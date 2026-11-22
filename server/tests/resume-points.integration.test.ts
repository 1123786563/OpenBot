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
 * #107's safe resume point: a step that stops for want of credits or budget
 * room holds nothing, waits as a resume point, and reserves again only once
 * the person has confirmed a budget. Its bill line names the app it ran for,
 * and a reservation that never runs gives its paid hold back.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const routeId = "resume-point";
const routeSpec = {
  provider: "fixture-resume",
  model: "model-resume",
  gatewayRevision: "resume-r1",
  meteringRevision: "resume-m1",
  maxInputTokens: 10,
  maxOutputTokens: 2,
  tools: false,
  price: { inputPerMillion: 1_000_000, outputPerMillion: 0 },
};
const harnessImage = `agent-langgraph-agui@sha256:${"e".repeat(64)}`;
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
const paidAt = new Date("2026-02-15T04:30:00.000Z");
const paidLedger = createPaidCreditLedger(database, () => paidAt);
const run = crypto.randomUUID().slice(0, 8);
const batchIds: string[] = [];

let originalCatalog: { value: unknown } | undefined;
let priceVersion = "";

async function enrolled(tag: string, testGrant: bigint) {
  const identity = {
    issuer: `resume-point-${tag}`,
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
  if (!row) throw new Error(`no Billing Account for the ${tag} identity`);
  return { identity, accountId: row.id };
}

async function boughtPack(accountId: string, credits: bigint, ref: string) {
  await paidLedger.upsertProduct({
    code: "pack-resume",
    kind: "credit_pack",
    priceCents: 9_900,
    creditsMicrocredits: credits,
  });
  const order = await paidLedger.createOrder({
    accountId,
    productCode: "pack-resume",
    channel: "alipay",
  });
  await paidLedger.verifyOrder({
    orderId: order.id,
    channel: "alipay",
    channelOrderRef: ref,
    amountCents: 9_900,
    paidAt,
  });
  return order;
}

async function budgetOf(
  identity: { issuer: string; subject: string },
  input: Parameters<typeof ledger.createBudget>[1],
) {
  const budget = await ledger.createBudget(identity, input);
  if (!budget) throw new Error("budget was not created");
  return budget;
}

async function operationRow(accountId: string, id: string) {
  const [row] = await database
    .select()
    .from(testCreditOperations)
    .where(
      and(
        eq(testCreditOperations.accountId, accountId),
        eq(testCreditOperations.id, id),
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
  priceVersion = (await ledger.quote())?.priceVersion ?? "";
});

afterAll(async () => {
  await database.transaction(async (tx) => {
    // By issuer tags, so orphaned rows from a crashed run clean up too.
    const rows = await tx
      .select({ id: testCreditAccounts.id })
      .from(testCreditAccounts)
      .where(
        inArray(
          testCreditAccounts.issuer,
          ["pause", "limit", "hold"].map((tag) => `resume-point-${tag}`),
        ),
      );
    const ids = rows.map(({ id }) => id);
    if (ids.length > 0) {
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
    for (const batchId of batchIds)
      await tx
        .delete(testCreditBatches)
        .where(eq(testCreditBatches.id, batchId));
    await tx.delete(paidProducts).where(eq(paidProducts.code, "pack-resume"));
  });
  if (originalCatalog) {
    await database
      .update(enterpriseSettings)
      .set({ value: originalCatalog.value as Record<string, unknown> })
      .where(eq(enterpriseSettings.key, pilotCatalogKey));
  } else {
    await database
      .delete(enterpriseSettings)
      .where(eq(enterpriseSettings.key, pilotCatalogKey));
  }
  await database.$client.close();
});

test("a step out of trial credits pauses there and continues only on a budget the person confirmed", async () => {
  const { identity, accountId } = await enrolled("pause", 6n);
  await boughtPack(accountId, 100n, `ali-resume-1-${run}`);

  // The runner's next step asks for the trial entry. Six cannot cover ten.
  const request = {
    operationId: "resume-op-1",
    route: routeId,
    priceVersion,
    creditType: "test" as const,
    applicationId: "weknora",
  };
  expect(await ledger.reserve(identity, request)).toEqual({
    state: "denied",
    reason: "insufficient_credits",
  });
  expect(await ledger.resumePoints(identity)).toMatchObject([
    {
      operationId: "resume-op-1",
      applicationId: "weknora",
      reason: "insufficient_credits",
      budgetId: null,
      creditType: null,
    },
  ]);
  // A paused step holds nothing, on either side.
  expect(await ledger.balance(identity)).toMatchObject({
    reservedMicrocredits: "0",
    availableMicrocredits: "6",
  });
  expect(await paidLedger.paidBalance(accountId)).toEqual({
    availableMicrocredits: "100",
    reservedMicrocredits: "0",
    chargedMicrocredits: "0",
  });

  // Trying again changes nothing until the person confirms. The pack stays
  // untouched, though it could cover the step.
  expect(await ledger.reserve(identity, request)).toEqual({
    state: "denied",
    reason: "insufficient_credits",
  });
  expect(await paidLedger.paidBalance(accountId)).toMatchObject({
    availableMicrocredits: "100",
    reservedMicrocredits: "0",
  });

  // The confirmation is the person's own budget, confirmed, and a step that
  // ran out of credits continues on paid credits only.
  const trial = await budgetOf(identity, {
    budgetId: "resume-trial-budget",
    creditType: "test",
    limitMicrocredits: 50n,
  });
  const unconfirmed = await budgetOf(identity, {
    budgetId: "resume-unconfirmed",
    creditType: "paid",
    limitMicrocredits: 50n,
    confirmed: false,
  });
  expect(
    await ledger.confirmResumePoint(identity, "resume-op-1", trial.budgetId),
  ).toEqual({ state: "denied" });
  expect(
    await ledger.confirmResumePoint(
      identity,
      "resume-op-1",
      unconfirmed.budgetId,
    ),
  ).toEqual({ state: "denied" });
  expect(
    await ledger.confirmResumePoint(
      identity,
      "no-such-step",
      unconfirmed.budgetId,
    ),
  ).toBeUndefined();
  expect(await ledger.reserve(identity, request)).toEqual({
    state: "denied",
    reason: "insufficient_credits",
  });

  const paid = await budgetOf(identity, {
    budgetId: "resume-paid-budget",
    creditType: "paid",
    limitMicrocredits: 50n,
  });
  expect(
    await ledger.confirmResumePoint(identity, "resume-op-1", paid.budgetId),
  ).toMatchObject({
    state: "confirmed",
    operationId: "resume-op-1",
    budgetId: "resume-paid-budget",
    creditType: "paid",
  });
  expect(await ledger.resumePoints(identity)).toMatchObject([
    {
      operationId: "resume-op-1",
      budgetId: "resume-paid-budget",
      creditType: "paid",
    },
  ]);

  // The runner asks exactly as it did. The step reserves on the confirmed
  // budget, from paid sources, and leaves the waiting list.
  const reserved = await ledger.reserve(identity, request);
  if (reserved.state !== "reserved" || !reserved.permit)
    throw new Error("the confirmed step did not reserve");
  expect(await operationRow(accountId, "resume-op-1")).toMatchObject({
    budgetId: "resume-paid-budget",
    paidHoldMicrocredits: 10n,
    applicationId: "weknora",
  });
  expect(await ledger.resumePoints(identity)).toEqual([]);
  expect(await ledger.balance(identity)).toMatchObject({
    reservedMicrocredits: "0",
    availableMicrocredits: "6",
  });
  expect(await paidLedger.paidBalance(accountId)).toEqual({
    availableMicrocredits: "90",
    reservedMicrocredits: "10",
    chargedMicrocredits: "0",
  });
  // A replay of the same request still answers with the reservation.
  expect(await ledger.reserve(identity, request)).toMatchObject({
    state: "existing",
    permit: reserved.permit,
  });
  // The step is under way: there is nothing left to confirm for it.
  expect(
    await ledger.confirmResumePoint(identity, "resume-op-1", paid.budgetId),
  ).toBeUndefined();

  // A paid budget dispatches, and the charge is the paid side's alone.
  expect(
    await ledger.beginDispatch(identity, {
      operationId: "resume-op-1",
      permit: reserved.permit,
    }),
  ).toMatchObject({ state: "dispatch" });
  expect(
    (
      await ledger.settle(accountId, "resume-op-1", {
        inputTokens: 7n,
        outputTokens: 0n,
      })
    )?.state,
  ).toBe("settled");
  expect(await ledger.balance(identity)).toMatchObject({
    availableMicrocredits: "6",
    chargedMicrocredits: "0",
  });
  expect(await paidLedger.paidBalance(accountId)).toEqual({
    availableMicrocredits: "93",
    reservedMicrocredits: "0",
    chargedMicrocredits: "7",
  });

  // A step that names no app draws the trial balance first and the pack for
  // the rest, so each Credit type pays its own share.
  const mixed = await ledger.reserve(identity, {
    operationId: "resume-op-2",
    route: routeId,
    priceVersion,
  });
  if (mixed.state !== "reserved" || !mixed.permit)
    throw new Error("the mixed step did not reserve");
  await ledger.beginDispatch(identity, {
    operationId: "resume-op-2",
    permit: mixed.permit,
  });
  await ledger.settle(accountId, "resume-op-2", {
    inputTokens: 7n,
    outputTokens: 0n,
  });
  expect(await ledger.balance(identity)).toMatchObject({
    availableMicrocredits: "0",
    chargedMicrocredits: "6",
  });
  expect(await paidLedger.paidBalance(accountId)).toEqual({
    availableMicrocredits: "92",
    reservedMicrocredits: "0",
    chargedMicrocredits: "8",
  });

  // Every bill line names the app its step ran for.
  const bill = await paidLedger.bill(accountId);
  expect(bill).toHaveLength(3);
  expect(bill).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        operationId: "resume-op-1",
        source: "credit_pack",
        applicationId: "weknora",
        amountMicrocredits: "7",
      }),
      expect.objectContaining({
        operationId: "resume-op-2",
        source: "test",
        applicationId: null,
        amountMicrocredits: "6",
      }),
      expect.objectContaining({
        operationId: "resume-op-2",
        source: "credit_pack",
        applicationId: null,
        amountMicrocredits: "1",
      }),
    ]),
  );
});

test("a step over its budget continues on a new budget the person confirms", async () => {
  const { identity, accountId } = await enrolled("limit", 40n);
  const small = await budgetOf(identity, {
    budgetId: "limit-small",
    creditType: "test",
    limitMicrocredits: 12n,
  });
  const step = (operationId: string) => ({
    operationId,
    route: routeId,
    priceVersion,
    budgetId: small.budgetId,
  });
  const first = await ledger.reserve(identity, step("limit-op-1"));
  if (first.state !== "reserved" || !first.permit)
    throw new Error("the first step did not reserve");
  await ledger.beginDispatch(identity, {
    operationId: "limit-op-1",
    permit: first.permit,
  });
  await ledger.settle(accountId, "limit-op-1", {
    inputTokens: 7n,
    outputTokens: 0n,
  });

  // Ten of the twelve are spoken for: the next step has no room.
  expect(await ledger.reserve(identity, step("limit-op-2"))).toEqual({
    state: "denied",
    reason: "execution_limit",
  });
  expect(await ledger.resumePoints(identity)).toMatchObject([
    { operationId: "limit-op-2", reason: "execution_limit" },
  ]);
  expect(await ledger.balance(identity)).toMatchObject({
    reservedMicrocredits: "0",
  });

  // A budget with no room for the step cannot continue it. The step waits
  // again, with nothing confirmed, so the person can pick another.
  const tiny = await budgetOf(identity, {
    budgetId: "limit-tiny",
    creditType: "test",
    limitMicrocredits: 5n,
  });
  expect(
    await ledger.confirmResumePoint(identity, "limit-op-2", tiny.budgetId),
  ).toMatchObject({ state: "confirmed" });
  expect(await ledger.reserve(identity, step("limit-op-2"))).toEqual({
    state: "denied",
    reason: "execution_limit",
  });
  expect(await ledger.resumePoints(identity)).toMatchObject([
    { operationId: "limit-op-2", reason: "execution_limit", budgetId: null },
  ]);

  // A step that ran out of budget room continues on a budget of either type.
  const roomier = await budgetOf(identity, {
    budgetId: "limit-roomier",
    creditType: "test",
    limitMicrocredits: 40n,
  });
  expect(
    await ledger.confirmResumePoint(identity, "limit-op-2", roomier.budgetId),
  ).toMatchObject({ state: "confirmed", creditType: "test" });
  expect((await ledger.reserve(identity, step("limit-op-2"))).state).toBe(
    "reserved",
  );
  expect(await operationRow(accountId, "limit-op-2")).toMatchObject({
    budgetId: "limit-roomier",
    paidHoldMicrocredits: 0n,
  });
  expect(await ledger.resumePoints(identity)).toEqual([]);
  expect(await paidLedger.paidBalance(accountId)).toEqual({
    availableMicrocredits: "0",
    reservedMicrocredits: "0",
    chargedMicrocredits: "0",
  });
});

test("a reservation that is refused at dispatch gives its paid hold back", async () => {
  const { identity, accountId } = await enrolled("hold", 6n);
  await boughtPack(accountId, 100n, `ali-resume-3-${run}`);
  const budget = await budgetOf(identity, {
    budgetId: "hold-budget",
    creditType: "paid",
    limitMicrocredits: 100n,
  });
  let clock = new Date();
  const timed = createTestCreditLedger(database, () => clock);
  const reserved = await timed.reserve(identity, {
    operationId: "hold-op-1",
    route: routeId,
    priceVersion,
    creditType: "paid",
    budgetId: budget.budgetId,
  });
  if (reserved.state !== "reserved" || !reserved.permit)
    throw new Error("the paid reservation did not reserve");
  expect(await paidLedger.paidBalance(accountId)).toMatchObject({
    availableMicrocredits: "90",
    reservedMicrocredits: "10",
  });

  // The runner arrives after the reservation's five minutes, so it is too
  // old to run.
  clock = new Date(clock.getTime() + 6 * 60_000);
  expect(
    await timed.beginDispatch(identity, {
      operationId: "hold-op-1",
      permit: reserved.permit,
    }),
  ).toEqual({ state: "denied", reason: "route_unavailable" });
  expect(await operationRow(accountId, "hold-op-1")).toMatchObject({
    state: "released",
    paidHoldMicrocredits: 0n,
  });
  expect(await paidLedger.paidBalance(accountId)).toEqual({
    availableMicrocredits: "100",
    reservedMicrocredits: "0",
    chargedMicrocredits: "0",
  });
});
