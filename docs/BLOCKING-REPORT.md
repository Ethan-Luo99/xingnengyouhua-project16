# 事件循环阻塞反例:方案、基准结论与零阻塞修复对照

纯 TypeScript + Node.js(无 DOM、无 `any`)的**可复现事件循环阻塞反例**,现已重构为
**legacy 阻塞 / 零阻塞双路径对照基准**:反例实现原样保留,零阻塞路径在
worker_threads 线程池中完成全部 CPU 计算,两条路径输出逐字节等价。

- 运行环境:Node.js v24.21.0,tsx v4.23.15,TypeScript strict
- 入口:`src/main.ts` → `benchmark()`(`src/report.ts:472`)
- 运行方式:`npx tsx src/main.ts`(沙箱内若 tsx IPC 被禁,可用 `node --import tsx src/main.ts`)

## 1. 方案:刻意制造的两种瓶颈(legacy 路径,原样保留)

`generatePageLegacy(rowCount)`(`src/report.ts:213`)在**同一个事件循环 tick** 内叠加了两类典型阻塞写法,二者都跑在主线程上,期间事件循环无法处理定时器、I/O 回调等任何事件:

### 1.1 同步 I/O:`readFileSync`

- `generatePageLegacy` 内部用 `readFileSync` 同步读取本地 `./config.json`(`src/report.ts:216`),`renderMetric` 每单元格也会经 `loadConfigSync` 触发同步读取(`src/report.ts:90`)。
- **为什么卡**:同步系统调用期间 libuv 事件循环被整个挂起,必须等内核返回才能继续;异步 `fs.promises.readFile` 则会把等待让渡给 libuv 线程池,不阻塞循环。
- 读到的**原始 JSON 文本直接参与 HTML 拼接**(写入 `<!-- config: ... -->` 注释与 `<title>`、`data-*` 属性),满足"读取本地配置参与拼接"。

### 1.2 CPU 密集串行计算:逐单元格真实运算

- 每个 `<td>` 都真实调用一次 `renderMetric(i)`(`src/report.ts:131`),共 `rowCount × columns` 次(rowCount=64、8 列时为 **512 次**,满足单次 ≥ 300 次函数执行)。
- 计算本体是纯函数 `computeMetric`(`src/metric-core.ts:40`),是**真实整数运算**,不是空转/常量:
  - `mixHash32`(`src/metric-core.ts:11`):`cellHashRounds`(默认 180000)轮 xorshift 移位 + `Math.imul` 32 位乘法混合,全程纯整数、确定性;
  - `isPrime`(`src/metric-core.ts:23`):在哈希结果附近做开方试除寻找质数;
  - 最终由哈希值与质数算出两位小数指标。
- **为什么卡**:512 个单元格 × 18 万轮串行执行,长时间独占调用栈,事件循环在整段同步计算结束前没有任何机会取得控制权(没有 `await`、没有 `setImmediate` 让出)。

> 这正是生产环境中最常见的反模式:在请求处理路径上使用同步 I/O,或一次性在主线程做大块序列化/加解密/模板渲染。

## 2. 基准如何量化卡顿

`benchmark()`(`src/report.ts:472`)在同一进程内对 **legacy / 零阻塞两条路径**分别测量并对照:

- **单次总耗时**:`performance.now()` 包裹单次 `generatePageLegacy` / `await generatePage`,各跑 3 次取中位数。
- **事件循环延迟(卡顿)**(`measureLagDuring`,`src/report.ts:361`):
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

针对第 1 节的两类阻塞,零阻塞路径(`generatePage` 异步版,`src/report.ts:306`)逐一消除:

| 阻塞点 | 修复 |
| --- | --- |
| 同步 I/O `readFileSync(config.json)` | `initConfig()`(`src/report.ts:108`)启动期一次性 `fs.promises.readFile` 并缓存原始文本与解析结果;请求路径只读内存缓存,**零同步 I/O**。 |
| CPU 密集计算独占主线程 | 默认交给 `MetricWorkerPool`(`src/worker-pool.ts`)worker_threads 线程池执行(规模按排队 P95 自适应,见第 5 节);池不可用或 worker 崩溃时打印告警并**降级为 `setImmediate` 分片计算**(`computeMetricsChunked`,每片 ≤4ms 即让出事件循环)。 |

输出等价性的结构保证:

- 两条路径共用**同一个** `assembleHtml` 模板函数(`src/report.ts:149`)与**同一个** `computeMetric` 纯函数(`src/metric-core.ts:40`),`config.json` 结构与 HTML 模板均未改动;
- `computeMetric(i, rounds)` 的输出只由 `(i, rounds)` 决定,与执行线程、分片方式、worker 调度顺序无关;线程池按序号切片、`Promise.all` 按提交顺序收集,结果拼接顺序确定;
- 基准实测校验:多轮一致、跨路径逐字节一致、与基准 SHA-256 一致。

### 4.2 异常链路

- **worker 崩溃 / 线程池不可用**:任一 worker 报错或非零退出 → 池标记不可用并拒绝待处理任务 → 主线程捕获后打印 `⚠` 告警,自动降级为 `setImmediate` 分片计算,输出不变,**进程不因此以非 0 退出**(仅一致性校验失败才会退出码 1)。可用 `REPORT_CRASH_WORKER=1`(worker 启动即退出)与 `REPORT_FORCE_FALLBACK=1`(直接禁用线程池)复现。
- **优雅关闭**:`shutdownReportResources()`(`src/report.ts:292`)拒绝排队任务并 `await` 全部 worker `terminate()`,进程可正常退出。

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

## 5. 运行时可调与韧性

在双路径基准之上,零阻塞路径进一步具备**热更新 + 自适应调度 + 可取消**三项运行期能力。
`npx tsx src/main.ts` 在原有对照结论之后追加"韧性验证"段,任一子项失败进程退出码非 0。

### 5.1 动态参数热更新(SIGUSR2)

- `installConfigHotReload()`(`src/main.ts` 启动时注册)把 `SIGUSR2` 绑定到 `reloadConfig()`(`src/report.ts`):信号到达后**异步** `fs.promises.readFile` 重读 `config.json`,热更新 `cellHashRounds` 与线程池目标大小(可选字段 `workerPoolSize`)。
- **页面级快照,杜绝新旧混拼**:`generatePage` 在入口处通过 `getCurrentConfig()` 抓取当前配置引用,整页(含全部分片)都用这一份参数;热更新只替换缓存指针,进行中的页面不受影响,重读完成后开始的新页面才用新参数。已用专项脚本验证:一个 220 行页面在途时把 `cellHashRounds` 由 180000 改为 190000,旧页摘要 `7febeaa4…b7a9a`、新页摘要 `3013a008…a24e2`,二者不同,说明同页没有混拼。
- **失败安全**:写入非法 JSON 后触发重读,实测打印 `⚠ config.json 重读失败,保留旧配置: Expected property name or '}' in JSON at position 2 (line 1 column 3)`,内存仍保留 190000,进程不退出。
- **信号路径真实生效**:还原基准配置后 `process.kill(pid, "SIGUSR2")`,轮询确认 rounds 回到 180000,随后 `rowCount=64` 摘要仍为基准值。

### 5.2 自适应线程池

`MetricWorkerPool`(`src/worker-pool.ts`)不再固定大小,worker 数量在 **[2, os.availableParallelism()-1]**(本机 12 核 → [2, 11])内自适应:

- 每个采样窗口统计任务**排队等待时长**(仍在排队的任务按截至窗口的已等待时长计入,避免首个积压窗口漏判);**连续 N 个窗口 P95 超阈值**且池饱和才扩容,空闲超过 `idleTimeoutMs` 才缩容;默认参数为窗口 250ms、N=4、P95 阈值 25ms、空闲 1500ms。
- 每次决策打印一行日志,含**当时队列长度与依据**;缩容只回收空闲 worker(`terminate` 标记为主动退出,不算故障),**排队/在途任务一律保留,不丢弃**。
- 韧性验证切换到激进参数(窗口 50ms、N=1、阈值 1ms、空闲 150ms),并发 12 个 160 行大页制造排队,实测真实日志:

```
[pool] 扩容决策: workers 8 → 9 (队列长度=176, 连续 1 个窗口 排队 P95=50.60ms > 阈值 1ms)
[pool] 扩容决策: workers 9 → 10 (队列长度=159, 连续 1 个窗口 排队 P95=99.93ms > 阈值 1ms)
[pool] 扩容决策: workers 10 → 11 (队列长度=144, 连续 1 个窗口 排队 P95=150.79ms > 阈值 1ms)
[pool] 缩容决策: workers 11 → 10 (队列长度=0, 空闲超时 150ms, 目标大小=3)
...（连续逐台回收）...
[pool] 缩容决策: workers 4 → 3 (队列长度=0, 空闲超时 150ms, 目标大小=3)
```

当段共 **3 次扩容(峰值 11 台 worker)、8 次缩容(回到目标 3 台)**;突发期间 12 个页面输出摘要两两一致。

### 5.3 可取消生成(AbortSignal)

`generatePage(rowCount, signal?)`(`src/report.ts`)新增可选 `AbortSignal`;线程池 `compute(indices, rounds, signal?)` 实现任务级取消:

- 取消后**停止派发新分片**(派发循环检查 `signal.aborted`),**尚未派发**的排队分片直接从队列移除并以 `AbortError` 拒绝;
- **在途分片**通过 1 字节 `SharedArrayBuffer` 标志(并辅以 `cancel` 消息)通知 worker;worker 每 32 个单元格在检查点读取标志,命中即停止、回 `discarded`,**已算出的部分结果不回传、直接丢弃**;
- 所有分片结果被丢弃,`assembleHtml` 不会被调用,**不产出半截 HTML**;取消不把池标记为故障(`AbortError` 在降级 `catch` 中被识别并直接上抛),worker 回执后全部回归空闲。
- 实测:384 行页面派发 8ms 后 `controller.abort()`,调用以 **AbortError 拒绝**,池排空到 `queued=0/inFlight=0`;紧接着一次正常 `rowCount=64` 生成成功,SHA-256 仍为 `a6aeae86…27ceb7dc`。

### 5.4 韧性验证实测结论(真实运行输出)

以下数据来自 `npx tsx src/main.ts` 实际运行(非手填),退出码 0:

| 验证项 | 结果 |
| --- | --- |
| (a) 中途取消以 AbortError 拒绝 | 通过 |
| (a) 取消后池状态可恢复(queued/inFlight 归零) | 通过 |
| (a) 取消后重跑 rowCount=64 SHA-256 | `a6aeae86…27ceb7dc`(与基准一致) |
| (b) 旧参数(180000)rowCount=64 SHA-256 | `a6aeae862721779f9d4d043de1a3a37aae0b60057a7541e75d7d18fa27ceb7dc` |
| (b) 新参数(190000)两轮稳定且不同于旧 | 通过 |
| (b) 新参数(190000)实测 SHA-256 | `6648ed309965b80c801e0251d86876267977367c120d2fb6677c0d507fcb2558` |
| (b) 重读非法 JSON 保留旧配置、进程不退出 | 通过 |
| (b) SIGUSR2 还原后 SHA-256 | `a6aeae86…27ceb7dc`(与基准一致) |
| (c) 扩容决策次数(峰值 worker) | 3 次(峰值 11) |
| (c) 缩容决策次数(最终 worker) | 8 次(回到 3) |

无论热更新、扩缩容、取消如何交织,成功生成的 `rowCount=64` 页面 SHA-256 始终为
`a6aeae862721779f9d4d043de1a3a37aae0b60057a7541e75d7d18fa27ceb7dc`,
输出可复现性与对照基准结论保持不变。

## 6. 文件说明

- `src/report.ts` — 双路径实现与基准:`generatePageLegacy`/`renderMetric`/`loadConfigSync`(legacy 反例)、`initConfig`/`reloadConfig`/`installConfigHotReload`/`getCurrentConfig`(启动缓存 + SIGUSR2 热更新)、`generatePage(rowCount, signal?)`(零阻塞 + 可取消)、`computeMetricsChunked`、`assembleHtml`(共用模板)、`benchmark`、线程池自适应/统计辅助与优雅关闭。
- `src/metric-core.ts` — `computeMetric`/`mixHash32`/`isPrime` 纯计算核心,主线程与 worker 共用。
- `src/metric-worker.ts` — worker_threads 工作线程脚本:支持 `compute`/`cancel` 消息与共享取消标志,周期性检查点丢弃在途分片;`REPORT_CRASH_WORKER=1` 可模拟崩溃。
- `src/worker-pool.ts` — `MetricWorkerPool` 自适应线程池:[2, availableParallelism()-1] 区间内按排队 P95 连续超阈值扩容、空闲超时缩容,打印决策日志;任务级取消、目标大小热更新(`setTargetSize`)、故障标记与优雅关闭。
- `src/main.ts` — 调 `benchmark({ rowCount: 64, runs: 3 })` 打印双路径对照,随后执行韧性验证(a 取消 / b 热更新 / c 扩缩容)并在任一项失败时置非 0 退出码。
- `config.json` — 本地配置;`columns` 决定列数,`cellHashRounds` 调节每单元格计算量,可选 `workerPoolSize` 指定线程池目标大小。启动期异步读取并缓存,运行期经 SIGUSR2 热更新。
- `tsconfig.json` — `strict` + `noImplicitAny`,`tsc --noEmit` 通过,源码无 `any`。

## 7. 复现与调节

```bash
npx tsc --noEmit      # 严格类型检查
npx tsx src/main.ts   # 双路径对照基准 + 韧性验证(取消/热更新/扩缩容)
```

- 想让卡顿更明显/更轻:改 `config.json` 的 `cellHashRounds`(与卡顿近似线性),或改 `src/main.ts` 中 `rowCount`。
- 只测单条路径:`benchmark({ path: "legacy" })` 或 `benchmark({ path: "zero" })`。
- 验证降级链路:`REPORT_FORCE_FALLBACK=1 node --import tsx src/main.ts`(强制分片)、`REPORT_CRASH_WORKER=1 node --import tsx src/main.ts`(模拟 worker 崩溃)。
- 手动触发热更新:运行中向进程发送 `kill -USR2 <pid>`,进程异步重读 `config.json`;重读失败只告警、不退出。
