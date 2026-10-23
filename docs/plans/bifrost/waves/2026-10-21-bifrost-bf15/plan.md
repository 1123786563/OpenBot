# Bifrost 组 17 续线 bf15 — #327/#328/#329/#330 实施方案

- 工作区：`/Users/wuyongjun/orca/workspaces/OpenBot/bf15`（main@`a789f6a4` + 未提交前置增量至 0195；本 Run 增量叠加其上，全部未提交、不 push）。
- 票号为准（GitHub 1123786563/OpenBot，只读）：#327=B17.3 providerJobID 丢失进入未知恢复；#328=B17.4 状态/结果查询只读授权；#329=B17.5 重复 GET 与完成通知只结算一次；#330=B17.6 按可靠终态 usage 结算。依赖链 #327←#326（基线已交付）、#328←#326、#329←#328、#330←#329，按序串行。
- 测试库：容器 `orca-w3-bf-pg`（127.0.0.1:5566，既有容器）内新建 `bf15` 库，全链迁移至 0195 后接 0196/0197。
- bifrost 子模块：本地克隆 pin `ad9470a5`，零提交（仅允许未跟踪 Go 测试文件）。
- 事实源：父 Spec #5、ADR 0002/0003/0004、`docs/specs/2026-10-14-bifrost-integration-design.md` Q26、CONTEXT.md 异步任务术语。

## Task 1 — #327 B17.3 派发丢答进入未知恢复（主战场 both）

**Owned files**：`server/src/billing/async-job-submit.ts`（最小扩展）、`server/src/billing/async-job-recovery.ts`（新）、`server/tests/async-lost-jobid.integration.test.ts`（新，driven 登记）。

**设计**：
- 派发 seam 入参携带稳定提交标识 `submitIdempotencyKey`（票面步骤 1）；派发答 `lost` 时提交路径立即调 `markReservationUnknown(reservationId, "async_dispatch_answer_lost")`（06.8 seam 注入，缺省 `createCreditWriter(database)`）——预留转 `unknown`、全额占用、交给 08.1 恢复扫描（扫描自动命名 unknown 持仓）。
- 新恢复模块两入口：`listUnconfirmedAsyncJobs`（`dispatch_unconfirmed` 全量，恢复扫描序）+ `createAsyncDispatchRecoveryService({database, findProviderJob})` 的 `recoverLostDispatch(jobId)`：读行 → 确保持仓 unknown（幂等，终态事实不动）→ 以 `{provider, model, submitIdempotencyKey}` 查供应商（注入 seam，closed vocabulary found/not_found）→ 找到则 `attachAsyncJobProviderId`（17.1 的唯一写，unconfirmed→submitted，冲突浮出）；找不到保持 dispatch_unconfirmed + unknown 持仓，不释放不结算不再派发。
- 决不：释放、结算、再派发（镜像 recovery-scan 纪律）。

**RED**：注入响应丢失 → 不建第二任务（重放答同一行、dispatch 一次、预留一行）；持仓 unknown 全额占用；扫描命名；找回成功补映射（反向读通、重放幂等）；找回失败保持 unknown 不释放（无 ledger 行、余额按全额扣）。

## Task 2 — #328 B17.4 状态/结果查询只读授权（主战场 openbot）

**Owned files**：`server/src/billing/async-job-status.ts`（新）、`server/tests/async-status-authz.test.ts`（新，driven 登记）。

**设计**：`createAsyncJobStatusService({database})` —— 形状校验（账户/公司范围字段在场即拒 `payer_conflict`，06.4/09.3 纪律）→ grant 解析 payer（server-side，06.7 同款：revoked 也答，可见性≠准入）→ 按 jobId / submitIdempotencyKey / providerJobId 恰一读取 → 缺行或他人归属答**同一**裸 `not_found`（不泄存在性）；本人答任务状态（dispatch 状态 + 持仓状态 + 双锁定版本 + cap/entryCount，全部逐字读行，不推导）。结构只读：仅 `database` 依赖，无 Reserve/Settle/dispatch seam。管理员访问不在此面（既有审计路径），非本面不设旁路。附 `asyncJobStatusEndpoints` 工厂（挂部署侧服务身份守卫后），路由语义由测试经工厂钉住。

**RED**：他人任务/缺任务/坏 grant 三路同答 not_found（无差异）；本人可读全量字段；查询零账务零派发（spy + 表行数断言）；账户字段在场拒。

## Task 3 — #329 B17.5 重复 GET 与完成通知只结算一次（主战场 openbot）

**Owned files**：`server/drizzle/0196_async_settle_triggers.sql` + journal、`server/src/db/schema/credit-reservations.ts`（+表）、`server/src/billing/async-terminal.ts`（新）、`server/tests/async-settle-once.integration.test.ts`（新，driven 登记）。

**设计**：
- 0196 表 `async_settle_triggers`：job_id PK/FK、idempotency_key UNIQUE、terminal_state CHECK(completed/failed/cancelled)、total/poll/notification_triggers、first/last_triggered_at、last_source CHECK(poll/notification)。
- `asyncTerminalSettleKey(jobId, terminal)`：纯函数统一幂等键 `async-terminal-settle:<jobId>:<state>:<sha256(usage 规范序)>` —— 通知与轮询描述同一终态必得同键（usage 指纹即"终态版本"）；深闸仍是 06.9 预留结算幂等（reservation 唯一、同实付回放首果、异实付冲突）。
- `createAsyncTerminalSettleService({database, settle, now?})`：`settleTerminal({jobId?|providerJobId?, terminal{state,usage,evidence}, source})` → 解析任务（反向映射支持通知携带 providerJobId）→ UPSERT 触发行（计数器原子自增，首插记键）→ 已 settled 答 `already_settled`（计数照记=可观测）→ 调 06.9 settle seam（evidence=provider_usage_report、settledBy=async-terminal:<source>、统一键）。`readAsyncSettleTrigger(jobId)` 供 22.3。
- 查询路径（17.4）只读，无结算 seam —— 结算只由本后台终态处理触发。

**RED**：并发 10 轮询 + 3 通知 → 一笔 ledger、触发行 total=13/poll=10/notification=3、键=纯函数值；重复状态查询零触发；异 usage 二报 → settlement_conflict 不二扣。

## Task 4 — #330 B17.6 按可靠终态 usage 结算（主战场 both）

**Owned files**：`server/drizzle/0197_async_settlement_details.sql` + journal、`server/src/db/schema/credit-reservations.ts`（+表）、`server/src/billing/credits-writer.ts`（union+写分支）、`server/src/billing/async-terminal.ts`（settle 路径深化）、`server/src/audit.ts`（+1 事件）、`server/src/billing/credits.ts`（消费明细 join）、`server/tests/async-terminal-settlement.integration.test.ts`（新，driven 登记）。

**设计**：
- #329 的"调 06.9"深化为图片/语音同款自有结算组合（image-settlement 模板）：`lockedBasisOfReservation` → `resolveLockedReservationBasis`（锁版本，绝不估算/最新价）→ `computeReservationCeiling` 精确定价 + `computeDimensionScaledUnits` 维度分摊 → `writer.settleReservation`（lineDetail + dimensionBreakdown，同一事务落账）。统一键与触发计数逻辑不动（#329 测试保持绿）。
- 0197 表 `credit_async_settlement_details`：reservation PK/FK、ledger FK、capability（随 async_jobs 闭集）、job_id UNIQUE（任务归因锚）、provider_job_id、entry_count、terminal_state、actual_usage jsonb(object)。writer settle 事务内写（12.2/0179 同款一次性提交）。
- 消费明细（credits.ts consumption）join 新表 → lineDetail 分支 `capability: 任务能力 + asyncJob{jobId, providerJobId, entryCount, terminalState}`——按任务归因从公开边界可读。
- 超上限：精确实付 > maximum → ledger 全额记录、applied 封顶持仓、released=0（writer 既有语义），**新增审计事件 `billing.async_settle_over_cap`**（closed vocabulary，payload 含 jobId/maximum/exactCost/overBy），outcome 携带 overCap 明细——不静默丢弃、不静默追加、交 08.x 处置。
- 未用额度释放：settle 的 released 侧回补可用余额（06.9 既有）。

**RED**：上限 100 实付 60 → 结算 60、释放差额、余额恢复；实付超上限 → ledger 全额/applied=持仓/审计事件在；锁定版本（结算前追加 v2 快照翻价，仍按 v1 计价）；明细行 + consumption 归因 jobId。

## Global constraints

- 每票 RED→GREEN→针对性回归；真库 bf15@5566；`bun run --filter server typecheck`；`bunx biome lint --error-on-warnings <changed>`；`cd bifrost/framework/jobaccounting && go test ./...`（回归；Go 侧仅允许未跟踪测试文件）；新测试 `node scripts/e2e-add-driven.mjs` 登记 + `node scripts/e2e-coverage-audit.mjs`。
- 已知基线红勿修不报：billing-visibility / openmuse-activity / gateway-admin 7/2/audit、workshop.*、usage-outbox 零用量 settle×#343 空分摊、bootstrap-local-gateway typecheck 2 处。
- 不 commit、不 push；GitHub 只读；不动 `.archive/`、`server/src/mastra/**`；OCR 按用户裁决跳过（最终提交前完整范围跑一次的旧裁决已被"不再使用 OCR 扫描"取代）。
- 报告：`reports/orca-dag-wave3-bf15.md` + 增量清单 + SHA-256 + 开工基线快照（区分前置增量与自有增量）。
