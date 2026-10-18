import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createCredits } from "../src/billing/credits";
import { createCreditWriter } from "../src/billing/credits-writer";
import { payerKey } from "../src/billing/payer";
import { resolvePayerForPersonalUser } from "../src/billing/payer-personal";
import { createBillingCreditRoutes } from "../src/billing/routes";
import { createDatabase, type Database } from "../src/db/client";
import { creditGrants } from "../src/db/schema/credits";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Ticket 02.6 — the personal credit read, against the dedicated PostgreSQL test database.
 *
 * The person-facing credit reads answer ONE account: the authenticated subject's own personal
 * payer, resolved server-side from the session (02.4's pure resolution). The acceptance criteria
 * live here:
 *
 *   AC-1  the user reads their own available, consumed and expired amounts — and `available`
 *         is the gate's own figure, the same spendable capacity the writer admits against;
 *   AC-2  a request naming another account is refused with the unified error structure and
 *         carries none of anyone's balance data;
 *   AC-3  the response names the account type and carries the pending-settlement placeholders,
 *         constant zeros explicitly marked not-enabled until group 06 lands;
 *   AC-4  the read path performs no database writes — resolution is pure and every query is a
 *         SELECT, proven by a recording database that counts mutating calls.
 *
 * The fixture seeds through the real writer (grants, a hold, a settlement) so the reader is
 * measured against the facts admission itself wrote, never hand-built rows — except the expired
 * grant's consumed part, which only the clock can produce and one commented UPDATE sets.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const run = randomUUID().slice(0, 8);

const SELF: AuthenticatedActor = {
  id: `user-self-${run}`,
  email: "self@openbot.test",
  role: "user",
};
const STRANGER: AuthenticatedActor = {
  id: `user-stranger-${run}`,
  email: "stranger@openbot.test",
  role: "user",
};

const selfKey = payerKey(resolvePayerForPersonalUser(SELF));
const strangerKey = payerKey(resolvePayerForPersonalUser(STRANGER));
/** The deployment's own key — the account these reads must STOP answering. */
const deploymentKey = `openbot-deployment-026-${run}`;

/** The numbers the fixture lays down, in scaled units (×100), for the assertions to reconcile. */
const expected = {
  /** live plan 100.00, untouched but for the hold below. */
  available: 106.37,
  /** live promo consumed 23.63 + expired grant consumed 10.00. */
  consumed: 33.63,
  /** expired grant lapsed 30.00 − 10.00. */
  expired: 20,
  /** the open hold against the plan grant. */
  held: 20,
};

async function seed() {
  // Live plan grant: 100.00, expires in 25 h — outside the 24 h "expiring soon" cue.
  await writer.grantCredits({
    externalCustomerId: selfKey,
    source: "plan",
    totalCents: 10_000,
    expiresAt: new Date(Date.now() + 25 * 3_600_000),
    idempotencyKey: `026-live-plan-${run}`,
  });
  // Live promo grant: 50.00, 23.63 of it consumed through a real reserve → settle.
  await writer.grantCredits({
    externalCustomerId: selfKey,
    source: "promo",
    totalCents: 5_000,
    expiresAt: new Date(Date.now() + 48 * 3_600_000),
    reason: "fixture promo",
    idempotencyKey: `026-live-promo-${run}`,
  });
  const consumed = await writer.reserveCredits({
    externalCustomerId: selfKey,
    idempotencyKey: `026-consumed-${run}`,
    maximumCents: 2_363,
    expiresAt: new Date(Date.now() + 60_000),
  });
  if (!consumed.reserved)
    throw new Error("fixture: the consumed hold should fit");
  await writer.settleReservation({
    reservationId: consumed.reservationId,
    actual: { numerator: 2363n, denominator: 1n },
    title: "fixture call",
  });
  // An open hold: 20.00 still reserved, so available drops and held rises.
  const held = await writer.reserveCredits({
    externalCustomerId: selfKey,
    idempotencyKey: `026-held-${run}`,
    maximumCents: 2_000,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  if (!held.reserved) throw new Error("fixture: the open hold should fit");
  // Expired grant: 30.00 total, 10.00 of it was consumed before it lapsed. The writer can only
  // move `used` through a live hold, and the clock cannot be turned back, so the fixture states
  // the consumed part directly — this read's job is to report the LAPSED remainder, not the total.
  await writer.grantCredits({
    externalCustomerId: selfKey,
    source: "signin",
    totalCents: 3_000,
    expiresAt: new Date(Date.now() - 3_600_000),
    idempotencyKey: `026-expired-${run}`,
  });
  await database
    .update(creditGrants)
    .set({ used: 1_000 })
    .where(
      and(
        eq(creditGrants.externalCustomerId, selfKey),
        eq(creditGrants.idempotencyKey, `026-expired-${run}`),
      ),
    );

  // The stranger holds a real balance: the refusals below must not depend on the foreign account
  // being empty, and the self reads must never see this 99.00.
  await writer.grantCredits({
    externalCustomerId: strangerKey,
    source: "promo",
    totalCents: 9_900,
    expiresAt: new Date(Date.now() + 48 * 3_600_000),
    reason: "cross-account bait",
    idempotencyKey: `026-bait-${run}`,
  });
  // The deployment's own key holds a balance too: after this ticket a signed-in read answers the
  // person, not the deployment, so this 40.00 must not appear in any response below.
  await writer.grantCredits({
    externalCustomerId: deploymentKey,
    source: "promo",
    totalCents: 4_000,
    expiresAt: new Date(Date.now() + 48 * 3_600_000),
    reason: "deployment account",
    idempotencyKey: `026-deployment-${run}`,
  });
}

const createdKeys = [selfKey, strangerKey, deploymentKey];
beforeAll(seed);
afterAll(async () => {
  await database.execute(
    sql`DELETE FROM credit_reservation_allocations WHERE reservation_id IN (SELECT id FROM credit_reservations WHERE external_customer_id IN (${sql.join(
      createdKeys.map((key) => sql`${key}`),
      sql`, `,
    )}))`,
  );
  await database.execute(
    sql`DELETE FROM credit_reservations WHERE external_customer_id IN (${sql.join(
      createdKeys.map((key) => sql`${key}`),
      sql`, `,
    )})`,
  );
  await database.execute(
    sql`DELETE FROM credit_charge_remainders WHERE external_customer_id IN (${sql.join(
      createdKeys.map((key) => sql`${key}`),
      sql`, `,
    )})`,
  );
  await database.execute(
    sql`DELETE FROM credit_ledger WHERE external_customer_id IN (${sql.join(
      createdKeys.map((key) => sql`${key}`),
      sql`, `,
    )})`,
  );
  await database.execute(
    sql`DELETE FROM credit_grants WHERE external_customer_id IN (${sql.join(
      createdKeys.map((key) => sql`${key}`),
      sql`, `,
    )})`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id IN (${sql.join(
      createdKeys.map((key) => sql`${key}`),
      sql`, `,
    )})`,
  );
  await database.$client.close();
});

/** The session guard as a switch: the given actor, or nobody. */
function requireUserAs(
  actor: AuthenticatedActor | undefined,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    if (!actor) {
      return context.json({ error: "Authentication required." }, 401);
    }
    context.set("actor", actor);
    await next();
  };
}

function app(
  actor: AuthenticatedActor | undefined,
  databaseOverride?: Database,
) {
  const credits = createCredits({
    database: databaseOverride ?? database,
    externalCustomerKey: deploymentKey,
    catalog: new Map(),
  });
  return new Hono<{ Variables: AppVariables }>().route(
    "/api/billing",
    createBillingCreditRoutes({ credits, requireUser: requireUserAs(actor) }),
  );
}

/**
 * A database that counts every mutating call on its way through: the read path must make none.
 * `execute` is recorded separately — the reader's selects carry raw fragments inside drizzle's
 * select builder, which is not a mutation, so only the four write doors fail the assertion.
 */
function writeCountingDatabase(target: Database) {
  const writes: string[] = [];
  const proxy = new Proxy(target, {
    get(object, property) {
      if (
        property === "insert" ||
        property === "update" ||
        property === "delete"
      ) {
        return (...args: unknown[]) => {
          writes.push(property);
          return (target[property] as (...callArguments: unknown[]) => unknown)(
            ...args,
          );
        };
      }
      if (property === "transaction") {
        return (scope: unknown) => {
          writes.push("transaction");
          return target.transaction(
            scope as Parameters<Database["transaction"]>[0],
          );
        };
      }
      const value = Reflect.get(object, property, target);
      return typeof value === "function"
        ? (value as (...callArguments: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { writes, database: proxy as Database };
}

type PersonalBalanceResponse = {
  accountType: string;
  available: number;
  consumed: number;
  expired: number;
  held: number;
  grants: {
    id: string;
    source: string;
    total: number;
    used: number;
    remaining: number;
    status: string;
    expiringSoon: boolean;
  }[];
  pendingSettlement: {
    enabled: boolean;
    available: number;
    consumed: number;
    expired: number;
    reserved: number;
    unknown: number;
    reservations: Array<{
      id: string;
      status: string;
      maximum: number;
      charged: number | null;
      released: number | null;
      provider: string | null;
      model: string | null;
      capability: string | null;
      botId: string | null;
      botName: string | null;
      unknownReason: string | null;
      releaseReason: string | null;
      createdAt: string;
      expiresAt: string;
      terminalAt: string | null;
    }>;
  };
};

describe("GET /api/billing/credits/summary answers the signed-in user's own account", () => {
  test("the balance carries available, consumed, expired and held — the gate's own figures", async () => {
    const response = await app(SELF).request("/api/billing/credits/summary");
    expect(response.status).toBe(200);
    const body = (await response.json()) as PersonalBalanceResponse;
    expect(body.accountType).toBe("personal");
    expect(body.available).toBeCloseTo(expected.available, 2);
    expect(body.consumed).toBeCloseTo(expected.consumed, 2);
    expect(body.expired).toBeCloseTo(expected.expired, 2);
    expect(body.held).toBeCloseTo(expected.held, 2);
    // The page and the gate agree to the unit: available is what admission would admit.
    const spendable = await writer.availableBalance(selfKey);
    expect(body.available).toBeCloseTo(spendable / 100, 2);
  });

  test("every grant of the account appears with its derived life", async () => {
    const response = await app(SELF).request("/api/billing/credits/summary");
    const body = (await response.json()) as PersonalBalanceResponse;
    const bySource = Object.fromEntries(
      body.grants.map((grant) => [grant.source, grant]),
    );
    expect(body.grants).toHaveLength(3);
    // The consumed settlement drew earliest-expiry-first, so it landed on the plan grant; the
    // entries report total/used/remaining per grant (`remaining` is the grant's own
    // total − used, holds live in the summary's `held`).
    expect(bySource.plan).toMatchObject({
      status: "active",
      total: 100,
      used: 23.63,
      remaining: 76.37,
    });
    expect(bySource.promo).toMatchObject({
      status: "active",
      total: 50,
      used: 0,
      remaining: 50,
    });
    expect(bySource.signin).toMatchObject({
      status: "expired",
      total: 30,
      used: 10,
      remaining: 20,
    });
    // No grant lives inside the 24-hour cue in this fixture.
    expect(body.grants.every((grant) => grant.expiringSoon === false)).toBe(
      true,
    );
  });

  test("the pending-settlement answer is live: the open hold pending, the settled one consumed", async () => {
    const response = await app(SELF).request("/api/billing/credits/summary");
    const body = (await response.json()) as PersonalBalanceResponse;
    // Group 06's gate is on (06.12): the field names 02.6 fixed now carry real data. The
    // fixture's open 20.00 hold is the pending quota (plain reserved, nothing unknown), and
    // the 23.63 settlement is the consumed figure — the ledger's own number.
    expect(body.pendingSettlement).toMatchObject({
      enabled: true,
      available: 20,
      consumed: 23.63,
      expired: 0,
      reserved: 20,
      unknown: 0,
    });
    expect(body.pendingSettlement.reservations).toHaveLength(2);
    const statuses = Object.fromEntries(
      body.pendingSettlement.reservations.map((row) => [row.status, row]),
    );
    expect(statuses.reserved?.maximum).toBe(20);
    expect(statuses.reserved?.charged).toBeNull();
    expect(statuses.settled?.charged).toBeCloseTo(23.63, 2);
  });

  test("the response structure is exactly the ticket's contract — key sets and types", async () => {
    const response = await app(SELF).request("/api/billing/credits/summary");
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "accountType",
      "available",
      "consumed",
      "expired",
      "grants",
      "held",
      "pendingSettlement",
    ]);
    expect(Object.keys(body.pendingSettlement as object).sort()).toEqual([
      "available",
      "consumed",
      "enabled",
      "expired",
      "reserved",
      "reservations",
      "unknown",
    ]);
    expect(Object.keys(body.grants as object[])).toHaveLength(3);
    expect(
      Object.keys((body.grants as Record<string, unknown>[])[0]).sort(),
    ).toEqual([
      "expiresAt",
      "expiringSoon",
      "grantedAt",
      "id",
      "reason",
      "remaining",
      "source",
      "status",
      "total",
      "used",
    ]);
    expect(typeof body.available).toBe("number");
    expect(typeof body.accountType).toBe("string");
  });

  test("the reads answer the person, not the deployment key", async () => {
    // The deployment account holds 40.00; none of it may surface as the user's balance.
    const response = await app(SELF).request("/api/billing/credits/summary");
    const body = (await response.json()) as PersonalBalanceResponse;
    expect(body.available).toBeCloseTo(expected.available, 2);

    const grants = await app(SELF).request("/api/billing/credits/grants");
    const grantsBody = (await grants.json()) as {
      grants: { reason: string | null }[];
    };
    expect(
      grantsBody.grants.some((grant) => grant.reason === "deployment account"),
    ).toBe(false);

    const consumption = await app(SELF).request(
      "/api/billing/credits/consumption?page=1",
    );
    const consumptionBody = (await consumption.json()) as {
      entries: { title: string }[];
    };
    expect(consumptionBody.entries).toHaveLength(1);
    expect(consumptionBody.entries[0].title).toBe("fixture call");
  });
});

describe("a request naming another account is refused with no balance data", () => {
  const reads = [
    "/api/billing/credits/summary",
    "/api/billing/credits/grants",
    "/api/billing/credits/consumption?page=1",
  ];

  test("another user's id is refused on every credit read, with the unified error body", async () => {
    for (const path of reads) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await app(SELF).request(
        `${path}${separator}userId=${STRANGER.id}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      // The unified structure: the refusal sentence and NOTHING else — no balance, no account,
      // not even an empty echo of the named account.
      expect(Object.keys(body).sort()).toEqual(["error"]);
      expect(JSON.stringify(body)).not.toContain(STRANGER.id);
      expect(JSON.stringify(body)).not.toContain("99");
    }
  });

  test("every account-identity key is refused, on any casing, without reading anything", async () => {
    for (const key of [
      "userId",
      "externalCustomerId",
      "payerId",
      "accountId",
      "companyId",
      "tenantId",
      "UserID",
      "ExternalCustomerId",
    ]) {
      for (const path of reads) {
        const separator = path.includes("?") ? "&" : "?";
        const response = await app(SELF).request(
          `${path}${separator}${key}=stray`,
        );
        expect(response.status).toBe(400);
        const body = (await response.json()) as Record<string, unknown>;
        expect(Object.keys(body)).toEqual(["error"]);
      }
    }
  });

  test("authentication still comes first: an unauthenticated caller sees 401", async () => {
    for (const path of reads) {
      const response = await app(undefined).request(path);
      expect(response.status).toBe(401);
    }
  });
});

describe("the read path writes nothing", () => {
  test("a first visit — no payer row, no grants — reads zeros and performs zero writes", async () => {
    const newcomer: AuthenticatedActor = {
      id: `user-newcomer-${run}`,
      email: "newcomer@openbot.test",
      role: "user",
    };
    const { writes, database: counting } = writeCountingDatabase(database);
    const response = await app(newcomer, counting).request(
      "/api/billing/credits/summary",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as PersonalBalanceResponse;
    // An account the ledger never met is empty, not broken — and the read did not open one.
    expect(body.accountType).toBe("personal");
    expect(body.available).toBe(0);
    expect(body.consumed).toBe(0);
    expect(body.expired).toBe(0);
    expect(body.held).toBe(0);
    expect(body.grants).toEqual([]);
    expect(body.pendingSettlement).toEqual({
      enabled: true,
      available: 0,
      consumed: 0,
      expired: 0,
      reserved: 0,
      unknown: 0,
      reservations: [],
    });
    expect(writes).toEqual([]);

    for (const path of [
      "/api/billing/credits/grants",
      "/api/billing/credits/consumption?page=1",
    ]) {
      const followUp = await app(newcomer, counting).request(path);
      expect(followUp.status).toBe(200);
    }
    expect(writes).toEqual([]);
  });

  test("a seeded account's reads perform zero writes too", async () => {
    const { writes, database: counting } = writeCountingDatabase(database);
    const response = await app(SELF, counting).request(
      "/api/billing/credits/summary",
    );
    expect(response.status).toBe(200);
    expect(writes).toEqual([]);
    const grantsRead = await app(SELF, counting).request(
      "/api/billing/credits/grants",
    );
    expect(grantsRead.status).toBe(200);
    const consumptionRead = await app(SELF, counting).request(
      "/api/billing/credits/consumption?page=1",
    );
    expect(consumptionRead.status).toBe(200);
    expect(writes).toEqual([]);
  });
});
