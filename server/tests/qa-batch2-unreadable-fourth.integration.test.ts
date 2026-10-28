import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
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
 * 99ab5899's durable-evidence contract:
 *
 *   Every no-amount delivery records its amount_unreadable evidence row BEFORE any verdict,
 *   and every verdict is a refusal: `amount-mismatch` while the order is still pending (the
 *   third strike blocks it — P2-3's endgame), `blocked` once it is. No delivery is acked
 *   successful, because none ever commits a durable paid fact; the 409 at the route is a
 *   terminal answer the channel can stop on. The batch-2 version of this probe pinned the
 *   OLD accumulate-then-silence shape (four deliveries → acked, three rows); the durable-
 *   evidence contract replaces it with the shape pinned here.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createPaymentStore(database);
const prefix = `qa2h4-${randomUUID().slice(0, 8)}`;
const planCode = `qa-plan-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await database
    .delete(paymentEvents)
    .where(like(paymentEvents.orderId, `${prefix}%`));
  await database
    .delete(paymentOrders)
    .where(like(paymentOrders.id, `${prefix}%`));
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
        fact: {
          outTradeNo: orderId,
          state: "paid" as const,
          channelTransactionId: `${prefix}-tx`,
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

describe("probe h-fourth: what the real store answers after the endgame", () => {
  test("strikes 1-2 refuse and accumulate, strike 3 blocks; FOURTH+ refusals keep recording evidence", async () => {
    const { order } = await store.insertOrder({
      planCode,
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(Date.now() + 15 * 60_000),
      createdBy: `${prefix}-h4`,
      ownerPayerRef: { kind: "personal" as const, id: `${prefix}-h4` },
      checkoutPayload: null,
    });

    const deliver = () =>
      serviceFor(silentDelivery(order.id)).handleCallback(
        "alipay",
        new Headers(),
        "x",
      );

    // Strikes 1 and 2: the order stays pending, each refusal accumulates its row.
    expect(await deliver()).toEqual({
      kind: "settlement-refused",
      settlement: { kind: "refused", reason: "amount-mismatch" },
    });
    expect(await deliver()).toEqual({
      kind: "settlement-refused",
      settlement: { kind: "refused", reason: "amount-mismatch" },
    });
    expect((await store.readOrder(order.id))?.status).toBe("pending");
    expect(await strikesOn(order.id)).toBe(2);

    // Strike 3: the endgame — blocked, third strike row recorded.
    expect(await deliver()).toEqual({
      kind: "settlement-refused",
      settlement: { kind: "refused", reason: "amount-mismatch" },
    });
    expect((await store.readOrder(order.id))?.status).toBe("blocked");
    expect(await strikesOn(order.id)).toBe(3);

    // FOURTH and FIFTH deliveries: refused with the durable blocked verdict, and every
    // refusal keeps recording its evidence row (a blocked status does not erase evidence).
    // No success ack is possible: no durable paid fact was ever committed.
    expect(await deliver()).toEqual({
      kind: "settlement-refused",
      settlement: { kind: "refused", reason: "blocked" },
    });
    expect(await deliver()).toEqual({
      kind: "settlement-refused",
      settlement: { kind: "refused", reason: "blocked" },
    });
    expect(await strikesOn(order.id)).toBe(5);

    // The money state never moved past blocked, and no fact was ever recorded.
    const final = await store.readOrder(order.id);
    expect(final?.status).toBe("blocked");
    const facts = await database
      .select({ id: paymentEvents.id })
      .from(paymentEvents)
      .where(
        and(
          eq(paymentEvents.orderId, order.id),
          eq(paymentEvents.kind, "fact"),
        ),
      );
    expect(facts).toHaveLength(0);
  });
});
