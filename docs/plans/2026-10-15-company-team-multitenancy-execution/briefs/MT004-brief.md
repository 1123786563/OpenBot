# MT004 / Issue #47 — 实现者 Task Brief（workspace membership 数据模型，expand-only）

角色：`backend_implementer`；完成后由独立 Pi Reviewer 复审。DAG 前置：MT003 已验证并集成（其交付文件已按哈希转移进你的工作树，见下）。

## 基线与前置核验

- `git rev-parse HEAD` 必须 = `f0520524f0faa2b4533b9d2f1aa69c8f907ba71`。
- 前置文件（先复算 SHA-256，不一致即 worker_done --outcome failed）：
  - `server/scripts/multitenancy/inventory.ts`（MT001，只读）
  - `server/scripts/multitenancy/migrate-test.ts`（MT003，本任务只允许追加 TASKS 注册表条目）
  - `server/tests/multitenancy/inventory.test.ts`、`server/tests/multitenancy/migration-tool.test.ts`（只读回归）
  - `server/tests/multitenancy/support/fixture.ts`、`support/scenarios.ts`、`fixtures.test.ts`（MT002，只读）

## 目标（Issue #47 What to build）

系统可记录「某人属于某公司的某个团队」，同时证明团队属于该公司、主体是该公司成员；成员关系带 active/suspended 状态与授权变更版本号。**只扩展数据模型，不改变现有可见性行为。**

## 验收（Issue #47 四条，逐条给测试证据）

1. 同一 (公司, 团队, 主体) 只有一条成员关系；重复插入被数据库拒绝。
2. 团队不属于该公司、或主体不是该公司成员时插入被拒绝（复合关联生效）。
3. 状态支持 active/suspended；版本号为正整数且单调递增。
4. 迁移可 dry-run 预览并在专用测试库重放；旧数据不因新增表而改变行为。

## 拥有文件

- `server/src/db/schema/enterprise-tenancy.ts`：**仅允许追加**新的 workspace membership 表定义（参考同文件 `enterprise_memberships`（:90，含 uniqueIndex 与 status/epoch 先例）与 `enterprise_workspaces`（:149）的写法与 RLS `app.tenant_id`/`app.principal_id`/`app.user_id` settings 模式；不得修改任何既有表/策略语义）。
- `server/scripts/multitenancy/migrate-test.ts`：仅追加 MT004 的 TASKS 注册条目与其 SQL 步骤（编号续接工具既有约定；不写业务数据）。
- `server/tests/multitenancy/membership-model.test.ts`：新建。
- `docs/plans/2026-10-15-company-team-multitenancy-execution/reports/MT004.md` 与 `checkpoints/MT004/**`：新建。

其余一切文件（含 MT001/MT002/MT003 交付物、共享 test support、drizzle 配置/journal、package 清单）不得修改。

## 实现要点

- 复合关联同时证明 workspace 属于该 tenant、principal 是该 tenant 成员（复合外键或等效约束 + 触发拒绝路径的测试）。
- 唯一约束 `(tenant_id, workspace_id, principal_id)`。
- epoch 单调递增由应用写入路径保证并在测试断言；status 枚举 active/suspended。
- 新表 RLS 策略按同文件既有模式最小新增，使受限角色测试可用；不改动其他表策略（全面 RLS 属 MT012）。
- 迁移经 MT003 工具：`bun --no-env-file server/scripts/multitenancy/migrate-test.ts generate MT004` 预览、`migrate MT004 --apply --manifest …` 在专用测试库重放。

## TDD（RED→GREEN→REFACTOR）

先写 `membership-model.test.ts`（RED：表/模块不存在），再实现 schema+迁移至 GREEN，最后 REFACTOR 并保持全绿。记录每轮 RED/GREEN 证据；首跑即绿的项按诚实披露处理（变异检查或说明）。

## 测试资源（专用，用后清理）

- docker PG：`docker run --rm -d --name openbot-i6-mt004-test-pg -e POSTGRES_DB=openbot_enterprise_mt004_test -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55445:5432 postgres:16`（postgres:16 必须给 POSTGRES_PASSWORD 或 POSTGRES_HOST_AUTH_METHOD=trust；trust 仅限回环一次性容器）（先 `lsof -i :55445` 确认空闲）。
- `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55445/openbot_enterprise_mt004_test`。
- 若需受限角色/企业 schema，参考 MT002 fixture 与 `server/tests/support/enterprise-database.ts` 的受控建立方式；密码放 0600 临时文件，绝不入库/入报告。

## 验证命令（全部记录退出码）

1. `TEST_DATABASE_URL=… bun test server/tests/multitenancy/membership-model.test.ts`
2. `TEST_DATABASE_URL=… bun test server/tests/multitenancy/migration-tool.test.ts server/tests/multitenancy/inventory.test.ts`（前置回归不被破坏）
3. `cd server && bun run typecheck`
4. `bunx biome check server/src/db/schema/enterprise-tenancy.ts server/scripts/multitenancy/migrate-test.ts server/tests/multitenancy/membership-model.test.ts`

## 检查点与报告

- before/after HEAD、owned 文件 staged/unstaged/untracked 全量内容与 SHA-256 清单、RED/GREEN 输出、Review Package（`checkpoints/MT004/review-package.json`，含 owned_product_files 哈希）。
- 报告 `reports/MT004.md` 按仓库 Ledger 字段规范。
- 无提交/推送/合并/生产迁移/部署授权；缺环境→blocked 不算通过；skipped 不算通过。
- 完成按 preamble `worker_done --outcome succeeded|failed`，附 `--report-path` 与 `--files-modified`。
