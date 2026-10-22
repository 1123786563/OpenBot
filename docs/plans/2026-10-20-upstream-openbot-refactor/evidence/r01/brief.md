# Task Brief R01：共享研究角色与 provider catalogue

- **Task/AC**: R01 / A10（静态角色/目录）。正式 Issue：[#500](https://github.com/1123786563/OpenBot/issues/500)（本地票 `docs/tickets/upstream-openbot-update/issues/up10.md`）。
- **owner_role**: backend_implementer（你）。
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`。不得 cd 主 checkout、不得 git stash/commit/push、不派发子 Agent。**不改 MCP 调用/选择/UI（R02/R03）。**

## 事实源

1. Spec §7 前 3 条 + up10 criteria 第 1、2 条；实施计划 I4 合约。
2. 上游参考（只读）：`evidence/upstream-sources/shared/research.ts`（93 行）、`server/src/plugins/catalogue.ts`（744 行——本地 catalogue 已分叉，按行为对齐：提取 reviewed host/path/认证 header/readTools，**不整文件复制**）。
3. 本地现状：`server/src/plugins/catalogue.ts` 有 parallel/parallel-authenticated 条目（:164/:176）、`CatalogueAuth`（:35）、`catalogueEntry`/`hostAdmissible`/`resolveServerUrl`/`classifyTool`（:358/:370/:384/:428）；无 `shared/research.ts`。**继承原 Parallel ID**（读本地条目实际 id），旧 grants 不失效。

## I4 合约（严格遵守）

```ts
type ResearchRole = 'search' | 'fetch';
type ResearchTools = { search: string; fetch: string; notes?: readonly string[] };
const RESEARCH_TOOLS: Readonly<Record<string, ResearchTools>>;
researchRoleOfTool(server: string, tool: string): ResearchRole | null;
researchRoleOf(ref: string): ResearchRole | null;
```

键为 catalogue key：`parallel`, `parallel-authenticated`, `exa`, `exa-authenticated`, `firecrawl`, `firecrawl-authenticated`。工具名：`web_search`/`web_fetch`、`web_search_exa`/`web_fetch_exa`、`firecrawl_search`/`firecrawl_scrape`。逻辑 ref：`@research/search`、`@research/fetch`；错拼/多斜线 → null。

## owned_files

- `shared/research.ts`、`shared/research.test.ts`（新建）
- `server/src/plugins/catalogue.ts`、`server/tests/plugin-catalogue.test.ts`
- `docs/verification/e2e-bun-suites.json`（如需登记）

## 要求（RED→GREEN→REFACTOR）

1. **RED（shared/research.test.ts）**：I4 六 key 与 catalogue 一致；`@research/search|fetch` 正确解析；错拼/多斜线/未知 → null；`researchRoleOfTool` 按 server+tool 判定。
2. **RED（plugin-catalogue.test.ts）**：Exa/Firecrawl 条目——reviewed HTTPS host/path（从上游 catalogue 提取）；认证 header（Exa `x-api-key`、Firecrawl `Authorization`，以上游为准核对）；`CatalogueAuth` 兼容扩展 `header?: string` + `tokenHeaderFor(entry): string`（默认 Authorization）；`classifyTool`：Exa 只读 allowlist 含 search/fetch/advanced_search；Firecrawl crawl/agent/interact/feedback **不归 read**；**未知工具 fail closed**（不因 provider 名降级）。
3. **负例**：子域伪装（`evil-search.parallel.ai`、`search.parallel.ai.evil.com`）、路径变种、重复 catalogue key、未知工具分类——V-N 全覆盖。
4. **兼容**：`catalogueEntry`/`resolveServerUrl`/`classifyTool` 原签名兼容；现有 provider 默认认证行为不变；旧 Parallel 真实 ref/ID/grants 不失效（读本地实际 id 继承）。
5. **验证**：`shared/research.test.ts` native（`bunx e2e run --config e2e.unit.config.ts shared/research.test.ts`，不带 scope）；`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/plugin-catalogue.test.ts`；登记对账；`bun run --filter server typecheck`（BASE 红不计入）；`bunx biome format` 每改动文件真实 exit 0（新增行）。
6. 只读是权限分类不代表免费——注释里说明（沿用上游措辞）。

## 禁止

- 不实现 MCP 调用/header 发送（R02）；不做 UI 标签（R03）；不让管理员任填 header 名或 credential URL；不默认启用新 provider。

## 报告

`evidence/r01/implementer-report.md`：改动摘要、六 key/工具名对照表、reviewed host/path/header 清单（注明上游出处）、fail-closed 证明、兼容证明（旧 ref/grants）、RED/GREEN、format/typecheck、偏差。
