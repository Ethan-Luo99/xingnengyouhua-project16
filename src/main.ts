import {
  benchmark,
  shutdownMetricPool,
  EXPECTED_SHA256,
  MAX_LAG_BUDGET_MS,
} from "./report.js";

function formatMs(value: number): string {
  return value.toFixed(2);
}

function pad(text: string, width: number): string {
  // 按显示宽度对齐(中日韩字符按 2 列计)。
  let width0 = 0;
  for (const ch of text) {
    width0 += ch.codePointAt(0)! > 0xff ? 2 : 1;
  }
  return text + " ".repeat(Math.max(0, width - width0));
}

function row(label: string, legacy: string, zero: string): string {
  return `${pad(label, 20)}${pad(legacy, 28)}${zero}`;
}

async function main(): Promise<void> {
  console.log("=== 事件循环阻塞 vs 零阻塞:双路径对比基准 ===");
  console.log(
    "legacy = 同步 readFileSync + 主线程串行 CPU;zero = 启动期异步缓存配置 + worker_threads 线程池\n",
  );

  const result = await benchmark({ rowCount: 64, runs: 3 });

  console.log("--- 输入规模 ---");
  console.log(`行数 rowCount      : ${result.rowCount}`);
  console.log(`列数 (config.json) : ${result.columnCount}`);
  console.log(`单元格总数         : ${result.cellCount}`);
  console.log(
    `renderMetric 调用数: ${result.renderMetricCallsPerRun} 次/单次生成 ` +
      `(要求 >= 300: ${result.meets300Calls ? "通过" : "失败"})`,
  );
  console.log(
    `各轮实际调用数      : [${result.renderMetricCallsEachRun.join(", ")}]`,
  );
  console.log(
    `零阻塞路径等效计算  : ${result.asyncMetricCallsPerRun} 次/单次生成`,
  );
  console.log(
    `零阻塞计算后端      : ${result.poolActive ? "worker_threads 线程池" : "setImmediate 分片(已降级)"}`,
  );

  console.log("\n--- 双路径对照表(同一进程实测) ---");
  console.log(row("指标", "legacy(阻塞)", "zero(零阻塞)"));
  console.log(row("单次耗时(各轮)",
    result.legacy.durationsMs.map(formatMs).join(" / "),
    result.zero.durationsMs.map(formatMs).join(" / "),
  ));
  console.log(row("单次耗时中位数",
    `${formatMs(result.legacy.medianMs)} ms`,
    `${formatMs(result.zero.medianMs)} ms`,
  ));
  console.log(row("事件循环最大卡顿",
    `${formatMs(result.legacy.maxLagMs)} ms`,
    `${formatMs(result.zero.maxLagMs)} ms`,
  ));
  console.log(row("事件循环平均延迟",
    `${formatMs(result.legacy.meanLagMs)} ms`,
    `${formatMs(result.zero.meanLagMs)} ms`,
  ));
  console.log(row("错过 10ms 节拍",
    `${result.legacy.delayedTicks} 次`,
    `${result.zero.delayedTicks} 次`,
  ));
  console.log(row("卡顿放大量",
    `${formatMs(result.legacy.lagAmplification)}x`,
    `${formatMs(result.zero.lagAmplification)}x`,
  ));
  console.log(row("吞吐(页/秒)", "—(阻塞,不测)",
    `${formatMs(result.zeroThroughputPagesPerSec)}`,
  ));
  console.log(row("输出 SHA-256",
    result.legacy.digest.slice(0, 16) + "…",
    result.zero.digest.slice(0, 16) + "…",
  ));

  console.log("\n--- 参照 ---");
  console.log(
    `空闲基线  最大卡顿: ${formatMs(result.baselineLag.maxLagMs)} ms, ` +
      `平均: ${formatMs(result.baselineLag.meanLagMs)} ms`,
  );
  console.log(
    `单次同步 readFileSync(config.json) 耗时: ${formatMs(result.syncConfigReadMs)} ms`,
  );

  console.log("\n--- 零阻塞达标校验 ---");
  console.log(
    `单次 generatePageAsync 期间事件循环最大卡顿: ${formatMs(result.zero.maxLagMs)} ms ` +
      `(预算 ≤ ${MAX_LAG_BUDGET_MS} ms): ${result.zeroMeetsLagBudget ? "达标 ✅" : "超标 ❌"}`,
  );
  console.log(`零阻塞路径吞吐: ${formatMs(result.zeroThroughputPagesPerSec)} 页/秒`);

  console.log("\n--- 可复现性 / 一致性校验 ---");
  console.log(`legacy 路径 SHA-256: ${result.legacy.digest}`);
  console.log(`zero   路径 SHA-256: ${result.zero.digest}`);
  console.log(`期望(阻塞原版)   : ${EXPECTED_SHA256}`);
  console.log(
    `两路径输出逐字节一致: ${result.crossPathIdentical ? "通过 ✅" : "失败 ❌"}`,
  );
  console.log(
    `与阻塞原版 SHA-256 一致: ${result.matchesExpectedDigest ? "通过 ✅" : "失败 ❌"}`,
  );
  console.log(`HTML 长度: ${result.htmlLength} 字符`);

  const allPassed =
    result.meets300Calls &&
    result.identicalAcrossRuns &&
    result.crossPathIdentical &&
    result.matchesExpectedDigest &&
    result.zeroMeetsLagBudget;

  console.log(
    `\n总体结论: ${allPassed ? "零阻塞达标且输出与阻塞版逐字节一致 ✅" : "存在未通过项 ❌"}`,
  );

  if (!allPassed) {
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error("基准运行失败:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    // 优雅关闭 worker 线程池。
    void shutdownMetricPool();
  });
