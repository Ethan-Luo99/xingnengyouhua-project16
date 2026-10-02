import { parentPort } from "node:worker_threads";
import { computeMetricValue } from "./metric-core.js";

/**
 * worker_threads 工作线程入口:接收一批单元格序号,逐个执行确定性计算,
 * 按原顺序返回结果字符串数组。计算只依赖 (index, rounds),
 * 与分片方式、线程调度顺序完全无关。
 */

export interface MetricComputeRequest {
  indices: number[];
  rounds: number;
}

export interface MetricComputeResponse {
  results: string[];
}

if (parentPort === null) {
  throw new Error("metric-worker 必须在 worker_threads 工作线程中运行");
}

const port = parentPort;

port.on("message", (request: MetricComputeRequest) => {
  const results = request.indices.map((index) =>
    computeMetricValue(index, request.rounds),
  );
  const response: MetricComputeResponse = { results };
  port.postMessage(response);
});
