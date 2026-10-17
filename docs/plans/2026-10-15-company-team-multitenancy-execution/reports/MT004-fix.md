# MT004-fix — 修复轮报告（关闭复审 F1 medium，附带 F2 low）

- 修复者：`backend_implementer`（Orca Task `task_7c40417f32e9` / Dispatch `ctx_982ce0c08523`）。全新会话，非原实现者（`task_4a94e96cd775`）、非复审者（`task_70322419a303`）。
- 日期：2026-10-16。权威依据：`briefs/MT004-fix-brief.md`（绝对权威）；输入证据：`reports/MT004-review.md` §4、`checkpoints/MT004/fix-transfer-manifest.txt`。
- **结论：F1（medium）与 F2（low）均已关闭；全部验证命令 exit 0；succeeded。**

---

## 1. 开工前核验（brief 步骤 1）

| 项 | 期望 | 实测 | 结论 |
| --- | --- | --- | --- |
| `git rev-parse HEAD` | `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（manifest 首行 BASE） | 一致 | ✅ |
| transfer manifest 逐文件 SHA-256 复算 | 全部 OK | 从仓库根 `shasum -a 256 -c` → **11/11 OK，exit 0**（首跑误在 checkpoint 目录内用相对路径执行而失败，属路径错误；从仓库根复跑全 OK，与复审报告 §1 同款教训） | ✅ |
| `git status --porcelain` | 仅 ` M server/src/db/schema/enterprise-tenancy.ts` + 三处 untracked | 完全一致 | ✅ |
| `git diff --numstat` schema 文件 | 70/0 纯追加 | 70 / 0 | ✅（本修复轮**零改动**，全轮保持） |

两份被修复对象的修复前哈希均与 manifest 一致：
- `server/scripts/multitenancy/migrate-test.ts` = `ac0a0381f05253d6a99fd4e66b079f54c2932e727b699c11317b3e505e71f058`
- `server/tests/multitenancy/membership-model.test.ts` = `7c86a1e6b6f6c3736f6d738fb62d6b9b9393eb3cd474ac61bf31b7890abbfa17`

## 2. F1（medium）：新表缺 `FORCE ROW LEVEL SECURITY` —— 已关闭（先 RED 后 GREEN）

### 2.1 修复内容（仅 `migrate-test.ts` SQL 层）

在 MT004 TASKS `rls_policies` 步骤的 `ENABLE` 语句之后，按 0056:137-143 同款引用风格追加一条：

```sql
ALTER TABLE "enterprise_workspace_memberships" FORCE ROW LEVEL SECURITY;
```

该步骤语句数 10 → 11；语句 digest 变化是工具 manifest/journal 机制的预期输入，无需任何其他文件改动。schema 文件零改动（纯 SQL 步骤即可关闭 F1，符合 brief 预期）。

### 2.2 TDD 证据（RED → GREEN，均用全新库）

- **RED**：先只在 `membership-model.test.ts` criterion 4 块新增用例 `fresh apply forces row level security on the new table (0056 hardening pattern; review F1)`——断言 fresh apply 后 `pg_class.relforcerowsecurity = true`（`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'enterprise_workspace_memberships'`）。修复前运行：
  - **15 pass / 1 fail，exit 1**；唯一失败即新用例：`Expected: true / Received: false`（`relforcerowsecurity=f`，与复审 §4 F1 证据吻合）。存档 `checkpoints/MT004-fix/RED-f1-relforcerowsecurity.txt`。
- **GREEN**：加入 FORCE 语句 + 两处 F2 注释后，在**另一个全新库**（DROP/CREATE + `enterprise-test-db.ts migrate` 重跑基线）复跑：
  - **16 pass / 0 fail，exit 0**（旧 15 用例零回退 + F1 新断言通过），与 brief 预期「16/0：旧 15 + F1 新断言」吻合。存档 `checkpoints/MT004-fix/GREEN-f1-relforcerowsecurity.txt`。
- **psql 独立复核**（测试进程外）：`enterprise_workspace_memberships` → `relrowsecurity=t, relforcerowsecurity=t`；对照既有 `enterprise_memberships`/`enterprise_workspaces` 均为 `force=t`，与 0056 硬化模式一致。

### 2.3 全新库说明（诚实披露）

修复改变了 `rls_policies` 的语句 digest，对已应用旧版 MT004 的库，工具按设计必然拒绝（journal 与计划漂移 → expand-only 不重放）。因此 RED 用容器初建的第一个全新库，GREEN 前 DROP/CREATE DATABASE 并重跑 `enterprise-test-db.ts migrate` 得到第二个全新库——与 brief「已应用过旧版 MT004 的库不重放；修复后的 SQL 只影响新库应用——用 fresh 库验证」逐字一致。旧库升级路径不在本修复轮范围。

## 3. F2（low）：`epoch` read-then-increase 并发竞态未明示 —— 已关闭（纯注释）

按 brief 原文各补一句，零行为改动：

- `membership-model.test.ts` 头注验收 (3)：明示 read-then-increase 非原子——并发写者可读到同一 current epoch 并写出重复值；串行化/重试责任归应用写入路径（MT005 消费契约将接管）。
- `migrate-test.ts` `WORKSPACE_MEMBERSHIP_TASK` 文档注释：同义说明，紧跟 expand-only 描述之后。

## 4. 验证命令与退出码（全部实际执行并记录）

环境：`pgvector/pgvector:pg16` 容器 `openbot-i6-mt004fix-pg`（`--rm -d`，trust，`127.0.0.1:55454`），库 `openbot_enterprise_mt004fix_test`；`enterprise-test-db.ts migrate` → `{"type":"migrations-applied","status":"ok"}` exit 0；受限登录 `ent_mt004fix_dir/data/op` 由 0600 临时 env 文件提供（`options=-c role=ob_ent_*` 由 `enterpriseRuntimeDatabaseUrlFrom` 自动追加；文件用后即删，密码未入库未入报告）。

| # | 命令 | 结果 | 退出码 |
| --- | --- | --- | --- |
| 1 | `TEST_DATABASE_URL=…55454/… bun test server/tests/multitenancy/membership-model.test.ts`（修复后） | **16 pass / 0 fail**（brief 预期 16/0 吻合；旧 15 零回退） | **0** |
| 2 | `MT003_ASSIGNED_TEST_DATABASE_URL=<同库> TEST_DATABASE_URL=<同库> bun test server/tests/multitenancy/migration-tool.test.ts server/tests/multitenancy/inventory.test.ts` | **75 pass / 0 fail / 0 skip**（42+33，与复审一致） | **0** |
| 3 | `TEST_DATABASE_URL=… + 三个 ENTERPRISE_TEST_*_DATABASE_URL=… bun test server/tests/multitenancy/fixtures.test.ts`（单独） | **17 pass / 0 fail** | **0** |
| 3b | 附带 F4 复证：`bun test inventory.test.ts fixtures.test.ts --timeout 30000` | **50 pass / 0 fail**（复审 §3 第 6 行同绿） | **0** |
| 4 | `cd server && bun run typecheck` | `tsc --noEmit` 无输出 | **0** |
| 5 | `bunx biome check` 两份拥有文件 | Checked 2 files, No fixes applied | **0** |
| 6 | `docker rm -f openbot-i6-mt004fix-pg`；删 0600 env 文件；`lsof -i :55454` 复查 | 容器已删、凭据已删、端口空闲（exit 1 = 无占用） | 0 |

无任何 skip 被计入通过；首跑即绿项（#2/#3/#3b/#4/#5）如实披露，它们不属于 RED/GREEN 范畴（F1 的 RED/GREEN 见 §2.2）。

## 5. 拥有文件与最终哈希（after）

| 文件 | after SHA-256 |
| --- | --- |
| `server/scripts/multitenancy/migrate-test.ts` | `cb0891c6dba4dcfbd476876971f97382a372fd24c6705dd601958f4f2b41fe38` |
| `server/tests/multitenancy/membership-model.test.ts` | `e7057686b398c93863b0515093578b79331a5de9a58598b4f12d288ff0185e3b` |

- 修复 diff：`checkpoints/MT004-fix/fix.diff`（F1 语句 +1、F1 用例 +18、F2 注释 migrate +4 / test -2+5）。before 副本（`checkpoints/MT004-fix/before/`）由修复后文件逆编辑重建，**重建件 SHA-256 与 transfer manifest 两行逐字一致** → diff 精确性可证。
- 其余约束逐条成立：`enterprise-tenancy.ts` 零改动（仍唯一 tracked ` M`，70/0 纯追加）；`migration-tool.test.ts`、`fixtures.test.ts`、`inventory.test.ts`、`inventory.ts`、`support/*` 只读未动；未放宽任何既有安全拒绝；TASKS 注册仍只含 MT000/MT004；无提交/推送/合并/生产迁移/部署。
- 结构化汇总：`checkpoints/MT004-fix/review-package.json`；命令原始终端输出：`checkpoints/MT004-fix/RED-f1-relforcerowsecurity.txt`、`GREEN-f1-relforcerowsecurity.txt`、`regression2-migration-tool-inventory.txt`、`regression3-fixtures.txt`、`regression3b-combined-timeout30000.txt`。

## 6. 复审 Finding 关闭映射

| Finding | 复审建议 | 本轮处置 | 状态 |
| --- | --- | --- | --- |
| **F1 [medium]** 新表缺 FORCE RLS | 「后续补一条 `ALTER TABLE … FORCE ROW LEVEL SECURITY`」 | `rls_policies` 步骤 ENABLE 后追加 FORCE（0056 同模式）+ `relforcerowsecurity=true` 断言（RED→GREEN）+ psql 复核 | **CLOSED** |
| **F2 [low]** epoch 并发局限未明示 | 「在 ADR/CONTEXT 或 MT005 消费契约中明示」 | brief 指定落地：membership-model.test.ts 头注 + migrate-test.ts 任务注释各补一句（MT005 消费契约将接管）；纯注释 | **CLOSED**（brief 指定形式） |
| F3/F4 [info] | 无行动要求 / 回归文档记录 `--timeout` | 不在修复范围；F4 对策已在本轮 #3b 复证可行 | 记录在案 |
