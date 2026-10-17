import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import type { PaymentProvider } from "../src/billing/payments/provider";
import { createPaymentService } from "../src/billing/payments/service";
import { createPaymentStore } from "../src/billing/payments/store";
import { createBillingStore } from "../src/billing/store";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createDatabase } from "../src/db/client";
import { paymentEvents, paymentOrders } from "../src/db/schema/payment";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * QA batch-2 probes (g)(h)(i) on REAL tables: the T5 semantics that carry restart and
 * cross-process subtleties an in-memory double cannot answer —
 *
 *   (g) failed-activation revival THROUGH THE REAL SWEEP QUERY (inArray pending+failed against
 *       real SQL), plus the alarm's restart semantics: the strike counter is process-local, but
 *       the (order_id, code) anomaly business key must keep the alarm ONE row per order across
 *       however many sweeps run.
 *   (h) the amount_unreadable endgame against the REAL partial index: strikes accumulate (the
 *       word is exempt from dedupe), the third strike blocks, and a FOURTH delivery on a blocked
 *       order is paid_after_blocked — the endgame actually ended.
 *   (i) the purchase guard's UNCACHED read against the real billing_subscriptions projection:
 *       a live row in the table refuses the purchase even while the cached read says nothing.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createPaymentStore(database);
const billingStore = createBillingStore(database);
const creditWriter = createCreditWriter(database);
const prefix = `qa2t5-${randomUUID().slice(0, 8)}`;
const planOf = () => `qa-plan-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await database.delete(paymentEvents).where(like(paymentEvents.orderId, `${prefix}%`));
  await database.delete(paymentOrders).where(like(paymentOrders.id, `${prefix}%`));
  await database.$client.close();
});

function providerFor(orderId: string, fact: Record<string, unknown>, id = "alipay"): PaymentProvider {
  return {
    id,
    async createSession() {
      return { checkout: { kind: "qrcode", payload: "qr" } };
    },
    async queryPayment() {
      return { outTradeNo: orderId, state: "pending" as const };
    },
    async closePayment() {},
    async verifyNotification() {
      return { ok: true as const, fact: { outTradeNo: orderId, state: "paid" as const, ...fact } };
    },
    successAck: { body: "success", contentType: "text/plain" },
  };
}

function serviceFor(provider: PaymentProvider, planCode: string) {
  return createPaymentService({
    providers: new Map([[provider.id, provider]]),
    store,
    catalog: new Map([[planCode, { amountCents: 8800, currency: "CNY", periodMonths: 1 }]]),
    notifyBaseUrl: "https://qa.example",
    orderTtlMinutes: 15,
    latePaymentWindowHours: 24,
    acceptForeignCurrency: false,
    lago: {
      async getPlan() {
        return { found: true, interval: "monthly", currency: "CNY" };
      },
      async ensureSubscription() {
        // The 7aff8dc5 contract: the facade always answers a period object (null fields mean
        // "provider stated no exact period", not "no answer at all").
        return { currentPeriodStart: null, currentPeriodEnd: null };
      },
    },
    externalCustomerKey: `${prefix}-deployment`,
    activePlanCode: async () => null,
    invalidateEntitlementCache: () => undefined,
    log: { warn: () => undefined },
  });
}

async function openOrder(planCode: string, provider: "alipay" | "wechat", tag: string) {
  const { order } = await store.insertOrder({
    planCode,
    provider,
    amountCents: 8800,
    currency: "CNY",
    expiresAt: new Date(Date.now() + 15 * 60_000),
    createdBy: `${prefix}-${tag}`,
    ownerPayerRef: { kind: "personal" as const, id: `${prefix}-${tag}` },
    checkoutPayload: null,
  });
  return order;
}

async function anomaliesOn(orderId: string, code?: string) {
  return database
    .select({ code: paymentEvents.code, detail: paymentEvents.detail })
    .from(paymentEvents)
    .where(
      code
        ? and(
            eq(paymentEvents.orderId, orderId),
            eq(paymentEvents.kind, "anomaly"),
            eq(paymentEvents.code, code),
          )
        : and(eq(paymentEvents.orderId, orderId), eq(paymentEvents.kind, "anomaly")),
    );
}

describe("probe g: failed activation revival through the real sweep query", () => {
  test("a failed order is picked up by listPaidPendingActivationOrders and lands applied", async () => {
    const plan = planOf();
    const order = await openOrder(plan, "alipay", "g");
    // First: a refusing gate marks it failed.
    const refusing = createPaymentService({
      providers: new Map([
        ["alipay", providerFor(order.id, { channelTransactionId: `${prefix}-tx-g`, amountCents: 8800 })],
      ]),
      store,
      catalog: new Map([[plan, { amountCents: 8800, currency: "CNY", periodMonths: 1 }]]),
      notifyBaseUrl: "https://qa.example",
      orderTtlMinutes: 15,
      latePaymentWindowHours: 24,
      acceptForeignCurrency: false,
      lago: {
        async getPlan() {
          return { found: false }; // the refusing verdict
        },
        async ensureSubscription() {
        // The 7aff8dc5 contract: the facade always answers a period object (null fields mean
        // "provider stated no exact period", not "no answer at all").
        return { currentPeriodStart: null, currentPeriodEnd: null };
      },
      },
      externalCustomerKey: `${prefix}-deployment`,
      activePlanCode: async () => null,
      invalidateEntitlementCache: () => undefined,
      log: { warn: () => undefined },
    });
    await refusing.handleCallback("alipay", new Headers(), "x");
    expect((await store.readOrder(order.id))?.activationState).toBe("failed");

    // The REAL store query must include the failed row (inArray pending+failed).
    const queued = await store.listPaidPendingActivationOrders(100);
    expect(queued.map((o) => o.id)).toContain(order.id);

    // A healthy service's sweep revives it: applied.
    const healthy = serviceFor(
      providerFor(order.id, { amountCents: 8800 }),
      plan,
    );
    await healthy.sweepActivations();
    expect((await store.readOrder(order.id))?.activationState).toBe("applied");
  });

  test("the alarm stays ONE row per order across many sweeps — the business key holds", async () => {
    const plan = planOf();
    const order = await openOrder(plan, "alipay", "g2");
    const refusing = createPaymentService({
      providers: new Map([
        ["alipay", providerFor(order.id, { channelTransactionId: `${prefix}-tx-g2`, amountCents: 8800 })],
      ]),
      store,
      catalog: new Map([[plan, { amountCents: 8800, currency: "CNY", periodMonths: 1 }]]),
      notifyBaseUrl: "https://qa.example",
      orderTtlMinutes: 15,
      latePaymentWindowHours: 24,
      acceptForeignCurrency: false,
      lago: {
        async getPlan() {
          return { found: false };
        },
        async ensureSubscription() {
        // The 7aff8dc5 contract: the facade always answers a period object (null fields mean
        // "provider stated no exact period", not "no answer at all").
        return { currentPeriodStart: null, currentPeriodEnd: null };
      },
      },
      externalCustomerKey: `${prefix}-deployment`,
      activePlanCode: async () => null,
      invalidateEntitlementCache: () => undefined,
      log: { warn: () => undefined },
    });
    await refusing.handleCallback("alipay", new Headers(), "x");

    // Six sweeps: the counter would fire the alarm at pass 3; passes 4-6 must NOT add rows —
    // the (order_id, code) partial unique index is the dam, process restart or not.
    for (let pass = 1; pass <= 6; pass += 1) {
      await refusing.sweepActivations();
    }
    const alarms = await anomaliesOn(order.id, "activation_retry_exhausted");
    expect(alarms.length).toBe(1);
    expect(alarms[0]?.detail).toContain(order.planCode);
  });
});

describe("probe h: the amount_unreadable endgame against the real partial index", () => {
  test("three unreadable strikes block; further deliveries never reopen the order", async () => {
    const plan = planOf();
    const order = await openOrder(plan, "alipay", "h");
    const silent = () =>
      serviceFor(providerFor(order.id, { channelTransactionId: `${prefix}-tx-h` }), plan);

    await silent().handleCallback("alipay", new Headers(), "x");
    await silent().handleCallback("alipay", new Headers(), "x");
    expect((await store.readOrder(order.id))?.status).toBe("pending");
    expect((await anomaliesOn(order.id, "amount_unreadable")).length).toBe(2);

    await silent().handleCallback("alipay", new Headers(), "x");
    expect((await store.readOrder(order.id))?.status).toBe("blocked");
    expect((await anomaliesOn(order.id, "amount_unreadable")).length).toBe(3);

    // The fourth no-amount delivery on a blocked order: 99ab5899's durable-evidence contract
    // means every refusal keeps recording its row (a blocked status does not erase evidence;
    // the shape is pinned in full in qa-batch2-unreadable-fourth), and the endgame is not
    // reversible by more deliveries — the order stays blocked.
    await silent().handleCallback("alipay", new Headers(), "x");
    expect((await anomaliesOn(order.id, "amount_unreadable")).length).toBe(4);
    expect((await store.readOrder(order.id))?.status).toBe("blocked");
  });
});

describe("probe i: the purchase guard's uncached projection read", () => {
  test("a live row in billing_subscriptions refuses the purchase while the cached read says null", async () => {
    const plan = planOf();
    const deploymentKey = `${prefix}-guard-deploy`;
    // Seed the projection directly: a live subscription row the cache never saw.
    await creditWriter.grantCredits({
      externalCustomerId: deploymentKey,
      source: "promo",
      totalCents: 1,
      expiresAt: new Date(Date.now() + 3600_000),
      idempotencyKey: `${prefix}-guard-seed`,
    }); // only to create the customer floor
    await billingStore.upsertSubscription({
      externalCustomerId: deploymentKey,
      externalSubscriptionId: `${deploymentKey}-sub`,
      planCode: plan,
      status: "active",
    });

    const guard = createPaymentService({
      providers: new Map([
        ["alipay", providerFor("po-none", {}, "alipay")],
      ]),
      store,
      catalog: new Map([[plan, { amountCents: 8800, currency: "CNY", periodMonths: 1 }]]),
      notifyBaseUrl: "https://qa.example",
      orderTtlMinutes: 15,
      latePaymentWindowHours: 24,
      acceptForeignCurrency: false,
      lago: {
        async getPlan() {
          return { found: true, interval: "monthly", currency: "CNY" };
        },
        async ensureSubscription() {
        // The 7aff8dc5 contract: the facade always answers a period object (null fields mean
        // "provider stated no exact period", not "no answer at all").
        return { currentPeriodStart: null, currentPeriodEnd: null };
      },
      },
      externalCustomerKey: deploymentKey,
      // The cached read lags: it still answers "no active plan".
      activePlanCode: async () => null,
      // The uncached read goes straight to the projection we just seeded.
      activePlanCodeUncached: async () => {
        const rows = await billingStore.readSubscriptions(deploymentKey);
        const live = rows.find(
          (row) => row.status === "active" || row.status === "incomplete",
        );
        return live ? live.planCode : null;
      },
      invalidateEntitlementCache: () => undefined,
      log: { warn: () => undefined },
    });

    await expect(
      guard.createPurchase({
        planCode: plan,
        provider: "alipay",
        cycle: "monthly",
        createdBy: "qa",
        ownerPayerRef: { kind: "personal" as const, id: "qa" },
      }),
    ).rejects.toMatchObject({
      refusal: { reason: "active-subscription", activePlanCode: plan },
    });

    // And with NO uncached read wired, the same deployment falls back to the cached answer
    // (back-compat): the purchase proceeds past the guard to the provider.
    const legacy = createPaymentService({
      providers: new Map([["alipay", providerFor("po-none", {}, "alipay")]]),
      store,
      catalog: new Map([[plan, { amountCents: 8800, currency: "CNY", periodMonths: 1 }]]),
      notifyBaseUrl: "https://qa.example",
      orderTtlMinutes: 15,
      latePaymentWindowHours: 24,
      acceptForeignCurrency: false,
      lago: {
        async getPlan() {
          return { found: true, interval: "monthly", currency: "CNY" };
        },
        async ensureSubscription() {
        // The 7aff8dc5 contract: the facade always answers a period object (null fields mean
        // "provider stated no exact period", not "no answer at all").
        return { currentPeriodStart: null, currentPeriodEnd: null };
      },
      },
      externalCustomerKey: deploymentKey,
      activePlanCode: async () => null,
      invalidateEntitlementCache: () => undefined,
      log: { warn: () => undefined },
    });
    // A DIFFERENT plan's pair: the legacy path opens the order (the cached answer governs).
    const order = await legacy.createPurchase({
      planCode: plan,
      provider: "alipay",
      cycle: "monthly",
      createdBy: "qa",
      ownerPayerRef: { kind: "personal" as const, id: "qa" },
    });
    expect(order.order.status).toBe("pending");
    // Clean up the pair so afterAll's prefix sweep finds nothing extra.
    await store.cancelOrder(order.order.orderId, 0).catch(() => {});
  });
});
