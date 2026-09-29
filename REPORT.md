# 可复现的 Node.js 事件循环阻塞反例 —— 方案与结论

纯 TypeScript + Node.js（无 DOM）环境下，刻意构造一个**单进程、可复现、可量化**的事件循环阻塞反例，
并自带基准测量与输出一致性校验。

- 运行方式：`npx tsx src/main.ts`（或 `npm run dev`）
- 类型约束：`strict` 模式、禁 `any`，`tsc --noEmit` 通过
- 运行环境：Node.js v24.21.0，tsx v4.23.15

## 一、文件清单

| 文件 | 作用 |
| --- | --- |
| `src/report.ts` | 核心：`renderMetric`、`generatePage`、`benchmark` |
| `src/main.ts` | 入口，打印基准数字与一致性校验结果 |
| `config.json` | 本地配置，生成 HTML 时同步读取并参与拼接 |
| `tsconfig.json` | 严格 TS 配置（`strict` / `noImplicitAny` / `noUnusedLocals`） |

## 二、阻塞是如何被刻意构造的

`generatePage(rowCount)` 在**同一个同步调用栈**内叠加了两类典型阻塞源：

### 瓶颈 1：同步文件 I/O（`fs.readFileSync`）

每次调用都执行 `readFileSync(resolve("./config.json"), "utf8")`。
同步 I/O 在事件循环所在的主线程上直接等待系统调用返回，期间 libuv 事件循环无法迭代，
任何 I/O 回调、定时器都得不到处理。读取到的配置内容（`title`、`generatedBy`、`columns`、文件字节数）
被真实拼进输出 HTML 的 `<title>`、`<h1>`、`<caption>`、表头单元格等位置。

### 瓶颈 2：CPU 密集串行计算（逐单元格 `renderMetric`）

- 报告为 `rowCount` 行 × 6 列的 `<table>`，**每个 `<td>` 都调用一次** `renderMetric(i)`（默认 60 行 = 360 次）。
- `renderMetric(i)` 是真实 CPU 运算而非空转/常量：内部循环 **80,000 轮**，每轮调用独立函数 `mixStep`，
  执行 `Math.imul` 整数乘法、异或、无符号移位，且每 8 轮触发一次 `Math.sin` 浮点运算，
  最终由累加校验和派生出指标值。
- 因此**单次 `renderMetric` 调用包含 ≥ 80,000 次真实函数执行**（远超「≥300 次」要求）；
  整页为 360 × 80,000 ≈ **2,880 万次**函数执行，且全部在主线程串行完成。
- Node 主线程单线程执行 JS，这段纯 CPU 同步代码在返回前不会释放线程，事件循环因此被独占。

两类瓶颈叠加：线程先卡在同步读盘，再卡在约数百毫秒的连续整数运算上。
这正是生产环境中「请求处理函数里做同步 I/O + 大循环串行计算」的典型反模式。

## 三、基准测量方法（`benchmark`）

`benchmark(rowCount, runs)` 使用 `node:perf_hooks` 输出三组互补指标：

1. **单次/汇总耗时**：`performance.now()` 包裹每次 `generatePage`，给出首次、总耗时、平均、最小/最大值。
2. **事件循环最大延迟**：`monitorEventLoopDelay()` 的 `max`，直接度量 libuv 事件循环被卡住的时长。
3. **定时器饿死探针**：一个 1ms 间隔的 `setInterval`，记录阻塞期间被推迟执行的最大 tick 延迟，
   作为与指标 2 相互独立的旁证。

> 测量要点：`monitorEventLoopDelay` 与 `setInterval` 探针都依赖事件循环在阻塞段**前后真正迭代**才能采到样本，
> 因此 `benchmark` 设计为 `async`，在每次阻塞运行前后 `await setTimeout(...)` 主动让出线程，
> 探针也在阻塞前先 tick 建立基线、阻塞后再采集被饿死的首个 tick。

### 一致性校验

- `renderMetric(i)` 是确定性纯函数（结果只取决于下标），`generatePage` 不使用时间戳/随机数，
  配置经 `JSON.parse` + 类型守卫校验形状。
- 每次运行的 HTML 都计算 SHA-256，比对全部 `runs` 次输出是否**逐字节一致**；
  另经跨进程复跑验证，两次独立进程的哈希完全相同。

## 四、实测结果

`rowCount = 60`（360 个单元格）、`runs = 3`，实测（2026-09-29）：

| 指标 | 数值 |
| --- | --- |
| 单元格数量 | 360（每个 80,000 轮真实整数混合运算） |
| 首次运行耗时 | 357.54 ms |
| 三次总耗时 | 1156.10 ms |
| 平均单次耗时 | 385.37 ms |
| 最小 / 最大耗时 | 357.54 / 400.17 ms |
| 事件循环最大延迟（`monitorEventLoopDelay`） | **410.26 ms** |
| 1ms 定时器最大饿死延迟 | **395.48 ms** |
| HTML 输出大小 | 15,850 字节 |
| SHA-256 | `710afdff562fd033e27b146c2135da51bbca0d924595bef314c75392376afac3` |
| 3 次输出逐字节一致 | **PASS** |
| 跨进程独立复跑哈希一致 | **PASS** |

两个独立指标（事件循环延迟 410.26 ms 与定时器饿死 395.48 ms）数量级吻合，
证明约 400 ms 内进程无法响应任何定时器/I/O 回调——卡顿真实存在，而非单纯的函数耗时。

## 五、复现方式

```bash
npm install
npm run dev          # 等价于 npx tsx src/main.ts
npx tsc --noEmit     # 严格类型检查
```

调整 `src/main.ts` 中的 `ROW_COUNT` 可线性放大或缩小卡顿（耗时与单元格数近似成正比）。

## 六、结论与正确写法对照

- **反例根因**：同步 I/O 占用线程 + 大量 CPU 计算在单个同步调用栈内串行执行，事件循环在整个期间无法迭代。
- **生产环境的修复方向**（本仓库刻意不采用，仅作对照）：
  - 同步 I/O 改为 `fs.promises.readFile`，并对配置做启动期一次性读取/缓存；
  - CPU 密集计算移入 `worker_threads`（或进程池），主线程只负责调度；
  - 若必须留在主线程，将大循环切片，每处理一批 `await setImmediate()` 让出事件循环；
  - 用本项目的两个延迟指标（`monitorEventLoopDelay` + 定时器探针）做上线后的持续监控。
