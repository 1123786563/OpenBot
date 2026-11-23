import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import { createTestCreditLedger } from "../src/billing/test-credit";
import { createDatabase } from "../src/db/client";
import {
  enterpriseSettings,
  lagoUsageEvents,
  paidCreditAllocations,
  paidEntitlements,
  paidOrders,
  paidProducts,
  paidRefunds,
  testCreditAccounts,
  testCreditBatches,
  testCreditBudgets,
  testCreditEnrollments,
  testCreditEvidence,
  testCreditOperations,
} from "../src/db/schema";
import { fixtureTraceReport } from "./support/bifrost-evidence";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * #107/#109 at the seam: the pilot wind-down switch stops sales and new
 * reservations of either Credit type while dispatched work keeps settling;
 * payments confirmed at or after the cutoff refund in full without
 * granting; and closure disposition refunds independent orders immediately
 * while orders still funding held reservations wait. The two entries also
 * choose their Credit type: "test" spends Test Credit only, "paid" paid
 * sources only, with the budget fixing the type at task start.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const routeId = "pilot-close";
const routeSpec = {
  provider: "fixture-close",
  model: "model-close",
  gatewayRevision: "close-r1",
  meteringRevision: "close-m1",
  maxInputTokens: 10,
  maxOutputTokens: 2,
  tools: false,
  price: { inputPerMillion: 1_000_000, outputPerMillion: 0 },
};
const harnessImage = `agent-langgraph-agui@sha256:${"d".repeat(64)}`;
const drafted = configure(emptyCatalog, {
  harnessImage,
  routes: { [routeId]: routeSpec },
});
const proposed = drafted.routes[routeId];
if (!proposed) throw new Error("fixture route missing");
const { catalog } = publish(
  verify(drafted, routeId, fixtureTraceReport(harnessImage, proposed), "test"),
  [routeId],
  routeId,
  "test",
);

const ledger = createTestCreditLedger(database);
const paidAt = new Date("2026-02-15T04:30:00.000Z"); // Beijing Feb 15 12:30
const paidLedger = createPaidCreditLedger(database, () => paidAt);
const run = crypto.randomUUID().slice(0, 8);
const batchIds: string[] = [];

let originalCatalog: { value: unknown } | undefined;
let priceVersion = "";

async function enrolled(tag: string, testGrant: bigint) {
  const identity = {
    issuer: `pilot-close-${tag}`,
    subject: crypto.randomUUID(),
  };
  const batchId = crypto.randomUUID();
  batchIds.push(batchId);
  await ledger.enroll({ identity, batchId, amount: testGrant });
  await ledger.claim(identity, batchId);
  const [row] = await database
    .select({ id: testCreditAccounts.id })
    .from(testCreditAccounts)
    .where(
      and(
        eq(testCreditAccounts.issuer, identity.issuer),
        eq(testCreditAccounts.subject, identity.subject),
      ),
    );
  return { identity, accountId: row.id };
}

async function boughtPack(
  accountId: string,
  credits: bigint,
  ref: string,
  at = paidAt,
  cents = 9_900,
) {
  await paidLedger.upsertProduct({
    code: "pack-close",
    kind: "credit_pack",
    priceCents: cents,
    creditsMicrocredits: credits,
  });
  const order = await paidLedger.createOrder({
    accountId,
    productCode: "pack-close",
    channel: "alipay",
  });
  await paidLedger.verifyOrder({
    orderId: order.id,
    channel: "alipay",
    channelOrderRef: ref,
    amountCents: cents,
    paidAt: at,
  });
  return order;
}

beforeAll(async () => {
  [originalCatalog] = await database
    .select()
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, pilotCatalogKey));
  await database
    .insert(enterpriseSettings)
    .values({ key: pilotCatalogKey, value: catalog })
    .onConflictDoUpdate({
      target: enterpriseSettings.key,
      set: { value: catalog },
    });
  priceVersion = (await ledger.quote())?.priceVersion ?? "";
});

afterAll(async () => {
  // The wind-down switch is a singleton: leave it open for other suites.
  await paidLedger.setPilotClosure({ stopSales: false, stopReserves: false });
  await database.transaction(async (tx) => {
    // By issuer tags, so orphaned rows from a crashed run clean up too.
    const rows = await tx
      .select({ id: testCreditAccounts.id })
      .from(testCreditAccounts)
      .where(
        inArray(
          testCreditAccounts.issuer,
          ["stop", "cutoff", "dispose", "entry"].map(
            (tag) => `pilot-close-${tag}`,
          ),
        ),
      );
    const ids = rows.map(({ id }) => id);
    if (ids.length > 0) {
      await tx.delete(paidRefunds).where(inArray(paidRefunds.accountId, ids));
      await tx
        .delete(paidCreditAllocations)
        .where(inArray(paidCreditAllocations.accountId, ids));
      await tx
        .delete(paidEntitlements)
        .where(inArray(paidEntitlements.accountId, ids));
      await tx.delete(paidOrders).where(inArray(paidOrders.accountId, ids));
      await tx
        .delete(lagoUsageEvents)
        .where(inArray(lagoUsageEvents.accountId, ids));
      await tx
        .delete(testCreditEvidence)
        .where(inArray(testCreditEvidence.accountId, ids));
      await tx
        .delete(testCreditOperations)
        .where(inArray(testCreditOperations.accountId, ids));
      await tx
        .delete(testCreditBudgets)
        .where(inArray(testCreditBudgets.accountId, ids));
      await tx
        .delete(testCreditEnrollments)
        .where(inArray(testCreditEnrollments.accountId, ids));
      await tx
        .delete(testCreditAccounts)
        .where(inArray(testCreditAccounts.id, ids));
    }
    for (const batchId of batchIds) {
      await tx
        .delete(testCreditBatches)
        .where(eq(testCreditBatches.id, batchId));
    }
    await tx.delete(paidProducts).where(eq(paidProducts.code, "pack-close"));
  });
  if (originalCatalog) {
    await database
      .update(enterpriseSettings)
      .set({
        value: originalCatalog.value as Record<string, unknown>,
      })
      .where(eq(enterpriseSettings.key, pilotCatalogKey));
  } else {
    await database
      .delete(enterpriseSettings)
      .where(eq(enterpriseSettings.key, pilotCatalogKey));
  }
  await database.$client.close();
});

test("wind-down stops sales and new reservations; dispatched work settles", async () => {
  const { identity, accountId } = await enrolled("stop", 6n);
  await boughtPack(accountId, 100n, `ali-close-1-${run}`);
  const reserved = await ledger.reserve(identity, {
    operationId: "close-op-1",
    route: routeId,
    priceVersion,
  });
  if (reserved.state !== "reserved" || !reserved.permit)
    throw new Error("reservation denied before closure");
  await ledger.beginDispatch(identity, {
    operationId: "close-op-1",
    permit: reserved.permit,
  });

  await paidLedger.setPilotClosure({ stopSales: true, stopReserves: true });
  await expect(
    paidLedger.createOrder({
      accountId,
      productCode: "pack-close",
      channel: "alipay",
    }),
  ).rejects.toMatchObject({ code: "pilot_closed" });
  expect(
    await ledger.reserve(identity, {
      operationId: "close-op-2",
      route: routeId,
      priceVersion,
    }),
  ).toMatchObject({ state: "denied", reason: "pilot_closed" });
  expect(
    await ledger.reserve(identity, {
      operationId: "close-op-3",
      route: routeId,
      priceVersion,
      creditType: "paid",
    }),
  ).toMatchObject({ state: "denied", reason: "pilot_closed" });

  // 已派发调用仍按原预留结算.
  const settled = await ledger.settle(accountId, "close-op-1", {
    inputTokens: 3n,
    outputTokens: 0n,
  });
  expect(settled?.state).toBe("settled");
  await paidLedger.setPilotClosure({ stopSales: false, stopReserves: false });
});

test("payments before the cutoff grant; at and after it refund in full", async () => {
  const { accountId } = await enrolled("cutoff", 6n);
  const before = await paidLedger.createOrder({
    accountId,
    productCode: "pack-close",
    channel: "wechat",
  });
  const atCutoff = await paidLedger.createOrder({
    accountId,
    productCode: "pack-close",
    channel: "alipay",
  });
  const after = await paidLedger.createOrder({
    accountId,
    productCode: "pack-close",
    channel: "alipay",
  });
  await paidLedger.setPilotClosure({ stopSales: true, stopReserves: true });

  const granted = await paidLedger.verifyOrder({
    orderId: before.id,
    channel: "wechat",
    channelOrderRef: `wx-cut-1-${run}`,
    amountCents: 9_900,
    paidAt: new Date(paidAt.getTime() - 3_600_000),
  });
  expect(granted.claimed).toBe(true);

  for (const [order, ref, when] of [
    [atCutoff, `ali-cut-2-${run}`, paidAt],
    [after, `ali-cut-3-${run}`, new Date(paidAt.getTime() + 3_600_000)],
  ] as const) {
    const landed = await paidLedger.verifyOrder({
      orderId: order.id,
      channel: "alipay",
      channelOrderRef: ref,
      amountCents: 9_900,
      paidAt: when,
    });
    expect(landed.claimed).toBe(false);
    expect(landed.refund).toMatchObject({
      state: "requested",
      reason: "pilot_closure",
      channel: "alipay",
      amountCents: 9_900,
    });
  }
  expect(await paidLedger.entitlements(accountId)).toHaveLength(1);
  await paidLedger.setPilotClosure({ stopSales: false, stopReserves: false });
});

test("closure disposition refunds free orders now and waits for held ones", async () => {
  const { accountId } = await enrolled("dispose", 6n);
  // Distinct arrivals so allocation order is deterministic: the waiting
  // order's pack arrives first and is exactly the size of its live hold, so
  // the partial order's consumption lands on its own pack.
  const waiting = await boughtPack(accountId, 20n, `ali-disp-a-${run}`);
  const partial = await boughtPack(
    accountId,
    30n,
    `ali-disp-c-${run}`,
    new Date(paidAt.getTime() + 60_000),
  );
  const free = await boughtPack(
    accountId,
    30n,
    `ali-disp-b-${run}`,
    new Date(paidAt.getTime() + 120_000),
  );

  // The waiting order still funds a live hold; the partial order consumed.
  await paidLedger.allocate({
    accountId,
    operationId: "close-hold",
    amountMicrocredits: 20n,
  });
  await paidLedger.allocate({
    accountId,
    operationId: "close-part",
    amountMicrocredits: 10n,
  });
  await paidLedger.settleAllocation({
    accountId,
    operationId: "close-part",
    chargeMicrocredits: 10n,
  });

  const previouslyFailed = await boughtPack(
    accountId,
    10n,
    `ali-disp-failed-${run}`,
    new Date(paidAt.getTime() + 180_000),
  );
  const failedRefund = await paidLedger.requestRefund(previouslyFailed.id);
  await paidLedger.confirmRefund(previouslyFailed.id, false);
  await paidLedger.setPilotClosure({ stopSales: true, stopReserves: true });
  await paidLedger.closePilotOrders(accountId);
  const refundRows = await paidLedger.refunds(accountId);
  expect(refundRows.find(({ orderId }) => orderId === free.id)).toMatchObject({
    state: "requested",
    usedMicrocredits: null,
    manualReviewCents: null,
  });
  expect(
    refundRows.find(({ orderId }) => orderId === partial.id),
  ).toMatchObject({
    state: "manual_review",
    usedMicrocredits: 10n,
    manualReviewCents: 3_300,
  });
  expect(
    refundRows.find(({ orderId }) => orderId === previouslyFailed.id),
  ).toMatchObject({ id: failedRefund.id, state: "manual_owed" });
  const waitingRefund = refundRows.find(
    ({ orderId }) => orderId === waiting.id,
  );
  expect(waitingRefund).toMatchObject({ state: "awaiting_settlement" });
  const view = await paidLedger.entitlements(accountId);
  expect(view.find(({ orderId }) => orderId === free.id)?.effective).toBe(
    "frozen",
  );
  expect(view.find(({ orderId }) => orderId === waiting.id)?.effective).toBe(
    "active",
  );

  await paidLedger.releaseAllocation(accountId, "close-hold");
  await paidLedger.closePilotOrders(accountId);
  expect(
    (await paidLedger.refunds(accountId)).find(
      ({ orderId }) => orderId === waiting.id,
    ),
  ).toMatchObject({ id: waitingRefund?.id, state: "requested" });
  await paidLedger.confirmRefund(waiting.id, true);
  expect(
    (await paidLedger.entitlements(accountId)).find(
      ({ orderId }) => orderId === waiting.id,
    )?.effective,
  ).toBe("revoked");
  await paidLedger.setPilotClosure({ stopSales: false, stopReserves: false });
});

test("the paid entry funds from paid sources only, under a paid budget", async () => {
  const { identity, accountId } = await enrolled("entry", 6n);
  await boughtPack(accountId, 100n, `ali-entry-1-${run}`);

  const reserved = await ledger.reserve(identity, {
    operationId: "entry-op-1",
    route: routeId,
    priceVersion,
    creditType: "paid",
  });
  expect(reserved).toMatchObject({ state: "reserved" });
  // Test Credit is untouched: still all six available.
  expect(await ledger.balance(identity)).toMatchObject({
    grantedMicrocredits: "6",
    reservedMicrocredits: "0",
    availableMicrocredits: "6",
  });
  const [row] = await database
    .select()
    .from(testCreditOperations)
    .where(
      and(
        eq(testCreditOperations.accountId, accountId),
        eq(testCreditOperations.id, "entry-op-1"),
      ),
    );
  expect(row).toMatchObject({ paidHoldMicrocredits: 10n });

  if (reserved.state !== "reserved" || !reserved.permit)
    throw new Error("paid reservation denied");
  await ledger.beginDispatch(identity, {
    operationId: "entry-op-1",
    permit: reserved.permit,
  });
  const settled = await ledger.settle(accountId, "entry-op-1", {
    inputTokens: 7n,
    outputTokens: 0n,
  });
  expect(settled?.state).toBe("settled");
  expect(
    (
      await database
        .select()
        .from(testCreditOperations)
        .where(
          and(
            eq(testCreditOperations.accountId, accountId),
            eq(testCreditOperations.id, "entry-op-1"),
          ),
        )
    )[0],
  ).toMatchObject({ charged: 7n, paidChargeMicrocredits: 7n });
  expect(await ledger.balance(identity)).toMatchObject({
    chargedMicrocredits: "0",
  });
  expect(
    (await paidLedger.paidSources(accountId))[0]?.remainingMicrocredits,
  ).toBe("93");

  // The trial entry spends Test Credit only: 6 cannot cover 10, and the
  // pack is never drawn.
  expect(
    await ledger.reserve(identity, {
      operationId: "entry-op-2",
      route: routeId,
      priceVersion,
      creditType: "test",
    }),
  ).toMatchObject({ state: "denied", reason: "insufficient_credits" });
  expect(
    (await paidLedger.paidSources(accountId))[0]?.remainingMicrocredits,
  ).toBe("93");

  // A task fixes its type: a paid budget refuses the trial entry, and a
  // paid entry under a test budget is refused.
  const budget = await ledger.createBudget(identity, {
    budgetId: "entry-paid-budget",
    creditType: "paid",
    limitMicrocredits: 100n,
  });
  expect(budget).toMatchObject({ creditType: "paid" });
  expect(
    await ledger.reserve(identity, {
      operationId: "entry-op-3",
      route: routeId,
      priceVersion,
      creditType: "test",
      budgetId: "entry-paid-budget",
    }),
  ).toMatchObject({ state: "denied", reason: "not_authorized" });
  const testBudget = await ledger.createBudget(identity, {
    budgetId: "entry-test-budget",
    creditType: "test",
    limitMicrocredits: 100n,
  });
  expect(testBudget).toMatchObject({ creditType: "test" });
  expect(
    await ledger.reserve(identity, {
      operationId: "entry-op-4",
      route: routeId,
      priceVersion,
      creditType: "paid",
      budgetId: "entry-test-budget",
    }),
  ).toMatchObject({ state: "denied", reason: "not_authorized" });
});
