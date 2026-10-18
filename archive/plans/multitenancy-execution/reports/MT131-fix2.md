# MT131-fix2 / Issue #174 — 修复轮报告（关闭复审 F1/F2，附带 F3/F4）

- 修复实现者：独立 Pi worker（Task `task_23bb940e29e7` / Dispatch `ctx_f2b1f182bcd7`），与原实现者（`task_9b95a3b8cb96`）和复审者（`task_64f9f515ebb` 所在复审任务）均无共享会话。
- 工作树：`/Users/wuyongjun/orca/workspaces/OpenBot/i6-mt131-fix2`；`git rev-parse HEAD` = `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`，与 `checkpoints/MT131/fix2-transfer-manifest.txt` 首行一致（派发前言中的 `…a69c8…` 为转写笔误，以 manifest/实际 HEAD 为准）。
- 转移完整性：`acceptance-harness.ts` = `2b29aeb63be347883a997de765da75676e883b7219b8d09a5184ae75c3fa1390`、`acceptance-harness.test.ts` = `df6f6f31dfa0e9b61e32ca55fee2f715917ab891281aec969b6d37eb8fd92a12`，逐字节复算与 manifest 一致后才动第一行代码。
- 本轮新建/修改仅限授权文件：两个被修复文件 + 本报告 + `checkpoints/MT131-fix2/**`；MT001/MT002 交付文件与共享 support 零改动（`git status --porcelain` 仅含原有 3 个 untracked 目录）。

## 0. 结论

| 复审 finding | 状态 | 关闭方式 |
| --- | --- | --- |
| F1（medium）测试硬编码实现者私有环境常量 | **已关闭** | 断言改为从 `REAL_ENV` 独立解析推导；两个不同合规专用环境（A/B）套件均 17/17 全绿 |
| F2（medium）控制域场景可作业务证据永真预言机 | **已关闭（只能收紧）** | `validateEvidencePlan` 拒绝 `HARNESS_CONTROL_DOMAIN` 与 `harness.` 前缀 scenarioId；控制场景仅限 harness 内部自检 |
| F3（low）CLI 旗标缺值静默降级 | **已关闭** | 缺值抛 `HARNESS_FLAG_MISSING_VALUE` |
| F4（low）tempDir 创建但从未使用 | **已关闭（选择"实际使用"）** | 每次运行写入 `run-metadata.json`（无凭据），写失败抛 `HARNESS_TEMPDIR_UNAVAILABLE` |

无提交/推送/合并；检查点与 SHA-256 清单未提交（无授权）。

## 1. 修复内容（逐 finding）

### F1 — 测试断言环境推导化（`acceptance-harness.test.ts`）

- 新增测试侧独立解析 helper（不调用实现内部函数，避免同义反复）：`realSetupDatabaseUrl()` 按 `ENTERPRISE_TEST_SETUP_DATABASE_URL?.trim() 优先、否则 TEST_DATABASE_URL` 取得本进程环境指向的专用库 URL；`databaseNameOf(url)` = 去首斜杠后的单一 decode 后路径段。
- 原 `:122`（`databaseName === "openbot_enterprise_mt131_test"`）、`:124`（`databasePort === 55434`）改为：
  - `isolation.databaseName === databaseNameOf(setupUrl)` 且 `/^openbot_enterprise_/`；
  - `isolation.databaseHost === setupUrl.hostname`；
  - `isolation.databasePort === Number(setupUrl.port) || 5432`。
- 原 `:302`（报告里的 `isolation.databaseName` 同款硬编码）同样改为推导断言 + 前缀校验。
- `CONSISTENT_FAKE_ENV`（纯解析 fake，不拨号）按复审建议原样保留；`httpPort === 45435` 等断言针对 harness 自有常量（非环境值），保留不变。
- 语义：断言目标从"某台机器的常量"变为"本进程环境实际指向的值 + 企业测试库名命名空间不变量"。

### F2 — 控制域证据隔离（`acceptance-harness.ts` `validateEvidencePlan`）

- 每个业务 evidence ref 在既有校验之后追加两条拒绝（错误码延续 `HARNESS_EVIDENCE_PLAN_INVALID` 家族）：
  - `ref.domain === HARNESS_CONTROL_DOMAIN` → `…:harness control domain full-coverage is reserved for harness-internal self-checks`；
  - `ref.scenarioId` 以 `harness.` 开头（任何域，含业务自建域）→ `…:harness-prefixed scenarioId is reserved for harness-internal self-checks`。
- 拒绝发生在端口绑定、自检与任何场景执行之前；`EvidencePlan` JSDoc 写明保留语义。校验只会比原来更严：无任何既有合法 plan 形态被新增拒绝（全量既有测试通过为证），「绝不合成通过」语义未放松——此前能靠控制场景刷成 `covered` 的通路被结构性封死（RED 阶段实证见 §2）。

### F3 — `parseFlags` 缺值显式失败

- `--out` / `--evidence` / `--run-id` 取值为 `undefined`（旗标位于 argv 末尾）时抛 `HARNESS_FLAG_MISSING_VALUE:<flag>`；未知旗标的 `HARNESS_FLAG_UNKNOWN` 行为不变。经 CLI 进程级测试验证（空 env 生成进程，失败快、无数据库副作用）。

### F4 — tempDir 实际使用（选择"用起来"而非删 mkdir）

- 选择理由：`tempDir` 字段已进入报告 isolation 契约与文档 schema（MT131-harness.md 非本轮拥有文件，删字段会让文档失真），且命名空间目录本来就是"运行期专属状态"的承诺位置——写入 run 元数据使其名实相符，比删除更闭合。
- 实现：`mkdir` 后写 `${tempDir}/run-metadata.json`，内容 = `{schemaVersion, harness, runId, startedAt, isolation}`（isolation 块本就无 URL/密码，实测见 §4）；写失败抛 `HARNESS_TEMPDIR_UNAVAILABLE:<tempDir>:<原因>`，不静默降级隔离契约。目录仍为运行期状态、可随时删除（文档语义不变）。

## 2. TDD 证据（RED → GREEN，全部真实执行）

环境 A：一次性容器 `openbot-i6-mt131fix2-pg`（`pgvector/pgvector:pg16`，`127.0.0.1:55447`，`POSTGRES_DB=openbot_enterprise_mt131fix2_test`，trust）；env 文件 `/tmp/mt131fix2-env.sh`（0600，随机 hex 密码，内容全程未打印）；`enterprise-test-db.ts migrate` exit 0；角色实测 `ent_fx2_dir/data/op` 三 LOGIN + `ob_ent_*` capability，public 150 表。端口预检 `lsof -i :55447/:55448/:45435` 全空闲。

| # | 阶段 | 命令要点 | 结果 | 退出码 |
| --- | --- | --- | --- | --- |
| 1 | **RED（F1）** | 原测试文件（改动前）@ 环境 A | **12 pass / 2 fail / 55 expect()**，失败在 `:122`（isolation.databaseName 硬编码）与 `:302`（report.isolation.databaseName），Received `openbot_enterprise_mt131fix2_test` | **1** |
| 2 | **RED（F2/F3/F4）** | 测试文件加入 F1 推导断言 + F2/F3/F4 新测试，harness 未改，@ 环境 A | **14 pass / 3 fail / 1718 expect()**：F2 测试中控制域 plan 被**接受并完整跑通管线**（永真预言机实证）；F4 测试 `ENOENT …/openbot-mt131-harness/<runId>/run-metadata.json`；F3 测试 stderr 无 `HARNESS_FLAG_MISSING_VALUE` | **1** |
| 3 | **GREEN（F1-F4）** | harness 三处修复后，@ 环境 A | **17 pass / 0 fail / 1730 expect()** | **0** |
| 4 | **环境无关性** | 第二组一次性容器 `openbot-i6-mt131fix2-pg-b`（`127.0.0.1:55448`，`openbot_enterprise_mt131fix2b_test`，独立登录 `ent_fx2b_*` 与独立随机密码，migrate exit 0），同命令 @ 环境 B | **17 pass / 0 fail / 1730 expect()** —— F1 修复的直接证据：不同库名/端口/角色的合规专用环境全绿 | **0** |
| 5 | 回归 | `bun test server/tests/multitenancy/`（fixtures + harness + inventory 三文件）@ 环境 A | **67 pass / 0 fail**，MT001/MT002 回归不受影响 | **0** |
| 6 | 静态 | `cd server && bun run typecheck` | tsc --noEmit 无输出 | **0** |
| 7 | 静态 | `bunx biome check scripts/multitenancy/acceptance-harness.ts tests/multitenancy/acceptance-harness.test.ts` | Checked 2 files, No fixes applied | **0** |
| 8 | CLI | `bun server/scripts/multitenancy/acceptance-harness.ts --out /tmp/mt131fix2-cli/report.json --run-id fx2cli01 --pretty` @ 环境 A | exit 0；`overall=acceptance-not-passed`、`covered 0/539`、self-check passed、`seedPoison.detected=true`（诚实不合成通过）；`…/openbot-mt131-harness/fx2cli01/run-metadata.json` 存在且 runId/db 名/端口正确；报告与元数据全文 `postgres://` 0 命中、`ent_fx2` 0 命中、`password` 0 命中 | **0** |

诚实披露：无首跑即绿项——四个 finding 均有各自 RED 失败记录（F1 的 RED 即改动前原文件在环境 A 的 2 fail；F2/F3/F4 的 RED 为新增测试在未改 harness 上的 3 fail）。

## 3. Finding → 改动 → 测试映射

| Finding | harness.ts 改动 | test.ts 改动 | 直接证据 |
| --- | --- | --- | --- |
| F1 | 无（实现本就正确解析环境） | `:122/:124/:302` 推导化 + `realSetupDatabaseUrl`/`databaseNameOf` helper | 运行 1（2 fail）→ 运行 3/4（两环境 0 fail） |
| F2 | `validateEvidencePlan` 两条保留域拒绝 + JSDoc | 新测试「refuses harness-owned control scenarios as business evidence」（控制域 + 外域 `harness.` 前缀两断言） | 运行 2（plan 被接受）→ 运行 3/4（拒绝） |
| F3 | `parseFlags` 三旗标缺值抛 `HARNESS_FLAG_MISSING_VALUE` | 新测试「refuses CLI flags given without a value」（`--out`/`--evidence`/`--run-id` 三生成进程） | 运行 2 → 运行 3/4 |
| F4 | `runAcceptanceHarness` 写 `run-metadata.json` + `HARNESS_TEMPDIR_UNAVAILABLE` | 新测试「uses its temp directory for run-scoped metadata」（存在性、字段、无凭据、清理） | 运行 2（ENOENT）→ 运行 3/4 + CLI 实测（运行 8） |

## 4. 凭据与资源治理

- 两组 env 文件均 0600、密码 `openssl rand -hex 24` 生成且从未打印（生成、写入、unset 全程无回显）；验证只输出行数与权限位。
- 测试/CLI 输出与报告经泄漏扫描：`postgres://`、`ent_fx2`、`password` 全部 0 命中后才纳入本报告。
- 用后清理：容器 `openbot-i6-mt131fix2-pg`、`openbot-i6-mt131fix2-pg-b` 已 `docker rm -f`；`/tmp/mt131fix2-env.sh`、`/tmp/mt131fix2b-env.sh` 及全部 scratch（before 快照、日志、CLI 输出）已删除；`lsof` 复查 55447/55448/45435 复归空闲。镜像按复审 F5 纠偏使用 `pgvector/pgvector:pg16`（plain postgres:16 缺 vector 扩展会 migrate 失败）。

## 5. 约束遵守声明

- 只动授权文件：`server/scripts/multitenancy/acceptance-harness.ts`、`server/tests/multitenancy/acceptance-harness.test.ts`、`reports/MT131-fix2.md`（本文件）、`checkpoints/MT131-fix2/**`；MT001/MT002 交付文件与共享 support 哈希不变（对 `checkpoints/MT131/fix2-transfer-manifest.txt` 可复算验证，本轮已实测 5/5 OK）。
- 「绝不合成通过」语义未放松，只收紧（F2）；无 skip/only/todo 引入；缺环境仍响亮失败。
- 无 commit / push / merge / 生产迁移 / 部署；migrate 仅运行在本轮自建的一次性容器（`--rm`，无持久卷）。
- 产物：`checkpoints/MT131-fix2/`（before.json / after.json / diff.patch / review-package.json / sha256-manifest.txt），全部未提交。

## 6. 移交说明（给下一轮独立复审者）

1. 校验 `checkpoints/MT131-fix2/sha256-manifest.txt` 与 `review-package.json` 中的哈希；基线对照 `checkpoints/MT131/fix2-transfer-manifest.txt`（前两文件旧值 `2b29aeb6…`/`df6f6f31…` 应仅存在于 before.json/diff 侧）。
2. 复跑只需任一合规专用环境（任意空闲 loopback 端口 + `openbot_enterprise_<你的名字>_test` 库 + pgvector 镜像 + 45435 空闲）：套件断言已环境推导化，你的库名/端口不会再导致失败（这正是 F1 关闭的验收方式）。
3. F2 复验可用最小 JSON plan（`{"GET /x": {"positive": {"domain": "full-coverage", "scenarioId": "harness.control.clean-observation"}}}` 经 `--evidence`）确认 CLI 以 `HARNESS_EVIDENCE_PLAN_INVALID` 拒绝；F3 复验 `--out`（无值）确认 `HARNESS_FLAG_MISSING_VALUE`。
