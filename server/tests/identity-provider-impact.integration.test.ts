import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
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
 * Who can still sign in once a registered identity provider is removed, read before an administrator
 * removes it: the people who would be left without a sign-in, and the people who keep one.
 *
 * The rule is the sign-in path's own (`decideSignInMethod`, `sso-required.ts`), decided on account
 * rows rather than on the provider's email domain: an account at another provider is a way in only
 * while that provider is still registered, a password or social account only while Require SSO is
 * off, and an address in INITIAL_ADMIN_EMAILS is let in another way whatever the setting.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `provider-impact-${randomUUID()}`;
/** The provider being removed. */
const providerId = `${prefix}-okta`;
/** Another registered provider, which stays. */
const otherId = `${prefix}-other`;
/** A provider removed earlier: its row is gone and an account at it remains. */
const goneId = `${prefix}-gone`;
/** A provider that is registered and that nobody has ever signed in through. */
const unusedId = `${prefix}-unused`;
const PASSWORD = "credential";
const GOOGLE = "google";
const breakGlassEmail = `${prefix}-break@example.test`;

const person = (suffix: string) => ({
  id: `${prefix}-${suffix}`,
  email: `${prefix}-${suffix}@example.test`,
});
const only = person("only");
const elsewhere = person("elsewhere");
const stale = person("stale");
const password = person("password");
const social = person("social");
const breakGlass = { id: `${prefix}-break`, email: breakGlassEmail };
const removed = person("removed");
const everybody = [
  only,
  elsewhere,
  stale,
  password,
  social,
  breakGlass,
  removed,
];

const account = (id: string, userId: string, provider: string) => ({
  id: `${prefix}-account-${id}`,
  accountId: `${id}-subject`,
  providerId: provider,
  userId,
});
const registered = (id: string, domain: string) => ({
  id,
  issuer: `https://${domain}`,
  providerId: id,
  domain,
});
const otherProviders = [
  registered(otherId, "other.test"),
  registered(unusedId, "unused.test"),
];

async function seed() {
  await database.insert(users).values(everybody);
  await database
    .insert(ssoProviders)
    .values([registered(providerId, "example.test"), ...otherProviders]);
  await database.insert(accounts).values([
    account("only", only.id, providerId),
    account("elsewhere-okta", elsewhere.id, providerId),
    account("elsewhere-other", elsewhere.id, otherId),
    // The row for `goneId` is deliberately absent: it was removed before this.
    account("stale-gone", stale.id, goneId),
    account("stale-okta", stale.id, providerId),
    account("password-okta", password.id, providerId),
    account("password-password", password.id, PASSWORD),
    account("social-okta", social.id, providerId),
    account("social-google", social.id, GOOGLE),
    account("break", breakGlass.id, providerId),
    account("removed", removed.id, providerId),
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

/** The store as index.ts builds it: the emergency addresses, and Google as the social provider. */
const store = createIdentityProviderStore(
  database,
  [breakGlassEmail],
  [GOOGLE],
);
const bothSettings = [true, false] as const;
const ids = (people: { userId: string }[]) =>
  people.map((who) => who.userId).sort();

test("a person whose only account is this provider loses their only way in", async () => {
  for (const ssoRequired of bothSettings)
    expect(
      (await store.impact(providerId, ssoRequired))?.losing.map(
        (who) => who.userId,
      ),
    ).toContain(only.id);
});

test("an account at another registered provider is a way in, whichever way Require SSO is set", async () => {
  for (const ssoRequired of bothSettings) {
    const impact = await store.impact(providerId, ssoRequired);
    expect(impact?.keeping).toContainEqual({
      userId: elsewhere.id,
      email: elsewhere.email,
      reason: "another-sign-in",
    });
    expect(ids(impact?.losing ?? [])).not.toContain(elsewhere.id);
  }
});

/*
 * The case the old reading got wrong: a second account was counted as a way in whatever it was at.
 * A provider's removal deletes its registration and nothing else, so the account at a provider
 * removed earlier is still there and still signs nobody in.
 */
test("an account at a provider removed earlier is no way in, whichever way Require SSO is set", async () => {
  for (const ssoRequired of bothSettings) {
    const impact = await store.impact(providerId, ssoRequired);
    expect(ids(impact?.losing ?? [])).toContain(stale.id);
    expect(ids(impact?.keeping ?? [])).not.toContain(stale.id);
  }
});

test("a password or social account is a way in only while Require SSO is off", async () => {
  const on = await store.impact(providerId, true);
  expect(ids(on?.losing ?? [])).toEqual(
    [only.id, password.id, social.id, stale.id].sort(),
  );
  expect(ids(on?.keeping ?? [])).toEqual([breakGlass.id, elsewhere.id].sort());

  const off = await store.impact(providerId, false);
  expect(ids(off?.losing ?? [])).toEqual([only.id, stale.id].sort());
  expect(off?.keeping).toEqual(
    expect.arrayContaining([
      {
        userId: password.id,
        email: password.email,
        reason: "another-sign-in",
      },
      {
        userId: social.id,
        email: social.email,
        reason: "another-sign-in",
      },
    ]),
  );
});

test("removing the last provider leaves only the emergency admins a way in while Require SSO is on", async () => {
  await database.delete(ssoProviders).where(
    inArray(
      ssoProviders.id,
      otherProviders.map((row) => row.id),
    ),
  );
  try {
    const impact = await store.impact(providerId, true);
    expect(impact?.keeping).toEqual([
      {
        userId: breakGlass.id,
        email: breakGlassEmail,
        reason: "emergency-admin",
      },
    ]);
    expect(ids(impact?.losing ?? [])).toEqual(
      [only.id, elsewhere.id, password.id, social.id, stale.id].sort(),
    );
  } finally {
    await database.insert(ssoProviders).values(otherProviders);
  }
});

test("a person whose access was removed is in neither list", async () => {
  const impact = await store.impact(providerId, true);
  const listed = [...(impact?.losing ?? []), ...(impact?.keeping ?? [])];
  expect(ids(listed)).not.toContain(removed.id);
});

test("a provider nobody signed in through affects nobody", async () => {
  expect(await store.impact(unusedId, true)).toEqual({
    losing: [],
    keeping: [],
  });
});

test("a provider that is not registered has no impact to read", async () => {
  expect(await store.impact(`${prefix}-never-registered`, true)).toBeNull();
});
