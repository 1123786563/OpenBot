# MOD11 计划（#631：以可信范围和环境代次绑定 Craft 沙箱能力句柄，S6 M09/CRAFT）

状态：冻结（2026-10-26）。实施基点 `4824cacde`（集成 HEAD，含 main 合入与 #618 全链路）。实施 Agent claude；Brief 全文内嵌。

## 0. 侦察事实（编排者已核实 @ `4824cacde`）

- `craft/sandbox-gateway.ts`（523 行）：`SandboxHttpError`/`AgentSandboxFileApi`/`SandboxConnection`/`SandboxGatewayOptions`/`SandboxGateway`/`createSandboxGateway`——file/serve/event/snapshot 能力句柄族。
- `codesandbox/client.ts`（339 行）：`SandboxClient`/`createSandboxClient`/`parseUsage` 等（M09）。
- `tenancy/execution-surfaces.ts`（246 行）：`sandboxExecutionSurface`（:117，SandboxSurfacePorts）+`computerExecutionSurface`+`nativeRuntimeExecutionSurface`+`NATIVE_RUNTIME_CANCEL_HEADERS`（M02 tenancy 侧 surface 合同）。
- **#618 前置已合入**（merge `4824cacde` 经 main d12fe247c）：`craftSandboxExecutionScope`（runtime :6912）经 `executionScopeFor` 接入 craftRoutes（:7004）与 craftWebappHmrDeps（:7096）；craft-sandbox-gateway-scope/craft-session-routes-scope 等存量测试在档。
- 跨模块消费者：`workshop/files.ts`、`workshop/routes.ts`、`tenancy/execution-surfaces.ts`、`tenancy/integration-evidence.ts`、`assembly/runtime.ts`。
- 模块归属：craft=CRAFT、codesandbox=M09；MOD11 环例外 26 条（主体 app 侧 copilot→M09 边）。exit_condition 两段式（出口段+消费者迁移）。
- 存量测试：codesandbox-client/gateway/routes、computer-sandbox、craft-*-scope 族。

## 1. 目标形态

### A. 出口门面（新增全权；落点由普查证实——候选 `server/src/codesandbox/public.ts`（S6=M09）或 `server/src/craft/public.ts`，以四能力句柄（file/serve/event/snapshot）的实际宿主为准）

`create<X>Public({...})` → 可信环境绑定句柄：四能力委托既有 gateway/client 方法（token/scope header 组装收拢为内部合同——验收「调用方不再拼 token 或 scope headers」）；**绑定合同**：同一服务器可信归属（验收①）、Bot scope+环境代次进缓存寻址键（验收②：同 Bot 不同 scope/代次无缓存/登录态串用）、缺范围不发请求+旧句柄复位/撤权后拒绝（验收③，现状机制钉）。不暴露内部 token 组装面；类型经组内签名提取；零新策略。

### B. 迁移臂（普查先行）

实际拼装 token/scope header 的调用点改经 A：主候选=`workshop/files.ts`/`workshop/routes.ts`（跨模块消费者）与 assembly 内散拼点；执行者普查全消费点冻结清单（含「不再拼 token」的逐点证据）。tenancy/execution-surfaces.ts 仅「必要衔接」（票面），其余不动。

### C. `server/tests/multitenancy/<name>-public.test.ts`（新增全权，名称随落点）

1. 委托等价；2. 验收①同一可信归属（四能力同源 scope 断言）；3. 验收②缓存/登录态隔离（scope+代次键钉）；4. 验收③缺范围零请求+复位/撤权拒绝（现状钉+存量 craft-*-scope 对照）；5. 验收④负向（零新增默认公司/团队、零 header 透传可信值——源级钉）；6. 验收⑤#618 原票测试全数保持（两侧对照，两侧落盘、完整命令、复跑独立落盘）。

## 2. owned_files（冻结）

A/C 新增全权；普查结论指向的消费者文件（workshop×2 预期）受限迁移；`assembly/runtime.ts`/`assembly/http.ts`（受限最小接线）；`tests/config/module-imports.json`（预期零 delta；若新出口产生新边照两段式例外先例登记并报裁决）；`tests/config/e2e-bun-suites.json`（仅新测试落 driven 层时照 MOD09 先例）。其余全仓只读（sandbox-gateway.ts/client.ts/execution-surfaces.ts 内件零改动——除非适配必须先上报）。事实不符→停下上报。

## 3. 验证门

checker 基线一致（658）；typecheck **0 错误**（合并后新基线）；审计 32 缺口零新增（+新测试 native 计入）；D 全部根入口；存量 craft/codesandbox 套件两侧对照（双侧落盘、完整命令、复跑独立落盘）；biome 我方零新增。

## 4. 验收映射

①→C2；②→C3；③→C4；④→C5；⑤→C6。
