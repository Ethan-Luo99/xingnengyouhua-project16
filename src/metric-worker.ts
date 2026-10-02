/**
 * worker_threads 工作线程:接收一批单元格序号,用共享的纯计算核心
 * 逐个计算指标字符串并回传。计算是纯函数,结果与调度顺序无关。
 *
 * 调试钩子:REPORT_CRASH_WORKER=1 时 worker 启动即退出,
 * 用于验证主线程的"线程池故障 → 分片降级"链路。
 */
import { parentPort } from "node:worker_threads";
import { computeMetric } from "./metric-core.js";

export interface ComputeTaskMessage {
  id: number;
  indices: number[];
  rounds: number;
}

export interface ComputeResultMessage {
  id: number;
  results: string[];
}

if (process.env.REPORT_CRASH_WORKER === "1") {
  process.exit(1);
}

if (parentPort === null) {
  throw new Error("metric-worker 必须在 worker_threads 中运行");
}

const port = parentPort;

port.on("message", (task: ComputeTaskMessage) => {
  const results = task.indices.map((index) =>
    computeMetric(index, task.rounds),
  );
  const response: ComputeResultMessage = { id: task.id, results };
  port.postMessage(response);
});
