# R02 Implementer Report — MCP 认证、skill ref 和治理执行

- Task: R02 / A10（后端）；正式 Issue #500（up10 criteria 1–6，UI 标签除外）。
- 工作区: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`（未提交树，未 commit/push，未用 git stash，未派发子 Agent）。
- 日期: 2026-10-20。
- 前置消费: R01（`shared/research.ts`、catalogue 六 key、`tokenHeaderFor`）、U02（store 的 connect-prompt 既有改动原样保留）、U04（工具摘要，未触碰）。

## 1. 改动摘要

| 文件 | 改动 |
|---|---|
| `server/src/plugins/mcp.ts` | `Connection` 增加可选 `tokenHeader?: string`（上游同型）；`withClient` 二分支：有名 header 时 token **trim 后原样**放入该 header（不加 scheme），否则维持原 `Authorization: authorizationHeader(token)` 分支（Bearer/自带 scheme 语义逐位不变）。超时/结果封顶/错误包装（`vendorFailure`）未动。 |
| `server/src/plugins/transport.ts` | **偏差 #1**：`listTools`/`callTool` 两个 connection 形状各加同名可选字段 `tokenHeader?: string`（+11 行，含注释）。该文件是 store↔mcp 的 seam，字段不加则 store 的对象字面量过不了 TS 超属性检查；该接口文档注释本身规定"以可选字段加性扩展"。仅 MCP transport 读取它。 |
| `server/src/plugins/store.ts` | ① 新增 `deploymentTokenHeader(entry)`（三态：`deployment-bearer` 且 entry 显式命名 header → 该名；否则 `undefined`）。**有意不直接用 `tokenHeaderFor`**：R01 合约它恒返回具体名（默认 `"Authorization"`），若把默认值塞进 `tokenHeader` 会走"raw 无 scheme"分支、丢掉 Bearer 前缀（见偏差 #2）。② `callTool` 与 `refreshTools` 的 listing 两处 vendor 调用按该三态传 `tokenHeader`。③ `connectionTokenFor` 非 person-oauth 分支：entry 为 `deployment-bearer` 且解不出 token（无 credentialId）→ `PluginRefusedError`，**无 key 不发送请求**（listing 路径同享，句子进 `lastError`）。U02 的 connectAppRefusal 改动原样保留、零冲突。 |
| `server/src/plugins/tools.ts` | 删除 Parallel 专用 researchConnector/引导语（:145-186），换上游对齐的 `researchProviders` + `researchGuidance`：按 held ref 求角色（本地护栏 `roleOfHeldRef`），按 vendor 去重且 keyed 优先，仅当某 server 同时持有 search+fetch 才生成引导；notes 按 provider 单独注入（`RESEARCH_TOOLS[key].notes` → `"<Vendor>: <note>"`）。多 provider 时注入 "Use the one the person asks for."；失败上报、不换供应商的措辞来自上游。 |
| `server/src/plugins/selection.ts` | `declaredBy` 增加角色展开（上游对齐）：skill.tools 中每个 ref 先按精确 ref 求交（原样保留），再经 `researchRoleOf`（R01 原函数，null 语义未绕过）识别 `@research/search|fetch`，命中则**仅在 granted 集合内**收集同角色 held refs。护栏：`typeof ref === "string"` 先行（`researchRoleOf` 对非字符串会抛，消费侧必须挡住——R01 reviewer watch item），held 侧同 `roleOfHeldRef`（typeof + 首个斜杠 + `researchRoleOfTool`）。 |
| `server/tests/web-research.test.ts` | 新建（native，15 用例：2 skipped 为真实 key smoke）：引导语 5 用例、角色选择 6 用例（含旧 real ref 兼容、junk 护栏）、live describe 2+1 门。 |
| `server/tests/plugin-mcp-authorization.test.ts` | 扩展 +6 用例（native）：Bun.serve 假供应商上读 wire header 矩阵（默认 Bearer、自带 scheme、x-api-key raw+无 authorization、x-api-key 也不加 scheme、无 token 无 credential header、401 句子）。 |
| `server/tests/parallel-research.test.ts` | 更新 2 用例 + 新增 1 用例：引导语断言从 "Parallel provides …" 换成 provider 中性文案（保留"完整才算/不偏好"性质），keyed 优先断言保留并加严（不含 free ref 名），新增 Parallel notes（session_id/model_name）单独注入断言。原有 pins（catalogue endpoint、skills.yaml 四真实 ref）原样保留。 |
| `server/tests/plugin-store.integration.test.ts` | 追加 describe "research providers on the call path"（6 用例，driven/DB）：x-api-key 上 wire（aimock journal，header 名为 `[REDACTED]` 但名字可断言）、Parallel Bearer 兼容、无 key 零请求+拒绝、撤权拒绝+审计、Firecrawl 写工具 policy 拒绝（read 对照通过）、审计身份（server/tool/effect/reachedAs=deployment、无 key 泄漏）。同文件 14 行为 biome 重排（import/长行换行，语义零变化）。 |
| `.env.example` | 新增"研究 provider"注释块：catalogue 入口、key 走 vault、**无任何 RESEARCH_* 环境变量、默认不启用**；唯一环境变量是测试门 `OPENBOT_LIVE_RESEARCH` + 真实 key。 |
| `docs/web-research.md` | 新建（上游 40 行文档按本地行为重写：`tokenHeaderFor` 本地合约、角色求交语义、治理/审计、费用边界、无默认启用、新增 provider 步骤）。 |
| `docs/parallel-research.md` | 保留为 Parallel 兼容说明，顶部加指回 `web-research.md` 的引言；正文断言逐条核对仍为真（keyed 优先、Bearer、不自动重试）。 |

## 2. 认证矩阵（wire 证据）

| entry | auth.kind | header 字段 | wire 行为 | 证据 |
|---|---|---|---|---|
| parallel / parallel-authenticated | none / deployment-bearer | 无 | `Authorization: Bearer <token>`（token 自带 `basic|bearer` scheme 时按原样）——**与改动前逐位一致** | plugin-mcp-authorization "Bearer by default"/"names its own scheme"；store integration "Parallel's keyed entry still authenticates with Authorization" |
| exa / exa-authenticated | none / deployment-bearer | `x-api-key` | token **trim 后原样**入 `x-api-key`，**不发送** `Authorization`，不加 scheme | plugin-mcp-authorization 两条 x-api-key wire 用例；store integration journal 断言含 `x-api-key`、不含 `authorization` |
| firecrawl / firecrawl-authenticated | none / deployment-bearer | 无（默认 Authorization） | 同 Parallel 行为（R01 落地值） | plugin-catalogue（R01）`tokenHeaderFor` 矩阵 + 本任务 wire 矩阵的默认分支 |
| 无 token（keyless entry） | — | — | 不发送任何 credential header（原行为） | plugin-mcp-authorization "no token means no credential header" |
| deployment-bearer 且无 credentialId | — | — | **本地拒绝**（`PluginRefusedError`），零网络请求；listing 同享 | store integration "a keyed provider with no key sends nothing at all"（mock 请求数 = 0） |
| 自定义 server（无 entry） | — | — | 原行为不变（entry null → 三态 undefined → Authorization 分支） | connectionTokenFor 分支仅对 `entry?.auth.kind === "deployment-bearer"` 收紧 |

header 名来自 catalogue entry 的 reviewed 可选字段（`auth.header`），caller 无法自定义（`resolveServerUrl`/host pin 由 R01 守住，未动）。

## 3. 角色求交语义

- 宣告侧：`researchRoleOf(ref)`（R01 原函数）只认 `@research/search`、`@research/fetch`；错拼/多斜杠/真实 ref/缺前缀 → null（R01 13 用例继续守护）。**消费侧未绕过 null 语义**：非字符串 ref 在进入 `researchRoleOf` 之前由消费侧 `typeof` 挡下（watch item 的护栏落在消费侧，shared/research.ts 零改动）。
- 持有侧：`roleOfHeldRef` = typeof 护栏 + 首个斜杠拆分 + `researchRoleOfTool(server, tool)`；server 侧用 `Object.hasOwn` 防原型键（R01）。上游 `researchRoleFor` 的"斜杠数护栏"等价重建于两个消费文件（tools.ts / selection.ts 各一份，注释互相指认，因 shared 与 catalogue 均不在本任务 owned_files）。
- 求交点只在 selection：展开结果 ⊆ granted 集合，**skill 宣告角色永远不会引入未授权 connector**；未持有的 provider 一个 ref 都不会出现（web-research "never offers a provider the Bot was not granted"、"never widens into a ref the Bot does not hold"）。
- 兼容：`parallel/web_search`、`parallel/web_fetch` 真实 ref 在 selection 与 guidance 下行为不变（web-research "the old real tool refs keep working"、parallel-research 原 pins、examples/fintech/skills.yaml 四 ref 未动且测试继续 pin）。
- 收窄方向不变：`declaredBy` 只把 refs **加进** declared/wanted，narrowing 的 fail-open 语义（selector 失败 → offer everything）未动。

## 4. 引导语变化对照

| 改动前 | 改动后 |
|---|---|
| 硬编码 `["parallel-authenticated","parallel"]` 查找，文案固定 "Parallel provides public-web search and extraction: …" | 按实际 held refs 解析出 provider（vendor 去重、keyed 优先），每家一行 `- <Vendor>: mcp__<key>__<search> finds sources and mcp__<key>__<fetch> reads selected pages.` |
| session_id/model_name 指令硬编码进 Parallel 段落 | 从 `RESEARCH_TOOLS[key].notes` 按实际 provider 注入，前缀 `<Vendor>:`；Exa/Firecrawl 无 notes 时**不出现**他家参数（测试断言 exa 引导不含 "session_id"） |
| 单 provider 措辞 | 多 provider 时加 "Use the one the person asks for. Otherwise pick one and keep to it for the conversation." |
| 隐私边界句 | 保留原句（public web、不连私人账户、只发 objective/queries/URLs） |
| cite sources / 不伪造证据句 | 保留原句，另加上游新增 "Do not name the provider in your answer unless the person asks which one you used" |
| — | 新增主动搜索指令 + "a search or two" 上限（上游对齐；测试 pin） |
| — | 明确**无任何** "fallback / switch to / another provider" 措辞（测试对六 key 全量断言不出现） |
| 仅当同 server 两工具齐备才说明（原行为） | 保留该性质，且扩到六 key（单工具/connectedButNotHeld/空 → 无研究段） |

不默认启用：无任何自动添加/启用行为，catalogue 四新条目仍只有静态清单（R01），引导语只在 grant 存在时出现。

## 5. 治理用例清单（mock MCP，全部经 `PluginStore.callTool` 单门）

| 用例 | 层 | 结果 |
|---|---|---|
| Exa key 走 `x-api-key`、无 `authorization`（journal header 名断言；值为 `[REDACTED]`，raw 值在 plugin-mcp-authorization 的裸服务器上断言） | driven | pass |
| Parallel keyed 仍 `Authorization`（兼容） | driven | pass |
| 无 key：本地拒绝 + mock 请求数 0 | driven | pass |
| 撤权：`revoke` 后拒绝（not_granted）+ `mcp.call_rejected` + vendor 零请求 | driven | pass |
| 写工具拒绝：`firecrawl_crawl`（readTools 收窄为 write）在 `intent == "write_tool"` deny 规则下拒绝（审计 effect=write），同策略下 `firecrawl_search`（read）通过 | driven | pass |
| 审计身份：`payload.server = "exa-authenticated"`、`tool = "web_fetch_exa"`、`effect = read`、`reachedAs = "deployment"`（keyed provider 以 deployment 凭据运行，从不记成个人）、payload 不含 key 明文 | driven | pass |
| 认证失败报告：401 → `McpServerError` 句子含 "401" 与 "credential"（`vendorFailure` 原路径） | native | pass |
| 超时：**未重测**（见偏差 #4）——`CALL_TIMEOUT_MS = 60_000` 与 BASE/上游逐字相同，本任务零改动；失败包装路径（同一 `withClient`）由 401 用例证明 | — | gap 记录 |
| 不自动换供应商：代码层面 R02 未新增任何 vendor-dialing 调用点（唯一出网点仍是 `transportFor(access.transport).callTool` 那一处 `injectedVendor ?? …`）；引导语无 fallback 措辞（native 用例断言） | native+代码 | pass |
| SSRF：R01 的 host/path pin 负例继续通过（plugin-catalogue 63 用例回归）；call 侧 URL 仍由 `effectiveUrl`→`resolveServerUrl` 从 catalogue 解析，本任务未改 | native | 回归 pass |
| 预算/Payer/组织隔离：R02 未新建旁路——`store.callTool` 之上现有的预算/Payer/tenancy 调用链未动（`server/src/copilot.ts` 的 usage meter/payer 绑定零改动）；grants 的 bot 级撤权由本任务用例覆盖。两公司级插件隔离套件属 enterprise/MT 域，其套件红是记忆中已记录的 BASE 漂移（MT005 门槛 vs 旧假件），非本任务引入，未触碰 | 代码+既有套件 | 见偏差 #5 |

## 6. 计费边界核查

- 模型 token 计量的唯一入口是 `server/src/copilot.ts` 的 `usageMeter`（`ModelUsageReport`，模型响应路径）；R02 五个源文件无一触碰模型调用或计量代码（grep 证据：`git diff --name-only` 无 copilot.ts / billing/ / usage-origin）。
- 研究 MCP 调用（含真实 provider API credits 的消耗）不产生任何 token 账单行：调用结果只作为工具文本进上下文，计量仍按模型实际用量走原 outbox；"外部 credits 不伪装 token"由构造成立（无新计量点）。
- 不重复计量：R02 未在 provider 调用路径上新增任何计数/计费写点；store integration 的审计断言（call_succeeded/call_rejected）与 BASE 行为一致，审计不承担计量。
- 已有收费规则照常：policy/dry-run/审批/audit 全部原 seam（回归见 §8）。

## 7. mock 与真实 key 证据分离

- **mock 合约证据**（本任务全部验收依据）：§2/§5 全部条目，运行于本地 Bun.serve / `@copilotkit/aimock` MCP mock / 专用 fixture 库 `openbot_r02_test`（`127.0.0.1:5435`，自建并跑完迁移；未动共享 `openbot_enterprise_test`，`.env` 未改，`TEST_DATABASE_URL` 按命令行内联传入）。
- **真实联调证据**：`server/tests/web-research.test.ts` 的 describe "a real research provider, for real"，双门 `OPENBOT_LIVE_RESEARCH=1` + `EXA_API_KEY`/`FIRECRAWL_API_KEY`（与 `composio-live.test.ts` 同款 `skipIf` 模式），断言真实端点（`https://mcp.exa.ai/mcp` 带 `x-api-key`；`https://mcp.firecrawl.dev/v2/mcp` 带 Bearer）返回的 listing 含 pin 的 search/fetch 工具名。**本环境无真实 key：2 例 skipped（标题点名缺的变量）→ 按验收纪律记 BLOCKED，不算通过、不算验收证据。** 缺口需持 key 的联调轮补跑。
- fixture key 全部为明显虚构值（`exa-test-key-0000…`），无真实凭据进入代码/报告/审计。

## 8. RED / GREEN / 验证

| 步骤 | 命令 | 结果 |
|---|---|---|
| RED-1 | `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts <parallel-research,web-research,plugin-mcp-authorization>` | **10 failed / 17 passed / 2 skipped**（引导语 8 + x-api-key wire 2；证据 `evidence/r02/red-native.txt`） |
| RED-2 | `TEST_DATABASE_URL=…openbot_r02_test bun test ./server/tests/plugin-store.integration.test.ts -t "research providers on the call path"` | **2 failed / 4 passed**（x-api-key 未发送、无 key 仍发请求；证据 `red-store.txt`） |
| GREEN-1 | 同 RED-1 | **27 passed / 2 skipped**（2 skip = live smoke 门） |
| GREEN-2 | 同 RED-2 | **6 passed / 0 failed** |
| 全文件回归 | `bun test ./server/tests/plugin-store.integration.test.ts`（同库） | **141 passed / 0 fail** |
| 邻接套件 | native：plugin-selection、plugin-catalogue、mcp-listing、shared/research、mcp-protocol、mcp-result、plugin-oauth、composio-classify、openconnector-access、google-drive-rest、component-catalogue(+entries)、responsibility-trigger-tools、plugin-servers-validation、plugin-connect-route、plugin-grants-validation、plugin-share-target、plugin-routes、approvals*、builtin-routines、composio-transport、component-grants-skills-validation、agent-callback-token、oauth-refresh-redirect、openmuse-personal-tools、proactive、memory.test | 全绿（唯一红：copilot.test.ts "configures an OpenAI built-in agent"，见下） |
| 邻接套件 | driven（同一 fixture 库）：mcp-grant-removal、plugin-user-credential、plugin-curated-credential、plugin-credential-binding、plugin-credential-rotation、account-mode、approvals-policy、composio-connection-kinds、composio-connections、memory-defaults/sensitivity/store、credential-rotation-leak、demonstrations-store、plugin-logos | 全绿 |
| brief 指定命令 | `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/parallel-research.test.ts server/tests/web-research.test.ts` | **16 passed / 2 skipped** |
| 登记对账 | `node scripts/e2e-coverage-audit.mjs` | **exit 0**：1061 files · 568 native（+1 = web-research.test.ts）· 478 driven · no gaps；driven 清单零改动 |
| typecheck | `bun run --filter server typecheck` | 仅 3 条 `scripts/bootstrap-local-gateway.ts` TS2339（:106/:108/:120）——BASE 既有红，该文件未触碰，不计入 |
| format | `bunx biome format <9 个代码文件>` | **exit 0**；`bunx biome lint` 同集 0 findings |
| copilot.test.ts 红 | — | "configures an OpenAI built-in agent" 期望 `model: "openai/gpt-5.6-terra"`、实际收到 Mastra 模型对象。`server/src/copilot.ts` 与该测试文件均**不在本工作树 diff 内**（`git status` 为空），函数不 import 任何 R02 文件 → BASE 既有漂移，非本任务引入，未修（不在 owned_files） |

## 9. 偏差与冲突记录

1. **`server/src/plugins/transport.ts` 被改动（不在 owned_files）**：+11 行，仅两个 connection 形状的可选字段 `tokenHeader?: string`。理由：header 必须穿过 store→transport→mcp 的 seam 才能到 wire（Spec §7 "header、URL 由服务配置约束，不信任 caller 自定义"—— reviewed 名只能来自 catalogue，经由 store 传递）；该接口文档注释明文允许"加性可选字段"扩展（accountHandle 先例）；不加则 store 端对象字面量类型不过。上游参考在同一位置有同名字段。其余 owned 边界（app/UI/locales/shared/skills.yaml）零改动。
2. **`tokenHeaderFor` 与 `deploymentTokenHeader` 并存**：brief 前置描述消费 `tokenHeaderFor`，但 R01 合约的恒名返回（默认 `"Authorization"`）与 transport 需要的三态（默认分支需走 `authorizationHeader` 的 Bearer/scheme 逻辑）不匹配——直接透传会让 Firecrawl/Parallel 的 keyed entry 丢掉 Bearer 前缀，违反"旧 Parallel 保持原认证行为"。故 store 侧新增私有三态读取（读 entry 的 reviewed 可选字段），`tokenHeaderFor` 保持 R01 合约与其测试不动。行为与上游（`tokenHeaderFor: string | undefined` + `?? "Authorization"`）等价。
3. **护栏落在消费侧而非 shared**：watch item 指明上游 `researchRoleFor` 的 typeof/斜杠护栏未移植进 shared/research.ts 且"消费侧不得绕过"。因 shared/research.ts 与 catalogue.ts 均不在 owned_files，护栏以 6 行本地 helper 重建于 tools.ts 与 selection.ts（注释互相指认防止漂移）；声明侧在调用 `researchRoleOf` 前先做 typeof（实测该函数对非字符串会抛，junk 用例抓住过）。
4. **超时未重测**：60s 固定超时的真实超时用例需 ≥60s/例，且超时常量与 BASE/上游逐字相同、本任务零改动。以"同一失败包装路径由 401 用例证明 + 常量未变"记录为 gap，而非宣称已验证。
5. **两公司/Payer 级插件用例未新增**：R02 未新增任何可绕过现有预算/Payer/tenancy 的调用点（唯一出网点不变），grants 级撤权已覆盖；两公司插件隔离属 enterprise/MT 套件，其 BASE 红（MT005 vs 旧假件，见项目记忆）不是本任务可修的 owned 面。此项留给 V01 的企业回归，本报告如实记为依赖既有 seam、无新增旁路。
6. **brief 与实际代码无冲突**：Spec §7 五条、up10 criteria 1–6 与 I4 合约、上游行为参考一致；未发现需升级的冲突。
7. **未做**（按禁止项）：不默认启用任何 provider（catalogue/行为/文档三处一致）；不为失败换供应商；未知高风险工具未降 read（R01 fail-closed 未动，消费侧未绕过）；未改 UI 文件；未改 shared/research.ts；未动 `docs/verification/e2e-bun-suites.json`（本任务无新 driven 文件）。

## 10. Diff 范围自查

`git status` 中本任务新增/修改：`server/src/plugins/{mcp,tools,selection,transport}.ts`、`server/src/plugins/store.ts`（其中 U02 的 connect-prompt hunks 为前置遗留、原样保留）、`server/tests/{parallel-research,plugin-mcp-authorization,plugin-store.integration}.test.ts`、新 `server/tests/web-research.test.ts`、`.env.example`、新 `docs/web-research.md`、`docs/parallel-research.md`、`evidence/r02/*`。`server/src/plugins/catalogue.ts` 的 diff 全部为 R01 遗留、本任务零触碰。工作树其余未提交改动属 U/L/S 系列前置任务，未触碰；未删除任何 untracked 文件。

---

# R02-F1（fix brief：技能保存路径放行逻辑研究角色 ref）

## F1. 裁决落实

按主控裁决实现：合法逻辑角色 ref（`researchRoleOf(ref) !== null`，恰 `@research/search`/`@research/fetch`）在保存校验中视为 known，不查 `mcp_tools`、不要求 server 行；授权仍在选择时与实际 granted refs 求交（R02 已落地），本修复不授予任何新权限。错拼/多斜杠/缺 `@` 仍按未知拒绝。

## F2. Diff 摘要（本任务净增量，均在 owned_files）

- `server/src/plugins/store.ts`（净 +2 处）：
  1. `import { researchRoleOf } from "../../../shared/research";`（复用 shared，消费侧同 R02 selection.ts 模式；放置位符合 biome organizeImports 对 shared 组的排序）。
  2. `installSkill` 保存校验处（~:5055）：`const unknown = declared.filter((ref) => !known.has(ref) && researchRoleOf(ref) === null);` + 说明注释。`knownToolRefs` 函数本体与对真实 `serverId/toolName` ref 的 DB 校验语义零改动；connect-prompt/callTool/其他路径零触碰。
- `server/tests/plugin-store.integration.test.ts`（扩展）：
  1. import 块补 `skills, skillTools`（同块字母序内插入）。
  2. 文件尾新增 `describe("research role refs on the skill save path")`，6 用例，自带 suite 唯一 fixture server/tool 行与 capture-and-restore 清理（afterAll 后库内 `skill_role_%`/`skillref_%` 残留经查询验证为 0）。

store.ts 与测试文件的其余 uncommitted diff 均为 R01/R02/U02 等前置任务遗留，原样保留、未触碰；未删除任何 untracked 文件；无 commit/stash。

## F3. RED / GREEN 证据

| 步骤 | 命令 | 结果 |
|---|---|---|
| RED | `TEST_DATABASE_URL=…openbot_r02_test bun test ./server/tests/plugin-store.integration.test.ts -t "research role refs on the skill save path"` | **3 failed / 3 passed**：角色 ref 声明保存抛 `PluginRefusedError: No tool by that name has been seen here: @research/search, @research/fetch`（store.ts:5057，即 `POST /skills` 400 的直接来源，routes.ts:2782 原样映射）；混合声明同拒；且错误信息把 `@research/search` 误报为缺失项。3 个负例（`@research/searh`/`@research/`/`research/search`）当时即按预期拒绝 |
| GREEN | 同 RED | **6 pass / 0 fail**（13 expect） |

用例清单：① 仅角色 ref 保存成功且 `skill_tools` 逐字持久化 + skills 行存在；② 角色 ref 与真实 `serverId/tool` ref 混合声明双持久化；③ 真实未知 ref 仍拒、错误只点名未知 ref 不点名角色 ref、零持久化；④⑤⑥ 负例（错拼/空角色/缺 `@`）仍 `PluginRefusedError` 且零持久化。

## F4. 回归与验证

| 项 | 命令 | 结果 |
|---|---|---|
| 全文件回归 | `bun test ./server/tests/plugin-store.integration.test.ts`（复用 `openbot_r02_test`，127.0.0.1:5435；`.env` 未改，`TEST_DATABASE_URL` 命令行内联） | **147 pass / 0 fail**（141 既有含 R02 "research providers on the call path" 全绿 + 6 新增） |
| selection 求交回归 | `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/plugin-selection.test.ts`（该文件走 e2e-compat，`bun test` 直接跑会因 `node:module registerHooks` 在 Bun 下不可用而 COLLECTION_ERROR，属分层既定） | **25 passed / 0 fail** |
| typecheck | `bun run --filter server typecheck` | 仅 3 条 `scripts/bootstrap-local-gateway.ts` TS2339（:106/:108/:120）——BASE 既有红，该文件未触碰，不计入；store.ts/测试文件 0 错 |
| format | `bunx biome format server/src/plugins/store.ts server/tests/plugin-store.integration.test.ts` | **exit 0**（真实退出码，首轮曾报 1 处换行并已按 formatter 产出修正后复验） |

## F5. 偏差与记录

1. **`bunx biome check`（含 organizeImports assist）在这两文件是既有红**：两文件的 import 块乱序（测试文件头部 node: 导入顺序、store.ts:86 `connectAppRefusal` 位置）是 R02/U02 前置 uncommitted 改动带入的既有状态，非本任务引入；brief 只要求 `biome format` exit 0（已达成）。为不搅动并行任务的 hunks，未代为重排整块 import；本任务新增的两处 import 自身在各自邻域内符合排序。
2. **测试落在 store 层而非 route 层**：护栏本体在 `installSkill`，`PluginRefusedError`→400 映射在 `plugins/routes.ts` 既有且不在本任务改动面；store 层断言同一 seam，brief 允许（"扩展）或新建 route 级测试文件（如更合适）"），无需登记对账（未新建文件）。
3. **DB 复用而非新建**：按 brief 选项复用 `openbot_r02_test`（表齐全已验证），未新建 `openbot_r02f1_test`；fixture 全部 suite 唯一 id，清理后残留 0，不污染后续任务。
4. **brief 与代码无冲突**，无需升级。
