import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 刻意构造的事件循环阻塞反例。
 *
 * 阻塞来源有两处，二者都运行在事件循环线程上：
 *  1. 同步 I/O —— generatePage 每次调用都执行 readFileSync("./config.json")。
 *     libuv 在同步系统调用期间无法处理定时器 / I/O 回调 / 微任务之外的任何事件。
 *  2. CPU 密集串行计算 —— 每个 <td> 都真实调用 renderMetric(i)，其内部是
 *     纯整数的哈希混合 + 试除质数判定，rowCount * columns 个单元格串行执行，
 *     长时间占用调用栈，事件循环在整段计算结束前没有任何机会取得控制权。
 */

const CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "config.json",
);

const COLUMN_COUNT_FALLBACK = 8;
const HASH_ROUNDS_FALLBACK = 2000;

interface ReportConfig {
  title: string;
  generator: string;
  columns: number;
  cellHashRounds: number;
}

/** renderMetric 被调用的真实次数，用于在基准中校验 ">=300 次函数执行"。 */
let renderMetricInvocations = 0;

export function getRenderMetricInvocations(): number {
  return renderMetricInvocations;
}

export function resetRenderMetricInvocations(): void {
  renderMetricInvocations = 0;
}

/**
 * 32 位整数 xorshift-multiply 混合（确定性、无随机源、无浮点误差），
 * 是真实的逐轮 CPU 运算，不是空转也不是常量返回。
 */
function mixHash32(state: number, round: number): number {
  let h = (state ^ round) | 0;
  h ^= h << 13;
  h = (h | 0) >>> 0;
  h ^= h >>> 17;
  h = (h | 0) >>> 0;
  h ^= h << 5;
  h = Math.imul(h, 0x9e3779b9) >>> 0;
  return h;
}

function isPrime(candidate: number): boolean {
  if (candidate < 2) {
    return false;
  }
  if (candidate % 2 === 0) {
    return candidate === 2;
  }
  const limit = Math.floor(Math.sqrt(candidate));
  for (let divisor = 3; divisor <= limit; divisor += 2) {
    if (candidate % divisor === 0) {
      return false;
    }
  }
  return true;
}

/**
 * 每个单元格调用一次的真实 CPU 计算函数。
 * 依据单元格序号 i 做确定性运算，输出一个两位小数的指标字符串。
 */
export function renderMetric(i: number): string {
  renderMetricInvocations += 1;

  const rounds = loadConfigSync().cellHashRounds;
  let h = (0x811c9dc5 ^ (i + 1)) >>> 0;

  for (let round = 0; round < rounds; round += 1) {
    h = mixHash32(h, round);
  }

  // 在哈希结果附近试除寻找一个质数，进一步增加真实的整数运算量。
  const primeCandidateBase = (h % 4096) * 2 + 1001;
  let candidate = primeCandidateBase;
  while (!isPrime(candidate)) {
    candidate += 2;
  }

  const metric = (h % 100000) / 100 + (candidate % 97) / 100;
  return metric.toFixed(2);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 同步读取并解析 ./config.json —— 阻塞点之一。 */
export function loadConfigSync(): ReportConfig {
  const raw = readFileSync(CONFIG_PATH, "utf8");
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

/**
 * 生成 <table> 结构的 HTML 报告。
 * 每个单元格真实调用 renderMetric(i)（i 全局递增），
 * 输出完全由 (rowCount, config.json) 决定，因此可复现。
 */
export function generatePage(rowCount: number): string {
  if (!Number.isInteger(rowCount) || rowCount < 0) {
    throw new Error("rowCount 必须是非负整数");
  }

  const rawConfig = readFileSync(CONFIG_PATH, "utf8");
  const config = loadConfigSync();
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
      cells.push(`<td data-i="${metricIndex}">${renderMetric(metricIndex)}</td>`);
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

export interface LagSample {
  /** 采样窗口内事件循环回调的最大延迟（毫秒）。 */
  maxLagMs: number;
  /** 采样窗口内回调延迟的平均值（毫秒）。 */
  meanLagMs: number;
  /** 期间错过 10ms 节拍的回调数量。 */
  delayedTicks: number;
}

/**
 * 用一个 10ms 的 setInterval 作为探针测量事件循环延迟。
 * 空闲时各 tick 间隔约 10ms；同步阻塞期间探针无法触发，
 * 阻塞结束后的首个 tick 会"还债"，其超出 10ms 的漂移即卡顿量。
 */
async function measureEventLoopLag(
  blockedWork: () => void,
  warmupMs: number,
): Promise<LagSample> {
  const tickIntervalMs = 10;
  let maxLagMs = 0;
  let lagSumMs = 0;
  let tickCount = 0;
  let delayedTicks = 0;

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
      blockedWork();
    }, warmupMs);

    setTimeout(
      () => {
        clearInterval(timer);
        resolve();
      },
      warmupMs + 2500,
    );
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

export interface BenchmarkResult {
  rowCount: number;
  columnCount: number;
  cellCount: number;
  renderMetricCallsPerRun: number;
  renderMetricCallsEachRun: number[];
  meets300Calls: boolean;
  totalDurationsMs: number[];
  totalMedianMs: number;
  blockedLag: LagSample;
  baselineLag: LagSample;
  identicalAcrossRuns: boolean;
  digests: string[];
  syncConfigReadMs: number;
  htmlLength: number;
}

export interface BenchmarkOptions {
  rowCount?: number;
  runs?: number;
}

/**
 * 量化卡顿并校验可复现性：
 *  - 总耗时：performance.now() 包裹同步 generatePage；
 *  - 事件延迟：setInterval 探针 + monitorEventLoopDelay 直方图（max/mean）；
 *  - 可复现：多次运行的 HTML 逐字节相等且 SHA-256 相同。
 */
export async function benchmark(
  options: BenchmarkOptions = {},
): Promise<BenchmarkResult> {
  const rowCount = options.rowCount ?? 64;
  const runs = options.runs ?? 3;
  const config = loadConfigSync();

  const totalDurationsMs: number[] = [];
  const digests: string[] = [];
  const outputs: string[] = [];
  const callsEachRun: number[] = [];

  for (let run = 0; run < runs; run += 1) {
    resetRenderMetricInvocations();
    const start = performance.now();
    const html = generatePage(rowCount);
    const end = performance.now();

    totalDurationsMs.push(end - start);
    digests.push(sha256Hex(html));
    outputs.push(html);
    callsEachRun.push(getRenderMetricInvocations());
  }

  const renderMetricCallsPerRun = callsEachRun[0] ?? 0;

  const firstDigest = digests[0] ?? "";
  const identicalAcrossRuns = digests.every(
    (digest) => digest === firstDigest,
  ) && outputs.every((html) => html === (outputs[0] ?? ""));

  const readStart = performance.now();
  readFileSync(CONFIG_PATH, "utf8");
  const syncConfigReadMs = performance.now() - readStart;

  const baselineHistogram = monitorEventLoopDelay({ resolution: 1 });
  baselineHistogram.enable();
  const baselineLag = await measureEventLoopLag(() => {
    // 空闲基线：不做任何阻塞工作。
  }, 300);
  baselineHistogram.disable();

  const blockedHistogram = monitorEventLoopDelay({ resolution: 1 });
  blockedHistogram.enable();
  const blockedLag = await measureEventLoopLag(() => {
    resetRenderMetricInvocations();
    generatePage(rowCount);
  }, 300);
  blockedHistogram.disable();

  return {
    rowCount,
    columnCount: config.columns,
    cellCount: rowCount * config.columns,
    renderMetricCallsPerRun,
    renderMetricCallsEachRun: callsEachRun,
    meets300Calls: renderMetricCallsPerRun >= 300,
    totalDurationsMs,
    totalMedianMs: median(totalDurationsMs),
    blockedLag: {
      maxLagMs: Math.max(
        blockedLag.maxLagMs,
        blockedHistogram.max / 1e6,
      ),
      meanLagMs:
        blockedLag.meanLagMs > 0
          ? blockedLag.meanLagMs
          : blockedHistogram.mean / 1e6,
      delayedTicks: blockedLag.delayedTicks,
    },
    baselineLag: {
      maxLagMs: Math.max(baselineLag.maxLagMs, baselineHistogram.max / 1e6),
      meanLagMs:
        baselineLag.meanLagMs > 0
          ? baselineLag.meanLagMs
          : baselineHistogram.mean / 1e6,
      delayedTicks: baselineLag.delayedTicks,
    },
    identicalAcrossRuns,
    digests,
    syncConfigReadMs,
    htmlLength: outputs[0]?.length ?? 0,
  };
}
