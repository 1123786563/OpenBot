import type { LagoUsageProjection } from "./lago-usage";

/**
 * The self-hosted Lago community edition only aggregates raw usage: every event
 * carries integer microcredits as units, and the money amount stays zero. The
 * billing account travels as Lago's external customer id so aggregation can be
 * per-account without leaking anything beyond the internal reference.
 */
export function createLagoHttpUsageClient(options: {
  baseUrl: string;
  apiKey: string;
  metricCode: string;
  /** Lago aggregates per subscription; map the account to its external id. */
  externalSubscriptionId: (accountId: string) => string;
  fetch?: typeof fetch;
}): {
  send: (event: LagoUsageProjection) => Promise<{
    eventId: string;
    inputTokens: bigint;
    outputTokens: bigint;
    amountMicrocredits: bigint;
  }>;
} {
  const fetcher = options.fetch ?? fetch;
  const eventsUrl = `${options.baseUrl.replace(/\/$/, "")}/api/v1/events`;
  return {
    async send(event) {
      const response = await fetcher(eventsUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event: {
            transaction_id: event.eventId,
            external_customer_id: event.accountId,
            external_subscription_id: options.externalSubscriptionId(
              event.accountId,
            ),
            code: options.metricCode,
            // Lago's events API takes whole epoch seconds, not ISO strings.
            timestamp: Math.floor(event.occurredAt.getTime() / 1000),
            properties: {
              operation_id: event.operationId,
              resource: event.resource,
              input_tokens: event.inputTokens.toString(),
              output_tokens: event.outputTokens.toString(),
              microcredits: event.amountMicrocredits.toString(),
            },
          },
        }),
      });
      if (!response.ok) {
        throw new Error(`Lago usage event rejected with ${response.status}.`);
      }
      const body: {
        event?: { transaction_id?: string; lago_id?: string };
      } = await response.json().catch(() => ({}));
      const eventId = body.event?.transaction_id;
      // Lago echoes the transaction id; the lago id additionally identifies the
      // stored row, which is what makes the acceptance unique per event.
      if (!eventId || (eventId !== event.eventId && body.event?.lago_id)) {
        throw new Error("Lago usage event was not acknowledged.");
      }
      return {
        eventId: event.eventId,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        amountMicrocredits: event.amountMicrocredits,
      };
    },
  };
}
