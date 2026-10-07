/**
 * worker_threads 工作线程:接收一批单元格序号,用共享的纯计算核心
 * 逐个计算指标字符串并回传。计算是纯函数,结果与调度顺序无关。
 *
 * 消息协议:
 *  - 入站 { type:"compute", id, indices, rounds, cancelFlag }
 *      cancelFlag 是 1 字节 SharedArrayBuffer:主线程把首字节置 1
 *      即请求取消;计算循环是同步的(普通消息无法在循环期间送达),
 *      所以必须通过共享内存读取取消信号。
 *  - 入站 { type:"cancel", id } 显式取消通知(共享标志的冗余双保险);
 *  - 出站 { type:"result",    id, results } 分片正常完成;
 *  - 出站 { type:"discarded", id }          分片在途被丢弃。
 *
 * 取消是协作式的:worker 周期性检查共享取消标志,命中后立刻停止后续
 * 单元格计算并回 discarded,已算出的部分结果不回传、直接丢弃。
 *
 * 调试钩子:REPORT_CRASH_WORKER=1 时 worker 启动即退出,
 * 用于验证主线程的"线程池故障 → 分片降级"链路。
 */
import { parentPort } from "node:worker_threads";
import { computeMetric } from "./metric-core.js";

export interface ComputeTaskMessage {
  type: "compute";
  id: number;
  indices: number[];
  rounds: number;
  /** 1 字节共享内存:首字节为 1 表示主线程请求丢弃该分片。 */
  cancelFlag: SharedArrayBuffer;
}

export interface CancelTaskMessage {
  type: "cancel";
  id: number;
}

export type WorkerInboundMessage = ComputeTaskMessage | CancelTaskMessage;

export interface ComputeResultMessage {
  type: "result";
  id: number;
  results: string[];
}

export interface TaskDiscardedMessage {
  type: "discarded";
  id: number;
}

export type WorkerOutboundMessage =
  | ComputeResultMessage
  | TaskDiscardedMessage;

if (process.env.REPORT_CRASH_WORKER === "1") {
  process.exit(1);
}

if (parentPort === null) {
  throw new Error("metric-worker 必须在 worker_threads 中运行");
}

const port = parentPort;

/** 已通过 cancel 消息显式通知取消的分片 id(共享标志的双保险)。 */
const cancelledTaskIds = new Set<number>();

/** 每计算多少个单元格检查一次取消标志,兼顾响应速度与检查开销。 */
const CANCEL_CHECK_STRIDE = 32;

port.on("message", (message: WorkerInboundMessage) => {
  if (message.type === "cancel") {
    cancelledTaskIds.add(message.id);
    return;
  }

  const task = message;
  const cancelFlag = new Int8Array(task.cancelFlag);
  const results: string[] = [];

  const isCancelled = (): boolean =>
    cancelFlag[0] === 1 || cancelledTaskIds.has(task.id);

  for (let position = 0; position < task.indices.length; position += 1) {
    if (position % CANCEL_CHECK_STRIDE === 0 && isCancelled()) {
      cancelledTaskIds.delete(task.id);
      const discarded: TaskDiscardedMessage = {
        type: "discarded",
        id: task.id,
      };
      port.postMessage(discarded);
      return;
    }
    const index = task.indices[position] as number;
    results.push(computeMetric(index, task.rounds));
  }

  if (isCancelled()) {
    cancelledTaskIds.delete(task.id);
    const discarded: TaskDiscardedMessage = {
      type: "discarded",
      id: task.id,
    };
    port.postMessage(discarded);
    return;
  }

  const response: ComputeResultMessage = {
    type: "result",
    id: task.id,
    results,
  };
  port.postMessage(response);
});
