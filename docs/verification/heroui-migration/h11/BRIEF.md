# H11 Task Brief — frontend_implementer（Craft 工作区、预览和产物操作）

工作目录（唯一写入范围）：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
授权来源：父 Issue #443 委派提示词（实施已授权；#454 票面旧状态不适用）。不 commit/push。
前置：H10 已实现并复审（读 `reviews/` 对应 H10 结论；消费其聊天/实时屏幕控件 Interface）。

## 必读（按序）
1. `docs/tickets/heroui-migration/issues/h11.md`（范围、AC1–AC4）
2. `docs/adr/0008-test-runner-tester-army-e2e.md`
3. `h10/REPORT.md` 的控件消费说明 + `h03/REPORT.md`「下游 Interface」
4. `LEDGER.md` 2026-10-20 段

## 上游 Interface（冻结，只消费不改）
- 禁改：`ui/*`、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`、`preload.ts`、H03–H10/H12/H13 已改文件（见各自 POST-CHECKPOINT）。
- **不改 iframe origin/票据/sandbox/会话协议**——纯前端控件迁移。

## 范围（主所有权）
- 路由：_authed/_app/craft/{index,$sessionId,tasks}。
- 组件：`craft/*`（chat-panel、composer、message/*、output-panel/*、session-sidebar、subagent-view、scheduled-task-editor、attachment-input、sandbox-status-indicator、tool-cards/diff-body）+ `channels/workshop-*`（artifacts、files、panel、schedules、share、turn、usage——H10 明确不动归本任务）。

## 合同（AC 对照 h11.md——Craft 红线）
- 列表/任务/文件/产物动作保持加载/失败/成功状态。
- 预览菜单、放大/还原、下载/分享**不重挂载 iframe、不丢预览交互状态**。
- 预览 iframe 的 origin/票据/sandbox/会话隔离不变；**父应用主题不被假设穿透 iframe**（保持隔离事实）。
- 窄屏/短屏下任务面板与预览可操作；内层滚动与 Overlay 正确（消费 dialog 守卫 v3）。

## 已知红
- 本域 app 层无已知红。新红先单变量归因（preload 修复后先重跑）。

## 验证（全部执行并记录命令+exit code）
- `cd app && bun run typecheck`；`cd app && bun run build`
- native：仓库根 `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h11/native bunx e2e run --config e2e.unit.config.ts`
- 重点：craft 前端/预览既有回归
- 变更文件 biome lint/format；预览交互浏览器证据留 validator（cdp-harness 可复用）

## 交付
`h11/REPORT.md` + `POST-CHECKPOINT.sha256`（格式同 h05）。阻塞记录证据继续可做部分。
