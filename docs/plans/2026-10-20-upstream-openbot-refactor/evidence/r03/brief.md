# Task Brief R03：研究工具标签与 skill 选择 UI

- **Task/AC**: R03 / A10（前端）。正式 Issue：[#500](https://github.com/1123786563/OpenBot/issues/500)（本地票 `docs/tickets/upstream-openbot-update/issues/up10.md`）。
- **owner_role**: frontend_implementer（你）。
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`。不得 cd 主 checkout、不得 git stash/commit/push、不派发子 Agent。**前置**：R02 已 verified（角色求交、引导语去 Parallel 化）、U04 已 verified（工具摘要视图）。

## 事实源

1. Spec §7 + up10 criteria 第 5、6 条。
2. 上游参考（只读）：`evidence/upstream-sources/app/src/lib/plugins/tool-name.ts`、`app/src/components/skills/skill-tools.tsx`、`app/src/lib/skills/form.ts`。
3. 本地现状：`app/src/lib/plugins/tool-name.ts`（152 行）、`app/src/components/skills/skill-tools.tsx`、`app/src/lib/skills/form.ts`（84 行）、U04 的 `tool-activity.tsx`（`summarise` 已结构化）。I4 消费：`shared/research.ts` 的逻辑角色与实际 tool refs。先读 `.claude/skills/openbot-data-access` 与 `openbot-screen-layout`。

## owned_files

- `app/src/lib/plugins/tool-name.ts`、`app/src/components/channels/tool-activity.tsx`、`app/src/components/skills/skill-tools.tsx`、`app/src/lib/skills/form.ts`
- `app/src/locales/{en,zh-CN}/{channels,settings,skills}.json`
- `app/tests/tool-name.test.ts`、`app/tests/tool-activity.test.tsx`（扩展）
- `docs/verification/e2e-bun-suites.json`（如需登记）

## 要求（RED→GREEN→REFACTOR）

1. **RED（tool-name）**：三 provider 的 search/fetch 工具显示"搜索网页/读取网页"类标签（en/zh）；未知工具显示原名，**不误标成功/只读**；`@research/search`/`@research/fetch` 逻辑 ref 显示角色标签。
2. **RED（tool-activity 摘要）**：聚合摘要按真实步骤统计查询/页面数（"Searched 3 times and read 5 pages"类），依据真实返回结果；错误时保留 provider 原因与原始来源链接；**没有返回页面数时不编造数量**。
3. **skill 选择**：`SkillTools` 增加逻辑研究角色选项（`@research/search|fetch`）；`form.ts` 的 `undeclaredElsewhere` **不把合法逻辑角色当作失效工具**；兼容旧实际 ref（`parallel/web_search` 等）；"声明不等于授权"的说明保留。
4. **i18n**：三组 locales 新词条；键盘/中英文断言。
5. **验证**：`bun test ./app/tests/tool-name.test.ts`、`bun test ./app/tests/tool-activity.test.tsx` + U04 既有断言回归；统一驱动 `E2E_BUN_ONLY=app/tests`（已登记基线红除外）；`bun run --filter app typecheck`；`bunx biome format` 每改动文件真实 exit 0（新增行）。

## 禁止

- 不改服务端/R01/R02 文件（消费接口）；不默认启用 provider；不把未知工具标为只读/成功；单 Parallel 老配置兼容。

## 报告

`evidence/r03/implementer-report.md`：改动摘要、标签矩阵、skill 选择变化、i18n、RED/GREEN、format/typecheck、偏差。
