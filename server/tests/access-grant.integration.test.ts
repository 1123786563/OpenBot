import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { and, count, eq, like } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createRequireUser } from "../src/auth/guards";
import {
  accessGrantRoutes,
  createAccessGrantService,
  MODEL_ACCESS_SCOPE,
} from "../src/bot-services/access-grants";
import {
  bindingCodeHash,
  createBindingOfferIssuer,
} from "../src/bot-services/binding-codes";
import { createBotServiceStore } from "../src/bot-services/store";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  auditEvents,
  botBindingOffers,
  botServices,
  credentials,
  creditGrants,
  creditLedger,
  creditReservations,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Bifrost #238 (04.5): login confirmation creates the model access grant.
 *
 * The questions here are the ticket's own: only a signed-in user who has explicitly confirmed may
 * create an authorization (a binding code alone, a forged identity field or nobody at all cannot),
 * a repeated confirmation of the same (user, bot, external identity) is idempotent down to one
 * active row, and creating the grant mints no key, touches no balance and writes no credit grant.
 * The code that proves the external identity and the confirmation that creates the authorization
 * are two separate steps (AC03): preview consumes nothing; confirm is the only act that does.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const botStore = createBotServiceStore(database);
const issuer = createBindingOfferIssuer({ database, auditStore });
const service = createAccessGrantService({
  database,
  botServices: botStore,
  auditStore,
});

/**
 * The real guard against a fake session source: the same createRequireUser the app mounts, fed a
 * getSession that answers from one header. A request without the header is what "not signed in"
 * looks like here — and the 401 it gets is the guard's own, not a route's imitation of one.
 */
const requireUser = createRequireUser(
  {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async ({ headers }) => {
        const id = headers.get("x-openbot-test-user");
        if (!id) return null;
        return {
          user: {
            id,
            email: `${id}@example.test`,
            name: null,
            image: null,
            role: "user",
          },
        };
      },
    },
  },
  { rolesForUser: async () => ["user"] },
);

const app = accessGrantRoutes(requireUser, service);

const prefix = `b5-238-${randomUUID()}`;
const hint = (suffix = randomUUID().slice(0, 8)) => `slack:${prefix}-${suffix}`;

afterAll(async () => {
  // Grants name bots (FK), offers name bots (FK): children first, then the bots themselves.
  // Audit rows stay: audit_events is append-only by design, and each run names its own ids,
  // so rows from an earlier run can never answer a later assertion.
  await database
    .delete(accessGrants)
    .where(like(accessGrants.userId, `${prefix}%`));
  await database
    .delete(botBindingOffers)
    .where(like(botBindingOffers.botId, `${prefix}%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}%`));
  await database.$client.close();
});

/** A registered bot under this file's prefix. */
async function registeredBot(suffix = "bot") {
  const botId = `${prefix}-${suffix}`;
  const existing = await botStore.getBotService(botId);
  if (existing) return existing;
  return botStore.register({
    botId,
    displayName: `Grant Bot ${suffix}`,
    kind: "external",
    capabilities: ["chat"],
  });
}

/** One live binding offer for a bot under this file's prefix: the plaintext code exactly once. */
async function liveOffer(suffix: string, externalIdentityHint = hint()) {
  const bot = await registeredBot(suffix);
  return issuer.issue(
    { botId: bot.botId, status: "active" },
    { externalIdentityHint },
  );
}

function request(path: string, userId: string | null, body: unknown = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (userId) headers["x-openbot-test-user"] = userId;
  return app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** A fresh unknown code: the same shape the issuer mints, backed by no row at all. */
function unknownCode() {
  return `obot_bbind_${randomBytes(32).toString("base64url")}`;
}

test("a caller without a session is refused before anything is created", async () => {
  const offer = await liveOffer("anon", hint("anon"));
  const userId = `${prefix}-anon-user`;

  const preview = await request("/binding-preview", null, {
    bindingCode: offer.bindingCode,
  });
  const confirm = await request("/confirm", null, {
    bindingCode: offer.bindingCode,
  });
  expect(preview.status).toBe(401);
  expect(confirm.status).toBe(401);

  // Nothing was created and nothing was consumed: the code is still exactly as live as it was.
  const [row] = await database
    .select()
    .from(botBindingOffers)
    .where(eq(botBindingOffers.codeHash, bindingCodeHash(offer.bindingCode)));
  expect(row?.status).toBe("pending");
  const grants = await database
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.userId, userId));
  expect(grants).toHaveLength(0);
});

const INVALID_CODE = {
  error: "That binding code is not valid.",
  code: "model_access_invalid_code",
};

test("preview shows the bot and identity a live code names, and creates nothing", async () => {
  const identity = hint("preview");
  const offer = await liveOffer("preview", identity);
  const userId = `${prefix}-preview-user`;

  const response = await request("/binding-preview", userId, {
    bindingCode: offer.bindingCode,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const { preview } = (await response.json()) as {
    preview: Record<string, unknown>;
  };
  expect(preview).toMatchObject({
    bot: { botId: `${prefix}-preview`, displayName: `Grant Bot preview` },
    externalIdentity: identity,
    scope: MODEL_ACCESS_SCOPE,
  });
  expect(typeof preview.expiresAt).toBe("string");

  // The preview consumed nothing and created nothing — the code is still redeemable.
  const [row] = await database
    .select()
    .from(botBindingOffers)
    .where(eq(botBindingOffers.codeHash, bindingCodeHash(offer.bindingCode)));
  expect(row?.status).toBe("pending");
});

test("a request that tries to name a user or an identity is refused at the boundary", async () => {
  const offer = await liveOffer("forge", hint("forge"));
  const userId = `${prefix}-forge-user`;

  const forged = await request("/confirm", userId, {
    bindingCode: offer.bindingCode,
    userId: "someone-else",
    externalIdentity: "slack:attacker",
  });
  expect(forged.status).toBe(400);
  const [row] = await database
    .select()
    .from(botBindingOffers)
    .where(eq(botBindingOffers.codeHash, bindingCodeHash(offer.bindingCode)));
  expect(row?.status).toBe("pending");
});

test("confirm consumes the code and creates the full grant record", async () => {
  const identity = hint("create");
  const offer = await liveOffer("create", identity);
  const userId = `${prefix}-create-user`;

  // The person looks first (the confirmation flow's own first step).
  await request("/binding-preview", userId, { bindingCode: offer.bindingCode });

  const response = await request("/confirm", userId, {
    bindingCode: offer.bindingCode,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const { accessGrant, created } = (await response.json()) as {
    accessGrant: Record<string, unknown>;
    created: boolean;
  };
  expect(created).toBe(true);
  expect(Object.keys(accessGrant).sort()).toEqual([
    "botId",
    "createdAt",
    "externalIdentity",
    "grantId",
    "revokedAt",
    "scope",
    "status",
    "userId",
  ]);
  expect(accessGrant).toMatchObject({
    userId,
    botId: `${prefix}-create`,
    externalIdentity: identity,
    scope: MODEL_ACCESS_SCOPE,
    status: "active",
    revokedAt: null,
  });
  expect(typeof accessGrant.grantId).toBe("string");
  expect(accessGrant.grantId).not.toContain(offer.bindingCode);
  expect(typeof accessGrant.createdAt).toBe("string");

  // The code is spent; exactly one row exists and it is the one the response described.
  const [spent] = await database
    .select()
    .from(botBindingOffers)
    .where(eq(botBindingOffers.codeHash, bindingCodeHash(offer.bindingCode)));
  expect(spent?.status).toBe("redeemed");
  const rows = await database
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.grantId, accessGrant.grantId as string));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    userId,
    botId: `${prefix}-create`,
    externalIdentity: identity,
    scope: MODEL_ACCESS_SCOPE,
    status: "active",
    revokedAt: null,
  });
});

test("a replayed code cannot confirm twice", async () => {
  const identity = hint("replay");
  const offer = await liveOffer("replay", identity);
  const userId = `${prefix}-replay-user`;

  const first = await request("/confirm", userId, {
    bindingCode: offer.bindingCode,
  });
  expect(first.status).toBe(200);

  const replay = await request("/confirm", userId, {
    bindingCode: offer.bindingCode,
  });
  expect(replay.status).toBe(400);
  expect(await replay.json()).toEqual(INVALID_CODE);
});

test("a repeated confirmation with a fresh code is idempotent: one active grant", async () => {
  const identity = hint("idem");
  const userId = `${prefix}-idem-user`;
  await registeredBot("idem");

  const firstOffer = await liveOffer("idem", identity);
  const first = await request("/confirm", userId, {
    bindingCode: firstOffer.bindingCode,
  });
  expect(first.status).toBe(200);

  // The Bot issued a second code for the same person; confirming again is the same authorization.
  const secondOffer = await liveOffer("idem", identity);
  const second = await request("/confirm", userId, {
    bindingCode: secondOffer.bindingCode,
  });
  expect(second.status).toBe(200);
  const secondBody = (await second.json()) as {
    accessGrant: { grantId: string };
    created: boolean;
  };
  const firstBody = (await first.json()) as {
    accessGrant: { grantId: string };
  };
  expect(secondBody.created).toBe(false);
  expect(secondBody.accessGrant.grantId).toBe(firstBody.accessGrant.grantId);

  // Both codes are spent; the table holds exactly one active row for the triple.
  expect(
    (
      await database
        .select()
        .from(botBindingOffers)
        .where(
          eq(
            botBindingOffers.codeHash,
            bindingCodeHash(secondOffer.bindingCode),
          ),
        )
    )[0]?.status,
  ).toBe("redeemed");
  const active = await database
    .select()
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.userId, userId),
        eq(accessGrants.botId, `${prefix}-idem`),
        eq(accessGrants.externalIdentity, identity),
        eq(accessGrants.status, "active"),
      ),
    );
  expect(active).toHaveLength(1);
});

test("two codes for one authorization, confirmed concurrently: one grant", async () => {
  const identity = hint("race");
  const userId = `${prefix}-race-user`;
  await registeredBot("race");
  const [left, right] = await Promise.all([
    liveOffer("race", identity),
    liveOffer("race", identity),
  ]);

  const [a, b] = await Promise.all([
    request("/confirm", userId, { bindingCode: left.bindingCode }),
    request("/confirm", userId, { bindingCode: right.bindingCode }),
  ]);
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  const [grantA, grantB] = (await Promise.all([a.json(), b.json()])) as [
    { accessGrant: { grantId: string }; created: boolean },
    { accessGrant: { grantId: string }; created: boolean },
  ];
  expect(grantA.accessGrant.grantId).toBe(grantB.accessGrant.grantId);
  expect([grantA.created, grantB.created].filter(Boolean)).toHaveLength(1);

  const active = await database
    .select()
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.userId, userId),
        eq(accessGrants.botId, `${prefix}-race`),
        eq(accessGrants.externalIdentity, identity),
        eq(accessGrants.status, "active"),
      ),
    );
  expect(active).toHaveLength(1);
});

test("expired, unknown and disabled-bot codes are all refused the same way", async () => {
  const userId = `${prefix}-invalid-user`;

  // An offer whose lifetime has passed: expiry is data, so the row is inserted directly.
  const expiredCode = unknownCode();
  await registeredBot("invalid");
  await database.insert(botBindingOffers).values({
    codeHash: bindingCodeHash(expiredCode),
    botId: `${prefix}-invalid`,
    externalIdentityHint: hint("expired"),
    singleUse: true,
    status: "pending",
    expiresAt: new Date(Date.now() - 60_000),
  });

  const disabledOffer = await liveOffer("invalid", hint("disabled"));
  await botStore.disable(`${prefix}-invalid`);

  const attempts = await Promise.all([
    request("/confirm", userId, { bindingCode: unknownCode() }),
    request("/confirm", userId, { bindingCode: expiredCode }),
    request("/binding-preview", userId, { bindingCode: unknownCode() }),
    request("/confirm", userId, { bindingCode: disabledOffer.bindingCode }),
  ]);
  for (const attempt of attempts) {
    expect(attempt.status).toBe(400);
    expect(await attempt.json()).toEqual(INVALID_CODE);
  }

  // A body that does not even name a code is a refusal too, and nothing is created by any of it.
  const empty = await request("/confirm", userId, {});
  expect(empty.status).toBe(400);
  const rows = await database
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.userId, userId));
  expect(rows).toHaveLength(0);
});

test("two users confirming their own codes hold separate grants; identities are the idempotency key", async () => {
  const identity = hint("pair");
  await registeredBot("pair");
  const [offerOne, offerTwo] = await Promise.all([
    liveOffer("pair", identity),
    liveOffer("pair", identity),
  ]);

  const one = await request("/confirm", `${prefix}-pair-one`, {
    bindingCode: offerOne.bindingCode,
  });
  const two = await request("/confirm", `${prefix}-pair-two`, {
    bindingCode: offerTwo.bindingCode,
  });
  expect(one.status).toBe(200);
  expect(two.status).toBe(200);
  const grantOne = (await one.json()) as { accessGrant: { grantId: string } };
  const grantTwo = (await two.json()) as { accessGrant: { grantId: string } };
  expect(grantOne.accessGrant.grantId).not.toBe(grantTwo.accessGrant.grantId);

  // The same user, same bot, a different external identity: a different authorization.
  const otherIdentity = hint("other");
  const offerOther = await liveOffer("pair", otherIdentity);
  const third = await request("/confirm", `${prefix}-pair-one`, {
    bindingCode: offerOther.bindingCode,
  });
  expect(third.status).toBe(200);
  const activeForOne = await database
    .select()
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.userId, `${prefix}-pair-one`),
        eq(accessGrants.status, "active"),
      ),
    );
  expect(activeForOne).toHaveLength(2);
});

test("creating a grant mints no key, no balance and no credit grant", async () => {
  const offer = await liveOffer("audit", hint("side-effects"));
  const userId = `${prefix}-audit-user`;

  const before = {
    credentials: (await database.select({ n: count() }).from(credentials))[0]
      ?.n,
    creditGrants: (await database.select({ n: count() }).from(creditGrants))[0]
      ?.n,
    ledger: (await database.select({ n: count() }).from(creditLedger))[0]?.n,
    reservations: (
      await database.select({ n: count() }).from(creditReservations)
    )[0]?.n,
  };

  const response = await request("/confirm", userId, {
    bindingCode: offer.bindingCode,
  });
  expect(response.status).toBe(200);

  const after = {
    credentials: (await database.select({ n: count() }).from(credentials))[0]
      ?.n,
    creditGrants: (await database.select({ n: count() }).from(creditGrants))[0]
      ?.n,
    ledger: (await database.select({ n: count() }).from(creditLedger))[0]?.n,
    reservations: (
      await database.select({ n: count() }).from(creditReservations)
    )[0]?.n,
  };
  expect(after).toEqual(before);
});

test("the trail records the confirmation, and never the plaintext code", async () => {
  const identity = hint("trail");
  const userId = `${prefix}-trail-user`;
  await registeredBot("trail");
  const firstOffer = await liveOffer("trail", identity);
  const first = await request("/confirm", userId, {
    bindingCode: firstOffer.bindingCode,
  });
  expect(first.status).toBe(200);
  const { grantId } = (
    (await first.json()) as { accessGrant: { grantId: string } }
  ).accessGrant;

  const events = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "model_access.granted"),
        eq(auditEvents.targetId, grantId),
      ),
    );
  expect(events).toHaveLength(1);
  expect(events[0]?.actorUserId).toBe(userId);
  expect(events[0]?.payload).toMatchObject({
    grantId,
    userId,
    botId: `${prefix}-trail`,
    externalIdentity: identity,
    scope: MODEL_ACCESS_SCOPE,
    codeHash: bindingCodeHash(firstOffer.bindingCode),
  });
  expect(JSON.stringify(events[0]?.payload)).not.toContain(
    firstOffer.bindingCode,
  );

  // A repeated confirmation is its own event, not a second grant.
  const secondOffer = await liveOffer("trail", identity);
  const second = await request("/confirm", userId, {
    bindingCode: secondOffer.bindingCode,
  });
  expect(second.status).toBe(200);
  const reconfirmed = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "model_access.reconfirmed"),
        eq(auditEvents.targetId, grantId),
      ),
    );
  expect(reconfirmed).toHaveLength(1);
});

/** Which constraint a rejected write tripped (drizzle wraps the driver error, so cause holds it). */
async function violation(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("expected the write to be rejected");
    },
    (caught: unknown) => caught,
  );
  const driver = (error as { cause?: unknown }).cause ?? error;
  const { errno, constraint } = driver as {
    errno?: unknown;
    constraint?: unknown;
  };
  return { sqlState: errno, constraint };
}

test("the table itself keeps one active grant per identity and the status pair honest", async () => {
  const userId = `${prefix}-schema-user`;
  const bot = await registeredBot("schema");
  const identity = hint("schema");
  const row = {
    grantId: randomUUID(),
    userId,
    botId: bot.botId,
    externalIdentity: identity,
    scope: MODEL_ACCESS_SCOPE,
    status: "active" as const,
  };
  await database.insert(accessGrants).values(row);

  // A second active grant for the same (user, bot, identity) is the one thing the index forbids.
  expect(
    await violation(
      database
        .insert(accessGrants)
        .values({ ...row, grantId: randomUUID() })
        .execute(),
    ),
  ).toEqual({
    sqlState: "23505",
    constraint: "access_grants_one_active_per_identity",
  });

  // The status and revokedAt must agree, and the scope stays inside what exists.
  expect(
    await violation(
      database
        .insert(accessGrants)
        .values({
          ...row,
          grantId: randomUUID(),
          externalIdentity: hint("mismatch"),
          status: "active",
          revokedAt: new Date(),
        })
        .execute(),
    ),
  ).toEqual({
    sqlState: "23514",
    constraint: "access_grants_revoked_at_check",
  });
  expect(
    await violation(
      database
        .insert(accessGrants)
        .values({
          ...row,
          grantId: randomUUID(),
          externalIdentity: hint("scope"),
          scope: "everything" as never,
        })
        .execute(),
    ),
  ).toEqual({ sqlState: "23514", constraint: "access_grants_scope_check" });
});

test("without a composed service the surface answers a tagged 503", async () => {
  const bare = accessGrantRoutes(requireUser, undefined);
  const response = await bare.request("/confirm", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-test-user": `${prefix}-anyone`,
    },
    body: JSON.stringify({ bindingCode: "obot_bbind_x" }),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "Model access authorization is not available.",
    code: "model_access_unavailable",
  });
});
