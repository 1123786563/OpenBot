import { describe, expect, test } from "bun:test";
import { createLagoClient } from "../src/billing/lago";
import { createOutboundGuard } from "../src/billing/outbound";
import { BillingError } from "../src/billing/types";

const BASE_URL = "https://lago.example.test";
const API_KEY = "lago-secret-key";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status });
}

/** A client whose fetch records every call and answers from one function. */
function clientWith(
  respond: (url: URL, init?: RequestInit) => Promise<Response> | Response,
) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetchStub = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const address = url instanceof URL ? url : new URL(String(url));
    seen.push({ url: address.toString(), init });
    return respond(address, init);
  }) as typeof fetch;
  const client = createLagoClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: fetchStub,
    // The gate is required by the type; these tests stub the transport itself, so a no-op stands in
    // for the resolver the real guard would run.
    assertTarget: async () => {},
  });
  return { client, seen };
}

/** Every error the client raises must name its sentinel and nothing it was told. */
async function expectCleanError(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(BillingError);
  const message = (error as Error).message;
  expect(message).not.toContain(API_KEY);
  expect(message).not.toContain(BASE_URL);
  expect(message).not.toContain("secret-token-from-body");
  expect(message).not.toContain("Service Unavailable");
  return error as BillingError;
}

describe("createLagoClient", () => {
  test("reads a customer from a 200 response", async () => {
    const { client } = clientWith(() =>
      jsonResponse({
        customer: { external_id: "deployment-1", name: "Deployment 1" },
      }),
    );
    const result = await client.getCustomer("deployment-1");
    expect(result).toEqual({
      status: 200,
      body: { externalId: "deployment-1", name: "Deployment 1" },
    });
  });

  test("sends the API key as a bearer and never as a query parameter", async () => {
    const { client, seen } = clientWith(() =>
      jsonResponse({ customer: { external_id: "deployment-1" } }),
    );
    await client.getCustomer("deployment-1");
    const call = seen[0];
    expect(call?.url).not.toContain(API_KEY);
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  test("asks for redirects to be refused, not followed", async () => {
    const { client, seen } = clientWith(() =>
      jsonResponse({ customer: { external_id: "deployment-1" } }),
    );
    await client.getCustomer("deployment-1");
    expect(seen[0]?.init?.redirect).toBe("error");
  });

  test("a fetch that returns a redirect anyway is treated as unreachable", async () => {
    const { client } = clientWith(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.test" },
        }),
    );
    const error = await expectCleanError(client.getCustomer("deployment-1"));
    expect(error.code).toBe("unreachable");
    expect(error.retryable).toBe(true);
  });

  test("a transport failure is unreachable, retryable, and says nothing it was told", async () => {
    const { client } = clientWith(() =>
      Promise.reject(
        new TypeError(`fetch failed for ${BASE_URL} with ${API_KEY}`),
      ),
    );
    const error = await expectCleanError(client.getCustomer("deployment-1"));
    expect(error.code).toBe("unreachable");
    expect(error.retryable).toBe(true);
  });

  test("an aborted request (the timeout path) is unreachable", async () => {
    const { client } = clientWith(() =>
      Promise.reject(
        new DOMException("The operation was aborted", "AbortError"),
      ),
    );
    const error = await expectCleanError(client.getCustomer("deployment-1"));
    expect(error.code).toBe("unreachable");
  });

  test.each([429, 502, 503])("HTTP %d is unreachable", async (status) => {
    const { client } = clientWith(() =>
      jsonResponse({ error: "secret-token-from-body" }, status),
    );
    const error = await expectCleanError(client.getCustomer("deployment-1"));
    expect(error.code).toBe("unreachable");
    expect(error.retryable).toBe(true);
  });

  test("a 400 is a terminal invalid_response", async () => {
    const { client } = clientWith(() =>
      jsonResponse({ error: "bad_request" }, 400),
    );
    const error = await expectCleanError(client.getCustomer("deployment-1"));
    expect(error.code).toBe("invalid_response");
    expect(error.retryable).toBe(false);
  });

  test("getCustomer passes a 404 through as an observable fact", async () => {
    const { client } = clientWith(() => jsonResponse({ status: 404 }, 404));
    const result = await client.getCustomer("deployment-1");
    expect(result).toEqual({ status: 404, body: null });
  });

  test.each([404, 400])(
    "listSubscriptions treats HTTP %d as invalid_response",
    async (status) => {
      const { client } = clientWith(() =>
        jsonResponse({ error: "no" }, status),
      );
      const error = await expectCleanError(
        client.listSubscriptions("deployment-1"),
      );
      expect(error.code).toBe("invalid_response");
    },
  );

  test("postCustomer passes a 422 through unclassified", async () => {
    const { client } = clientWith(() =>
      jsonResponse(
        { status: 422, error: "Validation failed: external_id" },
        422,
      ),
    );
    const result = await client.postCustomer({
      externalId: "deployment-1",
      name: "Deployment 1",
    });
    expect(result).toEqual({ status: 422, body: null });
  });

  test("postSubscription passes a 422 through unclassified", async () => {
    const { client } = clientWith(() =>
      jsonResponse({ status: 422, error: "Validation failed: plan_code" }, 422),
    );
    const result = await client.postSubscription({
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-sub",
      planCode: "pro",
    });
    expect(result).toEqual({ status: 422, body: null });
  });

  test("postSubscription sends the wire shape and nothing else", async () => {
    const { client, seen } = clientWith(() =>
      jsonResponse(
        {
          subscription: {
            lago_id: "lago-sub-1",
            external_id: "deployment-1-sub",
            external_customer_id: "deployment-1",
            plan_code: "pro",
            status: "active",
          },
        },
        201,
      ),
    );
    const result = await client.postSubscription({
      externalCustomerId: "deployment-1",
      externalSubscriptionId: "deployment-1-sub",
      planCode: "pro",
    });
    expect(result).toEqual({
      status: 201,
      body: {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "active",
      },
    });
    const sent = JSON.parse(String(seen[0]?.init?.body));
    expect(Object.keys(sent)).toEqual(["subscription"]);
    expect(Object.keys(sent.subscription).sort()).toEqual([
      "external_customer_id",
      "external_id",
      "plan_code",
    ]);
  });

  test("listSubscriptions neutralises the wire shape", async () => {
    const { client, seen } = clientWith(() =>
      jsonResponse({
        subscriptions: [
          {
            lago_id: "lago-sub-1",
            external_customer_id: "deployment-1",
            plan_code: "pro",
            status: "active",
          },
          {
            lago_id: "lago-sub-2",
            external_id: "deployment-1-old",
            external_customer_id: "deployment-1",
            plan_code: "starter",
            status: "terminated",
          },
        ],
        meta: { total_count: 2 },
      }),
    );
    const result = await client.listSubscriptions("deployment-1");
    expect(result).toEqual({
      status: 200,
      body: [
        {
          externalCustomerId: "deployment-1",
          externalSubscriptionId: "lago-sub-1",
          planCode: "pro",
          status: "active",
        },
        {
          externalCustomerId: "deployment-1",
          externalSubscriptionId: "deployment-1-old",
          planCode: "starter",
          status: "terminated",
        },
      ],
    });
    const query = new URL(seen[0]?.url ?? "").searchParams.getAll("status[]");
    expect(query).toEqual(["active", "incomplete", "canceled", "terminated"]);
    expect(
      new URL(seen[0]?.url ?? "").searchParams.get("external_customer_id"),
    ).toBe("deployment-1");
  });

  test("an unknown subscription status on the wire is invalid_response", async () => {
    const { client } = clientWith(() =>
      jsonResponse({
        subscriptions: [
          {
            lago_id: "lago-sub-1",
            external_customer_id: "deployment-1",
            plan_code: "pro",
            status: "pending",
          },
        ],
      }),
    );
    const error = await expectCleanError(
      client.listSubscriptions("deployment-1"),
    );
    expect(error.code).toBe("invalid_response");
  });

  test("a 2xx that is not JSON is invalid_response", async () => {
    const { client } = clientWith(() =>
      textResponse("<html>login page</html>"),
    );
    const error = await expectCleanError(client.getCustomer("deployment-1"));
    expect(error.code).toBe("invalid_response");
    expect(error.retryable).toBe(false);
  });

  test("a 2xx with a wrong shape is invalid_response", async () => {
    const { client } = clientWith(() =>
      jsonResponse({ customer: "deployment-1" }),
    );
    const error = await expectCleanError(client.getCustomer("deployment-1"));
    expect(error.code).toBe("invalid_response");
  });

  test("a body over 1 MiB is never read", async () => {
    const { client } = clientWith(() =>
      textResponse("a".repeat(1024 * 1024 + 1)),
    );
    const error = await expectCleanError(client.getCustomer("deployment-1"));
    expect(error.code).toBe("invalid_response");
  });

  test("a declared content-length over 1 MiB is refused before reading", async () => {
    const { client } = clientWith(
      () =>
        new Response(null, {
          status: 200,
          headers: { "content-length": String(1024 * 1024 + 1024) },
        }),
    );
    const error = await expectCleanError(client.getCustomer("deployment-1"));
    expect(error.code).toBe("invalid_response");
  });

  test("runs the SSRF gate on the exact URL it is about to open", async () => {
    const asked: string[] = [];
    const { client } = clientWith(() =>
      jsonResponse({ customer: { external_id: "deployment-1" } }),
    );
    const gated = createLagoClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: (async () =>
        jsonResponse({
          customer: { external_id: "deployment-1" },
        })) as typeof fetch,
      assertTarget: async (url) => {
        asked.push(url.toString());
      },
    });
    await gated.getCustomer("deployment-1");
    expect(asked).toEqual([`${BASE_URL}/api/v1/customers/deployment-1`]);
    await client.getCustomer("deployment-1");
  });

  test("a refused target surfaces rather than being swallowed into a sentinel", async () => {
    const refusal = new Error("target refused");
    const gated = createLagoClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: (async () => jsonResponse({})) as typeof fetch,
      assertTarget: async () => {
        throw refusal;
      },
    });
    await expect(gated.getCustomer("deployment-1")).rejects.toBe(refusal);
  });

  test("a guard's refusal is unconfigured and opens no request", async () => {
    let opened = 0;
    const gated = createLagoClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: (async () => {
        opened += 1;
        return jsonResponse({});
      }) as typeof fetch,
      // The real gate, with a resolver that answers like a host inside the deployment: the default
      // posture refuses it, and the refusal must become the non-retryable sentinel before fetch.
      assertTarget: createOutboundGuard({
        resolveDns: async () => [{ address: "127.0.0.1" }],
      }),
    });
    const error = await expectCleanError(gated.getCustomer("deployment-1"));
    expect(error.code).toBe("unconfigured");
    expect(error.retryable).toBe(false);
    expect(opened).toBe(0); // the gate ran before the transport, so nothing was sent
  });
});

describe("createLagoClient getUsage", () => {
  test("reads the current period's usage and neutralises the wire shape", async () => {
    const { client, seen } = clientWith(() =>
      jsonResponse({
        customer_usage: {
          from_datetime: "2026-10-01T00:00:00Z",
          to_datetime: "2026-10-31T23:59:59Z",
          currency: "USD",
          amount_cents: 10,
          total_amount_cents: 12,
          taxes_amount_cents: 2,
          charges_usage: [
            {
              units: "1",
              amount_cents: 10,
              billable_metric: { code: "api_calls", name: "API calls" },
            },
          ],
        },
      }),
    );
    const result = await client.getUsage("deployment-1", "deployment-1-pro");
    expect(result).toEqual({
      status: 200,
      body: {
        fromDatetime: "2026-10-01T00:00:00Z",
        toDatetime: "2026-10-31T23:59:59Z",
        currency: "USD",
        amountCents: 10,
        totalAmountCents: 12,
        charges: [
          {
            metricCode: "api_calls",
            metricName: "API calls",
            units: "1",
            amountCents: 10,
          },
        ],
      },
    });
    // The subscription rides as a query parameter and the customer id as the path, never the reverse.
    expect(seen[0]?.url).toBe(
      `${BASE_URL}/api/v1/customers/deployment-1/current_usage?external_subscription_id=deployment-1-pro`,
    );
  });

  test.each([404, 405])(
    "HTTP %d is a fact the projections already know, answered with no body",
    async (status) => {
      const { client } = clientWith(() =>
        jsonResponse({ status, error: "no active subscription" }, status),
      );
      const result = await client.getUsage("deployment-1", "deployment-1-pro");
      expect(result).toEqual({ status, body: null });
    },
  );

  test("a 500 is the retryable unreachable sentinel, not a usage answer", async () => {
    const { client } = clientWith(() => jsonResponse({}, 500));
    const error = await expectCleanError(
      client.getUsage("deployment-1", "deployment-1-pro"),
    );
    expect(error.code).toBe("unreachable");
  });
});

describe("createLagoClient subscription history folding", () => {
  test("a re-subscribed external id folds to its live record", async () => {
    const { client } = clientWith(() =>
      jsonResponse({
        subscriptions: [
          {
            lago_id: "lago-sub-new",
            external_customer_id: "deployment-1",
            external_id: "deployment-1-pro",
            plan_code: "pro",
            status: "active",
          },
          {
            // The lifecycle record the active one replaced: same external id, terminated. Whichever
            // order the provider answers in, the fold keeps the live record.
            lago_id: "lago-sub-old",
            external_customer_id: "deployment-1",
            external_id: "deployment-1-pro",
            plan_code: "pro",
            status: "terminated",
          },
        ],
      }),
    );
    const result = await client.listSubscriptions("deployment-1");
    expect(result.body).toEqual([
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-pro",
        planCode: "pro",
        status: "active",
      },
    ]);
  });

  test("distinct external ids are never folded", async () => {
    const { client } = clientWith(() =>
      jsonResponse({
        subscriptions: [
          {
            lago_id: "lago-sub-base",
            external_customer_id: "deployment-1",
            external_id: "deployment-1-base",
            plan_code: "base",
            status: "terminated",
          },
          {
            lago_id: "lago-sub-pro",
            external_customer_id: "deployment-1",
            external_id: "deployment-1-pro",
            plan_code: "pro",
            status: "active",
          },
        ],
      }),
    );
    const result = await client.listSubscriptions("deployment-1");
    expect(result.body).toHaveLength(2);
  });
});

describe("createLagoClient postEvent", () => {
  const EVENT = {
    transactionId: "llm-deployment-1-1730000000000-100-20",
    code: "llm_tokens",
    timestamp: 1730000000,
    externalSubscriptionId: "deployment-1-pro",
    properties: { input_tokens: 100, output_tokens: 20, tokens: 120 },
  };

  test.each([200, 202])("HTTP %d is an accepted event", async (status) => {
    const { client, seen } = clientWith(() => jsonResponse({}, status));
    const result = await client.postEvent(EVENT);
    expect(result).toEqual({ status, body: null });
    const init = seen[0]?.init;
    expect(init?.method).toBe("POST");
    const sent = JSON.parse(String(init?.body)) as {
      event: Record<string, unknown>;
    };
    expect(sent.event).toEqual({
      transaction_id: EVENT.transactionId,
      code: EVENT.code,
      timestamp: EVENT.timestamp,
      external_subscription_id: EVENT.externalSubscriptionId,
      properties: EVENT.properties,
    });
  });

  test.each([404, 422])(
    "HTTP %d is this deployment's mistake, answered without a throw",
    async (status) => {
      const { client } = clientWith(() =>
        jsonResponse({ status, error: "no such metric" }, status),
      );
      const result = await client.postEvent(EVENT);
      expect(result).toEqual({ status, body: null });
    },
  );

  test("a 500 is the retryable unreachable sentinel", async () => {
    const { client } = clientWith(() => jsonResponse({}, 500));
    const error = await expectCleanError(client.postEvent(EVENT));
    expect(error.code).toBe("unreachable");
  });
});

describe("createLagoClient listEvents", () => {
  test("reads the event page and neutralises the wire shape", async () => {
    const { client, seen } = clientWith(() =>
      jsonResponse({
        events: [
          {
            lago_id: "lago-evt-1",
            transaction_id: "llm-deployment-1-1-2-3",
            code: "llm_tokens",
            timestamp: "2026-10-10T04:32:50.000Z",
            external_subscription_id: "deployment-1-pro",
            properties: { tokens: 120, input_tokens: 100, output_tokens: 20 },
          },
        ],
        meta: {
          current_page: 2,
          next_page: 3,
          total_pages: 3,
          total_count: 61,
        },
      }),
    );
    const result = await client.listEvents("deployment-1-pro", 50, 2);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      events: [
        {
          transactionId: "llm-deployment-1-1-2-3",
          code: "llm_tokens",
          timestamp: "2026-10-10T04:32:50.000Z",
          externalSubscriptionId: "deployment-1-pro",
          properties: { tokens: 120, input_tokens: 100, output_tokens: 20 },
        },
      ],
      totalCount: 61,
      totalPages: 3,
      currentPage: 2,
      nextPage: 3,
    });
    expect(seen[0]?.url).toBe(
      `${BASE_URL}/api/v1/events?external_subscription_id=deployment-1-pro&per_page=50&page=2`,
    );
  });

  test("a null next_page is the last page, not a malformed answer", async () => {
    const { client } = clientWith(() =>
      jsonResponse({
        events: [],
        meta: {
          current_page: 3,
          next_page: null,
          total_pages: 3,
          total_count: 61,
        },
      }),
    );
    const result = await client.listEvents("deployment-1-pro", 50, 3);
    expect(result.body?.nextPage).toBeNull();
  });

  test("HTTP 404 is an unknown subscription, answered with no page", async () => {
    const { client } = clientWith(() => jsonResponse({}, 404));
    const result = await client.listEvents("deployment-1-pro", 50, 1);
    expect(result).toEqual({ status: 404, body: null });
  });
});
