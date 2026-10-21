Review complete: 4 finding(s) across 5 selected item(s).

─── server/src/copilot.ts:827-833 ───
[security · medium] settleFinish 失败路径在 `error instanceof Error` 时把 gate 实现抛出的原始错误对象原样经
failSettlement 传入 controller.error(error)，而结算失败的流错误是 person-visible 的（index.ts 侧注释自述 "so the stream
the person sees fails"）。本 diff 的其他出口都强制了凭据脱敏纪律：gate 失败路径日志只记 error.name（注释明言 message
可能携带连接串等存储细节），index.ts 也把 finish 失败统一包装为无凭据的 ModelUsageSettlementError——此处却把该不变量的执行完全交给每个 gate
实现自觉，且行内注释 "never the raw error" 与代码行为相反（日志侧确实不带原始错误，但流侧拿到了原始对象）。若某 gate 实现的 finish
直接抛出携带连接串等敏感信息的底层错误，该 message 可能沿运行时错误序列化（如 RUN_ERROR 事件）暴露给客户端。建议在边界处强制该不变量：非
ModelUsageSettlementError 一律包装为仅携带稳定 code 的 ModelUsageSettlementError 后再交给 controller.error。

                  failSettlement(
                    "billing-model-finish-failed",
-                   error instanceof Error
+                   error instanceof ModelUsageSettlementError
                      ? error
-                     : new ModelUsageSettlementError("usage_persistence_failed"),
+                     : new ModelUsageSettlementError(
+                         typeof code === "string"
+                           ? code
+                           : "usage_persistence_failed",
+                       ),
                    code ? { code } : undefined,
                  );


─── server/src/copilot.ts:852-861 ───
[bug · low] cancel 回调先 `await reader.cancel(reason)` 再 settleFail("cancelled")，与在途 pull 存在竞态：若消费方在某个
pull 尚在等待上游 read 时取消流，reader.cancel 会使该 pending read 以 done 解决，pull 续体先行执行 settleFail("no_usage")
并抢占 settled 标志，cancel 侧的 settleFail("cancelled") 随即早退——一次真实取消被记为 no_usage 释放，恰好违背本次新增 "cancelled"
原因的既定意图（注释自述 "the release reason must not record it as one"）。两条路径都会释放
hold，无资金风险，仅释放原因记账失真、影响按原因审计释放的准确性。settleFail 对 settled 标志的抢占在首个 await 之前同步完成，因此把该调用提到 await
reader.cancel 之前即可让取消路径确定性地赢得分类。

          async cancel(reason) {
+           // Claim the settled flag BEFORE tearing the upstream down: a pull still in
+           // flight would otherwise win the race and record this cancellation as no_usage.
+           await settleFail("cancelled");
            try {
              await reader.cancel(reason);
            } finally {
-             // The consumer chose to end the stream: a cancellation is not a stream
-             // failure, and the release reason must not record it as one.
-             await settleFail("cancelled");
              reader.releaseLock();
            }
          },


─── server/src/index.ts:3276-3286 ───
[maintainability · low] 这个 catch 把两个不同阶段合并且共用同一套日志分类：`calculateExactModelUsageCharge` 是纯定价计算（不触碰
outbox），它抛出的 `UsageChargeError`（例如 `usage_over_reservation` —— 两侧 token
各自在上限内但合计计价超过预扣额度时，本路径真实可达）会被记在 `billing-usage-outbox-write-failed` 日志类型下；而定价步骤里任何非计费异常（如编程错误）经
`usageOutboxWriteFailureCode` 兜底后会得到稳定码 `usage_outbox_write_failed` ——
这会主动把排障的对账/运维引向一个从未发生的数据库写入。建议将定价阶段与落库阶段分开（定价拒绝用独立的稳定码/日志类型，如 `usage_charge_refused`），保留抛
`ModelUsageSettlementError` 与保留预扣的行为不变。

+         let charged: ReturnType<typeof calculateExactModelUsageCharge>;
+         try {
+           charged = calculateExactModelUsageCharge(modelPolicy, {
+             inputTokens: usage.inputTokens,
+             outputTokens: usage.outputTokens,
+           });
+         } catch (error) {
+           // Pricing refused the settlement: a distinct stage from the outbox write,
+           // so it must not be logged as (or fall back to) a write failure code.
+           const code = error instanceof UsageChargeError ? error.code : "usage_charge_failed";
+           log.error(
+             { type: "billing-usage-charge-refused", source: "llm", eventId: input.eventId, code },
+             "billing-usage-charge-refused",
+           );
+           throw new ModelUsageSettlementError(code);
+         }
+         try {
+           await usageOutbox.record({ /* ... */ });
          } catch (error) {
            const failureCode = usageOutboxWriteFailureCode(error);
            logUsageOutboxWriteFailure(
              "llm",
              input.eventId,
              error,
              reservation.reservationId,
              failureCode,
            );
            throw new ModelUsageSettlementError(failureCode);
          }


─── server/src/copilot.ts:630-634 ───
[maintainability · low] `countInputTokens` 的任何失败（包括未来计数后端的瞬时故障：网络超时、服务 5xx）都被折叠成永久能力码
`input_bound_unsupported`，运维在 `billing-model-admission-refused`
日志里无法区分「该适配器从未提供计数契约」与「计数服务此刻不可用」，两者的处置动作完全不同（前者要改配置，后者要查依赖）。由于该码同时是面向管理员的拒绝话术（"cannot prove the
configured billing bounds"），瞬时故障被表述为部署能力缺陷会误导排障方向。建议为计数失败引入独立拒绝码（如 `input_count_failed`），或至少像 gate
失败路径一样只记录 `error.name` 以保留区分度。

          try {
            counted = await providerBounds.input.countInputTokens(params);
-         } catch {
-           return refuse("input_bound_unsupported");
+         } catch (error) {
+           // A count that THREW is a failed probe, not a missing capability: keep the two
+           // distinguishable in the refusal log instead of folding both into one code.
+           log.error(
+             {
+               type: "billing-model-input-count-failed",
+               eventId,
+               name: (error as Error | null | undefined)?.name,
+             },
+             "billing-model-input-count-failed",
+           );
+           return refuse("input_count_failed");
          }

