import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { createIdentityProviderStore } from "../src/auth/identity-provider-store";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { accounts, ssoProviders, users } from "../src/db/schema/core";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * Removing an identity provider through the admin route, against the real store and database: a
 * removal asked for twice (a screen left open, or a response lost and sent again) removes once and
 * leaves one row in the trail, two at once end the same way, and the account impact stops being
 * readable once the provider is gone.
 */

const prefix = `provider-removal-${randomUUID()}`;
const providerId = `${prefix}-okta`;
const admin = { id: `${prefix}-admin`, email: `${prefix}-admin@example.test` };
const member = {
  id: `${prefix}-member`,
  email: `${prefix}-member@example.test`,
};
const people = [admin, member];

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const rows: AuditEventInput[] = [];

function app() {
  const store = createIdentityProviderStore(database);
  // createApp takes positional stores: auditStore is 13th and identityProviders 19th. Built by
  // index so a store appended later cannot shift them.
  const args = Array.from({ length: 19 }) as Parameters<typeof createApp>;
  args[0] = loadConfig(testEnvironment()) as never;
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: { getSession: async () => ({ user: admin }) },
  } as never;
  args[2] = { rolesForUser: async () => ["admin"] } as never;
  // The real trail is append-only, so the route writes to one that only remembers.
  args[12] = {
    insert: async (event: AuditEventInput) => void rows.push(event),
  } as never;
  args[18] = store as never;
  return createApp(...args);
}

const REMOVE = `/api/admin/identity-providers/${encodeURIComponent(providerId)}`;

/** Every fixture id starts with the run's prefix, so this also clears a run that crashed before afterAll. */
async function cleanUp() {
  await database
    .delete(ssoProviders)
    .where(like(ssoProviders.id, "provider-removal-%"));
  // A person's account rows go with them.
  await database.delete(users).where(like(users.id, "provider-removal-%"));
}

async function registerProvider() {
  await database.delete(ssoProviders).where(eq(ssoProviders.id, providerId));
  await database.insert(ssoProviders).values({
    id: providerId,
    issuer: "https://idp.example.test",
    providerId,
    domain: "example.test",
  });
}

async function registered() {
  return database
    .select({ id: ssoProviders.id })
    .from(ssoProviders)
    .where(eq(ssoProviders.id, providerId));
}

beforeAll(async () => {
  await cleanUp();
  await database.insert(users).values(people);
  await database.insert(accounts).values({
    id: `${prefix}-account-member`,
    accountId: "member-subject",
    providerId,
    userId: member.id,
  });
  await registerProvider();
});
afterAll(async () => {
  await cleanUp();
  await database.$client.end({ timeout: 5 });
});
beforeEach(async () => {
  rows.length = 0;
  await registerProvider();
});

test("a removal asked for twice removes once and leaves one row in the trail", async () => {
  const hono = app();
  const first = await hono.request(REMOVE, { method: "DELETE" });
  const again = await hono.request(REMOVE, { method: "DELETE" });

  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ removed: true });
  expect(again.status).toBe(404);
  expect(await again.json()).toEqual({ error: "There is no such provider." });
  expect(await registered()).toEqual([]);
  expect(
    rows.map((row) => [row.eventType, row.targetId, row.actorUserId]),
  ).toEqual([["identity_provider.removed", providerId, admin.id]]);
});

test("two removals at once end with one success and one row in the trail", async () => {
  const hono = app();
  const responses = await Promise.all([
    hono.request(REMOVE, { method: "DELETE" }),
    hono.request(REMOVE, { method: "DELETE" }),
  ]);

  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 404,
  ]);
  expect(await registered()).toEqual([]);
  expect(rows.map((row) => row.eventType)).toEqual([
    "identity_provider.removed",
  ]);
});

test("who the provider is the only way in for is readable until it is removed", async () => {
  const hono = app();
  const before = await hono.request(`${REMOVE}/impact`);
  expect(before.status).toBe(200);
  expect(await before.json()).toMatchObject({
    impact: {
      losing: { total: 1, emails: [member.email] },
      keeping: { total: 0, accounts: [] },
      includesYou: false,
    },
  });

  await hono.request(REMOVE, { method: "DELETE" });
  const after = await hono.request(`${REMOVE}/impact`);
  expect(after.status).toBe(404);
});
