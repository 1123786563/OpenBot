import { z } from "zod";
import type { SettledUsageProjection } from "./flexprice-usage";

const zero = z.union([z.literal(0), z.string().regex(/^0(?:\.0+)?$/)]);
const price = z.object({
  amount: zero,
  type: z.literal("USAGE"),
  billing_model: z.literal("FLAT_FEE"),
  price_unit_type: z.literal("FIAT"),
  meter_id: z.string(),
  currency: z.string(),
  status: z.literal("published"),
});
const storedEvent = z.object({
  status: z.enum(["processing", "processed", "failed"]),
  processed_events: z
    .array(
      z.object({
        customer_id: z.string(),
        subscription_id: z.string(),
        meter_id: z.string(),
      }),
    )
    .optional(),
  event: z.object({
    id: z.string(),
    event_name: z.string(),
    external_customer_id: z.string(),
    timestamp: z.iso.datetime({ offset: true }),
    source: z.string(),
    properties: z.record(z.string(), z.unknown()),
  }),
});

export function createFlexpriceUsageClient(options: {
  baseUrl: string;
  apiKey: string;
  customerId: string;
  externalCustomerId: string;
  meterId: string;
  subscriptionId: string;
}) {
  const origin = new URL(options.baseUrl);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.href !== `${origin.origin}/`
  )
    throw new Error("Flexprice URL must be an HTTP origin.");
  const eventName = "openbot_model_usage";
  const request = (path: string, init?: RequestInit) =>
    fetch(`${origin.origin}/v1${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": options.apiKey,
      },
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
  async function json(response: Response): Promise<unknown> {
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Flexprice request rejected with ${response.status}.`);
    }
    return response.json();
  }
  return {
    async verifyDestination() {
      const [customer, meter, subscription] = await Promise.all([
        request(`/customers/${encodeURIComponent(options.customerId)}`).then(
          json,
        ),
        request(`/meters/${encodeURIComponent(options.meterId)}`).then(json),
        request(
          `/subscriptions/${encodeURIComponent(options.subscriptionId)}`,
        ).then(json),
      ]);
      z.object({
        id: z.literal(options.customerId),
        external_id: z.literal(options.externalCustomerId),
        timezone: z.literal("UTC"),
        status: z.literal("published"),
      }).parse(customer);
      z.object({
        id: z.literal(options.meterId),
        event_name: z.literal(eventName),
        aggregation: z.object({
          type: z.literal("SUM"),
          field: z.literal("microcredits"),
          expression: z.string().max(0).optional(),
          multiplier: z.null().optional(),
        }),
        filters: z.array(z.unknown()).length(0),
        status: z.literal("published"),
      }).parse(meter);
      const destination = z
        .object({
          customer_id: z.literal(options.customerId),
          plan_id: z.string(),
          timezone: z.literal("UTC"),
          subscription_status: z.literal("active"),
          line_items: z.tuple([
            z.object({
              meter_id: z.literal(options.meterId),
              price: price.extend({ meter_id: z.literal(options.meterId) }),
            }),
          ]),
        })
        .parse(subscription);
      z.object({
        prices: z.tuple([
          price.extend({ meter_id: z.literal(options.meterId) }),
        ]),
      }).parse(
        await json(
          await request(`/plans/${encodeURIComponent(destination.plan_id)}`),
        ),
      );
    },
    async send(
      event: SettledUsageProjection,
    ): Promise<"matched" | "missing" | "pending" | "mismatch" | "rejected"> {
      const properties = {
        operation_id: event.operationId,
        resource: event.resource,
        input_tokens: event.inputTokens.toString(),
        output_tokens: event.outputTokens.toString(),
        microcredits: event.amountMicrocredits.toString(),
      };
      const query = new URLSearchParams({
        external_customer_id: options.externalCustomerId,
        start_time: new Date(event.occurredAt.getTime() - 1000).toISOString(),
        end_time: new Date(event.occurredAt.getTime() + 1000).toISOString(),
      });
      const read = async () => {
        const response = await request(
          `/events/${encodeURIComponent(event.eventId)}?${query}`,
        );
        if (response.status === 404) {
          await response.body?.cancel();
          return "missing";
        }
        const stored = storedEvent.safeParse(await json(response));
        if (!stored.success) return "mismatch";
        const actual = stored.data.event;
        const matches =
          actual.id === event.eventId &&
          actual.event_name === eventName &&
          actual.external_customer_id === options.externalCustomerId &&
          actual.source === "openbot" &&
          Date.parse(actual.timestamp) === event.occurredAt.getTime() &&
          Object.entries(properties).every(
            ([key, value]) => actual.properties[key] === value,
          );
        if (!matches) return "mismatch";
        if (stored.data.status === "processing") return "pending";
        if (stored.data.status === "failed") return "rejected";
        return stored.data.processed_events?.some(
          (row) =>
            row.customer_id === options.customerId &&
            row.subscription_id === options.subscriptionId &&
            row.meter_id === options.meterId,
        )
          ? "matched"
          : "mismatch";
      };
      const existing = await read();
      if (existing !== "missing") return existing;
      const response = await request("/events", {
        method: "POST",
        body: JSON.stringify({
          event_id: event.eventId,
          event_name: eventName,
          external_customer_id: options.externalCustomerId,
          timestamp: event.occurredAt.toISOString(),
          source: "openbot",
          properties,
        }),
      });
      if (response.status === 400 || response.status === 422) {
        await response.body?.cancel();
        const result = await read();
        return result === "missing" ? "rejected" : result;
      }
      await json(response);
      // 202 only acknowledges Kafka acceptance. Keep the durable delivery pending until readback.
      return read();
    },
  };
}
