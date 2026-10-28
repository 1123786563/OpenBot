import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { requireAdmin } from "../src/auth/guards";
import { createCredits } from "../src/billing/credits";
import { createCreditWriter } from "../src/billing/credits-writer";
import { payerKey } from "../src/billing/payer";
import {
  createBillingAdminRoutes,
  createBillingCreditRoutes,
} from "../src/billing/routes";
import type { BillingService } from "../src/billing/types";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost 02.8 (#222): the administrator's grant to a NAMED PERSONAL account, against a real
 * PostgreSQL. The ticket's acceptance criteria live here:
 *
 * - the same grant request submitted twice lands once (explicit key AND the keyless derived rule);
 * - after Jia and Yi each hold 10 credits, Yi can neither read nor spend Jia's balance;
 * - a non-administrator is refused outright;
 * - every answered grant carries a queryable audit row naming the operator and the account the
 *   server RESOLVED from the target user — a bare externalCustomerId is a shape error, never an
 *   input.
 *
 * The route contract this file pins (this ticket's produced contract, consumed by the admin UI
 * and by ticket 10.4):
 *
 *   POST /api/admin/billing/credits/personal-grants
 *   { userId, source? ("promo"|"signin", default "promo"), totalCents,
 *     expiresAt? (ISO offset datetime), reason?, idempotencyKey? }
 *   → 200 { grant, account: { id, kind: "personal", payerId, externalCustomerId, createdAt },
 *           inserted }
 *
 * Idempotency-key rule: an explicit request key lands as `admin-personal:explicit:<key>`; a
 * keyless request derives `admin-personal:derived:<digest>` from the operator and the request's
 * identity fields (actor, user, source, amount, raw expiry, reason) — so a replayed keyless
 * request collapses onto the first grant, while two intentional grants differ in at least one
 * field or ride explicit keys.
 *
 * The user page half of the seam (发放后用户页面可见新 Grant) is asserted here end-to-end: after
 * the admin grant, the 02.6 personal read — the one the 02.7 page renders — answers the new
 * grant for its own user and nothing for the other.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const credits = createCredits({
  database,
  externalCustomerKey: `openbot-deployment-b5222-${randomUUID().slice(0, 8)}`,
  catalog: new Map(),
});
const auditStore = createAuditStore(database);
const run = randomUUID().slice(0, 8);

/** The deployment key this run pretends is the deployment's; asserted untouched, then deleted. */
const DEPLOYMENT_KEY = `openbot-deployment-b5222-${run}`;

const ADMIN: AuthenticatedActor = {
  id: `admin-${run}`,
  email: `admin-${run}@openbot.test`,
  role: "admin",
};
const MEMBER: AuthenticatedActor = {
  id: `member-${run}`,
  email: `member-${run}@openbot.test`,
  role: "user",
};

/** The two grant targets: real user rows, because the route answers 404 for a user who isn't. */
const jia = { id: `user-jia-${run}`, email: `jia-${run}@openbot.test` };
const yi = { id: `user-yi-${run}`, email: `yi-${run}@openbot.test` };

/** Every user id this run inserted, for the teardown. */
const insertedUserIds: string[] = [jia.id, yi.id];

/**
 * The admin routes' service is the snapshot/sync surface, which these tests never mount: the
 * personal-grant route talks to the payer resolution, the writer and the audit trail. A typed
 * absent object keeps the factory's required parameter honest without building a provider client
 * this file has no use for.
 */
const stubService = {} as BillingService;

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

/** The admin group and the personal credit reads, mounted where app.ts mounts them. */
function appAs(
  actor: AuthenticatedActor | undefined,
  overrides?: {
    creditWriter?: typeof writer | undefined;
    database?: typeof database | undefined;
  },
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/admin/billing",
    createBillingAdminRoutes({
      service: stubService,
      requireUser: requireUserAs(actor),
      requireAdmin,
      audit: auditStore,
      externalCustomerKey: DEPLOYMENT_KEY,
      customerName: `OpenBot deployment ${DEPLOYMENT_KEY}`,
      database:
        overrides && "database" in overrides ? overrides.database : database,
      creditWriter:
        overrides && "creditWriter" in overrides
          ? overrides.creditWriter
          : writer,
    }),
  );
  app.route(
    "/api/billing",
    createBillingCreditRoutes({
      credits,
      requireUser: requireUserAs(actor),
    }),
  );
  return app;
}

/** One admin grant POST, spelled the way the admin UI sends it. */
function grant(
  app: ReturnType<typeof appAs>,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request("/api/admin/billing/credits/personal-grants", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The account's grant rows, straight from the ledger's authority. */
async function grantRowsOf(externalCustomerId: string) {
  return database.execute(
    sql`SELECT id, total, used, idempotency_key FROM credit_grants WHERE external_customer_id = ${externalCustomerId} ORDER BY granted_at`,
  );
}

/** The audit rows this run's operator wrote, read back from the table (可查询的证据). */
async function auditRowsOf(actorId: string) {
  return database.execute(
    sql`SELECT event_type, target_id, actor_user_id, payload FROM audit_events WHERE actor_user_id = ${actorId} AND event_type = 'billing.credits.personal_granted'`,
  );
}

afterAll(async () => {
  // Children first, then the customers (whose delete cascades to grants, ledger, reservations),
  // then the user rows. The audit rows stay: `audit_events` is append-only by trigger, and the
  // rows this run wrote name this run's unique actor ids, so they are evidence in a dedicated
  // test database, not pollution.
  await database.execute(
    sql`DELETE FROM payer_accounts WHERE kind = 'personal' AND payer_id IN (${sql.join(
      insertedUserIds.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`%${run}%`}`,
  );
  await database.execute(sql`DELETE FROM users WHERE id LIKE ${`%${run}%`}`);
  await database.$client.close();
});

describe("an admin grant to a named personal account", () => {
  test("lands once on the account the server resolved from the user", async () => {
    await database.insert(users).values({ id: jia.id, email: jia.email });
    const app = appAs(ADMIN);
    const response = await grant(app, {
      userId: jia.id,
      totalCents: 1_000, // 10.00 credits, scaled ×100
      reason: "新用户活动",
      expiresAt: "2026-12-01T00:00:00Z",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      grant: { id: string; total: number; externalCustomerId: string };
      account: {
        id: string;
        kind: string;
        payerId: string;
        externalCustomerId: string;
      };
      inserted: boolean;
    };
    expect(body.inserted).toBe(true);
    expect(body.grant.total).toBe(1_000);
    // THE resolution property: the grant's account is the payer layer's answer for this user —
    // derived on the server, never a key the request named (the request couldn't have).
    expect(body.account).toMatchObject({
      kind: "personal",
      payerId: jia.id,
      externalCustomerId: payerKey({ kind: "personal", id: jia.id }),
    });
    expect(body.grant.externalCustomerId).toBe(body.account.externalCustomerId);
    const rows = await grantRowsOf(body.account.externalCustomerId);
    expect(rows.length).toBe(1);
    // The user's own page sees it (02.6 read, 02.7 renders it).
    const balance = await credits.personalBalance({
      kind: "personal",
      id: jia.id,
    });
    expect(balance.available).toBe(10);
    expect(balance.grants).toHaveLength(1);
    expect(balance.grants[0]?.remaining).toBe(10);
  });

  test("the same request with the same idempotencyKey lands once", async () => {
    const app = appAs(ADMIN);
    const body = {
      userId: jia.id,
      totalCents: 500, // 5 credits
      reason: "补偿发放",
      expiresAt: "2026-12-01T00:00:00Z",
      idempotencyKey: `retry-${run}`,
    };
    const first = await grant(app, body);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      inserted: boolean;
      grant: { id: string };
    };
    expect(firstBody.inserted).toBe(true);

    const replay = await grant(app, body);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      inserted: boolean;
      grant: { id: string };
    };
    expect(replayBody.inserted).toBe(false);
    expect(replayBody.grant.id).toBe(firstBody.grant.id);

    // Exactly two rows so far (the 10-credit one from the test above, plus this 5) — and 15 on
    // the balance, not 20.
    const key = payerKey({ kind: "personal", id: jia.id });
    const rows = await grantRowsOf(key);
    expect(rows.length).toBe(2);
    expect(rows.reduce((sum, row) => sum + Number(row.total), 0)).toBe(1_500);
    const balance = await credits.personalBalance({
      kind: "personal",
      id: jia.id,
    });
    expect(balance.available).toBe(15);
  });

  test("a keyless replay of the same request also lands once (derived-key rule)", async () => {
    const user = {
      id: `user-derived-${run}`,
      email: `derived-${run}@openbot.test`,
    };
    insertedUserIds.push(user.id);
    await database.insert(users).values({ id: user.id, email: user.email });
    const app = appAs(ADMIN);
    const body = { userId: user.id, totalCents: 700, reason: "客服补偿" };
    const first = await grant(app, body);
    expect(first.status).toBe(200);
    const second = await grant(app, body);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { inserted: boolean };
    expect(secondBody.inserted).toBe(false);

    const key = payerKey({ kind: "personal", id: user.id });
    const rows = await grantRowsOf(key);
    expect(rows.length).toBe(1);
    expect(Number(rows[0].total)).toBe(700);
    // The stored key is the derived spelling, namespaced for the trail.
    expect(String(rows[0].idempotency_key)).toMatch(
      /^admin-personal:derived:[0-9a-f]{40}$/,
    );
  });

  test("two keyless grants differing in reason are two grants, not one", async () => {
    const user = {
      id: `user-distinct-${run}`,
      email: `distinct-${run}@openbot.test`,
    };
    insertedUserIds.push(user.id);
    await database.insert(users).values({ id: user.id, email: user.email });
    const app = appAs(ADMIN);
    const first = await grant(app, {
      userId: user.id,
      totalCents: 100,
      reason: "三月活动",
    });
    const second = await grant(app, {
      userId: user.id,
      totalCents: 100,
      reason: "四月活动",
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const rows = await grantRowsOf(payerKey({ kind: "personal", id: user.id }));
    expect(rows.length).toBe(2);
  });
});

describe("authorization", () => {
  test("a non-administrator is refused and nothing is written", async () => {
    await database.insert(users).values({ id: yi.id, email: yi.email });
    const app = appAs(MEMBER);
    const response = await grant(app, {
      userId: yi.id,
      totalCents: 1_000,
      reason: "不应发生",
    });
    expect(response.status).toBe(403);
    expect(
      await grantRowsOf(payerKey({ kind: "personal", id: yi.id })),
    ).toHaveLength(0);
    expect(await auditRowsOf(MEMBER.id)).toHaveLength(0);
  });
});

describe("input shape", () => {
  test("a bare externalCustomerId (or any account key) is a 400, never a grant", async () => {
    const app = appAs(ADMIN);
    const response = await grant(app, {
      userId: jia.id,
      totalCents: 100,
      externalCustomerId: payerKey({ kind: "personal", id: yi.id }),
    });
    expect(response.status).toBe(400);
    // And the named key got nothing.
    expect(
      await grantRowsOf(payerKey({ kind: "personal", id: yi.id })),
    ).toHaveLength(0);
  });

  test("an unknown user answers 404 and writes nothing", async () => {
    const app = appAs(ADMIN);
    const ghost = `user-ghost-${run}`;
    const response = await grant(app, { userId: ghost, totalCents: 100 });
    expect(response.status).toBe(404);
    expect(
      await grantRowsOf(payerKey({ kind: "personal", id: ghost })),
    ).toHaveLength(0);
  });

  test("without a credit writer wired, the route answers 503 and grants nothing", async () => {
    const app = appAs(ADMIN, { creditWriter: undefined });
    const response = await grant(app, { userId: jia.id, totalCents: 100 });
    expect(response.status).toBe(503);
  });
});

describe("audit", () => {
  test("every answered grant has a queryable row: operator, resolved account, amount, reason", async () => {
    const rows = await auditRowsOf(ADMIN.id);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      expect(row.event_type).toBe("billing.credits.personal_granted");
      expect(row.actor_user_id).toBe(ADMIN.id);
      expect(row.target_id).toMatch(/^cg-/);
    }
    // The first grant, identified by its own facts rather than by row order: the operator, the
    // account the server resolved, the amount, the reason. It arrived WITHOUT a key, so its
    // idempotency reads "derived" — the keyless rule this ticket delivers.
    const first = rows.find(
      (row) =>
        (row.payload as Record<string, unknown>).totalCents === 1_000 &&
        (row.payload as Record<string, unknown>).reason === "新用户活动",
    );
    expect(first).toBeDefined();
    expect(first?.payload).toMatchObject({
      userId: jia.id,
      payerAccountId: expect.stringMatching(/^pa-/),
      externalCustomerId: payerKey({ kind: "personal", id: jia.id }),
      idempotency: "derived",
      inserted: true,
    });
    // The explicit spelling is on the trail too, beside its replay answered as the no-op it
    // was: two rows for two requests, one grant in the books.
    const explicitRows = rows.filter(
      (row) => (row.payload as Record<string, unknown>).reason === "补偿发放",
    );
    expect(explicitRows).toHaveLength(2);
    expect(
      explicitRows
        .map((row) => (row.payload as Record<string, unknown>).inserted)
        .sort(),
    ).toEqual([false, true]);
    for (const row of explicitRows) {
      expect(row.payload).toMatchObject({
        idempotency: "explicit",
        userId: jia.id,
      });
    }
    expect(
      rows.some(
        (row) => (row.payload as Record<string, unknown>).inserted === false,
      ),
    ).toBe(true);
  });
});

describe("Jia and Yi isolation", () => {
  test("after each holds 10, Yi can neither read nor spend Jia's balance", async () => {
    const adminApp = appAs(ADMIN);
    for (const user of [jia, yi]) {
      const response = await grant(adminApp, {
        userId: user.id,
        totalCents: 1_000,
        reason: "隔离测试",
        idempotencyKey: `isolate-${user.id}`,
      });
      expect(response.status).toBe(200);
    }

    // Yi's own read: 10 credits, one grant — and nothing of Jia's.
    const yiApp = appAs({ id: yi.id, email: yi.email, role: "user" });
    const summary = await yiApp.request("/api/billing/credits/summary");
    expect(summary.status).toBe(200);
    const summaryBody = (await summary.json()) as {
      available: number;
      grants: unknown[];
    };
    expect(summaryBody.available).toBe(10);
    expect(summaryBody.grants).toHaveLength(1);

    // Yi's read trying to name Jia's account is a forgery answered 400 (02.4's boundary).
    const crossRead = await yiApp.request(
      `/api/billing/credits/summary?userId=${encodeURIComponent(jia.id)}`,
    );
    expect(crossRead.status).toBe(400);

    // Yi cannot spend past their own 10 even though Jia holds 10: the hold is drawn from the
    // resolved account, and the refusal reports what Yi themselves had.
    const reserve = await writer.reserveCredits({
      externalCustomerId: payerKey({ kind: "personal", id: yi.id }),
      idempotencyKey: `overspend-${run}`,
      maximumCents: 1_500,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(reserve).toEqual({ reserved: false, availableCents: 1_000 });
    // And Jia's balance is unmoved by any of it.
    expect(
      (await credits.personalBalance({ kind: "personal", id: jia.id }))
        .available,
    ).toBeGreaterThan(10);
  });

  test("a personal grant leaves the deployment-level records untouched", async () => {
    const before = await grantRowsOf(DEPLOYMENT_KEY);
    const beforeBalance = await writer.availableBalance(DEPLOYMENT_KEY);
    const response = await grant(appAs(ADMIN), {
      userId: jia.id,
      totalCents: 100,
      reason: "不应触碰部署键",
    });
    expect(response.status).toBe(200);
    expect(await grantRowsOf(DEPLOYMENT_KEY)).toEqual(before);
    expect(await writer.availableBalance(DEPLOYMENT_KEY)).toBe(beforeBalance);
  });
});
