import { describe, expect, test } from "bun:test";
import { createLagoHttpUsageClient } from "../src/billing/lago-client";
import type { LagoUsageProjection } from "../src/billing/lago-usage";

const event: LagoUsageProjection = {
  eventId: "8f6a1c2e-0000-4000-8000-000000000001",
  operationId: "op-97",
  resource: "glm-5.3-flash",
  inputTokens: 19n,
  outputTokens: 31n,
  amountMicrocredits: 9007199254740993n,
  occurredAt: new Date("2026-01-02T00:00:00.924Z"),
};

const properties = {
  operation_id: event.operationId,
  resource: event.resource,
  input_tokens: "19",
  output_tokens: "31",
  microcredits: "9007199254740993",
};

const stored = {
  transaction_id: event.eventId,
  external_subscription_id: "usage-only",
  code: "model-usage",
  timestamp: "2026-01-02T00:00:00.000Z",
  precise_total_amount_cents: "0.0",
  properties,
};

function client(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handler,
  });
  return {
    server,
    client: createLagoHttpUsageClient({
      baseUrl: server.url.origin,
      apiKey: "secret",
      metricCode: "model-usage",
      externalSubscriptionId: "usage-only",
    }),
  };
}

describe("Lago HTTP usage client", () => {
  test("replays the original event and verifies Lago's stored values", async () => {
    let posted: unknown;
    let reads = 0;
    const fixture = client(async (request) => {
      expect(request.headers.get("authorization")).toBe("Bearer secret");
      if (request.method === "POST") {
        expect(new URL(request.url).pathname).toBe("/api/v1/events");
        posted = await request.json();
        return Response.json({ event: { transaction_id: event.eventId } });
      }
      expect(new URL(request.url).pathname).toBe(
        `/api/v1/events/${event.eventId}`,
      );
      reads++;
      return posted
        ? Response.json({ event: stored })
        : new Response(null, { status: 404 });
    });
    try {
      await expect(fixture.client.send(event)).resolves.toBe("matched");
      expect(posted).toEqual({
        event: {
          transaction_id: event.eventId,
          external_subscription_id: "usage-only",
          code: "model-usage",
          timestamp: 1767312000,
          precise_total_amount_cents: "0",
          properties,
        },
      });
      await expect(fixture.client.send(event)).resolves.toBe("matched");
      expect(reads).toBe(3);
    } finally {
      await fixture.server.stop(true);
    }
  });

  test("separates a stored mismatch from delayed availability or an outage", async () => {
    let response = Response.json({
      event: { ...stored, properties: { ...properties, output_tokens: "32" } },
    });
    let posts = 0;
    const fixture = client((request) => {
      if (request.method === "POST") {
        posts++;
        return Response.json({ event: stored });
      }
      return response.clone();
    });
    try {
      await expect(fixture.client.send(event)).resolves.toBe("mismatch");
      expect(posts).toBe(0);
      response = Response.json({
        event: { ...stored, precise_total_amount_cents: "1.0" },
      });
      await expect(fixture.client.send(event)).resolves.toBe("mismatch");
      response = new Response(null, { status: 404 });
      await expect(fixture.client.send(event)).resolves.toBe("missing");
      expect(posts).toBe(1);
      response = new Response(null, { status: 503 });
      await expect(fixture.client.send(event)).rejects.toThrow("503");
      expect(posts).toBe(1);
    } finally {
      await fixture.server.stop(true);
    }
  });
  test("readback recovers an event stored before the POST acknowledgment was lost", async () => {
    let posts = 0;
    const fixture = client((request) => {
      if (request.method === "POST") {
        posts++;
        return new Response(null, { status: 503 });
      }
      return posts > 0
        ? Response.json({ event: stored })
        : new Response(null, { status: 404 });
    });
    try {
      await expect(fixture.client.send(event)).rejects.toThrow("503");
      await expect(fixture.client.send(event)).resolves.toBe("matched");
      expect(posts).toBe(1);
    } finally {
      await fixture.server.stop(true);
    }
  });

  test("keeps a duplicate invisible to readback pending and pauses a rejected event", async () => {
    let errors = { transaction_id: ["value_already_exist"] };
    const fixture = client((request) =>
      request.method === "POST"
        ? Response.json({ error_details: errors }, { status: 422 })
        : new Response(null, { status: 404 }),
    );
    try {
      await expect(fixture.client.send(event)).resolves.toBe("missing");
      errors = { transaction_id: ["invalid_format"] };
      await expect(fixture.client.send(event)).resolves.toBe("rejected");
    } finally {
      await fixture.server.stop(true);
    }
  });

  test("verifies a dedicated zero-rate plan and UTC aggregation before export", async () => {
    let timezone = "UTC";
    let fixedCharges: unknown[] = [];
    const plan = {
      code: "usage-plan",
      parent_id: null,
      amount_cents: 0,
      charges: [
        {
          billable_metric_code: "model-usage",
          charge_model: "standard",
          min_amount_cents: 0,
          filters: [],
          applied_pricing_unit: null,
          properties: { amount: "0" },
        },
      ],
    };
    const fixture = client((request) => {
      switch (new URL(request.url).pathname) {
        case "/api/v1/subscriptions/usage-only":
          return Response.json({
            subscription: { external_customer_id: "usage-customer", plan },
          });
        case "/api/v1/customers/usage-customer":
          return Response.json({ customer: { applicable_timezone: timezone } });
        case "/api/v1/billable_metrics/model-usage":
          return Response.json({
            billable_metric: {
              aggregation_type: "sum_agg",
              field_name: "microcredits",
              expression: null,
              recurring: false,
              rounding_function: null,
              filters: [],
            },
          });
        case "/api/v1/plans/usage-plan":
          return Response.json({
            plan: { ...plan, fixed_charges: fixedCharges },
          });
        default:
          return new Response(null, { status: 404 });
      }
    });
    try {
      await fixture.client.verifyDestination();
      timezone = "Asia/Shanghai";
      await expect(fixture.client.verifyDestination()).rejects.toThrow("UTC");
      timezone = "UTC";
      fixedCharges = [{ amount: "1" }];
      await expect(fixture.client.verifyDestination()).rejects.toThrow(
        "additional charges",
      );
    } finally {
      await fixture.server.stop(true);
    }
  });
});
