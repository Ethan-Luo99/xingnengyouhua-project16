/**
 * 自适应 worker_threads 线程池,用于把单元格指标计算移出主线程。
 *
 * 确定性保证:任务按 indices 顺序切片,Promise.all 按提交顺序收集,
 * 拼接结果只取决于输入序号,与 worker 调度/完成顺序无关。
 *
 * 自适应调度:按采样窗口统计任务排队等待时间,连续若干窗口 P95 超阈值
 * 才扩容一个 worker;队列清空且空闲超时后每次缩容一个空闲 worker。
 * 扩缩容都打印一行决策日志(含队列长度与依据),缩容只退空闲 worker,
 * 绝不丢弃已排队任务。worker 数量始终夹在 [minWorkers, maxWorkers]。
 *
 * 可取消:compute 接受可选 AbortSignal。取消时排队任务直接移除并拒绝,
 * 在途任务向 worker 发 cancel 控制消息让其丢弃在途分片,迟到的结果
 * 按任务 id 匹配丢弃,池状态不受污染,后续调用照常工作。
 *
 * 故障语义:任一 worker 报错或非零退出(主动缩容的退休 worker 除外)
 * → 池标记为不可用并拒绝所有待处理任务,由调用方降级为分片计算。
 */
import os from "node:os";
import { Worker } from "node:worker_threads";
import type {
  ComputeResultMessage,
  ComputeTaskMessage,
  WorkerInboundMessage,
} from "./metric-worker.js";

/** 构造一个 name 为 AbortError 的错误,与 DOMException("...","AbortError") 语义一致。 */
export function createAbortError(): Error {
  const error = new Error("操作已取消 (aborted)");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export interface AdaptivePoolOptions {
  /** 初始 worker 数,默认 min(8, maxWorkers)。 */
  initialWorkers?: number;
  /** 缩容下限,默认 2。 */
  minWorkers?: number;
  /** 扩容上限,默认 max(2, os.availableParallelism() - 1)。 */
  maxWorkers?: number;
  /** 排队等待采样窗口长度(毫秒),默认 1000。 */
  windowMs?: number;
  /** 触发扩容计数的排队 P95 阈值(毫秒),默认 25。 */
  scaleUpThresholdMs?: number;
  /** 连续多少个窗口 P95 超阈值才扩容,默认 3。 */
  consecutiveWindows?: number;
  /** 空闲多久(毫秒)才允许缩容,默认 10000。 */
  idleTimeoutMs?: number;
  /** 扩缩容决策日志输出口,默认 console.log。 */
  onDecision?: (line: string) => void;
}

interface PendingTask {
  message: ComputeTaskMessage;
  enqueuedAt: number;
  resolve: (results: string[]) => void;
  reject: (error: Error) => void;
}

interface WaitSample {
  time: number;
  waitMs: number;
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

export class MetricWorkerPool {
  private readonly workers = new Set<Worker>();
  private readonly idleWorkers: Worker[] = [];
  private readonly queue: PendingTask[] = [];
  private readonly inFlight = new Map<Worker, PendingTask>();
  /** 主动缩容退休中的 worker,其退出不视为故障。 */
  private readonly retiring = new Set<Worker>();
  private nextTaskId = 1;
  private usable = true;

  private readonly minWorkers: number;
  private readonly maxWorkers: number;
  private readonly windowMs: number;
  private readonly scaleUpThresholdMs: number;
  private readonly consecutiveWindows: number;
  private readonly idleTimeoutMs: number;
  private readonly onDecision: (line: string) => void;

  private waitSamples: WaitSample[] = [];
  private consecutiveHotWindows = 0;
  private lastActivityAt = Date.now();
  /** setTargetSize 缩容时暂时无空闲 worker 可退的欠账,空闲后补齐。 */
  private pendingShrink = 0;
  private readonly sampler: NodeJS.Timeout;

  constructor(options: AdaptivePoolOptions = {}) {
    const upperBound = Math.max(2, os.availableParallelism() - 1);
    this.maxWorkers = Math.max(
      1,
      Math.min(options.maxWorkers ?? upperBound, upperBound),
    );
    this.minWorkers = Math.max(
      1,
      Math.min(options.minWorkers ?? 2, this.maxWorkers),
    );
    this.windowMs = options.windowMs ?? 1000;
    this.scaleUpThresholdMs = options.scaleUpThresholdMs ?? 25;
    this.consecutiveWindows = options.consecutiveWindows ?? 3;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 10000;
    this.onDecision = options.onDecision ?? ((line) => console.log(line));

    const initial = Math.max(
      this.minWorkers,
      Math.min(options.initialWorkers ?? 8, this.maxWorkers),
    );
    for (let index = 0; index < initial; index += 1) {
      this.spawnWorker();
    }

    this.sampler = setInterval(() => {
      this.adapt();
    }, this.windowMs);
    this.sampler.unref();
  }

  get workerCount(): number {
    return this.workers.size;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get isUsable(): boolean {
    return this.usable;
  }

  private logDecision(line: string): void {
    this.onDecision(`[MetricWorkerPool] ${line}`);
  }

  private spawnWorker(): void {
    const worker = new Worker(
      new URL("./metric-worker.ts", import.meta.url),
    );
    worker.on("message", (message: ComputeResultMessage) => {
      this.handleResult(worker, message);
    });
    worker.on("error", (error: Error) => {
      if (this.retiring.has(worker)) {
        return;
      }
      this.handleWorkerFailure(worker, error);
    });
    worker.on("exit", (code: number) => {
      if (this.retiring.has(worker)) {
        this.retiring.delete(worker);
        return;
      }
      if (code !== 0 && this.usable) {
        this.handleWorkerFailure(
          worker,
          new Error(`metric-worker 异常退出,退出码 ${code}`),
        );
      }
    });
    this.workers.add(worker);
    this.idleWorkers.push(worker);
    this.pumpQueue();
  }

  /** 退休一个空闲 worker:不丢弃任何排队任务,退出不算故障。 */
  private retireWorker(worker: Worker): void {
    this.workers.delete(worker);
    const idleIndex = this.idleWorkers.indexOf(worker);
    if (idleIndex >= 0) {
      this.idleWorkers.splice(idleIndex, 1);
    }
    this.retiring.add(worker);
    void worker.terminate().finally(() => {
      this.retiring.delete(worker);
    });
  }

  /**
   * 自适应调度:每个采样窗口评估一次。
   *  - 扩容:窗口内排队等待 P95 超阈值,且连续 consecutiveWindows 个窗口如此;
   *  - 缩容:队列与在途均为空且空闲超过 idleTimeoutMs,每次退一个空闲 worker。
   */
  private adapt(): void {
    if (!this.usable) {
      return;
    }
    const now = Date.now();
    const cutoff = now - this.windowMs;
    this.waitSamples = this.waitSamples.filter(
      (sample) => sample.time >= cutoff,
    );

    if (this.waitSamples.length > 0) {
      const p95 = percentile95(this.waitSamples.map((sample) => sample.waitMs));
      if (p95 > this.scaleUpThresholdMs) {
        this.consecutiveHotWindows += 1;
      } else {
        this.consecutiveHotWindows = 0;
      }
      if (
        this.consecutiveHotWindows >= this.consecutiveWindows &&
        this.workers.size < this.maxWorkers
      ) {
        const from = this.workers.size;
        this.spawnWorker();
        this.logDecision(
          `扩容 ${from}→${this.workers.size}: 连续 ${this.consecutiveWindows} 个采样窗口` +
            `排队 P95=${p95.toFixed(2)}ms 超阈值 ${this.scaleUpThresholdMs}ms,` +
            `当前队列长度=${this.queue.length}`,
        );
        this.consecutiveHotWindows = 0;
      }
    } else {
      this.consecutiveHotWindows = 0;
    }

    const idleForMs = now - this.lastActivityAt;
    if (
      this.workers.size > this.minWorkers &&
      this.queue.length === 0 &&
      this.inFlight.size === 0 &&
      idleForMs >= this.idleTimeoutMs
    ) {
      const idle = this.idleWorkers.pop();
      if (idle !== undefined) {
        const from = this.workers.size;
        this.retireWorker(idle);
        this.lastActivityAt = now;
        this.logDecision(
          `缩容 ${from}→${this.workers.size}: 空闲 ${idleForMs}ms 超时空闲阈值 ` +
            `${this.idleTimeoutMs}ms,当前队列长度=${this.queue.length}`,
        );
      }
    }
  }

  /**
   * 热更新目标线程数:夹在 [minWorkers, maxWorkers] 后向目标调整。
   * 扩容立即生效;缩容优先退空闲 worker,不足部分记账,待 worker 空闲再退,
   * 绝不丢弃已排队任务。
   */
  setTargetSize(target: number): void {
    if (!this.usable) {
      return;
    }
    const clamped = Math.max(
      this.minWorkers,
      Math.min(this.maxWorkers, Math.floor(target)),
    );
    const current = this.workers.size;
    if (clamped > current) {
      for (let count = current; count < clamped; count += 1) {
        this.spawnWorker();
      }
      this.logDecision(
        `目标扩容 ${current}→${clamped}: 热更新目标线程数=${target},` +
          `当前队列长度=${this.queue.length}`,
      );
    } else if (clamped < current) {
      let deficit = current - clamped;
      while (deficit > 0 && this.idleWorkers.length > 0) {
        const idle = this.idleWorkers.pop();
        if (idle === undefined) {
          break;
        }
        this.retireWorker(idle);
        deficit -= 1;
      }
      this.pendingShrink += deficit;
      this.logDecision(
        `目标缩容 ${current}→${clamped}: 热更新目标线程数=${target},` +
          `当前队列长度=${this.queue.length}` +
          (deficit > 0 ? `,${deficit} 个待空闲后退休` : ""),
      );
    }
  }

  /**
   * 计算一批单元格指标。结果数组与 indices 一一对应、顺序确定。
   * 池不可用时抛出异常,调用方负责降级;signal 取消时以 AbortError 拒绝。
   */
  async compute(
    indices: number[],
    rounds: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (!this.usable || this.workers.size === 0) {
      throw new Error("worker 线程池不可用");
    }
    if (signal?.aborted) {
      throw createAbortError();
    }

    const chunkCount = Math.max(this.workers.size * 2, 1);
    const chunkSize = Math.max(1, Math.ceil(indices.length / chunkCount));
    const parts: Promise<string[]>[] = [];

    for (let start = 0; start < indices.length; start += chunkSize) {
      parts.push(
        this.dispatch(
          {
            kind: "compute",
            id: this.nextTaskId,
            indices: indices.slice(start, start + chunkSize),
            rounds,
          },
          signal,
        ),
      );
      this.nextTaskId += 1;
    }

    const results = await Promise.all(parts);
    return results.flat();
  }

  private dispatch(
    message: ComputeTaskMessage,
    signal?: AbortSignal,
  ): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }
      let onAbort: (() => void) | null = null;
      const cleanup = (): void => {
        if (onAbort !== null && signal !== undefined) {
          signal.removeEventListener("abort", onAbort);
          onAbort = null;
        }
      };
      const task: PendingTask = {
        message,
        enqueuedAt: Date.now(),
        resolve: (results) => {
          cleanup();
          resolve(results);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      if (signal !== undefined) {
        onAbort = () => {
          this.cancelTask(task);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.lastActivityAt = Date.now();
      const worker = this.idleWorkers.pop();
      if (worker === undefined) {
        this.queue.push(task);
        return;
      }
      this.assign(worker, task);
    });
  }

  /**
   * 取消单个任务:排队中的直接移除并拒绝;在途的立即拒绝、
   * 通知 worker 丢弃在途分片,并把 worker 收回空闲队列继续服务。
   */
  private cancelTask(task: PendingTask): void {
    const queuedIndex = this.queue.indexOf(task);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      task.reject(createAbortError());
      return;
    }
    for (const [worker, inFlightTask] of this.inFlight) {
      if (inFlightTask === task) {
        this.inFlight.delete(worker);
        task.reject(createAbortError());
        const cancelMessage: WorkerInboundMessage = {
          kind: "cancel",
          id: task.message.id,
        };
        worker.postMessage(cancelMessage);
        this.idleWorkers.push(worker);
        this.pumpQueue();
        return;
      }
    }
    // 任务已结算,无需处理。
  }

  private assign(worker: Worker, task: PendingTask): void {
    const now = Date.now();
    this.waitSamples.push({ time: now, waitMs: now - task.enqueuedAt });
    this.inFlight.set(worker, task);
    worker.postMessage(task.message);
  }

  private handleResult(worker: Worker, message: ComputeResultMessage): void {
    this.lastActivityAt = Date.now();
    const task = this.inFlight.get(worker);
    if (task === undefined || task.message.id !== message.id) {
      // 已取消任务的迟到结果(或 cancelled=true 的丢弃回执),直接忽略。
      return;
    }
    this.inFlight.delete(worker);
    task.resolve(message.results);
    this.idleWorkers.push(worker);
    if (
      this.pendingShrink > 0 &&
      this.queue.length === 0 &&
      this.workers.size > this.minWorkers
    ) {
      this.pendingShrink -= 1;
      this.idleWorkers.pop();
      this.retireWorker(worker);
      return;
    }
    this.pumpQueue();
  }

  private pumpQueue(): void {
    while (this.queue.length > 0 && this.idleWorkers.length > 0) {
      const task = this.queue.shift();
      const worker = this.idleWorkers.pop();
      if (task === undefined || worker === undefined) {
        return;
      }
      this.assign(worker, task);
    }
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    this.workers.delete(worker);
    const idleIndex = this.idleWorkers.indexOf(worker);
    if (idleIndex >= 0) {
      this.idleWorkers.splice(idleIndex, 1);
    }
    const pending = this.inFlight.get(worker);
    if (pending !== undefined) {
      this.inFlight.delete(worker);
      pending.reject(error);
    }
    void worker.terminate();

    // 简化语义:任一 worker 崩溃即视为池不可用,拒绝排队任务,
    // 由主线程统一降级,避免半可用状态下的不确定行为。
    if (this.usable) {
      this.usable = false;
      const failure = new Error(
        `worker 线程池故障: ${error.message}`,
      );
      for (const queued of this.queue.splice(0)) {
        queued.reject(failure);
      }
      for (const [busyWorker, task] of this.inFlight) {
        this.inFlight.delete(busyWorker);
        task.reject(failure);
      }
    }
  }

  /** 优雅关闭:拒绝排队任务并等待所有 worker 线程退出。 */
  async shutdown(): Promise<void> {
    this.usable = false;
    clearInterval(this.sampler);
    const failure = new Error("worker 线程池已关闭");
    for (const queued of this.queue.splice(0)) {
      queued.reject(failure);
    }
    const terminations = [...this.workers].map((worker) =>
      worker.terminate(),
    );
    this.workers.clear();
    this.idleWorkers.length = 0;
    await Promise.all(terminations);
  }
}
