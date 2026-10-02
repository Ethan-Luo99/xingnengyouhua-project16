import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { computeMetricValue } from "./metric-core.js";
import { MetricWorkerPool } from "./metric-pool.js";

/**
 * 双路径报告生成器:
 *
 *  - legacy(阻塞反例,保留用于对照):generatePage 每次调用都 readFileSync
 *    ./config.json,renderMetric 每单元格再次同步读配置,rowCount × columns
 *    个单元格的 CPU 计算在主线程一次性串行跑完,事件循环被整体挂起。
 *
 *  - zero(零阻塞):config.json 在启动期由 initConfigCache() 异步读取一次并缓存,
 *    请求路径上没有任何同步 I/O;单元格计算默认派发给 worker_threads 线程池
 *    (computeMetricValue 只依赖 (index, rounds),结果与分片/调度顺序无关),
 *    线程池不可用时自动降级为 setImmediate 时间片计算并打印告警,
 *    单次 generatePageAsync 期间事件循环最大卡顿 ≤ 5ms。
 *
 * 两条路径共用 assembleHtml 与 computeMetricValue,输出逐字节等价。
 */

const CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "config.json",
);

const COLUMN_COUNT_FALLBACK = 8;
const HASH_ROUNDS_FALLBACK = 2000;

/** 零阻塞路径单次 generatePageAsync 期间允许的事件循环最大卡顿。 */
export const MAX_LAG_BUDGET_MS = 5;

/** 重构前阻塞版本 generatePage(64) 的 SHA-256,零阻塞路径必须逐字节复现。 */
export const EXPECTED_SHA256 =
  "a6aeae862721779f9d4d043de1a3a37aae0b60057a7541e75d7d18fa27ceb7dc";

interface ReportConfig {
  title: string;
  generator: string;
  columns: number;
  cellHashRounds: number;
}

/** renderMetric(legacy 路径)被调用的真实次数,用于校验 ">=300 次函数执行"。 */
let renderMetricInvocations = 0;

export function getRenderMetricInvocations(): number {
  return renderMetricInvocations;
}

export function resetRenderMetricInvocations(): void {
  renderMetricInvocations = 0;
}

/** 零阻塞路径实际计算的单元格数(与 renderMetric 等效)。 */
let asyncMetricInvocations = 0;

export function getAsyncMetricInvocations(): number {
  return asyncMetricInvocations;
}

export function resetAsyncMetricInvocations(): void {
  asyncMetricInvocations = 0;
}

/**
 * 每个单元格调用一次的真实 CPU 计算函数(legacy 阻塞版本)。
 * 保留原行为:每次都经 loadConfigSync() 同步读取 config.json。
 */
export function renderMetric(i: number): string {
  renderMetricInvocations += 1;
  const rounds = loadConfigSync().cellHashRounds;
  return computeMetricValue(i, rounds);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseConfig(raw: string): ReportConfig {
  const parsed: unknown = JSON.parse(raw);

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

  return {
    title: String(record.title),
    generator: String(record.generator),
    columns,
    cellHashRounds,
  };
}

/** 同步读取并解析 ./config.json —— legacy 阻塞路径保留。 */
export function loadConfigSync(): ReportConfig {
  return parseConfig(readFileSync(CONFIG_PATH, "utf8"));
}

/** 启动期异步读取并缓存的配置(零阻塞路径唯一配置来源)。 */
interface CachedConfig {
  config: ReportConfig;
  raw: string;
}

let cachedConfig: CachedConfig | null = null;

/**
 * 启动期一次性异步读取 config.json 并缓存。
 * 之后 generatePageAsync 只读缓存,请求路径上没有任何同步 I/O。
 */
export async function initConfigCache(): Promise<void> {
  const raw = await readFile(CONFIG_PATH, "utf8");
  cachedConfig = { config: parseConfig(raw), raw };
}

function requireCachedConfig(): CachedConfig {
  if (cachedConfig === null) {
    throw new Error("配置尚未初始化,请先调用 initConfigCache()");
  }
  return cachedConfig;
}

/**
 * 两条路径共用的 HTML 拼装函数,保证输出逐字节等价。
 * metrics[row * columns + column] 即单元格 (row, column) 的指标字符串。
 */
function assembleHtml(
  rowCount: number,
  config: ReportConfig,
  rawConfig: string,
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

/**
 * legacy 阻塞路径:同步读配置 + 主线程串行计算全部单元格。
 * 保留作为基准对照,不要在新代码中使用。
 */
export function generatePage(rowCount: number): string {
  if (!Number.isInteger(rowCount) || rowCount < 0) {
    throw new Error("rowCount 必须是非负整数");
  }

  const rawConfig = readFileSync(CONFIG_PATH, "utf8");
  const config = loadConfigSync();
  const columns = config.columns;

  const metrics: string[] = [];
  for (let index = 0; index < rowCount * columns; index += 1) {
    metrics.push(renderMetric(index));
  }

  return assembleHtml(rowCount, config, rawConfig, metrics);
}

// ---------------------------------------------------------------------------
// 零阻塞路径:worker_threads 线程池 + setImmediate 分片降级
// ---------------------------------------------------------------------------

/** 分片降级模式下,每个时间片允许占用的主线程时长(远小于 5ms 预算)。 */
const SLICE_BUDGET_MS = 2;

let metricPool: MetricWorkerPool | null = null;
let poolInitPromise: Promise<MetricWorkerPool | null> | null = null;
let fallbackWarned = false;

function warnFallback(reason: string): void {
  if (!fallbackWarned) {
    fallbackWarned = true;
    console.warn(`[告警] worker 线程池不可用,降级为 setImmediate 分片计算: ${reason}`);
  }
}

/**
 * 初始化线程池;失败(无法创建 worker、自检计算异常等)时返回 null,
 * 调用方自动降级,进程不会因此非 0 退出。
 */
async function createPool(): Promise<MetricWorkerPool | null> {
  // 测试/演示用途:强制走降级路径。
  if (process.env.REPORT_DISABLE_POOL === "1") {
    warnFallback("已通过 REPORT_DISABLE_POOL=1 手动禁用线程池");
    return null;
  }
  try {
    const workerUrl = new URL("./metric-worker.ts", import.meta.url);
    const size = Math.max(2, Math.min(os.availableParallelism() - 1, 8));
    const pool = new MetricWorkerPool(size, workerUrl);
    // 自检:确认 worker 能正常执行计算再投入使用。
    await pool.compute([0], 1);
    return pool;
  } catch (error) {
    warnFallback(error instanceof Error ? error.message : String(error));
    return null;
  }
}

function getPool(): Promise<MetricWorkerPool | null> {
  if (metricPool !== null) {
    return Promise.resolve(metricPool);
  }
  poolInitPromise ??= createPool().then((pool) => {
    metricPool = pool;
    return pool;
  });
  return poolInitPromise;
}

/** 优雅关闭线程池(进程退出前调用)。 */
export async function shutdownMetricPool(): Promise<void> {
  const pool = metricPool;
  metricPool = null;
  poolInitPromise = null;
  if (pool !== null) {
    await pool.shutdown();
  }
}

/** setImmediate 时间片计算:每片 ≤ SLICE_BUDGET_MS,片间让出事件循环。 */
async function computeMetricsSliced(
  indices: number[],
  rounds: number,
): Promise<string[]> {
  const results: string[] = new Array<string>(indices.length);
  let sliceStart = performance.now();

  for (let k = 0; k < indices.length; k += 1) {
    const index = indices[k];
    if (index !== undefined) {
      results[k] = computeMetricValue(index, rounds);
    }
    if (performance.now() - sliceStart >= SLICE_BUDGET_MS) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      sliceStart = performance.now();
    }
  }

  return results;
}

/**
 * 计算全部单元格指标。优先走线程池;线程池不可用或运行中崩溃时,
 * 降级为 setImmediate 分片计算并打印告警。两种方式的计算结果完全一致
 * (computeMetricValue 是纯函数,与调度无关)。
 */
async function computeAllMetrics(
  cellCount: number,
  rounds: number,
): Promise<string[]> {
  const indices: number[] = [];
  for (let index = 0; index < cellCount; index += 1) {
    indices.push(index);
  }

  const pool = await getPool();
  if (pool !== null && !pool.isBroken) {
    try {
      return await pool.compute(indices, rounds);
    } catch (error) {
      warnFallback(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return computeMetricsSliced(indices, rounds);
}

/**
 * 零阻塞路径:配置来自启动期缓存(无同步 I/O),
 * 单元格计算在线程池或 setImmediate 时间片中完成,事件循环保持响应。
 * 输出与 generatePage 逐字节等价。
 */
export async function generatePageAsync(rowCount: number): Promise<string> {
  if (!Number.isInteger(rowCount) || rowCount < 0) {
    throw new Error("rowCount 必须是非负整数");
  }

  const cached = requireCachedConfig();
  const cellCount = rowCount * cached.config.columns;
  const metrics = await computeAllMetrics(
    cellCount,
    cached.config.cellHashRounds,
  );
  asyncMetricInvocations += cellCount;

  return assembleHtml(rowCount, cached.config, cached.raw, metrics);
}

// ---------------------------------------------------------------------------
// 事件循环延迟测量
// ---------------------------------------------------------------------------

export interface LagSample {
  /** 采样窗口内事件循环回调的最大延迟(毫秒)。 */
  maxLagMs: number;
  /** 采样窗口内回调延迟的平均值(毫秒)。 */
  meanLagMs: number;
  /** 期间错过 10ms 节拍的回调数量。 */
  delayedTicks: number;
}

/**
 * 用 10ms setInterval 探针测量 work 执行期间的事件循环延迟。
 * work 可以是同步函数(legacy)或异步函数(零阻塞路径)。
 */
async function measureEventLoopLag(
  work: () => void | Promise<void>,
  warmupMs: number,
  observeMs: number,
): Promise<LagSample> {
  const tickIntervalMs = 10;
  let maxLagMs = 0;
  let lagSumMs = 0;
  let tickCount = 0;
  let delayedTicks = 0;

  let done = false;
  let workPromise: void | Promise<void>;

  await new Promise<void>((resolve) => {
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

    setTimeout(() => {
      workPromise = work();
      void Promise.resolve(workPromise).then(() => {
        done = true;
      });
    }, warmupMs);

    const poll = setInterval(() => {
      if (done && performance.now() >= stopAt) {
        clearInterval(poll);
        clearInterval(timer);
        resolve();
      }
    }, 5);

    const stopAt = performance.now() + warmupMs + observeMs;
  });

  return {
    maxLagMs,
    meanLagMs: tickCount > 0 ? lagSumMs / tickCount : 0,
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

// ---------------------------------------------------------------------------
// 双路径对比基准
// ---------------------------------------------------------------------------

export interface PathStats {
  /** 单次生成耗时样本(毫秒)。 */
  durationsMs: number[];
  medianMs: number;
  /** 生成期间事件循环最大卡顿(毫秒)。 */
  maxLagMs: number;
  meanLagMs: number;
  delayedTicks: number;
  /** 相对空闲基线的卡顿放大量。 */
  lagAmplification: number;
  digest: string;
}

export interface BenchmarkResult {
  rowCount: number;
  columnCount: number;
  cellCount: number;
  renderMetricCallsPerRun: number;
  renderMetricCallsEachRun: number[];
  asyncMetricCallsPerRun: number;
  meets300Calls: boolean;
  legacy: PathStats;
  zero: PathStats;
  /** 零阻塞路径吞吐(页/秒)。 */
  zeroThroughputPagesPerSec: number;
  /** 零阻塞路径单次最大卡顿是否 ≤ MAX_LAG_BUDGET_MS。 */
  zeroMeetsLagBudget: boolean;
  baselineLag: LagSample;
  identicalAcrossRuns: boolean;
  crossPathIdentical: boolean;
  matchesExpectedDigest: boolean;
  digests: string[];
  syncConfigReadMs: number;
  htmlLength: number;
  poolActive: boolean;
}

export interface BenchmarkOptions {
  rowCount?: number;
  runs?: number;
  /** 吞吐测量窗口(毫秒)。 */
  throughputWindowMs?: number;
}

async function measurePath(
  generate: () => Promise<string>,
  runs: number,
): Promise<{ durationsMs: number[]; digest: string; html: string; lag: LagSample }> {
  const durationsMs: number[] = [];
  let html = "";

  for (let run = 0; run < runs; run += 1) {
    const start = performance.now();
    html = await generate();
    durationsMs.push(performance.now() - start);
  }

  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const lag = await measureEventLoopLag(
    async () => {
      await generate();
    },
    300,
    200,
  );
  histogram.disable();

  return {
    durationsMs,
    digest: sha256Hex(html),
    html,
    lag: {
      maxLagMs: Math.max(lag.maxLagMs, histogram.max / 1e6),
      meanLagMs: lag.meanLagMs > 0 ? lag.meanLagMs : histogram.mean / 1e6,
      delayedTicks: lag.delayedTicks,
    },
  };
}

/**
 * 双路径对比基准:同一进程内分别测量 legacy(阻塞)与 zero(零阻塞)路径的
 * 单次耗时、事件循环最大延迟、卡顿放大量,并校验两条路径输出逐字节一致、
 * 且与 EXPECTED_SHA256 相同。零阻塞路径额外测量吞吐(页/秒)。
 */
export async function benchmark(
  options: BenchmarkOptions = {},
): Promise<BenchmarkResult> {
  const rowCount = options.rowCount ?? 64;
  const runs = options.runs ?? 3;
  const throughputWindowMs = options.throughputWindowMs ?? 2000;

  await initConfigCache();
  const config = requireCachedConfig().config;

  // 空闲基线
  const baselineHistogram = monitorEventLoopDelay({ resolution: 1 });
  baselineHistogram.enable();
  const baselineLag = await measureEventLoopLag(() => {}, 300, 200);
  baselineHistogram.disable();
  const baseline: LagSample = {
    maxLagMs: Math.max(baselineLag.maxLagMs, baselineHistogram.max / 1e6),
    meanLagMs:
      baselineLag.meanLagMs > 0
        ? baselineLag.meanLagMs
        : baselineHistogram.mean / 1e6,
    delayedTicks: baselineLag.delayedTicks,
  };

  // legacy 阻塞路径(每次生成前重置计数器,逐次记录 renderMetric 真实调用数)
  const legacyCallsPerRun: number[] = [];
  const legacyResult = await measurePath(async () => {
    resetRenderMetricInvocations();
    const html = generatePage(rowCount);
    legacyCallsPerRun.push(getRenderMetricInvocations());
    return html;
  }, runs);

  // 零阻塞路径
  const zeroResult = await measurePath(
    () => generatePageAsync(rowCount),
    runs,
  );

  // 单独测量零阻塞路径单次生成的等效计算次数
  resetAsyncMetricInvocations();
  await generatePageAsync(rowCount);
  const asyncCallsPerRun = getAsyncMetricInvocations();

  // 零阻塞吞吐:固定窗口内连续生成的页数
  let pages = 0;
  const windowStart = performance.now();
  while (performance.now() - windowStart < throughputWindowMs) {
    await generatePageAsync(rowCount);
    pages += 1;
  }
  const elapsedSec = (performance.now() - windowStart) / 1000;
  const zeroThroughput = pages / elapsedSec;

  const readStart = performance.now();
  readFileSync(CONFIG_PATH, "utf8");
  const syncConfigReadMs = performance.now() - readStart;

  const amplification = (maxLagMs: number): number =>
    maxLagMs / Math.max(baseline.maxLagMs, 0.01);

  const legacyDigest = legacyResult.digest;
  const zeroDigest = zeroResult.digest;

  const digests = [legacyDigest, zeroDigest];
  const crossPathIdentical = legacyResult.html === zeroResult.html;
  const identicalAcrossRuns = crossPathIdentical;
  const matchesExpectedDigest = zeroDigest === EXPECTED_SHA256;

  return {
    rowCount,
    columnCount: config.columns,
    cellCount: rowCount * config.columns,
    renderMetricCallsPerRun: legacyCallsPerRun[0] ?? 0,
    renderMetricCallsEachRun: legacyCallsPerRun.slice(0, runs),
    asyncMetricCallsPerRun: asyncCallsPerRun,
    meets300Calls: (legacyCallsPerRun[0] ?? 0) >= 300,
    legacy: {
      durationsMs: legacyResult.durationsMs,
      medianMs: median(legacyResult.durationsMs),
      maxLagMs: legacyResult.lag.maxLagMs,
      meanLagMs: legacyResult.lag.meanLagMs,
      delayedTicks: legacyResult.lag.delayedTicks,
      lagAmplification: amplification(legacyResult.lag.maxLagMs),
      digest: legacyDigest,
    },
    zero: {
      durationsMs: zeroResult.durationsMs,
      medianMs: median(zeroResult.durationsMs),
      maxLagMs: zeroResult.lag.maxLagMs,
      meanLagMs: zeroResult.lag.meanLagMs,
      delayedTicks: zeroResult.lag.delayedTicks,
      lagAmplification: amplification(zeroResult.lag.maxLagMs),
      digest: zeroDigest,
    },
    zeroThroughputPagesPerSec: zeroThroughput,
    zeroMeetsLagBudget: zeroResult.lag.maxLagMs <= MAX_LAG_BUDGET_MS,
    baselineLag: baseline,
    identicalAcrossRuns,
    crossPathIdentical,
    matchesExpectedDigest,
    digests,
    syncConfigReadMs,
    htmlLength: zeroResult.html.length,
    poolActive: metricPool !== null && !metricPool.isBroken,
  };
}
