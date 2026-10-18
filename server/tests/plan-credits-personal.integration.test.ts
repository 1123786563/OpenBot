import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createLagoClient } from "../src/billing/lago";
import type { PayerRef } from "../src/billing/payer";
import { payerKey } from "../src/billing/payer";
import type {
  PaymentFact,
  PaymentProvider,
  PaymentProviderId,
} from "../src/billing/payments/provider";
import { createPaymentService } from "../src/billing/payments/service";
import { createPaymentStore } from "../src/billing/payments/store";
import { createPlanRenewalGrantor } from "../src/billing/plan-renewals";
import { createReconciler } from "../src/billing/reconcile";
import { createBillingService } from "../src/billing/service";
import { createBillingStore } from "../src/billing/store";
import { createWebhookVerifier } from "../src/billing/webhook-signature";
import { createDatabase, type Database } from "../src/db/client";
import {
  billingCustomers,
  billingSubscriptions,
} from "../src/db/schema/billing";
import { creditGrants } from "../src/db/schema/credits";
import { paymentOrders } from "../src/db/schema/payment";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Plan credits land in the PURCHASER'S personal account (ticket 10.5, AC14/Q27) against the
 * dedicated PostgreSQL test database. The ticket's acceptance criteria live here:
 *
 * 1. A purchase's plan allowance lands in the account the ORDER bound at creation — the
 *    purchaser's own personal key — and the purchaser's available balance rises by exactly
 *    the plan's allowance. No other account moves: not another person's, not the deployment's
 *    legacy key.
 * 2. A plan change settles inside the SAME account: a sequential re-purchase (the "差额" is
 *    the second order's own full allowance) and a provider-side plan change (the next period's
 *    renewal pays the NEW plan's allowance into the SAME owner's account) never move, copy or
 *    mix credits across accounts — and reconciliation audits exactly that, per account.
 * 3. A repeated payout is suppressed by the ledger's idempotency key: a replayed callback, and
 *    an activation retried after a crash between the grant and the applied marker, land as ONE
 *    grant at the priced amount.
 *
 * The rig mirrors src/index.ts's production wiring (the same factories, the same idempotency
 * key spellings) over the real stores, the real credit writer and the real reconciler; the
 * provider is a scripted fetch stub behind the real LagoClient and the payment channel is a
 * scripted fake behind the real PaymentProvider seam — fakes exist only at the two remote
 * boundaries, never inside the money path.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);
const billingStore = createBillingStore(database);
const paymentStore = createPaymentStore(database);
const creditWriter = createCreditWriter(database);

const prefix = `b5294-${randomUUID().slice(0, 8)}`;
const deploymentKey = `openbot-deployment-${prefix}`;
const WEBHOOK_SIGNING_KEY = `wh-${prefix}`;

/**
 * The catalog's allowance per plan, already scaled ×100 (100 credits → 10_000 units). Codes are
 * derived from the RUN's random prefix, because the payment store's overlap guard is scoped to
 * one global `deployment_scope`: a second overlapping paid collection of ONE plan code on the
 * deployment is deliberately refused as a duplicate — within a run that guards between tests,
 * and across runs it fences a crashed predecessor's leftovers. Unique codes per test (and per
 * run) are the isolation; the guard itself is never bent.
 */
const PLAN_STEMS: Record<string, { priceCents: number; allowance: number }> = {
  pro: { priceCents: 8800, allowance: 10_000 },
  std: { priceCents: 8800, allowance: 10_000 },
  stdb: { priceCents: 8800, allowance: 10_000 },
  max: { priceCents: 12800, allowance: 30_000 },
  base: { priceCents: 8800, allowance: 10_000 },
  big: { priceCents: 12800, allowance: 30_000 },
  solo: { priceCents: 8800, allowance: 10_000 },
};

/** This run's purchasable code for a stem, e.g. `std-b5294-9f2a11`. */
const planCode = (stem: string) => `${stem}-${prefix}`;

const PLAN_ALLOWANCES: Record<string, number> = Object.fromEntries(
  Object.entries(PLAN_STEMS).map(([stem, entry]) => [
    planCode(stem),
    entry.allowance,
  ]),
);

/** The price the fake channel collects, per plan — the order snapshot's own numbers. */
const PLAN_PRICES: Record<string, number> = Object.fromEntries(
  Object.entries(PLAN_STEMS).map(([stem, entry]) => [
    planCode(stem),
    entry.priceCents,
  ]),
);

/** The full purchasable catalog, from the two tables above. */
const CATALOG = new Map(
  Object.keys(PLAN_ALLOWANCES).map((code) => [
    code,
    {
      amountCents: PLAN_PRICES[code],
      currency: "CNY" as const,
      periodMonths: 1,
    },
  ]),
);

/** The period the provider is currently running; the stub serves it on every read and create. */
const periods = {
  current: {
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-11-01T00:00:00.000Z",
  },
};

type StubSubscription = {
  externalCustomerId: string;
  externalSubscriptionId: string;
  planCode: string;
  status: "active" | "incomplete" | "canceled" | "terminated";
};

/** The provider stand-in: one switchable subscription list, the running period, plan facts. */
function lagoFetchStub() {
  const state = {
    list: [] as StubSubscription[],
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchStub = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");

    if (method === "GET" && url.pathname === "/api/v1/subscriptions") {
      const externalCustomerId =
        url.searchParams.get("external_customer_id") ?? "";
      const rows = state.list.filter(
        (subscription) =>
          subscription.externalCustomerId === externalCustomerId,
      );
      return json(200, {
        subscriptions: rows.map((subscription) => ({
          lago_id: `lago-${subscription.externalSubscriptionId}`,
          external_id: subscription.externalSubscriptionId,
          external_customer_id: subscription.externalCustomerId,
          plan_code: subscription.planCode,
          status: subscription.status,
          current_billing_period_started_at: periods.current.start,
          current_billing_period_ending_at: periods.current.end,
        })),
      });
    }
    if (method === "GET" && url.pathname.startsWith("/api/v1/subscriptions/")) {
      const externalId = decodeURIComponent(
        url.pathname.slice("/api/v1/subscriptions/".length),
      );
      const found = state.list.find(
        (subscription) => subscription.externalSubscriptionId === externalId,
      );
      if (!found) return json(404, { status: 404 });
      return json(200, {
        subscription: {
          lago_id: `lago-${found.externalSubscriptionId}`,
          external_id: found.externalSubscriptionId,
          external_customer_id: found.externalCustomerId,
          plan_code: found.planCode,
          status: found.status,
          current_billing_period_started_at: periods.current.start,
          current_billing_period_ending_at: periods.current.end,
        },
      });
    }
    if (method === "POST" && url.pathname === "/api/v1/subscriptions") {
      const body = JSON.parse(String(init?.body)) as {
        subscription: {
          external_customer_id: string;
          external_id: string;
          plan_code: string;
        };
      };
      const created: StubSubscription = {
        externalCustomerId: body.subscription.external_customer_id,
        externalSubscriptionId: body.subscription.external_id,
        planCode: body.subscription.plan_code,
        status: "active",
      };
      state.list = state.list.filter(
        (row) => row.externalSubscriptionId !== created.externalSubscriptionId,
      );
      state.list.push(created);
      return json(200, {
        subscription: {
          lago_id: `lago-${created.externalSubscriptionId}`,
          external_id: created.externalSubscriptionId,
          external_customer_id: created.externalCustomerId,
          plan_code: created.planCode,
          status: created.status,
          current_billing_period_started_at: periods.current.start,
          current_billing_period_ending_at: periods.current.end,
        },
      });
    }
    if (method === "GET" && url.pathname.startsWith("/api/v1/plans/")) {
      return json(200, {
        plan: {
          interval: "monthly",
          amount_cents: 8800,
          amount_currency: "CNY",
        },
      });
    }
    if (method === "GET" && url.pathname.startsWith("/api/v1/customers/")) {
      const externalId = decodeURIComponent(
        url.pathname.slice("/api/v1/customers/".length),
      );
      return json(200, { customer: { external_id: externalId, name: null } });
    }
    return json(404, { status: 404 });
  }) as typeof fetch;
  return { state, fetchStub };
}

const stub = lagoFetchStub();
const lagoClient = createLagoClient({
  baseUrl: "https://lago.stub.test",
  apiKey: `stub-${prefix}`,
  fetch: stub.fetchStub,
  assertTarget: async () => {},
});

const logLines: string[] = [];
// The renewal payout, wired through the SAME production factory src/index.ts wires.
const renewals = createPlanRenewalGrantor({
  creditsFor: (planCode: string) => PLAN_ALLOWANCES[planCode] ?? null,
  grantCredits: creditWriter.grantCredits,
});

const billingService = createBillingService({
  config: { externalCustomerKey: deploymentKey, webhookMode: "hmac" },
  client: lagoClient,
  store: billingStore,
  verifier: createWebhookVerifier({
    key: { mode: "hmac", key: WEBHOOK_SIGNING_KEY },
  }),
  planEntitlements: new Map(
    Object.keys(PLAN_ALLOWANCES).map((code) => [
      code,
      [{ code: "intelligence" }],
    ]),
  ),
  renewals,
  log: (message) => logLines.push(message),
});

/**
 * The plan-allowance payout, wired exactly as src/index.ts wires it: the account key arrives
 * FROM the payment service (the order owner's `payerKey`), the ledger key is `plan:<orderId>`.
 */
const grantor = {
  creditsFor: (planCode: string) => PLAN_ALLOWANCES[planCode] ?? null,
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
  readCurrentPeriodEnd: async () => new Date(periods.current.end),
};

/** The reconciler's catalog answer, the same arithmetic index.ts uses for the audit. */
const expectedPlanCredits = (planCode: string) =>
  PLAN_ALLOWANCES[planCode] ?? null;

function fakePaidProvider(
  id: PaymentProviderId,
  fact: PaymentFact,
  queryState: "pending" | "paid" = "pending",
): PaymentProvider {
  return {
    id,
    createSession: async () => ({
      checkout: { kind: "qrcode", payload: `qr-${id}` },
    }),
    queryPayment: async (outTradeNo: string) => ({
      outTradeNo,
      state: queryState,
      ...(queryState === "paid" ? fact : {}),
    }),
    closePayment: async () => {},
    verifyNotification: async () => ({ ok: true as const, fact }),
    successAck: { body: "success", contentType: "text/plain" },
  };
}

/** One purchase-to-activation run over the real services; returns the paid order's id. */
async function purchaseAndPay(user: PayerRef, tag: string, stem = "pro") {
  const channelTransactionId = `ch-${prefix}-${tag}`;
  const plan = planCode(stem);
  const amountCents = PLAN_PRICES[plan];
  if (amountCents === undefined) throw new Error(`no price for ${plan}`);
  const provider = fakePaidProvider("alipay", {
    outTradeNo: "",
    state: "paid",
    amountCents,
    currency: "CNY",
    channelTransactionId,
  });
  const payments = createPaymentService({
    providers: new Map([[provider.id, provider]]),
    store: paymentStore,
    catalog: CATALOG,
    notifyBaseUrl: "https://payments.openbot.example",
    orderTtlMinutes: 15,
    latePaymentWindowHours: 24,
    acceptForeignCurrency: false,
    lago: {
      getPlan: async (planCode) => {
        const result = await lagoClient.getPlan(planCode);
        return result.status === 200 && result.body
          ? {
              found: true,
              interval: result.body.interval,
              currency: result.body.currency ?? undefined,
            }
          : { found: false };
      },
      ensureSubscription: async (input) =>
        billingService.ensureSubscription(input),
      // 10.3: the activation path stamps ownership; wired by the assembly like index.ts.
      stampSubscriptionOwnership: (input) =>
        billingStore.stampSubscriptionOwnership(input),
    },
    externalCustomerKey: deploymentKey,
    // The single-subscription guard is 10.2's subject; these tests share one deployment key,
    // so the rig answers "not active" the same way the 10.2/10.3 rigs do.
    activePlanCode: async () => null,
    invalidateEntitlementCache: () =>
      billingService.invalidateEntitlementCache(deploymentKey),
    grantor,
    log: { warn: (message) => logLines.push(message) },
  });
  const { order } = await payments.createPurchase({
    planCode: plan,
    provider: "alipay",
    cycle: "monthly",
    createdBy: `${prefix}-${tag}`,
    ownerPayerRef: user,
  });
  provider.verifyNotification = async () => ({
    ok: true as const,
    fact: {
      outTradeNo: order.orderId,
      state: "paid" as const,
      amountCents,
      currency: "CNY",
      channelTransactionId,
    },
  });
  const outcome = await payments.handleCallback(
    "alipay",
    new Headers({ "content-type": "application/json" }),
    "{}",
  );
  return { orderId: order.orderId, outcome, payments, provider };
}

/** The same service shape as purchaseAndPay, for a caller that drives the sweep itself. */
async function buildPayments(_tag: string, provider: PaymentProvider) {
  return createPaymentService({
    providers: new Map([[provider.id, provider]]),
    store: paymentStore,
    catalog: CATALOG,
    notifyBaseUrl: "https://payments.openbot.example",
    orderTtlMinutes: 15,
    latePaymentWindowHours: 24,
    acceptForeignCurrency: false,
    lago: {
      getPlan: async (planCode) => {
        const result = await lagoClient.getPlan(planCode);
        return result.status === 200 && result.body
          ? {
              found: true,
              interval: result.body.interval,
              currency: result.body.currency ?? undefined,
            }
          : { found: false };
      },
      ensureSubscription: async (input) =>
        billingService.ensureSubscription(input),
      stampSubscriptionOwnership: (input) =>
        billingStore.stampSubscriptionOwnership(input),
    },
    externalCustomerKey: deploymentKey,
    activePlanCode: async () => null,
    invalidateEntitlementCache: () =>
      billingService.invalidateEntitlementCache(deploymentKey),
    grantor,
    log: { warn: (message) => logLines.push(message) },
  });
}

async function subscriptionRow(externalSubscriptionId: string) {
  const [row] = await database
    .select()
    .from(billingSubscriptions)
    .where(
      eq(billingSubscriptions.externalSubscriptionId, externalSubscriptionId),
    )
    .limit(1);
  return row;
}

/** Every plan-source grant of one account, in payout order (granted-at, then the unique key). */
async function planGrantsFor(accountKey: string) {
  return database
    .select({
      idempotencyKey: creditGrants.idempotencyKey,
      total: creditGrants.total,
      externalCustomerId: creditGrants.externalCustomerId,
      expiresAt: creditGrants.expiresAt,
    })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.source, "plan"),
        eq(creditGrants.externalCustomerId, accountKey),
      ),
    )
    .orderBy(creditGrants.grantedAt, creditGrants.idempotencyKey);
}

/** A signed subscription.* delivery in the provider's own wire shape. */
function signedDelivery(
  eventId: string,
  webhookType: string,
  object: Record<string, unknown>,
) {
  const body = JSON.stringify({
    webhook_type: webhookType,
    object_type: "subscription",
    organization_id: "lago-org-1",
    subscription: { lago_id: "lago-subscription-1", ...object },
  });
  return new Request("https://openbot.example.test/api/billing/webhooks/lago", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lago-signature": createHmac("sha256", WEBHOOK_SIGNING_KEY)
        .update(body)
        .digest("base64"),
      "x-lago-signature-algorithm": "hmac",
      "x-lago-unique-key": eventId,
    },
    body,
  });
}

afterEach(async () => {
  // The provider stand-in is module state: one test's live subscriptions and rolled-over period
  // must not answer the next test's sync/activation reads.
  stub.state.list = [];
  periods.current = {
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-11-01T00:00:00.000Z",
  };
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
    await paymentStore.cancelOrder(order.id, order.version);
  }
});

/** Production boot syncs the deployment customer before any purchase; tests seed the same floor. */
async function seedDeploymentCustomer() {
  await billingStore.upsertCustomer({
    externalId: deploymentKey,
    name: "OpenBot deployment test",
  });
}

afterAll(async () => {
  // Every account key and order carries the prefix, so one test's leftovers never answer another's.
  await database
    .delete(creditGrants)
    .where(like(creditGrants.externalCustomerId, `%${prefix}%`));
  await database
    .delete(billingSubscriptions)
    .where(like(billingSubscriptions.externalCustomerId, `%${prefix}%`));
  await database
    .delete(billingSubscriptions)
    .where(
      like(billingSubscriptions.externalSubscriptionId, `${deploymentKey}-%`),
    );
  await database
    .delete(paymentOrders)
    .where(like(paymentOrders.createdBy, `${prefix}%`));
  // The customer rows the rig's floors and grants implied, last: credit_grants cascades on the
  // customer, and the deployment/stranger keys all carry the prefix. A shared test database
  // stays as clean as this file found it — whole-table scans in other files must not count us.
  await database
    .delete(billingCustomers)
    .where(like(billingCustomers.externalId, `%${prefix}%`));
  await database.$client.close();
});

describe("10.5 plan credits into the purchaser's personal account", () => {
  test("a purchase pays its allowance into the buyer's account alone; nobody else's balance moves", async () => {
    await seedDeploymentCustomer();
    const buyer = `${prefix}-buyer`;
    const other = `${prefix}-other`;
    const buyerKey = payerKey({ kind: "personal", id: buyer });
    const otherKey = payerKey({ kind: "personal", id: other });
    const deploymentAccountKey = deploymentKey;

    // The balances BEFORE the purchase: both people start at zero, on their own keys.
    expect(await creditWriter.availableBalance(buyerKey)).toBe(0);
    expect(await creditWriter.availableBalance(otherKey)).toBe(0);

    const { orderId, outcome } = await purchaseAndPay(
      { kind: "personal", id: buyer },
      "buy",
    );
    expect(outcome).toEqual({ kind: "success" });
    const order = await paymentStore.readOrder(orderId);
    expect(order?.activationState).toBe("applied");

    // The buyer's balance rose by exactly the plan's allowance — the whole point of the ticket.
    expect(await creditWriter.availableBalance(buyerKey)).toBe(
      PLAN_ALLOWANCES[planCode("pro")],
    );

    // Nobody else moved: not the other person, not the deployment's legacy account.
    expect(await creditWriter.availableBalance(otherKey)).toBe(0);
    expect(await creditWriter.availableBalance(deploymentAccountKey)).toBe(0);
    expect(await planGrantsFor(otherKey)).toHaveLength(0);
    expect(await planGrantsFor(deploymentAccountKey)).toHaveLength(0);

    // The grant row itself: one, in the buyer's key, at the priced amount, expiring with the
    // provider's period — the allowance lapses when the subscription's period does.
    const grants = await planGrantsFor(buyerKey);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.idempotencyKey).toBe(`plan:${orderId}`);
    expect(grants[0]?.total).toBe(PLAN_ALLOWANCES[planCode("pro")]);
    expect(grants[0]?.expiresAt.toISOString()).toBe(periods.current.end);
  });

  test("a plan change re-purchase settles the whole difference inside the same account", async () => {
    await seedDeploymentCustomer();
    const buyer = `${prefix}-switcher`;
    const stranger = `${prefix}-bystander`;
    const buyerKey = payerKey({ kind: "personal", id: buyer });
    const strangerKey = payerKey({ kind: "personal", id: stranger });

    // Upgrade path as the product has it (one subscription at a time): the cheaper plan's
    // period runs out — the provider's record goes terminal — and the buyer purchases the
    // bigger plan. The "difference" is settled by the second order's own full allowance — and
    // every cent of both allowances stays in ONE account.
    const first = await purchaseAndPay(
      { kind: "personal", id: buyer },
      "down",
      "std",
    );
    expect(first.outcome).toEqual({ kind: "success" });
    // The provider terminates the expired std subscription; a terminal record bars nobody.
    stub.state.list = stub.state.list.map((row) =>
      row.externalSubscriptionId === `${deploymentKey}-${planCode("std")}`
        ? { ...row, status: "canceled" as const }
        : row,
    );
    const second = await purchaseAndPay(
      { kind: "personal", id: buyer },
      "up",
      "max",
    );
    expect(second.outcome).toEqual({ kind: "success" });
    expect(
      (await paymentStore.readOrder(second.orderId))?.activationState,
    ).toBe("applied");

    const buyerGrants = await planGrantsFor(buyerKey);
    expect(buyerGrants.map((grant) => grant.idempotencyKey)).toEqual([
      `plan:${first.orderId}`,
      `plan:${second.orderId}`,
    ]);
    expect(buyerGrants.map((grant) => grant.total)).toEqual([
      PLAN_ALLOWANCES[planCode("std")],
      PLAN_ALLOWANCES[planCode("max")],
    ]);
    // The buyer's balance is the sum of both allowances; the stranger's is still zero.
    expect(await creditWriter.availableBalance(buyerKey)).toBe(
      PLAN_ALLOWANCES[planCode("std")] + PLAN_ALLOWANCES[planCode("max")],
    );
    expect(await creditWriter.availableBalance(strangerKey)).toBe(0);

    // A stranger's own purchase never lands in (or takes from) the buyer's account: the new
    // order pays ITS owner, and the buyer's rows do not move by a single unit. (The stranger
    // buys their own plan code — one deployment runs one live entitlement at a time, so the
    // buyer's max subscription is terminated first, the way an expired plan hands over.)
    stub.state.list = stub.state.list.map((row) =>
      row.externalSubscriptionId === `${deploymentKey}-${planCode("max")}`
        ? { ...row, status: "canceled" as const }
        : row,
    );
    const strangerBuy = await purchaseAndPay(
      { kind: "personal", id: stranger },
      "stranger",
      "stdb",
    );
    expect(strangerBuy.outcome).toEqual({ kind: "success" });
    expect(
      (await planGrantsFor(strangerKey)).map((g) => g.idempotencyKey),
    ).toEqual([`plan:${strangerBuy.orderId}`]);
    expect((await planGrantsFor(buyerKey)).map((grant) => grant.total)).toEqual(
      [PLAN_ALLOWANCES[planCode("std")], PLAN_ALLOWANCES[planCode("max")]],
    );
    expect(await creditWriter.availableBalance(buyerKey)).toBe(
      PLAN_ALLOWANCES[planCode("std")] + PLAN_ALLOWANCES[planCode("max")],
    );

    // Reconciliation agrees, per account: no missing, no mis-accounted, no amount drift.
    const report = await createReconciler(
      database,
      deploymentKey,
      expectedPlanCredits,
    ).reconcile();
    const planFindings = report.findings.filter((finding) =>
      finding.code.startsWith("plan_grant_"),
    );
    expect(planFindings).toEqual([]);
  });

  test("a provider-side plan change renews the NEW plan's allowance into the SAME owner's account", async () => {
    await seedDeploymentCustomer();
    const owner = `${prefix}-upgrader`;
    const other = `${prefix}-outsider`;
    const ownerKey = payerKey({ kind: "personal", id: owner });
    const otherKey = payerKey({ kind: "personal", id: other });
    const { orderId } = await purchaseAndPay(
      { kind: "personal", id: owner },
      "base-buy",
      "base",
    );
    const subscriptionId = `${deploymentKey}-${planCode("base")}`;

    // The provider moves the subscription to the bigger plan and the period rolls over: the
    // upgrade's settlement is the NEXT period's allowance at the NEW plan's amount.
    periods.current = {
      start: "2026-11-01T00:00:00.000Z",
      end: "2026-12-01T00:00:00.000Z",
    };
    const row = await subscriptionRow(subscriptionId);
    expect(row).toBeDefined();
    stub.state.list = [
      {
        externalCustomerId: deploymentKey,
        externalSubscriptionId: subscriptionId,
        planCode: planCode("big"),
        status: "active",
      },
    ];
    const delivery = () =>
      signedDelivery(`evt-upgrade-${randomUUID()}`, "subscription.updated", {
        external_customer_id: deploymentKey,
        external_id: subscriptionId,
        plan_code: planCode("big"),
        status: "active",
      });
    const response = await billingService.handleWebhook(delivery());
    expect(response.status).toBe(200);

    // The projection row carries the new plan, keeps the SAME owner (a refresh never moves one),
    // and the renewal paid the NEW plan's allowance into the owner's account under the new
    // period's key — not into anyone else's, not at the old plan's amount.
    const upgraded = await subscriptionRow(subscriptionId);
    expect(upgraded?.planCode).toBe(planCode("big"));
    expect(upgraded?.ownerPayerKind).toBe("personal");
    expect(upgraded?.ownerPayerId).toBe(owner);
    const renewalKey = `plan-renewal:${subscriptionId}:${periods.current.start}`;
    const ownerGrants = await planGrantsFor(ownerKey);
    expect(ownerGrants.map((grant) => grant.idempotencyKey)).toEqual([
      `plan:${orderId}`,
      renewalKey,
    ]);
    expect(ownerGrants[1]?.total).toBe(PLAN_ALLOWANCES[planCode("big")]);
    expect(await planGrantsFor(otherKey)).toHaveLength(0);
    expect(await creditWriter.availableBalance(ownerKey)).toBe(
      PLAN_ALLOWANCES[planCode("base")] + PLAN_ALLOWANCES[planCode("big")],
    );
    expect(await creditWriter.availableBalance(otherKey)).toBe(0);
  });

  test("a repeated payout is suppressed: replayed callback and crash-retried activation land once", async () => {
    await seedDeploymentCustomer();
    const buyer = `${prefix}-replayer`;
    const buyerKey = payerKey({ kind: "personal", id: buyer });

    // A replayed callback answers success and inserts nothing: the first paid fact stands.
    const { orderId, outcome, provider } = await purchaseAndPay(
      { kind: "personal", id: buyer },
      "replay",
      "solo",
    );
    expect(outcome).toEqual({ kind: "success" });
    const replay = await (
      await buildPayments("replay", provider)
    ).handleCallback(
      "alipay",
      new Headers({ "content-type": "application/json" }),
      "{}",
    );
    expect(replay).toEqual({ kind: "success" });
    expect(await planGrantsFor(buyerKey)).toHaveLength(1);

    // The crash window between the grant and the applied marker: the payout row EXISTS (the
    // first activation committed it), the marker has been rolled back to pending, and the
    // sweep re-runs the whole activation. The ledger's unique `plan:<orderId>` key folds the
    // retry into the first insert — one grant, at the priced amount, and the activation lands.
    await database
      .update(paymentOrders)
      .set({ activationState: "pending" })
      .where(eq(paymentOrders.id, orderId));
    const sweeper = await buildPayments("crash-sweep", provider);
    await sweeper.sweepActivations();
    const afterCrash = await planGrantsFor(buyerKey);
    expect(afterCrash).toHaveLength(1);
    expect(afterCrash[0]?.idempotencyKey).toBe(`plan:${orderId}`);
    expect(afterCrash[0]?.total).toBe(PLAN_ALLOWANCES[planCode("solo")]);
    expect((await paymentStore.readOrder(orderId))?.activationState).toBe(
      "applied",
    );
    expect(await creditWriter.availableBalance(buyerKey)).toBe(
      PLAN_ALLOWANCES[planCode("solo")],
    );

    // And the account dimension of the audit bites: a grant sitting in ANYONE's account other
    // than the order owner's is a finding, not an aggregate — the invariant is per account.
    const stranger = `${prefix}-thief`;
    const strangerKey = payerKey({ kind: "personal", id: stranger });
    // The account floor the key's first grant would have laid (credit_grants FKs the customer).
    await database
      .insert(billingCustomers)
      .values({ externalId: strangerKey, name: null })
      .onConflictDoNothing({ target: billingCustomers.externalId });
    const [stray] = await database
      .update(creditGrants)
      .set({ externalCustomerId: strangerKey })
      .where(eq(creditGrants.idempotencyKey, `plan:${orderId}`))
      .returning({ id: creditGrants.id });
    expect(stray).toBeDefined();
    const report = await createReconciler(
      database,
      deploymentKey,
      expectedPlanCredits,
    ).reconcile();
    expect(
      report.findings.filter(
        (finding) => finding.code === "plan_grant_owner_mismatch",
      ),
    ).toHaveLength(1);
  });
});
