/**
 * 事件循环阻塞反例的"零阻塞"重构版。
 *
 * 双路径并存:
 *  - legacy 阻塞路径(generatePageLegacy / renderMetric / loadConfigSync):
 *    原样保留的反例实现 —— 每次调用同步 readFileSync(config.json),
 *    全部单元格的 CPU 计算在主线程一次性串行跑完。
 *  - 零阻塞路径(generatePage 异步版):
 *    1. config.json 启动期一次性异步读取并缓存(initConfig),请求路径零同步 I/O;
 *    2. 单元格 CPU 计算默认交给 worker_threads 线程池(MetricWorkerPool),
 *       线程池不可用或 worker 崩溃时自动降级为 setImmediate 分片计算,
 *       两种模式下主线程都不会被长时间独占。
 *
 * 两条路径共用同一个 assembleHtml 模板函数与同一个 computeMetric 纯函数,
 * 输出逐字节等价,与分片/调度顺序无关。
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeMetric } from "./metric-core.js";
import {
  AGGRESSIVE_AUTO_SCALE_OPTIONS,
  type AutoScaleOptions,
  createAbortError,
  MetricWorkerPool,
  type PoolStats,
} from "./worker-pool.js";

export const CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "config.json",
);

const COLUMN_COUNT_FALLBACK = 8;
const HASH_ROUNDS_FALLBACK = 2000;

/** rowCount=64 时必须复现的基准摘要(与阻塞版本逐字节一致)。 */
export const EXPECTED_SHA256_ROW64 =
  "a6aeae862721779f9d4d043de1a3a37aae0b60057a7541e75d7d18fa27ceb7dc";

interface ReportConfig {
  title: string;
  generator: string;
  columns: number;
  cellHashRounds: number;
  /** 可选:线程池目标大小;缺省由线程池自行决定(夹取到合法区间)。 */
  workerPoolSize?: number;
}

/** renderMetric / 分片计算被调用的真实次数,用于校验 ">=300 次函数执行"。 */
let renderMetricInvocations = 0;

export function getRenderMetricInvocations(): number {
  return renderMetricInvocations;
}

export function resetRenderMetricInvocations(): void {
  renderMetricInvocations = 0;
}

function parseConfig(parsed: unknown): ReportConfig {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("title" in parsed) ||
    !("generator" in parsed) ||
    !("columns" in parsed) ||
    !("cellHashRounds" in parsed)
  ) {
    throw new Error("config.json 缺少必需字段");
  }

  const record = parsed as Record<string, unknown>;
  const columns =
    typeof record.columns === "number" && Number.isInteger(record.columns)
      ? record.columns
      : COLUMN_COUNT_FALLBACK;
  const cellHashRounds =
    typeof record.cellHashRounds === "number" &&
    Number.isInteger(record.cellHashRounds)
      ? record.cellHashRounds
      : HASH_ROUNDS_FALLBACK;

  const workerPoolSize =
    "workerPoolSize" in record &&
    typeof record.workerPoolSize === "number" &&
    Number.isInteger(record.workerPoolSize) &&
    record.workerPoolSize > 0
      ? record.workerPoolSize
      : undefined;

  return {
    title: String(record.title),
    generator: String(record.generator),
    columns,
    cellHashRounds,
    workerPoolSize,
  };
}

/** 同步读取并解析 ./config.json —— legacy 阻塞路径专用,原样保留。 */
export function loadConfigSync(): ReportConfig {
  const raw = readFileSync(CONFIG_PATH, "utf8");
  return parseConfig(JSON.parse(raw));
}

export interface LoadedConfig {
  /** 配置文件原始文本,逐字节参与 HTML 注释拼接。 */
  rawConfig: string;
  config: ReportConfig;
}

let configCache: LoadedConfig | null = null;
let configLoadPromise: Promise<LoadedConfig> | null = null;

/**
 * 启动期一次性异步读取并缓存 config.json。
 * 之后请求路径上只读内存缓存,不再出现任何同步 I/O。
 */
export function initConfig(): Promise<LoadedConfig> {
  configLoadPromise ??= readFile(CONFIG_PATH, "utf8").then((rawConfig) => {
    const loaded: LoadedConfig = {
      rawConfig,
      config: parseConfig(JSON.parse(rawConfig)),
    };
    configCache = loaded;
    return loaded;
  });
  return configLoadPromise;
}

let reloadInFlight: Promise<LoadedConfig> | null = null;

/** 当前缓存配置(未初始化时抛错),供验证读取热更新后的参数。 */
export function getCurrentConfig(): LoadedConfig {
  return getCachedConfig();
}

/**
 * 异步重读 config.json 并热更新 cellHashRounds 与线程池目标大小。
 *
 * 快照语义:进行中的 generatePage 在其入口处持有旧 LoadedConfig 引用,
 * 整页(含所有分片)都用旧参数跑完;只有重读完成后开始的新页面才看到
 * 新参数,因此同一页面内绝不会出现新旧参数混拼。
 *
 * 读取或解析失败时保留旧配置、打印告警并拒绝,进程不退出。
 * 并发触发复用同一个 Promise,避免并发重读造成状态抖动。
 */
export function reloadConfig(): Promise<LoadedConfig> {
  if (reloadInFlight !== null) {
    return reloadInFlight;
  }
  reloadInFlight = readFile(CONFIG_PATH, "utf8")
    .then((rawConfig) => {
      let loaded: LoadedConfig;
      try {
        loaded = { rawConfig, config: parseConfig(JSON.parse(rawConfig)) };
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error(String(error));
      }
      const previous = configCache;
      configCache = loaded;
      if (loaded.config.workerPoolSize !== undefined) {
        desiredPoolSize = loaded.config.workerPoolSize;
        pool?.setTargetSize(loaded.config.workerPoolSize);
      }
      console.log(
        `[config] 热更新生效: cellHashRounds ` +
          `${previous?.config.cellHashRounds ?? "?"} → ${loaded.config.cellHashRounds}` +
          (loaded.config.workerPoolSize !== undefined
            ? `, workerPoolSize 目标=${loaded.config.workerPoolSize}`
            : ""),
      );
      return loaded;
    })
    .catch((error: unknown) => {
      console.warn(
        "⚠ config.json 重读失败,保留旧配置:",
        error instanceof Error ? error.message : String(error),
      );
      throw error instanceof Error ? error : new Error(String(error));
    })
    .finally(() => {
      reloadInFlight = null;
    });
  return reloadInFlight;
}

let sigusr2Installed = false;

/**
 * 注册 SIGUSR2 → reloadConfig()(幂等,只注册一次)。
 * 重读失败只告警、不抛出(信号回调中的 reject 无人接收),进程不退出。
 */
export function installConfigHotReload(): void {
  if (sigusr2Installed) {
    return;
  }
  sigusr2Installed = true;
  process.on("SIGUSR2", () => {
    reloadConfig().catch(() => undefined);
  });
}

function getCachedConfig(): LoadedConfig {
  if (configCache === null) {
    throw new Error("config 尚未初始化,请先在启动期 await initConfig()");
  }
  return configCache;
}

/**
 * legacy 阻塞路径的单元格计算:每单元格都同步 readFileSync(config.json)
 * 再跑 CPU 密集运算 —— 反例原样保留,仅供对照基准使用。
 */
export function renderMetric(i: number): string {
  renderMetricInvocations += 1;
  const rounds = loadConfigSync().cellHashRounds;
  return computeMetric(i, rounds);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * 唯一的 HTML 模板拼装函数,legacy 与零阻塞路径共用,
 * 从结构上保证两条路径输出逐字节等价。
 */
function assembleHtml(
  rawConfig: string,
  config: ReportConfig,
  rowCount: number,
  metrics: string[],
): string {
  const columns = config.columns;

  const lines: string[] = [];
  lines.push("<!DOCTYPE html>");
  lines.push('<html lang="zh-CN">');
  lines.push("<head>");
  lines.push(`<meta charset="utf-8">`);
  lines.push(`<title>${escapeHtml(config.title)}</title>`);
  lines.push(
    `<meta name="generator" content="${escapeHtml(config.generator)}">`,
  );
  lines.push("</head>");
  lines.push("<body>");
  lines.push(`<h1>${escapeHtml(config.title)}</h1>`);
  lines.push(
    `<!-- config: ${rawConfig.replaceAll("--", "&#45;&#45;").replaceAll(">", "&gt;")} -->`,
  );
  lines.push(
    `<table data-rows="${rowCount}" data-cols="${columns}" data-hash-rounds="${config.cellHashRounds}">`,
  );

  const headerCells: string[] = [];
  for (let column = 0; column < columns; column += 1) {
    headerCells.push(`<th>指标 ${column + 1}</th>`);
  }
  lines.push(`<thead><tr>${headerCells.join("")}</tr></thead>`);
  lines.push("<tbody>");

  for (let row = 0; row < rowCount; row += 1) {
    const cells: string[] = [];
    for (let column = 0; column < columns; column += 1) {
      const metricIndex = row * columns + column;
      cells.push(
        `<td data-i="${metricIndex}">${metrics[metricIndex] ?? ""}</td>`,
      );
    }
    lines.push(`<tr>${cells.join("")}</tr>`);
  }

  lines.push("</tbody>");
  lines.push("</table>");
  lines.push(`<footer>由 ${escapeHtml(config.generator)} 生成</footer>`);
  lines.push("</body>");
  lines.push("</html>");

  return `${lines.join("\n")}\n`;
}

function assertValidRowCount(rowCount: number): void {
  if (!Number.isInteger(rowCount) || rowCount < 0) {
    throw new Error("rowCount 必须是非负整数");
  }
}

/**
 * legacy 阻塞路径:同步 I/O + 主线程串行 CPU,反例原样保留。
 * 可用 benchmark({ path: "legacy" }) 单独切换测量。
 */
export function generatePageLegacy(rowCount: number): string {
  assertValidRowCount(rowCount);

  const rawConfig = readFileSync(CONFIG_PATH, "utf8");
  const config = loadConfigSync();
  const columns = config.columns;

  const metrics: string[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      metrics.push(renderMetric(row * columns + column));
    }
  }

  return assembleHtml(rawConfig, config, rowCount, metrics);
}

/** 分片让出的时间片预算:每片最多占用主线程 4ms,保证卡顿远低于 5ms 目标。 */
const CHUNK_TIME_BUDGET_MS = 4;

/**
 * 降级路径:setImmediate 分片计算。
 * 每片在 CHUNK_TIME_BUDGET_MS 内跑完后让出事件循环,
 * 定时器 / I/O 回调在片间都能被及时处理。
 */
async function computeMetricsChunked(
  indices: number[],
  rounds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const results: string[] = new Array<string>(indices.length);
  let sliceStart = performance.now();

  for (let position = 0; position < indices.length; position += 1) {
    if (signal?.aborted === true) {
      throw createAbortError();
    }
    const index = indices[position] as number;
    results[position] = computeMetric(index, rounds);
    renderMetricInvocations += 1;

    if (performance.now() - sliceStart >= CHUNK_TIME_BUDGET_MS) {
      await yieldToEventLoop();
      sliceStart = performance.now();
    }
  }

  return results;
}

export type ComputeMode = "worker-pool" | "chunked-fallback";

let pool: MetricWorkerPool | null = null;
let poolDisabled = process.env.REPORT_FORCE_FALLBACK === "1";
let lastComputeMode: ComputeMode = poolDisabled
  ? "chunked-fallback"
  : "worker-pool";
/** 建池时采用的目标大小(可被热更新改写);undefined 用池默认值。 */
let desiredPoolSize: number | undefined;
let desiredAutoScale: AutoScaleOptions | undefined;

/** 最近一次零阻塞 generatePage 实际使用的计算模式。 */
export function getLastComputeMode(): ComputeMode {
  return lastComputeMode;
}

function getPool(): MetricWorkerPool | null {
  if (poolDisabled) {
    return null;
  }
  if (pool === null) {
    try {
      pool = new MetricWorkerPool(desiredPoolSize, desiredAutoScale);
    } catch (error) {
      poolDisabled = true;
      console.warn(
        "⚠ worker 线程池创建失败,降级为 setImmediate 分片计算:",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }
  return pool;
}

/** 返回当前线程池快照(池未建立时为 null),供韧性验证检查状态。 */
export function getPoolStats(): PoolStats | null {
  return pool === null ? null : pool.getStats();
}

/** 运行期调整自适应参数(若池尚未建立则记录,建池时生效)。 */
export function configurePoolAutoScaling(options: AutoScaleOptions): void {
  desiredAutoScale = options;
  pool?.configureAutoScaling(options);
}

/** 韧性验证使用的激进取值(短窗口、低阈值),快速触发扩缩容。 */
export function enableAggressiveAutoScaling(): void {
  configurePoolAutoScaling(AGGRESSIVE_AUTO_SCALE_OPTIONS);
}

/** 清零线程池扩缩容决策计数,供韧性验证分段统计。 */
export function resetPoolScaleEventCounts(): void {
  pool?.resetScaleEventCounts();
}

/** 优雅关闭线程池:等待全部 worker 退出,进程可正常结束。 */
export async function shutdownReportResources(): Promise<void> {
  const current = pool;
  pool = null;
  if (current !== null) {
    await current.shutdown();
  }
}

/**
 * 零阻塞路径:异步生成与 legacy 逐字节等价的 HTML 报告。
 *  - config 来自启动期缓存,零同步 I/O;
 *  - 单元格计算默认在 worker 线程池执行;池故障时打印告警并
 *    降级为 setImmediate 分片计算,输出不变、进程不因此失败;
 *  - signal 中止后以 AbortError 拒绝:不派发新分片、在途分片被丢弃,
 *    assembleHtml 不会被调用,因此不产出任何半截 HTML,池状态不受污染。
 */
export async function generatePage(
  rowCount: number,
  signal?: AbortSignal,
): Promise<string> {
  assertValidRowCount(rowCount);
  if (signal?.aborted === true) {
    throw createAbortError();
  }

  // 快照:本次生成整页(含全部分片)都用这一份配置,
  // 即使期间发生热更新也不影响本页,杜绝同页新旧参数混拼。
  await initConfig();
  // 取"当前"缓存而非 initConfig 返回的初次承诺,否则热更新不生效。
  const { rawConfig, config } = getCurrentConfig();
  const columns = config.columns;

  const indices: number[] = [];
  for (let cell = 0; cell < rowCount * columns; cell += 1) {
    indices.push(cell);
  }

  let metrics: string[];
  const activePool = getPool();
  if (activePool !== null) {
    try {
      metrics = await activePool.compute(
        indices,
        config.cellHashRounds,
        signal,
      );
      renderMetricInvocations += indices.length;
      lastComputeMode = "worker-pool";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        // 取消不是池故障:不降级、不标记池不可用,直接向上拒绝。
        throw error;
      }
      poolDisabled = true;
      console.warn(
        "⚠ worker 线程池故障,降级为 setImmediate 分片计算:",
        error instanceof Error ? error.message : String(error),
      );
      await shutdownReportResources();
      metrics = await computeMetricsChunked(
        indices,
        config.cellHashRounds,
        signal,
      );
      lastComputeMode = "chunked-fallback";
    }
  } else {
    metrics = await computeMetricsChunked(
      indices,
      config.cellHashRounds,
      signal,
    );
    lastComputeMode = "chunked-fallback";
  }

  if (signal !== undefined && signal.aborted) {
    throw createAbortError();
  }
  return assembleHtml(rawConfig, config, rowCount, metrics);
}

export interface LagSample {
  /** 采样窗口内事件循环回调的最大延迟(毫秒)。 */
  maxLagMs: number;
  /** 采样窗口内回调延迟的平均值(毫秒)。 */
  meanLagMs: number;
  /** 期间错过 10ms 节拍的回调数量。 */
  delayedTicks: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 用 10ms setInterval 探针 + monitorEventLoopDelay 直方图测量
 * work 执行期间的事件循环延迟。work 可为同步(legacy)或异步(零阻塞)。
 */
async function measureLagDuring(
  work: () => void | Promise<unknown>,
  settleMs: number,
): Promise<LagSample> {
  const tickIntervalMs = 10;
  let maxLagMs = 0;
  let lagSumMs = 0;
  let tickCount = 0;
  let delayedTicks = 0;

  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();

  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const drift = now - previous - tickIntervalMs;
    previous = now;
    tickCount += 1;

    if (drift > 1) {
      maxLagMs = Math.max(maxLagMs, drift);
      lagSumMs += drift;
      if (drift > tickIntervalMs) {
        delayedTicks += 1;
      }
    }
  }, tickIntervalMs);

  await work();
  await delay(settleMs);

  clearInterval(timer);
  histogram.disable();

  const histogramMeanMs = histogram.mean / 1e6;
  return {
    maxLagMs: Math.max(maxLagMs, histogram.max / 1e6),
    meanLagMs:
      tickCount > 0
        ? lagSumMs / tickCount
        : Number.isFinite(histogramMeanMs)
          ? histogramMeanMs
          : 0,
    delayedTicks,
  };
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted[middle] ?? 0;
}

export type BenchPath = "legacy" | "zero" | "both";

export interface PathBenchmark {
  /** 单次生成耗时(毫秒),共 runs 次。 */
  durationsMs: number[];
  medianMs: number;
  /** 单次 generatePage 期间实测事件循环卡顿。 */
  lag: LagSample;
  /** 相对空闲基线的卡顿放大量。 */
  lagAmplification: number;
  digests: string[];
  renderMetricCallsPerRun: number;
  /** 零阻塞路径实际计算模式。 */
  computeMode: ComputeMode | "sync-blocking";
  /** 零阻塞路径实测吞吐(页/秒)。 */
  throughputPagesPerSec?: number;
}

export interface BenchmarkResult {
  rowCount: number;
  columnCount: number;
  cellCount: number;
  baselineLag: LagSample;
  legacy: PathBenchmark | null;
  zero: PathBenchmark | null;
  /** 同一路径多轮输出逐字节一致。 */
  identicalAcrossRuns: boolean;
  /** 两条路径输出逐字节一致。 */
  crossPathIdentical: boolean;
  expectedDigest: string | null;
  digestMatchesExpected: boolean;
  htmlLength: number;
  meets300Calls: boolean;
  /** 零阻塞路径单次生成期间最大卡顿 ≤ 5ms。 */
  zeroPathMaxLagOk: boolean;
}

export interface BenchmarkOptions {
  rowCount?: number;
  runs?: number;
  /** 测量哪条路径,默认 both 双路径对照。 */
  path?: BenchPath;
  /** 吞吐测量窗口(毫秒),仅零阻塞路径。 */
  throughputWindowMs?: number;
}

const ZERO_PATH_MAX_LAG_BUDGET_MS = 5;

/**
 * 双路径对照基准:同一进程内分别测量 legacy 阻塞路径与零阻塞路径的
 * 单次耗时、事件循环最大延迟、卡顿放大量;零阻塞路径额外测量吞吐。
 * 同时校验可复现性(多轮一致、跨路径一致、与基准 SHA-256 一致)。
 */
export async function benchmark(
  options: BenchmarkOptions = {},
): Promise<BenchmarkResult> {
  const rowCount = options.rowCount ?? 64;
  const runs = options.runs ?? 3;
  const pathOption = options.path ?? "both";
  const throughputWindowMs = options.throughputWindowMs ?? 1000;

  // 启动期一次性异步读取并缓存配置,之后请求路径零同步 I/O。
  const { config } = await initConfig();

  const baselineLag = await measureLagDuring(() => delay(300), 50);

  const runLegacy = pathOption === "both" || pathOption === "legacy";
  const runZero = pathOption === "both" || pathOption === "zero";

  let legacy: PathBenchmark | null = null;
  let legacyHtml = "";
  if (runLegacy) {
    const durationsMs: number[] = [];
    const digests: string[] = [];
    let callsPerRun = 0;

    for (let run = 0; run < runs; run += 1) {
      resetRenderMetricInvocations();
      const start = performance.now();
      const html = generatePageLegacy(rowCount);
      durationsMs.push(performance.now() - start);
      digests.push(sha256Hex(html));
      callsPerRun = getRenderMetricInvocations();
      if (run === 0) {
        legacyHtml = html;
      }
    }

    const lag = await measureLagDuring(() => {
      generatePageLegacy(rowCount);
    }, 300);

    legacy = {
      durationsMs,
      medianMs: median(durationsMs),
      lag,
      lagAmplification: lag.maxLagMs / Math.max(baselineLag.maxLagMs, 0.01),
      digests,
      renderMetricCallsPerRun: callsPerRun,
      computeMode: "sync-blocking",
    };
  }

  let zero: PathBenchmark | null = null;
  let zeroHtml = "";
  if (runZero) {
    // 预热:建池 + JIT,不计入测量。
    await generatePage(rowCount);

    const durationsMs: number[] = [];
    const digests: string[] = [];
    let callsPerRun = 0;

    for (let run = 0; run < runs; run += 1) {
      resetRenderMetricInvocations();
      const start = performance.now();
      const html = await generatePage(rowCount);
      durationsMs.push(performance.now() - start);
      digests.push(sha256Hex(html));
      callsPerRun = getRenderMetricInvocations();
      if (run === 0) {
        zeroHtml = html;
      }
    }

    const lag = await measureLagDuring(async () => {
      await generatePage(rowCount);
    }, 300);

    // 吞吐:固定窗口内连续生成,统计每秒页数。
    let pages = 0;
    const throughputStart = performance.now();
    while (performance.now() - throughputStart < throughputWindowMs) {
      await generatePage(rowCount);
      pages += 1;
    }
    const throughputPagesPerSec =
      (pages / (performance.now() - throughputStart)) * 1000;

    zero = {
      durationsMs,
      medianMs: median(durationsMs),
      lag,
      lagAmplification: lag.maxLagMs / Math.max(baselineLag.maxLagMs, 0.01),
      digests,
      renderMetricCallsPerRun: callsPerRun,
      computeMode: getLastComputeMode(),
      throughputPagesPerSec,
    };
  }

  const allDigests = [
    ...(legacy?.digests ?? []),
    ...(zero?.digests ?? []),
  ];
  const identicalAcrossRuns =
    (legacy === null ||
      legacy.digests.every((digest) => digest === legacy.digests[0])) &&
    (zero === null ||
      zero.digests.every((digest) => digest === zero.digests[0]));

  const crossPathIdentical =
    legacy === null || zero === null
      ? true
      : legacyHtml === zeroHtml &&
        (legacy.digests[0] ?? "") === (zero.digests[0] ?? "");

  const expectedDigest = rowCount === 64 ? EXPECTED_SHA256_ROW64 : null;
  const digestMatchesExpected =
    expectedDigest === null
      ? true
      : allDigests.length > 0 &&
        allDigests.every((digest) => digest === expectedDigest);

  const callsPerRun =
    zero?.renderMetricCallsPerRun ?? legacy?.renderMetricCallsPerRun ?? 0;

  return {
    rowCount,
    columnCount: config.columns,
    cellCount: rowCount * config.columns,
    baselineLag,
    legacy,
    zero,
    identicalAcrossRuns,
    crossPathIdentical,
    expectedDigest,
    digestMatchesExpected,
    htmlLength: (zeroHtml || legacyHtml).length,
    meets300Calls: callsPerRun >= 300,
    zeroPathMaxLagOk:
      zero === null || zero.lag.maxLagMs <= ZERO_PATH_MAX_LAG_BUDGET_MS,
  };
}
