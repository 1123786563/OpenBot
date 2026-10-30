import {
  afterAll,
  afterEach,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { createDatabase, type Database } from "../src/db/client";
import { billingCustomers } from "../src/db/schema/billing";
import { creditGrants } from "../src/db/schema/credits";
import { paymentEvents, paymentOrders } from "../src/db/schema/payment";
import { createCreditWriter } from "../src/billing/credits-writer";
import type {
  PaymentProvider,
  PaymentProviderId,
} from "../src/billing/payments/provider";
import { createPaymentService } from "../src/billing/payments/service";
import { createPaymentStore } from "../src/billing/payments/store";
import type { PaymentStore } from "../src/billing/payments/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Payment-callback ownership (ticket 10.2, AC14/Q27) against the dedicated PostgreSQL test
 * database. The rule under test: a callback's payout lands in the account the ORDER bound at
 * creation — `payerKey(order.ownerPayerRef)` — never in an account any delivery's bytes name,
 * and never by default in the deployment's own account. Around that rule: a redelivery of the
 * same callback credits once (the paid-fact unique index plus the `plan:<orderId>` grant key),
 * a failed signature moves nothing and still leaves an audit row on the order it named, and a
 * pre-attribution legacy order pays out to nobody rather than to a guessed account.
 *
 * The provider is a scripted fake — production's adapters decrypt and verify the exact bytes;
 * what crosses the seam is a PaymentFact, and the first test deliberately lets a hostile
 * payload's user fields RIDE ON that fact, to prove the service reads none of them. Every
 * account key is unique per test, so one test's leftovers can never answer another's counts.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store: PaymentStore = createPaymentStore(database);
const creditWriter = createCreditWriter(database);
const prefix = `cbown-${randomUUID().slice(0, 8)}`;
/** Scaled units (×100): a 100-credit plan allowance. */
const PLAN_CREDIT_UNITS = 10_000;
const grantPeriodEnd = new Date("2027-01-31T00:00:00Z");

/** One account identity, unique per call — tests never share an account. */
let actorSeq = 0;
function personalActor(tag: string) {
  actorSeq += 1;
  const user = `${prefix}-${tag}-${actorSeq}`;
  return { user, key: `openbot-personal-${user}` };
}

function deploymentActor() {
  actorSeq += 1;
  return { key: `openbot-deployment-${prefix}-${actorSeq}` };
}

afterAll(async () => {
  // Grants and their customer floor rows carry the prefix in every account key the tests use;
  // orders cascade their events.
  await database
    .delete(creditGrants)
    .where(like(creditGrants.externalCustomerId, `%${prefix}%`));
  await database
    .delete(billingCustomers)
    .where(like(billingCustomers.externalId, `%${prefix}%`));
  await database
    .delete(paymentOrders)
    .where(like(paymentOrders.createdBy, `${prefix}%`));
  await database.$client.close();
});

afterEach(async () => {
  // The deployment holds ONE pending purchase at a time (the pending-scope partial unique
  // index); every test closes what it opened so the next test's insert finds the slot free.
  const pending = await database
    .select({ id: paymentOrders.id, version: paymentOrders.version })
    .from(paymentOrders)
    .where(
      and(
        like(paymentOrders.createdBy, `${prefix}%`),
        eq(paymentOrders.status, "pending"),
      ),
    );
  for (const order of pending) {
    await store.cancelOrder(order.id, order.version);
  }
});

function orderInput(ownerPayerRef: {
  kind: "personal";
  id: string;
}): Parameters<PaymentStore["insertOrder"]>[0] {
  return {
    planCode: `pro-${randomUUID().slice(0, 8)}`,
    provider: "alipay",
    amountCents: 8800,
    currency: "CNY",
    expiresAt: new Date(Date.now() + 15 * 60_000),
    createdBy: prefix,
    ownerPayerRef,
    checkoutPayload: null,
  };
}

/**
 * The plan-allowance payout, wired exactly as src/index.ts wires it: the service decides the
 * recipient and this grantor writes the ledger under the `plan:<orderId>` idempotency key.
 */
const grantor = {
  creditsFor: (planCode: string) =>
    planCode.startsWith("pro-") ? PLAN_CREDIT_UNITS : null,
  grantPlanCredits: async (input: {
    externalCustomerId: string;
    planCode: string;
    orderId: string;
    totalCents: number;
    expiresAt: Date | null;
  }) => {
    if (input.expiresAt === null) return { inserted: false };
    const result = await creditWriter.grantCredits({
      externalCustomerId: input.externalCustomerId,
      source: "plan",
      totalCents: input.totalCents,
      expiresAt: input.expiresAt,
      reason: `plan allowance · ${input.planCode} · order ${input.orderId}`,
      idempotencyKey: `plan:${input.orderId}`,
    });
    return { inserted: result.inserted };
  },
  readCurrentPeriodEnd: async () => grantPeriodEnd,
};

function fakeProvider(
  id: PaymentProviderId,
  verify: PaymentProvider["verifyNotification"],
): PaymentProvider {
  return {
    id,
    createSession: async () => ({
      checkout: { kind: "qrcode", payload: `qr-${id}` },
    }),
    queryPayment: async (outTradeNo: string) => ({
      outTradeNo,
      state: "pending" as const,
    }),
    closePayment: async () => {},
    verifyNotification: verify,
    successAck: { body: "success", contentType: "text/plain" },
  };
}

function buildService(providers: PaymentProvider[], keyDeployment: string) {
  return createPaymentService({
    providers: new Map(providers.map((provider) => [provider.id, provider])),
    store,
    catalog: new Map([
      ["pro-default", { currency: "CNY", cycles: new Map([["monthly", 8800]]) }],
    ]),
    notifyBaseUrl: "https://payments.openbot.example",
    orderTtlMinutes: 15,
    latePaymentWindowHours: 24,
    acceptForeignCurrency: false,
    lago: {
      getPlan: async () => ({
        found: true,
        interval: "monthly",
        currency: "CNY",
      }),
      ensureSubscription: async () => ({
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: grantPeriodEnd.toISOString(),
      }),
    },
    externalCustomerKey: keyDeployment,
    activePlanCode: async () => null,
    invalidateEntitlementCache: () => undefined,
    grantor,
  });
}

/** Every plan-source grant on exactly the accounts a test names — no key, no row. */
async function grantsFor(keys: string[]) {
  return database
    .select({
      externalCustomerId: creditGrants.externalCustomerId,
      idempotencyKey: creditGrants.idempotencyKey,
    })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.source, "plan"),
        inArray(creditGrants.externalCustomerId, keys),
      ),
    );
}

async function factCount(orderId: string) {
  const rows = await database
    .select({ id: paymentEvents.id })
    .from(paymentEvents)
    .where(
      and(eq(paymentEvents.orderId, orderId), eq(paymentEvents.kind, "fact")),
    );
  return rows.length;
}

async function anomaliesOf(orderId: string) {
  return database
    .select({ code: paymentEvents.code, detail: paymentEvents.detail })
    .from(paymentEvents)
    .where(
      and(
        eq(paymentEvents.orderId, orderId),
        eq(paymentEvents.kind, "anomaly"),
      ),
    );
}

function paidFactFor(orderId: string, channelTransactionId: string) {
  return {
    outTradeNo: orderId,
    state: "paid" as const,
    channelTransactionId,
    amountCents: 8800,
    currency: "CNY",
  };
}

test("a verified callback credits the ORDER's account; payload user identities are dead data", async () => {
  const owner = personalActor("owner");
  const forger = personalActor("forger");
  const deployment = deploymentActor();
  const { order } = await store.insertOrder(
    orderInput({ kind: "personal", id: owner.user }),
  );
  // The raw bytes carry a forger's identities — a user id and a whole account key.
  const rawBody = JSON.stringify({
    app_id: "2021000000000000",
    out_trade_no: order.id,
    trade_status: "TRADE_SUCCESS",
    buyer_id: forger.user,
    external_customer_id: forger.key,
  });
  const alipay = fakeProvider("alipay", async (_headers, body) => {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    // A hostile or buggy adapter leak: the payload's user fields surface ON the fact the
    // seam hands the service. The service must read none of them.
    return {
      ok: true as const,
      fact: Object.assign(paidFactFor(order.id, `tx-${order.id}`), {
        buyerId: parsed.buyer_id,
        externalCustomerId: parsed.external_customer_id,
      }),
    };
  });
  const outcome = await buildService([alipay], deployment.key).handleCallback(
    "alipay",
    new Headers(),
    rawBody,
  );
  expect(outcome).toEqual({ kind: "success" });
  expect((await store.readOrder(order.id))?.status).toBe("paid");

  const grants = await grantsFor([owner.key, forger.key, deployment.key]);
  // Exactly one allowance, and it is the ORDER OWNER's — not the forger's, not the
  // deployment's default account.
  expect(grants.map((grant) => grant.externalCustomerId)).toEqual([owner.key]);
  expect(grants[0]?.idempotencyKey).toBe(`plan:${order.id}`);
});

test("the same callback redelivered credits once; a second transaction on the paid order credits nothing", async () => {
  const owner = personalActor("owner");
  const deployment = deploymentActor();
  const { order } = await store.insertOrder(
    orderInput({ kind: "personal", id: owner.user }),
  );
  const deliver = (transactionId: string) =>
    buildService(
      [
        fakeProvider("alipay", async () => ({
          ok: true as const,
          fact: paidFactFor(order.id, transactionId),
        })),
      ],
      deployment.key,
    );

  const first = await deliver(`tx-${order.id}`).handleCallback(
    "alipay",
    new Headers(),
    "body",
  );
  expect(first).toEqual({ kind: "success" });
  const replay = await deliver(`tx-${order.id}`).handleCallback(
    "alipay",
    new Headers(),
    "body",
  );
  // The channel is told "done" so it stops retrying — and nothing is paid twice.
  expect(replay).toEqual({ kind: "success" });
  // A different transaction landing on the already-paid order is refused, not a second payout.
  const other = await deliver(`tx-other-${order.id}`).handleCallback(
    "alipay",
    new Headers(),
    "body",
  );
  expect(other).toEqual({
    kind: "settlement-refused",
    settlement: { kind: "refused", reason: "blocked" },
  });

  expect(await factCount(order.id)).toBe(1);
  const grants = await grantsFor([owner.key, deployment.key]);
  expect(grants.map((grant) => grant.externalCustomerId)).toEqual([owner.key]);
  expect(grants[0]?.idempotencyKey).toBe(`plan:${order.id}`);
});

test("a failed signature moves no money, grants nothing, and records an anomaly on the order it named", async () => {
  const owner = personalActor("owner");
  const forger = personalActor("forger");
  const deployment = deploymentActor();
  const { order } = await store.insertOrder(
    orderInput({ kind: "personal", id: owner.user }),
  );
  const alipay = fakeProvider("alipay", async () => ({
    ok: false as const,
    referencedOutTradeNo: order.id,
  }));
  const service = buildService([alipay], deployment.key);
  const outcome = await service.handleCallback(
    "alipay",
    new Headers(),
    JSON.stringify({ out_trade_no: order.id, buyer_id: forger.user }),
  );
  expect(outcome).toEqual({ kind: "unverified" });

  // Nothing about any order moved, and no account was touched — the forger least of all.
  expect((await store.readOrder(order.id))?.status).toBe("pending");
  expect(await factCount(order.id)).toBe(0);
  expect(await grantsFor([owner.key, forger.key, deployment.key])).toHaveLength(
    0,
  );

  // The attempt is not silently dropped: an anomaly row names the order the delivery claimed.
  const anomalies = await anomaliesOf(order.id);
  expect(anomalies.map((anomaly) => anomaly.code)).toContain(
    "callback_unverified",
  );

  // A failed delivery naming an order that does not exist fabricates nothing at all.
  const stranger = fakeProvider("alipay", async () => ({
    ok: false as const,
    referencedOutTradeNo: "po-does-not-exist",
  }));
  expect(
    await buildService([stranger], deployment.key).handleCallback(
      "alipay",
      new Headers(),
      "{}",
    ),
  ).toEqual({ kind: "unverified" });
  expect(await store.readOrder("po-does-not-exist")).toBeNull();
  expect(await factCount("po-does-not-exist")).toBe(0);
});

test("a paid fact on a pre-attribution order credits nobody and records the withheld payout", async () => {
  const deployment = deploymentActor();
  // A legacy row inserted the way 10.1 found them: ownerless, awaiting the attribution pass.
  const orderId = `po-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const planCode = `pro-${randomUUID().slice(0, 8)}`;
  await database.insert(paymentOrders).values({
    id: orderId,
    deploymentScope: "default",
    planCode,
    provider: "alipay",
    amountCents: 8800,
    currency: "CNY",
    status: "pending",
    activationState: "pending",
    expiresAt: new Date(Date.now() + 15 * 60_000),
    createdBy: prefix,
  });
  const alipay = fakeProvider("alipay", async () => ({
    ok: true as const,
    fact: paidFactFor(orderId, `tx-${orderId}`),
  }));
  const outcome = await buildService([alipay], deployment.key).handleCallback(
    "alipay",
    new Headers(),
    "body",
  );
  // The money itself landed on the order…
  expect(outcome).toEqual({ kind: "success" });
  expect((await store.readOrder(orderId))?.status).toBe("paid");
  // …but the allowance pays out to NO account — not the deployment's, not a guessed one —
  // and the gap is recorded for the operator instead of silently dropped.
  expect(await grantsFor([deployment.key])).toHaveLength(0);
  const anomalies = await anomaliesOf(orderId);
  expect(anomalies.map((anomaly) => anomaly.code)).toContain("unowned_payout");
});
