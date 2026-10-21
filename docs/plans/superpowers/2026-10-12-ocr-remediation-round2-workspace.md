Review partially complete: 7 finding(s); 2 of 3 selected item(s) failed.

─── server/src/billing/reconcile.ts:480-482 ───
[maintainability · low] 业务约定字符串 "usage:" 在相邻两行重复出现两次（startsWith 与 slice
必须严格保持一致），且它还与写入侧（server/src/index.ts 中 `idempotencyKey:
\`usage:${input.eventId}\``）构成跨模块契约。任一侧字面量漂移，此处的 usage_event_id 解析就会静默失效（退化为
null，不报错）。建议提取为具名常量，集中维护这一 usage 幂等键的命名契约。

-           const usageEventId = reservation.idempotencyKey.startsWith("usage:")
-             ? reservation.idempotencyKey.slice("usage:".length)
+           const usageEventId = reservation.idempotencyKey.startsWith(
+             USAGE_IDEMPOTENCY_KEY_PREFIX,
+           )
+             ? reservation.idempotencyKey.slice(
+                 USAGE_IDEMPOTENCY_KEY_PREFIX.length,
+               )
              : null;
+ 
+           // 模块级常量（需与 server/src/index.ts 写入侧的 `usage:${eventId}` 保持一致）：
+           // const USAGE_IDEMPOTENCY_KEY_PREFIX = "usage:";


─── server/src/copilot.ts:616-624 ───
[bug · medium] 输出上限的换算与截取存在两个缺陷:(1) maximumTokens 是 bigint,而 config.ts 的 exactWholeNumber
对字符串形式配置接受任意大的非负整数(仅 number 形式才校验 safe-integer),因此 Number(maximumTokens) 可能发生精度舍入,使写入请求的 cap
高于结算阶段用于比较的 bigint 上界——当舍入方向向上时,提供者按 cap 返回的 output 会触发 usage_over_bound,导致已成功的流被报错且预留被扣住(false
positive),准入与结算两个比较点必须使用同一数值域才一致;(2) 调用方传入的 maxOutputTokens 未做合法性校验:负数(如 -5)或小数因 `requested < cap`
成立被原样透传,违背"输出上限由提供者强制"的契约,通常会引发 provider 400(provider_error 路径),maximumTokens 为 0n 时还会发送
maxOutputTokens: 0。建议把 min 比较移到 bigint 域并校验调用方取值。

-         const cap = Number(providerBounds.output.maximumTokens);
+         const cap = providerBounds.output.maximumTokens;
          const requested = (
            params as { maxOutputTokens?: unknown }
          ).maxOutputTokens;
+         const effective =
+           typeof requested === "number" &&
+           Number.isSafeInteger(requested) &&
+           requested >= 0 &&
+           BigInt(requested) <= cap
+             ? BigInt(requested)
+             : cap;
          request = {
            ...(params as Record<string, unknown>),
-           maxOutputTokens:
-             typeof requested === "number" && requested < cap ? requested : cap,
+           maxOutputTokens: Number(effective),
          };


─── server/src/copilot.ts:731-740 ───
[maintainability · low] usage_invalid、usage_over_bound、finish 持久化失败三处完全重复了 `settled = true;
log.error(...); reader.releaseLock(); controller.error(...)` 终止序列,任一处未来遗漏某一侧(如漏 releaseLock 或漏置
settled)都会引入难以察觉的流泄漏或重复结算;建议提取为单一 helper。另外 ModelUsageSettlementError 的 code 是裸 string,与
ModelUsageRefusalCode 的联合类型风格不一致,建议同样收敛为联合类型("usage_invalid" | "usage_over_bound" |
"usage_persistence_failed");countInputTokens 抛错与返回非法值统一复用 input_bound_unsupported
也掩盖了计数实现自身的缺陷,可细分独立原因码以便运维定位。

-             if (!validInput || !validOutput) {
+             const failSettlement = (
+               logType: string,
+               code: ModelUsageSettlementCode,
+               detail?: Record<string, unknown>,
+             ) => {
                settled = true;
-               log.error(
-                 { type: "billing-model-usage-invalid", eventId },
-                 "billing-model-usage-invalid",
-               );
+               log.error({ type: logType, eventId, ...detail }, logType);
                reader.releaseLock();
-               controller.error(new ModelUsageSettlementError("usage_invalid"));
+               controller.error(new ModelUsageSettlementError(code));
+             };
+ 
+             if (!validInput || !validOutput) {
+               failSettlement("billing-model-usage-invalid", "usage_invalid");
                return;
              }


─── server/src/copilot.ts:660-666 ───
[other · low] finish 改为决定性边界后,`usageMeter` 仍在 `await lifecycle?.finish` 之前上报用量:一旦 finish 落库失败、流被
error,计量侧已记录了一笔从未持久化的"成本",与结算事实产生漂移(旧实现 finish 失败被吞掉,不存在此分叉)。建议把 meter 调用移到 finish
成功之后,使"已上报成本"与"已提交用量"保持一致;另外 settleFail 的注释 "Same containment rule as the finish path"
在本次改动后已失真(finish 路径不再吞异常),也建议顺手更正。

-         /*
-          * The decisive boundary: `finish` resolves only after the immutable usage fact has
-          * committed (or an identical event already exists). A rejection is NOT contained
-          * here — it propagates to the pull below, which errors the stream instead of
-          * reporting a successful answer whose usage was never durably recorded.
-          */
          await lifecycle?.finish?.({
+           eventId,
+           occurredAt,
+           inputTokens: usage.inputTokens,
+           outputTokens: usage.outputTokens,
+         });
+         try {
+           usageMeter?.({
+             eventId,
+             occurredAt,
+             inputTokens: usage.inputTokens,
+             outputTokens: usage.outputTokens,
+           });
+         } catch {
+           // A meter that throws must not take the run's last chunk down with it.
+         }


─── server/src/copilot.ts:772-776 ───
[other · low] 捕获的 `error` 没有写入日志,只记录了事件类型。该路径正是"预留被扣留、等待人工对账"的入口,缺少底层错误(如 outbox
写入异常的具体原因)会显著增加排障成本;且本 wrapper 无法假设上游 lifecycle 已自行记录原因。建议将 error 附入日志对象。

                } catch (error) {
                  log.error(
-                   { type: "billing-model-finish-failed", eventId },
+                   { type: "billing-model-finish-failed", eventId, error },
                    "billing-model-finish-failed",
                  );


─── server/src/copilot.ts:599-601 ───
[other · medium] 行为契约收窄但类型未同步:gate 的签名 `Promise<ModelUsageGateLifecycle | undefined>` 仍声明可返回
undefined(旧语义下等价于"本次调用不计量、直接放行"),而新代码把 wired gate 返回 undefined 一律硬拒为 `model_bounds_missing`。当前
index.ts 的 gate 始终返回完整 lifecycle,所以仓内尚无触发方,但任何依赖 "返回 undefined 豁免计费" 的选择性门控部署会在此被整体阻断。若这是有意的
fail-closed 收紧,建议同步收窄 gate 返回类型(去掉 `| undefined`)或在类型/注释中明确 "undefined 视为拒绝",消除契约歧义。

        let request = params;
        if (modelUsageGate) {
+         // A wired gate MUST return a lifecycle with provable bounds: `undefined` no longer
+         // means "skip billing" — it refuses. Narrow the gate's return type accordingly so
+         // the contract is enforceable at the type level.
          if (!providerBounds) return refuse("model_bounds_missing");


─── server/src/copilot.ts:460-465 ───
[documentation · low] 文档断言 "thrown only AFTER the reservation created by admission has been
released" 与 `refuse` 的实现不一致:`lifecycle?.fail` 的失败被 try/catch 吞掉后仍会抛出本错误,此时预留并未真正释放(仅靠预留自身的 expiresAt
过期兜底)。在计费审计语境下,建议弱化该表述(如 "release is attempted before throwing; a failed release leaves the hold for
reconciliation"),或在拒绝日志中带上释放是否成功,保证文档口径与代码行为一致。

  /**
   * A billed call refused before the provider saw anything, because its configured reservation
   * bounds cannot be proven on the actual provider request. Distinct from `CreditGateError`
-  * (the person's balance is fine; this deployment's model wiring is the limit), and thrown
-  * only AFTER the reservation created by admission has been released.
+  * (the person's balance is fine; this deployment's model wiring is the limit). Release is
+  * ATTEMPTED before throwing; if the release itself fails, the hold stays visible for
+  * operator reconciliation rather than being silently dropped.
   */


LLM retry report summary: 3 of 30 requests affected -- 2 requests failed, 1 request recovered after retry

Core review (3 requests):
- server/src/billing/reconcile.ts: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- server/src/index.ts: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- server/src/copilot.ts: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> succeeded

Per-attempt detail: --format json (retry_report).
