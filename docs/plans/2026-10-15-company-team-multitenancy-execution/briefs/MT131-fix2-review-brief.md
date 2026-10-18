# MT131-fix2 — 修复轮独立复审 Task Brief

你是全新独立 Pi Reviewer（与修复实现者、原实现者、原复审者均无共享会话）。只读审阅，不修复 finding。

## 目标

两个独立结论：(1) 修复有效性——`archive/plans/multitenancy-execution/reports/MT131-review2.md` 的 F1/F2（Medium）是否真实关闭且无回归，F3/F4（Low）处置是否得当；(2) Code quality（修复后整体）。有效新 finding 按 critical/high/medium/low/info 分级（含 file:line 证据）。

## 快照核验（先做）

- `git rev-parse HEAD` = f0520524 开头（完整值以 `archive/plans/multitenancy-execution/checkpoints/MT131/fix2-review-sha256-manifest.txt` 首行为准）。
- 逐条复算该 manifest 每个文件 SHA-256；不匹配 → worker_done --outcome failed。
- `git status --porcelain` 只含清单内 untracked 路径。

## 审阅对象

- 修复后 `server/scripts/multitenancy/acceptance-harness.ts`、`server/tests/multitenancy/acceptance-harness.test.ts`
- 修复报告 `archive/plans/multitenancy-execution/reports/MT131-fix2.md` 与 `archive/plans/multitenancy-execution/checkpoints/MT131-fix2/**`
- 参照：原复审 `archive/plans/multitenancy-execution/reports/MT131-review2.md`、`archive/plans/multitenancy-execution/checkpoints/MT131/fix2-transfer-manifest.txt`（修复前哈希）

## 审阅要点

1. **F1 关闭判据**：环境断言从 `REAL_ENV` 解析推导（或 fake env 断言解析输出）；不再出现实现者私有库名/端口字面量；任意合规专用环境全绿。
2. **F2 关闭判据**：`validateEvidencePlan` 拒绝控制域（HARNESS_CONTROL_DOMAIN）与 `harness.` 前缀 scenarioId 进入业务 evidence plan；harness 内部自检仍可用控制场景；只收紧不放松。
3. **F3/F4**：缺值旗标抛 `HARNESS_FLAG_MISSING_VALUE`；tempDir 处置（实际使用或删除 mkdir）与报告说明一致。
4. **回归**：MT001/MT002 文件未动（对照前置哈希）；「绝不合成通过」语义不变；既有用例全过。
5. TDD 证据真实性；报告/检查点完整性。

## 独立复跑（必须亲自执行并记录退出码）

1. 端口预检（55451 与硬编码 45435）。
2. 起专用库（用后删除）：`docker run --rm -d --name openbot-i6r2-mt131fix2-pg -e POSTGRES_DB=openbot_enterprise_mt131fix2_review -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55451:5432 pgvector/pgvector:pg16`
3. 自建受限角色 env `/tmp/mt131fix2-review-env.sh`（0600、随机密码、绝不打印、用后删；TEST_DATABASE_URL、ENTERPRISE_TEST_SETUP_DATABASE_URL 及三受限角色 URL 指向 55451；受控 migrate/建角色参照 `server/scripts/enterprise-test-db.ts` 与原复审报告 §1-§2）。
4. `source /tmp/mt131fix2-review-env.sh && bun test server/tests/multitenancy/acceptance-harness.test.ts`（合规专用环境全绿 = F1 直接证据）
5. `cd server && bun run typecheck`；`bunx biome check` 两文件。
6. 清理容器与 env 文件。
   环境阻塞项标 blocked + 原因。

## 产出

写 `archive/plans/multitenancy-execution/reports/MT131-fix2-review.md`（本工作树唯一允许新建/修改文件）。

## 约束

只读被审文件；不修复；无提交/推送/合并授权；skipped/blocked 不算通过；完成按 preamble worker_done --outcome succeeded|failed 附 --report-path。
