import { z } from "zod";
import type { LagoUsageClient } from "./lago-usage";

const zeroMoney = z.union([z.literal(0), z.string().regex(/^0(?:\.0+)?$/)]);
const empty = z.array(z.unknown()).length(0);
const duplicateEvent = z.object({
  error_details: z.object({
    transaction_id: z.tuple([z.literal("value_already_exist")]),
  }),
});
const usageMetric = z.object({
  billable_metric: z.object({
    aggregation_type: z.literal("sum_agg"),
    field_name: z.literal("microcredits"),
    expression: z.null(),
    recurring: z.literal(false),
    rounding_function: z.null(),
    filters: empty,
  }),
});
const utcCustomer = z.object({
  customer: z.object({ applicable_timezone: z.enum(["UTC", "Etc/UTC"]) }),
});
const storedEvent = z.object({
  event: z.object({
    transaction_id: z.string(),
    external_subscription_id: z.string(),
    code: z.string(),
    timestamp: z.iso.datetime({ offset: true }),
    precise_total_amount_cents: zeroMoney,
    properties: z.record(z.string(), z.unknown()),
  }),
});

export function createLagoHttpUsageClient(options: {
  baseUrl: string;
  apiKey: string;
  metricCode: string;
  externalSubscriptionId: string;
}): LagoUsageClient & { verifyDestination(): Promise<void> } {
  const apiUrl = `${options.baseUrl.replace(/\/$/, "")}/api/v1`;
  const subscriptionId = encodeURIComponent(options.externalSubscriptionId);
  const headers = {
    Authorization: `Bearer ${options.apiKey}`,
    "Content-Type": "application/json",
  };
  const request = (path: string, init?: RequestInit) =>
    fetch(`${apiUrl}${path}`, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });

  async function json(response: Response) {
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Lago usage request rejected with ${response.status}.`);
    }
    const raw: unknown = await response.json();
    return raw;
  }

  return {
    async verifyDestination() {
      const zeroCharge = z.object({
        billable_metric_code: z.literal(options.metricCode),
        charge_model: z.literal("standard"),
        min_amount_cents: zeroMoney,
        filters: empty,
        applied_pricing_unit: z.null(),
        properties: z.object({ amount: zeroMoney }),
      });
      const zeroPlan = z.object({
        code: z.string().min(1),
        parent_id: z.null(),
        amount_cents: zeroMoney,
        charges: z.tuple([zeroCharge]),
        minimum_commitment: z.null().optional(),
      });
      const subscription = z.object({
        subscription: z.object({
          external_customer_id: z.string().min(1),
          plan: zeroPlan,
        }),
      });
      const destination = subscription.safeParse(
        await json(await request(`/subscriptions/${subscriptionId}`)),
      );
      if (!destination.success)
        throw new Error(
          "Lago usage subscription must use a dedicated zero-rate plan.",
        );
      const customerId = encodeURIComponent(
        destination.data.subscription.external_customer_id,
      );
      const planCode = encodeURIComponent(
        destination.data.subscription.plan.code,
      );
      const [customer, metric, plan] = await Promise.all([
        request(`/customers/${customerId}`).then(json),
        request(
          `/billable_metrics/${encodeURIComponent(options.metricCode)}`,
        ).then(json),
        request(`/plans/${planCode}`).then(json),
      ]);
      if (
        !z
          .object({ plan: zeroPlan.extend({ fixed_charges: empty }) })
          .safeParse(plan).success
      )
        throw new Error("Lago usage plan has additional charges.");
      if (
        !utcCustomer.safeParse(customer).success ||
        !usageMetric.safeParse(metric).success
      )
        throw new Error(
          "Lago usage requires a UTC customer and a microcredit sum metric.",
        );
    },

    async send(event) {
      const timestamp = Math.floor(event.occurredAt.getTime() / 1000);
      const properties = {
        operation_id: event.operationId,
        resource: event.resource,
        input_tokens: event.inputTokens.toString(),
        output_tokens: event.outputTokens.toString(),
        microcredits: event.amountMicrocredits.toString(),
      };
      const path = `/events/${encodeURIComponent(event.eventId)}`;
      const read = async () => {
        const response = await request(path);
        if (response.status === 404) {
          await response.body?.cancel();
          return "missing";
        }
        const stored = storedEvent.safeParse(await json(response));
        if (!stored.success) return "mismatch";
        const actual = stored.data.event;
        return actual.transaction_id === event.eventId &&
          actual.external_subscription_id === options.externalSubscriptionId &&
          actual.code === options.metricCode &&
          Date.parse(actual.timestamp) === timestamp * 1000 &&
          Object.entries(properties).every(
            ([key, value]) => actual.properties[key] === value,
          )
          ? "matched"
          : "mismatch";
      };

      const existing = await read();
      if (existing !== "missing") return existing;

      const response = await request("/events", {
        method: "POST",
        body: JSON.stringify({
          event: {
            transaction_id: event.eventId,
            external_subscription_id: options.externalSubscriptionId,
            code: options.metricCode,
            timestamp,
            precise_total_amount_cents: "0",
            properties,
          },
        }),
      });
      // Lago can return 422 for a duplicate when two exporters observe a missing
      // event. Read storage in either case before deciding whether replay worked.
      if (response.status === 422) {
        const duplicate = duplicateEvent.safeParse(
          await response.json().catch(() => undefined),
        ).success;
        const result = await read();
        return result === "missing" && !duplicate ? "rejected" : result;
      }
      if (!response.ok) await json(response);
      await response.body?.cancel();
      return read();
    },
  };
}
