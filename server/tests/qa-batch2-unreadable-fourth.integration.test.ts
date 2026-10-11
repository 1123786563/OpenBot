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
 * QA batch-2 probe (h), the FOURTH-delivery semantics against real PostgreSQL — the case the
 * author's suite never reaches (its in-memory double answers from its own list, so its
 * "blocked" test ends at the third strike) and the case where the real partial index answers
 * differently from the double:
 *
 *   A fourth no-amount delivery on a BLOCKED order takes the amount gate's FIRST branch
 *   (amountCents === undefined → amount_unreadable), because that branch runs before the
 *   blocked-status check. The endgame's protection is only the strike counter's own condition
 *   (status === "pending"), which the blocked order no longer satisfies — so the anomaly keeps
 *   accumulating on a terminal order. Harmless to the sweeper (it never queries blocked rows),
 *   but the "endgame ended" story and the real store disagree with the author's double: the
 *   double returns paid_after_blocked only for deliveries that CARRY an amount.
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

describe("probe h-fourth: what the real store answers after the endgame", () => {
  test("strikes 1-2 pend, strike 3 blocks; a FOURTH no-amount delivery is documented reality", async () => {
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

    // Strike 3: the endgame — blocked, and a THIRD amount_unreadable row plus the block's own
    // amount_mismatch anomaly (blockOrder writes that word by construction).
    expect(await deliver()).toEqual({ kind: "success" });
    expect((await store.readOrder(order.id))?.status).toBe("blocked");

    // The FOURTH delivery, still no amount: the amount gate's first branch fires again
    // (it precedes the blocked check). The REAL index lets the row accumulate (the word is
    // exempt); the endgame does not re-block (status is not pending). This is the behaviour
    // difference this probe exists to record — see the report's B2 note.
    expect(await deliver()).toEqual({ kind: "success" });
    const strikes = await database
      .select({ id: paymentEvents.id })
      .from(paymentEvents)
      .where(
        and(
          eq(paymentEvents.orderId, order.id),
          eq(paymentEvents.kind, "anomaly"),
          eq(paymentEvents.code, "amount_unreadable"),
        ),
      );
    // Four deliveries, four strike rows: the accumulation on a terminal order is REAL.
    expect(strikes.length).toBe(4);

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
