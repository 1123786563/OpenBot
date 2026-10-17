# b5-253 (Bifrost 06.2) — Reserve 事务内重验授权与价格依据

BASE: `bab7c0b9`（工作区含前置票未提交集成改动 209 文件，本票只新增文件，不改任何既有文件）。
测试库：`postgres://openbot:openbot@localhost:5590/openbot_b5_253`（coordinator 指定的 b5-verify-pg 5590 容器，全新库，已应用 roles.sql + 全部迁移至 0138；严禁触碰 5432/live `openbot`）。

## 前置契约核实（已读实际实现）

- 06.1 `server/src/billing/credit-service-auth.ts`：`creditProtocolRoutes({authenticate, auditStore, endpoints})` 提供 `endpoints` 组合位；唯一受信身份 `credit_service/bifrost/gateway`；401 统一拒绝。**只消费，不改**。
- 04.5 `server/src/db/schema/access-grants.ts` + `bot-services/access-grants.ts`：`AccessGrant{grantId,userId,botId,status:'active'|'revoked'}`；撤销=条件 UPDATE 行锁（admission-bound，不释放既有预留）。
- 03.2/03.3 `server/src/gateway/price-snapshot.ts` + `price-status.ts`：`gatewayPriceSnapshots(provider,model,capability,snapshotVersion)` append-only；`assertPriceSnapshotDims`/`classifyPriceDims`（known/free/unknown；free 是价格，unknown 永非 0）。直接消费，勿复制语义。
- 03.4 同步状态 `gatewayCatalogSyncState`（单例行 `gateway_catalog_sync`，`lastSuccessfulSyncAt`）已交付；**03.6 的 assertCatalogFresh 门禁模块不在基线**（已确认缺失）。本票在 Reserve 重验逻辑内以 `lastSuccessfulSyncAt` + 注入窗口（默认 15 分钟，03.6 票面默认值）实现新鲜度拒绝——属本票"重验逻辑"范围；03.6 落地后可替换实现，报告如实记录此偏差。
- 02.x `server/src/billing/payer.ts`：`payerKey(ref)` 纯函数推导账户键；`payer_accounts` 映射行（kind+payerId 唯一）；`unknown_owner` 隔离。`payer-binding.ts`：`bindPayer` 冻结绑定。
- 03.7 `gateway-model-open-scope.ts` 语义：open = scope 行 state='open' 且 ref 仍在 last-good catalog（`gatewayModelCatalogRefs` 三元组存在）。
- credit-writer `server/src/billing/credits-writer.ts`：`reserveCredits{externalCustomerId,idempotencyKey,maximumCents,expiresAt}` 自开事务（customer 行锁 + 分配）。**本票不改该文件**（越界问题已编排 ask 上报 coordinator，未获批前不动）：同事务写入通过把 `createCreditWriter(tx)` 绑定到外层事务实现——drizzle 事务对象的 `.transaction()` 是 SAVEPOINT，全部语句落在同一连接同一事务，外层提交才可见。writer 仍是 `credit_reservations` 唯一写方。
- 06.3（下游）Consumes `CreditWriter.reserveCredits` 原子语义——本票不抢其"预留写入路径"范围；06.4 做 payer 篡改比对——本票只做 payerRef 经映射解析， grant↔payer 一致性留给 06.4。
- 06.5（下游）做 bound 取整与版本锁定——`rateVersion` 本票仅形状校验并随请求契约透传。
- ADR 0001/0003：保守计数（`input-bound.ts` CONSERVATIVE_*）只能用于拒绝，不得作为上限证据；可强制证据 = 机制性封顶（provider 强制 max_tokens / 自执行截断上限）。

## 设计决策

1. **新模块 `server/src/billing/credit-reserve.ts`**（唯一生产代码新文件）：
   - `createCreditReserveService(deps)`：`{database, botServices?, now?, catalogFreshnessWindowMs?=900_000}`。
   - `service.reserve(request)` → 自开 `database.transaction(tx)`，先纯形状校验（拒绝零读写），再在事务内依序重验，全部通过后 `reserveCredits`（绑定 tx）写入预留，服务端生成 `attemptId`（`att-`+8B hex，受信生成）。
   - 导出 `reserveCreditInTransaction(tx, deps, request)` 供并发注入测试与 06.3 消费。
2. **请求契约（Produces）**：`{grantId, payer: PayerRef, model: ModelRef, snapshotVersion, rateVersion, boundEvidence, maximumCredits, idempotencyKey, expiresAt?}`。`boundEvidence` 为非空数组，closed kinds：`provider_max_tokens` / `self_enforced_input_truncation`，各带正整数 `maximumTokens`；封闭集之外（含保守估算形状）一律 `bound_evidence_not_enforceable`。
3. **拒绝码（封闭集，拒绝响应带 reasonCode 且零写入）**：`request_invalid`、`grant_invalid`（未知/撤销/跨 Bot/Bot 停用）、`payer_unresolved`、`model_not_open`（scope 未开放或已下架）、`catalog_stale`、`catalog_never_synced`、`price_basis_not_found`、`price_unknown`（带 classification 的 reasonCode+missingDimensions）、`bound_evidence_not_enforceable`、`insufficient_credits`（带 availableCents）。
4. **事务内重验顺序**：授权行 `FOR SHARE`（并发撤销被挡到提交后）→ Bot 状态 → payer 映射（tx 内读 `payer_accounts`，键用 `payerKey` 重推导比对）→ 开放范围（scope 行 open + catalog 三元组存在）→ 新鲜度（单例 lastSuccessfulSyncAt，超窗 `catalog_stale`，从未同步 `catalog_never_synced`）→ 价格（按锁定 snapshotVersion 读 append-only 行，dims 经 `assertPriceSnapshotDims` 复验、`classifyPriceDims` 重分类；unknown 拒绝，free 通过）→ 预留写入。任一不满足即 return，事务提交时无任何写入。
5. **HTTP 端点**：`creditProtocolEndpoints(deps)` 返回 Hono 子应用 `POST /reserve`，由调用方传入 `creditProtocolRoutes({endpoints})` 挂载（app.ts 装配属 07.x，不在本票）。reserved→201；拒绝→422 `{error, code: reasonCode, ...}`；JSON 解析失败→400。鉴权由 06.1 中间件负责（测试经真实 credential 走完整门）。
6. **无新增迁移、无 schema 改动**：attemptId 只在响应返回并随预留 idempotencyKey 关联（`creditReservations` 既有列足够；持久化 attempt↔reservation 映射由 06.7 状态查询票处理）。

## 文件级计划

| 文件 | 动作 |
| --- | --- |
| `server/src/billing/credit-reserve.ts` | 新增：请求/拒绝类型、纯校验、`reserveCreditInTransaction`、service、`creditProtocolEndpoints` |
| `server/tests/reserve-revalidation.integration.test.ts` | 新增（票面指定文件名）：五类拒绝 + 拒绝不写库 + 同事务并发注入 + free/unknown 分辨 + HTTP 边界（真实 06.1 凭据） |

## RED→GREEN 验证命令

```bash
cd server
export TEST_DATABASE_URL='postgres://openbot:openbot@localhost:5590/openbot_b5_253'
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test ./tests/reserve-revalidation.integration.test.ts   # 文件参数必须 ./ 前缀
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test ./tests/billing-credits-writer.integration.test.ts  # 既有写入方不回归
bun run typecheck
bunx biome lint --error-on-warnings src/billing/credit-reserve.ts tests/reserve-revalidation.integration.test.ts
```

## Review Focus

- 并发撤销窗口：重验读必须持授权行锁直至提交，否则撤销漏过（并发注入测试钉死）。
- 拒绝路径写库：五类拒绝 + payer/request 拒绝前后行数快照必须为零差（含 billing_customers）。
- free vs unknown：全零价格放行、unknown 拒绝，两者不得混同。
- 新鲜度原因词：拒绝码必须指新鲜度（catalog_stale/never_synced），不得报成模型不存在。
- 估算证据：`input-bound` 的保守计数不得出现在可强制证据封闭集（源代码 import 边界 + kind 封闭集双断言）。
