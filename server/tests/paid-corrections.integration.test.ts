import { afterAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import { createApp } from "../src/app";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import { createTestCreditLedger } from "../src/billing/test-credit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  enterpriseSettings,
  lagoUsageEvents,
  paidCorrections,
  paidCreditAllocations,
  paidEntitlements,
  paidOrders,
  paidProducts,
  paidRefunds,
  testCreditAccounts,
  testCreditEvidence,
  testCreditOperations,
} from "../src/db/schema";
import { fixtureTraceReport } from "./support/bifrost-evidence";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

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

const staff = "staff-corrections";
let customer = "";
let clock = paidAt;
const testLedger = createTestCreditLedger(database, () => clock);
const config = loadConfig(testEnvironment());
const app = createApp(
  config,
  {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async ({ headers }) => {
        const id = headers.get("x-fixture-user");
        return id ? { user: { id, email: "fixture@example.test" } } : null;
      },
    },
  },
  { rolesForUser: async (id) => (id === staff ? ["admin"] : ["user"]) },
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  {
    testLedger,
    paidLedger: createPaidCreditLedger(database, () => clock),
    runtime: {
      authenticate: async (request) =>
        request.headers.get("x-fixture-runtime") === customer
          ? { issuer: "openbot", subject: customer }
          : undefined,
      execute: async () => {
        clock = new Date("2026-03-14T16:01:00.000Z");
        return {
          text: "Fixture result after outage",
          usage: { inputTokens: 25, outputTokens: 0 },
        };
      },
    },
  },
);
function executionCall(path: string, payload: Record<string, unknown>) {
  return app.request(`/api/billing/v1/${path}`, {
    method: "POST",
    headers: {
      "x-fixture-runtime": customer,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

const operatorPath = "/api/admin/billing/corrections";
function postCorrection(payload: Record<string, unknown>, actor = staff) {
  return app.request(operatorPath, {
    method: "POST",
    headers: { "x-fixture-user": actor, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
async function readPaid(path: string) {
  const response = await app.request(`/api/billing/paid/${path}`, {
    headers: { "x-fixture-user": customer },
  });
  expect(response.status).toBe(200);
  return response.json();
}

const fixtureAccounts: string[] = [];
async function freshAccount() {
  clock = paidAt;
  customer = crypto.randomUUID();
  const [row] = await database
    .insert(testCreditAccounts)
    .values({
      issuer: "openbot",
      subject: customer,
    })
    .returning();
  fixtureAccounts.push(row.id);
  return row.id;
}

test("an overcharge returns to a still-valid source and the bill keeps both lines", async () => {
  const account = await freshAccount();
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

  const payload = {
    kind: "overcharge_refund",
    accountId: account,
    operationId: "corr-op-1",
    amountMicrocredits: "10",
    reason: "metered double count",
    evidence: "case-2026-041",
  };
  expect((await postCorrection(payload, "")).status).toBe(401);
  expect((await postCorrection(payload, customer)).status).toBe(403);
  expect((await postCorrection({ ...payload, by: "forged" })).status).toBe(400);
  expect(
    (await postCorrection({ ...payload, amountMicrocredits: "31" })).status,
  ).toBe(409);
  const responses = await Promise.all([
    postCorrection(payload),
    postCorrection(payload),
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  const [first, retry] = await Promise.all(
    responses.map((response) => response.json()),
  );
  expect(retry).toEqual(first);
  expect(first).toMatchObject({
    kind: "overcharge_refund",
    operationId: "corr-op-1",
    amountMicrocredits: "10",
  });
  expect(first.entitlementId).toBe(verified.entitlement?.id);
  // The source that over-paid gets its credits back.
  expect((await ledger().entitlements(account))[0].consumedMicrocredits).toBe(
    20n,
  );
  expect((await ledger().paidSources(account))[0]?.remainingMicrocredits).toBe(
    "80",
  );

  // The bill keeps the original charge and links the correction beside it.
  expect(await readPaid("bill")).toMatchObject([
    {
      source: "credit_pack",
      operationId: "corr-op-1",
      amountMicrocredits: "30",
    },
    {
      source: "correction",
      operationId: "corr-op-1",
      amountMicrocredits: "10",
      reason: "metered double count",
      correction: {
        evidence: "case-2026-041",
        operator: staff,
        availableBeforeMicrocredits: "70",
        availableAfterMicrocredits: "80",
        correctionCreditsMicrocredits: "0",
      },
    },
  ]);
  expect(
    (
      await postCorrection({
        ...payload,
        amountMicrocredits: "21",
        evidence: "case-other",
      })
    ).status,
  ).toBe(409);
});

test("an overcharge on an expired source becomes non-expiring Correction Credits", async () => {
  const account = await freshAccount();
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
  await ledger().verifyOrder({
    orderId: order.id,
    channel: "wechat",
    channelOrderRef: `wx-corr-2-${run}`,
    amountCents: 2_900,
    paidAt,
  });
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
  clock = new Date("2026-04-01T00:00:00.000Z");
  const response = await postCorrection({
    kind: "overcharge_refund",
    accountId: account,
    operationId: "corr-op-2",
    amountMicrocredits: "12",
    reason: "late verified overcharge",
    evidence: "case-2026-042",
  });
  expect(response.status).toBe(200);
  expect(await readPaid("bill")).toMatchObject([
    {
      source: "subscription",
      operationId: "corr-op-2",
      amountMicrocredits: "30",
    },
    {
      source: "correction",
      operationId: "corr-op-2",
      periodStart: "2026-02-15T04:30:00.000Z",
      periodEnd: "2026-03-14T16:00:00.000Z",
      correction: {
        availableBeforeMicrocredits: "0",
        availableAfterMicrocredits: "12",
        correctionCreditsMicrocredits: "12",
      },
    },
  ]);
  expect(await readPaid("sources")).toMatchObject([
    { kind: "correction_credit", remainingMicrocredits: "12" },
  ]);
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
  const account = await freshAccount();
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

  const routeId = "correction-fault-route";
  const harnessImage = `agent-langgraph-agui@sha256:${"a".repeat(64)}`;
  const drafted = configure(emptyCatalog, {
    harnessImage,
    routes: {
      [routeId]: {
        provider: "fixture",
        model: "correction-fault",
        gatewayRevision: "fixture-r1",
        meteringRevision: "fixture-m1",
        maxInputTokens: 30,
        maxOutputTokens: 2,
        tools: false,
        price: { inputPerMillion: 1_000_000, outputPerMillion: 0 },
      },
    },
  });
  const proposed = drafted.routes[routeId];
  if (!proposed) throw new Error("Fixture route missing.");
  const { catalog } = publish(
    verify(drafted, routeId, fixtureTraceReport(harnessImage, proposed), staff),
    [routeId],
    routeId,
    staff,
  );
  const [previous] = await database
    .select()
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, pilotCatalogKey));
  try {
    await database
      .insert(enterpriseSettings)
      .values({ key: pilotCatalogKey, value: catalog })
      .onConflictDoUpdate({
        target: enterpriseSettings.key,
        set: { value: catalog },
      });
    clock = new Date("2026-03-14T15:59:00.000Z");
    const quote = await testLedger.quote();
    const held = await executionCall("reserve", {
      operationId: "corr-fault",
      route: routeId,
      priceVersion: quote?.priceVersion,
      creditType: "paid",
    });
    const reservation = await held.json();
    expect(reservation).toMatchObject({ state: "reserved" });
    expect(await readPaid("balance")).toMatchObject({
      reservedMicrocredits: "30",
    });
    const dispatched = await executionCall("dispatch", {
      operationId: "corr-fault",
      permit: reservation.permit,
      messages: [
        { role: "user", content: "Fixture call spanning the Billing Period." },
      ],
    });
    expect(await dispatched.json()).toMatchObject({
      state: "completed",
      operation: { chargedMicrocredits: "25", releasedMicrocredits: "5" },
    });
  } finally {
    if (previous) {
      await database
        .update(enterpriseSettings)
        .set({ value: previous.value })
        .where(eq(enterpriseSettings.key, pilotCatalogKey));
    } else {
      await database
        .delete(enterpriseSettings)
        .where(eq(enterpriseSettings.key, pilotCatalogKey));
    }
  }
  const late = createPaidCreditLedger(database, () => clock);
  const payload = {
    kind: "fault_compensation",
    accountId: account,
    operationId: "corr-fault",
    amountMicrocredits: "50",
    reason: "gateway outage across March 15",
    evidence: "case-2026-043",
  };
  expect((await postCorrection({ ...payload, evidence: " " })).status).toBe(
    400,
  );
  expect(await readPaid("balance")).toMatchObject({
    availableMicrocredits: "0",
    reservedMicrocredits: "0",
  });
  expect((await postCorrection(payload)).status).toBe(200);
  expect(await readPaid("balance")).toMatchObject({
    availableMicrocredits: "50",
    reservedMicrocredits: "0",
  });
  expect(await readPaid("bill")).toMatchObject([
    {
      source: "subscription",
      operationId: "corr-fault",
      amountMicrocredits: "25",
    },
    {
      source: "correction",
      operationId: "corr-fault",
      reason: payload.reason,
      periodEnd: before.periodEnd?.toISOString(),
      correction: {
        kind: "fault_compensation",
        evidence: payload.evidence,
        operator: staff,
        availableAfterMicrocredits: "50",
      },
    },
  ]);

  const view = await late.entitlements(account);
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
    reason: payload.reason,
  });
  // The execution's 24-hour reconciliation window has closed. Verified
  // overcharge support can still act on the original, unchanged debit.
  clock = new Date("2026-03-16T00:00:00.000Z");
  const original = await app.request("/api/billing/operations/corr-fault", {
    headers: { "x-fixture-user": customer },
  });
  expect(await original.json()).toMatchObject({
    state: "settled",
    chargedMicrocredits: "25",
    cutoffAt: "2026-03-15T15:59:00.000Z",
  });
  expect(
    (
      await postCorrection({
        ...payload,
        kind: "overcharge_refund",
        amountMicrocredits: "4",
        evidence: "case-2026-044",
        reason: "Proved overcharge after cutoff",
      })
    ).status,
  ).toBe(200);
  expect(await readPaid("balance")).toMatchObject({
    availableMicrocredits: "54",
  });
});

afterAll(async () => {
  const ids = fixtureAccounts;
  if (ids.length > 0) {
    await database
      .delete(lagoUsageEvents)
      .where(inArray(lagoUsageEvents.accountId, ids));
    await database
      .delete(testCreditEvidence)
      .where(inArray(testCreditEvidence.accountId, ids));
    await database
      .delete(testCreditOperations)
      .where(inArray(testCreditOperations.accountId, ids));
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
