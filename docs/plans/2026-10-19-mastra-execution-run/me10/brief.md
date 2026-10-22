# ME10 (#482) Task Brief — 职责、投递、唤醒与审批续跑统一执行和回传

Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec2-2`（分支 `1123786563/mastra-exec2-2`，未提交树，BASE `bcf51633f`）。前置 ME09 已闭环（governed turn runner + 恢复治理脊柱）。基线：23 文件波 273 pass / 0 fail / 1350 expects。
Ticket: `docs/tickets/mastra-agent-execution/issues/me10.md`（6 AC）。Spec §8。ADR 0006/0008/0010。旧计划 T9/T10 文件参考。

## 现状与接缝

1. **ME09 交付的统一面**：`mastra/headless.ts` createGovernedTurnRunner（TurnRunner 合同）+ `settleResumedRun`/`assertResumeBindingCurrent` 恢复门 + runs 服务 markRunSuspended/reactivateSuspensionLease + index.ts 服务端 engine selector（enterprise 齐备→governed；否则 legacy）。
2. **四类入口现状（先盘点再逐项迁移）**：
   - 职责推进：index.ts 中 responsibility 相关装配（搜 `responsibilit`；旧装配含 createHeadlessComputerTools 的 legacy 通道）。
   - 消息投递：`server/src/delivery/`（delivery runner）。
   - 唤醒：唤醒入口（搜 `wakeup|wake_up|wake-up`）。
   - 审批续跑：approvals continuation runner（搜 `approvalContinuation`；旧走 Intelligence runner）。
3. **ME09 评审遗留归本票（必须处置）**：
   - **F4 决策**：目前两处生产 install 均 `durableToolNames: []`——审批要求的 grant 在 Mastra 路径一律 fail-closed 拒绝（MASTRA_TOOL_SUSPENSION_UNSUPPORTED），不产生 waiting_approval。本票裁决并落地：审批续跑入口要求真实 parking——在 governed 装配挂 durable 审批暂停（requireApproval 挂 ME05 台账），审批后经 reactivateSuspensionLease 恢复；同步修正 tools.ts:234 的过时注释。
   - F5：headless events-append 注释与行为对齐（或升 fail-run）。
   - F6：dead waiting rows 处置（挂起 run 无驱动者时的明确语义：认领过期后的 recovery/清理路径）。
   - F7：清理 stale MASTRA_RESUME_LOOP_MODEL_UNWIRED 映射（continuation-routes.ts:100）与误导测试名（mastra-computer-tools.test.ts:405）。

## 交付（6 AC）

- AC1 逐项登记并迁移四入口：每入口记录业务归属、受限执行身份、预算来源、去重键、目标会话、回调（entrypoint 清单落报告）；全部走前置 governed turn（复用 ME09 selector 合同），不新建平行模型/Intelligence runner 路径。
- AC2 每入口重验当事人/Bot/目标资源资格；来源撤销后不以全局扫描身份继续。
- AC3 复用 headless lease/历史/预算/工具/记忆（不自建）。
- AC4 同一业务推进意图重投递/恢复保持操作身份；已完成 receipt 不重复执行；未知副作用停止自动推进。
- AC5 审批续跑引用准确 continuation（不把批准事件当新聊天重跑计划）——F4 落地后真实 parking→恢复。
- AC6 每入口独立正常+取消/超时/重复投递演示；结果/失败可见；费用/观测归属正确。
- 验证（票面）：四类入口各一正常及故障/重复案例，共用前置 turn；对照入口清单核对无 Intelligence 执行/历史旁路（grep `IntelligenceAgentRunner|routineIntelligence` 生产消费面归零——routines 一处已由 ME09 处理，本票补齐其余）。

## 测试与环境

新套件建议：`server/tests/mastra-entries.test.ts`（四入口装配/资格/去重 unit）+ 扩展 `server/tests/enterprise/mastra-routines.integration.test.ts` 或新 `mastra-entries.integration.test.ts`（真实 PG）。TDD RED 先行。入册 add-driven（单文件单调用）。基线门禁同前（23 文件波+新件 0 fail 0 skip；tsc 恰 3 基线；biome 干净）。环境 openbot-test-pg@:5433。

## 边界与上报

- 不加长任务产品、不新调度算法、不改 OpenMuse/Craft/Computer 引擎。
- F4 若发现 durable 审批暂停与现有 six-gate/引擎行为冲突，如实报告裁决点，不静默绕过。
- 报告写 `me10/report.md`（写权限受阻则全文返回）。不 commit/push。
