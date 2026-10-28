# MOD13 计划（#633：分离工具审批决定与 Run 等待恢复并保持单次消费，S5 M08/M05）

状态：冻结（2026-10-26）。实施基点 `dcbaf1405`（集成 HEAD）。实施 Agent claude；Brief 全文内嵌。

## 0. 侦察事实（编排者已核实 @ `dcbaf1405`）

- `approvals/`（11 文件 3312 行）：service.ts（createApprovalService :125/equivalenceOf :62/DECLINED_BY_PERSON/ALREADY_WAITING/withheld 常量族）、store.ts（:35）、execute.ts（createApprovedActionExecutor :17+ApprovedActionDependencies）、wiring.ts（createServerApprovalService）、resume-sweep/question-resume/policy/routes。
- mastra 侧：`approvals.ts`、`continuation-store.ts`、`resume-driver.ts`（createMastraResumeDriver :127+MastraResumeLoop 接口 :53）。
- **两门面前置已就位**：MOD12 `plugins/public.ts`（ToolAccess：callTool/prepareAction——审批执行经 runtime :4634 toolAccess.callTool）、MOD07 `runs/public.ts`（RunLifecycle：start/get/getActiveForThread/cancel/stop）。
- 装配现状：runtime :124-138 approvals imports、:556 createMastraResumeDriver、approvals executor 经 deps 注入（execute.ts :186 deps.callTool=toolAccess 提供者）。
- 存量测试：approvals-* 10 件（native+integration）、continuation/process 族（普查补全）。

## 1. 目标形态（票面原文展开：ToolAccess 写审批决定与 receipt；RunLifecycle 写 WaitRef/claim/等待状态）

### A. 能力上浮到两既有门面（additive，零行为变更）

- **ToolAccess（MOD12 plugins/public.ts）增补**：审批决定与 receipt 写入能力（委托 approvals service/store 现有判定——参数/目标/来源等价性 equivalenceOf 现状、重复批准返回同一决定【验收①】、receipt 持久化【验收③】）。落点裁决：`plugins/public.ts` 增 `approvals` 能力组（构造注入 ApprovalService 最小面）**或** `approvals/public.ts` 新门面由 ToolAccess 消费——普查后择形（倾向后者：approvals 自身成出口，ToolAccess 组内 import 合法方向需证）。
- **RunLifecycle（MOD07 runs/public.ts）增补**：WaitRef/claim/等待状态写取能力（委托 mastra continuation-store/resume-driver 现有 CAS+generation 机制【验收②】与 runs 挂起/恢复衔接）。
- 单次消费语义收拢：重复点击（等价复用【①】）、重启重读原 receipt 不重发外部副作用【③】、无供应商幂等证据超时进 unknown【④】、人工/前端工具真实结果不填假成功【⑤】——全部现状机制经门面钉死，零新策略。

### B. 迁移臂（普查先行）

直接调用 approvals.execute/resume-driver/continuation-store 的**跨模块或装配级**入口改经两门面：主候选=runtime approvals 接线（:4634 toolAccess.callTool 的审批前置流）与 mastra resume 挂载点；内件零改动。普查全表冻结。

### C. `server/tests/multitenancy/approval-resume-public.test.ts`（新增全权）

1. 委托等价（两门面新增能力 vs 直调内件）；2-5. 验收①-④逐条（等价复用/CAS 单驱动者/重启读 receipt 不重发/超时 unknown 现状钉）；6. 验收⑤真实结果（假成功负向钉）；7. 存量 approvals/continuation 套件两侧对照（双侧落盘、完整命令、复跑独立落盘）。

## 2. owned_files（冻结）

A 增补（plugins/public.ts 受限增 capability 组 **或** approvals/public.ts 新增全权——普查择形后冻结）+ runs/public.ts 受限增 WaitRef/claim 组 + C 新增全权；B 迁移消费者文件（普查后冻结：runtime.ts 预期受限 hunk；mastra 挂载点若跨模块预期受限）；`assembly/runtime.ts`（受限）；两 config（预期零 delta；driven 层照先例）。其余全仓只读（approvals 内件 11 文件、mastra 三文件、runs 内件零改动——除非适配必须先上报）。事实不符→停下上报。

## 3. 验证门

checker 658 基线一致；typecheck 0；审计 32 缺口零新增（+新测试 native）；D 全部根入口；存量 approvals/continuation 套件两侧对照（双侧落盘、完整命令、复跑独立落盘）；biome 我方零新增。

## 4. 验收映射

①→C2；②→C3；③→C4；④→C5；⑤→C6。
