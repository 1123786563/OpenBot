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
  paidRefunds,
  paidEntitlements,
  paidOrders,
  paidProducts,
  testCreditAccounts,
  testCreditBatches,
  testCreditEnrollments,
  testCreditEvidence,
  testCreditOperations,
} from "../src/db/schema";
import { fixtureTraceReport } from "./support/bifrost-evidence";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * #101 AC4: one reservation spans Test Credit and paid sources. The trial
 * balance holds its available part, the paid ledger holds the shortfall, and
 * settlement consumes each side in order while releases return both.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const routeId = "pilot-mixed";
// 1 microcredit per input token, so a hold is 10 and evidence of N input
// tokens charges exactly N.
const routeSpec = {
  provider: "fixture-mixed",
  model: "model-mixed",
  gatewayRevision: "mixed-r1",
  meteringRevision: "mixed-m1",
  maxInputTokens: 10,
  maxOutputTokens: 2,
  tools: false,
  price: { inputPerMillion: 1_000_000, outputPerMillion: 0 },
};
const harnessImage = `agent-langgraph-agui@sha256:${"c".repeat(64)}`;
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

let clockOffsetMs = 0;
const ledger = createTestCreditLedger(
  database,
  () => new Date(Date.now() + clockOffsetMs),
);
const paidLedger = createPaidCreditLedger(
  database,
  () => new Date("2026-02-15T04:30:00.000Z"),
);
const identities = [crypto.randomUUID(), crypto.randomUUID()].map(
  (subject) => ({ issuer: `mixed-funding-${subject}`, subject }),
);
const batchIds: string[] = [];
const run = crypto.randomUUID().slice(0, 8);

let originalCatalog: { value: unknown } | undefined;
let priceVersion = "";
const testGrant = 6n;
const packCredits = 100n;

async function quoteVersion() {
  const quote = await ledger.quote();
  if (!quote) throw new Error("no active quote");
  return quote;
}

async function accountIdOf(index: number) {
  const [row] = await database
    .select({ id: testCreditAccounts.id })
    .from(testCreditAccounts)
    .where(eq(testCreditAccounts.issuer, identities[index].issuer));
  if (!row) throw new Error("account missing");
  return row.id;
}

async function operationRow(operationId: string, index = 0) {
  const accountId = await accountIdOf(index);
  const [row] = await database
    .select()
    .from(testCreditOperations)
    .where(
      and(
        eq(testCreditOperations.accountId, accountId),
        eq(testCreditOperations.id, operationId),
      ),
    );
  return row;
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
  priceVersion = (await quoteVersion()).priceVersion;
  // Account 0: 6 test microcredits plus a 100-microcredit paid pack.
  const batchId = crypto.randomUUID();
  batchIds.push(batchId);
  await ledger.enroll({
    identity: identities[0],
    batchId,
    amount: testGrant,
  });
  await ledger.claim(identities[0], batchId);
  await paidLedger.upsertProduct({
    code: "pack-mixed",
    kind: "credit_pack",
    priceCents: 9_900,
    creditsMicrocredits: packCredits,
  });
  const order = await paidLedger.createOrder({
    accountId: await accountIdOf(0),
    productCode: "pack-mixed",
    channel: "wechat",
  });
  await paidLedger.verifyOrder({
    orderId: order.id,
    channel: "wechat",
    channelOrderRef: `wx-mixed-pack-${run}`,
    amountCents: 9_900,
    paidAt: new Date("2026-02-15T04:30:00.000Z"),
  });
  // Account 1: enrolled but never claimed — no test credits, no paid sources.
  const unclaimed = crypto.randomUUID();
  batchIds.push(unclaimed);
  await ledger.enroll({
    identity: identities[1],
    batchId: unclaimed,
    amount: 1_000n,
  });
});

afterAll(async () => {
  await database.transaction(async (tx) => {
    const accounts = tx
      .select({ id: testCreditAccounts.id })
      .from(testCreditAccounts)
      .where(
        inArray(
          testCreditAccounts.issuer,
          identities.map(({ issuer }) => issuer),
        ),
      );
    await tx
      .delete(paidCreditAllocations)
      .where(inArray(paidCreditAllocations.accountId, accounts));
    await tx
      .delete(paidEntitlements)
      .where(inArray(paidEntitlements.accountId, accounts));
    await tx
      .delete(paidRefunds)
      .where(inArray(paidRefunds.accountId, accounts));
    await tx.delete(paidOrders).where(inArray(paidOrders.accountId, accounts));
    await tx
      .delete(lagoUsageEvents)
      .where(inArray(lagoUsageEvents.accountId, accounts));
    await tx
      .delete(testCreditEvidence)
      .where(inArray(testCreditEvidence.accountId, accounts));
    await tx
      .delete(testCreditOperations)
      .where(inArray(testCreditOperations.accountId, accounts));
    await tx
      .delete(testCreditEnrollments)
      .where(inArray(testCreditEnrollments.accountId, accounts));
    await tx
      .delete(testCreditAccounts)
      .where(inArray(testCreditAccounts.id, accounts));
    for (const batchId of batchIds) {
      await tx
        .delete(testCreditBatches)
        .where(eq(testCreditBatches.id, batchId));
    }
    await tx.delete(paidProducts).where(eq(paidProducts.code, "pack-mixed"));
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

test("one reservation spans Test Credit and paid sources", async () => {
  const reserved = await ledger.reserve(identities[0], {
    operationId: "mixed-span",
    route: routeId,
    priceVersion,
  });
  expect(reserved).toMatchObject({ state: "reserved" });

  // The hold is 10: 6 test + 4 paid.
  const balance = await ledger.balance(identities[0]);
  expect(balance).toMatchObject({
    grantedMicrocredits: "6",
    reservedMicrocredits: "6",
    availableMicrocredits: "0",
  });
  const sources = await paidLedger.paidSources(await accountIdOf(0));
  expect(sources[0]?.remainingMicrocredits).toBe("96");

  if (reserved.state !== "reserved" || !reserved.permit)
    throw new Error("mixed reservation denied");
  await ledger.beginDispatch(identities[0], {
    operationId: "mixed-span",
    permit: reserved.permit,
  });

  // A 7-microcredit charge consumes all 6 test credits and 1 paid.
  const settled = await ledger.settle(await accountIdOf(0), "mixed-span", {
    inputTokens: 7n,
    outputTokens: 0n,
  });
  expect(settled?.state).toBe("settled");
  const row = await operationRow("mixed-span");
  expect(row).toMatchObject({
    charged: 7n,
    paidChargeMicrocredits: 1n,
    paidHoldMicrocredits: 0n,
  });
  expect(await ledger.balance(identities[0])).toMatchObject({
    chargedMicrocredits: "6",
    availableMicrocredits: "0",
  });
  expect(
    (await paidLedger.paidSources(await accountIdOf(0)))[0]
      ?.remainingMicrocredits,
  ).toBe("99");

  // The bill shows the charge split by the source that funded it, with the
  // source's original period and arrival time (#101 账单视图).
  const lines = await paidLedger.bill(await accountIdOf(0));
  expect(lines).toHaveLength(2);
  expect(lines.find(({ source }) => source === "test")).toMatchObject({
    operationId: "mixed-span",
    amountMicrocredits: "6",
    entitlementId: null,
    periodStart: null,
  });
  const paidLine = lines.find(({ source }) => source === "credit_pack");
  expect(paidLine).toMatchObject({
    operationId: "mixed-span",
    amountMicrocredits: "1",
    periodStart: null,
    periodEnd: null,
  });
  expect(paidLine?.entitlementId).toBeTruthy();
  expect(paidLine?.arrivedAt).toBeTruthy();
});

test("a released unsent reservation returns both sides", async () => {
  // The trial credits are spent, so this hold is entirely paid-side.
  const reserved = await ledger.reserve(identities[0], {
    operationId: "mixed-release",
    route: routeId,
    priceVersion,
  });
  if (reserved.state !== "reserved" || !reserved.permit)
    throw new Error("mixed reservation denied");
  expect(await operationRow("mixed-release")).toMatchObject({
    paidHoldMicrocredits: 10n,
  });
  expect(
    (await paidLedger.paidSources(await accountIdOf(0)))[0]
      ?.remainingMicrocredits,
  ).toBe("89");
  const dispatch = await ledger.beginDispatch(identities[0], {
    operationId: "mixed-release",
    permit: reserved.permit,
  });
  expect(dispatch.state).toBe("dispatch");

  await ledger.releaseUnsent(await accountIdOf(0), "mixed-release");
  expect(await operationRow("mixed-release")).toMatchObject({
    state: "released",
    paidHoldMicrocredits: 0n,
  });
  expect(await ledger.balance(identities[0])).toMatchObject({
    grantedMicrocredits: "6",
    reservedMicrocredits: "0",
    chargedMicrocredits: "6",
    availableMicrocredits: "0",
  });
  expect(
    (await paidLedger.paidSources(await accountIdOf(0)))[0]
      ?.remainingMicrocredits,
  ).toBe("99");
});

test("a cutoff without evidence releases the paid hold with the rest", async () => {
  const reserved = await ledger.reserve(identities[0], {
    operationId: "mixed-cutoff",
    route: routeId,
    priceVersion,
  });
  if (reserved.state !== "reserved" || !reserved.permit)
    throw new Error("mixed reservation denied");
  await ledger.beginDispatch(identities[0], {
    operationId: "mixed-cutoff",
    permit: reserved.permit,
  });
  clockOffsetMs = 24 * 60 * 60_000 + 2_000;
  await ledger.balance(identities[0]);
  clockOffsetMs = 0;

  expect(await operationRow("mixed-cutoff")).toMatchObject({
    state: "released",
    paidHoldMicrocredits: 0n,
  });
  expect(
    (await paidLedger.paidSources(await accountIdOf(0)))[0]
      ?.remainingMicrocredits,
  ).toBe("99");
});

test("a paid-only account reserves entirely from paid sources", async () => {
  // Account 1 claimed no test batch, so the whole hold comes from the pack —
  // but this account has no pack either, so both funders refuse.
  const noFunds = await ledger.reserve(identities[1], {
    operationId: "mixed-paid-only",
    route: routeId,
    priceVersion,
  });
  expect(noFunds).toMatchObject({
    state: "denied",
    reason: "not_authorized",
  });

  // Give account 1 its own pack: the full hold and charge are paid-side.
  await paidLedger.upsertProduct({
    code: "pack-mixed",
    kind: "credit_pack",
    priceCents: 9_900,
    creditsMicrocredits: packCredits,
  });
  const order = await paidLedger.createOrder({
    accountId: await accountIdOf(1),
    productCode: "pack-mixed",
    channel: "alipay",
  });
  await paidLedger.verifyOrder({
    orderId: order.id,
    channel: "alipay",
    channelOrderRef: `ali-mixed-pack-${run}`,
    amountCents: 9_900,
    paidAt: new Date("2026-02-15T04:30:00.000Z"),
  });
  const reserved = await ledger.reserve(identities[1], {
    operationId: "mixed-paid-span",
    route: routeId,
    priceVersion,
  });
  expect(reserved).toMatchObject({ state: "reserved" });
  expect(await operationRow("mixed-paid-span", 1)).toMatchObject({
    paidHoldMicrocredits: 10n,
  });
  expect(await ledger.balance(identities[1])).toMatchObject({
    grantedMicrocredits: "0",
    reservedMicrocredits: "0",
    availableMicrocredits: "0",
  });

  if (reserved.state !== "reserved" || !reserved.permit)
    throw new Error("paid-only reservation denied");
  await ledger.beginDispatch(identities[1], {
    operationId: "mixed-paid-span",
    permit: reserved.permit,
  });

  const settled = await ledger.settle(await accountIdOf(1), "mixed-paid-span", {
    inputTokens: 3n,
    outputTokens: 0n,
  });
  expect(settled?.state).toBe("settled");
  expect(await operationRow("mixed-paid-span", 1)).toMatchObject({
    charged: 3n,
    paidChargeMicrocredits: 3n,
  });
  expect(
    (await paidLedger.paidSources(await accountIdOf(1)))[0]
      ?.remainingMicrocredits,
  ).toBe("97");
});
