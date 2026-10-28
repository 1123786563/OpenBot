import { afterAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import {
  bindingCodeRoutes,
  createBindingOfferIssuer,
  mintBindingCode,
} from "../src/bot-services/binding-codes";
import { botServiceRoutes } from "../src/bot-services/auth";
import { createBotServiceRegistry } from "../src/bot-services/registry";
import { loadConfig } from "../src/config";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { auditEvents, botBindingOffers, credentials } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";
/**
 * Bifrost #236 (04.3): one-time binding-code issuance, on a real PostgreSQL.
 *
 * The questions here are the ticket's own: only an authenticated Bot service identity can issue a
 * binding code, a code is bound to the issuing Bot and the one external identity it named (never a
 * universal claim ticket), the offer carries an explicit short expiry and defaults to single use,
 * and every issuance lands on the audit trail without ever writing the code's plaintext.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
/** A fresh deployment key per run: ciphertext from an earlier run must not verify. */
const encryptionKey = randomBytes(32).toString("base64");
const auditStore = createAuditStore(database);
const registry = createBotServiceRegistry(database, {
  encryptionKey,
  credentialStore: createCredentialStore(database),
  auditStore,
});
const issuer = createBindingOfferIssuer({ database, auditStore });
const app = botServiceRoutes({
  authenticate: registry.authenticate,
  bindingCodes: bindingCodeRoutes({ issuer }),
});
const prefix = `b5-236-${randomUUID()}`;

afterAll(async () => {
  // Offers first (they name a bot), then the credentials, then the bots. Audit rows stay:
  // audit_events is append-only by design, and each run names its own botIds and code hashes,
  // so rows from an earlier run can never answer a later assertion.
  await database
    .delete(botBindingOffers)
    .where(like(botBindingOffers.botId, `${prefix}%`));
  await database
    .delete(credentials)
    .where(like(credentials.keyId, `${prefix}%`));
  await database.$client.close();
});

/** A botId under this file's prefix, registered and credentialed, with its live secret. */
async function credentialedBot(suffix: string) {
  const botId = `${prefix}-${suffix}`;
  await registry.register({
    botId,
    displayName: "Binding Bot",
    kind: "external",
    capabilities: ["chat"],
  });
  const { secret } = await registry.credentials.issue(botId);
  return { botId, secret };
}

/** POST one issuance request the way a Bot's server would. */
function issueRequest(secret: string, body: unknown) {
  return app.request("/binding-codes", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
}

test("only an authenticated bot service identity can issue a binding code", async () => {
  const { botId, secret } = await credentialedBot("perm");

  const bare = await app.request("/binding-codes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ externalIdentityHint: "slack:U123" }),
  });
  const forged = await issueRequest(
    `obot_bsvc_${botId}~${randomBytes(32).toString("base64url")}`,
    { externalIdentityHint: "slack:U123" },
  );
  expect(bare.status).toBe(401);
  expect(forged.status).toBe(401);
  // The one uniform refusal the door answers, a Bot's existence or absence invisible.
  expect(await bare.json()).toEqual({
    error: "Bot service authentication failed.",
    code: "bot_service_auth_failed",
  });
  expect(await forged.text()).toBe(
    JSON.stringify({
      error: "Bot service authentication failed.",
      code: "bot_service_auth_failed",
    }),
  );

  // A valid secret whose Bot has since been disabled authenticates no more.
  await registry.disable(botId);
  const disabled = await issueRequest(secret, {
    externalIdentityHint: "slack:U123",
  });
  expect(disabled.status).toBe(401);
});

test("issuing returns the one-time offer, bound to the requesting bot and its named identity", async () => {
  const { botId, secret } = await credentialedBot("shape");
  const response = await issueRequest(secret, {
    externalIdentityHint: "github:octocat",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const { bindingOffer } = (await response.json()) as {
    bindingOffer: Record<string, unknown>;
  };
  // The whole produced contract, and nothing more.
  expect(Object.keys(bindingOffer).sort()).toEqual([
    "bindingCode",
    "botId",
    "expiresAt",
    "externalIdentityHint",
    "singleUse",
    "status",
  ]);
  expect(bindingOffer.botId).toBe(botId);
  expect(bindingOffer.externalIdentityHint).toBe("github:octocat");
  expect(bindingOffer.singleUse).toBe(true);
  expect(bindingOffer.status).toBe("pending");
  expect(typeof bindingOffer.bindingCode).toBe("string");
  expect(new Date(bindingOffer.expiresAt as string).getTime()).toBeGreaterThan(
    Date.now(),
  );

  // The stored row agrees, and holds only the code's digest, never its plaintext.
  const [row] = await database
    .select()
    .from(botBindingOffers)
    .where(eq(botBindingOffers.botId, botId));
  expect(row.externalIdentityHint).toBe("github:octocat");
  expect(row.singleUse).toBe(true);
  expect(row.status).toBe("pending");
  expect(row.codeHash).not.toBe(bindingOffer.bindingCode);
});

test("the offer must name the external identity to bind", async () => {
  const { secret } = await credentialedBot("hint");
  const missing = await issueRequest(secret, {});
  const blank = await issueRequest(secret, { externalIdentityHint: "   " });
  const wrongType = await issueRequest(secret, { externalIdentityHint: 42 });
  const tooLong = await issueRequest(secret, {
    externalIdentityHint: "a".repeat(513),
  });
  for (const response of [missing, blank, wrongType, tooLong]) {
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("bot_binding_invalid");
  }
  // No rows were written by any refused issuance.
  const rows = await database
    .select()
    .from(botBindingOffers)
    .where(like(botBindingOffers.botId, `${prefix}-hint%`));
  expect(rows).toHaveLength(0);
});

test("a code issued to one bot is never a claim ticket for another", async () => {
  const a = await credentialedBot("bind-a");
  const b = await credentialedBot("bind-b");
  const offerA = await (
    await issueRequest(a.secret, { externalIdentityHint: "slack:U42" })
  ).json();
  const offerB = await (
    await issueRequest(b.secret, { externalIdentityHint: "slack:U42" })
  ).json();
  // The same external identity, two different Bots: two distinct offers.
  expect(offerA.bindingOffer.bindingCode).not.toBe(
    offerB.bindingOffer.bindingCode,
  );
  const rows = await database
    .select()
    .from(botBindingOffers)
    .where(eq(botBindingOffers.externalIdentityHint, "slack:U42"));
  expect(rows.map((row) => row.botId).sort()).toEqual(
    [a.botId, b.botId].sort(),
  );
});

test("binding codes are high-entropy, unpredictable and never repeat", () => {
  const codes = new Set<string>();
  for (let i = 0; i < 200; i++) codes.add(mintBindingCode());
  expect(codes.size).toBe(200);
  for (const code of codes) {
    expect(code.startsWith("obot_bbind_")).toBe(true);
    const body = code.slice("obot_bbind_".length);
    // Base64url of 32 random bytes: 256 bits of entropy, no characters a URL would mangle.
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(body, "base64url").byteLength).toBe(32);
  }
});

test("re-issuing for the same bot and identity mints a fresh code, not a derived one", async () => {
  const { botId, secret } = await credentialedBot("reissue");
  const first = await (
    await issueRequest(secret, { externalIdentityHint: "slack:U99" })
  ).json();
  const second = await (
    await issueRequest(secret, { externalIdentityHint: "slack:U99" })
  ).json();
  expect(first.bindingOffer.bindingCode).not.toBe(
    second.bindingOffer.bindingCode,
  );
  const rows = await database
    .select()
    .from(botBindingOffers)
    .where(eq(botBindingOffers.botId, botId));
  expect(rows).toHaveLength(2);
});

test("the offer carries an explicit expiry and defaults to single use", async () => {
  const { botId, secret } = await credentialedBot("ttl");
  const response = await issueRequest(secret, {
    externalIdentityHint: "slack:U7",
  });
  const { bindingOffer } = await response.json();
  const row = (
    await database
      .select()
      .from(botBindingOffers)
      .where(eq(botBindingOffers.botId, botId))
  )[0];
  const lifetimeMs = new Date(bindingOffer.expiresAt).getTime() - Date.now();
  // The default lifetime is short: fifteen minutes, not a session, not a day.
  expect(lifetimeMs).toBeLessThanOrEqual(15 * 60_000);
  expect(lifetimeMs).toBeGreaterThan(14 * 60_000);
  expect(row.expiresAt.getTime()).toBe(
    new Date(bindingOffer.expiresAt).getTime(),
  );

  // The lifetime is a composition-time choice, not hardcoded and not per-request.
  const at = new Date("2026-01-01T00:00:00Z");
  const shortIssuer = createBindingOfferIssuer({
    database,
    auditStore: createAuditStore(database),
    ttlMs: 90_000,
    now: () => at,
  });
  const issued = await shortIssuer.issue(
    { botId, status: "active" },
    { externalIdentityHint: "slack:U8" },
  );
  expect(issued.expiresAt.toISOString()).toBe("2026-01-01T00:01:30.000Z");
  expect(issued.singleUse).toBe(true);
});

test("every issuance is audited, and the audit never holds the code", async () => {
  const { botId, secret } = await credentialedBot("audit");
  const { bindingOffer } = await (
    await issueRequest(secret, { externalIdentityHint: "slack:U1000" })
  ).json();

  const [event] = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetType, "bot_binding_offer"),
        eq(auditEvents.initiatorId, botId),
      ),
    );
  expect(event.eventType).toBe("bot_binding.offered");
  // The trail names the offer by its digest; a trail reader can never redeem what they read.
  expect(event.targetId).not.toBe(bindingOffer.bindingCode);
  expect(event.initiatorKind).toBe("handoff");
  expect(event.initiatorId).toBe(botId);
  expect(event.payload).toMatchObject({
    botId,
    externalIdentityHint: "slack:U1000",
  });
  expect(JSON.stringify(event.payload)).not.toContain(bindingOffer.bindingCode);
});

test("without a composed issuer the surface answers fail-closed", async () => {
  const response = await bindingCodeRoutes(undefined).request("/", {
    method: "POST",
    body: JSON.stringify({ externalIdentityHint: "slack:U1" }),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "Binding-code issuance is not available.",
    code: "bot_binding_unavailable",
  });
});

test("the deployment mounts issuance on the public bot-service surface, behind the same guard", async () => {
  const { botId, secret } = await credentialedBot("mounted");
  const args: unknown[] = new Array(createApp.length).fill(undefined);
  args[0] = loadConfig(testEnvironment());
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: { getSession: async () => null },
  };
  args[2] = { rolesForUser: async () => ["user"] };
  // The registry rides the botServices seat, second from the end: workbenchPayer was appended
  // after it (#287), so the last seat is the payer's, not the registry's.
  args[createApp.length - 2] = registry;
  const deployment = createApp(...(args as never[]));

  // Without a credential the service guard answers before any route is reached.
  const bare = await deployment.request("/api/bot-service/binding-codes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ externalIdentityHint: "slack:U3000" }),
  });
  expect(bare.status).toBe(401);
  expect(await bare.json()).toEqual({
    error: "Bot service authentication failed.",
    code: "bot_service_auth_failed",
  });

  // With one, the public boundary issues the same contract the module tests pin.
  const response = await deployment.request("/api/bot-service/binding-codes", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ externalIdentityHint: "slack:U3000" }),
  });
  expect(response.status).toBe(200);
  const { bindingOffer } = (await response.json()) as {
    bindingOffer: { botId: string; bindingCode: string };
  };
  expect(bindingOffer.botId).toBe(botId);
  expect(typeof bindingOffer.bindingCode).toBe("string");
});
