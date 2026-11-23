import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish,
  verify,
} from "../src/admin/bifrost-catalog";
import {
  createPaidCreditLedger,
  type PaidCreditLedger,
} from "../src/billing/paid-ledger";
import { createPilotSignoffs } from "../src/billing/pilot-signoffs";
import {
  createTestCreditLedger,
  type TestCreditLedger,
  type VerifiedBillingIdentity,
} from "../src/billing/test-credit";
import { createDatabase } from "../src/db/client";
import {
  billingApplications,
  billingPilotSignoffs,
  billingRestore,
  billingSpendingAuthorizations,
  enterpriseSettings,
  lagoUsageEvents,
  paidCorrections,
  paidCreditAllocations,
  paidEntitlements,
  paidOrders,
  paidProducts,
  paidRefunds,
  pilotProviderCostHolds,
  pilotProviderCostLimitEvents,
  pilotProviderCostLimits,
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
 * The paths credits travel (#103, #108, #111, #112): a suspended account
 * reserves nothing, an application spends only under the person's
 * authorization, a paused path refuses new work while the rest settles, a
 * rollback settles dispatched work at the price it froze, and a restore from
 * an old backup pauses the ledger until each account is replayed and resumed.
 */

type Identity = VerifiedBillingIdentity;

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const ledger = createTestCreditLedger(database);
const run = crypto.randomUUID().slice(0, 8);
const app = `paths-app-${run}`;
const secondApp = `paths-second-${run}`;
const routeId = "billing-paths";
const nextRouteId = "billing-paths-next";
const harnessImage = `agent-langgraph-agui@sha256:${"f".repeat(64)}`;
const batchIds: string[] = [];
let originalCatalog: { value: unknown } | undefined;
let priceVersion = "";

// A published catalog with one route, at so much per input token.
function catalogWith(id: string, inputPerMillion: number) {
  const drafted = configure(emptyCatalog, {
    harnessImage,
    routes: {
      [id]: {
        provider: "fixture-paths",
        model: "model-paths",
        gatewayRevision: "paths-r1",
        meteringRevision: "paths-m1",
        maxInputTokens: 10,
        maxOutputTokens: 2,
        tools: false,
        price: { inputPerMillion, outputPerMillion: 0 },
      },
    },
  });
  const proposed = drafted.routes[id];
  if (!proposed) throw new Error("fixture route missing");
  return publish(
    verify(drafted, id, fixtureTraceReport(harnessImage, proposed), "test"),
    [id],
    id,
    "test",
  ).catalog;
}

const catalog = catalogWith(routeId, 1_000_000);
const nextCatalog = catalogWith(nextRouteId, 10_000_000);

async function install(value: Record<string, unknown>) {
  await database
    .insert(enterpriseSettings)
    .values({ key: pilotCatalogKey, value })
    .onConflictDoUpdate({
      target: enterpriseSettings.key,
      set: { value },
    });
}

async function enrolled(tag: string, testGrant: bigint) {
  const identity: Identity = {
    issuer: `billing-paths-${tag}`,
    subject: crypto.randomUUID(),
  };
  const batchId = crypto.randomUUID();
  batchIds.push(batchId);
  await ledger.enroll({ identity, batchId, amount: testGrant });
  await ledger.claim(identity, batchId);
  const accountId = await ledger.accountOf(identity);
  if (!accountId) throw new Error(`no Billing Account for the ${tag} identity`);
  return { identity, accountId };
}

// Reserves a step that must reserve, and answers its permit.
async function reservedAs(
  credit: TestCreditLedger,
  identity: Identity,
  request: Parameters<TestCreditLedger["reserve"]>[1],
) {
  const result = await credit.reserve(identity, request);
  if (result.state !== "reserved" || !result.permit)
    throw new Error(`the step ${request.operationId} did not reserve`);
  return result.permit;
}

async function operationRow(accountId: string, id: string) {
  return (
    await database
      .select()
      .from(testCreditOperations)
      .where(
        and(
          eq(testCreditOperations.accountId, accountId),
          eq(testCreditOperations.id, id),
        ),
      )
  )[0];
}

async function boughtPack(
  paid: PaidCreditLedger,
  accountId: string,
  ref: string,
  paidAt: Date,
) {
  const order = await paid.createOrder({
    accountId,
    productCode: "pack-paths",
    channel: "alipay",
  });
  const verified = await paid.verifyOrder({
    orderId: order.id,
    channel: "alipay",
    channelOrderRef: ref,
    amountCents: 9_900,
    paidAt,
  });
  expect(verified.claimed).toBe(true);
  return order;
}

// A step on the paid entry: reserved, dispatched, and settled for seven.
async function paidStep(
  credit: TestCreditLedger,
  identity: Identity,
  accountId: string,
  operationId: string,
) {
  const permit = await reservedAs(credit, identity, {
    operationId,
    route: routeId,
    priceVersion,
    creditType: "paid",
  });
  await credit.beginDispatch(identity, { operationId, permit });
  const settled = await credit.settle(accountId, operationId, {
    inputTokens: 7n,
    outputTokens: 0n,
  });
  expect(settled).toMatchObject({ state: "settled", chargedMicrocredits: "7" });
}

/**
 * Removes every row this file writes. It runs before the tests too, so a run
 * that stopped midway cannot leave a paused application behind to refuse the
 * next run's orders.
 */
async function cleanUp() {
  await database.transaction(async (tx) => {
    // By issuer prefix, so rows from a crashed run clean up too.
    const rows = await tx
      .select({ id: testCreditAccounts.id })
      .from(testCreditAccounts)
      .where(like(testCreditAccounts.issuer, "billing-paths-%"));
    const ids = rows.map(({ id }) => id);
    // A provider-cost hold references its account.
    await tx
      .delete(pilotProviderCostHolds)
      .where(eq(pilotProviderCostHolds.path, routeId));
    await tx
      .delete(pilotProviderCostLimitEvents)
      .where(eq(pilotProviderCostLimitEvents.path, routeId));
    await tx
      .delete(pilotProviderCostLimits)
      .where(eq(pilotProviderCostLimits.path, routeId));
    if (ids.length > 0) {
      // Evidence references its operation, and an operation references its
      // authorization, so they go in that order.
      await tx
        .delete(testCreditEvidence)
        .where(inArray(testCreditEvidence.accountId, ids));
      await tx
        .delete(lagoUsageEvents)
        .where(inArray(lagoUsageEvents.accountId, ids));
      await tx
        .delete(testCreditOperations)
        .where(inArray(testCreditOperations.accountId, ids));
      await tx
        .delete(testCreditResumePoints)
        .where(inArray(testCreditResumePoints.accountId, ids));
      await tx
        .delete(billingSpendingAuthorizations)
        .where(inArray(billingSpendingAuthorizations.accountId, ids));
      await tx
        .delete(paidCreditAllocations)
        .where(inArray(paidCreditAllocations.accountId, ids));
      await tx.delete(paidRefunds).where(inArray(paidRefunds.accountId, ids));
      await tx
        .delete(paidCorrections)
        .where(inArray(paidCorrections.accountId, ids));
      await tx
        .delete(paidEntitlements)
        .where(inArray(paidEntitlements.accountId, ids));
      await tx.delete(paidOrders).where(inArray(paidOrders.accountId, ids));
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
    await tx
      .delete(billingPilotSignoffs)
      .where(
        and(
          eq(billingPilotSignoffs.evidence, "fixture"),
          sql`${billingPilotSignoffs.record}->>'buildVersion' = 'issue-112'`,
        ),
      );
    await tx
      .delete(billingApplications)
      .where(like(billingApplications.id, "paths-%"));
    await tx.delete(billingRestore).where(eq(billingRestore.id, "ledger"));
    await tx.delete(paidProducts).where(eq(paidProducts.code, "pack-paths"));
  });
}

beforeAll(async () => {
  await cleanUp();
  [originalCatalog] = await database
    .select()
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, pilotCatalogKey));
  await install(catalog);
  priceVersion = (await ledger.quote())?.priceVersion ?? "";
  await database
    .insert(paidProducts)
    .values({
      code: "pack-paths",
      kind: "credit_pack",
      version: 1,
      priceCents: 9_900,
      creditsMicrocredits: 100n,
      active: true,
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await cleanUp();
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

test("a suspended account reserves and dispatches nothing, while what already dispatched settles", async () => {
  const paid = createPaidCreditLedger(database);
  const { identity, accountId } = await enrolled("suspend", 40n);
  const step = (operationId: string) => ({
    operationId,
    route: routeId,
    priceVersion,
  });
  const underWay = await reservedAs(ledger, identity, step("suspend-op-1"));
  await ledger.beginDispatch(identity, {
    operationId: "suspend-op-1",
    permit: underWay,
  });
  const waiting = await reservedAs(ledger, identity, step("suspend-op-2"));

  // The identity provider disables the account mid-flight (#103 停用期间
  // 收费入口维持暂停).
  await paid.suspendAccount(accountId, true);
  expect(await ledger.reserve(identity, step("suspend-op-3"))).toEqual({
    state: "denied",
    reason: "not_authorized",
  });
  await expect(
    paid.createOrder({
      accountId,
      productCode: "pack-paths",
      channel: "alipay",
    }),
  ).rejects.toMatchObject({ code: "account_suspended" });

  // A reservation made before the suspension does not run, and its hold
  // returns.
  expect(
    await ledger.beginDispatch(identity, {
      operationId: "suspend-op-2",
      permit: waiting,
    }),
  ).toEqual({ state: "denied", reason: "not_authorized" });
  expect(await operationRow(accountId, "suspend-op-2")).toMatchObject({
    state: "released",
  });
  expect(await ledger.balance(identity)).toMatchObject({
    reservedMicrocredits: "10",
    availableMicrocredits: "30",
  });

  // The step already dispatched settles (已派发结算可继续).
  expect(
    (
      await ledger.settle(accountId, "suspend-op-1", {
        inputTokens: 7n,
        outputTokens: 0n,
      })
    )?.state,
  ).toBe("settled");
  expect(await ledger.balance(identity)).toMatchObject({
    reservedMicrocredits: "0",
    availableMicrocredits: "33",
    chargedMicrocredits: "7",
  });

  // Lifted, the account reserves again.
  await paid.suspendAccount(accountId, false);
  expect((await ledger.reserve(identity, step("suspend-op-3"))).state).toBe(
    "reserved",
  );
});

test("an application spends from a person's account only under the authorization they granted it", async () => {
  const start = new Date("2026-06-01T00:00:00.000Z");
  let clock = start;
  const paid = createPaidCreditLedger(database, () => start);
  const timed = createTestCreditLedger(database, () => clock);
  const { identity, accountId } = await enrolled("app", 100n);
  const stranger = await enrolled("stranger", 100n);

  // An application registers its identity and the resources it may be
  // authorized for. Nothing can be granted to it before approval (#111
  // 未审批应用不能启用).
  const registration = {
    id: app,
    name: "Paths fixture app",
    operator: "independent" as const,
    resourcePrefix: "kb-",
  };
  expect(await timed.registerApplication(registration)).toMatchObject({
    id: app,
    approvedAt: null,
    pausedAt: null,
  });
  // A second registration must repeat the first.
  expect(
    await timed.registerApplication({ ...registration, name: "Renamed" }),
  ).toMatchObject({ name: "Paths fixture app" });
  await expect(
    timed.registerApplication({ ...registration, operator: "platform" }),
  ).rejects.toThrow("differs");
  const hour = 60 * 60_000;
  const grant = (
    input: Omit<Parameters<TestCreditLedger["authorize"]>[1], "expiresAt">,
  ) =>
    timed.authorize(identity, {
      ...input,
      expiresAt: new Date(clock.getTime() + hour),
    });
  expect(
    await grant({
      authorizationId: "paths-online",
      applicationId: app,
      kind: "online",
      limitMicrocredits: 25n,
    }),
  ).toEqual({ state: "denied" });
  expect(await timed.approveApplication(app, "pilot-lead")).toMatchObject({
    approvedBy: "pilot-lead",
  });
  expect((await timed.applications()).map(({ id }) => id)).toContain(app);

  // The grant is explicit about its task, its scope, its limit and its life.
  for (const refused of [
    // A background authorization belongs to one task.
    {
      authorizationId: "paths-loose",
      applicationId: app,
      kind: "background" as const,
      limitMicrocredits: 25n,
    },
    // Outside the scope the application registered.
    {
      authorizationId: "paths-outside",
      applicationId: app,
      kind: "online" as const,
      resourcePrefix: "mail-",
      limitMicrocredits: 25n,
    },
    // For nothing, or already over.
    {
      authorizationId: "paths-nothing",
      applicationId: app,
      kind: "online" as const,
      limitMicrocredits: 0n,
    },
    {
      authorizationId: "paths-unknown",
      applicationId: "no-such-app",
      kind: "online" as const,
      limitMicrocredits: 25n,
    },
  ])
    expect(await grant(refused)).toEqual({ state: "denied" });
  expect(
    await timed.authorize(identity, {
      authorizationId: "paths-spent",
      applicationId: app,
      kind: "online",
      expiresAt: new Date(clock.getTime() - 1),
      limitMicrocredits: 25n,
    }),
  ).toEqual({ state: "denied" });
  expect(
    await grant({
      authorizationId: "paths-online",
      applicationId: app,
      kind: "online",
      limitMicrocredits: 25n,
    }),
  ).toMatchObject({
    state: "authorized",
    authorization: {
      authorizationId: "paths-online",
      resourcePrefix: "kb-",
      limitMicrocredits: "25",
      spentMicrocredits: "0",
      state: "active",
    },
  });
  expect(
    await grant({
      authorizationId: "paths-task",
      applicationId: app,
      kind: "background",
      taskId: "task-1",
      limitMicrocredits: 25n,
    }),
  ).toMatchObject({ state: "authorized" });
  // Asking again with the same ID answers with the first grant, and with
  // another application's ID is refused.
  expect(
    await grant({
      authorizationId: "paths-online",
      applicationId: app,
      kind: "online",
      limitMicrocredits: 25n,
    }),
  ).toMatchObject({ state: "existing" });
  expect(
    await grant({
      authorizationId: "paths-task",
      applicationId: secondApp,
      kind: "background",
      taskId: "task-1",
      limitMicrocredits: 25n,
    }),
  ).toEqual({ state: "denied" });

  const step = (operationId: string, extra: Record<string, string> = {}) => ({
    operationId,
    route: routeId,
    priceVersion,
    ...extra,
  });
  const online = {
    authorizationId: "paths-online",
    applicationId: app,
    resourceId: "kb-doc-1",
  };
  const background = {
    authorizationId: "paths-task",
    applicationId: app,
    resourceId: "kb-doc-1",
    taskId: "task-1",
  };
  const { resourceId: _resourceId, ...unnamed } = online;
  // Each call proves its identity, its resource scope and its task
  // (在线及后台两种调用验证身份、资源范围、任务).
  for (const refused of [
    { ...online, resourceId: "mail-inbox" },
    { ...online, resourceId: "kb" },
    // Without a resource there is no scope to check.
    unnamed,
    // Not as another application.
    { ...online, applicationId: secondApp },
    // An online authorization takes no task.
    { ...online, taskId: "task-1" },
    // A background authorization runs its one task.
    { ...background, taskId: "task-2" },
    {
      authorizationId: "paths-loose",
      applicationId: app,
      resourceId: "kb-doc-1",
    },
    {
      authorizationId: "paths-none",
      applicationId: app,
      resourceId: "kb-doc-1",
    },
    // Another account cannot spend through this one's authorization.
  ])
    expect(
      await timed.reserve(identity, step("paths-refused", refused)),
    ).toEqual({ state: "denied", reason: "not_authorized" });
  expect(
    await timed.reserve(stranger.identity, step("stranger-op-1", online)),
  ).toEqual({ state: "denied", reason: "not_authorized" });
  // None of these refusals is a step waiting for a budget.
  expect(await timed.resumePoints(identity)).toEqual([]);

  const taskPermit = await reservedAs(
    timed,
    identity,
    step("app-task-op-1", background),
  );
  // Twenty-five allows two steps of at most ten each. A third is refused,
  // and it is not a resume point: the limit is the person's to raise.
  const first = await reservedAs(timed, identity, step("app-op-1", online));
  await timed.beginDispatch(identity, {
    operationId: "app-op-1",
    permit: first,
    authorizationId: online.authorizationId,
  });
  const second = await reservedAs(timed, identity, step("app-op-2", online));
  expect(await timed.reserve(identity, step("app-op-3", online))).toEqual({
    state: "denied",
    reason: "execution_limit",
  });
  expect(await timed.resumePoints(identity)).toEqual([]);
  expect(await timed.balance(identity)).toMatchObject({
    reservedMicrocredits: "30",
  });
  // Each reservation names the application and the authorization it counts
  // against, and so does its bill line.
  expect(await operationRow(accountId, "app-op-1")).toMatchObject({
    applicationId: app,
    authorizationId: "paths-online",
  });
  const onlineRecord = async () =>
    (await timed.authorizations(identity))?.find(
      ({ authorizationId }) => authorizationId === "paths-online",
    );
  expect(await onlineRecord()).toMatchObject({ spentMicrocredits: "20" });

  // What an application may read goes through its own authorizations only
  // (#111 应用只能查询自身授权范围内的账户摘要和操作状态).
  expect(await timed.authorizationIdentity(app, "paths-online")).toEqual(
    identity,
  );
  expect(
    await timed.authorizationIdentity(secondApp, "paths-online"),
  ).toBeUndefined();
  expect(await timed.authorizationIdentity(app, "paths-none")).toBeUndefined();
  expect(await timed.authorizationSummary(app, "paths-online")).toMatchObject({
    authorizationId: "paths-online",
    spentMicrocredits: "20",
    reservedMicrocredits: "30",
    availableMicrocredits: "70",
  });
  expect(
    await timed.authorizationSummary(secondApp, "paths-online"),
  ).toBeUndefined();

  // The limit only rises, and the life only extends, by the person (#86
  // 增加上限需用户确认).
  expect(
    await timed.amendAuthorization(identity, "paths-online", {
      limitMicrocredits: 20n,
    }),
  ).toEqual({ state: "not_widened" });
  expect(
    await timed.amendAuthorization(identity, "paths-online", {
      expiresAt: new Date(clock.getTime() + 1_000),
    }),
  ).toEqual({ state: "not_widened" });
  expect(
    await timed.amendAuthorization(identity, "paths-none", {
      limitMicrocredits: 20n,
    }),
  ).toBeUndefined();
  expect(
    await timed.amendAuthorization(stranger.identity, "paths-online", {
      limitMicrocredits: 45n,
    }),
  ).toBeUndefined();
  expect(
    await timed.amendAuthorization(identity, "paths-online", {
      limitMicrocredits: 45n,
      expiresAt: new Date(clock.getTime() + 2 * hour),
    }),
  ).toMatchObject({
    state: "amended",
    authorization: { limitMicrocredits: "45", spentMicrocredits: "20" },
  });

  // Revoking an authorization stops its new reservations, and a reservation
  // already made under it does not run (撤销).
  expect(await timed.revokeAuthorization(identity, "paths-task")).toMatchObject(
    { state: "revoked" },
  );
  expect(
    await timed.revokeAuthorization(identity, "paths-none"),
  ).toBeUndefined();
  expect(
    await timed.revokeAuthorization(stranger.identity, "paths-online"),
  ).toBeUndefined();
  expect(
    await timed.beginDispatch(identity, {
      operationId: "app-task-op-1",
      permit: taskPermit,
      authorizationId: background.authorizationId,
    }),
  ).toEqual({ state: "denied", reason: "not_authorized" });
  expect(await operationRow(accountId, "app-task-op-1")).toMatchObject({
    state: "released",
  });
  expect(
    await timed.reserve(identity, step("app-task-op-2", background)),
  ).toEqual({ state: "denied", reason: "not_authorized" });

  // Pausing the application's path refuses its new reservations, and only
  // its (#112 实测暂停一个路径). A reservation already made does not run;
  // one already dispatched settles, and so do a payment and a refund that
  // were already on their way.
  const inFlight = await paid.createOrder({
    accountId: stranger.accountId,
    productCode: "pack-paths",
    channel: "alipay",
  });
  expect(await timed.pauseApplication(app, "pilot-lead")).toMatchObject({
    pausedBy: "pilot-lead",
  });
  expect(await timed.reserve(identity, step("app-op-3", online))).toEqual({
    state: "denied",
    reason: "route_unavailable",
  });
  expect(
    await timed.beginDispatch(identity, {
      operationId: "app-op-2",
      permit: second,
      authorizationId: online.authorizationId,
    }),
  ).toEqual({ state: "denied", reason: "route_unavailable" });
  expect(await operationRow(accountId, "app-op-2")).toMatchObject({
    state: "released",
  });
  // Another path keeps working.
  await reservedAs(timed, stranger.identity, step("stranger-op-2"));
  expect(
    (
      await paid.verifyOrder({
        orderId: inFlight.id,
        channel: "alipay",
        channelOrderRef: `ali-paths-paused-${run}`,
        amountCents: 9_900,
        paidAt: start,
      })
    ).claimed,
  ).toBe(true);
  await paid.requestRefund(inFlight.id, "user_request", "ops");
  expect((await paid.confirmRefund(inFlight.id, true)).state).toBe("confirmed");
  expect(
    (
      await timed.settle(accountId, "app-op-1", {
        inputTokens: 7n,
        outputTokens: 0n,
      })
    )?.state,
  ).toBe("settled");
  // The bill names the application the step ran for (账单标示来源应用).
  expect(await paid.bill(accountId)).toEqual([
    expect.objectContaining({
      operationId: "app-op-1",
      applicationId: app,
      source: "test",
      amountMicrocredits: "7",
    }),
  ]);
  expect(await onlineRecord()).toMatchObject({ spentMicrocredits: "7" });
  expect(
    await timed.authorizedOperation(app, "paths-online", "app-op-1"),
  ).toMatchObject({ operationId: "app-op-1", state: "settled" });
  // Not through an authorization it did not run under, nor as another
  // application.
  expect(
    await timed.authorizedOperation(app, "paths-task", "app-op-1"),
  ).toBeUndefined();
  expect(
    await timed.authorizedOperation(secondApp, "paths-online", "app-op-1"),
  ).toBeUndefined();
  await timed.resumeApplication(app);
  expect(
    (await timed.applications()).find(({ id }) => id === app),
  ).toMatchObject({ pausedAt: null, pausedBy: null });

  // Its life over, an authorization reserves nothing more (有效期).
  clock = new Date(start.getTime() + 3 * hour);
  expect(await timed.reserve(identity, step("app-op-4", online))).toEqual({
    state: "denied",
    reason: "not_authorized",
  });
  expect((await onlineRecord())?.state).toBe("expired");

  // Paid credits are worth buying only while some path can spend them. One
  // paused path leaves the others open (#99 账户没有可用付费路径时).
  await timed.registerApplication({
    id: secondApp,
    name: "Paths second app",
    operator: "platform",
    resourcePrefix: "mail-",
  });
  await timed.approveApplication(secondApp, "pilot-lead");
  await boughtPack(paid, stranger.accountId, `ali-paths-${run}`, start);
  const order = () =>
    paid.createOrder({
      accountId: stranger.accountId,
      productCode: "pack-paths",
      channel: "alipay",
    });
  await timed.pauseApplication(app, "pilot-lead");
  const open = await order();
  expect(await paid.pendingOrders(stranger.accountId)).toEqual([
    expect.objectContaining({ id: open.id, state: "pending" }),
  ]);
  // At the pilot cutoff, an order the channel says nobody paid is closed,
  // once (#109 截点查单、关闭可关订单).
  expect(await paid.closeOrder(open.id, "pilot-lead")).toMatchObject({
    id: open.id,
    state: "failed",
    closedBy: "pilot-lead",
  });
  expect(await paid.closeOrder(open.id, "pilot-lead")).toBeUndefined();
  expect(await paid.pendingOrders(stranger.accountId)).toEqual([]);
  await timed.pauseApplication(secondApp, "pilot-lead");
  await expect(order()).rejects.toMatchObject({ code: "no_paid_path" });
  expect(await paid.paidPaths()).toEqual(
    expect.arrayContaining([
      { id: app, name: "Paths fixture app", pausedAt: expect.any(Date) },
      { id: secondApp, name: "Paths second app", pausedAt: expect.any(Date) },
    ]),
  );
  await timed.resumeApplication(secondApp);
  expect((await order()).state).toBe("pending");
});

test("after a rollback, dispatched work settles at the price it froze and the old path takes nothing new", async () => {
  const { identity, accountId } = await enrolled("rollback", 200n);
  const step = (operationId: string) => ({
    operationId,
    route: routeId,
    priceVersion,
  });
  const underWay = await reservedAs(ledger, identity, step("rollback-op-1"));
  await ledger.beginDispatch(identity, {
    operationId: "rollback-op-1",
    permit: underWay,
  });
  const waiting = await reservedAs(ledger, identity, step("rollback-op-2"));

  // The service changes to a build that no longer offers the old route,
  // and quotes a new price (#108 回滚前暂停受影响路径新派发).
  await install(nextCatalog);

  // The old path takes no new reservation...
  expect(await ledger.reserve(identity, step("rollback-op-3"))).toEqual({
    state: "denied",
    reason: "route_unavailable",
  });
  // ...and a reservation that had not dispatched does not run. Nothing is
  // charged for it.
  expect(
    await ledger.beginDispatch(identity, {
      operationId: "rollback-op-2",
      permit: waiting,
    }),
  ).toEqual({ state: "denied", reason: "route_unavailable" });
  expect(await operationRow(accountId, "rollback-op-2")).toMatchObject({
    state: "released",
  });
  // The step already dispatched settles on the current ledger at the price
  // it froze: seven tokens cost seven, not seventy (#108 原价格及规则完成存量).
  expect(
    await ledger.settle(accountId, "rollback-op-1", {
      inputTokens: 7n,
      outputTokens: 0n,
    }),
  ).toMatchObject({ state: "settled", chargedMicrocredits: "7" });
  expect(await ledger.balance(identity)).toMatchObject({
    availableMicrocredits: "193",
    chargedMicrocredits: "7",
  });

  // New work quotes the new path at its own price.
  const next = await ledger.quote();
  if (!next) throw new Error("the new path is not quoted");
  expect(next.route).toBe(nextRouteId);
  await reservedAs(ledger, identity, {
    operationId: "rollback-op-4",
    route: nextRouteId,
    priceVersion: next.priceVersion,
  });
  expect(await ledger.balance(identity)).toMatchObject({
    reservedMicrocredits: "100",
  });
  await install(catalog);
});

test("a restore from an old backup pauses the ledger, replays each record once and resumes accounts one by one", async () => {
  let clock = new Date("2026-07-01T00:00:00.000Z");
  const paid = createPaidCreditLedger(database, () => clock);
  const a = await enrolled("restore-a", 100n);
  const b = await enrolled("restore-b", 100n);
  const ref = (tag: string) => `ali-restore-${tag}-${run}`;
  // A step on the paid entry.
  const step = (operationId: string) => ({
    operationId,
    route: routeId,
    priceVersion,
    creditType: "paid" as const,
  });
  const balanceOf = (accountId: string) => paid.paidBalance(accountId);
  // Each payment lands a minute later, so their order is not a tie.
  const tick = () => {
    clock = new Date(clock.getTime() + 60_000);
    return clock;
  };
  // A provider-cost ceiling on this path, so a reservation also takes a
  // share of it (#106).
  await ledger.setProviderCostLimit({
    path: routeId,
    limitMicrocredits: 1_000n,
    by: "pilot-lead",
  });

  // Before the backup: a payment, a refund and a dispatched call, with a
  // reservation not yet dispatched (#108 在有付款、退款和已派发调用的状态抓取备份).
  await boughtPack(paid, a.accountId, ref("a1"), tick());
  const refunded = await boughtPack(paid, a.accountId, ref("a0"), tick());
  await paid.requestRefund(refunded.id, "user_request", "ops");
  expect((await paid.confirmRefund(refunded.id, true)).state).toBe("confirmed");
  await paidStep(ledger, a.identity, a.accountId, "restore-op-1");
  const waiting = await reservedAs(ledger, a.identity, step("restore-op-0"));
  expect(await balanceOf(a.accountId)).toEqual({
    availableMicrocredits: "83",
    reservedMicrocredits: "10",
    chargedMicrocredits: "7",
  });

  // The backup: the ledger's rows for these accounts.
  const ids = [a.accountId, b.accountId];
  const tables = [
    paidOrders,
    paidEntitlements,
    paidRefunds,
    paidCreditAllocations,
    testCreditOperations,
    testCreditEvidence,
    lagoUsageEvents,
    pilotProviderCostHolds,
  ] as const;
  const backup = await Promise.all(
    tables.map((table) =>
      database.select().from(table).where(inArray(table.accountId, ids)),
    ),
  );

  // Then more records: two payments and a dispatched call.
  const later = await boughtPack(paid, a.accountId, ref("a2"), tick());
  await paidStep(ledger, a.identity, a.accountId, "restore-op-2");
  const laterB = await boughtPack(paid, b.accountId, ref("b1"), tick());
  expect(await balanceOf(a.accountId)).toEqual({
    availableMicrocredits: "176",
    reservedMicrocredits: "10",
    chargedMicrocredits: "14",
  });

  // The old backup is put back.
  await database.transaction(async (tx) => {
    for (const table of [...tables].reverse())
      await tx.delete(table).where(inArray(table.accountId, ids));
    for (const [index, table] of tables.entries())
      if (backup[index].length > 0)
        await tx.insert(table).values(backup[index] as never);
  });
  expect(await balanceOf(a.accountId)).toEqual({
    availableMicrocredits: "83",
    reservedMicrocredits: "10",
    chargedMicrocredits: "7",
  });
  expect(await paid.entitlements(b.accountId)).toHaveLength(0);

  // Restore mode pauses new charges and grants, and reaches reservations
  // made before it (#108 恢复阶段暂停新增收费与发放).
  const since = await paid.beginRestore("operator");
  expect(since).toEqual(clock);
  const newOrder = (accountId: string) =>
    paid.createOrder({
      accountId,
      productCode: "pack-paths",
      channel: "alipay",
    });
  for (const accountId of ids)
    await expect(newOrder(accountId)).rejects.toMatchObject({
      code: "ledger_restoring",
    });
  const heldBatch = crypto.randomUUID();
  batchIds.push(heldBatch);
  await ledger.enroll({ identity: b.identity, batchId: heldBatch, amount: 5n });
  expect(await ledger.claim(b.identity, heldBatch)).toBeUndefined();
  await expect(
    paid.applyCompensation({
      accountId: b.accountId,
      amountMicrocredits: 5n,
      reason: "Recovery fixture",
      evidence: "recovery-compensation",
      by: "operator",
    }),
  ).rejects.toMatchObject({ code: "ledger_restoring" });
  expect(
    await ledger.reserve(a.identity, {
      operationId: "restore-op-3",
      route: routeId,
      priceVersion,
    }),
  ).toEqual({ state: "denied", reason: "unavailable" });
  expect(
    await ledger.beginDispatch(a.identity, {
      operationId: "restore-op-0",
      permit: waiting,
    }),
  ).toEqual({ state: "denied", reason: "not_authorized" });
  expect(await operationRow(a.accountId, "restore-op-0")).toMatchObject({
    state: "released",
  });
  const replayPayment = (order: { id: string }, tag: string, paidAt: Date) =>
    paid.verifyOrder({
      orderId: order.id,
      channel: "alipay",
      channelOrderRef: ref(tag),
      amountCents: 9_900,
      paidAt,
    });
  const restoreOrder = (order: { id: string }, accountId: string) =>
    paid.restoreOrder({
      id: order.id,
      accountId,
      productCode: "pack-paths",
      priceCents: 9_900,
      channel: "alipay",
    });
  // An order the backup never saw is put back by the ID the channel knows,
  // once. Its payment still waits for the account (#108 按原 ID…重建).
  expect(await restoreOrder(later, a.accountId)).toMatchObject({
    id: later.id,
    state: "pending",
  });
  expect(await restoreOrder(later, a.accountId)).toBeUndefined();
  await expect(replayPayment(later, "a2", clock)).rejects.toMatchObject({
    code: "ledger_restoring",
  });

  // An account whose records match the channel is resumed on its own.
  // Everything after the backup is rebuilt by its original ID, and running
  // the replay again changes nothing (#108 重跑对账后每笔结果仍只出现一次).
  await paid.resumeAccount(a.accountId);
  const after = {
    availableMicrocredits: "186",
    reservedMicrocredits: "0",
    chargedMicrocredits: "14",
  };
  // The payment by its channel reference, twice.
  expect((await replayPayment(later, "a2", clock)).claimed).toBe(true);
  // A replay answers with the original outcome, and grants nothing again.
  expect(await replayPayment(later, "a2", clock)).toMatchObject({
    replayed: true,
    claimed: true,
  });
  // The call by its operation ID and its trusted usage, twice. The runner
  // reserves and dispatches as it did, with the reservation it gets back.
  const replayPermit = await reservedAs(
    ledger,
    a.identity,
    step("restore-op-2"),
  );
  await ledger.beginDispatch(a.identity, {
    operationId: "restore-op-2",
    permit: replayPermit,
  });
  const replayUsage = async () => {
    for (let n = 0; n < 2; n += 1) {
      await ledger.recordEvidence(a.accountId, "restore-op-2", {
        evidenceId: "restore-evidence-2",
        outcome: "completed",
        inputTokens: 7n,
        outputTokens: 0n,
      });
      expect(
        await ledger.settleRecorded(a.accountId, "restore-op-2"),
      ).toMatchObject({ state: "settled", chargedMicrocredits: "7" });
    }
    expect(await balanceOf(a.accountId)).toEqual(after);
  };
  await replayUsage();
  expect(
    (await paid.entitlements(a.accountId)).map(({ state }) => state),
    // The first pack, the refunded one and the replayed one.
  ).toEqual(["granted", "revoked", "granted"]);
  expect(await paid.bill(a.accountId)).toEqual([
    expect.objectContaining({
      operationId: "restore-op-1",
      amountMicrocredits: "7",
    }),
    expect.objectContaining({
      operationId: "restore-op-2",
      amountMicrocredits: "7",
    }),
  ]);
  // The provider-cost share is taken once.
  expect(
    await database
      .select()
      .from(pilotProviderCostHolds)
      .where(
        and(
          eq(pilotProviderCostHolds.accountId, a.accountId),
          eq(pilotProviderCostHolds.operationId, "restore-op-2"),
        ),
      ),
  ).toEqual([
    expect.objectContaining({ state: "verified", costMicrocredits: 7n }),
  ]);
  // Running the whole replay again adds nothing: the same operation answers
  // with its record, the same evidence settles nothing twice.
  expect(await replayPayment(later, "a2", clock)).toMatchObject({
    replayed: true,
  });
  expect(await ledger.reserve(a.identity, step("restore-op-2"))).toMatchObject({
    state: "existing",
  });
  await replayUsage();

  // Resumed, it reserves again while the ledger is still restoring.
  await reservedAs(ledger, a.identity, {
    operationId: "restore-op-3",
    route: routeId,
    priceVersion,
  });

  // An account with a difference stays paused: the channel paid an order
  // the ledger no longer has (#108 出现差异的账户维持暂停).
  await expect(newOrder(b.accountId)).rejects.toMatchObject({
    code: "ledger_restoring",
  });
  expect(
    await ledger.reserve(b.identity, {
      operationId: "restore-op-b",
      route: routeId,
      priceVersion,
    }),
  ).toEqual({ state: "denied", reason: "unavailable" });
  // Beginning the restore again keeps its start, so A stays resumed.
  expect(await paid.beginRestore("operator")).toEqual(since);
  expect(await ledger.receipt(a.identity, "restore-op-3")).toMatchObject({
    state: "reserved",
  });

  // The order is put back by the ID the channel knows, the account is
  // reconciled, and its payment verifies by the original reference.
  await restoreOrder(laterB, b.accountId);
  await paid.resumeAccount(b.accountId);
  expect(await ledger.claim(b.identity, heldBatch)).toMatchObject({
    batchId: heldBatch,
  });
  expect((await replayPayment(laterB, "b1", clock)).claimed).toBe(true);
  expect(await replayPayment(laterB, "b1", clock)).toMatchObject({
    replayed: true,
  });
  expect(await balanceOf(b.accountId)).toEqual({
    availableMicrocredits: "100",
    reservedMicrocredits: "0",
    chargedMicrocredits: "0",
  });

  // The restore ends. A later one holds every account again until each is
  // reconciled once more.
  await paid.endRestore();
  expect((await newOrder(b.accountId)).state).toBe("pending");
  await expect(
    paid.restoreOrder({
      id: later.id,
      accountId: a.accountId,
      productCode: "pack-paths",
      priceCents: 9_900,
      channel: "alipay",
    }),
  ).rejects.toMatchObject({ code: "not_restoring" });
  clock = new Date(clock.getTime() + 60 * 60_000);
  expect(await paid.beginRestore("operator")).toEqual(clock);
  expect(
    await ledger.reserve(b.identity, {
      operationId: "restore-op-b",
      route: routeId,
      priceVersion,
    }),
  ).toEqual({ state: "denied", reason: "unavailable" });
  // Nothing is resumed once the restore has ended.
  await paid.endRestore();
  expect(await paid.resumeAccount(b.accountId)).toBeUndefined();
});

test("paid pilot requires matching path and channel signoffs and drains in-flight work after pause", async () => {
  const { accountId, identity } = await enrolled("signoff", 20n);
  const scope = {
    evidence: "fixture" as const,
    deploymentId: "local",
    buildVersion: "issue-112",
    imageDigest: `sha256:${"a".repeat(64)}`,
  };
  const paid = createPaidCreditLedger(database, undefined, undefined, scope);
  const credit = createTestCreditLedger(database, undefined, scope);
  const order = (channel: "alipay" | "wechat" = "alipay") =>
    paid.createOrder({ accountId, productCode: "pack-paths", channel });
  const firstParty = `paths-first-party-${run}`;
  const alternative = `paths-signoff-alternative-${run}`;
  await credit.registerApplication({
    id: firstParty,
    name: "Fixture platform path",
    operator: "platform",
    resourcePrefix: "fixture-platform:",
  });
  await credit.approveApplication(firstParty, "fixture-lead");
  await credit.registerApplication({
    id: alternative,
    name: "Fixture alternative path",
    operator: "platform",
    resourcePrefix: "fixture-alternative:",
  });
  await credit.approveApplication(alternative, "fixture-lead");
  await expect(order()).rejects.toMatchObject({ code: "no_paid_path" });
  const signoffs = createPilotSignoffs(database);
  const revision = catalog.routes[routeId]?.revision;
  if (!revision) throw new Error("Missing fixture route revision.");
  const record = {
    ...scope,
    approvedBy: "fixture-lead",
    pauseOwner: "fixture-ops",
    accountIds: [accountId],
    deploymentRef: "fixture:build",
  };
  const channelRecord = {
    ...record,
    kind: "channel",
    id: "alipay",
    merchant: "fixture-alipay",
    maxOrderCents: 9900,
    paymentRef: "fixture:payment",
    refundRef: "fixture:refund",
    reconciliationRef: "fixture:reconciliation",
    rulesRef: "fixture:rules",
  };
  await signoffs.record(channelRecord);
  await expect(order()).rejects.toMatchObject({ code: "no_paid_path" });
  await credit.setProviderCostLimit({
    path: routeId,
    limitMicrocredits: 1000n,
    by: "fixture-ops",
  });
  for (const id of [firstParty, alternative]) {
    await signoffs.record({
      ...record,
      kind: "application",
      id,
      pathRef: `fixture:${id}`,
      rampRef: "fixture:ramp",
      routes: [
        {
          id: routeId,
          provider: "fixture-paths",
          revision,
          resourceType: "chat",
          reconciliationRef: "fixture:supplier-window",
          supplierCapMicrocredits: "1000",
          maxOperationMicrocredits: "20",
        },
      ],
    });
  }
  await expect(order("wechat")).rejects.toMatchObject({
    code: "channel_unavailable",
  });
  const otherDeployment = createPaidCreditLedger(
    database,
    undefined,
    undefined,
    {
      ...scope,
      evidence: "deployment",
    },
  );
  await expect(
    otherDeployment.createOrder({
      accountId,
      productCode: "pack-paths",
      channel: "alipay",
    }),
  ).rejects.toMatchObject({ code: "no_paid_path" });
  const testMerchant = {
    merchant: "fixture-alipay",
    version: 1,
    applicationIds: [firstParty, alternative],
  };
  const fixtureOrder = (
    ledger = paid,
    channel: "alipay" | "wechat" = "alipay",
    buyer = accountId,
  ) =>
    ledger.createOrder({
      accountId: buyer,
      productCode: "pack-paths",
      channel,
      testPack: {
        ...testMerchant,
        merchant: `fixture-${channel}`,
        id: crypto.randomUUID(),
      },
    });
  const excluded = await enrolled("signoff-excluded", 20n);
  await expect(
    fixtureOrder(paid, "alipay", excluded.accountId),
  ).rejects.toMatchObject({ code: "no_paid_path" });
  const staleBuild = createPaidCreditLedger(database, undefined, undefined, {
    ...scope,
    buildVersion: "new-build",
  });
  await expect(fixtureOrder(staleBuild)).rejects.toMatchObject({
    code: "no_paid_path",
  });
  await signoffs.record({ ...channelRecord, maxOrderCents: 9899 });
  await expect(fixtureOrder()).rejects.toMatchObject({
    code: "channel_unavailable",
  });
  await signoffs.record(channelRecord);
  await expect(
    signoffs.record({ ...channelRecord, evidence: "deployment" }),
  ).rejects.toThrow("A fixture merchant cannot receive deployment signoff.");
  await expect(fixtureOrder(paid, "wechat")).rejects.toMatchObject({
    code: "channel_unavailable",
  });
  await signoffs.record({
    ...channelRecord,
    id: "wechat",
    merchant: "fixture-wechat",
  });
  const paidAt = new Date();
  const verified = await fixtureOrder();
  const pending = await fixtureOrder();
  async function verify(id: string) {
    expect(
      (
        await paid.verifyOrder({
          orderId: id,
          channel: "alipay",
          channelOrderRef: `fixture:${id}`,
          amountCents: 9900,
          paidAt,
          merchantId: testMerchant.merchant,
          currency: "CNY",
          testChannel: true,
        })
      ).claimed,
    ).toBe(true);
  }
  await verify(verified.id);
  const step = (operationId: string, applicationId = firstParty) => ({
    operationId,
    applicationId,
    route: routeId,
    priceVersion,
    creditType: "paid" as const,
  });
  const productionCredit = createTestCreditLedger(database, undefined, {
    ...scope,
    evidence: "deployment",
  });
  expect(
    await productionCredit.reserve(identity, step("fixture-isolation")),
  ).toEqual({
    state: "denied",
    reason: "route_unavailable",
  });
  await credit.setProviderCostLimit({
    path: routeId,
    limitMicrocredits: 1001n,
    by: "fixture-ops",
  });
  expect(await credit.reserve(identity, step("excess-cap"))).toEqual({
    state: "denied",
    reason: "route_unavailable",
  });
  await expect(fixtureOrder()).rejects.toMatchObject({ code: "no_paid_path" });
  await credit.setProviderCostLimit({
    path: routeId,
    limitMicrocredits: 1000n,
    by: "fixture-ops",
  });
  const dispatched = await reservedAs(credit, identity, step("signed-sent"));
  expect(
    await credit.beginDispatch(identity, {
      operationId: "signed-sent",
      permit: dispatched,
    }),
  ).toMatchObject({ state: "dispatch" });
  const held = await reservedAs(credit, identity, step("signed-held"));
  await credit.pauseApplication(firstParty, "fixture-ops");
  expect(await credit.reserve(identity, step("signed-after"))).toEqual({
    state: "denied",
    reason: "route_unavailable",
  });
  expect(
    await credit.beginDispatch(identity, {
      operationId: "signed-held",
      permit: held,
    }),
  ).toEqual({ state: "denied", reason: "route_unavailable" });
  expect(await operationRow(accountId, "signed-held")).toMatchObject({
    state: "released",
  });
  await reservedAs(credit, identity, step("signed-alternative", alternative));
  expect((await fixtureOrder()).state).toBe("pending");
  await signoffs.setChannelPause("alipay", "fixture", "fixture-ops");
  await signoffs.record(channelRecord);
  expect((await fixtureOrder(paid, "wechat")).state).toBe("pending");
  await expect(
    paid.checkTestCheckout(
      accountId,
      testMerchant.applicationIds,
      {
        channel: "alipay",
        merchant: testMerchant.merchant,
        fixture: true,
      },
      pending.priceCents,
    ),
  ).rejects.toMatchObject({ code: "channel_unavailable" });
  await expect(fixtureOrder()).rejects.toMatchObject({
    code: "channel_unavailable",
  });
  await verify(pending.id);
  const refund = await paid.requestTestPackRefund({
    orderId: pending.id,
    accountId,
    channel: "alipay",
    merchant: testMerchant.merchant,
  });
  expect(
    await paid.applyTestPackRefundResult({
      orderId: pending.id,
      refundId: refund.id,
      merchantId: testMerchant.merchant,
      channel: "alipay",
      channelOrderRef: `fixture:${pending.id}`,
      currency: "CNY",
      amountCents: 9900,
      state: "confirmed",
    }),
  ).toMatchObject({ state: "confirmed" });
  expect(
    await credit.settle(accountId, "signed-sent", {
      inputTokens: 7n,
      outputTokens: 0n,
    }),
  ).toMatchObject({ state: "settled", chargedMicrocredits: "7" });
});
