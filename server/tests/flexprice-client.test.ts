import { expect, test } from "bun:test";
import { createFlexpriceUsageClient } from "../src/billing/flexprice-client";
import type { SettledUsageProjection } from "../src/billing/flexprice-usage";

const event: SettledUsageProjection = {
  eventId: "event-1",
  operationId: "op-1",
  resource: "glm-4.7",
  inputTokens: 19n,
  outputTokens: 31n,
  amountMicrocredits: 9007199254740993n,
  occurredAt: new Date("2026-11-28T00:00:00.123Z"),
};
const price = {
  amount: "0",
  type: "USAGE",
  billing_model: "FLAT_FEE",
  price_unit_type: "FIAT",
  meter_id: "meter",
  currency: "usd",
  status: "published",
};
function fixture(
  options: { wrongPrice?: boolean; delayed?: boolean; mismatch?: boolean } = {},
) {
  let posts = 0;
  let stored: unknown;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("x-api-key")).toBe("private-key");
      const path = new URL(request.url).pathname;
      if (path === "/v1/customers/customer")
        return Response.json({
          id: "customer",
          external_id: "opaque-deployment",
          timezone: "UTC",
          status: "published",
        });
      if (path === "/v1/meters/meter")
        return Response.json({
          id: "meter",
          event_name: "openbot_model_usage",
          aggregation: { type: "SUM", field: "microcredits" },
          filters: [],
          status: "published",
        });
      if (path === "/v1/subscriptions/subscription")
        return Response.json({
          customer_id: "customer",
          plan_id: "plan",
          timezone: "UTC",
          subscription_status: "active",
          line_items: [{ meter_id: "meter", price }],
        });
      if (path === "/v1/plans/plan")
        return Response.json({
          prices: [{ ...price, amount: options.wrongPrice ? "1" : "0" }],
        });
      if (request.method === "POST") {
        expect(path).toBe("/v1/events");
        stored = await request.json();
        posts++;
        expect(stored).toEqual({
          event_id: event.eventId,
          event_name: "openbot_model_usage",
          external_customer_id: "opaque-deployment",
          timestamp: event.occurredAt.toISOString(),
          source: "openbot",
          properties: {
            operation_id: "op-1",
            resource: "glm-4.7",
            input_tokens: "19",
            output_tokens: "31",
            microcredits: "9007199254740993",
          },
        });
        return Response.json({}, { status: 202 });
      }
      expect(path).toBe("/v1/events/event-1");
      expect(
        new URL(request.url).searchParams.get("external_customer_id"),
      ).toBe("opaque-deployment");
      if (!stored || options.delayed)
        return new Response(null, { status: 404 });
      return Response.json({
        event: {
          id: options.mismatch ? "conflict" : event.eventId,
          event_name: "openbot_model_usage",
          external_customer_id: "opaque-deployment",
          timestamp: event.occurredAt.toISOString(),
          source: "openbot",
          properties: {
            operation_id: "op-1",
            resource: "glm-4.7",
            input_tokens: "19",
            output_tokens: "31",
            microcredits: "9007199254740993",
          },
        },
      });
    },
  });
  return {
    server,
    posts: () => posts,
    client: createFlexpriceUsageClient({
      baseUrl: server.url.origin,
      apiKey: "private-key",
      customerId: "customer",
      externalCustomerId: "opaque-deployment",
      meterId: "meter",
      subscriptionId: "subscription",
    }),
  };
}

test("Flexprice validates zero-price destination, reads back exact usage and replays without another POST", async () => {
  const f = fixture();
  try {
    await f.client.verifyDestination();
    expect(await f.client.send(event)).toBe("matched");
    expect(await f.client.send(event)).toBe("matched");
    expect(f.posts()).toBe(1);
  } finally {
    f.server.stop(true);
  }
});
test("Flexprice 202 is not treated as durable usage readback", async () => {
  const f = fixture({ delayed: true });
  try {
    expect(await f.client.send(event)).toBe("missing");
  } finally {
    f.server.stop(true);
  }
});
test("Flexprice conflicting stored event pauses instead of replacing data", async () => {
  const f = fixture({ mismatch: true });
  try {
    expect(await f.client.send(event)).toBe("mismatch");
    expect(await f.client.send(event)).toBe("mismatch");
    expect(f.posts()).toBe(1);
  } finally {
    f.server.stop(true);
  }
});
test("Flexprice rejects a plan that would charge money", async () => {
  const f = fixture({ wrongPrice: true });
  try {
    await expect(f.client.verifyDestination()).rejects.toThrow();
    expect(f.posts()).toBe(0);
  } finally {
    f.server.stop(true);
  }
});
