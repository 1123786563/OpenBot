# R03 Implementer Report — 研究工具标签与 skill 选择 UI

- Task/AC: R03 / A10 前端半部（up10 criteria 5、6 的 UI 面）。
- 工作区: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`（未提交树；未 commit/push；未用 git stash；未派发子 Agent）。
- 日期: 2026-10-20。
- 前置消费: R01（`shared/research.ts` 导出面，未改）、R02（selection 角色求交，消费侧只读）、U04（`tool-activity.tsx` 既有投影与断言，扩展不重写）。

## 1. 改动摘要（恰为 owned_files）

| 文件 | 改动 |
|---|---|
| `app/src/lib/plugins/tool-name.ts` | ① `readToolName` 经 `researchRoleOfTool`（shared 原函数）识别六 catalogue key 的 search/fetch，命中即返回角色标签并**丢弃 provider detail**（匿名，上游同语义）；非研究工具路径逐位不变。② `ToolName` 加性扩展 `labelKey?: ResearchLabelKey`（`"tools.researchSearch" \| "tools.researchFetch"`），供组件按语言渲染；无翻译时 `label` 恒为英文回退（与 en locale 同串，测试钉死）。③ 导出 `RESEARCH_ROLES`（`{role, ref}` 两条，picker 用）。R01 交接（`RESEARCH_ROLE_PREFIX` 未导出）按批复处理：ref 在 owned 消费侧拼写，`app/tests/tool-name.test.ts` 用 shared `researchRoleOf` 逐条回读钉死，shared 文件零改动。 |
| `app/src/components/channels/tool-activity.tsx` | ① `StepKind` 增 `search`/`fetch`；`stepDetails` 按 shared 角色分类：search 步骤 detail=首个非空 query 字段（`query/objective/search_queries/queries`），pages=0；fetch 步骤 detail=首个 URL 的 host，单 http(s) URL 时 `href`（真实来源链接），**pages 只在 completed（非 pending/failed/refused）时计 `urls.length`（至少 1），否则恒 0**——失败/拒绝/未完成的调用不产生页数（上游 `Math.max(urls.length,1)` 无条件计数的缺陷在此修正）。② `summarise` 增 `searches`（仅真实返回的 search 步数）与 `fetchedPages`（fetch pages 和）；`browsed` 收窄为仅 browser 步骤的 pages（否则 fetch 页数会串进"浏览了"）。③ 折叠行摘要短语前置 `tools.searchedTimes`/`tools.readPages`（次序对齐上游：searched→read→browsed→connectors）；`labelKey` 走既有 `stepLabel` 翻译管线（zh 生效）。 |
| `app/src/components/skills/skill-tools.tsx` | 在 server 工具组与 "Not connected here" 组之间加 "Public-web research" 组：`RESEARCH_ROLES` 两个按钮（`@research/search`/`@research/fetch`），label 走 skills locale，`title` 带 ref 语义；`variant` 跟随 `held`；gating 只看 `plugins.data`（角色不依赖任何已连 server，上游同型）。既有三段结构（server 工具 / elsewhere / "声明不等于授权" `grantsNothing` 说明）零改动。 |
| `app/src/lib/skills/form.ts` | `undeclaredElsewhere` 增加 `researchRoleOf(ref) === null` 条件：两个合法逻辑角色不再被当作"无 server 提供的失效 ref"列出；错拼/真实 ref 语义不变（null 照旧列出）。文档注释说明豁免理由与 fail-closed 边界。 |
| `app/src/locales/{en,zh-CN}/channels.json` | `tools.` 下新增：`researchSearch`/`researchFetch`（步骤角色标签）；`searchedTimes_one/_other`、`readPages_one/_other`（en 带复数；zh `_other`）。zh：搜索网页 / 读取网页 / 搜索了网页 {{count}} 次 / 读取了 {{count}} 个页面。 |
| `app/src/locales/{en,zh-CN}/skills.json` | `tools.` 下新增：`researchHeading`（Public-web research / 公共网页研究）、`researchSearch`/`researchFetch`（同角色标签）、`researchTitle`（`{{ref}} — on whichever research connector the Bot holds` / `{{ref}} — 在 Bot 持有的任一研究连接器上使用`）。 |
| `app/tests/tool-name.test.ts` | +16 用例（11→27）：六 key 标签矩阵（search/fetch/无 detail 泄漏）、研究 server 上未知工具保原名（含"名字内嵌 server"与"名字不含 server"两形）、`RESEARCH_ROLES`↔`researchRoleOf` 漂移钉、真实 ref 非 role ref、`undeclaredElsewhere` 角色豁免 4 例（豁免/旧真实 ref 照列/共存/错拼仍列）、双语言词条存在性+英文回退与 en locale 同串。 |
| `app/tests/tool-activity.test.tsx` | +9 用例（18→27）：search 步骤角色命名与 query detail、fetch 来源链接、pages 真实性矩阵（pending/failed/refused=0，completed=URL 数）、summarise 真实计数、全败研究组零计数、en 摘要 "Searched the web 3 times and read 5 pages"、失败组保 provider 原因+来源链接+零计数、zh 摘要与角色标签、研究 server 未标注工具仍是普通 connector 步骤。 |
| `docs/verification/e2e-bun-suites.json` | 未改：无新测试文件；`tool-activity.test.tsx` 已在 part 4 登记，`tool-name.test.ts` 为 native 收集（`SUITE_DIRS` 自动）。 |
| `app/src/locales/{en,zh-CN}/settings.json` | 未改（owned 但无消费面：研究标签的三个屏幕是 transcript（channels）、picker（skills）、ServerToolLine/access（不可 owned）；settings 下无研究词条消费点）。 |

## 2. 标签矩阵（六 key × search/fetch + 负例）

| 输入（模型所见） | en（无翻译回退 = en locale） | zh（经 `labelKey`） | detail | kind |
|---|---|---|---|---|
| `mcp__parallel__web_search` | Search the web | 搜索网页 | —（匿名） | search |
| `mcp__parallel-authenticated__web_search` | Search the web | 搜索网页 | — | search |
| `mcp__exa__web_search_exa` | Search the web | 搜索网页 | — | search |
| `mcp__exa-authenticated__web_search_exa` | Search the web | 搜索网页 | — | search |
| `mcp__firecrawl__firecrawl_search` | Search the web | 搜索网页 | — | search |
| `mcp__firecrawl-authenticated__firecrawl_search` | Search the web | 搜索网页 | — | search |
| 同六 key 的 fetch 名（`web_fetch`/`web_fetch_exa`/`firecrawl_scrape`） | Read web pages | 读取网页 | — | fetch |
| `mcp__exa__web_search_advanced_exa` | Web search advanced exa（原名 humanise） | 同（无 labelKey） | —（名字内嵌 server，既有规则吞掉） | connector |
| `mcp__exa__deep_research` | Deep research | 同 | exa | connector |
| `mcp__notes__search_notes` | Search notes | 同 | — | connector |

- 摘要短语：`Searched the web N times and read M pages` / `搜索了网页 N 次并读取了 M 个页面`；与研究短语并存的 browser/connector 短语次序：searched → read → browsed → used connector(s)。
- 计数真实性：`searches` 只数真实返回的 search 步；`fetchedPages` 只数 completed fetch（`urls.length`，无 URL 形状时 1）；pending/failed/refused 一律 0，且 issues 计数照旧显示。"没有返回页面数不编造数量"由用例 `a group where every research call failed counts nothing` 与 `summarise counts searches and pages from real returns only` 钉死。
- "未知工具不误标成功/只读"：未知工具不获 `labelKey`、不获 search/fetch kind、不带 read 标记；权限分类仍完全在 server（`classifyTool`，未触碰）。

## 3. skill 选择变化

- 新增两枚角色按钮，产出 ref 为 `@research/search`/`@research/fetch`（恰好 shared 解析器认定的两条；漂移由测试回读钉死）。
- `undeclaredElsewhere`：角色 ref 不再进 "Not connected here"；旧真实 ref（`parallel/web_search` 等）在无 server 提供时**照旧列出**（兼容面不变，`grantsNothing` 声明不等于授权说明原样保留）。
- 求交语义与 R02 一致：角色 ref 只在 selection 时展开到 Bot 实际持有的同角色工具，picker 勾选永不扩大授权。

## 4. i18n

- 词条双语落地（见 §1）；en 回退串与 en locale 同串有测试钉死；zh 断言在渲染层完成（`搜索了网页 2 次并读取了 1 个页面`、`搜索网页`、`读取网页`）。
- 键盘：picker 按钮为原生 `<button type="button">`；折叠与步骤展开沿用 U04 的原生 `<details>/<summary>`（键盘可达），测试沿用 U04 的 summary 点击驱动方式。

## 5. RED / GREEN

| 步骤 | 命令 | 结果（证据文件） |
|---|---|---|
| RED-1 | `bunx e2e run --config e2e.unit.config.ts app/tests/tool-name.test.ts` | **COLLECTION_ERROR**（`RESEARCH_ROLES` named export 缺失，文件级求值失败——ADR 0008 认定的合法 RED 形态）；`red-native.txt` |
| RED-2 | `bun test ./app/tests/tool-activity.test.tsx` | **9 failed / 18 passed**（新增 9 例全红，U04 既有 18 例全绿）；`red-driven.txt` |
| GREEN-1 | 同 RED-1 | **27/27 passed**；`green-native.txt` |
| GREEN-2 | 同 RED-2 | **27/27 passed**（含全部 U04 断言回归）；`green-driven.txt` |

## 6. 回归与统一驱动

| 范围 | 命令 | 结果 |
|---|---|---|
| 直接消费面回归 | `bunx e2e run … skill-form / browser-activity / tool-result / shared/research` | **41/41 passed**（含 `undeclaredElsewhere` 既有语义） |
| `readToolName` 消费组件回归 | `bun test … bot-access-skills / connect-app-card / person-sent-message` | **22/22 passed** |
| transcript 邻接 | `bun test … composer-attachments-ui / composer-queue-attachments / transcript-attachments` | **62/62 passed** |
| 统一驱动 | `E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.e2e/r03-driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | **6 组中 5 组绿**（part 1–4、multitenancy ✓；承载本文件的 part 4 ✓）；唯一红 `app/tests/ai-observability` = **已登记 BASE 既有红**（U03/L03/U04 账本同录），失败文件 `ai-observability-admin-summary.test.tsx` 与本任务 import 图零交集 |
| `billing-credits-ui` 备注 | native 直跑 8/18 红 | **ledger §7 U04-OBS1 已裁定的环境基线红**（BASE worktree 全绿 / 主 checkout 同红 / import 零交集），非本任务引入，未计入 |
| typecheck | `bun run --filter app typecheck` | **exit 0**（`typecheck.txt`） |
| format | `bunx biome format <每个改动文件>` 逐文件 | **10/10 exit 0**（`format-check.txt`） |

## 7. 冲突与偏差（升级项在前）

1. **【冲突·需主控升级】server 技能保存路径拒绝逻辑角色 ref。** `server/src/plugins/store.ts` 的 `knownToolRefs`（:1436 起）按首个 `/` 拆 ref、把 `@research` 当 serverId 查 `mcp_tools`，查无即 `PluginRefusedError` → `POST /skills` 返回 400 "No tool by that name has been seen here: @research/search"。R02 落地了 selection 角色求交但**未**改 `knownToolRefs`，也无任何测试覆盖经 `installSkill` 保存角色 ref。结果是：本任务 picker 可以勾选 `@research/search`，但按下保存会被后端 400 拒绝——up10 criterion 5（"共享工具角色同时用于…技能选择"）的端到端闭环在此断开。server 文件不在 R03 owned_files，未动；需主控派发 server 侧修复（在 `knownToolRefs`/`installSkill` 放行恰好两条角色 ref，负例照拒）并补路由级测试。
2. **偏差：单条研究调用行不本地化（记录，不阻塞）。** 单条 connector 调用按 U04 钉死的语义不折叠、走 `chat-transcript.tsx` 的 `ServerToolLine`（非 owned），其 `readToolName(name)` 无翻译器，zh 下显示英文角色标签 "Search the web"（provider 匿名性不受影响）。相邻多步（研究回合常态：search+fetch 相邻）折叠后全部本地化。上游本身无 i18n，此为本地化覆盖面差异，非行为差异；修复需改非 owned 文件，留给集成轮。
3. **偏差：`bot-profile/access.tsx` 的 Bot 授权页标签同样走英文回退**（同因：非 owned、无翻译参数）。角色标签为 provider 匿名，无泄漏；仅语言回退。
4. **偏差：fetch 步骤 detail 不用上游 "host and N more" 文案。** 上游把多 URL 数量拼进硬编码英文短语；本地改为只显首 URL host（多 URL 全量保留在步骤展开的 inputs 里），避免在 locales 外加硬编码文案（U04 纪律延续）。来源链接只在单 URL 时渲染为 `<a href>`（多 URL 时无单一目标），真实链接保留性质不变。
5. **偏差：`RESEARCH_ROLES` 落在 `app/src/lib/plugins/tool-name.ts` 而非 shared。** 上游从 shared 导出 `RESEARCH_ROLES`/`RESEARCH_ROLE_LABELS`；R01 刻意未导出（其 review F4 交接），批复要求消费侧自理、不改 shared 语义。app 侧拼写 + `researchRoleOf` 回读钉死等价防漂移。
6. **settings.json 未使用**：owned 但无研究消费点，零改动（见 §1）。

## 8. 证据清单（本目录）

`red-native.txt`、`red-driven.txt`、`green-native.txt`、`green-driven.txt`、`driven-app-groups-run.txt`、`typecheck.txt`、`format-check.txt`。
