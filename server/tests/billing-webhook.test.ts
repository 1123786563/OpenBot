import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createLagoClient } from "../src/billing/lago";
import { createBillingService } from "../src/billing/service";
import { createWebhookVerifier } from "../src/billing/webhook-signature";
import { memoryBillingStore } from "./support/billing";

// A stand-in signing key for the stub endpoint; referenced, never inlined at a call site.
const WEBHOOK_SIGNING_KEY = `endpoint-${"hmac-key"}`;

type StubSubscription = {
  externalCustomerId: string;
  externalSubscriptionId: string;
  planCode: string;
  status: "active" | "incomplete" | "canceled" | "terminated";
};

/**
 * A provider stand-in for the re-read path: the subscription list it serves is switchable between
 * calls, and `failNext` makes the next re-read fail the way a network failure fails.
 */
function reReadStub() {
  const state = {
    list: [] as StubSubscription[],
    customers: new Map<string, string>(),
    /** How many upcoming subscription reads fail at the transport level. */
    failNext: 0,
    reads: 0,
    customerReads: 0,
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchStub = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");

    if (method === "GET" && url.pathname === "/api/v1/subscriptions") {
      state.reads += 1;
      if (state.failNext > 0) {
        state.failNext -= 1;
        throw new TypeError("fetch failed");
      }
      return json(200, {
        subscriptions: state.list.map((subscription) => ({
          lago_id: `lago-sub-${subscription.externalSubscriptionId}`,
          external_id: subscription.externalSubscriptionId,
          external_customer_id: subscription.externalCustomerId,
          plan_code: subscription.planCode,
          status: subscription.status,
        })),
      });
    }
    if (
      method === "GET" &&
      url.pathname.startsWith("/api/v1/customers/")
    ) {
      state.customerReads += 1;
      const externalId = decodeURIComponent(
        url.pathname.slice("/api/v1/customers/".length),
      );
      const name = state.customers.get(externalId);
      return name
        ? json(200, { customer: { external_id: externalId, name } })
        : json(404, { status: 404 });
    }
    return json(404, { status: 404 });
  }) as typeof fetch;
  return { state, fetchStub };
}

function webhookFixture() {
  const stub = reReadStub();
  const client = createLagoClient({
    baseUrl: "https://lago.stub.test",
    apiKey: `stub-${"bearer"}`,
    fetch: stub.fetchStub,
    assertTarget: async () => {},
  });
  const store = memoryBillingStore();
  const service = createBillingService({
    config: { externalCustomerKey: "deployment-1", webhookMode: "hmac" },
    client,
    store,
    verifier: createWebhookVerifier({
      key: { mode: "hmac", key: WEBHOOK_SIGNING_KEY },
    }),
    planEntitlements: new Map([["pro", ["intelligence", "teams"]]]),
  });
  return { stub, store, service };
}

/** A delivery signed the way the provider signs, with the header overrides a test needs. */
function signedDelivery(
  eventId: string,
  webhookType: string,
  fields: Record<string, string> = {},
  headers: Record<string, string> = {},
): Request {
  const body = JSON.stringify({
    event_id: eventId,
    webhook_type: webhookType,
    ...fields,
  });
  return new Request("https://openbot.example.test/api/billing/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lago-signature": createHmac("sha256", WEBHOOK_SIGNING_KEY)
        .update(body)
        .digest("base64"),
      // The routing header: absent means jwt, and this deployment is hmac.
      "x-lago-signature-algorithm": "hmac",
      ...headers,
    },
    body,
  });
}

describe("createBillingService.handleWebhook", () => {
  test("an unsigned delivery is refused before anything else happens", async () => {
    const { stub, store, service } = webhookFixture();
    const response = await service.handleWebhook(
      new Request("https://openbot.example.test/api/billing/webhooks", {
        method: "POST",
        body: JSON.stringify({ event_id: "evt-1", webhook_type: "x" }),
      }),
    );
    expect(response.status).toBe(401);
    expect(stub.state.reads).toBe(0);
    expect(store.inbox.size).toBe(0);
  });

  test("a redelivered event is answered from the inbox alone: one re-read, ever", async () => {
    const { stub, service } = webhookFixture();
    stub.state.list = [
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "active",
      },
    ];
    const first = await service.handleWebhook(
      signedDelivery("evt-1", "subscription.created", {
        external_customer_id: "deployment-1",
      }),
    );
    expect(first.status).toBe(200);
    expect(stub.state.reads).toBe(1);

    const second = await service.handleWebhook(
      signedDelivery("evt-1", "subscription.created", {
        external_customer_id: "deployment-1",
      }),
    );
    expect(second.status).toBe(200);
    expect(stub.state.reads).toBe(1); // the inbox answered; the provider was not asked again
  });

  test("a re-read that fails transiently leaves no inbox row and is retried whole", async () => {
    const { stub, store, service } = webhookFixture();
    stub.state.list = [
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "active",
      },
    ];
    stub.state.failNext = 1;

    const first = await service.handleWebhook(
      signedDelivery("evt-1", "subscription.created", {
        external_customer_id: "deployment-1",
      }),
    );
    expect(first.status).toBe(503); // the provider is asked to retry the delivery
    expect(store.inbox.size).toBe(0); // nothing was recorded as done
    expect([...store.subscriptions.values()]).toEqual([]);

    const retry = await service.handleWebhook(
      signedDelivery("evt-1", "subscription.created", {
        external_customer_id: "deployment-1",
      }),
    );
    expect(retry.status).toBe(200);
    expect(stub.state.reads).toBe(2); // failed once, succeeded once
    expect(store.inbox.size).toBe(1);
    expect([...store.subscriptions.values()]).toEqual([
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "active",
      },
    ]);
  });

  test("an out-of-order delivery cannot walk a projection backwards", async () => {
    const { stub, store, service } = webhookFixture();
    stub.state.list = [
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "active",
      },
    ];
    await service.handleWebhook(
      signedDelivery("evt-new", "subscription.created", {
        external_customer_id: "deployment-1",
      }),
    );
    expect([...store.subscriptions.values()][0]?.status).toBe("active");

    // The authoritative object moved on; a stale event still arrives. The projection follows the
    // re-read, not the event's own view of the world.
    stub.state.list = [
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "terminated",
      },
    ];
    await service.handleWebhook(
      signedDelivery("evt-old", "subscription.terminated", {
        external_customer_id: "deployment-1",
      }),
    );
    expect([...store.subscriptions.values()][0]?.status).toBe("terminated");
  });

  test("a customer delivery refreshes the customer projection", async () => {
    const { stub, store, service } = webhookFixture();
    stub.state.customers.set("deployment-1", "Renamed Deployment");
    const response = await service.handleWebhook(
      signedDelivery("evt-c", "customer.updated", {
        external_customer_id: "deployment-1",
        object_id: "lago-customer-1",
      }),
    );
    expect(response.status).toBe(200);
    expect(stub.state.customerReads).toBe(1);
    expect(store.customers.get("deployment-1")).toEqual({
      name: "Renamed Deployment",
    });
  });

  test("records the delivery's idempotency key alongside the event", async () => {
    const { store, service } = webhookFixture();
    const response = await service.handleWebhook(
      signedDelivery(
        "evt-k",
        "invoice.created",
        { object_id: "lago-invoice-1" },
        { "x-lago-unique-key": "uk-1" },
      ),
    );
    expect(response.status).toBe(200);
    expect([...store.inbox.values()][0]?.uniqueKey).toBe("uk-1");
  });

  test("a delivery about an object with no projection is finished work", async () => {
    const { stub, store, service } = webhookFixture();
    const response = await service.handleWebhook(
      signedDelivery("evt-i", "invoice.created", {
        object_id: "lago-invoice-1",
      }),
    );
    expect(response.status).toBe(200);
    expect(stub.state.reads).toBe(0); // nothing to re-read
    expect(store.inbox.size).toBe(1);
  });

  test("a subscription delivery naming no customer is refused, not guessed at", async () => {
    const { store, service } = webhookFixture();
    const response = await service.handleWebhook(
      signedDelivery("evt-b", "subscription.updated", {
        object_id: "lago-sub-1",
      }),
    );
    expect(response.status).toBe(400);
    expect(store.inbox.size).toBe(0);
  });

  test("a service built without a verifier answers 503 (defence in depth for off deployments)", async () => {
    const service = createBillingService({
      config: { externalCustomerKey: "deployment-1", webhookMode: "off" },
      client: createLagoClient({
        baseUrl: "https://lago.stub.test",
        apiKey: `stub-${"bearer"}`,
        fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      }),
      store: memoryBillingStore(),
    });
    const response = await service.handleWebhook(
      new Request("https://openbot.example.test/api/billing/webhooks", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(503);
  });

  test("entitlements read the projection the webhook just refreshed", async () => {
    const { stub, service } = webhookFixture();
    stub.state.list = [
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "active",
      },
    ];
    await service.handleWebhook(
      signedDelivery("evt-1", "subscription.created", {
        external_customer_id: "deployment-1",
      }),
    );
    await expect(service.entitlements()).resolves.toEqual({
      active: true,
      planCode: "pro",
      codes: ["intelligence", "teams"],
    });
  });

  test("snapshot reports counts and the configured webhook mode", async () => {
    const { stub, service } = webhookFixture();
    stub.state.list = [
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "active",
      },
    ];
    stub.state.customers.set("deployment-1", "Deployment 1");
    await service.handleWebhook(
      signedDelivery("evt-c", "customer.updated", {
        external_customer_id: "deployment-1",
      }),
    );
    await service.handleWebhook(
      signedDelivery("evt-s", "subscription.created", {
        external_customer_id: "deployment-1",
      }),
    );
    const snapshot = await service.snapshot();
    expect(snapshot).toMatchObject({
      configured: true,
      customers: 1,
      subscriptions: 1,
      webhookMode: "hmac",
    });
    expect(typeof snapshot.lastSyncedAt).toBe("string");
  });

  test("reconcile refuses rather than half-working", async () => {
    const { service } = webhookFixture();
    await expect(service.reconcile()).rejects.toMatchObject({
      code: "unsupported",
      retryable: false,
    });
  });
});
