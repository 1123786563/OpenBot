# MOD03 实施计划（#623：抽离服务启动关闭装配并显式管理资源生命周期）

冻结于 2026-10-24，编排者依据 Issue #623 正文 + 集成 HEAD `90e7f1746` 代码事实。原则：**只移动文件，需要适配时才写代码**（用户 2026-10-24）。

## 0. 代码事实（@90e7f1746 实测）

- `server/src/index.ts` 8496 行：import 块至 :743；:744 起为**模块级顶层可执行装配**（`const log`、辅助函数、store/worker 创建、接线、顶层 await ×3：`initializeDevActorUser` :1118 / `synchronizeTenantPackage` :1747 / `installEnterpriseControls` :5660）。
- 关键次序锚点：`startHttpServer({...})` :8392 → SIGINT/SIGTERM 处理器 :8416–8452 → listening 日志 :8461 → MT009/MT011 尾段 + `export { teamResourceActionService }` / `export { resourceInventoryService }` :8462–8496。
- 关闭序（:8416–8452 逐字）：15 个具名 sync stop + 3 个可选（catalogSyncScheduler?/keyStateSyncScheduler? 在前段、opikExportWorker?/opikRetentionWorker?/opikExecutionWorker?）+ `deliverySweeps` 循环 + `handoffKickSweep?.stop()` + `billingSweepStops` 循环（**各自独立 try/catch 吞错**）+ `stopCraftIdleReaper()` + `void Promise.allSettled([channelActivityListener.stop(), policyListener.stop(), workOfferedListener?.stop() ?? Promise.resolve(), Promise.resolve(retentionSweeps.stop())]).finally(() => process.exit(0))`。
- `production-entry.ts` 8 行：`import "eventsource"; await import("./index");`。
- **index.ts 模块消费者 = 零**（仅 package.json `dev`/`start` 直接运行 + production-entry 动态 import + craft-preview 提示文本）；两尾段 export 当前无消费者（MT009/MT011 留给后续票）。
- **源文本消费者 1 个**：`server/tests/qa-batch1-llm-meter-id.test.ts`（85 行）`readFileSync("../src/index.ts")` + 13 个 `(SOURCE)` 正则钉住计费接线（`await usageOutbox.record(`、`logUsageOutboxWriteFailure(`、`throw new ModelUsageSettlementError(`、`isConfirmedNoCost(`、`await recordUnsettledUsage({`、`usageOutboxWriteFailureCode(error)` 等）。其余 9 个含 "src/index" 字样的测试均仅注释引用。
- `tests/config/module-imports.json` 在集成分支已有 `server/src/assembly → ASSEMBLY` moduleRoot（MOD02），runtime.ts/lifecycle.ts 落此目录自动归属。

## 1. owned_files（冻结）

| 文件 | 权限 |
| --- | --- |
| `server/src/assembly/runtime.ts` | 新增全权 |
| `server/src/assembly/lifecycle.ts` | 新增全权 |
| `server/src/index.ts` | 改造为薄入口（§3 形态冻结） |
| `server/tests/module-runtime-lifecycle.test.ts` | 新增全权 |
| `server/tests/qa-batch1-llm-meter-id.test.ts` | **唯一后果性编辑**：SOURCE 路径指向钉住文本搬移后的家（§3-W），断言正则与强度零变化 |
| `server/src/production-entry.ts` | 预期零改动；如需适配必须先说明 |
| `tests/config/module-imports.json` | 预期零 delta（assembly 目录已归属）；如需变化必须说明理由 |

全仓其余只读。`server/src/http-server.ts`、app.ts、assembly/http.ts 一律不碰。

## 2. 目标形态

### assembly/lifecycle.ts（新）

显式生命周期注册表，替代模块级散置句柄 + 硬编码关闭序：

- `export interface HeldResource { name: string; stop: () => void | Promise<unknown>; isolate?: boolean }`（isolate=独立 try/catch 吞错，映射 billingSweepStops 语义）。
- `export function createRuntimeLifecycle()` 返回：`hold(resource)`（注册已创建资源，未创建的可选资源**不注册**——保留 `?.` 语义）；`stopRegistered()` 按**注册清单逐项执行**；`installSignalShutdown(signals)` 安装 SIGINT/SIGTERM 处理器，**once 守卫**（第二次信号不重放停序——验收 3「无重复执行副作用」）；内部失败回滚查询（stopRegistered 即回滚原语）。
- **停序合同 = :8416–8452 今日精确次序**（§0 清单逐字冻结）：调用方以与今日相同的顺序 `hold()` 各资源（含 deliverySweeps/billingSweepStops 逐项展开、isolate 标记 billing 项、可选资源仅在创建处注册），使 stopRegistered() 的执行序列与今日处理器逐项等价；末尾 allSettled 组 + `process.exit(0)` 语义保留。

### assembly/runtime.ts（新）

- `export interface RuntimeAssembly { teamResourceActionService: TeamResourceActionService | null; resourceInventoryService: ResourceInventoryService | null }`（唯一类型导出；后续票扩展面）。
- `export async function assembleRuntime(): Promise<RuntimeAssembly>`：**index.ts :744–:8496 全部顶层可执行语句与模块级辅助函数/常量，逐字节按原序迁入函数体**（async 化覆盖 3 处顶层 await，求值时序不变）；唯一具名值导出即该工厂。
- 函数体包裹 try/catch：抛出时先 `lifecycle.stopRegistered()`（只清本次已注册资源，验收 2），再 rethrow（进程仍非零退出，不吞错）。
- 原 signal 处理器位置（对应旧 :8416）替换为 `lifecycle.installSignalShutdown(["SIGINT","SIGTERM"])` 调用，安装时点在 startHttpServer 之后、listening 日志之前——与今日一致。
- 返回 `{ teamResourceActionService, resourceInventoryService }`。

### index.ts（搬空后）

薄入口（形如 production-entry）：

```ts
import { assembleRuntime } from "./assembly/runtime";
const runtime = await assembleRuntime();
export const teamResourceActionService = runtime.teamResourceActionService;
export const resourceInventoryService = runtime.resourceInventoryService;
```

（`bun src/index.ts` 可运行性、两服务可导入性保持。）

## 3. Adaptation 白名单（唯一允许的非逐字节差异，逐处在报告中枚举行号）

- **W1** 各资源创建点的 `lifecycle.hold({...})` 插入（或集中注册段——实施者二选一，但停序必须逐项等价今日清单）。
- **W2** 整体 try/catch 回滚包裹。
- **W3** 两服务经 return threading 导出；index.ts 薄入口重写。
- **W4** signal 处理器 → installSignalShutdown 调用。
- **W5** import 搬迁：被迁代码独占的 import 随迁至 runtime.ts；index.ts 保留自身所需。lifecycle.ts 自持（不 import index/runtime，运行时无环）。
- **W6** qa-batch1-llm-meter-id.test.ts SOURCE 路径改为钉住文本的新家；13 个钉住点的旧→新位置映射表入报告。
- 白名单外任何差异 = 违规。qa-batch1 断言正则与语义**零变化**（只动读取路径/注释）。

## 4. 测试（module-runtime-lifecycle.test.ts，e2e-compat 根入口收集）

1. **停序 pin**：注册模拟资源（含 isolate 项、可选未注册项、delivery/billing 展开项）→ stopRegistered 执行序列 == §0 今日清单逐项（名称+次序+isolated 吞错+allSettled 组）。
2. **once 守卫**：双信号不重放。
3. **回滚语义**：注册 N 项后模拟启动失败 → 只停 1..N 已注册项、未注册项（外部/共享）不被触碰。
4. **失败隔离**：isolated stop 抛错不阻断后续；非 isolated 抛错行为如实记录（与今日一致即通过）。
5. **import 纯度**：`import("./assembly/runtime")`/`import("./assembly/lifecycle")` 不产生监听、不注册任何资源、不写日志副作用（可观察面断言）。
6. 可选能力（验收 4）：结构断言 lifecycle/runtime 不在未启用时强制创建（由 W1 注册点位于条件创建分支内保证，报告给映射证明）。
7. 真实 smoke（尽力而为，如实报告）：`bun src/index.ts` 若测试环境（DB 等）允许 → 起动监听 + SIGTERM 优雅退出 exit 0；不允许则报阻塞与缺失项，**不伪造**。
8. 回归：qa-batch1 复跑绿；MOD02 新测试 14/14；抽样 settings-instructions-routes、plugin-routes；存量红（guards/ready/identity-app-wiring）前后一致不动。

## 5. 验证门

checker（预期 654 基线零 delta、assembly 归属自动）、typecheck（恰 3 条已知存量）、覆盖审计（26 存量缺口零新增）、上述测试全绿。验收 4 条逐条给证据映射。

## 6. 边界与风险披露

- 模块求值顺序：import 集合不变（仅换宿主文件），无新增运行时模块；由回归+smoke 覆盖。
- `startHttpServer` :8392 / 处理器 / listening / 尾段的相对次序冻结不变。
- production-entry 零改动（动态 import 语义不受影响）。
- 存量红、审计 26 缺口为既有基线，不修。
