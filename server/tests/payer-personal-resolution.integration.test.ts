import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createCredits } from "../src/billing/credits";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createBillingCreditRoutes } from "../src/billing/routes";
import {
  resolvePersonalPayerAccount,
  resolvePayerForPersonalUser,
} from "../src/billing/payer-personal";
import { payerKey, readPayerAccount } from "../src/billing/payer";
import { createDatabase } from "../src/db/client";
import { payerAccounts } from "../src/db/schema/billing";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { Hono, type MiddlewareHandler } from "hono";

/*
 * The personal branch against a real PostgreSQL, gated on TEST_DATABASE_URL the way the rest of
 * the integration suite is. The ticket's acceptance criteria live here: a second resolution of
 * the same authenticated user answers the same account (idempotence), six connections racing the
 * first resolution leave exactly one account row (the database's unique indexes arbitrate), and
 * a resolution that creates an account creates NOTHING else — no grant, no ledger row, no
 * balance. The cross-account refusals at the route boundary live in the task-3 describe below.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const run = randomUUID().slice(0, 8);

/** Every account key this run created; the cleanup deletes exactly these. */
const createdKeys = new Set<string>();
/** The extra pools the concurrency test opens; closed alongside the main one. */
const extraDatabases: ReturnType<typeof createDatabase>[] = [];

function track(key: string): string {
  createdKeys.add(key);
  return key;
}

afterAll(async () => {
  const keys = [...createdKeys];
  if (keys.length > 0) {
    await database.execute(
      sql`DELETE FROM payer_accounts WHERE external_customer_id IN (${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )})`,
    );
    // billing_customers cascades to the grants, ledger, reservations and remainders.
    await database.execute(
      sql`DELETE FROM billing_customers WHERE external_id IN (${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )})`,
    );
  }
  for (const extra of extraDatabases) await extra.$client.close();
  await database.$client.close();
});

describe("resolvePersonalPayerAccount is idempotent per authenticated user", () => {
  test("a second resolution answers the same account, one row in the database", async () => {
    const user = { id: `user-pers-1-${run}` };
    const first = await resolvePersonalPayerAccount(database, user);
    track(first.externalCustomerId);
    expect(first.externalCustomerId).toBe(payerKey({ kind: "personal", id: user.id }));

    const again = await resolvePersonalPayerAccount(database, user);
    expect(again.id).toBe(first.id);

    const rows = await database
      .select({ id: payerAccounts.id })
      .from(payerAccounts)
      .where(and(eq(payerAccounts.kind, "personal"), eq(payerAccounts.payerId, user.id)));
    expect(rows).toHaveLength(1);
    expect(
      await readPayerAccount(database, resolvePayerForPersonalUser(user)),
    ).toEqual(first);
  });
});

describe("concurrent first resolutions leave exactly one personal account", () => {
  test("six connections racing one user all answer the one account row", async () => {
    const user = { id: `user-pers-race-${run}` };
    // Separate database instances = separate connection pools: the inserts genuinely land on
    // different connections, so the unique index — not event-loop luck — decides the winner.
    const lanes = Array.from({ length: 6 }, () => {
      const lane = createDatabase(testDatabaseUrl(), { max: 1 });
      extraDatabases.push(lane);
      return lane;
    });

    const answers = await Promise.all(
      lanes.map((lane) => resolvePersonalPayerAccount(lane, user)),
    );
    track(answers[0].externalCustomerId);

    const ids = new Set(answers.map((answer) => answer.id));
    expect(ids.size).toBe(1);
    const rows = await database.execute(
      sql`SELECT count(*) AS n FROM payer_accounts WHERE kind = 'personal' AND payer_id = ${user.id}`,
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});

describe("a personal resolution creates the account and no balance", () => {
  test("no grant, no ledger row, and the writer answers a zero balance", async () => {
    const user = { id: `user-pers-born-${run}` };
    const account = await resolvePersonalPayerAccount(database, user);
    track(account.externalCustomerId);

    const rows = await database.execute(
      sql`SELECT (SELECT count(*) FROM credit_grants WHERE external_customer_id = ${account.externalCustomerId}) AS grants,
                 (SELECT count(*) FROM credit_ledger WHERE external_customer_id = ${account.externalCustomerId}) AS ledger`,
    );
    expect(Number(rows[0].grants)).toBe(0);
    expect(Number(rows[0].ledger)).toBe(0);
    expect(await writer.availableBalance(account.externalCustomerId)).toBe(0);
  });
});

describe("the credit read routes refuse requests that name an account", () => {
  // The deployment's own key, the one the routes read while ticket 02.6 has not switched them
  // to personal reads — a legitimate request keeps answering THIS account.
  const deploymentKey = `openbot-deployment-route-${run}`;
  const credits = createCredits({
    database,
    externalCustomerKey: deploymentKey,
    catalog: new Map(),
  });
  const self: AuthenticatedActor = {
    id: `user-self-${run}`,
    email: "self@openbot.test",
    role: "user",
  };

  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", self);
    await next();
  };
  const signedIn = () =>
    new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      createBillingCreditRoutes({ credits, requireUser }),
    );
  const signedOut = () =>
    new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      createBillingCreditRoutes({
        credits,
        requireUser: async (context, next) => {
          if (!context.req.header("authorization")) {
            return context.json({ error: "Authentication required." }, 401);
          }
          context.set("actor", self);
          await next();
        },
      }),
    );

  test("a request carrying another user's userId is refused, not answered empty", async () => {
    // The foreign account exists and even holds a balance — the refusal must not depend on the
    // named account being empty; the request shape itself is the forgery.
    const stranger = { id: `user-stranger-${run}` };
    const strangerAccount = await resolvePersonalPayerAccount(database, stranger);
    track(strangerAccount.externalCustomerId);
    await writer.grantCredits({
      externalCustomerId: strangerAccount.externalCustomerId,
      source: "promo",
      totalCents: 9_900,
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      reason: "cross-account bait",
      idempotencyKey: `xacct-bait-${run}`,
    });

    for (const path of [
      `/api/billing/credits/summary?userId=${stranger.id}`,
      `/api/billing/credits/grants?userId=${stranger.id}`,
      `/api/billing/credits/consumption?userId=${stranger.id}&page=1`,
    ]) {
      const response = await signedIn().request(path);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("not accepted");
    }
  });

  test("a bare externalCustomerId is refused on every credit read", async () => {
    for (const path of [
      `/api/billing/credits/summary?externalCustomerId=${deploymentKey}`,
      `/api/billing/credits/grants?externalCustomerId=stray-key`,
      `/api/billing/credits/consumption?externalCustomerId=stray-key`,
    ]) {
      const response = await signedIn().request(path);
      expect(response.status).toBe(400);
    }
  });

  test("the mapping layer's and company branch's ids are refused too, any casing", async () => {
    for (const key of [
      "payerId",
      "accountId",
      "companyId",
      "tenantId",
      "UserID",
      "ExternalCustomerId",
    ]) {
      const response = await signedIn().request(
        `/api/billing/credits/summary?${key}=x`,
      );
      expect(response.status).toBe(400);
    }
  });

  test("the reads' own window and page grammar keeps answering 200", async () => {
    const response = await signedIn().request(
      `/api/billing/credits/consumption?from=2026-10-01T00:00:00.000Z&page=1`,
    );
    expect(response.status).toBe(200);
  });

  test("authentication still comes first: an unauthenticated caller sees 401", async () => {
    const response = await signedOut().request(
      `/api/billing/credits/summary?userId=someone-else`,
    );
    expect(response.status).toBe(401);
  });
});
