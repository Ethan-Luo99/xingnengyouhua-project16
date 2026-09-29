import { benchmark } from "./report.js";

function formatMs(value: number): string {
  return value.toFixed(2);
}

async function main(): Promise<void> {
  console.log("=== 事件循环阻塞反例基准 ===");
  console.log("阻塞构造: 每单元格同步 readFileSync(config.json) + 串行 CPU 整数运算\n");

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

  console.log("\n--- 单次总耗时 (performance.now) ---");
  result.totalDurationsMs.forEach((duration, index) => {
    console.log(`第 ${index + 1} 次: ${formatMs(duration)} ms`);
  });
  console.log(`中位数: ${formatMs(result.totalMedianMs)} ms`);
  console.log(
    `单次同步 readFileSync(config.json) 耗时: ${formatMs(result.syncConfigReadMs)} ms`,
  );

  console.log("\n--- 事件循环延迟 (10ms setInterval 探针 + perf_hooks) ---");
  console.log(
    `空闲基线  最大卡顿: ${formatMs(result.baselineLag.maxLagMs)} ms, ` +
      `平均: ${formatMs(result.baselineLag.meanLagMs)} ms, ` +
      `错过节拍次数: ${result.baselineLag.delayedTicks}`,
  );
  console.log(
    `阻塞期间  最大卡顿: ${formatMs(result.blockedLag.maxLagMs)} ms, ` +
      `平均: ${formatMs(result.blockedLag.meanLagMs)} ms, ` +
      `错过节拍次数: ${result.blockedLag.delayedTicks}`,
  );
  console.log(
    `卡顿放大量: ${formatMs(result.blockedLag.maxLagMs / Math.max(result.baselineLag.maxLagMs, 0.01))}x`,
  );

  console.log("\n--- 可复现性校验 ---");
  result.digests.forEach((digest, index) => {
    console.log(`第 ${index + 1} 次输出 SHA-256: ${digest}`);
  });
  console.log(
    `固定输入下 HTML 逐字节一致: ${result.identicalAcrossRuns ? "通过 ✅" : "失败 ❌"}`,
  );
  console.log(`HTML 长度: ${result.htmlLength} 字符`);

  const allPassed =
    result.meets300Calls &&
    result.identicalAcrossRuns &&
    result.blockedLag.maxLagMs > result.baselineLag.maxLagMs * 2;

  console.log(
    `\n总体结论: ${allPassed ? "阻塞可观测且结果可复现 ✅" : "存在未通过项 ❌"}`,
  );

  if (!allPassed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("基准运行失败:", error);
  process.exitCode = 1;
});
