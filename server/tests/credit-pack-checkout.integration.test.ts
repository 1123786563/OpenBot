import { afterAll, beforeAll, expect, test } from "bun:test";
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
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import { createTestCreditLedger } from "../src/billing/test-credit";
import { createTestCreditRoutes } from "../src/billing/test-credit-routes";
import { createDatabase } from "../src/db/client";
import {
  billingApplications,
  enterpriseSettings,
  paidCreditAllocations,
  paidEntitlements,
  paidOrders,
  paidProducts,
  paidRefunds,
  testCreditAccounts,
  testCreditOperations,
  testCreditResumePoints,
} from "../src/db/schema";
import { fixtureTraceReport } from "./support/bifrost-evidence";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const ledger = createTestCreditLedger(database);
const paid = createPaidCreditLedger(database);
const code = "fixture-credit-pack";
const token = "fixture-credit-pack-token-for-local-test";
const alipayToken = "fixture-alipay-token-for-local-test";
const issuer = "credit-pack-fixture";
const alice = crypto.randomUUID();
const bob = crypto.randomUUID();
const outsider = crypto.randomUUID();
const fixtureSubjects = new Set<string>([alice, bob, outsider]);
type RefundTerms = ReturnType<typeof testRefundTerms.parse>;
const refundStarts = new Map<string, RefundTerms>();
let refundUnavailable = false;
let accountIds: string[] = [];
const payments = new Map<string, object>();
const starts = new Map<string, unknown>();
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
        return Response.json({ ...terms, state: "processing" });
      }
      if (request.method === "PUT") {
        starts.set(id, await request.json());
        return Response.json({
          checkoutUrl: `${server.url.origin}/checkout/${id}`,
        });
      }
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
  eligible = accountIds.slice(0, 2),
  alipayOrigin?: string,
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
  await database.delete(paidProducts).where(eq(paidProducts.code, code));
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

test("a concurrent reservation and refund can never both claim the same source", async () => {
  const pack = await verifiedPack();
  const route = "checkout-refund-race";
  const harnessImage = `agent-langgraph-agui@sha256:${"a".repeat(64)}`;
  const draft = configure(emptyCatalog, {
    harnessImage,
    routes: {
      [route]: {
        provider: "refund-fixture",
        model: "refund-fixture",
        gatewayRevision: "refund-fixture-v1",
        meteringRevision: "refund-fixture-v1",
        maxInputTokens: 10,
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
    if (previous) await install(previous.value);
    else
      await database
        .delete(enterpriseSettings)
        .where(eq(enterpriseSettings.key, pilotCatalogKey));
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
  });
}

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
