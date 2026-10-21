Review complete: 8 finding(s) across 7 selected item(s).

─── server/src/index.ts:3268-3272 ───
[maintainability · low] 此分支对外来(非 UsageChargeError)错误只记录猜测的回退码
"usage_charge_failed",日志中没有任何错误身份信息,排障时无法区分是哪类异常触发了定价拒绝。本次变更在其他失败日志中已确立安全边界内的可诊断性约定:error.message
可能携带连接细节而 error.name 不会——logUsageOutboxWriteFailure(第 378 行)与 copilot.ts 的
billing-model-gate-failed、billing-model-input-count-failed 均记录 name。建议此处保持一致,补充 error.name 字段。

            const code =
              error instanceof UsageChargeError ? error.code : "usage_charge_failed";
            log.error(
              {
                type: "billing-usage-charge-refused",
+               ...(error instanceof Error ? { name: error.name } : {}),


─── server/src/billing/credits-writer.ts:301-308 ───
[documentation · low] 本次新增的终态重放拒绝改变了 reserveCredits 的对外契约,但接口 JSDoc(本文件上方 reserveCredits 的文档,约
116-122 行)仍无条件声明 "A replay of `idempotencyKey` answers the original
reservation",未同步说明已结算/已释放的预订重放现在会抛出
CreditReservationConflictError。维护者依据该文档会误以为重放始终幂等返回原预订——正是本次修复要消除的误解。建议同步更新接口文档,写明仅 `reserved`
状态下重放返回原预订,终态重放与 customer/amount 不匹配同样抛冲突错误。

-           if (existing.status !== "reserved") {
-             // A terminal hold carries no capacity: answering `reserved` would admit work
-             // the gate never priced and settle could never charge — the same refusal
-             // settle gives a released hold.
-             throw new CreditReservationConflictError(
-               `reserveCredits: the reservation for this idempotency key is ${existing.status}.`,
-             );
-           }
+   /**
+    * Hold `maximumCents` (scaled units, a positive 32-bit integer) across the customer's live
+    * grants, earliest expiry first, atomically with respect to every other hold and settlement of
+    * the customer. A replay of `idempotencyKey` answers the original reservation while it is
+    * still `reserved`; a replay against a settled or released hold, or with a different customer
+    * or amount, throws `CreditReservationConflictError`. A refused hold writes nothing and
+    * reports what was available.
+    */


─── server/src/copilot.ts:461-465 ───
[maintainability · low] 统一的拒绝消息对 input_over_limit 不成立：该码表示请求本身的输入超过配置上限，而非部署无法证明计费边界。此时「请管理员配置可证明的
bound」是错误指引——请求方可通过缩短请求自救。建议按 code 区分消息（至少为 input_over_limit 给出「缩短请求」指引），其余能力缺失类代码保留现有文案。

    constructor(readonly code: ModelUsageRefusalCode) {
      super(
-       `Model call refused (${code}): this deployment cannot prove the configured billing bounds on the provider request. Ask an administrator to configure a provable bound for this model.`,
+       code === "input_over_limit"
+         ? `Model call refused (${code}): the request exceeds this deployment's configured input token limit for this model. Shorten the request and try again.`
+         : `Model call refused (${code}): this deployment cannot prove the configured billing bounds on the provider request. Ask an administrator to configure a provable bound for this model.`,
      );
    }


─── server/src/copilot.ts:632-644 ───
[maintainability · low] 计数抛错（依赖瞬时故障）与真实的输入边界能力缺失共用同一个 input_bound_unsupported
拒绝码：日志事件（billing-model-input-count-failed）可区分二者，但到达人/运维侧的拒绝码与文案完全相同，排障时无法从拒绝信号分辨「等一会重试即可」与「需要改配置」。同理
，下方非整数计数分支也归入同一码。建议为探测失败引入独立拒绝码（如 input_count_failed），保持 fail-closed 行为不变，仅让信号可区分。

          } catch (error) {
            // A count that THREW is a failed probe (dependency outage), not a missing
            // capability; the name alone is logged so the two stay distinguishable.
            log.error(
              {
                type: "billing-model-input-count-failed",
                eventId,
                name: (error as Error | null | undefined)?.name,
              },
              "billing-model-input-count-failed",
            );
-           return refuse("input_bound_unsupported");
+           return refuse("input_count_failed");
          }


─── server/src/copilot.ts:473-478 ───
[style · low] ModelUsageSettlementError 的 code 为宽松 string，与同文件 ModelUsageRefusalCode
的字面量联合类型做法不一致，削弱了本文件自产结算码（usage_invalid / usage_over_bound /
usage_persistence_failed）的可枚举性与可维护性。由于该错误还会透传 gate 实现抛出的外部 code（如 outbox 写失败码），集合需保持开放，建议用 (string &
{}) 惯用法在保留开放性的同时为本文件自产码提供字面量补全与文档。

+ /**
+  * Codes this wrapper emits itself; a gate implementation may reject settlement
+  * with its own codes, so the set stays open by design.
+  */
+ export type ModelUsageSettlementCode =
+   | "usage_invalid"
+   | "usage_over_bound"
+   | "usage_persistence_failed"
+   | (string & {});
+ 
  export class ModelUsageSettlementError extends Error {
    override name = "ModelUsageSettlementError";
-   constructor(readonly code: string) {
+   constructor(readonly code: ModelUsageSettlementCode) {
      super(`Model usage settlement failed (${code}).`);
    }
  }


─── server/src/billing/usage-outbox.ts:129-130 ───
[documentation · low] 注释中的 "settled" 不是 usage_outbox 的状态——该表的状态机是 pending/delivered/blocked(见 schema
的 check 约束),"settled" 是 credit_reservations 域的术语。在这个文件里用一个不存在的状态名会让读者误去找 `settled` 状态或混淆两个域的状态机。建议改为
"terminal"(或明确写出 delivered/blocked)。

-   /** A guarded update that matched nothing: present-but-settled is silent, absent throws. */
+   /** A guarded update that matched nothing: present-but-terminal (`delivered`/`blocked`) is silent, absent throws. */
    async function assertRecordExists(eventId: string) {


─── server/src/index.ts:3275-3277 ───
[maintainability · low] 此处的条件展开是恒真分支(死防御):第 3224 行 `if (!reservation.reserved) throw`
之后,`reservation` 已收窄为 `{ reserved: true; reservationId: string }`,且 reserveCredits 的两个成功返回路径都保证
reservationId 为非空字符串(credits-writer.ts:309、342)。同函数内的另两处调用(outbox 写失败日志、fail() 的
logReservationReleaseFailure)都是无条件直接传递 reservationId 的,此处单独做存在性检查既冗余又与同层代码不一致——保留它会让读者误以为
reservationId 可能为空。logUsageOutboxWriteFailure 内部已有 `...(reservationId ? { reservationId } : {})`
守卫,调用方无需重复。

-               ...(reservation.reservationId
-                 ? { reservationId: reservation.reservationId }
-                 : {}),
+               reservationId: reservation.reservationId,


─── server/src/copilot.ts:635-642 ───
[maintainability · low] 此处「只记 error.name、不落 message（防连接串泄漏）」的日志块与上方 billing-model-gate-failed
的块（log.error({type, eventId, name}, type)）完全同构，仅 type 不同，属重复逻辑。failSettlement 已把「type
参数化」做了一次，建议把该模式收敛为一个局部小工具（如 logNamedFailure(type, error)），两个 catch 共用，避免后续新增同类日志时三处各自漂移。

+         const logNamedFailure = (type: string, failure: unknown): void => {
            log.error(
              {
-               type: "billing-model-input-count-failed",
+               type,
                eventId,
-               name: (error as Error | null | undefined)?.name,
+               name: (failure as Error | null | undefined)?.name,
              },
-             "billing-model-input-count-failed",
+             type,
            );
+         };
+         // gate admission catch:
+         logNamedFailure("billing-model-gate-failed", error);
+         // input count catch:
+         logNamedFailure("billing-model-input-count-failed", error);

