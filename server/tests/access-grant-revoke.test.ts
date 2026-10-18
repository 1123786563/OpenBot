import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { and, count, eq, like } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createRequireUser } from "../src/auth/guards";
import {
  accessGrantRoutes,
  createAccessGrantService,
} from "../src/bot-services/access-grants";
import { createBindingOfferIssuer } from "../src/bot-services/binding-codes";
import { createBotServiceStore } from "../src/bot-services/store";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  auditEvents,
  botBindingOffers,
  botServices,
  creditGrants,
  creditLedger,
  creditReservations,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Bifrost #240 (04.7): the user-side authorization list and individual revocation.
 *
 * The questions here are the ticket's own: a person sees and can revoke only their own
 * authorizations (someone else's grant is the same silence as no grant at all), a revocation is
 * effective the instant it commits — the row reads revoked, and the downstream use check (the
 * resolveForUser seam 05.3/05.7 ride) refuses at once — a repeated revocation changes nothing
 * (idempotent), a consumption that already happened is not undone (no ledger, reservation or
 * credit grant row moves), and every real revocation leaves exactly one audit event.
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

const prefix = `b5-240-${randomUUID()}`;
const hint = (suffix = randomUUID().slice(0, 8)) => `slack:${prefix}-${suffix}`;

afterAll(async () => {
  // Grants name bots (FK), offers name bots (FK): children first, then the bots themselves.
  // Audit rows stay: audit_events is append-only by design, and each run names its own ids.
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
async function registeredBot(suffix: string) {
  const botId = `${prefix}-${suffix}`;
  const existing = await botStore.getBotService(botId);
  if (existing) return existing;
  return botStore.register({
    botId,
    displayName: `Revoke Bot ${suffix}`,
    kind: "external",
    capabilities: ["chat"],
  });
}

/** Confirm one grant for `userId` on `botSuffix` bound to `identity`, through the 04.5 flow. */
async function confirmedGrant(
  userId: string,
  botSuffix: string,
  identity = hint(),
) {
  await registeredBot(botSuffix);
  const offer = await issuer.issue(
    { botId: `${prefix}-${botSuffix}`, status: "active" },
    { externalIdentityHint: identity },
  );
  const { grant } = await service.confirm(userId, offer.bindingCode);
  return grant;
}

function request(
  path: string,
  userId: string | null,
  init: { method?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (userId) headers["x-openbot-test-user"] = userId;
  return app.request(path, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const REFUSED = {
  error: "That model access grant cannot be used.",
  code: "model_access_grant_refused",
};

test("the list shows only the caller's own grants, with bot, identity, status and time", async () => {
  const mine = `${prefix}-list-mine`;
  const theirs = `${prefix}-list-their`;
  const myGrant = await confirmedGrant(mine, "list", hint("mine"));
  await confirmedGrant(theirs, "list", hint("theirs"));

  const response = await request("/grants", mine);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const { grants } = (await response.json()) as {
    grants: Array<Record<string, unknown>>;
  };
  const own = grants.filter((grant) => grant.grantId === myGrant.grantId);
  expect(own).toHaveLength(1);
  expect(own[0]).toMatchObject({
    grantId: myGrant.grantId,
    botId: `${prefix}-list`,
    botDisplayName: "Revoke Bot list",
    externalIdentity: myGrant.externalIdentity,
    scope: "model-access",
    status: "active",
    revokedAt: null,
  });
  expect(typeof own[0]?.createdAt).toBe("string");

  // The other person's grant is nowhere in the answer — not even its shape or count.
  expect(
    grants.some(
      (grant) => grant.userId === theirs || grant.userId === "userId",
    ),
  ).toBe(false);
  for (const grant of grants) {
    expect(grant.userId).toBe(mine);
  }
});

test("revoking marks the grant revoked the instant the response returns, and the downstream use check refuses at once", async () => {
  const userId = `${prefix}-revoke-now`;
  const grant = await confirmedGrant(userId, "instant", hint("instant"));

  const response = await request(`/grants/${grant.grantId}/revoke`, userId, {
    method: "POST",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.json()) as {
    accessGrant: Record<string, unknown>;
    revoked: boolean;
  };
  expect(body.revoked).toBe(true);
  expect(body.accessGrant).toMatchObject({
    grantId: grant.grantId,
    userId,
    status: "revoked",
  });
  expect(typeof body.accessGrant.revokedAt).toBe("string");

  // The row itself is revoked, immediately, with the pair the schema demands.
  const [row] = await database
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.grantId, grant.grantId));
  expect(row?.status).toBe("revoked");
  expect(row?.revokedAt).not.toBeNull();

  // Downstream (05.3 issuance, 05.7 renewal, 06.2 revalidation) reads the same seam: refused now.
  await expect(service.resolveForUser(grant.grantId, userId)).rejects.toThrow();

  // And the list answers revoked from now on.
  const list = await request("/grants", userId);
  const listed = (
    (await list.json()) as {
      grants: Array<{ grantId: string; status: string }>;
    }
  ).grants.find((entry) => entry.grantId === grant.grantId);
  expect(listed?.status).toBe("revoked");
});

test("a repeated revocation is idempotent: the same revoked grant, no second audit event", async () => {
  const userId = `${prefix}-revoke-idem`;
  const grant = await confirmedGrant(userId, "idem", hint("idem"));

  const first = await request(`/grants/${grant.grantId}/revoke`, userId, {
    method: "POST",
  });
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as {
    accessGrant: { grantId: string; revokedAt: string | null };
    revoked: boolean;
  };
  expect(firstBody.revoked).toBe(true);

  const second = await request(`/grants/${grant.grantId}/revoke`, userId, {
    method: "POST",
  });
  expect(second.status).toBe(200);
  const secondBody = (await second.json()) as typeof firstBody;
  expect(secondBody.revoked).toBe(false);
  expect(secondBody.accessGrant.grantId).toBe(grant.grantId);
  expect(secondBody.accessGrant.status).toBe("revoked");

  // Exactly one revocation happened: exactly one audit event, and the revokedAt never moved.
  const [row] = await database
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.grantId, grant.grantId));
  expect(row?.revokedAt?.toISOString()).toBe(
    firstBody.accessGrant.revokedAt as string,
  );
  const events = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "model_access.revoked"),
        eq(auditEvents.targetId, grant.grantId),
      ),
    );
  expect(events).toHaveLength(1);
});

test("another person's grant is unrevokable and invisible: one uniform refusal", async () => {
  const owner = `${prefix}-cross-owner`;
  const attacker = `${prefix}-cross-attacker`;
  const grant = await confirmedGrant(owner, "cross", hint("cross"));

  const revoke = await request(`/grants/${grant.grantId}/revoke`, attacker, {
    method: "POST",
  });
  expect(revoke.status).toBe(404);
  expect(await revoke.json()).toEqual(REFUSED);

  // A grantId nobody issued is the same answer: neither confirms the other's existence.
  const unknown = await request(`/grants/${randomUUID()}/revoke`, attacker, {
    method: "POST",
  });
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual(REFUSED);

  // The owner's grant is untouched, still active.
  const [row] = await database
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.grantId, grant.grantId));
  expect(row?.status).toBe("active");

  // And the attacker's own list does not name it either.
  const list = await request("/grants", attacker);
  const grants = (await list.json()) as {
    grants: Array<{ grantId: string }>;
  };
  expect(grants.grants.some((entry) => entry.grantId === grant.grantId)).toBe(
    false,
  );
});

test("every real revocation writes one audit record naming the actor, and never a secret", async () => {
  const userId = `${prefix}-audit`;
  const grant = await confirmedGrant(userId, "audit", hint("audit"));

  await request(`/grants/${grant.grantId}/revoke`, userId, { method: "POST" });

  const events = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "model_access.revoked"),
        eq(auditEvents.targetId, grant.grantId),
      ),
    );
  expect(events).toHaveLength(1);
  expect(events[0]?.actorUserId).toBe(userId);
  expect(events[0]?.targetType).toBe("access_grant");
  expect(events[0]?.payload).toMatchObject({
    grantId: grant.grantId,
    userId,
    botId: `${prefix}-audit`,
    externalIdentity: grant.externalIdentity,
  });
});

test("revoking touches only the grant row: settled consumption keeps its ledger, reservations and grants", async () => {
  const userId = `${prefix}-settle`;
  const grant = await confirmedGrant(userId, "settle", hint("settle"));

  const before = {
    ledger: (await database.select({ n: count() }).from(creditLedger))[0]?.n,
    reservations: (
      await database.select({ n: count() }).from(creditReservations)
    )[0]?.n,
    creditGrants: (await database.select({ n: count() }).from(creditGrants))[0]
      ?.n,
  };

  const response = await request(`/grants/${grant.grantId}/revoke`, userId, {
    method: "POST",
  });
  expect(response.status).toBe(200);

  const after = {
    ledger: (await database.select({ n: count() }).from(creditLedger))[0]?.n,
    reservations: (
      await database.select({ n: count() }).from(creditReservations)
    )[0]?.n,
    creditGrants: (await database.select({ n: count() }).from(creditGrants))[0]
      ?.n,
  };
  // Revocation settles nothing and forgives nothing: the money facts are exactly as they were.
  expect(after).toEqual(before);
});

test("without a session neither the list nor a revocation answers", async () => {
  const list = await request("/grants", null);
  expect(list.status).toBe(401);
  const revoke = await request(`/grants/${randomUUID()}/revoke`, null, {
    method: "POST",
  });
  expect(revoke.status).toBe(401);
});

test("without a composed service the whole surface answers a tagged 503", async () => {
  const bare = accessGrantRoutes(requireUser, undefined);
  const list = await bare.request("/grants", {
    headers: { "x-openbot-test-user": `${prefix}-anyone` },
  });
  expect(list.status).toBe(503);
  expect(await list.json()).toEqual({
    error: "Model access authorization is not available.",
    code: "model_access_unavailable",
  });
});
