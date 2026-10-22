# H10 Task Brief — frontend_implementer（聊天输入、消息动作与实时屏幕交互）

工作目录（唯一写入范围）：`/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`
授权来源：父 Issue #443 委派提示词（实施已授权；#453 票面旧状态不适用）。不 commit/push。
前置：H03+H09 已实现并复审（读 `reviews/` 对应结论；消费 H09 导航浮层 Interface）。

## 必读（按序）
1. `docs/tickets/heroui-migration/issues/h10.md`（范围、AC1–AC6）
2. `docs/adr/0008-test-runner-tester-army-e2e.md`
3. `h03/REPORT.md`「下游 Interface」节 + `h01/browser/RUN-2026-10-19.md`（弹层守卫 v3 语义——聊天浮层消费它）
4. `LEDGER.md` 2026-10-20 段 + `BACKLOG-H14-H15.md`（本域遗留：bubble.tsx hover --muted）

## 上游 Interface（冻结，只消费不改）
- 禁改：`ui/*`（bubble/message/message-scroller/questionnaire/context-menu/carousel/live-waveform 名义归本 Issue 但已随 H02/H03 去 Base-UI 化并冻结——确需改动记 Interface 变更申请）、`package.json`/`bun.lock`、`main.tsx`/`__root.tsx`、`styles/*`、`lib/theme.ts`、`preload.ts`、H03–H09/H12/H13 已改文件。
- **保留专用引擎行为：PromptArea（内容模型/IME）、Streamdown（渲染）、Embla（轮播）、@shadcn/react questionnaire 与 message-scroller**——只迁移其中的通用控件与动作入口。

## 范围（主所有权）
- 路由：_authed/_app/channel/{new,$channelId}、group/{new,$channelId}、share.$token。
- 组件：`channels/*`（composer 全家、chat-transcript、conversation-view、recipient-field、tool-line/tool-boundary、voice-*、team-bot-consent、avatar、browser-activity、group-*；workshop-* 归 H11 不动）、`computer/*`（live-screen、computer-view/panel/controls、activity-log、command-output、demonstration-recorder、handoff-resume-notice、placeholder、desktop-illustration）、`suggestions/proactive-panel.tsx`。

## 合同（AC 对照 h10.md——聊天域红线，最重合同区）
- **中文 IME 组合期 Enter 不误发**；单次提交只发一次；disabled/pending/停止/重试语义不变。
- 附件添加/粘贴/拖入/取消/上传失败/重试生命周期不变；**非接收区 drop 不卸载页面**（根级保护）。
- 流式追加/手动滚动/回底部/历史加载锚点正确；**不因换按钮库重挂载消息列表**。
- 问卷/消息滚动的 render 动作与 HeroUI 按钮兼容（H01 已验组合模式）；上下文菜单用已验证的右键/键盘/触摸策略（H01 fixture 证据 + H15 in-app 复核）。
- 实时屏幕键盘接管/释放/快捷键优先级正确；菜单/弹窗焦点不吞屏幕控制（dialog 守卫 v3 分层语义）。
- 跨公司/团队会话切换保留归属：草稿/附件/异步响应不串入新范围。

## 已知红（须修复或单变量归因）
- `zz-probe-context-menu` 8 红（**既有真回归，归本域修复**——先读 h02/form-primitives/report.json 与 zz-probe 测试本体定因）。
- `update-routing` / `live-screen-mouse wheel` 相关红（先单变量归因：preload 修复后可能已绿）。
- `heroui-spike` TextArea 红：先核 H13 的 F3 复核结论；若属 spike 测试自身（非生产路径）如实记录转 H15。
- pre-existing 勿追：gallery-components（H13）、approval-team-settings（H07）、bot-sharing（H07）。

## 附加任务（BACKLOG 转）
- `bubble.tsx:33` hover `--muted` → 语义 token（H02 审查 M1，本域文件；若属冻结范围记 Interface 申请由主控裁决）。

## 验证（全部执行并记录命令+exit code）
- `cd app && bun run typecheck`；`cd app && bun run build`
- native：仓库根 `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h10/native bunx e2e run --config e2e.unit.config.ts`
- 重点：composer-*、live-screen-keyboard、carousel-keyboard、channel-* 全家
- IME/滚动/屏幕接管真实浏览器证据留 validator 轮（spike/CDP harness 可复用 `h01/browser/cdp-harness/` 配方；CHROME_PATH 可覆盖）
- BASE 对照 worktree 放 /tmp 且用后删除

## 交付
`h10/REPORT.md` + `POST-CHECKPOINT.sha256`（格式同 h05）。TDD 优先测公共 Seam。阻塞记录证据继续可做部分。
