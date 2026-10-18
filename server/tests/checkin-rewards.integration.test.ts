import { afterAll, describe, expect, test } from "../../tests/support/e2e-compat";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createCredits } from "../src/billing/credits";
import { createCreditWriter } from "../src/billing/credits-writer";
import { payerKey } from "../src/billing/payer";
import {
  createRewardGranter,
  rewardIdempotencyKey,
  rewardPeriodOfDay,
  type RewardGranter,
} from "../src/billing/rewards";
import { createBillingCreditRoutes } from "../src/billing/routes";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost 10.4 (#293): reward grants land in the CLAIMER'S OWN personal account, once per
 * reward period, against a real PostgreSQL. The ticket's acceptance criteria live here:
 *
 * - a signin reward lands on the account the server RESOLVED from the authenticated session —
 *   never an account the request could have named (the claim body has no such field, and a
 *   request that tries to smuggle one in is a 400, not a redirect);
 * - the same claim in the same period lands once (the ledger's unique idempotency key
 *   `reward:<type>:<period>:<user>`), while the next period is a genuinely new grant;
 * - every answered claim carries a queryable record: the grant row on the claimer's own 02.6
 *   read, and an audit row naming who claimed what into which resolved account.
 *
 * The route contract this file pins (this ticket's produced contract, consumed by the check-in
 * client and by ticket 10.6's display):
 *
 *   POST /api/billing/credits/rewards/claim
 *   { rewardType: "signin" }
 *   → 200 { inserted, period, grant, account: { id, kind: "personal", payerId,
 *           externalCustomerId, createdAt } }
 *   → 400 for any request that carries an account identity (body field or query parameter)
 *   → 401 unauthenticated; 503 when the deployment has no credit writer configured
 *
 * The period is SERVER-DERIVED (the UTC calendar day of the deployment's clock, injected as
 * `now` for determinism) — the client names the reward type and nothing else.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const rewards = createRewardGranter({ database, creditWriter: writer });
const credits = createCredits({
  database,
  externalCustomerKey: `openbot-deployment-b104-${randomUUID().slice(0, 8)}`,
  catalog: new Map(),
});
const auditStore = createAuditStore(database);
const run = randomUUID().slice(0, 8);

/** Fixed clock: two adjacent UTC days, so period semantics are deterministic. */
const FIXED_NOW = new Date("2026-10-17T08:30:00Z");
const NEXT_DAY = new Date("2026-10-18T08:30:00Z");

const MEMBER: AuthenticatedActor = {
  id: `user-jia-${run}`,
  email: `jia-${run}@openbot.test`,
  role: "user",
};
const SECOND: AuthenticatedActor = {
  id: `user-yi-${run}`,
  email: `yi-${run}@openbot.test`,
  role: "user",
};

/** Every payer id this run created accounts for, for the teardown. */
const insertedPayerIds = [MEMBER.id, SECOND.id, `user-sang-${run}`, `user-di-${run}`];

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

/** The personal credit reads plus the claim route, mounted where app.ts mounts them. */
function appAs(
  actor: AuthenticatedActor | undefined,
  overrides?: {
    rewards?: RewardGranter | undefined;
    now?: Date;
  },
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/billing",
    createBillingCreditRoutes({
      credits,
      requireUser: requireUserAs(actor),
      // Explicitly-overridable seams: `"rewards" in overrides` (not falsiness) so a test can
      // ask for the unconfigured deployment rather than accidentally receive the real one.
      rewards:
        overrides && "rewards" in overrides ? overrides.rewards : rewards,
      audit: auditStore,
      now: () => overrides?.now ?? FIXED_NOW,
    }),
  );
  return app;
}

/** One claim POST, spelled the way the check-in client sends it. */
function claim(
  app: ReturnType<typeof appAs>,
  body: Record<string, unknown> = { rewardType: "signin" },
  query = "",
): Promise<Response> {
  return app.request(`/api/billing/credits/rewards/claim${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** An account's grant rows, straight from the ledger's authority. */
async function grantRowsOf(externalCustomerId: string) {
  return database.execute(
    sql`SELECT id, total, used, source, idempotency_key FROM credit_grants WHERE external_customer_id = ${externalCustomerId} ORDER BY granted_at`,
  );
}

/** The audit rows this run's claims wrote, read back from the table (可查询的证据). */
async function claimAuditRowsOf(actorId: string) {
  return database.execute(
    sql`SELECT event_type, target_id, actor_user_id, payload FROM audit_events WHERE actor_user_id = ${actorId} AND event_type = 'billing.credits.reward_claimed'`,
  );
}

afterAll(async () => {
  // Children first, then the customers (whose delete cascades to grants, ledger, reservations).
  // The audit rows stay: `audit_events` is append-only by trigger, and the rows this run wrote
  // name this run's unique actor ids, so they are evidence in a dedicated test database, not
  // pollution.
  await database.execute(
    sql`DELETE FROM payer_accounts WHERE kind = 'personal' AND payer_id IN (${sql.join(
      insertedPayerIds.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${`%${run}%`}`,
  );
  await database.$client.close();
});

describe("a signin reward claim", () => {
  test("lands on the claimer's own personal account, resolved server-side", async () => {
    const app = appAs(MEMBER);
    const response = await claim(app);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      inserted: boolean;
      period: string;
      grant: { id: string; source: string; total: number; externalCustomerId: string };
      account: { id: string; kind: string; payerId: string; externalCustomerId: string };
    };
    // THE attribution property: the grant's account is the payer layer's answer for the session
    // user — derived on the server, never a key the request named (the request couldn't have).
    expect(body.inserted).toBe(true);
    expect(body.period).toBe("2026-10-17");
    expect(body.grant.source).toBe("signin");
    expect(body.grant.total).toBe(100); // 1.00 credit, scaled ×100 — server policy, not client input
    expect(body.account).toMatchObject({
      kind: "personal",
      payerId: MEMBER.id,
      externalCustomerId: payerKey({ kind: "personal", id: MEMBER.id }),
    });
    expect(body.grant.externalCustomerId).toBe(body.account.externalCustomerId);

    const rows = await grantRowsOf(body.account.externalCustomerId);
    expect(rows.length).toBe(1);
    const balance = await credits.personalBalance({
      kind: "personal",
      id: MEMBER.id,
    });
    expect(balance.available).toBe(1);
  });

  test("a replay in the same period lands once (inserted:false, same grant)", async () => {
    const app = appAs(MEMBER);
    const first = await claim(app);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { inserted: boolean; grant: { id: string } };
    // The first claim of this test is the period's replay of the test above: same period key.
    expect(firstBody.inserted).toBe(false);
    const replay = await claim(app);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { inserted: boolean; grant: { id: string } };
    expect(replayBody.inserted).toBe(false);
    expect(replayBody.grant.id).toBe(firstBody.grant.id);

    const rows = await grantRowsOf(payerKey({ kind: "personal", id: MEMBER.id }));
    expect(rows.length).toBe(1);
    const balance = await credits.personalBalance({
      kind: "personal",
      id: MEMBER.id,
    });
    expect(balance.available).toBe(1);
  });

  test("the next period is a new grant (period rides the idempotency key)", async () => {
    const app = appAs(MEMBER, { now: NEXT_DAY });
    const response = await claim(app);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { inserted: boolean; period: string };
    expect(body.inserted).toBe(true);
    expect(body.period).toBe("2026-10-18");

    const rows = await grantRowsOf(payerKey({ kind: "personal", id: MEMBER.id }));
    expect(rows.length).toBe(2);
    const balance = await credits.personalBalance({
      kind: "personal",
      id: MEMBER.id,
    });
    expect(balance.available).toBe(2);
  });

  test("another user's claim lands on their own account, never the first user's", async () => {
    const app = appAs(SECOND);
    const response = await claim(app);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      inserted: boolean;
      account: { kind: string; payerId: string; externalCustomerId: string };
    };
    expect(body.inserted).toBe(true);
    expect(body.account.payerId).toBe(SECOND.id);

    // Yi's one grant is on yi's key; jia's books are untouched by it.
    const yiRows = await grantRowsOf(payerKey({ kind: "personal", id: SECOND.id }));
    expect(yiRows.length).toBe(1);
    const jiaRows = await grantRowsOf(payerKey({ kind: "personal", id: MEMBER.id }));
    expect(jiaRows.length).toBe(2);
    const jiaBalance = await credits.personalBalance({
      kind: "personal",
      id: MEMBER.id,
    });
    expect(jiaBalance.available).toBe(2);
  });

  test("a body naming an account identity is a shape error, not a redirect", async () => {
    const app = appAs(MEMBER);
    const before = await grantRowsOf(payerKey({ kind: "personal", id: SECOND.id }));
    const forgeries = [
      { rewardType: "signin", userId: SECOND.id },
      { rewardType: "signin", externalCustomerId: payerKey({ kind: "personal", id: SECOND.id }) },
    ];
    for (const forged of forgeries) {
      const response = await claim(app, forged);
      expect(response.status).toBe(400);
      // Nothing landed anywhere: the forgery never became a grant.
      const after = await grantRowsOf(payerKey({ kind: "personal", id: SECOND.id }));
      expect(after.length).toBe(before.length);
      const mine = await grantRowsOf(payerKey({ kind: "personal", id: MEMBER.id }));
      expect(mine.length).toBe(2);
    }
  });

  test("a query parameter naming an account is refused", async () => {
    const app = appAs(MEMBER);
    const response = await claim(
      app,
      { rewardType: "signin" },
      `?userId=${encodeURIComponent(SECOND.id)}`,
    );
    expect(response.status).toBe(400);
    const after = await grantRowsOf(payerKey({ kind: "personal", id: SECOND.id }));
    expect(after.length).toBe(1);
  });

  test("every answered claim is queryable: the 02.6 read and the audit trail", async () => {
    // Jia has answered claims: first, replay, next-day (the replays are on the trail too,
    // marked inserted:false — a double press that entered the books once is a fact worth
    // reading, the same rule the admin grant keeps).
    const app = appAs(MEMBER);
    const response = await app.request("/api/billing/credits/grants");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      grants: { id: string; source: string; remaining: number }[];
    };
    const signinGrants = body.grants.filter((grant) => grant.source === "signin");
    expect(signinGrants).toHaveLength(2);
    expect(signinGrants.every((grant) => grant.remaining === 1)).toBe(true);

    const auditRows = await claimAuditRowsOf(MEMBER.id);
    // One row per ANSWERED request: first claim, the two replays of the same period, and the
    // next-day claim — the replays are on the trail too, marked inserted:false, because a
    // double press that entered the books once is a fact worth reading (the admin grant's
    // rule). The forged attempts above answered 400 before any grant, so they are absent.
    expect(auditRows.length).toBe(4);
    // The first payout is distinguishable from its replays in the trail itself.
    const firstPayouts = auditRows.filter(
      (row) =>
        (row.payload as Record<string, unknown>).period === "2026-10-17" &&
        (row.payload as Record<string, unknown>).inserted === true,
    );
    expect(firstPayouts).toHaveLength(1);
    expect(firstPayouts[0]?.payload).toMatchObject({
      userId: MEMBER.id,
      rewardType: "signin",
      period: "2026-10-17",
      totalCents: 100,
      externalCustomerId: payerKey({ kind: "personal", id: MEMBER.id }),
      payerAccountId: expect.any(String),
    });
    // And a replay's row says so, naming the same resolved account.
    const replayRows = auditRows.filter(
      (row) => (row.payload as Record<string, unknown>).inserted === false,
    );
    expect(replayRows.length).toBe(2);
    expect(replayRows[0]?.payload).toMatchObject({
      externalCustomerId: payerKey({ kind: "personal", id: MEMBER.id }),
    });
  });

  test("a failed grant leaves no half state (no grant row, no credits)", async () => {
    const sang = { id: `user-sang-${run}` };
    // A fractional amount is a caller's bug; the writer refuses it and nothing is written.
    expect(
      rewards.grantReward({
        user: sang,
        rewardType: "signin",
        period: "2026-10-17",
        totalCents: 10.5,
        expiresAt: new Date(FIXED_NOW.getTime() + 365 * 24 * 3600_000),
      }),
    ).rejects.toThrow(TypeError);
    const rows = await grantRowsOf(payerKey({ kind: "personal", id: sang.id }));
    expect(rows.length).toBe(0);
  });

  test("an unauthenticated claim is refused outright", async () => {
    const app = appAs(undefined);
    const response = await claim(app);
    expect(response.status).toBe(401);
  });

  test("a deployment without the reward granter answers 503, not a silent nothing", async () => {
    const app = appAs(MEMBER, { rewards: undefined });
    const response = await claim(app);
    expect(response.status).toBe(503);
  });
});

describe("the reward idempotency key", () => {
  test("binds user + reward type + period, so types never collide", async () => {
    const di = { id: `user-di-${run}` };
    const day = rewardPeriodOfDay(FIXED_NOW);
    expect(day).toBe("2026-10-17");
    const signin = await rewards.grantReward({
      user: di,
      rewardType: "signin",
      period: day,
      totalCents: 100,
      expiresAt: new Date(FIXED_NOW.getTime() + 365 * 24 * 3600_000),
    });
    const promo = await rewards.grantReward({
      user: di,
      rewardType: "promo",
      period: day,
      totalCents: 100,
      expiresAt: new Date(FIXED_NOW.getTime() + 365 * 24 * 3600_000),
    });
    expect(signin.inserted).toBe(true);
    expect(promo.inserted).toBe(true);
    expect(signin.grant.id).not.toBe(promo.grant.id);
    expect(signin.idempotencyKey).toBe(
      rewardIdempotencyKey({ userId: di.id, rewardType: "signin", period: day }),
    );
    expect(signin.idempotencyKey.startsWith(`reward:signin:${day}:`)).toBe(true);
    expect(promo.idempotencyKey.startsWith(`reward:promo:${day}:`)).toBe(true);
    const rows = await grantRowsOf(signin.account.externalCustomerId);
    expect(rows.length).toBe(2);
  });
});
