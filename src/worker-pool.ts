/**
 * 自适应 worker_threads 线程池。
 *
 * 职责:
 *  - 把单元格指标计算分片派发给 worker 线程,结果按提交顺序收集,
 *    输出只取决于输入序号,与调度/完成顺序无关;
 *  - worker 数量在 [2, os.availableParallelism()-1] 内自适应:
 *    连续 N 个采样窗口的排队等待 P95 超阈值才扩容,空闲超时才缩容,
 *    每次扩缩容打印一行决策日志(含队列长度与依据);
 *  - 支持任务级取消:AbortSignal 中止后停止派发新分片、通知 worker
 *    丢弃在途分片、已返回的部分结果由调用方丢弃,worker 全部回归空闲,
 *    线程池状态不被污染。
 *
 * 故障语义:任一 worker 报错或非零退出(非缩容主动终止)→ 池标记
 * 不可用并拒绝在途/排队任务,由调用方降级为分片计算。
 */
import os from "node:os";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import type {
  ComputeResultMessage,
  TaskDiscardedMessage,
  WorkerOutboundMessage,
} from "./metric-worker.js";

interface ComputeRequest {
  type: "compute";
  id: number;
  indices: number[];
  rounds: number;
  cancelFlag: SharedArrayBuffer;
}

interface PendingTask {
  message: ComputeRequest;
  resolve: (results: string[]) => void;
  reject: (error: Error) => void;
  /** 入队时间(performance.now()),用于采样排队等待时长。 */
  enqueuedAt: number;
}

export interface PoolStats {
  workerCount: number;
  idleCount: number;
  queued: number;
  inFlight: number;
  targetSize: number;
  scaleUpEvents: number;
  scaleDownEvents: number;
}

export interface AutoScaleOptions {
  /** 采样窗口长度(毫秒)。 */
  windowMs: number;
  /** 连续多少个窗口排队 P95 超阈值才扩容。 */
  sustainedWindows: number;
  /** 排队等待 P95 阈值(毫秒)。 */
  queueWaitP95ThresholdMs: number;
  /** worker 空闲多久后允许缩容(毫秒)。 */
  idleTimeoutMs: number;
}

export const DEFAULT_AUTO_SCALE_OPTIONS: AutoScaleOptions = {
  windowMs: 250,
  sustainedWindows: 4,
  queueWaitP95ThresholdMs: 25,
  idleTimeoutMs: 1500,
};

/** 用于测试的激进取值:短窗口 + 单窗口即扩容,快速触发扩缩容。 */
export const AGGRESSIVE_AUTO_SCALE_OPTIONS: AutoScaleOptions = {
  windowMs: 50,
  sustainedWindows: 1,
  queueWaitP95ThresholdMs: 1,
  idleTimeoutMs: 150,
};

const DEFAULT_POOL_SIZE = 8;

/** 计算 worker 数量的合法区间 [2, availableParallelism()-1]。 */
export function workerBounds(): { min: number; max: number } {
  const parallelism = os.availableParallelism();
  return { min: 2, max: Math.max(2, parallelism - 1) };

}

function clampWorkerCount(value: number): number {
  const { min, max } = workerBounds();
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** 构造符合 DOM 约定的 AbortError(name === "AbortError")。 */
export function createAbortError(message = "操作已取消"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function percentile95(samples: number[]): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(0.95 * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)] ?? 0;
}

/** 为一批分片 Promise 挂空拒绝处理,避免取消时 unhandledRejection。 */
function suppressParts(parts: Promise<string[]>[]): void {
  for (const part of parts) {
    part.catch(() => undefined);
  }
}

export class MetricWorkerPool {
  private readonly workers = new Set<Worker>();
  private readonly idleWorkers: Worker[] = [];
  private readonly queue: PendingTask[] = [];
  private readonly inFlight = new Map<Worker, PendingTask>();
  /** 主动缩容/关闭而终止的 worker,其 exit 事件不算故障。 */
  private readonly terminated = new Set<Worker>();
  private nextTaskId = 1;
  private usable = true;

  private targetSize: number;
  private autoScale: AutoScaleOptions;
  private autoTimer: NodeJS.Timeout | null = null;
  private currentWindowWaits: number[] = [];
  private consecutiveHighWindows = 0;
  /** 每个 worker 最近一次处于忙碌(派发/完成)的时间戳。 */
  private readonly lastBusyAt = new Map<Worker, number>();
  private scaleUpEvents = 0;
  private scaleDownEvents = 0;

  constructor(
    size?: number,
    autoScaleOptions?: AutoScaleOptions,
  ) {
    const initial = clampWorkerCount(size ?? DEFAULT_POOL_SIZE);
    this.targetSize = initial;
    this.autoScale = autoScaleOptions ?? DEFAULT_AUTO_SCALE_OPTIONS;
    for (let index = 0; index < initial; index += 1) {
      this.spawnWorker();
    }
    this.startAutoScaler();
  }

  get workerCount(): number {
    return this.workers.size;
  }

  get isUsable(): boolean {
    return this.usable;
  }

  getStats(): PoolStats {
    return {
      workerCount: this.workers.size,
      idleCount: this.idleWorkers.length,
      queued: this.queue.length,
      inFlight: this.inFlight.size,
      targetSize: this.targetSize,
      scaleUpEvents: this.scaleUpEvents,
      scaleDownEvents: this.scaleDownEvents,
    };
  }

  /** 热更新线程池目标大小;在合法区间内夹取,不丢弃任何排队任务。 */
  setTargetSize(size: number): void {
    this.targetSize = clampWorkerCount(size);
  }

  /** 运行期调整自适应参数(立即按新窗口采样)。 */
  configureAutoScaling(options: AutoScaleOptions): void {
    this.autoScale = options;
    this.currentWindowWaits = [];
    this.consecutiveHighWindows = 0;
    if (this.autoTimer !== null) {
      clearInterval(this.autoTimer);
    }
    this.startAutoScaler();
  }

  /** 清零扩缩容决策计数(韧性验证按测试段独立统计)。 */
  resetScaleEventCounts(): void {
    this.scaleUpEvents = 0;
    this.scaleDownEvents = 0;
  }

  private startAutoScaler(): void {
    this.autoTimer = setInterval(() => {
      this.autoScaleTick();
    }, this.autoScale.windowMs);
    this.autoTimer.unref?.();
  }

  private spawnWorker(): void {
    const worker = new Worker(new URL("./metric-worker.ts", import.meta.url));
    worker.on("message", (message: WorkerOutboundMessage) => {
      if (message.type === "result") {
        this.handleResult(worker, message);
      } else {
        this.handleDiscarded(worker, message);
      }
    });
    worker.on("error", (error: Error) => {
      if (this.terminated.has(worker)) {
        return;
      }
      this.handleWorkerFailure(worker, error);
    });
    worker.on("exit", (code: number) => {
      this.workers.delete(worker);
      this.removeFromIdle(worker);
      this.lastBusyAt.delete(worker);
      if (this.terminated.delete(worker)) {
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
    this.lastBusyAt.set(worker, performance.now());
  }

  private removeFromIdle(worker: Worker): void {
    const index = this.idleWorkers.indexOf(worker);
    if (index >= 0) {
      this.idleWorkers.splice(index, 1);
    }
  }

  /**
   * 计算一批单元格指标。结果数组与 indices 一一对应、顺序确定。
   * signal 中止后:尚未派发的分片直接拒绝,在途分片通知 worker 丢弃,
   * 整个计算以 AbortError 拒绝;线程池本身保持可用。
   */
  async compute(
    indices: number[],
    rounds: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (!this.usable || this.workers.size === 0) {
      throw new Error("worker 线程池不可用");
    }
    if (signal?.aborted === true) {
      throw createAbortError();
    }

    const chunkCount = Math.max(this.workers.size * 2, 1);
    const chunkSize = Math.max(1, Math.ceil(indices.length / chunkCount));
    const parts: Promise<string[]>[] = [];
    const abortSignal: AbortSignal | undefined = signal;

    for (let start = 0; start < indices.length; start += chunkSize) {
      if (abortSignal !== undefined && abortSignal.aborted) {
        suppressParts(parts);
        throw createAbortError();
      }
      const cancelFlag = new SharedArrayBuffer(1);
      parts.push(
        this.dispatch(
          {
            type: "compute",
            id: this.nextTaskId,
            indices: indices.slice(start, start + chunkSize),
            rounds,
            cancelFlag,
          },
          signal,
        ),
      );
      this.nextTaskId += 1;
    }

    try {
      return (await Promise.all(parts)).flat();
    } catch (error) {
      // 任一分片被取消/失败:其余分片的拒绝也需被消费,避免 unhandledRejection。
      suppressParts(parts);
      throw error;
    }
  }

  private dispatch(
    message: ComputeRequest,
    signal?: AbortSignal,
  ): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      const task: PendingTask = {
        message,
        resolve,
        reject,
        enqueuedAt: performance.now(),
      };

      const onAbort = (): void => {
        signal?.removeEventListener("abort", onAbort);
        const queuedIndex = this.queue.indexOf(task);
        if (queuedIndex >= 0) {
          // 尚未派发:从队列移除并拒绝,不会被任何 worker 取走。
          this.queue.splice(queuedIndex, 1);
          task.reject(createAbortError());
          return;
        }
        // 在途:置共享标志 + 发取消消息,worker 循环下一个检查点即停,
        // 结果在 handleDiscarded 中以 AbortError 拒绝。
        new Int8Array(message.cancelFlag)[0] = 1;
        const worker = this.workerOfTask(message.id);
        worker?.postMessage({ type: "cancel", id: message.id });
      };

      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
      }

      const worker = this.idleWorkers.pop();
      if (worker === undefined) {
        this.queue.push(task);
        return;
      }
      this.assign(worker, task);
    });
  }

  private workerOfTask(taskId: number): Worker | undefined {
    for (const [worker, task] of this.inFlight) {
      if (task.message.id === taskId) {
        return worker;
      }
    }
    return undefined;
  }

  private assign(worker: Worker, task: PendingTask): void {
    this.inFlight.set(worker, task);
    this.lastBusyAt.set(worker, performance.now());
    worker.postMessage(task.message);
  }

  private handleResult(worker: Worker, message: ComputeResultMessage): void {
    const task = this.inFlight.get(worker);
    if (task === undefined || task.message.id !== message.id) {
      return;
    }
    this.inFlight.delete(worker);
    this.lastBusyAt.set(worker, performance.now());
    task.resolve(message.results);
    this.recycleWorker(worker);
  }

  private handleDiscarded(
    worker: Worker,
    message: TaskDiscardedMessage,
  ): void {
    const task = this.inFlight.get(worker);
    if (task === undefined || task.message.id !== message.id) {
      return;
    }
    this.inFlight.delete(worker);
    this.lastBusyAt.set(worker, performance.now());
    task.reject(createAbortError());
    this.recycleWorker(worker);
  }

  private recycleWorker(worker: Worker): void {
    this.idleWorkers.push(worker);
    this.pumpQueue();
  }

  private pumpQueue(): void {
    while (this.queue.length > 0 && this.idleWorkers.length > 0) {
      const task = this.queue.shift();
      const worker = this.idleWorkers.pop();
      if (task === undefined || worker === undefined) {
        return;
      }
      // 记录排队等待样本,供自适应窗口计算 P95。
      this.currentWindowWaits.push(performance.now() - task.enqueuedAt);
      this.assign(worker, task);
    }
  }

  /**
   * 每个采样窗口:
   *  - 连续 sustainedWindows 个窗口排队 P95 超阈值且仍有积压 → 扩容 1;
   *  - 存在超过 idleTimeoutMs 未工作的空闲 worker 且高于下界 → 缩容 1。
   * 缩容只回收空闲 worker,排队与在途任务一律保留。
   */
  private autoScaleTick(): void {
    if (!this.usable) {
      return;
    }
    const waits = this.currentWindowWaits;
    this.currentWindowWaits = [];
    // 仍在排队的任务也按"截至本窗口已等待多久"计入样本,
    // 否则首个积压窗口(任务尚未派发、没有离队样本)会漏判,导致永不扩容。
    const now = performance.now();
    for (const queued of this.queue) {
      waits.push(now - queued.enqueuedAt);
    }
    const p95 = percentile95(waits);

    if (p95 > this.autoScale.queueWaitP95ThresholdMs) {
      this.consecutiveHighWindows += 1;
    } else {
      this.consecutiveHighWindows = 0;
    }

    const { max } = workerBounds();
    const saturated =
      this.queue.length > 0 || this.inFlight.size >= this.workers.size;
    if (
      this.consecutiveHighWindows >= this.autoScale.sustainedWindows &&
      this.workers.size < max &&
      saturated
    ) {
      const previous = this.workers.size;
      this.spawnWorker();
      this.scaleUpEvents += 1;
      console.log(
        `[pool] 扩容决策: workers ${previous} → ${this.workers.size} ` +
          `(队列长度=${this.queue.length}, 连续 ${this.consecutiveHighWindows} 个窗口 ` +
          `排队 P95=${p95.toFixed(2)}ms > 阈值 ${this.autoScale.queueWaitP95ThresholdMs}ms)`,
      );
      this.pumpQueue();
      this.consecutiveHighWindows = 0;
      return;
    }

    // 向配置目标回归:目标上调且当前规模不足时补齐。
    if (this.workers.size < this.targetSize) {
      const previous = this.workers.size;
      this.spawnWorker();
      this.scaleUpEvents += 1;
      console.log(
        `[pool] 扩容决策: workers ${previous} → ${this.workers.size} ` +
          `(队列长度=${this.queue.length}, 向配置目标 ${this.targetSize} 回归)`,
      );
      this.pumpQueue();
      return;
    }

    // 缩容:仅在空闲超时后回收,且不低于配置目标与合法下界。
    if (this.workers.size > Math.max(this.targetSize, workerBounds().min)) {
      const candidate = this.pickIdleTimedOutWorker(now);
      if (candidate !== undefined) {
        const previous = this.workers.size;
        this.retireWorker(candidate);
        this.scaleDownEvents += 1;
        console.log(
          `[pool] 缩容决策: workers ${previous} → ${this.workers.size} ` +
            `(队列长度=${this.queue.length}, 空闲超时 ${this.autoScale.idleTimeoutMs}ms, ` +
            `目标大小=${this.targetSize})`,
        );
      }
    }
  }

  private pickIdleTimedOutWorker(now: number): Worker | undefined {
    for (const worker of this.idleWorkers) {
      const busyAt = this.lastBusyAt.get(worker) ?? now;
      if (now - busyAt >= this.autoScale.idleTimeoutMs) {
        return worker;
      }
    }
    return undefined;
  }

  private retireWorker(worker: Worker): void {
    this.removeFromIdle(worker);
    this.workers.delete(worker);
    this.lastBusyAt.delete(worker);
    this.terminated.add(worker);
    void worker.terminate();
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    this.workers.delete(worker);
    this.removeFromIdle(worker);
    this.lastBusyAt.delete(worker);
    const pending = this.inFlight.get(worker);
    if (pending !== undefined) {
      this.inFlight.delete(worker);
      pending.reject(error);
    }
    void worker.terminate();

    if (this.usable) {
      this.usable = false;
      if (this.autoTimer !== null) {
        clearInterval(this.autoTimer);
        this.autoTimer = null;
      }
      const failure = new Error(`worker 线程池故障: ${error.message}`);
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
    if (this.autoTimer !== null) {
      clearInterval(this.autoTimer);
      this.autoTimer = null;
    }
    const failure = new Error("worker 线程池已关闭");
    for (const queued of this.queue.splice(0)) {
      queued.reject(failure);
    }
    for (const worker of this.workers) {
      this.terminated.add(worker);
    }
    const terminations = [...this.workers].map((worker) =>
      worker.terminate(),
    );
    this.workers.clear();
    this.idleWorkers.length = 0;
    this.inFlight.clear();
    await Promise.all(terminations);
  }
}
