# ME06 (#478) Task Brief — Computer 与前端工具在有人和无人值守场景中保持真实执行

Workspace: `/Users/wuyongjun/orca/workspaces/OpenBot/mastra-exec`（分支 `1123786563/mastra-exec`，未提交树，BASE `bf64d0f2`）。
Ticket: `docs/tickets/mastra-agent-execution/issues/me06.md`（6 条 AC）。Spec: `docs/specs/2026-10-19-mastra-agent-execution-migration-design.md` §5/§6/§8。ADR 0006（逻辑私有 Bot 范围隔离）、0004、0008。
前置（已集成待 review 闭环）：ME05 的 continuation 台账含 `frontend_tool` kind（`server/src/mastra/continuation-store.ts:239,305,765`；`execution-contracts.ts:71,103`；`resume-driver.ts:98-106` 注明 frontend_tool 有自己的 drive 形状；F1 围栏已落地：`recordOperationStarted` 返回判别结果、`receiptSink.started()`（resume-driver.ts:164）在 drive 前拒绝非记录者 `MASTRA_CONTINUATION_CLAIM_LOST`）。

## 现状与精确接缝（先读这些）

1. **fail-closed 拒绝点（本票要打开的第一个开关）**：`server/src/copilot.ts` `mastraAgentConfiguration`（~L2340-2378）当 `computerGuidance !== undefined` 时抛 `MASTRA_TEXT_ONLY_SLICE`。本票把 computer 工具真正接线后移除该拒绝（learnedSkills 的拒绝留给 ME08，不许动）。computerGuidance 以 legacy 原文进入 instructionParts（L2722 的模式：`...(computerGuidance ? [computerGuidance] : [])`），不得改写措辞。
2. **Legacy 的三条 Computer 工具通道**（全部保留语义，只换调度装配）：
   - 服务端 headless 工具：`server/src/index.ts:2812,2965,3130` 的 `createHeadlessComputerTools(...)`（`server/src/computer/headless-tools.ts`，含 `HeadlessToolSuspension`/`HeadlessWaiting`）与 `server/src/copilot.ts:3731` / `server/src/routines/run-turn.ts:492` 的 `HeadlessToolsMiddleware`。
   - 浏览器参与工具：app 侧 `app/src/lib/copilot/computer-tools.tsx`、`gallery-tools.tsx`、`sandboxed-tools.tsx` 经 `useFrontendTool`（`app/src/lib/copilot/approval-tools.tsx`）注册，写操作经 `/api/approvals/computer/<botId>` 服务端门控；AG-UI `TOOL_CALL_*` 事件由客户端应答。
   - Computer 审批与 host-access：`server/src/approvals/**`、`server/src/host-access/**`、`server/src/computer/policy*.ts`、`stream-auth.ts`。
3. **ME04 工具包装**：`server/src/mastra/tools.ts`（createMastraTools：GrantedTool → 受控包装，operationId/argsDigest、abort/lease guard）。服务端可执行工具沿用该包装，不得绕过。
4. **事件面**：`server/src/mastra/stream-events.ts` 已发 `TOOL_CALL_START/ARGS/END/RESULT`（客户端据此参与）。
5. **作用域解析**：Computer 环境/凭据按 公司/团队/本人/逻辑 Bot 解析（ADR 0006），现有解析入口在 `server/src/computer/target.ts`、`deployment-routes.ts`、`server/src/enterprise/` 的 governed 装配（`enterprise/runs/governed-execution.ts` 有 ExecutionBinding 携带 scope 字段）。禁止以全局 Bot ID 寻址有状态环境。

## 交付（6 AC 对应）

- AC1 环境/凭据按 scope 解析：Mastra 路径装配 computer 工具时，环境与控制凭据从 ExecutionBinding 的 scope（tenant/workspace/principal/actor+bot）解析；跨 scope 环境引用拒绝。测试：同 Bot 跨 scope 两环境不串、以全局 Bot ID 直取被拒。
- AC2 服务端/浏览器分工：服务端可执行工具走 ME04 包装；需要浏览器的工具不在服务端伪造结果——挂起为 `frontend_tool` continuation 并向客户端发 TOOL_CALL 事件等待真实回包。测试：浏览器工具产生挂起+事件；服务端无伪造结果路径。
- AC3 无人值守挂起：headless 运行遇需参与工具时持久挂起（frontend_tool continuation），原 UI 可查看并在参与后恢复；stop/撤权后阻断。测试：headless 挂起→人工（前端应答）完成恢复；stop 后敏感工具不再执行。
- AC4 结果关联与幂等：工具结果关联原 operationId/toolCallId + argsDigest；重复客户端回包不重复追加结果、不重复副作用（ME05 receipt 复用）。测试：同一回包重放两次只计一次。
- AC5 gallery/activity 语义：`open-generative-ui` 活动（copilot.ts ~L4653 的 legacy 通道）在 Mastra 路径保持渲染/授权语义；等待状态刷新后不丢。测试：等待中的 frontend_tool 刷新后状态仍在；gallery 事件走原授权。
- AC6 审批/host-access 保持：Computer 审批链路（`/api/approvals/computer/*`）与 host-access 限制不变；已撤销控制凭据、过期恢复、跨范围环境均拒绝。测试：撤销控制凭据后 computer 工具拒绝；过期 claim 走 ME05 过期规则。

## 实现要点

- 修改集中在：`server/src/copilot.ts`（mastraAgentConfiguration 打开 computerGuidance + 传工具）、`server/src/mastra/execution.ts`（durable 挂起已在 ME05 就位：~L214-240 durable tool mount、~L331-365 onSuspension save-before-end——frontend_tool 与 approval 走同台账）、必要时 `server/src/mastra/tools.ts`/`resume-driver.ts`（frontend_tool 的 drive 形状：客户端结果 → resume 输入）、`server/src/computer/*` 只读消费不改引擎。
- **不改**：`server/src/computer/` 引擎本身、Craft/沙箱引擎、`server/src/approvals/**`、OpenMuse 子模块。app 侧仅当真实缺口才改（T12 原则：验证已有 UI 行为，不无故重构）。
- 复用 ME05 fixture 模式（`server/tests/support/me05-fixture.ts`：一次性受限角色 DB + 真实 drizzle 迁移 0164）。
- 新测试文件建议：`server/tests/mastra-computer-tools.test.ts`（unit）+ `server/tests/enterprise/mastra-frontend-tool-participation.integration.test.ts`（integration，真子进程/双实例模式照 me05-child.ts）。新文件入册：`node scripts/e2e-file-audit.mjs && node scripts/e2e-bun-manifest.mjs`（禁止手编清单）。
- 验证命令基线：绿波 13 文件 + 本票新套件（`ME01_TEST_PG_PORT=5433 TEST_DATABASE_URL=postgresql://postgres:openbot@127.0.0.1:5433/openbot_test bun test …`）；typecheck 基线 = 3 个已知 `scripts/bootstrap-local-gateway.ts` 错误；`bunx biome check` 干净。
- 环境事实：测试 PG 容器 `openbot-test-pg`（:5433，postgres/openbot，库 openbot_test 已迁移）；一次性库模式见 me01/me03/me05 fixture。缺环境记 UNVERIFIED 与确切失败，不静默 skip。

## 边界与上报

- 只迁移工具调度与客户端参与协议。出现"必须改 Computer/Craft/沙箱引擎才能工作"即为范围外，停下来在报告里说明。
- 冲突升级：实现与 Spec/ADR 冲突时不在实现阶段静默改设计，报告冲突点由控制器裁决。
- 报告写 `docs/plans/2026-10-19-mastra-execution-run/me06/report.md`：命令、真实计数（pass/fail/skip/expect）、改动文件清单、AC 对照、UNVERIFIED 项、环境事实。不 commit/push。

## 评审跟踪（ME05 review 结论，必须纳入本票）

- **F1（Important）围栏缺口**：claim 过期被接管后，原（迟到的）driver 无法察觉自己已失去 claim 仍会 drive `resumeStream`（`resume-driver.ts:160-168`，`recordOperationStarted` onConflictDoNothing 吞掉归属变化）。若 ME05 修复轮先行落地则消费其结果；若未落地，本票接线 frontend_tool drive 形状时必须一并补上（迟到的失主 driver 在 drive 前被拒绝，receipt/外部调用不变）。
- **F2（merge-time）**：drizzle 0164 编号与 main 未提交的 `0164_usage_outbox_workspace` 冲突；本票新增迁移前先查工作区真实下一个编号，合并时按集成清单重编号。
- **生产装配**：ME05 的 `setMastraContinuations` / `resumeFromApprovalDecision` 目前无 index.ts 调用方（评审确认符合 ME05 fence）。本票让"客户端参与工具"真实可演示，因此由本票在生产装配（`server/src/index.ts`）构造真实 continuation store 并接上 seam；这是参与等待/恢复对用户可见的前提。
- **approvals-integration 可观测性**：ME05 评审指出 product observability 随本票落地——审批/参与等待在聊天 UI 的可见状态（waiting/suspended、刷新后仍在）属本票 AC5 范围。

## R2-10 所有权（OCR 第 2 轮裁定）

fixture 去重（container/psql/bootstrap 三份拷贝，第 4 次 defer）由本票起点完成：动手写 computer fixture 之前，先抽 `server/tests/support/pg-container.ts` 共享 helper（container()、psql()、一次性库+受限角色 bootstrap、drop() 清理），me01/me03/me05 三份 fixture 改为消费它；行为零变化（各 fixture 现有测试不动，只换底层助手）。

## Re-review 遗留（2026-10-20 波 2/3/4 复审）

- `server/src/mastra/execution.ts` 尚有 4 处 `as unknown as BaseEvent`（R3-10 的 RUN_ERROR 发射点，stream-events.ts 的 R4-14 只清了自己文件）。本票拥有 execution.ts，顺手改为按 @ag-ui/client 具体事件类型构造（与 stream-events.ts 的 R4-14 模式一致）。
