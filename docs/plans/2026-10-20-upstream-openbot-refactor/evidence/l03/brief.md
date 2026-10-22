# Task Brief L03：分步登录表单与客户端兼容

- **Task/AC**: L03 / A08（端到端收口）。正式 Issue：[#496](https://github.com/1123786563/OpenBot/issues/496)（本地票 `docs/tickets/upstream-openbot-update/issues/up08.md`）。
- **owner_role**: frontend_implementer（你）。
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`。不得 cd 主 checkout、不得 git stash/commit/push、不派发子 Agent。**前置**：L02 已 verified（`POST /api/sign-in-requests/:id/code`、code_required 状态机、`submitCode`）。

## 事实源

1. Spec §5（尤其第 1、8 条）+ up08 criteria 第 1、6、10 条；计划 L03 接口行。
2. 上游参考（只读）：`evidence/upstream-sources/app/src/components/passwords/sign-in-form.tsx`、`app/src/lib/passwords/{queries,mutations}.ts`、`app/src/lib/copilot/sign-in-tool.tsx`。
3. 本地现状：`app/src/components/passwords/sign-in-form.tsx`、`app/src/lib/passwords/{queries,mutations}.ts`、`app/src/lib/copilot/sign-in-tool.tsx`；`app/tests/sign-in-card.test.tsx`（既有，只可扩展）。
4. 先读 `.claude/skills/openbot-data-access`（mutations 工厂）与 `openbot-screen-layout`。

## owned_files

- `app/src/components/passwords/sign-in-form.tsx`
- `app/src/lib/passwords/queries.ts`、`app/src/lib/passwords/mutations.ts`
- `app/src/lib/copilot/sign-in-tool.tsx`
- `app/src/locales/en/settings.json`、`app/src/locales/zh-CN/settings.json`
- `app/tests/sign-in-card.test.tsx`（扩展）、`app/tests/sign-in-code-step.test.tsx`（新建）
- `docs/verification/e2e-bun-suites.json`（新 suite 登记）

## 接口

- 新增 `submitSignInCodeMutationOptions(queryClient)`，variables `{id: string; code: string}`。
- `SignInStatus` 增 `code_required`；`FINAL_SIGN_IN` 保持四终态（signed_in/failed/cancelled/expired——以本地现状为准核对）。

## 要求（RED→GREEN→REFACTOR）

1. **RED**（`app/tests/sign-in-code-step.test.tsx` 先失败）：pending 只显示用户名/密码，不提前问 code；code_required 只显示 code 与必要说明；**初次 UI 不再发送 code**（旧字段从密码提交中移除）；wrong code → 可显式重试；filling → 禁重复提交；expired/cancelled → 无可提交控件。
2. 秘密清理：code 字段从不进密码 vault；提交/取消/卸载清空秘密与 mutation variables（避免 TanStack 完成后长期保留含 code 的 variables）；保存密码选择保持现有行为。
3. 独立 `/sign-in/$requestId` 页面与聊天 dialog 共用同一状态组件；sign-in tool 等待 code_required 不提前返回成功；用户导航/组织变化关闭旧 request 绑定并清理旧查询结果。
4. **i18n/可访问性**：en/zh-CN settings.json 新词条；keyboard/autoComplete（one-time-code）/status live region；沿用现有 15 分钟等待窗口文案口径。
5. **验证**：`bun test ./app/tests/sign-in-code-step.test.tsx` + 回归 `bun test ./app/tests/sign-in-card.test.tsx`；统一驱动 `E2E_BUN_ONLY=app/tests`（ai-observability 为已登记 BASE 红）；`bun run --filter app typecheck`；`bunx biome format` 每改动文件真实 exit 0（新增行）。
6. 兼容：旧 client 的上游 code 字段在服务端不会提前执行（L02 已保证）——在本任务测试中加一条客户端不发送的钉住即可，不改服务端。

## 禁止

- 不改服务端/L01/L02 文件（消费接口）；不自动重放登录；不把 code 写日志/持久层；非 owned untracked 文件不删。

## 报告

`evidence/l03/implementer-report.md`：改动摘要、RED/GREEN 证据、秘密清理矩阵、i18n 词条、format/typecheck、偏差。
