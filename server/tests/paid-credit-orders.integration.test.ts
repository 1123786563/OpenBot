import { afterAll, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { firstBillingPeriod } from "../src/billing/billing-period";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import { createDatabase } from "../src/db/client";
import {
  paidCreditAllocations,
  paidEntitlements,
  paidOrders,
  paidProducts,
  testCreditAccounts,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * #99–#101: orders lock the purchased product version, channel verification
 * grants exactly once, an advance purchase claims the one allowed future
 * period atomically, and the refund seams freeze and revoke.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const ledger = () => createPaidCreditLedger(database, () => paidAt);
const paidAt = new Date("2026-02-15T04:30:00.000Z"); // Beijing Feb 15 12:30
// Channel references stay unique across reruns of this file against the same database.
const run = crypto.randomUUID().slice(0, 8);
let account: string;

async function freshAccount(tag: string) {
  const [row] = await database
    .insert(testCreditAccounts)
    .values({ issuer: `paid-ledger-${tag}`, subject: crypto.randomUUID() })
    .returning();
  return row.id;
}

test("orders lock the product version and price they were placed under", async () => {
  account = await freshAccount("lock");
  await ledger().upsertProduct({
    code: "plan-monthly",
    kind: "subscription",
    priceCents: 2_900,
    creditsMicrocredits: 5_000_000n,
  });
  const order = await ledger().createOrder({
    accountId: account,
    productCode: "plan-monthly",
    channel: "wechat",
  });
  expect(order).toMatchObject({ productVersion: 1, priceCents: 2_900 });

  // A price change republishes the product as version 2; the placed order
  // keeps what it locked.
  await ledger().upsertProduct({
    code: "plan-monthly",
    kind: "subscription",
    priceCents: 3_900,
    creditsMicrocredits: 5_000_000n,
  });
  const later = await ledger().createOrder({
    accountId: account,
    productCode: "plan-monthly",
    channel: "alipay",
  });
  expect(later).toMatchObject({ productVersion: 2, priceCents: 3_900 });
  expect(order.productVersion).toBe(1);
  expect(order.priceCents).toBe(2_900);
});

test("verification grants the first Beijing period exactly once", async () => {
  account = await freshAccount("first");
  await ledger().upsertProduct({
    code: "plan-monthly",
    kind: "subscription",
    priceCents: 2_900,
    creditsMicrocredits: 5_000_000n,
  });
  const order = await ledger().createOrder({
    accountId: account,
    productCode: "plan-monthly",
    channel: "wechat",
  });
  const verified = await ledger().verifyOrder({
    orderId: order.id,
    channel: "wechat",
    channelOrderRef: `wx-20260215-001-${run}`,
    amountCents: 2_900,
    paidAt,
  });
  expect(verified.order.state).toBe("verified");
  expect(verified.claimed).toBe(true);

  const expected = firstBillingPeriod(paidAt);
  expect(verified.entitlement).toMatchObject({
    kind: "subscription",
    anchorDay: expected.anchorDay,
    periodStart: expected.start,
    periodEnd: expected.end,
    state: "granted",
  });

  // The same channel reference replays the original result and never grants
  // a second entitlement.
  const replay = await ledger().verifyOrder({
    orderId: order.id,
    channel: "wechat",
    channelOrderRef: `wx-20260215-001-${run}`,
    amountCents: 2_900,
    paidAt,
  });
  expect(replay.replayed).toBe(true);
  expect(await ledger().entitlements(account)).toHaveLength(1);

  // A different reference against the same order is refused.
  await expect(
    ledger().verifyOrder({
      orderId: order.id,
      channel: "wechat",
      channelOrderRef: `wx-other-${run}`,
      amountCents: 2_900,
      paidAt,
    }),
  ).rejects.toMatchObject({ code: "verification_mismatch" });
});

test("a mismatched amount fails the order instead of granting", async () => {
  account = await freshAccount("mismatch");
  await ledger().upsertProduct({
    code: "plan-monthly",
    kind: "subscription",
    priceCents: 2_900,
    creditsMicrocredits: 5_000_000n,
  });
  const order = await ledger().createOrder({
    accountId: account,
    productCode: "plan-monthly",
    channel: "alipay",
  });
  await expect(
    ledger().verifyOrder({
      orderId: order.id,
      channel: "alipay",
      channelOrderRef: `ali-1-${run}`,
      amountCents: 1_900,
      paidAt,
    }),
  ).rejects.toMatchObject({ code: "verification_mismatch" });
  const [row] = await database
    .select()
    .from(paidOrders)
    .where(inArray(paidOrders.id, [order.id]));
  expect(row.state).toBe("failed");
  expect(await ledger().entitlements(account)).toHaveLength(0);
});

test("an advance purchase claims the next period, and only one future claim wins", async () => {
  account = await freshAccount("advance");
  await ledger().upsertProduct({
    code: "plan-monthly",
    kind: "subscription",
    priceCents: 2_900,
    creditsMicrocredits: 5_000_000n,
  });
  const first = await ledger().createOrder({
    accountId: account,
    productCode: "plan-monthly",
    channel: "wechat",
  });
  const verifiedFirst = await ledger().verifyOrder({
    orderId: first.id,
    channel: "wechat",
    channelOrderRef: `wx-adv-1-${run}`,
    amountCents: 2_900,
    paidAt,
  });
  const current = verifiedFirst.entitlement;
  if (!current) throw new Error("first purchase granted no entitlement");

  const second = await ledger().createOrder({
    accountId: account,
    productCode: "plan-monthly",
    channel: "wechat",
  });
  const third = await ledger().createOrder({
    accountId: account,
    productCode: "plan-monthly",
    channel: "alipay",
  });
  const claims = await Promise.all([
    ledger().verifyOrder({
      orderId: second.id,
      channel: "wechat",
      channelOrderRef: `wx-adv-2-${run}`,
      amountCents: 2_900,
      paidAt,
    }),
    ledger().verifyOrder({
      orderId: third.id,
      channel: "alipay",
      channelOrderRef: `ali-adv-3-${run}`,
      amountCents: 2_900,
      paidAt,
    }),
  ]);

  const winners = claims.filter((claim) => claim.claimed);
  const losers = claims.filter((claim) => !claim.claimed);
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expect(losers[0].order.state).toBe("refund_pending");

  const winner = winners[0];
  if (!winner?.entitlement)
    throw new Error("the future claim granted no entitlement");
  expect(winner.entitlement).toMatchObject({ state: "future" });
  // Effective exactly when the current period ends, same anchor.
  expect(winner.entitlement.periodStart).toEqual(current.periodEnd);
  expect(winner.entitlement.anchorDay).toBe(current.anchorDay);

  const view = await ledger().entitlements(account);
  expect(view.filter(({ effective }) => effective === "active")).toHaveLength(
    1,
  );
  expect(view.filter(({ effective }) => effective === "future")).toHaveLength(
    1,
  );
});

test("credit packs arrive without a period and in arrival order", async () => {
  account = await freshAccount("pack");
  await ledger().upsertProduct({
    code: "pack-long",
    kind: "credit_pack",
    priceCents: 9_900,
    creditsMicrocredits: 20_000_000n,
  });
  const order = await ledger().createOrder({
    accountId: account,
    productCode: "pack-long",
    channel: "wechat",
  });
  const verified = await ledger().verifyOrder({
    orderId: order.id,
    channel: "wechat",
    channelOrderRef: `wx-pack-1-${run}`,
    amountCents: 9_900,
    paidAt,
  });
  expect(verified.entitlement).toMatchObject({
    kind: "credit_pack",
    periodStart: null,
    state: "granted",
  });
  const [view] = await ledger().entitlements(account);
  expect(view.effective).toBe("active");
});

test("the refund seams freeze, then revoke, a verified order", async () => {
  account = await freshAccount("refund");
  await ledger().upsertProduct({
    code: "pack-long",
    kind: "credit_pack",
    priceCents: 9_900,
    creditsMicrocredits: 20_000_000n,
  });
  const order = await ledger().createOrder({
    accountId: account,
    productCode: "pack-long",
    channel: "wechat",
  });
  await ledger().verifyOrder({
    orderId: order.id,
    channel: "wechat",
    channelOrderRef: `wx-refund-1-${run}`,
    amountCents: 9_900,
    paidAt,
  });

  const frozen = await ledger().freezeEntitlements(order.id, true);
  expect(frozen.state).toBe("refund_pending");
  expect((await ledger().entitlements(account))[0].effective).toBe("frozen");

  // A failed refund unfreezes and the entitlement returns.
  const unfrozen = await ledger().freezeEntitlements(order.id, false);
  expect(unfrozen.state).toBe("verified");
  expect((await ledger().entitlements(account))[0].effective).toBe("active");

  await ledger().freezeEntitlements(order.id, true);
  const refunded = await ledger().revokeEntitlements(order.id);
  expect(refunded.state).toBe("refunded");
  expect((await ledger().entitlements(account))[0].effective).toBe("revoked");

  await expect(ledger().revokeEntitlements(order.id)).rejects.toMatchObject({
    code: "not_verified",
  });
});

afterAll(async () => {
  const accounts = await database
    .select({ id: testCreditAccounts.id })
    .from(testCreditAccounts)
    .where(
      inArray(
        testCreditAccounts.issuer,
        [
          "lock",
          "first",
          "mismatch",
          "advance",
          "pack",
          "refund",
          "order-1",
          "order-2",
          "order-3",
          "order-4",
        ].map((tag) => `paid-ledger-${tag}`),
      ),
    );
  const ids = accounts.map(({ id }) => id);
  if (ids.length > 0) {
    await database
      .delete(paidCreditAllocations)
      .where(inArray(paidCreditAllocations.accountId, ids));
    await database
      .delete(paidEntitlements)
      .where(inArray(paidEntitlements.accountId, ids));
    await database.delete(paidOrders).where(inArray(paidOrders.accountId, ids));
    await database
      .delete(testCreditAccounts)
      .where(inArray(testCreditAccounts.id, ids));
  }
  await database.delete(paidProducts);
  await database.$client.close();
});

// ── Consumption ordering (#101 AC3) ─────────────────────────────────────────

test("allocations spend the current period first, then packs by arrival", async () => {
  account = await freshAccount("order-1");
  await ledger().upsertProduct({
    code: "plan-monthly",
    kind: "subscription",
    priceCents: 2_900,
    creditsMicrocredits: 100n,
  });
  await ledger().upsertProduct({
    code: "pack-long",
    kind: "credit_pack",
    priceCents: 9_900,
    creditsMicrocredits: 50n,
  });
  const planOrder = await ledger().createOrder({
    accountId: account,
    productCode: "plan-monthly",
    channel: "wechat",
  });
  await ledger().verifyOrder({
    orderId: planOrder.id,
    channel: "wechat",
    channelOrderRef: `wx-order-1-plan-${run}`,
    amountCents: 2_900,
    paidAt,
  });
  const packA = await ledger().createOrder({
    accountId: account,
    productCode: "pack-long",
    channel: "wechat",
  });
  await ledger().verifyOrder({
    orderId: packA.id,
    channel: "wechat",
    channelOrderRef: `wx-order-1-packa-${run}`,
    amountCents: 9_900,
    paidAt: new Date(paidAt.getTime() + 60_000),
  });
  const packB = await ledger().createOrder({
    accountId: account,
    productCode: "pack-long",
    channel: "alipay",
  });
  await ledger().verifyOrder({
    orderId: packB.id,
    channel: "alipay",
    channelOrderRef: `ali-order-1-packb-${run}`,
    amountCents: 9_900,
    paidAt: new Date(paidAt.getTime() + 120_000),
  });

  const sources = await ledger().paidSources(account);
  expect(sources.map(({ kind }) => kind)).toEqual([
    "subscription",
    "credit_pack",
    "credit_pack",
  ]);

  const allocated = await ledger().allocate({
    accountId: account,
    operationId: "order-1-op-1",
    amountMicrocredits: 120n,
  });
  expect(allocated.state).toBe("allocated");
  const after = await ledger().paidSources(account);
  // 100 subscription + 20 of pack A drawn; the fully-drawn source stops
  // being offered.
  expect(
    after.map(({ remainingMicrocredits }) => remainingMicrocredits),
  ).toEqual(["30", "50"]);
});

test("expired sources cannot fund new allocations", async () => {
  account = await freshAccount("order-2");
  await ledger().upsertProduct({
    code: "plan-monthly",
    kind: "subscription",
    priceCents: 2_900,
    creditsMicrocredits: 100n,
  });
  const planOrder = await ledger().createOrder({
    accountId: account,
    productCode: "plan-monthly",
    channel: "wechat",
  });
  await ledger().verifyOrder({
    orderId: planOrder.id,
    channel: "wechat",
    channelOrderRef: `wx-order-2-plan-${run}`,
    amountCents: 2_900,
    paidAt,
  });
  const staleClock = new Date(paidAt.getTime() + 90 * 24 * 60 * 60_000);
  const stale = createPaidCreditLedger(database, () => staleClock);
  expect(await stale.paidSources(account)).toHaveLength(0);
  const denied = await stale.allocate({
    accountId: account,
    operationId: "order-2-op-1",
    amountMicrocredits: 1n,
  });
  expect(denied).toMatchObject({
    state: "denied",
    reason: "insufficient_credits",
  });
});

test("settlement consumes the allocated sources and releases return holds", async () => {
  account = await freshAccount("order-3");
  await ledger().upsertProduct({
    code: "pack-long",
    kind: "credit_pack",
    priceCents: 9_900,
    creditsMicrocredits: 50n,
  });
  const pack = await ledger().createOrder({
    accountId: account,
    productCode: "pack-long",
    channel: "wechat",
  });
  const verified = await ledger().verifyOrder({
    orderId: pack.id,
    channel: "wechat",
    channelOrderRef: `wx-order-3-pack-${run}`,
    amountCents: 9_900,
    paidAt,
  });

  await ledger().allocate({
    accountId: account,
    operationId: "order-3-charge",
    amountMicrocredits: 40n,
  });
  const settled = await ledger().settleAllocation({
    accountId: account,
    operationId: "order-3-charge",
    chargeMicrocredits: 30n,
  });
  expect(settled.state).toBe("settled");
  const [entitlement] = await ledger().entitlements(account);
  expect(entitlement.consumedMicrocredits).toBe(30n);
  expect((await ledger().paidSources(account))[0].remainingMicrocredits).toBe(
    "20",
  );

  // A held-but-unsettled operation releases without consuming.
  await ledger().allocate({
    accountId: account,
    operationId: "order-3-hold",
    amountMicrocredits: 15n,
  });
  const released = await ledger().releaseAllocation(account, "order-3-hold");
  expect(released.released).toBe(1);
  expect((await ledger().paidSources(account))[0].remainingMicrocredits).toBe(
    "20",
  );

  void verified;
});

test("concurrent allocations cannot overspend one source", async () => {
  account = await freshAccount("order-4");
  await ledger().upsertProduct({
    code: "pack-long",
    kind: "credit_pack",
    priceCents: 9_900,
    creditsMicrocredits: 10n,
  });
  const pack = await ledger().createOrder({
    accountId: account,
    productCode: "pack-long",
    channel: "wechat",
  });
  await ledger().verifyOrder({
    orderId: pack.id,
    channel: "wechat",
    channelOrderRef: `wx-order-4-pack-${run}`,
    amountCents: 9_900,
    paidAt,
  });
  const attempts = await Promise.all(
    [1, 2, 3].map((n) =>
      ledger().allocate({
        accountId: account,
        operationId: `order-4-op-${n}`,
        amountMicrocredits: 8n,
      }),
    ),
  );
  const allocated = attempts.filter((a) => a.state === "allocated");
  const denied = attempts.filter((a) => a.state === "denied");
  expect(allocated).toHaveLength(1);
  expect(denied).toHaveLength(2);
});
