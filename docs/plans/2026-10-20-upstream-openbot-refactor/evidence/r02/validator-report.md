# R02 Validator Report — backend_validator 验收

- Task: R02（MCP 认证、skill ref 和治理执行，AC A10 后端，Issue #500）
- 工作区: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`
- 日期: 2026-10-20
- 结论: **6/6 PASS，验收通过**。无阻断项；2 条 P3 记录项（报告记账瑕疵，非代码缺陷）+ 2 条 INFO。
- 验证方式：全部关键数字亲跑复现，diff 范围用 before/after 证据 diff 做 content-hash 级机比，未转抄 implementer 报告的任何未验证声明。
- DB：fixture 库 `openbot_r02_test`（127.0.0.1:5435，迁移 166/166 已应用，mcp_servers 0 行 scratch 态）；`TEST_DATABASE_URL` 按次内联换库名，`.env` 未改动（仍指 `openbot_enterprise_test`），凭证未打印。

---

## 1. 认证矩阵 — PASS

| 命令（亲跑） | 结果 |
|---|---|
| `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/parallel-research.test.ts server/tests/web-research.test.ts server/tests/plugin-mcp-authorization.test.ts` | **27 passed / 2 skipped (29)**，Test Files 3 passed —— 与声明逐字一致 |
| `TEST_DATABASE_URL=…openbot_r02_test bun test ./server/tests/plugin-store.integration.test.ts` | **141 pass / 0 fail**（491 expect） |
| 同库 `-t "research providers on the call path"` | **6 pass / 0 fail** |
| brief 指定命令（parallel-research + web-research 两文件） | **16 passed / 2 skipped (18)** |

抽查逐项核对（代码读 + 亲跑断言）：

- **Exa keyed → x-api-key raw**：native `Bun.serve` 裸服务器上断言 `x-api-key: secret`（trim 后原样）、`authorization: null`（plugin-mcp-authorization "is the vendor's own header, as stored"/"sent raw, with no scheme added"）；driven journal 断言请求头名含 `x-api-key`、不含 `authorization`（store integration 用例 1）。`mcp.ts` withClient 二分支与上游 `mcp.ts:348` 同型（computed key + trim，无 scheme）。
- **Firecrawl/Parallel keyed → Authorization Bearer**：catalogue `firecrawl-authenticated`/`parallel-authenticated` 无 `auth.header`（catalogue.ts :236/:288）→ 走默认分支；plugin-catalogue `tokenHeaderFor(firecrawl-authenticated) === "Authorization"` pin 在位（63/63 亲跑通过）；Parallel driven 用例 journal 断言含 `authorization`、不含 `x-api-key`；native 默认分支 wire 断言 `Authorization: Bearer secret` / 自带 scheme 原样（"Bearer by default"/"names its own scheme"）。
- **keyless 无 credential header**：native "no token means no credential header at all"（authorization 与 x-api-key 均 null）——通过。
- **keyed 无 key → 本地拒绝零请求**：`store.ts` connectionTokenFor 非 person-oauth 分支新增守卫（`!token && entry?.auth.kind === "deployment-bearer"` → `PluginRefusedError`，listing 同享该函数）；driven 用例断言 `mock.getRequests().length === 0`——通过。
- **header 名只来自 catalogue**：`tokenHeader` 唯一来源是 `deploymentTokenHeader(entry)` 读 reviewed 可选字段（store.ts :926-941）；`callTool` 输入不携带 header 参数；唯一出网点 store.ts :8428 `injectedVendor ?? transportFor(access.transport).callTool`。caller 不可自定义成立。
- **401 处理**：mcp.ts :294-296 句子含 "401" 与 "credential"（BASE 原路径，R02 未动）；native "a credential the vendor rejects is reported as one" 两断言——通过。
- **日志/审计无 token**：审计 payload 构造 `decided` 仅含 actor/bot/server/tool/effect/reachedAs/decision（store.ts :8187-8213）；driven 用例断言 succeeded payload 的 JSON 不含 fixture key——通过。

## 2. 角色求交 — PASS

- **只 granted 集合内展开**：`selection.ts declaredBy` 精确 ref 求交原样保留；角色展开 `for (const held of granted) if (roleOfHeldRef(held) === role) refs.add(held)`——展开结果 ⊆ granted，结构上不可能引入未授权 connector。测试 "never offers a provider the Bot was not granted"（offered 恰等于唯一 held ref）、"a role never widens into a ref the Bot does not hold, at either spelling"（只持 search 时 fetch 不发明）——均通过。
- **skill 宣告不授予新 connector**：`researchRoleOf`（R01 原函数）null 语义未动（shared/research.test.ts 13/13 亲跑通过）；宣告侧 `typeof ref === "string" ? researchRoleOf(ref) : null` 在调用前挡非字符串。
- **watch item 落点（消费侧护栏）**：`roleOfHeldRef` 在 tools.ts 与 selection.ts 各一份，均为 typeof + `indexOf("/") <= 0` 护栏 + `researchRoleOfTool`（shared 侧 Object.hasOwn 防原型键）；junk 用例（`ref: 42`、`tools: [undefined, …]`）不抛错、不误判角色——通过。fail-open 语义未动：declaredBy 只增不减，narrowing 路径零改动。
- **旧 ref 兼容 pins**：`examples/fintech/skills.yaml` 四条真实 ref（:36-37 等）git diff 为空、parallel-research "ships a Research Desk declaration" 测试逐字 pin 四 ref；web-research "the old real tool refs keep working beside the role refs"——通过。

## 3. 引导语 — PASS

- **vendor 去重 + keyed 优先**：`researchProviders` 按 `entry.vendor` 聚合，keyed（`auth.kind === "deployment-bearer"`）覆盖 free；测试 "a vendor added twice is described once, with its key" 断言 keyed 工具名在、free 工具名不在——通过。
- **search+fetch 齐备才说完整研究**：`held.search && held.fetch` 双缺一不可，且仅认 catalogue entry（自命名的 custom server 不算）；测试遍历六 key，单工具/空 → 无 "public-web research" 段——通过。
- **notes 按 provider 分开**：`RESEARCH_TOOLS[entry.key].notes` 前缀 `<Vendor>:` 单独注入；exa 引导断言不含 `session_id`，parallel 引导含 "Parallel: Generate one session_id" / "Parallel: Omit model_name"——通过。
- **无 fallback 措辞**：六 key 全量断言不含 "fallback"/"switch to"/"another provider"，且含 "do not invent evidence"——通过。
- **不默认启用**：`.env.example` 新注释块明示无 `RESEARCH_*` 变量；`server/src/` 全目录 grep 无 OPENBOT_LIVE_RESEARCH/EXA_API_KEY/FIRECRAWL_API_KEY 读取（仅测试文件）；catalogue 引导仅 grant 存在时出现；skills.yaml/catalogue 均零改动。

## 4. 治理与计费 — PASS

- **撤权**：driven "a revoked research grant refuses, and the vendor is not asked"——`PluginRefusedError` + mock 请求数 0 + `mcp.call_rejected` refusal=`not_granted` 恰 1 行——通过。
- **写工具拒绝（crawl vs search 对照）**：同一 `intent == "write_tool"` deny 策略下 `firecrawl_crawl` 拒（审计 effect=write 恰 1 行）、`firecrawl_search` 过——通过。
- **审计身份**：payload.server=`exa-authenticated`、tool=`web_fetch_exa`、effect=`read`、reachedAs=`deployment`、无 key 泄漏——通过（亲跑）。
- **无 vendor-dialing 新调用点**：全 `server/src/` grep，vendor host 字符串只存在于 catalogue.ts（六条目 host pin）；R02 源文件无 `fetch(`/第二出网路径；引导语 fallback 断言见 §3。不换供应商成立。
- **usageMeter 零触碰**：`git diff -- server/src/copilot.ts` 为空（usageMeter :469/:1817 原样）；R02 改动文件集无任何 metering/billing 文件；provider 调用路径无新增计数写点（driven 审计断言与 BASE 行为一致）。credits 不伪装 token 由构造成立。

## 5. 范围与偏差 — PASS

- **diff 范围机比**（before-tracked.diff vs after-tracked.diff，content-hash 级）：R02 新增进 tracked diff 的源/文档文件恰为 owned 集（mcp/tools/selection/store.ts、parallel-research.test、plugin-mcp-authorization.test、plugin-store.integration.test、.env.example、docs/parallel-research.md）+ 两个新文件（web-research.test.ts、docs/web-research.md，untracked）+ **transport.ts（+11/-0，仅两个 connection 形状的可选字段）**。无超出。
- **偏差①论证成立**：transport.ts 是 store↔mcp seam，store 端对象字面量带 `tokenHeader` 必须在 seam 类型上声明否则不过 TS 超属性检查；+11 全为加性可选字段；上游 mcp.ts:215/:348 同名字段同型消费，仅 MCP transport 读它；文档注释明示加性扩展惯例。接受。
- **U02 connect-prompt hunks 原样**：u02/after-tracked.diff 与 r02/after-tracked.diff 的 store.ts hunk 内容 hash 对比——**5/5 保留、0 丢失**；R02 在 store.ts 的新增内容恰 4 个 hunk（deploymentTokenHeader、无 key 守卫、listing tokenHeader、callTool tokenHeader）。
- **typecheck**：`bun run --filter server typecheck` 恰 3 条 TS2339，全部在 `scripts/bootstrap-local-gateway.ts` :106/:108/:120；该文件 git diff 为空 → BASE 既有红，零新增。
- **format**：`bunx biome format` 9 个代码文件 **exit 0**（Checked 9 files, No fixes applied）。store integration 的 14 行删除逐行核对全为 biome 重排（import 拆行/长行换行），语义零变化。
- **live smoke 证据分离诚实**：2 例 skipped，标题点名缺失变量（"needs EXA_API_KEY"/"needs FIRECRAWL_API_KEY"），双门 `OPENBOT_LIVE_RESEARCH=1` + key（与 composio-live.test.ts 同款 skipIf 模式）；本环境无任何 live 变量（亲验）；测试注释与 docs/web-research.md 均明文 "a skipped live smoke is BLOCKED evidence, never a pass"。**确认不计入验收**，缺口需持 key 联调轮补跑。
- **登记对账**：`node scripts/e2e-coverage-audit.mjs` **exit 0**——1061 files · 568 native · 478 driven · no gaps（亲跑复现）。

## 6. RED 真实性 — PASS

- `red-native.txt`：10 failed / 17 passed / 2 skipped (29)，Test Files 3 failed (3)——总数与三文件 29 用例一致（27 GREEN pass + 2 skip，10+17+2=29 自洽）；10 条失败标题与现行测试名逐一对应（x-api-key wire 2、引导语 5、parallel-research 3）。
- 逐条 BASE 逻辑核验：BASE 无 `tokenHeader`（x-api-key 二例必红）；BASE 引导语为 Parallel 硬编码文案（新断言文本 "For public-web research you can use:"、"- Parallel: …"、"- Firecrawl:"、"Parallel: Generate one session_id" 均不存在 → 8 例必红，含 exa 遍历例的 toContain 失败）。RED 真实。
- `red-store.txt`：2 failed / 4 passed（describe 共 6 例）——BASE 下 x-api-key 不发送（journal 只见 authorization）与无 key 仍发匿名请求（请求数 > 0）两例必红，其余 4 例（Parallel 默认分支/撤权/写工具/审计身份）BASE 已有路径本就成立。RED 真实。
- 时间序：red 23:12 → green 23:18 → after-diff 23:20 → report 23:19，自洽。

## 邻接回归（亲跑加固）

| 套件 | 结果 |
|---|---|
| native：plugin-selection 25 + plugin-catalogue 63 + mcp-listing 5 + mcp-protocol 9 | 102/102 |
| native：plugin-oauth + mcp-result + composio-classify + component-catalogue | 85/85 |
| native：plugin-connect-route + plugin-grants-validation | 42/42 |
| native：shared/research.test.ts（E2E_UNIT_SCOPE=shared） | 13/13 |
| driven（openbot_r02_test）：mcp-grant-removal.integration | 2/2 |
| driven（同库）：plugin-user-credential.integration | 16/16 |

## 问题分级

- **P3-1（记录项）**：`green-native.txt` 实为 6 文件混合捕获（e2e native 摘要 "6 files / 120+2" + bun driven 摘要 "175 pass across 6 files"），与报告 §8 GREEN-1 行声称的 3 文件命令不完全对应，"27 passed / 2 skipped" 只能靠重跑复核（本验收已重跑，数字成立）。证据文件标注瑕疵，非代码缺陷。
- **P3-2（记录项）**：implementer 报告 §8 邻接清单写 "mcp-grant-removal"，实际文件为 `server/tests/mcp-grant-removal.integration.test.ts`（缺 `.integration` 后缀）。拼写瑕疵。
- **INFO-1**：偏差④（超时未重测）诚实记录为 gap：`CALL_TIMEOUT_MS = 60_000`（mcp.ts:22）与 BASE 逐字相同，R02 零改动，失败包装路径由 401 例覆盖。接受该 gap 表述，不作为扣分。
- **INFO-2**：偏差②③（store 侧三态 `deploymentTokenHeader` 与 `tokenHeaderFor` 并存；护栏落消费侧双份）均与 R01 合约/owned 边界一致，注释互指防漂移，行为与上游等价。接受。

## 验收判定

**PASS（6/6）**。Task R02 达到验收标准：认证矩阵 wire 级证据齐备且亲跑复现、角色求交在 granted 集合内结构性封闭、引导语去 Parallel 化且性质保留、治理/审计/计费边界用例在位、diff 范围恰 owned+transport(+11) 且偏差论证成立、RED→GREEN 证据真实。live smoke 2 例 BLOCKED 缺口如实分离，不阻塞本次验收，但持真实 key 的联调轮仍需补跑后 A10 后端才算完整闭环。
