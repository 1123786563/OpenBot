import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import { createTestCreditLedger } from "../src/billing/test-credit";
import { createTestCreditRoutes } from "../src/billing/test-credit-routes";
import { loadWeKnoraBilling } from "../src/billing/weknora-config";
import { createWeKnoraRoutes } from "../src/billing/weknora-routes";
import { createDatabase } from "../src/db/client";
import {
  billingApplications,
  billingSpendingAuthorizations,
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
  testCreditResumePoints,
} from "../src/db/schema";
import {
  fixtureEmbeddingReport,
  fixtureTraceReport,
} from "./support/bifrost-evidence";
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
const embeddingRouteId = "routes-embedding";
const harnessImage = `agent-langgraph-agui@sha256:${"a".repeat(64)}`;
const drafted = configure(emptyCatalog, {
  harnessImage,
  routes: {
    [embeddingRouteId]: {
      purpose: "embedding",
      provider: "fixture-embedding",
      model: "model-embedding",
      gatewayRevision: "routes-r1",
      meteringRevision: "routes-m1",
      maxInputTokens: 10,
      maxOutputTokens: 0,
      tools: false,
      price: { inputPerMillion: 1_000_000, outputPerMillion: 0 },
    },
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
const embeddingProposal = drafted.routes[embeddingRouteId];
if (!proposed || !embeddingProposal) throw new Error("fixture route missing");
const embeddingReport = fixtureEmbeddingReport(harnessImage, embeddingProposal);
const { catalog } = publish(
  verify(
    verify(
      drafted,
      routeId,
      fixtureTraceReport(harnessImage, proposed),
      "test",
    ),
    embeddingRouteId,
    embeddingReport,
    "test",
  ),
  [routeId, embeddingRouteId],
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

test("a dispatch-only refusal leaves the reservation available to the controlled executor", async () => {
  const ledger = createTestCreditLedger(database);
  const person = { issuer: identity.issuer, subject: crypto.randomUUID() };
  const batchId = crypto.randomUUID();
  batchIds.push(batchId);
  await ledger.enroll({ identity: person, batchId, amount: 100n });
  await ledger.claim(person, batchId);
  const held = await ledger.reserve(person, {
    operationId: "routes-read-only-dispatch",
    route: routeId,
    priceVersion,
  });
  if (held.state !== "reserved") throw new Error("Could not reserve fixture.");
  const view = createTestCreditRoutes({
    ledger,
    authenticate: async () => person,
  });
  const response = await view.request("/v1/dispatch", {
    method: "POST",
    body: JSON.stringify({
      operationId: "routes-read-only-dispatch",
      permit: held.permit,
      messages: [{ role: "user", content: "Hello." }],
    }),
  });
  expect(response.status).toBe(503);
  expect(
    await ledger.receipt(person, "routes-read-only-dispatch"),
  ).toMatchObject({
    state: "reserved",
  });
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
  expect(
    (
      await api.request("/v1/reserve", {
        ...signedIn,
        method: "POST",
        body: JSON.stringify(step),
      })
    ).status,
  ).toBe(401);
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

  const backgroundId = "routes-background";
  const taskId = "routes-ingestion";
  expect(
    (
      await grant({
        ...authorization,
        authorizationId: backgroundId,
        kind: "background",
        taskId,
      })
    ).status,
  ).toBe(200);
  const background = {
    ...step,
    authorizationId: backgroundId,
    operationId: "routes-background-op",
    taskId,
  };
  const hold = await (await call("/v1/reserve", app, background)).json();
  expect(hold.state).toBe("reserved");
  expect(
    await (
      await call("/v1/reserve", app, {
        ...background,
        authorizationId: step.authorizationId,
        taskId: undefined,
      })
    ).json(),
  ).toEqual({ state: "denied", reason: "not_authorized" });
  expect(
    await (
      await call("/v1/reconcile", app, {
        authorizationId: step.authorizationId,
        operationId: background.operationId,
      })
    ).json(),
  ).toEqual({ state: "absent" });
  expect(
    await ledger.beginDispatch(identity, {
      operationId: background.operationId,
      permit: hold.permit,
      authorizationId: backgroundId,
    }),
  ).toMatchObject({ state: "dispatch" });
  await ledger.settle(
    (await ledger.accountOf(identity)) ?? "",
    background.operationId,
    {
      inputTokens: 1n,
      outputTokens: 0n,
    },
  );

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

test("WeKnora worker requests retain uploader attribution after sign-out and share durable limits", async () => {
  let now = new Date();
  const ledger = createTestCreditLedger(database, () => now);
  const uploader = { ...identity, subject: crypto.randomUUID() };
  const contender = { ...identity, subject: crypto.randomUUID() };
  for (const [owner, amount] of [
    [uploader, 60n],
    [contender, 19n],
  ] as const) {
    const batchId = crypto.randomUUID();
    batchIds.push(batchId);
    await ledger.enroll({ identity: owner, batchId, amount });
    await ledger.claim(owner, batchId);
  }
  const otherApp = "routes-competing-app";
  applicationIds.push("weknora", otherApp);
  for (const [id, resourcePrefix] of [
    ["weknora", "weknora:"],
    [otherApp, "kb-"],
  ]) {
    if (!id || !resourcePrefix) throw new Error("Missing fixture app");
    await ledger.registerApplication({
      id,
      name: id,
      operator: "platform",
      resourcePrefix,
    });
    await ledger.approveApplication(id, "fixture");
  }

  let session: typeof uploader | undefined = uploader;
  const accountApi = createTestCreditRoutes({
    ledger,
    weknoraRouteId: embeddingRouteId,
    authenticate: async () => session,
  });
  const accountPost = (path: string, input: unknown) =>
    accountApi.request(path, {
      method: "POST",
      body: JSON.stringify(input),
    });
  const resourceId = "weknora:tenant:1:kb:docs";
  const authorizationId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + 60_000).toISOString();
  const grant = {
    authorizationId,
    applicationId: "weknora",
    kind: "background" as const,
    taskId: authorizationId,
    resourcePrefix: resourceId,
    expiresAt,
    limitMicrocredits: "10",
  };
  expect((await accountPost("/authorizations", grant)).status).toBe(200);
  expect(
    await (
      await accountApi.request(
        `/weknora/preview?authorizationId=${authorizationId}`,
      )
    ).json(),
  ).toMatchObject({
    creditType: "test",
    price: { inputPerMillion: 1_000_000 },
    maxChargeMicrocredits: "10",
    authorization: { limitMicrocredits: "10" },
  });
  session = undefined;
  expect((await accountApi.request("/balance")).status).toBe(401);

  let gatewayCalls = 0;
  let gatewayUnavailable = false;
  let beforeMeter: (() => Promise<void>) | undefined;
  let beforeReply: (() => Promise<void>) | undefined;
  const local = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      if (new URL(request.url).pathname === "/meter") {
        await beforeMeter?.();
        return Response.json({
          requestId: request.headers.get("x-request-id"),
          requestSha256: createHash("sha256").update(body).digest("hex"),
          gatewayRevision: "routes-r1",
          meteringRevision: "routes-m1",
          inputTokenUpperBound: 2,
        });
      }
      gatewayCalls++;
      if (gatewayUnavailable) return new Response(null, { status: 503 });
      await beforeReply?.();
      return Response.json({
        object: "list",
        model: "model-embedding",
        usage: { prompt_tokens: 2, total_tokens: 2 },
        data: [{ index: 0, embedding: [1, 0] }],
      });
    },
  });
  try {
    const token = crypto.randomUUID();
    const runtime = loadWeKnoraBilling({
      OPENBOT_TEST_CREDIT_WEKNORA: "enabled",
      OPENBOT_WEKNORA_SERVICE_TOKEN: token,
      OPENBOT_WEKNORA_ROUTE: embeddingRouteId,
      TEST_CREDIT_EMBEDDINGS_BIFROST_URL: new URL("/v1/embeddings", local.url)
        .href,
      TEST_CREDIT_INPUT_METER_URL: new URL("/meter", local.url).href,
      TEST_CREDIT_INPUT_METER_TOKEN: "fixture",
      TEST_CREDIT_BIFROST_TOKEN: "fixture",
      TEST_CREDIT_GATEWAY_IMAGE_DIGEST: embeddingReport.gatewayImageDigest,
      TEST_CREDIT_GATEWAY_REVISION: "routes-r1",
      TEST_CREDIT_METERING_REVISION: "routes-m1",
      TEST_CREDIT_CASDOOR_ISSUER: "https://casdoor.invalid",
      TEST_CREDIT_CASDOOR_PROVIDER_ID: "fixture",
    });
    if (!runtime) throw new Error("Expected enabled WeKnora billing");
    const fixtureRuntime = { ...runtime, issuer: identity.issuer };
    const worker = createWeKnoraRoutes({ ...fixtureRuntime, ledger });
    const headers = { authorization: `Bearer ${token}` };
    const scope = {
      authorizationId,
      resourceId,
      subject: uploader.subject,
      input: ["fixture"],
    };
    const original = { ...scope, operationId: crypto.randomUUID() };
    const request = (input: typeof original, credential = headers) =>
      worker.request("/embeddings", {
        method: "POST",
        body: JSON.stringify(input),
        headers: credential,
      });
    expect(
      (await request(original, { authorization: "Bearer nope" })).status,
    ).toBe(401);
    expect(
      (await request({ ...original, subject: contender.subject })).status,
    ).toBe(403);
    expect(
      (await request({ ...original, resourceId: `${resourceId}-other` }))
        .status,
    ).toBe(403);
    const completed = await request(original);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      vectors: [[1, 0]],
      receipt: { applicationId: "weknora", chargedMicrocredits: "2" },
    });
    expect((await request(original)).status).toBe(200);
    expect(gatewayCalls).toBe(1);
    expect((await request({ ...original, input: ["different"] })).status).toBe(
      409,
    );
    session = contender;
    expect(
      (await accountApi.request(`/operations/${original.operationId}`)).status,
    ).toBe(404);
    const statusPath = `/authorizations/${authorizationId}/operations/${original.operationId}`;
    expect(
      await (await worker.request(statusPath, { headers })).json(),
    ).toMatchObject({ state: "settled" });
    expect(
      (
        await worker.request(
          statusPath.replace(authorizationId, crypto.randomUUID()),
          { headers },
        )
      ).status,
    ).toBe(404);

    const paused = { ...scope, operationId: crypto.randomUUID() };
    expect((await request(paused)).status).toBe(429);
    const pausedPath = `/authorizations/${authorizationId}/operations/${paused.operationId}`;
    expect(
      await (await worker.request(pausedPath, { headers })).json(),
    ).toMatchObject({ state: "paused", code: "execution_limit" });
    session = uploader;
    expect(
      (
        await accountPost(`/authorizations/${authorizationId}/amend`, {
          limitMicrocredits: "30",
        })
      ).status,
    ).toBe(200);
    expect((await request(paused)).status).toBe(429);
    expect(
      (await request({ ...paused, operationId: crypto.randomUUID() })).status,
    ).toBe(429);
    expect(
      (
        await accountPost("/budgets", {
          budgetId: "weknora-resume",
          creditType: "test",
          limitMicrocredits: "30",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await accountPost(`/resume-points/${paused.operationId}/confirm`, {
          budgetId: "weknora-resume",
          authorizationId,
          limitMicrocredits: "31",
        })
      ).status,
    ).toBe(200);
    expect(
      await (await worker.request(pausedPath, { headers })).json(),
    ).toMatchObject({ state: "confirmed", code: "execution_limit" });
    expect(
      (await request({ ...paused, operationId: crypto.randomUUID() })).status,
    ).toBe(429);
    expect((await request(paused)).status).toBe(200);
    const grants = await ledger.authorizations(uploader);
    expect(
      grants?.find((grant) => grant.authorizationId === authorizationId),
    ).toMatchObject({ limitMicrocredits: "31" });

    const uncertain = { ...scope, operationId: crypto.randomUUID() };
    gatewayUnavailable = true;
    expect(await (await request(uncertain)).json()).toMatchObject({
      code: "reconciling",
    });
    gatewayUnavailable = false;
    const callsAfterFailure = gatewayCalls;
    expect(await (await request(uncertain)).json()).toMatchObject({
      code: "reconciling",
    });
    expect(gatewayCalls).toBe(callsAfterFailure);
    const uncertainStatus = await worker.request(
      `/authorizations/${authorizationId}/operations/${uncertain.operationId}`,
      { headers },
    );
    expect(await uncertainStatus.json()).toMatchObject({
      state: "pending",
      outcome: "unknown",
    });

    const revoke = () => ledger.revokeAuthorization(uploader, authorizationId);
    beforeReply = async () => {
      await revoke();
    };
    expect(
      (await request({ ...scope, operationId: crypto.randomUUID() })).status,
    ).toBe(200);
    beforeReply = undefined;
    expect(
      (await request({ ...scope, operationId: crypto.randomUUID() })).status,
    ).toBe(410);

    const expiryId = crypto.randomUUID();
    await ledger.authorize(uploader, {
      ...grant,
      authorizationId: expiryId,
      taskId: expiryId,
      expiresAt: new Date(expiresAt),
      limitMicrocredits: 20n,
    });
    beforeMeter = async () => {
      now = new Date(expiresAt);
    };
    const expiresWhileMetering = {
      ...scope,
      authorizationId: expiryId,
      operationId: crypto.randomUUID(),
    };
    const before = gatewayCalls;
    expect(await (await request(expiresWhileMetering)).json()).toEqual({
      code: "authorization_expired",
    });
    expect(gatewayCalls).toBe(before);
    expect(
      (
        await request({
          ...expiresWhileMetering,
          operationId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(410);
    beforeMeter = undefined;

    const contenderGrant = crypto.randomUUID();
    const competitorGrant = crypto.randomUUID();
    const later = new Date(now.getTime() + 60_000);
    await ledger.authorize(contender, {
      ...grant,
      authorizationId: contenderGrant,
      taskId: contenderGrant,
      expiresAt: later,
      limitMicrocredits: 19n,
    });
    await ledger.authorize(contender, {
      ...grant,
      authorizationId: competitorGrant,
      taskId: undefined,
      applicationId: otherApp,
      kind: "online",
      resourcePrefix: "kb-",
      expiresAt: later,
      limitMicrocredits: 19n,
    });
    // Keep the winning worker's hold in flight until the other reservation has run.
    const winnerMaySettle = Promise.withResolvers<void>();
    beforeReply = () => winnerMaySettle.promise;
    const contestedUpload = {
      ...scope,
      authorizationId: contenderGrant,
      subject: contender.subject,
      operationId: crypto.randomUUID(),
    };
    const embedding = request(contestedUpload);
    const competitor = await ledger.reserve(contender, {
      operationId: "competing-app-op",
      route: routeId,
      priceVersion,
      applicationId: otherApp,
      authorizationId: competitorGrant,
      resourceId: "kb-docs",
      creditType: "test",
    });
    winnerMaySettle.resolve();
    const embeddingResponse = await embedding;
    if (competitor.state === "reserved") {
      expect(embeddingResponse.status).toBe(402);
      const status = await worker.request(
        `/authorizations/${contenderGrant}/operations/${contestedUpload.operationId}`,
        { headers },
      );
      expect(await status.json()).toMatchObject({
        state: "paused",
        code: "insufficient_credits",
      });
    } else {
      expect(competitor).toEqual({
        state: "denied",
        reason: "insufficient_credits",
      });
      expect(embeddingResponse.status).toBe(200);
    }
    expect(
      (
        await worker.request(
          `/authorizations/${competitorGrant}/operations/competing-app-op`,
          { headers },
        )
      ).status,
    ).toBe(404);
  } finally {
    await local.stop(true);
  }
});

afterAll(async () => {
  const accounts = await database
    .select({ id: testCreditAccounts.id })
    .from(testCreditAccounts)
    .where(inArray(testCreditAccounts.issuer, [identity.issuer]));
  const ids = accounts.map(({ id }) => id);
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
