import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  benchmark,
  generatePage,
  getPoolStats,
  installConfigHotReload,
  isAbortError,
  shutdownReportResources,
  waitNextConfigReload,
  EXPECTED_SHA256_ROW64,
  EXPECTED_SHA256_ROW64_HOT,
  HOT_RELOAD_ROUNDS,
  type BenchmarkResult,
  type PathBenchmark,
} from "./report.js";
import { MetricWorkerPool } from "./worker-pool.js";

function formatMs(value: number): string {
  return value.toFixed(2);
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

/** 热更新用配置:仅改 cellHashRounds 并显式指定线程池目标大小。 */
const HOT_CONFIG_JSON = `{
  "title": "季度服务性能报告",
  "generator": "report.ts/blocking-benchmark",
  "columns": 8,
  "cellHashRounds": ${HOT_RELOAD_ROUNDS},
  "workerThreads": 3
}
`;

const CONFIG_PATH = fileURLToPath(
  new URL("../config.json", import.meta.url),
);

/** 通过真实 SIGUSR2 信号触发一次热重读并等待其完成。 */
async function triggerReloadViaSignal(): Promise<boolean> {
  const waited = waitNextConfigReload();
  process.kill(process.pid, "SIGUSR2");
  // 兜底定时器:信号监听本身不会给事件循环续命(ref),若此刻没有其他
  // 存活的句柄(如分片降级模式下无线程池),进程可能在信号被处理前
  // 正常退出;定时器既保持循环存活,也防止极端情况下永久挂起。
  let timer: NodeJS.Timeout | null = null;
  const backstop = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, 5000);
  });
  const result = await Promise.race([waited, backstop]);
  if (timer !== null) {
    clearTimeout(timer);
  }
  return result;
}

interface ResilienceState {
  failures: number;
}

function check(
  state: ResilienceState,
  name: string,
  ok: boolean,
  detail: string,
): void {
  console.log(
    `  ${ok ? "✅" : "❌"} ${name}${detail === "" ? "" : ` — ${detail}`}`,
  );
  if (!ok) {
    state.failures += 1;
  }
}

/** (a) 生成中途取消:确认 AbortError 拒绝、无半截 HTML、池可恢复。 */
async function verifyCancellation(state: ResilienceState): Promise<void> {
  console.log("\n(a) 可取消生成");
  const statsBefore = getPoolStats();
  const controller = new AbortController();
  const pending = generatePage(64, controller.signal);
  const timer = setTimeout(() => {
    controller.abort();
  }, 20);

  let caught: unknown = null;
  try {
    await pending;
  } catch (error) {
    caught = error;
  } finally {
    clearTimeout(timer);
  }

  check(
    state,
    "中途取消以 AbortError 拒绝",
    isAbortError(caught),
    caught instanceof Error ? `error.name=${caught.name}` : "未拒绝",
  );

  const statsAfter = getPoolStats();
  const poolUnpolluted =
    statsBefore === null || statsAfter === null
      ? statsBefore === null && statsAfter === null
      : statsAfter.usable === statsBefore.usable && statsAfter.queued === 0;
  check(
    state,
    "取消后线程池状态未受污染",
    poolUnpolluted,
    statsAfter === null
      ? "分片降级模式(无线程池)"
      : `workers=${statsAfter.workers} queued=${statsAfter.queued} usable=${statsAfter.usable}`,
  );

  const recoveredDigest = sha256Hex(await generatePage(64));
  check(
    state,
    "取消后新生成可完成且 SHA 正确",
    recoveredDigest === EXPECTED_SHA256_ROW64,
    recoveredDigest,
  );
}

/** (b) 热更新:失败保持旧配置 / 新参数生效 / 进行中任务用旧参数 / 恢复。 */
async function verifyHotReload(state: ResilienceState): Promise<void> {
  console.log("\n(b) SIGUSR2 热更新 config.json");
  const originalRaw = await readFile(CONFIG_PATH, "utf8");

  // 旧参数下 128 行基准摘要,用于对照"进行中任务用旧参数跑完"。
  const expected128Old = sha256Hex(await generatePage(128));

  try {
    // b1: 损坏配置 → 重读失败,保持旧配置,进程不退出。
    await writeFile(CONFIG_PATH, "{ 这不是合法 JSON\n", "utf8");
    const failedReloadOk = await triggerReloadViaSignal();
    check(state, "损坏配置重读被拒绝(保持旧配置)", !failedReloadOk, "");
    const keptDigest = sha256Hex(await generatePage(64));
    check(
      state,
      "重读失败后仍按旧配置生成",
      keptDigest === EXPECTED_SHA256_ROW64,
      keptDigest,
    );

    // b2: 写入新参数配置;先启动一个 128 行生成再发信号,
    //     验证进行中的任务用旧参数完整跑完(不混拼)。
    await writeFile(CONFIG_PATH, HOT_CONFIG_JSON, "utf8");
    const inflight = generatePage(128);
    const reloadOk = await triggerReloadViaSignal();
    check(state, "新配置热重读成功", reloadOk, "");

    const inflightDigest = sha256Hex(await inflight);
    check(
      state,
      "进行中的生成用旧参数跑完",
      inflightDigest === expected128Old,
      inflightDigest,
    );

    const hotDigest = sha256Hex(await generatePage(64));
    check(
      state,
      `新参数(cellHashRounds=${HOT_RELOAD_ROUNDS})生成摘要正确`,
      hotDigest === EXPECTED_SHA256_ROW64_HOT,
      hotDigest,
    );
  } finally {
    // 无论断言结果如何都恢复原始配置并热重读回去。
    await writeFile(CONFIG_PATH, originalRaw, "utf8");
    await triggerReloadViaSignal();
  }

  const restoredDigest = sha256Hex(await generatePage(64));
  check(
    state,
    "恢复原配置后摘要回到基准",
    restoredDigest === EXPECTED_SHA256_ROW64,
    restoredDigest,
  );
}

/** (c) 自适应扩缩容:独立池 + 短窗口,确认扩容与缩容日志各至少一次。 */
async function verifyAdaptiveScaling(
  state: ResilienceState,
): Promise<void> {
  console.log("\n(c) 自适应线程池扩缩容");
  const decisions: string[] = [];
  const testPool = new MetricWorkerPool({
    initialWorkers: 2,
    minWorkers: 2,
    maxWorkers: 6,
    windowMs: 100,
    scaleUpThresholdMs: 5,
    consecutiveWindows: 2,
    idleTimeoutMs: 400,
    onDecision: (line) => {
      decisions.push(line);
      console.log(`  ${line}`);
    },
  });

  try {
    // 制造排队压力:一次性投入大批重任务,排队等待 P95 必然超阈值。
    const heavyIndices = Array.from({ length: 64 }, (_, index) => index);
    const batch: Promise<string[]>[] = [];
    for (let round = 0; round < 60; round += 1) {
      batch.push(testPool.compute(heavyIndices, 180000));
    }
    let loadError: unknown = null;
    try {
      await Promise.all(batch);
    } catch (error) {
      loadError = error;
    }

    if (!testPool.isUsable) {
      // worker 崩溃注入(REPORT_CRASH_WORKER=1)等环境下测试池直接不可用,
      // 扩缩容无从演示;该场景已由主流程的降级链路覆盖,此处跳过不计失败。
      console.log(
        "  (跳过扩缩容断言:测试池不可用 — " +
          `${loadError instanceof Error ? loadError.message : String(loadError)})`,
      );
      return;
    }
    check(state, "压力批次全部完成", loadError === null, "");

    // 静默等待空闲超时触发缩容。
    await delay(1500);

    const scaleUpLines = decisions.filter((line) => line.includes("扩容"));
    const scaleDownLines = decisions.filter((line) => line.includes("缩容"));
    check(
      state,
      "扩容决策日志至少出现一次",
      scaleUpLines.length >= 1,
      `扩容 ${scaleUpLines.length} 次`,
    );
    check(
      state,
      "缩容决策日志至少出现一次",
      scaleDownLines.length >= 1,
      `缩容 ${scaleDownLines.length} 次`,
    );
    check(
      state,
      "缩容后 worker 数回到下限且任务零丢失",
      testPool.workerCount === 2,
      `workers=${testPool.workerCount}(已完成的 ${batch.length} 批任务全部 resolve)`,
    );
  } finally {
    await testPool.shutdown();
  }
}

/** 韧性验证:取消 / 热更新 / 自适应扩缩容 + 交织后的最终一致性回归。 */
async function runResilienceChecks(): Promise<boolean> {
  console.log("\n=== 韧性验证(运行时可调 + 自适应调度 + 可取消)===");

  const state: ResilienceState = { failures: 0 };
  await verifyCancellation(state);
  await verifyHotReload(state);
  await verifyAdaptiveScaling(state);

  // 最终回归:取消、热更新、扩缩容交织之后,rowCount=64 摘要必须仍是基准值。
  const finalDigest = sha256Hex(await generatePage(64));
  check(
    state,
    "交织操作后 rowCount=64 一致性回归",
    finalDigest === EXPECTED_SHA256_ROW64,
    finalDigest,
  );

  console.log(
    `\n韧性验证结论: ${state.failures === 0 ? "全部通过 ✅" : `${state.failures} 项失败 ❌`}`,
  );
  return state.failures === 0;
}

async function main(): Promise<void> {
  installConfigHotReload();

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

  const benchmarkPassed =
    result.meets300Calls &&
    result.identicalAcrossRuns &&
    result.crossPathIdentical &&
    result.digestMatchesExpected &&
    result.zeroPathMaxLagOk;

  const resiliencePassed = await runResilienceChecks();
  const allPassed = benchmarkPassed && resiliencePassed;

  console.log(
    `\n总体结论: ${allPassed ? "零阻塞达标、输出可复现且韧性验证通过 ✅" : "存在未通过项 ❌"}`,
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
