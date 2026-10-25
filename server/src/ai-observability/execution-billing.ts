/**
 * The billing wiring of evaluation calls (Issue #31 / DAG T25).
 *
 * One evaluation case is one or, when the case declares a tool surface, up to
 * `EVALUATION_TOOL_LOOP_MAX_STEPS` metered model calls — and this module is where each
 * of them meets the deployment's ONE credit machinery, nothing here is a second
 * ledger. The wiring follows the built-in model-usage gate seam for seam:
 *
 *  - Admission: `reserveCredits` under the worst-case hold the frozen model's policy
 *    prices, BEFORE the gateway is dialed. A balance that cannot cover one call's
 *    ceiling, a model with no configured price, or a gate that cannot read the ledger
 *    all refuse — fail-closed, the provider is never invoked (T23's 402 doctrine,
 *    refined to the single call). For a tool loop the admission is asked BEFORE EVERY
 *    step (FREV-R2-01): step 0 rides the case's hold, each later step reserves its
 *    own, and a step whose ceiling is not spendable is never dialed — an overrun is
 *    refused at the step, not discovered by the pricing after the spend. R3-01 adds
 *    the input bound the same pre-dial doctrine owes: every request is counted
 *    against the policy's input maximum with the approved conservative counter and
 *    refused outright when it cannot fit — and the budget is lent to every priced
 *    case, the blank tool surface included, because the engine's own state tools
 *    make the business whitelist no answer to "can this case multi-step?".
 *  - Settlement: the gateway's own usage becomes one immutable usage-outbox fact with
 *    the reservation identity and the exact rational charge; the existing delivery
 *    sweep settles the hold downstream, exactly as the built-in path's calls do. A
 *    loop's steps settle one fact each, against the hold that admitted that step. The
 *    ledger stays the authority — the Opik-side projections and span observations are
 *    analysis copies and are never read back for charging.
 *  - Unknown cost: usage that never arrived, a call that threw, a charge the pricing
 *    refused — none of them become zero. The hold stays occupied (ADR-0003's pending
 *    settlement) and an evidence row names the case (a loop: the step). A thrown
 *    gateway call is an UNKNOWN outcome here, deliberately not the built-in path's
 *    released `provider_error`: this runner cannot observe "refused before the first
 *    token" — a timeout mid-generation throws the same — so no confirmed-no-cost is
 *    claimed.
 *
 * Idempotency rides the T24 write-ahead row's natural key — `(executionId, caseIndex)`
 * — as both the reservation's idempotency key and the outbox event id, so a replayed
 * or takeover-shaped re-run can neither dial the gateway twice nor charge twice: the
 * terminal reservation refuses re-admission, and a settlement replay answers the
 * first result. A loop's later steps key on that same natural key plus `:step:<n>`,
 * under the first step's hold as the fence.
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
  EVALUATION_INPUT_OVER_LIMIT,
  type EvaluationModelCall,
  type EvaluationModelCallObserver,
  type EvaluationStepBudget,
  type EvaluationStepUsage,
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
 * The event id (and reservation idempotency key) of one tool-loop step after the
 * first (FREV-R2-01): a case that spends several provider calls settles each step
 * against the hold that admitted it, and each fact needs its own natural key. Step 0
 * IS the case's first provider request and keeps {@link evaluationCaseUsageId}.
 */
export function evaluationCaseStepUsageId(
  executionId: string,
  caseIndex: number,
  step: number,
): string {
  return `${evaluationCaseUsageId(executionId, caseIndex)}:step:${step}`;
}

/**
 * The output ceiling one loop step's hold prices (FREV-R2-01). The policy's output
 * token maximum is exactly the output that `maximumReservationUnits` covers, so it is
 * what the step's request must carry: the provider cannot generate past the hold even
 * when the frozen configuration names no cap of its own.
 */
function stepOutputCeiling(
  policy: BillingModelCreditPolicyEntry,
): number | undefined {
  const maximum = policy.output.maximumTokens;
  if (maximum <= 0n) return undefined;
  return Number(
    maximum > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : maximum,
  );
}

/**
 * The input ceiling one step's request is counted against before it is dialed
 * (R3-01). The policy's input token maximum is the approved conservative bound a
 * request must fit — the counted input bound of ADR-0001, reused as-is rather than
 * a second measure — so a request the counter cannot fit is refused outright, not
 * sent for the provider's own tokenizer to reject after the spend.
 */
function stepInputCeiling(
  policy: BillingModelCreditPolicyEntry,
): number | undefined {
  const maximum = policy.input.maximumTokens;
  if (maximum <= 0n) return undefined;
  return Number(
    maximum > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : maximum,
  );
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
 * The token counts an exact charge can be priced from, or null when the cost must stay
 * unknown. T28 carries a case's usage as `unknown` — the runner's own raw record, or
 * the SafeValue envelope the T28 projection shapes (each count itself envelope-wrapped
 * one level) — so every honest spelling unwraps here, and each count must be a finite
 * number. An omitted or truncated envelope, a record without both counts, or a count
 * that is not a finite number yields null: unknown cost, never zero (the T25 ruling).
 */
export function exactTokensOf(usage: unknown): {
  inputTokens: number;
  outputTokens: number;
} | null {
  // One envelope level is all the projection produces; deeper wrapping is not billable.
  const counted = (value: unknown, unwrapped = false): number | null => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (unwrapped) return null;
    if (value !== null && typeof value === "object") {
      const envelope = value as { state?: unknown; value?: unknown };
      if (envelope.state === "projected") {
        return counted(envelope.value, true);
      }
    }
    return null;
  };
  const seen =
    usage !== null && typeof usage === "object" && !Array.isArray(usage)
      ? (usage as { state?: unknown; value?: unknown })
      : null;
  const record =
    seen?.state === "projected"
      ? seen.value
      : seen && !("state" in seen)
        ? seen
        : null;
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  const fields = record as Record<string, unknown>;
  const inputTokens = counted(fields.inputTokens);
  const outputTokens = counted(fields.outputTokens);
  return inputTokens !== null && outputTokens !== null
    ? { inputTokens, outputTokens }
    : null;
}

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
    // The moment the admission grants is the moment the call begins (the built-in
    // gate's clock): the usage fact timestamps the call, never its settlement
    // (T25-rev L-3).
    let callStartedAt = new Date();

    // FREV-R2-01: a case with a tool surface is up to
    // `EVALUATION_TOOL_LOOP_MAX_STEPS` provider calls, and one hold priced for a
    // single call cannot bound that spend. Step 0 rides the case-level hold below —
    // it IS this call's first provider request — and every later step reserves its
    // OWN hold through the budget, asked BEFORE the step is dialed: a balance that
    // cannot cover the next step refuses it there, instead of an overrun discovered
    // by the pricing at settlement, after the money was spent. Each step's usage is
    // recorded as the provider reported it and settled against the hold that admitted
    // it — the same credit writer, outbox and reservation semantics, per step.
    const stepHolds: {
      step: number;
      reservationId: string;
      startedAt: Date;
    }[] = [];
    const stepUsage: EvaluationStepUsage[] = [];
    // The step's enforced output ceiling: the exact amount of output the step's hold
    // prices (`maximumReservationUnits` covers input + output maxima), so a step can
    // never generate past what was reserved for it — not even when the frozen
    // configuration names no cap at all.
    const outputCeiling =
      modelPolicy === undefined ? undefined : stepOutputCeiling(modelPolicy);
    // The step's enforced input ceiling (R3-01): the policy's own input maximum. The
    // request the caller composed — prompt, history, tool results, tool schemas — is
    // counted against it with the approved conservative counter BEFORE every dial
    // and refused outright when it cannot fit; it is never sent for the provider's
    // tokenizer to reject after the spend.
    const inputCeiling =
      modelPolicy === undefined ? undefined : stepInputCeiling(modelPolicy);

    const holdAdmission = async (
      idempotencyKey: string,
      maximumCents: number,
    ) =>
      deps.billing.creditWriter.reserveCredits({
        externalCustomerId: deps.billing.externalCustomerId,
        idempotencyKey,
        maximumCents,
        expiresAt: new Date(Date.now() + windowMs),
      });

    // The admission the T24 runner asks for, answered by a real hold. The natural key
    // makes the reservation replay-safe: a still-reserved hold answers itself, and a
    // terminal one refuses — a settled case can never be invoked (or charged) again.
    const admit = modelPolicy
      ? async () => {
          try {
            const hold = await holdAdmission(
              `${USAGE_IDEMPOTENCY_KEY_PREFIX}${eventId}`,
              Number(modelPolicy.maximumReservationUnits),
            );
            if (!hold.reserved) {
              return { allowed: false as const, reason: "credits_exhausted" };
            }
            reservationId = hold.reservationId;
            callStartedAt = new Date();
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

    const stepBudget: EvaluationStepBudget | undefined =
      modelPolicy === undefined
        ? undefined
        : {
            ...(inputCeiling === undefined ? {} : { inputCeiling }),
            admit: async (stepIndex) => {
              if (stepIndex === 0) {
                // This step IS the case's first provider request: the case-level
                // admission above already holds its ceiling, and refuses the whole
                // call when it cannot. Nothing more to reserve — only the ceiling
                // the step must carry on the wire.
                return reservationId === undefined
                  ? { allowed: false as const, reason: "budget_refused" }
                  : {
                      allowed: true as const,
                      ...(outputCeiling === undefined
                        ? {}
                        : { maxOutputTokens: outputCeiling }),
                    };
              }
              const stepEventId = evaluationCaseStepUsageId(
                context.executionId,
                context.caseIndex,
                stepIndex,
              );
              try {
                const hold = await holdAdmission(
                  `${USAGE_IDEMPOTENCY_KEY_PREFIX}${stepEventId}`,
                  Number(modelPolicy.maximumReservationUnits),
                );
                if (!hold.reserved) {
                  // The next step's ceiling is not spendable: it is never dialed.
                  return {
                    allowed: false as const,
                    reason: "credits_exhausted",
                  };
                }
                stepHolds.push({
                  step: stepIndex,
                  reservationId: hold.reservationId,
                  startedAt: new Date(),
                });
                return {
                  allowed: true as const,
                  ...(outputCeiling === undefined
                    ? {}
                    : { maxOutputTokens: outputCeiling }),
                };
              } catch (error) {
                deps.log?.(
                  `billing: opik_case_step_admission_failed event=${stepEventId} code=${
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
            },
            record: (step) => {
              stepUsage.push(step);
            },
          };

    const outcome = await createProductionEvaluationCaseRunner({
      callModel: deps.callModel,
      admit,
      observe: deps.observe,
      ...(stepBudget === undefined ? {} : { stepBudget }),
    })(context);

    // Never admitted: no hold exists, the runner already answered the refused case.
    if (!reservationId || !modelPolicy) return outcome;

    const base = {
      source: "llm" as const,
      externalCustomerId: deps.billing.externalCustomerId,
      model: modelName,
      client: EVALUATION_USAGE_CLIENT,
    };

    // FREV-R2-01: a case that spent several provider calls is settled step by step —
    // each request against the hold that admitted it, each fact under its own natural
    // key. Step 0's fact keeps the case's own event id; later steps carry `:step:<n>`.
    if (stepUsage.length > 0 || stepHolds.length > 0) {
      const holds = new Map<
        number,
        { reservationId: string; startedAt: Date }
      >();
      holds.set(0, { reservationId, startedAt: callStartedAt });
      for (const hold of stepHolds) {
        holds.set(hold.step, {
          reservationId: hold.reservationId,
          startedAt: hold.startedAt,
        });
      }
      const usage = new Map(stepUsage.map((one) => [one.index, one]));
      const steps = [...new Set([...holds.keys(), ...usage.keys()])].sort(
        (left, right) => left - right,
      );
      for (const step of steps) {
        const stepEventId =
          step === 0
            ? eventId
            : evaluationCaseStepUsageId(
                context.executionId,
                context.caseIndex,
                step,
              );
        const stepBase = { ...base, eventId: stepEventId };
        const hold = holds.get(step);
        if (hold === undefined) {
          // Not reachable by construction (a step is recorded only after its hold);
          // silence would lose a spend, so the absence is logged rather than dropped.
          deps.log?.(
            `billing: opik_case_step_without_hold event=${stepEventId} step=${step}`,
          );
          continue;
        }
        const stepOccurredAt = { ...stepBase, occurredAt: hold.startedAt };
        const observed = usage.get(step);
        if (observed === undefined) {
          // A step whose hold was made but whose request never finished producing
          // usage: a failed or unknown outcome, never a confirmed no-cost. Hold
          // retained, evidence row written — the same rule the single-call path
          // applies to a thrown call.
          await evidence({
            ...stepOccurredAt,
            inputTokens: 0,
            outputTokens: 0,
            reason:
              outcome.status === "failed"
                ? "provider_error"
                : "outcome_unknown",
          });
          continue;
        }
        const tokens = exactTokensOf(observed);
        if (tokens === null) {
          // The provider reported no exact counts for this step: unknown cost, never
          // a zero. The hold stays occupied.
          await evidence({
            ...stepOccurredAt,
            inputTokens: 0,
            outputTokens: 0,
            reason: "usage_missing",
          });
          continue;
        }
        try {
          const charged = calculateExactModelUsageCharge(modelPolicy, tokens);
          await deps.billing.outbox.record({
            ...stepOccurredAt,
            transactionId: stepEventId,
            inputTokens: charged.inputTokens,
            outputTokens: charged.outputTokens,
            reservationId: hold.reservationId,
            actualCostNumerator: charged.actual.numerator.toString(),
            actualCostDenominator: charged.actual.denominator.toString(),
            botId: context.scope.botId,
            ownerUserId: context.scope.actorId,
          });
        } catch (error) {
          const code =
            error instanceof UsageChargeError
              ? error.code
              : "usage_outbox_write_failed";
          await evidence({
            ...stepOccurredAt,
            inputTokens: tokens.inputTokens,
            outputTokens: tokens.outputTokens,
            reason: code,
          });
          throw new EvaluationCaseSettlementError(code);
        }
      }
      return outcome;
    }

    const fact = { ...base, eventId, occurredAt: callStartedAt };

    if (outcome.status === "completed") {
      const tokens = exactTokensOf(outcome.usage);
      if (tokens) {
        try {
          const charged = calculateExactModelUsageCharge(modelPolicy, tokens);
          await deps.billing.outbox.record({
            ...fact,
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
            ...fact,
            inputTokens: tokens.inputTokens,
            outputTokens: tokens.outputTokens,
            reason: code,
          });
          throw new EvaluationCaseSettlementError(code);
        }
      }
      // Usage never arrived, or arrived in a shape no exact charge can price (an
      // envelope the projection did not fully carry): an unknown cost, never a zero.
      // The evidence row carries no reservation facts, so the credits target holds it
      // for review while the Lago target still meters the zero the call reported; the
      // hold stays occupied.
      await evidence({
        ...fact,
        inputTokens: 0,
        outputTokens: 0,
        reason: "usage_missing",
      });
      return outcome;
    }

    // A failed case is an unknown outcome, not a confirmed no-cost — see the module
    // head. Evidence row, hold retained; the runner's own failed detail stands. The
    // one failure this layer CAN name exactly is the budget's pre-dial input refusal
    // (R3-01): no provider saw the request, so the row says `input_over_limit`
    // instead of mislabelling it a provider error.
    await evidence({
      ...fact,
      inputTokens: 0,
      outputTokens: 0,
      reason:
        outcome.status === "failed"
          ? outcome.reason === EVALUATION_INPUT_OVER_LIMIT
            ? EVALUATION_INPUT_OVER_LIMIT
            : "provider_error"
          : "outcome_unknown",
    });
    return outcome;
  };
}
