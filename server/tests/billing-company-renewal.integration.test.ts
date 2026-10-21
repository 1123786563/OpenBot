import { createHmac, randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createLagoClient } from "../src/billing/lago";
import type { PayerRef } from "../src/billing/payer";
import { payerKey } from "../src/billing/payer";
import { createPlanRenewalGrantor } from "../src/billing/plan-renewals";
import { createBillingService } from "../src/billing/service";
import { createBillingStore } from "../src/billing/store";
import { createWebhookVerifier } from "../src/billing/webhook-signature";
import { createDatabase, type Database } from "../src/db/client";
import {
  billingCustomers,
  billingSubscriptions,
} from "../src/db/schema/billing";
import { creditGrants } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * BP05 (#373): company subscription renewal and period correction, against the dedicated
 * PostgreSQL test database. The rules under test are the ticket's three clauses:
 *
 * 1. A renewal of the SAME period is granted exactly once, the NEXT period pays again, and
 *    the payout's idempotency domain includes the ACCOUNT (spec: 两类 ID 的唯一键和幂等域均
 *    包含 type，不能因字符串相同发生混用) — a personal subscription and a company
 *    subscription that share the provider's id string are two subscriptions, two rows, two
 *    grants, never one collapsed payout.
 * 2. No payout precedes reliable payment/period facts: a delivery without the provider's
 *    period grants nothing and moves no marker.
 * 3. Cancellation blocks future periods while the already-paid current period's grant stands
 *    to its locked expiry; and nothing a delivery or sync carries can rewrite the
 *    subscription's payer.
 *
 * The provider is a scripted fetch stub behind the real LagoClient; everything else — the
 * billing store, the billing service, the renewal grantor, the credit writer, the webhook
 * verifier — is production code over the real database.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);
const billingStore = createBillingStore(database);
const creditWriter = createCreditWriter(database);

const prefix = `bp05-${randomUUID().slice(0, 8)}`;
/** The personal deployment's customer and the company's own external customer. */
const deploymentKey = `openbot-deployment-${prefix}`;
const companyCustomerKey = `openbot-company-${prefix}`;
const WEBHOOK_SIGNING_KEY = `wh-${prefix}`;

/** Scaled units (×100): the plan's renewal allowance. */
const PLAN_CREDIT_UNITS = 10_000;

/**
 * Each test gets its OWN company and person: one payer's grants and rows must never answer
 * another test's assertions, and the accounts all share one credit ledger database.
 */
const companyOf = (tag: string): PayerRef => ({
  kind: "company",
  id: `tenant-${prefix}-${tag}`,
});
const personOf = (tag: string): PayerRef => ({
  kind: "personal",
  id: `user-${prefix}-${tag}`,
});

const periods = {
  current: {
    start: "2026-11-01T00:00:00.000Z",
    end: "2026-12-01T00:00:00.000Z",
  },
};

type StubSubscription = {
  externalCustomerId: string;
  externalSubscriptionId: string;
  planCode: string;
  status: "active" | "incomplete" | "canceled" | "terminated";
  periodStart?: string;
  periodEnd?: string;
};

/** The provider stand-in: one switchable subscription list, the running period, plan facts. */
function lagoFetchStub() {
  const state = { list: [] as StubSubscription[] };
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
    const wire = (subscription: StubSubscription) => ({
      lago_id: `lago-${subscription.externalSubscriptionId}`,
      external_id: subscription.externalSubscriptionId,
      external_customer_id: subscription.externalCustomerId,
      plan_code: subscription.planCode,
      status: subscription.status,
      ...(subscription.periodStart === undefined
        ? {}
        : { current_billing_period_started_at: subscription.periodStart }),
      ...(subscription.periodEnd === undefined
        ? {}
        : { current_billing_period_ending_at: subscription.periodEnd }),
    });
    if (method === "GET" && url.pathname === "/api/v1/subscriptions") {
      const externalCustomerId =
        url.searchParams.get("external_customer_id") ?? "";
      return json(200, {
        subscriptions: state.list
          .filter((row) => row.externalCustomerId === externalCustomerId)
          .map(wire),
      });
    }
    if (method === "GET" && url.pathname.startsWith("/api/v1/subscriptions/")) {
      const externalId = decodeURIComponent(
        url.pathname.slice("/api/v1/subscriptions/".length),
      );
      const found = state.list.find(
        (row) => row.externalSubscriptionId === externalId,
      );
      if (!found) return json(404, { status: 404 });
      return json(200, { subscription: wire(found) });
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
        periodStart: periods.current.start,
        periodEnd: periods.current.end,
      };
      state.list = state.list.filter(
        (row) =>
          !(
            row.externalCustomerId === created.externalCustomerId &&
            row.externalSubscriptionId === created.externalSubscriptionId
          ),
      );
      state.list.push(created);
      return json(200, { subscription: wire(created) });
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

const renewals = createPlanRenewalGrantor({
  creditsFor: (planCode) =>
    planCode.startsWith("pro") ? PLAN_CREDIT_UNITS : null,
  grantCredits: creditWriter.grantCredits,
});

const billingService = createBillingService({
  config: { externalCustomerKey: deploymentKey, webhookMode: "hmac" },
  client: lagoClient,
  store: billingStore,
  verifier: createWebhookVerifier({
    key: { mode: "hmac", key: WEBHOOK_SIGNING_KEY },
  }),
  planEntitlements: new Map(),
  renewals,
  log: (message) => console.log(`[bill] ${message}`),
});

/** Seed the customer floor rows and one owned subscription, the activation path's result. */
async function seedOwnedSubscription(input: {
  externalCustomerId: string;
  externalSubscriptionId: string;
  planCode: string;
  owner: PayerRef;
}) {
  await billingStore.ensureCustomerRow({
    externalId: input.externalCustomerId,
  });
  await billingStore.upsertSubscription({
    externalCustomerId: input.externalCustomerId,
    externalSubscriptionId: input.externalSubscriptionId,
    planCode: input.planCode,
    status: "active",
  });
  stub.state.list.push({
    externalCustomerId: input.externalCustomerId,
    externalSubscriptionId: input.externalSubscriptionId,
    planCode: input.planCode,
    status: "active",
    periodStart: periods.current.start,
    periodEnd: periods.current.end,
  });
  // The activation path stamps the period the ORDER paid — October here — so the renewal
  // pass has an uncovered CURRENT period (November) to pay, exactly as a real first period
  // hands over to the second.
  await billingStore.stampSubscriptionOwnership({
    externalCustomerId: input.externalCustomerId,
    externalSubscriptionId: input.externalSubscriptionId,
    ownerPayerKind: input.owner.kind,
    ownerPayerId: input.owner.id,
    allowancePeriodStart: new Date("2026-10-01T00:00:00.000Z"),
    allowancePeriodEnd: new Date(periods.current.start),
  });
}

/** A signed subscription.* delivery in the provider's own wire shape, for one customer. */
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

/** A renewal notification for one subscription under one customer, with the running period. */
function renewalDelivery(input: {
  externalCustomerId: string;
  externalSubscriptionId: string;
  planCode: string;
  status?: StubSubscription["status"];
}) {
  return signedDelivery(`evt-bp05-${randomUUID()}`, "subscription.updated", {
    external_customer_id: input.externalCustomerId,
    external_id: input.externalSubscriptionId,
    plan_code: input.planCode,
    status: input.status ?? "active",
    current_billing_period_started_at: periods.current.start,
    current_billing_period_ending_at: periods.current.end,
  });
}

async function planGrantsFor(accountKey: string) {
  return database
    .select({
      idempotencyKey: creditGrants.idempotencyKey,
      total: creditGrants.total,
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

async function subscriptionRow(input: {
  externalCustomerId: string;
  externalSubscriptionId: string;
}) {
  const [row] = await database
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.externalCustomerId, input.externalCustomerId),
        eq(
          billingSubscriptions.externalSubscriptionId,
          input.externalSubscriptionId,
        ),
      ),
    )
    .limit(1);
  return row;
}

afterEach(() => {
  stub.state.list = [];
  periods.current = {
    start: "2026-11-01T00:00:00.000Z",
    end: "2026-12-01T00:00:00.000Z",
  };
});

afterAll(async () => {
  await database
    .delete(creditGrants)
    .where(like(creditGrants.externalCustomerId, `%${prefix}%`));
  await database
    .delete(billingSubscriptions)
    .where(like(billingSubscriptions.externalCustomerId, `%${prefix}%`));
  await database
    .delete(billingCustomers)
    .where(like(billingCustomers.externalId, `%${prefix}%`));
  await database.$client.close();
});

describe("BP05: company subscription renewal and period correction", () => {
  test("a company renewal pays the company account once per period; the next period pays again", async () => {
    const company = companyOf("renewal");
    const subscriptionId = `${companyCustomerKey}-renewal-pro`;
    await seedOwnedSubscription({
      externalCustomerId: companyCustomerKey,
      externalSubscriptionId: subscriptionId,
      planCode: "pro",
      owner: company,
    });
    const companyKey = payerKey(company);

    const first = await billingService.handleWebhook(
      renewalDelivery({
        externalCustomerId: companyCustomerKey,
        externalSubscriptionId: subscriptionId,
        planCode: "pro",
      }),
    );
    expect(first.status).toBe(200);

    // The renewal landed in the COMPANY account, under the account-scoped renewal key.
    const afterFirst = await planGrantsFor(companyKey);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.idempotencyKey).toBe(
      `plan-renewal:${companyKey}:${subscriptionId}:${periods.current.start}`,
    );
    expect(afterFirst[0]?.total).toBe(PLAN_CREDIT_UNITS);
    expect(afterFirst[0]?.expiresAt?.toISOString()).toBe(periods.current.end);

    // A duplicate notification of the SAME period (fresh event identity, same facts) pays once.
    const second = await billingService.handleWebhook(
      renewalDelivery({
        externalCustomerId: companyCustomerKey,
        externalSubscriptionId: subscriptionId,
        planCode: "pro",
      }),
    );
    expect(second.status).toBe(200);
    expect(await planGrantsFor(companyKey)).toHaveLength(1);

    // The NEXT period is a new payout, not a replay.
    periods.current = {
      start: "2026-12-01T00:00:00.000Z",
      end: "2027-01-01T00:00:00.000Z",
    };
    stub.state.list = stub.state.list.map((row) => ({
      ...row,
      periodStart: periods.current.start,
      periodEnd: periods.current.end,
    }));
    const third = await billingService.handleWebhook(
      renewalDelivery({
        externalCustomerId: companyCustomerKey,
        externalSubscriptionId: subscriptionId,
        planCode: "pro",
      }),
    );
    expect(third.status).toBe(200);
    const afterThird = await planGrantsFor(companyKey);
    expect(afterThird.map((grant) => grant.idempotencyKey)).toEqual([
      `plan-renewal:${companyKey}:${subscriptionId}:2026-11-01T00:00:00.000Z`,
      `plan-renewal:${companyKey}:${subscriptionId}:2026-12-01T00:00:00.000Z`,
    ]);
  });

  test("personal and company subscriptions sharing the id string never collapse into one payout", async () => {
    // The provider namespaces external ids per customer, so the same string can be a personal
    // deployment's subscription and a company's subscription at once. Locally they are two
    // rows under two customers with two owners — and two payouts, each in its own account.
    const person = personOf("shared");
    const company = companyOf("shared");
    const shared = `shared-sub-${prefix}`;
    await seedOwnedSubscription({
      externalCustomerId: deploymentKey,
      externalSubscriptionId: shared,
      planCode: "pro",
      owner: person,
    });
    await seedOwnedSubscription({
      externalCustomerId: companyCustomerKey,
      externalSubscriptionId: shared,
      planCode: "pro",
      owner: company,
    });

    const personal = await billingService.handleWebhook(
      renewalDelivery({
        externalCustomerId: deploymentKey,
        externalSubscriptionId: shared,
        planCode: "pro",
      }),
    );
    expect(personal.status).toBe(200);
    const companyDelivery = await billingService.handleWebhook(
      renewalDelivery({
        externalCustomerId: companyCustomerKey,
        externalSubscriptionId: shared,
        planCode: "pro",
      }),
    );
    expect(companyDelivery.status).toBe(200);

    // Both rows still exist, each under its own customer with its own owner.
    const personalRow = await subscriptionRow({
      externalCustomerId: deploymentKey,
      externalSubscriptionId: shared,
    });
    const companyRow = await subscriptionRow({
      externalCustomerId: companyCustomerKey,
      externalSubscriptionId: shared,
    });
    expect(personalRow?.ownerPayerKind).toBe("personal");
    expect(companyRow?.ownerPayerKind).toBe("company");

    // Both accounts hold this period's payout; neither consumed the other's.
    const personalGrants = await planGrantsFor(payerKey(person));
    const companyGrants = await planGrantsFor(payerKey(company));
    expect(personalGrants).toHaveLength(1);
    expect(companyGrants).toHaveLength(1);
    expect(personalGrants[0]?.idempotencyKey).not.toBe(
      companyGrants[0]?.idempotencyKey,
    );
  });

  test("the sweep pays a customer only from an answer naming that customer, never a bare-id collision (F7)", async () => {
    // The sweep asks the provider by BARE subscription id, and under this ticket's own
    // premise the same string can be live under two customers at once. The stub's
    // bare-id GET answers whichever record it holds first, so seeding the company's
    // record first makes it the ONLY answer either row can get: the company's row is
    // answered with its own record, the deployment's row with someone else's.
    const person = personOf("sweep-collision");
    const company = companyOf("sweep-collision");
    const shared = `shared-sweep-${prefix}`;
    await seedOwnedSubscription({
      externalCustomerId: companyCustomerKey,
      externalSubscriptionId: shared,
      planCode: "pro",
      owner: company,
    });
    await seedOwnedSubscription({
      externalCustomerId: deploymentKey,
      externalSubscriptionId: shared,
      planCode: "pro",
      owner: person,
    });
    // The company's provider period runs a month AHEAD of the deployment's own record:
    // paying the deployment from the collision would cover a period its subscription
    // never ran, in someone else's calendar.
    const companyPeriod = {
      start: "2026-12-01T00:00:00.000Z",
      end: "2027-01-01T00:00:00.000Z",
    };
    stub.state.list = stub.state.list.map((row) =>
      row.externalCustomerId === companyCustomerKey &&
      row.externalSubscriptionId === shared
        ? { ...row, periodStart: companyPeriod.start, periodEnd: companyPeriod.end }
        : row,
    );

    await billingService.sweepRenewals();

    // The company was answered with its own record: its period paid, in its account.
    const companyGrants = await planGrantsFor(payerKey(company));
    expect(companyGrants.map((grant) => grant.idempotencyKey)).toEqual([
      `plan-renewal:${payerKey(company)}:${shared}:${companyPeriod.start}`,
    ]);
    // The deployment was answered with the company's record — undeterminable, so nothing
    // paid and nothing advanced: no grant for ANY period, the marker still at October.
    const personalGrants = await planGrantsFor(payerKey(person));
    expect(personalGrants).toHaveLength(0);
    const personalRow = await subscriptionRow({
      externalCustomerId: deploymentKey,
      externalSubscriptionId: shared,
    });
    expect(personalRow?.allowancePeriodStart?.toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  test("the entitlement read shows no subscription facts from a bare-id collision (F9)", async () => {
    // The courtesy subscription read beside the projection is also a bare-id GET: an
    // answer naming another customer is not this row's subscription, so it must not show
    // up as the caller's running period. The context drops to null, never to someone
    // else's facts.
    const person = personOf("ent-collision");
    const company = companyOf("ent-collision");
    // A customer of this test's own, so the read has exactly one row to choose — the
    // deployment key carries earlier tests' subscriptions in this shared database.
    const entCustomerKey = `openbot-ent-${prefix}`;
    const shared = `shared-ent-${prefix}`;
    await seedOwnedSubscription({
      externalCustomerId: companyCustomerKey,
      externalSubscriptionId: shared,
      planCode: "pro",
      owner: company,
    });
    await seedOwnedSubscription({
      externalCustomerId: entCustomerKey,
      externalSubscriptionId: shared,
      planCode: "pro",
      owner: person,
    });
    stub.state.list = stub.state.list.map((row) =>
      row.externalCustomerId === companyCustomerKey &&
      row.externalSubscriptionId === shared
        ? {
            ...row,
            periodStart: "2026-12-01T00:00:00.000Z",
            periodEnd: "2027-01-01T00:00:00.000Z",
          }
        : row,
    );

    const entitlements = await billingService.entitlements(entCustomerKey);

    // The projection's own answer stands — the customer is active — but the provider's
    // courtesy context is absent rather than another customer's December period.
    expect(entitlements.active).toBe(true);
    expect(entitlements.subscription).toBeNull();
  });

  test("a renewal without the provider's period facts pays nothing and moves no marker", async () => {
    const company = companyOf("noise");
    const subscriptionId = `${companyCustomerKey}-noise-pro`;
    await seedOwnedSubscription({
      externalCustomerId: companyCustomerKey,
      externalSubscriptionId: subscriptionId,
      planCode: "pro",
      owner: company,
    });
    stub.state.list = stub.state.list.map((row) => {
      const { periodStart: _drop, periodEnd: _drop2, ...rest } = row;
      return rest;
    });

    // The delivery names the subscription but carries no period facts: nothing is known to
    // be collected, so nothing is prepaid — no grant, no marker movement.
    const response = await billingService.handleWebhook(
      signedDelivery(`evt-bp05-${randomUUID()}`, "subscription.updated", {
        external_customer_id: companyCustomerKey,
        external_id: subscriptionId,
        plan_code: "pro",
        status: "active",
      }),
    );
    expect(response.status).toBe(200);
    expect(await planGrantsFor(payerKey(company))).toHaveLength(0);
    const row = await subscriptionRow({
      externalCustomerId: companyCustomerKey,
      externalSubscriptionId: subscriptionId,
    });
    // The seed stamped the PAID period (October); an unknown-facts delivery must not have
    // re-stamped or advanced anything.
    expect(row?.allowancePeriodStart?.toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  test("cancellation blocks future periods; the paid current period's grant stands to its expiry", async () => {
    const company = companyOf("cancel");
    const subscriptionId = `${companyCustomerKey}-cancel-pro`;
    await seedOwnedSubscription({
      externalCustomerId: companyCustomerKey,
      externalSubscriptionId: subscriptionId,
      planCode: "pro",
      owner: company,
    });
    const companyKey = payerKey(company);

    // November was paid and granted.
    const paid = await billingService.handleWebhook(
      renewalDelivery({
        externalCustomerId: companyCustomerKey,
        externalSubscriptionId: subscriptionId,
        planCode: "pro",
      }),
    );
    expect(paid.status).toBe(200);
    expect(await planGrantsFor(companyKey)).toHaveLength(1);

    // The subscription is canceled and the provider has rolled to December.
    stub.state.list = stub.state.list.map((row) =>
      row.externalSubscriptionId === subscriptionId
        ? { ...row, status: "canceled" as const }
        : row,
    );
    periods.current = {
      start: "2026-12-01T00:00:00.000Z",
      end: "2027-01-01T00:00:00.000Z",
    };
    const canceled = await billingService.handleWebhook(
      renewalDelivery({
        externalCustomerId: companyCustomerKey,
        externalSubscriptionId: subscriptionId,
        planCode: "pro",
        status: "canceled",
      }),
    );
    expect(canceled.status).toBe(200);

    // No future period is paid: the December grant does not exist…
    const grants = await planGrantsFor(companyKey);
    expect(grants).toHaveLength(1);
    // …and the paid November grant is retained to its locked expiry, not clawed back.
    expect(grants[0]?.expiresAt?.toISOString()).toBe(
      "2026-12-01T00:00:00.000Z",
    );
    expect(grants[0]?.total).toBe(PLAN_CREDIT_UNITS);
  });

  test("a renewal delivery cannot rewrite the subscription's payer", async () => {
    const company = companyOf("owner");
    const person = personOf("owner");
    const subscriptionId = `${companyCustomerKey}-owner-pro`;
    await seedOwnedSubscription({
      externalCustomerId: companyCustomerKey,
      externalSubscriptionId: subscriptionId,
      planCode: "pro",
      owner: company,
    });

    // A full refresh delivery for the company's customer: the projection refresh and the
    // renewal pass both run; neither may move the owner columns.
    const response = await billingService.handleWebhook(
      renewalDelivery({
        externalCustomerId: companyCustomerKey,
        externalSubscriptionId: subscriptionId,
        planCode: "pro",
      }),
    );
    expect(response.status).toBe(200);
    const row = await subscriptionRow({
      externalCustomerId: companyCustomerKey,
      externalSubscriptionId: subscriptionId,
    });
    expect(row?.ownerPayerKind).toBe("company");
    expect(row?.ownerPayerId).toBe(company.id);
    // And the payout still landed in the company's account, not any other.
    expect(await planGrantsFor(payerKey(company))).toHaveLength(1);
    expect(await planGrantsFor(payerKey(person))).toHaveLength(0);
  });
});
