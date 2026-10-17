import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createBotServiceRegistry } from "../src/bot-services/registry";
import { botServiceCredentialRoutes } from "../src/bot-services/credential-routes";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { auditEvents, credentials } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";

/** A requireUser stand-in that answers like the real guard: anonymous is refused, never passed. */
function actorAs(
  role: "admin" | "user" | "anonymous",
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    if (role === "anonymous") {
      return context.json({ error: "Authentication required." }, 401);
    }
    context.set("actor", {
      id: `${role}-person`,
      email: `${role}@example.com`,
      role,
    } as never);
    await next();
  };
}

/**
 * Bifrost #235 (04.2): the administrator's credential surface for the bot service registry.
 *
 * The plaintext appears exactly once — in the response that mints or rotates it — and nowhere
 * ever after: not in a later read, not in the vault's stored ciphertext, not on the audit trail.
 * Managing a credential is administrator-only and is not the authentication boundary: here a
 * missing bot is a 404, because an administrator just picked it from a list.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const encryptionKey = randomBytes(32).toString("base64");
const credentialStore = createCredentialStore(database);
const registry = createBotServiceRegistry(database, {
  encryptionKey,
  credentialStore,
  auditStore: createAuditStore(database),
});
const admin = botServiceCredentialRoutes(actorAs("admin"), registry);
const member = botServiceCredentialRoutes(actorAs("user"), registry);
const anonymous = botServiceCredentialRoutes(actorAs("anonymous"), registry);
const prefix = `b5-235-${randomUUID()}`;

afterAll(async () => {
  await database
    .delete(credentials)
    .where(
      and(
        eq(credentials.kind, "bot_service"),
        like(credentials.keyId, `${prefix}%`),
      ),
    );
  await database.$client.close();
});

async function registeredBot(suffix = randomUUID()) {
  const botId = `${prefix}-${suffix}`;
  await registry.register({
    botId,
    displayName: "Credential Bot",
    kind: "external",
    capabilities: ["chat"],
  });
  return botId;
}

const post = (path: string, body?: unknown) =>
  admin.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("issuing returns the plaintext exactly once and stores only ciphertext", async () => {
  const botId = await registeredBot("once");
  const response = await post(`/${botId}/credentials`);
  expect(response.status).toBe(201);
  const raw = await response.text();
  const body = JSON.parse(raw) as { botServiceCredential: { secret: string } };
  const { secret } = body.botServiceCredential;
  expect(secret).toMatch(/^obot_bsvc_/);
  // Exactly once: the whole body mentions the plaintext one time — its own field.
  expect(raw.split(secret).length - 1).toBe(1);

  // The vault holds ciphertext; no fragment of the plaintext is readable in any row.
  const rows = await database
    .select({ encryptedValue: credentials.encryptedValue })
    .from(credentials);
  const fragment = secret.slice(secret.length - 24);
  for (const row of rows) {
    expect(row.encryptedValue).not.toContain(fragment);
  }

  // A later read is a masked status: live, dated, and free of any secret material.
  const status = await admin.request(`/${botId}/credentials`);
  expect(status.status).toBe(200);
  const statusRaw = await status.text();
  expect(statusRaw).not.toContain(secret);
  expect(statusRaw).not.toContain("obot_bsvc_");
  const view = JSON.parse(statusRaw) as {
    botServiceCredential: Record<string, unknown>;
  };
  expect(view.botServiceCredential).toMatchObject({ botId, live: true });
  expect(Object.keys(view.botServiceCredential).sort()).toEqual([
    "botId",
    "createdAt",
    "live",
    "updatedAt",
  ]);
});

test("issuing for an unknown or malformed bot is refused at the administrator boundary", async () => {
  expect((await post(`/${prefix}-nobody/credentials`)).status).toBe(404);
  expect((await post("/UPPER_NOT_A_BOT/credentials")).status).toBe(400);
});

test("only administrators manage credentials", async () => {
  const botId = await registeredBot("guard");
  for (const [app, expected] of [
    [member, 403],
    [anonymous, 401],
  ] as const) {
    const issue = await app.request(`/${botId}/credentials`, {
      method: "POST",
    });
    expect(issue.status).toBe(expected);
    const status = await app.request(`/${botId}/credentials`);
    expect(status.status).toBe(expected);
    const rotate = await app.request(`/${botId}/credentials/rotate`, {
      method: "POST",
    });
    expect(rotate.status).toBe(expected);
    const revoke = await app.request(`/${botId}/credentials`, {
      method: "DELETE",
    });
    expect(revoke.status).toBe(expected);
  }
});

test("rotation mints a fresh secret and retires the old one with no gap", async () => {
  const botId = await registeredBot("rotate-route");
  // Nothing live yet: an explicit rotation has nothing to rotate.
  const premature = await post(`/${botId}/credentials/rotate`);
  expect(premature.status).toBe(409);

  const first = await (await post(`/${botId}/credentials`)).json();
  const secretOne = first.botServiceCredential.secret as string;

  const response = await post(`/${botId}/credentials/rotate`);
  expect(response.status).toBe(201);
  const raw = await response.text();
  const second = JSON.parse(raw) as {
    botServiceCredential: { secret: string; rotated: boolean };
  };
  expect(second.botServiceCredential.rotated).toBe(true);
  expect(second.botServiceCredential.secret).not.toEqual(secretOne);
  expect(raw.split(second.botServiceCredential.secret).length - 1).toBe(1);

  expect(
    await registry.authenticate(second.botServiceCredential.secret),
  ).toMatchObject({ botId });
  await expect(registry.authenticate(secretOne)).rejects.toThrow();
});

test("revocation is final and immediate", async () => {
  const botId = await registeredBot("revoke-route");
  const issued = await (await post(`/${botId}/credentials`)).json();
  const secret = issued.botServiceCredential.secret as string;
  expect(
    await admin.request(`/${botId}/credentials`, { method: "DELETE" }),
  ).toMatchObject({ status: 200 });

  const status = await admin.request(`/${botId}/credentials`);
  expect(
    ((await status.json()) as { botServiceCredential: { live: boolean } })
      .botServiceCredential.live,
  ).toBe(false);
  await expect(registry.authenticate(secret)).rejects.toThrow();

  // Nothing live to revoke twice.
  expect(
    (await admin.request(`/${botId}/credentials`, { method: "DELETE" })).status,
  ).toBe(409);
});

test("the trail records issue, rotate and revoke against the bot — never the secret", async () => {
  const botId = await registeredBot("audit");
  const issued = await (await post(`/${botId}/credentials`)).json();
  const secret = issued.botServiceCredential.secret as string;
  await post(`/${botId}/credentials/rotate`);
  await admin.request(`/${botId}/credentials`, { method: "DELETE" });

  const rows = await database
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.targetId, botId));
  expect(rows.map((row) => row.eventType).sort()).toEqual([
    "bot_service.credential_issued",
    "bot_service.credential_revoked",
    "bot_service.credential_rotated",
  ]);
  for (const row of rows) {
    expect(row.targetType).toBe("bot_service");
    expect(row.actorUserId).toBe("admin-person");
  }

  // The vault's own trail answers by key id, and neither trail ever holds the plaintext.
  const vaultRows = await database
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.eventType, "credential.created"));
  expect(
    vaultRows.some(
      (row) => (row.payload as { keyId?: string }).keyId === botId,
    ),
  ).toBe(true);
  const fragment = secret.slice(secret.length - 24);
  const trail = await database
    .select({ payload: auditEvents.payload })
    .from(auditEvents)
    .where(like(auditEvents.targetId, `${prefix}%`));
  for (const row of trail) {
    expect(JSON.stringify(row.payload)).not.toContain(fragment);
  }
});

test("concurrent issues leave exactly one live credential and both callers honest", async () => {
  const botId = await registeredBot("race");
  const results = await Promise.allSettled([
    post(`/${botId}/credentials`),
    post(`/${botId}/credentials`),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  expect(fulfilled).toHaveLength(2);
  const secrets = new Set<string>();
  for (const result of fulfilled) {
    const response = (result as PromiseFulfilledResult<Response>).value;
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      botServiceCredential: { secret: string };
    };
    secrets.add(body.botServiceCredential.secret);
  }
  expect(secrets.size).toBe(2);
  // The vault's own invariant: at most one live credential for the bot.
  const live = await credentialStore.findLiveByKey({
    kind: "bot_service",
    provider: "bot-service",
    keyId: botId,
  });
  expect(live).not.toBeNull();
  // Exactly one of the two plaintexts still authenticates.
  const outcomes = await Promise.all(
    [...secrets].map((secret) =>
      registry.authenticate(secret).then(
        () => true,
        () => false,
      ),
    ),
  );
  expect(outcomes.filter(Boolean)).toHaveLength(1);
});
