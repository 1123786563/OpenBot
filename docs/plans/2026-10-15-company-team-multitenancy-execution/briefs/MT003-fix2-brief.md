# MT003-fix2 / Issue #46 — 修复轮 Task Brief（关闭复审 F1/F2，附带 F3/F4）

角色：`backend_implementer`（修复轮）；完成后由全新独立 Pi Reviewer 复审。你是修复实现者，不是原审阅者。

## 背景与输入

- 原实现（Task `task_60577e388d74`，已结算）+ 独立复审 `reports/MT003-review2.md`（Task `task_8ae36eaedbc7`，Spec PASS / Code PASS，但有 2 Medium 有效 findings 必须关闭）。
- 复审报告已随快照转移到你的工作树：`docs/plans/2026-10-15-company-team-multitenancy-execution/reports/MT003-review2.md`（F1/F2/F3/F4 定义与 file:line 证据见其 §5）。
- 被修复对象当前哈希（先复算，不符即 worker_done --outcome failed）：
  - `server/scripts/multitenancy/migrate-test.ts` = `e00f90a45edfe02c21c227ca10f42c196d57ee41e644d7eab8fcd0c979ca76bf`
  - `server/tests/multitenancy/migration-tool.test.ts` = `e004868a3793aebb05fce46c5547384064bfe0ce30df5180143b4ada7794d461`
- HEAD 必须 = `f0520524f0faa2b4533b9d2f1aa69c8f907ba71`。

## 必须关闭的 Findings（逐条 TDD：先 RED 后 GREEN）

- **F1（medium）**：真实库集成测试把专属库硬编码为实现者端点（`127.0.0.1:55433` + `openbot_enterprise_mt003_test`，migration-tool.test.ts:842-848）。改为：专属端点来自显式 env（如 `MT003_ASSIGNED_TEST_DATABASE_URL`），必须通过与主路径相同的全部安全检查（`resolveTestDatabaseTarget`/`testDatabaseUrlFrom` 链：回环、单段库名、`openbot_enterprise_*` 前缀、非生产拒绝）；未显式配置时保持显式 skip + 理由。复审在 55443/review 库上验证了该 skip 行为，修复后该 URL 必须能真实运行集成测试（33→34 pass 结构消失）。
- **F2（medium）**：migrate 从不核对 journal 已记录 digest 与当前计划的一致性（`readJournalNumbers` 只 SELECT number，migrate-test.ts:653-661；up-to-date 只看编号前缀）。改为：migrate 一并读取每步 `statement_digest` 并与当前计划逐步骤比对；漂移即拒绝（连接后、apply 前），提示「journal 与当前计划漂移，需人工审查」，且不得自动修复/重放。

## 附带（同一文件、低风险，一并修复）

- **F3（low）**：`migrate <task> --manifest F` 无 `--apply` 时 manifest 被静默忽略（parseArgs :455-462 只拒绝 apply&&!manifest）。改为：`--manifest` 出现而 `--apply` 缺失时给出明确拒绝或警告（拒绝优先，与既有 args 拒绝风格一致）。
- **F4（low）**：`expectNoSideEffects` 只断言 connect==0/writes==[]（migration-tool.test.ts:80-83）。追加断言拒绝路径 `reads==[]`。

## 拥有文件（其余一律不动）

- `server/scripts/multitenancy/migrate-test.ts`
- `server/tests/multitenancy/migration-tool.test.ts`
- `docs/plans/2026-10-15-company-team-multitenancy-execution/reports/MT003-fix2.md`（新建）
- `docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT003-fix2/**`（新建）

## 约束

- 不改 TASKS 注册表语义（仍只有 MT000）；不放宽任何既有安全拒绝；保持所有既有测试通过（34 pass 基线不回退）。
- 保持向后兼容的 CLI 行为除 F3 明确收紧外不变。
- TDD：每个 finding 先写失败测试（RED 记录输出），再实现（GREEN），REFACTOR 保持全绿；首跑即绿项按诚实披露处理。
- 无提交/推送/合并/生产迁移/部署授权；未提交检查点 + SHA-256 清单。

## 测试资源（专用，用后清理）

- `lsof -i :55446` 确认空闲后：
  `docker run --rm -d --name openbot-i6-mt003fix2-pg -e POSTGRES_DB=openbot_enterprise_mt003fix2_test -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55446:5432 postgres:16`
- `MT003_ASSIGNED_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55446/openbot_enterprise_mt003fix2_test`（F1 修复后的新 env 路径；同时验证旧硬编码路径不再必需）。

## 验证命令（全部记录退出码）

1. `MT003_ASSIGNED_TEST_DATABASE_URL=… bun test server/tests/multitenancy/migration-tool.test.ts`（预期全过无 skip：旧 34 pass + 新增 F1/F2/F3/F4 用例）
2. 无 env 时同命令（预期集成用例显式 skip 且理由正确，其余全过）
3. `cd server && bun run typecheck`
4. `bunx biome check` 两个文件
5. `docker rm -f openbot-i6-mt003fix2-pg`

## 产出

- `reports/MT003-fix2.md`：修复说明、RED/GREEN 证据、四个 finding 的关闭映射、命令与退出码。
- `checkpoints/MT003-fix2/`：before/after 哈希、diff、review-package.json（含修复后两文件哈希）。
- worker_done --outcome succeeded|failed，附 --report-path --files-modified。
