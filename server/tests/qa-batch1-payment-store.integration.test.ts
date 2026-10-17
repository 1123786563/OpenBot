import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { createPaymentStore } from "../src/billing/payments/store";
import { createDatabase } from "../src/db/client";
import { paymentEvents, paymentOrders } from "../src/db/schema/payment";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * QA batch-1 probe (b)+(c), aligned with the deployment-scoped purchase semantics: the payment
 * store's pending-slot defence and the paid-fact idempotency under REAL concurrency, against a
 * real PostgreSQL. The author's tests exercise the sequential conflict answer; the property
 * P1-1 was filed over is the race itself — N concurrent inserts contending for the ONE pending
 * slot this deployment allows, and the cross-order paid-fact race that the partial unique index
 * must settle with one winner and N-1 alreadyKnown verdicts.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createPaymentStore(database);
const prefix = `qa1b-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  // Store-generated order ids (po-...) never start with the test prefix, so scope the
  // cleanup to createdBy instead; a leaked pending row poisons the deployment's one
  // pending slot for whichever payment file runs next against this database.
  const orders = await database
    .select({ id: paymentOrders.id })
    .from(paymentOrders)
    .where(eq(paymentOrders.createdBy, prefix));
  if (orders.length > 0) {
    await database.delete(paymentEvents).where(
      inArray(
        paymentEvents.orderId,
        orders.map((order) => order.id),
      ),
    );
    await database.delete(paymentOrders).where(
      inArray(paymentOrders.id, orders.map((order) => order.id)),
    );
  }
  await database.$client.close();
});

function orderInput(overrides: Partial<Parameters<typeof store.insertOrder>[0]> = {}) {
  return {
    planCode: `qa-plan-${randomUUID().slice(0, 8)}`,
    provider: "alipay" as const,
    amountCents: 8800,
    currency: "CNY" as const,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    createdBy: prefix,
    ownerPayerRef: { kind: "personal" as const, id: prefix },
    checkoutPayload: null,
    ...overrides,
  };
}

test("probe b: five concurrent inserts on one (plan, provider) land ONE pending order", async () => {
  const input = orderInput();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => store.insertOrder({ ...input })),
  );

  const winners = results.filter((result) => result.conflict === null);
  expect(winners).toHaveLength(1);
  const winnerId = winners[0].order.id;

  // Every loser gets the WINNER's row back with the conflict named — one payable QR total.
  for (const result of results) {
    expect(result.order.id).toBe(winnerId);
    expect(result.order.status).toBe("pending");
  }
  const losers = results.filter((result) => result.conflict === "pending-pair");
  expect(losers).toHaveLength(4);

  // The database fact: exactly one pending row on this pair (queried by the plan code — the
  // order id itself is the store's own `po-` draw, not our prefix).
  const rows = await database
    .select({ id: paymentOrders.id, status: paymentOrders.status })
    .from(paymentOrders)
    .where(eq(paymentOrders.planCode, input.planCode));
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("pending");
  expect(rows[0].id).toBe(winnerId);

  // The pending slot is deployment-wide: leave no pending order behind for the next test.
  expect(await store.cancelOrder(winnerId, 0)).toBe(true);
});

test("probe b: the same plan on DIFFERENT providers contends for the one deployment pending slot", async () => {
  const input = orderInput();
  const alipay = await store.insertOrder({ ...input });
  expect(alipay.conflict).toBeNull();
  // The pending-scope partial unique index is per DEPLOYMENT, not per (plan, provider): a
  // channel switch must first cancel the pending order (the service's flow), not open a
  // second payable QR beside it.
  const wechat = await store.insertOrder({ ...input, provider: "wechat" });
  expect(wechat.conflict).toBe("pending-purchase");
  expect(wechat.order.id).toBe(alipay.order.id);

  // The database fact: exactly one pending row deployment-wide for this scope.
  const rows = await database
    .select({ id: paymentOrders.id, status: paymentOrders.status })
    .from(paymentOrders)
    .where(eq(paymentOrders.planCode, input.planCode));
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("pending");

  // Free the deployment slot for the next test.
  expect(await store.cancelOrder(alipay.order.id, alipay.order.version)).toBe(true);
});

test("probe b: a terminal order frees the pair — a fresh pending order opens after cancel", async () => {
  const input = orderInput();
  const first = await store.insertOrder({ ...input });
  const canceled = await store.cancelOrder(first.order.id, first.order.version);
  expect(canceled).toBe(true);

  const second = await store.insertOrder({ ...input });
  expect(second.conflict).toBeNull();
  expect(second.order.id).not.toBe(first.order.id);

  // And the replay of the canceled pair is NOT the canceled order — the read is pending-only.
  const replay = await store.readPendingOrder(input.planCode, input.provider);
  expect(replay?.id).toBe(second.order.id);
});

test("probe c: two orders racing the SAME channel transaction — one claims, one alreadyKnown", async () => {
  const input = orderInput();
  const { order: first } = await store.insertOrder(input);
  // The deployment pending slot allows only one open order: settle the first aside so the
  // second can open, then race both confirms against the same channel transaction id.
  expect(await store.cancelOrder(first.id, first.version)).toBe(true);
  const { order: second } = await store.insertOrder(input);
  expect(second.id).not.toBe(first.id);
  const transactionId = `${prefix}-tx-race`;
  const periodStart = new Date();
  const periodEnd = new Date(Date.now() + 30 * 24 * 3600_000);

  const results = await Promise.all([
    store.confirmPaid({
      id: first.id,
      expectedVersion: first.version + 1,
      fromStatuses: ["expired", "canceled"],
      channelTransactionId: transactionId,
      amountCents: 8800,
      periodStart,
      periodEnd,
    }),
    store.confirmPaid({
      id: second.id,
      expectedVersion: second.version,
      fromStatuses: ["pending"],
      channelTransactionId: transactionId,
      amountCents: 8800,
      periodStart,
      periodEnd,
    }),
  ]);

  const claimed = results.filter((result) => result.claimed);
  expect(claimed).toHaveLength(1);
  const known = results.filter((result) => result.alreadyKnown);
  expect(known).toHaveLength(1);

  // The loser is untouched: it keeps the status it held before the race, with no channel
  // transaction recorded.
  const loserId = results[0].claimed ? second.id : first.id;
  const loser = await store.readOrder(loserId);
  expect(loser?.status).toBe(loserId === first.id ? "canceled" : "pending");
  expect(loser?.channelTransactionId).toBeNull();

  // The winner is paid exactly once; the events table holds ONE paid fact for the transaction.
  const facts = await database
    .select({ id: paymentEvents.id })
    .from(paymentEvents)
    .where(like(paymentEvents.channelTransactionId ?? paymentEvents.id, transactionId));
  expect(facts).toHaveLength(1);
});
