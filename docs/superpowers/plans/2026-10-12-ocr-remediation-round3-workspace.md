Review complete: 9 finding(s) across 5 selected item(s).

─── server/src/billing/usage-outbox.ts:168-177 ───
[maintainability · low] 本次修改使「0 行更新 → 回读行存在性,缺失则抛
UsageOutboxRecordNotFoundError」这一代码块在文件中第三次原样出现(markDelivered、recordDeliveryFailure、blockDelivery
各一份)。建议提取为一个共享的小助手函数(如 `assertRecordExists(eventId)`),三处调用即可,后续若回读语义调整(例如需要区分目标状态)只需改一处。

-     if (rows.length === 0) {
+   async function assertRecordExists(eventId: string) {
-       const [record] = await database
+     const [record] = await database
-         .select({ eventId: usageOutbox.eventId })
+       .select({ eventId: usageOutbox.eventId })
-         .from(usageOutbox)
+       .from(usageOutbox)
-         .where(eq(usageOutbox.eventId, eventId))
+       .where(eq(usageOutbox.eventId, eventId))
-         .limit(1);
+       .limit(1);
-       if (!record) {
+     if (!record) {
-         throw new UsageOutboxRecordNotFoundError(eventId);
+       throw new UsageOutboxRecordNotFoundError(eventId);
+     }
-       }
+   }
+ 
+   // markDelivered / recordDeliveryFailure / blockDelivery 内:
+   if (rows.length === 0) {
+     await assertRecordExists(eventId);
-     }
+   }


─── server/src/index.ts:3272-3282 ───
[maintainability · low] 统一 catch 将两类性质不同的失败混入同一事件类型:calculateExactModelUsageCharge
的费用计算失败(UsageChargeError,如 usage_invalid_tokens / usage_over_token_max)与 usageOutbox.record 的写入失败都会以
"billing-usage-outbox-write-failed" 事件记录;且 usageOutboxWriteFailureCode 对不携带合规 code 的错误兜底为
"usage_outbox_write_failed",该码随后作为 ModelUsageSettlementError.code
对外传播,把计算阶段的失败记成写入失败。按此事件类型/错误码配置的写入失败告警与对账分类会混入非写入类结算失败,误导排障。建议按失败阶段拆分事件类型(如
billing-model-usage-charge-failed 与 billing-usage-outbox-write-failed),或在日志与结算错误中附带 stage 字段(如
stage: "charge" | "outbox_write")区分。

          } catch (error) {
+           const isChargeFailure = error instanceof UsageChargeError;
+           const stage = isChargeFailure ? "charge" : "outbox_write";
            logUsageOutboxWriteFailure(
              "llm",
              input.eventId,
              error,
              reservation.reservationId,
+             stage,
            );
            throw new ModelUsageSettlementError(
-             usageOutboxWriteFailureCode(error),
+             isChargeFailure
+               ? usageOutboxWriteFailureCode(error)
+               : usageOutboxWriteFailureCode(error),
            );
          }


─── server/src/copilot.ts:658-661 ───
[bug · medium] 写入侧的 `Number(effective)` 会破坏上方注释强调的 bigint 域不变量：若配置的 `maximumTokens` 超过
`Number.MAX_SAFE_INTEGER`，转换会发生舍入，导致 provider 实际执行的输出上限与结算侧 bigint 比较使用的上限不一致——正是注释里声称要避免的"round
UP"漂移，只是被挪到了写回侧。该场景经配置可达：`config.ts` 的 `exactWholeNumber` 接受任意长度的十进制字符串（不做安全整数校验），唯一范围约束是对费率乘积
`maximumReservationUnits ≤ MAX_STORED_CREDIT_UNITS`，配合极小费率即可配置出超安全范围的 token 上限。建议在准入阶段校验 cap 可被
Number 精确表示，否则拒绝（fail-closed），保证写入上限与结算上限严格一致。

-         request = {
-           ...(params as Record<string, unknown>),
-           maxOutputTokens: Number(effective),
-         };
+         const cap = providerBounds.output.maximumTokens;
+         /*
+          * A maximum that cannot survive the Number() write below unchanged would leave the
+          * provider-side cap and the settlement-side bigint maximum disagreeing; refuse the
+          * unwritable bound rather than rounding it.
+          */
+         if (cap > BigInt(Number.MAX_SAFE_INTEGER)) {
+           return refuse("output_bound_unsupported");
+         }


─── server/src/copilot.ts:750-753 ───
[bug · medium] 结算失败路径只 `reader.releaseLock()` 而未取消底层流：`controller.error(...)` 只会终结外层包装流，外层的
`cancel(reason)` 不会因此被触发，provider 的 HTTP 响应体从此无人消费、连接被 undici 等客户端挂起直到超时。在持续出现
`usage_invalid`/`usage_over_bound` 结算失败（如 provider 报告超限用量）的场景下会累积悬挂连接。建议改为 `await
reader.cancel(...)`（cancel 会隐式释放锁并向上游传播取消，回收底层连接），本函数及 finish 持久化失败的 catch 分支（第 820 行附近）需要一并修改。

              settled = true;
              log.error({ type: logType, eventId, ...detail }, logType);
-             reader.releaseLock();
+             try {
+               // Cancel — not just releaseLock — so the provider's HTTP body is torn down
+               // instead of holding its connection until it times out.
+               await reader.cancel("settlement_failed");
+             } catch {
+               // The upstream is already gone; nothing to recover.
+             }
              controller.error(new ModelUsageSettlementError(code));


─── server/src/copilot.ts:811-825 ───
[maintainability · low] 该 catch 分支与 `failSettlement` 的函数体高度重复（置 `settled`、按 eventId
记日志、`releaseLock`、`controller.error`），两处独立维护容易在未来漂移——例如只在一处补上底层流取消、或日志字段单边演化。建议提取公共的终止辅助函数（参数化错误对象与日
志码），让两条失败退出路径共享同一实现。



─── server/src/copilot.ts:651-657 ───
[bug · low] 调用方显式传入 `maxOutputTokens: 0`（安全整数、非负、≤ cap）会被原样透传为 0：OpenAI 兼容接口要求 `max_tokens` ≥ 1，0
会导致请求被 provider 拒绝；若 provider 选择忽略 0，则"provider 侧强制输出上限"的承诺落空，只能靠结算侧兜底并产生失败流。建议将 0 视为非法请求值回退到配置
cap（`requested > 0`），并同步更新上方注释对"whole, non-negative"的描述。

          const effective =
            typeof requested === "number" &&
            Number.isSafeInteger(requested) &&
-           requested >= 0 &&
+           requested > 0 &&
            BigInt(requested) <= cap
              ? BigInt(requested)
              : cap;


─── server/src/copilot.ts:833-837 ───
[maintainability · low] 空 catch 的注释声称"仅消费者取消"，但 `enqueue` 在流已关闭/已出错等任何状态下都会抛
TypeError，这些异常被无条件静默吞掉，且没有任何日志，会削弱"chunk 丢失"类问题的排查能力。建议至少以 debug 级别记录 eventId 与原因，使非取消场景下的丢块可诊断。

            try {
              controller.enqueue(part);
-           } catch {
-             // The consumer cancelled mid-pull; the chunk dies with the stream.
+           } catch (error) {
+             // Enqueue throws for any closed/errored state, not only consumer cancellation;
+             // keep a dropped chunk diagnosable instead of silently discarding it.
+             log.debug(
+               { type: "billing-model-chunk-dropped", eventId, error },
+               "billing-model-chunk-dropped",
+             );
            }


─── server/src/index.ts:372-372 ───
[maintainability · medium] 此次变更将 outbox 写失败升级为"决定性"失败(用户可见的流失败 + 保留预扣等待人工对账),但对应的唯一持久化调查线索
billing-usage-outbox-write-failed 只记录了粗粒度的 code(非兼容错误一律兜底为 usage_outbox_write_failed),丢弃了底层错误的
message/堆栈。当发生数据库故障等写失败时,操作者拿到残留的预扣(reconcile 报
expired_reserved_reservation)后,无法从日志判断失败根因(连接拒绝?超时?约束冲突?),使注释中"reconciliation is what investigates
it"的约定缺少关键证据。建议在该服务端日志中补充 error.message(必要时加堆栈或 cause 链)——面向用户的 ModelUsageSettlementError
保持无凭证即可,日志侧不涉及泄露面。

+     {
+       type: "billing-usage-outbox-write-failed",
+       source,
+       eventId,
        ...(reservationId ? { reservationId } : {}),
+       code: usageOutboxWriteFailureCode(error),
+       ...(error instanceof Error ? { message: error.message, stack: error.stack } : {}),
+     },


─── server/src/index.ts:3279-3281 ───
[maintainability · low] usageOutboxWriteFailureCode(error) 在同一 catch 内被求值两次:一次隐含在
logUsageOutboxWriteFailure 内(生成日志 code),一次用于构造
ModelUsageSettlementError。两处独立推导同一个分类结果,后续任一侧调整分类逻辑时可能静默漂移——这正是本 PR 在 USAGE_IDEMPOTENCY_KEY_PREFIX
上通过共享常量规避的问题模式。建议只计算一次并复用。

-           throw new ModelUsageSettlementError(
-             usageOutboxWriteFailureCode(error),
+         } catch (error) {
+           const failureCode = usageOutboxWriteFailureCode(error);
+           logUsageOutboxWriteFailure(
+             "llm",
+             input.eventId,
+             error,
+             reservation.reservationId,
+             failureCode,
            );
+           throw new ModelUsageSettlementError(failureCode);
+         }


LLM retry report summary: 1 of 116 requests affected -- 1 request failed

Core review (1 request):
- server/src/copilot.ts: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed

Per-attempt detail: --format json (retry_report).
