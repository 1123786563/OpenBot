# R01 Independent Review — 共享研究角色与 provider catalogue（最终质量关口）

- Reviewer: Task R01 独立 reviewer（只读；本报告为唯一写入物）
- 工作区: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`
- 日期: 2026-10-20
- 对象: R01 增量（`shared/research.ts` + test 新建；`server/src/plugins/catalogue.ts`、`server/tests/plugin-catalogue.test.ts` 修改）
- 事实源核对: Spec §7 前 3 条（`docs/specs/2026-10-20-upstream-openbot-adoption-design.md:102-105`）、up10 criteria 1–2（`docs/tickets/upstream-openbot-update/issues/up10.md`）、实施计划 I4 合约（`implementation-plan.md:106-116`）、上游 `evidence/upstream-sources/{shared/research.ts, server/src/plugins/catalogue.ts}`
- 方法: 全部关键声称独立复跑/复算（测试、audit、typecheck、format、diff 机械比对），未采信报告原文。

## 0. 结论

**通过。** Spec compliance 与 code quality 均无阻断项。2 条 P3（均为报告记账失真，代码不受影响）、3 条观察项（R02/R03 交接 watch item）。实现与上游参考逐字/逐串对齐，fail-closed 语义经源码序与负例双向证实，兼容面零破坏，范围恰为 4 个 owned_files。

## 1. 独立复跑证据（本人执行）

| 检查 | 命令 | 结果 |
|---|---|---|
| shared native | `bunx e2e run --config e2e.unit.config.ts shared/research.test.ts` | **13/13 passed** |
| catalogue | `E2E_UNIT_SCOPE=server … server/tests/plugin-catalogue.test.ts` | **63/63 passed** |
| 旧 Parallel 回归 | 同 scope `server/tests/parallel-research.test.ts` | 4/4 passed |
| 8 个 consumer 回归 | mcp-listing / plugin-oauth / composio-classify / openconnector-access / google-drive-rest / component-catalogue / component-catalogue-entries / responsibility-trigger-tools | 8 文件 **117/117 passed**（+4 = 121/121，与实现者声称一致） |
| 归层对账 | `node scripts/e2e-coverage-audit.mjs` | **exit 0**：1060 files · 567 native · 478 driven · no gaps |
| typecheck | `bun run --filter server typecheck` | 恰 3 条错误，全部 `scripts/bootstrap-local-gateway.ts` (106,52)/(108,53)/(120,74)；该文件 `git diff HEAD` 为空 ⇒ BASE 既有红，零新增 |
| format | `bunx biome format`（4 文件） | Checked 4 files, no fixes needed（exit 0） |
| 中立文件 | before/after diff 逐 hunk md5 比对 `docs/verification/e2e-bun-suites.json`、`e2e.unit.config.ts` | **字节相同** ⇒ R01 零改动（native 桶经 `SUITE_DIRS` 含 `shared` 自动收集，无需登记，与 `scripts/lib/e2e-manifest.mjs:19` 证实） |
| 范围 | `before-status.txt` + after 对比 | catalogue 两文件在 before 未修改、`shared/research.*` 在 before 不存在；工作树中 `shared/connect-prompt.*` 为前置任务遗留，非 R01 所为 ⇒ R01 恰 4 个 owned_files |

## 2. Spec compliance 逐条核对

### 2.1 逻辑角色与授权求交的静态基础 — PASS

- I4 合约四个签名（`ResearchRole`/`ResearchTools`/`RESEARCH_TOOLS`/两函数）与 `implementation-plan.md:107-113` **逐字一致**；六 key 与 catalogue 双向对账有测试（`plugin-catalogue.test.ts:851-876`，含「shared key ⊆ catalogue 且 catalogue 研究条目 ⊆ shared key」双向断言），漂移只能在此失败。
- 求交语义的静态声明位于 `shared/research.ts:83-90` 文档："The two meet at selection time and nowhere before it"——`researchRoleOf` 只读 ref 本身，真 ref（`parallel/web_search`）恒 null，声明不能凭语义自动成为 grant。运行时求交属 R02，与 brief 分工一致。
- 六 key 的工具名与 I4 规定完全一致（parallel: `web_search`/`web_fetch`；exa: `web_search_exa`/`web_fetch_exa`；firecrawl: `firecrawl_search`/`firecrawl_scrape`），且与 catalogue read 分类逐 key 互证（`:866-876`）。

### 2.2 固定 reviewed host/path/认证 header — PASS

- 机械比对（两文件全部字符串字面量集合 diff）：本地 catalogue 相对上游**仅多一个字符串 `"Authorization"`**（= brief 规定的 `tokenHeaderFor` 默认值偏差），上游仅多一个 `@openbot/shared/research` import 说明符（本地刻意不建运行时依赖，由测试互证）。四条目（exa :242-253、exa-authenticated :254-267、firecrawl :268-280、firecrawl-authenticated :281-293）与上游逐串相同——实现者报告 §3 的行号**经核实准确**。
- 管理员不能任填：`CatalogueAuth.header?` 文档明示 "never taken from a caller, and an administrator does not get to type one in"（catalogue.ts:44-47）；`hostAdmissible` raw 相等 + `resolveServerUrl` 恒用 `entry.path`（上游既语义，未触碰）；路径/仿冒 host 负例 9 个全部拒。
- `resolveServerUrl(key, "https://attacker.example")` 六条目全部回 pinned URL——caller host/path 双忽略有测试钉死。

### 2.3 只读=权限分类非免费 — PASS

- 注释：两个常量块均带 "READ IS A PERMISSION CLASSIFICATION AND NOT A PRICE"（catalogue.ts:166、:179），上游 :174 措辞沿用并扩写，满足 brief 要求 6。
- 语义有测试背书：Exa `agent_run`/`web_search_news_exa`（advertised 但不在 allowlist）→ write（:756-757）；Firecrawl crawl 写列表整组 → write（:776-778）。

### 2.4 未知/高风险工具 fail-closed — PASS

- `classifyTool` 分支序（catalogue.ts）: `!advertised`(:576) → `writeTools`(:579) → `readTools` 收窄(:583) → `recorded`(:586) → `!entry`(:590) → read(:593)。readTools 分支**只可能返回 "write"**，且置于 `recorded` 之前 ⇒ vendor 列无法买回（`firecrawl_monitor_delete`+recorded "read" → write，已测）。
- 未知工具三条路全封：未 advertised → write；有 readTools 条目不在名单 → write；无条目 → write。六 key 上 `not_advertised` 全 write、`classifyTool(null,…)` write 均已测——provider 名不参与降级，满足 up10 criterion 2 后半句。
- 兜底完整性：readTools 用 `.includes` 精确匹配，大小写/家族名（`firecrawl_monitor_*`）天然落入 write 方向。

### 2.5 旧 Parallel ref 兼容 — PASS

- diff hunk `@@ -184,6 +239,60 @@` 中 parallel/parallel-authenticated 仅以上下文行出现，零 +/- 触及；key/endpoint/auth kind/credential kind 有专属兼容测试（:886-906）。
- Parallel **不设** `readTools`（:919-920 断言 undefined）：既有 grants 在 write-list 方向发放，不静默切 allowlist 方向——这是正确的兼容判断（上游亦不设）。旧真实 ref 四个（`parallel[-authenticated]/web_search|web_fetch`）role+分类双断言绿，`parallel-research.test.ts` 4/4 绿。

## 3. Code quality 核对

### 3.1 shared/research.ts 零依赖纯函数 — PASS

- 无任何 import；`Object.freeze` 覆盖表（:53）与全部三个 provider 常量（:24/:33/:38，含 PARALLEL.notes 内层 :27），运行时与类型双只读。`Object.hasOwn` 防原型键（:69）并有测试（`toString`/`constructor` → null）。
- `researchRoleOf` 的 split 解构三段法（:92-94）正确处理多斜线/尾斜杠/空串/缺前缀（7 个负例全 null，含 `@research/search/`、`""`、`@research/constructor`）。
- `shared/research.ts` 与上游 `shared/research.ts` 逐行 diff：**可执行逻辑完全相同**，差异仅为 (a) 移除 `RESEARCH_ROLE_LABELS`/`RESEARCH_ROLES`/导出 `RESEARCH_ROLE_PREFIX`（UI 标签面，brief 禁止 R01 做，已记偏差 §7.3），(b) 文档扩写（含 drift 测试具体路径、grant/role 求交语义）。忠实。

### 3.2 classifyTool 三层顺序的权限放大问题 — PASS（重点审查项）

审查问题：readTools 收窄会不会反向放大权限？**不会**，依据：

1. 该分支唯一出口是 `return "write"`（:583），结构上不可能产出 read——它引入的行为变化是单调收紧的。
2. 对**在** readTools 名单上的工具，落空穿透到 `recorded`/`!entry`/read(:593)，与改动前无 readTools 条目的路径逐位相同；对**不在**名单上的工具，只可能从「(可能) read」变为 write。不存在 read→read'（更宽）或 write→read 的转移。
3. 排序在 `writeTools` 之后保证 write 名单优先（若某工具同时在两名单，仍 write——安全方向）；在 `recorded` 之前保证不受约束的 vendor 列不能否决 reviewed allowlist（"an allowlist that could be outvoted by one would not be an allowlist"，:580-582）。
4. 遗留条目（google-drive/notion/routines/parallel×2/自定义）`readTools` 为 undefined ⇒ 分支短路，行为零变化——这正是旧 grants 兼容的机制保障，且断言钉死（:919-920）。

### 3.3 tokenHeaderFor 返回 string vs 上游 string|undefined — PASS（偏差已记录且合理）

- brief/计划 I 合约明文 `(entry): string`（默认 Authorization），实现遵 brief；上游 `string|undefined` 依赖调用点 `?? "Authorization"` 补全。对全部输入（含 null/none/user-oauth/未知 key），本地结果 ≡ 上游 `?? "Authorization"` 后结果，R02 消费面行为等价且免于漏写 `??`。
- 附加发现（优于上游的细节）：本地对 `header` 做**真值**判断（:477），`header: ""` 会落默认 `"Authorization"`；上游原样返回 `""`，而 `"" ?? 默认` 不触发替换，会产出空 header 名。即本地在退化输入方向比 naive 移植更 fail-safe。无条目带空 header，非现实风险，仅记录。
- 偏差在 implementer-report §7.1 完整披露，与 brief 无冲突。

### 3.4 Firecrawl read 集含 map/parse 的上游依据 — PASS

- 直接依据：上游 `catalogue.ts:191-196` 的 `FIRECRAWL_READ_TOOLS` 恰为 `firecrawl_search`/`firecrawl_scrape`/`firecrawl_map`/`firecrawl_parse` 四项，本地逐字相同（测试 `:770-775` 按序 pin）。brief 明文授权「从上游 catalogue 提取 reviewed readTools，按行为对齐、不整文件复制」。
- 方向核查：`firecrawl_extract`/`firecrawl_generate_llmstxt` 等上游未列入 read 的能力在 allowlist 方向下**自动为 write**（即便事实上只读）——过严不放过，符合 fail-closed 取向。map（链接枚举）与 parse（结构化读取）为查询语义，与同列表 search/scrape 一致。

## 4. Findings

| # | 严重度 | 内容 | 处置 |
|---|---|---|---|
| F1 | P3 | **implementer-report 用例计数失真（复核证实 validator P3-1）**：报告 §1「追加 11 用例（63 总）」、§6「52 原有 + 11 新增」与 diff 不符。实测 diff 新增 **17 个 test 块**（`git show HEAD` 基线 46 + 17 = 63，两数本人独立复算确认）；「11 failed / 52 passed」实为 RED 时点断言分布，被误写为基线构成。总数 63/63、13/13 本身正确，代码零影响。 | 修订报告 §1/§6 文案即可，不阻塞。 |
| F2 | P3 | **RED 精确计数（11 failed）事后不可复算**：COLLECTION_ERROR→补 stub→断言红的链条机制真实（named export 缺失即文件级求值失败，与 ADR 0008 一致），≥11 失败的逻辑下限成立，但当时点树未留存，精确值只能逻辑重建。 | 接受；后续任务建议留存 RED 原始输出文件作证据。 |
| F3 | 观察（R02 watch item） | 上游 catalogue `researchRoleFor(ref)`（上游 :165-172，`serverId/toolName` 拆分 + `typeof ref !== "string"` 与 `slash <= 0` 运行时护栏）未移植——不在 I4 合约内，实现者已披露（报告 §7.2）。R02 做求交时须自行实现该拆分并**保留同等输入护栏**（上游注释：Bot instructions 由它构建，never throws）。 | 记入 R02 交接；R02 brief 有自己的前置清单，无 R01 缺陷。 |
| F4 | 观察（R03 watch item） | `RESEARCH_ROLE_PREFIX` 未导出（上游导出）。R03 的标签/引导面需要前缀或字面量时，应在其 owned_files 内补导出或引常量，勿复制字符串。 | 记入 R03 交接。 |
| F5 | 观察 | 派发清单上游行号 :247-289 与实际 :242-293 有偏移（validator 观察项，本人复核确认实际块界准确；implementer-report §3 所引 :242-253/:254-267/:268-280/:281-293 经核实无误）。无影响。 | 无需动作。 |
| F6 | 观察 | 工作树混有其它任务未提交文件（`shared/connect-prompt.*` 等）；经 before-status + before/after hunk 比对隔离，R01 自身 diff 恰为 4 个 owned_files，干净。 | 无需动作。 |

## 5. 报告交叉核对结论

- implementer-report：除 F1 计数失真外，其余关键声称（六 key 对照表、reviewed 清单及上游行号、fail-closed 举证、兼容举证、121/121 回归、typecheck 3 条 BASE 红、format exit 0、5 条偏差披露）**全部独立复核为真**。
- validator-report：6/6 PASS 判定成立；其 P3-1/P3-2 两条记账项本人以 diff 复算（17 块、46+17=63）与逻辑重建双重证实；其对 classifyTool 行号（:579/:583/:586）、diff hunk 界（`@@ -184,6 +239,60 @@`）、中立文件字节相同、audit 数字（1060/567/478）的声称均与本人实测一致。两报告之间无互相矛盾。

## 6. 判定

R01 静态半部（I4 合约、reviewed catalogue、fail-closed 分类、Parallel 兼容）实现忠实、语义安全、测试钉死充分、范围干净，可进入 R02 集成。F1 报告文案修订不阻塞；F3/F4 作为 R02/R03 交接 watch item 传递。

Spec compliance: pass
Code quality: pass
