# R02 Independent Review — MCP 认证、skill ref 和治理执行（A10 后端，#500）

- Reviewer: 独立 reviewer（Task R02，最终质量关口；OCR 已取消）。
- 日期: 2026-10-20。结论先行：**Spec compliance: pass / Code quality: pass**。
- 审查方式：只读源码与证据 + 亲跑复核；未改任何业务/测试/文档源文件（本文件为唯一写入）。
- R02 增量隔离：`diff r01/after-tracked.diff r02/after-tracked.diff` 机比（R01 为紧邻前置，ledger 已 verified），加 untracked 新文件直读。增量恰为：`server/src/plugins/{mcp,selection,store,tools,transport}.ts`、`server/tests/{parallel-research,plugin-mcp-authorization,plugin-store.integration,web-research}.test.ts`、`.env.example`、`docs/{web-research,parallel-research}.md`——与 implementer §10 自查一致，无超出（catalogue.ts/copilot.ts/shared 均零触碰）。

## 1. 亲跑复核（全部复现）

| 命令 | 结果 |
|---|---|
| `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts {parallel-research,web-research,plugin-mcp-authorization}` | **27 passed / 2 skipped (29)**，web-research 13 例（2 skip=live 门）——与 validator 逐字一致 |
| `TEST_DATABASE_URL=…openbot_r02_test bun test ./server/tests/plugin-store.integration.test.ts` | **141 pass / 0 fail**（491 expect） |
| 同库 `-t "research providers on the call path"` | **6 pass / 0 fail** |
| `E2E_UNIT_SCOPE=server … plugin-catalogue + plugin-selection` | **88/88**（R01 catalogue 63 未回退） |
| `E2E_UNIT_SCOPE=shared … shared/research.test.ts` | **13/13**（R01 合约未动） |
| `node scripts/e2e-coverage-audit.mjs` | **exit 0**：1061 files · 568 native · 478 driven · no gaps |
| `bun run --filter server typecheck` | 恰 3 条 TS2339，全在 `scripts/bootstrap-local-gateway.ts:106/108/120`——ledger 已登记 BASE 红，R02 未触碰该文件，零新增 |

## 2. Spec §7 逐条

1. **逻辑角色求交 + 旧 ref 兼容 — pass**。`selection.ts declaredBy`：精确 ref 求交原样保留；`@research/*` 经 `researchRoleOf`（R01 原函数，null 语义未绕过，shared 13/13）识别后仅在 `granted` 集合内收集同角色 held refs——展开结果 ⊆ granted 是结构性封闭（`for (const held of granted)`），skill 宣告不可能引入未授权 connector。上游 `declaredBy`（selection.ts:196-213）行为同型且本地更严（上游宣告侧无 typeof 护栏，本地有）。兼容：`parallel/web_search|fetch` 真实 ref 测试钉住（web-research "the old real tool refs keep working"、parallel-research 原 pins + skills.yaml 四 ref 未动）。
2. **固定 reviewed host/path/header，不信任 caller — pass**。`callTool` 输入类型（store.ts:8037-8048）无 url/header 参数；URL 走 `effectiveUrl(row, entry)`（R01 pin，未动）；header 唯一来源 `deploymentTokenHeader(entry)`（store.ts:934）读 entry 的 reviewed 可选字段。wire 级证据（Bun.serve 裸服务器断言 `x-api-key`/`authorization` 的值与缺席）+ driven journal（header 名断言）双层覆盖。
3. **只读是分类不降级 — pass（消费侧）**。catalogue.ts 零触碰（R01 fail-closed 保留，plugin-catalogue 63/63 回归）；消费侧新钉 `firecrawl_crawl` 在 `intent == "write_tool"` deny 下拒绝、同策略 `firecrawl_search` 通过、审计 effect=write 恰 1 行——"write 分类不被 provider 名洗白"在调用门得到执行证据。
4. **复用原路径、分别报告、不自动换供应商 — pass（超时为已披露 gap，见 F5）**。缺 key：本地 `PluginRefusedError` + mock 请求数 0（store.ts:1895 守卫，listing 经 `connectionTokenFor` 同享）；认证拒绝：401 → `McpServerError` 句子含 "401"+"credential"（native）；撤权：not_granted 拒绝 + `mcp.call_rejected` 恰 1 行 + vendor 零请求（driven）；政策拒绝：write_tool deny（driven）。四类结果路径互异、各有独立证据。不换供应商：唯一出网点仍为 store.ts:8428 `injectedVendor ?? transportFor(access.transport).callTool`（grep 全 `server/src/` 无新增 vendor host/`fetch(` 调用点）；引导语六 key 全量断言无 "fallback/switch to/another provider"。预算/Payer/tenancy：R02 增量无 copilot.ts/billing 文件，无新计量点，MCP/egress/凭据/审计全走原 seam（审计 `decided` shape store.ts:8187-8205，含 server/tool/effect/reachedAs，无 token 字段；driven 断言 payload 无 fixture key）。
5. **credits 与 token 计费边界 — pass**。模型计量唯一入口 `copilot.ts usageMeter` 不在增量内（`git diff` 机比确认）；provider 调用路径零新增计数/计费写点；外部 credits 不伪装 token 由构造成立（无新计量点可伪装）。
6. **不默认启用；来源/页数 — pass（后端范围）**。`server/src/`+`shared/` 无 `OPENBOT_LIVE_RESEARCH`/`EXA_API_KEY`/`FIRECRAWL_API_KEY` 读取（仅测试文件）；`.env.example` 明示无 `RESEARCH_*` 变量、默认不启用；引导语仅 grant 存在时出现；catalogue 引导保持静态清单。来源 URL/摘要页数为 R03 UI 面，后端对 vendor 文本原样透传，无相悖改动。

**up10 criteria 1–8（后端范围）**：全部满足。criterion 5 的"对话摘要"与 criterion 6 的 UI 呈现属 R03，后端无阻塞项。criterion 8：mock 证据（Bun.serve/aimock/专用库 `openbot_r02_test`）与真实联调证据严格分离——live describe 双门 `skipIf`（`OPENBOT_LIVE_RESEARCH=1` + key），标题点名缺失变量，测试注释与 web-research.md 明文 "a skipped live smoke is BLOCKED evidence, never a pass"，本环境 2 例 skip 未计入任何验收数字。**BLOCKED 隔离严格，确认不算验收。**

## 3. Code quality

- **偏差②（`deploymentTokenHeader` 三态 vs `tokenHeaderFor` 并存）— 合理，接受**。`tokenHeaderFor`（catalogue.ts:476）恒返回具体名（默认 `"Authorization"`），无法区分"显式命名"与"默认"；而 transport 两分支对 token 形状不同（raw trim vs `authorizationHeader` 的 Bearer/scheme 逻辑）。直接透传默认名会走 raw 分支、丢 Bearer 前缀，违反"旧 Parallel 认证逐位不变"；`tokenHeader === "Authorization"` 式判断则对"未来 entry 显式命名 Authorization"脆弱。三态是把真实的语义缺口放在 seam 上而非掩盖它，注释（store.ts:923-933）把理由写透；行为与上游（`tokenHeader?: string` + 上游侧 `?? "Authorization"`）等价。`tokenHeaderFor` 及其 R01 测试原样保留，无合约破坏。
- **偏差①（transport.ts +11）— 最小，接受**。两个 connection 形状各加同名可选字段加注释；store 端对象字面量不过 TS 超属性检查是硬约束；仅 MCP transport 读取；接口注释明示加性扩展惯例（accountHandle 先例）。上游 mcp.ts:215/:348 同名字段同型消费。
- **`researchGuidance` 生成 — 复杂度得当、可测**。`researchProviders`/`researchGuidance` 两个纯函数、无网络、与上游 tools.ts:148-246 逐行行为一致（本地差异：`roleOfHeldRef` 本地护栏替代上游 `researchRoleFor`，等价重建）；vendor 去重 keyed 优先逻辑 3 行、被专测钉住；notes 按条目 key 注入且测试断言 exa 不含 `session_id`。11 个 native 用例全部无 I/O。
- **偏差③（护栏落消费侧）— 健壮，接受**。`roleOfHeldRef` 的 typeof/slash 护栏对"数据库实际持有的任意字节"防御（junk 用例：`ref: 42`、`tools: [undefined]` 不抛不误判）；narrowing 路径不可抛的约束（抛=selection fail-open 放行一切）有注释与测试双重固化。代价见 F4。
- **文档 — pass**。web-research.md 44 行各项声明与代码逐条对上（tri-state、x-api-key raw、角色求交、费用边界、加 provider 步骤、无默认启用）；parallel-research.md 顶部指回 web-research.md 且正文断言（keyed 优先、Bearer、不自动重试）复核仍真。

## 4. 交叉核对两份报告（P3-1/P3-2 抽验 + 新发现）

- **P3-1（green-native.txt 混合捕获）— 属实**。该文件仅 3 行："6 files / 120 passed | 2 skipped"（e2e native 摘要）+ "175 pass / 0 fail"（bun driven 摘要），与报告 §8 GREEN-1 行声称的 3 文件命令不对应。GREEN-1 数字（27/2 skip）我已亲跑成立，故仅为证据标注瑕疵，不损结论。
- **P3-2（套件名拼写）— 属实**。implementer §8 写 "mcp-grant-removal"，实际文件 `server/tests/mcp-grant-removal.integration.test.ts`。
- **F1（新发现）**：implementer §1 称 web-research.test.ts "15 用例"，实际 **13**（5 引导语 + 6 角色选择 + 2 live；2 skip）。validator 的 29/18 总数正确，仅为报告计数笔误。

## 5. Findings 汇总（无 Critical/High/Medium）

| # | 严重度 | 内容 | 处置建议 |
|---|---|---|---|
| F1 | Low | implementer 报告 web-research 用例数 "15" 实为 13（亲跑确认） | 更正记录即可，不阻验收 |
| F2 | Low | `green-native.txt` 为 6 文件混合捕获，未覆盖其被引用的 GREEN-1 命令；数字经 validator 与本轮双重复跑成立 | 证据文件标注瑕疵；V01 汇总时注明 |
| F3 | Info | 报告套件名缺 `.integration` 后缀（同 validator P3-2） | 记录即可 |
| F4 | Info | `roleOfHeldRef` 在 tools.ts 与 selection.ts 双份（owned_files 边界所迫，注释互指防漂移） | V01/后续清理可收敛为单一 server-side helper（不宜进 app 共享的 shared/research.ts） |
| F5 | Info | 超时无运行时用例：`CALL_TIMEOUT_MS=60_000` 与 BASE/上游逐字相同、零改动，失败包装路径由 401 例覆盖；const 无注入点，补测需先立 seam（超出 R02 范围） | 记 V01/backlog：若加超时注入点再做短超时用例 |
| F6 | Info | `roleOfHeldRef(ref: string)` 形参类型为 string 而体内有 `typeof` 护栏——对类型读者看似死代码，实为运行时数据防御（junk 用例固化）。防未来"清理"误删 | 注释已写明；无需行动 |

## 6. 判定

- Spec §7 全六条（后端范围）+ up10 criteria 1–8：逐条通过，证据 wire 级/库级分离，live-key BLOCKED 隔离严格。
- 偏差①②③论证成立且与上游行为等价；diff 范围恰为 owned+transport(+11)+证据；RED（10 fail/2 fail，标题逐一对应）→GREEN 真实且三方可复现。
- 唯一未闭环项：持真实 key 的 live 联调（2 例 BLOCKED）——需在 A10 完整闭环前由持 key 轮补跑，不阻本次 R02 后端验收。

Spec compliance: pass
Code quality: pass
