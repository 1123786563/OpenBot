# R03 Validator Report — frontend_validator 验收

- Task: R03（研究工具标签与 skill 选择 UI，AC A10 前端半部，Issue #500 / up10 criteria 5、6）
- 工作区: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`（未提交树）
- 日期: 2026-10-20
- 结论: **5/5 PASS，验收通过**。无阻断项；1 条 P3 记录项（报告命令行标注瑕疵，数字可复现）+ 2 条 INFO。
- 验证方式：验收清单 5 项全部亲跑或亲读源码核对，未转抄 implementer 报告的任何未验证声明。端到端保存路径按批复引用 R02-F1 证据（未自跑 DB）。

---

## 1. 行为（RED→GREEN 双层亲跑） — PASS

| 命令（亲跑） | 层 | 结果 |
|---|---|---|
| `E2E_UNIT_SCOPE=app bunx e2e run --config e2e.unit.config.ts app/tests/tool-name.test.ts` | native | **27 passed / 27**，Test Files 1 passed |
| `bun test ./app/tests/tool-activity.test.tsx` | driven（Bun） | **27 pass / 0 fail**（136 expect） |

抽查逐项核对（读源码 + 断言亲跑通过）：

- **六 key search/fetch 标签矩阵**：测试遍历 `Object.keys(RESEARCH_TOOLS)`（shared/research.ts 六 key：parallel、parallel-authenticated、exa、exa-authenticated、firecrawl、firecrawl-authenticated），search 断言 `{label:"Search the web", labelKey:"tools.researchSearch"}`、fetch 断言 `{label:"Read web pages", labelKey:"tools.researchFetch"}`；`detail` 逐 key 断言 undefined（provider 匿名，tool-name.ts:86-91 命中即丢弃 detail）。zh 走 `labelKey` 渲染管线：locale 双语词条在位（zh `搜索网页`/`读取网页`），渲染层 zh 用例断言 `搜索网页`/`读取网页` 出现在折叠行内——通过。
- **未知工具原名不误标**：`mcp__exa__web_search_advanced_exa` → `{label:"Web search advanced exa"}`（connector kind、labelKey undefined）；`mcp__exa__deep_research` → `{label:"Deep research", detail:"exa"}`；`mcp__notes__search_notes` 原样。权限分类仍在 server（`classifyTool` 不在 R03 diff 面），"不误标成功/只读"由构造成立。
- **StepKind search/fetch detail**：search detail=首个非空 query 字段（`query/objective/search_queries/queries`，tool-activity.tsx:244-257），用例钉 `detail === "openbot upstream"`；fetch detail=首 URL host（`hostOf` 剥 `www.`），单 http(s) URL 时 `href` 为真实链接（用例钉 `href === "https://example.com/page"`、`detail === "example.com"`）；多 URL 时无 href（无单一目标）。
- **pages 只计 completed**：tool-activity.tsx:281-284——`!pending && !failed && !refused ? Math.max(urls.length,1) : 0`；用例矩阵钉 pending=0、failed(2 URL)=0、refused=0、completed(2 URL)=2。上游 `Math.max(urls.length,1)` 无条件计数的缺陷确已修正。
- **summarise searches/fetchedPages**：3 search + 5 completed fetch + 1 failed fetch → `searches=3, fetchedPages=5, browsed=0`；全败组 → `0/0`（issues 计数照旧）。`browsed` 收窄为仅 browser 步骤（fetch 页数不串入"浏览了"）。
- **摘要短语中英文**：en `Searched the web 3 times and read 5 pages`（searchedTimes_one/_other、readPages_one/_other 复数在位）；zh `搜索了网页 2 次并读取了 1 个页面`；短语次序 searched → read → browsed → connectors（tool-activity.tsx:470-489）。失败组摘要不出现计数短语、回落到首步骤标签，provider 原因与来源链接保留（`a[href="https://example.com/source"]` 断言在位）。

## 2. skill 选择 — PASS

- **SkillTools 角色组两按钮**（skill-tools.tsx:151-171）：`RESEARCH_ROLES.map` 渲染恰两枚 `@research/search`/`@research/fetch` 原生 `<button type="button">`（键盘可达），label 走 skills locale，`title` 带 ref 语义，`variant` 跟随 `held`；gating 只看 `plugins.data`（角色不依赖任何已连 server，与上游同型）；既有三段结构（server 工具 / elsewhere / `grantsNothing` "声明不等于授权"）零改动。
- **`undeclaredElsewhere` 豁免合法角色**（form.ts:87）：`!known.has(ref) && researchRoleOf(ref) === null`——恰 shared 解析器的两个答案豁免，四个用例亲跑通过：纯角色 ref 豁免、旧真实 ref（`parallel/web_search` 无 server 提供时照列）、真实 ref 与角色 ref 共存、错拼 `@research/serch` 仍列（fail-closed）。
- **角色 ref↔shared 解析器防漂移**：`RESEARCH_ROLES` 每条 ref 回读 `researchRoleOf` 断言等于自身 role，且钉死序列 `["@research/search","@research/fetch"]`；真实 ref `researchRoleOf("parallel/web_search") === null` 钉在位。
- **端到端（引用 R02-F1，未自跑 DB）**：picker 勾选产出 `@research/search|fetch` → `POST /skills` → `installSkill`（server/src/plugins/store.ts:5055-5075）`const unknown = declared.filter((ref) => !known.has(ref) && researchRoleOf(ref) === null)` 放行角色 ref、负例照拒（本工作区亲读源码确认在位）；R02-F1 证据：`evidence/r02/implementer-report.md` §F3/F4——RED 3 failed/3 passed（保存 400 `No tool by that name has been seen here: @research/search`）→ GREEN 6/6，全文件回归 **147 pass / 0 fail**（141 既有 + 6 新增，`openbot_r02_test` 库）；selection 求交 25/25。R03 实现者报告 §7-1 升级的冲突已被主控派发 R02-F1 修复，闭环成立。

## 3. 偏差评估 — PASS（记录项均属实、边界正确）

- **偏差①②（zh 下单行英文回退）核实**：`chat-transcript.tsx:1390` `ServerToolLine` 与 `bot-profile/access.tsx:53` 均以 `readToolName(...).label` 直用、不消费 `labelKey`——单条研究调用行与 Bot 授权页在 zh 下显示英文角色标签。两文件均不在 R03 owned_files，实现者如实记录为偏差并留集成轮，处置正确。provider 匿名性不受影响。
- **fetch 多 URL 只显首 host**：tool-activity.tsx:266-274——`detail: hostOf(first)`，`href` 仅单 URL 时渲染；多 URL 全量保留在步骤展开的 `inputs`。不用上游 "host and N more" 硬编码文案，避免在 locales 外加英文短语——偏差记录与代码一致。
- **settings.json 零改动**：`git status -- app/src/locales/{en,zh-CN}/settings.json` 输出为空，且两文件 0 个 research 键——owned 但无消费面，未改正确（亲验）。
- **`RESEARCH_ROLES` 落 app 侧而非 shared**：R01 刻意不导出 prefix 常量（r02 validator §INFO-2 同裁定），app 侧拼写 + `researchRoleOf` 回读钉死等价防漂移。接受。

## 4. 范围与回归 — PASS

- **diff 范围机比**（r03/before-tracked.diff vs after-tracked.diff，逐文件 content-hash）：tracked 增量恰 **8 文件**——`tool-name.ts`、`skill-tools.tsx`、`form.ts`、`{en,zh-CN}/channels.json`（channels 两条为已有 hunk 上追加；en +6 键、zh +4 键，亲比 hunks）、`{en,zh-CN}/skills.json`、`tool-name.test.ts`——全部在 owned 集。untracked 增量恰 **2 文件**——`tool-activity.tsx` 与 `tool-activity.test.tsx`（mtime 23:41，R03 窗口内；brief owned 的扩展对象）。邻接文件 mtime 核验：`shared/research.ts`(22:49)、`chat-transcript.tsx`(20:13)、`bot-profile/access.tsx`(14:57)、`browser-activity.tsx`(20:09) 均在 R03 窗口（23:30–23:46）之外，零触碰。`e2e-bun-suites.json` 在增量外（未改，符合"如需登记"——无新文件无需登记）。无超出。
- **typecheck**：`bun run --filter app typecheck` → **exit 0**（亲跑）。
- **回归（三组全跑，超出"任二"要求）**：
  - 直接消费面：`E2E_UNIT_SCOPE=app … skill-form + browser-activity + tool-result` **28/28** + `E2E_UNIT_SCOPE=shared … shared/research` **13/13** = **41/41**（与报告数一致）
  - `readToolName` 消费组件：`bun test bot-access-skills + connect-app-card + person-sent-message` → **22/22**（54 expect）
  - transcript 邻接：`bun test composer-attachments-ui + composer-queue-attachments + transcript-attachments` → **62/62**（288 expect）
- **format**：`bunx biome format` 恰 10 个 R03 改动文件 → **Checked 10 files, No fixes applied, exit 0**（亲跑）。
- **统一驱动（证据复核）**：`driven-app-groups-run.txt` 6 组中 5 组绿（part 1–4、multitenancy），唯一红 `app/tests/ai-observability`（`ai-observability-admin-summary.test.tsx` solo 仍红）——与 l03、u04 两份 validator report 登记的同一 BASE 基线红一致，且该文件 git status 干净、与 R03 import 图零交集。billing-credits-ui 环境基线红由 U04-OBS1 裁定在先。均不计入。

## 5. RED 真实性 — PASS

- **RED-1（native）**：`red-native.txt` = **COLLECTION_ERROR**：`The requested module '../src/lib/plugins/tool-name' does not provide an export named 'RESEARCH_ROLES'`（tool-name.test.ts:7）——BASE 无该 named export，文件级求值失败，ADR 0008 明文认定的合法 RED 形态（"e2e 的收集按文件容错性差：一个文件求值失败即报 COLLECTION_ERROR"）。逻辑成立：GREEN 的第一件事就是新增该 export。
- **RED-2（driven）**：`red-driven.txt` = **18 pass / 9 fail**——9 条失败恰为新增 9 例，失败签名与 BASE 逐条逻辑对应：`step.kind` Expected "search"/"fetch" Received "connector"（BASE 无 `researchRoleOfTool` 分类）、`pages` Expected 2 Received 0（BASE 无 fetch pages 语义）、zh 摘要 `搜索了网页…` 缺失（BASE 无词条）、`web_search_advanced_exa` 断言 connector/无 labelKey 必红（BASE 全部步骤皆 connector）。U04 既有 18 例全绿，与"扩展不重写"一致。
- **时间序**：red 23:37:11/12 → green 23:40:14/16 → driven-groups 23:43 → typecheck/format 23:45 → after-diff 23:46:53 → report 23:46。RED 在 GREEN 前、GREEN 在 after-diff 前，自洽。

---

## 问题分级

- **P3-1（记录项）**：implementer 报告 §6"直接消费面回归 41/41"的命令行写作单条 `bunx e2e run … skill-form / browser-activity / tool-result / shared/research`，未注明 `shared/research.test.ts` 需 `E2E_UNIT_SCOPE=shared` 单独一次调用（本验收首轮按单 scope 跑只得 3 文件 28/28，分两次跑才复现 28+13=41）。数字本身正确且已复现，属证据文件命令标注瑕疵，非代码缺陷。
- **INFO-1**：偏差①②（zh 英文回退，`chat-transcript.tsx` / `bot-profile/access.tsx`）与偏差③（settings.json 未用）均与 owned 边界一致、记录诚实；zh 覆盖面缺口应进集成轮待办（两处消费点补 `labelKey` 翻译参数即可）。
- **INFO-2**：R03 实现者 §7-1 升级的 store.ts 保存 400 冲突，已由主控派发 R02-F1 修复（本报告 §2 引用其 147/147 证据），picker→保存→selection 求交端到端在当前树内闭环。

## 验收判定

**PASS（5/5）**。Task R03 达到验收标准：双层行为断言亲跑 27/27 + 27/27 全绿且抽查逐项属实（匿名化、计数真实性、双语摘要）、skill 选择对合法角色豁免且对错拼 fail-closed、端到端保存路径由 R02-F1 修复闭环、diff 恰 owned + 2 个 owned 扩展文件、回归 41/41 + 22/22 + 62/62 + typecheck exit 0 + format 10/10 全部亲跑复现、RED→GREEN 证据真实且时间序自洽。
