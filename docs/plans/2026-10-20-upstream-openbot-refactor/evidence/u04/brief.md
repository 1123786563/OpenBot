# Task Brief U04：工具活动分组与摘要

- **Task/AC**: U04 / A07。正式 Issue：[#499](https://github.com/1123786563/OpenBot/issues/499)（本地票 `docs/tickets/upstream-openbot-update/issues/up07.md`）。
- **owner_role**: frontend_implementer（你）。
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`。不得 cd 主 checkout、不得 git stash/commit/push、不派发子 Agent。
- **前置**：U03 已 verified（connect-app-card 已在 transcript 中渲染；连接卡片是分组边界之一）。

## 事实源

1. Spec §3 第 4 条 + up07 六条 criteria。
2. 上游参考（只读）：`evidence/upstream-sources/app/src/components/channels/tool-activity.tsx`（447 行）与上游 `chat-transcript.tsx` 的接入方式。
3. 本地现状：`app/src/components/channels/chat-transcript.tsx`（工具渲染接入约 :1711 起，含 BrowserActivity）、`browser-activity.tsx`（现有单条浏览器活动展示）、U03 产出的 connect-app-card。**先读 `.claude/skills/openbot-data-access` 与 `openbot-screen-layout`**。
4. 接口合约（计划 §2 工具摘要行）：`groupToolSteps(items: readonly VisibleChatItem[]): TranscriptItem[]`，`ToolGroup {kind:'tools'; id:string; steps:ToolItem[]}`——纯分组函数与展示分离；**只改视图投影，不写回消息存储**。

## owned_files

- `app/src/components/channels/tool-activity.tsx`（新建）、`app/tests/tool-activity.test.tsx`（新建）
- `app/src/components/channels/chat-transcript.tsx`、`app/src/components/channels/browser-activity.tsx`
- `app/src/locales/en/channels.json`、`app/src/locales/zh-CN/channels.json`
- `docs/verification/e2e-bun-suites.json`（新 suite 登记与对账）

## 要求（RED→GREEN→REFACTOR）

1. **RED**：`bun test ./app/tests/tool-activity.test.tsx` 先失败再实现。行为矩阵：
   - 相邻普通 connector（mcp）/browser 工具折叠为一组；**单条 connector 保持原单行行为**（回归现有展示）；文本消息打断分组；组 id 用首步骤 id（流中不重挂载）。
   - **边界不折叠**：连接卡片（U03）、审批、Team Bot consent、人机接管、自定义组件工具保持独立可见。
   - pending→success/blocked/failed/refused 计数随真实结果更新；完整参数/结果逐项可展开；可显示 result 先走现有 asText/forDisplay/refusal 处理，不截去唯一错误信息；失败/拒绝分类保留。
   - 沿用现有 untrusted envelope 与 renderer，供应商内容不当授权。
2. **GREEN**：分组函数纯（无副作用、可单测），展示组件消费之；流式更新不闪烁、展开状态稳定。
3. **验证**：`bun test ./app/tests/tool-activity.test.tsx` + 回归 `bun test ./app/tests/connect-app-card.test.tsx`；统一驱动 `E2E_BUN_ONLY=app/tests ...`（ai-observability 为已登记 BASE 红）；`bun run --filter app typecheck`；`bunx biome format` 每文件真实 exit 0（新增行）。
4. **i18n**：en/zh-CN channels.json 新词条；键盘展开/收起；中英文断言；历史消息无需迁移（投影是视图层）。
5. R03 之后将接入研究角色标签——本任务只做 generic connector/browser 分类，**不要**提前实现 research 逻辑。

## 禁止

- 不改消息存储/工具执行；不引入新依赖；不隐藏人工决定类条目；不修改 U02/U03 的 shared 与卡片文件（消费接口可以）；locales 外不加硬编码文案。

## 报告

`evidence/u04/implementer-report.md`：改动摘要、分组边界清单、RED/GREEN 证据、流式/展开稳定性验证、i18n、format/typecheck、偏差。
