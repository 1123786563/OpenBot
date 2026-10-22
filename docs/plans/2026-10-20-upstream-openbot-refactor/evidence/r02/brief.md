# Task Brief R02：MCP 认证、skill ref 和治理执行

- **Task/AC**: R02 / A10（后端）。正式 Issue：[#500](https://github.com/1123786563/OpenBot/issues/500)（本地票 `docs/tickets/upstream-openbot-update/issues/up10.md`）。
- **owner_role**: backend_implementer（你）。
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`。不得 cd 主 checkout、不得 git stash/commit/push、不派发子 Agent。**前置**：R01 已 verified（`shared/research.ts` 角色、catalogue 六 key、`tokenHeaderFor`）；U04 已 verified（工具摘要视图存在）。**不做 UI 标签（R03）。**

## 事实源

1. Spec §7 全部 5 条 + up10 criteria 第 1–6 条。
2. 上游参考（只读，按行为对齐）：`evidence/upstream-sources/server/src/plugins/{mcp,tools,selection}.ts`、`server/tests/web-research.test.ts`、`docs/web-research.md`、`.env.example`（上游 store.ts 仅 54 行，本地大文件已分叉——**只参考行为不复制结构**）。
3. 本地现状：`server/src/plugins/tools.ts:145-185` Parallel 专用 researchConnector/引导语；`selection.ts` 的 `selectTools`/`selectionPrompt`；`server/tests/parallel-research.test.ts` 与 `docs/parallel-research.md` 既有；MCP/egress/凭据/预算/审计走现有路径。

## owned_files

- `server/src/plugins/{mcp,tools,store,selection}.ts`（只改实际用到的入口；store.ts 若无需改则不动——R01 已改过它的 catalogue 消费）
- `server/tests/parallel-research.test.ts`、`server/tests/web-research.test.ts`（新建）
- 现有 plugin selection / MCP authorization 相关测试（扩展，不削弱）
- `.env.example`、`docs/web-research.md`（新文档；`docs/parallel-research.md` 保留为兼容说明或按内容并入，注明）

## 要求（RED→GREEN→REFACTOR）

1. **认证（tokenHeaderFor）**：RED——供应商指定 header 正确发送（Exa `x-api-key`、Firecrawl `Authorization`，按 R01 落地值）；无 key 不发送请求；旧 Parallel 保持原认证行为；日志/审计无 header token。driven/native 按实际归层。
2. **逻辑角色求交**：`@research/search`/`@research/fetch` 展开时与**实际已授权 tool refs** 求交；不因 skill 宣告角色授予新 connector；旧 `parallel/web_search`、`parallel/web_fetch` 真实 ref 继续可用（兼容测试）。
3. **引导语去 Parallel 化**：只在实际 search/fetch 能力完整时说明具备完整研究；供应商专用 notes（session_id、隐私边界）分开注入、按实际 provider 生成；不默认启用任何新 provider。
4. **治理执行（mock MCP）**：超时、认证失败、撤权、SSRF 防护、写工具拒绝、**不自动换供应商**；实际 provider/server/tool 身份进入现有审计；预算/Payer/组织隔离复用现有 seam（两公司/撤权用例）。
5. **计费边界**：检查模型 token 账单与外部 MCP 供应商费用——不凭空给 provider API credits 创建 token 账单；本地已有收费规则照常；真实调用与原有计量不重复。
6. **真实 key smoke 单列**：`web-research.test.ts` 中需要真实 provider key 的 case 显式环境门槛（缺 key → 明确 blocked/skip-with-reason，不算验收通过）；mock 合约证据与真实联调证据分开记录。
7. **验证**：`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/parallel-research.test.ts server/tests/web-research.test.ts`（按实际归层；driven 的用 `bun test`）；selection/MCP authorization 既有套件回归；typecheck（BASE 红不计入）；`bunx biome format` 每改动文件真实 exit 0（新增行）。

## 禁止

- 不默认启用新 provider/后台研究；不为失败自动换供应商；未知高风险工具不降为 read（R01 已 fail-closed，消费侧不得绕过）；不改 UI 文件；不改 R01 的 shared/research.ts 语义（发现缺陷报告主控）。

## 报告

`evidence/r02/implementer-report.md`：改动摘要、认证矩阵、角色求交语义、引导语变化对照、治理用例清单、计费边界核查、mock 与真实 key 证据分离、RED/GREEN、format/typecheck、偏差。
