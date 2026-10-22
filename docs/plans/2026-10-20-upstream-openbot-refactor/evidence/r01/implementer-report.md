# R01 Implementer Report — 共享研究角色与 provider catalogue

- Task: R01 / A10（静态半部）；正式 Issue #500（up10 criteria 1、2）。
- 工作区: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`（未提交树，未 commit/push，未用 git stash）。
- 日期: 2026-10-20

## 1. 改动摘要（全部在 owned_files 内）

| 文件 | 改动 |
|---|---|
| `shared/research.ts` | 新建（I4 合约）：`ResearchRole`、`ResearchTools`、`RESEARCH_TOOLS`（六 key，frozen）、`researchRoleOfTool(server, tool)`、`researchRoleOf(ref)`。零依赖，server/app 均可导入。 |
| `shared/research.test.ts` | 新建（13 用例）：六 key 清单、工具名 pin、双条目同工具对、`@research/search|fetch` 解析、错拼/多斜线/未知→null、跨 provider 工具不误配、原型键（`toString`/`constructor`）不冒充 provider、大小写精确匹配。 |
| `server/src/plugins/catalogue.ts` | ① `CatalogueAuth` deployment-bearer 兼容扩展 `header?: string`；② `CatalogueEntry` 新增 `readTools?: readonly string[]`；③ 新增 `EXA_READ_TOOLS` / `FIRECRAWL_WRITE_TOOLS` / `FIRECRAWL_READ_TOOLS`（含“read 是权限分类不代表免费”注释）；④ 新增 exa / exa-authenticated / firecrawl / firecrawl-authenticated 四条目；⑤ 新增 `tokenHeaderFor(entry): string`（默认 `Authorization`）；⑥ `classifyTool` 在 writeTools 之后、recorded 之前加入 readTools 收窄分支。原 `catalogueEntry`/`hostAdmissible`/`resolveServerUrl`/`classifyTool`/`serverCredentialKind` 签名未动。 |
| `server/tests/plugin-catalogue.test.ts` | 追加 11 用例（63 总）：六条目 pinned endpoint、仿冒 host 负例、path pin、catalogue key 唯一性、auth kind/credential kind、`x-api-key` header、`tokenHeaderFor` 默认值矩阵、Exa 三工具 allowlist、Firecrawl write/read 清单 pin、未知工具（`firecrawl_monitor_delete` 等）即便 recorded `"read"` 仍 write、双条目分类一致、六 key 与 catalogue 双向对账、旧 Parallel key/ref/grants 兼容。 |
| `docs/verification/e2e-bun-suites.json` | 未改。两文件均为 native 桶（import `tests/support/e2e-compat`），`scripts/e2e-coverage-audit.mjs` exit 0、`no gaps`，driven 计数保持 478 —— “如需登记”判定为不需要。 |

## 2. I4 六 key / 工具名对照表

| catalogue key | search 工具 | fetch 工具 | notes |
|---|---|---|---|
| `parallel` | `web_search` | `web_fetch` | session_id 复用、model_name 保守（继承上游） |
| `parallel-authenticated` | `web_search` | `web_fetch` | 同上（共享 PARALLEL 常量） |
| `exa` | `web_search_exa` | `web_fetch_exa` | — |
| `exa-authenticated` | `web_search_exa` | `web_fetch_exa` | — |
| `firecrawl` | `firecrawl_search` | `firecrawl_scrape` | — |
| `firecrawl-authenticated` | `firecrawl_search` | `firecrawl_scrape` | — |

逻辑 ref：`@research/search`、`@research/fetch`；前缀 `@research`（未导出常量；上游的 `RESEARCH_ROLES`/`RESEARCH_ROLE_LABELS`/导出的 `RESEARCH_ROLE_PREFIX` 属 UI 标签面，R03 需要，本任务按 brief 禁止“做 UI 标签”未实现——偏差 §7）。

## 3. reviewed host/path/header 清单（上游出处）

提取自 `docs/plans/2026-10-20-upstream-openbot-refactor/evidence/upstream-sources/server/src/plugins/catalogue.ts`（744 行，只读参考，按行为对齐、未整文件复制）：

| key | host | path | auth | header | 上游行号 |
|---|---|---|---|---|---|
| `exa` | `https://mcp.exa.ai` | `/mcp` | `none` | — | :242-253 |
| `exa-authenticated` | `https://mcp.exa.ai` | `/mcp` | `deployment-bearer` | `x-api-key` | :254-267 |
| `firecrawl` | `https://mcp.firecrawl.dev` | `/v2/mcp` | `none` | — | :268-280 |
| `firecrawl-authenticated` | `https://mcp.firecrawl.dev` | `/v2/mcp` | `deployment-bearer` | 默认 `Authorization`（未写 header 字段，与上游一致） | :281-293 |

工具分类清单（同为上游提取）：`EXA_READ_TOOLS` = `web_search_exa`/`web_fetch_exa`/`web_search_advanced_exa`（:175-179）；`FIRECRAWL_WRITE_TOOLS` = `firecrawl_crawl`/`firecrawl_agent`/`firecrawl_interact`/`firecrawl_interact_stop`/`firecrawl_feedback`/`firecrawl_search_feedback`（:182-189）；`FIRECRAWL_READ_TOOLS` = `firecrawl_search`/`firecrawl_scrape`/`firecrawl_map`/`firecrawl_parse`（:191-196）。“只读是权限分类不代表免费”沿用上游措辞（:174 “spend credits, so only the three that read are reads”）并显式加注 READ IS A PERMISSION CLASSIFICATION AND NOT A PRICE。

## 4. fail-closed 证明

- **host**：`hostAdmissible` 原样（raw 字符串相等）。负例已测：`https://search.parallel.ai.evil.com`、`https://evil-search.parallel.ai`、`https://mcp.exa.ai.evil.test`、`https://api.exa.ai`、`https://eu.mcp.firecrawl.dev`、`https://evil.test/mcp.exa.ai` 全部 false。
- **path**：`resolveServerUrl` 忽略 caller host/path，`entry.path` 恒为 catalogue 值（`/mcp` vs `/v2/mcp` 变体已测）。
- **classifyTool 收窄分支**：`if (entry?.readTools && !entry.readTools.includes(toolName)) return "write";` 位于 writeTools 判定之后、`recorded` 之前 ⇒ advertised 但不在 allowlist ⇒ write，且 `recorded: "read"` 无法买回（`firecrawl_monitor_delete`、`firecrawl_scrape_v3` 已测）。recorded `"write"` 仍可收窄 read-listed 工具（`firecrawl_scrape` + `"write"` ⇒ write）。无条目（`classifyTool(null, …)`）与未 advertised 均 write（含 Exa `agent_run`、`web_search_news_exa`）。provider 名不参与降级：六 key 上 `not_advertised` 全部 write。
- **key 唯一性**：`new Set(CATALOGUE.map(key)).size === CATALOGUE.length`（BY_KEY 是 Map，重复 key 会静默遮蔽，已测防回归）。
- **researchRoleOf**：错拼（`serch`/`SEARCH`/`scrape`）、多斜线（`@research/search/extra`、`@research//search`）、真 ref（`parallel/web_search`）、缺前缀（`research/search`、`@research`）、尾斜杠、空串 → 全 null。
- **researchRoleOfTool**：`Object.hasOwn` 防原型键（`toString`/`constructor` → null）；跨 provider（`exa` 的工具名配 `parallel`）→ null；大小写/子串不匹配 → null。

## 5. 兼容证明（旧 ref/grants 不失效）

- 原 Parallel 条目 key 原样继承：`parallel`、`parallel-authenticated`（读本地实际 id，未改）。`resolveServerUrl("parallel") === "https://search.parallel.ai/mcp"`；auth kind `none`/`deployment-bearer`；`serverCredentialKind` `null`/`"mcp"` 均与改动前一致（`server/tests/parallel-research.test.ts` 原有断言原样通过）。
- 旧真实 ref `parallel/web_search`、`parallel-authenticated/web_fetch` 等：`researchRoleOfTool` 判 search/fetch，`classifyTool` 判 read；`examples/fintech/skills.yaml` 声明的四个 ref 所依赖的 key/工具名全部未动。
- Parallel 两条目**不设** `readTools`（上游同样不设）：既有 grants 是在“write-list 方向”语义下发放的，不静默切换到 allowlist 方向。
- `tokenHeaderFor(parallel-authenticated) === "Authorization"`（无 header 字段 ⇒ 默认，与改动前行为相同）。
- `classifyTool` 对无 `readTools` 条目（google-drive/notion/routines/parallel×2/自定义服务器）分支短路，行为逐位不变。
- 相邻 9 个 consumer 套件回归：`parallel-research` / `mcp-listing` / `plugin-oauth` / `composio-classify` / `openconnector-access` / `google-drive-rest` / `component-catalogue` / `component-catalogue-entries` / `responsibility-trigger-tools` = **121/121 通过**。

## 6. RED / GREEN / 验证

| 步骤 | 命令 | 结果 |
|---|---|---|
| RED-1 | `bunx e2e run --config e2e.unit.config.ts shared/research.test.ts`（无 scope） | COLLECTION_ERROR: Cannot find module `shared/research` |
| RED-2 | `E2E_UNIT_SCOPE=server … plugin-catalogue.test.ts` | 先 COLLECTION_ERROR: 无 `tokenHeaderFor` 导出；补类型+默认 `tokenHeaderFor` 后断言级 RED：**11 failed / 52 passed** |
| GREEN-1 | 同 RED-1 | **13/13 passed** |
| GREEN-2 | 同 RED-2 | **63/63 passed**（52 原有 + 11 新增） |
| 回归 | 同 scope，9 套件 | **121/121 passed** |
| 登记对账 | `node scripts/e2e-coverage-audit.mjs` | exit 0：1060 files · 567 native · 478 driven · no gaps；manifest 无需登记 |
| typecheck | `bun run --filter server typecheck` | 仅 3 条 `scripts/bootstrap-local-gateway.ts` TS2339（:106/:108/:120）——BASE 既有红，该文件本任务未触碰、工作树基线即有，不计入 |
| format | `bunx biome format shared/research.ts shared/research.test.ts server/src/plugins/catalogue.ts server/tests/plugin-catalogue.test.ts` | **exit 0**（test 文件曾报 8 处换行，`--write` 修正后复检 exit 0） |

## 7. 偏差与冲突记录

1. **`tokenHeaderFor` 返回类型**：brief 合约为 `(entry): string`（默认 Authorization）；上游为 `string | undefined`（undefined≈默认）。按 brief 实现——任何输入都返回具体 header 名（Exa `x-api-key`，其余一律 `"Authorization"`，含 `null`/未知 key/非 bearer 条目）。对上游消费方式（`?? "Authorization"`）行为等价且更严格；R02 消费面以其 brief 前置描述（`tokenHeaderFor`）为准，无破坏。
2. **上游 `researchRoleFor(ref)` 未移植**：上游 catalogue.ts :165-172 有该辅助（`serverId/toolName` 拆分），但不在 I4 合约、不在 R02 brief 前置清单（R02 前置仅列 `shared/research.ts` 角色、六 key、`tokenHeaderFor`）。R02 可用 `researchRoleOfTool` 等价组合；避免在合约外新增接口面。
3. **上游 label 导出未实现**：`RESEARCH_ROLE_LABELS`（英文 UI 文案）、`RESEARCH_ROLES`、导出的 `RESEARCH_ROLE_PREFIX` 属 UI 标签面（R03），brief 明确 R01 不做 UI 标签。`@research` 前缀以模块内常量存在，语义不变；R03 若需要 label 表应在其 owned_files 内补。
4. **brief 与实际代码无冲突**：Spec §7 前 3 条、up10 criteria 1/2 与 I4 合约、上游 catalogue 行为三者一致，未发现需要升级的冲突。
5. **未做**（按禁止项）：MCP 调用/header 实际发送（R02）、UI 标签（R03）、管理员自填 header/URL、默认启用新 provider。四新条目仅入 catalogue 静态清单，无任何启用/连接行为。

## 8. Diff 范围自查

`git status` 中本任务新增/修改仅：`shared/research.ts`、`shared/research.test.ts`（新）、`server/src/plugins/catalogue.ts`、`server/tests/plugin-catalogue.test.ts`（会话起点均未修改，diff 全部属于本任务）。工作树其余未提交改动为前置任务（U/L/S 系列）遗留，未触碰；`docs/verification/e2e-bun-suites.json` 的既有改动非本任务所为、本任务对其零改动。
