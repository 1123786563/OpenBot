Review partially complete: 57 finding(s); 3 of 46 selected item(s) failed.

─── server/drizzle/meta/0075_snapshot.json:16282-16287 ───
[style · low] 快照文件末尾缺少换行符（diff 中标记 "\ No newline at end of file"）。这是 drizzle-kit 生成产物的默认输出格式，仓库中未见
.editorconfig 等 lint 约束，对 drizzle 迁移功能无影响；但同批次的迁移 SQL 与 _journal.json
亦是如此。建议二选一并保持统一：若团队要求文本文件以换行结尾，应为 drizzle 生成产物统一补齐（注意每次 drizzle-kit generate 会重新生成，需配套 lint
忽略或提交钩子，否则会产生无意义 diff 行）；否则保持现状即可。



─── server/drizzle.config.ts:3-3 ───
[bug · medium] TEST_DATABASE_URL 被置于 DATABASE_URL 之前,而 db:migrate 脚本通过 `bun --env-file=../.env
drizzle-kit migrate` 加载环境变量,且 reference/development.md 指导开发者为集成测试设置 TEST_DATABASE_URL。该变量一旦写入 .env 或残留于部署
shell,生产/开发迁移命令会静默改道测试库,造成"以为已迁移实则未迁移"的高危错配。建议至少在配置内对两者同时存在时给出显式警告,并在部署/生产迁移文档中明确要求 unset
TEST_DATABASE_URL。

  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
+ 
+ if (process.env.TEST_DATABASE_URL) {
+   console.warn(
+     "drizzle.config: TEST_DATABASE_URL is set and takes precedence over DATABASE_URL — " +
+       "migration commands will run against the test database. Unset it before migrating " +
+       "an application or production database.",
+   );
+ }


─── server/drizzle/0077_credit_reservations.sql:40-40 ───
[bug · medium] credit_reservations_settled_check 存在 NULL 语义漏洞:当 status='settled' 而
actual_numerator/actual_denominator/charged/applied/released 均为 NULL 时,正则与比较谓词求值为 NULL,`FALSE OR
NULL = NULL`,CHECK 对 NULL 视为通过,结算行可携带全空金额字段入库。应用层 credits-writer 的 settle 路径虽总是写入全部字段,但直接
SQL、手工修复或半提交场景将绕过该防护。建议对参与谓词的列显式加 IS NOT NULL。另外 actual_denominator 用 `!~ '^0+$'` 仅排除全零,允许
'01'、'007' 等前导零形态,与 credit_charge_remainders_shape_check 采用的 `^[1-9][0-9]*$` 严格度不一致,建议统一。

- CONSTRAINT "credit_reservations_settled_check" CHECK ("credit_reservations"."status" <> 'settled' OR ("credit_reservations"."actual_numerator" ~ '^[0-9]+$' AND "credit_reservations"."actual_denominator" ~ '^[0-9]+$' AND "credit_reservations"."actual_denominator" !~ '^0+$' AND "credit_reservations"."charged" >= 0 AND "credit_reservations"."applied" >= 0 AND "credit_reservations"."applied" <= "credit_reservations"."maximum" AND "credit_reservations"."released" = "credit_reservations"."maximum" - "credit_reservations"."applied"))
+ CONSTRAINT "credit_reservations_settled_check" CHECK ("credit_reservations"."status" <> 'settled' OR ("credit_reservations"."actual_numerator" IS NOT NULL AND "credit_reservations"."actual_numerator" ~ '^[0-9]+$' AND "credit_reservations"."actual_denominator" IS NOT NULL AND "credit_reservations"."actual_denominator" ~ '^[1-9][0-9]*$' AND "credit_reservations"."charged" >= 0 AND "credit_reservations"."applied" >= 0 AND "credit_reservations"."applied" <= "credit_reservations"."maximum" AND "credit_reservations"."released" = "credit_reservations"."maximum" - "credit_reservations"."applied"))


─── server/drizzle/0076_productive_nextwave.sql:0-0 ───
[other · low] deployment_scope 是"每个部署域仅一笔 pending 购买"不变量的分区键,但此处未设值域 CHECK 约束:任何字符串(包括拼写变体如
'dfeault' 或大小写差异)都会静默形成一个新的"每域一笔"分区,绕过全局单笔 pending 的意图。应用层目前以 store.ts 中的 DEPLOYMENT_SCOPE="default"
常量收敛,但数据库层无兜底。建议补充值域 CHECK(若采纳,需同步重新生成 meta snapshot 或以新迁移追加约束)。

  ALTER TABLE "payment_orders" ADD COLUMN "deployment_scope" text DEFAULT 'default' NOT NULL;
+ ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_deployment_scope_check" CHECK ("payment_orders"."deployment_scope" IN ('default'));


─── server/drizzle/0079_lying_yellowjacket.sql:5-5 ───
[other · low] 新增的 status 列既无 CHECK 值域约束,命名又与本表已有的投递状态 lago_status/credits_status
高度重叠,易被误读为交付状态(实际语义是用量产生时的运行状态,当前唯一写入值为 'succeeded')。同表的 source、lago_status、credits_status 均有 CHECK
兜底,建议为 status 收窄值域或改名(如 run_status)以消除歧义;若采纳需同步重新生成 meta snapshot 或追加新迁移。

  ALTER TABLE "usage_outbox" ADD COLUMN "status" text;
+ ALTER TABLE "usage_outbox" ADD CONSTRAINT "usage_outbox_status_check" CHECK ("usage_outbox"."status" IS NULL OR "usage_outbox"."status" IN ('succeeded'));


─── server/drizzle/0080_many_robin_chapel.sql:1-1 ───
[other · low] reservation_id 与 actual_cost_numerator/denominator 通过
usage_outbox_credit_identity_check 强制成对出现,但不指向任何外键:billing_customers 删除会级联删除
credit_reservations,outbox 行将残留指向不存在 reservation 的孤儿引用,后续按 reservation_id 对账/审计无法回溯。若 outbox
作为不可变投递事实有意不加 FK(避免级联影响),建议至少在 schema 注释中写明该取舍;否则建议补充 REFERENCES "credit_reservations"("id")(注意
immutableFields 含 reservationId,应采用 NO ACTION 而非 SET NULL)。

- ALTER TABLE "usage_outbox" ADD COLUMN "reservation_id" text;--> statement-breakpoint
+ ALTER TABLE "usage_outbox" ADD COLUMN "reservation_id" text REFERENCES "public"."credit_reservations"("id") ON DELETE no action ON UPDATE no action;


─── server/drizzle/0082_naive_nightshade.sql:2-4 ───
[bug · medium] 回填用 terminal_at 冒充 paid_at,对「过期/取消后迟到补付」的订单是错误的:这类行 terminal_at 记录的是过期/取消时刻,而钱实际到账发生在
terminal_at 之后的迟到窗口内。这与 payment.ts 中 paid_at 的契约(“paid_at records only the paid transition
itself”“invoice settlement time never has to guess whether a terminal timestamp means money
landed”)直接矛盾。下游 statements.ts 以 order.paidAt 作为 settledAt 出账,迟到补付的历史订单将把“过期时刻”当成“结算时刻”对外展示。而按
payment.ts 的设计,每次 paid CAS 成功都会在同一事务里插入 kind='fact'/state='paid' 的 payment_events,其 created_at
才是钱到账的准确时刻。建议回填时优先取该 fact 事件时间,取不到(早于 events 表存在的极老订单)再退回 terminal_at。

  UPDATE "payment_orders"
- SET "paid_at" = "terminal_at"
- WHERE "status" = 'paid' AND "paid_at" IS NULL;--> statement-breakpoint
+ SET "paid_at" = COALESCE((
+   SELECT "pe"."created_at"
+   FROM "payment_events" AS "pe"
+   WHERE "pe"."order_id" = "payment_orders"."id"
+     AND "pe"."kind" = 'fact' AND "pe"."state" = 'paid'
+   ORDER BY "pe"."created_at" ASC
+   LIMIT 1
+ ), "payment_orders"."terminal_at")
+ WHERE "status" = 'paid' AND "paid_at" IS NULL;


─── server/drizzle/0077_credit_reservations.sql:40-40 ───
[bug · low] 结算守卫只覆盖 status='settled',而 status='released' 的行完全没有金额约束:应用层 releaseReservation 的契约是
applied=0、released=maximum、release_reason 必填,但直接 SQL、手工修复或半提交场景可以写入金额字段为 NULL(或任意值)的 released 行;读取侧
`reservation.released ?? 0` 会静默把已归还的额度报成 0,审计/对账无法发现。注意建议中的谓词必须显式 IS NOT NULL——否则会复现已确认的
settled_check 同款 NULL 直通漏洞(NULL 相等比较求值为 NULL,CHECK 视为通过)。若采纳,因该批迁移尚未部署,可就地修改 0077 并同步重新生成 meta
snapshot。

- CONSTRAINT "credit_reservations_settled_check" CHECK ("credit_reservations"."status" <> 'settled' OR ("credit_reservations"."actual_numerator" ~ '^[0-9]+$' AND "credit_reservations"."actual_denominator" ~ '^[0-9]+$' AND "credit_reservations"."actual_denominator" !~ '^0+$' AND "credit_reservations"."charged" >= 0 AND "credit_reservations"."applied" >= 0 AND "credit_reservations"."applied" <= "credit_reservations"."maximum" AND "credit_reservations"."released" = "credit_reservations"."maximum" - "credit_reservations"."applied"))
+ CONSTRAINT "credit_reservations_released_check" CHECK ("credit_reservations"."status" <> 'released' OR ("credit_reservations"."applied" IS NOT NULL AND "credit_reservations"."applied" = 0 AND "credit_reservations"."released" IS NOT NULL AND "credit_reservations"."released" = "credit_reservations"."maximum" AND "credit_reservations"."release_reason" IS NOT NULL))


─── server/drizzle/0077_credit_reservations.sql:6-6 ───
[maintainability · low] schema 注释声明 credit_charge_remainders 携带的小数“always in [0, 1) and in lowest
terms”,但本 CHECK 只校验了数字形状:分子 >= 分母(即余数 >= 1 个缩放单位)同样能入库,残留错误会在下一次结算时被累入 charged,静默多扣费。在同一约束内追加数值比较即可把
[0,1) 下界落到数据库层(两侧已有纯数字正则,::numeric 转换不会失败);最简分数无法廉价地在 SQL 校验,可留给应用层。

- CONSTRAINT "credit_charge_remainders_shape_check" CHECK ("credit_charge_remainders"."numerator" ~ '^[0-9]+$' AND "credit_charge_remainders"."denominator" ~ '^[1-9][0-9]*$')
+ CONSTRAINT "credit_charge_remainders_shape_check" CHECK ("credit_charge_remainders"."numerator" ~ '^[0-9]+$' AND "credit_charge_remainders"."denominator" ~ '^[1-9][0-9]*$' AND "credit_charge_remainders"."numerator"::numeric < "credit_charge_remainders"."denominator"::numeric)


─── server/drizzle/meta/0077_snapshot.json:0-0 ───
[style · low] 快照文件末尾缺少换行符（\ No newline at end of file）。这是 drizzle-kit 生成 JSON 快照的默认输出格式，同批
_journal.json 及其他 0075–0082 快照文件均具有相同特征，无功能影响；但若仓库后续引入 editorconfig/CI 的末行换行检查，该类生成文件每次重新生成都会产生全文件级
diff 噪音。建议团队确认 EOL 策略：如需强制末行换行，可通过生成后格式化钩子统一处理。



─── server/src/billing/credits-writer.ts:683-688 ───
[bug · medium] 过期预留会永久占用客户额度:held 子查询只按 status='reserved' 过滤,不检查 expires_at;reserveCredits 也不拒绝已过去的
expiresAt;releaseReservation 仅在 finish/fail 回调触发(index.ts 两处),进程在 reserve 之后、回调之前崩溃时预留即悬挂,唯一出口是
reconcile 的只读上报(注释明确不做自动释放)。结果是过期的 hold 让 availableBalance 无限期偏小,直到人工介入。建议让过期的 hold 从容量计算中消失(子查询加
`and r.expires_at > now()`),settle 侧已有 remainingGrantCapacity 检查不会因此超卖;或接线一个过期释放清扫。同时 reserveCredits
宜校验 expiresAt 在未来。

        held: sql<number>`coalesce((
          select sum(a.amount)::int
          from credit_reservation_allocations a
          join credit_reservations r on r.id = a.reservation_id
-         where a.grant_id = credit_grants.id and r.status = 'reserved'
+         where a.grant_id = credit_grants.id
+           and r.status = 'reserved'
+           and r.expires_at > now()
        ), 0)`,


─── server/src/billing/credits-writer.ts:313-320 ───
[bug · medium] 幂等查重发生在 lockCustomer 之后,但锁只串行化同一客户:两个不同客户并发提交同一 idempotencyKey 时都会通过查重,输家在 commit 时撞上
credit_reservations_idempotency_key_unique_idx,以原始数据库错误(DrizzleQueryError 包装 23505)抛出——既不是 docstring
承诺的 CreditReservationConflictError,也丢失了"replay 应返回原预留"的语义,调用方拿到的是非类型化错误。建议捕获该唯一键冲突并映射为
CreditReservationConflictError(或重读已有行按命中重放)。

          const reservationId = `cr-${randomBytes(8).toString("hex")}`;
+         try {
-         await tx.insert(creditReservations).values({
+           await tx.insert(creditReservations).values({
-           id: reservationId,
+             id: reservationId,
-           externalCustomerId: input.externalCustomerId,
+             externalCustomerId: input.externalCustomerId,
-           idempotencyKey: input.idempotencyKey,
+             idempotencyKey: input.idempotencyKey,
-           maximum: input.maximumCents,
+             maximum: input.maximumCents,
-           expiresAt: input.expiresAt,
+             expiresAt: input.expiresAt,
-         });
+           });
+         } catch (error) {
+           // 23505 here means a concurrent cross-customer replay won the insert race.
+           if (
+             error instanceof Bun.SQL.PostgresError &&
+             (error.errno === "23505" || error.code === "23505")
+           ) {
+             throw new CreditReservationConflictError(
+               "reserveCredits: the idempotency key belongs to a different reservation.",
+             );
+           }
+           throw error;
+         }


─── server/src/billing/credits-writer.ts:262-268 ───
[maintainability · low] readBalance 与 availableBalance 实现完全相同,而 readBalance 在生产代码中已无调用方(预扣门已改走
reserveCredits),仅剩测试引用。两个同名异实的公共方法并存会让后续维护者误以为语义有差别。建议保留 availableBalance,删除 readBalance 或在
docstring 中明确其为别名,并迁移测试。



─── server/src/billing/reconcile.ts:219-225 ───
[performance · low] 计划额度审计把 source='plan' 的全部 credit_grants 一次性载入内存构建
Map,行数随付费订单线性增长,对账的内存与耗时无上界——与同文件中 usage 扫描一律带 LIMIT 的做法不一致。建议改为按 paidOrders 推导出的 key 集合过滤查询(如
inArray 分批),或用数据库端 join 聚合。

-         const planGrants = await database
+         const planKeys = paidOrders
+           .map((order) => `plan:${order.id}`)
+           .filter((key) => {
+             const expected = expectedPlanCredits(
+               paidOrders.find((order) => `plan:${order.id}` === key)!.planCode,
+             );
+             return expected !== null && expected > 0;
+           });
+         const planGrants = planKeys.length
+           ? await database
-           .select({
+               .select({
-             idempotencyKey: creditGrants.idempotencyKey,
+                 idempotencyKey: creditGrants.idempotencyKey,
-             total: creditGrants.total,
+                 total: creditGrants.total,
-           })
+               })
-           .from(creditGrants)
+               .from(creditGrants)
-           .where(eq(creditGrants.source, "plan"));
+               .where(
+                 and(
+                   eq(creditGrants.source, "plan"),
+                   inArray(creditGrants.idempotencyKey, planKeys),
+                 ),
+               )
+           : [];


─── server/src/billing/statements.ts:58-65 ───
[security · low] scope 是订单读取的租户隔离(deployment_scope/createdBy 过滤),这里却设计为可选参数;payments/store.ts 的
ownerScopeCondition 在 scope 为 undefined 时返回 undefined(不过滤)。当前 routes.ts 两处都传了
billingReadScopeOf,但任何未来调用点漏传 scope 都会静默退化为读取全部订单的 fail-open。建议将 scope 设为必填,让遗漏成为编译错误。

    invoices(
      window: StatementWindow,
-     scope?: PaymentOrderReadScope,
+     scope: PaymentOrderReadScope,
    ): Promise<BillingInvoicePage>;
    invoice(
      id: string,
-     scope?: PaymentOrderReadScope,
+     scope: PaymentOrderReadScope,
    ): Promise<BillingInvoiceDetail | null>;


─── server/src/billing/store.ts:45-49 ───
[bug · low] 当 PostgresError 的 errno 不是 5 位 SQLSTATE 且 code 属性缺失(为 undefined)时,sqlState 为
undefined,sqlState.startsWith 会抛出 TypeError——把"判断是否可重试"变成一个新的异常,掩盖原始错误。建议对 sqlState 兜底为空字符串。

      const sqlState =
        typeof error.errno === "string" && /^[0-9A-Z]{5}$/.test(error.errno)
          ? error.errno
-         : error.code;
+         : (error.code ?? "");
      return sqlState.startsWith("08") || RETRYABLE_POSTGRES_CODES.has(sqlState);


─── server/src/billing/maintenance.ts:6-6 ───
[documentation · low] 此注释已过时:index.ts 的装配处已在 billing 与 usage-outbox 就绪时调用
startUsageDeliverySweeps(usage-delivery 目标已组装完毕),sweeper 已接入生产路径。保留"尚未接线"的说法会误导读者排查定时任务的来源。

-  * Nothing starts this in production yet: it waits for the delivery targets to be assembled.
+  * index.ts starts this once both the billing seam and the usage outbox are assembled.


─── server/src/billing/maintenance.ts:54-56 ───
[style · low] timers 数组同时存放 setTimeout 与 setInterval 句柄,stop() 统一用 clearTimeout 清理。Node/Bun
下二者互通、功能可行,但语义上 interval 应配 clearInterval,混用会让读者误判句柄类型。建议分开清理或统一改用 clearInterval。

      stop: () => {
-       for (const timer of timers) clearTimeout(timer);
+       for (const timer of timers) {
+         clearTimeout(timer);
+         clearInterval(timer);
+       }
      },


─── server/src/billing/payments/service.ts:455-465 ───
[bug · high] 被删除的 B3/P2-3 注释明确修复过"终态 blocked 订单的 strike 行无限增长"：旧代码先判断 order.status === "blocked"
直接静默应答、不再落任何行。本变更把异常记录移到了终态检查之前，而 amount_unreadable 恰是 0074 迁移中
payment_events_anomaly_unique_idx（... WHERE kind='anomaly' AND code <> 'amount_unreadable'）唯一排除的
code——已 blocked 的订单每收到一次无金额重投都会新增一行异常；同时该裁决现在映射为 routes 的 fail(409)，渠道会按重试策略持续重发（store 注释自述 Alipay 对
409 最多重试 8 次）。两个变化叠加，恰好复活了旧注释要消灭的"为 nobody 无限增长的尾巴"。建议把 blocked 终态检查移回记录之前。

+       if (order.status === "blocked") {
+         // Terminal verdict stands: no new strike row for a dead order.
+         return { kind: "refused", reason: "blocked" };
+       }
        const recorded = await recordAnomalyQuietly({
          orderId: order.id,
          code: "amount_unreadable",
          channelTransactionId: fact.channelTransactionId ?? null,
          amountCents: null,
          detail: "paid fact carried no comparable amount",
        });
        if (!recorded) return { kind: "retryable-failure" };
-       if (order.status === "blocked") {
-         return { kind: "refused", reason: "blocked" };
-       }


─── server/src/billing/payments/service.ts:698-700 ───
[security · medium] 部署级 pending 唯一之后，这段重放会把"任何创建者"的待支付订单原样交回：toView 对 pending 单暴露 checkout 二维码
payload，任意登录用户用相同 plan+provider 请求即可拿到他人订单的付款码并付款；跨计划请求则收到携带 pendingPlanCode 的 409。而同一变更把
/purchases/current、/purchases/:id 收紧为严格按 actor 过滤（billingReadScopeOf 无条件返回
actorId、无管理员旁路），创建路径却完全不过滤——两者隔离语义相互矛盾。若"部署内共享付款码"是预期语义，请补注释明确；否则重放与冲突分支应按 createdBy 过滤。

          if (pending.provider === input.provider) {
+           // Pending orders are actor-visible only, matching the read routes' scoping.
+           if (pending.createdBy && pending.createdBy !== input.createdBy) {
+             throw new PurchaseError({
+               reason: "pending-purchase",
+               pendingPlanCode: pending.planCode,
+             });
+           }
            return { order: toView(pending) };
          }


─── server/src/billing/payments/service.ts:745-750 ───
[bug · medium] 唯一约束从 (plan, provider) 收紧到部署级后，"订单先建、会话后开"的失败代价被放大：下方 createSession 重试耗尽抛错时，刚插入的
pending 订单（checkoutPayload 为 null）会占住整个部署唯一的购买槽位直到 TTL 过期清扫；期间其他计划的购买全部收到 pending-purchase
409，而同计划重试只会命中 replay 快路径返回 checkout 为 null 的视图、并不会补开会话，用户同样拿不到二维码。旧 pair 粒度下至少其他 (plan, provider)
组合仍可购买。建议会话最终失败时取消该订单释放槽位（此时还没有任何渠道侧凭证，取消不产生账目歧义），或允许 replay 路径为无 payload 的 pending 单补开一次会话。



─── server/src/billing/payments/service.ts:381-389 ───
[performance · medium] "duplicate" 裁决不在订单上落任何持久状态：重复单的 activationState 仍停在 "pending"，而
listPaidPendingActivationOrders 选取 status='paid' 且 activation_state IN ('pending','failed')。因此
sweepActivations 每个周期都会重新选中该重复单、再次执行 resolveActivationOwnership 的 FOR UPDATE 行锁事务重判一遍（duplicate_paid
证据行因去重索引只写一次，但查询与锁开销每轮都在）。建议为重复单持久化一个可识别的终态，或在清扫查询中排除已确认重复的订单，让归属判定对每个订单只做一次。注意：若复用 "failed"，需同步调整
sweepActivations 的 activationStrikes 告警逻辑，避免对重复单误报 activation_retry_exhausted。



─── server/src/billing/payments/service.ts:71-73 ───
[style · low] 三层嵌套三元表达式违反编码规范（禁止嵌套三元），后续新增 refusal 原因时也容易放错层级。建议改为映射表。

-           : refusal.reason === "pending-purchase"
-             ? "Another purchase is already pending for this deployment."
-             : "This deployment already has an active subscription.",
+ // 模块级：
+ const REFUSAL_MESSAGES: Record<PurchaseRefusal["reason"], string> = {
+   "unknown-plan": "That plan is not purchasable here.",
+   "unknown-provider": "That channel is not configured on this deployment.",
+   "pending-purchase": "Another purchase is already pending for this deployment.",
+   "active-subscription": "This deployment already has an active subscription.",
+ };
+ // 构造函数内：
+ super(REFUSAL_MESSAGES[refusal.reason]);


─── server/src/billing/payments/store.ts:82-88 ───
[bug · low] 与 rowOf 使用 order.currency 的写法不一致：锁定查询的 SQL 已选出 currency（PaymentOrderLockedRow
里也声明了），这里却硬编码 "CNY"，且行内 deploymentScope 选出后从未使用。一旦币种约束放开，行锁路径会静默给订单错标币种。建议使用 row.currency，与 rowOf
保持一致。

  function lockedRowOf(row: PaymentOrderLockedRow): PaymentOrderRecord {
    return {
      id: row.id,
      planCode: row.planCode,
      provider: row.provider,
      amountCents: row.amountCents,
-     currency: "CNY",
+     currency: row.currency,


─── server/src/billing/payments/store.ts:195-201 ───
[maintainability · low] errno 在部分驱动中是数值类型，(errno ?? code) === "23505" 的严格字符串比较一旦 errno
存在即失配——主键冲突会被当作真实错误抛出（下单 500）而非重绘 id。当前项目使用 bun-sql 驱动（错误码落在 code
字符串上）暂不触发，但这段混合两种驱动字段的写法比较脆弱；建议统一字符串化后比较。

+       const sqlState = String(postgresError.errno ?? postgresError.code);
        if (
-         (postgresError.errno ?? postgresError.code) === "23505" &&
+         sqlState === "23505" &&
          (postgresError.constraint ?? postgresError.constraint_name) ===
            "payment_orders_pkey"
        ) {
          return true;
        }


─── server/src/billing/credits-writer.ts:292-302 ───
[bug · high] 幂等回放分支只比对 externalCustomerId 与 maximum,不检查 existing.status。当原预留已到达终态(如 fail/finish
回调已调用 releaseReservation,或已 settle)时,这里仍返回 reserved: true,调用方会据此放行实际工作——但此时没有任何容量被持有(容量门被完全绕过),随后
settleReservation 又必然抛 CreditReservationConflictError,导致这次工作永远无法计费。即:重放已释放预留的 key 可以无上限地免费使用算力,直接破坏
reserveCredits 作为 admission authority 的硬顶保证。建议对终态预留显式拒绝:抛 CreditReservationConflictError(与 settle 对
released 的处理一致),或返回 { reserved: false } 让调用方重新走容量判定。

          if (existing) {
            if (
              existing.externalCustomerId !== input.externalCustomerId ||
              existing.maximum !== input.maximumCents
            ) {
              throw new CreditReservationConflictError(
                "reserveCredits: the idempotency key belongs to a different reservation.",
+             );
+           }
+           if (existing.status !== "reserved") {
+             // A terminal hold carries no capacity; answering reserved would admit
+             // work the gate never priced and settle could never charge.
+             throw new CreditReservationConflictError(
+               `reserveCredits: the reservation for this idempotency key is ${existing.status}.`,
              );
            }
            return { reserved: true as const, reservationId: existing.id };
          }


─── server/src/billing/credits-writer.ts:455-459 ───
[bug · low] ledger 的 grantId 归属取 `allocations.find((a) => a.amount > 0)?.grantId`,即"第一个持有量大于 0 的
allocation",而非"第一个实际发生扣减(drew > 0)的 grant"。当排在前面的 grant 因预留之外的旧消费已无余量时(drew=0),费用实际记在后面的 grant
上,这里却归到前者;charged=0(整笔落在 remainder)时 applied=0 也会挂上一个从未被扣减的 grant。consumeCredits 对同一列的约定是只在真正扣减时记录
firstGrantId(见下方 draw 循环),两处写法不一致会误导按 grant 维度追账的排查。建议在扣减循环中记录首个 drew > 0 的 grantId 再写入 ledger。

+         let firstGrantId: string | null = null;
+         for (const allocation of allocations) {
+           ...
+           if (drew > 0) {
+             if (firstGrantId === null) firstGrantId = allocation.grantId;
+             ...
+           }
+           ...
+         }
+ 
          const ledgerId = `cl-${randomBytes(8).toString("hex")}`;
          await tx.insert(ledger).values({
            id: ledgerId,
            externalCustomerId: reservation.externalCustomerId,
-           grantId: allocations.find((a) => a.amount > 0)?.grantId ?? null,
+           grantId: firstGrantId,


─── server/src/billing/payments/service.ts:628-629 ───
[maintainability · medium] 本次删除的 `readLatestPaidOrder` 跨订单重复检查是该 store 方法在全代码库（src 与
tests）中的唯一调用点。删除后 `store.readLatestPaidOrder`（store.ts）与 `PaymentStore`
接口中的声明（types.ts）成为无任何调用方的死代码，且其实现内部的大段注释（"The duplicate check runs AFTER the caller's own
confirm…pinned by
qa-batch1-duplicate-paid.integration.test.ts"）仍在描述这个已被删除的调用方行为，会误导后续维护者。建议将该方法与接口声明一并移除（listOrdersIn
Window 处引用其注释的交叉引用也需同步调整）；若有意保留该 seam 供测试使用，请补充说明，但目前没有任何测试引用它。

+     const fresh = await deps.store.readOrder(order.id).catch(() => null);
      if (fresh) await activateOrder(fresh);
      return { kind: "claimed" };
+     // （同时从 store.ts 删除 readLatestPaidOrder 实现，并从 types.ts 的 PaymentStore 中移除其声明）


─── server/src/billing/payments/service.ts:629-629 ───
[documentation · low] 上方第 620–626 行的多行注释（"A cross-order duplicate is worth one more look on EVERY
confirm… the anomaly is what makes it visible to reconciliation instead of hiding inside a
second"）是本次删除 `readLatestPaidOrder` 检查后遗留的孤儿注释：它描述的代码已不存在、句子在 "a second" 处被截断，且仍在宣称存在 per-(plan,
provider) 的 pending-pair 索引——这正是本次变更加以替换的旧约束。现在跨订单重复的判定已移入 activateOrder →
resolveActivationOwnership，注释应删除或改写为指向新的所有权判定路径，否则会与实际行为矛盾。

+     // 跨订单重复的判定已由 activateOrder → resolveActivationOwnership 在行锁下完成并落
+     // duplicate_paid 证据；此处只需重读订单并尝试激活。
+     const fresh = await deps.store.readOrder(order.id).catch(() => null);
+     if (fresh) await activateOrder(fresh);
      return { kind: "claimed" };


─── server/src/billing/payments/store.ts:556-560 ───
[maintainability · low] 这里用原生 SQL 加手写的 PaymentOrderLockedRow 类型与 lockedRowOf 映射函数，完整复制了 rowOf
已有的行→记录转换逻辑。手抄副本已经出现漂移（currency 被硬编码为 "CNY"、deploymentScope 选出后未使用）。项目使用的 drizzle-orm 0.45 支持在类型化
select 上直接调用 `.for("update")`，改用 drizzle 查询即可复用 rowOf、删除这约 55 行易漂移的重复映射，参数化同样由 drizzle 处理。

-         const locked = await tx.execute(sql`
-           select
-             "id",
-             "deployment_scope" as "deploymentScope",
-             "plan_code" as "planCode",
+         const lockedOrders = (
+           await tx
+             .select()
+             .from(paymentOrders)
+             .where(
+               and(
+                 eq(paymentOrders.deploymentScope, anchor.deploymentScope),
+                 eq(paymentOrders.planCode, anchor.planCode),
+                 eq(paymentOrders.status, "paid"),
+                 isNotNull(paymentOrders.periodStart),
+                 isNotNull(paymentOrders.periodEnd),
+                 lt(paymentOrders.periodStart, anchor.periodEnd),
+                 gt(paymentOrders.periodEnd, anchor.periodStart),
+               ),
+             )
+             .orderBy(
+               asc(paymentOrders.periodStart),
+               asc(paymentOrders.createdAt),
+               asc(paymentOrders.id),
+             )
+             .for("update")
+         ).map(rowOf);


─── server/src/billing/payments/routes.ts:32-32 ───
[maintainability · low] payments 子模块从这里向上反向依赖父级 billing 的 HTTP 聚合文件（../routes.ts），只为取一个 3
行的辅助函数。这把子模块的 HTTP 层耦合到父模块的路由文件上（billing/routes.ts 自身反而只向下依赖 payments/types），方向颠倒且日后
billing/routes.ts 一旦反向引用 payments 路由即成环。建议把 billingReadScopeOf 移到 PaymentOrderReadScope
旁边（payments/types.ts）或其他共享模块，让两个路由文件都从下层导入。

- import { billingReadScopeOf } from "../routes";
+ import { billingReadScopeOf } from "../read-scope";


─── server/src/billing/usage-delivery.ts:33-36 ───
[maintainability · low] workshop/metering.ts 导出的 CODE_RUN_METRIC("code_run_tokens")注释明确写着 "one
constant so both sides agree",但本文件用字符串字面量重复定义了同一业务常量("llm_tokens"
同样没有共享常量)。任一侧修改而另一侧遗漏,会造成指标代码漂移、Lago 侧计量对不上。建议从 metering.ts 导入 CODE_RUN_METRIC,或将两个 metric code 下沉为
billing 侧共享常量(由 metering 反向引用),保持单一事实来源。

+ import { CODE_RUN_METRIC } from "../workshop/metering";
+ 
  const METRIC_BY_SOURCE = {
    llm: "llm_tokens",
-   code_run: "code_run_tokens",
+   code_run: CODE_RUN_METRIC,
  } as const;


─── server/src/billing/usage-delivery.ts:176-184 ───
[maintainability · medium] recordDeliveryFailure 只把行保持 pending 并刷新 updated_at:usage_outbox 表(0075
迁移)没有 attempts 计数或退避列,投递侧也没有上限逻辑。一条因持续性失败(如 provider 始终拒绝该 payload、external_customer_id 不存在等)的记录会被每
30s 的 sweep 无限期重试,永远不进入终态,也没有告警升级路径。失败虽会因 updated_at 刷新排到队尾(不会饿死其他记录),但失败调用和 warn 日志会永久持续。建议为 outbox
增加 attempts 列,超过阈值后走 blockDelivery 进入可人工排查的终态,或基于失败时间做退避。



─── server/src/billing/usage-delivery.ts:170-175 ───
[maintainability · low] metering.ts 的 reportCodeRunUsage 写入的 code_run 记录从不携带
reservationId/actualCost 事实,因此每条 code_run 事件在 credits 目标上必然抛 missing_reservation 并走到这条 warn 日志 +
block 写入——一个确定性的预期结果被当作投递失败处理,每次 code run 都会产生一条 "usage delivery failed"
告警噪声,稀释该日志对真正意外失败的告警价值。建议对预期的 missing_reservation 降级日志级别(或按 source/事实预判 credits 目标不适用),把 warn
留给真正意外失败。



─── server/src/billing/usage-delivery.ts:191-192 ───
[bug · low] allDelivered 只反映本次被尝试的目标:当记录的另一个目标已处于 blocked 状态(被上方 continue 跳过)时,本目标投递成功后该记录仍被计入
delivered。delivered 的实际语义是"本轮无失败"而非"所有目标已投递",监控/对账口径会偏乐观——一条 credits 被永久 block 的记录也会贡献 delivered
计数。建议仅当所有目标均为 delivered 时才计入 delivered,或为 blocked 单列计数。

+         const fullyDelivered = targets.every(
+           (t) => !t.pending && t.name !== "credits" || true,
+         );
          if (effectFailed) result.failed += 1;
-         else if (allDelivered) result.delivered += 1;
+         else if (allDelivered && fullyDelivered) result.delivered += 1;


─── server/src/workshop/metering.ts:146-146 ───
[maintainability · low] "web" 是业务归因标签的字面量硬编码,且与 LLM 路径(index.ts 中 outbox.record 同样写死 client:
"web")重复定义。code run 当前仅从 workshop 网页入口发起尚可接受,但未来若出现其他客户端入口(如 API),用量归因将恒为 "web",影响下游账单归因与审计。建议提取为与
LLM 路径共享的常量,或从调用入口透传真实客户端标识。

-     client: "web",
+     client: METERED_CLIENT,


─── server/src/db/schema/credit-reservations.ts:71-74 ───
[bug · medium] SQL 中对 NULL 的比较结果为 NULL,而 CHECK 约束对 NULL 视为通过。此 check 的后半段 AND 链(含 charged >=
0、applied <= maximum、released = maximum - applied)在
charged/applied/released/actual_numerator/actual_denominator 任一列为 NULL 时整体为 NULL,于是 "settled
行必含完整结算事实且 released = maximum - applied" 的不变量可被 NULL 绕过:status='settled'
且这些列全空的行会顺利落库。应用层结算路径(credits-writer.ts settleReservation)目前在同一事务单条 UPDATE
中原子写入,不会触发,但该约束作为数据库事实的兜底即告失效;且重放路径 settledResultOf 会把 NULL 默认为 0,静默返回 0 费用结果。建议在 settled
分支为各可空列显式断言 IS NOT NULL(置于比较之前),并同步修改迁移 0077 中同名 check 表达式,避免 TS schema 与实际 DDL 漂移。

      check(
        "credit_reservations_settled_check",
-       sql`${table.status} <> 'settled' OR (${table.actualNumerator} ~ '^[0-9]+$' AND ${table.actualDenominator} ~ '^[0-9]+$' AND ${table.actualDenominator} !~ '^0+$' AND ${table.charged} >= 0 AND ${table.applied} >= 0 AND ${table.applied} <= ${table.maximum} AND ${table.released} = ${table.maximum} - ${table.applied})`,
+       sql`${table.status} <> 'settled' OR (${table.actualNumerator} IS NOT NULL AND ${table.actualNumerator} ~ '^[0-9]+$' AND ${table.actualDenominator} IS NOT NULL AND ${table.actualDenominator} ~ '^[0-9]+$' AND ${table.actualDenominator} !~ '^0+$' AND ${table.charged} IS NOT NULL AND ${table.charged} >= 0 AND ${table.applied} IS NOT NULL AND ${table.applied} >= 0 AND ${table.applied} <= ${table.maximum} AND ${table.released} IS NOT NULL AND ${table.released} = ${table.maximum} - ${table.applied})`,
      ),


─── server/src/db/schema/usage-outbox.ts:20-20 ───
[documentation · low] 同组的 credit_reservations / credit_reservation_allocations 对 billingCustomers /
creditLedger 均配置外键与级联删除,而 usage_outbox 的 external_customer_id 与下方的 reservation_id 为裸 text、无外键;配套的
maintenance.ts
只做投递扫描,没有孤儿行清理或校验逻辑补偿。客户或预留被删除后,未投递/已投递的用量事实行会永久残留,影响对账与统计口径。若这是刻意的解耦设计(发件箱行需在引用行删除后仍保留,以支撑独立重试与审计),
建议在此加注释说明设计意图,避免被误判为遗漏;否则应补充外键或对应的孤儿行处理策略。



─── server/src/billing/usage-outbox.ts:199-203 ───
[maintainability · low] lago/credits 两个目标的三元分支在 markDelivered、recordDeliveryFailure、blockDelivery
三个函数里逐字复制(set 对象、where 条件里的列选择各重复 3 遍),且 "rows.length === 0 → 回查 → 抛 UsageOutboxRecordNotFoundError"
的收尾块在 recordDeliveryFailure 和 blockDelivery 中原样出现两次。新增第三个目标或新增一列(比如 attempts)时需要同步改 6 处,极易漏改。建议提取一个
{lago, credits} 的列映射(status/lastErrorCode 列)加共享的 set 构造器和 not-found 断言辅助函数;顺带可让本文件的 "lago" |
"credits" 联合类型与 usage-delivery.ts 的 UsageDeliveryTarget 统一为单一来源。

-   async function blockDelivery(
-     eventId: string,
-     target: "lago" | "credits",
-     failureCode: string,
-   ) {
+   const TARGET_COLUMNS = {
+     lago: {
+       status: usageOutbox.lagoStatus,
+       lastErrorCode: usageOutbox.lagoLastErrorCode,
+     },
+     credits: {
+       status: usageOutbox.creditsStatus,
+       lastErrorCode: usageOutbox.creditsLastErrorCode,
+     },
+   } as const;
+ 
+   async function deliveredSet(target: UsageDeliveryTarget) {
+     const columns = TARGET_COLUMNS[target];
+     return {
+       [columns.status.name]: "delivered" satisfies UsageOutboxDeliveryStatus,
+       [columns.lastErrorCode.name]: null,
+       updatedAt: new Date(),
+     };
+   }
+ 
+   async function assertRowExists(eventId: string) {
+     const [record] = await database
+       .select({ eventId: usageOutbox.eventId })
+       .from(usageOutbox)
+       .where(eq(usageOutbox.eventId, eventId))
+       .limit(1);
+     if (!record) throw new UsageOutboxRecordNotFoundError(eventId);
+   }


─── server/src/workshop/metering.ts:6-7 ───
[documentation · low] docstring 承诺 "a double report records identical immutable facts(重复上报即幂等
no-op)",但该承诺有一个未声明的前提:occurredAt 在 immutableFields 冲突比对之内,而生产结算点(codesandbox/gateway.ts 的两个 settle
处)是现场 `new Date()`,并非取自已持久化的 finishedAt。今天的接线里同一 run 只会结算一次所以不触发;一旦未来加入真正的重放/补偿路径(例如 reconcile
增加修复模式按 run 重报),第二次上报的 occurredAt 必然不同,得到的是 UsageOutboxConflictError——经 index.ts 的 reporter 会被记成
usage-outbox 写失败(看起来像数据丢失、需对账排查),而非这里承诺的静默 no-op。建议在 CodeRunUsageInput 或本注释中明确 occurredAt
必须传已持久化的完成时间(而非新的 Date),把幂等前提写清楚。

   * event id and transaction id are both `code-run:<runId>`, so a double report records identical
-  * immutable facts in the usage outbox and the delivery worker settles it once downstream.
+  * immutable facts in the usage outbox and the delivery worker settles it once downstream. This
+  * holds only while `occurredAt` is the run's persisted finishedAt — a fresh `new Date()` per
+  * settle would fail the immutable-facts comparison and surface as a spurious outbox conflict.


─── server/src/db/schema/credit-reservations.ts:75-77 ───
[bug · low] 本文件把终态事实当作数据库级不变量来设计(注释明确说 settled/released 一次性写入且"使 settle/release 的重放能返回第一次结果"),但
released 终态没有任何事实约束:settled 有 credit_reservations_settled_check,而 released 行的 applied/released 可以为
NULL 或任意值(如 applied=5、released=NULL 也合法)。releaseReservation 的重放只看 status
短路返回,一旦未来写入路径遗漏事实字段,重放/审计口径将被静默破坏。注意新增约束必须 NULL-safe(NULL 比较结果为 NULL 会被 CHECK 视为通过,与已确认的 settled
check 问题同源),用 IS NOT NULL 先行断言。

+     check(
+       "credit_reservations_released_check",
+       sql`${table.status} <> 'released' OR (${table.applied} IS NOT NULL AND ${table.applied} = 0 AND ${table.released} IS NOT NULL AND ${table.released} = ${table.maximum})`,
+     ),
      uniqueIndex("credit_reservations_idempotency_key_unique_idx").on(
        table.idempotencyKey,
      ),


─── server/src/db/schema/payment.ts:62-62 ───
[bug · low] paid_at 的文档注释承诺了精确不变量:"只记录 paid 这次迁移本身,所有非 paid 行保持 NULL",statements.ts 也直接用 paidAt
生成账单的 settledAt;但约束列表里没有对应 CHECK 把它与 status 绑定(同组的 activation_state/status 都有
CHECK,credit_reservations 的 terminal_at 也以同样形状的 credit_reservations_terminal_check
固化为数据库事实)。未来任何写路径把 canceled/expired 行误写 paid_at(或 paid 行漏写)都会直接污染账单结算时间且无库层防线。该约束是 NULL-safe
的(status='paid' AND paid_at IS NOT NULL / status<>'paid' AND paid_at IS NULL 都是确定性判断),且迁移 0082
的回填已保证存量数据满足它。

      paidAt: timestamp("paid_at", { withTimezone: true }),
+     // …并在 (table) => [ … ] 约束数组中补充:
+     check(
+       "payment_orders_paid_at_check",
+       sql`(${table.status} = 'paid' AND ${table.paidAt} IS NOT NULL) OR (${table.status} <> 'paid' AND ${table.paidAt} IS NULL)`,
+     ),


─── server/src/db/schema/usage-outbox.ts:34-34 ───
[maintainability · low] status 是一个完全裸的 text 列:无 $type、无 CHECK、无注释,与同表的
lagoStatus/creditsStatus(有联合类型和 CHECK)形成对比,极易让读者误以为它也是投递状态。实际它只由 code_run 路径写入,是 sandbox
网关的业务终态透传(gateway 中取值是闭集 completed/failed/timeout/refused),并经 usage-delivery 原样进入 Lago 计量
properties;且它参与 immutable 事实比对,是计费重放的承重字段。建议收窄类型或加 CHECK 并注明用途,避免无界字符串流入计费事实。

-     status: text("status"),
+     /** code run 的业务终态(闭集),透传给 Lago properties;与 lago/credits 投递状态无关。 */
+     status: text("status").$type<
+       "completed" | "failed" | "timeout" | "refused"
+     >(),


─── server/src/codesandbox/client.ts:130-132 ───
[other · high] enforceableTokenBudget 被静态硬编码为 false，且全库不存在任何配置项、环境变量或沙箱能力探测能将其置为
true（仅测试假客户端会构造该字段）。结合 gateway.ts 的 billingBlocked 门控（billingEnabled && client &&
!enforceableTokenBudget）以及 index.ts 中 billingEnabled = billing !== undefined 的装配，任何配置了计费的部署都将在 run 与
startStreaming 两条路径上 100% 拒绝代码运行——本 PR 搭建的整套计费管道上线即永久关闭 run_code/工作台这一核心功能，且没有切换开关。fail-closed
拒绝本身符合「pre-call provider
bounds」的验收意图（测试也断言了该行为），但必须给出后续启用机制：建议将该能力位接入部署配置（如环境变量并在启动时校验）或对沙箱代理做能力协商，否则至少需要在部署文档中明确「计费开启 ⇒
代码执行不可用」的临时状态与切换计划。

+ export type SandboxClientOptions = {
+   baseUrl: string;
+   token: string;
+   botId: string;
+   /** 沙箱代理是否能强制执行网关计费所依赖的令牌预算；默认 false（fail-closed）。 */
+   enforcesTokenBudget?: boolean;
+   fetchImpl?: typeof fetch;
+ };
+ 
+ // ...
      capabilities: {
-       enforceableTokenBudget: false,
+       enforceableTokenBudget: options.enforcesTokenBudget ?? false,
      },


─── server/src/codesandbox/gateway.ts:194-217 ───
[maintainability · medium] 「审计 → store.create → store.finish → 返回拒绝」的拒绝序列现在在 run/startStreaming 中因
billingBlocked 与 !options.client 两种条件共重复出现四次（本次新增两次），各处仅 reason 字符串与返回形态不同。后续如需为拒绝落库补充字段（如
occurredAt、toolCallId 之外的维度）或调整落库顺序，极易遗漏其中一处。建议提取一个公共的 refuse 辅助函数，各分支只负责组装自己的返回值。

-       if (billingBlocked) {
-         await audit("code.run_refused", {
-           runId,
-           reason: BILLING_TOKEN_BUDGET_UNAVAILABLE,
-           toolCallId,
-           timeoutMs,
-         });
+       const refuseRun = async (reason: string) => {
+         await audit("code.run_refused", { runId, reason, toolCallId, timeoutMs });
          await options.store.create({
            id: runId,
            botId: options.botId,
            ownerUserId: options.ownerUserId,
            task,
            model: options.modelId,
-         });
-         await options.store.finish(runId, {
-           status: "refused",
-           error: BILLING_TOKEN_BUDGET_UNAVAILABLE,
          });
+         await options.store.finish(runId, { status: "refused", error: reason });
+       };
+       if (billingBlocked) {
+         await refuseRun(BILLING_TOKEN_BUDGET_UNAVAILABLE);
          return {
            kind: "refused",
            reason:
              "Code execution is unavailable because this deployment cannot enforce a billing token budget.",
          };
        }


─── server/src/codesandbox/gateway.ts:507-508 ───
[maintainability · low] 该防御分支不可达：queue 仅经 push 填入恒为真值的 TranslatedEvent，在 queue.length > 0 的前置下
shift() 不可能返回假值（本处原为 queue.shift()!）。若队列不变量真的被破坏，continue 也只会静默丢弃假元素并继续循环（shift
会缩短队列，不会形成空转死循环），反而掩盖了不变量破坏的 bug。建议改为显式的 event === undefined 判断并以断言/抛错暴露失败路径，让不变量破坏可被观测。

                    const event = queue.shift();
-                   if (!event) continue;
+                   if (event === undefined)
+                     throw new Error("stream queue invariant broken: shift returned undefined");


─── server/src/codesandbox/gateway.ts:123-124 ───
[documentation · low] 本行文档注释（「A one-event stream that answers "not configured"…」）原本描述的是其下方的
refusedStream 函数；本次在两者之间插入常量后，该注释被隔断、现在错误地挂在常量上方，描述对象与内容不符（且 refusedStream 现在也不只回答
not-configured，还会回答计费拒绝）。建议将注释移回 refusedStream 上方并同步更新描述。

- /** A one-event stream that answers "not configured" in the same shape a real run would. */
+ /** The machine-readable refusal reason for billing deployments without token-budget enforcement. */
  const BILLING_TOKEN_BUDGET_UNAVAILABLE = "billing-token-budget-unavailable";
+ 
+ /** A one-event stream that answers a refusal (not-configured or billing budget) in the same shape a real run would. */
+ function refusedStream(reason = "not-configured"): AsyncIterable<TranslatedEvent> {


─── server/src/codesandbox/gateway.ts:276-288 ───
[maintainability · low] 本块与 run() 路径的 metering 块（约 276-292 行）逐字重复：onUsage 载荷的八个字段组装与「吞掉异常、仅注释说明」的
try/catch 完全相同。这是计费关键路径，两份拷贝一旦在未来只改其一（如新增计费维度、调整 status 语义或错误处理策略），工具路径与 workshop
流式路径的计量数据将静默分叉，且不会有任何编译或测试信号。建议提取一个私有辅助函数（如 meterCompletedRun(runId, sessionId, usage,
occurredAt)），两条路径共用同一份载荷组装与异常包含逻辑。

-           if (options.onUsage && result.usage) {
+       // 私有辅助：两条路径共用同一份计量载荷与异常包含逻辑，避免分叉。
+       const meterCompletedRun = async (
+         runId: string,
+         sessionId: string,
+         usage: SandboxUsage,
+         occurredAt: Date,
+       ): Promise<void> => {
+         if (!options.onUsage) return;
-             try {
+         try {
-               await options.onUsage({
+           await options.onUsage({
-                 runId,
+             runId,
-                 status: "completed",
+             status: "completed",
-                 sessionId,
+             sessionId,
-                 botId: options.botId,
+             botId: options.botId,
-                 ownerUserId: options.ownerUserId,
+             ownerUserId: options.ownerUserId,
-                 modelId: options.modelId,
+             modelId: options.modelId,
-                 inputTokens: result.usage.inputTokens,
-                 outputTokens: result.usage.outputTokens,
+             inputTokens: usage.inputTokens,
+             outputTokens: usage.outputTokens,
-                 occurredAt,
+             occurredAt,
-               });
+           });
+         } catch {
+           // Contained like onArtifacts: a metering miss is a billing miss, never a run error.
+         }
+       };
+ 
+       // run() 与 startStreaming() 的结算点均调用：
+       // await meterCompletedRun(runId, sessionId, result.usage, occurredAt);


─── server/src/index.ts:3248-3250 ───
[bug · medium] finish 路径中 calculateExactModelUsageCharge 抛出的 usage_over_token_max /
usage_over_reservation(非 usage_invalid_tokens)分支既不结算也不释放预留、也不写 outbox:预留将保持 reserved
持续占用该客户可用额度(credit_reservation_allocations 的 held 统计只看 status='reserved',全仓库没有过期预留的自动释放),最终只能等
reconcile 产出 expired_reserved_reservation 交人工恢复,而这次用量(Lago 上报与本地扣费)彻底丢失。同时该失败被记录为
billing-usage-outbox-write-failed 事件类型,但此处并未发生任何 outbox 写入,事件类型与故障性质不符,会误导排障。建议对 UsageChargeError
统一分支处理:显式释放预留(用独立 release reason)并改用独立日志事件类型;下方 usageOutbox.record 失败(同样只留日志)也可考虑一次有界重试再放弃,减少一次性丢失。

+         } catch (error) {
+           if (error instanceof UsageChargeError) {
+             // 计费计算被策略拒绝:显式释放预留并记录独立事件,
+             // 而不是让预留悬挂到过期后才由 reconcile 人工恢复。
+             log.warn(
+               { type: "billing-usage-charge-refused", eventId: input.eventId, code: error.code },
+               "billing-usage-charge-refused",
+             );
+             await billing.creditWriter.releaseReservation(reservation.reservationId, error.code);
+             return;
+           }
            logUsageOutboxWriteFailure("llm", input.eventId, error);
            return;
          }


─── server/src/index.ts:3212-3216 ───
[maintainability · low] reserveCredits 的异常被静默替换为
CreditGateError,没有任何服务端日志:数据库抖动或故障期间所有模型调用都会被拒,日志里却只有客户端可见的通用门控失败,无法与"额度不足"区分,排障缺少线索。建议在抛出前记录一次含错误
name/code 的日志。

        });
-     } catch {
+     } catch (error) {
+       log.error(
+         {
+           type: "billing-credit-reservation-failed",
+           eventId: input.eventId,
+           code: reservationReleaseFailureCode(error),
+         },
+         "billing-credit-reservation-failed",
+       );
        throw new CreditGateError();
      }
      if (!reservation.reserved) throw new CreditGateError();


─── server/src/index.ts:3294-3297 ───
[bug · medium] code_run 的 outbox 行不含 reservation 事实(reportCodeRunUsage 未做预留),而这里的 credits
目标对每一行都会尝试结算:新写入的 code_run 行 creditsStatus 默认 pending,投递时 createCreditUsageTarget 必然抛
missing_reservation,随后按该码 block 并打印一条 "usage delivery failed ... target=credits
code=missing_reservation" 的 warn——即每次代码运行都会产生一条计费失败告警、sweep 的 failed 计数也随预期终态递增,告警噪音会掩盖真实投递故障;被
block 的 credits 目标也永远不会成功。同时这意味着 code run 从此完全不消耗本地额度(旧的 consumeCredits 后付路径已移除)。若"code run 只报
Lago、不扣本地额度"是有意设计,建议在接线处跳过无 reservation 事实的 credits 目标(或将 missing_reservation 的日志降级/不计入
failed);否则需补齐 code run 的预留/结算链路。



─── server/src/index.ts:3536-3537 ───
[style · low] 内联的 import("./workshop/metering").CodeRunUsageInput 类型标注可读性差,且与文件顶部统一的 import
风格不一致;建议改为顶部 import type { CodeRunUsageInput } from "./workshop/metering"。

  const codeRunUsageReporter = billing && usageOutbox
-   ? async (input: import("./workshop/metering").CodeRunUsageInput): Promise<void> => {
+   ? async (input: CodeRunUsageInput): Promise<void> => {


─── server/src/index.ts:3150-3156 ───
[style · low] 新增的这段注释与紧邻上方(3146-3149 行)的既有注释整段重复,是复制粘贴残留;建议删除其中一份,保留带 planCatalog 定价说明的新版即可。



─── server/src/copilot.ts:624-629 ───
[performance · low] finish 分片在 controller.enqueue 之前先 await settleFinish,而 settleFinish 内的
lifecycle.finish 是一次同步的 outbox 落库(数据库写):数据库变慢时,流式响应的最后一个分片会被这次持久化写阻塞,客户端尾部出现额外延迟。outbox
本身就是为异步下游投递设计的,建议先 enqueue 再异步结算(结算失败已有 try/catch 包裹,不影响客户端流)。



─── server/src/config.ts:1510-1518 ───
[bug · medium] 这里只校验了 maximumReservationUnits 的上界,未拒绝 0n:当 rate 的 numerator 为 0 或 maximumTokens 为 0
时,ceilingProduct 返回 0n,该配置会被当作合法通过启动校验。但硬性预留门(index.ts)随后以 maximumCents: 0 调用 reserveCredits,而
reserveCredits 明确要求正数(抛 "reserveCredits needs a positive 32-bit scaled amount"),每次都会被 index.ts 包装成
CreditGateError —— 该模型每次调用都被拒,且没有任何日志能解释原因。建议在此对称增加下界检查,让错误留在 boot 时 issues
里(符合本文件"配置错误在启动时点名拒绝"的设计);另外 MAX_STORED_CREDIT_UNITS(2_147_483_647n)与 credits-writer.ts 的
MAX_STORED_UNITS(2_147_483_647)是同一 32 位约束的两份副本,建议共享导出常量避免漂移。

-       const maximumReservationUnits =
-         inputMaximumCostUnits + outputMaximumCostUnits;
-       if (maximumReservationUnits > MAX_STORED_CREDIT_UNITS) {
+       if (
+         maximumReservationUnits === 0n ||
+         maximumReservationUnits > MAX_STORED_CREDIT_UNITS
+       ) {
          issues.push({
            key: `BILLING_MODEL_MAX_RESERVATION_TOKENS.${modelId}`,
            reason: "out_of_range",
          });
          continue;
        }


─── server/src/config.ts:1683-1689 ───
[bug · low] 字符串分支接受任意量级的 bigint(number 分支有 Number.isSafeInteger 上界),而下游唯一的范围检查
MAX_STORED_CREDIT_UNITS 只约束乘积,不约束 rate 的分子/分母本身。例如 BILLING_MODEL_CREDIT_RATES 中 {numerator: "1",
denominator: "<70 位数字>"} 能通过启动校验(乘积仍 ≤ 上限),但结算时 actual 约分后的分母会超过 settleReservation 的
MAX_ACTUAL_DENOMINATOR(10^60),该 TypeError 没有 code 字段,投递层将其归为 delivery_failed 且永不 block —— 每 30
秒重试并告警、永不收敛。建议对分子/分母在解析期设置与 MAX_ACTUAL_DENOMINATOR 一致的上界(报 out_of_range),或对最终 denominator 做显式约束。

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!/^-?\d+$/.test(trimmed)) {
        issues.push({ key, reason: "out_of_range" });
        return undefined;
      }
      const parsed = BigInt(trimmed);
+     if (parsed < 0n) {
+       issues.push({ key, reason: "negative" });
+       return undefined;
+     }
+     if (parsed > RATE_COMPONENT_LIMIT) {
+       issues.push({ key, reason: "out_of_range" });
+       return undefined;
+     }
+     return parsed;


─── server/src/index.ts:3231-3236 ───
[other · low] usage_invalid_tokens 分支没有发生任何 outbox 写入 —— 事件本身是 provider 返回的 usage 形状非法,随后走的是预留释放 ——
却复用了 type 为 "billing-usage-outbox-write-failed" 的日志分类。按该 type 建立的监控/检索(例如排查 outbox 落库、数据库抖动)会把
provider usage 异常混入其中,误导排障方向。建议为该分支使用独立的日志 type(如 billing-usage-invalid),或直接复用下方
logReservationReleaseFailure 的分类。

-             logUsageOutboxWriteFailure("llm", input.eventId, error);
-             try {
-               await billing.creditWriter.releaseReservation(
-                 reservation.reservationId,
-                 "no_usage",
+             log.error(
+               {
+                 type: "billing-usage-invalid",
+                 source: "llm",
+                 eventId: input.eventId,
+                 code: error.code,
+               },
+               "billing-usage-invalid",
-               );
+             );


LLM retry report summary: 24 of 333 requests affected -- 3 requests failed, 6 requests cancelled, 15 requests recovered after retry

Review planning (3 requests):
- app/src/lib/billing/invoices.ts,server/src/billing/credits-writer.ts,server/src/billing/maintenance.ts,server/src/billing/reconcile.ts,server/src/billing/routes.ts,server/src/billing/service.ts,server/src/billing/statements.ts,server/src/billing/store.ts,server/src/billing/types.ts,server/tests/support/billing.ts: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> succeeded
- server/drizzle/meta/0079_snapshot.json: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> succeeded
- server/drizzle/meta/0081_snapshot.json: rate limited (HTTP 429) -> rate limited (HTTP 429) -> succeeded

Core review (14 requests):
- server/drizzle/meta/0078_snapshot.json: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- server/drizzle/meta/0080_snapshot.json: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- server/drizzle/meta/0082_snapshot.json: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- server/drizzle/meta/0076_snapshot.json: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> succeeded
- server/drizzle/meta/0076_snapshot.json: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> succeeded
- ... and 9 more

Context compaction (6 requests):
- server/drizzle/meta/0075_snapshot.json: cancelled
- server/drizzle/meta/0077_snapshot.json: cancelled
- server/drizzle/meta/0078_snapshot.json: cancelled
- server/drizzle/meta/0080_snapshot.json: cancelled
- server/drizzle/meta/0081_snapshot.json: cancelled
- ... and 1 more

Comment filtering (1 request):
- server/drizzle/meta/0075_snapshot.json: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> succeeded

Per-attempt detail: --format json (retry_report).
