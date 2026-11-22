import { afterAll, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import { createTestCreditRoutes } from "../src/billing/test-credit-routes";
import { createTestCreditLedger } from "../src/billing/test-credit";
import { createDatabase } from "../src/db/client";
import {
  paidCreditAllocations,
  paidEntitlements,
  paidOrders,
  paidProducts,
  testCreditAccounts,
  testCreditBatches,
  testCreditBudgets,
  testCreditEnrollments,
  testCreditResumePoints,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The billing API a person's browser reads (#107): both Credit types side by
 * side, budgets that fix the type when a task starts, the confirmation a
 * paused step continues on, and no execution without a controlled executor.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const paidAt = new Date("2026-02-15T04:30:00.000Z");
const identity = {
  issuer: "billing-routes",
  subject: crypto.randomUUID(),
};
// The session seam, stubbed: the request names its own verified subject.
const api = createTestCreditRoutes({
  ledger: createTestCreditLedger(database),
  paid: { ledger: createPaidCreditLedger(database, () => paidAt) },
  authenticate: async (request) =>
    request.headers.get("x-test-subject") === identity.subject
      ? identity
      : undefined,
});
const signedIn = { headers: { "x-test-subject": identity.subject } };

const batchIds: string[] = [];

test("a person without a Billing Account is told so on every read", async () => {
  for (const path of [
    "/balance",
    "/paid/sources",
    "/paid/bill",
    "/paid/balance",
    "/resume-points",
  ]) {
    const response = await api.request(path, signedIn);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "Billing Account unavailable.",
    });
  }
});

test("every read requires a verified identity", async () => {
  for (const path of [
    "/balance",
    "/paid/sources",
    "/paid/bill",
    "/paid/balance",
    "/budgets",
    "/resume-points",
  ]) {
    const response = await api.request(path);
    expect(response.status).toBe(401);
  }
  expect(
    (
      await api.request("/resume-points/routes-op-1/confirm", {
        method: "POST",
        body: JSON.stringify({ budgetId: "routes-paid" }),
      })
    ).status,
  ).toBe(401);
  const response = await api.request("/budgets", {
    method: "POST",
    body: JSON.stringify({
      budgetId: "no-identity",
      creditType: "paid",
      limitMicrocredits: "1",
    }),
  });
  expect(response.status).toBe(401);
});

test("the bill shows both Credit types and the budget fixes its type", async () => {
  // Trusted provisioning opens the account and claims a trial batch.
  const ledger = createTestCreditLedger(database);
  const batchId = crypto.randomUUID();
  await ledger.enroll({ identity, batchId, amount: 6n });
  await ledger.claim(identity, batchId);
  const accountId = (await ledger.accountOf(identity)) ?? "";
  if (!accountId) throw new Error("no Billing Account for the test identity");
  batchIds.push(batchId);

  // A paid pack and a charge against it.
  const paid = createPaidCreditLedger(database, () => paidAt);
  await paid.upsertProduct({
    code: "pack-routes",
    kind: "credit_pack",
    priceCents: 9_900,
    creditsMicrocredits: 50n,
  });
  const order = await paid.createOrder({
    accountId,
    productCode: "pack-routes",
    channel: "alipay",
  });
  await paid.verifyOrder({
    orderId: order.id,
    channel: "alipay",
    channelOrderRef: `ali-routes-${crypto.randomUUID().slice(0, 8)}`,
    amountCents: 9_900,
    paidAt,
  });
  await paid.allocate({
    accountId,
    operationId: "routes-op-1",
    amountMicrocredits: 10n,
  });
  await paid.settleAllocation({
    accountId,
    operationId: "routes-op-1",
    chargeMicrocredits: 4n,
  });

  const sources = await api.request("/paid/sources", signedIn);
  expect(sources.status).toBe(200);
  expect(await sources.json()).toMatchObject([
    { kind: "credit_pack", remainingMicrocredits: "46" },
  ]);
  const bill = await api.request("/paid/bill", signedIn);
  expect(await bill.json()).toMatchObject([
    {
      operationId: "routes-op-1",
      source: "credit_pack",
      amountMicrocredits: "4",
    },
  ]);

  // The entry the person picks fixes the type on the budget.
  const created = await api.request("/budgets", {
    ...signedIn,
    method: "POST",
    body: JSON.stringify({
      budgetId: "routes-paid",
      creditType: "paid",
      limitMicrocredits: "25",
    }),
  });
  expect(created.status).toBe(200);
  expect(await created.json()).toMatchObject({
    creditType: "paid",
    limitMicrocredits: "25",
    confirmed: true,
  });
  const listed = await api.request("/budgets", signedIn);
  expect(await listed.json()).toMatchObject([
    { budgetId: "routes-paid", creditType: "paid", limitMicrocredits: "25" },
  ]);
  // A budget of an unknown Credit type never reaches the ledger.
  const refused = await api.request("/budgets", {
    ...signedIn,
    method: "POST",
    body: JSON.stringify({
      budgetId: "routes-other",
      creditType: "trial",
      limitMicrocredits: "25",
    }),
  });
  expect(refused.status).toBe(400);

  // The paid balance beside the Test Credit one: 46 of the pack still
  // spendable, none held, 4 charged.
  const paidBalance = await api.request("/paid/balance", signedIn);
  expect(await paidBalance.json()).toEqual({
    availableMicrocredits: "46",
    reservedMicrocredits: "0",
    chargedMicrocredits: "4",
  });
  // Every bill line carries the app its step ran for, where it named one.
  expect(await (await api.request("/paid/bill", signedIn)).json()).toEqual([
    expect.objectContaining({
      operationId: "routes-op-1",
      applicationId: null,
    }),
  ]);
});

test("a paused step waits for a budget the person confirms", async () => {
  // The session seam answers one identity: the account the test above opened.
  const accountId =
    (await createTestCreditLedger(database).accountOf(identity)) ?? "";
  if (!accountId) throw new Error("no Billing Account for the test identity");
  // A step the ledger paused for want of credits, as its reserve leaves it.
  await database.insert(testCreditResumePoints).values({
    accountId,
    operationId: "routes-paused",
    applicationId: "weknora",
    reason: "insufficient_credits",
  });
  const headers = signedIn;

  const waiting = await api.request("/resume-points", headers);
  expect(await waiting.json()).toMatchObject([
    {
      operationId: "routes-paused",
      applicationId: "weknora",
      reason: "insufficient_credits",
      budgetId: null,
    },
  ]);
  const confirm = (operationId: string, body: unknown) =>
    api.request(`/resume-points/${operationId}/confirm`, {
      ...headers,
      method: "POST",
      body: JSON.stringify(body),
    });
  expect((await confirm("routes-paused", {})).status).toBe(400);
  expect(
    (await confirm("no-such-step", { budgetId: "routes-paid" })).status,
  ).toBe(404);
  // A step out of credits continues on paid credits, not a Test budget.
  const created = await api.request("/budgets", {
    ...headers,
    method: "POST",
    body: JSON.stringify({
      budgetId: "routes-continue",
      creditType: "test",
      limitMicrocredits: "25",
    }),
  });
  expect(created.status).toBe(200);
  const refused = await confirm("routes-paused", {
    budgetId: "routes-continue",
  });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    error: "That budget cannot continue this step.",
  });
  await api.request("/budgets", {
    ...headers,
    method: "POST",
    body: JSON.stringify({
      budgetId: "routes-paid-continue",
      creditType: "paid",
      limitMicrocredits: "25",
    }),
  });
  const confirmed = await confirm("routes-paused", {
    budgetId: "routes-paid-continue",
  });
  expect(confirmed.status).toBe(200);
  expect(await confirmed.json()).toMatchObject({
    state: "confirmed",
    operationId: "routes-paused",
    budgetId: "routes-paid-continue",
    creditType: "paid",
  });
  expect(
    await (await api.request("/resume-points", headers)).json(),
  ).toMatchObject([
    { operationId: "routes-paused", budgetId: "routes-paid-continue" },
  ]);
});

test("a deployment without the paid ledger answers 503 on the paid views", async () => {
  const bare = createTestCreditRoutes({
    ledger: createTestCreditLedger(database),
    authenticate: async () => identity,
  });
  expect((await bare.request("/paid/sources")).status).toBe(503);
  expect((await bare.request("/paid/bill")).status).toBe(503);
  expect((await bare.request("/paid/balance")).status).toBe(503);
  // Its Test Credit views still answer.
  expect((await bare.request("/budgets")).status).toBe(200);
});

afterAll(async () => {
  const accounts = await database
    .select({ id: testCreditAccounts.id })
    .from(testCreditAccounts)
    .where(inArray(testCreditAccounts.issuer, [identity.issuer]));
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
      .delete(testCreditBudgets)
      .where(inArray(testCreditBudgets.accountId, ids));
    await database
      .delete(testCreditEnrollments)
      .where(inArray(testCreditEnrollments.accountId, ids));
    await database
      .delete(testCreditAccounts)
      .where(inArray(testCreditAccounts.id, ids));
    for (const batchId of batchIds)
      await database
        .delete(testCreditBatches)
        .where(inArray(testCreditBatches.id, [batchId]));
  }
  await database
    .delete(paidProducts)
    .where(inArray(paidProducts.code, ["pack-routes"]));
  await database.$client.close();
});
