import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { run as runBillingPaths } from "../scripts/billing-paths";
import { startCreditPackFixture } from "../scripts/credit-pack-test-fixture";
import {
  configure,
  emptyCatalog,
  pilotCatalogKey,
  publish as publishCatalog,
  verify,
} from "../src/admin/bifrost-catalog";
import {
  type CreditPackChannel,
  type CreditPackTestRefundResult,
  loadCreditPackTestChannel,
  testRefundTerms,
} from "../src/billing/credit-pack-test-channel";
import { createFlexpriceAlipaySweep } from "../src/billing/flexprice-alipay-checkout";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import { createTestCreditLedger } from "../src/billing/test-credit";
import { createTestCreditRoutes } from "../src/billing/test-credit-routes";
import { createDatabase } from "../src/db/client";
import {
  billingApplications,
  enterpriseSettings,
  lagoUsageEvents,
  paidCreditAllocations,
  paidEntitlements,
  paidOrders,
  paidPilotClosure,
  paidProducts,
  paidRefunds,
  testCreditAccounts,
  testCreditEvidence,
  testCreditOperations,
  testCreditResumePoints,
} from "../src/db/schema";
import { fixtureTraceReport } from "./support/bifrost-evidence";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
let time: Date | undefined;
const clock = () => time ?? new Date();
const ledger = createTestCreditLedger(database, clock);
const paid = createPaidCreditLedger(database, clock);
const code = "fixture-credit-pack";
const token = "fixture-credit-pack-token-for-local-test";
const alipayToken = "fixture-alipay-token-for-local-test";
const issuer = "credit-pack-fixture";
const alice = crypto.randomUUID();
const bob = crypto.randomUUID();
const outsider = crypto.randomUUID();
const subscriber = crypto.randomUUID();
const switcher = crypto.randomUUID();
const fixtureSubjects = new Set<string>([
  alice,
  bob,
  outsider,
  subscriber,
  switcher,
]);
type RefundTerms = ReturnType<typeof testRefundTerms.parse>;
const refundStarts = new Map<string, RefundTerms>();
const refundChannels = new Map<string, string>();
let refundUnavailable = false;
let accountIds: string[] = [];
const payments = new Map<string, object>();
const starts = new Map<string, unknown>();
const switchCalls: string[] = [];
const closeResults = new Map<string, object>();
let onQuery: (() => Promise<void>) | undefined;
const openbotApp = `checkout-openbot-${alice}`;
const secondApp = `checkout-second-${alice}`;
function startControlledFixture(credential: string) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server): Promise<Response> {
      if (request.headers.get("authorization") !== `Bearer ${credential}`)
        return new Response(null, { status: 401 });
      const [, route, id = ""] = new URL(request.url).pathname.split("/");
      if (route === "refunds") {
        if (refundUnavailable) return new Response(null, { status: 503 });
        if (request.method !== "PUT")
          return Response.json({ state: "unknown" });
        const terms = testRefundTerms.parse(await request.json());
        refundStarts.set(id, terms);
        refundChannels.set(id, credential);
        return Response.json({ ...terms, state: "processing" });
      }
      if (request.method === "PUT") {
        starts.set(id, await request.json());
        return Response.json({
          checkoutUrl: `${server.url.origin}/checkout/${id}`,
        });
      }
      if (request.method === "DELETE") {
        switchCalls.push(`close:${id}`);
        return Response.json(
          payments.get(id) ?? closeResults.get(id) ?? { state: "unknown" },
        );
      }
      switchCalls.push(`query:${id}`);
      await onQuery?.();
      return Response.json(payments.get(id) ?? { state: "unknown" });
    },
  });
}

const fixture = startControlledFixture(token);
const alipayFixture = startControlledFixture(alipayToken);

let api: Hono;
const billingServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => api.fetch(request),
});
beforeAll(async () => {
  accountIds = (
    await database
      .insert(testCreditAccounts)
      .values([...fixtureSubjects].map((subject) => ({ issuer, subject })))
      .returning()
  ).map(({ id }) => id);
  api = mount(fixture.url.origin);
  await publish(2_500, 25_000_000n);
});

function mount(
  origin: string,
  eligible = accountIds.filter((_, index) => index !== 2),
  alipayOrigin?: string,
  execute?: Parameters<typeof createTestCreditRoutes>[0]["execute"],
) {
  const app = new Hono();
  const env = {
    OPENBOT_CREDIT_PACK_TEST_ORIGIN: origin,
    OPENBOT_CREDIT_PACK_TEST_TOKEN: token,
    OPENBOT_CREDIT_PACK_TEST_ACCOUNT_IDS: eligible.join(","),
    OPENBOT_CREDIT_PACK_TEST_PRODUCT: code,
    OPENBOT_CREDIT_PACK_TEST_APPLICATION_IDS: [openbotApp, secondApp].join(","),
    OPENBOT_CREDIT_PACK_TEST_MERCHANT: "fixture-merchant",
    OPENBOT_CREDIT_PACK_ALIPAY_TEST_ORIGIN: alipayOrigin,
    OPENBOT_CREDIT_PACK_ALIPAY_TEST_TOKEN: alipayToken,
    OPENBOT_CREDIT_PACK_ALIPAY_TEST_ACCOUNT_IDS: eligible.join(","),
    OPENBOT_CREDIT_PACK_ALIPAY_TEST_APPLICATION_IDS: [
      openbotApp,
      secondApp,
    ].join(","),
    OPENBOT_CREDIT_PACK_ALIPAY_TEST_MERCHANT: "fixture-merchant",
  };
  app.route(
    "/api/billing",
    createTestCreditRoutes({
      ledger,
      execute,
      paid: {
        ledger: paid,
        creditPackTestChannel: loadCreditPackTestChannel(env),
        alipayCreditPackTestChannel: loadCreditPackTestChannel(env, "alipay"),
      },
      authenticate: async (request) => {
        const subject = request.headers.get("x-fixture-subject");
        return subject && fixtureSubjects.has(subject)
          ? { issuer, subject }
          : undefined;
      },
    }),
  );
  return app;
}

afterAll(async () => {
  await Promise.all([
    fixture.stop(true),
    alipayFixture.stop(true),
    billingServer.stop(true),
  ]);
  await database
    .delete(paidPilotClosure)
    .where(inArray(paidPilotClosure.id, accountIds));
  await database
    .delete(paidCreditAllocations)
    .where(inArray(paidCreditAllocations.accountId, accountIds));
  await database
    .delete(paidEntitlements)
    .where(inArray(paidEntitlements.accountId, accountIds));
  await database
    .delete(paidRefunds)
    .where(inArray(paidRefunds.accountId, accountIds));
  await database
    .delete(paidOrders)
    .where(inArray(paidOrders.accountId, accountIds));
  await database
    .delete(paidProducts)
    .where(inArray(paidProducts.code, [code, monthly, plus]));
  await database
    .delete(lagoUsageEvents)
    .where(inArray(lagoUsageEvents.accountId, accountIds));
  await database
    .delete(testCreditEvidence)
    .where(inArray(testCreditEvidence.accountId, accountIds));
  await database
    .delete(testCreditOperations)
    .where(inArray(testCreditOperations.accountId, accountIds));
  await database
    .delete(testCreditResumePoints)
    .where(inArray(testCreditResumePoints.accountId, accountIds));
  await database
    .delete(testCreditAccounts)
    .where(inArray(testCreditAccounts.id, accountIds));
  await database
    .delete(billingApplications)
    .where(inArray(billingApplications.id, [openbotApp, secondApp]));
  await database.$client.close();
});

const publish = (priceCents: number, creditsMicrocredits: bigint) =>
  paid.upsertProduct({
    code,
    kind: "credit_pack",
    priceCents,
    creditsMicrocredits,
  });
const orders = "/paid/credit-pack/orders";
const callback = "/credit-pack-test/callback";
const refundCallback = "/credit-pack-test/refund-callback";
function call(
  path: string,
  subject?: string,
  body?: object,
  channelAuth: boolean | string = false,
) {
  return fetch(new URL(`/api/billing${path}`, billingServer.url), {
    method: body ? "POST" : "GET",
    headers: {
      ...(subject ? { "x-fixture-subject": subject } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...(channelAuth
        ? {
            authorization: `Bearer ${typeof channelAuth === "string" ? channelAuth : token}`,
          }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function approvePaths() {
  for (const [id, name] of [
    [openbotApp, "OpenBot"],
    [secondApp, "Fixture app"],
  ]) {
    await ledger.registerApplication({
      id,
      name,
      operator: "platform",
      resourcePrefix: id,
    });
    await ledger.approveApplication(id, "fixture");
  }
  await ledger.resumeApplication(openbotApp);
}

test("an eligible person locks the shown CNY offer and verifies a channel payment once", async () => {
  expect((await call("/paid/credit-pack", outsider)).status).toBe(404);
  const offer = await (await call("/paid/credit-pack", alice)).json();
  expect(offer.product).toMatchObject({
    priceCents: 2500,
    currency: "CNY",
    creditsMicrocredits: "25000000",
  });
  const input = {
    version: offer.product.version,
    orderId: crypto.randomUUID(),
  };
  expect((await call(orders, alice, input)).status).toBe(409); // No approved paths.
  await approvePaths();
  await ledger.pauseApplication(secondApp, "fixture");
  expect(await (await call("/paid/credit-pack", alice)).json()).toMatchObject({
    available: true,
    pausedApplications: ["Fixture app"],
  });

  const placed = await call(orders, alice, input);
  expect(placed.status).toBe(201);
  expect(await placed.json()).toMatchObject({
    id: input.orderId,
    state: "pending",
  });
  expect((await call(orders, alice, input)).status).toBe(200);
  const path = `${orders}/${input.orderId}`;
  expect((await call(`${path}/checkout`, alice, {})).status).toBe(200);
  expect(starts.get(input.orderId)).toMatchObject({
    amountCents: 2500,
    merchantId: "fixture-merchant",
    currency: "CNY",
  });
  expect(await (await call(`${path}/verify`, alice, {})).json()).toMatchObject({
    state: "pending",
  });
  expect((await call(`${path}/verify`, bob, {})).status).toBe(404);

  await publish(3500, 35_000_000n);
  expect(
    (await call(orders, alice, { ...input, orderId: crypto.randomUUID() }))
      .status,
  ).toBe(409);
  await ledger.pauseApplication(openbotApp, "fixture");
  expect(
    (
      await call(orders, alice, {
        version: input.version + 1,
        orderId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);

  const result = {
    state: "paid",
    orderId: input.orderId,
    merchantId: "fixture-merchant",
    currency: "CNY",
    amountCents: 2500,
    channelOrderRef: crypto.randomUUID(),
    paidAt: new Date().toISOString(),
  };
  expect((await call(callback, undefined, result)).status).toBe(401);
  for (const mismatch of [
    { merchantId: "other" },
    { amountCents: 3500 },
    { currency: "USD" },
  ]) {
    expect(
      (await call(callback, undefined, { ...result, ...mismatch }, true))
        .status,
    ).toBe(409);
  }
  const wrongOrder = { ...result, orderId: crypto.randomUUID() };
  expect((await call(callback, undefined, wrongOrder, true)).status).toBe(404);
  payments.set(input.orderId, wrongOrder);
  expect((await call(`${path}/verify`, alice, {})).status).toBe(409);
  expect(await (await call("/paid/sources", alice)).json()).toEqual([]);

  payments.set(input.orderId, result);
  const queriesEntered = Promise.withResolvers<void>();
  const releaseQueries = Promise.withResolvers<void>();
  let queries = 0;
  onQuery = () => {
    if (++queries === 2) queriesEntered.resolve();
    return releaseQueries.promise;
  };
  const active = [
    call(`${path}/verify`, alice, {}),
    call(`${path}/verify`, alice, {}),
  ];
  await queriesEntered.promise;
  const callbacks = [
    call(callback, undefined, result, true),
    call(callback, undefined, result, true),
  ];
  releaseQueries.resolve();
  const verified = await Promise.all([...callbacks, ...active]);
  onQuery = undefined;
  expect(verified.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
  const sources = await (await call("/paid/sources", alice)).json();
  expect(sources).toMatchObject([
    { orderId: input.orderId, remainingMicrocredits: "25000000" },
  ]);
  expect(await (await call(orders, alice)).json()).toMatchObject([
    {
      id: input.orderId,
      state: "verified",
      entitlementId: sources[0].entitlementId,
    },
  ]);
  expect(await (await call("/paid/balance", alice)).json()).toMatchObject({
    availableMicrocredits: "25000000",
  });
  expect(await (await call("/balance", alice)).json()).toMatchObject({
    availableMicrocredits: "0",
  });
  expect(await (await call(orders, bob)).json()).toEqual([]);
});

test("a ledger outage blocks checkout and credit issuance, then the original order can reconcile", async () => {
  await approvePaths();
  await publish(3500, 35_000_000n);
  const offer = await (await call("/paid/credit-pack", bob)).json();
  const input = {
    orderId: crypto.randomUUID(),
    version: offer.product.version,
  };
  const path = `${orders}/${input.orderId}`;
  expect((await call(orders, bob, input)).status).toBe(201);
  const result = {
    state: "paid",
    orderId: input.orderId,
    merchantId: "fixture-merchant",
    currency: "CNY",
    amountCents: 3500,
    channelOrderRef: crypto.randomUUID(),
    paidAt: new Date().toISOString(),
  };
  payments.set(input.orderId, result);
  const another = { ...input, orderId: crypto.randomUUID() };
  // Simulate a ledger whose order records survive but whose credit sources cannot be confirmed.
  await database.execute(
    sql`ALTER TABLE paid_credit_allocations RENAME TO checkout_unavailable_allocations`,
  );
  try {
    expect((await call(orders, bob, another)).status).toBe(503);
    expect(await (await call(orders, bob)).json()).toMatchObject([
      { id: input.orderId, state: "pending" },
    ]);
  } finally {
    await database.execute(
      sql`ALTER TABLE checkout_unavailable_allocations RENAME TO paid_credit_allocations`,
    );
  }
  await paid.beginRestore("fixture");
  try {
    expect((await call(orders, bob, another)).status).toBe(503);
    expect((await call(`${path}/verify`, bob, {})).status).toBe(503);
    expect((await call(callback, undefined, result, true)).status).toBe(503);
  } finally {
    await paid.endRestore();
  }
  expect(await (await call(`${path}/verify`, bob, {})).json()).toMatchObject({
    id: input.orderId,
    state: "verified",
  });
  expect(await (await call("/paid/balance", bob)).json()).toMatchObject({
    availableMicrocredits: "35000000",
  });
});

test("the runnable fixture records a user confirmation and the order is recoverable after a missed callback", async () => {
  await approvePaths();
  const previous = api;
  let delivered = false;
  let refundCallbackStatuses: number[] = [];
  let confirmedResult: CreditPackTestRefundResult | undefined;
  const checkoutFixture = startCreditPackFixture({
    port: 0,
    token,
    notifyRefund: async (result) => {
      const unauthenticated = await call(refundCallback, undefined, result);
      const wrongAmount = await call(
        refundCallback,
        undefined,
        { ...result, amountCents: 1 },
        true,
      );
      refundCallbackStatuses = [unauthenticated.status, wrongAmount.status];
      confirmedResult = result;
      return new Response(null, { status: 503 });
    },
    notify: async (result) => {
      if (!delivered) return new Response(null, { status: 503 });
      return call(callback, undefined, result, true);
    },
  });
  api = mount(checkoutFixture.url.origin);
  try {
    const offer = await (await call("/paid/credit-pack", alice)).json();
    const input = {
      orderId: crypto.randomUUID(),
      version: offer.product.version,
    };
    expect((await call(orders, alice, input)).status).toBe(201);
    const path = `${orders}/${input.orderId}`;
    const { checkoutUrl } = await (
      await call(`${path}/checkout`, alice, {})
    ).json();
    expect(await (await fetch(checkoutUrl)).text()).toContain(
      "Confirm simulated payment",
    );
    expect((await call(`${path}/verify`, bob, {})).status).toBe(404);
    expect(
      await (await fetch(checkoutUrl, { method: "POST" })).text(),
    ).toContain("Check payment");
    api = mount(checkoutFixture.url.origin, []);
    expect(await (await call("/paid/credit-pack", alice)).json()).toMatchObject(
      { available: false },
    );
    expect(
      (await call(orders, alice, { ...input, orderId: crypto.randomUUID() }))
        .status,
    ).toBe(404);
    expect(
      await (await call(`${path}/verify`, alice, {})).json(),
    ).toMatchObject({ state: "verified" });
    delivered = true;
    expect(
      await (await fetch(checkoutUrl, { method: "POST" })).text(),
    ).toContain("payment confirmed");
    const sources = await (await call("/paid/sources", alice)).json();
    expect(
      sources.filter(
        (source: { orderId: string }) => source.orderId === input.orderId,
      ),
    ).toHaveLength(1);
    const requestRefund = () => call(`${path}/refund`, alice, {});
    expect((await call(`${path}/refund`, bob, {})).status).toBe(404);
    const [first, replay] = await Promise.all([
      requestRefund(),
      requestRefund(),
    ]);
    expect([first.status, replay.status]).toEqual([200, 200]);
    const requested = await first.json();
    expect(requested.refund).toMatchObject({
      state: "processing",
      amountCents: 3500,
    });
    expect((await replay.json()).refund.id).toBe(requested.refund.id);
    expect(
      await (await call("/paid/sources", alice)).json(),
    ).not.toContainEqual(expect.objectContaining({ orderId: input.orderId }));
    expect(
      await (await call(`${path}/refund/verify`, alice, {})).json(),
    ).toMatchObject({
      state: "refunded",
      refund: { id: requested.refund.id, state: "confirmed" },
    });
    expect(refundCallbackStatuses).toEqual([401, 409]);
    expect(confirmedResult).toBeDefined();
    const replies = await Promise.all([
      call(refundCallback, undefined, confirmedResult, true),
      call(refundCallback, undefined, confirmedResult, true),
    ]);
    expect(replies.map(({ status }) => status)).toEqual([200, 200]);
    expect((await (await requestRefund()).json()).refund.id).toBe(
      requested.refund.id,
    );
  } finally {
    api = previous;
    await checkoutFixture.stop(true);
  }
});

async function verifiedPack(channel: CreditPackChannel = "wechat") {
  await approvePaths();
  const subject = crypto.randomUUID();
  fixtureSubjects.add(subject);
  const [{ id: accountId }] = await database
    .insert(testCreditAccounts)
    .values({ issuer, subject })
    .returning();
  accountIds.push(accountId);
  const isAlipay = channel === "alipay";
  const suffix = isAlipay ? "/alipay" : "";
  const offer = `/paid/credit-pack${suffix}`;
  const orderList = `${offer}/orders`;
  const channelAuth = isAlipay ? alipayToken : token;
  const paymentCallback = `/credit-pack-test${suffix}/callback`;
  const refundCallback = `/credit-pack-test${suffix}/refund-callback`;
  api = mount(
    fixture.url.origin,
    [accountId],
    isAlipay ? alipayFixture.url.origin : undefined,
  );
  const { product } = await (await call(offer, subject)).json();
  const orderId = crypto.randomUUID();
  const path = `${orderList}/${orderId}`;
  expect(
    (await call(orderList, subject, { orderId, version: product.version }))
      .status,
  ).toBe(201);
  const payment = {
    orderId,
    state: "paid",
    merchantId: "fixture-merchant",
    currency: "CNY",
    amountCents: product.priceCents,
    channelOrderRef: crypto.randomUUID(),
    paidAt: new Date().toISOString(),
  };
  expect(
    (await call(paymentCallback, undefined, payment, channelAuth)).status,
  ).toBe(200);
  return {
    accountId,
    orderId,
    subject,
    refundResult: (result: object) =>
      call(refundCallback, undefined, result, channelAuth),
    refund: (body = {}) => call(`${path}/refund`, subject, body),
    verifyRefund: () => call(`${path}/refund/verify`, subject, {}),
    status: async () => (await (await call(orderList, subject)).json())[0],
    balance: async () => (await call("/paid/balance", subject)).json(),
  };
}

async function installFixtureCatalog(route: string, maxInputTokens: number) {
  const harnessImage = `agent-langgraph-agui@sha256:${"a".repeat(64)}`;
  const draft = configure(emptyCatalog, {
    harnessImage,
    routes: {
      [route]: {
        provider: "refund-fixture",
        model: "refund-fixture",
        gatewayRevision: "refund-fixture-v1",
        meteringRevision: "refund-fixture-v1",
        maxInputTokens,
        maxOutputTokens: 2,
        tools: false,
        price: { inputPerMillion: 1_000_000, outputPerMillion: 0 },
      },
    },
  });
  const catalog = publishCatalog(
    verify(
      draft,
      route,
      fixtureTraceReport(harnessImage, draft.routes[route]),
      "test",
    ),
    [route],
    route,
    "test",
  ).catalog;
  const [previous] = await database
    .select()
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, pilotCatalogKey));
  const install = (value: unknown) => {
    const json = sql`${JSON.stringify(value)}::text::jsonb`;
    return database
      .insert(enterpriseSettings)
      .values({ key: pilotCatalogKey, value: json })
      .onConflictDoUpdate({
        target: enterpriseSettings.key,
        set: { value: json },
      });
  };
  await install(catalog);
  return async () => {
    if (previous) await install(previous.value);
    else
      await database
        .delete(enterpriseSettings)
        .where(eq(enterpriseSettings.key, pilotCatalogKey));
  };
}

test("a concurrent reservation and refund can never both claim the same source", async () => {
  const pack = await verifiedPack();
  const route = "checkout-refund-race";
  const restoreCatalog = await installFixtureCatalog(route, 10);
  try {
    const operationId = crypto.randomUUID();
    const quote = await ledger.quote();
    expect(quote?.priceVersion).toBeDefined();
    const reserve = (id: string) =>
      call("/v1/reserve", pack.subject, {
        operationId: id,
        route,
        priceVersion: quote?.priceVersion,
        creditType: "paid",
        resumable: false,
      });
    const [reservation, request] = await Promise.all([
      reserve(operationId),
      pack.refund(),
    ]);
    expect(reservation.status).toBe(200);
    const hold = await reservation.json();
    if (hold.state === "reserved") {
      expect(request.status).toBe(409);
      expect(await request.json()).toMatchObject({ code: "refund_held" });
      expect((await pack.status()).refund).toBeNull();
      expect(
        await ledger.beginDispatch(
          { issuer, subject: pack.subject },
          {
            operationId,
            permit: hold.permit,
          },
        ),
      ).toMatchObject({ state: "dispatch" });
      await ledger.releaseUnsent(pack.accountId, operationId);
      expect((await pack.refund()).status).toBe(200);
    } else {
      expect(hold).toMatchObject({ reason: "insufficient_credits" });
      expect(request.status).toBe(200);
    }
    expect(await pack.status()).toMatchObject({
      creditsFrozen: true,
      state: "refund_pending",
      refund: { state: "processing" },
    });
    expect(await pack.balance()).toMatchObject({
      availableMicrocredits: "0",
      reservedMicrocredits: "0",
    });
    expect(await (await reserve(crypto.randomUUID())).json()).toMatchObject({
      reason: "insufficient_credits",
    });
  } finally {
    await restoreCatalog();
  }
});

for (const channel of ["wechat", "alipay"] as const) {
  test(`${channel}: uncertainty keeps the refund frozen until definitive failure`, () =>
    expectUncertainRefund(channel));
  test(`${channel}: owed funds keep the original refund frozen until operator confirmation`, () =>
    expectManualRefund(channel));
}

async function expectUncertainRefund(channel: CreditPackChannel) {
  const pack = await verifiedPack(channel);
  // Freeze commits before the loopback channel is contacted.
  refundUnavailable = true;
  try {
    expect((await pack.refund()).status).toBe(503);
  } finally {
    refundUnavailable = false;
  }
  const pending = (await pack.status()).refund;
  expect(pending.state).toBe("requested");
  expect(await pack.balance()).toMatchObject({ availableMicrocredits: "0" });
  expect(await (await pack.verifyRefund()).json()).toMatchObject({
    refund: { id: pending.id, state: "processing" },
  });
  const terms = refundStarts.get(pending.id);
  expect(terms).toBeDefined();
  expect(await (await pack.verifyRefund()).json()).toMatchObject({
    state: "refund_pending",
    creditsFrozen: true,
    refund: { id: pending.id, state: "processing" },
  });
  expect((await pack.refundResult({ ...terms, state: "failed" })).status).toBe(
    200,
  );
  expect(
    (await pack.refundResult({ ...terms, state: "processing" })).status,
  ).toBe(200);
  expect(await (await pack.refund()).json()).toMatchObject({
    state: "verified",
    refund: { id: pending.id, state: "failed" },
  });
  expect(await pack.balance()).toMatchObject({
    availableMicrocredits: "35000000",
  });
}

async function expectManualRefund(channel: CreditPackChannel) {
  const pack = await verifiedPack(channel);
  const { refund } = await (await pack.refund()).json();
  const terms = refundStarts.get(refund.id);
  expect(
    (await pack.refundResult({ ...terms, state: "manual_owed" })).status,
  ).toBe(200);
  expect((await pack.refundResult({ ...terms, state: "failed" })).status).toBe(
    200,
  );
  expect(await (await pack.refund()).json()).toMatchObject({
    id: pack.orderId,
    state: "refund_pending",
    refund: { id: refund.id, amountCents: 3500, state: "manual_owed" },
  });
  expect(await pack.balance()).toMatchObject({ availableMicrocredits: "0" });
  expect((await paid.confirmRefund(pack.orderId, false)).state).toBe(
    "manual_owed",
  );
  expect((await paid.confirmRefund(pack.orderId, true)).state).toBe(
    "manual_owed",
  );
  const confirmReturned = (cents: string) =>
    runBillingPaths(
      ["confirm-test-refund", pack.orderId, "--returned-cents", cents],
      { credit: ledger, paid },
    );
  await expect(confirmReturned("3499")).rejects.toHaveProperty(
    "code",
    "verification_mismatch",
  );
  expect(await pack.balance()).toMatchObject({ availableMicrocredits: "0" });
  await confirmReturned("3500");
  await confirmReturned("3500");
  expect(await pack.status()).toMatchObject({
    state: "refunded",
    refund: { id: refund.id, amountCents: 3500, state: "confirmed" },
  });
  expect(await pack.balance()).toMatchObject({ availableMicrocredits: "0" });
}

test("used credits and a customer partial refund request go to review without an automatic payout", async () => {
  const used = await verifiedPack();
  const operationId = crypto.randomUUID();
  expect(
    await paid.allocate({
      accountId: used.accountId,
      operationId,
      amountMicrocredits: 1_000_000n,
    }),
  ).toMatchObject({ state: "allocated" });
  await paid.settleAllocation({
    accountId: used.accountId,
    operationId,
    chargeMicrocredits: 1_000_000n,
  });
  const { refund: usedRefund } = await (await used.refund()).json();
  expect(usedRefund).toMatchObject({
    amountCents: 3500,
    state: "manual_review",
  });
  expect(refundStarts.has(usedRefund.id)).toBe(false);
  expect(await used.balance()).toMatchObject({
    availableMicrocredits: "34000000",
  });

  const partial = await verifiedPack();
  const { refund: partialRefund } = await (
    await partial.refund({ amountCents: 500 })
  ).json();
  expect(partialRefund).toMatchObject({
    amountCents: 500,
    state: "manual_review",
  });
  expect(await partial.status()).toMatchObject({ refund: partialRefund });
  expect(refundStarts.has(partialRefund.id)).toBe(false);
  expect(await partial.balance()).toMatchObject({
    availableMicrocredits: "35000000",
  });
});

for (const state of ["disputed", "partial"]) {
  test(`a channel ${state} result keeps a frozen refund in manual review`, async () => {
    const pack = await verifiedPack();
    const { refund } = await (await pack.refund()).json();
    const terms = refundStarts.get(refund.id);
    expect(
      (
        await call(
          refundCallback,
          undefined,
          {
            ...terms,
            state,
            ...(state === "partial" ? { returnedCents: 500 } : {}),
          },
          true,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          refundCallback,
          undefined,
          { ...terms, state: "processing" },
          true,
        )
      ).status,
    ).toBe(200);
    expect(await (await pack.verifyRefund()).json()).toMatchObject({
      state: "refund_pending",
      refund: { id: refund.id, amountCents: 3500, state: "manual_review" },
    });
    expect(await pack.balance()).toMatchObject({ availableMicrocredits: "0" });
    if (state === "disputed") {
      const ops = (action: string) =>
        runBillingPaths(
          [
            "dispute",
            action,
            pack.orderId,
            "--by",
            "support-fixture",
            "--reference",
            "refund-channel-case",
          ],
          { credit: ledger, paid },
        );
      expect(await pack.status()).toMatchObject({
        dispute: { id: refund.id, progress: "open" },
      });
      await ops("open");
      await ops("confirm-reversal");
      expect(await pack.status()).toMatchObject({
        dispute: {
          id: refund.id,
          progress: "reversed",
          usedMicrocredits: "0",
          manualReviewCents: null,
        },
      });
    }
  });
}

test("support reverses a fixture order and the statement preserves its dispatched usage", async () => {
  const pack = await verifiedPack();
  const route = "checkout-payment-dispute";
  const restoreCatalog = await installFixtureCatalog(route, 500_000);
  const identity = { issuer, subject: pack.subject };
  const quote = await ledger.quote();
  const reserve = async (operationId: string) =>
    (
      await call("/v1/reserve", pack.subject, {
        operationId,
        route,
        priceVersion: quote?.priceVersion,
        creditType: "paid",
        resumable: false,
      })
    ).json();
  const dispatch = async (operationId: string, permit: string) =>
    ledger.beginDispatch(identity, { operationId, permit });
  const bill = async () => (await call("/paid/bill", pack.subject)).json();
  const ops = async (action: string, reference?: string) => {
    const command = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "server/scripts/billing-paths.ts",
        "dispute",
        action,
        pack.orderId,
        ...(reference
          ? ["--by", "support-fixture", "--reference", reference]
          : []),
      ],
      {
        env: { PATH: process.env.PATH, DATABASE_URL: testDatabaseUrl() },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
      command.exited,
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    return JSON.parse(stdout);
  };
  try {
    const first = crypto.randomUUID();
    expect(await dispatch(first, (await reserve(first)).permit)).toMatchObject({
      state: "dispatch",
    });
    await ledger.settle(pack.accountId, first, {
      inputTokens: 100_000n,
      outputTokens: 0n,
    });
    const alreadyDispatched = crypto.randomUUID();
    expect(
      await dispatch(
        alreadyDispatched,
        (await reserve(alreadyDispatched)).permit,
      ),
    ).toMatchObject({ state: "dispatch" });
    const unsent = crypto.randomUUID();
    const unsentHold = await reserve(unsent);
    expect(unsentHold).toMatchObject({ state: "reserved" });

    const opened = await ops("open", "channel-case-104");
    expect(await ops("open", "channel-case-104")).toEqual(opened);
    const [storedDispute] = await database
      .select({
        shape: sql<string>`jsonb_typeof(${paidRefunds.dispute})`,
        reference: sql<string>`${paidRefunds.dispute}->'opened'->>'reference'`,
      })
      .from(paidRefunds)
      .where(eq(paidRefunds.orderId, pack.orderId));
    expect(storedDispute).toEqual({
      shape: "object",
      reference: "channel-case-104",
    });
    expect(await pack.status()).toMatchObject({
      creditsFrozen: true,
      dispute: { id: opened.id, progress: "open", usedMicrocredits: "100000" },
    });
    expect(await reserve(crypto.randomUUID())).toMatchObject({
      reason: "insufficient_credits",
    });
    expect(await dispatch(unsent, unsentHold.permit)).toMatchObject({
      reason: "insufficient_credits",
    });

    const { product } = await (
      await call("/paid/credit-pack", pack.subject)
    ).json();
    const otherOrder = crypto.randomUUID();
    expect(
      (
        await call(orders, pack.subject, {
          orderId: otherOrder,
          version: product.version,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(
          callback,
          undefined,
          {
            orderId: otherOrder,
            state: "paid",
            merchantId: "fixture-merchant",
            currency: "CNY",
            amountCents: product.priceCents,
            channelOrderRef: crypto.randomUUID(),
            paidAt: new Date().toISOString(),
          },
          true,
        )
      ).status,
    ).toBe(200);
    const fromOther = crypto.randomUUID();
    expect(
      await dispatch(fromOther, (await reserve(fromOther)).permit),
    ).toMatchObject({ state: "dispatch" });
    await ledger.settle(pack.accountId, fromOther, {
      inputTokens: 50_000n,
      outputTokens: 0n,
    });

    const reversed = await ops("confirm-reversal", "channel-reversal-104");
    expect(reversed.id).toBe(opened.id);
    const disputedOrder = async () =>
      (await (await call(orders, pack.subject)).json()).find(
        ({ id }: { id: string }) => id === pack.orderId,
      );
    expect(await disputedOrder()).toMatchObject({
      creditsFrozen: false,
      dispute: { progress: "awaiting_settlement" },
    });
    await expect(ops("reconcile", "finance-journal-104")).rejects.toThrow(
      "settle",
    );
    await ledger.settle(pack.accountId, alreadyDispatched, {
      inputTokens: 200_000n,
      outputTokens: 0n,
    });
    expect(await disputedOrder()).toMatchObject({
      dispute: {
        id: opened.id,
        progress: "manual_reconciliation",
        usedMicrocredits: "300000",
        revokedMicrocredits: "34700000",
        manualReviewCents: 30,
      },
    });
    const reconciled = await ops("reconcile", "finance-journal-104");
    expect(reconciled).toMatchObject({
      id: opened.id,
      dispute: {
        reconciliation: {
          by: "support-fixture",
          reference: "finance-journal-104",
        },
      },
    });
    expect(await ops("reconcile", "finance-journal-104")).toEqual(reconciled);
    expect(await ops("status")).toMatchObject({
      payment: {
        orderId: pack.orderId,
        channel: "wechat",
        channelOrderRef: expect.stringMatching(/^fixture:fixture-merchant:/),
      },
      progress: {
        id: opened.id,
        progress: "reconciled",
        manualReviewCents: 30,
      },
      evidence: {
        opened: { reference: "channel-case-104" },
        reversal: { reference: "channel-reversal-104" },
        reconciliation: { reference: "finance-journal-104" },
      },
    });
    expect((await ops("confirm-reversal", "channel-reversal-104")).id).toBe(
      opened.id,
    );
    expect(refundStarts.has(opened.id)).toBe(false);
    expect(await pack.balance()).toMatchObject({
      availableMicrocredits: "34950000",
      reservedMicrocredits: "0",
      chargedMicrocredits: "350000",
    });
    expect(await bill()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: first,
          orderId: pack.orderId,
          amountMicrocredits: "100000",
        }),
        expect.objectContaining({
          operationId: alreadyDispatched,
          orderId: pack.orderId,
          amountMicrocredits: "200000",
        }),
        expect.objectContaining({
          operationId: fromOther,
          orderId: otherOrder,
          amountMicrocredits: "50000",
        }),
        expect.objectContaining({
          source: "dispute",
          orderId: pack.orderId,
          dispute: expect.objectContaining({
            id: opened.id,
            progress: "reconciled",
            usedMicrocredits: "300000",
            revokedMicrocredits: "34700000",
            manualReviewCents: 30,
          }),
        }),
      ]),
    );
    expect(await (await call("/paid/bill", bob)).json()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderId: pack.orderId }),
      ]),
    );
  } finally {
    await restoreCatalog();
  }
}, 90_000);

test("Alipay checkout reconciles missed callbacks and refunds only through the original channel", async () => {
  await approvePaths();
  const previous = api;
  const prefix = "/paid/credit-pack/alipay";
  const alipayCallback = "/credit-pack-test/alipay/callback";
  const alipayRefund = "/credit-pack-test/alipay/refund-callback";
  let payment: object | undefined;
  let refund: CreditPackTestRefundResult | undefined;
  const checkoutFixture = startCreditPackFixture({
    port: 0,
    token: alipayToken,
    channel: "alipay",
    notify: async (result) => {
      payment = result;
      return new Response(null, { status: 503 });
    },
    notifyRefund: async (result) => {
      refund = result;
      return new Response(null, { status: 503 });
    },
  });
  api = mount(fixture.url.origin, [accountIds[0]], checkoutFixture.url.origin);
  try {
    const offer = await call(prefix, alice);
    expect(offer.status).toBe(200);
    expect((await call(prefix, outsider)).status).toBe(404);
    const { product } = await offer.json();
    const input = { orderId: crypto.randomUUID(), version: product.version };
    const orderPath = `${prefix}/orders/${input.orderId}`;
    const balance = async () =>
      (await (await call("/paid/balance", alice)).json()).availableMicrocredits;
    const before = BigInt(await balance());
    expect((await call(`${prefix}/orders`, alice, input)).status).toBe(201);
    expect((await call(orders, alice, input)).status).toBe(409);
    expect(await (await call(orders, alice)).json()).not.toContainEqual(
      expect.objectContaining({ id: input.orderId }),
    );
    expect(
      (await call(`${orders}/${input.orderId}/checkout`, alice, {})).status,
    ).toBe(404);
    const { checkoutUrl } = await (
      await call(`${orderPath}/checkout`, alice, {})
    ).json();
    expect(await (await fetch(checkoutUrl)).text()).toContain(
      "Alipay test checkout",
    );
    expect(
      await (await call(`${orderPath}/verify`, alice, {})).json(),
    ).toMatchObject({ state: "pending" });
    const failed = {
      ...input,
      state: "failed",
      merchantId: "fixture-merchant",
      currency: "CNY",
      amountCents: product.priceCents,
    };
    expect((await call(callback, undefined, failed, true)).status).toBe(409);
    expect(
      (
        await call(
          alipayCallback,
          undefined,
          { ...failed, amountCents: 1 },
          alipayToken,
        )
      ).status,
    ).toBe(409);
    expect(
      (await call(alipayCallback, undefined, failed, alipayToken)).status,
    ).toBe(200);
    expect(
      await (await call(`${orderPath}/verify`, alice, {})).json(),
    ).toMatchObject({ state: "failed" });
    expect(
      await (await fetch(checkoutUrl, { method: "POST" })).text(),
    ).toContain("Check payment");
    expect(payment).toBeDefined();
    expect((await call(alipayCallback, undefined, payment, true)).status).toBe(
      401,
    );
    expect((await call(callback, undefined, payment, true)).status).toBe(409);
    for (const [fields, status] of [
      [{ merchantId: "fixture-wrong" }, 409],
      [{ amountCents: 1 }, 409],
      [{ currency: "USD" }, 409],
      [{ orderId: crypto.randomUUID() }, 404],
    ] satisfies [object, number][]) {
      expect(
        (
          await call(
            alipayCallback,
            undefined,
            { ...payment, ...fields },
            alipayToken,
          )
        ).status,
      ).toBe(status);
    }
    expect(await balance()).toBe(before.toString());
    expect(
      await (await call(`${orderPath}/verify`, alice, {})).json(),
    ).toMatchObject({ state: "verified" });
    expect(
      (await call(alipayCallback, undefined, payment, alipayToken)).status,
    ).toBe(200);
    expect(
      (await call(alipayCallback, undefined, failed, alipayToken)).status,
    ).toBe(200);
    expect(await balance()).toBe(
      (before + BigInt(product.creditsMicrocredits)).toString(),
    );
    expect(
      (await call(`${orders}/${input.orderId}/refund`, alice, {})).status,
    ).toBe(404);
    const requested = await (
      await call(`${orderPath}/refund`, alice, {})
    ).json();
    expect(requested).toMatchObject({
      state: "refund_pending",
      creditsFrozen: true,
      refund: { state: "processing" },
    });
    expect(await balance()).toBe(before.toString());
    // The fixture has settled funds, but its callback has not reached the ledger.
    const funds = await fetch(
      new URL(`/refunds/${requested.refund.id}`, checkoutFixture.url),
      {
        headers: { authorization: `Bearer ${alipayToken}` },
      },
    );
    expect(await funds.json()).toMatchObject({
      state: "confirmed",
      amountCents: product.priceCents,
    });
    expect(refund).toBeDefined();
    expect((await call(refundCallback, undefined, refund, true)).status).toBe(
      409,
    );
    expect((await call(alipayRefund, undefined, refund, true)).status).toBe(
      401,
    );
    for (const [fields, status] of [
      [{ amountCents: 1 }, 409],
      [{ currency: "USD" }, 400],
      [{ merchantId: "fixture-wrong" }, 409],
      [{ orderId: crypto.randomUUID() }, 404],
      [{ refundId: crypto.randomUUID() }, 409],
      [{ channelOrderRef: "wrong-reference" }, 409],
    ] satisfies [object, number][]) {
      expect(
        (
          await call(
            alipayRefund,
            undefined,
            { ...refund, ...fields },
            alipayToken,
          )
        ).status,
      ).toBe(status);
    }
    expect(await (await call(`${prefix}/orders`, alice)).json()).toContainEqual(
      expect.objectContaining({
        id: input.orderId,
        state: "refund_pending",
        creditsFrozen: true,
        refund: expect.objectContaining({
          id: requested.refund.id,
          state: "processing",
        }),
      }),
    );
    expect(
      await (await call(`${orderPath}/refund/verify`, alice, {})).json(),
    ).toMatchObject({
      state: "refunded",
      creditsFrozen: false,
      refund: { id: requested.refund.id, state: "confirmed" },
    });
    expect(
      (await call(alipayRefund, undefined, refund, alipayToken)).status,
    ).toBe(200);
    expect(
      (
        await call(
          alipayRefund,
          undefined,
          { ...refund, state: "processing" },
          alipayToken,
        )
      ).status,
    ).toBe(200);
    expect(
      (await call(alipayCallback, undefined, payment, alipayToken)).status,
    ).toBe(200);
    expect(
      await (await call(`${orderPath}/refund/verify`, alice, {})).json(),
    ).toMatchObject({
      state: "refunded",
      refund: { id: requested.refund.id, state: "confirmed" },
    });
    expect(await balance()).toBe(before.toString());
  } finally {
    api = previous;
    await checkoutFixture.stop(true);
  }
});

const monthly = "fixture-monthly";
const plus = "fixture-monthly-plus";
const plans = "/paid/subscription";

test("a customer can renew a Beijing month, replace a future plan after refund, and restart after a gap", async () => {
  await approvePaths();
  const previous = api;
  const route = "subscription-cross-period";
  const restoreCatalog = await installFixtureCatalog(route, 150);
  const boundary = new Date("2027-02-27T16:00:00Z");
  api = mount(fixture.url.origin, undefined, undefined, async () => {
    time = boundary;
    return {
      text: "completed after renewal",
      usage: { inputTokens: 145, outputTokens: 0 },
    };
  });
  const publishPlan = (
    productCode: string,
    priceCents: number,
    credits: bigint,
  ) =>
    paid.upsertProduct({
      code: productCode,
      kind: "subscription",
      priceCents,
      creditsMicrocredits: credits,
    });
  const basic = await publishPlan(monthly, 1000, 100n);
  const upgrade = await publishPlan(plus, 2000, 200n);
  const view = async () => {
    const response = await call(plans, subscriber);
    expect(response.status).toBe(200);
    return response.json();
  };
  const place = async (product = basic, path = plans) => {
    const id = crypto.randomUUID();
    const response = await call(`${path}/orders`, subscriber, {
      orderId: id,
      ...(path === plans ? { productCode: product.code } : {}),
      version: product.version,
    });
    expect(response.status).toBe(201);
    expect(
      (await call(`${path}/orders/${id}/checkout`, subscriber, {})).status,
    ).toBe(200);
    expect(starts.get(id)).toMatchObject({ amountCents: product.priceCents });
    payments.set(id, {
      orderId: id,
      state: "paid",
      merchantId: "fixture-merchant",
      currency: "CNY",
      channelOrderRef: crypto.randomUUID(),
      amountCents: product.priceCents,
      paidAt: clock().toISOString(),
    });
    return id;
  };
  const verify = async (id: string, path = plans) => {
    const response = await call(`${path}/orders/${id}/verify`, subscriber, {});
    expect(response.status).toBe(200);
    return response.json();
  };
  try {
    time = new Date("2027-01-30T20:00:00Z"); // Jan 31 in Beijing
    expect((await call(plans, outsider)).status).toBe(404);
    expect(await view()).toMatchObject({
      products: expect.arrayContaining([
        {
          code: monthly,
          version: basic.version,
          priceCents: 1000,
          creditsMicrocredits: "100",
          currency: "CNY",
        },
      ]),
      current: null,
      next: null,
    });
    const first = await place();
    expect(await verify(first)).toMatchObject({ state: "verified" });
    expect(await view()).toMatchObject({
      current: {
        id: first,
        anchorDay: 31,
        periodEnd: "2027-02-27T16:00:00.000Z",
      },
    });

    time = new Date("2027-02-14T20:00:00Z");
    const renewals = [await place(upgrade), await place(upgrade)];
    await publishPlan(plus, 3000, 300n);
    const verified = await Promise.all(renewals.map((id) => verify(id)));
    expect(verified.map(({ state }) => state).sort()).toEqual([
      "refund_pending",
      "verified",
    ]);
    const winner = verified.find(({ state }) => state === "verified").id;
    expect(await view()).toMatchObject({
      current: { id: first, creditsMicrocredits: "100", priceCents: 1000 },
      next: {
        id: winner,
        creditsMicrocredits: "200",
        priceCents: 2000,
        periodStart: "2027-02-27T16:00:00.000Z",
        periodEnd: "2027-03-30T16:00:00.000Z",
      },
    });
    const replacement = () =>
      call(`${plans}/orders`, subscriber, {
        orderId: crypto.randomUUID(),
        productCode: monthly,
        version: basic.version,
      });
    expect((await replacement()).status).toBe(409);
    expect(
      (await call(`${plans}/orders/${first}/refund`, subscriber, {})).status,
    ).toBe(409);
    const refund = await call(
      `${plans}/orders/${winner}/refund`,
      subscriber,
      {},
    );
    expect(refund.status).toBe(200);
    const {
      refund: { id: refundId },
    } = await refund.json();
    const terms = refundStarts.get(refundId);
    expect(terms?.amountCents).toBe(2000);
    expect((await replacement()).status).toBe(409);
    expect(
      (
        await call(
          refundCallback,
          undefined,
          { ...terms, state: "confirmed", returnedCents: 2000 },
          true,
        )
      ).status,
    ).toBe(200);
    const next = await place();
    expect(await verify(next)).toMatchObject({ state: "verified" });

    const pack = await publish(500, 50n);
    const packPath = "/paid/credit-pack";
    const purchasePack = async () => {
      const id = await place(pack, packPath);
      expect(await verify(id, packPath)).toMatchObject({ state: "verified" });
      return id;
    };
    const packA = await purchasePack();
    expect(
      await (await call(`${plans}/orders`, subscriber)).json(),
    ).not.toContainEqual(expect.objectContaining({ id: packA }));
    expect(await (await call(orders, subscriber)).json()).not.toContainEqual(
      expect.objectContaining({ id: first }),
    );
    expect(
      (await call(`${plans}/orders/${packA}/refund`, subscriber, {})).status,
    ).toBe(404);
    expect(
      (await call(`${orders}/${next}/refund`, subscriber, {})).status,
    ).toBe(404);
    time = new Date("2027-02-15T20:01:00Z");
    const packB = await purchasePack();
    const currentOrder = await verify(first);
    const firstPackOrder = await verify(packA, packPath);
    const secondPackOrder = await verify(packB, packPath);
    const accountId = await ledger.accountOf({ issuer, subject: subscriber });
    if (!accountId) throw new Error("Missing subscriber account");
    const reserve = (operationId: string, amountMicrocredits: bigint) =>
      paid.allocate({ accountId, operationId, amountMicrocredits });
    const released = crypto.randomUUID();
    const settled = crypto.randomUUID();
    expect(await reserve(released, 15n)).toMatchObject({ state: "allocated" });
    time = new Date(boundary.getTime() - 1_000);
    const quote = await ledger.quote();
    const hold = await (
      await call("/v1/reserve", subscriber, {
        operationId: settled,
        route,
        priceVersion: quote?.priceVersion,
        creditType: "paid",
        resumable: false,
      })
    ).json();
    expect(hold).toMatchObject({ state: "reserved" });
    const dispatch = await call("/v1/dispatch", subscriber, {
      operationId: settled,
      permit: hold.permit,
      messages: [{ role: "user", content: "Finish after renewal" }],
    });
    expect(await dispatch.json()).toMatchObject({
      state: "completed",
      operation: { chargedMicrocredits: "145" },
    });
    expect(await view()).toMatchObject({
      current: { id: next, anchorDay: 31 },
      next: null,
    });
    await paid.releaseAllocation(accountId, released);
    expect(await (await call("/paid/bill", subscriber)).json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: settled,
          source: "subscription",
          entitlementId: currentOrder.entitlementId,
          amountMicrocredits: "85",
          periodStart: "2027-01-30T20:00:00.000Z",
          periodEnd: "2027-02-27T16:00:00.000Z",
          arrivedAt: "2027-01-30T20:00:00.000Z",
          at: boundary.toISOString(),
        }),
        expect.objectContaining({
          operationId: settled,
          source: "credit_pack",
          entitlementId: firstPackOrder.entitlementId,
          amountMicrocredits: "50",
        }),
        expect.objectContaining({
          operationId: settled,
          source: "credit_pack",
          entitlementId: secondPackOrder.entitlementId,
          amountMicrocredits: "10",
        }),
      ]),
    );
    expect(
      await (await call("/paid/balance", subscriber)).json(),
    ).toMatchObject({ availableMicrocredits: "140" });
    expect(await reserve(crypto.randomUUID(), 141n)).toMatchObject({
      state: "denied",
      reason: "insufficient_credits",
    });

    const newUpgrade = await publishPlan(plus, 3000, 300n);
    const following = await place(newUpgrade);
    expect(await verify(following)).toMatchObject({ state: "verified" });
    expect(await view()).toMatchObject({
      next: { id: following, periodEnd: "2027-04-29T16:00:00.000Z" },
    });

    time = new Date("2027-03-30T16:00:00Z");
    expect(await view()).toMatchObject({
      current: { id: following, creditsMicrocredits: "300", priceCents: 3000 },
      next: null,
    });

    time = new Date("2027-06-04T20:00:00Z");
    expect(await view()).toMatchObject({ current: null, next: null });
    const restarted = await place();
    expect(await verify(restarted)).toMatchObject({ state: "verified" });
    expect(await view()).toMatchObject({
      current: {
        id: restarted,
        anchorDay: 5,
        periodStart: time.toISOString(),
        periodEnd: "2027-07-04T16:00:00.000Z",
      },
    });
  } finally {
    time = undefined;
    api = previous;
    await restoreCatalog();
  }
});

test("switching a renewal queries and closes the old order, and late payment refunds through its original channel", async () => {
  await approvePaths();
  const previous = api;
  api = mount(fixture.url.origin, undefined, alipayFixture.url.origin);
  const alipayPlans = "/paid/subscription/alipay";
  const monthlyPlan = await paid.upsertProduct({
    code: monthly,
    kind: "subscription",
    priceCents: 1250,
    creditsMicrocredits: 100n,
  });
  const accountId = accountIds[4];
  const orderInput = (orderId: string) => ({
    orderId,
    productCode: monthlyPlan.code,
    version: monthlyPlan.version,
  });
  const payment = (id: string, at: Date) => ({
    orderId: id,
    merchantId: "fixture-merchant",
    currency: "CNY",
    amountCents: 1250,
    paidAt: at.toISOString(),
    channelOrderRef: id,
    state: "paid",
  });
  const placeWeChat = async () => {
    const id = crypto.randomUUID();
    expect(
      (await call(`${plans}/orders`, switcher, orderInput(id))).status,
    ).toBe(201);
    expect(
      (await call(`${plans}/orders/${id}/checkout`, switcher, {})).status,
    ).toBe(200);
    return id;
  };
  try {
    time = new Date("2027-04-12T10:00:00Z");
    const first = await placeWeChat();
    expect(
      (await call(callback, undefined, payment(first, time), true)).status,
    ).toBe(200);
    time = new Date("2027-04-15T10:00:00Z");
    const original = await placeWeChat();
    const replacement = crypto.randomUUID();
    const switchBody = { orderId: replacement };
    const switchPath = `${alipayPlans}/orders/switch/${original}`;
    expect((await call(switchPath, bob, switchBody)).status).toBe(404);
    closeResults.set(original, {
      orderId: original,
      merchantId: "fixture-merchant",
      currency: "CNY",
      amountCents: 1250,
      state: "failed",
    });
    const concurrentSwitch = await Promise.all([
      call(switchPath, switcher, switchBody),
      call(switchPath, switcher, { orderId: crypto.randomUUID() }),
    ]);
    expect(concurrentSwitch.map(({ status }) => status).sort()).toEqual([
      200, 201,
    ]);
    const choices = await Promise.all(
      concurrentSwitch.map((response) => response.json()),
    );
    expect(choices[0].id).toBe(choices[1].id);
    const switchedId = choices[0].id;
    expect((await call(switchPath, switcher, switchBody)).status).toBe(200);
    const oldChannelCalls = switchCalls.filter((entry) =>
      entry.endsWith(original),
    );
    expect(oldChannelCalls[0]).toBe(`query:${original}`);
    expect(oldChannelCalls).toContain(`close:${original}`);
    expect(
      (await call(`${alipayPlans}/orders/${switchedId}/checkout`, switcher, {}))
        .status,
    ).toBe(200);
    const replacementPayment = payment(switchedId, time);
    expect(
      (
        await call(
          "/credit-pack-test/alipay/callback",
          undefined,
          replacementPayment,
          alipayToken,
        )
      ).status,
    ).toBe(200);
    // A channel can report money after saying the order was closed, including
    // after the intended next period starts.
    time = new Date("2027-05-15T10:00:00Z");
    const late = payment(original, time);
    const accepted = await Promise.all([
      call(callback, undefined, late, true),
      call(callback, undefined, late, true),
      call(callback, undefined, closeResults.get(original), true),
    ]);
    expect(accepted.map(({ status }) => status)).toEqual([200, 200, 200]);
    expect(await paid.entitlements(accountId)).toHaveLength(2);
    const refunds = await paid.refunds(accountId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      orderId: original,
      amountCents: 1250,
      channel: "wechat",
      reason: "duplicate_future_period",
    });
    expect(refundStarts.get(refunds[0].id)).toMatchObject({
      orderId: original,
      amountCents: 1250,
    });
    const refundId = refunds[0].id;
    expect(await paid.requestRefund(original)).toMatchObject({
      id: refundId,
      state: "processing",
      reason: "duplicate_future_period",
    });

    const refundTerms = refundStarts.get(refundId);
    expect(refundChannels.get(refundId)).toBe(token);
    const confirmed = { ...refundTerms, state: "confirmed" };
    expect(
      (
        await call(
          "/credit-pack-test/alipay/refund-callback",
          undefined,
          confirmed,
          alipayToken,
        )
      ).status,
    ).toBe(409);
    for (const state of ["confirmed", "processing", "confirmed"]) {
      expect(
        (await call(refundCallback, undefined, { ...confirmed, state }, true))
          .status,
      ).toBe(200);
    }
    expect(await paid.refunds(accountId)).toEqual([
      expect.objectContaining({
        id: refundId,
        state: "confirmed",
        orderId: original,
        amountCents: 1250,
      }),
    ]);
    // The channel can decline to close. Both checkouts can then report
    // payment, even with repeated callbacks arriving concurrently.
    const openOriginal = await placeWeChat();
    const openReplacement = crypto.randomUUID();
    expect(
      (
        await call(`${alipayPlans}/orders/switch/${openOriginal}`, switcher, {
          orderId: openReplacement,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(
          `${alipayPlans}/orders/${openReplacement}/checkout`,
          switcher,
          {},
        )
      ).status,
    ).toBe(200);

    const suspendedOrder = await placeWeChat();
    const bothPaid = time;
    time = new Date(+bothPaid + 1000);
    await paid.suspendAccount(accountId, true);
    expect(
      (
        await call(
          `${alipayPlans}/orders`,
          switcher,
          orderInput(crypto.randomUUID()),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          `${alipayPlans}/orders/${openReplacement}/checkout`,
          switcher,
          {},
        )
      ).status,
    ).toBe(409);
    const concurrentPayments = await Promise.all([
      call(callback, undefined, payment(openOriginal, bothPaid), true),
      call(
        "/credit-pack-test/alipay/callback",
        undefined,
        payment(openReplacement, bothPaid),
        alipayToken,
      ),
      call(
        "/credit-pack-test/alipay/callback",
        undefined,
        payment(openReplacement, bothPaid),
        alipayToken,
      ),
    ]);
    expect(concurrentPayments.map(({ status }) => status)).toEqual([
      200, 200, 200,
    ]);
    expect(await paid.entitlements(accountId)).toHaveLength(3);
    const finalRefunds = (await paid.refunds(accountId)).filter(
      ({ id }) => id !== refundId,
    );
    expect(finalRefunds).toHaveLength(1);
    expect(finalRefunds[0]).toMatchObject({
      reason: "duplicate_future_period",
      amountCents: 1250,
    });
    const losingChannel = finalRefunds[0].channel;
    const losingTerms = refundStarts.get(finalRefunds[0].id);
    const losingToken = losingChannel === "alipay" ? alipayToken : token;
    expect(refundChannels.get(finalRefunds[0].id)).toBe(losingToken);
    expect(
      (
        await call(
          losingChannel === "alipay"
            ? "/credit-pack-test/alipay/refund-callback"
            : refundCallback,
          undefined,
          { ...losingTerms, state: "confirmed" },
          losingToken,
        )
      ).status,
    ).toBe(200);
    expect(
      (await paid.refunds(accountId)).every(
        ({ state }) => state === "confirmed",
      ),
    ).toBe(true);
    const suspendedPayment = payment(suspendedOrder, time);
    time = new Date(+time + 1000);
    await paid.suspendAccount(accountId, false);
    expect(
      (await call(callback, undefined, suspendedPayment, true)).status,
    ).toBe(200);
    const suspendedRefund = (await paid.refunds(accountId)).find(
      ({ orderId }) => orderId === suspendedOrder,
    );
    expect(suspendedRefund).toMatchObject({
      reason: "account_suspended",
      amountCents: 1250,
      channel: "wechat",
      state: "processing",
    });
    expect(await paid.entitlements(accountId)).toHaveLength(3);
  } finally {
    time = undefined;
    api = previous;
  }
});

test("a switch reconciles an already paid order and the runnable fixture closes a payable link", async () => {
  await approvePaths();
  const previous = api;
  const localWeChat = startCreditPackFixture({
    port: 0,
    token,
    notify: async () => new Response(null, { status: 503 }),
  });
  api = mount(localWeChat.url.origin, undefined, alipayFixture.url.origin);
  const alipayOrders = "/paid/credit-pack/alipay/orders";
  const { version } = await publish(2500, 25_000_000n);
  const prepare = async () => {
    const orderId = crypto.randomUUID();
    expect((await call(orders, switcher, { orderId, version })).status).toBe(
      201,
    );
    const checkout = await call(`${orders}/${orderId}/checkout`, switcher, {});
    expect(checkout.status).toBe(200);
    const { checkoutUrl } = await checkout.json();
    return { orderId, checkoutUrl };
  };
  const switchToAlipay = (orderId: string) =>
    call(`${alipayOrders}/switch/${orderId}`, switcher, {
      orderId: crypto.randomUUID(),
    });
  try {
    const alreadyPaid = await prepare();
    expect((await fetch(alreadyPaid.checkoutUrl, { method: "POST" })).ok).toBe(
      true,
    );
    expect((await switchToAlipay(alreadyPaid.orderId)).status).toBe(409);
    expect(await (await call(orders, switcher)).json()).toContainEqual(
      expect.objectContaining({ id: alreadyPaid.orderId, state: "verified" }),
    );
    const unpaid = await prepare();
    expect((await switchToAlipay(unpaid.orderId)).status).toBe(201);
    expect((await fetch(unpaid.checkoutUrl, { method: "POST" })).status).toBe(
      409,
    );
    expect(await (await call(orders, switcher)).json()).toContainEqual(
      expect.objectContaining({ id: unpaid.orderId, state: "failed" }),
    );
  } finally {
    await localWeChat.stop(true);
    api = previous;
  }
});

test("scoped pilot closure reconciles each order through its original channel", async () => {
  await approvePaths();
  const subject = crypto.randomUUID();
  fixtureSubjects.add(subject);
  const [{ id: accountId }] = await database
    .insert(testCreditAccounts)
    .values({ issuer, subject })
    .returning();
  accountIds.push(accountId);
  const [unaffected] = accountIds;
  const route = "checkout-pilot-closure";
  const restoreCatalog = await installFixtureCatalog(route, 10);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  api = mount(
    fixture.url.origin,
    [accountId, unaffected],
    alipayFixture.url.origin,
    async () => {
      entered.resolve();
      await finish.promise;
      return { text: "completed", usage: { inputTokens: 3, outputTokens: 0 } };
    },
  );
  const alipayOrders = "/paid/credit-pack/alipay/orders";
  async function place(path = orders, buyer = subject) {
    const { product } = await (
      await call(path.replace("/orders", ""), buyer)
    ).json();
    const orderId = crypto.randomUUID();
    expect(
      (await call(path, buyer, { orderId, version: product.version })).status,
    ).toBe(201);
    return {
      orderId,
      amountCents: product.priceCents,
      merchantId: "fixture-merchant",
      currency: "CNY",
    };
  }
  async function notify(
    order: Awaited<ReturnType<typeof place>>,
    date: Date,
    alipay = false,
  ) {
    const payment = {
      ...order,
      state: "paid",
      channelOrderRef: order.orderId,
      paidAt: date.toISOString(),
    };
    expect(
      (
        await call(
          alipay ? "/credit-pack-test/alipay/callback" : callback,
          undefined,
          payment,
          alipay ? alipayToken : token,
        )
      ).status,
    ).toBe(200);
  }
  async function operator(action: string) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "server/scripts/billing-paths.ts",
        "closure",
        action,
        "--account",
        accountId,
      ],
      {
        env: {
          DATABASE_URL: testDatabaseUrl(),
          OPENBOT_CREDIT_PACK_TEST_ORIGIN: fixture.url.origin,
          OPENBOT_CREDIT_PACK_TEST_TOKEN: token,
          OPENBOT_CREDIT_PACK_TEST_ACCOUNT_IDS: accountId,
          OPENBOT_CREDIT_PACK_TEST_PRODUCT: code,
          OPENBOT_CREDIT_PACK_TEST_APPLICATION_IDS: openbotApp,
          OPENBOT_CREDIT_PACK_TEST_MERCHANT: "fixture-merchant",
          OPENBOT_CREDIT_PACK_ALIPAY_TEST_ORIGIN: alipayFixture.url.origin,
          OPENBOT_CREDIT_PACK_ALIPAY_TEST_TOKEN: alipayToken,
          OPENBOT_CREDIT_PACK_ALIPAY_TEST_ACCOUNT_IDS: accountId,
          OPENBOT_CREDIT_PACK_ALIPAY_TEST_APPLICATION_IDS: openbotApp,
          OPENBOT_CREDIT_PACK_ALIPAY_TEST_MERCHANT: "fixture-merchant",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [status, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    return JSON.parse(stdout);
  }
  async function status(id: string, path = orders) {
    const rows = await (await call(path, subject)).json();
    return rows.find((row: { id: string }) => row.id === id);
  }
  let dispatched: Promise<Response> | undefined;
  try {
    const held = await place();
    const free = await place(alipayOrders);
    const lateBefore = await place();
    const exact = await place(alipayOrders);
    const after = await place();
    await notify(held, new Date(Date.now() - 120_000));
    await notify(free, new Date(Date.now() - 60_000), true);
    closeResults.set(lateBefore.orderId, { ...lateBefore, state: "failed" });
    const quote = await ledger.quote();
    const operationId = crypto.randomUUID();
    const reserve = async (id: string) =>
      (
        await call("/v1/reserve", subject, {
          operationId: id,
          route,
          priceVersion: quote?.priceVersion,
          creditType: "paid",
        })
      ).json();
    const queuedId = crypto.randomUUID();
    const queued = await reserve(queuedId);
    expect(queued.state).toBe("reserved");
    const hold = await reserve(operationId);
    expect(hold.state).toBe("reserved");
    dispatched = call("/v1/dispatch", subject, {
      operationId,
      permit: hold.permit,
      messages: [{ role: "user", content: "fixture" }],
    });
    await Promise.race([
      entered.promise,
      dispatched.then(async (response) => {
        throw new Error(
          `Dispatch did not enter executor: ${await response.clone().text()}`,
        );
      }),
    ]);
    const { cutoff } = await operator("stop");
    expect(cutoff).toBeString();
    expect(
      await (await call("/paid/credit-pack", subject)).json(),
    ).toMatchObject({ available: false });
    expect(await reserve(crypto.randomUUID())).toMatchObject({
      reason: "pilot_closed",
    });
    const queuedResult = await call("/v1/dispatch", subject, {
      operationId: queuedId,
      permit: queued.permit,
      messages: [{ role: "user", content: "never sent" }],
    });
    expect(await queuedResult.json()).toMatchObject({
      state: "existing",
      operation: { state: "released" },
    });
    await place(orders, alice);
    for (const order of [lateBefore, exact, after]) {
      expect(switchCalls).toContain(`query:${order.orderId}`);
      expect(switchCalls).toContain(`close:${order.orderId}`);
    }
    expect(await status(lateBefore.orderId)).toMatchObject({ state: "failed" });
    expect(await status(after.orderId)).toMatchObject({ state: "pending" });
    expect(await status(held.orderId)).toMatchObject({
      refund: { state: "awaiting_settlement" },
    });
    const freeOrder = await status(free.orderId, alipayOrders);
    expect(freeOrder).toMatchObject({
      refund: { state: "processing" },
      creditsFrozen: true,
    });
    expect(refundChannels.get(freeOrder.refund.id)).toBe(alipayToken);

    const repeated = await operator("stop");
    expect(repeated.cutoff).toBe(cutoff);
    expect(repeated.pendingOrders).toContain(after.orderId);
    expect(
      switchCalls.filter((event) => event === `query:${after.orderId}`),
    ).toHaveLength(2);
    const boundary = new Date(cutoff).getTime();
    await notify(lateBefore, new Date(boundary - 1));
    await notify(exact, new Date(boundary), true);
    payments.set(after.orderId, {
      ...after,
      state: "paid",
      channelOrderRef: after.orderId,
      paidAt: new Date(boundary + 1).toISOString(),
    });
    await operator("reconcile");
    await notify(after, new Date(boundary + 1));
    const beforeOrder = await status(lateBefore.orderId);
    expect(beforeOrder).toMatchObject({
      entitlementId: expect.any(String),
      refund: { state: "processing" },
    });
    for (const [order, path, credential] of [
      [exact, alipayOrders, alipayToken],
      [after, orders, token],
    ] as const) {
      const view = await status(order.orderId, path);
      expect(view).toMatchObject({
        entitlementId: null,
        refund: { state: "processing", amountCents: order.amountCents },
      });
      expect(refundChannels.get(view.refund.id)).toBe(credential);
    }
    const exactTerms = refundStarts.get(
      (await status(exact.orderId, alipayOrders)).refund.id,
    );
    expect(
      (
        await call(
          "/credit-pack-test/alipay/refund-callback",
          undefined,
          {
            ...exactTerms,
            state: "failed",
          },
          alipayToken,
        )
      ).status,
    ).toBe(200);
    expect(await status(exact.orderId, alipayOrders)).toMatchObject({
      state: "refund_pending",
      entitlementId: null,
      refund: { state: "manual_owed" },
    });
    const freeTerms = refundStarts.get(freeOrder.refund.id);
    expect(
      (
        await call(
          "/credit-pack-test/alipay/refund-callback",
          undefined,
          { ...freeTerms, state: "confirmed" },
          alipayToken,
        )
      ).status,
    ).toBe(200);
    expect(await status(free.orderId, alipayOrders)).toMatchObject({
      state: "refunded",
      refund: { state: "confirmed" },
    });

    finish.resolve();
    expect(await (await dispatched).json()).toMatchObject({
      state: "completed",
      operation: { state: "settled", chargedMicrocredits: "3" },
    });
    await operator("reconcile");
    const reviewed = await status(held.orderId);
    expect(reviewed).toMatchObject({
      creditsFrozen: true,
      refund: { state: "manual_review" },
    });
    expect(refundStarts.has(reviewed.refund.id)).toBe(false);
    expect(await (await call("/paid/balance", subject)).json()).toMatchObject({
      availableMicrocredits: "0",
      reservedMicrocredits: "0",
      chargedMicrocredits: "3",
    });
    expect(await (await call("/paid/bill", subject)).json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId,
          orderId: held.orderId,
          amountMicrocredits: "3",
        }),
      ]),
    );
  } finally {
    finish.resolve();
    await dispatched?.catch(() => undefined);
    await restoreCatalog();
  }
}, 90_000);

test("a live channel requires distinct provider credentials and a non-fixture merchant", async () => {
  const { loadCreditPackLiveChannel } = await import(
    "../src/billing/credit-pack-live-channel"
  );
  const base = {
    OPENBOT_CREDIT_PACK_LIVE_ORIGIN: "https://pay.example.test",
    OPENBOT_CREDIT_PACK_LIVE_TOKEN: "live-token-0123456789abcdef",
    OPENBOT_CREDIT_PACK_LIVE_ACCOUNT_IDS: accountIds[0],
    OPENBOT_CREDIT_PACK_LIVE_APPLICATION_IDS: openbotApp,
    OPENBOT_CREDIT_PACK_LIVE_MERCHANT: "merchant-live-001",
    OPENBOT_CREDIT_PACK_LIVE_PRODUCT: code,
  };
  expect(loadCreditPackLiveChannel({ ...base })).toBeDefined();
  expect(
    loadCreditPackLiveChannel({
      ...base,
      OPENBOT_CREDIT_PACK_LIVE_MERCHANT: "fixture-live",
    }),
  ).toBeUndefined();
  expect(
    loadCreditPackLiveChannel({
      ...base,
      OPENBOT_CREDIT_PACK_LIVE_ORIGIN: "http://127.0.0.1:3000",
    }),
  ).toBeUndefined();
  expect(
    loadCreditPackLiveChannel({
      ...base,
      OPENBOT_CREDIT_PACK_TEST_ORIGIN: "https://pay.example.test",
      OPENBOT_CREDIT_PACK_TEST_TOKEN: base.OPENBOT_CREDIT_PACK_LIVE_TOKEN,
    }),
  ).toBeUndefined();
  expect(loadCreditPackLiveChannel({})).toBeUndefined();
  expect(() =>
    loadCreditPackTestChannel({
      OPENBOT_CREDIT_PACK_TEST_ORIGIN: "https://pay.example.test",
      OPENBOT_CREDIT_PACK_TEST_MERCHANT: "merchant-live-001",
    }),
  ).toThrow("Live payment channels require the live channel adapter.");
});

test("a live channel signs provider calls and admits only signed callbacks", async () => {
  const { loadCreditPackLiveChannel, liveCallbackSignature } = await import(
    "../src/billing/credit-pack-live-channel"
  );
  const { createCreditPackCheckout } = await import(
    "../src/billing/credit-pack-checkout"
  );
  const liveToken = "live-contract-token-000000000001";
  const liveMerchant = "merchant-live-contract";
  const signature = (route: string, body = "") =>
    liveCallbackSignature(liveToken, route, body);
  const channel = loadCreditPackLiveChannel({
    OPENBOT_CREDIT_PACK_LIVE_ORIGIN: "https://payments.example.test",
    OPENBOT_CREDIT_PACK_LIVE_TOKEN: liveToken,
    OPENBOT_CREDIT_PACK_LIVE_ACCOUNT_IDS: accountIds[0],
    OPENBOT_CREDIT_PACK_LIVE_APPLICATION_IDS: openbotApp,
    OPENBOT_CREDIT_PACK_LIVE_MERCHANT: liveMerchant,
    OPENBOT_CREDIT_PACK_LIVE_PRODUCT: code,
  });
  if (!channel) throw new Error("Live channel did not load.");
  expect(channel.merchant).toBe(liveMerchant);
  expect(channel.kind).toBe("wechat");
  expect(channel.fixture).toBe(false);
  expect(channel.allows(accountIds[0])).toBe(true);

  const signed = (route: string) =>
    new Request("https://openbot.test/api/billing/credit-pack-test/callback", {
      headers: {
        "x-channel-route": route,
        "x-signature": signature(route),
      },
    });
  expect(await channel.authenticates(signed("callback"))).toBe(true);
  expect(
    await channel.authenticates(
      new Request("https://openbot.test/callback", {
        headers: {
          "x-channel-route": "callback",
          "x-signature": liveCallbackSignature("wrong-token", "callback"),
        },
      }),
    ),
  ).toBe(false);
  expect(
    await channel.authenticates(
      new Request("https://openbot.test/callback", {
        headers: {
          "x-channel-route": "refund-callback",
          "x-signature": signature("callback"),
        },
      }),
    ),
  ).toBe(false);

  const checkout = createCreditPackCheckout({ channel, ledger, paid });
  const live = new Hono<{
    Variables: {
      identity: import("../src/billing/test-credit").VerifiedBillingIdentity;
    };
  }>();
  live.use("*", async (context, next) => {
    context.set("identity", { issuer, subject: alice });
    await next();
  });
  live.route("/api/billing", checkout);
  const liveApi = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => live.fetch(request),
  });
  const callback = (route: string, body?: object, ok = true) => {
    const payload = JSON.stringify(body ?? {});
    return fetch(
      new URL(`/api/billing/credit-pack-test/${route}`, liveApi.url),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-channel-route": route,
          "x-signature": ok ? signature(route, payload) : "invalid",
        },
        body: payload,
      },
    );
  };
  expect((await callback("callback", undefined, false)).status).toBe(401);
  expect((await callback("callback", { state: "not-a-payment" })).status).toBe(
    400,
  );
  expect((await callback("refund-callback", undefined, false)).status).toBe(
    401,
  );
  expect(
    (await callback("refund-callback", { state: "not-a-refund" })).status,
  ).toBe(400);
  await liveApi.stop(true);
}, 20_000);

test("a live channel signs checkout, query, close and refund requests to the provider", async () => {
  const { loadCreditPackLiveChannel } = await import(
    "../src/billing/credit-pack-live-channel"
  );
  const token = "live-contract-token-000000000002";
  const merchant = "merchant-live-contract";
  const origin = "https://payments.example.test";
  const channel = loadCreditPackLiveChannel({
    OPENBOT_CREDIT_PACK_LIVE_ORIGIN: origin,
    OPENBOT_CREDIT_PACK_LIVE_TOKEN: token,
    OPENBOT_CREDIT_PACK_LIVE_ACCOUNT_IDS: accountIds[0],
    OPENBOT_CREDIT_PACK_LIVE_APPLICATION_IDS: openbotApp,
    OPENBOT_CREDIT_PACK_LIVE_MERCHANT: merchant,
    OPENBOT_CREDIT_PACK_LIVE_PRODUCT: code,
  });
  if (!channel) throw new Error("Live channel did not load.");
  const orderId = crypto.randomUUID();
  const refundId = crypto.randomUUID();
  const terms: RefundTerms = {
    refundId,
    orderId,
    merchantId: merchant,
    currency: "CNY",
    amountCents: 2500,
    channelOrderRef: "live-ref-1",
  };
  const payment = {
    state: "paid",
    ...terms,
    paidAt: "2026-11-26T10:00:00.000Z",
  };
  const replies = [
    { checkoutUrl: `${origin}/checkout/${orderId}` },
    payment,
    { ...payment, state: "failed" },
    { ...terms, state: "processing" },
    { state: "unknown" },
  ];
  const calls: {
    url: string;
    method: string;
    authorization: string | null;
    signature: string | null;
    body: string;
  }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.clone().text();
    calls.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      signature: request.headers.get("x-signature"),
      body,
    });
    return Response.json(replies.shift());
  }) as typeof fetch;
  const sign = (route: string, body: string) =>
    createHmac("sha256", token).update(`${route}:${body}`).digest("hex");
  try {
    expect(await channel.checkout({ id: orderId, priceCents: 2500 })).toBe(
      `${origin}/checkout/${orderId}`,
    );
    expect(await channel.query(orderId)).toMatchObject({ state: "paid" });
    expect(await channel.close(orderId)).toMatchObject({ state: "failed" });
    expect(await channel.startRefund(terms)).toMatchObject({
      state: "processing",
    });
    expect(await channel.queryRefund(refundId)).toEqual({ state: "unknown" });
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(calls).toHaveLength(5);
  const checkoutBody = JSON.stringify({
    orderId,
    merchantId: merchant,
    amountCents: 2500,
    currency: "CNY",
    productCode: code,
  });
  expect(calls[0]).toEqual({
    url: `${origin}/orders/${orderId}`,
    method: "POST",
    authorization: `Bearer ${token}`,
    signature: sign(`orders/${orderId}`, checkoutBody),
    body: checkoutBody,
  });
  expect(calls[1]).toEqual({
    url: `${origin}/orders/${orderId}`,
    method: "GET",
    authorization: `Bearer ${token}`,
    signature: sign(`orders/${orderId}`, ""),
    body: "",
  });
  expect(calls[2]).toEqual({
    url: `${origin}/orders/close/${orderId}`,
    method: "POST",
    authorization: `Bearer ${token}`,
    signature: sign(`orders/close/${orderId}`, "{}"),
    body: "{}",
  });
  const refundBody = JSON.stringify(terms);
  expect(calls[3]).toEqual({
    url: `${origin}/refunds/${refundId}`,
    method: "POST",
    authorization: `Bearer ${token}`,
    signature: sign(`refunds/${refundId}`, refundBody),
    body: refundBody,
  });
  expect(calls[4]).toEqual({
    url: `${origin}/refunds/${refundId}`,
    method: "GET",
    authorization: `Bearer ${token}`,
    signature: sign(`refunds/${refundId}`, ""),
    body: "",
  });
}, 20_000);

test("a live channel pays, grants, refunds through its provider and reconciles once", async () => {
  const { loadCreditPackLiveChannel } = await import(
    "../src/billing/credit-pack-live-channel"
  );
  await approvePaths();
  const subject = crypto.randomUUID();
  fixtureSubjects.add(subject);
  const [{ id: accountId }] = await database
    .insert(testCreditAccounts)
    .values({ issuer, subject })
    .returning();
  accountIds.push(accountId);
  const product = await publish(2_500, 25_000_000n);
  const providerOrigin = "https://provider-e2e.example.test";
  const liveToken = "live-e2e-provider-token-00000001";
  const liveMerchant = "merchant-live-e2e";
  const channel = loadCreditPackLiveChannel({
    OPENBOT_CREDIT_PACK_LIVE_ORIGIN: providerOrigin,
    OPENBOT_CREDIT_PACK_LIVE_TOKEN: liveToken,
    OPENBOT_CREDIT_PACK_LIVE_ACCOUNT_IDS: accountId,
    OPENBOT_CREDIT_PACK_LIVE_APPLICATION_IDS: openbotApp,
    OPENBOT_CREDIT_PACK_LIVE_MERCHANT: liveMerchant,
    OPENBOT_CREDIT_PACK_LIVE_PRODUCT: code,
  });
  if (!channel) throw new Error("Live channel did not load.");
  const app = new Hono();
  app.route(
    "/api/billing",
    createTestCreditRoutes({
      ledger,
      paid: { ledger: paid, creditPackTestChannel: channel },
      authenticate: async () => ({ issuer, subject }),
    }),
  );
  const liveApi = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => app.fetch(request),
  });
  const get = (path: string) =>
    fetch(new URL(`/api/billing${path}`, liveApi.url));
  const post = (path: string, body?: object) =>
    fetch(new URL(`/api/billing${path}`, liveApi.url), {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  const callback = (route: string, body: object, credential = liveToken) => {
    const payload = JSON.stringify(body);
    return fetch(
      new URL(`/api/billing/credit-pack-test/${route}`, liveApi.url),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-channel-route": route,
          "x-signature": createHmac("sha256", credential)
            .update(`${route}:${payload}`)
            .digest("hex"),
        },
        body: payload,
      },
    );
  };
  const providerOrders = new Map<string, object>();
  const providerRefunds = new Map<string, object>();
  const providerCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(providerOrigin)) return originalFetch(request);
    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    providerCalls.push(`${request.method} /${parts.join("/")}`);
    if (parts[0] === "orders" && parts.length === 2) {
      if (request.method === "POST")
        return Response.json({
          checkoutUrl: `${providerOrigin}/pay/${parts[1]}`,
        });
      return Response.json(
        providerOrders.get(parts[1]) ?? { state: "unknown" },
      );
    }
    if (parts[0] === "orders" && parts[1] === "close")
      return Response.json({ state: "unknown" });
    if (parts[0] === "refunds") {
      if (request.method === "POST") {
        const terms = testRefundTerms.parse(await request.json());
        providerRefunds.set(parts[1], terms);
        return Response.json({ ...terms, state: "processing" });
      }
      return Response.json(
        providerRefunds.get(parts[1]) ?? { state: "unknown" },
      );
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    const offer = await (await get("/paid/credit-pack")).json();
    expect(offer.available).toBe(true);
    expect(offer.product).toMatchObject({
      version: product.version,
      priceCents: product.priceCents,
      currency: "CNY",
    });
    const orderId = crypto.randomUUID();
    expect(
      (await post(orders, { orderId, version: product.version })).status,
    ).toBe(201);
    const [orderRow] = await database
      .select({ testMerchant: paidOrders.testMerchant })
      .from(paidOrders)
      .where(eq(paidOrders.id, orderId));
    expect(orderRow.testMerchant).toBeNull();
    expect((await post(`${orders}/${orderId}/checkout`, {})).status).toBe(200);
    const payment = {
      state: "paid",
      orderId,
      merchantId: liveMerchant,
      currency: "CNY",
      amountCents: product.priceCents,
      channelOrderRef: `live-${orderId}`,
      paidAt: new Date().toISOString(),
    };
    for (const mismatch of [
      { merchantId: "merchant-live-elsewhere" },
      { amountCents: 1 },
      { currency: "USD" },
    ])
      expect(
        (await callback("callback", { ...payment, ...mismatch })).status,
      ).toBe(409);
    expect(await (await get(orders)).json()).toMatchObject([
      { id: orderId, state: "pending", entitlementId: null },
    ]);
    expect((await callback("callback", payment)).status).toBe(200);
    expect(await (await get(orders)).json()).toMatchObject([
      {
        id: orderId,
        state: "verified",
        priceCents: product.priceCents,
        entitlementId: expect.any(String),
      },
    ]);
    expect(await (await get("/paid/balance")).json()).toMatchObject({
      availableMicrocredits: product.creditsMicrocredits.toString(),
    });
    // The same provider signature replayed cannot grant again.
    expect((await callback("callback", payment)).status).toBe(200);
    expect(await (await get("/paid/balance")).json()).toMatchObject({
      availableMicrocredits: product.creditsMicrocredits.toString(),
    });

    const refunding = await (
      await post(`${orders}/${orderId}/refund`, {})
    ).json();
    expect(refunding).toMatchObject({
      state: "refund_pending",
      creditsFrozen: true,
      refund: { state: "processing", amountCents: product.priceCents },
    });
    expect(await (await get("/paid/balance")).json()).toMatchObject({
      availableMicrocredits: "0",
    });
    const terms = providerRefunds.get(refunding.refund.id);
    if (!terms) throw new Error("The provider never received the refund.");
    expect(terms).toMatchObject({
      orderId,
      merchantId: liveMerchant,
      currency: "CNY",
      amountCents: product.priceCents,
      channelOrderRef: `live-${orderId}`,
    });
    providerRefunds.set(refunding.refund.id, { ...terms, state: "confirmed" });
    expect(
      await (await post(`${orders}/${orderId}/refund/verify`, {})).json(),
    ).toMatchObject({ state: "refunded", refund: { state: "confirmed" } });
    expect(await (await get("/paid/balance")).json()).toMatchObject({
      availableMicrocredits: "0",
    });
    expect(providerCalls).toEqual([
      `POST /orders/${orderId}`,
      `POST /refunds/${refunding.refund.id}`,
      `GET /refunds/${refunding.refund.id}`,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await liveApi.stop(true);
  }
}, 20_000);

test("Flexprice two-channel checkout locks the buyer's CNY quote and settles only a matching invoice", async () => {
  const buyer = accountIds[1];
  const orderId = crypto.randomUUID();
  const invoiceId = "inv_openbot_alipay";
  const customerId = "cus_openbot_alipay";
  const webhookToken = "fixture-flexprice-webhook-token-0001";
  let issuedInvoice: unknown;
  let channel = "alipay";
  let closeConfirmed = false;
  let invoicePaid = false;
  let reconcileOnQuery = false;
  let confirmedByWeChat = false;
  let invoiceCurrency = "cny";
  let invoiceTotal = "25";
  let responseInvoiceId = invoiceId;
  const invoice = () => ({
    id: responseInvoiceId,
    customer_id: customerId,
    metadata: { openbot_account_id: buyer },
    idempotency_key: `openbot-credit-pack:${orderId}`,
    invoice_status: "FINALIZED",
    payment_status: invoicePaid ? "SUCCEEDED" : "PENDING",
    currency: invoiceCurrency,
    total: invoiceTotal,
    amount_due: invoiceTotal,
    amount_paid: invoicePaid ? "25" : "0",
    amount_remaining: invoicePaid ? "0" : invoiceTotal,
    paid_at: invoicePaid ? new Date().toISOString() : undefined,
  });
  const flexprice = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("x-api-key") !== "fixture-flexprice")
        return new Response(null, { status: 401 });
      const url = new URL(request.url);
      if (url.pathname === `/v1/customers/external/openbot-alipay-${buyer}`)
        return Response.json({
          id: customerId,
          external_id: `openbot-alipay-${buyer}`,
        });
      if (url.pathname === "/v1/invoices" && request.method === "POST") {
        if (issuedInvoice)
          return Response.json(
            { details: { invoice_id: invoiceId } },
            { status: 409 },
          );
        issuedInvoice = await request.json();
        return new Response(null, { status: 502 });
      }
      if (url.pathname === `/v1/invoices/${invoiceId}`)
        return Response.json(invoice());
      if (
        url.pathname === `/v1/invoices/${invoiceId}/qr-checkout` &&
        url.searchParams.get("customer_id") === customerId
      ) {
        if (request.method === "GET" && reconcileOnQuery) invoicePaid = true;
        const input =
          request.method === "POST" ? await request.json() : undefined;
        const waiting = input?.channel === "wechat" && !closeConfirmed;
        if (input?.channel === "wechat" && closeConfirmed) channel = "wechat";
        return Response.json({
          channel,
          order_id: `pay_openbot_${channel}`,
          status: confirmedByWeChat
            ? "paid"
            : waiting
              ? "confirming"
              : "pending",
          amount: "25.00",
          currency: "CNY",
          qr_code: waiting
            ? undefined
            : channel === "wechat"
              ? "weixin://wxpay/bizpayurl?fixture"
              : "https://qr.alipay.com/fixture",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  const settings = {
    baseUrl: flexprice.url.origin,
    apiKey: "fixture-flexprice",
    webhookToken,
    merchant: "fixture-flexprice-merchant",
    wechatMerchant: "fixture-wechat-merchant",
    productCodes: [code],
    applicationIds: [openbotApp],
    accountIds: [buyer, accountIds[0]],
  };
  const mountFlexprice = (wechatEnabled = true) => {
    return createTestCreditRoutes({
      ledger,
      paid: {
        ledger: paid,
        flexpriceAlipay: {
          ...settings,
          wechatMerchant: wechatEnabled ? settings.wechatMerchant : undefined,
        },
      },
      authenticate: async (request) => {
        const subject = request.headers.get("x-fixture-subject");
        return subject && fixtureSubjects.has(subject)
          ? { issuer, subject }
          : undefined;
      },
    });
  };
  let billing = mountFlexprice();
  const request = (
    path: string,
    subject?: string,
    body?: object,
    auth?: string,
  ) =>
    billing.request(path, {
      method: body ? "POST" : "GET",
      headers: {
        ...(subject ? { "x-fixture-subject": subject } : {}),
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        "content-type": "application/json",
      },
      body: body && JSON.stringify(body),
    });
  try {
    await approvePaths();
    const product = await publish(2500, 25_000_000n);
    const root = "/paid/credit-pack/alipay/flexprice";
    expect((await request(root, bob)).status).toBe(200);
    const before = BigInt(
      (await (await request("/paid/balance", bob)).json())
        .availableMicrocredits,
    );
    const verify = `${root}/orders/${orderId}/verify`;
    const checkout = `${root}/orders/${orderId}/checkout`;
    const input = { orderId, productCode: code, version: product.version };
    // Flexprice issued the invoice before the connection failed. Retrying
    // recovers the same invoice by its idempotency key and keeps the quote.
    expect((await request(`${root}/orders`, bob, input)).status).toBe(503);
    await publish(3500, 35_000_000n);
    expect((await request(`${root}/orders`, bob, input)).status).toBe(200);
    expect((await request(checkout, alice, {})).status).toBe(404);
    expect((await request(verify, alice, {})).status).toBe(404);
    expect(await (await request(checkout, bob, {})).json()).toMatchObject({
      status: "pending",
      qrCode: "https://qr.alipay.com/fixture",
    });
    billing = mountFlexprice(false);
    expect(await (await request(root, bob)).json()).toMatchObject({
      channels: ["alipay"],
    });
    expect((await request(checkout, bob, { channel: "wechat" })).status).toBe(
      404,
    );
    billing = mountFlexprice();
    expect(
      await (await request(checkout, bob, { channel: "wechat" })).json(),
    ).toMatchObject({
      status: "confirming",
      channel: "alipay",
    });
    closeConfirmed = true;
    expect(
      await (await request(checkout, bob, { channel: "wechat" })).json(),
    ).toMatchObject({
      status: "pending",
      channel: "wechat",
      qrCode: "weixin://wxpay/bizpayurl?fixture",
    });
    expect(issuedInvoice).toMatchObject({
      customer_id: customerId,
      idempotency_key: `openbot-credit-pack:${orderId}`,
      currency: "CNY",
      line_items: [{ amount: "25.00", quantity: "1" }],
    });

    const callback = "/credit-pack-flexprice/alipay/callback";
    const notice = {
      event_type: "invoice.update.payment",
      invoice: { id: invoiceId },
    };
    expect((await request(callback, undefined, notice)).status).toBe(401);
    // A payment notice only prompts a fresh read from Flexprice.
    expect(
      (await request(callback, undefined, notice, webhookToken)).status,
    ).toBe(200);
    expect(await (await request(verify, bob, {})).json()).toMatchObject({
      state: "pending",
    });
    confirmedByWeChat = true;
    invoicePaid = true;
    for (const mismatch of ["wrong invoice", "currency", "amount"]) {
      responseInvoiceId =
        mismatch === "wrong invoice" ? "inv_other" : invoiceId;
      invoiceCurrency = mismatch === "currency" ? "usd" : "cny";
      invoiceTotal = mismatch === "amount" ? "35" : "25";
      expect((await request(verify, bob, {})).status).toBe(409);
    }
    responseInvoiceId = invoiceId;
    invoiceCurrency = "cny";
    invoiceTotal = "25";
    expect(await (await request("/paid/balance", bob)).json()).toMatchObject({
      availableMicrocredits: before.toString(),
    });

    invoicePaid = false;
    reconcileOnQuery = true;
    billing = mountFlexprice();
    const sweepErrors: unknown[] = [];
    await createFlexpriceAlipaySweep({
      settings,
      paid,
      onError: (_orderId, error) => sweepErrors.push(error),
    })();
    expect(sweepErrors).toEqual([]);
    expect(await (await request("/paid/balance", bob)).json()).toMatchObject({
      availableMicrocredits: (before + 25_000_000n).toString(),
    });

    for (const result of await Promise.all([
      request(verify, bob, {}),
      request(callback, undefined, notice, webhookToken),
      request(callback, undefined, notice, webhookToken),
    ]))
      expect(result.status).toBe(200);
    expect(await (await request(`${root}/orders`, bob)).json()).toContainEqual(
      expect.objectContaining({
        id: orderId,
        state: "verified",
        channel: "wechat",
        creditsMicrocredits: "25000000",
      }),
    );
    expect(await (await request("/paid/balance", bob)).json()).toMatchObject({
      availableMicrocredits: (before + 25_000_000n).toString(),
    });
  } finally {
    flexprice.stop(true);
  }
});
