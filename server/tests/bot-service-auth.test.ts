import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import {
  botServiceRoutes,
  createBotServiceAuthenticator,
  createFailureLimiter,
} from "../src/bot-services/auth";
import { createBotServiceRegistry } from "../src/bot-services/registry";
import {
  BotServiceAuthFailureError,
  BotServiceRateLimitedError,
} from "../src/bot-services/types";
import { loadConfig } from "../src/config";
import { createApp } from "../src/app";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * Bifrost #235 (04.2): bot service credential authentication, on a real PostgreSQL.
 *
 * The questions here are the ticket's own: only a valid service credential passes, revocation or
 * disabling fails authentication on the very next call (nothing is cached), every failure looks
 * the same whether or not the bot exists, and the result of authenticating says which Bot it is —
 * and nothing about any user, account or credit.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
/** A fresh deployment key per run: ciphertext from an earlier run must not verify. */
const encryptionKey = randomBytes(32).toString("base64");
const credentialStore = createCredentialStore(database);
const registry = createBotServiceRegistry(database, {
  encryptionKey,
  credentialStore,
  auditStore: createAuditStore(database),
});
const prefix = `b5-235-${randomUUID()}`;

afterAll(async () => {
  await database
    .delete(credentials)
    .where(
      like(credentials.keyId, `${prefix}%`),
    );
  await database.$client.close();
});

/** A botId under this file's prefix, registered and, where asked, credentialed. */
async function registeredBot(suffix = randomUUID()) {
  const botId = `${prefix}-${suffix}`;
  await registry.register({
    botId,
    displayName: "Auth Bot",
    kind: "external",
    capabilities: ["chat"],
  });
  return botId;
}

async function credentialedBot(suffix = randomUUID()) {
  const botId = await registeredBot(suffix);
  const issued = await registry.credentials.issue(botId);
  return { botId, secret: issued.secret };
}

/**
 * One observable failure. Every refusal below must be THIS: same class, same message, no reason
 * a caller could branch on. A test that only checks `rejects.toThrow()` would pass on any error
 * at all, including the leaks the ticket forbids.
 */
async function uniformFailure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("expected authentication to fail");
    },
    (caught: unknown) => caught,
  );
  return {
    name: (error as Error).name,
    message: (error as Error).message,
  };
}

const AUTH_FAILED = {
  name: "BotServiceAuthFailureError",
  message: "Bot service authentication failed.",
};

test("a valid service credential authenticates, and says only which Bot", async () => {
  const { botId, secret } = await credentialedBot("ok");
  const identity = await registry.authenticate(secret);
  // The whole contract: which Bot, and its status. Two fields, no more.
  expect(Object.keys(identity).sort()).toEqual(["botId", "status"]);
  expect(identity).toEqual({ botId, status: "active" });
});

test("the identity carries no user, account or credit field of any kind", async () => {
  const { secret } = await credentialedBot("shape");
  const identity = await registry.authenticate(secret);
  const rendered = JSON.stringify(identity);
  expect(rendered).not.toMatch(
    /user|account|userId|credit|grant|balance|token|secret|key/i,
  );
});

test("a wrong secret is refused", async () => {
  const { botId } = await credentialedBot("wrong");
  const forged = `obot_bsvc_${botId}~${randomBytes(32).toString("base64url")}`;
  await expect(registry.authenticate(forged)).rejects.toBeInstanceOf(
    BotServiceAuthFailureError,
  );
});

test("an unknown bot's token is refused, identically to a wrong secret", async () => {
  const stranger = `obot_bsvc_${prefix}-nobody~${randomBytes(32).toString("base64url")}`;
  expect(await uniformFailure(registry.authenticate(stranger))).toEqual(
    AUTH_FAILED,
  );
  const { botId } = await credentialedBot("wrong2");
  const forged = `obot_bsvc_${botId}~${randomBytes(32).toString("base64url")}`;
  expect(await uniformFailure(registry.authenticate(forged))).toEqual(
    AUTH_FAILED,
  );
});

test("malformed presented secrets are refused, never parsed into an answer", async () => {
  for (const presented of [
    "",
    "not-a-our-token",
    "obot_bsvc_",
    `obot_bsvc_${randomUUID()}~`, // no secret part
    `obot_bsvc_${"UPPER"}~${randomBytes(32).toString("base64url")}`, // invalid botId
    `obot_bsvc_${prefix}-real~short`, // a bot that does not exist, and a stub secret
  ]) {
    expect(await uniformFailure(registry.authenticate(presented))).toEqual(
      AUTH_FAILED,
    );
  }
});

test("revocation fails authentication on the very next call", async () => {
  const { botId, secret } = await credentialedBot("revoke");
  expect(await registry.authenticate(secret)).toMatchObject({ botId });
  await registry.credentials.revoke(botId);
  expect(await uniformFailure(registry.authenticate(secret))).toEqual(
    AUTH_FAILED,
  );
  // Reissuing starts a new life; the old secret stays dead.
  const reissued = await registry.credentials.issue(botId);
  expect(await registry.authenticate(reissued.secret)).toMatchObject({ botId });
  expect(await uniformFailure(registry.authenticate(secret))).toEqual(
    AUTH_FAILED,
  );
});

test("rotation retires the old secret immediately, with no gap", async () => {
  const { botId, secret } = await credentialedBot("rotate");
  const rotated = await registry.credentials.rotate(botId);
  expect(rotated.secret).not.toEqual(secret);
  expect(await registry.authenticate(rotated.secret)).toMatchObject({ botId });
  expect(await uniformFailure(registry.authenticate(secret))).toEqual(
    AUTH_FAILED,
  );
});

test("disabling the bot fails authentication immediately; enabling restores it", async () => {
  const { botId, secret } = await credentialedBot("disable");
  expect(await registry.authenticate(secret)).toMatchObject({ botId });
  await registry.disable(botId);
  expect(await uniformFailure(registry.authenticate(secret))).toEqual(
    AUTH_FAILED,
  );
  await registry.enable(botId);
  // The same credential, valid again: disabling never touched the vault.
  expect(await registry.authenticate(secret)).toMatchObject({ botId });
});

test("no failure answer distinguishes a missing bot from a bad credential", async () => {
  const { botId, secret } = await credentialedBot("uniform");
  const wrong = `obot_bsvc_${botId}~${randomBytes(32).toString("base64url")}`;
  const stranger = `obot_bsvc_${prefix}-ghost~${randomBytes(32).toString("base64url")}`;
  const observations = [
    await uniformFailure(registry.authenticate(wrong)),
    await uniformFailure(registry.authenticate(stranger)),
    await uniformFailure(registry.authenticate("obot_bsvc_")),
  ];
  await registry.disable(botId);
  observations.push(await uniformFailure(registry.authenticate(secret)));
  await registry.credentials.revoke(botId);
  observations.push(await uniformFailure(registry.authenticate(secret)));
  for (const observation of observations) {
    expect(observation).toEqual(AUTH_FAILED);
  }
});

test("repeated failures rate limit that identity, and the window heals", async () => {
  let now = 1_000_000;
  const authenticated = createBotServiceAuthenticator({
    encryptionKey,
    credentialStore,
    botServices: registry,
    limiter: createFailureLimiter({
      windowMs: 60_000,
      maxFailures: 20,
      now: () => now,
    }),
  });
  const { botId, secret } = await credentialedBot("limited");
  const wrong = `obot_bsvc_${botId}~${randomBytes(32).toString("base64url")}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await expect(authenticated(wrong)).rejects.toBeInstanceOf(
      BotServiceAuthFailureError,
    );
  }
  // Even the correct secret is refused while the window is hot — and the refusal is the
  // rate-limit class, not a second answer that says anything about the bot.
  await expect(authenticated(secret)).rejects.toBeInstanceOf(
    BotServiceRateLimitedError,
  );
  // A different bot presenting bad secrets is its own bucket: not poisoned by its neighbour.
  const other = await credentialedBot("limited-other");
  expect(await authenticated(other.secret)).toMatchObject({ botId: other.botId });
  // Time passes, the window drains, the honest secret works again.
  now += 61_000;
  expect(await authenticated(secret)).toMatchObject({ botId });
});

test("the bot surface answers with the identity and one uniform refusal", async () => {
  const app = botServiceRoutes({
    authenticate: registry.authenticate,
  });
  const { botId, secret } = await credentialedBot("http");
  const ok = await app.request("/", {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("cache-control")).toBe("no-store");
  expect(await ok.json()).toEqual({
    botService: { botId, status: "active" },
  });

  const wrong = await app.request("/", {
    headers: {
      authorization: `Bearer obot_bsvc_${botId}~${randomBytes(32).toString("base64url")}`,
    },
  });
  const stranger = await app.request("/", {
    headers: {
      authorization: `Bearer obot_bsvc_${prefix}-ghost~${randomBytes(32).toString("base64url")}`,
    },
  });
  const bare = await app.request("/");
  const malformed = await app.request("/", {
    headers: { authorization: "Basic dXNlcjpwYXNz" },
  });
  const bodies = await Promise.all([
    wrong.text(),
    stranger.text(),
    bare.text(),
    malformed.text(),
  ]);
  for (const response of [wrong, stranger, bare, malformed]) {
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  // Byte for byte the same answer, so no observer learns whether the bot exists.
  expect(new Set(bodies).size).toBe(1);
  expect(JSON.parse(bodies[0])).toEqual({
    error: "Bot service authentication failed.",
    code: "bot_service_auth_failed",
  });

  // Disabling flips the very next request to the same refusal.
  await registry.disable(botId);
  const disabled = await app.request("/", {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(disabled.status).toBe(401);
  expect(await disabled.text()).toBe(bodies[0]);
});

test("an unrated credential surface still mounts fail-closed when absent", async () => {
  // createApp takes its services positionally; the registry sits in the last seat, and the
  // credential surfaces answer a tagged 503 when the deployment built none.
  const args: unknown[] = new Array(createApp.length).fill(undefined);
  args[0] = loadConfig(testEnvironment());
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: { getSession: async () => null },
  };
  args[2] = { rolesForUser: async () => ["user"] };
  const app = createApp(...(args as never[]));
  const surface = await app.request("/api/bot-service");
  expect(surface.status).toBe(503);
  expect((await surface.json()).code).toBe("bot_service_unavailable");
});
