import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import * as paymentCrypto from "../src/billing/payments/crypto";
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
  await database
    .delete(paymentOrders)
    .where(eq(paymentOrders.createdBy, prefix));
  await database.$client.close();
});

afterEach(async () => {
  const pending = await database
    .select({ id: paymentOrders.id, version: paymentOrders.version })
    .from(paymentOrders)
    .where(
      and(
        eq(paymentOrders.createdBy, prefix),
        eq(paymentOrders.status, "pending"),
      ),
    );
  for (const order of pending) {
    await store.cancelOrder(order.id, order.version);
  }
});

/**
 * One order's insert input, on a plan code UNIQUE to this call. The pending-scope partial unique
 * index (deployment_scope WHERE status='pending') is a database fact, and these tests share one
 * database across runs — a per-call suffix keeps each test's purchase independent.
 */
function orderInput() {
  return {
    planCode: `pro-${randomUUID().slice(0, 8)}`,
    provider: "alipay" as const,
    amountCents: 8800,
    currency: "CNY" as const,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    createdBy: prefix,
    checkoutPayload: "qr-payload",
  };
}

test("insertOrder retries a real primary-key collision with a fresh order id", async () => {
  const collisionId = `po-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const freshId = `po-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await database.insert(paymentOrders).values({
    id: collisionId,
    ...orderInput(),
    status: "canceled",
  });
  const generate = spyOn(paymentCrypto, "generateOutTradeNo")
    .mockReturnValueOnce(collisionId)
    .mockReturnValueOnce(freshId);
  try {
    const result = await store.insertOrder(orderInput());
    expect(result.conflict).toBeNull();
    expect(result.order.id).toBe(freshId);
    expect((await store.readOrder(collisionId))?.status).toBe("canceled");
    expect((await store.readPendingPurchase())?.id).toBe(freshId);
  } finally {
    generate.mockRestore();
  }
});

test("insertOrder generates short ids and terminal orders leave the purchase slot free", async () => {
  const { order } = await store.insertOrder(orderInput());
  expect(order.id).toMatch(/^po-[0-9a-f]{16}$/);
  expect(order.status).toBe("pending");
  await store.cancelOrder(order.id, order.version);

  // A terminal row does not occupy the deployment's pending slot.
  await database.insert(paymentOrders).values({
    // Not the store's id, but a plan this test owns.
    id: `${prefix}-fixed`,
    planCode: `pro-${randomUUID().slice(0, 8)}`,
    provider: "alipay",
    amountCents: 8800,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    status: "canceled",
    createdBy: prefix,
  });
  const second = await store.insertOrder(orderInput());
  expect(second.order.id).not.toBe(order.id);
  expect(await store.readOrder(`${prefix}-fixed`)).not.toBeNull();
});

test("same-pair orders replay, while channel switches must free the deployment slot first", async () => {
  const input = orderInput();
  const first = await store.insertOrder(input);
  expect(first.conflict).toBeNull();

  // The same plan on the same channel while the first is still pending: no second row, the
  // winner's order is the answer, and the conflict is named.
  const second = await store.insertOrder(input);
  expect(second.conflict).toBe("pending-pair");
  expect(second.order.id).toBe(first.order.id);

  // A different channel cannot open alongside the pending purchase.
  const other = await store.insertOrder({ ...input, provider: "wechat" });
  expect(other.conflict).toBe("pending-purchase");
  expect(other.order.id).toBe(first.order.id);

  // A terminal order frees the deployment slot for a channel switch.
  await store.cancelOrder(first.order.id, first.order.version);
  const third = await store.insertOrder({ ...input, provider: "wechat" });
  expect(third.conflict).toBeNull();
  expect(third.order.id).not.toBe(first.order.id);
});

test("only one pending purchase exists across plans and providers", async () => {
  const first = await store.insertOrder(orderInput());
  const second = await store.insertOrder({
    ...orderInput(),
    provider: "wechat",
  });

  expect(second.conflict).toBe("pending-purchase");
  expect((await store.readPendingPurchase())?.id).toBe(first.order.id);
});

test("concurrent orders on different plans and providers converge on one pending purchase", async () => {
  const inputs = [
    orderInput(),
    { ...orderInput(), provider: "wechat" as const },
  ];
  const results = await Promise.all(
    inputs.map((input) => store.insertOrder(input)),
  );
  const winners = results.filter((result) => result.conflict === null);
  const losers = results.filter((result) => result.conflict !== null);

  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expect(losers[0]?.conflict).toBe("pending-purchase");
  expect(losers[0]?.order.id).toBe(winners[0]?.order.id);
  expect((await store.readPendingPurchase())?.id).toBe(winners[0]?.order.id);
});

test("a paid fact claims its channel transaction exactly once (the race)", async () => {
  const { order } = await store.insertOrder(orderInput());
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
  const { order: conflicting } = await store.insertOrder(orderInput());

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

test("resolveActivationOwnership serializes overlapping paid orders to one entitlement owner", async () => {
  const sharedPlan = `pro-${randomUUID().slice(0, 8)}`;
  const first = await store.insertOrder({
    ...orderInput(),
    planCode: sharedPlan,
  });
  const firstPeriodStart = new Date();
  const firstPeriodEnd = new Date(firstPeriodStart.getTime() + 30 * 24 * 3600_000);
  expect(
    await store.confirmPaid({
      id: first.order.id,
      expectedVersion: first.order.version,
      fromStatuses: ["pending"],
      channelTransactionId: `${prefix}-tx-owner`,
      amountCents: 8800,
      periodStart: firstPeriodStart,
      periodEnd: firstPeriodEnd,
    }),
  ).toEqual({ claimed: true, alreadyKnown: false });

  const second = await store.insertOrder({
    ...orderInput(),
    planCode: sharedPlan,
    provider: "wechat",
  });
  const secondPeriodStart = new Date(firstPeriodStart.getTime() + 5 * 60_000);
  const secondPeriodEnd = new Date(secondPeriodStart.getTime() + 30 * 24 * 3600_000);
  expect(
    await store.confirmPaid({
      id: second.order.id,
      expectedVersion: second.order.version,
      fromStatuses: ["pending"],
      channelTransactionId: `${prefix}-tx-duplicate`,
      amountCents: 8800,
      periodStart: secondPeriodStart,
      periodEnd: secondPeriodEnd,
    }),
  ).toEqual({ claimed: true, alreadyKnown: false });

  const [owner, duplicate] = await Promise.all([
    store.resolveActivationOwnership(first.order.id),
    store.resolveActivationOwnership(second.order.id),
  ]);

  expect(owner).toMatchObject({
    outcome: "owner",
    order: { id: first.order.id },
  });
  expect(duplicate).toMatchObject({
    outcome: "duplicate",
    order: { id: second.order.id },
    ownerOrder: {
      id: first.order.id,
      channelTransactionId: `${prefix}-tx-owner`,
    },
  });
});

test("an already-applied owner stays the owner when a later overlapping paid order settles", async () => {
  const sharedPlan = `pro-${randomUUID().slice(0, 8)}`;
  const owner = await store.insertOrder({
    ...orderInput(),
    planCode: sharedPlan,
  });
  const laterPeriodStart = new Date(Date.now() + 10 * 60_000);
  const laterPeriodEnd = new Date(laterPeriodStart.getTime() + 30 * 24 * 3600_000);
  expect(
    await store.confirmPaid({
      id: owner.order.id,
      expectedVersion: owner.order.version,
      fromStatuses: ["pending"],
      channelTransactionId: `${prefix}-tx-applied-owner`,
      amountCents: 8800,
      periodStart: laterPeriodStart,
      periodEnd: laterPeriodEnd,
    }),
  ).toEqual({ claimed: true, alreadyKnown: false });
  await store.recordActivation(owner.order.id, "applied");

  const duplicate = await store.insertOrder({
    ...orderInput(),
    planCode: sharedPlan,
    provider: "wechat",
  });
  const earlierOverlapStart = new Date(laterPeriodStart.getTime() - 5 * 60_000);
  const earlierOverlapEnd = new Date(earlierOverlapStart.getTime() + 30 * 24 * 3600_000);
  expect(
    await store.confirmPaid({
      id: duplicate.order.id,
      expectedVersion: duplicate.order.version,
      fromStatuses: ["pending"],
      channelTransactionId: `${prefix}-tx-late-overlap`,
      amountCents: 8800,
      periodStart: earlierOverlapStart,
      periodEnd: earlierOverlapEnd,
    }),
  ).toEqual({ claimed: true, alreadyKnown: false });

  await expect(store.resolveActivationOwnership(owner.order.id)).resolves.toMatchObject({
    outcome: "owner",
    order: { id: owner.order.id },
  });
  await expect(store.resolveActivationOwnership(duplicate.order.id)).resolves.toMatchObject({
    outcome: "duplicate",
    order: { id: duplicate.order.id },
    ownerOrder: { id: owner.order.id },
  });
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
  const { order: stale } = await store.insertOrder({
    ...orderInput(),
    expiresAt: new Date(Date.now() - 60_000),
  });
  await store.expireOrder(stale.id, stale.version);
  const { order: fresh } = await store.insertOrder(orderInput());

  const expired = await store.listExpiredPendingOrders(new Date(), 100);
  // The swept-and-expired order and the not-yet-expired one are both excluded: the read is the
  // query-first pass's worklist, and it must never see a terminal row again.
  expect(expired.find((order) => order.id === stale.id)).toBeUndefined();
  expect(expired.find((order) => order.id === fresh.id)).toBeUndefined();
});
