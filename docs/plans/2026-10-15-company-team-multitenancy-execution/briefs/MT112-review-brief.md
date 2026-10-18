# MT112 / Issue #155(1/2) — 独立复审 Task Brief

你是独立 Pi Reviewer，只读审阅，与实现者（Task `task_1f45a268faf6` / Dispatch `ctx_679c87145582`，已结算）无共享会话。

## 目标

两个独立结论：(1) Spec compliance——Issue #155 第 1/2 段四条验收（幂等 / 映射唯一可核验 / dry-run+manifest / 既有行为不变）；(2) Code quality。有效 finding 按 critical/high/medium/low/info 分级（含 file:line 证据）。

## 快照核验（先做）

- `git rev-parse HEAD` = f0520524 开头（完整值以 `archive/plans/multitenancy-execution/checkpoints/MT112/review-sha256-manifest.txt` 首行为准）。
- 逐条复算该 manifest 每个文件 SHA-256；不匹配 → worker_done --outcome failed。
- 预期 git 状态：`server/src/db/schema/enterprise-tenancy.ts` 为 tracked ` M`（实现者纯追加已转移）；核验 `git diff --numstat` 为纯追加（对照实现报告：70+N 行 0 删除）；其余为清单内 untracked。

## 审阅对象

- `server/src/db/schema/enterprise-tenancy.ts`（追加 `enterpriseDeploymentAnchors`）
- `server/scripts/multitenancy/migrate-test.ts`（追加 MT112 TASKS 4 步：DDL/RLS/锚点行/映射行）
- `server/tests/multitenancy/migration-tool.test.ts`（裁决 #5 窄例外：:347 断言 `["MT000","MT004","MT112"]` + 3 行注释，核验 diff 仅此）
- `server/tests/multitenancy/legacy-anchor.test.ts`（新建 21 用例）
- 报告 `archive/plans/multitenancy-execution/reports/MT112.md` 与 `archive/plans/multitenancy-execution/checkpoints/MT112/**`

## 审阅要点

1. **勘察结论核验**（亲自打开代码验证）：`deployment_packages.tenant_id`（core.ts:261 附近）、`billing_customers.external_id`（billing.ts:18 附近）、`deploymentExternalCustomerId`（billing/service.ts:54 附近，`openbot-deployment-${tenantId}`）——映射表设计是否与真实结构一致；`DEPLOYMENT_ID` env 边界披露是否准确。
2. **幂等**：ON CONFLICT DO NOTHING 语句级 + 数据级（原样重放计数不变）+ 工具级（重复 apply up-to-date）；「全库最早用户」确定性选取无先查后插竞态。
3. **映射唯一且可核验**：双唯一索引（deployment identity / billing customer）+ 派生 CHECK 焊死 `billing_external_customer_id = 'openbot-deployment-' || deployment_tenant_id`；23505/23514/42501 证据；JOIN 可核验。
4. **dry-run + manifest 链路**：buildPlan 确定性、drift manifest 副作用前拒绝、journal digest 一致。
5. **既有行为不变**：expand-only 断言（表清单/行数/字段逐字/pg_policies 计数）；146 pass 全量回归 0 skip。
6. **裁决 #5 最小性**：migration-tool.test.ts diff 仅一处断言 + 注释（对照 `archive/plans/multitenancy-execution/checkpoints/MT112/migration-tool.test.diff` 13 行存档，独立重算比对）。
7. **RLS**：新表 ENABLE+FORCE（吸取 MT004 F1 教训，验证本轮已含 FORCE）+ 仅 operator SELECT + 无受限角色写权限。
8. TDD/mutation 真实性（RED 缺失导出型、GREEN 两轮、MUT2 假跑诚实披露）；已知边界 5 条合理性。

## 独立复跑（必须亲自执行并记录退出码）

1. 端口预检 `lsof -i :55459`；起专用库（必须 pgvector/pgvector:pg16）：
   `docker run --rm -d --name openbot-i6r2-mt112-pg -e POSTGRES_DB=openbot_enterprise_mt112_review -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55459:5432 pgvector/pgvector:pg16`
2. `bun scripts/enterprise-test-db.ts migrate`（env 指向 55459；受限登录 0600 env 自建、用后删、密码不入库不打印）。
3. `TEST_DATABASE_URL=…55459/… bun test server/tests/multitenancy/legacy-anchor.test.ts`（预期 21/0）
4. `MT003_ASSIGNED_TEST_DATABASE_URL=<同库> TEST_DATABASE_URL=<同库> ENTERPRISE_TEST_{DIRECTORY,DATA,OPERATOR}_DATABASE_URL=<三登录> bun test tests/multitenancy/`（预期 146/0/0 skip；组合超时则按 MT004 F4 记录加 `--timeout 30000` 复跑并如实记录）
5. CLI 链冒烟：fresh 库 `migrate MT112`（dry-run）→ apply → 重复 apply（up-to-date）；psql 复核锚点实体与 `pg_class.relforcerowsecurity`（锚点表应 t/t）
6. `cd server && bun run typecheck`；`bunx biome check` 四个被审文件
7. 清理容器与 env。环境阻塞项标 blocked + 原因，不当通过也不宣称失败。

## 产出

写 `archive/plans/multitenancy-execution/reports/MT112-review.md`（本工作树唯一允许新建/修改的文件）：Verdicts、findings、命令与退出码、哈希复算、勘察结论核验、裁决 #5 最小性比对。

## 约束

只读被审文件；不修复；无提交/推送/合并授权；skipped/blocked 不算通过；完成按 preamble worker_done --outcome succeeded|failed 附 --report-path。
