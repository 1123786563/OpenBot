# 套餐 / 积分 / 账单模块系统性梳理

> 范围：`server/src/billing/`、`server/src/billing/payments/`、`server/src/db/schema/{billing,credits,payment}.ts`、装配点 `server/src/index.ts`、`server/src/app.ts`、`server/src/config.ts`，以及迁移 `0071_billing_idempotency.sql`、`0073_credit_ledger_idempotency.sql`。
> 结论全部基于实际代码，引用处均给出文件与行为。

---

## 一、现状说明

### 1.1 模块职责边界

```
server/src/billing/
├── types.ts              领域词汇表：4 个哨兵错误码、Receipt/Store/Service 接口（provider 中立 seam）
├── service.ts            Lago 订阅同步、webhook 编排、entitlements、usage 计量上报、reconcile 委托
├── store.ts              投影表读写：billing_customers / billing_subscriptions / webhook inbox
├── lago.ts               Lago HTTP 客户端（唯一一个说 Lago 方言的文件）
├── entitlement.ts        entitlements 的 per-customer TTL 缓存（10min 答案 / 1min 失败，fail-closed）
├── webhook-signature.ts  Lago webhook JWT/HMAC 验签
├── outbound.ts           SSRF 防护：协议白名单 + 私网/保留段/元数据地址拒绝 + DNS 解析复查
├── raw-body.ts           webhook 原始体一次性有上限读取
├── credits.ts            积分读侧（summary / grants / consumption，只读）
├── credits-writer.ts     积分写侧（grantCredits / consumeCredits，唯一写 used 与 ledger 的地方）
├── statements.ts         套餐用量（plan-usage）+ 账单读（invoices，订单即账单）
├── reconcile.ts          只读对账：支付三方一致 + 积分恒等式
├── routes.ts             HTTP：webhook、user（entitlements/statements/credits）、admin（sync/grant/reconcile）
└── payments/             支付子域
    ├── types.ts          订单五态、激活三态、PaymentStore/Provider seam
    ├── service.ts        购买编排、回调分诊 settlePaidFact、激活 activateOrder、两个 sweeper
    ├── store.ts          payment_orders / payment_events 的唯一写入者（CAS + 事实表）
    ├── provider.ts       渠道中立五方法 seam
    ├── alipay.ts / wechat.ts   渠道适配器（RSA2 / AES-256-GCM）
    ├── channel-http.ts   共享 HTTP 纪律（redirect:error、超时、注入式 fetch）
    ├── crypto.ts         签名/验签/解密/金额字符串精确转分/短单号
    ├── routes.ts         匿名回调 + 用户/管理员购买路由
    └── maintenance.ts    sweepExpired + sweepActivations 定时器（60s）
```

**关键设计决定（代码中反复声明）**：
- **双系统分工**：Lago 拥有订阅与计量原始事件；积分台账与支付订单完全本地（`credits.ts` 头注）。
- **单部署单客户**：`externalCustomerKey = openbot-deployment-<tenantId>`（`service.ts` `deploymentExternalCustomerId`），`payment_orders` 不带客户列——v1 的订单"就是"这个部署的（`reconcile.ts` 注释）。
- **POST-PAID 积分**：调用先放行、结束后按实际 token 数扣；预扣门（gate）只是可见性，精度靠 consume（`credits-writer.ts` `consumeCredits` 注释）。
- **金额纪律**：全链路整数分；积分按 `CREDIT_SCALE=100` 整数缩放存储，杜绝浮点（`schema/credits.ts`、`crypto.ts` `amountStringToCents` 手工位解析）。

### 1.2 核心数据实体与关系

```
billing_customers (externalId PK)
 ├─< billing_subscriptions (externalSubscriptionId PK, FK customer, status∈{active,incomplete,canceled,terminated})
 └─< credit_grants  (id "cg-" PK, FK customer, source∈{plan,promo,signin},
 │                    total/used 缩放整数, CHECK used<=total, idempotencyKey 唯一)
 │      └─< credit_ledger (id PK, FK customer, grantId FK→grants 可空,
 │                          credits=全额成本, applied=实际吸收, CHECK applied<=credits,
 │                          idempotencyKey 唯一)
 └─< payment_orders (id "po-" PK, plan/provider/amountCents 快照, status 五态,
      │               activationState 三态, version CAS, terminalAt, periodStart/End,
      │               partial unique (plan,provider) WHERE status='pending')
      └─< payment_events (fact: partial unique channelTransactionId WHERE kind=fact AND state='paid';
                          anomaly: unique (orderId,code) WHERE kind=anomaly AND code<>'amount_unreadable')
```

- `credit_grants.status` 只是"出生证明"，活跃/耗尽/过期由读取侧按时钟+余额派生（`deriveGrantStatus`）。
- `payment_events` 的 paid fact 是**跨订单幂等键**：同一渠道交易号只能被一笔订单认领一次。
- webhook inbox（`billing_webhook_events`）行**后写**——行存在即代表投影已刷新完成（`service.ts` `handleWebhook` 注释，与被继承的 Go 实现的分歧记录在案）。

### 1.3 状态机

**订单（payment_orders.status）——前向单行道，paid/blocked 吸收：**

```
pending ──confirm(CAS)──▶ paid ──▶ (吸收一切后续事实)
   │ ├─金额不符──▶ blocked(终态)
   │ ├─TTL 到期(先 query 渠道)──▶ expired ──迟付窗口内(terminalAt+Nh)──▶ paid
   │ └─管理员取消──▶ canceled ──迟付窗口内──▶ paid
```

**激活（activation_state，与钱态正交）：** `pending → applied | failed`；`failed` 会被 sweeper 无限重试（P1-4 决定），连续 3 次 failed 写 `activation_retry_exhausted` 告警。

**订阅（来自 Lago）：** `active / incomplete / canceled / terminated`。

**积分 grant：** 读取派生 `active → exhausted(余额0) / expired(时钟过)`，写侧从不翻转。

### 1.4 关键业务流程

**购买（三源收敛）**：`createPurchase`（单订阅 guard → pending-pair 幂等索引 → 先建订单后开渠道会话）→ QR → 三个入口（匿名回调 `handleCallback`、页面轮询 `readOrder`、60s sweeper `sweepExpired`）全部收敛到 `settlePaidFact`：金额门（无金额→挂起记 strike；金额不符→block；paid 幂等静默；over/paid_after_blocked/late_payment 记 anomaly）→ `confirmPaid` 单事务（CAS + fact 插入， TransactionAlreadyKnown 信号回滚）→ 跨订单 duplicate_paid 检查 → `activateOrder`（Lago 计划校验 → ensureSubscription → grantPlanCredits → 失效缓存 → applied）。

**计量与扣积分**（`index.ts` 装配）：模型流 finish → `recordUsage`（Lago，fire-and-forget）+ `consumeCredits`（本地，`tokens × 100`）同键幂等；代码运行 → `consumeCredits("code-run:<runId>")` 无预扣门（沙箱预算自治）。

**预扣门**：`setModelUsageGate` → `readBalance` 10s TTL 缓存，fail-closed（读失败即拒，`copilot.ts` `CreditGateError` → 402 语义）。

**消耗事务**：ledger 行先插（占幂等键）→ 按 `expiresAt, grantedAt` 升序 `SELECT ... FOR UPDATE LIMIT 1` 逐 grant 吸收 → 回写 grantId/applied → 事务内读剩余。

---

## 二、设计缺陷清单

### P0 — 高危（资金/数据一致性直接受损）

#### P0-1 LLM 计量幂等键是进程内自增序号，重启/多副本即碰撞

- **位置**：`server/src/index.ts`（`setModelUsageMeter` 块）：`meterSequence` 为模块级 `let`，`transactionId = llm:${externalCustomerKey}:${meterSequence}`；该 id 同时作为 Lago `recordUsage` 的 transactionId 与 `consumeCredits` 的 `idempotencyKey`。
- **问题**：进程重启后序号归零。重启前已写入的 `llm:key:1..N` 与重启后新调用生成的同前缀同序号键在两个系统上分别撞车：
  - 本地 `credit_ledger.idempotency_key` 唯一索引命中 → `consumeCredits` 走幂等分支 `inserted:false`，**该次调用不扣积分**；
  - Lago 按 transactionId 去重 → **计量事件被合并/丢弃，收入侧漏计**。
  - 多副本部署下两个进程序号相互重叠，碰撞常态化。
- **业务后果**：每次发版重启后，前 N 次模型调用（N = 重启前累计调用数，随运行时长增长）全部免单；Lago 账面与本地台账同时漏记，且**对账发现不了**（见 P1-3）。这是幂等键设计错误：幂等键必须派生自业务事实（runId/messageId），而不是进程生命周期。
- **修复方向**：为每个 finish 生成一次性 UUID（`llm:${crypto.randomUUID()}`）或复用请求级稳定 id；`code-run:<runId>` 的做法（业务 id）就是对的那一半。

#### P0-2 月度订阅无续订发放路径：第二个月起积分清零、调用被 gate 全锁

- **位置**：`payments/service.ts` `grantPlanCreditsFor`（唯一调用点，idempotencyKey=`plan:<orderId>`）；`index.ts` grantor 装配；全库无任何按周期发放的 sweeper。
- **问题**：计划积分只在**订单激活时发一次**，`expiresAt` 对齐当前周期末。Lago 订阅是 monthly recurring，但收款走的是本地一次性扫码订单，且 `createPurchase` 的单订阅 guard（`activePlanCodeUncached`，`active|incomplete` 即拒）在旧订阅仍活跃期间**拒绝复购**。用户只能在旧订阅过期后重新购买。
- **业务后果**：到期时刻起旧 grant 全部过期 → `readBalance=0` → `CreditGateError`，**付费订阅用户在"旧订阅过期→新订单支付→激活"整个空窗期内完全不可用**；若用户不理解需要重新购买（界面上是"已订阅"心智），则持续不可用。数据不丢，但付费连续性断裂，属于业务正确性缺陷而非运维问题。
- **修复方向**：二选一——(a) 增加周期 sweeper：检测活跃订阅进入新周期时按 `plan:<subscriptionId>:<periodStart>` 幂等发放；(b) 到期前允许"续费单"（guard 放行同计划续购，activation 端把订阅期顺延）。

### P1 — 中高（一致性窗口 / 对账盲区 / 越权面）

#### P1-1 webhook 处理中的非 BillingError 一律答 400，渠道不再重试，投影丢事件

- **位置**：`billing/service.ts` `handleWebhook`：
  ```ts
  catch (error) {
    if (error instanceof BillingError && error.retryable) return 503;
    return 400;            // ← DB 连接错误、PgError、任何意外 throw 都落到这里
  }
  ```
  `refreshFor` 内的 `store.upsertCustomer/upsertSubscription` 抛出的数据库故障不是 `BillingError`。
- **业务后果**：Lago 对 4xx 不重试。DB 抖动窗口内的 `customer.*`/`subscription.*` 事件永久丢失，本地投影停在旧状态（entitlements 走 10 分钟 TTL 缓存 + 本地投影，不会自愈），直到有人手动 sync 或下一个同对象 webhook 到达。付费用户可能被持续显示为免费版/付费版错误状态。
- **修复方向**：区分「渠道可重试的已验签投递」（意外错误一律 5xx，inbox 未写，Lago 会重投）与「负载本身不可理解」（400）。语义上：验签通过后的任何处理失败都应 5xx。

#### P1-2 "live 订阅"的定义在三处不一致：entitlement 只认 active，guard/reconcile 认 active+incomplete

- **位置**：
  - `billing/service.ts` entitlement 读函数：`rows.find(row => row.status === "active")` —— 只有 active；
  - `index.ts` `activePlanCodeUncached`：`active || incomplete`；
  - `reconcile.ts` live 订阅查询：`IN ('active','incomplete')`（注释声称"与 guard 一致"，确实一致，但与 entitlement 不一致）。
- **业务后果**：一笔 `incomplete`（已建未生效）订阅下，guard 拒绝复购（"已有活跃订阅"），entitlement 却回答 `active:false`——用户看到免费版、也无法购买、也无法使用计划积分（plan grant 只在 activation 发，activation 建出的订阅若为 incomplete 则页面永远显示未订阅）。用户陷入"不能买、也没有"的死角，只能靠 Lago 侧状态推进或人工介入。
- **修复方向**：把 live 的定义收敛到一个常量谓词（一个导出函数 `isLiveSubscription(row)`），三处共用；entitlement 读对 incomplete 给出可区分的答案（如 `active:false, subscription:{status:'incomplete'}` 已支持，但页面文案需配合）。

#### P1-3 对账缺第三恒等式：本地 credit_ledger ↔ Lago 计量事件无交叉核对

- **位置**：`billing/reconcile.ts` 只审计两个不变量（支付三方一致、Σgrants.used == Σledger.applied）。`index.ts` 明确写了"1 token = 1 scaled unit 是为了两本书 COULD reconcile"，但 reconcile 不做。
- **业务后果**：`recordUsage` 是 fire-and-forget（404/422 只 warn），Lago 侧漏计（metric 未注册、订阅 id 漂移、P0-1 的幂等键碰撞）时**没有任何机制能发现**。收入侧（Lago 计费）与成本侧（本地积分）各自正确、互相沉默漂移，等财务对不上时已无据可查。
- **修复方向**：reconcile 增加按窗口的粗粒度核对：Lago `listEvents`（transactionId 可分页拉取）与 `credit_ledger` 的 id 集合差分，报告 `local_without_lago` / `lago_without_local` 两类 finding。不用逐条金额，id 差分即够用。

#### P1-4 资源级权限缺失：任意登录用户可读任意订单（含付款 QR）、账单、积分明细

- **位置**：`billing/payments/routes.ts`：`GET /purchases/:id`、`GET /purchases/current` 仅 `requireUser`；`toView` 对 pending 订单返回 `checkoutPayload`（QR 码）。`billing/routes.ts`：`GET /invoices/:id`、`/credits/*` 同样仅 `requireUser`。创建/取消购买需要 admin，但**读不需要**。
- **业务后果**：单部署多用户（OpenBot 有完整用户体系，非 admin 用户存在）时，任何登录用户可枚举 `po-` 单号读取他人订单金额、渠道交易号、付款 QR；账单与积分明细全站共享可见。信息泄露面（金额、购买行为、消费记录）成立；QR 本身是收款码，泄露风险有限但属越权读取。
- **修复方向**：v1 若定位"部署级账务仅管理员可见"，把读路由加 `requireAdmin`；若定位"团队共享池"，至少把 `checkoutPayload` 的返回收敛到 `createdBy === actor.id`。

### P2 — 中（运营/语义/健壮性缺口）

#### P2-1 金额门要求精确相等，无差额处理与退款通路

- **位置**：`payments/service.ts` `settlePaidFact`：`fact.amountCents !== order.amountCents` → pending 单直接 `blockOrder`。全库无退款 API/流程。
- **业务后果**：渠道侧金额与快照差 1 分（部分退款后再通知、渠道手续费语义变化、攻击构造）即订单终态 blocked，用户资金已扣但无任何自动化出路，只能靠 anomaly 行人工对账退款。blocked 资金滞留无 SLA。
- **修复方向**：差额在容差内（如 ±0.01）走人工审核态而非终态；补一条退款工单流程（哪怕 v1 只是导出 blocked 清单）。

#### P2-2 blockOrder 写入的 anomaly code 恒为 `amount_mismatch`，语义失真

- **位置**：`payments/store.ts` `blockOrder`：事件 `code` 硬编码 `"amount_mismatch"`；而 `amount_unreadable` 达 3 次的 endgame 也调 `blockOrder`，detail 才是真实原因。
- **业务后果**：按 code 检索/分组的运维面板把"渠道无法读出金额"误报为"金额不符"，处理路径完全不同的两类故障混为一谈。
- **修复方向**：`blockOrder` 增加 `code` 入参；endgame 传 `amount_unreadable`。

#### P2-3 `usage()` 设计为永不缓存，套餐用量页每次刷新直打 Lago

- **位置**：`billing/service.ts` `usage()`（注释 "Uncached on purpose"）；`statements.ts` `planUsage` 每次调用它；`plan-usage` 路由无节流。
- **业务后果**：页面高频刷新或多用户同时看用量时，对 Lago 的 QPS 随之放大；Lago 限流（429 → `unreachable`）会让整页 503。usageDaily 已有 60s 缓存可参照。
- **修复方向**：加短 TTL（30–60s）或 stale-while-revalidate，与 daily 一致。

#### P2-4 sweeper 与 activationStrikes 的单进程假设

- **位置**：`payments/maintenance.ts`（60s 定时器，无分布式锁）；`service.ts` `activationStrikes`（进程内存，重启清零）。
- **业务后果**：多副本部署下重复扫单（CAS 保证正确性，仅浪费渠道查询配额）；告警计数重启后从零攒，`activation_retry_exhausted` 延迟最多一个进程生命周期。
- **修复方向**：扫单加 `SELECT ... FOR UPDATE SKIP LOCKED` 或 Redis 锁（workshop 模块已有 `createRedisTurnLock` 先例）；strikes 落库或接受现状（anomaly 幂等键已保证不重复）。

#### P2-5 `addMonths` 月末溢出：1月31日 +1 月 = 3月2/3日

- **位置**：`payments/service.ts` `addMonths`（`setUTCMonth` 直加）。
- **业务后果**：`periodEnd`（进而 grant 兜底 expiry 与账单展示）在月末购买时偏移 1–3 天；对迟付窗口无影响（锚 terminalAt），仅展示/兜底语义不精确。
- **修复方向**：钳制到目标月最后一天。

#### P2-6 管理员手动发放积分无额度护栏

- **位置**：`billing/routes.ts` `grantInput`：`totalCents ≤ 1_000_000_000`（一千万积分），无单次/每日业务限额；`idempotencyKey: null`（两次点击=两次发放，注释声明为决策）。
- **业务后果**：运营手滑多打一个零即凭空发放百万积分；无回收 API（grant 无撤销/调整路径），只能进数据库手工修。
- **修复方向**：单次上限收敛到业务合理值 + 增加撤销（负 grant 或 status 翻转需设计，建议只读余额再加一张 adjustment 表）。

### P3 — 低（演进债/边角）

| # | 位置 | 问题 | 后果 |
|---|------|------|------|
| P3-1 | `db/schema/payment.ts`、全 billing 表 | 无 tenant/user 列、无 RLS（enterprise RLS 迁移 0056–0067 未覆盖 billing/credits/payment 三组表） | 多租户演进需迁移 + 回填；当前企业租户共享一个账务池 |
| P3-2 | `billing/service.ts` `recordUsage` | 404/422 仅 `console.warn`，无本地暂存/重放队列 | Lago 侧漏计不可恢复（与 P1-3 叠加） |
| P3-3 | `billing_webhook_events`、`payment_events`（尤其 `amount_unreadable` 刻意累积） | 无保留期清理任务 | 表无限增长（低速率下可长期忽略） |
| P3-4 | `service.ts` `dayKey` | usage daily 按服务器本地时区分桶 | 部署时区/夏令时变化导致图表日界漂移 |
| P3-5 | `credits-writer.ts` `consumeCredits` 循环 | 每吸收一个 grant 一轮 `SELECT..FOR UPDATE`，大额消耗跨多 grant 时多次往返 | 排序稳定无死锁、语义正确，仅性能边角 |
| P3-6 | `index.ts` 汇率 TODO | `1 token = 1 credit` 占位汇率写死在两个调用点 | 已被 TODO 标注；实现真实定价时 P0-1 的幂等键修复必须同车 |

### 值得保留的亮点（避免重构时误伤）

这些是代码里真实做对、且被测试钉住的设计，梳理结论不是"推倒重来"：

1. **pending-pair 部分唯一索引**（0071）：并发双开单在数据库层面收敛为一单，输家变重放。
2. **confirmPaid 单事务**（CAS + paid fact + `TransactionAlreadyKnown` 回滚信号）：钱态与事实原子，幂等答案读自提交态。
3. **credit ledger 双列**（`credits` 全额 vs `applied` 实吸收）：透支可见而非四舍五入，配合 CHECK 约束形成运行时+事后双重栅栏。
4. **webhook inbox 后写**：行存在即工作完成，崩溃不丢事件（与被继承的 Go 版的分歧有书面记录）。
5. **金额全整数纪律**（缩放积分、手工位解析金额字符串、`centsToAmountString`）。
6. **错误哨兵码不携带细节**：URL/密钥不可能经 stack trace 入日志。
7. **query-first 过期扫单**：先问渠道再埋单，渠道不可达即跳过，不丢钱。
8. **outbound SSRF 门 + boot 时 fail-fast**。

---

## 三、改进建议与重构方向

**方向一：计量与幂等键正确性（对应 P0-1、P3-2、P3-6）**
把"一次消耗"建模为业务事实：模型 finish 用 `(botId, conversationId, finishSeq)` 或 UUID；持久化一个 `usage_outbox`（本地表）再异步推 Lago，推失败可重放——这同时消灭 fire-and-forget 的漏计和幂等键碰撞。真实汇率（per-model 定价表）作为 outbox 的一个映射函数插入，不再散落两个调用点。

**方向二：订阅生命周期与积分发放对齐（对应 P0-2、P1-2）**
- 定义唯一的 `isLiveSubscription` 谓词并三处共用；
- 新增 `period-grant sweeper`：扫描活跃订阅的 `currentPeriodStart` 变化，按 `plan:<subscriptionId>:<periodStart>` 幂等发放，天然兼容续订；
- guard 对"同计划到期前续购"给出可区分的 refusal（`expiring-soon`），配合前端引导。

**方向三：webhook 处理失败语义（对应 P1-1）**
验签成功后的任何处理异常 → 5xx（渠道重投）；仅"验签失败/负载不可解析"→ 4xx。一行 catch 分支的改动词。

**方向四：对账闭环（对应 P1-3、P2-1）**
reconcile 增加第三恒等式（ledger ids ↔ Lago event ids 差分）与第四查询（blocked/over_paid/late_payment 未决清单）。让 `POST /api/admin/billing/reconcile` 从"体检"变"体检+未决工单导出"。

**方向五：权限收敛（对应 P1-4）**
账务读面按"部署管理员可见"收紧；`checkoutPayload` 仅回创建者。若产品要团队共享池，把账单/积分页降为脱敏聚合。

**方向六：多租户预留（对应 P3-1）**
短期不动；但在任何新表上从现在起带 `external_customer_id`，为 billing 系列表补 tenant 列留好演进缝，避免 P3-1 的迁移雪球。

---

## 四、任务拆分与分工计划

依赖关系：`T1 → T2`（幂等键先于定价，同车发布）；`T3 独立`；`T4 依赖 T5`（谓词统一是发放 sweeper 的前置）；`T6/T7/T8 独立`，可并行。

| # | 任务 | 内容 | 模块 | 依赖 | 优先级 | 建议人力 |
|---|------|------|------|------|--------|----------|
| T1 | 幂等键重建 | LLM finish 改 UUID/业务 id；补重启场景回归测试（重启前后同键必须扣两次） | billing/index.ts | — | P0 | 后端×1，1–2 天 |
| T2 | 计量 outbox + 真实汇率 | `usage_outbox` 表 + 重放任务 + per-model 定价配置；TODO(product) 落地 | billing | T1 | P0/P1 | 后端×1，3–5 天 |
| T3 | webhook 失败语义修正 | catch 分支分级（意外错误 5xx）+ 集成测试（DB 故障注入） | billing/service.ts | — | P1 | 后端×1，0.5 天 |
| T4 | live 谓词统一 | 导出 `isLiveSubscription`，entitlement/guard/reconcile 三处替换 + 测试 | billing | — | P1 | 后端×1，0.5–1 天 |
| T5 | 周期发放 sweeper | 新增 period-grant 扫描（幂等键 `plan:<subId>:<periodStart>`）+ 续购 guard 放行策略 | payments/credits | T4 | P0 | 后端×1，2–3 天 |
| T6 | reconcile 增强 | ledger↔Lago 事件差分 + 未决 anomaly 工单导出 | billing/reconcile.ts | — | P1 | 后端×1，2–3 天 |
| T7 | 账务权限收紧 | 读路由加 admin / QR 仅创建者可见 + 路由测试更新 | payments/routes, billing/routes | — | P1 | 后端×1，1 天 |
| T8 | P2 杂项包 | blockOrder code 入参；usage 短缓存；addMonths 钳制；grant 限额；sweeper SKIP LOCKED | payments | — | P2 | 后端×1，2 天 |

**建议实施顺序**：
```
第一批（止血，本周）：T1 → T3 → T4        （T1/T3/T4 互相独立可并行开工）
第二批（业务正确性，下周）：T5 → T2
第三批（治理）：T6 → T7 → T8
```

**验收要点**（每任务的可回归断言）：
- T1：重启前后 `llm:` 键不重复；`credit_ledger` 行数 == finish 次数。
- T3：验签后 DB 断连 → 响应 5xx、inbox 无行；Lago 重投后自愈。
- T4：incomplete 订阅下 entitlement/guard/reconcile 三方回答一致。
- T5：模拟 Lago 周期翻转后，第二周期自动发放一次且仅一次。
- T6：人为删一条 Lago 事件 → reconcile 报 `local_without_lago`。
- T7：非 admin 用户 `GET /purchases/:id` 403/404，QR 不回传。

---

*审阅范围未含：`desktop/`、`app/` 前端消费侧的真实渲染逻辑（仅核对了 API 契约）；`agent-*` 参考实现目录；`kb-mastra/`。如需前端侧（套餐与积分页面、升级弹窗）的同规格梳理，可另开一份。*
