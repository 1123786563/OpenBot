# MOD07 计划（#627：收拢聊天 Run 生命周期与内部执行 Adapter，M05 RunLifecycle）

状态：冻结（2026-10-25）。实施基点 `bc55d4182`（集成分支 HEAD）。实施 Agent pi；Brief 全文内嵌。

## 0. 侦察事实（编排者已核实 @ `bc55d4182`）

- M05 组：`enterprise/runs/`（12 文件：service/store/runner/events/outbox/model-capability/governed-execution/model-route-catalog/model-route-rebind/output-ceiling/request-context/scan-executor）+ `mastra/`（execution-contracts 268 行/execution 526/governed-agent 133 等）+ `enterprise/runtime-errors.ts`。
- 23 条 MOD07 环例外（exit_condition 两段式「M05 建立 public/integration 出口并让 Mxx 改走公开出口」）：M03→M05 4 条（agent-resolver→runs/governed-execution；handoff-runner→mastra/handoff-delivery+headless；wake-up→mastra/headless）、M04→M05 9 条（conversations/service→mastra 五边+intent-reconciler 两边）、M02→M05 2 条（contracts→mastra/contracts+message-parts）、其余 delivery/plugins 等。
- RunService 面：`createRunService(deps)` :199（`start` :217；`failRunWithLease`/`completeRunWithLease`/`validateStopInput` 等带 lease 语义导出）；**runner.ts :918 组装 `const runs = createRunService({...})`、:457 `deps.runs.start(scope, admission)`=聊天提交→Run 建立的现消费点（M05 内部）**；`createProductionRunnerComposition` 消费者=plugin-packages/runtime.ts、assembly/runtime.ts、billing/entrypoint-catalog.ts（跨模块）。
- copilot.ts：CopilotRuntime v2 锚点（AgentRunner run/stop/isRunning/connect 接口族）。
- 存量测试：runs-protocol、duplicate-run、control-lease-routes、native-runtime、runtime-config、credential-lease、package-runtime、mastra 系（message-parts 已绿复跑先例）。
- **验收⑤与出口段的差异**：Issue 明文「目标消费者完成迁移，不只给 RunService 原方法换出口文件」——本票必须完成聊天提交链消费者的真实迁移（读法：目标消费者=聊天提交→Run 建立/事件链，非 23 例全部——该读法交独立审核裁决，未迁移者登记两段式第二段）。

## 1. 目标形态

### A. `enterprise/runs/public.ts`（新增全权）

`createRunLifecyclePublic({ runs })` → RunLifecycle 公共用例薄委托：提交（幂等、固定 Bot/版本/原归属）/状态读取/终态写入（完成 vs 取消）——委托 createRunService 既有方法（start/fail/complete/stop 等，实际面 pi 证实）；类型经 M05 组内签名提取（MOD05/06 先例）；不 re-export RunService/store/lease 类型整面。

### B. `enterprise/runs/integration.ts`（新增全权）

内部执行 Adapter 具名臂：封装 ExecuteMastra/ExecutionBinding/治理执行（execution-contracts/execution/governed-agent 细节留 M05 内部，不进 public）；装配点改经具名臂（与 MOD06 integration.ts 同构）。

### C. 迁移臂（验收⑤硬要求）

聊天提交→Run 建立/事件链的目标消费者改走 A：主候选=runner.ts :457 一带（runs.start 消费点）经门面 + assembly/runtime.ts 组合体接线 + copilot.ts 锚点（若需）；**pi 先普查冻结实际迁移清单**（RunService/ExecuteMastra 全部消费点+各自模块归属），事实与计划不符停下上报（MOD05/06 惯例）。M03/M04 等其余 23 例消费者不迁移，登记两段式第二段。

### D. `server/tests/multitenancy/run-lifecycle-public.test.ts`（新增全权）

1. 委托等价（生命周期面替身：同参/同结果/同错误实例）；2. 验收①：提交幂等+固定 Bot/版本/原归属（Run/Attempt/generation 非客户端选择——源级钉+结构断言）；3. 验收②：旧 lease/generation 拒写新运行、取消/完成竞争确定结果（复用 duplicate-run/control-lease 存量语义+替身断言）；4. 验收③：Mastra 只执行准入、消息经 Conversation 写入（经 M04 出口类型注入断言——MOD06 public 已建）；5. 验收④：断线 vs 主动取消区别维持、零新 durable workflow 权威（结构断言）；6. 存量 run/lease/Mastra 套件 BASE 对照复跑（base 侧证据**必须落盘**——MOD06 R1-F6 裁决）。

## 2. owned_files（冻结）

A/B/D 新增全权；`enterprise/runs/runner.ts`（受限：:457 消费点经门面+装配经 B 臂）；`assembly/runtime.ts`（受限：组合体/锚点接线最小 hunk）；`copilot.ts`（受限：运行接线锚点若适配必须）；`tests/config/module-imports.json`（受限：**预期零 delta**；若 C 迁移致环例外消减则为预期负 delta——逐条对应迁移清单、checker 重收敛、报告披露，禁止无对应迁移的删除）。

其余全仓只读（service.ts/store.ts/events.ts/execution* 三文件/governed-agent.ts 内件零改动；agents/**、conversations/**、contracts.ts 不碰）。事实不符→停下上报。

## 3. 验证门

checker（零 delta 或登记的预期负 delta）；typecheck 恰 3；审计 26 缺口+606 native；新测试根入口全绿；存量 runs-protocol/duplicate-run/control-lease-routes/native-runtime BASE 对照（两侧证据落盘）；biome 我方文件零新增诊断（BASE 对照行文如实）。

## 4. 验收映射

①幂等固定归属→D2；②lease/generation/竞争→D3；③Mastra 只准入+消息经 Conversation→D4（M04 出口注入）；④断线 vs 取消→D5；⑤目标消费者迁移→C（读法交审核裁决）；23 例出口段=Produces 段兑现、未迁移者登记。
