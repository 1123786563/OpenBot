// server/src/assembly/model-budget.ts
// MOD09（Issue #629，根 #620）：assembly 的具名预算组合体（组合搬移，零新策略）。
//
// 本文件把 runtime.ts 的内联预算组合原样收拢：
//   - 用量 gate（setModelUsageGate 的具名工厂）：内联的 creditWriter/creditPolicy/
//     reserveCredits 调用形状逐字节搬移——双重预算顺序（token 界内校验→资金预扣
//     →dispatch 才放行）、原 Payer 一次解析（B5-219）、确认无费才释放/其余一律
//     标记未知（A2/ADR-0003）、结算事实先落 outbox（保留预扣）的边界全部原样。
//   - 结算/释放/未知标记的失败日志与稳定码 helper：随 gate 一起搬移，runtime 侧
//     仍有一个 code_run 消费点改经 re-import（行为不变）。
//   - 按 Brief 组装 M06 门面（enterprise/models/public.ts）：资金三道门注入
//     既有 creditWriter（结构注入），可选注入 token 预算服务与 Run capability
//     协作者——gate 的资金写入全部经门面三道门（行为逐字节等价：纯委托）。
//
// 判定/定价/状态机语义零改动：定价出 config 的 creditPolicy 与 workshop/metering，
// 预扣/释放/未知标记出 billing/credits-writer，错误类型出自原模块——本文件只是
// 组合点，不含任何新规则。

import { getLogger } from "@openbot/shared/logger";
import {
  countChatInputTokens,
  fitChatInputRequest,
} from "../billing/input-bound";
import {
  CreditInsufficientError,
  type PayerBinding,
  type currentPayerBinding as readCurrentPayerBinding,
  resolveConsumptionPayerBinding,
} from "../billing/payer-binding";
import { USAGE_IDEMPOTENCY_KEY_PREFIX } from "../billing/types";
import {
  createUsageEvidenceRecorder,
  isConfirmedNoCost,
} from "../billing/usage-evidence";
import {
  type UsageOutbox,
  UsageOutboxConflictError,
} from "../billing/usage-outbox";
import type { currentWorkbenchScope as readCurrentWorkbenchScope } from "../billing/workbench-payer";
import type { BillingCreditPolicyConfig } from "../config";
import {
  CreditGateFailureError,
  CreditPolicyUnconfiguredError,
  ModelNotPricedError,
  ModelUsageSettlementError,
  type setModelUsageGate,
} from "../copilot";
import {
  createModelBudgetPublic,
  type InvocationHoldReservation,
  type ModelBudgetCreditCollaborator,
  type ModelBudgetPublic,
} from "../enterprise/models/public";
import {
  calculateExactModelUsageCharge,
  UsageChargeError,
} from "../workshop/metering";

const log = getLogger("server");

export const STABLE_BILLING_CODE = /^[a-z0-9_]{1,64}$/;
export const MODEL_RESERVATION_WINDOW_MS = 15 * 60_000;

export function usageOutboxWriteFailureCode(error: unknown): string {
  if (error instanceof UsageOutboxConflictError) {
    return "usage_outbox_conflict";
  }
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && STABLE_BILLING_CODE.test(code)
    ? code
    : "usage_outbox_write_failed";
}

export function logUsageOutboxWriteFailure(
  source: "llm" | "code_run",
  eventId: string,
  error: unknown,
  reservationId?: string,
  precomputedCode?: string,
) {
  // The error's NAME only: a database message can carry connection details, and the sweep
  // probes pin that nothing of the sort reaches the logs.
  log.error(
    {
      type: "billing-usage-outbox-write-failed",
      source,
      eventId,
      ...(reservationId ? { reservationId } : {}),
      code: precomputedCode ?? usageOutboxWriteFailureCode(error),
      ...(error instanceof Error ? { name: error.name } : {}),
    },
    "billing-usage-outbox-write-failed",
  );
}

export function reservationReleaseFailureCode(error: unknown): string {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && STABLE_BILLING_CODE.test(code)
    ? code
    : "reservation_release_failed";
}

export function logReservationReleaseFailure(input: {
  source: "llm";
  eventId: string;
  reservationId: string;
  reason: string;
  error: unknown;
}) {
  log.error(
    {
      type: "billing-reservation-release-failed",
      source: input.source,
      eventId: input.eventId,
      reservationId: input.reservationId,
      reason: input.reason,
      code: reservationReleaseFailureCode(input.error),
    },
    "billing-reservation-release-failed",
  );
}

export function logReservationUnknownMarkFailure(input: {
  source: "llm";
  eventId: string;
  reservationId: string;
  reason: string;
  error: unknown;
}) {
  log.error(
    {
      type: "billing-reservation-unknown-mark-failed",
      source: input.source,
      eventId: input.eventId,
      reservationId: input.reservationId,
      reason: input.reason,
      code: reservationReleaseFailureCode(input.error),
    },
    "billing-reservation-unknown-mark-failed",
  );
}

// ---------------------------------------------------------------------------
// 具名预算组合体
// ---------------------------------------------------------------------------

/** gate 的入参（copilot setModelUsageGate 合同形状，经签名提取）。 */
export type ModelBudgetGateInput = Parameters<
  NonNullable<Parameters<typeof setModelUsageGate>[0]>
>[0];

/** gate 的合同形状（copilot setModelUsageGate 注入函数原样）。 */
export type ModelUsageGateFunction = NonNullable<
  Parameters<typeof setModelUsageGate>[0]
>;

/** 组合体的装配依赖：注入 A 门面所需的预算协作者 + gate 的装配事实。 */
export interface ModelBudgetArmDeps {
  /** 资金三道门的既有 writer（billing.creditWriter，结构注入 M06 门面）。 */
  readonly credits: ModelBudgetCreditCollaborator;
  /** 部署定价策略（config 的 creditPolicy，装配原样传入）。 */
  readonly creditPolicy: BillingCreditPolicyConfig | undefined;
  /** 本部署的默认模型 id（gate 的 modelId 回退依据，装配原样）。 */
  readonly defaultModelId: string;
  /** 部署自身的付款账户绑定（B5-219：无自带绑定时的一次性默认）。 */
  readonly deploymentPayerBinding: PayerBinding;
  /** 请求上下文的付款账户绑定读取器（装配原样注入，gate 内逐次调用）。 */
  readonly currentPayerBinding: typeof readCurrentPayerBinding;
  /** 请求上下文的公司工作台 scope 读取器（09.2 归属，装配原样注入）。 */
  readonly currentWorkbenchScope: typeof readCurrentWorkbenchScope;
  /** 不可结算用量证据的 outbox（usage evidence 的唯一写入面）。 */
  readonly usageOutbox: UsageOutbox;
  /** 传给 M06 门面 token 预算组（可选；gate 本身不消费）。 */
  readonly budget?: Parameters<typeof createModelBudgetPublic>[0]["budget"];
  /** 传给 M06 门面授权组（可选；gate 本身不消费）。 */
  readonly invocations?: Parameters<
    typeof createModelBudgetPublic
  >[0]["invocations"];
}

/**
 * 具名预算组合体：构造 M06 门面（注入预算协作者）并返回搬移后的用量 gate。
 * 组合点本位——gate 内所有资金写入都经门面三道门，其余装配事实闭包捕获。
 */
export function createModelBudgetArm(deps: ModelBudgetArmDeps): {
  budgetPublic: ModelBudgetPublic;
  usageGate: ModelUsageGateFunction;
} {
  const budgetPublic = createModelBudgetPublic({
    credits: deps.credits,
    ...(deps.budget ? { budget: deps.budget } : {}),
    ...(deps.invocations ? { invocations: deps.invocations } : {}),
  });
  const usageGate = createModelUsageGate(deps, budgetPublic);
  return { budgetPublic, usageGate };
}

/**
 * The billing seam meters what the built-in Bots consume, once it exists: every model call's
 * admitted call reserves first, then the finished usage becomes one immutable outbox fact with the
 * same event/reservation identity and exact rational charge. Delivery to Lago and credits happens
 * downstream; a completed run whose durable write failed stays visible for reconciliation rather
 * than being silently charged in-process.
 */
function createModelUsageGate(
  deps: ModelBudgetArmDeps,
  budgetPublic: ModelBudgetPublic,
): ModelUsageGateFunction {
  const creditPolicy = deps.creditPolicy;
  const recordUnsettledUsage = createUsageEvidenceRecorder(
    deps.usageOutbox,
    (message) => log.warn(message),
  );
  return async (input) => {
    if (!creditPolicy?.configured) {
      // `configured === false` narrows the union to the variant that carries `issues`, so the
      // offending keys reach the error (and the log) without a cast. `creditPolicy === undefined`
      // cannot happen inside this block, but the guard is on `?.` so answer it as "no issues known".
      throw new CreditPolicyUnconfiguredError(
        creditPolicy?.configured === false ? creditPolicy.issues : [],
      );
    }
    const modelId = input.modelId ?? deps.defaultModelId;
    const modelPolicy = creditPolicy.models.get(modelId);
    if (!modelPolicy) throw new ModelNotPricedError(modelId);

    /*
     * The request's one payer (B5-219): resolved ONCE here, from the request's own
     * binding when the surface bound one, otherwise the deployment's boot binding — and
     * every write below (reserve, outbox fact, unsettled evidence) names exactly this
     * account. A refusal below never re-resolves and never switches: an insufficient
     * balance on the bound account is the final answer for this request.
     */
    const payerBinding = resolveConsumptionPayerBinding({
      requestBinding: deps.currentPayerBinding(),
      deploymentBinding: deps.deploymentPayerBinding,
    });

    let reservation: Awaited<
      ReturnType<typeof budgetPublic.reserveInvocationHold>
    >;
    try {
      reservation = await budgetPublic.reserveInvocationHold({
        externalCustomerId: payerBinding.externalCustomerId,
        idempotencyKey: `${USAGE_IDEMPOTENCY_KEY_PREFIX}${input.eventId}`,
        maximumCents: Number(modelPolicy.maximumReservationUnits),
        expiresAt: new Date(
          input.occurredAt.getTime() + MODEL_RESERVATION_WINDOW_MS,
        ),
      });
    } catch (error) {
      log.error(
        {
          type: "billing-credit-gate-failed",
          eventId: input.eventId,
          model: modelId,
          name: (error as Error | null)?.name,
        },
        "billing-credit-gate-failed",
      );
      throw new CreditGateFailureError();
    }
    if (!reservation.reserved) {
      /*
       * The hold is the WORST-CASE ceiling (config.ts derives it from the configured token maxima),
       * so this refusal has two very different causes and the log is the only place they are
       * distinguishable: a balance that is genuinely empty, and a balance that is fine but smaller
       * than one call's maximum (decision gate G3). `available` and `required` in scaled units.
       */
      log.warn(
        {
          type: "billing-credit-reservation-refused",
          eventId: input.eventId,
          model: modelId,
          payerKind: payerBinding.payer.kind,
          available: reservation.availableCents,
          required: Number(modelPolicy.maximumReservationUnits),
        },
        "billing-credit-reservation-refused",
      );
      /*
       * The one insufficiency semantics (B5-219 / AC13): a displayable refusal on the
       * bound account — its type and its own available amount, no other account's data,
       * no second resolution, no switch. The hold attempt wrote nothing.
       */
      throw new CreditInsufficientError({
        payerKind: payerBinding.payer.kind,
        availableCents: reservation.availableCents,
      });
    }

    return {
      /*
       * The provider-bound contract, as it stands for the adapters this deployment actually
       * invokes. The built-in instance path is the OpenAI-compatible chat model: it maps
       * maxOutputTokens to max_tokens, which the chat-completions contract enforces, so the
       * output cap is proven. Its input side has no provider-enforced ceiling, so the bound
       * is the deployment's own (ADR-0001): a conservative bytes-based count that sits above
       * a typical tokenizer, and a fit that drops the oldest non-system messages until the
       * count fits the configured ceiling — the provider cannot be SENT more than the
       * reservation prices by our own measure, and a tokenizer that beats the calibration
       * surfaces at settlement as usage_over_bound: the stream fails, the hold is retained,
       * and billing/usage-evidence.ts keeps the provider's real token counts — the credits
       * target blocks the row in manual review (`missing_reservation`) while the Lago
       * target still meters the tokens the provider did report.
       * （G2 未决：Spec「Billed admission per surface」仍写 input_bound_unsupported，与 ADR-0001 的 counted+截断冲突，待回写。2026-10-15。）
       */
      bounds: {
        input: {
          enforced: "counted" as const,
          maximumTokens: modelPolicy.input.maximumTokens,
          countInputTokens: countChatInputTokens,
          fit: fitChatInputRequest(modelPolicy.input.maximumTokens),
        },
        output: {
          enforced: "provider_cap" as const,
          maximumTokens: modelPolicy.output.maximumTokens,
        },
      },
      finish: async (usage) => {
        /*
         * The decisive boundary: a successful finish means the immutable usage fact is
         * COMMITTED to the outbox (or an identical event already exists). Any failure —
         * invalid or over-bound usage, or a rejected write — is logged with both stable ids
         * and rethrown as a credential-free settlement error, so the stream the person sees
         * fails rather than reporting a successful answer whose usage vanished. The hold
         * stays `reserved`: chargeable work is never released by a failed write, and
         * reconciliation is what investigates it.
         */
        let charged: ReturnType<typeof calculateExactModelUsageCharge>;
        try {
          charged = calculateExactModelUsageCharge(modelPolicy, {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          });
        } catch (error) {
          // Pricing refused the settlement — a distinct stage from the outbox write, so it
          // gets its own event and never the write-failure code a foreign error would
          // otherwise fall back to. The hold is retained either way.
          const code =
            error instanceof UsageChargeError
              ? error.code
              : "usage_charge_failed";
          log.error(
            {
              type: "billing-usage-charge-refused",
              source: "llm",
              eventId: input.eventId,
              reservationId: reservation.reservationId,
              ...(error instanceof Error ? { name: error.name } : {}),
              code,
            },
            "billing-usage-charge-refused",
          );
          // Audit A3: the tokens are real work this deployment will not price — a durable
          // evidence row (no reservation facts, hold retained) instead of numbers that die
          // with the stream error. The settlement-failure exit in copilot.ts may record the
          // same event again with zero tokens; the outbox keeps these real facts and logs the
          // second write as superseded.
          await recordUnsettledUsage({
            eventId: input.eventId,
            source: "llm",
            externalCustomerId: payerBinding.externalCustomerId,
            model: modelId,
            client: input.client,
            occurredAt: input.occurredAt,
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            reason: code,
          });
          throw new ModelUsageSettlementError(code);
        }
        try {
          await deps.usageOutbox.record({
            eventId: input.eventId,
            source: "llm",
            externalCustomerId: payerBinding.externalCustomerId,
            transactionId: input.eventId,
            inputTokens: charged.inputTokens,
            outputTokens: charged.outputTokens,
            model: modelId,
            client: input.client,
            occurredAt: input.occurredAt,
            reservationId: reservation.reservationId,
            actualCostNumerator: charged.actual.numerator.toString(),
            actualCostDenominator: charged.actual.denominator.toString(),
            // The consumption record's attribution (09.1): the Bot that ran the call and the
            // person it ran for, as the build knew them. Absent stays absent — a named null,
            // never a guess.
            botId: input.attribution.botId,
            ownerUserId: input.attribution.userId,
            // The team dimension (09.2): the workspace a company-workbench call ran under,
            // from the request's own scope. Attribution only — the payer above is already
            // fixed, and no dimension of the caller moves it.
            workspaceId: deps.currentWorkbenchScope()?.workspaceId ?? null,
          });
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
      },
      recordUnsettled: async (unsettled) => {
        await recordUnsettledUsage({
          eventId: unsettled.eventId,
          source: "llm",
          externalCustomerId: payerBinding.externalCustomerId,
          model: modelId,
          client: input.client,
          occurredAt: unsettled.occurredAt,
          inputTokens: unsettled.inputTokens,
          outputTokens: unsettled.outputTokens,
          reason: unsettled.reason,
        });
      },
      fail: async (failure) => {
        /*
         * Release only on a CONFIRMED no-cost (audit A2 / CONTEXT.md Pending Settlement /
         * ADR-0003): the provider refused before any token (`provider_error`), admission refused
         * before the provider (`bound_refused`), or the provider reported zero usage (`no_usage`).
         * Everything else is an unknown outcome — `usage_missing`, `stream_error`, `cancelled`:
         * the provider may have produced billable work we never learned about. Those keep the
         * hold (it expires on its own clock and reconciliation reports it) and leave a durable
         * evidence row naming the event, the reason, and whatever token counts the stream had
         * learned by the time it failed.
         */
        if (isConfirmedNoCost(failure.reason)) {
          try {
            await budgetPublic.releaseInvocationHold(
              reservation.reservationId,
              failure.reason,
            );
          } catch (error) {
            logReservationReleaseFailure({
              source: "llm",
              eventId: input.eventId,
              reservationId: reservation.reservationId,
              reason: failure.reason,
              error,
            });
          }
          return;
        }
        // 06.8: the hold must outlive its own expiry, so it may not stay plain-reserved —
        // mark it unknown BEFORE the evidence write. Best-effort by the same contract as the
        // release above: a failed mark is logged, never allowed to mask the evidence row or
        // the stream's own failure.
        try {
          await budgetPublic.markInvocationHoldUnknown(
            reservation.reservationId,
            failure.reason,
          );
        } catch (error) {
          logReservationUnknownMarkFailure({
            source: "llm",
            eventId: input.eventId,
            reservationId: reservation.reservationId,
            reason: failure.reason,
            error,
          });
        }
        await recordUnsettledUsage({
          eventId: input.eventId,
          source: "llm",
          externalCustomerId: payerBinding.externalCustomerId,
          model: modelId,
          client: input.client,
          occurredAt: input.occurredAt,
          inputTokens: failure.inputTokens ?? 0,
          outputTokens: failure.outputTokens ?? 0,
          reason: failure.reason,
        });
      },
    };
  };
}

/** 组合体答案里 gate 预扣答案的形状（组合搬移后与原内联形状逐字段同一）。 */
export type ModelBudgetGateReservation = InvocationHoldReservation;
