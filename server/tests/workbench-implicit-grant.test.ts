import { afterAll, expect, test } from "../../tests/support/e2e-compat";
import { randomUUID } from "node:crypto";
import { and, count, eq, like } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createRequireUser } from "../src/auth/guards";
import {
  accessGrantRoutes,
  createAccessGrantService,
  MODEL_ACCESS_SCOPE,
  WORKBENCH_BOT_ID,
} from "../src/bot-services/access-grants";
import { createBindingOfferIssuer } from "../src/bot-services/binding-codes";
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
 * Bifrost #241 (04.8): the built-in workbench bot's implicit authorization.
 *
 * The workbench is OpenBot itself: the signed-in session user is the authorization's subject, and
 * no binding code exists anywhere in this flow. What the ticket demands is that the implicit grant
 * is still a real grant — one auditable, revocable `access_grants` row marked `workbench-implicit`
 * and distinguishable from every binding-code grant — that a visitor without a session produces no
 * implicit authorization at all, and that the grant buys exactly the one narrow scope every other
 * grant has: no key, no credits, no company content, and no way past the admission revalidation
 * the downstream tickets run.
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
 * The real guard against a fake session source, exactly as 04.5/04.7's own files mount it: a
 * request without the header is what "not signed in" looks like here — and the 401 it gets is the
 * guard's own, not a route's imitation of one.
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

const prefix = `b5-241-${randomUUID()}`;

afterAll(async () => {
  // Grants name bots (FK), offers name bots (FK): children first, then the bots themselves.
  // Audit rows stay: audit_events is append-only by design, and each run names its own ids.
  await database
    .delete(accessGrants)
    .where(like(accessGrants.userId, `${prefix}%`));
  await database
    .delete(botBindingOffers)
    .where(like(botBindingOffers.botId, `${prefix}-wb-external%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}%`));
  await database.$client.close();
});

/** Register the well-known workbench bot as the deployment's own builtin Bot (04.1's act). */
async function registerWorkbenchBot() {
  const existing = await botStore.getBotService(WORKBENCH_BOT_ID);
  if (existing) return existing;
  return botStore.register({
    botId: WORKBENCH_BOT_ID,
    displayName: "OpenBot Workbench",
    kind: "builtin",
    capabilities: ["chat"],
  });
}

/**
 * An external Bot under this file's prefix plus one live binding offer for it, so the source
 * assertions have a real binding-code grant to stand next to.
 */
async function externalBindingCodeGrant(userId: string) {
  const botId = `${prefix}-wb-external`;
  const existing = await botStore.getBotService(botId);
  const bot =
    existing ??
    (await botStore.register({
      botId,
      displayName: "External Grant Bot",
      kind: "external",
      capabilities: ["chat"],
    }));
  const offer = await issuer.issue(
    { botId: bot.botId, status: "active" },
    { externalIdentityHint: `slack:${prefix}-${randomUUID().slice(0, 8)}` },
  );
  const response = await post(userId, "/confirm", {
    bindingCode: offer.bindingCode,
  });
  expect(response.status).toBe(200);
  const { accessGrant } = (await response.json()) as {
    accessGrant: Record<string, unknown>;
  };
  return accessGrant;
}

function request(
  path: string,
  userId: string | null,
  options: { method?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (userId) headers["x-openbot-test-user"] = userId;
  return app.request(path, {
    method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function post(userId: string | null, path: string, body: unknown = {}) {
  return request(path, userId, { method: "POST", body });
}

test("a visitor without a session is refused and no implicit grant exists", async () => {
  const response = await post(null, "/workbench/grant");
  expect(response.status).toBe(401);

  // Not signed in: no authorization of any kind exists for the visitor the request claimed.
  const rows = await database
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.userId, `${prefix}-anonymous`));
  expect(rows).toHaveLength(0);
});

test("a signed-in user is granted the builtin workbench bot with no binding code", async () => {
  await registerWorkbenchBot();
  const userId = `${prefix}-implicit-user`;

  const response = await post(userId, "/workbench/grant");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const { accessGrant, created } = (await response.json()) as {
    accessGrant: Record<string, unknown>;
    created: boolean;
  };
  expect(created).toBe(true);
  expect(accessGrant).toMatchObject({
    userId,
    botId: WORKBENCH_BOT_ID,
    // The subject is the login identity itself, not an external identity a code named.
    externalIdentity: `openbot:${userId}`,
    scope: MODEL_ACCESS_SCOPE,
    status: "active",
    revokedAt: null,
    source: "workbench-implicit",
  });
  expect(typeof accessGrant.grantId).toBe("string");

  // Exactly one row, and it is the one the response described.
  const rows = await database
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.grantId, accessGrant.grantId as string));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    userId,
    botId: WORKBENCH_BOT_ID,
    externalIdentity: `openbot:${userId}`,
    scope: MODEL_ACCESS_SCOPE,
    status: "active",
    source: "workbench-implicit",
    revokedAt: null,
  });
});

test("asking twice is the same grant: the implicit grant is idempotent", async () => {
  await registerWorkbenchBot();
  const userId = `${prefix}-idem-user`;

  const first = await post(userId, "/workbench/grant");
  expect(first.status).toBe(200);
  const second = await post(userId, "/workbench/grant");
  expect(second.status).toBe(200);
  const [firstBody, secondBody] = (await Promise.all([
    first.json(),
    second.json(),
  ])) as [
    { accessGrant: { grantId: string }; created: boolean },
    { accessGrant: { grantId: string }; created: boolean },
  ];
  expect(firstBody.created).toBe(true);
  expect(secondBody.created).toBe(false);
  expect(secondBody.accessGrant.grantId).toBe(firstBody.accessGrant.grantId);

  const active = await database
    .select()
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.userId, userId),
        eq(accessGrants.botId, WORKBENCH_BOT_ID),
        eq(accessGrants.status, "active"),
      ),
    );
  expect(active).toHaveLength(1);
});

test("the implicit source is distinct from the binding-code source, in the row and in the list", async () => {
  await registerWorkbenchBot();
  const userId = `${prefix}-source-user`;
  const implicit = await post(userId, "/workbench/grant");
  expect(implicit.status).toBe(200);
  const external = await externalBindingCodeGrant(userId);

  const implicitBody = (await implicit.json()) as {
    accessGrant: { grantId: string; source?: string };
  };
  expect(implicitBody.accessGrant.source).toBe("workbench-implicit");
  expect((external as { source?: string }).source).toBe("binding-code");

  const [implicitRow] = await database
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.grantId, implicitBody.accessGrant.grantId));
  const [externalRow] = await database
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.grantId, (external as { grantId: string }).grantId));
  expect(implicitRow?.source).toBe("workbench-implicit");
  expect(externalRow?.source).toBe("binding-code");

  // The person's own list carries the source, so the two kinds stay distinguishable on screen.
  const list = await request("/grants", userId);
  expect(list.status).toBe(200);
  const { grants } = (await list.json()) as {
    grants: Array<{ grantId: string; source: string }>;
  };
  const listedImplicit = grants.find(
    (grant) => grant.grantId === implicitBody.accessGrant.grantId,
  );
  const listedExternal = grants.find(
    (grant) => grant.grantId === (external as { grantId: string }).grantId,
  );
  expect(listedImplicit?.source).toBe("workbench-implicit");
  expect(listedExternal?.source).toBe("binding-code");
});

test("the implicit grant is revocable through the user's own revocation, and stays revoked", async () => {
  await registerWorkbenchBot();
  const userId = `${prefix}-revoke-user`;
  const granted = await post(userId, "/workbench/grant");
  const { accessGrant } = (await granted.json()) as {
    accessGrant: { grantId: string };
  };

  const revoked = await post(userId, `/grants/${accessGrant.grantId}/revoke`);
  expect(revoked.status).toBe(200);
  const revokedBody = (await revoked.json()) as {
    accessGrant: { status: string; revokedAt: string | null };
    revoked: boolean;
  };
  expect(revokedBody.revoked).toBe(true);
  expect(revokedBody.accessGrant.status).toBe("revoked");
  expect(revokedBody.accessGrant.revokedAt).not.toBeNull();

  // Revocation is sticky: continuing to use the workbench does not silently resurrect it.
  const again = await post(userId, "/workbench/grant");
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    error:
      "Your workbench model access was revoked. Re-authorize to restore it.",
    code: "workbench_grant_revoked",
  });
  const active = await database
    .select()
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.userId, userId),
        eq(accessGrants.botId, WORKBENCH_BOT_ID),
        eq(accessGrants.status, "active"),
      ),
    );
  expect(active).toHaveLength(0);

  // An explicit re-authorization is a new grant; the revoked one stays dead in history.
  const reauthorized = await post(userId, "/workbench/grant", {
    reauthorize: true,
  });
  expect(reauthorized.status).toBe(200);
  const reauthorizedBody = (await reauthorized.json()) as {
    accessGrant: { grantId: string };
    created: boolean;
  };
  expect(reauthorizedBody.created).toBe(true);
  expect(reauthorizedBody.accessGrant.grantId).not.toBe(accessGrant.grantId);
  const rows = await database
    .select()
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.userId, userId),
        eq(accessGrants.botId, WORKBENCH_BOT_ID),
      ),
    );
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.grantId === accessGrant.grantId)?.status).toBe(
    "revoked",
  );
  expect(
    rows.find((row) => row.grantId === reauthorizedBody.accessGrant.grantId)
      ?.status,
  ).toBe("active");
});

test("two re-authorizations racing land on one grant, not two", async () => {
  await registerWorkbenchBot();
  const userId = `${prefix}-race-user`;
  const granted = await post(userId, "/workbench/grant");
  const { accessGrant } = (await granted.json()) as {
    accessGrant: { grantId: string };
  };
  await post(userId, `/grants/${accessGrant.grantId}/revoke`);

  // Two windows of the workbench re-authorize at once: the database's partial unique index is
  // the answer both land on — one new grant, one twin, the loser returning the winner's row.
  const [left, right] = await Promise.all([
    post(userId, "/workbench/grant", { reauthorize: true }),
    post(userId, "/workbench/grant", { reauthorize: true }),
  ]);
  expect(left.status).toBe(200);
  expect(right.status).toBe(200);
  const [leftBody, rightBody] = (await Promise.all([
    left.json(),
    right.json(),
  ])) as [
    { accessGrant: { grantId: string }; created: boolean },
    { accessGrant: { grantId: string }; created: boolean },
  ];
  expect(leftBody.accessGrant.grantId).toBe(rightBody.accessGrant.grantId);
  expect([leftBody.created, rightBody.created].filter(Boolean)).toHaveLength(1);

  const active = await database
    .select()
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.userId, userId),
        eq(accessGrants.botId, WORKBENCH_BOT_ID),
        eq(accessGrants.status, "active"),
      ),
    );
  expect(active).toHaveLength(1);
});

test("an implicit grant revocation is audited with its source", async () => {
  await registerWorkbenchBot();
  const userId = `${prefix}-audit-user`;
  const granted = await post(userId, "/workbench/grant");
  const { accessGrant } = (await granted.json()) as {
    accessGrant: { grantId: string };
  };

  const events = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "model_access.granted"),
        eq(auditEvents.targetId, accessGrant.grantId),
      ),
    );
  expect(events).toHaveLength(1);
  expect(events[0]?.actorUserId).toBe(userId);
  expect(events[0]?.payload).toMatchObject({
    grantId: accessGrant.grantId,
    userId,
    botId: WORKBENCH_BOT_ID,
    externalIdentity: `openbot:${userId}`,
    scope: MODEL_ACCESS_SCOPE,
    source: "workbench-implicit",
  });

  await post(userId, `/grants/${accessGrant.grantId}/revoke`);
  const revocations = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "model_access.revoked"),
        eq(auditEvents.targetId, accessGrant.grantId),
      ),
    );
  expect(revocations).toHaveLength(1);
  expect(revocations[0]?.payload).toMatchObject({
    source: "workbench-implicit",
  });
});

/*
 * F1 (review-241): the audit trail must survive its own failures. `confirm` answers an existing
 * active grant with `model_access.reconfirmed` precisely so a retry after a failed audit write
 * still names the authorization; `ensureWorkbenchGrant` must hold the same line — every ensure
 * that returns an active row is audited, `granted` when it created the row, `reconfirmed` when it
 * answered one. An authorization the trail cannot name is one that failed, and the retry is what
 * heals the trail.
 */
test("an ensure whose audit write failed is re-audited by the retry, not silently unaudited", async () => {
  await registerWorkbenchBot();
  const userId = `${prefix}-audit-heal-user`;

  // First ensure: the grant row commits, then the audit write fails — the caller sees the error.
  let auditInserts = 0;
  const flakyAudit = createAccessGrantService({
    database,
    botServices: botStore,
    auditStore: {
      insert: async (event) => {
        auditInserts += 1;
        if (auditInserts === 1) throw new Error("audit store unavailable");
        await auditStore.insert(event);
      },
    },
  });
  await expect(flakyAudit.ensureWorkbenchGrant(userId)).rejects.toThrow(
    "audit store unavailable",
  );
  expect(auditInserts).toBe(1);

  // The retry answers the already-committed active row — and must still name it in the trail,
  // exactly like confirm's reconfirmed: the retry is the self-heal, not a silent second grant.
  const retry = await service.ensureWorkbenchGrant(userId);
  expect(retry.created).toBe(false);

  const healed = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "model_access.reconfirmed"),
        eq(auditEvents.targetId, retry.grant.grantId),
      ),
    );
  expect(healed).toHaveLength(1);
  expect(healed[0]?.actorUserId).toBe(userId);
  expect(healed[0]?.payload).toMatchObject({
    grantId: retry.grant.grantId,
    userId,
    botId: WORKBENCH_BOT_ID,
    externalIdentity: `openbot:${userId}`,
    scope: MODEL_ACCESS_SCOPE,
    source: "workbench-implicit",
  });
});

test("every ensure that answers an active row is its own audit event", async () => {
  await registerWorkbenchBot();
  const userId = `${prefix}-reconfirm-user`;

  const first = await service.ensureWorkbenchGrant(userId);
  expect(first.created).toBe(true);
  const second = await service.ensureWorkbenchGrant(userId);
  expect(second.created).toBe(false);
  expect(second.grant.grantId).toBe(first.grant.grantId);

  const granted = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "model_access.granted"),
        eq(auditEvents.targetId, first.grant.grantId),
      ),
    );
  expect(granted).toHaveLength(1);
  const reconfirmed = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "model_access.reconfirmed"),
        eq(auditEvents.targetId, first.grant.grantId),
      ),
    );
  expect(reconfirmed).toHaveLength(1);
  expect(reconfirmed[0]?.actorUserId).toBe(userId);
});

test("the implicit grant grants nothing else: no key, no credits, no wider scope", async () => {
  await registerWorkbenchBot();
  const userId = `${prefix}-no-side-effects-user`;

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

  const granted = await post(userId, "/workbench/grant");
  expect(granted.status).toBe(200);
  const { accessGrant } = (await granted.json()) as {
    accessGrant: {
      grantId: string;
      scope: string;
      source: string;
    };
  };

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

  // The one scope every grant has — model access on the person's own authorization, which the
  // admission revalidation (06.2) resolves and refuses when it is revoked. Nothing implicit
  // widens it: no company-content scope exists here to hold.
  expect(accessGrant.scope).toBe(MODEL_ACCESS_SCOPE);
  expect(accessGrant.source).toBe("workbench-implicit");

  // The door 05.3/06.2 resolve through accepts the live grant...
  const identity = {
    botId: WORKBENCH_BOT_ID,
    status: "active" as const,
  };
  const resolved = await service.resolveForBot(
    accessGrant.grantId,
    identity as Parameters<typeof service.resolveForBot>[1],
  );
  expect(resolved.grantId).toBe(accessGrant.grantId);

  // ...and refuses the same grantId the instant it is revoked.
  await post(userId, `/grants/${accessGrant.grantId}/revoke`);
  await expect(
    service.resolveForBot(
      accessGrant.grantId,
      identity as Parameters<typeof service.resolveForBot>[1],
    ),
  ).rejects.toThrowError(/cannot be used|model access grant/i);
});

test("an unregistered, disabled or non-builtin workbench bot refuses, creating nothing", async () => {
  const unavailable = {
    error: "The built-in workbench bot is not available.",
    code: "workbench_grant_unavailable",
  };

  /**
   * The routes with the well-known id resolved to whatever this test aims the lookup at. The
   * registry read is the seam the deployment's own state arrives through; the grants still live
   * in the same real SQL this file tests everywhere else.
   */
  const appResolvingWorkbenchAs = (
    resolved: Awaited<ReturnType<typeof botStore.getBotService>>,
  ) =>
    accessGrantRoutes(
      requireUser,
      createAccessGrantService({
        database,
        botServices: {
          getBotService: async (botId: string) =>
            botId === WORKBENCH_BOT_ID
              ? resolved
              : botStore.getBotService(botId),
        },
        auditStore,
      }),
    );
  const grantRequest = (
    appToAsk: ReturnType<typeof accessGrantRoutes>,
    user: string,
  ) =>
    appToAsk.request("/workbench/grant", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-test-user": user,
      },
      body: JSON.stringify({}),
    });

  // A deployment that never registered the workbench bot: the whole flow is unavailable.
  const missing = await grantRequest(
    appResolvingWorkbenchAs(null),
    `${prefix}-missing-user`,
  );
  expect(missing.status).toBe(503);
  expect(await missing.json()).toEqual(unavailable);

  // Disabled after registration: the same refusal, and still no grant. (The bot was registered
  // by the earlier tests in this file — rows are never deleted — so this is the real row.)
  expect((await botStore.getBotService(WORKBENCH_BOT_ID))?.status).toBe(
    "active",
  );
  await botStore.disable(WORKBENCH_BOT_ID);
  const disabled = await grantRequest(
    appResolvingWorkbenchAs(await botStore.getBotService(WORKBENCH_BOT_ID)),
    `${prefix}-disabled-user`,
  );
  expect(disabled.status).toBe(503);
  expect(await disabled.json()).toEqual(unavailable);
  await botStore.enable(WORKBENCH_BOT_ID);

  // An external Bot squatting the well-known identity is not the workbench: refuse. The record
  // is a real registry row registered under this file's prefix.
  const squatBotId = `${prefix}-wb-squat`;
  const squat = await botStore.register({
    botId: squatBotId,
    displayName: "Not the workbench",
    kind: "external",
    capabilities: ["chat"],
  });
  const squatResponse = await grantRequest(
    appResolvingWorkbenchAs(squat),
    `${prefix}-squat-user`,
  );
  expect(squatResponse.status).toBe(503);
  expect(await squatResponse.json()).toEqual(unavailable);

  // No request in this test produced any grant row at all.
  for (const user of [
    `${prefix}-missing-user`,
    `${prefix}-disabled-user`,
    `${prefix}-squat-user`,
  ]) {
    const rows = await database
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.userId, user));
    expect(rows).toHaveLength(0);
  }
});
