# ME09 (#481) Task Brief — 定时任务通过统一 Mastra 执行并回写原会话

Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec2-2`（分支 `1123786563/mastra-exec2-2`，未提交树，BASE `bcf51633f`）。前置 ME06/ME07/ME08 已集成（本票派发时 ME07 review 已闭环）。绿波基线：20 文件 231 pass / 0 fail / 1157 expects。
Ticket: `docs/tickets/mastra-agent-execution/issues/me09.md`（6 AC）。Spec §8（后台执行与集成）+ §5 生命周期表。ADR 0006/0008/0010。旧 15-Task 计划 T9 文件参考：Create `server/src/mastra/headless.ts`；Modify `routines/run-turn.ts`、`routines/runner.ts`、`index.ts` 的 routine 装配。

## 现状与接缝（先读）

1. **现 headless turn**：`server/src/routines/run-turn.ts` `createTurnRunner`（:279）——`IntelligenceLike` + `RunnerLike` 依赖注入、thread lock（TTL/heartbeat/abort grace）、`buildAgentFor`（AbstractAgent）、`toolsForTurn`（HeadlessTool[]，computer 工具三处装配之一）、components gallery、深度/continuation。`routines/runner.ts` 消费；`index.ts` 以 `routineIntelligence` + `routineAgentRunner`（CopilotKit Intelligence socket runner，~index.ts:2780-2800 区）装配。
2. **Mastra 受控执行面已就绪**（ME02–ME08）：`mastra/execution.ts`（受控模型+工具循环、durable 挂起、save-before-end）、`governed-agent.ts`、`browser-runner` 装配（copilot.ts mastraAgentConfiguration 工厂）、`conversation-runtime.ts`（服务端历史读写）、continuation 台账 + `resume-driver.ts`、`computer-scope.ts`（作用域环境，**未接线**——本票接 headless 侧）、`frontend-tools.ts`、learned skills。
3. **ME06 登记的入场条件（本票必须完成）**：
   - 生产 `loopFor` 的 governed 模型再绑定（现为 `MASTRA_RESUME_LOOP_MODEL_UNWIRED` fail-closed，index.ts:~3000）：恢复流的模型拨号须走受控网关（route+ceiling+run 重激活或等价受控合同——与 runs 服务对已 settle run 拒绝 capability 铸造的现状对齐：设计恢复专用 capability 铸造路径或在恢复时重开 attempt，遵守"结算干净+预算受控"不变量，**不得绕过网关/预算/租约**）。
   - `toolGrantCurrent` 门 kind-aware 化（index.ts:~2974）：approval 决策照旧查 plugin grant 台账；frontend_tool 决策查该挂起绑定的 frontend 声明集或等价可撤权台账。
   - 恢复流 classifyThread 级预条件复验（ME13 F2）与 pending-intent staging 预检（ME13 F1）可随恢复路径一并收紧。
   - composed generation 门测试（`runs.getActiveAttemptGeneration` 组合回调的生产级测试）。
   - legacy 双通道 computer 收敛：headless 装配（`createHeadlessComputerTools` 三处 index.ts:~2824/3071/3236 + run-turn.ts:492 HeadlessToolsMiddleware）切到 `computer-scope.ts` 作用域装配（或以 ME06 的装配面包一层）。
4. **本票范围（票面 AC）**：定时任务端到端切片——到点触发经**同一受控 Mastra turn**（可信目录重建 scope/受限身份、明确预算与固定 payer、完整历史、工具/记忆/技能合同）、结果回写原会话、重复投递去重、失败/暂停/取消准确回写、撤权/lease 丢失/预算耗尽阻断。职责/投递/唤醒/交接（ME10/ME11）、OpenMuse/Workshop（ME12）不在本票。

## 交付要点

- `mastra/headless.ts`：`createGovernedTurnRunner(deps)` 满足现有 `createTurnRunner` 返回的可观察合同（TurnRunner 形状），内部走 `mastra/execution.ts` 受控循环 + `conversation-runtime` 历史 + continuation/resume + `computer-scope`/`frontend-tools`/learned 工具面；thread lock/heartbeat/stop 复用 OpenBot 权威（不引入 Intelligence socket/私有 thread lock）。
- `index.ts`：routine 装配切到 governed runner（engine selector 服务端合同；无 Intelligence socket 依赖）；scope/预算从持久调度记录 + 可信目录重建（队列字符串不构成授权；缺配置拒绝并给原因）。
- 重复 firing/队列重投递 → 同一推进意图认领（幂等）；审批/参与等待走 ME05/ME06 挂起合同（无浏览器不绕审批）。
- 测试（TDD，票面 Verification）：手动触发 + 时间触发各一次；双 worker 重复投递；无预算拒绝；撤权阻断；审批等待回写可见；结果回写原会话且刷新可见；旧运行不被重复收费。新套件建议 `server/tests/mastra-headless.test.ts` + `server/tests/enterprise/mastra-routines.integration.test.ts`（真实 PG 一次性库；pg-container helper）。入册 add-driven。
- 基线门禁：20 文件波 + 新套件 0 fail 0 skip；typecheck 恰 3 基线；biome 干净。环境：openbot-test-pg@:5433（openbot_test 已建至 0207 链）。注意 main 侧已知红（conformance-evidence 指纹随收口重录；cleanup probe-spec 缺口）不归本票。

## 边界与上报

- 不重写调度算法/不加长任务产品；不改 OpenMuse 子模块；Craft/Computer 引擎不改。
- 与 Spec §5/§8 冲突即停下报告；恢复 capability 铸造若需 runs 服务接口变更，最小面实现并在报告说明。
- 报告写 `me09/report.md`（写权限受阻则全文返回）。不 commit/push。
