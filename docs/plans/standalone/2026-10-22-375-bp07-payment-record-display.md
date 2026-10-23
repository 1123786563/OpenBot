# BP07（#375）个人与公司支付记录、积分和能力状态展示 — 实施方案

状态：执行中（bp1 worktree，未提交交付）。Run 证据：`.archive/runs/2026-10-22-375-bp07/`。

## 需求与事实源

- Issue #375（BP07）：按授权账户展示支付记录、收款/交付进度、周期、Grant、可用/预留/待结算/消费及能力不可用原因；切换账户不串数据。
- Spec：`docs/specs/2026-10-15-billing-payment-account-and-fulfillment-design.md`（已批准）§页面与账务语义、§订单收款与交付、§异常处置与对账。
- 前置交付（本 worktree 未提交基线）：BP01–BP06（#369–#374）的订单/PayerRef/收款事实/交付恢复/续期/处置注册表；#116 公司财务授权与账簿（companyBooks）；#140 scoped billing 三面（orders/usage/invoices 逐 scope 读取）。
- 原则：**消费既有只读面，不另建账务**。本票零新表、零新金额口径；全部改动是既有订单/事件/账户行的只读投影与展示。

## 范围裁定（依仓库当前代码）

1. **收款/交付进度（AC1）**：订单行已持有 `activationState`/`activationFailureReason`/`activationNextRetryAt`（BP03），购买面 `PaymentOrderView.fulfillmentState` 已存在；缺口在**账单读（statements/BillingInvoice）不携带交付进度与异常事件**。方案：把同一三值规则提炼为 `fulfillmentStateOfOrder` 共享函数，`BillingInvoice` 增补 `fulfillment`（state/reason/nextRetryAt，未收款为 null）、`payerKind`（个人/公司清晰标识）、`anomalies`（payment_events kind='anomaly' 的只读投影，新 store 读 `listAnomalyEvents(orderIds)`）。支付记录对 paid+processing 显示「已付款，权益处理中」，`needs_resolution` 与异常事件显示处置进度。
2. **公司支付记录（AC2）**：`companyBooks`（财务授权判定门后）增补 `payments` —— 以公司 PayerRef `{kind:"company", id:tenantId}` 复用 `listOrdersInWindow` 的 owner scope 读公司订单（与个人读同一投影形状）；账务读取仍在判定门后，拒绝路径零账务读取。普通成员/其他公司的拒绝语义由既有 `COMPANY_FINANCE_REQUIRED` 哨兵承担（测试钉死）。个人面不显示公司消费：个人 scope 的 kind 不匹配公司订单（测试钉死）。
3. **币种与术语（AC3）**：订单金额只以订单快照币种渲染（`money(amountCents, currency)`，DB CHECK 全为 CNY）；Lago 估算/美元成本不进入支付记录金额位（`plan-usage` 的 provider 币种金额不被任何页面标作实付——测试钉死 money() 按币种渲染）。文案层面「本地订单视图不称正式发票」：以「支付记录」为统一用语并加断言（无「发票」字样）。切换账户丢弃旧响应：所有新读骑 #140 的 scope 前缀（books 单查询整体切换；个人面沿用 scoped 查询）。
4. **能力状态（What-to-build）**：账户级能力状态 = `billing_credit_accounts.status/quarantine_reason`（隔离即能力不可用 + 原因）。个人 `PersonalCreditBalance` 增 `account{status,quarantineReason}`（既有行只读）；公司 books 的 `account` 增 `quarantineReason`。模型/规格级可用性属 Bifrost 线自己的面（#338 discovery/selection），不在本票重复。

## 改动面

### Server（读侧，零写入路径）

- `payments/types.ts`：`fulfillmentStateOfOrder()` 共享规则；`PaymentOrderEventRecord`；`PaymentStore.listAnomalyEvents(orderIds)`。
- `payments/store.ts`：`listAnomalyEvents`（SELECT，kind='anomaly'，order_id IN，createdAt 升序）。
- `payments/service.ts`：`toView` 改用共享规则（行为不变）。
- `billing/types.ts`：`BillingInvoice` + `fulfillment/payerKind/anomalies`；`BillingPaymentAnomaly`。
- `statements.ts`：deps 增可选 `events`；页读一次批量取异常；`invoiceOf` 投影交付进度与 payerKind。
- `company-finance-visibility.ts`：`CompanyBooks` + `payments`、`account.quarantineReason`；deps 增可选 `orders`/`events`；判定门后按公司 PayerRef 读最近 20 笔。
- `enterprise/tenancy/company-admin-routes.ts` + `index.ts`：装配注入 payments store（两处 companyBooks 装配）。
- `credits.ts`：`personalBalance` 增 `account`（billing_credit_accounts 按 externalCustomerId 只读一行；无行=未隔离=active）。

### App

- `lib/billing/invoices.ts`、`lib/billing/payments.ts`（`PurchaseOrderView.fulfillmentState` 对齐 wire）、`lib/billing/credits.ts`（`account` 字段）。
- `components/billing/orders-view.tsx`：OrderRow 增交付进度（已付款，权益处理中 / 已交付 / 待人工处置+异常行）；异常事件行（译文，closed 词表）。
- `components/billing/personal-balance-card.tsx`：账户状态位（正常 / 能力不可用：原因）。
- `lib/enterprise/tenant/company-admin.ts` + `routes/_authed/tenant/admin/billing.tsx`：公司支付记录表 + 账户状态原因。
- locales：`settings.json`（zh/en）与 `company-admin.json`（zh/en）新键；支付记录用语统一。

### 测试（先红后绿）

- `server/tests/billing-statements.test.ts`：fulfillment 三态投影、anomalies 附着、payerKind、公司订单不进个人 scope、detail 同型。
- `server/tests/billing-routes.test.ts`（票面指定）：invoices 路由携带交付进度与异常；购买面 fulfillmentState 透传（billing-payments 侧 app 断言）。
- `server/tests/billing-payment-events.integration.test.ts`（新，PG bp1 库）：`listAnomalyEvents` 真库读 + 公司 PayerRef scope 订单隔离。
- `app/tests/personal-orders-ui.test.tsx`：已付款未交付渲染「已付款，权益处理中」；needs_resolution+异常进度；币种按订单快照渲染；文案无「发票」。
- `app/tests/billing-payments.test.ts`（票面指定）：wire 类型携带 fulfillmentState。
- `app/tests/billing-credits-ui.test.tsx`（票面指定）：账户状态/隔离原因渲染；能力不可用原因。
- `app/tests/multitenancy/web-billing.test.tsx`：books.payments 渲染、切换丢弃旧支付记录、无授权仍单一拒绝。
- 新文件按 ADR 0008 走 e2e 收集；Bun 耦合才 e2e-add-driven 登记 + coverage audit。

## 验证

`TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5566/bp1`（容器 orca-w3-bf-pg 内新建库，先跑迁移）；
`bun test`（票面三件套 + statements/orders/credits/web-billing + 新集成测试）；`bun run --filter server typecheck`；app typecheck；`node scripts/e2e-coverage-audit.mjs`。

## 明确不做

自动退款入口、正式税务发票、Lago 估算入实付金额位、新账表/新金额口径、模型级价格可用性面（Bifrost 线）、`.archive/` 与 `server/src/mastra/**` 改动、提交/推送。
