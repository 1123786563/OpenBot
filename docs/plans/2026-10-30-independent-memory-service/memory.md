# 通用记忆服务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans；用户选择多 Agent 后才使用 superpowers:subagent-driven-development。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付独立可用的应用 API、记忆生命周期、后台处理与 React/HeroUI 管理站。

**Architecture:** MEMORY 独占权威记忆与任务；所有前台/后台动作使用同一授权和来源核验服务。Hindsight、模型网关和应用通知为具名适配；管理界面通过 OIDC 建立本人会话。

**Tech Stack:** Bun/Hono、PostgreSQL/Drizzle、React/HeroUI、Better Auth OIDC 客户端、Hindsight；e2e 统一运行 HTTP/数据库与浏览器测试。

**Spec:** [已批准 Spec v3](../../specs/2026-10-30-independent-memory-service-design.md)。全局约束与 Review Focus 继承[计划入口](README.md)，类型与 API 以[跨仓库合同](contracts.md)为准。本分册路径相对拟建 MEMORY 仓库。

## Global Constraints

应用登记、本人与应用委托分开；按应用及来源隔离，逐内容版本共享；候选不可召回。一天、30 天和备份期限沿用 Spec；所有后台模型调用计入应用/个人预算，不经 OpenBot 业务 API。

## Review Focus

M01 锁定伪造主体与降权；M02/M03 锁定重复提交和敏感内容；M04/M05 锁定并发撤销与清理；M06 锁定未知费用、过期与恢复；M07 锁定统一本人界面不绕过服务规则。

### M01：身份、应用登记与本人委托

**Files:** Create `package.json`、`src/index.ts`、`src/assembly/runtime.ts`、`src/db/schema.ts`、`src/auth/context.ts`、`src/apps/service.ts`、`src/delegations/service.ts`、`src/http/routes.ts`、`packages/client/src/contracts.ts`、`e2e.unit.config.ts`、`tests/support/server.ts`、`tests/access-context.test.ts`。

**Interfaces:** 消费 I01 的 provider 与合同中的 AccessContext。`authorizeMemoryRequest(request: Request, action: "collect" | "recall" | "manage"): Promise<AccessContext>` 只返回服务签发的内部能力。应用登记由独立运营权限入口创建，普通应用不能自我批准。

- [ ] 写 `registered_app_without_user_delegation_is_denied`、`user_id_body_does_not_choose_subject`、`collect_and_recall_are_independent`、`operator_cannot_read_personal_content`；断言无权请求不泄露其他应用候选数量/存在性。
- [ ] 运行 `bun run test tests/access-context.test.ts` 确认预期失败；新仓库正式 test 脚本使用 e2e，真实 Bun HTTP 服务由隔离 fixture 启动。
- [ ] 实现受验证的 OIDC 本人会话与用户委托、登记应用身份、数据库 schema 和合同导出。对 app/subject/source key 建立复合归属约束；关闭根据相同邮箱自动关联及由应用提交 confirmed 状态的入口。
- [ ] 测试转绿，运行 `bun run typecheck`、`bun run build`；验证应用停用和分别撤销采集/读取立即影响后续准入。

### M02：可靠异步接收与任务状态

**Files:** Create `src/ingestion/submit.ts`、`src/ingestion/worker.ts`、`src/ingestion/schema.ts`、`src/ingestion/routes.ts`、`tests/ingestion-reliability.test.ts`；Modify `src/db/schema.ts`、`src/http/routes.ts`。

**Interfaces:** 实现合同中的 `MemoryService.submit`；`processIngestion(jobId: string): Promise<void>` 消费数据库任务租约，任务状态与 JobView 一致。M03 提供提取器，未装配时明确 pending，不伪造候选。

- [ ] 写 `ack_only_after_atomic_persistence`、`same_key_same_payload_returns_original_job`、`same_key_different_payload_conflicts`、`restarted_worker_does_not_duplicate_candidates`、`revoked_delegation_stops_queued_job`；断言片段和任务写入失败时无 202。
- [ ] 运行 `bun run test tests/ingestion-reliability.test.ts` 确认预期失败。
- [ ] 实现原子持久接收、固定归属/提交时间/最迟处理时间、租约、重试与状态查询。任务领取、模型调用前及候选提交前重验授权、来源、暂停和过期。状态 pending 记录预算或依赖原因；不以换任务 ID 绕开幂等。
- [ ] 同一测试转绿；用崩溃重启 fixture 证明任务/候选收敛，过期和取消任务不能再次被领取。

### M03：提取、审核、更正、来源与派生

**Files:** Create `src/memory/service.ts`、`src/memory/schema.ts`、`src/memory/review.ts`、`src/memory/sensitivity.ts`、`src/memory/derivation.ts`、`src/memory/pause.ts`、`src/sources/service.ts`、`src/model-access/port.ts`、`tests/memory-lifecycle.test.ts`、`tests/explicit-remember.test.ts`；Modify `src/db/schema.ts`。

**Interfaces:** 实现 `MemoryService.review/correct`，`extractCandidates(jobId: string): Promise<void>`，`verifyRememberIntent(request: Request): Promise<VerifiedRememberIntent>`；来源与候选拥有服务端固定归属，UI 不能覆盖。

`VerifiedRememberIntent` 由 `src/memory/review.ts` 定义为带私有品牌的本人、应用、内容摘要、来源及单次 nonce 记录，只有受信本人交互验证器可签发。`setPause(context: AccessContext, patch: { learningPaused?: boolean; usagePaused?: boolean }): Promise<void>` 定义在 `pause.ts`，分别更新控制，不删除数据。

- [ ] 写 `candidate_never_recalled_by_origin_app`、`conflict_does_not_overwrite_confirmed_fact`、`correction_keeps_validity_history`、`derived_memory_requires_review_and_all_sources`、`app_claim_is_not_explicit_user_intent`、`sensitive_intent_requires_extra_review`、`learning_and_usage_pause_are_independent`；密码/令牌不得保存，跨来源综合不越过 Spec 限制。
- [ ] 运行 `bun run test tests/memory-lifecycle.test.ts tests/explicit-remember.test.ts` 确认预期失败。
- [ ] 实现候选/确认版本、编辑/拒绝/有效时间、最小依据与派生依赖。去重只提示关联，不合并 app/source 授权；明确记住证明绑定本人、应用、内容、来源和单次 nonce，与普通采集凭据分开。
- [ ] 测试转绿；通过模拟模型输入证明输出不能制造权限、来源或本人审核。接入 M06 的预算适配后，提取及 Hindsight 内部模型调用均走受管调用面。

### M04：按当前权限召回、版本共享与来源核验

**Files:** Create `src/recall/service.ts`、`src/recall/authorization.ts`、`src/sharing/service.ts`、`src/sources/client.ts`、`src/hindsight/adapter.ts`、`tests/recall-isolation.test.ts`、`tests/revocation-race.test.ts`；Modify `src/memory/service.ts`。

**Interfaces:** 实现 `MemoryService.recall/share`；`checkSource(input: SourceCheck): Promise<SourceDecision>` 消费登记的来源适配。Hindsight 只返回可用索引标识，正式正文回读服务权威记录。

- [ ] 写 `same_user_different_apps_are_isolated`、`share_is_read_only_and_version_pinned`、`new_or_derived_content_is_not_auto_shared`、`unknown_consumer_or_source_outage_denies_source_content`；构造检索期间撤销、来源更正和交付前撤销的受控 barrier 测试。
- [ ] 运行 `bun run test tests/recall-isolation.test.ts tests/revocation-race.test.ts` 确认预期失败。
- [ ] 实现来源在线检查和服务内权限 fencing；在最终交付前重读审核/版本/共享/暂停/遗忘及来源资格。锁或事务不得跨远端 HTTP 持有；明确线性化时点并在受控并发测试证明。服务整体故障时调用方不得使用旧索引/缓存恢复授权。
- [ ] 测试转绿；单独断开 Hindsight 后，已确认权威数据可同权限本地降级；断开来源应用只屏蔽其受限内容，RecallResult 不能把不可核验伪装为空记忆。

### M05：遗忘、来源撤销与副本清理

**Files:** Create `src/cleanup/service.ts`、`src/cleanup/notifications.ts`、`src/cleanup/receipts.ts`、`src/cleanup/schema.ts`、`tests/cleanup-propagation.test.ts`；Modify `src/memory/service.ts`、`src/sharing/service.ts`、`src/sources/service.ts`。

**Interfaces:** 实现 `MemoryService.forget/revokeShare/revokeSource`、`acceptCleanupReceipt(appId: string, receipt: CleanupReceipt): Promise<void>`；通知记录与撤销事实同一事务持久化，receipt 必须属于通知接收应用。

- [ ] 写 `revoke_blocks_before_remote_cleanup`、`temporary_source_failure_does_not_delete`、`source_revocation_blocks_dependents_and_cancels_jobs`、`reconnect_does_not_resurrect`、`partial_receipt_is_not_complete`、`wrong_app_receipt_is_rejected`。
- [ ] 运行 `bun run test tests/cleanup-propagation.test.ts` 确认预期失败。
- [ ] 实现持久撤销、派生依赖失效、索引/观察/依据清理、已知接收应用通知与幂等回执。暂时来源不可用与本人明确撤销分开；遗忘/撤销不等待 Hindsight 成功才阻断。
- [ ] 测试转绿；崩溃后重试通知、重复回执、未知下游副本均保持正确的已停止使用/部分清理/完成范围。

### M06：预算、有限保留与备份恢复

**Files:** Create `src/model-access/budget.ts`、`src/model-access/gateway.ts`、`src/retention/sweep.ts`、`src/recovery/gate.ts`、`src/recovery/replay.ts`、`tests/budget-concurrency.test.ts`、`tests/retention-restore.test.ts`；Modify `src/ingestion/worker.ts`、`src/assembly/runtime.ts`。

**Interfaces:** `runBudgetedModelCall<T>(input: BudgetedCall<T>): Promise<T>` 固定应用/本人/任务归属；`sweepRetention(now: Date): Promise<SweepResult>`；`replayRevocations(restoreId: string): Promise<void>` 成功前 recovery gate 拒绝召回。

- [ ] 写 `concurrent_calls_respect_app_and_person_limits`、`unknown_cost_keeps_reservation`、`retry_does_not_double_bill`、`completed_payload_removed_within_one_day`、`queued_payload_and_candidate_expire_at_30_days`、`restore_blocks_until_revocations_replayed`；边界用受控时间而非长 sleep。
- [ ] 运行 `bun run test tests/budget-concurrency.test.ts tests/retention-restore.test.ts` 确认预期失败。
- [ ] 实现独立预算预留/结算、服务身份网关调用和分应用用量；不引入支付订单/积分销售。提取、索引与推理适配都不能直接绕过该预算入口。调用前锁定价格依据与可强制的输入/输出及费用上界；无法证明有限预算的调用不 dispatch，不能只记录一个最大金额却任由 provider 超出。实现原片段、候选、任务载荷与最小依据的独立清理；Hindsight 含内容追踪关闭，备份窗口不超过 30 天。
- [ ] 测试转绿；用隔离备份恢复演练证明撤销重放前拒绝读，不能仅凭配置宣称物理副本清理完成。真实网关费用及备份资源的写入只在当次授权的测试身份下验证。

### M07：独立管理站与最小客户端

**Files:** Create `app/src/routes/{candidates,memories,sources,sharing,activity}.tsx`、`app/src/lib/client.ts`、`app/src/lib/memory/{queries,mutations}.ts`、`app/src/embed/channel.ts`、`packages/client/src/index.ts`、`tests/management-ui.test.ts`、`tests/client-contract.test.ts`、`e2e.web.config.ts`。大括号表示列出的单个文件，不要求路由库支持该语法。

**Interfaces:** 发布合同中的 `createMemoryClient`；React/HeroUI 管理页复用相同 API 与本人规则，提供独立和 embed 展示模式，embed 不再渲染一套宿主侧栏。窗口消息只消费合同的四种无身份消息。

- [ ] 写 `owner_can_review_and_share_exact_version`、`operator_cannot_open_content`、`pending_and_partial_cleanup_are_visible`、`client_preserves_scope_and_error_states`；验证管理入口不能替应用生成普通采集之外的本人证明。
- [ ] 运行 `bun run test tests/management-ui.test.ts tests/client-contract.test.ts` 确认预期失败。
- [ ] 实现候选审核、更正/历史、来源撤销、共享及暂停、任务和清理状态；查询 key 跟随当前本人及应用/来源范围，会话退出清理缓存。登录走顶层受验证 OIDC 回跳；任何窗口消息不得携带权限或 token。
- [ ] 测试转绿，运行 `bun run typecheck`、`bun run build`，再用 `e2e run --config e2e.web.config.ts` 在独立站验证本人两账户隔离与浏览器可操作性。OpenBot 内嵌组合验证归 O03。

## 交付完成条件

M01–M07 每项完成相关验证及独立行为/Spec/质量检查；完整新仓库代码再做集成验证和适用 OCR。独立服务可供 fixture 应用使用后才进入 OpenBot 旧路径删除，不因 UI 能打开而认为后台生命周期已验收。
