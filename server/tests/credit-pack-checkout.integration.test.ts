import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { startCreditPackFixture } from "../scripts/credit-pack-test-fixture";
import { loadCreditPackTestChannel } from "../src/billing/credit-pack-test-channel";
import { createPaidCreditLedger } from "../src/billing/paid-ledger";
import { createTestCreditLedger } from "../src/billing/test-credit";
import { createTestCreditRoutes } from "../src/billing/test-credit-routes";
import { createDatabase } from "../src/db/client";
import {
  billingApplications,
  paidEntitlements,
  paidOrders,
  paidProducts,
  testCreditAccounts,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const ledger = createTestCreditLedger(database);
const paid = createPaidCreditLedger(database);
const code = "fixture-credit-pack";
const token = "fixture-credit-pack-token-for-local-test";
const issuer = "credit-pack-fixture";
const alice = crypto.randomUUID();
const bob = crypto.randomUUID();
const outsider = crypto.randomUUID();
const fixtureSubjects = new Set<string>([alice, bob, outsider]);
let accountIds: string[] = [];
const payments = new Map<string, object>();
const starts = new Map<string, unknown>();
let onQuery: (() => Promise<void>) | undefined;
const openbotApp = `checkout-openbot-${alice}`;
const secondApp = `checkout-second-${alice}`;
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, server): Promise<Response> {
    if (request.headers.get("authorization") !== `Bearer ${token}`)
      return new Response(null, { status: 401 });
    const id = new URL(request.url).pathname.split("/").at(-1) ?? "";
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

let api: Hono;
beforeAll(async () => {
  accountIds = (
    await database
      .insert(testCreditAccounts)
      .values([alice, bob, outsider].map((subject) => ({ issuer, subject })))
      .returning()
  ).map(({ id }) => id);
  api = mount(fixture.url.origin);
  await publish(2_500, 25_000_000n);
});

function mount(origin: string, eligible = accountIds.slice(0, 2)) {
  const app = new Hono();
  const channel = loadCreditPackTestChannel({
    OPENBOT_CREDIT_PACK_TEST_ORIGIN: origin,
    OPENBOT_CREDIT_PACK_TEST_TOKEN: token,
    OPENBOT_CREDIT_PACK_TEST_ACCOUNT_IDS: eligible.join(","),
    OPENBOT_CREDIT_PACK_TEST_PRODUCT: code,
    OPENBOT_CREDIT_PACK_TEST_APPLICATION_IDS: [openbotApp, secondApp].join(","),
    OPENBOT_CREDIT_PACK_TEST_MERCHANT: "fixture-merchant",
  });
  app.route(
    "/api/billing",
    createTestCreditRoutes({
      ledger,
      paid: { ledger: paid, creditPackTestChannel: channel },
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
  await fixture.stop(true);
  await database
    .delete(paidEntitlements)
    .where(inArray(paidEntitlements.accountId, accountIds));
  await database
    .delete(paidOrders)
    .where(inArray(paidOrders.accountId, accountIds));
  await database.delete(paidProducts).where(eq(paidProducts.code, code));
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
function call(
  path: string,
  subject?: string,
  body?: object,
  channelAuth = false,
) {
  return api.request(`/api/billing${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(subject ? { "x-fixture-subject": subject } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...(channelAuth ? { authorization: `Bearer ${token}` } : {}),
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
  const checkoutFixture = startCreditPackFixture({
    port: 0,
    token,
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
  } finally {
    api = previous;
    await checkoutFixture.stop(true);
  }
});
