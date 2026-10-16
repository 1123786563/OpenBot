/**
 * The billing wiring of evaluation calls (Issue #31 / DAG T25).
 *
 * One evaluation case is one metered model call, and this module is where that call
 * meets the deployment's ONE credit machinery — nothing here is a second ledger. The
 * wiring follows the built-in model-usage gate seam for seam:
 *
 *  - Admission: `reserveCredits` under the worst-case hold the frozen model's policy
 *    prices, BEFORE the gateway is dialed. A balance that cannot cover one call's
 *    ceiling, a model with no configured price, or a gate that cannot read the ledger
 *    all refuse — fail-closed, the provider is never invoked (T23's 402 doctrine,
 *    refined to the single call).
 *  - Settlement: the gateway's own usage becomes one immutable usage-outbox fact with
 *    the reservation identity and the exact rational charge; the existing delivery
 *    sweep settles the hold downstream, exactly as the built-in path's calls do. The
 *    ledger stays the authority — the Opik-side projections and span observations are
 *    analysis copies and are never read back for charging.
 *  - Unknown cost: usage that never arrived, a call that threw, a charge the pricing
 *    refused — none of them become zero. The hold stays occupied (ADR-0003's pending
 *    settlement) and an evidence row names the case. A thrown gateway call is an
 *    UNKNOWN outcome here, deliberately not the built-in path's released
 *    `provider_error`: this runner cannot observe "refused before the first token" —
 *    a timeout mid-generation throws the same — so no confirmed-no-cost is claimed.
 *
 * Idempotency rides the T24 write-ahead row's natural key — `(executionId, caseIndex)`
 * — as both the reservation's idempotency key and the outbox event id, so a replayed
 * or takeover-shaped re-run can neither dial the gateway twice nor charge twice: the
 * terminal reservation refuses re-admission, and a settlement replay answers the
 * first result.
 */
import {
  CreditReservationConflictError,
  type CreditWriter,
} from "../billing/credits-writer";
import { USAGE_IDEMPOTENCY_KEY_PREFIX } from "../billing/types";
import { createUsageEvidenceRecorder } from "../billing/usage-evidence";
import type { UsageOutbox } from "../billing/usage-outbox";
import type { BillingModelCreditPolicyEntry } from "../config";
import {
  calculateExactModelUsageCharge,
  UsageChargeError,
} from "../workshop/metering";
import {
  createProductionEvaluationCaseRunner,
  type EvaluationModelCall,
  type EvaluationModelCallObserver,
  textOf,
} from "./execution-runner";
import type {
  EvaluationCaseRunner,
  ExecutionBudgetPrecheck,
} from "./executions";

/** How the usage fact names the surface an evaluation call really came from. */
export const EVALUATION_USAGE_CLIENT = "opik_evaluation";

/**
 * The hold window mirrors the built-in gate's (index.ts): long enough that a worker
 * lease plus a bounded gateway call always fits inside it, short enough that an
 * abandoned hold returns to the balance for reconciliation to report.
 */
const DEFAULT_RESERVATION_WINDOW_MS = 15 * 60_000;

/** The T24 write-ahead row's natural key, spelled as the billing seam's event id. */
export function evaluationCaseUsageId(
  executionId: string,
  caseIndex: number,
): string {
  return `opik-execution-case:${executionId}:${caseIndex}`;
}

/**
 * A case that completed but cannot be settled honestly: the pricing refused its usage,
 * or the immutable usage fact failed to persist. The case runner throws this so the
 * worker records the execution as failed rather than a success whose cost vanished —
 * the same decisive boundary the built-in path's `ModelUsageSettlementError` draws.
 */
export class EvaluationCaseSettlementError extends Error {
  override name = "EvaluationCaseSettlementError";
  constructor(readonly code: string) {
    super(`Evaluation case settlement failed (${code}).`);
  }
}

/**
 * The T23 start seam's implementation: may an execution of this deployment start at
 * all. The balance is deployment-scoped (one deployment, one customer key — the same
 * fact every other credit read hangs on), so the actor and experiment in the input
 * do not change the answer; a deployment with nothing spendable answers `allowed:
 * false` before any row or ticket is written, which is the 402 the service throws.
 * A gate that cannot read the ledger refuses rather than admits.
 */
export function createExecutionBudgetPrecheck(
  deps: Readonly<{
    creditWriter: Pick<CreditWriter, "availableBalance">;
    externalCustomerId: string;
    log?: (message: string) => void;
  }>,
): ExecutionBudgetPrecheck {
  return async () => {
    try {
      const spendable = await deps.creditWriter.availableBalance(
        deps.externalCustomerId,
      );
      return spendable > 0
        ? { allowed: true }
        : { allowed: false, reason: "no_spendable_credits" };
    } catch {
      deps.log?.(
        `billing: opik_execution_precheck_failed customer=${deps.externalCustomerId} code=credit_gate_failed`,
      );
      return { allowed: false, reason: "credit_gate_failed" };
    }
  };
}

/** What the billing side of one evaluation call needs from the deployment. */
export type EvaluationBillingDeps = Readonly<{
  creditWriter: Pick<CreditWriter, "reserveCredits">;
  outbox: Pick<UsageOutbox, "record">;
  /** The frozen model's price ceiling; a model this map does not name is not admissible. */
  policy: ReadonlyMap<string, BillingModelCreditPolicyEntry>;
  externalCustomerId: string;
}>;

/**
 * The production case runner, billed: the T24 runner runs inside, its admission seam
 * answered by a real reservation, and the outcome that comes back is settled through
 * the same outbox the built-in path's calls settle through. The runner's contract is
 * untouched — refused admission is still the honestly failed case with its `refused`
 * span; what this wrapper adds is everything after that answer.
 */
export function createBilledEvaluationCaseRunner(
  deps: Readonly<{
    callModel: EvaluationModelCall;
    observe?: EvaluationModelCallObserver;
    billing: EvaluationBillingDeps;
    reservationWindowMs?: number;
    log?: (message: string) => void;
  }>,
): EvaluationCaseRunner {
  const evidence = createUsageEvidenceRecorder(deps.billing.outbox, deps.log);
  const windowMs = deps.reservationWindowMs ?? DEFAULT_RESERVATION_WINDOW_MS;

  return async (context) => {
    const modelName = textOf(context.config.modelName);
    const modelPolicy = deps.billing.policy.get(modelName);
    const eventId = evaluationCaseUsageId(
      context.executionId,
      context.caseIndex,
    );
    let reservationId: string | undefined;

    // The admission the T24 runner asks for, answered by a real hold. The natural key
    // makes the reservation replay-safe: a still-reserved hold answers itself, and a
    // terminal one refuses — a settled case can never be invoked (or charged) again.
    const admit = modelPolicy
      ? async () => {
          try {
            const hold = await deps.billing.creditWriter.reserveCredits({
              externalCustomerId: deps.billing.externalCustomerId,
              idempotencyKey: `${USAGE_IDEMPOTENCY_KEY_PREFIX}${eventId}`,
              maximumCents: Number(modelPolicy.maximumReservationUnits),
              expiresAt: new Date(Date.now() + windowMs),
            });
            if (!hold.reserved) {
              return { allowed: false as const, reason: "credits_exhausted" };
            }
            reservationId = hold.reservationId;
            return { allowed: true as const };
          } catch (error) {
            deps.log?.(
              `billing: opik_case_admission_failed event=${eventId} code=${
                error instanceof CreditReservationConflictError
                  ? "reservation_conflict"
                  : "credit_gate_failed"
              }`,
            );
            return {
              allowed: false as const,
              reason:
                error instanceof CreditReservationConflictError
                  ? "reservation_conflict"
                  : "credit_gate_failed",
            };
          }
        }
      : async () => ({ allowed: false as const, reason: "model_not_priced" });

    const outcome = await createProductionEvaluationCaseRunner({
      callModel: deps.callModel,
      admit,
      observe: deps.observe,
    })(context);

    // Never admitted: no hold exists, the runner already answered the refused case.
    if (!reservationId || !modelPolicy) return outcome;

    const base = {
      eventId,
      source: "llm" as const,
      externalCustomerId: deps.billing.externalCustomerId,
      model: modelName,
      client: EVALUATION_USAGE_CLIENT,
      occurredAt: new Date(),
    };

    if (outcome.status === "completed") {
      const detail = outcome.detail as
        | { inputTokens?: unknown; outputTokens?: unknown }
        | undefined;
      if (
        typeof detail?.inputTokens === "number" &&
        typeof detail?.outputTokens === "number"
      ) {
        try {
          const charged = calculateExactModelUsageCharge(modelPolicy, {
            inputTokens: detail.inputTokens,
            outputTokens: detail.outputTokens,
          });
          await deps.billing.outbox.record({
            ...base,
            transactionId: eventId,
            inputTokens: charged.inputTokens,
            outputTokens: charged.outputTokens,
            reservationId,
            actualCostNumerator: charged.actual.numerator.toString(),
            actualCostDenominator: charged.actual.denominator.toString(),
            botId: context.scope.botId,
            ownerUserId: context.scope.actorId,
          });
          return outcome;
        } catch (error) {
          const code =
            error instanceof UsageChargeError
              ? error.code
              : "usage_outbox_write_failed";
          // The tokens the gateway did report are real work this deployment will not
          // price (audit A3's discipline): they ride the evidence row, hold retained.
          await evidence({
            ...base,
            inputTokens: detail.inputTokens,
            outputTokens: detail.outputTokens,
            reason: code,
          });
          throw new EvaluationCaseSettlementError(code);
        }
      }
      // Usage never arrived: an unknown cost, never a zero. The evidence row carries no
      // reservation facts, so the credits target holds it for review while the Lago
      // target still meters the zero the call reported; the hold stays occupied.
      await evidence({
        ...base,
        inputTokens: 0,
        outputTokens: 0,
        reason: "usage_missing",
      });
      return outcome;
    }

    // A failed case is an unknown outcome, not a confirmed no-cost — see the module
    // head. Evidence row, hold retained; the runner's own failed detail stands.
    await evidence({
      ...base,
      inputTokens: 0,
      outputTokens: 0,
      reason:
        outcome.status === "failed" ? "provider_error" : "outcome_unknown",
    });
    return outcome;
  };
}
