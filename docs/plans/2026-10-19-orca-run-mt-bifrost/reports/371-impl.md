# BP03 / #371 实施报告：已收款订单的订阅与积分交付恢复

- 工作区：`bp371-pilot`（本票独占），BASE = `0a85bb42d622c25d3190db7c7cde117f3b8e57b9`
- 事实源：`docs/specs/2026-10-15-billing-payment-account-and-fulfillment-design.md`（已批准）、`docs/superpowers/plans/2026-10-15-billing-payment-account-fulfillment.md`（Task 4 切片）、票面 #371。
- 交付形态：未提交检查点（无提交/推送授权），逐文件 sha256 见文末。

## 设计结论（先读这段）

票面的三条 AC 落在现有「分步幂等激活」骨架上，缺的是三块：**确定性冲突的终态**、**失败事实的持久保留**、**用户可读的交付状态**。实现没有新建周期表——首期周期事实已经分布在三处持久行上（订单行的 period/owner 快照、订阅投影行的 owner+allowance 周期戳、`plan:<orderId>` 幂等键的 grant 行），再建一张周期表会造出第二份周期真相。对账证据复用既有 reconciler（`plan_grant_missing` / `plan_grant_owner_mismatch` / `applied_without_subscription` / `duplicate_paid_order` 四类 finding 即"两半都核对"的读侧证明）。

具体改动：

1. **`needs_resolution` 进入 `PaymentActivationState`**（迁移 0161 放宽 CHECK）。确定性冲突=「权益周期已被另一订单持有」（duplicate 判定）。`activateOrder` 的 duplicate 分支从"记证据后留在 pending 被无限重扫"改为"记 duplicate_paid 证据 + 落 needs_resolution"；`listPaidPendingActivationOrders` 的 IN('pending','failed') 过滤天然把它排除出重试清单。
2. **所有权判定修正**：`resolveActivationOwnership` 的 claimed-owner 过滤从 `activationState != 'pending'` 收紧为 `IN ('applied','failed')`——needs_resolution 行是"已裁决的落败方"，绝不能被当成 owner（否则旧测试里重放路径会把 duplicate 抬成 owner）。真 store 与两处测试替身同步修正。
3. **失败事实持久化**：订单行新增 `activation_failure_reason`（稳定词：`grant_write_failed`/`provider_unreachable`/`plan_not_found`/`duplicate_paid`/…）与 `activation_next_retry_at`。新 store 方法 `recordActivationFailure({id, reason, nextRetryAt, activationState?})`；applied 时两列清空。sweep 间隔本身就是调度器，`nextRetryAt = now + 60s` 是被保留的"下次重试"事实，不做双重门禁。
4. **用户读取状态**：`PaymentOrderView.fulfillmentState: "processing" | "delivered" | "needs_resolution" | null`——已收款未交付显示 processing（"已付款，权益处理中"），applied 才是 delivered，未收款为 null。收款状态与交付状态独立（spec 原文）。
5. **告警加宽**：`sweepActivations` 的 strike 计数从只数 `failed` 扩为 `failed | pending`——暂时性卡死（grantor 拒写、provider 不可达）连续 3 pass 后同样触发 `activation_retry_exhausted` 告警，覆盖"已收款未交付…告警"的另一半。
6. **reconcile 对齐**：`plan_grant_missing` 审计跳过 needs_resolution 订单（它们本来就不该有 grant，报 missing 是把正确状态当漂移）；冲突单由 `duplicate_paid_order` finding 承接。

**范围判定说明**：规则性拒绝（plan 不存在/非月付/外币）维持 P1-4 的"永远重试+3 连败告警"——票面的"确定性冲突"按 spec §订单、收款与交付 第 4 段解读为收款/权益归属冲突，规则可能在供应商侧被改正是 P1-4 已钉的语义，未动。`nextRetryAt` 不做退避门禁（sweep 定频即调度），如需指数退避另立票。

## AC 逐项证据

### AC1 — Lago 成功、Grant 失败后重试只补 Grant；反向重复通知不多发

| 证据 | 位置 | 结果 |
| --- | --- | --- |
| 单元：grant 抛错 → 订单留 paid+非 applied，`activationFailureReason=grant_write_failed`、`activationNextRetryAt` 落值，视图 fulfillmentState=processing；修复后 sweep 一次 applied，`inserted=true` 的 payout 恰 1 次（订阅半边幂等重问、grant 半边唯一键收敛），两失败列清空，视图 delivered | `payment-service.test.ts` "AC1: Lago landed but the grant refused" | PASS |
| 单元（反向）：grant 落库、stamp 失败 → 同一交付重放 + sweep 重跑，`inserted=true` 仍恰 1 次（重问全答 inserted:false） | 同文件 "AC1 (reverse)" | PASS |
| 集成（真 PG）：首 pass 真实 creditWriter 抛错 → 行级保留失败原因与计划；次 pass 只补 grant：`plan:<orderId>` 键的 grant 行恰 1 条、账户=`payerKey(order.ownerPayerRef)`、到期=供应商周期末（非空、非无限期）；订阅投影行 owner=personal/prefix + allowance 周期=订单周期；第三 pass + 读侧均不再变 | `billing-period-fulfillment.integration.test.ts` "AC1" | PASS |
| 幂等基线回归：既有 "a re-run activation does not double-grant"、"an already-applied order re-asked grants nothing" | `payment-service.test.ts` | PASS |

### AC2 — 已收款未交付显示处理中并告警；确定性冲突进入待处置，不能无限重试或表示完成

| 证据 | 位置 | 结果 |
| --- | --- | --- |
| 显示处理中：paid+未 applied → `fulfillmentState: "processing"`（单元+集成都断言）；applied → "delivered" | 两文件 AC1 用例 | PASS |
| 告警：grantor 持续抛错（verdict=pending）连续 3 pass 触发一次 `activation_retry_exhausted`，第 4 pass 不重复；既有规则拒绝（verdict=failed）告警用例不回归 | "AC2: a paid order stuck processing…" + 既有 "activation_retry_exhausted once" | PASS |
| 待处置：重叠期 challenger → `activationState='needs_resolution'`、`activationFailureReason='duplicate_paid'`、`activationNextRetryAt=null`、duplicate_paid 异常在、无 grant；再跑 3 次 sweep 不变；store 层断言重试清单不含它（=不无限重试）；视图 `needs_resolution`（≠完成） | 单元 "AC2: a deterministic entitlement conflict…" + 集成同名 | PASS |
| 旧契约测试更新：`qa-batch1-duplicate-paid.integration.test.ts` 末段原钉"duplicate 仍在 sweep 重试清单"，按票面改为 needs_resolution 语义（其余断言不动，duplicate_paid 证据可见性仍 PASS） | 该文件 | PASS |

### AC3 — 订阅与 Grant 继承订单 Payer；周期结束依据缺失时不发无限期额度

| 证据 | 位置 | 结果 |
| --- | --- | --- |
| Grant 收款方=`openbot-personal-<ownerPayerRef.id>`（订单 Payer 派生键），非部署键 | 单元 "AC3: the payout lands in the order owner's account key" + 集成 grant 行断言 | PASS |
| 订阅投影 owner 列 = 订单 owner（stamp 半边），allowance 周期 = 订单/供应商周期 | 集成 AC1 订阅行断言 | PASS |
| 无周期依据：`readCurrentPeriodEnd→null` 且订单 periodEnd 缺失 → 不发 grant（attempts=0）、不 applied、失败原因 `grant_no_period`；真 creditWriter 本就拒绝空 expiry（双保险） | 单元 "AC3: neither the provider nor the order answers a period end…" | PASS |

### 对账证据（票面 Change："有对账证据"）

集成测试第 3 例对全库跑真 reconciler：本票订单无 `plan_grant_missing`/`plan_grant_owner_mismatch`/`plan_grant_amount_mismatch`/`applied_without_subscription`/`activation_backlog` finding；唯一预期 finding 是冲突单的 `duplicate_paid_order`（运营队列入口）。交付完成的判定=两半的持久行俱在（grant 唯一键行 + 订阅 owner 戳），由 reconciler 独立核对，不依赖激活函数的一次返回值。

## 测试与验证输出

命令按本仓现状：`bun test` 直跑 node-only 套件会因 `registerHooks` 失败（票面旧命令过时的原因）；node 侧用 `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts`，bun 侧（bun-sql 依赖的集成套件）用 `TEST_DATABASE_URL=… bun test`。专用库 `openbot_bp371`（bf011-pg/5432 容器新建，`scripts/migrate.ts` 全量迁移到 0161，验证后已清空回零基线）。

| 命令 | 结果 |
| --- | --- |
| `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/payment-service.test.ts` | **70/70 pass**（含 6 条新 BP03 用例） |
| `TEST_DATABASE_URL=postgres://postgres@localhost:5432/openbot_bp371 bun test server/tests/billing-period-fulfillment.integration.test.ts` | **3/3 pass** |
| 同 runner：payment-routes / billing-statements / qa-batch1-payment-service / qa-batch1-billing-routes | 59/59 pass |
| 同 runner：billing-routes / payment-mount | 23/23 pass |
| 同 bun：billing-reconcile / plan-credits-personal / subscription-ownership / qa-batch1-payment-store / qa-batch1-duplicate-paid / payment-callback-ownership / personal-credits-read / payment-store / billing-store 集成 | 88 pass / 1 fail——`personal-credits-read` 的 credits/summary 键序断言**在干净 HEAD 上同样失败**（已用带标签 stash 验证后丢弃），属分支既有失败、非本票改动 |
| 同 bun：order-ownership / qa-batch1-replay-storm / qa-batch2-cycle-config-qr / qa-batch2-t5-semantics / qa-batch2-unreadable-fourth / qa-batch3-reconcile | 31/31 pass |
| `bun run --filter server typecheck`（= `tsc --noEmit`） | **exit 0** |
| 迁移 0161 落库验证 | CHECK 含 4 态、两新列存在；`scripts/migrate.ts` 前滚成功 |

未跑：`app` typecheck（无前端改动，视图字段是 server 侧类型）；全套 7929 条 e2e unit corpus（超出票面 Verification 范围，已按改动面全量覆盖 payments/billing 族）。

## 未提交检查点

BASE `0a85bb42d622c25d3190db7c7cde117f3b8e57b9`，全部改动未提交：

```
 M docs/verification/e2e-bun-suites.json
 M server/drizzle/meta/_journal.json
 M server/src/billing/payments/service.ts
 M server/src/billing/payments/store.ts
 M server/src/billing/payments/types.ts
 M server/src/billing/reconcile.ts
 M server/src/db/schema/payment.ts
 M server/tests/payment-service.test.ts
 M server/tests/qa-batch1-duplicate-paid.integration.test.ts
?? server/drizzle/0161_payment_activation_needs_resolution.sql
?? server/tests/billing-period-fulfillment.integration.test.ts
?? docs/plans/2026-10-19-orca-run-mt-bifrost/reports/371-impl.md（本报告）
```

sha256（sha256sum 逐文件）：

```
2b6e8b222fc56adfd870b7fdc4b1c4d79ee03a61581d5dcd8421dadd6ff27aae  docs/verification/e2e-bun-suites.json
684f2984a4b67c67058f7c4e2b739b476d14faa38b8894bb99fd38a501654f2a  server/drizzle/meta/_journal.json
6f6e1154bf55a3b5c3e1952c8e7669c842f895ba8f31600293e39f739f433db8  server/src/billing/payments/service.ts
5ebbcc65736832cdc734db20d3b3cc27e8d60e7846c753a5516ce95e9c63ba49  server/src/billing/payments/store.ts
b55f361d0c091702ae76e73fc1492128cfc5a388686c5e8d63f98c77512534b2  server/src/billing/payments/types.ts
98012cf98c3523d5e846d9ade3bf77bcf542e3f64a0c601639b6785f3dceeb10  server/src/billing/reconcile.ts
a137f4eb7be573caf8364060b8861bdd73bc7c681310dcb8925887f051ef418c  server/src/db/schema/payment.ts
17f02513e3b1221a156235a711c8b3dde82f6be88452b11db496f394ff4c19cd  server/tests/payment-service.test.ts
ef9eb40e6a4424bfa1369bcbf36e0b67c8eba706d7bbf4e87ea6859b6acb9482  server/tests/qa-batch1-duplicate-paid.integration.test.ts
a5a1dc67850da32f2d2d6be36b41c8fe33859b30a5386a3dc45b51ea33f9dabb  server/drizzle/0161_payment_activation_needs_resolution.sql
b789a0ea62765bc7f75589706bc9202dde65849dd98f3ccef7bd43de15c7267a  server/tests/billing-period-fulfillment.integration.test.ts
```

## 跨票接口说明（Ownership 约定：不越域，仅报告）

- `PaymentActivationState` 增加 `needs_resolution`、`PaymentOrderView` 增加 `fulfillmentState`、`PaymentStore` 增加 `recordActivationFailure`——下游 BP05（#373 异常处置）的处置动作应以此状态为入口（把 needs_resolution 拉回 pending 或人工核销）。
- `qa-batch1-duplicate-paid.integration.test.ts` 的重试清单契约已按本票翻转，#373/#374/#375 若引用旧语义需同步。
- `personal-credits-read.test.ts` 的 credits/summary 键序断言为分支既有失败（HEAD 可复现），归其契约 owner，本票未动。

## 遗留

1. **`activationNextRetryAt` 是记录而非门禁**：sweep 定频 60s 即调度器；若运营需要指数退避（长期故障降频），另立票把门禁加上。
2. **needs_resolution 无人工出口**：进入该态后只能由 BP05（#373）的处置动作离开；当前运营可见入口是 duplicate_paid 异常 + reconcile finding + 订单行失败原因。
3. **迁移 0161 为手写**（含 journal 条目）：`drizzle-kit generate` 在本仓迁移历史上已损坏（上游合并重编号致 meta 快包碰撞），与记忆中的上游同步坑一致；文件已按仓库既有语句风格手写并实测前滚。
4. **共享测试库的既有泄漏模式**：多个旧集成套件 afterAll 按 `order_id LIKE prefix%` 清理，而订单 id 是随机 `po-` 前缀，永远清不掉（本票专用库验证后已整体清空规避）；属跨票基建问题，未越域修。
