# MT003-fix2 / Issue #46 — 修复轮独立复审报告（fix2-review）

- Reviewer：全新独立 Pi Reviewer（Orca Task `task_4d75316b5635` / Dispatch `ctx_8ee90c5fa0c3`）。与修复实现者（`task_63aeeec4713d` / `ctx_e985c1514a4a`）、原实现者（`task_60577e388d74`）、原复审者（`task_8ae36eaedbc7`）均无共享会话。
- 复审日期：2026-10-15。冻结 BASE：`f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（`git rev-parse HEAD` 实测，与 `checkpoints/MT003/fix2-review-sha256-manifest.txt` 首行一致）。
- 审阅方式：只读被审文件；唯一写入本报告；全部验证命令本人执行并记录退出码；无提交/推送/合并行为。

---

## 1. 快照与完整性核验（先做，全部通过）

- `git rev-parse HEAD` → `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` ✅（= manifest 首行）
- `checkpoints/MT003/fix2-review-sha256-manifest.txt` 逐文件 SHA-256 复算：**28/28 全部匹配**（两被修文件 after 哈希 `330524de…`/`cca6e35c…`、inventory 两文件、MT003/MT003-review2/MT003-fix2 三报告、brief、MT003-fix2 checkpoint 20 件）✅
- `git status --porcelain`：无任何 tracked 修改；untracked 共 37 个文件 = fix2 清单 28 项 + 原 MT003 轮产物 8 项 + 两个 manifest 文件自身（均属本工作流既有产物，无外来文件）✅
- 交叉核验：对照原轮 `checkpoints/MT003/review-sha256-manifest.txt`（12 项），仅 `migrate-test.ts` 与 `migration-tool.test.ts` 两项哈希不同——恰为修复轮声称改动的两个文件；`before.json` 记录的 before 哈希 `e00f90a4…`/`e004868a…` 与原轮 manifest 逐字一致，证明修复确实开工于已冻结的复审基线 ✅
- 复审全程结束后对两被审文件再次复算，哈希与 manifest 仍一致（未被复审过程污染）✅
- 限制：修复报告 §1 引用的 `fix2-transfer-manifest.txt` 不在本工作树（见 I3）；其锚定的 before 哈希已经由原轮 manifest 在本工作树独立复算成立，无完整性缺口。

## 2. Verdicts（两个独立结论）

| 结论 | 判定 | 摘要 |
| --- | --- | --- |
| 修复有效性（F1/F2 Medium 真实关闭、F3/F4 Low 处置得当、无回归） | **PASS** | F1/F2/F3/F4 均以代码 + 测试 + 本人独立复跑三重证据核实关闭；34 基线用例全数保留、TASKS 仍仅 MT000、安全拒绝零放宽（见 §3、§4、§7） |
| Code quality（修复后整体） | **PASS**（非阻塞 findings） | 0 critical / 0 high / 0 medium / 2 low / 3 info（见 §6）；修复风格与既有代码一致，无安全或正确性缺陷 |

## 3. 逐 Finding 关闭判定（独立复核，非转述报告）

**F1（medium）真实库集成测试端点硬编码 → 显式 env + 全安全检查：已关闭 ✅**
- 代码：专属库唯一来源为 `MT003_ASSIGNED_TEST_DATABASE_URL`（migration-tool.test.ts:979-995 区段）；显式配置时经与主路径**同一函数** `resolveTestDatabaseTarget` 全链校验（回环/fragment/单段库名/`openbot_enterprise_*` 前缀），被拒 = 模块级 `throw`（响亮失败，绝不降级为 skip）；未配置 = `test.skip` + 理由（env 名与要求）；断言全部改为从解析结果动态取值，端点/库名硬编码消失。
- 独立复现（本人在 **55450/openbot_enterprise_mt003fix2_review** 全新专属库，非实现者的 55446 端点——直接证明硬编码已消失）：**42 pass / 0 skip / 0 fail，exit 0（233 expect）**；原复审指出的「指定 URL 下结构性 33+1skip」不复存在。
- 负面证据独立复现：`MT003_ASSIGNED_TEST_DATABASE_URL=postgres://…@db.internal.example.com…` → 整套件 **exit 1**，消息含完整回环拒绝理由（安全检查与主路径共用）。
- 无 env 独立复现：**41 pass / 1 skip / 0 fail，exit 0**，skip 理由 = 「MT003_ASSIGNED_TEST_DATABASE_URL is not set; set it to a dedicated loopback openbot_enterprise_* test database…」。

**F2（medium）journal statement_digest 与当前计划漂移不可检测 → 已关闭 ✅**
- 代码：`readJournalEntries` SELECT `number, statement_digest`（42P01 仍视作空 journal）；新增 `validateJournalAgainstPlan` 先沿用编号前缀校验、再逐步骤比对 digest，漂移 reason 含步骤名、双侧 digest 前缀与「manual review is required; the tool never rewrites or replays already-journaled steps」；`runMigrate` 在 `connect` 后、dry-run/apply/up-to-date 分支前调用（migrate-test.ts:982-988）——三条路径全部经过检查。
- CLI 独立复现（psql 手工篡改 journal number=2 digest 为 `aaaa…`）：
  - dry-run → `refused (journal): …drifted apart — manual review is required…`，**exit 1**；
  - 携带**合法** manifest 的 apply → manifest 门禁通过后被 `refused (journal)`，**exit 1**（连接后、apply 前拒绝）；
  - 无自动修复：篡改后 journal 仍为 3 行、`aaaa…` 原样保留，无 UPDATE/DELETE/重放；
  - 还原 digest 后 dry-run exit 0、apply `up-to-date` exit 0——一致状态下无误伤（既有 up-to-date 语义保持）。
- 终态核验：journal 3 行 digest `66e51f…/852f77…/99e216…` 与计划/manifest 逐字一致（并与原复审 apply-lifecycle 记录一致）；`mt_tool_selfcheck` 已删除，无业务外残留对象。

**F3（low）`--manifest` 无 `--apply` 静默忽略 → 已关闭 ✅**
- 代码：`parseArgs` 新增 `manifestPath && !apply` → `refused(args)`（migrate-test.ts:513-518），消息说明 dry-run 会静默忽略 manifest 故拒绝。
- 独立复现：CLI `migrate MT000 --manifest <合法文件>` → `refused (args): --manifest requires --apply…`，**exit 1**；套件内新用例断言 refused(args) + 零副作用，通过。

**F4（low）拒绝路径不断言零读 → 已关闭 ✅**
- 代码：`expectNoSideEffects` 追加 `expect(effects.reads).toEqual([])`；新增元测试构造含 reads 的 effects 证明 helper 会抛错。
- 独立复现：元测试与全部既有拒绝用例（args/database-config 各路径）在强化 helper 下全过——证明当前拒绝路径确实零读。

## 4. 独立复跑记录（本人执行，含退出码）

| # | 命令 | 结果 / 退出码 |
| --- | --- | --- |
| 1 | `lsof -i :55450` | 空闲（exit 1 = 无监听） |
| 2 | `docker run --rm -d --name openbot-i6r2-mt003fix2-pg -e POSTGRES_DB=openbot_enterprise_mt003fix2_review -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55450:5432 pgvector/pgvector:pg16` | 容器启动，1s ready（pg_isready 通过） |
| 3 | `MT003_ASSIGNED_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55450/openbot_enterprise_mt003fix2_review bun test server/tests/multitenancy/migration-tool.test.ts`（全新库） | **exit 0，42 pass / 0 skip / 0 fail（233 expect）**——与实现者 green-F1-fresh 记录逐字一致 |
| 4 | 无该 env 同命令 | **exit 0，41 pass / 1 skip / 0 fail（216 expect）**，skip 理由正确 |
| 5 | 非法 env（非回环 host）同命令 | **exit 1**，整套件响亮失败 + 完整安全拒绝理由 |
| 6 | CLI 冒烟（`bun --no-env-file`，review 库重置后）：dry-run / generate --out / apply / re-apply | exit 依次 **0 / 0 / 0 / 0**；dry-run 3 步 4 语句、apply 3 步入账、re-apply `up-to-date` |
| 7 | 篡改 digest 的 manifest → apply | **exit 1**，`refused (manifest): manifest step 1 does not match plan step…`（连接前拒绝） |
| 8 | F3 CLI：`migrate MT000 --manifest <file>`（无 --apply） | **exit 1**，`refused (args)` |
| 9 | F2：psql 篡改 journal number=2 digest → dry-run / 合法 manifest apply | 均 **exit 1** `refused (journal)`；journal 未被改写（无自动修复） |
| 10 | 还原 digest → dry-run / apply | exit **0** / **0**（`up-to-date`）；终态 journal 3 行 digest 与计划一致、自检表已删 |
| 11 | `cd server && bun run typecheck` | **exit 0**（tsc --noEmit clean） |
| 12 | `bunx biome check scripts/multitenancy/migrate-test.ts tests/multitenancy/migration-tool.test.ts` | **exit 0**（Checked 2 files, No fixes applied） |
| 13 | `bun test server/tests/multitenancy/inventory.test.ts`（MT001 回归） | **exit 0，33 pass / 0 fail（5088 expect）** |
| 14 | `docker rm -f openbot-i6r2-mt003fix2-pg`；`lsof -i :55450` | 容器删除，端口复查无监听 |

工具版本：bun 1.4.2、pgvector/pgvector:pg16。全程按 brief 用后即删；环境无阻塞项。

## 5. TDD 证据真实性评估

- **RED 均真实且对应新测试**：red-F1（旧代码 + env → 仍 33 pass + 1 skip，skip 理由为旧硬编码 guard 文案，正是缺陷表现）；red-F2（`SyntaxError: Export named 'validateJournalAgainstPlan' not found`，功能缺失型 RED，exit 1）；red-F3（新用例在旧代码走到 `connect` 触发探针，栈指向旧 migrate-test.ts:928，即被修复的静默忽略行为）；red-F4（元测试 `Received function did not throw`，即旧 helper 对 reads 盲区）。
- **GREEN 与最终态可复现**：本人全新库 42 pass / 0 skip / 233 expect 与 green-F1-fresh 存档逐字一致；无 env 41+1skip / 216 expect 与 verify-final-no-env 一致。
- **诚实披露核验**：修复报告 §2-F2 披露的「GREEN 第一版传参类型错误、8 测试当场失败后修正」与 F2 行为测试密度（apply/dry-run/up-to-date 三路径 + 不自修复断言）相符；未发现声称不存在的 RED。
- **存档时序说明（见 L2）**：由 skip 文案可判定实际执行序为 F3 → F4 → F2 → F1 重写 → 终态验证（green-F2/F3/F4 仍带旧集成 guard 的 skip 文案）；每个 finding 内部 RED 先于 GREEN 成立，无完整性问题，仅报告 §2 的呈现顺序（F1→F2→F3→F4）易被误读为执行顺序。

## 6. Findings（分级；只报告，不修复）

### Low

- **L1（low，报告准确性）修复报告对 green-F2 存档的计数引用失实。** `reports/MT003-fix2.md` §2-F2 称「green-F2.txt **42 pass / 0 fail，exit 0**」，存档实际为 **41 pass / 1 skip / 0 fail**（该 skip 为无 env 时集成测试的合法显式跳过，exit 0 属实）。证据：`checkpoints/MT003-fix2/green-F2.txt` 末 5 行 vs 报告引文。不影响任何 verdict，但报告引用自身证据时应逐字准确。
- **L2（low，审计可追溯性）checkpoint 存档时序与报告 §2 呈现顺序不一致。** green-F2/F3/F4 的 skip 文案均为旧硬编码 guard（「TEST_DATABASE_URL is not the assigned MT003 test database 127.0.0.1:55433/…」），证明 F1 重写晚于 F2/F3/F4 的 GREEN（实际序：F3→F4→F2→F1→终态验证）。每个 finding 的 RED→GREEN 顺序成立，但按 §2 顺序阅读会重建出错误时间线；建议修复报告按实际执行序排列或在 §2 注明呈现顺序 ≠ 执行顺序。

### Info

- **I1（info）`validateJournalAgainstPlan` 对 `plan.steps[entry.number - 1]` 的越界安全性依赖调用顺序。** 安全性由「先 `validateJournalNumbers` 保证连续 1..n 前缀」隐式保证（migrate-test.ts:283-302）；未来若有人重排两步校验或单独调用 digest 比对，会产生 undefined-index 隐患。可选加一行显式防御，非必需。
- **I2（info）F1 的模块级 throw 会让非法 env 连非集成用例一起失败。** `MT003_ASSIGNED_TEST_DATABASE_URL` 配错时整套件 exit 1（本人在复现 #5 确认）。这正是「响亮失败、绝不降级」的设计意图且符合 brief，记录以提醒后续维护者该行为的波及面。
- **I3（info）修复报告引用的 `fix2-transfer-manifest.txt` 不在本工作树。** 其锚定的 before 哈希（`e00f90a4…`/`e004868a…`）已通过原轮 `checkpoints/MT003/review-sha256-manifest.txt` 在本工作树独立复算成立，无完整性缺口；仅指出引用链上有一个不在场的中间产物（与原复审 F9(c) 同类的跨工作树限制）。

### 原复审 Info 项（F5-F9）处置状态（非本轮必修）

F5（5 位编号不扫描）、F6（execution 与 refused 语义合并）、F7（.env 规避靠操作者自觉）为原轮已记录的实现层 info，本轮修复未触碰亦未恶化；F9(a) 的 docker 命令缺陷在本轮 brief 中已修正（补 `POSTGRES_HOST_AUTH_METHOD=trust`）；F9(b) 跨工作树哈希限制同样适用于本轮（I3）。原 F1/F2/F3/F4 → 全部关闭。

## 7. 回归判据核验

- **TASKS 仍仅 MT000**：`ALLOWED_TASK_IDS` 恰为 `["MT000"]` 断言通过（套件 criterion 3 首用例）；代码注册表仅 SELF_CHECK_TASK；未新增任何业务迁移。✅
- **34 pass 基线保留**：以 red-baseline 存档的 34 个用例名与本人终态 42-pass 输出做名字级 diff，唯一差异为集成测试自身 `(skip)→(pass)`（F1 预期效果）；34 个基线用例体全数保留且通过（新 8 用例 = F2×6 + F3×1 + F4 元测试×1）。✅
- **无安全拒绝被放宽**：criterion 1/2 全部既有拒绝用例原样通过；CLI 独立验证篡改 manifest / F3 / 非回环 env / journal 漂移拒绝路径全部 exit 1 且理由完整；F1 的 env 路径复用同一 `resolveTestDatabaseTarget`（非法 env 响亮失败已独立复现）——安全强度只增不减。✅
- **CLI 行为除 F3 收紧外不变**：dry-run 默认、generate 语义、apply 门禁、re-apply up-to-date、退出码语义均与原轮记录一致（含 digest `66e51f…/852f77…/99e216…` 逐字一致）。✅
- **MT001 回归**：inventory.test.ts 33 pass / 0 fail。✅

## 8. 结论

- **修复有效性：PASS**——F1（显式 env + 全安全检查 + 响亮失败 + 显式 skip）与 F2（journal digest 逐步骤比对、三路径覆盖、拒绝先行、无自动修复）在本人自建专属库（55450，非实现者端点）上独立复现关闭；F3/F4 处置得当；无任何回归。
- **Code quality：PASS（非阻塞）**——修复实现与既有风格一致（seam 复用、拒绝先行、零副作用断言、确定性输出）；2 low（L1 报告计数引用失实、L2 存档时序呈现）与 3 info 供后续跟进，均不影响本工单关闭。
- 复审过程零仓库文件改动（唯一新建本报告）；临时容器已删除、端口无残留；无提交/推送/合并行为。
