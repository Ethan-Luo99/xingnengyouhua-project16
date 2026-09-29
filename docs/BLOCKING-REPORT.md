# 事件循环阻塞反例:方案与基准结论

纯 TypeScript + Node.js(无 DOM、无 `any`)构造的**可复现事件循环阻塞反例**,并自带基准测量与一致性校验。

- 运行环境:Node.js v24.21.0,tsx v4.23.15,TypeScript strict
- 入口:`src/main.ts` → `benchmark()`(`src/report.ts`)
- 运行方式:`npx tsx src/main.ts`(沙箱内若 tsx IPC 被禁,可用 `node --import tsx src/main.ts`)

## 1. 方案:刻意制造的两种瓶颈

`generatePage(rowCount)`(`src/report.ts:149`)在**同一个事件循环 tick** 内叠加了两类典型阻塞写法,二者都跑在主线程上,期间事件循环无法处理定时器、I/O 回调等任何事件:

### 1.1 同步 I/O:`readFileSync`

- `generatePage` 内部用 `readFileSync` 同步读取本地 `./config.json`(`src/report.ts:154`),`renderMetric` 每单元格也会经 `loadConfigSync` 触发同步读取(`src/report.ts:111`)。
- **为什么卡**:同步系统调用期间 libuv 事件循环被整个挂起,必须等内核返回才能继续;异步 `fs.promises.readFile` 则会把等待让渡给 libuv 线程池,不阻塞循环。
- 读到的**原始 JSON 文本直接参与 HTML 拼接**(写入 `<!-- config: ... -->` 注释与 `<title>`、`data-*` 属性),满足"读取本地配置参与拼接"。

### 1.2 CPU 密集串行计算:逐单元格真实运算

- 每个 `<td>` 都真实调用一次 `renderMetric(i)`(`src/report.ts:80`),共 `rowCount × columns` 次(rowCount=64、8 列时为 **512 次**,满足单次 ≥ 300 次函数执行,且每轮计数打印为 `[512, 512, 512]`)。
- `renderMetric` 是**真实整数运算**,不是空转/常量:
  - `mixHash32`(`src/report.ts:49`):`cellHashRounds`(默认 180000)轮 xorshift 移位 + `Math.imul` 32 位乘法混合,全程纯整数、确定性;
  - `isPrime`(`src/report.ts:60`):在哈希结果附近做开方试除寻找质数;
  - 最终由哈希值与质数算出两位小数指标。
- **为什么卡**:512 个单元格 × 18 万轮串行执行,长时间独占调用栈,事件循环在整段同步计算结束前没有任何机会取得控制权(没有 `await`、没有 `setImmediate` 让出)。

> 这正是生产环境中最常见的反模式:在请求处理路径上使用同步 I/O,或一次性在主线程做大块序列化/加解密/模板渲染。

## 2. 基准如何量化卡顿

`benchmark()`(`src/report.ts:302`)同时使用两种手段并做对照:

- **单次总耗时**:`performance.now()` 包裹同步 `generatePage`,跑 3 次取中位数。
- **事件循环延迟(卡顿)**:
  - 10ms `setInterval` 探针(`measureEventLoopLag`,`src/report.ts:216`):空闲时 tick 间隔约 10ms;同步阻塞期间探针无法触发,阻塞结束后首个 tick 的漂移即卡顿量,记录最大延迟、平均延迟与错过节拍数;
  - `perf_hooks.monitorEventLoopDelay` 直方图(`src/report.ts:337`)交叉验证 max/mean,取两者最大值作为最大卡顿。
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

## 4. 文件说明

- `src/report.ts` — `renderMetric` / `loadConfigSync` / `generatePage` / `benchmark`,阻塞反例与测量的全部实现。
- `src/main.ts` — 调 `benchmark({ rowCount: 64, runs: 3 })` 并格式化打印规模、耗时、卡顿、摘要、校验结论。
- `config.json` — 被同步读取并拼进 HTML 的本地配置;`columns` 决定列数,`cellHashRounds` 调节每单元格计算量。
- `tsconfig.json` — `strict` + `noImplicitAny`,`tsc --noEmit` 通过,源码无 `any`。

## 5. 复现与调节

```bash
npx tsc --noEmit      # 严格类型检查
npx tsx src/main.ts   # 打印基准数字与校验结论
```

- 想让卡顿更明显/更轻:改 `config.json` 的 `cellHashRounds`(与卡顿近似线性),或改 `src/main.ts` 中 `rowCount`。
- 对照"正确写法"可把 `readFileSync` 换成 `await fs.promises.readFile`,并把大计算分片到 `setImmediate`/worker_threads,卡顿即会消失,可作为本反例的修复验证。
