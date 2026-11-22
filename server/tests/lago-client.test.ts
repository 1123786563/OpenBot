import { describe, expect, test } from "bun:test";
import { createLagoHttpUsageClient } from "../src/billing/lago-client";
import type { LagoUsageProjection } from "../src/billing/lago-usage";

const event: LagoUsageProjection = {
  eventId: "8f6a1c2e-0000-4000-8000-000000000001",
  accountId: "account-97",
  operationId: "op-97",
  resource: "glm-5.3-flash",
  inputTokens: 19n,
  outputTokens: 31n,
  amountMicrocredits: 50n,
  occurredAt: new Date("2026-01-02T03:04:05Z"),
};

function client(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return createLagoHttpUsageClient({
    baseUrl: "https://lago.example",
    apiKey: "secret",
    metricCode: "model-usage",
    externalSubscriptionId: (accountId) => `openbot-sub-${accountId}`,
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) =>
      handler(String(url), init)) as unknown as typeof fetch,
  });
}

describe("Lago HTTP usage client", () => {
  test("maps the outbox projection onto a zero-amount usage event", async () => {
    let body: Record<string, unknown> | undefined;
    let headers: HeadersInit | undefined;
    const result = await client((url, init) => {
      body = JSON.parse(String(init?.body));
      headers = init?.headers;
      expect(url).toBe("https://lago.example/api/v1/events");
      return Response.json({ event: { transaction_id: event.eventId } });
    }).send(event);
    expect(result).toEqual({
      eventId: event.eventId,
      inputTokens: 19n,
      outputTokens: 31n,
      amountMicrocredits: 50n,
    });
    const sent = body?.event as Record<string, unknown>;
    expect(sent.transaction_id).toBe(event.eventId);
    expect(sent.external_customer_id).toBe("account-97");
    expect(sent.external_subscription_id).toBe("openbot-sub-account-97");
    expect(sent.code).toBe("model-usage");
    expect(sent.timestamp).toBe(Date.parse("2026-01-02T03:04:05Z") / 1000);
    expect(sent.properties).toEqual({
      operation_id: "op-97",
      resource: "glm-5.3-flash",
      input_tokens: "19",
      output_tokens: "31",
      microcredits: "50",
    });
    expect((headers as Record<string, string>).Authorization).toBe(
      "Bearer secret",
    );
  });

  test("refuses events Lago did not acknowledge", async () => {
    const failing = client(() => Response.json({}, { status: 503 }));
    await expect(failing.send(event)).rejects.toThrow("rejected with 503");
    const silent = client(() => Response.json({}));
    await expect(silent.send(event)).rejects.toThrow("not acknowledged");
  });
});
