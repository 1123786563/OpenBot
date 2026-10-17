import { describe, expect, test } from "../../tests/support/e2e-compat";
import { createHmac } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import type { AuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { requireAdmin } from "../src/auth/guards";
import type { CreditWriter } from "../src/billing/credits-writer";
import {
  createLagoClient,
  type LagoClient,
  type LagoEventPage,
  type LagoSubscriptionBody,
  type LagoUsageBody,
} from "../src/billing/lago";
import {
  createBillingAdminRoutes,
  createBillingRoutes,
  createBillingWebhookRoutes,
} from "../src/billing/routes";
import { createBillingService } from "../src/billing/service";
import { BillingError } from "../src/billing/types";
import { createWebhookVerifier } from "../src/billing/webhook-signature";
import { memoryBillingStore } from "./support/billing";
import type { ReconcileReport } from "../src/billing/types";

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

/** A recording double of the credit writer, shaped exactly like the real seam. */
function recordingCreditWriter() {
  const grants: unknown[] = [];
  return {
    grants,
    writer: {
      async grantCredits(input: {
        externalCustomerId: string;
        source: "promo" | "signin" | "plan";
        totalCents: number;
        expiresAt: Date;
        reason?: string | null;
        idempotencyKey?: string | null;
      }) {
        grants.push(input);
        return {
          inserted: true,
          grant: {
            id: `cg-${grants.length}`,
            externalCustomerId: input.externalCustomerId,
            source: input.source,
            reason: input.reason ?? null,
            total: input.totalCents,
            used: 0,
            grantedAt: "2026-10-11T00:00:00.000Z",
            expiresAt: input.expiresAt.toISOString(),
          },
        };
      },
    },
  };
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
    getSubscription: 0,
    postSubscription: 0,
    getUsage: 0,
    postEvent: 0,
    listEvents: 0,
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
  /** Every metered event the service sent, for asserting the metering chain end to end. */
  const postedEvents: unknown[] = [];
  /** What the provider's events list answers; null stands in for its unknown-subscription 404. */
  let eventPage: LagoEventPage | null = null;
  /**
   * What the provider's single-subscription read answers; null stands in for its gone-subscription
   * 404, and `failSubscription` makes the read throw the way an unreachable provider does.
   */
  let subscription: LagoSubscriptionBody | null = null;
  let failSubscription = false;
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
    async getSubscription(externalSubscriptionId) {
      calls.getSubscription += 1;
      if (failSubscription) throw new BillingError("unreachable");
      return subscription !== null &&
        subscription.externalSubscriptionId === externalSubscriptionId
        ? { status: 200, body: subscription }
        : { status: 404, body: null };
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
    async postEvent(event) {
      calls.postEvent += 1;
      postedEvents.push(event);
      return { status: 200, body: null };
    },
    async listEvents(externalSubscriptionId, _perPage, _page) {
      calls.listEvents += 1;
      if (eventPage === null) return { status: 404, body: null };
      return {
        status: 200,
        body: {
          events: eventPage.events.filter(
            (event) => event.externalSubscriptionId === externalSubscriptionId,
          ),
          totalCount: eventPage.totalCount,
          totalPages: eventPage.totalPages,
          currentPage: eventPage.currentPage,
          nextPage: eventPage.nextPage,
        },
      };
    },
  };
  return {
    calls,
    client,
    subscriptions,
    postedEvents,
    setUsage: (value: LagoUsageBody | null) => {
      usage = value;
    },
    setEventPage: (value: LagoEventPage | null) => {
      eventPage = value;
    },
    setSubscription: (value: LagoSubscriptionBody | null) => {
      subscription = value;
    },
    setSubscriptionFailure: (value: boolean) => {
      failSubscription = value;
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
    planEntitlements: new Map([
      ["pro", [{ code: "intelligence" }, { code: "teams" }]],
    ]),
  });
  return { store, service };
}

function serviceFixtureWithReconciler(
  client: LagoClient,
  reconcile: () => Promise<ReconcileReport>,
) {
  const store = memoryBillingStore();
  const service = createBillingService({
    config: { externalCustomerKey: DEPLOYMENT_KEY, webhookMode: "hmac" },
    client,
    store,
    verifier: undefined,
    reconciler: { reconcile },
    planEntitlements: new Map([
      ["pro", [{ code: "intelligence" }, { code: "teams" }]],
    ]),
  });
  return { store, service };
}

/** An app with the three billing groups mounted where app.ts mounts them. */
function billingApp(
  actor: AuthenticatedActor | undefined,
  client: LagoClient,
  creditWriter?: CreditWriter,
  reconcile?: () => Promise<ReconcileReport>,
) {
  const { service } = reconcile
    ? serviceFixtureWithReconciler(client, reconcile)
    : serviceFixture(client);
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
      ...(creditWriter ? { creditWriter } : {}),
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

  test("GET /entitlements carries the subscription context", async () => {
    const stub = countingClient();
    stub.setSubscription({
      externalCustomerId: DEPLOYMENT_KEY,
      externalSubscriptionId: `${DEPLOYMENT_KEY}-pro`,
      planCode: "pro",
      status: "active",
      currentPeriodStart: "2026-10-01T00:00:00Z",
      currentPeriodEnd: "2026-11-01T00:00:00Z",
    });
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
    // The exact body, keys and all: active, the plan code, the plan's entries and the period the
    // provider currently runs — and nothing else.
    expect(await response.json()).toEqual({
      active: true,
      planCode: "pro",
      codes: [{ code: "intelligence" }, { code: "teams" }],
      subscription: {
        status: "active",
        currentPeriodStart: "2026-10-01T00:00:00Z",
        currentPeriodEnd: "2026-11-01T00:00:00Z",
      },
    });
    expect(stub.calls.getSubscription).toBe(1);
  });

  test("GET /entitlements degrades to a null subscription when the provider refuses", async () => {
    const stub = countingClient();
    stub.setSubscriptionFailure(true);
    const { app } = billingApp(ADMIN, stub.client);
    const synced = await app.request("/api/admin/billing/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planCode: "pro" }),
    });
    expect(synced.status).toBe(200);

    // A provider that refuses the courtesy read does not fail the entitlement read itself: the
    // answer still gates the deployment, the period just reads as unknown.
    const response = await app.request("/api/billing/entitlements");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.subscription).toBeNull();
    expect(body.active).toBe(true);
  });
});

/*
 * The old usage routes (`/usage`, `/usage/events`) went with the old 用量 screens — no page asks
 * them any more, so neither their handlers nor these tests remain.
 */

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

  test("a credit grant lands on the deployment's customer and leaves an audit row", async () => {
    const recording = recordingCreditWriter();
    const { app, audit } = billingApp(ADMIN, countingClient().client, recording.writer as CreditWriter);
    const response = await app.request("/api/admin/billing/credits/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "promo",
        totalCents: 10_000,
        reason: "官方活动发放",
        expiresAt: "2026-11-01T00:00:00Z",
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { grant: { id: string } };
    expect(body.grant.id).toBe("cg-1");
    // The grant targeted the deployment's own customer key, not a caller-named one.
    expect(recording.grants[0]).toMatchObject({
      externalCustomerId: DEPLOYMENT_KEY,
      source: "promo",
      totalCents: 10_000,
      reason: "官方活动发放",
    });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ eventType: "billing.credits.granted" });
  });

  test("a grant refuses `plan` as a source and a non-administrator outright", async () => {
    const recording = recordingCreditWriter();
    const { app } = billingApp(ADMIN, countingClient().client, recording.writer as CreditWriter);
    const planSource = await app.request("/api/admin/billing/credits/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "plan", totalCents: 100 }),
    });
    expect(planSource.status).toBe(400);
    expect(recording.grants).toHaveLength(0);

    const memberApp = billingApp(MEMBER, countingClient().client, recording.writer as CreditWriter);
    const denied = await memberApp.app.request("/api/admin/billing/credits/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "promo", totalCents: 100 }),
    });
    expect(denied.status).toBe(403);
    expect(recording.grants).toHaveLength(0);
  });

  test("a grant body naming an account is refused: the writer's key is server-derived", async () => {
    // 02.4's write-side regression lock: the grant route derives the deployment key itself, so a
    // body that carries an account identity (someone else's userId or a bare externalCustomerId)
    // is a shape error answered 400, never a grant onto the named account.
    const recording = recordingCreditWriter();
    const { app } = billingApp(ADMIN, countingClient().client, recording.writer as CreditWriter);
    for (const foreign of [
      { source: "promo", totalCents: 100, externalCustomerId: "openbot-personal-someone-else" },
      { source: "promo", totalCents: 100, userId: "user-someone-else" },
    ]) {
      const response = await app.request("/api/admin/billing/credits/grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(foreign),
      });
      expect(response.status).toBe(400);
    }
    expect(recording.grants).toHaveLength(0);
  });

  test("without a credit writer wired, the grant route answers 503 and grants nothing", async () => {
    const { app } = billingApp(ADMIN, countingClient().client);
    const response = await app.request("/api/admin/billing/credits/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "promo", totalCents: 100 }),
    });
    expect(response.status).toBe(503);
  });

  test("reconcile returns usage pending and blocked counts distinctly and audits finding codes", async () => {
    const report: ReconcileReport = {
      ranAt: "2026-10-12T00:00:00.000Z",
      checked: {
        paidOrders: 1,
        appliedOrders: 1,
        creditCustomers: 1,
        usageDeliveryTargets: {
          pending: { lago: 0, credits: 2 },
          blocked: { lago: 1, credits: 0 },
        },
        usageFindings: {
          limit: 2,
          emitted: 2,
          omitted: 3,
        },
      },
      findings: [
        {
          category: "usage",
          code: "usage_target_pending",
          subject: "usage-event-1",
          detail:
            "target=credits state=pending attempt_age_seconds=3600 last_failure_code=provider_unavailable",
        },
        {
          category: "usage",
          code: "usage_target_blocked",
          subject: "usage-event-2",
          detail:
            "target=lago state=blocked attempt_age_seconds=7200 last_failure_code=invalid_response",
        },
        {
          category: "usage",
          code: "usage_findings_omitted",
          subject: "usage_outbox",
          detail:
            "omitted=3 pending_lago=0 pending_credits=2 blocked_lago=1 blocked_credits=0",
        },
      ],
    };
    const { app, audit } = billingApp(
      ADMIN,
      countingClient().client,
      undefined,
      async () => report,
    );

    const response = await app.request("/api/admin/billing/reconcile", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(report);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      eventType: "billing.reconciled",
      payload: {
        checked: report.checked,
        findingCounts: {
          usage_target_pending: 1,
          usage_target_blocked: 1,
          usage_findings_omitted: 1,
        },
      },
    });
  });
});
