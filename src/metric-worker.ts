/**
 * worker_threads 工作线程:接收一批单元格序号,用共享的纯计算核心
 * 逐个计算指标字符串并回传。计算是纯函数,结果与调度顺序无关。
 *
 * 可取消语义:主线程可发来 { kind: "cancel", id } 控制消息。
 * worker 每算完 CANCEL_CHECK_SLICE 个单元格就让出一次事件循环,
 * 此时取消消息才会被处理;发现当前任务被取消则立即丢弃在途分片,
 * 回传 cancelled=true 的空结果(主线程此时通常已不再等待它)。
 *
 * 调试钩子:REPORT_CRASH_WORKER=1 时 worker 启动即退出,
 * 用于验证主线程的"线程池故障 → 分片降级"链路。
 */
import { parentPort } from "node:worker_threads";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { computeMetric } from "./metric-core.js";

export interface ComputeTaskMessage {
  kind: "compute";
  id: number;
  indices: number[];
  rounds: number;
}

export interface CancelTaskMessage {
  kind: "cancel";
  id: number;
}

export type WorkerInboundMessage = ComputeTaskMessage | CancelTaskMessage;

export interface ComputeResultMessage {
  kind: "result";
  id: number;
  results: string[];
  /** true 表示任务在算完前被取消,results 为空,主线程应丢弃。 */
  cancelled: boolean;
}

if (process.env.REPORT_CRASH_WORKER === "1") {
  process.exit(1);
}

if (parentPort === null) {
  throw new Error("metric-worker 必须在 worker_threads 中运行");
}

const port = parentPort;

/** 每算这么多个单元格就让出一次事件循环,给取消消息一个被处理的机会。 */
const CANCEL_CHECK_SLICE = 16;

const cancelledIds = new Set<number>();
const pendingTasks: ComputeTaskMessage[] = [];
let running = false;

async function runTask(task: ComputeTaskMessage): Promise<void> {
  const { id, indices, rounds } = task;
  const results: string[] = [];

  for (let start = 0; start < indices.length; start += CANCEL_CHECK_SLICE) {
    if (cancelledIds.has(id)) {
      cancelledIds.delete(id);
      const dropped: ComputeResultMessage = {
        kind: "result",
        id,
        results: [],
        cancelled: true,
      };
      port.postMessage(dropped);
      return;
    }
    const end = Math.min(start + CANCEL_CHECK_SLICE, indices.length);
    for (let position = start; position < end; position += 1) {
      results.push(computeMetric(indices[position] as number, rounds));
    }
    if (end < indices.length) {
      await yieldToEventLoop();
    }
  }

  const done: ComputeResultMessage = {
    kind: "result",
    id,
    results,
    cancelled: false,
  };
  port.postMessage(done);
}

/** 串行处理任务队列,保证同一 worker 内任务不交错。 */
async function pump(): Promise<void> {
  if (running) {
    return;
  }
  running = true;
  try {
    let task = pendingTasks.shift();
    while (task !== undefined) {
      await runTask(task);
      task = pendingTasks.shift();
    }
  } finally {
    running = false;
  }
}

port.on("message", (message: WorkerInboundMessage) => {
  if (message.kind === "cancel") {
    cancelledIds.add(message.id);
    return;
  }
  pendingTasks.push(message);
  void pump();
});
