# 事件循环阻塞反例:方案与基准结论

纯 TypeScript + Node.js(无 DOM、无 `any`)构造的**可复现事件循环阻塞反例**,并自带基准测量与一致性校验。

- 运行环境:Node.js v24.21.0,tsx v4.23.15,TypeScript strict
- 入口:`src/main.ts` → `benchmark()`(`src/report.ts`)
- 运行方式:`npx tsx src/main.ts`(沙箱内若 tsx IPC 被禁,可用 `node --import tsx src/main.ts`)

## 1. 方案:刻意制造的两种瓶颈

`generatePage(rowCount)`(`src/report.ts:214`,legacy 阻塞路径)在**同一个事件循环 tick** 内叠加了两类典型阻塞写法,二者都跑在主线程上,期间事件循环无法处理定时器、I/O 回调等任何事件:

### 1.1 同步 I/O:`readFileSync`

- `generatePage` 内部用 `readFileSync` 同步读取本地 `./config.json`(`src/report.ts:218`),`renderMetric` 每单元格也会经 `loadConfigSync` 触发同步读取(`src/report.ts:124`)。
- **为什么卡**:同步系统调用期间 libuv 事件循环被整个挂起,必须等内核返回才能继续;异步 `fs.promises.readFile` 则会把等待让渡给 libuv 线程池,不阻塞循环。
- 读到的**原始 JSON 文本直接参与 HTML 拼接**(写入 `<!-- config: ... -->` 注释与 `<title>`、`data-*` 属性),满足"读取本地配置参与拼接"。

### 1.2 CPU 密集串行计算:逐单元格真实运算

- 每个 `<td>` 都真实调用一次 `renderMetric(i)`(`src/report.ts:76`),共 `rowCount × columns` 次(rowCount=64、8 列时为 **512 次**,满足单次 ≥ 300 次函数执行,且每轮计数打印为 `[512, 512, 512]`)。
- `renderMetric` 是**真实整数运算**,不是空转/常量:
  - `mixHash32`(`src/metric-core.ts:11`):`cellHashRounds`(默认 180000)轮 xorshift 移位 + `Math.imul` 32 位乘法混合,全程纯整数、确定性;
  - `isPrime`(`src/metric-core.ts:22`):在哈希结果附近做开方试除寻找质数;
  - 最终由哈希值与质数算出两位小数指标。
- **为什么卡**:512 个单元格 × 18 万轮串行执行,长时间独占调用栈,事件循环在整段同步计算结束前没有任何机会取得控制权(没有 `await`、没有 `setImmediate` 让出)。

> 这正是生产环境中最常见的反模式:在请求处理路径上使用同步 I/O,或一次性在主线程做大块序列化/加解密/模板渲染。

## 2. 基准如何量化卡顿

`benchmark()`(`src/report.ts:539`)同时使用两种手段并做对照:

- **单次总耗时**:`performance.now()` 包裹同步 `generatePage`,跑 3 次取中位数。
- **事件循环延迟(卡顿)**:
  - 10ms `setInterval` 探针(`measureEventLoopLag`,`src/report.ts:383`):空闲时 tick 间隔约 10ms;同步阻塞期间探针无法触发,阻塞结束后首个 tick 的漂移即卡顿量,记录最大延迟、平均延迟与错过节拍数;
  - `perf_hooks.monitorEventLoopDelay` 直方图(`src/report.ts:511`)交叉验证 max/mean,取两者最大值作为最大卡顿。
  - 另测一段**空闲基线**作对照,输出"卡顿放大量"。
- **结果一致性(可复现)校验**:3 次生成结果逐字节比较 + SHA-256 摘要全部相同;输出只依赖 `(rowCount, config.json)`,不含时间戳/随机源。任一校验失败则进程退出码为 1。

## 3. 实测结论

固定输入 `rowCount=64`(8 列,512 个单元格,`cellHashRounds=180000`),代表性实测:

| 指标 | 数值 |
| --- | --- |
| `renderMetric` 真实调用 | 512 次/单次(要求 ≥300,**通过**) |
| 单次总耗时(3 次) | 183.44 / 178.35 / 184.72 ms,中位数 183.44 ms |
| 空闲基线最大卡顿 | 约 1.6–2.0 ms |
| 阻塞期间最大卡顿 | 约 176–184 ms,错过 1 个 10ms 节拍 |
| 卡顿放大量 | 约 88–115 倍 |
| 3 次 HTML SHA-256 | 完全一致 |
| 跨进程两次运行摘要 | 一致(见下) |
| 总体结论 | 阻塞可观测且结果可复现(退出码 0) |

三次输出的 SHA-256 均为:

```
a6aeae862721779f9d4d043de1a3a37aae0b60057a7541e75d7d18fa27ceb7dc
```

在**两个独立进程**中分别运行,该摘要保持不变,证明输出跨进程可复现而非仅同进程内稳定。HTML 长度 15416 字符,为标准 `<table>` 结构(`<thead>/<tbody>/<tr>/<td data-i>`),单元格值为真实运算结果(如 `567.15`、`482.73`)。

## 4. 修复对照(零阻塞重构)

在保留 legacy 阻塞路径的前提下,新增零阻塞路径,两类阻塞均已消除:

- **同步 I/O → 启动期异步缓存**:`initConfigCache()`(`src/report.ts`)在启动期用 `fs/promises.readFile` 一次性读取并缓存 `config.json`,`generatePageAsync` 只读缓存,请求路径上没有任何同步 I/O。
- **CPU 串行计算 → worker_threads 线程池**:单元格计算抽成纯函数 `computeMetricValue(i, rounds)`(`src/metric-core.ts`),由固定大小线程池(`src/metric-pool.ts`,worker 入口 `src/metric-worker.ts`)分片并行执行;结果只依赖 `(index, rounds)`,与分片/调度顺序无关。
- **异常降级**:线程池创建失败或 worker 运行中崩溃时,自动降级为主线程 `setImmediate` 时间片计算(每片 ≤ 2ms)并打印 `[告警]`,进程不会因此非 0 退出;`shutdownMetricPool()` 支持优雅关闭。可用 `REPORT_DISABLE_POOL=1` 强制走降级路径验证。
- **逐字节等价**:两条路径共用 `assembleHtml` 与 `computeMetricValue`,输出 SHA-256 与阻塞原版完全一致。

### 4.1 双路径实测对照(同一进程,`rowCount=64`,512 单元格)

以下数据为 `npx tsx src/main.ts` 真实运行输出(Node.js v24.21.0):

| 指标 | legacy(阻塞) | zero(零阻塞,线程池) |
| --- | --- | --- |
| 单次耗时(3 轮) | 183.68 / 178.02 / 178.78 ms | 108.34 / 24.35 / 25.49 ms |
| 单次耗时中位数 | 178.78 ms | 25.49 ms |
| 事件循环最大卡顿 | 176.95 ms | **1.78 ms**(预算 ≤ 5 ms,达标) |
| 事件循环平均延迟 | 5.40 ms | 0.04 ms |
| 错过 10ms 节拍 | 1 次 | 0 次 |
| 卡顿放大量(对空闲基线 1.67 ms) | 106.21x | 1.07x |
| 吞吐 | —(阻塞,不测) | 41.31 页/秒 |
| 输出 SHA-256 | `a6aeae86…ceb7dc` | `a6aeae86…ceb7dc`(逐字节一致) |

### 4.2 降级路径实测(`REPORT_DISABLE_POOL=1`,setImmediate 分片)

| 指标 | 数值 |
| --- | --- |
| 单次耗时中位数 | 175.76 ms(与 legacy 相同量级,计算仍在主线程) |
| 事件循环最大卡顿 | **3.15 ms**(预算 ≤ 5 ms,达标) |
| 卡顿放大量 | 2.03x |
| 吞吐 | 5.74 页/秒 |
| 输出 SHA-256 | `a6aeae86…ceb7dc`(与线程池路径一致) |
| 进程退出码 | 0(降级只打印告警,不导致非 0 退出) |

结论:线程池路径在输出逐字节不变的前提下,把单次生成期间的事件循环最大卡顿从约 177 ms 降到 1.78 ms(≤ 5 ms 预算),卡顿放大量从约 106x 降到约 1x,并带来约 41 页/秒的吞吐;即使线程池不可用,分片降级也能把卡顿压在 5 ms 预算内。

## 5. 文件说明

- `src/report.ts` — 双路径实现与基准:`generatePage`/`renderMetric`/`loadConfigSync`(legacy 阻塞路径,保留对照)、`initConfigCache`/`generatePageAsync`/`shutdownMetricPool`(零阻塞路径)、`benchmark`(双路径对比测量)。
- `src/metric-core.ts` — 纯计算核心 `computeMetricValue(i, rounds)`,主线程与 worker 共用,保证结果与调度无关。
- `src/metric-worker.ts` — worker_threads 工作线程入口。
- `src/metric-pool.ts` — 固定大小线程池:分片派发、崩溃检测、降级通知、优雅关闭。
- `src/main.ts` — 调 `benchmark({ rowCount: 64, runs: 3 })` 并打印双路径对照表与全部校验结论。
- `config.json` — 本地配置;`columns` 决定列数,`cellHashRounds` 调节每单元格计算量(结构与模板均未改动)。
- `tsconfig.json` — `strict` + `noImplicitAny`,`tsc --noEmit` 通过,源码无 `any`。

## 6. 复现与调节

```bash
npx tsc --noEmit      # 严格类型检查
npx tsx src/main.ts   # 双路径对照基准 + 全部验证结论(沙箱内若 tsx IPC 被禁,可用 node --import tsx src/main.ts)
REPORT_DISABLE_POOL=1 npx tsx src/main.ts   # 强制 setImmediate 分片降级路径
```

- 想让卡顿更明显/更轻:改 `config.json` 的 `cellHashRounds`(与卡顿近似线性),或改 `src/main.ts` 中 `rowCount`。
- 校验任一失败(两路径输出不一致、与阻塞原版 SHA-256 不符、零阻塞路径卡顿超 5 ms 预算)进程退出码为 1;worker 降级本身不导致非 0 退出。
