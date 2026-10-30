import { type UsageOutbox, UsageOutboxConflictError } from "./usage-outbox";

/**
 * The durable trace an UNSETTLED metered call leaves (audit A2/A3).
 *
 * A billed call whose cost could not be determined — the provider never reported usage, the
 * stream broke mid-answer, or the reported usage exceeded the configured bound — is not a free
 * call and is not a chargeable one. `CONTEXT.md` names the state: **Pending Settlement**, the
 * hold stays occupied until settlement or a confirmed no-cost. Retaining the hold is only half of
 * honest: the operator also needs a record that the call happened and what it looked like.
 *
 * The record rides the existing outbox rather than a new table. The row carries NO reservation
 * facts, so the credits target blocks it (`missing_reservation`, a terminal manual-review state)
 * and the Lago target still meters the tokens the provider did report. The reservation itself is
 * left `reserved`: it expires on its own clock and reconciliation reports it as
 * `expired_reserved_reservation`, naming this same event id (the reservation's idempotency key is
 * `usage:<eventId>`). One row, three existing findings, no new vocabulary.
 *
 * Never throws: this is evidence on a failure path, and a failed evidence write must not replace
 * the failure it describes. Both outcomes are logged by stable code, with no error message —
 * a driver error can carry connection details.
 */
export type UnsettledUsageInput = {
  eventId: string;
  source: "llm" | "code_run";
  externalCustomerId: string;
  model: string;
  client: string;
  occurredAt: Date;
  /** What the provider reported, when it reported anything; zero for an outcome we never learned. */
  inputTokens: number;
  outputTokens: number;
  /** The unsettled reason, stored in the outbox's free-text `status` column. */
  reason: string;
};

/**
 * The failure reasons that mean "confirmed no cost" — the only ones that may release a hold
 * (audit A2). Everything else is an unknown outcome: `CONTEXT.md` Pending Settlement and ADR-0003
 * both keep the reservation occupied until settlement or a confirmed no-cost. Lifted out of the
 * gate's closure into this module so the decision is a testable pure function, not a `Set` literal
 * buried in 4000 lines of assembly.
 */
export const CONFIRMED_NO_COST_REASONS: ReadonlySet<string> = new Set([
  "provider_error", // the provider refused before producing anything
  "bound_refused", // admission refused before the provider was called
  "no_usage", // the provider reported a finish with zero tokens
]);

export function isConfirmedNoCost(reason: string): boolean {
  return CONFIRMED_NO_COST_REASONS.has(reason);
}

export function createUsageEvidenceRecorder(
  outbox: Pick<UsageOutbox, "record">,
  log: (message: string) => void = (message) =>
    // biome-ignore lint/suspicious/noConsole: stable-code operational log
    console.warn(message),
): (input: UnsettledUsageInput) => Promise<void> {
  return async (input) => {
    try {
      await outbox.record({
        eventId: input.eventId,
        source: input.source,
        externalCustomerId: input.externalCustomerId,
        transactionId: input.eventId,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        model: input.model,
        client: input.client,
        occurredAt: input.occurredAt,
        reservationId: null,
        actualCostNumerator: null,
        actualCostDenominator: null,
        status: input.reason,
      });
    } catch (error) {
      if (error instanceof UsageOutboxConflictError) {
        // The event already holds different (real) facts: the settlement wrote them first, so
        // this evidence is superseded by something better. Not a failure.
        log(
          `billing: usage_evidence_superseded event=${input.eventId} reason=${input.reason}`,
        );
        return;
      }
      log(
        `billing: usage_evidence_write_failed event=${input.eventId} reason=${input.reason} code=${
          error instanceof Error ? error.name : "unknown"
        }`,
      );
    }
  };
}
