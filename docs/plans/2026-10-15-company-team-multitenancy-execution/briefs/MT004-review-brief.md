# MT004 / Issue #47 — 独立复审 Task Brief

你是独立 Pi Reviewer，只读审阅，与实现者（Task `task_4a94e96cd775` / Dispatch `ctx_0d3c6dfe3dc0`，已结算）无共享会话。

## 目标

两个独立结论：(1) Spec compliance——Issue #47 四条验收；(2) Code quality。有效 finding 按 critical/high/medium/low/info 分级（含 file:line 证据）。

## 快照核验（先做）

- `git rev-parse HEAD` = f0520524 开头（完整值以 `archive/plans/multitenancy-execution/checkpoints/MT004/review-sha256-manifest.txt` 首行为准）。
- 逐条复算该 manifest 每个文件 SHA-256；不匹配 → worker_done --outcome failed。
- **预期 git 状态**：`server/src/db/schema/enterprise-tenancy.ts` 为 **tracked 修改（M）**——实现者的纯追加改动已转移到本工作树；其余为清单内 untracked。用 `git diff server/src/db/schema/enterprise-tenancy.ts` 核验修改是**纯追加**（0 删除、不改任何既有表/策略语义）；出现其它 tracked 修改即报告。

## 审阅对象

- `server/src/db/schema/enterprise-tenancy.ts`（追加的 `enterprise_workspace_memberships`）
- `server/scripts/multitenancy/migrate-test.ts`（追加的 MT004 TASKS 条目）
- `server/tests/multitenancy/membership-model.test.ts`（新建）
- `server/tests/multitenancy/migration-tool.test.ts`（coordinator 裁决 #3 的窄例外：仅 :344 附近穷举断言 `["MT000"]`→`["MT000","MT004"]` 及裁决注释；核验 diff 仅此一处——存档 `archive/plans/multitenancy-execution/checkpoints/MT004/migration-tool.test.diff`）
- 报告 `archive/plans/multitenancy-execution/reports/MT004.md` 与 `archive/plans/multitenancy-execution/checkpoints/MT004/**`

## 审阅要点（对照 Issue #47 四条验收 + 父 Spec §4.1/§4.2）

1. 唯一成员关系：复合主键 `(tenant_id, workspace_id, principal_id)`；重复插入被数据库拒绝（测试证据）。
2. 复合关联生效：workspace 不属该公司、或 principal 非该公司成员时插入被拒（复合 FK 真实触发，测试证据）。
3. status active/suspended；epoch 正整数且应用写入路径单调递增（read-then-increase 的并发局限是否如实披露）。
4. 迁移 dry-run 预览 + 专用测试库重放；旧数据/既有表行为不变（enterprise-tenancy.ts 纯追加核验 + 回归）。
5. RLS 最小新增与同文件既有模式一致（policy 形状、app.* settings、GRANT 面）；未改既有表策略（MT012 才做全面 RLS）。
6. 裁决 #3 执行是否最小（migration-tool.test.ts 仅断言演进 + 注释）；TASKS 注册不含业务数据。
7. TDD 证据真实性（red-green/ 存档、mutation/、诚实披露项：pgvector 镜像偏差、brief 哈希笔误）。

## 独立复跑（必须亲自执行并记录退出码）

1. 端口预检 `lsof -i :55453`；起专用库（**必须 pgvector/pgvector:pg16**，plain postgres:16 缺 vector 会迁移失败——实现者已披露）：
   `docker run --rm -d --name openbot-i6r2-mt004-pg -e POSTGRES_DB=openbot_enterprise_mt004_review -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55453:5432 pgvector/pgvector:pg16`
2. 按报告记录的方式受控建立企业基线 schema 与受限角色（`bun scripts/enterprise-test-db.ts migrate`，env 指向 55453；密码放 0600 临时文件，绝不入库/入报告，用后删）。
3. `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55453/openbot_enterprise_mt004_review bun test server/tests/multitenancy/membership-model.test.ts`
4. `MT003_ASSIGNED_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55453/openbot_enterprise_mt004_review bun test server/tests/multitenancy/migration-tool.test.ts`（含 MT004 注册后的全链路）
5. `bun test server/tests/multitenancy/inventory.test.ts server/tests/multitenancy/fixtures.test.ts`（MT001/MT002 回归；fixtures 若需受限角色 env 按其 skip 理由配置）
6. `cd server && bun run typecheck`；`bunx biome check` 被审四个文件。
7. 清理容器与临时 env。
   环境阻塞项标 blocked + 原因，不当通过也不宣称失败。

## 产出

写 `archive/plans/multitenancy-execution/reports/MT004-review.md`（本工作树唯一允许新建/修改的文件）：Verdicts、findings、命令与退出码、哈希复算、enterprise-tenancy.ts 纯追加核验结论。

## 约束

只读被审文件（含 tracked 修改文件——不得再改动它）；不修复；无提交/推送/合并授权；skipped/blocked 不算通过；完成按 preamble worker_done --outcome succeeded|failed 附 --report-path。
