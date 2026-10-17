import { afterAll, expect, test } from "../../tests/support/e2e-compat";
import { randomBytes, randomUUID } from "node:crypto";
import { and, count, eq, like } from "drizzle-orm";
import { Hono } from "hono";
import { createAuditStore } from "../src/audit";
import { type AppVariables, createRequireUser } from "../src/auth/guards";
import {
  AccessGrantUseError,
  accessGrantRoutes,
} from "../src/bot-services/access-grants";
import { botServiceRoutes } from "../src/bot-services/auth";
import {
  bindingCodeHash,
  createBindingOfferIssuer,
} from "../src/bot-services/binding-codes";
import { botServiceCredentialRoutes } from "../src/bot-services/credential-routes";
import { createBotServiceRegistry } from "../src/bot-services/registry";
import { botServiceAdminRoutes } from "../src/bot-services/routes";
import type { BotServiceIdentity } from "../src/bot-services/types";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  accessGrants,
  botBindingOffers,
  botServices,
  credentials,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Bifrost #239 (04.6): the impersonation and service-only refusal paths.
 *
 * Four attack paths, one answer each (AC03): a body that names another user's userId or email
 * buys nobody's authorization; a Bot's service credential alone buys no user credential of any
 * kind; an authorization granted to one Bot cannot be used by another; a revoked authorization
 * cannot be reused. Every refusal says one thing and no more — none of them may leak that some
 * other user, grant or Bot exists. The collection is also the rejection-path checklist 22.1
 * audits the whole entry inventory against: the composed app below mounts group 04's surfaces
 * exactly as app.ts does, and its route table is probed entry by entry.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
/** A fresh deployment key per run: ciphertext from an earlier run must not verify. */
const encryptionKey = randomBytes(32).toString("base64");
const registry = createBotServiceRegistry(database, {
  encryptionKey,
  credentialStore: createCredentialStore(database),
  auditStore,
});
const issuer = createBindingOfferIssuer({ database, auditStore });

/**
 * The real guard against a fake session source, with a mutable role map so the admin surfaces can
 * be probed for the 403 a non-administrator must get. A request without the header is what "not
 * signed in" looks like, and the 401 it gets is the guard's own.
 */
const roles = new Map<string, "user" | "admin">();
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
          },
        };
      },
    },
  },
  { rolesForUser: async (id) => [roles.get(id) ?? "user"] },
);

/** Group 04's surfaces, mounted exactly as app.ts mounts them. */
const app = new Hono<{ Variables: AppVariables }>();
app.route(
  "/api/admin/bot-services",
  botServiceAdminRoutes(requireUser, registry, auditStore),
);
app.route(
  "/api/admin/bot-services",
  botServiceCredentialRoutes(requireUser, registry),
);
app.route(
  "/api/bot-service",
  botServiceRoutes({
    authenticate: registry.authenticate,
    bindingCodes: registry.bindingCodes,
  }),
);
app.route(
  "/api/model-access",
  accessGrantRoutes(requireUser, registry.modelAccess),
);

const prefix = `b5-239-${randomUUID()}`;
const owner = `${prefix}-owner`;
const stranger = `${prefix}-stranger`;
const strangerEmail = `${stranger}@example.test`;

/** Every refusal body this file produces, for the no-leak sweep at the end. */
const refusalBodies: string[] = [];

/**
 * Read one response once, and if it is a refusal record its body for the sweep. Each refusal
 * test also asserts its exact tagged shape, so the sweep only double-checks what the body may
 * never name: another user, another grant, another Bot.
 */
async function read(response: Response): Promise<string> {
  const text = await response.text();
  if (response.status >= 400) refusalBodies.push(text);
  return text;
}

function request(
  path: string,
  options: {
    method?: string;
    userId?: string | null;
    botSecret?: string;
    body?: unknown;
  } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.userId) headers["x-openbot-test-user"] = options.userId;
  if (options.botSecret) headers.authorization = `Bearer ${options.botSecret}`;
  return app.request(path, {
    method: options.method ?? "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

afterAll(async () => {
  // Grants name bots (FK), offers name bots (FK): children first, then the bots and their vault
  // rows. Audit rows stay: audit_events is append-only by design and each run names its own ids.
  await database
    .delete(accessGrants)
    .where(like(accessGrants.userId, `${prefix}%`));
  await database
    .delete(botBindingOffers)
    .where(like(botBindingOffers.botId, `${prefix}%`));
  await database
    .delete(credentials)
    .where(like(credentials.keyId, `${prefix}%`));
  await database
    .delete(botServices)
    .where(like(botServices.botId, `${prefix}%`));
  await database.$client.close();
});

/** A registered, credentialed bot under this file's prefix; returns its secret exactly once. */
async function credentialedBot(suffix: string) {
  const botId = `${prefix}-${suffix}`;
  if (!(await registry.getBotService(botId))) {
    await registry.register({
      botId,
      displayName: `Impersonation Bot ${suffix}`,
      kind: "external",
      capabilities: ["chat"],
    });
  }
  const issued = await registry.credentials.issue(botId);
  return { botId, secret: issued.secret };
}

/** One live binding offer for a bot under this file's prefix: the plaintext code exactly once. */
async function liveCode(botId: string, externalIdentityHint: string) {
  return issuer.issue({ botId, status: "active" }, { externalIdentityHint });
}

/** Confirm one authorization through the real HTTP flow; returns what the API answered. */
async function confirmGrant(
  userId: string,
  botId: string,
  externalIdentityHint: string,
) {
  const offer = await liveCode(botId, externalIdentityHint);
  const response = await request("/api/model-access/confirm", {
    userId,
    body: { bindingCode: offer.bindingCode },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    accessGrant: {
      grantId: string;
      userId: string;
      botId: string;
      status: string;
    };
    created: boolean;
  };
  return { offer, response, ...body };
}

const INVALID_REQUEST = {
  error: "Send the binding code the Bot gave you.",
  code: "model_access_invalid_request",
};
const AUTH_REQUIRED = { error: "Authentication required." };
const BOT_AUTH_FAILED = {
  error: "Bot service authentication failed.",
  code: "bot_service_auth_failed",
};

let botAId = "";
let botBId = "";
let grantAId = "";

test("fixtures: the owner holds one active grant on bot A, bot B holds a credential", async () => {
  const a = await credentialedBot("bot-a");
  botAId = a.botId;
  const b = await credentialedBot("bot-b");
  botBId = b.botId;
  const confirmed = await confirmGrant(
    owner,
    botAId,
    `slack:${prefix}-owner-identity`,
  );
  grantAId = confirmed.accessGrant.grantId;
  expect(confirmed.created).toBe(true);
  expect(confirmed.accessGrant.status).toBe("active");

  const active = await database
    .select()
    .from(accessGrants)
    .where(
      and(eq(accessGrants.userId, owner), eq(accessGrants.status, "active")),
    );
  expect(active).toHaveLength(1);
});

test("a body naming another user's userId, email or identity is refused and the code survives", async () => {
  const hint = `slack:${prefix}-forge`;
  const offer = await liveCode(botAId, hint);

  const forged = await request("/api/model-access/confirm", {
    userId: owner,
    body: {
      bindingCode: offer.bindingCode,
      userId: stranger,
      email: strangerEmail,
      externalIdentity: hint,
    },
  });
  expect(forged.status).toBe(400);
  expect(JSON.parse(await read(forged))).toEqual(INVALID_REQUEST);

  // The code was not consumed and no row exists for the forged user: the boundary refused before
  // the service read anything.
  const [row] = await database
    .select()
    .from(botBindingOffers)
    .where(eq(botBindingOffers.codeHash, bindingCodeHash(offer.bindingCode)));
  expect(row?.status).toBe("pending");
  const forStranger = await database
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.userId, stranger));
  expect(forStranger).toHaveLength(0);

  // The same forgery on the preview route: refused before anything is shown.
  const preview = await request("/api/model-access/binding-preview", {
    userId: owner,
    body: {
      bindingCode: offer.bindingCode,
      userId: stranger,
      email: strangerEmail,
    },
  });
  expect(preview.status).toBe(400);
  expect(JSON.parse(await read(preview))).toEqual(INVALID_REQUEST);
});

test("a forged user in the query string cannot redirect whose authorization is created", async () => {
  const offer = await liveCode(botAId, `slack:${prefix}-query`);
  const response = await request(
    `/api/model-access/confirm?userId=${encodeURIComponent(stranger)}&email=${encodeURIComponent(strangerEmail)}`,
    { userId: owner, body: { bindingCode: offer.bindingCode } },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    accessGrant: { grantId: string; userId: string };
  };
  // The grant belongs to the session's own user, whoever the query tried to name.
  expect(body.accessGrant.userId).toBe(owner);

  const forStranger = await database
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.userId, stranger));
  expect(forStranger).toHaveLength(0);
});

test("the confirmation answers only the session's own grant, and the preview names nobody", async () => {
  const hint = `slack:${prefix}-own-view`;
  const offer = await liveCode(botAId, hint);
  const seen = await request("/api/model-access/binding-preview", {
    userId: owner,
    body: { bindingCode: offer.bindingCode },
  });
  expect(seen.status).toBe(200);
  const previewBody = JSON.parse(await read(seen)) as Record<string, unknown>;
  expect(Object.keys(previewBody)).toEqual(["preview"]);
  expect(Object.keys(previewBody.preview as object).sort()).toEqual([
    "bot",
    "expiresAt",
    "externalIdentity",
    "scope",
  ]);
  // A preview of what would be authorized names the Bot and the identity, never a user.
  expect(JSON.stringify(previewBody)).not.toContain(owner);
  expect(JSON.stringify(previewBody)).not.toContain("@example.test");

  const response = await request("/api/model-access/confirm", {
    userId: owner,
    body: { bindingCode: offer.bindingCode },
  });
  expect(response.status).toBe(200);
  const body = JSON.parse(await read(response)) as {
    accessGrant: Record<string, unknown>;
    created: boolean;
  };
  expect(Object.keys(body).sort()).toEqual(["accessGrant", "created"]);
  expect(Object.keys(body.accessGrant).sort()).toEqual([
    "botId",
    "createdAt",
    "externalIdentity",
    "grantId",
    "revokedAt",
    "scope",
    // 04.8 marks which flow created a grant; this flow's is always the binding code.
    "source",
    "status",
    "userId",
  ]);
  expect(body.accessGrant.userId).toBe(owner);
});

test("a bot service credential alone opens no user surface", async () => {
  const { secret } = await credentialedBot("bot-a");
  const before = (await database.select({ n: count() }).from(accessGrants))[0]
    ?.n;

  // The bot's valid credential is not a session: both user routes refuse it as nobody at all.
  const preview = await request("/api/model-access/binding-preview", {
    botSecret: secret,
    body: { bindingCode: "obot_bbind_x" },
  });
  expect(preview.status).toBe(401);
  expect(JSON.parse(await read(preview))).toEqual(AUTH_REQUIRED);

  const confirm = await request("/api/model-access/confirm", {
    botSecret: secret,
    body: { bindingCode: "obot_bbind_x" },
  });
  expect(confirm.status).toBe(401);
  expect(JSON.parse(await read(confirm))).toEqual(AUTH_REQUIRED);

  // The administrator's credential surface is not a bot's either: a service credential is not a
  // session there, so no bot can mint anything with its own token.
  const adminIssue = await request(
    `/api/admin/bot-services/${botAId}/credentials`,
    { botSecret: secret, body: {} },
  );
  expect(adminIssue.status).toBe(401);
  expect(JSON.parse(await read(adminIssue))).toEqual(AUTH_REQUIRED);

  // Nothing was authorized or minted by any of it.
  const after = (await database.select({ n: count() }).from(accessGrants))[0]
    ?.n;
  expect(after).toBe(before);
  const [offer] = await database
    .select()
    .from(botBindingOffers)
    .where(eq(botBindingOffers.codeHash, bindingCodeHash("obot_bbind_x")));
  expect(offer).toBeUndefined();
});

test("an invalid bot credential is refused uniformly on the bot surface", async () => {
  const wrong = `obot_bsvc_${botAId}~${randomBytes(32).toString("base64url")}`;
  const response = await request("/api/bot-service", {
    method: "GET",
    botSecret: wrong,
  });
  expect(response.status).toBe(401);
  expect(JSON.parse(await read(response))).toEqual(BOT_AUTH_FAILED);

  const noToken = await request("/api/bot-service", { method: "GET" });
  expect(noToken.status).toBe(401);
  expect(JSON.parse(await read(noToken))).toEqual(BOT_AUTH_FAILED);
});

test("what a bot service credential can see and ask for carries no user credential", async () => {
  const { botId, secret } = await credentialedBot("bot-b");

  const who = await request("/api/bot-service", {
    method: "GET",
    botSecret: secret,
  });
  expect(who.status).toBe(200);
  const whoBody = JSON.parse(await read(who)) as Record<string, unknown>;
  // The whole answer: which bot. No user, grant, key or balance field of any kind.
  expect(whoBody).toEqual({
    botService: { botId, status: "active" },
  });

  const beforeGrants = (
    await database.select({ n: count() }).from(accessGrants)
  )[0]?.n;
  const beforeCredentials = (
    await database.select({ n: count() }).from(credentials)
  )[0]?.n;

  const issuance = await request("/api/bot-service/binding-codes", {
    botSecret: secret,
    body: { externalIdentityHint: `slack:${prefix}-issued` },
  });
  expect(issuance.status).toBe(200);
  const issuanceBody = JSON.parse(await read(issuance)) as {
    bindingOffer: Record<string, unknown>;
  };
  expect(Object.keys(issuanceBody)).toEqual(["bindingOffer"]);
  expect(Object.keys(issuanceBody.bindingOffer).sort()).toEqual([
    "bindingCode",
    "botId",
    "expiresAt",
    "externalIdentityHint",
    "singleUse",
    "status",
  ]);
  expect(issuanceBody.bindingOffer.botId).toBe(botId);
  // The offer is a claim ticket for one (bot, identity) pair, not a user credential: no grantId,
  // no virtual key, no user id in it.
  expect(JSON.stringify(issuanceBody)).not.toMatch(/grantId|"userId"|virtual/i);

  // Issuance created no authorization and no credential of any kind.
  expect((await database.select({ n: count() }).from(accessGrants))[0]?.n).toBe(
    beforeGrants,
  );
  expect((await database.select({ n: count() }).from(credentials))[0]?.n).toBe(
    beforeCredentials,
  );

  // And the code it minted, held with no user session anywhere, confirms nothing.
  const anonymous = await request("/api/model-access/confirm", {
    body: { bindingCode: issuanceBody.bindingOffer.bindingCode },
  });
  expect(anonymous.status).toBe(401);
  expect(JSON.parse(await read(anonymous))).toEqual(AUTH_REQUIRED);
  const [still] = await database
    .select()
    .from(botBindingOffers)
    .where(
      eq(
        botBindingOffers.codeHash,
        bindingCodeHash(issuanceBody.bindingOffer.bindingCode as string),
      ),
    );
  expect(still?.status).toBe("pending");
});

test("an authorization cannot be used by another bot", async () => {
  const service = registry.modelAccess;
  const strangerBot: BotServiceIdentity = { botId: botBId, status: "active" };

  const crossBot = await service.resolveForBot(grantAId, strangerBot).then(
    () => {
      throw new Error("expected the cross-bot use to be refused");
    },
    (caught: unknown) => caught,
  );
  expect(crossBot).toBeInstanceOf(AccessGrantUseError);
  // The refusal that says "not yours" is byte-identical to the one that says "no such grant":
  // a bot probing grantIds learns nothing.
  const unknown = await service
    .resolveForBot(`b5-239-${randomUUID()}`, strangerBot)
    .then(
      () => {
        throw new Error("expected the unknown grant to be refused");
      },
      (caught: unknown) => caught,
    );
  expect((crossBot as Error).message).toBe((unknown as Error).message);
  expect(
    (crossBot as AccessGrantUseError).code ===
      (unknown as AccessGrantUseError).code,
  ).toBe(true);

  // The refused use changed nothing: the grant is exactly as it was.
  const [row] = await database
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.grantId, grantAId));
  expect(row?.status).toBe("active");
});

test("an unregistered or disabled bot cannot use an authorization either", async () => {
  const service = registry.modelAccess;
  const grant = await confirmGrant(owner, botAId, `slack:${prefix}-disabled`);

  // A bot that was never registered has no identity to use anything with.
  const ghost: BotServiceIdentity = {
    botId: `${prefix}-ghost`,
    status: "active",
  };
  await expect(
    service.resolveForBot(grant.accessGrant.grantId, ghost),
  ).rejects.toBeInstanceOf(AccessGrantUseError);

  // The grant's own bot, disabled after the confirmation, is refused too: the registry's live
  // status is the last word, exactly as it is at confirmation time.
  await registry.disable(botAId);
  await expect(
    service.resolveForBot(grant.accessGrant.grantId, {
      botId: botAId,
      status: "active",
    }),
  ).rejects.toBeInstanceOf(AccessGrantUseError);
  await registry.enable(botAId);

  // With the bot active again, the same call is the one refusal that becomes an answer.
  const resolved = await service.resolveForBot(grant.accessGrant.grantId, {
    botId: botAId,
    status: "active",
  });
  expect(resolved.grantId).toBe(grant.accessGrant.grantId);
  expect(resolved.botId).toBe(botAId);
  expect(resolved.userId).toBe(owner);
  expect(resolved.status).toBe("active");
});

test("a grant is only ever resolved for its own user, and refuses others without naming them", async () => {
  const service = registry.modelAccess;
  const grant = await confirmGrant(owner, botAId, `slack:${prefix}-user-scope`);

  // Another signed-in user gets the same refusal an unknown grantId gets: whether the grant
  // exists, and whose it is, is nobody else's information.
  const foreign = await service
    .resolveForUser(grant.accessGrant.grantId, stranger)
    .then(
      () => {
        throw new Error("expected the foreign use to be refused");
      },
      (caught: unknown) => caught,
    );
  const unknown = await service
    .resolveForUser(`b5-239-${randomUUID()}`, stranger)
    .then(
      () => {
        throw new Error("expected the unknown grant to be refused");
      },
      (caught: unknown) => caught,
    );
  expect(foreign).toBeInstanceOf(AccessGrantUseError);
  expect((foreign as Error).message).toBe((unknown as Error).message);

  const own = await service.resolveForUser(grant.accessGrant.grantId, owner);
  expect(own.grantId).toBe(grant.accessGrant.grantId);
  expect(own.userId).toBe(owner);
});

test("a revoked authorization cannot be reused, only replaced", async () => {
  const service = registry.modelAccess;
  const grant = await confirmGrant(owner, botAId, `slack:${prefix}-revoke`);
  const grantId = grant.accessGrant.grantId;

  // 04.7's revocation is a status, not a deletion; the schema already holds it.
  await database
    .update(accessGrants)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(eq(accessGrants.grantId, grantId));

  // Bot use and owner use are both refused, with the same silence as an unknown grant.
  const byBot = await service
    .resolveForBot(grantId, { botId: botAId, status: "active" })
    .then(
      () => {
        throw new Error("expected the revoked use to be refused");
      },
      (caught: unknown) => caught,
    );
  const byOwner = await service.resolveForUser(grantId, owner).then(
    () => {
      throw new Error("expected the revoked use to be refused");
    },
    (caught: unknown) => caught,
  );
  expect(byBot).toBeInstanceOf(AccessGrantUseError);
  expect(byOwner).toBeInstanceOf(AccessGrantUseError);
  const unknownBot = await service
    .resolveForBot(`b5-239-${randomUUID()}`, {
      botId: botAId,
      status: "active",
    })
    .then(
      () => {
        throw new Error("expected the unknown grant to be refused");
      },
      (caught: unknown) => caught,
    );
  expect((byBot as Error).message).toBe((unknownBot as Error).message);

  // The dead grant stays in the table forever, and a fresh confirmation is a NEW authorization:
  // a new grantId beside the old row, never the revoked one handed out again.
  const replacement = await confirmGrant(
    owner,
    botAId,
    `slack:${prefix}-revoke`,
  );
  expect(replacement.created).toBe(true);
  expect(replacement.accessGrant.grantId).not.toBe(grantId);
  const rows = await database
    .select()
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.userId, owner),
        eq(accessGrants.botId, botAId),
        eq(accessGrants.externalIdentity, `slack:${prefix}-revoke`),
      ),
    );
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.status).sort()).toEqual(["active", "revoked"]);
});

test("no refusal anywhere names another user, grant or bot", async () => {
  // Every 4xx body this file produced, read in one place: none may carry someone else's
  // user id, email, grant id, or another bot's name or identity hint.
  expect(refusalBodies.length).toBeGreaterThan(0);
  for (const body of refusalBodies) {
    expect(body).not.toContain(stranger);
    expect(body).not.toContain(strangerEmail);
    expect(body).not.toContain(grantAId);
    expect(body).not.toContain("Impersonation Bot");
    expect(body).not.toContain(`${prefix}-owner-identity`);
    expect(body).not.toContain(`${prefix}-disabled`);
    expect(body).not.toContain(`${prefix}-revoke`);
  }
});

test("the entry inventory: every mounted route refuses an anonymous caller, admin routes refuse non-admins", async () => {
  // The route table of the composed app IS the checklist: any future route added to these
  // surfaces without a guard shows up here and fails the probe.
  const byPath = new Map<string, Set<string>>();
  for (const route of app.routes) {
    if (route.method === "ALL") continue;
    const methods = byPath.get(route.path) ?? new Set<string>();
    methods.add(route.method);
    byPath.set(route.path, methods);
  }
  expect(byPath.size).toBeGreaterThan(4);

  const probed: string[] = [];
  for (const [path, methods] of byPath) {
    for (const method of methods) {
      const anonymous = await app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" || method === "DELETE" ? undefined : "{}",
      });
      expect(
        anonymous.status,
        `${method} ${path} must refuse an anonymous caller`,
      ).toBe(401);
      await read(anonymous);
      probed.push(`${method} ${path}`);

      if (path.startsWith("/api/admin")) {
        const nonAdmin = await request(path, {
          method,
          userId: stranger,
          body: method === "GET" || method === "DELETE" ? undefined : {},
        });
        expect(
          nonAdmin.status,
          `${method} ${path} must refuse a non-administrator`,
        ).toBe(403);
        await read(nonAdmin);
      }
    }
  }

  // And the checklist is the inventory it claims to be: every group 04 surface is on it.
  const joined = probed.join(" ");
  expect(joined).toContain("POST /api/model-access/confirm");
  expect(joined).toContain("POST /api/model-access/binding-preview");
  expect(joined).toContain("GET /api/bot-service");
  expect(joined).toContain("POST /api/bot-service/binding-codes");
  expect(joined).toContain("POST /api/admin/bot-services");
  expect(joined).toContain("POST /api/admin/bot-services/:botId/credentials");
});
