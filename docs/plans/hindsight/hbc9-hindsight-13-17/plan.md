# Hindsight 13–17（#390/#392/#393/#394）实施计划

日期：2026-10-21。工作区：hbc9 worktree（main@f89cce08 + 未提交 #389 前置增量）。
事实源：[Hindsight 个人记忆设计](../../../specs/2026-10-15-hindsight-personal-memory-design.md)、
[ADR 0005](../../../adr/0005-self-hosted-hindsight-for-personal-memory.md)、
[ADR 0008](../../../adr/0008-test-runner-tester-army-e2e.md)、
Issue 快照 `.archive/runs/2026-10-21-hbc9-hindsight-13-17/issues/`。
执行证据（验证命令、退出码、清理结果）归 `.archive/runs/2026-10-21-hbc9-hindsight-13-17/verification/`。

## 前置核对

- #383（scoped-recall）、#384（sync-queue）、#385（degraded-recall）、#387（answer-evidence）、
  #388（derived-judgments）、#389（judgment-review，含 0182 迁移）均已在当前工作树交付并测试通过
  （开工时 `hindsight-judgment-review.integration.test.ts` 24/24 绿）。
- #380（计费准入 credit-reserve）、#82（租户归属）以 main@HEAD 已落地代码为准。

## 交付切片（按票串行）

### Task 1 — #390 遗忘与来源撤销的即时阻断

- 迁移 `0183_hindsight_revocations.sql`：`hindsight_revocations` 撤销台账，一行 = 一个被阻断文档
  （kind memory/source/bot，document_id + bank_id，deletion_state pending/confirmed/failed），
  unique(tenant_id, document_id)。
- 新模块 `server/src/hindsight/revocation.ts`：
  - `forgetPersonalMemory`：走既有三个 forget seam 的同一墓碑策略（改动三个 seam 返回诚实状态并接受
    revocation ledger recorder，先持久阻断、后远端删除）；
  - `revokeAuthorizationTarget`（source/bot）：一个事务内禁用授权行 + 墓碑全部来源受限行 +
    传递闭包墓碑依赖判断 + 写台账，提交后才逐文档远端删除；
  - `retryOutstandingDeletions`：后台重试未完成删除（完成证据属 #14，本票只记 confirmed/failed）；
  - `replayRevocations`：备份恢复后按台账幂等重放阻断。
- 状态面（AC3）：`{ stoppedUsingAt, remoteDeletion: { attempted, outstanding } }`——立即"已停止使用"，
  远端副本清理单独汇报且永不宣称已清除。
- 验证：远端不可用/延迟/旧索引命中注入（scripted service），原文与派生判断均不出现；
  grant 重启用后仍不复活；sync-queue 排空不重发。

### Task 2 — #392 暂停学习与暂停使用

- 迁移 `0184_hindsight_pause_controls.sql`：`hindsight_pause_controls`
  (tenant_id, principal_id) PK，learning_paused_at / usage_paused_at 分离保存。
- 新模块 `server/src/hindsight/pause-controls.ts`（store + 服务），三个召回 seam
  （preference/scoped/judgment recall）入口查 usage 暂停即答空（先于任何远端调用，降级路径同被覆盖），
  候选生成 seam（proposeDerivedJudgmentCandidate）查 learning 暂停即拒（refusal reason 'learning-paused'）。
  本人显式确认/审核/遗忘不受两开关影响。
- 验证：两开关四组合 ×（索引召回、SQL 降级、候选生成、显式确认），切换后下一次运行、Hindsight 宕机
  （暂停时不得走降级补齐）。

### Task 3 — #393 后台预算与运营积压

- 迁移 `0185_hindsight_background_budgets.sql`：`hindsight_budget_caps`（公司/个人月度上限，平台设定，
  无行=不限）+ `hindsight_budget_reservations`（admit/settle/release，unique(tenant_id, work_key) 幂等）。
- 新模块 `server/src/hindsight/budget-gate.ts`：admit 按 (tenant, workKey) 幂等（重试不重复扣费），
  公司/个人上限分别拒绝；已确认内容的读取路径完全不经过该门。
- sync-queue 集成：retain 前 admit（workKey = work 行 id:attempts，deferred 不增 attempts ⇒ 同一
  reservation），传输失败 release、服务已应答 settle；额度耗尽 → deferred（排队）。
- 新模块 `server/src/hindsight/ops-view.ts`：管理员健康快照——服务状态（复用 #398 四态）、积压
  （pending/failed/最旧待处理/未完成删除）、预算用量（公司+按人），结构上不含任何记忆/候选/依据文本。
- 验证：额度耗尽排队、恢复后按原租户与用户身份继续、重试不重复扣费、跨公司互不计入、
  管理员快照无内容泄露（序列化扫描）。

### Task 4 — #394 历史已确认 OpenBot 记忆迁移

- 迁移 `0186_hindsight_legacy_memory_migration.sql`：`hindsight_migration_map`（old_record_id PK →
  新主体，幂等映射）、`hindsight_migration_quarantine`（受控隔离清单，只存 old id + owner + 原因，
  不复制内容）、`hindsight_migration_runs`（游标 + 计数，断点恢复）。
- 新模块 `server/src/hindsight/legacy-migration.ts`：扫描 `personal_memories`（旧系统，owner_user_id
  为全局用户）；只迁有 OpenBot 记录且 confirmed/edited 且活跃的行；公司归属 = 该用户 principal 恰好
  一个 active membership（绝不从全局用户 ID 猜租户；0 个或多个 → 隔离）；formedBy person → 通用偏好、
  bot → Bot 受限、import → 来源受限（并按旧 source.enabled 播种 grant，权限对账）；unreviewed 保持
  待审不迁；新行 id 沿用旧 id（确定性幂等，不重复活跃内容），经 #384 work recorder 入队索引。
- 验证：多公司 + 缺归属数据演练迁移、断点重跑（limit 分批 + 恢复）、迁移前后数量/来源/权限对账、
  样本召回（索引 + 降级）。

## 共同约束

- 每票一个迁移（0183–0186）接续 0182；journal 同步追加；不 commit 不 push；GitHub 只读。
- 新测试文件经 `scripts/e2e-add-driven.mjs` 登记进 `tests/config/e2e-bun-suites.json`（注明原因）。
- 测试库：TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5567/hbc9（容器 orca-w3-hbc-pg，
  本轮新建，先跑迁移）。合约测试用 `deploy/hindsight/test/contract-instance.sh`。
- 不改 `.archive/` 以外的既有归档、不改 `server/src/mastra/**`。
- 状态：Task 1 done · Task 2 done · Task 3 done · Task 4 done（详见 run ledger）。
