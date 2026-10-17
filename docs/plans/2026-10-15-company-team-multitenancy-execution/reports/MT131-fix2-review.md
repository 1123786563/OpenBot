# MT131-fix2 / Issue #174 — 修复轮独立复审报告（review of fix2）

- Reviewer：全新独立 Pi 复审 worker（Task `task_55e77d116928` / Dispatch `ctx_2b71de398106`），与修复实现者（Task `task_23bb940e29e7`）、原实现者（`task_9b95a3b8cb96`）、原复审者均无共享会话，未复用任何先前会话、容器、端口或凭据。
- 工作树：`/Users/wuyongjun/orca/workspaces/OpenBot/i6-review2-mt131`；`git rev-parse HEAD` = `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`，与 `checkpoints/MT131/fix2-review-sha256-manifest.txt` 首行一致。
- 本工作树内唯一由本次复审新建的文件即本报告；被审文件与前置文件零改动。无 commit / push / merge。

## 0. Verdicts（两个独立结论）

| 结论 | 判定 |
| --- | --- |
| **修复有效性（F1/F2 Medium 真实关闭、F3/F4 Low 处置得当、无回归）** | **PASS**（证据见 §3–§5） |
| **Code quality（修复后整体）** | **PASS WITH FINDINGS** — 0 critical / 0 high / 0 medium / 1 low / 2 info（见 §6） |

无 skipped、无 blocked 项。所有复跑均为真实执行并记录退出码。

## 1. 快照与完整性核验（先做，全部通过）

1. `git rev-parse HEAD` → `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（= `fix2-review-sha256-manifest.txt` 首行）。
2. 该 manifest 16 个文件逐条 `shasum -a 256` 复算 → **16/16 OK**（含修复后两个被审文件 `33f24c24…`/`18717a1b…`、MT001/MT002 五个前置文件、三份报告、brief 与 `checkpoints/MT131-fix2/**` 五件产物）。
3. `git status --porcelain` 仅含清单内 untracked 目录（`docs/plans/2026-10-15-company-team-multitenancy-execution/`、`server/scripts/multitenancy/`、`server/tests/multitenancy/`），无 tracked 修改。
4. `checkpoints/MT131-fix2/before.json`：修复前两文件哈希 `2b29aeb6…`/`df6f6f31…` 与当前磁盘不同 → 改动真实发生；`after.json` 哈希 = 磁盘 = fix2 manifest，三方一致；`review-package.json` 2 文件哈希逐一复算 OK，`source_head` = 实际 HEAD。
5. **MT001/MT002 未动（回归判据 1）**：`inventory.ts`、`inventory.test.ts`、`fixture.ts`、`scenarios.ts`、`fixtures.test.ts` 五个前置文件的当前哈希同时匹配两条独立链——fix2-review manifest 与原复审轮 `checkpoints/MT131/after-manifest-sha256.txt`，且与 `before.json.prerequisites_untouched` 一致。
6. 说明（info 级，见 §6-F3R）：brief / before.json / fix2 报告引用的 `checkpoints/MT131/fix2-transfer-manifest.txt` 在本工作树（乃至本机）不存在——该文件只留在修复实现者工作树。修复前哈希经 `before.json` + `diff.patch` + coordinator 提供的 fix2-review manifest 三方可完整交叉验证，**不构成核验缺口**，仅是产物引用路径断链。

## 2. 独立复跑记录（亲自执行，含退出码）

### 2.1 环境自建（全部用后即删）

- 端口预检：`lsof -i :55451 -i :45435` → 空闲（exit 1，无监听）。
- 容器：`docker run --rm -d --name openbot-i6r2-mt131fix2-pg -e POSTGRES_DB=openbot_enterprise_mt131fix2_review -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55451:5432 pgvector/pgvector:pg16` → 就绪（按 review2 F5 纠偏直接使用 pgvector 镜像，未重蹈 plain postgres:16 缺 vector 扩展的 migrate 失败）。
- 环境文件 `/tmp/mt131fix2-review-env.sh`：`-rw-------`（0600），4 组 `openssl rand -hex 24` 随机密码，**内容全程未打印**（仅输出权限位与行数 5）；用后已删（`ls` → No such file）。
- 受控 migrate：`cd server && bun scripts/enterprise-test-db.ts migrate` → **exit 0**，`{"type":"migrations-applied","status":"ok"}`。
- 角色实测（psql 查 pg_roles/pg_auth_members，仅输出角色名）：`ent_rv2dir/ent_rv2data/ent_rv2op` 三个 LOGIN（`super=false createrole=false`），各自恰好挂一个 NOLOGIN capability（`ob_ent_directory/ob_ent_data/ob_ent_operator`），另有 `ob_ent_identity_operator`；public schema **150 张表**——与受控 setup 形态一致。
- 本复审环境（55451 / `openbot_enterprise_mt131fix2_review` / `ent_rv2*`）与原实现者（55434/`…_mt131_test`）、修复实现者（55447/55448/`…_mt131fix2*_test`/`ent_fx2*`）**三方互不相同**，因此本次全绿即是 F1 环境无关性的第三方直接证据。

### 2.2 测试套件（F1 直接证据）

`source /tmp/mt131fix2-review-env.sh && cd server && bun test tests/multitenancy/acceptance-harness.test.ts`

| 项 | 结果 |
| --- | --- |
| 结果 | **17 pass / 0 fail / 1730 expect()** |
| 退出码 | **0** |
| 与修复报告对照 | 17/1730 与其 GREEN（环境 A/B）逐项一致，且本环境库名/端口/角色与前两者完全不同 |

3 个新增测试均在我环境实跑通过：`refuses harness-owned control scenarios as business evidence`、`uses its temp directory for run-scoped metadata`、`refuses CLI flags given without a value`。
`grep -n "\.skip\|\.only\|\.todo"` 于测试文件 → **0 命中**（回归判据 3 之一：无新增跳过）。

### 2.3 全量回归与静态检查

| # | 命令 | 退出码 |
| --- | --- | --- |
| 1 | `bun test tests/multitenancy/`（fixtures + harness + inventory 三文件） | **0**（**67 pass / 0 fail / 6964 expect()**，与修复报告运行 5 一致） |
| 2 | `cd server && bun run typecheck`（tsc --noEmit） | **0** |
| 3 | `bunx biome check scripts/multitenancy/acceptance-harness.ts tests/multitenancy/acceptance-harness.test.ts` | **0**（Checked 2 files, No fixes applied） |

### 2.4 F2 结构性复验：拒绝先于端口绑定/自检

用 Python 在 `127.0.0.1:45435` 先挂一个哑监听器（占位），再运行 CLI 并喂入含控制域引用的业务 evidence plan：

```
plan: {"GET /api/passwords": {"positive": {"domain": "full-coverage",
        "scenarioId": "harness.control.clean-observation"},
       "denial": {"domain": "bots", "scenarioId": "harness.control.identity"}}}
→ exit 1, stderr 尾行：
HARNESS_RUN_FAILED:HARNESS_EVIDENCE_PLAN_INVALID:GET /api/passwords:positive:
  harness control domain full-coverage is reserved for harness-internal self-checks
```

**关键判读**：端口被占时若校验滞后于绑定，应报 `HARNESS_PORT_UNAVAILABLE`；实际报的是 plan 拒绝 → **拒绝发生在端口绑定之前**（自检更在其后，代码顺序亦为 `validateEvidencePlan` :827 → `startHarnessHttpStatus` :829 → `runPositiveControl` :833，两证据互相印证）。

- 变体 2（`harness.` 前缀 + 外域 `bots`）：`→ exit 1, HARNESS_EVIDENCE_PLAN_INVALID:…positive:harness-prefixed scenarioId is reserved…` ✓
- F3 复验：`--evidence`（尾随无值）`→ exit 1, HARNESS_RUN_FAILED:HARNESS_FLAG_MISSING_VALUE:--evidence` ✓
- 观察项（非缺陷）：`--out --run-id rv2f3` → `exit 1, HARNESS_FLAG_UNKNOWN:rv2f3`（tokenizer 语义，见 §6-F1R）。

### 2.5 CLI 全流程与 F4 复验

`bun scripts/multitenancy/acceptance-harness.ts --out /tmp/... --run-id rv2rev01`（本复审环境）→ **exit 0**：

- `overall=acceptance-not-passed`、`covered 0/539`、`self-check passed`、poison `detected`（reasons `leaked-records:1, denied:false`）——**诚实不合成通过，语义未放松**（回归判据 2）。
- `isolation`：`databaseName=openbot_enterprise_mt131fix2_review`、`databasePort=55451`、`httpPort=45435` —— 报告如实反映**我的**环境（F1 语义一致性的运行时佐证）。
- **F4**：`${tempDir}/run-metadata.json` 存在，键 = `harness/isolation/runId/schemaVersion/startedAt`，`runId=rv2rev01`、db 名与端口正确。
- 泄密扫描（报告 + 元数据全文）：`postgres://` 0 命中、`ent_rv2` 0 命中；`password` 9 命中全部为 `/api/passwords` 路由路径；`55451` 仅为端口号字段。**无凭据泄漏**。

### 2.6 清理与终态

- `docker rm -f openbot-i6r2-mt131fix2-pg` → 容器已删；`lsof :55451 :45435` 复查空闲。
- 0600 env 文件、plan JSON、CLI 输出目录、psql 计数脚本全部删除。
- fixture 残留实证：对容器内 public 全部 150 表逐表 `count(*)` → **nonzero_tables=0**（dispose 后零残留）。
- `git status --porcelain` 与复审前一致（原 3 个 untracked 目录 + 本报告）。

## 3. F1 [medium→已关闭] 环境断言推导化

- 代码证据：测试文件新增 `realSetupDatabaseUrl()`（按 `ENTERPRISE_TEST_SETUP_DATABASE_URL ?? TEST_DATABASE_URL` 解析本进程环境，缺失即响亮抛错）与 `databaseNameOf()`（URL 单一 decode 路径段）两个**测试侧独立 helper**（不调用被测内部函数，避免同义反复）；原 `:122/:124/:302` 三处硬编码断言（diff `-` 行可见）改为 `isolation.databaseName === databaseNameOf(setupUrl)` + `/^openbot_enterprise_/` 前缀不变量、`databaseHost === setupUrl.hostname`、`databasePort === Number(setupUrl.port) || 5432`。
- 残留字面量核查：`openbot_enterprise_mt131_test`/`55434` 仅剩 `CONSISTENT_FAKE_ENV`（纯解析 fake，不拨号）与负例输入（非环回主机、角色库不一致）——均为**解析用输入**而非对 `REAL_ENV` 的断言，与 review2 F1 建议原样吻合。`httpPort === 45435` 断言针对 harness 自有常量（非环境值），维持原状。
- **运行证据**：§2.2 —— 第三方环境（与两名前实施者均不同）17/17 全绿，exit 0。原 F1 失败模式（外来环境 12/14）不可能复现。
- **判定：真实关闭，且未引入放松**（推导断言比原硬编码更严格：新增了库名命名空间前缀不变量）。

## 4. F2 [medium→已关闭] 控制域证据隔离（只收紧）

- 代码证据：`validateEvidencePlan`（acceptance-harness.ts:384-444）对每个业务 evidence ref 在既有 `ISOLATION_DOMAINS`/scenarioId 非空校验之后追加两条拒绝——`ref.domain === HARNESS_CONTROL_DOMAIN`（错误信息含保留语义说明）与 `ref.scenarioId.startsWith("harness.")`（任何域，含业务自建域），错误码延续 `HARNESS_EVIDENCE_PLAN_INVALID` 家族；`EvidencePlan` JSDoc 写明 reserved 语义。
- 顺序证据：§2.4 占端口实验 + 代码调用序（:827 → :829 → :833）双重证明拒绝先于端口绑定与自检。
- 内部自检不受影响：`runPositiveControl`/环境检查（:569-:641）直接经 `runIsolationScenario` 使用控制场景，不经 `validateEvidencePlan`；我的 CLI 运行 `self-check passed` + poison `detected` 即内部控制完好的直接证据。
- **只收紧不放松**：此前「控制场景刷 covered」的永真通路被结构性封死；除此之外无任何既有合法 plan 形态被新拒绝（67/67 既有+新增用例全绿为证）；业务 plan 引用未注册场景仍落 `scenario-error → uncovered`（failsafe 未变）。
- **判定：真实关闭。**

## 5. F3/F4 [low→处置得当] 与回归判据

- **F3 关闭**：`parseFlags` 三旗标取值 `undefined`（尾随）时抛 `HARNESS_FLAG_MISSING_VALUE:<flag>`（diff 可见三处同构改动）；我实测 `--evidence` 尾随 → exit 1 + 精确错误码；套件内 3 生成进程测试（`--out`/`--evidence`/`--run-id`）全过。缺环境时仍响亮失败、无静默降级。
- **F4 关闭（选择「实际使用」）**：`mkdir` 后写 `${tempDir}/run-metadata.json`（schemaVersion/harness/runId/startedAt/isolation），写失败抛 `HARNESS_TEMPDIR_UNAVAILABLE:<tempDir>:<原因>`；我 CLI 实测文件存在、字段正确、全文无凭据；与修复报告 §1-F4 的处置说明（含「目录仍为运行期状态、可随时删除」）完全一致。
- **回归判据逐条**：
  1. MT001/MT002 文件未动 —— §1.5 双哈希链验证 ✓
  2. 「绝不合成通过」语义未放松 —— CLI `0/539 + acceptance-not-passed`、F2 仅封死非法绿色通路、缺侧仍 `missing/uncovered` ✓
  3. 既有用例全过 —— 67 pass / 0 fail（含 MT001 inventory、MT002 fixtures 全套）✓
- **TDD 证据真实性**：修复报告披露四个 finding 均无首跑即绿——F1 RED（旧断言外来环境 2 fail）与 review2 的独立观测（12 pass/2 fail@55444）同构且 diff `-` 行即旧断言；F2/F3/F4 RED = 3 个新测试在未改 harness 上失败，而 diff 显示对应 harness 改动恰为使三者转绿的最小新增（控制域拒绝 / 缺值抛错 / writeFile 元数据）。RED→GREEN 链条与 before/after 哈希、报告运行表完全自洽，判定真实。
- 报告/检查点完整性：`before.json`/`after.json`/`diff.patch`/`review-package.json`/`sha256-manifest.txt` 齐备且互相一致（§1.4）。

## 6. Code quality — 分级 findings（本复审新增，全部仅记录、未修复）

**严重度计数：0 critical / 0 high / 0 medium / 1 low / 2 info。** 修复本身未引入任何 medium 及以上问题。

### F1R [low] CLI 旗标 tokenizer 会把下一个 `--*` 旗标吞作取值
- 证据：实测 `--out --run-id rv2f3` → `flags.out="--run-id"`（`--out` 后的 `index += 1` 无条件取下一 token），随后 `rv2f3` 报 `HARNESS_FLAG_UNKNOWN`（exit 1）。行为仍是响亮失败、诚实性无损，且属**改动前既有语义**（diff 中 `index += 1` 原已存在，本轮只补了 `undefined` 分支），故不算回归。
- 影响：错误 surfaced 在错误的旗标上，排障时略误导；`--out --pretty` 类组合会把 `--pretty` 当文件名（随后 unknown 下一 token）。
- 建议（未实施）：取值前若下一 token 以 `--` 开头则按缺值处理（抛 `HARNESS_FLAG_MISSING_VALUE`），或在 MT131-harness.md 注明旗标取值可为任意 token。

### F2R [info] run-metadata 写入先于 evidence plan 校验
- 证据：`runAcceptanceHarness` 顺序为 resolve → mkdir+writeFile（:798-816）→ buildInventory → `validateEvidencePlan`（:827）。被拒绝的 plan 仍会留下一个含 `run-metadata.json` 的 tempDir 孤儿目录。
- 影响：无（目录本就是可随时删除的运行期状态，拒绝路径 exit 1 不产生报告）；若日后在意 TMPDIR 洁净度，可把写入移到 plan 校验之后。

### F3R [info] `fix2-transfer-manifest.txt` 引用断链
- 证据：fix2 报告 §5、`before.json.transfer_manifest` 与本任务 brief 均引用 `checkpoints/MT131/fix2-transfer-manifest.txt`，该文件在本工作树与本机均不存在（find 全盘 0 命中）——它只留存在修复实现者工作树 `i6-mt131-fix2` 中，未随检查点转移。
- 影响：无核验缺口（§1.5-1.6 已用 manifest + before.json + diff.patch 三方交叉补齐）；仅是移交物清单与实际产物的不一致，建议后续轮把转移清单本体纳入 `checkpoints/`。

### F4R [info]（沿承 review2 F7/F8/F9，未变化）
原复审的 info 级观察（正侧不消费 `denied`、serviceSurface 原因优先级、`withCleanStdout` 全局替换）在 diff 范围外，逐条比对后确认本轮未触碰、语义未变，继续以 info 持有。

## 7. 命令与退出码汇总

| # | 命令（要点） | 退出码 |
| --- | --- | --- |
| 1 | `git rev-parse HEAD` | f0520524…（= manifest 首行） |
| 2 | fix2-review manifest 16 文件 SHA-256 复算 | 16/16 OK |
| 3 | `lsof -i :55451 -i :45435` | 空闲（exit 1） |
| 4 | `docker run … pgvector/pgvector:pg16 … :55451` | 运行 OK |
| 5 | `bun scripts/enterprise-test-db.ts migrate` | **0** |
| 6 | 角色验证（pg_roles/pg_auth_members，仅角色名） | 3 LOGIN + 3 capability + identity_operator，150 表 |
| 7 | `bun test tests/multitenancy/acceptance-harness.test.ts` | **0**（17 pass / 0 fail / 1730 expect()） |
| 8 | `bun test tests/multitenancy/` | **0**（67 pass / 0 fail / 6964 expect()） |
| 9 | `bun run typecheck` | **0** |
| 10 | `bunx biome check <两文件>` | **0** |
| 11 | 占用 45435 + CLI `--evidence <控制域 plan>` | **1**，`HARNESS_EVIDENCE_PLAN_INVALID…control domain`（非端口错误 → 拒绝先于绑定） |
| 12 | CLI `--evidence <harness. 前缀 plan>` | **1**，`HARNESS_EVIDENCE_PLAN_INVALID…harness-prefixed` |
| 13 | CLI `--evidence`（尾随） | **1**，`HARNESS_FLAG_MISSING_VALUE:--evidence` |
| 14 | CLI `--out --run-id rv2f3` | **1**，`HARNESS_FLAG_UNKNOWN:rv2f3`（§6-F1R 观察项） |
| 15 | CLI 全流程 `--out … --run-id rv2rev01` | **0**（acceptance-not-passed，0/539，self-check passed，poison detected） |
| 16 | run-metadata.json 存在性 + 泄密扫描 | 存在；`postgres://`/`ent_rv2` 0 命中 |
| 17 | fixture 残留（150 表逐表 count） | nonzero_tables=0 |
| 18 | `docker rm -f` + 删 0600 env 文件 + 端口复查 | 完成，端口空闲 |

## 8. 约束遵守声明

- 只读被审文件与全部检查点；除本报告外零新建/修改，`git status` 与复审前一致。
- 无 commit / push / merge / 生产迁移 / 部署；migrate 仅运行于复审自建的一次性容器（`--rm`，无持久卷，用后已删）。
- 凭据治理：env 文件 0600、密码随机生成且全程未打印、用后已删；所有输出经泄漏扫描（`postgres://`/`ent_rv2`/`password`）后才纳入本报告。
- 与修复实现者、原实现者、原复审者均无共享会话；容器/端口/库名/角色/密码全部独立自建且互不重叠。
