import { Worker } from "node:worker_threads";
import type {
  MetricComputeRequest,
  MetricComputeResponse,
} from "./metric-worker.js";

/**
 * 固定大小的 worker_threads 线程池。
 * - 每个 worker 同一时刻只处理一个任务,主线程按空闲 worker 轮询派发;
 * - 任一 worker 崩溃( error 事件 / 非 0 退出)即判定线程池不可用,
 *   拒绝所有排队与在途任务,由调用方降级为 setImmediate 分片计算;
 * - shutdown() 拒绝剩余任务并 terminate 全部 worker,实现优雅关闭。
 */

interface PendingTask {
  indices: number[];
  rounds: number;
  resolve: (results: string[]) => void;
  reject: (error: Error) => void;
}

export class MetricWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly idleWorkers: Worker[] = [];
  private readonly taskQueue: PendingTask[] = [];
  private readonly inFlight = new Map<Worker, PendingTask>();
  private broken = false;
  private shuttingDown = false;

  constructor(
    readonly size: number,
    workerUrl: URL,
  ) {
    for (let n = 0; n < size; n += 1) {
      const worker = new Worker(workerUrl);
      worker.on("message", (response: MetricComputeResponse) => {
        this.handleResponse(worker, response);
      });
      worker.on("error", (error: Error) => {
        this.handleWorkerFailure(worker, error);
      });
      worker.on("exit", (code: number) => {
        if (code !== 0 && !this.shuttingDown) {
          this.handleWorkerFailure(
            worker,
            new Error(`worker 异常退出,退出码 ${code}`),
          );
        }
      });
      this.workers.push(worker);
      this.idleWorkers.push(worker);
    }
  }

  get isBroken(): boolean {
    return this.broken;
  }

  /**
   * 把 indices 切成 线程数×8 个分片并行派发,按原顺序拼接结果。
   * 每个分片结果只取决于分片内的 (index, rounds),与调度顺序无关。
   */
  async compute(indices: number[], rounds: number): Promise<string[]> {
    if (this.broken) {
      throw new Error("worker 线程池不可用");
    }
    if (indices.length === 0) {
      return [];
    }

    const chunkCount = Math.min(indices.length, this.size * 8);
    const chunkSize = Math.ceil(indices.length / chunkCount);
    const parts: Promise<string[]>[] = [];
    for (let start = 0; start < indices.length; start += chunkSize) {
      parts.push(this.dispatch(indices.slice(start, start + chunkSize), rounds));
    }
    const chunks = await Promise.all(parts);
    return chunks.flat();
  }

  private dispatch(indices: number[], rounds: number): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      if (this.broken) {
        reject(new Error("worker 线程池不可用"));
        return;
      }
      this.taskQueue.push({ indices, rounds, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (
      !this.broken &&
      this.idleWorkers.length > 0 &&
      this.taskQueue.length > 0
    ) {
      const worker = this.idleWorkers.pop();
      const task = this.taskQueue.shift();
      if (worker === undefined || task === undefined) {
        return;
      }
      this.inFlight.set(worker, task);
      const request: MetricComputeRequest = {
        indices: task.indices,
        rounds: task.rounds,
      };
      worker.postMessage(request);
    }
  }

  private handleResponse(
    worker: Worker,
    response: MetricComputeResponse,
  ): void {
    const task = this.inFlight.get(worker);
    if (task === undefined) {
      return;
    }
    this.inFlight.delete(worker);
    task.resolve(response.results);
    if (!this.broken) {
      this.idleWorkers.push(worker);
      this.pump();
    }
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    if (this.broken) {
      return;
    }
    this.broken = true;
    const task = this.inFlight.get(worker);
    if (task !== undefined) {
      this.inFlight.delete(worker);
      task.reject(error);
    }
    this.rejectAll(error);
    // 后台清理剩余 worker,不阻塞调用方。
    void this.terminateAll();
  }

  private rejectAll(error: Error): void {
    for (const queued of this.taskQueue.splice(0)) {
      queued.reject(error);
    }
    for (const task of this.inFlight.values()) {
      task.reject(error);
    }
    this.inFlight.clear();
  }

  private async terminateAll(): Promise<void> {
    await Promise.all(
      this.workers.map((worker) => worker.terminate().then(() => undefined)),
    );
  }

  /** 优雅关闭:拒绝剩余任务并终止全部 worker,可重复调用。 */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.broken = true;
    this.rejectAll(new Error("worker 线程池已关闭"));
    await this.terminateAll();
  }
}
