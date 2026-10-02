import {
  benchmark,
  shutdownReportResources,
  type BenchmarkResult,
  type PathBenchmark,
} from "./report.js";

function formatMs(value: number): string {
  return value.toFixed(2);
}

function printPathSection(title: string, path: PathBenchmark): void {
  console.log(`\n--- ${title} ---`);
  console.log(`计算模式           : ${path.computeMode}`);
  console.log(
    `renderMetric 调用数: ${path.renderMetricCallsPerRun} 次/单次生成`,
  );
  console.log(
    `单次耗时           : [${path.durationsMs.map(formatMs).join(", ")}] ms,` +
      ` 中位数 ${formatMs(path.medianMs)} ms`,
  );
  console.log(
    `事件循环最大卡顿   : ${formatMs(path.lag.maxLagMs)} ms ` +
      `(平均 ${formatMs(path.lag.meanLagMs)} ms, 错过节拍 ${path.lag.delayedTicks} 次)`,
  );
  console.log(`卡顿放大量         : ${formatMs(path.lagAmplification)}x`);
  if (path.throughputPagesPerSec !== undefined) {
    console.log(
      `实测吞吐           : ${path.throughputPagesPerSec.toFixed(1)} 页/秒`,
    );
  }
}

async function main(): Promise<void> {
  console.log("=== 事件循环阻塞 vs 零阻塞 双路径对照基准 ===");
  console.log(
    "legacy: 同步 readFileSync + 主线程串行 CPU | 零阻塞: 启动期异步缓存配置 + worker 线程池\n",
  );

  const result: BenchmarkResult = await benchmark({ rowCount: 64, runs: 3 });

  console.log("--- 输入规模 ---");
  console.log(`行数 rowCount      : ${result.rowCount}`);
  console.log(`列数 (config.json) : ${result.columnCount}`);
  console.log(`单元格总数         : ${result.cellCount}`);
  console.log(
    `renderMetric >= 300: ${result.meets300Calls ? "通过 ✅" : "失败 ❌"}`,
  );

  console.log("\n--- 空闲基线 ---");
  console.log(
    `最大卡顿: ${formatMs(result.baselineLag.maxLagMs)} ms, ` +
      `平均: ${formatMs(result.baselineLag.meanLagMs)} ms`,
  );

  if (result.legacy !== null) {
    printPathSection("legacy 阻塞路径(反例保留)", result.legacy);
  }
  if (result.zero !== null) {
    printPathSection("零阻塞路径", result.zero);
    console.log(
      `单次生成最大卡顿 ≤ 5ms: ${result.zeroPathMaxLagOk ? "通过 ✅" : "失败 ❌"} ` +
        `(实测 ${formatMs(result.zero.lag.maxLagMs)} ms)`,
    );
  }

  if (result.legacy !== null && result.zero !== null) {
    const legacyMedian = result.legacy.medianMs;
    console.log("\n--- 对照表 ---");
    console.log(
      `单次耗时中位数 : legacy ${formatMs(legacyMedian)} ms  →  零阻塞 ${formatMs(result.zero.medianMs)} ms`,
    );
    console.log(
      `最大卡顿       : legacy ${formatMs(result.legacy.lag.maxLagMs)} ms  →  零阻塞 ${formatMs(result.zero.lag.maxLagMs)} ms`,
    );
    console.log(
      `卡顿放大量     : legacy ${formatMs(result.legacy.lagAmplification)}x  →  零阻塞 ${formatMs(result.zero.lagAmplification)}x`,
    );
    console.log(
      `吞吐           : legacy ~${(1000 / legacyMedian).toFixed(1)} 页/秒(推算,且全程卡死)  →  ` +
        `零阻塞 ${(result.zero.throughputPagesPerSec ?? 0).toFixed(1)} 页/秒(实测,事件循环保持响应)`,
    );
  }

  console.log("\n--- 可复现性校验 ---");
  const digestSource = result.zero ?? result.legacy;
  digestSource?.digests.forEach((digest, index) => {
    console.log(`零阻塞第 ${index + 1} 次输出 SHA-256: ${digest}`);
  });
  console.log(
    `多轮输出逐字节一致  : ${result.identicalAcrossRuns ? "通过 ✅" : "失败 ❌"}`,
  );
  console.log(
    `跨路径逐字节一致    : ${result.crossPathIdentical ? "通过 ✅" : "失败 ❌"}`,
  );
  if (result.expectedDigest !== null) {
    console.log(`基准摘要(rowCount=64): ${result.expectedDigest}`);
    console.log(
      `与基准摘要一致      : ${result.digestMatchesExpected ? "通过 ✅" : "失败 ❌"}`,
    );
  }
  console.log(`HTML 长度: ${result.htmlLength} 字符`);

  const allPassed =
    result.meets300Calls &&
    result.identicalAcrossRuns &&
    result.crossPathIdentical &&
    result.digestMatchesExpected &&
    result.zeroPathMaxLagOk;

  console.log(
    `\n总体结论: ${allPassed ? "零阻塞达标且输出可复现 ✅" : "存在未通过项 ❌"}`,
  );

  await shutdownReportResources();

  if (!allPassed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("基准运行失败:", error);
  process.exitCode = 1;
});
