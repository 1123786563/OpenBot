import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { createLagoClient } from "../src/billing/lago";
import { createBillingService } from "../src/billing/service";
import { createBillingStore } from "../src/billing/store";
import { BillingPersistenceError } from "../src/billing/types";
import { createWebhookVerifier } from "../src/billing/webhook-signature";
import type { Database } from "../src/db/client";
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
    if (method === "GET" && url.pathname.startsWith("/api/v1/customers/")) {
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

function webhookFixture(
  store = memoryBillingStore(),
  log?: (message: string) => void,
) {
  const stub = reReadStub();
  const client = createLagoClient({
    baseUrl: "https://lago.stub.test",
    apiKey: `stub-${"bearer"}`,
    fetch: stub.fetchStub,
    assertTarget: async () => {},
  });
  const service = createBillingService({
    config: { externalCustomerKey: "deployment-1", webhookMode: "hmac" },
    client,
    store,
    verifier: createWebhookVerifier({
      key: { mode: "hmac", key: WEBHOOK_SIGNING_KEY },
    }),
    planEntitlements: new Map([
      ["pro", [{ code: "intelligence" }, { code: "teams" }]],
    ]),
    ...(log ? { log } : {}),
  });
  return { stub, store, service };
}

/**
 * A delivery signed the way the provider signs, in the provider's own wire shape: the subject
 * object nested under a member named by `object_type`, and the event's identity in the
 * `X-Lago-Unique-Key` header — the body carries no `event_id` of its own (Webhooks::BaseService
 * builds the payload; webhook.rb's `generate_headers` sets the header).
 */
function signedDelivery(
  eventId: string,
  webhookType: string,
  object: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Request {
  const objectType = webhookType.split(".")[0] ?? "object";
  const body = JSON.stringify({
    webhook_type: webhookType,
    object_type: objectType,
    organization_id: "lago-org-1",
    [objectType]: { lago_id: `lago-${objectType}-1`, ...object },
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
      // The delivery's id: in the header, per the provider's own wire contract.
      "x-lago-unique-key": eventId,
      ...headers,
    },
    body,
  });
}

describe("createBillingService.handleWebhook", () => {
  test("a wrapped SQL transient failure returns fixed 503 and retries the whole delivery", async () => {
    const logged: string[] = [];
    const { stub, store, service } = webhookFixture(
      memoryBillingStore(),
      (message) => logged.push(message),
    );
    const failure = new DrizzleQueryError(
      "sensitive query",
      ["sensitive parameter"],
      new Bun.SQL.PostgresError("sensitive database failure", {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "40001",
      }),
    );
    const failedStore = createBillingStore({
      transaction: () => Promise.reject(failure),
    } as unknown as Database);
    const apply = store.applyWebhookProjection.bind(store);
    let failNext = true;
    store.applyWebhookProjection = (input) => {
      if (failNext) {
        failNext = false;
        return failedStore.applyWebhookProjection(input);
      }
      return apply(input);
    };
    stub.state.list = [
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "active",
      },
    ];
    const deliver = () =>
      signedDelivery("evt-wrapped-sql", "subscription.created", {
        external_customer_id: "deployment-1",
      });
    const first = await service.handleWebhook(deliver());
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({
      error: "Billing webhook could not be applied.",
    });
    expect(store.inbox.size).toBe(0);
    expect(store.customers.size).toBe(0);
    expect(store.subscriptions.size).toBe(0);
    expect(logged).toEqual(["billing: webhook failed — persistence_failure"]);
    const retry = await service.handleWebhook(deliver());
    expect(retry.status).toBe(200);
    expect(stub.state.reads).toBe(2);
    expect(store.inbox.size).toBe(1);
    expect(store.subscriptions.size).toBe(1);
  });

  test("an unsigned delivery is refused before anything else happens", async () => {
    const { stub, store, service } = webhookFixture();
    const response = await service.handleWebhook(
      new Request("https://openbot.example.test/api/billing/webhooks", {
        method: "POST",
        body: JSON.stringify({
          webhook_type: "customer.created",
          object_type: "customer",
          organization_id: "lago-org-1",
          customer: { lago_id: "lago-customer-1", external_id: "deployment-1" },
        }),
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

  test("an insert race reports duplicate only after refreshing the projection", async () => {
    const { stub, store, service } = webhookFixture();
    stub.state.list = [
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "active",
      },
    ];
    const applyWebhookProjection = store.applyWebhookProjection.bind(store);
    store.applyWebhookProjection = async (input) => {
      await applyWebhookProjection(input);
      return "duplicate";
    };

    const response = await service.handleWebhook(
      signedDelivery("evt-insert-race", "subscription.created", {
        external_customer_id: "deployment-1",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "duplicate" });
    expect(stub.state.reads).toBe(1);
    expect(store.subscriptions.size).toBe(1);
    expect(store.inbox.size).toBe(1);
  });

  test("concurrent deliveries commit once in the in-memory store too", async () => {
    const { stub, store, service } = webhookFixture();
    stub.state.list = [
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "active",
      },
    ];
    const responses = await Promise.all(
      [0, 1].map(() =>
        service.handleWebhook(
          signedDelivery("evt-memory-race", "subscription.created", {
            external_customer_id: "deployment-1",
          }),
        ),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(bodies.map((body) => body.status).sort()).toEqual([
      "duplicate",
      "processed",
    ]);
    expect(store.inbox.size).toBe(1);
    expect(store.customers.size).toBe(1);
    expect(store.subscriptions.size).toBe(1);
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
    expect(store.customers.size).toBe(0);

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

  test("a subscription projection write failure leaves the inbox empty and retries refresh", async () => {
    const { stub, store, service } = webhookFixture();
    stub.state.list = [
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "active",
      },
    ];
    const upsertSubscription = store.upsertSubscription.bind(store);
    let failNext = true;
    store.upsertSubscription = async (input) => {
      if (failNext) {
        failNext = false;
        throw new BillingPersistenceError("subscription_upsert");
      }
      return upsertSubscription(input);
    };

    const first = await service.handleWebhook(
      signedDelivery("evt-write", "subscription.created", {
        external_customer_id: "deployment-1",
      }),
    );
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({
      error: "Billing webhook could not be applied.",
    });
    expect(store.inbox.size).toBe(0);

    const retry = await service.handleWebhook(
      signedDelivery("evt-write", "subscription.created", {
        external_customer_id: "deployment-1",
      }),
    );
    expect(retry.status).toBe(200);
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

  test("an inbox write failure rolls back the projection and leaves the event replayable", async () => {
    const logged: string[] = [];
    const { stub, store, service } = webhookFixture(
      memoryBillingStore(),
      (message) => logged.push(message),
    );
    stub.state.list = [
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "active",
      },
    ];
    const recordWebhookEvent = store.recordWebhookEvent.bind(store);
    let failNext = true;
    store.recordWebhookEvent = async (input) => {
      if (failNext) {
        failNext = false;
        throw new BillingPersistenceError("webhook_record");
      }
      return recordWebhookEvent(input);
    };

    const first = await service.handleWebhook(
      signedDelivery("evt-inbox-write", "subscription.created", {
        external_customer_id: "deployment-1",
      }),
    );
    expect(first.status).toBe(503);
    expect(store.inbox.size).toBe(0);
    expect(store.subscriptions.size).toBe(0);
    expect(store.customers.size).toBe(0);

    const retry = await service.handleWebhook(
      signedDelivery("evt-inbox-write", "subscription.created", {
        external_customer_id: "deployment-1",
      }),
    );
    expect(retry.status).toBe(200);
    expect(stub.state.reads).toBe(2);
    expect(store.subscriptions.size).toBe(1);
    expect(store.inbox.size).toBe(1);
    expect(logged).toEqual(["billing: webhook failed — persistence_failure"]);
  });

  test("an unknown store error is not classified as retryable", async () => {
    const { stub, store, service } = webhookFixture();
    stub.state.list = [
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "active",
      },
    ];
    store.applyWebhookProjection = async () => {
      throw new Error("unexpected programming failure");
    };

    const response = await service.handleWebhook(
      signedDelivery("evt-programming-error", "subscription.created", {
        external_customer_id: "deployment-1",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Billing webhook could not be applied.",
    });
    expect(store.inbox.size).toBe(0);
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
        external_id: "deployment-1",
      }),
    );
    expect(response.status).toBe(200);
    expect(stub.state.customerReads).toBe(1);
    expect(store.customers.get("deployment-1")).toEqual({
      name: "Renamed Deployment",
    });
  });

  test("all authoritative reads finish before the local atomic operation starts", async () => {
    const { stub, store, service } = webhookFixture();
    stub.state.customers.set("deployment-1", "Authoritative Name");
    stub.state.list = [
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "terminated",
      },
    ];
    const applyWebhookProjection = store.applyWebhookProjection.bind(store);
    let applied = false;
    store.applyWebhookProjection = async (input) => {
      expect(stub.state.customerReads).toBe(1);
      expect(stub.state.reads).toBe(1);
      expect(store.customers.size).toBe(0);
      expect(store.subscriptions.size).toBe(0);
      expect(input).toMatchObject({
        customer: { externalId: "deployment-1", name: "Authoritative Name" },
        subscriptions: stub.state.list,
        event: { provider: "lago", eventId: "evt-atomic-read" },
      });
      applied = true;
      return applyWebhookProjection(input);
    };
    const response = await service.handleWebhook(
      signedDelivery("evt-atomic-read", "subscription.created", {
        external_customer_id: "deployment-1",
        status: "active",
      }),
    );
    expect(response.status).toBe(200);
    expect(applied).toBe(true);
    expect(store.subscriptions.get("deployment-1-sub")?.status).toBe(
      "terminated",
    );
  });

  test("records the delivery's idempotency key alongside the event", async () => {
    const { store, service } = webhookFixture();
    const response = await service.handleWebhook(
      signedDelivery(
        "evt-k",
        "invoice.created",
        {},
        {
          "x-lago-unique-key": "uk-1",
        },
      ),
    );
    expect(response.status).toBe(200);
    expect([...store.inbox.values()][0]?.uniqueKey).toBe("uk-1");
  });

  test("a delivery about an object with no projection is finished work", async () => {
    const { stub, store, service } = webhookFixture();
    const response = await service.handleWebhook(
      signedDelivery("evt-i", "invoice.created", {}),
    );
    expect(response.status).toBe(200);
    expect(stub.state.reads).toBe(0); // nothing to re-read
    expect(store.inbox.size).toBe(1);
  });

  test("a body over 1 MiB is refused with 413 before it is verified or buffered", async () => {
    const { stub, store, service } = webhookFixture();
    const bigBody = "a".repeat(1024 * 1024 + 1);
    // Correctly signed, so the refusal can only come from the size cap, not from verification.
    const request = new Request(
      "https://openbot.example.test/api/billing/webhooks",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lago-signature": createHmac("sha256", WEBHOOK_SIGNING_KEY)
            .update(bigBody)
            .digest("base64"),
          "x-lago-signature-algorithm": "hmac",
        },
        body: bigBody,
      },
    );
    const response = await service.handleWebhook(request);
    expect(response.status).toBe(413);
    expect(stub.state.reads).toBe(0); // no re-read was reached
    expect(store.inbox.size).toBe(0); // nothing was recorded
  });

  test("a subscription delivery naming no customer is refused, not guessed at", async () => {
    const { store, service } = webhookFixture();
    const response = await service.handleWebhook(
      signedDelivery("evt-b", "subscription.updated", {}),
    );
    expect(response.status).toBe(400);
    expect(store.inbox.size).toBe(0);
  });

  test("a signed delivery without the unique-key header has no identity, so no acceptance", async () => {
    const { store, service } = webhookFixture();
    const body = JSON.stringify({
      webhook_type: "customer.updated",
      object_type: "customer",
      organization_id: "lago-org-1",
      customer: { lago_id: "lago-customer-1", external_id: "deployment-1" },
    });
    const request = new Request(
      "https://openbot.example.test/api/billing/webhooks",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lago-signature": createHmac("sha256", WEBHOOK_SIGNING_KEY)
            .update(body)
            .digest("base64"),
          "x-lago-signature-algorithm": "hmac",
          // Deliberately no x-lago-unique-key: correctly signed bytes, but no event identity —
          // the provider always sends the header, so this is a probe, not a delivery.
        },
        body,
      },
    );
    const response = await service.handleWebhook(request);
    expect(response.status).toBe(401); // verified bytes, but an event that cannot be named
    expect(store.inbox.size).toBe(0);
  });

  test("a subscription delivery on a deployment with no customer row lands one first", async () => {
    // The foreign key the real database enforces: a subscription projection references the
    // customer projection. A subscription delivery can be the first thing a deployment receives —
    // configured but never synced — and it must still land, not die on a 23503 answered as a
    // terminal 400 that drops the event.
    const { stub, store, service } = webhookFixture();
    stub.state.list = [
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "active",
      },
    ];
    // No customer.reads were answered 200 and no customer row exists locally.
    const response = await service.handleWebhook(
      signedDelivery("evt-fk", "subscription.created", {
        external_customer_id: "deployment-1",
      }),
    );
    expect(response.status).toBe(200);
    // The placeholder: nameless, present, exactly what the foreign key needs.
    expect(store.customers.get("deployment-1")).toEqual({ name: null });
    expect([...store.subscriptions.values()]).toEqual([
      {
        externalCustomerId: "deployment-1",
        externalSubscriptionId: "deployment-1-sub",
        planCode: "pro",
        status: "active",
      },
    ]);
  });

  test("a service built without a verifier answers 503 (defence in depth for off deployments)", async () => {
    const service = createBillingService({
      config: { externalCustomerKey: "deployment-1", webhookMode: "off" },
      client: createLagoClient({
        baseUrl: "https://lago.stub.test",
        apiKey: `stub-${"bearer"}`,
        fetch: (async () =>
          new Response("{}", { status: 200 })) as typeof fetch,
        assertTarget: async () => {},
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
      codes: [{ code: "intelligence" }, { code: "teams" }],
      subscription: null,
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
