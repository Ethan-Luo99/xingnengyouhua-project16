/**
 * 固定大小的 worker_threads 线程池,用于把单元格指标计算移出主线程。
 *
 * 确定性保证:任务按 indices 顺序切片,Promise.all 按提交顺序收集,
 * 拼接结果只取决于输入序号,与 worker 调度/完成顺序无关。
 *
 * 故障语义:任一 worker 报错或非零退出 → 池标记为不可用并拒绝所有
 * 待处理任务,由调用方(主线程)降级为 setImmediate 分片计算。
 */
import os from "node:os";
import { Worker } from "node:worker_threads";
import type {
  ComputeResultMessage,
  ComputeTaskMessage,
} from "./metric-worker.js";

interface PendingTask {
  message: ComputeTaskMessage;
  resolve: (results: string[]) => void;
  reject: (error: Error) => void;
}

export class MetricWorkerPool {
  private readonly workers = new Set<Worker>();
  private readonly idleWorkers: Worker[] = [];
  private readonly queue: PendingTask[] = [];
  private readonly inFlight = new Map<Worker, PendingTask>();
  private nextTaskId = 1;
  private usable = true;

  constructor(size?: number) {
    const workerCount =
      size ?? Math.max(2, Math.min(os.availableParallelism() - 1, 8));
    for (let index = 0; index < workerCount; index += 1) {
      this.spawnWorker();
    }
  }

  get workerCount(): number {
    return this.workers.size;
  }

  get isUsable(): boolean {
    return this.usable;
  }

  private spawnWorker(): void {
    const worker = new Worker(
      new URL("./metric-worker.ts", import.meta.url),
    );
    worker.on("message", (message: ComputeResultMessage) => {
      this.handleResult(worker, message);
    });
    worker.on("error", (error: Error) => {
      this.handleWorkerFailure(worker, error);
    });
    worker.on("exit", (code: number) => {
      if (code !== 0 && this.usable) {
        this.handleWorkerFailure(
          worker,
          new Error(`metric-worker 异常退出,退出码 ${code}`),
        );
      }
    });
    this.workers.add(worker);
    this.idleWorkers.push(worker);
  }

  /**
   * 计算一批单元格指标。结果数组与 indices 一一对应、顺序确定。
   * 池不可用时抛出异常,调用方负责降级。
   */
  async compute(indices: number[], rounds: number): Promise<string[]> {
    if (!this.usable || this.workers.size === 0) {
      throw new Error("worker 线程池不可用");
    }

    const chunkCount = Math.max(this.workers.size * 2, 1);
    const chunkSize = Math.max(1, Math.ceil(indices.length / chunkCount));
    const parts: Promise<string[]>[] = [];

    for (let start = 0; start < indices.length; start += chunkSize) {
      parts.push(
        this.dispatch({
          id: this.nextTaskId,
          indices: indices.slice(start, start + chunkSize),
          rounds,
        }),
      );
      this.nextTaskId += 1;
    }

    const results = await Promise.all(parts);
    return results.flat();
  }

  private dispatch(message: ComputeTaskMessage): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      const task: PendingTask = { message, resolve, reject };
      const worker = this.idleWorkers.pop();
      if (worker === undefined) {
        this.queue.push(task);
        return;
      }
      this.assign(worker, task);
    });
  }

  private assign(worker: Worker, task: PendingTask): void {
    this.inFlight.set(worker, task);
    worker.postMessage(task.message);
  }

  private handleResult(worker: Worker, message: ComputeResultMessage): void {
    const task = this.inFlight.get(worker);
    if (task === undefined || task.message.id !== message.id) {
      return;
    }
    this.inFlight.delete(worker);
    task.resolve(message.results);
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
