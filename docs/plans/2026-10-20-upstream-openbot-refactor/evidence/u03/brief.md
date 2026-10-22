# Task Brief U03：对话内连接卡片

- **Task/AC**: U03 / A06（前端半部）。正式 Issue：[#495](https://github.com/1123786563/OpenBot/issues/495)（本地票 `docs/tickets/upstream-openbot-update/issues/up06.md`）。
- **owner_role**: frontend_implementer（你）。
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`。不得 cd 主 checkout、不得 git stash/commit/push、不派发子 Agent。
- **前置**：U02 已 verified——`shared/connect-prompt.ts` 提供 `CONNECT_APP_MARKER`、`readConnectPrompt(text): ConnectPrompt|null`（严格 codec，fail-closed）。先读该文件与 `server/src/plugins/store.ts` 的 marker 分支了解服务端行为。

## 事实源

1. Spec §4 第 3–4 条 + up06 criteria 第 3–7 条。
2. 上游参考（只读）：`evidence/upstream-sources/app/src/components/channels/connect-app-card.tsx`（172 行）与 `.../chat-transcript.tsx` 的接入方式。
3. 本地现状：`app/src/lib/plugins/mutations.ts:428` `connectAccountMutationOptions`（返回 `Promise<string|null>`）、`app/src/lib/plugins/queries.ts:351` `personalConnections`、`:363` `connectionsQueryOptions`；`app/src/components/channels/chat-transcript.tsx` 约 :1711 是工具渲染接入点。**复用这些现有 API，不另建 connect API**。
4. 会话 Skill：`.claude/skills/openbot-data-access`（读必须走 queries 工厂、写必须走 mutations 工厂）、`.claude/skills/openbot-screen-layout`（卡片尺寸/词汇）——实现前先读，遵循其规则。

## owned_files

- `app/src/components/channels/connect-app-card.tsx`（新建）、`app/tests/connect-app-card.test.tsx`（新建）
- `app/src/components/channels/chat-transcript.tsx`
- `app/src/locales/en/channels.json`、`app/src/locales/zh-CN/channels.json`

## 要求（RED→GREEN→REFACTOR）

1. **RED**：`bun test ./app/tests/connect-app-card.test.tsx` 先失败再实现。覆盖：
   - 点击同步预占空 tab（`window.open('about:blank')` 同步调用），得到授权 URL 后 `location.replace` 导航并切断 opener（`opener=null`）；popup blocked 时给出可点链接的明确退路；URL 为 null（key 模式）时导航到现有设置页面，**绝不导航到 null**。
   - 轮询：仅等待期间每 2,000ms 调本人 `personalConnections`；最长 5 分钟后转明确重试态；成功只接受 serverId 匹配且 `revoked !== true` 的记录；窗口返回/关闭不算成功。
   - 成功后精准 invalidation 当前插件/授予相关查询；显示"再次发起"提示；**不自动重放原工具**。
   - 卸载、切 Bot/组织后的旧响应不更新新卡片（查询结果绑定当前有效范围）；错误/取消路径可操作。
   - 无 marker 的普通 tool 结果不渲染卡片（codec fail-closed）。
2. **transcript 接入（关键，U02 validator OBS-3）**：工具结果全文形如 `Refused. [connect-app]{...}`——`readConnectPrompt` 要求文本以 marker 开头，**必须先剥离 `Refused.` 信封**（见 `server/src/plugins/tools.ts` 的 REFUSAL_MARKER 与上游 chat-transcript 的处理方式）再识别；否则卡片永不绘制。旧客户端（无 marker）仍显示可读拒绝文本；卡片不可用时退回文本。
3. **i18n**：en/zh-CN `channels.json` 新词条；不硬编码英文；键盘可操作 + status live region；窄屏可用。
4. **验证**：`bun test ./app/tests/connect-app-card.test.tsx`；`E2E_BUN_ONLY=app/tests bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`（登记对账；ai-observability 组为已登记 BASE 既有红）；`bun run --filter app typecheck`；`bunx biome format` 每个改动文件真实 exit 0（新增行）。

## 禁止

- 不建第二套 OAuth/connect API；不改服务端；marker 解析结果不作授权依据；不向任意 origin 导航（URL 来自服务端 connect endpoint 响应）；秘密不入日志/测试 fixture（用虚构值）；不改 U02 的 shared 文件与其他任务文件。

## 报告

`evidence/u03/implementer-report.md`：改动摘要、RED/GREEN 证据、轮询/清理/范围切换的行为矩阵、i18n 词条清单、format/typecheck 结果、偏差。
