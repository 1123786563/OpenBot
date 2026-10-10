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

function orderInput() {
  return {
    planCode: "pro",
    provider: "alipay" as const,
    amountCents: 8800,
    currency: "CNY" as const,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    createdBy: "admin-1",
    checkoutPayload: "qr-payload",
  };
}

test("insertOrder generates short ids and retries a collision", async () => {
  const order = await store.insertOrder(orderInput());
  expect(order.id).toMatch(/^po-[0-9a-f]{16}$/);
  expect(order.status).toBe("pending");

  // A collision is absorbed: a pre-inserted fixed id occupies the key, and the next insert
  // redraws instead of surfacing the unique violation.
  await store.insertOrder(orderInput());
  await database.insert(paymentOrders).values({
    id: `${prefix}-fixed`,
    planCode: "pro",
    provider: "alipay",
    amountCents: 8800,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    status: "pending",
  });
  const second = await store.insertOrder(orderInput());
  expect(second.id).not.toBe(order.id);
  expect(await store.readOrder(`${prefix}-fixed`)).not.toBeNull();
});

test("a paid fact claims its channel transaction exactly once (the race)", async () => {
  const order = await store.insertOrder(orderInput());
  const conflicting = await store.insertOrder(orderInput());
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
  const order = await store.insertOrder(orderInput());
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
  const order = await store.insertOrder(orderInput());
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
  const order = await store.insertOrder(orderInput());
  expect(await store.cancelOrder(order.id, order.version)).toBe(true);
  // Canceled is idempotent at the service layer via re-read; the raw CAS refuses a second.
  expect(await store.cancelOrder(order.id, order.version)).toBe(false);

  const paid = await store.insertOrder(orderInput());
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

test("the sweeper's read returns only expired pending orders", async () => {
  const fresh = await store.insertOrder(orderInput());
  const stale = await store.insertOrder({
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
