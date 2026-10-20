# 计费代码审计（2026-10-14）

**审计基线**：`main` @ `c0167c5c`（审计过程中 HEAD 从 `7bfc18f2` 切到该合并提交；`git diff 7bfc18f2 HEAD -- server/src/billing …` 为空，所有计费文件内容未变，只有 `server/src/index.ts` 行号因无关新增而位移，本文行号按当前工作树）。

**范围**：`server/src/billing/**`（含 `payments/`）、`server/src/db/schema/{billing,credits,credit-reservations,payment,usage-outbox}.ts`、计费执法点 `server/src/copilot.ts` `meteredModel`、装配点 `server/src/index.ts`、定价 `server/src/workshop/metering.ts`、配置 `server/src/config.ts`、代码运行门 `server/src/codesandbox/gateway.ts`、前端 `app/src/lib/billing/**` 与 `app/src/{routes,components}/billing`。

**方法**：全部结论来自读代码 + grep + 实际运行。已运行的证据：
- `bun test`（20 个计费单测文件）→ **471 pass / 0 fail**（集成测试需要 `TEST_DATABASE_URL`，本次未跑）。
- 用 stub database 直接跑 `createCredits(...).summary()`，输出见 A1。
- 用 `.env` 里真实的 rate/ceiling 复算每次调用的预扣额，输出见 A4。

**先说结论里"没问题"的部分**（避免只报忧）：整数/有理数金额纪律（`CREDIT_SCALE`、`bigint` 有理数、`amountStringToCents` 手工位解析）、幂等靠唯一索引而不是读前检查、`confirmPaid` 的 CAS + paid fact 同事务、`onConflictDoNothing` 都带精确 target、SSRF 出站门（含 DNS 复查）、Lago webhook 的 `alg` 白名单 + `data` 与原文相等、WeChat 回调的四段验签（时间偏移 → 证书序列号 → 验签 → 解密 → mchid/appid）、reconciler 只读且用 BigInt 精确比较——这些都写得很扎实。下面的问题是剩余的。

---

## A. 会算错钱 / 漏收钱 / 收款后不发货

### A1【高】`credits.summary()` 把**已过期** Grant 计入 remaining，并且**完全不看** Reservation（hold）

`server/src/billing/credits.ts:78-87`

```ts
const live = remaining > 0 && row.expiresAt.getTime() > now;
if (row.source === "plan") { plan.remaining += remaining; }        // 不看 live
else { rewards.remaining += remaining; if (live) rewards.grantCount += 1; }  // 只有计数看 live
```

`live` 算出来了，却只用于 `grantCount`；`remaining` 无条件累加。实测（stub 数据库，一条活的 plan grant 100 积分用掉 10，一条**昨天过期**的 promo grant 50 积分未用）：

```
summary: {"plan":{"total":100,"used":10,"remaining":90},"rewards":{"total":50,"used":0,"remaining":50,"grantCount":0}}
```

即页面会显示"**0 个奖励，剩余 50**"——同一句话里两个数字互相打脸，而这 50 积分一分都花不掉（写侧 `freeGrants` 用 `gt(expiresAt, now)` 过滤掉了它）。

第二个真相源：写侧的准入权威 `availableBalance` 会减去活跃 hold 和尾差占位（`credits-writer.ts:availableOf`），读侧 `summary` 一次都不 join `credit_reservation_allocations`。所以一次进行中的调用锁住 21 积分（见 A4）时，页面仍然显示全额余额，用户看到的是"我明明有 90 积分，为什么拒绝我"。

**测试缺口**：`createCredits` 在整个 `server/tests` 里**零引用**（`grep -rn createCredits server/tests` 无结果）；`billing-credits.test.ts` 测的是路由，`Credits` 是手写 stub（`tests/billing-credits.test.ts:58-96`）。也就是说读侧聚合逻辑一行都没被测过。

> 建议：`summary` 复用写侧同一个 `freeGrants` 口径（过期不计、扣活跃 hold），或者显式改名为 `lifetimeTotals` 并另出一个 `spendable` 字段；给 `createCredits` 补真实数据库集成测试。

### A2【高】provider 不回 usage ⇒ **释放预扣、不计量、不扣费、不留异常**（静默免费）

`server/src/copilot.ts:777`（流结束没有 finish part）、`:823`（`billedInput = inputTokens ?? 0`）、`:875`（usage 为 0）→ 三处都走 `settleFail("no_usage")` → `lifecycle.fail` → `index.ts:3721` `releaseReservation(...)`。

`@ai-sdk/openai@3.0.99` 的 chat 路径确实会带 `stream_options: {include_usage: true}`，且 `convertOpenAIChatUsage(null)` 返回 `inputTokens.total === undefined`（已核对 `server/node_modules/@ai-sdk/openai/dist/index.js:215-240`、`:1145-1152`）。问题是**任何忽略 `include_usage` 的 OpenAI 兼容网关**（自建代理、部分 vLLM/老版本网关、GLM 的某些端点）都会让 `usage == null`：

- 预扣被释放（当作"确认无费用"）
- outbox 不写行 ⇒ Lago 也没有该事件 ⇒ 供应商侧账单同样漏计
- 没有 anomaly、没有 reconcile finding、只有一条 debug 级日志

这直接违反本仓库自己的领域定义与 ADR：

- `CONTEXT.md` **Pending Settlement**：「调用已经获得预留但实际费用尚未可靠确定的状态；对应额度仍被占用，直到结算或**确认无费用**后释放。_Avoid_: 免费失败」——usage 缺失是"结果未知"，不是"确认无费用"。
- `docs/adr/0003-bifrost-openbot-credit-admission.md`：「结果未知时保留预留，直到可靠结算或确认无费用后释放」。

> 建议：把 `no_usage` 分成两类——provider 明确报 0 token（可释放）与 provider 没报 usage（保留 hold + 写一条 `usage_missing` 的 anomaly/outbox 行，交给对账）。至少要有可观测计数，否则这条路径永远不会被发现。

### A3【高】over-bound 路径**销毁用量事实**，文档承诺的"留人工对账"没有可对账的记录

`server/src/copilot.ts:834-846`：实际 token 超过配置上界 ⇒ `failSettlement(...)` ⇒ `controller.error(...)`，**在 `settleFinish` 之前**，所以 `index.ts` 的 `finish` 从没被调用 ⇒ `usageOutbox.record` 从没执行。

后果：
1. 供应商已经产出的 token 既不进 Lago 也不进积分台账，**用量数字彻底丢失**（不是"延迟结算"，是"没有记录"）；
2. 用户已经生成完的回答被 `controller.error` 撕掉（产品层面：白跑一次长请求）；
3. 唯一残留是一条 `billing-model-usage-over-bound` 日志 + 15 分钟后 hold 过期产生的 `expired_reserved_reservation`（`reconcile.ts` 那条 finding 只带 `usage_event_id` 和 `maximum`，**不带 token 数**）。

而三处文档都宣称有对账证据：`billing/input-bound.ts:16`「surfaces at settlement as `usage_over_bound` — a held reservation for reconciliation」、`index.ts:3641` 附近同样的话、`reference/configuration.md:58-61`「surfaces at settlement as an over-bound hold for operator reconciliation rather than a silent charge」。实际是"hold 留住了，事实没留住"。

补充：`index.ts` 的 `finish` 里还有第二条同形态路径——`calculateExactModelUsageCharge` 抛错（`usage_over_token_max` / `usage_over_reservation`）时也是"不写 outbox + 保留 hold"（`index.ts:3673-3690`）。

> 建议：over-bound 也要落一条不可变事实（outbox 行 + `creditsStatus='blocked'`，或专用异常表），带真实 token 数；对账才有东西可对。是否仍要撕掉用户可见的流，是产品决策，应显式记录。

### A4【中高】预扣额 = **最坏情况上限**，导致小额余额用户被全量拒绝，且报错说"没有积分"

`index.ts:3623` `maximumCents: Number(modelPolicy.maximumReservationUnits)`，而 `maximumReservationUnits` 在 `config.ts:1553-1573` 由 `ceilingProduct(inputMax, inputRate) + ceilingProduct(outputMax, outputRate)` 推出。用 `.env` 里的真实配置复算：

```
BILLING_MODEL_CREDIT_RATES={"GLM-5.3":{"input":1/100,"output":1/20}}
BILLING_MODEL_MAX_RESERVATION_TOKENS={"GLM-5.3":{"input":128000,"output":16384}}
→ input ceiling  = 1280 scaled units = 12.80 积分
→ output ceiling =  820 scaled units =  8.20 积分
→ 每次调用预扣   = 2100 scaled units = 21.00 积分
→ standard 套餐 4000 积分 ⇒ 理论并发 190 次
→ 余额 20 积分能否发起一次调用？false；21 积分？true
```

也就是说：**余额 < 21 积分的部署/用户，一次模型调用都发不出去**，即使真实成本通常只有几分钱。而 `reserveCredits` 失败时 `index.ts:3629/3631` 抛的是 `CreditGateError`，用户看到的是「This deployment has no credits left」——技术上不成立（他有 20 积分）。签到/活动发的小额奖励积分因此直接变成不可用余额。

同一处还有第二个语义混淆：`index.ts:3611` `if (!creditPolicy?.configured) throw new CreditGateError()` 和 `:3614` `if (!modelPolicy) throw new CreditGateError()`——**"运维没配价格"和"用户没钱"共用一个哨兵**，而 `config.ts:1600-1620` 的 `issues` 是全局的：任意一个模型的 rate 写错（含 rate=0 导致 `maximumReservationUnits === 0n` 判 out_of_range），整个策略 `configured:false`，**全部署所有模型调用一律拒绝**，报"没有积分"。

> 建议：(1) 预扣额与 token 上限解耦，按"典型上界"而非"最坏上界"预留，或支持分档；(2) 三种拒绝分开哨兵：`credits_exhausted` / `credit_policy_unconfigured` / `model_not_priced`，前端文案与告警完全不同；(3) `configured` 改为 per-model 降级，一个模型配错不该拖死全部。

### A5【中】结算只比金额，**从不比币种**

`payments/service.ts:settlePaidFact` 只做 `fact.amountCents !== order.amountCents`（`:492`）。`PaymentFact.currency` 全模块无人读取：
- `alipay.ts:alipayFact` 直接硬编码 `currency: "CNY"`，不读通知里的币种；
- `wechat.ts:wechatFact` 只在 `currency === "CNY"` 时才带上字段，其它币种静默丢弃。

激活阶段确实检查了 Lago **plan** 的币种（`service.ts:405`），但**渠道实收币种**没有任何一处与订单快照 `payment_orders.currency` 比对。`reconcile.ts` 的注释还写着「currency is database-enforced CNY on both sides」——数据库约束的是本地列，管不到渠道回传的事实。

> 建议：`settlePaidFact` 增加 `fact.currency && fact.currency !== order.currency ⇒ blocked/anomaly`；Alipay 侧读通知里的实际字段而不是硬编码。

### A6【中】套餐 `credits` / `priceCents` 没有 int32 上界校验 ⇒ **收款成功、发货永久失败**

`config.ts:1999-2007`（credits）与 `:2041-2048`（priceCents）只校验「整数且 ≥ 0」，没有上界；`credits-writer.ts:grantCredits` 同样只校验非负整数（`:205-213`），**不校验 `MAX_STORED_UNITS`**（`reserveCredits`/`settleReservation` 都校验了，`grantCredits` 漏了）。而 `credit_grants.total` 是 `integer`（int32）。

于是 `LAGO_PLAN_CATALOG` 里写 `credits: 30000000`（×100 = 3e9 > 2147483647）时：用户付款成功 → `activateOrder` → `grantPlanCreditsFor` 插入触发 Postgres 22003 → catch 返回 false（`service.ts:grantPlanCreditsFor` 的 catch）→ 订单永远停在 `activationState='pending'` → sweeper 每 60s 无限重试 → 3 次后写一条 `activation_retry_exhausted`。钱收了，订阅可能已建，积分永远发不出去。

> 建议：`config.ts` 解析时校验 `credits * CREDIT_SCALE <= 2147483647`（以及 `priceCents <= 2147483647`）；`grantCredits` 补上界校验，让错误在启动/入参处炸，而不是在收款之后。

### A7【中】Lago webhook 无重放窗口：事件身份来自**未签名**的 header，JWT 的 `iat/exp` 完全不检查

`webhook-signature.ts:108`：`eventId = headers.get("x-lago-unique-key")`，而签名覆盖的只有 body（jwt 模式校验 `data` 与原文相等，hmac 模式校验原文）。`grep -n "exp\|iat" webhook-signature.ts` 无结果——token 里的时间声明一个都没读。

因此抓到**一条**合法投递的人，可以配任意新的 `X-Lago-Unique-Key` 无限重放：inbox 去重键是 `(provider, eventId)`，每次都是"新事件"，于是每次都通过验证、每次都重新读 Lago 并 upsert 投影、每次都写一行 inbox。内容伪造不了（body 必须与签名一致，且投影是从 Lago 权威对象重读的，不会回退状态），但：去重保证建立在未认证数据上、审计/inbox 表可被灌垃圾、每次重放都会放大成对 Lago 的多次 API 读取（无速率限制）。

> 建议：校验 JWT `exp`/`iat`（hmac 模式加时间戳 header + 偏移窗口，和 WeChat 适配器一样）；或把 `x-lago-unique-key` 纳入去重前先做 body 哈希去重（`sha256(rawBody)` 唯一索引），让重放命中已有行。

### A8【中】非重试型数据库错误在 webhook 上被回答 **400**，Lago 停止重试 ⇒ 投影永久丢失

`service.ts:handleWebhook` 的 catch：只有 `BillingPersistenceError` 与 `BillingError.retryable` 回答 503，其余一律 400。而 `store.ts:withPersistenceError` **只在 `isRetryableDatabaseError` 为真时**才包装成 `BillingPersistenceError`；不可重试的 DB 错误（例如投影 upsert 撞 23505、字段超长 22001、约束 23514）原样抛出 → 落到 400 分支 → 不写 inbox → Lago 认为"客户端错误，不再重试"。

设计意图（永久失败不该重试）可以理解，但把"我们自己的存储/数据问题"编码成 **4xx 客户端错误**是错的分级：既让上游停止重试，又在 Lago 的投递面板上表现为"对方拒绝"。

> 建议：非重试型持久化失败回答 500（Lago 会重试并暴露给运维），或至少写一条 inbox/anomaly 行留证据；400 只留给"签名合法但语义上不可处理"的投递。

---

## B. 领域模型 / 架构偏离（与本仓库自己的事实源冲突）

### B1【高】积分归属：事实源说"属于 OpenBot 用户"，实现是"属于整个部署"

- `CONTEXT.md`：**OpenBot User**「是本次 Bifrost 对接中积分消费的归属主体；同一组织的不同用户各自拥有积分余额」；**Model Access Grant**「同一用户不同授权的凭据共同消费该用户的积分余额」。
- `docs/adr/0002-per-user-bot-model-access.md`、`docs/adr/0003-...md`（「一个 OpenBot 用户关联一个 Bifrost Customer」）同向。
- 实现：`service.ts:deploymentExternalCustomerId(tenantId)` → `openbot-deployment-<tenantId>`，全模块只有一个 key；`credit_grants` / `credit_ledger` / `credit_reservations` **没有任何 owner/user 列**（`db/schema/credits.ts`、`credit-reservations.ts`）；`routes.ts:createBillingCreditRoutes` 只挂 `requireUser`，读取一律用部署 key。

后果（当前即可观察，不只是"未来做不了"）：**任何登录用户都能看到整个部署的积分余额与全部消耗明细**（`GET /api/billing/credits/{summary,grants,consumption}`），账单/订单侧反而按 `createdBy` 严格隔离（`payments/store.ts:ownerScopeCondition`，spec 的 "Billing visibility" 决策）。同一套系统里两种可见性口径。ADR-0003 已声明"不代表当前代码已提供上述保证"，所以这不是隐藏缺陷，但它是**领域语言与实现的最大裂缝**，且已经在泄露消费明细。

> 建议：要么把 `CONTEXT.md` 的归属主体改成部署（并说明消费明细对所有成员可见），要么给 ledger/grant/reservation 加 owner 列并把 customer key 下沉到用户级。这是 ADR 级决策，不该在实现阶段默默选边。

### B2【中高】已批准 Spec 与 ADR-0001 / 实现互相矛盾，Spec 未回写

`docs/specs/superpowers/2026-10-11-billing-reliability-design.md:35`（"Billed admission per surface — decided 2026-10-13"）仍写：模型调用输入侧无法证明上界 ⇒ 一律 `input_bound_unsupported` 拒绝；翻盘条件是「a provider count-tokens contract this adapter demonstrably honours (declared `counted`)… landed with adapter-level tests that inspect the actual outgoing request」。

实现（`index.ts:3647`）已声明 `enforced: "counted"`，但计数器是**我方基于序列化字节的经验估算 + 截断**（`billing/input-bound.ts`，ADR-0001），不是 provider 的 count-tokens 契约；也没有"检查实际外发请求"的适配器级测试。`reference/configuration.md:56-61` 已按 ADR-0001 改写，Spec 没有。

按 `AGENTS.md`：「如果实施 Plan 与已批准 Spec 冲突，以 Spec 为准」「如果实现与 ADR 或批准需求冲突，应升级处理，而不是在实现阶段静默重新设计」。现在是 ADR 与 Spec 各执一词、实现跟 ADR 走。

> 建议：把 Spec 的 "Billed admission per surface" 段落按 ADR-0001 更新（含"保守计数会低估 ⇒ 超支由 A3 的兜底路径处理"这一前提），或把 ADR-0001 降级为待批提案。顺带：`fitChatInputRequest` 目前只在 `copilot.ts` 内对 params 生效，Spec 要求的"检查真实外发请求"的测试确实缺失。

### B3【中】打开计费 ⇒ 代码运行功能全禁；且能力位一旦翻开就会永久 `blocked`

`codesandbox/gateway.ts:163-166` + `codesandbox/client.ts:131` `enforceableTokenBudget: false`（硬编码常量，非配置）⇒ `billingBlocked` 恒真 ⇒ 每个 code run 直接 `refusedStream("billing-token-budget-unavailable")`。这是 F5 的既定决策，但值得明确记录产品后果：**配了 Lago 的部署，代码运行 100% 不可用**。

连带陷阱：`workshop/metering.ts:reportCodeRunUsage` 写 outbox 行时**不带 `reservationId`**，`creditsStatus` 默认 `pending`；`usage-delivery.ts:78-81` 的 credits target 见到没有 reservation 就抛 `missing_reservation`，`:176` 直接 `block`。所以哪天有人把 `enforceableTokenBudget` 改成 `true`（code-run 路径**没有**任何 reserve 调用），每个 code run 都会产生一条永久 `blocked` 的 credits 投递——Lago 计量正常、积分永远收不到、对账里堆满 `usage_target_blocked`。

> 建议：在 `reportCodeRunUsage` 处显式写明"code-run 必须带 reservation 事实，否则不允许开计量"，或在 outbox 写入时就拒绝 `source='code_run' && reservationId == null`（数据库 CHECK 已经允许这种组合，`usage_outbox_credit_identity_check`）。

### B4【中】credit writer 同时携带两套互斥语义，其中一套生产无调用者

`credits-writer.ts:556 consumeCredits`（文档字符串整段在讲 **POST-PAID**：「调用先放行、结束后按实际扣」「`insufficient` 不是本方法的答案」）在生产代码里**没有任何调用者**（`grep -rn consumeCredits server/src` 只命中定义与注释；`tests/qa-batch1-llm-meter-id.test.ts` 甚至专门断言 index.ts 里**不许**出现 `consumeCredits`）。生产路径是 `reserveCredits` / `settleReservation`（hard-cap）。

同一接口里还有 `readBalance` 与 `availableBalance` 两个方法指向同一个 `availableOf`（`:268-274`）——接口比实现宽。

后果：模块接口（按 `codebase-design` 的说法，interface 包含"调用者必须知道的一切"）同时声明了两种互相矛盾的消费语义，读者要靠 grep 才能判断哪套是真的；`credits.ts` 读侧的注释也仍在讲 post-paid 的 `applied < credits` 透支叙事（见 D2）。

> 建议：删掉 `consumeCredits` 与 `readBalance` 之一（或明确标注为 legacy 并从 `CreditWriter` 接口移出），让接口只声明 hard-cap 一套语义。

### B5【中】死代码 + 说谎的注释：`readLatestPaidOrder` 与 `recordUsage`

- `payments/store.ts:295 readLatestPaidOrder`：实现完整、带长注释（「duplicate_paid never fired」的历史教训），**生产零调用者**（只有三个测试文件的双实现里出现）。它的调用点在 `88664e88` 被 `resolveActivationOwnership` 取代。
- `payments/service.ts:620-626`：注释仍宣称「A cross-order duplicate is worth one more look on EVERY confirm … the anomaly is what makes it visible to reconciliation instead of hiding inside a second」——句子在"second"处**被截断**，而它描述的 `readLatestPaidOrder` + `duplicate_paid` 检查在同一次提交里已被删除，紧跟其后的代码只是 `readOrder` + `activateOrder`。
- `billing/service.ts:427 recordUsage`（best-effort 计量）同样**生产零调用者**，已被 `deliverUsage` + outbox 取代；`routes.ts` 的注释还留着 "the usage meter (recordUsage)" 的测试分组。

> 建议：删掉两个死方法（或注明保留原因），并把 `settlePaidFact` 那段注释改成描述现状（重复收款由 `resolveActivationOwnership` + `duplicate_paid` anomaly 处理）。这类"注释描述已被删除的行为"在计费模块里代价特别高——下一个人会以为保护还在。

### B6【中】订阅投影只增不减，且 `pending` 状态从不查询

`service.ts:writeSubscriptionProjections` 只对 Lago 返回的列表做 upsert，**从不删除/降级**本地存在但远端不再返回的行；`lago.ts:167 SUBSCRIPTION_STATUSES = [active, incomplete, canceled, terminated]`，**不含 `pending`**（Lago 的订阅确有 pending 态）。

后果：
1. Lago 侧删除（或状态落到未查询的 `pending`）后，本地 `billing_subscriptions` 行永久停在 `active` ⇒ `entitlements()` 永久 `active:true`（免费用下去），且 `createPurchase` 被 `active-subscription` 永久拒绝（付不了钱）；
2. `reconcile.ts` 只检查反方向（`applied_without_subscription`：applied 订单 ⇒ 必须有 live 行），**没有** "本地 live 行但远端已无" 的检查——而且 reconciler 被设计成不访问 provider，所以这类漂移在现有对账里根本不可见；
3. `ensureSubscription` 的"已有 live 订阅就复用/拒绝"判断也建立在同一个不完整列表上，可能在 pending 订阅存在时再建一条。

> 建议：`listSubscriptions` 请求全部状态（或至少加 `pending`）；webhook/sync 时对"远端不再返回"的本地行做显式降级；给 reconciler 增加一个可选的 provider-side 抽查通道（保持默认只读，另开一个显式的 `--with-provider` 类开关）。

---

## C. 运维 / 可观测 / 一致性

### C1【中高】usage 投递没有终态：永久失败的行每 30s 重试到天荒地老

`usage-delivery.ts:176` 只有 `missing_reservation` 会 `block`；其余全部走 `recordDeliveryFailure`（只写 `*_last_error_code` + `updatedAt`，状态仍 `pending`）。而：
- `lago.ts:postEvent` 把 404/422（指标不存在、订阅不存在——**永久错误**）映射成 `provider_refused`；
- `service.ts:deliverUsage` 在没有 active 订阅时抛 `no_active_subscription`（同样可能长期为真）；
- `CreditReservationConflictError`（hold 已 released、或 actual 不一致——**确定性冲突**）没有 `code` 字段，`failureCodeOf` 退化成 `delivery_failed`。

`usage_outbox` 表**没有尝试次数列**（`db/schema/usage-outbox.ts` 只有两个 status + 两个 last_error_code），所以既没有"N 次后 block"，也没有退避。结果：一笔永远收不到的钱以每 30 秒一次的频率永久重试，`reconcile` 里表现为 `usage_target_pending` 计数持续增长（且 `usageFindingLimit=100` 之后的行只汇总成一条 `usage_findings_omitted`）。

> 建议：加 `lago_attempts` / `credits_attempts` 列，超过阈值转 `blocked`；把确定性冲突（reservation conflict、provider 422）直接归类为不可重试并 block。

### C2【中】`.env.example` 缺 4 个 `BILLING_*` 键 ⇒ 按模板部署必然全量拒绝

`grep -n "BILLING_" .env.example` **无结果**（同文件有 16 处 `LAGO_*`）；四个 hard-cap 键只在 `reference/configuration.md:41-47` 有说明，真实 `.env:644-647` 有值。

结合 A4/C1：从 `.env.example` 起的新部署只要配了 `LAGO_API_URL`，就会 `creditPolicy.configured === false` ⇒ `index.ts:3611` 对**每一次**模型调用抛 `CreditGateError` ⇒ 用户看到「This deployment has no credits left. Ask an administrator to grant credits or upgrade the plan.」，而真实原因是四个环境变量没配。这是最容易踩、最难自查的一个坑（`.env` 里那行注释自己都写了："Without all four the model gate refuses every call ('no credits')"）。

> 建议：`.env.example` 补齐四键（带注释与示例值）；启动时若 `billing` 已配置但 `creditPolicy.configured === false`，用 `log.error` 打出 `issues` 列表（现在 `issues` 被解析出来后只在类型里，没有任何一处输出给运维——`grep -rn "creditPolicy.issues" server/src` 无结果）。

### C3【中】`reconcile` 全表载入内存；sweeper 无 leader 选举；stop 句柄被丢弃

- `reconcile.ts`：`paidOrders`、`paidFacts`、`duplicateAnomalies`、`reservedRows`（含 join 展开）都是**无 limit 的全表查询**，注释明确说"抽样就不是审计"，但没有分页/流式处理。订单与事件表随时间线性增长，一次 `POST /api/admin/billing/reconcile` 的内存与耗时会跟着涨（`usage_outbox` 侧反而做了 `usageFindingLimit`，两套标准）。
- `maintenance.ts:startUsageDeliverySweeps` 与 `payments/maintenance.ts:startPaymentSweeps` 都是进程内 `setInterval`，**没有顾问锁/leader 选举**。多副本部署时每个副本都会扫同一批 pending 行（幂等性靠 Lago transaction id 与 reservation 状态兜住，不会重复扣钱，但会成倍放大对 Lago 的调用与 DB 争用）。
- `index.ts:3748` 与 `:3914` 都**丢弃了返回的 `stop()`**，没有优雅停机：进程退出时可能正处在一个 batch 中间（幂等设计下不致命，但和"可恢复"的目标不一致）。

> 建议：reconcile 分页/游标化；sweeper 用 Postgres 顾问锁（`pg_try_advisory_lock`）保证单实例执行；把 stop 句柄接到关停流程。

### C4【低中】Alipay 金额用浮点除法，模块内精确实现却是死代码

`alipay.ts:197`：`total_amount: (input.amountCents / 100).toFixed(2)`。
`crypto.ts:110 centsToAmountString` 是同一件事的精确实现（手工位分解，文档写着「a payment amount is one place a rounding error is theft」），**只被 `tests/payment-crypto.test.ts` 使用**。

当前量级下 `n/100` + `toFixed(2)` 不会错（n 为 int32 分时双精度足够），但这是"正确实现存在却绕过"的典型：一旦 `amountCents` 上界放宽（A6 说的缺校验）或有人复制这段到别的渠道，就会真的出错。

> 建议：`alipay.ts` 改用 `centsToAmountString`，删掉浮点路径。

### C5【低】`consumeCredits` 的重放答案里 `remaining: 0` 是假数字

`credits-writer.ts:582`（事务外快路径）与 `:615`（事务内竞争路径）：幂等命中时返回 `{inserted:false, applied: known.applied, remaining: 0}`——`remaining` 与真实余额无关，只是"没算"。目前是死代码（B4），但接口契约里 `remaining` 被文档描述为「The balance after this draw」，任何未来调用者拿它做判断都会被误导。

> 建议：随 B4 一起删除，或把返回类型改成 `remaining: number | null` 明确"未计算"。

---

## D. 前端 / 展示

### D1【中】透支（overdraw）在 UI 与对账里都不可见，与 schema 的承诺相反

`db/schema/credits.ts` 对 `applied` 列的注释：「`credits - applied` is the overdraw, **visible** instead of rounded away」。实际：
- `credits.ts:consumption()` 只返回 `credits`（全额成本），**不返回 `applied`**；
- `app/src/lib/billing/credits.ts:CreditConsumptionEntry` 也没有 `applied` 字段；
- `reconcile.ts` 的积分恒等式只比 `Σ grants.used` 与 `Σ ledger.applied`，**从不统计 `Σ(credits - applied)`**。

于是"余额不够仍然发生了消费"这一事实，在页面、在账单、在对账报告里全都看不到——只能靠人肉 SQL。

> 建议：consumption 读取带出 `applied`（前端用弱化样式标注未吸收部分），reconcile 增加一条 `overdraw_total` 汇总（只读，不修复）。

### D2【低中】`usage.tsx` 把两个口径不同的数字并排展示

`app/src/routes/_authed/settings/usage.tsx:220-224` 与 `:244-247`：`rewardsSummary` 同时用 `grantCount`（只算活的）和 `remaining`（含过期，见 A1）。这是 A1 的用户可见形态，修 A1 即可；但即使 A1 修好，这两个数字来自不同过滤条件的设计本身也容易再次分叉，建议服务端直接给出一致的 `{grantCount, remaining}` 对。

### D3【低】展示层浮点除法与"整数端到端"的纪律表述不一致

`app/src/lib/billing/format.ts:money()`（`cents/100`）、`credits()`；服务端 `credits.ts:scaleDown()`（`units/100`）。纯展示可以接受，但 `scaleDown` 的返回值会跨 HTTP 变成 JSON number 再被前端格式化——`2363/100` 这类值在 JSON 里是 `23.63`（双精度近似）。目前只在展示路径使用，**没有**参与任何比较，所以不构成缺陷；但 AGENTS/spec 反复强调"no `Number()` rounding between the database and a money comparison"，建议在 `scaleDown`/`money` 上加注释说明"仅限展示，禁止用于比较"，防止后来者拿它做判断。

---

## 优先级建议

| 级别 | 条目 | 一句话 |
| --- | --- | --- |
| P0 | A2、A3 | 两条"用量事实丢失"路径：一条静默免费，一条把已产出的 token 连同用户回答一起销毁 |
| P0 | A1 | 用户看到的余额是错的（含过期、不含 hold），且读侧零测试 |
| P1 | A4、C2 | 预扣=最坏上限 + 三种拒绝共用一个哨兵 + `.env.example` 缺键 ⇒ "配了计费就全拒，且报'没积分'" |
| P1 | A6、A8 | 收款后永久发不出货（int32 上界）；投影丢失被编码成 4xx |
| P1 | B1、B2 | 领域归属（部署 vs 用户）与 Spec/ADR 冲突，需要决策回写而不是继续实现 |
| P2 | A5、A7、B6、C1 | 币种不校验、webhook 可重放、投影只增不减、投递无终态 |
| P3 | B3、B4、B5、C3、C4、C5、D1–D3 | 陷阱与卫生：死代码、说谎注释、全表对账、浮点金额、透支不可见 |

## 我没有验证的部分（避免过度声明）

- **集成测试未运行**（需要 `TEST_DATABASE_URL`）：`billing-credits-writer.integration.test.ts`、`billing-reconcile.integration.test.ts`、`payment-store.integration.test.ts`、`qa-batch*` 等。所以 A1/A5/A6 的数据库层行为是读代码 + stub 运行推得的，没有在真库上复现。
- **A2 依赖真实网关行为**：`usage == null` 的触发条件是"上游忽略 `stream_options.include_usage`"，我没有对真实 GLM/自建网关发请求验证，只验证了 SDK 在 `usage == null` 时确实产出 `total: undefined`。
- **A7 没有实际重放**：结论来自"签名覆盖范围不含该 header + 无 exp/iat 校验"的代码事实，未构造真实重放请求。
- **前端只读了 `lib/billing` 与 `usage.tsx` 片段**，`upgrade-dialog.tsx`（552 行）、`invoices.tsx`、`consumption-table.tsx` 未逐行审计。
