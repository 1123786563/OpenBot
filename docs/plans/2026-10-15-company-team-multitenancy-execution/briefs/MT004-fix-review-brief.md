# MT004-fix — 修复轮独立复审 Task Brief

你是全新独立 Pi Reviewer（与修复实现者、原实现者、原复审者均无共享会话）。只读审阅，不修复 finding。

## 目标

两个独立结论：(1) 修复有效性——`reports/MT004-review.md` 的 F1（medium：新表缺 FORCE ROW LEVEL SECURITY）与 F2（low：epoch 并发竞态未明示）是否真实关闭且无回归；(2) Code quality（修复后整体）。有效新 finding 按 critical/high/medium/low/info 分级（含 file:line 证据）。

## 快照核验（先做）

- `git rev-parse HEAD` = f0520524 开头（完整值以 `checkpoints/MT004-fix/fix-review-sha256-manifest.txt` 首行为准）。
- 逐条复算该 manifest 每个文件 SHA-256；不匹配 → worker_done --outcome failed。
- `git status --porcelain`：仅 `server/src/db/schema/enterprise-tenancy.ts` 为 tracked ` M`（原实现纯追加 70/0，本修复轮零改动——用 `git diff --numstat` 核验仍为 70/0）+ 清单内 untracked。

## 审阅对象

- 修复后 `server/scripts/multitenancy/migrate-test.ts`（修复前 `ac0a0381…` → after 以 manifest 为准）
- 修复后 `server/tests/multitenancy/membership-model.test.ts`（修复前 `7c86a1e6…` → after 以 manifest 为准）
- 修复报告 `reports/MT004-fix.md` 与 `checkpoints/MT004-fix/**`（RED/GREEN 存档、fix.diff、before/ 副本、review-package.json）
- 参照：原复审 `reports/MT004-review.md` §4（F1/F2 定义与证据）、原实现报告 `reports/MT004.md`、`checkpoints/MT004/fix-transfer-manifest.txt`（修复前哈希）

## 审阅要点

1. **F1 关闭判据**：`rls_policies` 步骤在 ENABLE 之后追加 `ALTER TABLE "enterprise_workspace_memberships" FORCE ROW LEVEL SECURITY`，与 `server/drizzle/0056_enterprise_tenancy_rls.sql:137-143` 模式一致；新增用例断言 fresh apply 后 `pg_class.relforcerowsecurity = true`；RED 存档（15/1，唯一失败 = 新用例）真实对应修复前状态；GREEN 16/0 于**全新库**；psql 独立复核记录在案。
2. **F2 关闭判据**：membership-model.test.ts 头注与 migrate-test.ts WORKSPACE_MEMBERSHIP_TASK 注释各一句并发竞态说明（并发写者可读同一 current 写出重复 epoch；串行化/重试责任归应用写入路径）；diff 显示纯注释（无行为改动）。
3. **diff 最小性**：fix.diff 仅含 F1 语句 +1、F1 用例 +18、F2 注释（migrate +4 / test −2+5）；`enterprise-tenancy.ts` 零改动；migration-tool.test.ts 等其余文件与修复前哈希一致（对 fix-transfer-manifest 核验）。
4. **digest 漂移语义**：修复使 rls_policies 语句 digest 变化——工具对已应用旧版 MT004 的库应拒绝（journal 漂移）而非静默重放；修复报告 §2.3 的全新库说明与该机制一致。可在你的复跑中实际验证（fresh 库 apply 两次第二次 up-to-date；若你改造库内 journal 一行 digest 应被拒绝——工具已有该行为，验证不回退即可）。
5. **回归**：16/0、75/0（0 skip）、17/0、组合 `--timeout 30000` 50/0、typecheck、biome 全部复跑。

## 独立复跑（必须亲自执行并记录退出码）

1. 端口预检 `lsof -i :55455`；起专用库（必须 pgvector/pgvector:pg16）：
   `docker run --rm -d --name openbot-i6r2-mt004fix-pg -e POSTGRES_DB=openbot_enterprise_mt004fix_review -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55455:5432 pgvector/pgvector:pg16`
2. `bun scripts/enterprise-test-db.ts migrate`（env 指向 55455；受限角色登录用 0600 临时 env 文件，用后删，密码不入库/报告）。
3. `TEST_DATABASE_URL=…55455/… bun test server/tests/multitenancy/membership-model.test.ts`（预期 16/0）
4. `MT003_ASSIGNED_TEST_DATABASE_URL=<同库> TEST_DATABASE_URL=<同库> bun test server/tests/multitenancy/migration-tool.test.ts server/tests/multitenancy/inventory.test.ts`（预期 75/0/0 skip）
5. `TEST_DATABASE_URL=… + 三个 ENTERPRISE_TEST_*_DATABASE_URL=… bun test server/tests/multitenancy/fixtures.test.ts`（单独，预期 17/0）
6. `bun test server/tests/multitenancy/inventory.test.ts server/tests/multitenancy/fixtures.test.ts --timeout 30000`（预期 50/0）
7. `cd server && bun run typecheck`；`bunx biome check` 两被审文件
8. psql 交叉核验：fresh apply 后 `select relrowsecurity, relforcerowsecurity from pg_class where relname='enterprise_workspace_memberships'` → t/t
9. 清理容器与 env 文件。
   环境阻塞项标 blocked + 原因，不当通过也不宣称失败。

## 产出

写 `reports/MT004-fix-review.md`（本工作树唯一允许新建/修改的文件）：Verdicts（修复有效性 + Code quality 各自 PASS/FAIL）、findings、命令与退出码、哈希复算、diff 最小性结论。

## 约束

只读被审文件；不修复；无提交/推送/合并授权；skipped/blocked 不算通过；完成按 preamble worker_done --outcome succeeded|failed 附 --report-path。
