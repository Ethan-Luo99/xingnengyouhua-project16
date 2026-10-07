# 事件循环阻塞反例:方案、基准结论与零阻塞修复对照

纯 TypeScript + Node.js(无 DOM、无 `any`)的**可复现事件循环阻塞反例**,现已重构为
**legacy 阻塞 / 零阻塞双路径对照基准**:反例实现原样保留,零阻塞路径在
worker_threads 线程池中完成全部 CPU 计算,两条路径输出逐字节等价。

- 运行环境:Node.js v24.21.0,tsx v4.23.15,TypeScript strict
- 入口:`src/main.ts` → `benchmark()`(`src/report.ts:613`)
- 运行方式:`npx tsx src/main.ts`(沙箱内若 tsx IPC 被禁,可用 `node --import tsx src/main.ts`)

## 1. 方案:刻意制造的两种瓶颈(legacy 路径,原样保留)

`generatePageLegacy(rowCount)`(`src/report.ts:305`)在**同一个事件循环 tick** 内叠加了两类典型阻塞写法,二者都跑在主线程上,期间事件循环无法处理定时器、I/O 回调等任何事件:

### 1.1 同步 I/O:`readFileSync`

- `generatePageLegacy` 内部用 `readFileSync` 同步读取本地 `./config.json`(`src/report.ts:308`),`renderMetric` 每单元格也会经 `loadConfigSync` 触发同步读取(`src/report.ts:123`)。
- **为什么卡**:同步系统调用期间 libuv 事件循环被整个挂起,必须等内核返回才能继续;异步 `fs.promises.readFile` 则会把等待让渡给 libuv 线程池,不阻塞循环。
- 读到的**原始 JSON 文本直接参与 HTML 拼接**(写入 `<!-- config: ... -->` 注释与 `<title>`、`data-*` 属性),满足"读取本地配置参与拼接"。

### 1.2 CPU 密集串行计算:逐单元格真实运算

- 每个 `<td>` 都真实调用一次 `renderMetric(i)`(`src/report.ts:223`),共 `rowCount × columns` 次(rowCount=64、8 列时为 **512 次**,满足单次 ≥ 300 次函数执行)。
- 计算本体是纯函数 `computeMetric`(`src/metric-core.ts:42`),是**真实整数运算**,不是空转/常量:
  - `mixHash32`(`src/metric-core.ts:11`):`cellHashRounds`(默认 180000)轮 xorshift 移位 + `Math.imul` 32 位乘法混合,全程纯整数、确定性;
  - `isPrime`(`src/metric-core.ts:22`):在哈希结果附近做开方试除寻找质数;
  - 最终由哈希值与质数算出两位小数指标。
- **为什么卡**:512 个单元格 × 18 万轮串行执行,长时间独占调用栈,事件循环在整段同步计算结束前没有任何机会取得控制权(没有 `await`、没有 `setImmediate` 让出)。

> 这正是生产环境中最常见的反模式:在请求处理路径上使用同步 I/O,或一次性在主线程做大块序列化/加解密/模板渲染。

## 2. 基准如何量化卡顿

`benchmark()`(`src/report.ts:613`)在同一进程内对 **legacy / 零阻塞两条路径**分别测量并对照:

- **单次总耗时**:`performance.now()` 包裹单次 `generatePageLegacy` / `await generatePage`,各跑 3 次取中位数。
- **事件循环延迟(卡顿)**(`measureLagDuring`,`src/report.ts:502`):
  - 10ms `setInterval` 探针:空闲时 tick 间隔约 10ms;同步阻塞期间探针无法触发,阻塞结束后首个 tick 的漂移即卡顿量,记录最大延迟、平均延迟与错过节拍数;
  - `perf_hooks.monitorEventLoopDelay` 直方图交叉验证 max/mean,取两者最大值作为最大卡顿;
  - 另测一段**空闲基线**作对照,输出两条路径各自的"卡顿放大量"。
- **吞吐**:零阻塞路径在 1 秒窗口内连续生成页面,统计实测页/秒。
- **结果一致性(可复现)校验**:多轮生成结果逐字节比较 + SHA-256 摘要全部相同;两条路径的输出再互相逐字节比较;rowCount=64 时与基准摘要比对。任一校验失败则进程退出码为 1。

## 3. 实测结论(legacy 阻塞路径)

固定输入 `rowCount=64`(8 列,512 个单元格,`cellHashRounds=180000`),代表性实测:

| 指标 | 数值 |
| --- | --- |
| `renderMetric` 真实调用 | 512 次/单次(要求 ≥300,**通过**) |
| 单次总耗时(3 次) | 186.31 / 186.25 / 179.52 ms,中位数 186.25 ms |
| 空闲基线最大卡顿 | 1.84 ms |
| 阻塞期间最大卡顿 | 174.17 ms,错过 1 个 10ms 节拍 |
| 卡顿放大量 | 94.49 倍 |
| 3 次 HTML SHA-256 | 完全一致 |
| 跨进程两次运行摘要 | 一致(见下) |

三次输出的 SHA-256 均为:

```
a6aeae862721779f9d4d043de1a3a37aae0b60057a7541e75d7d18fa27ceb7dc
```

在**两个独立进程**中分别运行,该摘要保持不变,证明输出跨进程可复现而非仅同进程内稳定。HTML 长度 15416 字符,为标准 `<table>` 结构(`<thead>/<tbody>/<tr>/<td data-i>`),单元格值为真实运算结果(如 `567.15`、`482.73`)。

## 4. 修复对照:零阻塞重构

### 4.1 修复手法

针对第 1 节的两类阻塞,零阻塞路径(`generatePage` 异步版,`src/report.ts:418`)逐一消除:

| 阻塞点 | 修复 |
| --- | --- |
| 同步 I/O `readFileSync(config.json)` | `initConfig()`(`src/report.ts:141`)启动期一次性 `fs.promises.readFile` 并缓存原始文本与解析结果;请求路径只读内存缓存,**零同步 I/O**。 |
| CPU 密集计算独占主线程 | 默认交给 `MetricWorkerPool`(`src/worker-pool.ts`)自适应 worker_threads 线程池执行;池不可用或 worker 崩溃时打印告警并**降级为 `setImmediate` 分片计算**(`computeMetricsChunked`,`src/report.ts:330`,每片 ≤4ms 即让出事件循环)。 |

输出等价性的结构保证:

- 两条路径共用**同一个** `assembleHtml` 模板函数(`src/report.ts:241`)与**同一个** `computeMetric` 纯函数(`src/metric-core.ts:42`),`config.json` 结构与 HTML 模板均未改动;
- `computeMetric(i, rounds)` 的输出只由 `(i, rounds)` 决定,与执行线程、分片方式、worker 调度顺序无关;线程池按序号切片、`Promise.all` 按提交顺序收集,结果拼接顺序确定;
- 基准实测校验:多轮一致、跨路径逐字节一致、与基准 SHA-256 一致。

### 4.2 异常链路

- **worker 崩溃 / 线程池不可用**:任一 worker 报错或非零退出 → 池标记不可用并拒绝待处理任务 → 主线程捕获后打印 `⚠` 告警,自动降级为 `setImmediate` 分片计算,输出不变,**进程不因此以非 0 退出**(仅一致性校验失败才会退出码 1)。可用 `REPORT_CRASH_WORKER=1`(worker 启动即退出)与 `REPORT_FORCE_FALLBACK=1`(直接禁用线程池)复现。
- **优雅关闭**:`shutdownReportResources()`(`src/report.ts:404`)拒绝排队任务并 `await` 全部 worker `terminate()`,进程可正常退出。

### 4.3 实测对照数据

同一进程、同一输入(`rowCount=64`)下的真实运行结果(`node --import tsx src/main.ts`,非估计值):

| 指标 | legacy 阻塞路径 | 零阻塞路径(worker 线程池) |
| --- | --- | --- |
| 单次耗时中位数 | 186.25 ms | 28.81 ms |
| 事件循环最大卡顿 | 174.17 ms | **1.89 ms(≤ 5ms 达标)** |
| 卡顿放大量(相对空闲基线 1.84 ms) | 94.49x | 1.03x |
| 错过 10ms 节拍 | 1 次 | 0 次 |
| 吞吐 | ~5.4 页/秒(推算,且全程卡死) | **40.0 页/秒(实测,事件循环保持响应)** |
| `renderMetric` 调用 | 512 次/单次 | 512 次/单次 |
| HTML SHA-256 | `a6aeae86…27ceb7dc` | `a6aeae86…27ceb7dc`(逐字节一致) |

降级路径实测(`REPORT_FORCE_FALLBACK=1`,纯 `setImmediate` 分片、无 worker):

| 指标 | 数值 |
| --- | --- |
| 事件循环最大卡顿 | 4.40 ms(≤ 5ms 达标) |
| 实测吞吐 | 5.6 页/秒 |
| 输出 SHA-256 | 与 worker 路径逐字节一致 |

worker 崩溃链路实测(`REPORT_CRASH_WORKER=1`):打印告警 `⚠ worker 线程池故障,降级为 setImmediate 分片计算: metric-worker 异常退出,退出码 1`,随后以分片模式完成全部测量,最大卡顿 4.46 ms,**进程退出码 0**。

## 5. 运行时可调与韧性(B 轮新增)

在零阻塞双路径之上新增三项运行时能力,全部由 `src/main.ts` 的"韧性验证"段
逐项实测验证,任一失败进程退出码非 0。以下数据均为真实运行输出
(`npx tsx src/main.ts`,Node.js v24.21.0),非手填。

### 5.1 动态参数热更新(SIGUSR2)

- `installConfigHotReload()`(`src/report.ts:206`)注册 SIGUSR2 处理器,收到信号后
  `reloadConfig()`(`src/report.ts:176`)**异步**重读 `config.json`;
- 成功时整体换入新的配置快照(`cellHashRounds` 与可选的 `workerThreads`
  线程池目标大小同时生效,后者经 `MetricWorkerPool.setTargetSize` 下发);
- **不混拼保证**:`generatePage` 在入口捕获一次配置快照,进行中的生成用旧参数
  完整跑完,新任务用新参数,同一页面内不会出现新旧参数混拼;
- 重读失败(如 JSON 损坏)保持旧配置、打印 `⚠` 告警,进程不退出。

韧性验证 (b) 实测(热更新配置为 `cellHashRounds=90000, workerThreads=3`):

| 验证项 | 实测结果 |
| --- | --- |
| 损坏配置重读 | 拒绝并保持旧配置,告警 `⚠ config.json 热重读失败,保持旧配置`,后续生成摘要仍为 `a6aeae86…27ceb7dc` ✅ |
| 热更新决策日志 | `[MetricWorkerPool] 目标缩容 8→3: 热更新目标线程数=3,当前队列长度=8,5 个待空闲后退休` |
| 进行中的 128 行生成(与信号并发) | 用旧参数跑完,SHA-256 `5344b989…2037bf`,与旧参数基准逐字节一致 ✅ |
| 新参数 rowCount=64 摘要 | `5591d6cb7ad24ac8611dfc2dc7a8f66da77d28cb3000a86bb500b81a23cfa4af`(实测值,已固化为 `EXPECTED_SHA256_ROW64_HOT`,`src/report.ts:58`)✅ |
| 恢复原配置后 | 摘要回到基准 `a6aeae86…27ceb7dc` ✅ |

### 5.2 自适应线程池

`MetricWorkerPool`(`src/worker-pool.ts`)按采样窗口统计任务排队等待时间:

- **扩容**:窗口内排队 P95 超阈值(默认 25ms)且**连续 3 个窗口**如此,才扩容
  1 个 worker,上限 `max(2, os.availableParallelism() - 1)`;
- **缩容**:队列与在途均为空且空闲超阈值(默认 10s)后,每窗口退 1 个**空闲**
  worker,下限 2;只退空闲 worker,**绝不丢弃已排队任务**(`setTargetSize`
  缩容时无空闲可退的部分记账,待 worker 空闲后补齐);
- 每次扩缩容打印一行决策日志,含当时队列长度与决策依据。

韧性验证 (c) 实测(独立测试池:窗口 100ms、阈值 5ms、连续 2 窗口、空闲超时
400ms,60 批 × 64 单元格重任务):

```
[MetricWorkerPool] 扩容 2→3: 连续 2 个采样窗口排队 P95=194.00ms 超阈值 5ms,当前队列长度=186
[MetricWorkerPool] 扩容 3→4: 连续 2 个采样窗口排队 P95=396.00ms 超阈值 5ms,当前队列长度=93
[MetricWorkerPool] 扩容 4→5: 连续 2 个采样窗口排队 P95=549.00ms 超阈值 5ms,当前队列长度=0
[MetricWorkerPool] 缩容 5→4: 空闲 445ms 超时空闲阈值 400ms,当前队列长度=0
[MetricWorkerPool] 缩容 4→3: 空闲 400ms 超时空闲阈值 400ms,当前队列长度=0
[MetricWorkerPool] 缩容 3→2: 空闲 402ms 超时空闲阈值 400ms,当前队列长度=0
```

60 批任务全部 resolve(零丢失),缩容后 worker 数回到下限 2 ✅。

### 5.3 可取消生成

- `generatePage(rowCount, signal?)`(`src/report.ts:418`)接受可选 `AbortSignal`;
- 取消时:停止派发新分片(排队任务直接移除并拒绝)、向 worker 发
  `{kind:"cancel", id}` 控制消息(worker 每算 16 个单元格让出一次事件循环,
  发现取消即丢弃在途分片)、已算出的部分结果全部丢弃,Promise 以
  `AbortError`(`error.name === "AbortError"`)拒绝,**不产出任何半截 HTML**;
- 取消不被视为池故障:不触发降级、不改池状态,迟到的分片结果按任务 id
  匹配丢弃,后续新调用照常完成。

韧性验证 (a) 实测:生成中途(20ms)`AbortController.abort()` →
拒绝 `error.name=AbortError`;取消后池状态 `workers=8 queued=0 usable=true`
与取消前一致;紧接着的新生成的 HTML 摘要仍为 `a6aeae86…27ceb7dc` ✅。

### 5.4 交织一致性回归

韧性验证段末尾在"取消 + 两次热更新 + 扩缩容"全部交织之后,再以
`rowCount=64` 成功生成一次,实测 SHA-256 仍为
`a6aeae862721779f9d4d043de1a3a37aae0b60057a7541e75d7d18fa27ceb7dc` ✅。
完整韧性验证输出(12 项检查全部 ✅)见 `npx tsx src/main.ts` 的
"=== 韧性验证 ===" 段;`REPORT_FORCE_FALLBACK=1`(分片降级)与
`REPORT_CRASH_WORKER=1`(worker 崩溃注入)下韧性验证同样全部通过、退出码 0
(崩溃注入下扩缩容子项因测试池不可用而跳过,不计失败)。

## 6. 文件说明

- `src/report.ts` — 双路径实现与基准:`generatePageLegacy`/`renderMetric`/`loadConfigSync`(legacy 反例)、`initConfig`/`generatePage`/`computeMetricsChunked`(零阻塞)、`assembleHtml`(共用模板)、`benchmark`(双路径对照测量)、`shutdownReportResources`(优雅关闭);B 轮新增 `reloadConfig`/`installConfigHotReload`/`waitNextConfigReload`(SIGUSR2 热更新)、`generatePage` 的 `AbortSignal` 支持、`getPoolStats`(池状态快照)。
- `src/metric-core.ts` — `computeMetric`/`mixHash32`/`isPrime` 纯计算核心,主线程与 worker 共用。
- `src/metric-worker.ts` — worker_threads 工作线程脚本;协作式取消(每 16 个单元格让出一次事件循环检查取消标记);`REPORT_CRASH_WORKER=1` 可模拟崩溃。
- `src/worker-pool.ts` — `MetricWorkerPool` 自适应线程池:任务切片分发、排队 P95 采样扩缩容(带决策日志)、`setTargetSize` 热更新目标大小、可取消任务(`createAbortError`/`isAbortError`)、故障标记、优雅关闭。
- `src/main.ts` — 调 `benchmark({ rowCount: 64, runs: 3 })` 打印双路径对照与可复现性校验,随后执行"韧性验证"段(取消 / 热更新 / 扩缩容 + 交织回归),全部通过才以退出码 0 结束。
- `config.json` — 本地配置;`columns` 决定列数,`cellHashRounds` 调节每单元格计算量,可选 `workerThreads` 指定线程池目标大小。零阻塞路径启动期异步读取并缓存,SIGUSR2 触发热重读。
- `tsconfig.json` — `strict` + `noImplicitAny`,`tsc --noEmit` 通过,源码无 `any`。

## 7. 复现与调节

```bash
npx tsc --noEmit      # 严格类型检查
npx tsx src/main.ts   # 双路径对照基准 + 韧性验证,全部验证结论
```

- 想让卡顿更明显/更轻:改 `config.json` 的 `cellHashRounds`(与卡顿近似线性),或改 `src/main.ts` 中 `rowCount`。
- 只测单条路径:`benchmark({ path: "legacy" })` 或 `benchmark({ path: "zero" })`。
- 验证降级链路:`REPORT_FORCE_FALLBACK=1 node --import tsx src/main.ts`(强制分片)、`REPORT_CRASH_WORKER=1 node --import tsx src/main.ts`(模拟 worker 崩溃)。
- 运行时热更新:进程运行中修改 `config.json` 后 `kill -USR2 <pid>`,即异步重读并热更新 `cellHashRounds` 与 `workerThreads`;重读失败保持旧配置不退出。
