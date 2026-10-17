# MT003 / Issue #46 — 独立复审 Task Brief（review2，恢复会话）

你是独立 Pi Reviewer，只读审阅，与实现者（Task `task_60577e388d74` / Dispatch `ctx_a255a1e79beb`，已结算）无共享会话。coordinator 不接受你自批实现。

## 目标

对冻结快照给出**两个独立结论**：(1) Spec compliance——Issue #46 四条验收标准；(2) Code quality。并把有效 finding 按 critical/high/medium/low/info 分级列出（含 file:line 证据）。

## 快照与完整性核验（先做）

- 本工作树 HEAD 必须是 `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`…（完整值 `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` 不对则以 `git rev-parse HEAD` 输出 `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` 为准；正确值：`f0520524f0faa2b4533b9d2f1aa692c8f907ba71` 若不匹配请以实际命令输出为准并停止）。
  **正确 BASE：`f0520524f0faa2b4533b9d2f1aa692c8f907ba71` 以 `git rev-parse HEAD` 实际输出为准（应为 f0520524f0faa2b4533b9d2f1aa692c8f907ba71 开头）。**
- 逐条复算 `docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT003/review-sha256-manifest.txt` 中每个文件的 SHA-256；任何不匹配 → 立即 worker_done --outcome failed 并报告差异，不得继续审阅。
- `git status --porcelain` 应只含清单内 untracked 路径；出现 tracked 修改即报告。

## 审阅对象

- `server/scripts/multitenancy/migrate-test.ts`（33796 bytes）
- `server/tests/multitenancy/migration-tool.test.ts`（33417 bytes）
- 实现报告 `docs/plans/2026-10-15-company-team-multitenancy-execution/reports/MT003.md` 与 `checkpoints/MT003/**`
- 前置（只读参考）：MT001 `server/scripts/multitenancy/inventory.ts`、`server/tests/multitenancy/inventory.test.ts`（已验证集成的 f0520524f0faa2b4533b9d2f1aa692c8f907ba71 快照）

## 审阅要点

1. Issue #46 四条验收逐条对照测试证据（不是对照报告声明）。
2. interfaces.md T01 迁移工具契约：仅 `generate|migrate`、显式 allowlist、编号严格递增、dry-run 默认、apply 必须携带全匹配 manifest、校验先于连接。
3. 数据库安全：只读 `TEST_DATABASE_URL`（经 `runtime-test-environment.ts` seam）；缺失/生产/非法 URL 一律拒绝且零副作用；不读 `.env`、不回退 `DATABASE_URL`。
4. 报告「诚实披露」项（波次 2/5 首跑即绿 + 变异检查、CLI TDZ 缺陷修复）是否与测试代码真实对应；变异检查是否真的能区分行为。
5. 不编写业务迁移内容（TASKS 只有 MT000 自检）。
6. 代码质量：错误处理、注入安全、可读性、与既有 seam 的一致性。

## 独立复跑（必须亲自执行并记录退出码）

1. 端口预检：`lsof -i :55443`（应空闲；被占用则停并报告）。
2. 起专用库（用后删除）：
   `docker run --rm -d --name openbot-i6r2-mt003-pg -e POSTGRES_DB=openbot_enterprise_mt003_review -p 127.0.0.1:55443:5432 postgres:16`
3. `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55443/openbot_enterprise_mt003_review bun test server/tests/multitenancy/migration-tool.test.ts`（预期全过、无 skipped 记为通过）。
4. `cd server && bun run typecheck`。
5. `bunx biome check server/scripts/multitenancy/migrate-test.ts server/tests/multitenancy/migration-tool.test.ts`。
6. 清理：`docker rm -f openbot-i6r2-mt003-pg`。
   若 docker/环境阻塞某项检查：该项标记 blocked（含原因），不得记为通过，也不得据此宣称失败。

## 产出

写 `docs/plans/2026-10-15-company-team-multitenancy-execution/reports/MT003-review2.md`（本工作树内）：Verdicts 表（两个结论各自 PASS/FAIL）、findings（编号/级别/证据/建议）、全部复跑命令与退出码、哈希复算结果。这是你在本工作树唯一允许新建/修改的文件。

## 约束

- 只读被审文件；不修复 finding（修复由 coordinator 路由给实现者）。
- 无提交/推送/合并/生产迁移/部署授权；不触碰 MT001/MT002 文件与共享 test support。
- 不把 skipped/blocked 当通过；报告真实证据。
- 完成后按 preamble 以 `worker_done --outcome succeeded|failed` 结算，摘要含两个结论与 finding 计数，并附 `--report-path`。
