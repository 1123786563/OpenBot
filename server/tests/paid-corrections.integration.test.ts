import { afterAll, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import { createDatabase } from "../src/db/client";
import {
  paidCorrections,
  paidCreditAllocations,
  paidEntitlements,
  paidOrders,
  paidProducts,
  paidRefunds,
  testCreditAccounts,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * #105: verified corrections never rewrite the original records. An
 * overcharge returns credits to the source that paid while it is still
 * valid, becomes non-expiring Correction Credits when it is not, and
 * platform-fault compensation books separately with full audit links.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const paidAt = new Date("2026-02-15T04:30:00.000Z"); // Beijing Feb 15 12:30
const ledger = () => createPaidCreditLedger(database, () => paidAt);
const run = crypto.randomUUID().slice(0, 8);

async function freshAccount(tag: string) {
  const [row] = await database
    .insert(testCreditAccounts)
    .values({
      issuer: `paid-corr-${tag}`,
      subject: crypto.randomUUID(),
    })
    .returning();
  return row.id;
}

test("an overcharge returns to a still-valid source and the bill keeps both lines", async () => {
  const account = await freshAccount("valid");
  await ledger().upsertProduct({
    code: "pack-corr",
    kind: "credit_pack",
    priceCents: 9_900,
    creditsMicrocredits: 100n,
  });
  const order = await ledger().createOrder({
    accountId: account,
    productCode: "pack-corr",
    channel: "alipay",
  });
  const verified = await ledger().verifyOrder({
    orderId: order.id,
    channel: "alipay",
    channelOrderRef: `ali-corr-1-${run}`,
    amountCents: 9_900,
    paidAt,
  });
  await ledger().allocate({
    accountId: account,
    operationId: "corr-op-1",
    amountMicrocredits: 30n,
  });
  await ledger().settleAllocation({
    accountId: account,
    operationId: "corr-op-1",
    chargeMicrocredits: 30n,
  });

  const correction = await ledger().correctOvercharge({
    accountId: account,
    operationId: "corr-op-1",
    amountMicrocredits: 10n,
    reason: "metered double count",
    evidence: "case-2026-041",
    by: "staff-b",
  });
  expect(correction).toMatchObject({
    kind: "overcharge_refund",
    entitlementId: verified.entitlement?.id ?? null,
    operationId: "corr-op-1",
    amountMicrocredits: 10n,
  });
  // The source that over-paid gets its credits back.
  expect((await ledger().entitlements(account))[0].consumedMicrocredits).toBe(
    20n,
  );
  expect((await ledger().paidSources(account))[0]?.remainingMicrocredits).toBe(
    "80",
  );

  // The bill keeps the original charge and links the correction beside it.
  const lines = await ledger().bill(account);
  const charge = lines.find(({ source }) => source === "credit_pack");
  const fixed = lines.find(({ source }) => source === "correction");
  expect(charge).toMatchObject({
    operationId: "corr-op-1",
    amountMicrocredits: "30",
  });
  expect(fixed).toMatchObject({
    operationId: "corr-op-1",
    amountMicrocredits: "10",
    reason: "metered double count",
  });
});

test("an overcharge on an expired source becomes non-expiring Correction Credits", async () => {
  const account = await freshAccount("expired");
  await ledger().upsertProduct({
    code: "plan-corr",
    kind: "subscription",
    priceCents: 2_900,
    creditsMicrocredits: 100n,
  });
  const order = await ledger().createOrder({
    accountId: account,
    productCode: "plan-corr",
    channel: "wechat",
  });
  const verified = await ledger().verifyOrder({
    orderId: order.id,
    channel: "wechat",
    channelOrderRef: `wx-corr-2-${run}`,
    amountCents: 2_900,
    paidAt,
  });
  void verified;
  await ledger().allocate({
    accountId: account,
    operationId: "corr-op-2",
    amountMicrocredits: 30n,
  });
  await ledger().settleAllocation({
    accountId: account,
    operationId: "corr-op-2",
    chargeMicrocredits: 30n,
  });

  // The same correction, verified after the period ended.
  const late = createPaidCreditLedger(
    database,
    () => new Date("2026-04-01T00:00:00.000Z"),
  );
  const correction = await late.correctOvercharge({
    accountId: account,
    operationId: "corr-op-2",
    amountMicrocredits: 12n,
    reason: "late verified overcharge",
    evidence: "case-2026-042",
    by: "staff-c",
  });
  expect(correction).toMatchObject({
    kind: "overcharge_refund",
    entitlementId: null,
    amountMicrocredits: 12n,
  });
  // The expired subscription is untouched; the credits are spendable now.
  const view = await late.entitlements(account);
  const [subscription, credits] = view;
  expect(subscription?.effective).toBe("expired");
  expect(subscription?.consumedMicrocredits).toBe(30n);
  expect(credits).toMatchObject({
    kind: "credit_pack",
    effective: "active",
    creditsMicrocredits: 12n,
  });
  const allocated = await late.allocate({
    accountId: account,
    operationId: "corr-op-3",
    amountMicrocredits: 5n,
  });
  expect(allocated.state).toBe("allocated");
});

test("fault compensation books separately and touches no period", async () => {
  const account = await freshAccount("fault");
  await ledger().upsertProduct({
    code: "plan-corr",
    kind: "subscription",
    priceCents: 2_900,
    creditsMicrocredits: 100n,
  });
  const order = await ledger().createOrder({
    accountId: account,
    productCode: "plan-corr",
    channel: "alipay",
  });
  const verified = await ledger().verifyOrder({
    orderId: order.id,
    channel: "alipay",
    channelOrderRef: `ali-corr-3-${run}`,
    amountCents: 2_900,
    paidAt,
  });
  const before = verified.entitlement;
  if (!before) throw new Error("subscription granted nothing");

  const compensation = await ledger().applyCompensation({
    accountId: account,
    amountMicrocredits: 50n,
    reason: "gateway outage on Feb 20",
    evidence: "case-2026-043",
    by: "staff-d",
  });
  expect(compensation).toMatchObject({
    kind: "fault_compensation",
    operationId: null,
    amountMicrocredits: 50n,
  });

  const view = await ledger().entitlements(account);
  const [subscription, credit] = view;
  // The original expiry and anchor are exactly as paid for.
  expect(subscription?.periodEnd).toEqual(before.periodEnd);
  expect(subscription?.anchorDay).toEqual(before.anchorDay);
  expect(credit).toMatchObject({ creditsMicrocredits: 50n });
  expect(
    (await ledger().bill(account)).find(
      ({ source }) => source === "correction",
    ),
  ).toMatchObject({
    amountMicrocredits: "50",
    reason: "gateway outage on Feb 20",
  });
});

afterAll(async () => {
  const accounts = await database
    .select({ id: testCreditAccounts.id })
    .from(testCreditAccounts)
    .where(
      inArray(
        testCreditAccounts.issuer,
        ["valid", "expired", "fault"].map((tag) => `paid-corr-${tag}`),
      ),
    );
  const ids = accounts.map(({ id }) => id);
  if (ids.length > 0) {
    await database
      .delete(paidCorrections)
      .where(inArray(paidCorrections.accountId, ids));
    await database
      .delete(paidRefunds)
      .where(inArray(paidRefunds.accountId, ids));
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
  await database
    .delete(paidProducts)
    .where(inArray(paidProducts.code, ["pack-corr", "plan-corr"]));
  await database.$client.close();
});
