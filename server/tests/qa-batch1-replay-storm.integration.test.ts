import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import type { PaymentProvider } from "../src/billing/payments/provider";
import { createPaymentService } from "../src/billing/payments/service";
import { createPaymentStore } from "../src/billing/payments/store";
import { createDatabase } from "../src/db/client";
import { paymentEvents, paymentOrders } from "../src/db/schema/payment";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * QA batch-1 round-2 probe: the replay-storm check on the fixed duplicate_paid path. The
 * engineer's argument: the anomaly block runs only when `claimed` is true, and a redelivered
 * delivery never claims — the paid-status early-out answers the same transaction silently and
 * a different one as over_paid, both long before any confirm. Pinned here against real
 * PostgreSQL: N redeliveries of the one confirmation must not grow the anomaly table.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createPaymentStore(database);
const prefix = `qa2s-${randomUUID().slice(0, 8)}`;
// Per-test plan codes: two tests sharing one plan would see each other's paid orders through
// the duplicate check — which is exactly the cross-order visibility under test, and exactly why
// the isolation must be per-plan, not per-file.
const planOf = () => `qa-plan-${randomUUID().slice(0, 8)}`;
const planRedelivery = planOf();
const planDuplicate = planOf();

afterAll(async () => {
  await database
    .delete(paymentEvents)
    .where(like(paymentEvents.orderId, `${prefix}%`));
  await database
    .delete(paymentOrders)
    .where(like(paymentOrders.id, `${prefix}%`));
  await database.$client.close();
});

function paidDelivery(orderId: string, transactionId: string): PaymentProvider {
  return {
    id: "alipay",
    async createSession() {
      return { checkout: { kind: "qrcode", payload: "qr" } };
    },
    async queryPayment() {
      return { outTradeNo: orderId, state: "pending" as const };
    },
    async closePayment() {},
    async verifyNotification() {
      return {
        ok: true as const,
        fact: {
          outTradeNo: orderId,
          state: "paid" as const,
          channelTransactionId: transactionId,
          amountCents: 8800,
        },
      };
    },
    successAck: { body: "success", contentType: "text/plain" },
  };
}

function serviceFor(provider: PaymentProvider, planCode: string) {
  return createPaymentService({
    providers: new Map([[provider.id, provider]]),
    store,
    catalog: new Map([
      [planCode, { amountCents: 8800, currency: "CNY", periodMonths: 1 }],
    ]),
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
    externalCustomerKey: "qa-deployment",
    activePlanCode: async () => null,
    invalidateEntitlementCache: () => undefined,
    log: { warn: () => undefined },
  });
}

async function anomalyCount(orderId: string) {
  const rows = await database
    .select({ code: paymentEvents.code })
    .from(paymentEvents)
    .where(
      and(
        eq(paymentEvents.orderId, orderId),
        eq(paymentEvents.kind, "anomaly"),
      ),
    );
  return rows.length;
}

test("redelivering the same paid delivery 8 times writes ZERO anomalies, not 8", async () => {
  const { order } = await store.insertOrder({
    planCode: planRedelivery,
    provider: "alipay",
    amountCents: 8800,
    currency: "CNY",
    expiresAt: new Date(Date.now() + 15 * 60_000),
    createdBy: `${prefix}-a`,
    ownerPayerRef: { kind: "personal" as const, id: `${prefix}-a` },
    checkoutPayload: null,
  });
  const service = serviceFor(
    paidDelivery(order.id, `${prefix}-tx-a`),
    planRedelivery,
  );

  for (let delivery = 1; delivery <= 8; delivery += 1) {
    const outcome = await service.handleCallback("alipay", new Headers(), "x");
    expect(outcome).toEqual({ kind: "success" }); // every redelivery is still acked
  }

  expect(await anomalyCount(order.id)).toBe(0);
  const row = await store.readOrder(order.id);
  expect(row?.status).toBe("paid");
  expect(row?.activationState).toBe("applied");
});

test("the fixed duplicate path fires ONCE for the one confirmation that doubled the plan", async () => {
  const { order: a } = await store.insertOrder({
    planCode: planDuplicate,
    provider: "alipay",
    amountCents: 8800,
    currency: "CNY",
    expiresAt: new Date(Date.now() + 15 * 60_000),
    createdBy: `${prefix}-a2`,
    ownerPayerRef: { kind: "personal" as const, id: `${prefix}-a2` },
    checkoutPayload: null,
  });
  await serviceFor(
    paidDelivery(a.id, `${prefix}-tx-b`),
    planDuplicate,
  ).handleCallback("alipay", new Headers(), "x");
  expect(await anomalyCount(a.id)).toBe(0);

  await new Promise((resolve) => setTimeout(resolve, 1100));

  const { order: b } = await store.insertOrder({
    planCode: planDuplicate,
    provider: "wechat",
    amountCents: 8800,
    currency: "CNY",
    expiresAt: new Date(Date.now() + 15 * 60_000),
    createdBy: `${prefix}-b2`,
    ownerPayerRef: { kind: "personal" as const, id: `${prefix}-b2` },
    checkoutPayload: null,
  });
  const wechat: PaymentProvider = {
    ...paidDelivery(b.id, `${prefix}-tx-c`),
    id: "wechat",
    successAck: { body: '{"code":"SUCCESS"}', contentType: "text/plain" },
  };
  const wechatService = serviceFor(wechat, planDuplicate);

  // The second confirmation — the one that doubles the plan — fires exactly one anomaly.
  await wechatService.handleCallback("wechat", new Headers(), "x");
  // Redeliveries of THAT confirmation: the paid early-out answers them silently.
  for (let delivery = 1; delivery <= 6; delivery += 1) {
    await wechatService.handleCallback("wechat", new Headers(), "x");
  }

  expect(await anomalyCount(b.id)).toBe(1);
  const paidB = await store.readOrder(b.id);
  expect(paidB?.status).toBe("paid");
});
