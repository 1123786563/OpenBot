import type { BillingService } from "./types";
import type { UsageOutbox, UsageOutboxRecord } from "./usage-outbox";

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
      },
    });
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
        }[] = [
          {
            name: "lago",
            pending: record.lagoStatus === "pending",
            effect: () => deps.sendToLago(record),
            markDelivered: () => outbox.markLagoDelivered(record.eventId),
          },
          {
            name: "credits",
            pending: record.creditsStatus === "pending",
            effect: () => deps.chargeCredits(record),
            markDelivered: () => outbox.markCreditsDelivered(record.eventId),
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
            await outbox.recordDeliveryFailure(
              record.eventId,
              target.name,
              code,
            );
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
