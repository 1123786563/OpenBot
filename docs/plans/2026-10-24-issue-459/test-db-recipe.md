# #459 受限角色企业测试库配方（T-INF，2026-10-24）

本 Run 的企业测试库与驱动方式。事实源：T00 基线（`.archive/runs/2026-10-24-issue-459/verification/baseline.md`）、
ADR 0008、`server/scripts/multitenancy/migrate-test.ts`。只覆盖本 Run 的 `issue459-ent-pg` 容器；其他容器不属于本 Run。

## 1. 容器与库

- 容器 `issue459-ent-pg`（pgvector/pgvector:pg16，ID 4f3cb9032c4d），宿主端口 **127.0.0.1:5436**，数据库 `openbot_enterprise_issue459`。**保留运行，不要删除。**
- 角色：超级用户 `postgres/postgres`；三个受限登录角色 `ent_i459_dir` / `ent_i459_data` / `ent_i459_op`（密码 `i459pass`）→ capability 角色 `ob_ent_*`（roles.sql bootstrap 产物）。

## 2. 环境变量（每次运行显式传入，不依赖 .env）

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5436/openbot_enterprise_issue459
ENTERPRISE_TEST_SETUP_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5436/openbot_enterprise_issue459
ENTERPRISE_TEST_DIRECTORY_DATABASE_URL=postgres://ent_i459_dir:i459pass@127.0.0.1:5436/openbot_enterprise_issue459
ENTERPRISE_TEST_DATA_DATABASE_URL=postgres://ent_i459_data:i459pass@127.0.0.1:5436/openbot_enterprise_issue459
ENTERPRISE_TEST_OPERATOR_DATABASE_URL=postgres://ent_i459_op:i459pass@127.0.0.1:5436/openbot_enterprise_issue459
# e2e 驱动 multitenancy 岛时额外需要（driver 会把它换算成组内 TEST_DATABASE_URL）：
MT_TEST_DATABASE_URL=$TEST_DATABASE_URL
```

`plugin-install.test.ts` 的探针要求 `ENTERPRISE_TEST_SETUP_DATABASE_URL` 显式设置，缺省即整套 skip（T00 B-4）。

## 3. 从零重建（reset 配方）

```sh
docker exec issue459-ent-pg psql -U postgres -d postgres \
  -c 'DROP DATABASE IF EXISTS openbot_enterprise_issue459;' \
  -c 'CREATE DATABASE openbot_enterprise_issue459;'
# 角色 bootstrap（roles.sql，T00 已验证的同一份）
# 用第 2 节的 5 个 URL 执行 drizzle 全量迁移 + 角色 provision：
bun --no-env-file server/scripts/enterprise-test-db.ts migrate
```

## 4. 漂移调和（B-1 的可复现解法）

根因：`server/drizzle/0163_restore_drifted_tables.sql`（f64d4b91e）恢复了 38 张表 + 1 列，其中一批与
MT 任务链的 `CREATE TABLE` / `ADD COLUMN` 重叠；任务链步骤不是幂等 DDL，直接 apply 撞 `already exists`，
而 drizzle 版本又没有任务链的 RLS/FORCE/GRANT。

解法（测试侧，不改生产代码）：

- `server/tests/multitenancy/support/task-drift.ts` 的 `reconcileTaskDrift(client, taskIds)`：对给定任务链**未记
  journal**（`mt_task_migration_journal`）的步骤，删除其声明创建且当前已存在的表（CASCADE，与 drop-0163.sql
  配方一致）/列/约束，再让任务链按原文重建 —— RLS/GRANT 断言不变弱。journal 已记录的步骤一律不触碰。
- `applyPackageTasks()`（`support/package-install.ts`）在 apply 前自动调和，并用 session 级 advisory lock
  （`openbot:mt-package-task-chain`）把 reconcile→apply 对并发驱动组串行化。
- 覆盖链：`PACKAGE_CHAIN_TASK_IDS = MT004, MT008, MT031, PKG02, MT016, PKG03, PKG04`。

**预置（prime）**：`tool-invocation.test.ts`（MT032）与部分依赖 `enterprise_credentials`（MT027）的套件不自带任务
应用，需在跑套件前把链应用到库上。两种等价方式：

1. 先跑一次 package 链任一套件（其 `beforeAll → applyPackageTasks` 即完成调和 + 应用），例如：

   ```sh
   bun test --timeout=120000 server/tests/multitenancy/package-storage.test.ts
   ```

2. 或对额外任务（如 MT027）直接走三步配方：dry-run → `manifestFor(buildPlan(id))` 写临时 manifest →
   `--apply --manifest`（见 `plugin-install.test.ts` beforeAll 的同款调用）。

已应用的任务重复跑返回 `up-to-date`，幂等。

## 5. e2e 驱动（ADR 0008 两层制）

这批套件经 `server/src/db/client`（Bun SQL）依赖 Bun 运行时，属 **driven** 层：清单
`tests/config/e2e-bun-suites.json`（由 `node scripts/e2e-file-audit.mjs <14 目录> && node scripts/e2e-bun-manifest.mjs`
生成）登记后由 `tests/bun-suites.test.ts` 驱动 `bun test` 执行、e2e 统一报告：

```sh
# package 链 6 件套（storage/runtime/grants/expert/plugin-install/integration）一组：
E2E_BUN_ONLY="server/tests/multitenancy/package chain" E2E_UNIT_OUTPUT=.e2e/<dir> \
  bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
# MT032 单独一组：
E2E_BUN_ONLY="server/tests/multitenancy/tool-invocation" E2E_UNIT_OUTPUT=.e2e/<dir> \
  bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

注意：`E2E_BUN_ONLY` 是组名**子串**过滤；`server/tests/multitenancy` 会连岛内全部 ~120 个既有套件一起选中
（含大量与 #459 无关的既有红），所以验证时用上面的窄过滤。native 面（Node e2e）6 个 package 套件不受
本配方影响，照常经 `e2e.unit.config.ts` 收集。

## 6. 已知边界

- 任务链 journal 已记录、但对象随后被外部改动/删除的情形不在调和范围（journal 视为事实）。
- `plugin-install.test.ts` 单独重跑（alone-rerun）在**未 prime** 的全新库上会因 MT004/MT008 基表缺失失败；
  按 §4 先 prime 即可。
- 目录表内容契约：`plugin-install` 的 AC1 断言目录恰好只含它种子的 3 条，其 fixture 在 setup 与 dispose
  两侧都 truncate 三张插件表（披露过的 superuser 安排面）；`package-storage` / `package-install.integration`
  会遗留 `pkg02-*` 目录行，所以驱动组里 plugin-install 必须排在最前（清单里的显式组已按此排序）。
- 0163 恢复的其余 22 张表（非本链所有）仍留在库里，属其他套件的领域，不归本 helper 处置。
