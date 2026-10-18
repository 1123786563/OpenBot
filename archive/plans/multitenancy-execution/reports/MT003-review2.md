# MT003 / Issue #46 — 独立复审报告（review2）

- Reviewer：独立 Pi Reviewer（Orca Task `task_8ae36eaedbc7` / Dispatch `ctx_fc362bdfd563`），与实现者（Task `task_60577e388d74` / Dispatch `ctx_a255a1e79beb`，已结算）无共享会话，未自批。
- 复审日期：2026-10-15。
- 冻结快照 BASE：`f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（`git rev-parse HEAD` 实测，与 manifest 首行一致；与 coordinator 勘误消息一致）。
- 审阅方式：只读被审文件；唯一写入本报告；全部验证命令本人执行并记录退出码。
- 契约来源说明：brief 引用的 `interfaces.md` 不存在于本工作树（`docs/plans/2026-10-15-company-team-multitenancy-execution/` 仅有 briefs/checkpoints/reports）。按 Issue #46 Handoff notes「计划缺失时以本 Ticket 与父 Spec 为准」，T01 工具契约以 Issue #46 正文（四条验收 + Scope boundary + Verification）与 `checkpoints/MT003/review-package.json` 的 `acceptance_criteria_mapping` 为准执行审阅。

---

## 1. 快照与完整性核验（先做，全部通过）

- `git rev-parse HEAD` → `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` ✅
- `git status --porcelain`：仅 untracked 路径（`docs/plans/2026-10-15-company-team-multitenancy-execution/`、`server/scripts/multitenancy/`、`server/tests/multitenancy/`），无任何 tracked 修改 ✅
- `checkpoints/MT003/review-sha256-manifest.txt` 逐文件 SHA-256 复算：**12/12 全部匹配**（inventory.ts、migrate-test.ts、inventory.test.ts、migration-tool.test.ts、reports/MT003.md、brief、before.json、after.json、review-package.json、verification.txt、apply-lifecycle.txt、cli-smoke.txt）✅
- 复审全程结束后对两个被审文件再次复算，哈希与 manifest 仍一致（未被复审过程污染）✅
- 限制：`before.json`/`after.json` 声称 10 个前置文件哈希未变，但其中 8 个（MT001 checkpoint/report/dag 等）未随审阅工作树转移，本工作树内只能独立复算其中 2 个（`server/scripts/multitenancy/inventory.ts`、`server/tests/multitenancy/inventory.test.ts`，均匹配）。该 8 项「未变」声明在本工作树不可独立复算（见 F9）。

## 2. Verdicts

| 结论 | 判定 | 摘要 |
| --- | --- | --- |
| Spec compliance（Issue #46 四条验收 + Scope boundary + Verification） | **PASS** | 四条验收均以测试代码 + 本人独立复跑证据逐条核实（见 §3），非仅对照报告声明；范围边界（不写业务迁移）成立 |
| Code quality | **PASS**（非阻塞 findings） | 0 critical / 0 high / 2 medium / 2 low / 5 info（见 §5）；无安全或正确性缺陷阻塞本工单 |

## 3. Spec compliance 逐条证据（独立复核，非转述报告）

**C1 — 只接受枚举的任务标识与 generate/migrate；未枚举标识被拒绝：PASS**
- 实现：`TASKS` 显式枚举注册表仅含 `MT000`（migrate-test.ts:65-104）；`parseArgs` 拒绝未知命令（:431）、未知旗标（:409）、多余位置参数（:424）、缺失参数（:418）、未知 task id（:437，`TASKS.has` 大小写敏感）；命令×旗标交叉拒绝（:444 generate 拒 --apply/--manifest，:452 migrate 拒 --out）；`--apply` 缺 `--manifest` 在 args 阶段拒绝（:455-462）。
- 测试：criterion 1 块 7 个用例（migration-tool.test.ts:87-167），每个拒绝路径同时断言 `connectCalls==0`、`writes==[]`（:80-83）。
- 独立复跑：`migrate MT999` → `refused (args): unknown task id "MT999"; allowed task ids: MT000`，exit 1（本人 CLI 冒烟）；套件内 criterion 1 全过。

**C2 — 只读显式测试库配置；生产/缺失拒绝并说明原因；不回退 .env/DATABASE_URL：PASS**
- 实现：仅经 `runtimeTestEnvironment` seam 读 `TEST_DATABASE_URL`（migrate-test.ts:297-352；seam 文件 `server/scripts/runtime-test-environment.ts:8-18` 注释与实现均为只读该变量）；下层 `testDatabaseUrlFrom`（server/tests/support/database.ts:15-50）拒绝缺失/非法 URL/非 postgres 协议/live `openbot` 库名；工具层再叠回环主机（:324）、fragment（:331）、单段库名（:338）、`openbot_enterprise_*` 前缀（:345）。全部拒绝发生在 `connect` 之前（runMigrateTest 先 args 后 DB config，migrate-test.ts:528-545）。工具自身不加载 .env（使用说明要求 `bun --no-env-file`，:23-27）；测试环境常驻 `DATABASE_URL` 诱饵证明无回退（migration-tool.test.ts:26-30）。
- 测试：criterion 2 块 9 个用例（migration-tool.test.ts:170-290），全部零副作用断言。
- 独立复跑：缺 `TEST_DATABASE_URL` → `refused (database-config)`，exit 1，消息含「never falls back to DATABASE_URL and never loads .env」；`postgres` 库名、非回环主机等拒绝均有理由（套件全过）。

**C3 — 固定名字、递增编号；重复编号或跳号被检测：PASS**
- 实现：`stepFileName` 固定 `NNNN_<task小写>_<slug>.sql` 无时间戳（migrate-test.ts:126-128）；`buildPlan` 编号 1..n（:130-158）；三处检测——计划内 `validatePlanNumbering`（:200-227，重复/断号/重名）、journal `validateJournalNumbers`（:249-281，连续前缀 + 漂移）、generate 目录扫描（:799-838，重复/断号/超出计划/内容与名称漂移，写入前拒绝且不改写）。
- 测试：criterion 3 块（migration-tool.test.ts:291-432）+ generate 物化块 5 类漂移用例（:713-770，并断言拒绝时目录未被改写）。
- 独立复跑：两次 `generate --out` 物化 0001-0003 + manifest.json，文件名确定、digest 与实现者 checkpoint `apply-lifecycle.txt` 逐字一致（66e51f…/852f77…/99e216…）；`regenerating verifies instead of rewriting` 过。

**C4 — 默认 dry-run 输出语句与影响摘要；apply 必须携带全匹配 manifest：PASS**
- 实现：migrate 无 `--apply` 走 dry-run（逐条语句 + impact + 涉及对象 + journal 进度 + 精确 manifest，renderOutcome migrate-test.ts:553-586；无任何事务，:930-947）；apply 门禁在读 manifest→解析→对照计划（schemaVersion/tool/taskId/planDigest/逐步骤名与 digest/statementCount，:860-905）之后才 `connect`（:907）；每步独立事务 + journal INSERT（:963-976）；全应用后显式 `up-to-date` no-op（:951-961）。
- 测试：criterion 4 两块 8 个用例（migration-tool.test.ts:480-655），含 6 种 manifest 篡改全部「连接前拒绝」（`connectCalls()==0`）。
- 独立复跑（review 库 127.0.0.1:55443/openbot_enterprise_mt003_review，全新库）：dry-run exit 0 列出 3 步逐条语句；generate→apply exit 0→re-apply `up-to-date` exit 0；篡改 digest 的 manifest → `refused (manifest)` exit 1；终态 psql 验证：journal 3 行（MT000 1-3，digest 与计划一致）、`mt_tool_selfcheck` 已删除、除 journal 表无其它对象。

**Scope boundary — 不写业务迁移：PASS**：`TASKS` 仅 `MT000` 自检（非业务迁移）；测试断言 allowlist 恰为 `["MT000"]`（migration-tool.test.ts:311-316）。**Verification —** `bun test server/tests/multitenancy/migration-tool.test.ts` 已独立复跑（§4）。

## 4. 独立复跑记录（本人执行，含退出码）

| # | 命令 | 结果 / 退出码 |
| --- | --- | --- |
| 1 | `lsof -i :55443` / `-i :55433` | 均空闲（无监听） |
| 2 | `docker run --rm -d --name openbot-i6r2-mt003-pg -e POSTGRES_DB=openbot_enterprise_mt003_review -p 127.0.0.1:55443:5432 postgres:16`（brief 原命令） | **容器立即退出**：postgres:16 要求 `POSTGRES_PASSWORD` 或 `POSTGRES_HOST_AUTH_METHOD`（brief 命令缺陷，见 F9）。补 `-e POSTGRES_HOST_AUTH_METHOD=trust`（仅回环绑定、一次性容器）后 6s ready |
| 3 | `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55443/openbot_enterprise_mt003_review bun test server/tests/multitenancy/migration-tool.test.ts` | **exit 0，33 pass / 1 skip / 0 fail**（172 expect）。skip 即真实库集成测试：其守卫把「专属库」硬编码为实现者端点（见 F1），review URL 下按设计显式跳过。**按约束不计该 skip 为通过** |
| 4 | 追加一次性容器 `openbot-i6r2-mt003-pg-assigned`（127.0.0.1:55433，`POSTGRES_DB=openbot_enterprise_mt003_test`，用后删除）+ 同一测试命令（assigned URL） | **exit 0，34 pass / 0 fail / 189 expect**（全新库，applied 分支）；复跑第二次 **exit 0，34 pass / 0 fail / 186 expect**（up-to-date 分支，与实现者 verification.txt 完全一致）。psql 终态核验：journal 3 行 digest 与计划一致、自检表已删、无其它对象 |
| 5 | `cd server && bun run typecheck` | **exit 0**（clean；`server/tsconfig.json` include 含 `scripts`，报告声明属实） |
| 6 | `bunx biome check server/scripts/multitenancy/migrate-test.ts server/tests/multitenancy/migration-tool.test.ts` | **exit 0**（Checked 2 files, No fixes applied） |
| 7 | `TEST_DATABASE_URL=…55443/…review bun test server/tests/multitenancy/inventory.test.ts`（MT001 回归） | **exit 0，33 pass / 0 fail / 5088 expect**（该套件为纯静态分析，不连库） |
| 8 | CLI 冒烟（review 库，`bun --no-env-file`）：dry-run / 缺 env / MT999 / --apply 缺 manifest / generate --out / apply / re-apply / 篡改 manifest | exit 依次 0 / 1 / 1 / 1 / 0 / 0 / 0 / 1；全部消息带理由；拒绝路径无副作用 |
| 9 | 变异检查（在 `/tmp` 副本上，仓库文件零改动，事后哈希复验未变）：删除 journal INSERT | 伪连接单测 `a valid manifest applies…` **fail**；真实库集成测试在「journal 已收敛」状态下仍 pass——与实现者披露逐字吻合；**重置 journal（DROP）后复跑 → 2 fail / exit 1**。变异检查声明独立证实 |
| 10 | 清理 | `docker rm -f openbot-i6r2-mt003-pg openbot-i6r2-mt003-pg-assigned`；55433/55443 复查无监听 |

工具版本：bun 1.4.2、postgres:16（digest `ca0bd484…`）、gh 2.97.0。

## 5. Findings（分级；只报告，不修复）

### Medium

- **F1（medium，可复现性）真实库集成测试把「专属库」硬编码为实现者一次性端点，第三方无法在其它专属库上触发它。**
  证据：migration-tool.test.ts:842-848（`hasAssignedDatabase` 要求 endpoint 严格等于 `127.0.0.1:55433` 且库名严格等于 `openbot_enterprise_mt003_test`）、:847（`test.skip`）。后果：本 brief 第 3 步指定的 review URL（55443/`openbot_enterprise_mt003_review`）下必然 33 pass + 1 skip，「预期全过、无 skipped」在该 URL 下结构性不可达成；任何未来 reviewer/CI 必须复用实现者的临时端点才能验证 apply 链路（本次复审以自建同端点一次性容器绕过并全程记录）。缓解：已在 review-package.json 披露该设计（防误打其它库）。建议：把目标端点提为显式校验过的单一 env（如 `MT003_ASSIGNED_TEST_DATABASE_URL`，仍必须过 `resolveTestDatabaseTarget` 全部安全检查），或允许任意回环 `openbot_enterprise_*` 专属库，同时保留「无显式配置即显式跳过」。
- **F2（medium，健壮性）migrate 路径从不核对 journal 已记录 digest 与当前计划是否一致，计划/journal 内容漂移不可检测。**
  证据：`readJournalNumbers` 仅 SELECT `number`（migrate-test.ts:653-661）；`validateJournalNumbers` 只查连续性/数量（:249-281）；`up-to-date` 判定只看编号前缀（:930-953）。场景：注册表语句在步骤已应用后被修改 → 新 manifest 与新计划一致（manifest 门禁照常通过）→ 旧 journal 编号仍连续 → 报 `up-to-date`，库内 schema 实为旧 SQL 所建，与当前计划宣称内容背离且无任何信号。Issue #46 四条验收字面只要求重复/跳号检测，故不构成 spec FAIL；但该工具的存在目的即「可追溯、可重放、可核验」，journal 表已存 `statement_digest` 却从不比对。建议：migrate 时一并取 `statement_digest` 与计划逐步骤比对，漂移即拒绝并提示人工审查。

### Low

- **F3（low）`migrate <task> --manifest F` 不带 `--apply` 时静默忽略 manifest。** parseArgs 只拒绝 `apply && !manifestPath`（migrate-test.ts:455-462），`--manifest` 单独出现被接受（:421-426 区段）；runMigrate 仅在 `args.apply && args.manifestPath` 时读取校验（:907）。dry-run 无副作用故无安全影响，但用户提供的 manifest 被无声丢弃。建议：无 `--apply` 时对 `--manifest` 给出拒绝或警告。
- **F4（low）拒绝探针记录了文件读但拒绝路径不断言零读。** `refusalProbe` 记录 reads（migration-tool.test.ts:59-63），`expectNoSideEffects` 只断言 connect==0 与 writes==[]（:80-83）。criterion 2 各用例通过对 `stage:"database-config"` 的断言间接覆盖（若发生 readFile 会改变 stage），残余风险为「与预期 stage 恰好一致的读文件」这一理论缺口。建议：`expectNoSideEffects` 一并断言 `reads==[]`。

### Info

- **F5（info）generate 目录扫描忽略 5 位及以上编号文件。** `taskFilePattern = ^(\d{4})_`（migrate-test.ts:799-801），如 `10000_mt000_x.sql` 不匹配即被无视，漂移不报。触发条件极端（编号破万），仅记录。
- **F6（info）执行失败被建模为 `refused(stage:"execution")`**（migrate-test.ts:984-992），把运行期故障与「拒绝」语义合并；CLI 退出码正确（1），仅为语义洁癖记录。
- **F7（info）规避 .env 依赖操作者自觉传 `bun --no-env-file`。** Bun 会自动预载 .env，工具自身无法阻止（只在用法注释 :23-27 与拒绝消息中声明）；工具仍只认 `TEST_DATABASE_URL`，风险为值可能来自 .env 而非显式 shell 环境。属平台限制，已文档化。
- **F8（info）expect 计数 186 vs 189 差异可解释。** 集成测试 `applied` 分支比 `up-to-date` 分支多 3 个断言（migration-tool.test.ts:867-871）；实现者记录的 186 对应已收敛库，本人全新库首跑 189、复跑 186。非缺陷，留痕备查。
- **F9（info，环境/brief 缺陷，非实现缺陷）**（a）brief 的 docker 命令缺少 postgres:16 必需的认证 env，原命令无法启动（本次以 `POSTGRES_HOST_AUTH_METHOD=trust` + 仅回环绑定 + 用后删除补救并记录）；（b）`before/after.json` 的 10 项前置哈希中 8 项对应文件不在本审阅工作树，无法在此独立复算（已转移的 2 项均匹配）；（c）brief 引用的 `interfaces.md` 不在本工作树，已按 Issue #46 Handoff notes 回退以 Ticket + 父 Spec + review-package 契约映射为审阅契约。

## 6. 「诚实披露」项核验结论

| 披露 | 核验方式 | 结论 |
| --- | --- | --- |
| 波次 2 纯校验器随骨架实现、测试首跑即绿 | 冻结产物中不存在波次 2 的 RED 日志；报告未声称不存在的 RED | **与证据一致（不可证伪亦未造假）** |
| 波次 5 真实库测试首跑即绿 + 变异检查（收敛态不触发、重置 journal 后双失败） | 本人在 /tmp 副本独立复现：删除 journal INSERT → 伪连接单测 fail；收敛态下集成测试 pass；DROP journal 后复跑 2 fail / exit 1 | **独立证实，披露精确（连「收敛态不触发」细节都对）** |
| CLI TDZ 缺陷（入口原在文件中部）与修复 | 代码检查：CLI 块现位于文件末尾（migrate-test.ts:994-1011），其后无声明；top-level await 路径引用的 `defaultConnect`/`JOURNAL_TABLE` 等 const 均在其之前初始化，若前移即 TDZ；且 `bun test` 下 `import.meta.main` 为 false，套件结构性无法捕获该类缺陷——与披露的「冒烟抓到、套件抓不到」机理吻合 | **与代码事实一致** |

## 7. 结论

- **Spec compliance：PASS**——Issue #46 四条验收 + 范围边界全部以独立复跑证据核实；拒绝先行、零副作用、manifest 门禁、编号三处校验均真实有效；无业务迁移越界。
- **Code quality：PASS（非阻塞）**——实现干净（seam 复用、注入安全、确定性输出、每步事务 + 可重放 journal）；2 medium（F1 端点硬编码伤可复现性、F2 journal digest 漂移不可检测）建议实现者跟进，2 low + 5 info 供参考。
- 复审过程零仓库文件改动；两个临时容器已删除；无提交/推送/合并行为。

（本报告为本次复审在目标分支工作树内的唯一新建文件。）
