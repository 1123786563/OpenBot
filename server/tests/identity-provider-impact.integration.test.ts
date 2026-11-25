import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { createIdentityProviderStore } from "../src/auth/identity-provider-store";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  revokedAccess,
  ssoProviders,
  users,
} from "../src/db/schema/core";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Who a registered identity provider is the only way in for, read before an administrator removes
 * it: the people who would be left without a sign-in, and the people who keep one, by account rows
 * rather than by the provider's email domain.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `provider-impact-${randomUUID()}`;
const providerId = `${prefix}-okta`;
const GOOGLE = "google";
const breakGlassEmail = `${prefix}-break@example.test`;
/** A provider that is registered and that nobody has ever signed in through. */
const unusedId = `${prefix}-unused`;

const person = (suffix: string) => ({
  id: `${prefix}-${suffix}`,
  email: `${prefix}-${suffix}@example.test`,
});
const only = person("only");
const both = person("both");
const breakGlass = { id: `${prefix}-break`, email: breakGlassEmail };
const removed = person("removed");
const elsewhere = person("elsewhere");
const lonelyUser = person("lonely-user");
const everybody = [only, both, breakGlass, removed, elsewhere, lonelyUser];

const account = (id: string, userId: string, provider: string) => ({
  id: `${prefix}-account-${id}`,
  accountId: `${id}-subject`,
  providerId: provider,
  userId,
});

async function seed() {
  await database.insert(users).values(everybody);
  await database.insert(ssoProviders).values([
    {
      id: providerId,
      issuer: "https://idp.example.test",
      providerId,
      domain: "example.test",
    },
    {
      id: `${prefix}-lonely`,
      issuer: "https://lonely.example.test",
      providerId: `${prefix}-lonely`,
      domain: "lonely.test",
    },
    {
      id: unusedId,
      issuer: "https://unused.example.test",
      providerId: unusedId,
      domain: "unused.test",
    },
  ]);
  await database
    .insert(accounts)
    .values([
      account("only", only.id, providerId),
      account("both-okta", both.id, providerId),
      account("both-google", both.id, GOOGLE),
      account("break", breakGlass.id, providerId),
      account("removed", removed.id, providerId),
      account("elsewhere", elsewhere.id, GOOGLE),
      account("lonely", lonelyUser.id, `${prefix}-lonely`),
    ]);
  await database
    .insert(revokedAccess)
    .values({ email: removed.email, revokedBy: "admin" });
}

/** Every fixture id starts with the run's prefix, so this also clears a run that crashed before afterAll. */
async function cleanUp() {
  await database.delete(accounts).where(like(accounts.id, "provider-impact-%"));
  await database
    .delete(ssoProviders)
    .where(like(ssoProviders.id, "provider-impact-%"));
  await database
    .delete(revokedAccess)
    .where(like(revokedAccess.email, "%provider-impact-%"));
  await database.delete(users).where(like(users.id, "provider-impact-%"));
}

beforeAll(async () => {
  await cleanUp();
  await seed();
});
afterAll(async () => {
  await cleanUp();
  await database.$client.end({ timeout: 5 });
});

const store = createIdentityProviderStore(database, [breakGlassEmail]);

test("a person whose only account is this provider loses their only way in", async () => {
  const impact = await store.impact(providerId);
  expect(impact?.losing).toEqual([{ userId: only.id, email: only.email }]);
});

test("a person with a second account or an emergency address keeps a way in, and says why", async () => {
  const impact = await store.impact(providerId);
  expect(impact?.keeping).toEqual([
    {
      userId: both.id,
      email: both.email,
      reason: "another-sign-in",
    },
    {
      userId: breakGlass.id,
      email: breakGlassEmail,
      reason: "emergency-admin",
    },
  ]);
});

test("a person whose access was removed is in neither list", async () => {
  const impact = await store.impact(providerId);
  const listed = [...(impact?.losing ?? []), ...(impact?.keeping ?? [])];
  expect(listed.map((person) => person.userId)).not.toContain(removed.id);
});

test("a provider nobody signed in through affects nobody", async () => {
  expect(await store.impact(unusedId)).toEqual({ losing: [], keeping: [] });
});

test("a provider that is not registered has no impact to read", async () => {
  expect(await store.impact(`${prefix}-never-registered`)).toBeNull();
});
