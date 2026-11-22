import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import { createTestCreditRoutes } from "../src/billing/test-credit-routes";
import { createTestCreditLedger } from "../src/billing/test-credit";
import { createDatabase } from "../src/db/client";
import {
  billingApplications,
  billingSpendingAuthorizations,
  enterpriseSettings,
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
  testCreditResumePoints,
} from "../src/db/schema";
import { fixtureTraceReport } from "./support/bifrost-evidence";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The billing API a person's browser reads (#107): both Credit types side by
 * side, budgets that fix the type when a task starts, the confirmation a
 * paused step continues on, no execution without a controlled executor, and
 * an application that reserves and reads only through a person's
 * authorization (#111).
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
// No paid ledger, and no seam for an application's own credential.
const bare = createTestCreditRoutes({
  ledger: createTestCreditLedger(database),
  authenticate: async () => identity,
});
// An application's credential, stubbed the same way as the session one.
const applications = createTestCreditRoutes({
  ledger: createTestCreditLedger(database),
  authenticate: async () => undefined,
  authenticateApplication: async (request, applicationId) =>
    request.headers.get("x-test-application") === applicationId,
});

const routeId = "billing-routes";
const harnessImage = `agent-langgraph-agui@sha256:${"a".repeat(64)}`;
const drafted = configure(emptyCatalog, {
  harnessImage,
  routes: {
    [routeId]: {
      provider: "fixture-routes",
      model: "model-routes",
      gatewayRevision: "routes-r1",
      meteringRevision: "routes-m1",
      maxInputTokens: 10,
      maxOutputTokens: 2,
      tools: false,
      price: { inputPerMillion: 1_000_000, outputPerMillion: 0 },
    },
  },
});
const proposed = drafted.routes[routeId];
if (!proposed) throw new Error("fixture route missing");
const { catalog } = publish(
  verify(drafted, routeId, fixtureTraceReport(harnessImage, proposed), "test"),
  [routeId],
  routeId,
  "test",
);
const applicationIds: string[] = [];
const batchIds: string[] = [];
let originalCatalog: { value: unknown } | undefined;
let priceVersion = "";

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
  priceVersion =
    (await createTestCreditLedger(database).quote())?.priceVersion ?? "";
});

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
    "/applications",
    "/authorizations",
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
  // An application's credential is not a person's session.
  expect(
    (
      await api.request("/authorizations", {
        method: "POST",
        headers: { "x-openbot-application": "routes-app" },
      })
    ).status,
  ).toBe(401);
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
  expect((await bare.request("/paid/sources")).status).toBe(503);
  expect((await bare.request("/paid/bill")).status).toBe(503);
  expect((await bare.request("/paid/balance")).status).toBe(503);
  // Its Test Credit views still answer.
  expect((await bare.request("/budgets")).status).toBe(200);
});

test("an application reserves and reads only through a person's authorization", async () => {
  const ledger = createTestCreditLedger(database);
  const app = `routes-app-${crypto.randomUUID().slice(0, 8)}`;
  applicationIds.push(app);
  await ledger.registerApplication({
    id: app,
    name: "Routes fixture app",
    operator: "independent",
    resourcePrefix: "kb-",
  });
  if (!(await ledger.accountOf(identity)))
    throw new Error("no Billing Account for the test identity");

  // Nothing is granted to an application that is not approved (#111
  // 未审批应用不能启用).
  const grant = (body: unknown) =>
    api.request("/authorizations", {
      ...signedIn,
      method: "POST",
      body: JSON.stringify(body),
    });
  const authorization = {
    authorizationId: "routes-online",
    applicationId: app,
    kind: "online",
    expiresAt: "2030-01-01T00:00:00.000Z",
    limitMicrocredits: "25",
  };
  const unapproved = await grant(authorization);
  expect(unapproved.status).toBe(409);
  expect(await unapproved.json()).toMatchObject({
    error: "That application can't be authorized for this.",
  });
  expect((await grant({ ...authorization, kind: "other" })).status).toBe(400);
  await ledger.approveApplication(app, "pilot-lead");
  const granted = await grant(authorization);
  expect(granted.status).toBe(200);
  expect(await granted.json()).toMatchObject({
    authorizationId: "routes-online",
    applicationId: app,
    resourcePrefix: "kb-",
    limitMicrocredits: "25",
    state: "active",
  });
  // Asking again answers with the same grant.
  expect(await (await grant(authorization)).json()).toMatchObject({
    authorizationId: "routes-online",
  });
  expect(
    await (await api.request("/authorizations", signedIn)).json(),
  ).toMatchObject([{ authorizationId: "routes-online", applicationId: app }]);
  expect(await (await api.request("/applications", signedIn)).json()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: app, approvedBy: "pilot-lead" }),
    ]),
  );
  // The limit only rises (#86 增加上限需用户确认).
  const amend = (body: unknown) =>
    api.request("/authorizations/routes-online/amend", {
      ...signedIn,
      method: "POST",
      body: JSON.stringify(body),
    });
  const lowered = await amend({ limitMicrocredits: "20" });
  expect(lowered.status).toBe(409);
  expect(await lowered.json()).toMatchObject({
    error: "A Spending Authorization can only be raised or extended.",
  });
  expect(await (await amend({ limitMicrocredits: "45" })).json()).toMatchObject(
    { limitMicrocredits: "45" },
  );

  // An application's call is admitted by its own credential, and acts for
  // the person who granted it the authorization it names.
  const as = (applicationId: string) => ({
    headers: {
      "x-openbot-application": applicationId,
      "x-test-application": applicationId,
    },
  });
  const scoped = "/v1/spending-authorizations/routes-online";
  expect((await bare.request(scoped, as(app))).status).toBe(503);
  expect(
    (
      await applications.request(scoped, {
        headers: { "x-openbot-application": app },
      })
    ).status,
  ).toBe(401);
  expect((await applications.request(scoped, as("routes-other"))).status).toBe(
    404,
  );
  const call = (path: string, applicationId: string, body?: unknown) =>
    applications.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: as(applicationId).headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const step = {
    operationId: "routes-app-op-1",
    route: routeId,
    priceVersion,
    authorizationId: "routes-online",
    resourceId: "kb-doc-1",
  };
  // Without an authorization there is nobody to act for.
  expect(
    (await call("/v1/reserve", app, { ...step, authorizationId: undefined }))
      .status,
  ).toBe(400);
  expect(
    (
      await call("/v1/reserve", app, {
        ...step,
        authorizationId: "routes-none",
      })
    ).status,
  ).toBe(401);
  // As another application, or outside the granted scope.
  expect((await call("/v1/reserve", "routes-other", step)).status).toBe(401);
  expect(
    await (
      await call("/v1/reserve", app, { ...step, resourceId: "mail-inbox" })
    ).json(),
  ).toEqual({ state: "denied", reason: "not_authorized" });
  const reserved = await (await call("/v1/reserve", app, step)).json();
  expect(reserved).toMatchObject({ state: "reserved" });

  // It reads the account, and its own operation, only through that
  // authorization (#111 应用只能查询自身授权范围内的账户摘要和操作状态).
  expect(await (await call(scoped, app)).json()).toMatchObject({
    authorizationId: "routes-online",
    spentMicrocredits: "10",
  });
  expect(
    await (await call(`${scoped}/operations/routes-app-op-1`, app)).json(),
  ).toMatchObject({ operationId: "routes-app-op-1", state: "reserved" });
  expect((await call(`${scoped}/operations/routes-op-1`, app)).status).toBe(
    404,
  );
  expect(
    (await call(`${scoped}/operations/routes-app-op-1`, "routes-other")).status,
  ).toBe(404);

  // The person revokes it: nothing new reserves, and the reservation already
  // made does not run (验证撤销).
  expect(
    await (
      await api.request("/authorizations/routes-online/revoke", {
        ...signedIn,
        method: "POST",
      })
    ).json(),
  ).toMatchObject({ state: "revoked" });
  expect(
    (
      await api.request("/authorizations/routes-none/revoke", {
        ...signedIn,
        method: "POST",
      })
    ).status,
  ).toBe(404);
  expect(
    await (
      await call("/v1/reserve", app, {
        ...step,
        operationId: "routes-app-op-2",
      })
    ).json(),
  ).toEqual({ state: "denied", reason: "not_authorized" });
  expect(
    await (
      await call("/v1/dispatch", app, {
        operationId: "routes-app-op-1",
        authorizationId: "routes-online",
        permit: reserved.permit,
        messages: [{ role: "user", content: "Hello." }],
      })
    ).json(),
  ).toEqual({ state: "denied", reason: "not_authorized" });
  // A first-party runner's call is unchanged: it needs no application.
  expect(
    (
      await api.request("/v1/reserve", {
        ...signedIn,
        method: "POST",
        body: JSON.stringify({
          operationId: "routes-first-party",
          route: routeId,
          priceVersion,
        }),
      })
    ).status,
  ).toBe(200);
});

afterAll(async () => {
  const accounts = await database
    .select({ id: testCreditAccounts.id })
    .from(testCreditAccounts)
    .where(inArray(testCreditAccounts.issuer, [identity.issuer]));
  const ids = accounts.map(({ id }) => id);
  if (ids.length > 0) {
    await database
      .delete(testCreditEvidence)
      .where(inArray(testCreditEvidence.accountId, ids));
    await database
      .delete(testCreditOperations)
      .where(inArray(testCreditOperations.accountId, ids));
    await database
      .delete(testCreditResumePoints)
      .where(inArray(testCreditResumePoints.accountId, ids));
    // An operation references its authorization, so it goes first.
    await database
      .delete(billingSpendingAuthorizations)
      .where(inArray(billingSpendingAuthorizations.accountId, ids));
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
  await database
    .delete(billingApplications)
    .where(inArray(billingApplications.id, applicationIds));
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
