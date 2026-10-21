Review partially complete: 15 finding(s); 44 of 46 selected item(s) failed.

─── server/src/billing/usage-outbox.ts:129-131 ───
[bug · high] markDelivered 缺少目标状态 'pending' 的 where 守卫,而同文件的 recordDeliveryFailure 与 blockDelivery
均带该守卫。一旦某目标已被 blockDelivery 置为 blocked(如 missing_reservation 等待人工处理——reconcile.ts 将 blocked
计数作为审计证据,代码中不存在任何 unblock 路径,blocked 是终态),一个持有过期内存快照的滞后 worker 或未来新增的调用方仍可通过
markLagoDelivered/markCreditsDelivered 将其无条件覆盖为 delivered,封锁保护被静默绕过,可能把本应拦截的事件投递出去。建议与兄弟函数对齐:仅允许
pending → delivered,并复用同样的 0 行回读兜底(记录存在则静默跳过),避免幂等重标记时误抛 UsageOutboxRecordNotFoundError。

    async function markDelivered(eventId: string, target: "lago" | "credits") {
-     const rows =
+     const statusColumn =
+       target === "lago" ? usageOutbox.lagoStatus : usageOutbox.creditsStatus;
+     const rows = await database
+       .update(usageOutbox)
+       .set(
-       target === "lago"
+         target === "lago"
+           ? {
+               lagoStatus: "delivered" satisfies UsageOutboxDeliveryStatus,
+               lagoLastErrorCode: null,
+               updatedAt: new Date(),
+             }
+           : {
+               creditsStatus: "delivered" satisfies UsageOutboxDeliveryStatus,
+               creditsLastErrorCode: null,
+               updatedAt: new Date(),
+             },
+       )
+       .where(
+         and(eq(usageOutbox.eventId, eventId), eq(statusColumn, "pending")),
+       )
+       .returning({ eventId: usageOutbox.eventId });
+ 
+     if (rows.length === 0) {
+       const [record] = await database
+         .select({ eventId: usageOutbox.eventId })
+         .from(usageOutbox)
+         .where(eq(usageOutbox.eventId, eventId))
+         .limit(1);
+       if (!record) {
+         throw new UsageOutboxRecordNotFoundError(eventId);
+       }
+     }
+   }


─── server/src/billing/usage-outbox.ts:269-273 ───
[bug · medium] pending() 只有 pending/blocked/delivered 三态,没有 in-flight 认领语义(无 FOR UPDATE SKIP
LOCKED、无 owner/lease 字段);调用方 startUsageDeliverySweeps 的 running 标志仅防单进程内重叠,而 index.ts 在每个副本顶层启动
sweep。多副本并发轮询会取到同一批 pending 行并同时向 Lago 投递、并发调用 settleReservation。当前只能依赖下游隐式契约兜底:Lago 按
transaction_id 去重、credits 靠客户行锁 + settled 状态比对,重复外部调用、配额浪费与日志噪音仍会发生,且下游契约一旦变化即变成真实重复计费。建议在事务内用
SELECT ... FOR UPDATE SKIP LOCKED 认领并落地认领状态(如新增 claimedAt/lease 列或将状态机扩展 in_flight),保证一批事件同一时刻至多被一个
worker 处理。

      async pending(limit) {
        assertPositiveLimit(limit);
-       return database
+       // 认领语义:被选中行需在同一事务内写入认领标记(如 claimedAt/lease),
+       // 并发 worker 借助 SKIP LOCKED 跳过已被认领的行,避免重复投递。
+       return database.transaction(async (tx) =>
+         tx
-         .select()
+           .select()
-         .from(usageOutbox)
+           .from(usageOutbox)
+           .where(
+             or(
+               eq(usageOutbox.lagoStatus, "pending"),
+               eq(usageOutbox.creditsStatus, "pending"),
+             ),
+           )
+           .orderBy(asc(usageOutbox.updatedAt), asc(usageOutbox.eventId))
+           .limit(limit)
+           .for("update", { skipLocked: true }),
+       );
+     }


─── server/src/billing/usage-outbox.ts:199-203 ───
[maintainability · medium] blockDelivery 与 recordDeliveryFailure 除写入字段(lagoStatus/creditsStatus vs
lagoLastErrorCode/creditsLastErrorCode)外逻辑完全相同,markDelivered 内部 lago/credits 两分支同样是复制粘贴,且"更新 0
行后回读记录、不存在才抛错"的兜底重复出现三处。后续新增投递目标或状态(本 PR 已从两态扩到三态)时极易漏改其中一处造成行为不一致。建议抽取公共辅助函数:统一解析目标的 status/error
列,收敛"带 pending 守卫的更新 + 0 行回读兜底"逻辑,三个入口只声明各自的 set 载荷。

-   async function blockDelivery(
+   function targetColumns(target: "lago" | "credits") {
+     return target === "lago"
+       ? { status: usageOutbox.lagoStatus, lastError: usageOutbox.lagoLastErrorCode }
+       : { status: usageOutbox.creditsStatus, lastError: usageOutbox.creditsLastErrorCode };
+   }
+ 
+   /** 带 pending 守卫的目标状态更新 + 0 行回读兜底,三个投递簿记入口共用。 */
+   async function guardedTargetUpdate(
      eventId: string,
      target: "lago" | "credits",
-     failureCode: string,
+     set: { status?: UsageOutboxDeliveryStatus; lastError?: string | null },
    ) {
+     const columns = targetColumns(target);
+     const rows = await database
+       .update(usageOutbox)
+       .set({
+         ...(set.status !== undefined
+           ? (target === "lago"
+               ? { lagoStatus: set.status }
+               : { creditsStatus: set.status })
+           : {}),
+         ...(set.lastError !== undefined
+           ? (target === "lago"
+               ? { lagoLastErrorCode: set.lastError }
+               : { creditsLastErrorCode: set.lastError })
+           : {}),
+         updatedAt: new Date(),
+       })
+       .where(and(eq(usageOutbox.eventId, eventId), eq(columns.status, "pending")))
+       .returning({ eventId: usageOutbox.eventId });
+ 
+     if (rows.length === 0) {
+       const [record] = await database
+         .select({ eventId: usageOutbox.eventId })
+         .from(usageOutbox)
+         .where(eq(usageOutbox.eventId, eventId))
+         .limit(1);
+       if (!record) {
+         throw new UsageOutboxRecordNotFoundError(eventId);
+       }
+     }
+   }


─── server/src/billing/usage-outbox.ts:280-281 ───
[other · low] 失败重试缺少上限与退避:除 missing_reservation 会 block 外,其余持续失败的事件(如 Lago 对某客户永久拒绝)会以固定 30s
间隔被无限重试,recordDeliveryFailure 仅覆盖 lastErrorCode 并顺延 updatedAt(顺便丢失了首次失败时间),既无 attempts 计数也无
nextRetryAt/dead-letter,运维只能靠日志发现问题。事件量增长后,这类毒丸事件会长期占据 pending 工作集。建议增加 attempts 列并在超过阈值后升级为
blocked(或引入 nextRetryAt 实现指数退避),与 missing_reservation 的人工介入路径保持一致。注:索引方面无需担心,0078 迁移已建 (lago_status,
updated_at) 与 (credits_status, updated_at) 复合索引支撑该查询。



─── server/src/copilot.ts:729-741 ───
[bug · medium] 已核实:runtimeModel 对非 openai provider(含全部 Anthropic)与未设 OPENAI_BASE_URL 的官方 OpenAI
均返回字符串模型,而调用点仅在配置 model.plan 时才传入实例,因此计费门启用后这类部署上所有未走 plan 的内置 Bot 每次运行都会被此分支拒绝。fail-closed 本身符合"先证明
provider 边界"的整改目标且有测试覆盖,但复用 CreditGateError
使文案向用户断言"部署已没有额度,请充值或升级"——对配置形态问题是错误归因,管理员会被引导去充值而非修正部署配置。建议为"模型不可计量"引入独立的哨兵错误(独立
code/文案),并在此分支补充说明拒绝政策的注释(本文件其他分支均有成段说明)。

-   const resolvedModel = planModel ?? runtimeModel(model, apiKey);
-   if (
-     modelUsageGate !== undefined &&
-     typeof resolvedModel === "string"
-   ) {
+ export class UnmeterableModelError extends Error {
+   override name = "UnmeterableModelError";
+   readonly code = "model_unmeterable";
+   constructor() {
+     super(
+       "This model cannot be metered in its current form. Ask an administrator to configure a gateway base URL or a plan model.",
+     );
+   }
+ }
+ 
+ // ...
+   if (modelUsageGate !== undefined && typeof resolvedModel === "string") {
      return {
        type: "custom",
        // biome-ignore lint/correctness/useYield: this agent must fail when iteration starts.
        factory: async function* () {
-         throw new CreditGateError();
+         // Fail-closed: string-form models are resolved by the runtime where the
+         // gate cannot reach them, so billed admission cannot be proven.
+         throw new UnmeterableModelError();
        },
      };
    }


─── server/src/copilot.ts:503-506 ───
[maintainability · medium] 非 CreditGateError 的底层异常(如 gate 内部 TypeError、依赖故障)在此被替换为无信息的
CreditGateError 且未留任何痕迹——copilot.ts 全文件没有任何日志输出。配合 fail-closed 策略,线上"有额度却被拒"的问题(典型场景:gate
抛出的是意外异常而非额度拒绝)将无根因可查,与本次计费审计整改的可追溯目标相悖。建议在重抛前记录原始错误,或扩展 CreditGateError 支持 options.cause 保留根因。

          } catch (error) {
            if (error instanceof CreditGateError) throw error;
+           console.error("Model usage gate failed; refusing the call.", error);
            throw new CreditGateError();
          }


─── server/src/copilot.ts:556-565 ───
[performance · medium] finish/fail 的生产接线分别是 usage_outbox 落库与预约释放(含客户行锁的事务),而 pull 在 enqueue finish
分片前、cancel 在 releaseLock 前同步 await 其完成。try/catch 只能兜住 rejection,兜不住挂起:数据库抖动或连接池耗尽时,用户的流会被无限期阻塞(最后的
finish 分片不送达、cancel 方的 promise 不返回、上游读锁不释放)。生产侧已有 outbox 重投与预约过期补偿兜底,建议对结算等待加上界(如 Promise.race
超时),超时后放行流并交由对账补偿。

+         const settledWithin = (promise: Promise<void> | undefined) =>
+           Promise.race([
+             promise ?? Promise.resolve(),
+             new Promise<undefined>((resolve) =>
+               setTimeout(resolve, MODEL_SETTLE_TIMEOUT_MS),
+             ),
+           ]);
          try {
-           await lifecycle?.finish?.({
+           await settledWithin(
+             lifecycle?.finish?.({
-             eventId,
+               eventId,
-             occurredAt,
+               occurredAt,
-             inputTokens: usage.inputTokens,
+               inputTokens: usage.inputTokens,
-             outputTokens: usage.outputTokens,
+               outputTokens: usage.outputTokens,
-           });
+             }),
+           );
          } catch {
            // The lifecycle owner logs and reconciles its own durable-write failures.
          }


─── server/src/copilot.ts:631-638 ───
[bug · medium] 用户/客户端主动中止也会被记为 "stream_error":生产侧 fail 回调把该 reason 经 releaseReservation 持久化进
credit_reservations.releaseReason,正常取消被记为异常流失败,污染本 PR 刚建立的预约审计事实(消费方 abort 的原始 reason 参数也被丢弃)。当前
reconcile 不消费该字段,影响限于审计语义,但本整改主题正是审计可信度。建议在 ModelUsageFailureReason 中补充 "cancelled" 枚举供 cancel
路径使用,使主动取消与真实流错误可区分。

+ export type ModelUsageFailureReason =
+   | "provider_error"
+   | "stream_error"
+   | "no_usage"
+   | "cancelled";
+ 
+ // ...
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
-             await settleFail("stream_error");
+             await settleFail("cancelled");
              reader.releaseLock();
            }
          },


─── server/src/copilot.ts:546-555 ───
[bug · low] usageMeter?.() 未 await 且签名声明为同步返回 void:try/catch 只能捕获同步抛出,若注册方传入 async 函数,其 rejection
将成为 unhandled rejection、用量静默丢失。已核实当前生产未接线 setModelUsageMeter(index.ts 仅挂 gate,持久化走已 await 的 finish
生命周期),故为潜伏性隐患;但该 seam 是公开注册口,建议要么将签名改为允许返回 Promise 并 await + 捕获,要么在类型/注释上强制"必须同步"的契约,避免未来接线者踩坑。

          try {
-           usageMeter?.({
+           await usageMeter?.({
              eventId,
              occurredAt,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            });
          } catch {
            // A meter that throws must not take the run's last chunk down with it.
          }


─── server/src/copilot.ts:629-629 ───
[bug · low] 取消竞态:若消费者在 reader.read() 进行中取消外层流,cancel 回调会先结算并关闭流,而已在途的 pull 随后执行
controller.enqueue(part)(done 分支的 controller.close() 同理)会因流已关闭抛
TypeError,该分片被静默丢弃。流机制会吞掉该异常、无用户可见损害,但属未防御的竞态,建议对 enqueue/close 增加保护以消除噪音。

+           try {
-           controller.enqueue(part);
+             controller.enqueue(part);
+           } catch {
+             // The consumer cancelled mid-pull; the chunk dies with the stream.
+           }


─── server/src/copilot.ts:646-646 ───
[maintainability · low] meteredModelForTests 将内部包装函数以生产导出暴露,当前仅
server/tests/copilot-usage-meter.test.ts 使用。这扩大了生产模块的公共导出面,生产代码可能误用内部包装器。本 PR 已新增
server/tests/support/billing.ts 测试支撑层,建议经由该层桥接暴露,或至少在符号处注明仅供测试,约束其使用范围。



─── server/src/copilot.ts:406-412 ───
[maintainability · low] 用量报文形态 {eventId; occurredAt; inputTokens; outputTokens} 在 usageMeter 变量与
setter、ModelUsageGateLifecycle.finish 等处重复内联四次以上(settleFinish 还有一份收窄为 number 的变体),后续字段演进(如补充
modelId/runId)时极易漂移失配。建议抽取共享类型,各签名统一引用。

- export type ModelUsageGateLifecycle = {
-   finish?: (usage: {
+ export type ModelUsageReport = {
-     eventId: string;
+   eventId: string;
-     occurredAt: Date;
+   occurredAt: Date;
-     inputTokens: number | undefined;
+   inputTokens: number | undefined;
-     outputTokens: number | undefined;
+   outputTokens: number | undefined;
-   }) => Promise<void> | void;
+ };
+ 
+ export type ModelUsageGateLifecycle = {
+   finish?: (usage: ModelUsageReport) => Promise<void> | void;


─── server/src/billing/usage-outbox.ts:247-251 ───
[bug · low] record() 只仲裁了 event_id 主键冲突,但 schema 在 transaction_id
上还有独立唯一索引(usage_outbox_transaction_id_unique_idx,见 0075 迁移)。Postgres 的 ON CONFLICT
指定目标列后仅对该索引生效,一旦同一 transactionId 以不同 eventId 上报(例如把 eventId 用作每次上报的独立 UUID、transactionId
用作稳定业务键,这正是该唯一索引的设计意图),插入会以裸 23505 唯一约束异常抛出,绕过 UsageOutboxConflictError 的类型化冲突语义;而且下方按 eventId
的回读也查不到该行,无法做事实比对。当前两个调用点(index.ts 的 llm gate 传入 input.eventId、metering.reportCodeRunUsage 传入
code-run:<runId>)恰好 transactionId === eventId 才未触发。建议捕获 usage_outbox_transaction_id_unique_idx 的
23505 并改按 transaction_id 回读比对(重复→{inserted:false},事实不一致→ConflictError),或在入口校验 transactionId 与
eventId 的一一对应契约并在类型/文档中固化。

-       const inserted = await database
+       let inserted: { eventId: string }[] = [];
+       let conflictedOnTransactionId = false;
+       try {
+         inserted = await database
-         .insert(usageOutbox)
+           .insert(usageOutbox)
-         .values(normalized)
+           .values(normalized)
-         .onConflictDoNothing({ target: usageOutbox.eventId })
+           .onConflictDoNothing({ target: usageOutbox.eventId })
-         .returning({ eventId: usageOutbox.eventId });
+           .returning({ eventId: usageOutbox.eventId });
+       } catch (error) {
+         if (!isPgUniqueViolation(error, "usage_outbox_transaction_id_unique_idx")) {
+           throw error;
+         }
+         conflictedOnTransactionId = true;
+       }
+ 
+       if (inserted.length > 0) {
+         return { inserted: true };
+       }
+ 
+       const [record] = await database
+         .select()
+         .from(usageOutbox)
+         .where(
+           conflictedOnTransactionId
+             ? eq(usageOutbox.transactionId, normalized.transactionId)
+             : eq(usageOutbox.eventId, input.eventId),
+         )
+         .limit(1);


─── server/src/copilot.ts:526-545 ───
[maintainability · low] 死代码:settleFinish 的唯一调用点(下方 finish 分支)传入的永远是非空对象,而"流正常结束但没有 finish
分片"的路径(chunk.done 分支)是直接调用 settleFail("no_usage"),并未经过 settleFinish(null)。因此 usage === null
分支永远不会执行,连带参数类型的 `| null` 变体也属死面;且该分支内容与 settleFail("no_usage") 完全重复。结算路径("finish
持久化必须决断")是本次整改的核心,建议删除 null 变体让出口唯一(settleFinish 只收数值对象、失败统一走 settleFail);若原意是让"无用量"也走同一出口,则应把
chunk.done 分支改为调用 settleFinish(null) 并移除与 settleFail 的重复。

-       const settleFinish = async (
-         usage: {
+       const settleFinish = async (usage: {
-           inputTokens: number;
+         inputTokens: number;
-           outputTokens: number;
+         outputTokens: number;
-         } | null,
-       ) => {
+       }) => {
          if (settled) return;
          settled = true;
-         if (usage === null) {
-           try {
+         try {
-             await lifecycle?.fail?.({
+           usageMeter?.({
-               eventId,
+             eventId,
-               occurredAt,
+             occurredAt,
-               reason: "no_usage",
+             inputTokens: usage.inputTokens,
+             outputTokens: usage.outputTokens,
-             });
+           });
-           } catch {
+         } catch {
-             // Same containment rule as the finish path.
-           }
-           return;
+           // A meter that throws must not take the run's last chunk down with it.
          }


─── server/src/copilot.ts:581-582 ───
[documentation · low] 本次把原来的 `result.stream.pipeThrough(report)`(TransformStream 管道)重写为手写
ReadableStream(pull/cancel + settleFinish/settleFail 生命周期),但函数头部的 JSDoc(第 464-472 行,未随本次改动更新)仍写着
"the result's ReadableStream is piped through a transform so the `finish` part's token counts reach
the meter",描述的已是不存在的机制。注释与实现不一致会误导后续维护者(尤其这条注释还声称"hand-rolled to the same shape AI SDK's own
wrapLanguageModel produces",而新实现的手写流语义与 wrapLanguageModel 已有实质差异)。建议同步更新该段注释,说明预扣预约的 finish/fail
生命周期与结算时机。

+       /*
+        * 手写 ReadableStream(而非 TransformStream 管道):结算(finish 持久化 / fail 释放)
+        * 必须在分片送达或流终止前决断,详见 settleFinish / settleFail。
+        */
- const stream = new ReadableStream<Record<string, unknown>>({
+       const stream = new ReadableStream<Record<string, unknown>>({
          async pull(controller) {


LLM retry report summary: 78 of 125 requests affected -- 71 requests failed, 7 requests recovered after retry

Review planning (30 requests):
- server/drizzle/0077_credit_reservations.sql: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- server/drizzle/meta/0075_snapshot.json: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- server/drizzle/meta/0076_snapshot.json: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- server/drizzle/meta/0078_snapshot.json: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- server/drizzle/meta/0079_snapshot.json: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- ... and 25 more

Core review (46 requests):
- app/src/lib/billing/invoices.ts: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- server/drizzle.config.ts: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- server/drizzle/0075_volatile_tag.sql: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- server/drizzle/0076_productive_nextwave.sql: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- server/drizzle/0077_credit_reservations.sql: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- ... and 41 more

Context compaction (1 request):
- server/drizzle/meta/0077_snapshot.json: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed

File grouping (1 request):
- __grouping__: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed

Per-attempt detail: --format json (retry_report).
