import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import type { PaymentProvider } from "../src/billing/payments/provider";
import { createPaymentService } from "../src/billing/payments/service";
import { createPaymentStore } from "../src/billing/payments/store";
import { createDatabase } from "../src/db/client";
import { paymentEvents, paymentOrders } from "../src/db/schema/payment";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * QA batch-2 probe (h), the FOURTH-delivery semantics against real PostgreSQL — UPDATED for
 * batch 3's B3 fix (authorized in the batch-3 brief):
 *
 *   The amount gate's unreadable branch now carries a blocked→silence guard ahead of the
 *   strike recording. A fourth (and every further) no-amount delivery on a BLOCKED order is
 *   still ACKED (the channel must be quieted), but writes NOTHING: the strike count stays at
 *   three and the dead order accumulates no tail. The batch-2 version of this probe pinned
 *   the OLD accumulation (four deliveries → four rows) as B3; the fix replaces it with the
 *   bounded shape pinned here.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createPaymentStore(database);
const prefix = `qa2h4-${randomUUID().slice(0, 8)}`;
const planCode = `qa-plan-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await database.delete(paymentEvents).where(like(paymentEvents.orderId, `${prefix}%`));
  await database.delete(paymentOrders).where(like(paymentOrders.id, `${prefix}%`));
  await database.$client.close();
});

function silentDelivery(orderId: string): PaymentProvider {
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
        // paid, transaction stated, NO amount — the unreadable shape.
        fact: { outTradeNo: orderId, state: "paid" as const, channelTransactionId: `${prefix}-tx` },
      };
    },
    successAck: { body: "success", contentType: "text/plain" },
  };
}

function serviceFor(provider: PaymentProvider) {
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
      async ensureSubscription() {},
    },
    externalCustomerKey: "qa-deployment",
    activePlanCode: async () => null,
    invalidateEntitlementCache: () => undefined,
    log: { warn: () => undefined },
  });
}

async function strikesOn(orderId: string) {
  const rows = await database
    .select({ id: paymentEvents.id })
    .from(paymentEvents)
    .where(
      and(
        eq(paymentEvents.orderId, orderId),
        eq(paymentEvents.kind, "anomaly"),
        eq(paymentEvents.code, "amount_unreadable"),
      ),
    );
  return rows.length;
}

describe("probe h-fourth: what the real store answers after the endgame (B3 fixed)", () => {
  test("strikes 1-2 pend, strike 3 blocks; FOURTH+ deliveries ack silently, zero new rows", async () => {
    const { order } = await store.insertOrder({
      planCode,
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(Date.now() + 15 * 60_000),
      createdBy: `${prefix}-h4`,
      checkoutPayload: null,
    });

    const deliver = () =>
      serviceFor(silentDelivery(order.id)).handleCallback("alipay", new Headers(), "x");

    // Strikes 1 and 2: pending, accumulating.
    expect(await deliver()).toEqual({ kind: "success" });
    expect(await deliver()).toEqual({ kind: "success" });
    expect((await store.readOrder(order.id))?.status).toBe("pending");
    expect(await strikesOn(order.id)).toBe(2);

    // Strike 3: the endgame — blocked, third strike row recorded.
    expect(await deliver()).toEqual({ kind: "success" });
    expect((await store.readOrder(order.id))?.status).toBe("blocked");
    expect(await strikesOn(order.id)).toBe(3);

    // FOURTH and FIFTH deliveries: still ACKED (the channel is quieted — a refusal here
    // would make the channel retry forever), but the blocked→silence guard means NOTHING
    // lands: no fourth strike row, no tail on the dead order.
    expect(await deliver()).toEqual({ kind: "success" });
    expect(await deliver()).toEqual({ kind: "success" });
    expect(await strikesOn(order.id)).toBe(3);

    // The money state never moved past blocked, and no fact was ever recorded.
    const final = await store.readOrder(order.id);
    expect(final?.status).toBe("blocked");
    const facts = await database
      .select({ id: paymentEvents.id })
      .from(paymentEvents)
      .where(and(eq(paymentEvents.orderId, order.id), eq(paymentEvents.kind, "fact")));
    expect(facts).toHaveLength(0);
  });
});
