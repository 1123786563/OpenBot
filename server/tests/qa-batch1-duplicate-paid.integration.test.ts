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
 * QA batch-1 probe (c), FINAL ARBITER: the sequential cross-provider double payment, through
 * the real service against the real PostgreSQL. The point under test is subtle and worth
 * spelling out:
 *
 *   The service's duplicate_paid check runs AFTER our own confirm, reading `readLatestPaidOrder`
 *   (terminalAt DESC). After OUR confirm, the newest paid row on the plan is US — unless another
 *   order's terminalAt is later. In a sequential double payment (order A paid at T1, order B paid
 *   at T2 > T1), B's own confirm makes B the latest, so the check may see only itself and never
 *   fire. Whether P1-1's "跨单重复支付记异常" actually holds on the sequential path is decided
 *   HERE, against real SQL ordering — an in-memory double with a tied clock cannot answer it.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createPaymentStore(database);
const prefix = `qa1c-${randomUUID().slice(0, 8)}`;
const planCode = `qa-plan-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await database.delete(paymentEvents).where(like(paymentEvents.orderId, `${prefix}%`));
  await database.delete(paymentOrders).where(like(paymentOrders.id, `${prefix}%`));
  await database.$client.close();
});

function paidDelivery(
  orderId: string,
  transactionId: string,
): PaymentProvider {
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

function serviceFor(provider: PaymentProvider) {
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
      async ensureSubscription() {},
    },
    externalCustomerKey: "qa-deployment",
    activePlanCode: async () => null,
    invalidateEntitlementCache: () => undefined,
    log: { warn: () => undefined },
  });
}

async function openOrder(provider: "alipay" | "wechat", tag: string) {
  const { order } = await store.insertOrder({
    planCode,
    provider,
    amountCents: 8800,
    currency: "CNY",
    expiresAt: new Date(Date.now() + 15 * 60_000),
    createdBy: `qa-${tag}`,
    checkoutPayload: null,
  });
  return order;
}

async function anomaliesOn(orderId: string) {
  return database
    .select({ code: paymentEvents.code, detail: paymentEvents.detail })
    .from(paymentEvents)
    .where(
      and(
        eq(paymentEvents.orderId, orderId),
        eq(paymentEvents.kind, "anomaly"),
      ),
    );
}

test("sequential double payment (cross-provider): both paid, and the duplicate is VISIBLE", async () => {
  // Order A on alipay, paid for real.
  const a = await openOrder("alipay", "a");
  const alipayService = serviceFor(paidDelivery(a.id, `${prefix}-tx-a`));
  expect(await alipayService.handleCallback("alipay", new Headers(), "x")).toEqual({
    kind: "success",
  });
  const paidA = await store.readOrder(a.id);
  expect(paidA?.status).toBe("paid");
  const aAnoms = await anomaliesOn(a.id);
  console.log("A anomalies:", JSON.stringify(aAnoms));
  expect(aAnoms).toHaveLength(0);

  // REAL time passes between the two payments — the exact sequencing the terminalAt ordering
  // hinges on. One second is far beyond any same-millisecond tie.
  await new Promise((resolve) => setTimeout(resolve, 1100));

  // Order B on wechat (the pair the pending-pair index cannot bar — a legal channel switch
  // that was paid anyway), a second, distinct channel transaction.
  const b = await openOrder("wechat", "b");
  const wechatDelivery: PaymentProvider = {
    ...paidDelivery(b.id, `${prefix}-tx-b`),
    id: "wechat",
    successAck: { body: '{"code":"SUCCESS"}', contentType: "text/plain" },
  };
  const wechatService = serviceFor(wechatDelivery);
  expect(await wechatService.handleCallback("wechat", new Headers(), "x")).toEqual({
    kind: "success",
  });

  // The money is never swallowed: B is paid and activated.
  const paidB = await store.readOrder(b.id);
  expect(paidB?.status).toBe("paid");
  expect(paidB?.activationState).toBe("applied");

  // THE contract (P1-1's fix): a duplicate_paid anomaly names the second order, so
  // reconciliation can see the double collection. If this fails, the cross-order detection
  // only works in a concurrent race and the sequential case is still invisible.
  const bAnomalies = await anomaliesOn(b.id);
  const duplicate = bAnomalies.filter((row) => row.code === "duplicate_paid");
  expect(duplicate.length).toBeGreaterThanOrEqual(1);
  expect(duplicate[0]?.detail).toContain(a.id);
});
