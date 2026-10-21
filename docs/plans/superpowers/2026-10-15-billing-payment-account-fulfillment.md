# Billing Payment Account and Fulfillment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让个人与公司购买、收款、订阅周期、积分发放、严格消费和异常处置始终归属同一固定付款账户，并让已收款未交付可恢复、可对账。

**Architecture:** 在现有支付事实、Lago 订阅投影、CreditWriter/Credit Ledger 上增加不可变 `PayerRef` 与周期交付事实。支付渠道只确认资金，交付工作按订单归属幂等推进；消费路径统一用同一账户容量规则。先完成账户映射与历史数据盘点，再按纵向切片接入购买、续期、处置和页面。

**Tech Stack:** Bun、TypeScript、Hono、Drizzle ORM、PostgreSQL、React、TanStack Query、Lago、支付宝与微信支付现有适配器。

**Spec:** `docs/specs/2026-10-15-billing-payment-account-and-fulfillment-design.md`；同时遵守 `docs/specs/2026-10-14-company-team-multitenancy-design.md`、`docs/specs/2026-10-14-bifrost-github-spec.md`、`docs/adr/0003-bifrost-openbot-credit-admission.md`、`docs/adr/0004-company-team-tenancy.md` 和 `CONTEXT.md`。

## Global Constraints

- 公司工作台固定公司付款账户；外部授权 Bot 固定个人付款账户。余额不足、团队切换、回调、重试不得切换付款方。
- 公司与个人均可在线购买；公司授权管理员还可直接发放积分，两种来源写入同一公司积分账本。
- 付款账户由服务端可信身份或业务对象确定，持久化后不可被请求 body/header、回调或当前团队更改。
- 金额与积分使用已有整数最小单位；兑换和尾差保持精确有理数语义。支付渠道交易唯一键包含渠道及交易 ID。
- 严格计费的未知结果预留持续占容量；技术过期仅触发调查。无完整价格、可靠用量和可强制上限的能力保持不可用。
- 已收款未交付不得显示为交付完成。每次真实收款保留事实；同一订阅周期只交付一次积分。
- 对账只读。退款、补发、释放、结算、平台补偿是有权限、证据、幂等键和审计的独立动作；本计划不实现自动退款或正式税务发票。
- 现有已批准公司多租户工作尚未全部交付。公司财务和采购权限只通过可信 Tenant/Membership 服务接口接入；若该接口尚未集成，相关公司入口 fail closed，不借用全局 `requireAdmin` 或客户端 tenant ID 代替。
- 计划专属执行工作区的 BASE、用户既有改动、迁移前数据清单、每任务检查点、验证与 Review 证据在实施 Ledger 记录。用户未授权提交时使用未提交检查点；不以空 `BASE..HEAD` 代替审查。

## Review Focus

1. 两种 Payer 的 `id` 字符串相同：账户映射、幂等键和查询仍完全隔离；Task 1/2 的数据库测试覆盖。
2. 付款回调已验签但数据库写失败：返回可重试响应，重投只确认一笔资金事实；Task 3 测试覆盖。
3. Lago 已创建订阅但 Grant 写入失败：恢复只补 Grant，并显示处理中；Task 4 测试覆盖。
4. 续期通知乱序或周期被供应商修正：无可靠收款或周期事实时不发放、不猜测周期；Task 5 测试覆盖。
5. 预留已超过技术期限且费用未知：并发新请求仍不能使用该容量；Task 6 的 PostgreSQL 并发测试覆盖。

---

## 文件与接口地图

| 责任 | 文件 |
| --- | --- |
| Payer 类型、映射和授权边界 | 新增 `server/src/billing/payer.ts`、`server/src/billing/payer-store.ts`、`server/src/db/schema/billing-payers.ts`；改 `server/src/billing/routes.ts`、`server/src/billing/payments/routes.ts` |
| 订单与收款事实 | `server/src/db/schema/payment.ts`、`server/src/billing/payments/{types,store,service,maintenance}.ts`；新增支付迁移到 `server/drizzle/` |
| 订阅周期与交付 | `server/src/db/schema/billing.ts`、`server/src/billing/payments/service.ts`；新增 `server/src/billing/period-fulfillment.ts` |
| 积分账户与消费 | `server/src/billing/{capacity,credits-writer,credits,usage-outbox,usage-delivery,reconcile}.ts`、`server/src/db/schema/{credits,credit-reservations,usage-outbox}.ts`、`server/src/index.ts` |
| 账务 API 与页面 | `server/src/billing/{routes,statements,types}.ts`、`app/src/lib/billing/{payments,credits,invoices,queries}.ts`、`app/src/routes/_authed/settings/{usage,invoices}.tsx`、`app/src/components/billing/*`、`app/src/locales/{zh-CN,en}/settings.json` |
| 回归证据 | `server/tests/payment-*.test.ts`、`server/tests/billing-*.test.ts`、`app/tests/billing-*.test.tsx`；新增针对性 PostgreSQL 集成测试 |

## 任务依赖与预检

执行顺序：Task 1 → Task 2 → Task 3 → Task 4 → Task 5；Task 2 → Task 6；Task 4/5/6 → Task 7；Task 7 → Task 8 → Task 9。Task 1 的历史归属盘点和可信公司权限接口是下游入口的门槛，不以“公司设计已批准”冒充代码已交付。跨 Task 的共享类型统一以 `PayerRef`、`externalCustomerIdFor(payer)`、`BillingReadScope` 和 `PeriodKey` 为准；实现前把真实签名与数据库迁移写入 Ledger 并检查本表后再派发。Task 2/3 共改支付模块、Task 4/5 共改订阅与积分模块，必须串行集成；Task 6 的账户容量变更也在同一工作区完成。

每个 Task 先记录相关源码 HEAD 和未提交基线，执行 RED → GREEN → REFACTOR，保留同一快照的测试结果与独立 Review。只有前置 Task `verified` 且其检查点已进入当前工作区才开始下游。Review 含 Spec compliance 和 code quality；完成后对完整交付范围运行 OCR，发现有效问题按独立修复计划处理。

### Task 1: 账户归属映射与迁移边界

**Depends on:** 无。**Owner role:** `backend_implementer`。**Validator role:** `backend_validator`。**Acceptance:** Spec 的账户归属、历史隔离及 AC1/2 的基础契约。

**Files:** 创建 `server/src/billing/payer.ts`、`payer-store.ts`、`server/src/db/schema/billing-payers.ts` 和相应迁移；修改 `server/src/db/schema/billing.ts`；测试 `server/tests/billing-payer-store.integration.test.ts`。迁移脚本只处理有证据的映射，盘点报告保存至执行 Ledger。

**Interfaces:** Produces `type PayerRef = { type: "personal" | "company"; id: string }`、`type BillingReadScope = { actorId: string; payer: PayerRef; canReadCompanyFinance: boolean }`、`externalCustomerIdFor(payer: PayerRef): Promise<string>`。同一 `(type,id)` 唯一，Customer 反向唯一；返回的 Customer ID 是现有 CreditWriter/Lago 接口的适配值。公司采购/财务/发放权限由独立可信授权接口提供；不存在时公司路径拒绝。

- [ ] 写 PostgreSQL 集成测试：个人 `id=x` 与公司 `id=x` 映射到不同 Customer；并发开户只有一个有效映射；伪造 company id、非成员、权限服务失败均不能开户或读公司账务。
- [ ] 用专用 `TEST_DATABASE_URL` 运行该测试，确认新契约断言失败；环境缺失则记录缺失并停在本 Task，不能连接开发库。
- [ ] 实现 Payer 映射与授权适配；建立唯一约束及外键。先枚举旧 `billing_customers`、订单、订阅、Grant、预留与在途支付的归属证据；无法证明的记录隔离，禁止复制同一余额。
- [ ] 重跑该集成测试与 `bun run --filter server typecheck`，期望通过；检查迁移可前滚、失败可重试，旧归属不明时公司/个人消费入口拒绝。
- [ ] 保存检查点与迁移盘点摘要，请独立 reviewer 核对账户类型碰撞、权限与未知历史归属。

### Task 2: 个人与公司授权化购买

**Depends on:** Task 1。**Owner role:** `backend_implementer`。**Validator role:** `backend_validator`。**Acceptance:** Spec 验收 1、3 的购买部分。

**Files:** 修改 `server/src/db/schema/payment.ts`、`server/src/billing/payments/{types,store,service,routes}.ts`、`server/src/billing/routes.ts`、`server/src/index.ts`；新增迁移；测试 `server/tests/payment-store.integration.test.ts`、`server/tests/payment-routes.test.ts`。

**Interfaces:** Consumes `PayerRef`、`BillingReadScope` 和 `externalCustomerIdFor`。Produces `createPurchase({ payer, actorId, planCode, provider, cycle })`、按 Payer 锁定的订单价格/套餐版本/预计积分快照、`readOrder(id, scope)`、Payer 范围内唯一待支付约束。`createdBy` 只记录发起人。

- [ ] 写失败测试：个人与公司同时购买互不阻塞；同一 Payer 并发只创建一个待支付订单；换团队不改公司 Payer；非授权者创建、取消、读取及获取 QR 均拒绝且不泄露订单存在。
- [ ] 运行目标测试确认失败；写迁移把部署级 pending 唯一约束改为 `(payer_type,payer_id)`，保留历史订单但未证实归属的订单禁止自动认领。
- [ ] 调整路由与服务签名，购买权限分别检查个人身份和公司采购权；目录和订阅 guard 按 Payer 查未缓存事实，价格与积分快照落单后不重算。
- [ ] 运行 `bun test server/tests/payment-store.integration.test.ts server/tests/payment-routes.test.ts` 与 server typecheck；核查两个 Payer 的相同字符串 ID、不存在 Tenant 和权限服务失败用例。
- [ ] 保存检查点，独立 Review 后再允许 Task 3 改支付事务。

### Task 3: 收款事实、迟到款与交付状态

**Depends on:** Task 2。**Owner role:** `backend_implementer`。**Validator role:** `backend_validator`。**Acceptance:** Spec 验收 4、5 的资金事实和可恢复状态。

**Files:** 修改 `server/src/db/schema/payment.ts`、`server/src/billing/payments/{types,store,service,maintenance,routes}.ts`；新增迁移；测试 `server/tests/payment-service.test.ts`、`server/tests/payment-store.integration.test.ts`、`server/tests/payment-routes.test.ts`。

**Interfaces:** Produces `CollectionFact`，唯一键 `(provider,channelTransactionId)`，含实际金额/币种/订单及确认依据；`FulfillmentState = "pending" | "processing" | "delivered" | "needs_resolution"` 与失败原因、重试时间。收款确认事务同时写事实和订单状态；重复/迟到独立事实进入异常，绝不复用旧事实 ID。

- [ ] 写失败测试：验签后数据库写失败给渠道可重试响应；同一交易重放只有一条事实；不同交易落同一订单均保留资金事实但只允许一个权益交付候选；金额/币种/订单不符阻断交付。
- [ ] 运行目标测试确认失败；补迁移、CAS 与唯一约束。回调按渠道权威查单后比对快照，非确认态不产生已收款事实；存储错误不能回答成功。
- [ ] 实现交付状态和有界重试调度；当多次确定性失败时进入 `needs_resolution` 并告警，暂时性失败按退避时间继续尝试。渠道查询不可达时保留待核状态，不把待支付直接过期成“无款”。
- [ ] 运行目标测试、server typecheck；Review 资金事实的不可变性及回调响应语义，保存检查点。

### Task 4: 首期订阅与积分完整交付

**Depends on:** Task 3。**Owner role:** `backend_implementer`。**Validator role:** `backend_validator`。**Acceptance:** Spec 验收 1、5 的订阅与 Grant 同时到位。

**Files:** 修改 `server/src/db/schema/billing.ts`、`server/src/billing/payments/service.ts`、`server/src/billing/payments/maintenance.ts`、`server/src/billing/credits-writer.ts`、`server/src/index.ts`；新增 `server/src/billing/period-fulfillment.ts` 及迁移；测试 `server/tests/billing-period-fulfillment.integration.test.ts`、`server/tests/payment-service.test.ts`。

**Interfaces:** Consumes `CollectionFact`、`PayerRef`、`FulfillmentState`。Produces `type PeriodKey = { subscriptionId: string; providerPeriodId: string }` 和 `fulfillPaidPeriod({ payer, orderId, collectionFactId, periodKey }): Promise<...>`；订阅和 Grant 各有独立幂等记录，交付 `delivered` 需要二者证据俱在。

- [ ] 写失败测试：Lago 已创建订阅而 Grant 失败后重试只补 Grant；Grant 已存在的回调重放不再加积分；付款账户从订单继承且回调不能改；周期结束时间缺失时不发无限期 Grant。
- [ ] 运行目标测试确认失败；周期表保存外部稳定周期标识、Payer、起止、套餐快照、收款依据、Grant ID 和两个交付子状态。
- [ ] 将现有激活流程改为分步幂等交付；Grant 使用周期身份键和 `externalCustomerIdFor(payer)`，成功后核对订阅与 Grant 才写 `delivered`；失败保留处理中和可恢复证据。
- [ ] 运行目标测试、server typecheck；Review 外部成功/本地失败的恢复次序和余额归属，保存检查点。

### Task 5: 续期、公司管理员发放与周期纠错

**Depends on:** Task 4。**Owner role:** `backend_implementer`。**Validator role:** `backend_validator`。**Acceptance:** Spec 验收 3、6。

**Files:** 修改 `server/src/billing/{routes,service,types}.ts`、`server/src/billing/payments/service.ts`、`server/src/billing/period-fulfillment.ts`、`server/src/billing/webhook-signature.ts`、`server/src/index.ts`；测试 `server/tests/billing-webhook.test.ts`、`server/tests/billing-period-fulfillment.integration.test.ts`、`server/tests/billing-routes.test.ts`。

**Interfaces:** Consumes `PeriodKey` 与 `PayerRef`。Produces `recordRenewalPeriod({ subscriptionId, providerPeriodId, collectionFactId, periodStart, periodEnd })`，同周期幂等、跨周期独立；`grantCompanyCredits({ payer, actorId, amount, expiry, reason, idempotencyKey })` 只接受 company Payer，来源 `admin_company`，无虚构订单或收款。

- [ ] 写失败测试：同周期重复/乱序通知只发一次；下一周期另发；未证实续期收款不发；补缴和周期修正要查询权威事实，不从通知到达日推算；公司管理员发放与在线购买并发合并到账。
- [ ] 运行目标测试确认失败；把订阅 Payer 固定于首次订单，公司发放单独授权并审计发放人、原因、额度、有效期和账户。
- [ ] 接入续期收款证据和周期交付，处理取消后未来周期拒绝、已付款当前周期保持；周期事实冲突进入 `needs_resolution`。
- [ ] 运行目标测试、server typecheck；Review 来源枚举迁移、续期周期身份和公司发放越权，保存检查点。

### Task 6: 严格容量与用量账户贯通

**Depends on:** Task 2；与 Task 3–5 串行集成。**Owner role:** `backend_implementer`。**Validator role:** `backend_validator`。**Acceptance:** Spec 验收 2、7。

**Files:** 修改 `server/src/billing/{capacity,credits-writer,credits,usage-outbox,usage-delivery,reconcile}.ts`、`server/src/db/schema/{credits,credit-reservations,usage-outbox}.ts`、`server/src/index.ts`；必要迁移；测试 `server/tests/billing-credits-writer.integration.test.ts`、`server/tests/billing-usage-outbox.integration.test.ts`、`server/tests/billing-capacity.test.ts`。

**Interfaces:** Consumes `PayerRef` 与 `externalCustomerIdFor`。Produces严格账户容量读写：所有 `status=reserved` 且未证实释放/结算的 hold 都扣减容量，`expiresAt` 只用于恢复告警；usage、reservation、remainder 的账户标识与事件幂等身份均包含 Payer 类型。

- [ ] 写失败测试：跨技术过期的未知 hold 仍阻止并发新请求；个人与公司同字符串 ID 不串账；Grant 在调用中到期仍按原分配结算，释放的过期部分不可用；余额不足绝不切换 Payer。
- [ ] 运行目标 PostgreSQL 测试确认失败；修改唯一容量算法与读侧摘要，移除严格路径的 expired-hold lazy reclaim；部署级调用装配改从可信业务范围/个人授权传入 Payer。
- [ ] 用同一 Payer 贯通 usage outbox、结算、尾差和对账；不完整价格、usage 或强制上限保持 fail closed，超界保留事实并冻结受影响能力。
- [ ] 运行目标集成测试、server typecheck；Review 行锁、旧持有记录迁移与无双重容量算法，保存检查点。

### Task 7: 异常处置、逐账户对账与历史迁移核验

**Depends on:** Task 4、5、6。**Owner role:** `backend_implementer`。**Validator role:** `backend_validator`。**Acceptance:** Spec 验收 8 及历史账务保留。

**Files:** 新增 `server/src/billing/resolutions.ts`、`server/src/db/schema/billing-anomalies.ts` 及迁移；修改 `server/src/billing/{reconcile,routes,types}.ts`、`server/src/billing/payments/store.ts`；测试 `server/tests/billing-reconcile.integration.test.ts`、`server/tests/billing-resolution.integration.test.ts`。

**Interfaces:** Produces按 Payer 的只读 `ReconcileReport`，保留各交易 ID 与差异；`resolveBillingAnomaly({ anomalyId, action, evidence, actorId, idempotencyKey })` 是授权写操作。自动退款不启用；人工渠道退款结果需有渠道回执并登记，不能删除原始 Grant/Ledger。

- [ ] 写失败测试：两边金额汇总相等但个体交易错配仍报异常；跨账户 Grant 错配可识别；相同处置键只生效一次；未授权操作、无证据释放、退款金额超过可退额均拒绝。
- [ ] 运行目标测试确认失败；持久化异常关联、状态与不可变处置审计，逐账户对账只读，不在 reconcile 中自动修复。
- [ ] 实现有证据的补发、确认无费用释放、实际费用结算、平台承担损失和人工退款结果登记；对真实渠道退款执行只记录已核实回执，未具备渠道契约时公司及个人界面不提供自动退款按钮。
- [ ] 核对 Task 1 历史盘点与迁移清单：未知归属隔离，无余额复制、无待处理支付遗漏；运行集成测试、server typecheck，Review 处置权限和原始事实保留。

### Task 8: 账务读接口与能力说明

**Depends on:** Task 7。**Owner role:** `backend_implementer`。**Validator role:** `backend_validator`。**Acceptance:** Spec 验收 1–9 所需的授权账务读事实。

**Files:** 修改 `server/src/billing/{routes,statements,types}.ts`；测试 `server/tests/billing-routes.test.ts`、`server/tests/billing-statements.test.ts`。

**Interfaces:** Produces `BillingAccountView`、`PaymentRecordView`、`CreditCapacityView`，都携 `payerType/payerId` 与明确货币/积分单位、收款和交付状态。Task 9 消费这些已审查的响应。

- [ ] 写失败测试：普通成员看不到公司财务记录、创建人/财务权限范围正确；支付记录与正式发票术语区分；可用/预留/待结算/已消费与同一容量规则一致；购买目录显示能力不可用原因。
- [ ] 运行目标测试确认失败；实现三个响应类型及查询接口，所有读取用可信 Payer 范围，返回账户与金额单位，不混入另一个账户。
- [ ] 运行 `bun test server/tests/billing-routes.test.ts server/tests/billing-statements.test.ts` 与 server typecheck；独立 Review 后固定响应契约，保存检查点。

### Task 9: 账务页面与完整验收

**Depends on:** Task 8。**Owner role:** `frontend_implementer`。**Validator role:** `frontend_validator`。**Acceptance:** Spec 验收 1–9 的用户可见结果。

**Files:** 修改 `app/src/lib/billing/{payments,credits,invoices,queries}.ts`、`app/src/routes/_authed/settings/{usage,invoices}.tsx`、`app/src/components/billing/{upgrade-dialog,invoice-status,credit-bar,credit-grant-list}.tsx`、`app/src/locales/{zh-CN,en}/settings.json`；测试 `app/tests/billing-credits-ui.test.tsx`、`app/tests/billing-payments.test.ts`、`tests/e2e/billing.e2e.ts`。

**Interfaces:** Consumes Task 8 的 `BillingAccountView`、`PaymentRecordView`、`CreditCapacityView`。Query key 包含 Payer，切换公司/个人时丢弃旧账户在途结果。

- [ ] 写失败测试：已收款未交付显示“已付款，权益处理中”；个人/公司账户切换不显示旧响应；Lago 估算或美元成本不标成人民币实付；异常进度与不可用能力明确展示。
- [ ] 运行目标测试确认失败；实现支付记录、订阅周期、积分与用量展示，更新中英文文案。
- [ ] 运行 `bun test app/tests/billing-credits-ui.test.tsx app/tests/billing-payments.test.ts`、`bun run --filter app typecheck` 和相关 lint；通过独立 Review，保存检查点。
- [ ] 在专用隔离环境运行支付创建→回调→订阅/Grant→消费→对账 E2E；支付渠道与 Lago 外部凭据不可用时保留对应未验证状态，不把 fake 测试当作外部供应商证据。
- [ ] 完整差异 Review 与 OCR：覆盖原始 BASE 到 HEAD 及全部未提交交付文件；逐项修复有效 critical/high/medium，复核范围、迁移与九条验收证据后保存最终 Ledger。

## 实施前共享接口预检

| 共享点 | 提供任务 | 使用任务 | 放行条件 |
| --- | --- | --- | --- |
| `PayerRef`、Customer 映射、公司权限 | 1 | 2–8 | 类型、数据库唯一性、可信授权接口已集成；缺失时公司入口拒绝 |
| Payer 范围订单与价格快照 | 2 | 3–5、7–8 | 原子待支付约束及跨账户测试通过 |
| 收款事实与交付状态 | 3 | 4–5、7–8 | 收款事务和渠道重放 Review 通过 |
| `PeriodKey` 与首期交付 | 4 | 5、7–8 | Lago/Grant 局部失败恢复证据通过 |
| 严格容量算法 | 6 | 7–8 | PostgreSQL 并发、过期未知 hold 验证通过 |

Task Brief 只引用已核实的当前签名、对应 Spec 章节、上表前置检查点、文件所有权和报告路径。若跨任务类型不同步，先更新本计划和 Ledger，再派发下游；不在实现者提示词里自行改接口。未覆盖的外部退款时限/税务决定和真实供应商能力证据保持明确未启用状态，不将其记为验收通过。
