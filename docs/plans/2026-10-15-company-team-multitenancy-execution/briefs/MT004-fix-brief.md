# MT004-fix — 修复轮 Task Brief（关闭复审 F1，附带 F2）

角色：`backend_implementer`（修复轮）；完成后由全新独立 Pi Reviewer 复审。你是修复实现者，不是原实现者、不是复审者。

## 背景与输入

- 原实现（Task `task_4a94e96cd775`，已结算）+ 独立复审（Task `task_70322419a303`）报告 `reports/MT004-review.md`：Spec 4/4 PASS / Code PASS with findings —— **F1（medium）必须关闭**，F2（low）附带。
- 复审报告已随快照转移到你的工作树（findings 证据见其 §4）。
- 被修复对象修复前哈希（先复算，不符即 worker_done --outcome failed；以 `checkpoints/MT004/fix-transfer-manifest.txt` 为准）：
  - `server/scripts/multitenancy/migrate-test.ts`
  - `server/tests/multitenancy/membership-model.test.ts`
- HEAD 必须 = `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（manifest 首行）。
- `server/src/db/schema/enterprise-tenancy.ts` 为 tracked 修改（M）——这是原实现的纯追加改动，**不要动它**（本修复轮若仅在 SQL/注释层面即可关闭 F1/F2，则 schema 文件零改动）。

## 必须关闭的 Finding（先 RED 后 GREEN）

- **F1（medium）**：新表 `enterprise_workspace_memberships` 缺 `FORCE ROW LEVEL SECURITY`。0056 对既有 7 表全部 FORCE（`server/drizzle/0056_enterprise_tenancy_rls.sql:137-143`）；MT004 生成 SQL 仅 ENABLE（复审 pg_class 实测 `relforcerowsecurity=f`）。
  修复：在 `migrate-test.ts` 的 MT004 TASKS `rls_policies` 步骤中，按 0056 同模式追加 `ALTER TABLE enterprise_workspace_memberships FORCE ROW LEVEL SECURITY`（语句位置与 0056:137-143 风格一致；ENABLE 之后）。**注意**：已应用过旧版 MT004 的库不重放（expand-only）；修复后的 SQL 只影响新库应用——用 fresh 库验证。
  测试：新增用例断言 fresh apply 后 `pg_class.relforcerowsecurity = true`（SELECT FROM pg_class WHERE relname='enterprise_workspace_memberships'）。RED = 修复前该断言失败。

## 附带（同文件，一并修复）

- **F2（low）**：`epoch` read-then-increase 并发竞态未明示。在 `membership-model.test.ts` 头注与 `migrate-test.ts` 的 WORKSPACE_MEMBERSHIP_TASK 相关注释中各补一句：并发写者可读到同一 current epoch 并写出重复值；串行化/重试责任归应用写入路径（MT005 消费契约将接管）。纯注释，不改行为。

## 拥有文件（其余一律不动）

- `server/scripts/multitenancy/migrate-test.ts`
- `server/tests/multitenancy/membership-model.test.ts`
- `docs/plans/2026-10-15-company-team-multitenancy-execution/reports/MT004-fix.md`（新建）
- `docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT004-fix/**`（新建）

## 约束

- `server/src/db/schema/enterprise-tenancy.ts`、`server/tests/multitenancy/migration-tool.test.ts`、MT001/MT002/MT003/MT131 交付文件一律只读。
- 不放宽任何既有安全拒绝；TASKS 注册仍只含 MT000/MT004；既有 15 用例不回退。
- TDD：F1 先写失败断言（RED 存档），再加 FORCE（GREEN）；首跑即绿项诚实披露。
- 无提交/推送/合并/生产迁移/部署授权；未提交检查点 + SHA-256 清单。

## 测试资源（专用，用后清理）

- 镜像必须含 vector：`pgvector/pgvector:pg16`。`lsof -i :55454` 确认空闲后：
  `docker run --rm -d --name openbot-i6-mt004fix-pg -e POSTGRES_DB=openbot_enterprise_mt004fix_test -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55454:5432 pgvector/pgvector:pg16`
- `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55454/openbot_enterprise_mt004fix_test`（企业基线用 `bun scripts/enterprise-test-db.ts migrate`，env 指向 55454）。

## 验证命令（全部记录退出码）

1. `TEST_DATABASE_URL=…55454/… bun test server/tests/multitenancy/membership-model.test.ts`（预期 16/0：旧 15 + F1 新断言）
2. `MT003_ASSIGNED_TEST_DATABASE_URL=<同库> TEST_DATABASE_URL=<同库> bun test server/tests/multitenancy/migration-tool.test.ts server/tests/multitenancy/inventory.test.ts`（回归，预期 0 skip）
3. `TEST_DATABASE_URL=… + 三个 ENTERPRISE_TEST_*_DATABASE_URL=… bun test server/tests/multitenancy/fixtures.test.ts`（单独跑；已知组合跑 inventory+fixtures 需 `--timeout 30000`——复审 F4 环境项）
4. `cd server && bun run typecheck`
5. `bunx biome check` 两个拥有文件
6. `docker rm -f openbot-i6-mt004fix-pg`

## 产出

- `reports/MT004-fix.md`：修复说明、RED/GREEN 证据、F1/F2 关闭映射、命令与退出码。
- `checkpoints/MT004-fix/`：before/after 哈希、diff、review-package.json。
- worker_done --outcome succeeded|failed，附 --report-path --files-modified。
