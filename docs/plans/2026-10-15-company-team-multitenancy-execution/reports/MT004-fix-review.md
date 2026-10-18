# MT004-fix — 修复轮独立复审报告（Independent Pi Reviewer）

- 复审者：全新独立 Pi Reviewer（Orca Task `task_c9af0cd806e9` / Dispatch `ctx_7c547044f466`）。只读审阅，不修复任何 finding；与修复实现者（`task_7c40417f32e9`）、原实现者（`task_4a94e96cd775`）、原复审者（`task_70322419a303`）均无共享会话。
- 日期：2026-10-16。审阅工作树：`orca/workspaces/OpenBot/i6-review2-mt004-fix`。
- 权威依据：`briefs/MT004-fix-review-brief.md`（绝对权威）；参照 `reports/MT004-review.md` §4（F1/F2 定义）、`reports/MT004-fix.md`、`checkpoints/MT004-fix/**`、`checkpoints/MT004/fix-transfer-manifest.txt`（修复前哈希）。
- **总 verdict：修复有效性 PASS（F1 medium 与 F2 low 均真实关闭，无回归）；Code quality PASS。无新增阻塞 finding（3 条 info 观察，见 §7）。**

---

## 1. 快照核验（先做，全部亲自复算）

| 项 | 期望 | 实测 | 结论 |
| --- | --- | --- | --- |
| `git rev-parse HEAD` | `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（`checkpoints/MT004-fix/fix-review-sha256-manifest.txt` 首行 BASE） | 一致 | ✅ |
| manifest 逐文件 SHA-256 复算 | 全部 OK | 从仓库根 `sha256sum -c`（剔除 BASE 行）→ **22/22 OK，exit 0** | ✅ |
| `git status --porcelain` | 仅 `server/src/db/schema/enterprise-tenancy.ts` 为 tracked ` M` + 清单内 untracked | ` M server/src/db/schema/enterprise-tenancy.ts`；`?? docs/plans/2026-10-15-company-team-multitenancy-execution/`、`?? server/scripts/multitenancy/`、`?? server/tests/multitenancy/`；无其它 tracked 变更 | ✅ |
| `git diff --numstat` schema 文件 | 仍为 70/0 纯追加（原实现纯追加、本修复轮零改动） | **70 / 0** | ✅ |

注：brief 中的 `reports/…`、`checkpoints/…` 简写路径在实际仓库中均解析于 `docs/plans/2026-10-15-company-team-multitenancy-execution/` 之下（与其余简写路径一致），本报告沿用该解析。本报告文件是本人在本工作树**唯一新建**的文件；审阅全程未修改任何被审文件。

## 2. F1（medium）关闭核验 —— **已关闭**

| 判据（brief 审阅要点 1） | 实测 | 结论 |
| --- | --- | --- |
| `rls_policies` 步骤在 ENABLE 之后追加 FORCE | `server/scripts/multitenancy/migrate-test.ts:142-143`：`ENABLE ROW LEVEL SECURITY;` 之后紧跟 `ALTER TABLE "enterprise_workspace_memberships" FORCE ROW LEVEL SECURITY;` | ✅ |
| 与 0056 模式一致 | `server/drizzle/0056_enterprise_tenancy_rls.sql:137-143` 对全部 7 张既有企业表逐表 FORCE，引用风格（引号表名、独立语句）与新语句逐字同形 | ✅ |
| 语句数 10 → 11 | 工具 manifest 实测 `0002_mt004_rls_policies.sql` `statementCount: 11`（本人复跑 §6 #9 原样输出） | ✅ |
| 新增用例断言 `pg_class.relforcerowsecurity = true` | `membership-model.test.ts:337-350` `fresh apply forces row level security on the new table (0056 hardening pattern; review F1)`：fresh apply 后断言 `relrowsecurity` 与 `relforcerowsecurity` 均 `true`（`toHaveLength(1)` 前置防空过） | ✅ |
| RED 存档真实对应修复前状态 | `RED-f1-relforcerowsecurity.txt`：**15 pass / 1 fail**，唯一失败即新用例（`Expected: true / Received: false`，错误定位 `membership-model.test.ts:347` = after 文件中 `relforcerowsecurity` 断言行；测试名与 after 文件逐字一致；运行路径为修复实现者工作树 `i6-mt004-fix`，与修复会话归属一致）。修复前状态经本人双重印证：`before/migrate-test.ts`（SHA=transfer manifest `ac0a0381…`）确实无 FORCE 语句；本人对修复后代码的 fresh apply 实测 `relforcerowsecurity=t`（§6 #8）——同一断言修复前 false / 修复后 true 的因果链完整 | ✅ |
| GREEN 16/0 于全新库 | `GREEN-f1-relforcerowsecurity.txt`：**16 pass / 0 fail / 70 expect**；修复报告 §2.3 披露 GREEN 前 DROP/CREATE + 基线重跑（digest 漂移后旧库必然拒绝，工具行为见 §5）。本人独立复跑亦在**本人自建全新库**上得 16/0（§6 #2） | ✅ |
| psql 独立复核记录在案 | 本人容器实测：`enterprise_workspace_memberships` = `t/t`；对照 `enterprise_memberships`/`enterprise_workspaces` 亦 `t/t`、既有豁免 `enterprise_settings` `f/f`（§6 #8） | ✅ |

## 3. F2（low）关闭核验 —— **已关闭**

| 判据（brief 审阅要点 2） | 实测 | 结论 |
| --- | --- | --- |
| test 头注并发竞态说明 | `membership-model.test.ts:10-13`：验收 (3) 注释明示「read-then-increase 非原子，并发写者可读到同一 current epoch 并写出重复值，串行化/重试责任归应用写入路径（MT005 消费契约将接管）」 | ✅ |
| migrate 注释并发竞态说明 | `migrate-test.ts:101-104`：`WORKSPACE_MEMBERSHIP_TASK` 文档注释同义说明，紧跟 expand-only 描述之后 | ✅ |
| diff 显示纯注释（无行为改动） | 两处均为 `/** … */` 与 `// …` 注释行；无任何可执行语句变更。**硬证据**：本人将 `fix.diff` 逆应用到当前（after）两文件，产物 SHA-256 与 `before/` 存档逐字一致（§4），证明 diff 完整覆盖且全部改动仅为上述注释 + F1 语句 + F1 用例 | ✅ |

## 4. diff 最小性核验 —— **成立**

- **本人独立重建实验**：把当前两份被审文件复制到临时目录后以 `patch -R -p0` 逆应用 `checkpoints/MT004-fix/fix.diff`，产物 SHA-256：
  - `migrate-test.ts` → `ac0a0381f05253d6a99fd4e66b079f54c2932e727b699c11317b3e505e71f058`（= transfer manifest = `before/migrate-test.ts`）
  - `membership-model.test.ts` → `7c86a1e6b6f6c3736f6d738fb62d6b9b9393eb3cd474ac61bf31b7890abbfa17`（= transfer manifest = `before/membership-model.test.ts`）

  → `fix.diff` 是本次修复的**完整且精确**描述，无任何隐藏改动。before 副本真实性由 manifest 哈希（§1，22/22 OK）背书。
- **逐文件增量**（本人逐行统计）：`migrate-test.ts` **+5 −0**（F1 FORCE 语句 +1、F2 注释 +4）；`membership-model.test.ts` **+19 −1**（F2 头注 −1+4、F1 用例插入净 +15，含 diff 表示所需的 `});` 重闭合与空行）。仅 2 个文件、4 个 hunk，全部属于 F1 语句 / F1 用例 / F2 注释，无其它内容。
  - 与 brief 预算（F1 用例 +18、F2 test −2+5）对账：实际净增量（+18 行/test 文件、+5 行/migrate 文件）**不大于** brief 预算；差额系 brief 对注释换行与 diff 表示行的计法差异，见 §7-I1。语义要素（语句、断言、两句注释）与 brief 要求一一对应。
- **`enterprise-tenancy.ts` 零改动**：仍为唯一 tracked ` M`，numstat 70/0（原实现纯追加），manifest 哈希 `c4fc5145…` 与 transfer manifest 一致（该文件在两份 manifest 中哈希相同 → 本修复轮未触碰）✅
- **其余文件与修复前一致**：`fix-transfer-manifest.txt` 全部 11 项与 fix-review manifest 逐项对照，除两份拥有文件按预期变化（`ac0a0381…→cb0891c6…`、`7c86a1e6…→e7057686…`）外，其余 9 项（enterprise-tenancy.ts、inventory.ts、inventory.test.ts、migration-tool.test.ts、fixtures.test.ts、support/fixture.ts、support/scenarios.ts、MT004.md、MT004-review.md）哈希**逐字不变** ✅
- TASKS 注册仍只含 MT000/MT004；无安全拒绝放宽；无提交/推送/合并（HEAD 复核仍为 `f0520524…`）✅

## 5. digest 漂移语义独立验证（brief 审阅要点 4）

在本人专用库上实测（工具行为未回退）：

1. **fresh apply 两次**：membership-model 测试内含 apply → 重放 up-to-date 断言；本人另以 `runMigrateTest(["migrate","MT004"])` 直接二次调用 → `{"kind":"dry-run",…,"appliedCount":2,"pending":[]}`（up-to-date 预览），manifest 中 `0002_mt004_rls_policies.sql` `statementCount: 11` 证实 FORCE 在计划内。
2. **journal digest 篡改必拒**：`UPDATE mt_task_migration_journal SET statement_digest='deadbeef…' WHERE task_id='MT004' AND number=2` 后再调用工具 → `{"kind":"refused","stage":"journal","reason":"journal records 0002_mt004_rls_policies.sql with statement digest deadbeef… but the current plan digest is d6d6750e…; the journal and the current plan have drifted apart — manual review is required; the tool never rewrites or replays already-journaled steps"}`。

→ 修复报告 §2.3 的机制说明成立：已应用旧版 MT004（旧 rls_policies digest）的库会被**拒绝而非静默重放**；修复 SQL 只影响新库应用，与「用 fresh 库验证」一致。旧库升级路径不在本修复轮范围（已如实披露）。

## 6. 独立复跑（全部本人亲自执行；专用容器 `openbot-i6r2-mt004fix-pg` = `pgvector/pgvector:pg16`，端口 55455，库 `openbot_enterprise_mt004fix_review`）

前置：`lsof -i :55455` 空闲（exit 1）；容器 `--rm -d` + trust + `127.0.0.1:55455:5432`（镜像 `pgvector/pgvector:pg16`，`docker ps` 实证）；`pg_isready` accepting（~14s）；受限登录 `ent_i6r2fix_dir/data/op` 由 0600 临时 env 文件提供（`ENTERPRISE_TEST_SETUP_DATABASE_URL` + `TEST_DATABASE_URL` 同指 55455 库；用后已删，密码不入库不入报告）。baseline：`bun scripts/enterprise-test-db.ts migrate` → `{"type":"migrations-applied","status":"ok"}`，exit 0。

| # | 命令 | 结果 | 退出码 |
| --- | --- | --- | --- |
| 0 | `lsof -i :55455`（预检） | 无占用 | 1（=空闲，符合预期） |
| 1 | `bun scripts/enterprise-test-db.ts migrate`（env→55455，server/ 下执行） | migrations-applied ok | **0** |
| 2 | `TEST_DATABASE_URL=…55455/openbot_enterprise_mt004fix_review bun test server/tests/multitenancy/membership-model.test.ts` | **16 pass / 0 fail**（70 expect；brief 预期 16/0 吻合，含 F1 新用例 pass） | **0** |
| 3 | `MT003_ASSIGNED_TEST_DATABASE_URL=<同库> TEST_DATABASE_URL=<同库> bun test server/tests/multitenancy/migration-tool.test.ts server/tests/multitenancy/inventory.test.ts` | **75 pass / 0 fail / 0 skip**（5318 expect；`(skip)` 计数 = 0） | **0** |
| 4 | `TEST_DATABASE_URL=… + 三个 ENTERPRISE_TEST_*_DATABASE_URL=… bun test server/tests/multitenancy/fixtures.test.ts`（单独） | **17 pass / 0 fail**（146 expect，0 skip） | **0** |
| 5 | `bun test server/tests/multitenancy/inventory.test.ts server/tests/multitenancy/fixtures.test.ts --timeout 30000` | **50 pass / 0 fail**（5234 expect，0 skip；原复审 F4 的 `--timeout` 对策持续有效） | **0** |
| 6 | `cd server && bun run typecheck` | `$ tsc --noEmit` 无错误输出 | **0** |
| 7 | `bunx biome check server/scripts/multitenancy/migrate-test.ts server/tests/multitenancy/membership-model.test.ts` | Checked 2 files, No fixes applied | **0** |
| 8 | psql 交叉核验 `select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in (…)` | 新表 **t/t**；`enterprise_memberships`/`enterprise_workspaces` t/t；`enterprise_settings` f/f（既有豁免） | 0 |
| 9 | 二次 apply（`runMigrateTest(["migrate","MT004"])`） | up-to-date（`pending: []`，rls_policies `statementCount: 11`） | 0 |
| 10 | journal digest 篡改后再 apply | **refused（journal drift，拒绝重放）** | 拒绝即设计行为 |
| 11 | 清理：`docker rm -f`；删 0600 env 文件与 /tmp 脚本；`lsof :55455` 复查 | 容器已删、凭据已删、端口空闲（exit 1）；`docker ps -a` 无残留 | 0 |

全部 brief 要求命令复跑通过；无任何 skipped 被计入通过；无环境阻塞项。

## 7. Findings（本复审新增，均不阻塞）

- **I1 [info] brief 对修复 diff 的行数预算与实际 diff 算术存在计法差异（实际更小）**
  证据：brief 称「F1 用例 +18、F2 test −2+5」→ 预算净 +21；实测 `membership-model.test.ts` +19 −1（净 +18），其中 F1 用例 diff 表示为 +16（含 `});` 重闭合与空行）、F2 头注 −1+4。语义要素完全齐备，实际改动**严格小于**预算，属更保守的最小性；仅为行数计法（注释换行合并 / diff 表示行归属）差异，无需行动。
- **I2 [info] migration-tool+inventory 组合复跑 expect 计数 5318 与存档 5321 差 3**
  证据：§6 #3 vs `regression2-migration-tool-inventory.txt`。pass/fail/skip 完全一致，差异来自 inventory 动态 expect 计数（随环境派生对象数浮动），与本次修复无关，不影响任何结论。
- **I3 [info] RED 存档运行路径为修复实现者工作树（`…/i6-mt004-fix/…`）**
  证据：`RED-f1-relforcerowsecurity.txt` 错误栈路径。与「修复者全新会话/工作树」的归属一致（非本工作树），内部证据（测试名、行号、错误内容、15/1 计数）与修复前状态交叉印证成立（§2），真实性问题不存在；仅记录路径归属以免误读。

## 8. Verdicts 汇总

| 维度 | Verdict |
| --- | --- |
| 快照/哈希/git 状态核验 | **PASS**（HEAD=BASE；22/22 SHA-256 OK exit 0；唯一 tracked M 仍 70/0 纯追加） |
| F1 关闭（FORCE RLS + 断言 + RED/GREEN 真实性 + fresh 库 + psql） | **PASS（CLOSED）** |
| F2 关闭（两处纯注释披露） | **PASS（CLOSED，brief 指定形式）** |
| diff 最小性与只读约束（fix.diff 逆应用逐字还原 before/；其余 9 文件哈希不变） | **PASS** |
| digest 漂移语义（二次 apply up-to-date；篡改必拒） | **PASS（工具行为未回退）** |
| 独立复跑 8 项命令（16/0、75/0/0skip、17/0、50/0、typecheck、biome、psql、清理） | **PASS（全部 exit 0，无 blocked）** |
| **修复有效性总 verdict** | **PASS** |
| **Code quality 总 verdict（修复后整体）** | **PASS**（F1 语句与 0056 逐字同形、用例符合既有文件约定且防空过、注释准确承接原审建议、无行为改动；仅 3 条 info 观察） |

**最终结论：MT004-fix 通过独立复审（succeeded）**——F1（medium）与 F2（low）在本人独立核验与复跑中均真实关闭且无回归，快照/哈希/diff 最小性/digest 漂移语义全部核实；无新增 medium 及以上 finding。
