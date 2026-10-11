import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { createPaymentStore } from "../src/billing/payments/store";
import { createDatabase } from "../src/db/client";
import { paymentEvents, paymentOrders } from "../src/db/schema/payment";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The two payment tables against a real PostgreSQL, gated on TEST_DATABASE_URL the way the rest
 * of the integration suite is. The tables are created by the same DDL the drizzle schema spells
 * (../src/db/schema/payment.ts) — for the test database they were applied out of band, exactly as
 * billing-store.integration.test.ts assumes its migrations ran; a deployment applies the drizzle
 * migration instead. The store's guarantees under test here: the paid-fact partial unique index
 * is the cross-order idempotency key, CAS versions refuse stale writers, blocked is terminal.
 * All access goes through drizzle's parameter-bound builders.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createPaymentStore(database);
const prefix = `pay-${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await database.delete(paymentEvents).where(like(paymentEvents.orderId, `${prefix}%`));
  await database.delete(paymentOrders).where(like(paymentOrders.id, `${prefix}%`));
  await database.$client.close();
});

/**
 * One order's insert input, on a plan code UNIQUE to this call. The pending-pair partial unique
 * index ((plan, provider) WHERE status='pending') is now a database fact, and these tests share
 * one database across runs — a fixed plan code would have every test after the first insert
 * replay into the first test's pending order instead of creating its own. A per-call suffix
 * keeps each insert on its own pair; the pair index has its own dedicated test below.
 */
function orderInput() {
  return {
    planCode: `pro-${randomUUID().slice(0, 8)}`,
    provider: "alipay" as const,
    amountCents: 8800,
    currency: "CNY" as const,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    createdBy: "admin-1",
    checkoutPayload: "qr-payload",
  };
}

test("insertOrder generates short ids and retries a collision", async () => {
  const { order } = await store.insertOrder(orderInput());
  expect(order.id).toMatch(/^po-[0-9a-f]{16}$/);
  expect(order.status).toBe("pending");

  // A `po-` id collision is absorbed: a pre-inserted fixed id occupies the primary key, and the
  // next insert on a DIFFERENT pair (its own plan) redraws instead of surfacing the violation.
  await database.insert(paymentOrders).values({
    // Not the store's id, but a plan this pair-test owns: pending, so the pending-pair index
    // also sees exactly this row on this pair and nothing else.
    id: `${prefix}-fixed`,
    planCode: `pro-${randomUUID().slice(0, 8)}`,
    provider: "alipay",
    amountCents: 8800,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    status: "pending",
  });
  const second = await store.insertOrder(orderInput());
  expect(second.order.id).not.toBe(order.id);
  expect(await store.readOrder(`${prefix}-fixed`)).not.toBeNull();
});

test("the pending pair is unique: a second insert on the same (plan, provider) replays the first", async () => {
  const input = orderInput();
  const first = await store.insertOrder(input);
  expect(first.conflict).toBeNull();

  // The same plan on the same channel while the first is still pending: no second row, the
  // winner's order is the answer, and the conflict is named.
  const second = await store.insertOrder(input);
  expect(second.conflict).toBe("pending-pair");
  expect(second.order.id).toBe(first.order.id);

  // A different channel is a different pair — the index must not bar a channel switch.
  const other = await store.insertOrder({ ...input, provider: "wechat" });
  expect(other.conflict).toBeNull();
  expect(other.order.id).not.toBe(first.order.id);

  // And a terminal first order frees the pair for a fresh pending one.
  await store.cancelOrder(first.order.id, first.order.version);
  const third = await store.insertOrder(input);
  expect(third.conflict).toBeNull();
  expect(third.order.id).not.toBe(first.order.id);
});

test("a paid fact claims its channel transaction exactly once (the race)", async () => {
  const { order } = await store.insertOrder(orderInput());
  const { order: conflicting } = await store.insertOrder(orderInput());
  const transactionId = `${prefix}-tx-1`;

  const first = await store.confirmPaid({
    id: order.id,
    expectedVersion: order.version,
    fromStatuses: ["pending", "expired", "canceled"],
    channelTransactionId: transactionId,
    amountCents: 8800,
    periodStart: new Date(),
    periodEnd: new Date(Date.now() + 30 * 24 * 3600_000),
  });
  expect(first).toEqual({ claimed: true, alreadyKnown: false });

  // The same delivery redelivered: known, not re-claimed.
  const replay = await store.confirmPaid({
    id: order.id,
    expectedVersion: order.version, // stale on purpose
    fromStatuses: ["pending", "expired", "canceled"],
    channelTransactionId: transactionId,
    amountCents: 8800,
    periodStart: new Date(),
    periodEnd: new Date(),
  });
  expect(replay).toEqual({ claimed: false, alreadyKnown: true });

  // A second order the same transaction is reported against: the fact key is held by the first,
  // so the claim fails and nothing about the second order changes.
  const stolen = await store.confirmPaid({
    id: conflicting.id,
    expectedVersion: conflicting.version,
    fromStatuses: ["pending", "expired", "canceled"],
    channelTransactionId: transactionId,
    amountCents: 8800,
    periodStart: new Date(),
    periodEnd: new Date(),
  });
  expect(stolen).toEqual({ claimed: false, alreadyKnown: true });
  const unchanged = await store.readOrder(conflicting.id);
  expect(unchanged?.status).toBe("pending");
});

test("CAS version moves reject a stale writer", async () => {
  const { order } = await store.insertOrder(orderInput());
  const expired = await store.expireOrder(order.id, order.version);
  expect(expired).toBe(true);
  // The same version again: the row moved, the CAS refuses.
  const again = await store.expireOrder(order.id, order.version);
  expect(again).toBe(false);
  const row = await store.readOrder(order.id);
  expect(row?.status).toBe("expired");
  expect(row?.terminalAt).toBeInstanceOf(Date);
});

test("blocked is terminal: no migration out of it", async () => {
  const { order } = await store.insertOrder(orderInput());
  const blocked = await store.blockOrder({
    id: order.id,
    expectedVersion: order.version,
    channelTransactionId: `${prefix}-tx-bad`,
    amountCents: 1,
    detail: "paid 0.01, ordered 88.00",
  });
  expect(blocked).toBe(true);

  const refused = await store.confirmPaid({
    id: order.id,
    expectedVersion: order.version + 1,
    fromStatuses: ["pending", "expired", "canceled"],
    channelTransactionId: `${prefix}-tx-bad`,
    amountCents: 1,
    periodStart: new Date(),
    periodEnd: new Date(),
  });
  expect(refused.claimed).toBe(false);
  expect((await store.readOrder(order.id))?.status).toBe("blocked");

  // Anomalies do not consume the fact key: two coexist on one order.
  await store.recordAnomaly({
    orderId: order.id,
    kind: "anomaly",
    code: "late-payment",
    channelTransactionId: `${prefix}-tx-bad`,
    amountCents: 1,
    detail: "second anomaly coexists",
  });
  const rows = await database
    .select({ code: paymentEvents.code })
    .from(paymentEvents)
    .where(like(paymentEvents.orderId, `${order.id}`));
  expect(rows.map((row) => row.code).sort()).toEqual([
    "amount_mismatch",
    "late-payment",
  ]);
});

test("cancel is a CAS on pending only; activation records on paid", async () => {
  const { order } = await store.insertOrder(orderInput());
  expect(await store.cancelOrder(order.id, order.version)).toBe(true);
  // Canceled is idempotent at the service layer via re-read; the raw CAS refuses a second.
  expect(await store.cancelOrder(order.id, order.version)).toBe(false);

  const { order: paid } = await store.insertOrder(orderInput());
  await store.confirmPaid({
    id: paid.id,
    expectedVersion: paid.version,
    fromStatuses: ["pending"],
    channelTransactionId: `${prefix}-tx-act`,
    amountCents: 8800,
    periodStart: new Date(),
    periodEnd: new Date(Date.now() + 30 * 24 * 3600_000),
  });
  await store.recordActivation(paid.id, "applied");
  expect((await store.readOrder(paid.id))?.activationState).toBe("applied");
});

test("the anomaly dedup index: same (order, word) is one row; amount_unreadable accumulates", async () => {
  const { order } = await store.insertOrder(orderInput());
  // A redelivered late-payment notification: the second insert is a no-op (P2-2's dam).
  const anomaly = {
    orderId: order.id,
    kind: "anomaly" as const,
    code: "late_payment",
    channelTransactionId: `${prefix}-tx-late`,
    amountCents: 8800,
    detail: "redelivered",
  };
  await store.recordAnomaly(anomaly);
  await store.recordAnomaly(anomaly);
  expect(await store.countAnomalies(order.id, "late_payment")).toBe(1);
  // A DIFFERENT word on the same order coexists — the index is per word.
  await store.recordAnomaly({ ...anomaly, code: "over_paid", detail: "" });
  expect(await store.countAnomalies(order.id, "over_paid")).toBe(1);
  // amount_unreadable is excluded from the dam: its repeats accumulate (the endgame counts them).
  for (let i = 0; i < 3; i += 1) {
    await store.recordAnomaly({
      ...anomaly,
      code: "amount_unreadable",
      channelTransactionId: null,
      amountCents: null,
      detail: `strike ${i + 1}`,
    });
  }
  expect(await store.countAnomalies(order.id, "amount_unreadable")).toBe(3);
});

test("the sweeper's read returns only expired pending orders", async () => {
  const { order: fresh } = await store.insertOrder(orderInput());
  const { order: stale } = await store.insertOrder({
    ...orderInput(),
    expiresAt: new Date(Date.now() - 60_000),
  });
  await store.expireOrder(stale.id, stale.version);

  const expired = await store.listExpiredPendingOrders(new Date(), 100);
  // The swept-and-expired order and the not-yet-expired one are both excluded: the read is the
  // query-first pass's worklist, and it must never see a terminal row again.
  expect(expired.find((order) => order.id === stale.id)).toBeUndefined();
  expect(expired.find((order) => order.id === fresh.id)).toBeUndefined();
});
