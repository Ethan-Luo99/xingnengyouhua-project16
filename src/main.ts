import {
  benchmark,
  CONFIG_PATH,
  enableAggressiveAutoScaling,
  configurePoolAutoScaling,
  generatePage,
  getCurrentConfig,
  getPoolStats,
  installConfigHotReload,
  EXPECTED_SHA256_ROW64,
  reloadConfig,
  resetPoolScaleEventCounts,
  shutdownReportResources,
  type BenchmarkResult,
  type PathBenchmark,
} from "./report.js";
import {
  DEFAULT_AUTO_SCALE_OPTIONS,
  type PoolStats,
} from "./worker-pool.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

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

interface ResilienceResult {
  abort: {
    passed: boolean;
    rejectedWithAbortError: boolean;
    recoveredDigest: string;
    poolRecovered: boolean;
  };
  hotReload: {
    passed: boolean;
    oldDigest: string;
    newRounds: number;
    newDigestValue: string;
    newDigest: boolean;
    sigusr2Digest: string;
    failureKeptOld: boolean;
    restoredBaseline: boolean;
  };
  autoScale: {
    passed: boolean;
    scaleUpEvents: number;
    scaleDownEvents: number;
    maxWorkers: number;
    finalWorkers: number;
  };
}

/** 轮询直到线程池排空(取消后在途 discarded 回执是异步到达的)。 */
async function waitForPoolDrain(timeoutMs = 3000): Promise<PoolStats | null> {
  const start = Date.now();
  let stats = getPoolStats();
  while (
    stats !== null &&
    (stats.inFlight > 0 || stats.queued > 0) &&
    Date.now() - start < timeoutMs
  ) {
    await delayMs(10);
    stats = getPoolStats();
  }
  return stats;
}

/** (a) 生成中途取消:必须 AbortError 拒绝、无半截产物,池随后可恢复。 */
async function verifyAbort(): Promise<ResilienceResult["abort"]> {
  const controller = new AbortController();
  const pending = generatePage(384, controller.signal);
  // 给派发留出几毫秒,使部分分片在途后再取消。
  setTimeout(() => controller.abort(), 8);

  let rejectedWithAbortError = false;
  try {
    await pending;
  } catch (error) {
    rejectedWithAbortError = isAbortError(error);
  }

  const drained = await waitForPoolDrain();
  const poolRecovered =
    drained !== null &&
    drained.queued === 0 &&
    drained.inFlight === 0 &&
    drained.workerCount >= 2;

  // 取消后紧接一次正常生成:必须成功且摘要仍为基准值。
  const recoveredHtml = await generatePage(64);
  const recoveredDigest = sha256Hex(recoveredHtml);

  return {
    passed:
      rejectedWithAbortError &&
      poolRecovered &&
      recoveredDigest === EXPECTED_SHA256_ROW64,
    rejectedWithAbortError,
    recoveredDigest,
    poolRecovered,
  };
}

/** (b) 热更新 cellHashRounds:旧参数跑基准,新参数产生不同稳定摘要。 */
async function verifyHotReload(
  backupConfig: string,
): Promise<ResilienceResult["hotReload"]> {
  const oldHtml = await generatePage(64);
  const oldDigest = sha256Hex(oldHtml);

  // 写入新参数(cellHashRounds 调整、线程池目标改为 3)后触发异步重读。
  const updatedConfig = JSON.stringify(
    {
      title: "季度服务性能报告",
      generator: "report.ts/blocking-benchmark",
      columns: 8,
      cellHashRounds: 190000,
      workerPoolSize: 3,
    },
    null,
    2,
  ) + "\n";
  await writeFile(CONFIG_PATH, updatedConfig, "utf8");
  await reloadConfig();
  const newRounds = getCurrentConfig().config.cellHashRounds;

  const newHtml = await generatePage(64);
  const digest1 = sha256Hex(newHtml);
  const newHtml2 = await generatePage(64);
  const digest2 = sha256Hex(newHtml2);
  const newDigest = digest1 === digest2 && digest1 !== oldDigest;

  // 失败重读:写坏 JSON,必须保留旧配置并告警、不抛出致命错误。
  await writeFile(CONFIG_PATH, "{ not valid json", "utf8");
  let failureKeptOld = false;
  try {
    await reloadConfig();
  } catch {
    failureKeptOld = getCurrentConfig().config.cellHashRounds === newRounds;
  }

  // SIGUSR2 真实信号路径:恢复为基准配置后发信号,轮询直到重读完成。
  await writeFile(CONFIG_PATH, backupConfig, "utf8");
  process.kill(process.pid, "SIGUSR2");
  const signalStart = Date.now();
  while (
    getCurrentConfig().config.cellHashRounds !== 180000 &&
    Date.now() - signalStart < 3000
  ) {
    await delayMs(10);
  }
  const sigusr2Html = await generatePage(64);
  const sigusr2Digest = sha256Hex(sigusr2Html);
  const restoredBaseline = sigusr2Digest === EXPECTED_SHA256_ROW64;

  return {
    passed:
      oldDigest === EXPECTED_SHA256_ROW64 &&
      newRounds === 190000 &&
      newDigest &&
      failureKeptOld &&
      restoredBaseline,
    oldDigest,
    newRounds,
    newDigestValue: digest1,
    newDigest,
    sigusr2Digest,
    failureKeptOld,
    restoredBaseline,
  };
}

/** (c) 扩缩容:激进窗口 + 高并发突发制造排队,随后空闲等待回收。 */
async function verifyAutoScale(): Promise<ResilienceResult["autoScale"]> {
  configurePoolAutoScaling(DEFAULT_AUTO_SCALE_OPTIONS);
  enableAggressiveAutoScaling();
  resetPoolScaleEventCounts();

  const before = getPoolStats();
  const startWorkers = before?.workerCount ?? 0;

  // 高并发突发:12 个大页同时提交,制造持续排队与 P95 超阈值。
  const bursts: Promise<string>[] = [];
  for (let index = 0; index < 12; index += 1) {
    bursts.push(generatePage(160));
  }
  const pages = await Promise.all(bursts);
  const burstDigestsOk = pages.every(
    (html) => sha256Hex(html) === sha256Hex(pages[0] ?? ""),
  );

  const afterBurst = getPoolStats();
  let maxWorkers = afterBurst?.workerCount ?? 0;

  // 空闲超时后应持续缩容回到目标大小;等待足够多个激进窗口。
  await delayMs(1200);
  let stats = getPoolStats();
  const settleStart = Date.now();
  while (Date.now() - settleStart < 1500) {
    await delayMs(20);
    stats = getPoolStats();
    maxWorkers = Math.max(maxWorkers, stats?.workerCount ?? 0);
  }

  configurePoolAutoScaling(DEFAULT_AUTO_SCALE_OPTIONS);

  const scaleUpEvents = stats?.scaleUpEvents ?? 0;
  const scaleDownEvents = stats?.scaleDownEvents ?? 0;

  return {
    passed:
      burstDigestsOk &&
      scaleUpEvents >= 1 &&
      scaleDownEvents >= 1 &&
      maxWorkers > startWorkers,
    scaleUpEvents,
    scaleDownEvents,
    maxWorkers,
    finalWorkers: stats?.workerCount ?? 0,
  };
}

async function runResilienceChecks(
  backupConfig: string,
): Promise<ResilienceResult> {
  const abort = await verifyAbort();
  const hotReload = await verifyHotReload(backupConfig);
  const autoScale = await verifyAutoScale();
  return { abort, hotReload, autoScale };
}

async function main(): Promise<void> {
  console.log("=== 事件循环阻塞 vs 零阻塞 双路径对照基准 ===");
  console.log(
    "legacy: 同步 readFileSync + 主线程串行 CPU | 零阻塞: 启动期异步缓存配置 + worker 线程池\n",
  );

  // 注册 SIGUSR2 → 异步重读 config.json;备份配置以便韧性验证后还原。
  installConfigHotReload();
  const backupConfig = await readFile(CONFIG_PATH, "utf8");

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

  // ===== 韧性验证:取消 → 热更新 → 扩缩容 =====
  console.log("\n=== 韧性验证(运行时可调 + 自适应调度 + 可取消)===");
  let resilience: ResilienceResult | null = null;
  try {
    resilience = await runResilienceChecks(backupConfig);

    console.log("--- (a) 中途取消 ---");
    console.log(
      `以 AbortError 拒绝    : ${resilience.abort.rejectedWithAbortError ? "通过 ✅" : "失败 ❌"}`,
    );
    console.log(
      `取消后池状态可恢复    : ${resilience.abort.poolRecovered ? "通过 ✅" : "失败 ❌"}`,
    );
    console.log(`取消后重跑 SHA-256   : ${resilience.abort.recoveredDigest}`);

    console.log("--- (b) 热更新 cellHashRounds ---");
    console.log(`旧参数摘要(row=64)   : ${resilience.hotReload.oldDigest}`);
    console.log(
      `新参数 rounds         : ${resilience.hotReload.newRounds},` +
        ` 新摘要稳定且不同于旧: ${resilience.hotReload.newDigest ? "通过 ✅" : "失败 ❌"}`,
    );
    console.log(
      `新参数实测 SHA-256    : ${resilience.hotReload.newDigestValue}`,
    );
    console.log(
      `重读失败保留旧配置    : ${resilience.hotReload.failureKeptOld ? "通过 ✅" : "失败 ❌"}`,
    );
    console.log(
      `SIGUSR2 还原后摘要    : ${resilience.hotReload.sigusr2Digest} ` +
        `(${resilience.hotReload.restoredBaseline ? "与基准一致 ✅" : "不一致 ❌"})`,
    );

    console.log("--- (c) 自适应扩缩容 ---");
    console.log(
      `扩容决策次数          : ${resilience.autoScale.scaleUpEvents}` +
        `(峰值 worker=${resilience.autoScale.maxWorkers})`,
    );
    console.log(
      `缩容决策次数          : ${resilience.autoScale.scaleDownEvents}` +
        `(最终 worker=${resilience.autoScale.finalWorkers})`,
    );
    console.log(
      `扩/缩容各至少一次     : ${
        resilience.autoScale.scaleUpEvents >= 1 &&
        resilience.autoScale.scaleDownEvents >= 1
          ? "通过 ✅"
          : "失败 ❌"
      }`,
    );
  } finally {
    // 无论验证成功与否都还原磁盘配置并关闭线程池。
    await writeFile(CONFIG_PATH, backupConfig, "utf8").catch(() => undefined);
    await shutdownReportResources();
  }

  const resiliencePassed =
    resilience !== null &&
    resilience.abort.passed &&
    resilience.hotReload.passed &&
    resilience.autoScale.passed;

  console.log(
    `\n韧性验证总体结论: ${resiliencePassed ? "全部通过 ✅" : "存在未通过项 ❌"}`,
  );

  if (!allPassed || !resiliencePassed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("基准运行失败:", error);
  process.exitCode = 1;
});
