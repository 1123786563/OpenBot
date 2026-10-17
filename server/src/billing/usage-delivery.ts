/*
 * Terminal states (audit C1): a target whose failure a retry cannot fix ends in `blocked` on the
 * first attempt; a retryable failure ends in `blocked` only once the row is both exhausted
 * (MAX_DELIVERY_ATTEMPTS) and older than MIN_BLOCK_AGE_MS. `blocked` is TERMINAL either way.
 * Nothing in this module (or the sweeper that drives it) ever un-blocks a row: recovery is a
 * manual operator act against the reconciler's report.
 */
import type { BillingService } from "./types";
import type { CreditWriter } from "./credits-writer";
import type { UsageOutbox, UsageOutboxRecord } from "./usage-outbox";
import { UsageDeliveryError } from "./usage-delivery-error";

export { UsageDeliveryError } from "./usage-delivery-error";

export type UsageDeliveryTarget = "lago" | "credits";

export type UsageDeliveryResult = {
  examined: number;
  delivered: number;
  failed: number;
};

export type UsageDelivery = {
  runBatch(limit: number): Promise<UsageDeliveryResult>;
};

const STABLE_CODE = /^[a-z0-9_]{1,64}$/;

/** A target gives up after this many attempts: the row becomes evidence, not a hot loop. */
export const MAX_DELIVERY_ATTEMPTS = 8;

/**
 * How old a row must be before the attempt ceiling may end it. The ceiling alone is a trap:
 * eight attempts at the sweeper's 30-second interval is about four minutes, so one Lago outage
 * or one database failover would block a whole batch of chargeable events into a terminal state
 * that nothing in this codebase can undo. Attempts say "we keep failing"; age says "this is not
 * a blip". A row needs both before it stops being retried.
 */
export const MIN_BLOCK_AGE_MS = 24 * 3600_000;

/**
 * Failures a retry cannot fix (audit C1): no reservation facts to settle, a provider that says the
 * metric or subscription does not exist, a hold that is already terminal or was settled with a
 * different cost, and an event whose recorded facts contradict this one. Each ends the target in
 * `blocked` — the manual-review state reconciliation already reports — instead of retrying every
 * 30 seconds until somebody notices the pending count.
 */
export const NON_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "missing_reservation",
  "provider_refused",
  "reservation_conflict",
  "usage_outbox_conflict",
]);

/** Only a short snake_case code survives; anything else could carry payload or credentials. */
function failureCodeOf(error: unknown): string {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && STABLE_CODE.test(code)
    ? code
    : "delivery_failed";
}

const METRIC_BY_SOURCE = {
  llm: "llm_tokens",
  code_run: "code_run_tokens",
} as const;

function sourceSpecificProperties(record: UsageOutboxRecord) {
  if (record.source !== "code_run") return {};
  return {
    ...(record.runId ? { run_id: record.runId } : {}),
    ...(record.botId ? { bot_id: record.botId } : {}),
    ...(record.ownerUserId ? { owner_user_id: record.ownerUserId } : {}),
    ...(record.sessionId ? { session_id: record.sessionId } : {}),
    ...(record.status ? { status: record.status } : {}),
  };
}

/** The Lago target effect: persisted facts in, delivery-grade service call out. */
export function createLagoUsageTarget(
  billing: Pick<BillingService, "deliverUsage">,
): (record: UsageOutboxRecord) => Promise<void> {
  return (record) =>
    billing.deliverUsage({
      metricCode: METRIC_BY_SOURCE[record.source],
      transactionId: record.transactionId,
      externalCustomerId: record.externalCustomerId,
      timestamp: record.occurredAt,
      properties: {
        input_tokens: record.inputTokens,
        output_tokens: record.outputTokens,
        tokens: record.inputTokens + record.outputTokens,
        model: record.model,
        client: record.client,
        source: record.source,
        ...sourceSpecificProperties(record),
      },
    });
}

/** The credit target effect: settle the pre-call reservation from the persisted exact usage facts. */
export function createCreditUsageTarget(
  writer: Pick<CreditWriter, "settleReservation">,
): (record: UsageOutboxRecord) => Promise<void> {
  return async (record) => {
    if (
      !record.reservationId ||
      !record.actualCostNumerator ||
      !record.actualCostDenominator
    ) {
      throw new UsageDeliveryError("missing_reservation");
    }
    await writer.settleReservation({
      reservationId: record.reservationId,
      actual: {
        numerator: BigInt(record.actualCostNumerator),
        denominator: BigInt(record.actualCostDenominator),
      },
      title:
        record.source === "llm" ? "LLM token usage" : "Code run token usage",
      requestId: record.eventId,
      model: record.model,
      client: record.client,
    });
  };
}

/**
 * Delivers pending outbox rows one target at a time. Each target's result is persisted on its own,
 * so a failed target stays pending while its delivered sibling is never sent again. Target effects
 * are isolated from each other; outbox bookkeeping errors are not swallowed and surface after the
 * batch has been attempted.
 *
 * The credit effect is injected: production wiring waits for the outbox facts to carry the
 * reservation identity and exact actual cost the settlement needs.
 */
export function createUsageDelivery(deps: {
  outbox: UsageOutbox;
  sendToLago: (record: UsageOutboxRecord) => Promise<void>;
  chargeCredits: (record: UsageOutboxRecord) => Promise<void>;
  log?: (message: string) => void;
}): UsageDelivery {
  const { outbox } = deps;
  // biome-ignore lint/suspicious/noConsole: stable-code operational log
  const log = deps.log ?? ((message: string) => console.warn(message));

  return {
    async runBatch(limit) {
      const records = await outbox.pending(limit);
      const result: UsageDeliveryResult = {
        examined: records.length,
        delivered: 0,
        failed: 0,
      };
      const bookkeepingErrors: unknown[] = [];

      for (const record of records) {
        const targets: {
          name: UsageDeliveryTarget;
          pending: boolean;
          effect: () => Promise<void>;
          markDelivered: () => Promise<void>;
          block: (failureCode: string) => Promise<void>;
        }[] = [
          {
            name: "lago",
            pending: record.lagoStatus === "pending",
            effect: () => deps.sendToLago(record),
            markDelivered: () => outbox.markLagoDelivered(record.eventId),
            block: (failureCode) =>
              outbox.blockDelivery(record.eventId, "lago", failureCode),
          },
          {
            name: "credits",
            pending: record.creditsStatus === "pending",
            effect: () => deps.chargeCredits(record),
            markDelivered: () => outbox.markCreditsDelivered(record.eventId),
            block: (failureCode) =>
              outbox.blockDelivery(record.eventId, "credits", failureCode),
          },
        ];

        let effectFailed = false;
        let allDelivered = true;
        for (const target of targets) {
          if (!target.pending) continue;
          let effectError: unknown;
          let effectOk = false;
          try {
            await target.effect();
            effectOk = true;
          } catch (error) {
            effectError = error;
          }

          try {
            if (effectOk) {
              await target.markDelivered();
              continue;
            }
            effectFailed = true;
            allDelivered = false;
            const code = failureCodeOf(effectError);
            log(
              `billing: usage delivery failed event=${record.eventId} target=${target.name} code=${code}`,
            );
            if (NON_RETRYABLE_CODES.has(code)) {
              await target.block(code);
            } else {
              const { attempts } = await outbox.recordDeliveryFailure(
                record.eventId,
                target.name,
                code,
              );
              const ageMs = Date.now() - record.createdAt.getTime();
              if (
                attempts >= MAX_DELIVERY_ATTEMPTS &&
                ageMs > MIN_BLOCK_AGE_MS
              ) {
                log(
                  `billing: usage delivery exhausted event=${record.eventId} target=${target.name} attempts=${attempts} age_seconds=${Math.floor(ageMs / 1000)} code=${code}`,
                );
                await target.block(code);
              }
            }
          } catch (error) {
            allDelivered = false;
            bookkeepingErrors.push(error);
          }
        }

        if (effectFailed) result.failed += 1;
        else if (allDelivered) result.delivered += 1;
      }

      if (bookkeepingErrors.length === 1) throw bookkeepingErrors[0];
      if (bookkeepingErrors.length > 1) {
        throw new AggregateError(
          bookkeepingErrors,
          "Usage outbox bookkeeping failed",
        );
      }
      return result;
    },
  };
}
