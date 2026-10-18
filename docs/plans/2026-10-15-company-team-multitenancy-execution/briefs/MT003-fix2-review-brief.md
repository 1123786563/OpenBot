# MT003-fix2 — 修复轮独立复审 Task Brief

你是全新独立 Pi Reviewer（与修复实现者、原实现者、原复审者均无共享会话）。只读审阅，不修复 finding。

## 目标

两个独立结论：(1) 修复有效性——`archive/plans/multitenancy-execution/reports/MT003-review2.md` 的 F1/F2（Medium）是否真实关闭且无回归，F3/F4（Low）附带项处置是否得当；(2) Code quality（修复后整体）。有效新 finding 按 critical/high/medium/low/info 分级（含 file:line 证据）。

## 快照核验（先做）

- `git rev-parse HEAD` = f0520524 开头（完整值以 `archive/plans/multitenancy-execution/checkpoints/MT003/fix2-review-sha256-manifest.txt` 首行为准）。
- 逐条复算该 manifest 每个文件 SHA-256；任何不匹配 → worker_done --outcome failed 并报告差异。
- `git status --porcelain` 只含清单内 untracked 路径。

## 审阅对象

- 修复后 `server/scripts/multitenancy/migrate-test.ts`、`server/tests/multitenancy/migration-tool.test.ts`
- 修复报告 `archive/plans/multitenancy-execution/reports/MT003-fix2.md` 与 `archive/plans/multitenancy-execution/checkpoints/MT003-fix2/**`
- 参照：原复审 `archive/plans/multitenancy-execution/reports/MT003-review2.md`（F1-F4 定义）、修复前基线（manifest 中记录的修复前哈希对应内容，如需可从 `archive/plans/multitenancy-execution/checkpoints/MT003/fix2-transfer-manifest.txt` 溯源）

## 审阅要点

1. **F1 关闭判据**：专属端点经显式 env（如 `MT003_ASSIGNED_TEST_DATABASE_URL`）且过与主路径相同的全部安全检查（回环/单段库名/`openbot_enterprise_*` 前缀/非生产拒绝）；未配置时显式 skip + 理由；任何合规专用 URL 下集成测试真实运行（结构性 skip 消失）。
2. **F2 关闭判据**：migrate 读取 journal 每步 `statement_digest` 与当前计划逐步骤比对；漂移 → 连接后 apply 前拒绝，提示人工审查，无自动修复/重放；已有 up-to-date no-op 语义在一致时不误伤。
3. **F3/F4**：`--manifest` 无 `--apply` 明确拒绝；`expectNoSideEffects` 断言 `reads==[]`。
4. **回归**：TASKS 仍仅 MT000；既有 34 pass 基线用例全数保留且通过；无任何安全拒绝被放宽；CLI 行为除 F3 收紧外不变。
5. TDD 证据真实性（RED 输出对应新测试；首跑即绿项的诚实披露）。
6. 报告与检查点完整性（哈希、命令、退出码）。

## 独立复跑（必须亲自执行并记录退出码）

1. 端口预检后起专用库（用后删除）：
   `docker run --rm -d --name openbot-i6r2-mt003fix2-pg -e POSTGRES_DB=openbot_enterprise_mt003fix2_review -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55450:5432 pgvector/pgvector:pg16`
2. `MT003_ASSIGNED_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55450/openbot_enterprise_mt003fix2_review bun test server/tests/multitenancy/migration-tool.test.ts`（预期全过无 skip）
3. 无该 env 时同命令（预期集成用例显式 skip 且理由正确）
4. CLI 冒烟：dry-run / generate / apply / re-apply / 篡改 digest manifest 拒绝 / journal 漂移场景（手工修改 journal 一行 digest 后 migrate 应拒绝——F2 的直接验证）
5. `cd server && bun run typecheck`；`bunx biome check` 两文件
6. 清理容器。
   环境阻塞项标 blocked + 原因，不当通过也不宣称失败。

## 产出

写 `archive/plans/multitenancy-execution/reports/MT003-fix2-review.md`（本工作树唯一允许新建/修改文件）：Verdicts（修复有效性 + Code quality 各自 PASS/FAIL）、findings、命令与退出码、哈希复算。

## 约束

只读被审文件；不修复；无提交/推送/合并授权；skipped/blocked 不算通过；完成按 preamble worker_done --outcome succeeded|failed 附 --report-path。
