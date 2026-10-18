# MT131 / Issue #174 — 独立复审报告（review2）

- Reviewer：独立 Pi复审 worker（Task `task_64f49f515ebb` / Dispatch `ctx_9d91497242e9`），与实现者（Task `task_9b95a3b8cb96` / Dispatch `ctx_c83a96b3959d`，已结算）无共享会话，未复用实现者会话或凭据。
- 工作树：`/Users/wuyongjun/orca/workspaces/OpenBot/i6-review2-mt131`；`git rev-parse HEAD` = `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（与 brief / review-sha256-manifest.txt 首行一致；dispatch 前言中的 BASE 哈希笔误已经 coordinator 澄清勘误，以 brief/manifest 为准）。
- 本工作树内唯一由本次复审新建的文件即本报告；被审文件与前置文件零改动。

## 0. Verdicts（两个独立结论）

| 结论 | 判定 |
| --- | --- |
| **Spec compliance（Issue #174 四条验收）** | **PASS — 4/4 满足**（证据见 §3） |
| **Code quality** | **PASS WITH FINDINGS** — 0 critical / 0 high / 2 medium / 2 low / 4 info（见 §4） |

无 blocked 项：独立复跑所需的数据库、角色、端口均在本机自建成功并全部执行完毕。两次测试套件运行（不同环境命名）都是真实执行，无 skip、无占位通过。

## 1. 快照与完整性核验（先做，全部通过）

1. `git rev-parse HEAD` → `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（= manifest 首行）。
2. `review-sha256-manifest.txt` 14 个文件逐条 `shasum -a 256 -c` → **14/14 OK，exit 0**。
3. `git status --porcelain` 仅含清单内 untracked 目录（`docs/plans/2026-10-15-company-team-multitenancy-execution/`、`server/scripts/multitenancy/`、`server/tests/multitenancy/`），与 before.json/after.json 记录一致；无 tracked 修改。
4. 冻结包 `review-packages/MT131.json`：文件数 = 7（符合 brief）；7 个文件哈希 = 磁盘 SHA-256 = manifest 条目，三方全部一致；`source_head` = 实际 HEAD。
5. `before.json`（17 个前置文件，含 MT001/MT002 产物）与 `after.json`（shared_prerequisites_unchanged=true、commit_created=false）与当前状态一致。

## 2. 独立复跑记录（亲自执行，含退出码）

### 2.1 环境自建

- 端口预检：`lsof -i :55444 / :45435 / :45436` 全部空闲。
- 环境文件：`/tmp/mt131-review2-env.sh`，权限 `-rw-------`（0600），4 组随机密码（`openssl rand -hex 24`）自生成，**内容从未打印**；用后已删除（`ls /tmp/mt131-review2-*` → No such file）。
- 容器（brief 指定参数）：`docker run --rm -d --name openbot-i6r2-mt131-pg -e POSTGRES_DB=openbot_enterprise_mt131_review -p 127.0.0.1:55444:5432 postgres:16` → 就绪。
- **偏差 1（镜像）**：brief 指定的 `postgres:16` 无 `vector` 扩展，首次 `enterprise-test-db.ts migrate` **exit 1**（`PostgresError: extension "vector" is not available`，`/usr/share/postgresql/16/extension/vector.control: No such file or directory`，迁移 SQL 为 `CREATE EXTENSION IF NOT EXISTS vector;`）。改用 `pgvector/pgvector:pg16` 重建同名容器后 migrate 成功。这是 brief 环境参数与仓库 schema 的冲突，非被审代码缺陷。
- 受控 migrate（`cd server && bun scripts/enterprise-test-db.ts migrate`，env 已 source）：**exit 0**，`{"type":"migrations-applied","status":"ok"}`。
- 角色验证（psql 查 pg_roles/pg_auth_members，仅输出角色名）：`ent_r2mt131_directory/data/operator` 三个 LOGIN 角色、`super=false createrole=false`，各自恰好挂一个 NOLOGIN capability（`ob_ent_directory/data/operator`），另有 `ob_ent_identity_operator`；public schema 150 张表——与 progress.md 记录的受控 setup 形态一致。

### 2.2 测试套件（关键发现见 F1）

按 brief 原样：`source /tmp/mt131-review2-env.sh && OPENBOT_MT131_HARNESS_PORT=45436 bun test server/tests/multitenancy/acceptance-harness.test.ts`

| 环境 | 数据库@端口 | 结果 | 退出码 |
| --- | --- | --- | --- |
| A（brief 指定的独立命名） | `openbot_enterprise_mt131_review`@127.0.0.1:55444 | **12 pass / 2 fail**（1713→55 expect 后中断计） | **1** |
| B（复现实现者命名，独立自建的第二个容器 `openbot-i6r2-mt131-pg-b`） | `openbot_enterprise_mt131_test`@127.0.0.1:55434 | **14 pass / 0 fail / 1713 expect()** | **0** |

- 环境 A 的 2 个失败均在**断言环境常量**处，非 harness 行为：
  - `acceptance-harness.test.ts:122` `expect(isolation.databaseName).toBe("openbot_enterprise_mt131_test")`，Received `"openbot_enterprise_mt131_review"`；
  - `acceptance-harness.test.ts:302` 同款断言（导致覆盖语义断言在该环境下未执行到）。
  - `:124` `expect(isolation.databasePort).toBe(55434)` 属同类（A 中未到达）。
- 环境 B（数据库/端口与测试硬编码值一致）下 14/14 全绿、1713 expect()，与实现者 `checkpoints/MT131/verification-output.txt` 逐项一致（14 pass / 0 fail / 1713）。
- 结论：**harness 代码行为在我的独立数据库与角色上完整复验通过；2 fail 完全由测试文件硬编码实现者私有环境常量导致**（finding F1）。
- `grep -n "\.skip\|\.only\|\.todo"` 于测试文件 → 0 命中：无任何条件跳过，缺环境时套件响亮失败（符合 "skipped 不是 pass"）。

### 2.3 静态检查与 CLI

- `cd server && bun run typecheck`（tsc --noEmit）：**exit 0**。
- `bunx biome check server/scripts/multitenancy/acceptance-harness.ts server/tests/multitenancy/acceptance-harness.test.ts`：**exit 0**（Checked 2 files, No fixes applied）。
- CLI 诚实运行（环境 B，`--out /tmp/... --run-id r2rev01`，仍带 `OPENBOT_MT131_HARNESS_PORT=45436`）：**exit 0**；`overall=acceptance-not-passed`、`covered 0/539`、`self-check passed`、`seedPoison.detected=true`（reasons `leaked-records:1, denied:false`）、4/4 self-check pass、`serviceSurfacesCountingAsRouteCoverage: 0`、digest `2f5093ef127a5fd463c00a370fe67d4bfadec48f2ba9356aa1fe83abfb326e93` —— 与 MT131-harness.md §5 示例**逐字段一致**（含 digest 本身）。
- 报告泄密扫描：isolation 字段仅含 databaseName/Host/Port、role 名、httpPort、externalNamespace、tempDir、loopbackOnly —— **无任何 URL/密码**；全文 `postgres://` 0 命中、`ent_r2mt131` 0 命中（"password" 字样仅为 `/api/passwords` 路由路径）。
- fixture 清理实证：CLI 运行后对 `enterprise_*` 全部表 count → **全部为 0 行**（dispose 后无残留）。
- **偏差 2（端口变量）**：`OPENBOT_MT131_HARNESS_PORT` 在整个仓库 **0 命中**；harness 端口是硬编码常量 `HARNESS_HTTP_PORT = 45435`（acceptance-harness.ts:65），测试亦断言 45435（test.ts:132/150/152/303）。带 45436 值运行时测试全绿且绑定 45435，证明该变量不被消费。brief/任务摘要的 "harness 端口 45436" 与冻结代码不符（finding F5）；本复审按 brief 自身的规则「以测试实际读取的环境变量名为准，先读测试文件确认」处理。

### 2.4 清理

- `docker rm -f openbot-i6r2-mt131-pg openbot-i6r2-mt131-pg-b` → 两容器已删；55434/55444 复查空闲。
- 两个 0600 环境文件及全部 scratch 日志/报告已删除。
- `git status --porcelain` 与复审前一致（仍只有原 3 个 untracked 目录 + 本报告）。

## 3. Spec compliance — Issue #174 四条验收逐条对照

Issue #174 原文（github-intake.json `/issues/174`，与 Epic #206 表一致）：

**① harness 使用独立端口、测试数据库与外部命名空间，不污染开发环境 —— PASS**
- URL 仅从 `ENTERPRISE_TEST_SETUP_DATABASE_URL`/`TEST_DATABASE_URL` + 三个 `ENTERPRISE_TEST_*_DATABASE_URL` 解析，经共享校验器强制 loopback + `openbot_enterprise_*` 库名 + 三角色与 setup 同实例同库（acceptance-harness.ts:117-141；enterprise-database.ts:47-79,150-176）；`DATABASE_URL` 永不被读取（test.ts:85-89 实证拒绝）。
- 端口：`HARNESS_HTTP_PORT=45435` 专用环回绑定，二次独占绑定拒绝 `HARNESS_PORT_UNAVAILABLE`，关闭即释放（acceptance-harness.ts:145-177；test.ts:150-167 我的复跑通过）。
- 外部命名空间 `issue6_mt131_<run-id>`（acceptance-harness.ts:139）、temp 目录 `${TMPDIR}/openbot-mt131-harness/<run-id>`；run-id 形状约束 `^[a-z0-9-]{1,64}$`（:109）。
- 我的实测（§2.1/§2.3）：自建 55444/55434 两个一次性库 + 全新角色全流程可用，未触碰本机任何其他 PG 容器/开发栈；报告 isolation 块无 URL/凭据。

**② harness 能证明自身有效：先检测到一个人为植入的越权，再用于出证据 —— PASS**
- 种子毒化观测 `harness.poison.unauthorized-success`（positiveControlPassed:true + denied:false + 泄漏 1 条，acceptance-harness.ts:194-204）在每次 run 的正向控制中被双侧检出（`runPositiveControl` check 1，:495-513）；clean 控制保证检测器不是"全拒绝"（check 2）。
- 环境检查走**真实 MT002 fixture**（`createIsolationFixture("full-coverage")` → 真实 provisioning + requestAs：a1-member 200 为正控、a2-member 跨团队读被 401/403/404 拒绝为拒绝控，:336-369）。
- 检测器失效注入实验：`evaluator` 恒 pass 时 → `HARNESS_SELF_CHECK_FAILED`，且证据 adapter 的 `evidenceRuns === 0`（test.ts:233-260）——"先自证、后出证据"的顺序被测试钉死。
- 我的 CLI 实测：`seedPoison.detected=true`、4/4 self-check pass。

**③ 缺少测试环境时明确失败，不把 skipped 记为通过 —— PASS**
- `runAcceptanceHarness({environment:{}})` → `HARNESS_ENVIRONMENT_FAILED`（test.ts:204-217）；CLI 空 env → exit 1 + `HARNESS_RUN_FAILED:...TEST_DATABASE_URL|ENTERPRISE_TEST_SETUP_DATABASE_URL is required...`（test.ts:448-467，我的复跑亦得 exit 1 同消息）。
- 无 skip 路径（grep 0 命中）；缺侧=`missing`、未注册/异常=`scenario-error`、缺凭据=`environment-gap`，全部落在 `uncovered`，绝不合成 pass（acceptance-harness.ts:620-672；test "produces machine-readable..." 中 half/poisoned/unplanned 全部 uncovered 实证）。

**④ 运行方式与输出格式被文档化，可被其他 agent 直接使用 —— PASS**
- MT131-harness.md §4（setup/invocation/exit-code 契约/evidence plan 格式/清理）+ §5（schema v1 全字段 + 示例）；`EvidencePlan`/`RunHarnessOptions` 有 JSDoc（acceptance-harness.ts:400-427,538-556）。
- 本独立复审**就是按该文档成功复跑的第三方 agent**：文档描述的 env 变量名、migrate 方式、CLI 旗标、退出码语义与实际行为一致（除 F5/F6 两处文档级 nit）。
- 机器可读输出实测可 `JSON.parse`，schemaVersion=1，字段与文档一一对应。

**范围控制（Scope boundary）**：身份矩阵业务用例未混入（无业务 evidence plan 时诚实报 0/539 covered + acceptance-not-passed），符合"不含身份矩阵用例本身"。

**Blocked by 前置核验**：MT001 `inventory.ts`/`inventory.test.ts`、MT002 `support/fixture.ts`/`support/scenarios.ts`/`fixtures.test.ts` 哈希与 before.json/manifest 一致（消费侧未改动前置）；harness 消费 MT002 的 `createIsolationFixture(domain, options?)`、`registerIsolationDomain`、`runIsolationScenario`、`registeredIsolationDomains`、`ISOLATION_DOMAINS` 均为原签名调用（acceptance-harness.ts:36-57 imports；:305 fixture 创建；:481 注册；`FIXTURE_IDENTITIES`/`SPEC_IDENTITY_MATRIX` 位于冻结的 fixture.ts 内未动）。`evaluator`/`inventory` 作为自验 seam 已在 `RunHarnessOptions` JSDoc 声明 "production runs omit them"（:545-556），且坏 evaluator 实验证明生产缺省即安全。

## 4. Code quality — 分级 findings

**严重度计数：0 critical / 0 high / 2 medium / 2 low / 4 info。** 无任何 finding 由本复审修复；全部仅记录。

### F1 [medium] 测试硬编码实现者私有环境常量，套件不可在其它合规专用环境复跑
- 证据：`server/tests/multitenancy/acceptance-harness.test.ts:122`（`databaseName === "openbot_enterprise_mt131_test"`）、`:124`（`databasePort === 55434`）、`:302`（同 :122）。这些断言针对 `REAL_ENV`（进程环境快照）取值而非从环境推导的不变量。
- 影响：按 brief 用另一合规专用环境（`openbot_enterprise_mt131_review`@55444）复跑得 12/14（exit 1）；同名环境才 14/14。与 Issue #174 handoff 精神「另一个 agent 可直接接手/独立复验」相悖，也让"绿色"隐含了对某台机器的耦合。 harness 代码本身无此问题（报告如实反映实际环境）。
- 建议（未实施）：改为从 `REAL_ENV` 解析后断言（如 `databaseName === new URL(...).pathname.slice(1)` 且匹配 `/^openbot_enterprise_/`），或注入 fake env 断言解析输出。:64-70 的 `CONSISTENT_FAKE_ENV` 属纯解析 fake（不拨号），可保留。

### F2 [medium] harness 控制域场景可作为业务证据的"永真"预言机
- 证据：`validateEvidencePlan`（acceptance-harness.ts:436-473）只校验 `domain ∈ ISOLATION_DOMAINS`（`"full-coverage"` 在列表内，scenarios.ts:41）与 scenarioId 非空；`collectEntranceCoverage`（:622-640）随后经 `runIsolationScenario("full-coverage", "harness.control.clean-observation")` 命中 harness 自有控制 adapter（:303-311）→ 返回 clean 观测 → 正/拒两侧均 pass → 该入口 `covered`，全程无任何真实观测。
- 影响：一个（恶意或笔误的）未来业务 evidence plan 可以用控制场景把任意入口刷成 covered，绕过"绝不合成通过"的结构保证——harness 对未注册场景防了，却对自家控制场景没设防。
- 建议（未实施）：`validateEvidencePlan` 拒绝 `HARNESS_CONTROL_DOMAIN` 或 `harness.` 前缀 scenarioId。

### F3 [low] CLI 旗标缺值时静默降级
- 证据：`parseFlags`（acceptance-harness.ts:832-850）：`--out`/`--evidence`/`--run-id` 后无值时 `argv[index]` 为 `undefined` 被静默接受——尾随 `--out` 会让报告改走 stdout 而非报错；未知旗标有 `HARNESS_FLAG_UNKNOWN` 但缺值没有。
- 建议：取值为 `undefined` 时抛 `HARNESS_FLAG_MISSING_VALUE`。

### F4 [low] tempDir 每次运行创建但从不使用、也不清理
- 证据：`resolveHarnessIsolation` 生成 `tempDir`（acceptance-harness.ts:137）+ `runAcceptanceHarness` `mkdir(recursive)`（:576）后全模块再无引用；多次运行在 `${TMPDIR}/openbot-mt131-harness/` 下累积空目录（isolation 契约本身无害，报告文档"可随时删除"属实）。
- 建议：要么在隔离解析中实际使用（如写 run 元数据），要么省略 mkdir、仅保留命名空间字段。

### F5 [info] brief/任务摘要与冻结代码的端口/镜像偏差（复审侧已按代码事实适配）
- `OPENBOT_MT131_HARNESS_PORT` 全仓 0 命中，端口硬编码 45435（acceptance-harness.ts:65，测试 :132/150/152/303 同钉）——任务摘要"端口 45436"不成立。
- brief 的 `postgres:16` 镜像缺 `vector` 扩展导致 migrate exit 1，须 pgvector 镜像。
- 两者均为派发参数与仓库事实的冲突，非实现缺陷；已在 §2 记录实际处理。

### F6 [info] MT131-harness.md "both MT001 DB stages run" 措辞过强
- 实测（我的 CLI run）：`stages = [{live-table-crosscheck: ok}, {enterprise-capability-assembly: skipped}]`——后者需要生产装配变量（`ENTERPRISE_DIRECTORY_DATABASE_URL` 等，inventory.ts:1435-1447），专用测试环境必然显式 skipped（带原因）。digest `2f5093ef…26e93` 与文档一致恰证明实现者的记录性运行同样是 skipped；报告内 `stages` 数组本身是诚实的（digest 溯源设计有效），仅散文表述不准。

### F7 [info] 正向侧判定不消费 `denied` 事实
- `evaluateObservationSide`（acceptance-harness.ts:236-258）正侧只看 `positiveControlPassed` + 无泄漏/禁效；clean 控制观测本身 `denied:true`（:216-221），故"正侧却 denied"属 adapter 语义错误时 harness 不设防。这是观测事实模型（MT002 契约 "Facts, never verdicts"）的既定取舍，MT131-harness.md §7 Limitations 已声明"不保证未来 adapter 语义完美"。

### F8 [info] serviceSurface 原因优先级
- `mapServiceSurfaces`（acceptance-harness.ts:680-700）：`not_enumerated` 优先于 `unassembled`，两者皆存的 surface 只报前者。诚实性不受影响（status 恒 uncovered、countsAsRouteCoverage 恒 false，类型层钉死 `0`）。

### F9 [info] `withCleanStdout` 全局替换 `process.stdout.write`
- acceptance-harness.ts:868-886：finally 中恢复并把噪声重放 stderr；单进程单 run 的 CLI 契约下安全，若未来同进程并发运行 harness 会串扰（当前无此用法）。

## 5. 命令与退出码汇总

| # | 命令（要点） | 退出码 |
| --- | --- | --- |
| 1 | `git rev-parse HEAD` | f0520524…（匹配） |
| 2 | manifest `shasum -a 256 -c`（14 文件） | 0 |
| 3 | package 7 文件三方哈希比对（python） | 全 OK |
| 4 | `lsof -i :55444/:45435/:45436` | 空闲 |
| 5 | `docker run … openbot-i6r2-mt131-pg … :55444`（pgvector/pgvector:pg16，见偏差 1） | 运行 OK |
| 6 | `cd server && bun scripts/enterprise-test-db.ts migrate`（env A；postgres:16 首试 = 1，pgvector = **0**） | **0** |
| 7 | 角色验证（pg_roles/pg_auth_members） | 3 LOGIN+3 capability+1 identity_operator，单一 membership，150 表 |
| 8 | `OPENBOT_MT131_HARNESS_PORT=45436 bun test server/tests/multitenancy/acceptance-harness.test.ts`（env A：55444/`…_review`） | **1**（12 pass / 2 fail → F1） |
| 9 | 容器 B `openbot-i6r2-mt131-pg-b` @55434/`…_test` + migrate | 0 |
| 10 | 同命令（env B） | **0**（14 pass / 0 fail / 1713 expect()） |
| 11 | `cd server && bun run typecheck` | 0 |
| 12 | `bunx biome check <harness.ts> <harness.test.ts>` | 0 |
| 13 | `bun server/scripts/multitenancy/acceptance-harness.ts --out … --run-id r2rev01`（env B） | 0（acceptance-not-passed，0/539，poison detected） |
| 14 | fixture 残留行检查（enterprise_* 全表 count） | 全 0 |
| 15 | `docker rm -f` 两容器；删除两个 0600 env 文件与 scratch | 完成，端口复查空闲 |

无 skipped / 无 blocked；两次套件运行均为真实执行（A 失败属 finding F1 的证据，非环境阻塞）。

## 6. 约束遵守声明

- 只读被审文件与前置；`git status` 与复审前一致（本报告外零新增/修改）。
- 无 commit / push / merge / 生产迁移 / 部署；migrate 仅运行在复审自建的一次性容器内（`--rm`，无持久卷）。
- 凭据治理：环境文件 0600、内容全程未打印、密码随机生成、用后已删；日志/测试输出经密码泄漏扫描后才展示；报告 isolation 块无 URL/凭据（实测 grep 0 命中）。
- 与实现者无共享会话、未复用其容器（`openbot-i6-mt131-test-pg`/55434 当时空闲，B 容器为本复审自建并已删）、未自批。
