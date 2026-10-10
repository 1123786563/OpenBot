import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import type { AuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { requireAdmin } from "../src/auth/guards";
import {
  createLagoClient,
  type LagoClient,
  type LagoUsageBody,
} from "../src/billing/lago";
import {
  createBillingAdminRoutes,
  createBillingRoutes,
  createBillingWebhookRoutes,
} from "../src/billing/routes";
import { createBillingService } from "../src/billing/service";
import { createWebhookVerifier } from "../src/billing/webhook-signature";
import { memoryBillingStore } from "./support/billing";

const WEBHOOK_SIGNING_KEY = `endpoint-${"hmac-key"}`;
// A stand-in provider credential, referenced everywhere and expected to appear nowhere.
const PROVIDER_API_KEY = `lago-${"secret-bearer-key"}`;
const DEPLOYMENT_KEY = "openbot-deployment-tenant-1";

const ADMIN: AuthenticatedActor = {
  id: "user-admin",
  email: "admin@openbot.test",
  role: "admin",
};
const MEMBER: AuthenticatedActor = {
  id: "user-member",
  email: "member@openbot.test",
  role: "user",
};

/** The session guard as a switch: an absent actor is the not-signed-in request. */
function requireUserAs(
  actor: AuthenticatedActor | undefined,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    if (!actor) {
      return context.json({ error: "Authentication required." }, 401);
    }
    context.set("actor", actor);
    await next();
  };
}

/** An audit store that records, so a test can assert the sync left its row. */
function recordingAudit() {
  const events: unknown[] = [];
  const store: AuditStore = {
    insert: async (event) => {
      events.push(event);
    },
  };
  return { events, store };
}

/**
 * A provider client built from the interface rather than a fetch stub, because these tests assert
 * the conversation the routes drive (which verbs, how many times), not the wire spelling of it.
 */
function countingClient() {
  const calls = {
    getCustomer: 0,
    postCustomer: 0,
    listSubscriptions: 0,
    postSubscription: 0,
    getUsage: 0,
  };
  const customers = new Map<string, string>();
  const subscriptions: {
    externalCustomerId: string;
    externalSubscriptionId: string;
    planCode: string;
    status: "active" | "incomplete" | "canceled" | "terminated";
  }[] = [];
  /** What the provider's current_usage endpoint answers; null stands in for its "no active" 405. */
  let usage: LagoUsageBody | null = null;
  const client: LagoClient = {
    async getCustomer(externalId) {
      calls.getCustomer += 1;
      return customers.has(externalId)
        ? {
            status: 200,
            body: { externalId, name: customers.get(externalId) ?? "" },
          }
        : { status: 404, body: null };
    },
    async postCustomer(input) {
      calls.postCustomer += 1;
      customers.set(input.externalId, input.name);
      return {
        status: 201,
        body: { externalId: input.externalId, name: input.name },
      };
    },
    async listSubscriptions(externalCustomerId) {
      calls.listSubscriptions += 1;
      return {
        status: 200,
        body: subscriptions.filter(
          (subscription) =>
            subscription.externalCustomerId === externalCustomerId,
        ),
      };
    },
    async postSubscription(input) {
      calls.postSubscription += 1;
      const subscription = { ...input, status: "active" as const };
      subscriptions.push(subscription);
      return { status: 201, body: subscription };
    },
    async getUsage() {
      calls.getUsage += 1;
      return usage === null
        ? { status: 405, body: null }
        : { status: 200, body: usage };
    },
  };
  return {
    calls,
    client,
    subscriptions,
    setUsage: (value: LagoUsageBody | null) => {
      usage = value;
    },
  };
}

function serviceFixture(client: LagoClient) {
  const store = memoryBillingStore();
  const service = createBillingService({
    config: { externalCustomerKey: DEPLOYMENT_KEY, webhookMode: "hmac" },
    client,
    store,
    verifier: undefined,
    planEntitlements: new Map([["pro", ["intelligence", "teams"]]]),
  });
  return { store, service };
}

/** An app with the three billing groups mounted where app.ts mounts them. */
function billingApp(actor: AuthenticatedActor | undefined, client: LagoClient) {
  const { service } = serviceFixture(client);
  const audit = recordingAudit();
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/api/billing/webhooks", createBillingWebhookRoutes({ service }));
  app.route(
    "/api/billing",
    createBillingRoutes({ service, requireUser: requireUserAs(actor) }),
  );
  app.route(
    "/api/admin/billing",
    createBillingAdminRoutes({
      service,
      requireUser: requireUserAs(actor),
      requireAdmin,
      audit: audit.store,
      externalCustomerKey: DEPLOYMENT_KEY,
      customerName: `OpenBot deployment ${DEPLOYMENT_KEY}`,
    }),
  );
  return { app, service, audit };
}

describe("the webhook routes", () => {
  /**
   * A re-read stub that answers a customer read, which is all a `customer.*` delivery needs. The
   * verifier is the one the assembly builds when a key is configured, so the route is exercised
   * against the same signature path production verifies with.
   */
  function webhookApp() {
    const fetchStub = (async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname.startsWith("/api/v1/customers/")) {
        return new Response(
          JSON.stringify({
            customer: {
              external_id: decodeURIComponent(
                url.pathname.slice("/api/v1/customers/".length),
              ),
              name: "Deployment 1",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ status: 404 }), { status: 404 });
    }) as typeof fetch;
    const client = createLagoClient({
      baseUrl: "https://lago.stub.test",
      apiKey: PROVIDER_API_KEY,
      fetch: fetchStub,
      assertTarget: async () => {},
    });
    const service = createBillingService({
      config: { externalCustomerKey: DEPLOYMENT_KEY, webhookMode: "hmac" },
      client,
      store: memoryBillingStore(),
      verifier: createWebhookVerifier({
        key: { mode: "hmac", key: WEBHOOK_SIGNING_KEY },
      }),
    });
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/api/billing/webhooks", createBillingWebhookRoutes({ service }));
    return app;
  }

  /**
   * A signed delivery in the provider's wire shape: the subject object nested under its
   * `object_type` member, and the event's identity in the `X-Lago-Unique-Key` header — the body
   * carries no `event_id` of its own. `external_customer_id` and `external_id` both name this
   * deployment because the caller only sends customer deliveries here; the verifier reads whichever
   * the object type carries.
   */
  function signedDelivery(eventId: string, webhookType: string) {
    const objectType = webhookType.split(".")[0] ?? "object";
    const body = JSON.stringify({
      webhook_type: webhookType,
      object_type: objectType,
      organization_id: "lago-org-1",
      [objectType]: {
        lago_id: `lago-${objectType}-1`,
        external_customer_id: DEPLOYMENT_KEY,
        external_id: DEPLOYMENT_KEY,
      },
    });
    return {
      method: "POST" as const,
      headers: {
        "content-type": "application/json",
        "x-lago-signature": createHmac("sha256", WEBHOOK_SIGNING_KEY)
          .update(body)
          .digest("base64"),
        "x-lago-signature-algorithm": "hmac",
        "x-lago-unique-key": eventId,
      },
      body,
    };
  }

  test("a bad signature is refused 401 with no session in front of it", async () => {
    const app = webhookApp();
    const body = JSON.stringify({
      webhook_type: "customer.created",
      object_type: "customer",
      organization_id: "lago-org-1",
      customer: {
        lago_id: "lago-customer-1",
        external_id: DEPLOYMENT_KEY,
        external_customer_id: DEPLOYMENT_KEY,
      },
    });
    const response = await app.request("/api/billing/webhooks/lago", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lago-signature": "not-a-real-signature",
        "x-lago-signature-algorithm": "hmac",
      },
      body,
    });
    expect(response.status).toBe(401);
    // The refusal is the verifier's, not a session guard's: no credential is asked of the provider.
    expect(await response.json()).toEqual({
      error: "Invalid billing webhook signature.",
    });
  });

  test("a redelivered event is answered 200 duplicate from the inbox alone", async () => {
    const app = webhookApp();
    const first = await app.request(
      "/api/billing/webhooks/lago",
      signedDelivery("evt-dup", "customer.created"),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "processed" });

    const second = await app.request(
      "/api/billing/webhooks/lago",
      signedDelivery("evt-dup", "customer.created"),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: "duplicate" });
  });

  test("a body over 1 MiB is refused 413 through the route, not just in the service", async () => {
    const app = webhookApp();
    const bigBody = "a".repeat(1024 * 1024 + 1);
    const response = await app.request("/api/billing/webhooks/lago", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lago-signature": createHmac("sha256", WEBHOOK_SIGNING_KEY)
          .update(bigBody)
          .digest("base64"),
        "x-lago-signature-algorithm": "hmac",
      },
      body: bigBody,
    });
    expect(response.status).toBe(413);
  });
});

describe("the entitlements route", () => {
  test("an unsigned-in request is refused 401", async () => {
    const { app } = billingApp(undefined, countingClient().client);
    const response = await app.request("/api/billing/entitlements");
    expect(response.status).toBe(401);
  });

  test("the answer's keys are exactly active and codes — no plan vocabulary", async () => {
    const stub = countingClient();
    const { app } = billingApp(ADMIN, stub.client);
    // A sync first, so the projection the entitlement read serves has an active plan in it — the
    // same chain a deployment drives: the admin presses Sync, everybody reads entitlements.
    const synced = await app.request("/api/admin/billing/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planCode: "pro" }),
    });
    expect(synced.status).toBe(200);

    const response = await app.request("/api/billing/entitlements");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["active", "codes"]);
    expect(body.active).toBe(true);
    expect(body.codes).toEqual(["intelligence", "teams"]);
  });
});

describe("the usage route", () => {
  test("an unsigned-in request is refused 401", async () => {
    const { app } = billingApp(undefined, countingClient().client);
    const response = await app.request("/api/billing/usage");
    expect(response.status).toBe(401);
  });

  test("no active subscription answers active false, with no provider call", async () => {
    const stub = countingClient();
    const { app } = billingApp(ADMIN, stub.client);
    const response = await app.request("/api/billing/usage");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ active: false, charges: [] });
    expect(stub.calls.getUsage).toBe(0);
  });

  test("the active subscription's period, amounts and charges — and no plan vocabulary", async () => {
    const stub = countingClient();
    stub.setUsage({
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
    });
    const { app } = billingApp(ADMIN, stub.client);
    // A sync first, so the projection the usage read serves has an active subscription in it.
    const synced = await app.request("/api/admin/billing/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planCode: "pro" }),
    });
    expect(synced.status).toBe(200);

    const response = await app.request("/api/billing/usage");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "active",
      "amountCents",
      "charges",
      "currency",
      "fromDatetime",
      "toDatetime",
      "totalAmountCents",
    ]);
    expect(body.active).toBe(true);
    expect(body.charges).toEqual([
      {
        metricCode: "api_calls",
        metricName: "API calls",
        units: "1",
        amountCents: 10,
      },
    ]);
    expect(stub.calls.getUsage).toBe(1);
  });
});

describe("the admin routes", () => {
  test("an unsigned-in request is refused 401, not 500: requireUser is in front of requireAdmin", async () => {
    const { app } = billingApp(undefined, countingClient().client);
    const snapshot = await app.request("/api/admin/billing");
    expect(snapshot.status).toBe(401);
    const sync = await app.request("/api/admin/billing/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planCode: "pro" }),
    });
    expect(sync.status).toBe(401);
  });

  test("a non-administrator is refused 403 on both verbs", async () => {
    const { app } = billingApp(MEMBER, countingClient().client);
    const snapshot = await app.request("/api/admin/billing");
    expect(snapshot.status).toBe(403);
    const sync = await app.request("/api/admin/billing/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planCode: "pro" }),
    });
    expect(sync.status).toBe(403);
  });

  test("the snapshot is the store's counts and the configured webhook mode", async () => {
    const stub = countingClient();
    const { app } = billingApp(ADMIN, stub.client);
    const response = await app.request("/api/admin/billing");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      customers: 0,
      subscriptions: 0,
      webhookMode: "hmac",
    });
  });

  test("a sync request of the wrong shape is refused 400 with a sentence of ours", async () => {
    const stub = countingClient();
    const { app } = billingApp(ADMIN, stub.client);
    const malformed = await app.request("/api/admin/billing/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planCode: "pro", extra: true }),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "Supply a valid request.",
    });
    expect(stub.calls.postCustomer).toBe(0);

    const notJson = await app.request("/api/admin/billing/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(notJson.status).toBe(400);
  });

  test("sync is read-before-create: pressing twice creates exactly one of each", async () => {
    const stub = countingClient();
    const { app, audit } = billingApp(ADMIN, stub.client);
    const first = await app.request("/api/admin/billing/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planCode: "pro" }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ synced: true });

    const second = await app.request("/api/admin/billing/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planCode: "pro" }),
    });
    expect(second.status).toBe(200);

    // One create of each, ever: the second pass read what the first wrote.
    expect(stub.calls.postCustomer).toBe(1);
    expect(stub.calls.postSubscription).toBe(1);
    // The audit row names the plan and who pressed; two presses, two rows.
    expect(audit.events.length).toBe(2);
  });

  test("an unreachable provider answers 503 and carries no credential in the body", async () => {
    const failingFetch = (async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const { app } = billingApp(
      ADMIN,
      createLagoClient({
        baseUrl: "https://lago.unreachable.test",
        apiKey: PROVIDER_API_KEY,
        fetch: failingFetch,
        assertTarget: async () => {},
      }),
    );
    const response = await app.request("/api/admin/billing/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planCode: "pro" }),
    });
    expect(response.status).toBe(503);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain(PROVIDER_API_KEY);
    expect(text).not.toContain("lago.unreachable.test");
  });
});
