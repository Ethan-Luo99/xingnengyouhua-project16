import { benchmark } from "./report";

const ROW_COUNT = 60;
const RUNS = 3;

console.log("=== Event-loop blocking counterexample ===");
console.log(`Input: rowCount=${ROW_COUNT}, runs=${RUNS}`);
console.log("Blocking sources: fs.readFileSync per call + serial CPU-bound renderMetric per <td>");
console.log("");

const result = await benchmark(ROW_COUNT, RUNS);

console.log("--- Benchmark ---");
console.log(`Cells rendered        : ${result.cellCount} (each runs 80,000 real integer-mix steps)`);
console.log(`First run duration    : ${result.firstRunMs.toFixed(2)} ms`);
console.log(`Total duration        : ${result.totalMs.toFixed(2)} ms`);
console.log(`Average duration/run  : ${result.averageMs.toFixed(2)} ms`);
console.log(`Min / Max duration    : ${result.minMs.toFixed(2)} / ${result.maxMs.toFixed(2)} ms`);
console.log(`Event-loop max delay  : ${result.eventLoopMaxDelayMs.toFixed(2)} ms (perf_hooks monitorEventLoopDelay)`);
console.log(`Timer max lag (1ms)   : ${result.timerMaxLagMs.toFixed(2)} ms (setInterval starvation probe)`);
console.log(`HTML output bytes     : ${result.outputBytes}`);
console.log(`SHA-256               : ${result.sha256}`);
console.log("");

console.log("--- Consistency check ---");
console.log(`All ${result.runs} runs produced byte-identical HTML: ${result.consistent ? "PASS" : "FAIL"}`);

if (!result.consistent) {
  process.exitCode = 1;
}
