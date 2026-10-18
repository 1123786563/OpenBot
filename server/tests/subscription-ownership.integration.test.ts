import { afterAll, afterEach, describe, expect, test } from "../../tests/support/bun-test-compat";
import { createHmac, randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { createLagoClient } from "../src/billing/lago";
import { createBillingService } from "../src/billing/service";
import { createBillingStore } from "../src/billing/store";
import type { PayerRef } from "../src/billing/payer";
import { payerKey } from "../src/billing/payer";
import type {
  PaymentProvider,
  PaymentProviderId,
} from "../src/billing/payments/provider";
import { createPaymentService } from "../src/billing/payments/service";
import { createPaymentStore } from "../src/billing/payments/store";
import type { PaymentFact } from "../src/billing/payments/provider";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createPlanRenewalGrantor } from "../src/billing/plan-renewals";
import { createReconciler } from "../src/billing/reconcile";
import { createWebhookVerifier } from "../src/billing/webhook-signature";
import { createDatabase, type Database } from "../src/db/client";
import {
  billingCustomers,
  billingSubscriptions,
} from "../src/db/schema/billing";
import { creditGrants } from "../src/db/schema/credits";
import { paymentOrders } from "../src/db/schema/payment";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Subscription ownership and renewal payout (ticket 10.3, AC14/Q27) against the dedicated
 * PostgreSQL test database. The rules under test:
 *
 * 1. The subscription projection row belongs to the payer the paid ORDER bound at creation
 *    (owner pair + allowance period, stamped by the activation path — the only writer that
 *    names ownership), and its plan allowance lands in that same personal account.
 * 2. A renewal notification credits the subscription's owner exactly once per period: the
 *    grant's idempotency key carries the period (`plan-renewal:<subId>:<periodStart>`), so a
 *    repeated delivery is a no-op while the NEXT period pays out again.
 * 3. Ownership cannot be rewritten: webhook projection refreshes and owner-less sync calls
 *    never touch the owner columns.
 * 4. Reconciliation compares per owner account: one account's live subscription must not
 *    mask another account's applied-order drift, and a grant landing in the wrong account
 *    is a finding, not an aggregate.
 *
 * The provider is a scripted fetch stub behind the real LagoClient; the payment channel is a
 * scripted fake behind the real PaymentProvider seam. Everything else — stores, services,
 * the credit writer, the webhook verifier — is the production code over the real database.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);
const billingStore = createBillingStore(database);
const paymentStore = createPaymentStore(database);
const creditWriter = createCreditWriter(database);

const prefix = `b5292-${randomUUID().slice(0, 8)}`;
const deploymentKey = `openbot-deployment-${prefix}`;
const WEBHOOK_SIGNING_KEY = `wh-${prefix}`;

/** Scaled units (×100): a 100-credit plan allowance, purchase and renewal alike. */
const PLAN_CREDIT_UNITS = 10_000;

/** The period the provider is currently running; the stub serves it on every read and create. */
const periods = {
  current: {
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-11-01T00:00:00.000Z",
  },
};

type StubSubscription = {
  externalCustomerId: string;
  externalSubscriptionId: string;
  planCode: string;
  status: "active" | "incomplete" | "canceled" | "terminated";
};

/** The provider stand-in: one switchable subscription list, the running period, plan facts. */
function lagoFetchStub() {
  const state = {
    list: [] as StubSubscription[],
    /** Counts of the reads the assertions care about. */
    subscriptionReads: 0,
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
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");

    if (method === "GET" && url.pathname === "/api/v1/subscriptions") {
      state.subscriptionReads += 1;
      const externalCustomerId = url.searchParams.get("external_customer_id") ?? "";
      const rows = state.list.filter(
        (subscription) => subscription.externalCustomerId === externalCustomerId,
      );
      return json(200, {
        subscriptions: rows.map((subscription) => ({
          lago_id: `lago-${subscription.externalSubscriptionId}`,
          external_id: subscription.externalSubscriptionId,
          external_customer_id: subscription.externalCustomerId,
          plan_code: subscription.planCode,
          status: subscription.status,
          current_billing_period_started_at: periods.current.start,
          current_billing_period_ending_at: periods.current.end,
        })),
      });
    }
    if (
      method === "GET" &&
      url.pathname.startsWith("/api/v1/subscriptions/")
    ) {
      state.subscriptionReads += 1;
      const externalId = decodeURIComponent(
        url.pathname.slice("/api/v1/subscriptions/".length),
      );
      const found = state.list.find(
        (subscription) => subscription.externalSubscriptionId === externalId,
      );
      if (!found) return json(404, { status: 404 });
      return json(200, {
        subscription: {
          lago_id: `lago-${found.externalSubscriptionId}`,
          external_id: found.externalSubscriptionId,
          external_customer_id: found.externalCustomerId,
          plan_code: found.planCode,
          status: found.status,
          current_billing_period_started_at: periods.current.start,
          current_billing_period_ending_at: periods.current.end,
        },
      });
    }
    if (method === "POST" && url.pathname === "/api/v1/subscriptions") {
      const body = JSON.parse(String(init?.body)) as {
        subscription: { external_customer_id: string; external_id: string; plan_code: string };
      };
      const created: StubSubscription = {
        externalCustomerId: body.subscription.external_customer_id,
        externalSubscriptionId: body.subscription.external_id,
        planCode: body.subscription.plan_code,
        status: "active",
      };
      state.list = state.list.filter(
        (row) => row.externalSubscriptionId !== created.externalSubscriptionId,
      );
      state.list.push(created);
      return json(200, {
        subscription: {
          lago_id: `lago-${created.externalSubscriptionId}`,
          external_id: created.externalSubscriptionId,
          external_customer_id: created.externalCustomerId,
          plan_code: created.planCode,
          status: created.status,
          current_billing_period_started_at: periods.current.start,
          current_billing_period_ending_at: periods.current.end,
        },
      });
    }
    if (method === "GET" && url.pathname.startsWith("/api/v1/plans/")) {
      return json(200, {
        plan: { interval: "monthly", amount_cents: 8800, amount_currency: "CNY" },
      });
    }
    if (method === "GET" && url.pathname.startsWith("/api/v1/customers/")) {
      const externalId = decodeURIComponent(
        url.pathname.slice("/api/v1/customers/".length),
      );
      return json(200, { customer: { external_id: externalId, name: null } });
    }
    return json(404, { status: 404 });
  }) as typeof fetch;
  return { state, fetchStub };
}

const stub = lagoFetchStub();
const lagoClient = createLagoClient({
  baseUrl: "https://lago.stub.test",
  apiKey: `stub-${prefix}`,
  fetch: stub.fetchStub,
  assertTarget: async () => {},
});

const logLines: string[] = [];
// The renewal payout, wired through the SAME production factory src/index.ts wires — the
// ledger key's composition (`plan-renewal:<subId>:<periodStart>`) is the factory's own tested
// code, so this rig can never drift from the assembly it mirrors.
const renewals = createPlanRenewalGrantor({
  creditsFor: (planCode: string) =>
    planCode.startsWith("pro") ? PLAN_CREDIT_UNITS : null,
  grantCredits: creditWriter.grantCredits,
});

const billingService = createBillingService({
  config: { externalCustomerKey: deploymentKey, webhookMode: "hmac" },
  client: lagoClient,
  store: billingStore,
  verifier: createWebhookVerifier({
    key: { mode: "hmac", key: WEBHOOK_SIGNING_KEY },
  }),
  planEntitlements: new Map([["pro", [{ code: "intelligence" }]]]),
  // The renewal payout, wired like index.ts: the account key comes from the row's owner pair,
  // the ledger key carries the period.
  renewals,
  log: (message) => logLines.push(message),
});

/** The plan-allowance payout, wired exactly as src/index.ts wires it (key `plan:<orderId>`). */
const grantor = {
  creditsFor: (planCode: string) =>
    planCode.startsWith("pro") ? PLAN_CREDIT_UNITS : null,
  grantPlanCredits: async (input: {
    externalCustomerId: string;
    planCode: string;
    orderId: string;
    totalCents: number;
    expiresAt: Date | null;
  }) => {
    if (input.expiresAt === null) return { inserted: false };
    const result = await creditWriter.grantCredits({
      externalCustomerId: input.externalCustomerId,
      source: "plan",
      totalCents: input.totalCents,
      expiresAt: input.expiresAt,
      reason: `plan allowance · ${input.planCode} · order ${input.orderId}`,
      idempotencyKey: `plan:${input.orderId}`,
    });
    return { inserted: result.inserted };
  },
  readCurrentPeriodEnd: async () => new Date(periods.current.end),
};

function fakePaidProvider(id: PaymentProviderId, fact: PaymentFact): PaymentProvider {
  return {
    id,
    createSession: async () => ({
      checkout: { kind: "qrcode", payload: `qr-${id}` },
    }),
    queryPayment: async (outTradeNo: string) => ({ outTradeNo, state: "pending" as const }),
    closePayment: async () => {},
    verifyNotification: async () => ({ ok: true as const, fact }),
    successAck: { body: "success", contentType: "text/plain" },
  };
}

/** One purchase-to-activation run over the real services; returns the paid order's id. */
async function purchaseAndPay(user: PayerRef, tag: string, planCode = "pro") {
  const channelTransactionId = `ch-${prefix}-${tag}`;
  const provider = fakePaidProvider("alipay", {
    outTradeNo: "",
    state: "paid",
    amountCents: 8800,
    currency: "CNY",
    channelTransactionId,
  });
  const payments = createPaymentService({
    providers: new Map([[provider.id, provider]]),
    store: paymentStore,
    catalog: new Map([
      ["pro", { amountCents: 8800, currency: "CNY", periodMonths: 1 }],
      ["pro-b", { amountCents: 8800, currency: "CNY", periodMonths: 1 }],
      ["pro-c", { amountCents: 8800, currency: "CNY", periodMonths: 1 }],
      ["pro-d", { amountCents: 8800, currency: "CNY", periodMonths: 1 }],
      ["pro-e", { amountCents: 8800, currency: "CNY", periodMonths: 1 }],
      ["pro-f", { amountCents: 8800, currency: "CNY", periodMonths: 1 }],
      ["pro-g", { amountCents: 8800, currency: "CNY", periodMonths: 1 }],
    ]),
    notifyBaseUrl: "https://payments.openbot.example",
    orderTtlMinutes: 15,
    latePaymentWindowHours: 24,
    acceptForeignCurrency: false,
    lago: {
      getPlan: async (planCode) => {
        const result = await lagoClient.getPlan(planCode);
        return result.status === 200 && result.body
          ? { found: true, interval: result.body.interval, currency: result.body.currency ?? undefined }
          : { found: false };
      },
      ensureSubscription: async (input) => billingService.ensureSubscription(input),
      // 10.3: the activation path stamps ownership; wired by the assembly like index.ts.
      stampSubscriptionOwnership: (input) => billingStore.stampSubscriptionOwnership(input),
    },
    externalCustomerKey: deploymentKey,
    // The single-subscription guard is 10.2's subject; these tests share one deployment key,
    // so the rig answers "not active" the same way the 10.2 rig does.
    activePlanCode: async () => null,
    invalidateEntitlementCache: () => billingService.invalidateEntitlementCache(deploymentKey),
    grantor,
    renewals,
    log: { warn: (message) => console.log(`[payments] ${message}`) },
  });
  const { order } = await payments.createPurchase({
    planCode,
    provider: "alipay",
    cycle: "monthly",
    createdBy: `${prefix}-${tag}`,
    ownerPayerRef: user,
  });
  provider.verifyNotification = async () => ({
    ok: true as const,
    fact: {
      outTradeNo: order.orderId,
      state: "paid" as const,
      amountCents: 8800,
      currency: "CNY",
      channelTransactionId,
    },
  });
  const outcome = await payments.handleCallback(
    "alipay",
    new Headers({ "content-type": "application/json" }),
    "{}",
  );
  return { orderId: order.orderId, outcome };
}

async function subscriptionRow(externalSubscriptionId: string) {
  const [row] = await database
    .select()
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.externalSubscriptionId, externalSubscriptionId))
    .limit(1);
  return row;
}

async function planGrantsFor(accountKey: string) {
  return database
    .select({
      idempotencyKey: creditGrants.idempotencyKey,
      total: creditGrants.total,
      externalCustomerId: creditGrants.externalCustomerId,
    })
    .from(creditGrants)
    .where(
      and(eq(creditGrants.source, "plan"), eq(creditGrants.externalCustomerId, accountKey)),
    )
    // PostgreSQL promises no row order without one, and the exact-array assertions below read
    // the account's grant history in payout order: the purchase first, then each period's
    // renewal. Granted-at carries that order (ties, two grants in the same microsecond, fall
    // to the unique key), so the assertion reads the timeline, not the heap's mood.
    .orderBy(creditGrants.grantedAt, creditGrants.idempotencyKey);
}

/** A signed subscription.* delivery in the provider's own wire shape. */
function signedDelivery(eventId: string, webhookType: string, object: Record<string, unknown>) {
  const body = JSON.stringify({
    webhook_type: webhookType,
    object_type: "subscription",
    organization_id: "lago-org-1",
    subscription: { lago_id: "lago-subscription-1", ...object },
  });
  return new Request("https://openbot.example.test/api/billing/webhooks/lago", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lago-signature": createHmac("sha256", WEBHOOK_SIGNING_KEY)
        .update(body)
        .digest("base64"),
      "x-lago-signature-algorithm": "hmac",
      "x-lago-unique-key": eventId,
    },
    body,
  });
}

afterEach(async () => {
  // The provider stand-in is module state: one test's live subscriptions and rolled-over period
  // must not answer the next test's sync/activation reads.
  stub.state.list = [];
  periods.current = {
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-11-01T00:00:00.000Z",
  };
  const pending = await database
    .select({ id: paymentOrders.id, version: paymentOrders.version })
    .from(paymentOrders)
    .where(
      and(
        like(paymentOrders.createdBy, `${prefix}%`),
        eq(paymentOrders.status, "pending"),
      ),
    );
  for (const order of pending) {
    await paymentStore.cancelOrder(order.id, order.version);
  }
});

/** Production boot syncs the deployment customer before any purchase; tests seed the same floor. */
async function seedDeploymentCustomer() {
  await billingStore.upsertCustomer({ externalId: deploymentKey, name: "OpenBot deployment test" });
}

afterAll(async () => {
  // Every account key and order carries the prefix, so one test's leftovers never answer another's.
  await database.delete(creditGrants).where(like(creditGrants.externalCustomerId, `%${prefix}%`));
  await database
    .delete(billingSubscriptions)
    .where(like(billingSubscriptions.externalCustomerId, `%${prefix}%`));
  await database
    .delete(billingSubscriptions)
    .where(like(billingSubscriptions.externalSubscriptionId, `${deploymentKey}-%`));
  await database.delete(paymentOrders).where(like(paymentOrders.createdBy, `${prefix}%`));
  // The customer rows the rig's floors and grants implied, last: credit_grants cascades on the
  // customer, and the deployment/stranger keys all carry the prefix. A shared test database
  // stays as clean as this file found it — whole-table scans in other files must not count us.
  await database
    .delete(billingCustomers)
    .where(like(billingCustomers.externalId, `%${prefix}%`));
  await database.$client.close();
});

describe("10.3 subscription ownership", () => {
  test("activation binds the subscription and its plan allowance to the order's personal account", async () => {
    await seedDeploymentCustomer();
    const userA = `${prefix}-user-a`;
    const { orderId, outcome } = await purchaseAndPay(
      { kind: "personal", id: userA },
      "a",
    );
    expect(outcome).toEqual({ kind: "success" });

    // Activation must have landed: a paid order whose activation failed would strand every
    // assertion below and say nothing about ownership.
    const order = await paymentStore.readOrder(orderId);
    expect(order?.activationState).toBe("applied");

    // The subscription projection row is owned by the paying user, with the paid period as
    // the allowance marker.
    const row = await subscriptionRow(`${deploymentKey}-pro`);
    expect(row).toBeDefined();
    expect(row?.ownerPayerKind).toBe("personal");
    expect(row?.ownerPayerId).toBe(userA);
    expect(row?.allowancePeriodStart?.toISOString()).toBe(periods.current.start);
    expect(row?.allowancePeriodEnd?.toISOString()).toBe(periods.current.end);

    // The purchase allowance landed in the SAME account the subscription belongs to.
    const grants = await planGrantsFor(payerKey({ kind: "personal", id: userA }));
    expect(grants).toHaveLength(1);
    expect(grants[0]?.idempotencyKey).toBe(`plan:${orderId}`);
  });

  test("a renewal notification pays the owner once per period; the next period pays again", async () => {
    await seedDeploymentCustomer();
    const userB = `${prefix}-user-b`;
    const { orderId } = await purchaseAndPay({ kind: "personal", id: userB }, "b", "pro-b");
    const subscriptionId = `${deploymentKey}-pro-b`;
    const ownerKey = payerKey({ kind: "personal", id: userB });

    // The provider's period has rolled over: the same subscription now runs November.
    periods.current = {
      start: "2026-11-01T00:00:00.000Z",
      end: "2026-12-01T00:00:00.000Z",
    };
    const delivery = () =>
      signedDelivery(`evt-renew-${randomUUID()}`, "subscription.updated", {
        external_customer_id: deploymentKey,
        external_id: subscriptionId,
        plan_code: "pro-b",
        status: "active",
      });
    const first = await billingService.handleWebhook(delivery());
    expect(first.status).toBe(200);

    // The renewal allowance landed on the OWNER's account, keyed with the new period.
    const renewalKey = `plan-renewal:${subscriptionId}:${periods.current.start}`;
    const afterFirst = await planGrantsFor(ownerKey);
    expect(afterFirst.map((grant) => grant.idempotencyKey)).toEqual([
      `plan:${orderId}`,
      renewalKey,
    ]);
    const row = await subscriptionRow(subscriptionId);
    expect(row?.allowancePeriodStart?.toISOString()).toBe(periods.current.start);
    expect(row?.allowancePeriodEnd?.toISOString()).toBe(periods.current.end);

    // A repeated notification of the SAME period (fresh event identity, same facts) is a no-op:
    // the ledger key carries the period, and the marker agrees.
    const second = await billingService.handleWebhook(delivery());
    expect(second.status).toBe(200);
    expect(await planGrantsFor(ownerKey)).toHaveLength(2);

    // The NEXT period pays out again — a period-tagged key never mistakes the next period's
    // renewal for a replay of the last one.
    periods.current = {
      start: "2026-12-01T00:00:00.000Z",
      end: "2027-01-01T00:00:00.000Z",
    };
    const third = await billingService.handleWebhook(delivery());
    expect(third.status).toBe(200);
    const afterThird = await planGrantsFor(ownerKey);
    expect(afterThird.map((grant) => grant.idempotencyKey)).toEqual([
      `plan:${orderId}`,
      renewalKey,
      `plan-renewal:${subscriptionId}:${periods.current.start}`,
    ]);
  });

  test("an ownerless subscription's renewal pays nobody (Q23: no guessed attribution)", async () => {
    await seedDeploymentCustomer();
    const subscriptionId = `${deploymentKey}-pro-orphan`;
    await billingStore.upsertSubscription({
      externalCustomerId: deploymentKey,
      externalSubscriptionId: subscriptionId,
      planCode: "pro-c",
      status: "active",
    });
    periods.current = {
      start: "2026-11-01T00:00:00.000Z",
      end: "2026-12-01T00:00:00.000Z",
    };
    const response = await billingService.handleWebhook(
      signedDelivery(`evt-orphan-${randomUUID()}`, "subscription.updated", {
        external_customer_id: deploymentKey,
        external_id: subscriptionId,
        plan_code: "pro-c",
        status: "active",
      }),
    );
    expect(response.status).toBe(200);
    // No renewal grant anywhere for this subscription: an ownerless row has no account to
    // pay, and the pass records the skip instead of guessing one.
    const renewalGrants = await database
      .select({ id: creditGrants.id })
      .from(creditGrants)
      .where(like(creditGrants.idempotencyKey, `plan-renewal:${subscriptionId}:%`));
    expect(renewalGrants).toHaveLength(0);
    // The marker did not advance either: the period stays uncovered, not silently consumed.
    const row = await subscriptionRow(subscriptionId);
    expect(row?.allowancePeriodStart).toBeNull();
  });

  test("the renewal sweep pays a period whose notification never arrived", async () => {
    await seedDeploymentCustomer();
    const userC = `${prefix}-user-c`;
    await purchaseAndPay({ kind: "personal", id: userC }, "c", "pro-c");
    const subscriptionId = `${deploymentKey}-pro-c`;
    const ownerKey = payerKey({ kind: "personal", id: userC });

    // The provider rolled to December and no webhook ever came; the sweep asks the provider
    // itself and covers the gap the notification path missed.
    periods.current = {
      start: "2026-12-01T00:00:00.000Z",
      end: "2027-01-01T00:00:00.000Z",
    };
    await billingService.sweepRenewals();

    const grants = await planGrantsFor(ownerKey);
    expect(grants.map((grant) => grant.idempotencyKey)).toEqual([
      expect.stringContaining("plan:"),
      `plan-renewal:${subscriptionId}:${periods.current.start}`,
    ]);
    const row = await subscriptionRow(subscriptionId);
    expect(row?.allowancePeriodStart?.toISOString()).toBe(periods.current.start);
  });

  test("a webhook refresh and an owner-less sync cannot rewrite the subscription's ownership", async () => {
    await seedDeploymentCustomer();
    const userRw = `${prefix}-user-rw`;
    const { orderId } = await purchaseAndPay(
      { kind: "personal", id: userRw },
      "rw",
      // A plan no other test in this file buys: two overlapping paid orders on one plan are
      // 10.2's duplicate refusal, and its evidence rows would pollute every assertion below.
      "pro-d",
    );
    const subscriptionId = `${deploymentKey}-pro-d`;
    const ownerKey = payerKey({ kind: "personal", id: userRw });
    const before = await subscriptionRow(subscriptionId);
    expect(before?.ownerPayerKind).toBe("personal");
    expect(before?.ownerPayerId).toBe(userRw);
    expect(before?.allowancePeriodStart?.toISOString()).toBe(
      periods.current.start,
    );

    // A signed subscription.* delivery refreshes the projection from the provider's own truth;
    // the wire carries no OpenBot identity and the fold's upsert names no owner column, so
    // ownership and the allowance marker must survive the refresh byte-for-byte.
    const refreshed = await billingService.handleWebhook(
      signedDelivery(`evt-rewrite-${randomUUID()}`, "subscription.updated", {
        external_customer_id: deploymentKey,
        external_id: subscriptionId,
        plan_code: "pro",
        status: "active",
      }),
    );
    expect(refreshed.status).toBe(200);
    const afterWebhook = await subscriptionRow(subscriptionId);
    expect(afterWebhook?.ownerPayerKind).toBe("personal");
    expect(afterWebhook?.ownerPayerId).toBe(userRw);
    expect(afterWebhook?.allowancePeriodStart?.toISOString()).toBe(
      periods.current.start,
    );
    expect(afterWebhook?.allowancePeriodEnd?.toISOString()).toBe(
      periods.current.end,
    );

    // The admin-sync shape (ensureSubscription) names no owner either: the fold it drives is a
    // projection write, never an ownership decision.
    const receipt = await billingService.ensureSubscription({
      externalCustomerId: deploymentKey,
      externalSubscriptionId: subscriptionId,
      planCode: "pro-d",
    });
    expect(receipt.externalSubscriptionId).toBe(subscriptionId);
    const afterSync = await subscriptionRow(subscriptionId);
    expect(afterSync?.ownerPayerKind).toBe("personal");
    expect(afterSync?.ownerPayerId).toBe(userRw);

    // Neither pass paid anyone a second time: only the activation's payout ever existed.
    const grants = await planGrantsFor(ownerKey);
    expect(grants.map((grant) => grant.idempotencyKey)).toEqual([
      `plan:${orderId}`,
    ]);
  });

  test("reconciliation compares per owner account; one account's live row cannot mask another's drift", async () => {
    await seedDeploymentCustomer();
    const userRa = `${prefix}-user-ra`;
    const userRb = `${prefix}-user-rb`;
    const { orderId: orderA } = await purchaseAndPay(
      { kind: "personal", id: userRa },
      "ra",
      "pro-f",
    );
    // The provider already runs a second live subscription on another plan; the fold accepts
    // what the provider holds, and the deployment-wide view now holds two live rows.
    stub.state.list.push({
      externalCustomerId: deploymentKey,
      externalSubscriptionId: `${deploymentKey}-pro-g`,
      planCode: "pro-g",
      status: "active",
    });
    const { orderId: orderB } = await purchaseAndPay(
      { kind: "personal", id: userRb },
      "rb",
      "pro-g",
    );
    const subscriptionB = `${deploymentKey}-pro-g`;

    // B's entitlement is lost: the projection holds no live row for B's owner pair any more —
    // the drift a person experiences as "paid but shown as free".
    await database
      .update(billingSubscriptions)
      .set({ status: "terminated" })
      .where(eq(billingSubscriptions.externalSubscriptionId, subscriptionB));
    // And B's allowance payout sits in a stranger's account — money that landed cross-account.
    // The stranger needs a customer row: the grants table's foreign key demands one, exactly as
    // a real misplaced payout would have had.
    const strangerKey = payerKey({
      kind: "personal",
      id: `${prefix}-user-stranger`,
    });
    await billingStore.upsertCustomer({ externalId: strangerKey, name: null });
    await database
      .update(creditGrants)
      .set({ externalCustomerId: strangerKey })
      .where(eq(creditGrants.idempotencyKey, `plan:${orderB}`));

    const reconciler = createReconciler(
      database,
      deploymentKey,
      (planCode) => (planCode.startsWith("pro") ? PLAN_CREDIT_UNITS : null),
    );
    const report = await reconciler.reconcile();
    const codesFor = (orderId: string) =>
      report.findings
        .filter((finding) => finding.subject === orderId)
        .map((finding) => finding.code);

    // B's missing subscription is named per owner account — A's live row masks nothing.
    expect(codesFor(orderB)).toContain("applied_without_subscription");
    expect(codesFor(orderA)).not.toContain("applied_without_subscription");
    // The cross-account payout is a finding on B's order, and A's correctly-placed grant
    // produces no mismatch of its own.
    expect(codesFor(orderB)).toContain("plan_grant_owner_mismatch");
    expect(codesFor(orderA)).not.toContain("plan_grant_owner_mismatch");
  });

  test("a superseded owner's expired order is history, not drift", async () => {
    await seedDeploymentCustomer();
    const userRe = `${prefix}-user-re`;
    const { orderId: orderOld } = await purchaseAndPay(
      { kind: "personal", id: userRe },
      "re",
      "pro-e",
    );
    // The order's paid window is long over: the person's entitlement legitimately ended, the
    // way every non-renewed subscription ends.
    await database
      .update(paymentOrders)
      .set({
        periodStart: new Date("2026-08-01T00:00:00.000Z"),
        periodEnd: new Date("2026-09-01T00:00:00.000Z"),
      })
      .where(eq(paymentOrders.id, orderOld));

    // A different person buys the same plan afterwards; activation re-stamps the one
    // subscription row to the new owner — the old owner's pair holds no live row now.
    const userRf = `${prefix}-user-rf`;
    await purchaseAndPay({ kind: "personal", id: userRf }, "rf", "pro-e");

    const reconciler = createReconciler(
      database,
      deploymentKey,
      (planCode) => (planCode.startsWith("pro") ? PLAN_CREDIT_UNITS : null),
    );
    const report = await reconciler.reconcile();
    const codesFor = (orderId: string) =>
      report.findings
        .filter((finding) => finding.subject === orderId)
        .map((finding) => finding.code);

    // The expired order is history, never a "paid but shown as free" finding: its paid window
    // is over, and the live row now belongs to the person who actually renewed.
    expect(codesFor(orderOld)).not.toContain("applied_without_subscription");
    expect(codesFor(orderOld)).not.toContain("plan_grant_owner_mismatch");
  });
});
