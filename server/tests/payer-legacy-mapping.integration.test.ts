import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createCredits } from "../src/billing/credits";
import {
  createPayerAccount,
  payerKey,
  readPayerAccountForKey,
} from "../src/billing/payer";
import {
  mapLegacyExternalCustomerIds,
  type LegacyMappingOutcome,
} from "../src/billing/payer-legacy";
import { deploymentExternalCustomerId } from "../src/billing/service";
import { createDatabase } from "../src/db/client";
import { billingCustomers } from "../src/db/schema/billing";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { enterpriseTenants } from "../src/db/schema/enterprise-tenancy";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The legacy externalCustomerId mapping (ticket b5-216) against a real PostgreSQL, gated on
 * TEST_DATABASE_URL like the rest of the integration suite. The fixture is the mixed data the
 * ticket names: a claimed deployment key, a company tenant's deployment history (directory-
 * verified), an account the payer layer already mapped, a junk key, a deployment-prefixed key
 * naming no known identity, and a ledger-only key. Under migration:
 *
 * - every key lands in exactly one explicit mapping (idempotent: a second run adds nothing),
 * - no grant or ledger row is deleted, copied or re-pointed (values byte-identical, balances
 *   unchanged, no personal/company key gains rows),
 * - unattributable keys are quarantined as unknown_owner rows that the audit reads answer but
 *   no new consumption path can resolve (payerKey refuses the kind),
 * - a deployment PREFIX alone attributes nothing: the identity must exist behind the key.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const run = randomUUID().slice(0, 8);

/** The deployment identities this run claims (what an assembly would pass from its config). */
const claimedId = `leg-claim-${run}`;
const claimedKey = deploymentExternalCustomerId(claimedId);

/** The company tenant the directory knows: its deployment history stays attributed to it. */
const directoryTenantId = `leg-tenant-${run}`;
const directoryTenantKey = deploymentExternalCustomerId(directoryTenantId);

/** An account the payer layer already mapped before the migration ever ran. */
const premappedId = `leg-premapped-${run}`;
const premappedKey = payerKey({ kind: "legacy_deployment", id: premappedId });

/** Keys nobody can vouch for: junk, and a deployment prefix over a nonexistent identity. */
const junkKey = `openbot-junk-${run}`;
const ghostKey = deploymentExternalCustomerId(`leg-ghost-${run}`);

/** A key that appears only in the ledger (no grant), which the enumeration must not miss. */
const ledgerOnlyKey = `leg-ledger-only-${run}`;

/** Every external customer key this run created; the cleanup deletes exactly these. */
const fixtureKeys = [
  claimedKey,
  directoryTenantKey,
  premappedKey,
  junkKey,
  ghostKey,
  ledgerOnlyKey,
];

async function seedGrant(
  key: string,
  idempotencyKey: string,
  totalCents: number,
  source: "plan" | "promo" = "plan",
) {
  await writer.grantCredits({
    externalCustomerId: key,
    source,
    totalCents,
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    reason: `b5-216 fixture ${run}`,
    idempotencyKey,
  });
}

/** The grant and ledger rows of one key, as full rows for before/after comparison. */
async function rowsOf(key: string) {
  const grants = await database
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.externalCustomerId, key));
  const ledger = await database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.externalCustomerId, key));
  return { grants, ledger };
}

afterAll(async () => {
  await database.execute(
    sql`DELETE FROM payer_accounts WHERE external_customer_id IN (${sql.join(
      fixtureKeys.map((key) => sql`${key}`),
      sql`, `,
    )})`,
  );
  await database
    .delete(enterpriseTenants)
    .where(eq(enterpriseTenants.id, directoryTenantId));
  // billing_customers cascades to the grants and ledger rows.
  await database
    .delete(billingCustomers)
    .where(inArray(billingCustomers.externalId, fixtureKeys));
  await database.$client.close();
});

describe("the mixed legacy fixture maps explicitly, once per key", () => {
  test("seeding: the company tenant exists and every key carries its legacy records", async () => {
    await database
      .insert(enterpriseTenants)
      .values({ id: directoryTenantId, name: `B5-216 fixture tenant ${run}` });

    // The claimed deployment's own history: a grant plus a real hold/settlement, so the
    // preservation check sees both sides of the ledger under the original key.
    await seedGrant(claimedKey, `leg-claim-grant-${run}`, 50_000);
    const hold = await writer.reserveCredits({
      externalCustomerId: claimedKey,
      idempotencyKey: `leg-claim-hold-${run}`,
      maximumCents: 800,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    });
    if (!hold.reserved) throw new Error("fixture hold was refused");
    await writer.settleReservation({
      reservationId: hold.reservationId,
      actual: { numerator: 250n, denominator: 1n },
      title: "legacy claimed call",
    });

    // The company tenant's deployment history, and the already-mapped account's history.
    await seedGrant(directoryTenantKey, `leg-tenant-grant-${run}`, 20_000);
    await createPayerAccount(database, {
      kind: "legacy_deployment",
      id: premappedId,
    });
    await seedGrant(premappedKey, `leg-premapped-grant-${run}`, 5_000);

    // The unattributable keys, each with a balance nobody may move. The junk grant is promo
    // so the page's grants read (which filters plan grants out) still answers it.
    await seedGrant(junkKey, `leg-junk-grant-${run}`, 1_000, "promo");
    await seedGrant(ghostKey, `leg-ghost-grant-${run}`, 2_000);

    // The ledger-only key: a customer row and one ledger row, no grant at all.
    await database
      .insert(billingCustomers)
      .values({ externalId: ledgerOnlyKey, name: null });
    await database.insert(creditLedger).values({
      id: `leg-ledger-only-${run}`,
      externalCustomerId: ledgerOnlyKey,
      title: "legacy orphan draw",
      idempotencyKey: `leg-ledger-only-draw-${run}`,
      credits: 100,
      applied: 100,
    });

    for (const key of fixtureKeys) {
      expect(
        (await rowsOf(key)).grants.length + (await rowsOf(key)).ledger.length,
      ).toBeGreaterThan(0);
    }
  });

  test("the first run classifies every key exactly once and touches no money row", async () => {
    const before = new Map<string, Awaited<ReturnType<typeof rowsOf>>>();
    for (const key of fixtureKeys) before.set(key, await rowsOf(key));
    const claimedBalanceBefore = await writer.availableBalance(claimedKey);
    expect(claimedBalanceBefore).toBe(49_750);

    const report = await mapLegacyExternalCustomerIds(database, {
      claimedDeploymentIds: [claimedId],
    });

    // The report names every fixture key exactly once, in the right classification.
    expect(report.scannedKeys).toBe(6);
    expect(report.legacyDeploymentMapped).toBe(2);
    expect(report.unknownOwnerQuarantined).toBe(3);
    expect(report.alreadyMapped).toBe(1);
    expect(report.unprocessed).toBe(0);
    const byKey = new Map<string, LegacyMappingOutcome>(
      report.outcomes.map((outcome) => [outcome.externalCustomerId, outcome]),
    );
    expect(byKey.size).toBe(6);
    expect(byKey.get(claimedKey)).toMatchObject({
      kind: "legacy_deployment",
      payerId: claimedId,
    });
    expect(byKey.get(directoryTenantKey)).toMatchObject({
      kind: "legacy_deployment",
      payerId: directoryTenantId,
    });
    expect(byKey.get(premappedKey)).toMatchObject({ kind: "already_mapped" });
    for (const key of [junkKey, ghostKey, ledgerOnlyKey]) {
      expect(byKey.get(key)).toMatchObject({ kind: "unknown_owner" });
    }

    // The explicit mappings exist and name the identity the derivation came from.
    expect((await readPayerAccountForKey(database, claimedKey))?.payerId).toBe(
      claimedId,
    );
    expect(
      (await readPayerAccountForKey(database, directoryTenantKey))?.kind,
    ).toBe("legacy_deployment");
    expect(
      (await readPayerAccountForKey(database, premappedKey))?.payerId,
    ).toBe(premappedId);

    // No money row changed anywhere: same rows, same values, same balance.
    for (const key of fixtureKeys) {
      expect(await rowsOf(key)).toEqual(before.get(key));
    }
    expect(await writer.availableBalance(claimedKey)).toBe(
      claimedBalanceBefore,
    );

    // And no balance was copied out to any personal or company account: no payer account
    // of those kinds exists for anything this run touched, and no grant/ledger row either.
    const copied = await database.execute(
      sql`SELECT count(*) AS n FROM payer_accounts WHERE kind IN ('personal', 'company')`,
    );
    expect(Number(copied[0].n)).toBe(0);
    const strayMoney = await database.execute(
      sql`SELECT count(*) AS n FROM credit_grants WHERE external_customer_id LIKE 'openbot-personal-%' OR external_customer_id LIKE 'openbot-company-%'`,
    );
    expect(Number(strayMoney[0].n)).toBe(0);
  });

  test("a second run adds no mapping and rewrites no classification", async () => {
    const before = new Map<string, Awaited<ReturnType<typeof rowsOf>>>();
    for (const key of fixtureKeys) before.set(key, await rowsOf(key));
    const accountsBefore = await database.execute(
      sql`SELECT id, kind, payer_id, external_customer_id FROM payer_accounts
          WHERE external_customer_id IN (${sql.join(
            fixtureKeys.map((key) => sql`${key}`),
            sql`, `,
          )}) ORDER BY external_customer_id`,
    );

    const report = await mapLegacyExternalCustomerIds(database, {
      claimedDeploymentIds: [claimedId],
    });

    expect(report.scannedKeys).toBe(6);
    expect(report.legacyDeploymentMapped).toBe(0);
    expect(report.unknownOwnerQuarantined).toBe(0);
    expect(report.alreadyMapped).toBe(6);
    expect(report.unprocessed).toBe(0);

    const accountsAfter = await database.execute(
      sql`SELECT id, kind, payer_id, external_customer_id FROM payer_accounts
          WHERE external_customer_id IN (${sql.join(
            fixtureKeys.map((key) => sql`${key}`),
            sql`, `,
          )}) ORDER BY external_customer_id`,
    );
    expect(accountsAfter).toEqual(accountsBefore);
    for (const key of fixtureKeys) {
      expect(await rowsOf(key)).toEqual(before.get(key));
    }
  });
});

describe("unknown_owner records are quarantined: auditable, never consumable", () => {
  test("the audit reads answer the quarantine row while the write path refuses it", async () => {
    // Audit: the reverse lookup names the quarantined account, and the grant is still there.
    const quarantined = await readPayerAccountForKey(database, junkKey);
    expect(quarantined).toMatchObject({
      kind: "unknown_owner",
      payerId: junkKey,
      externalCustomerId: junkKey,
    });
    const junkRows = await rowsOf(junkKey);
    expect(junkRows.grants).toHaveLength(1);
    expect(junkRows.grants[0].total).toBe(1_000);

    // Isolation: no PayerRef resolves a quarantined record into a billable key.
    expect(() => payerKey({ kind: "unknown_owner", id: junkKey })).toThrow(
      TypeError,
    );
    await expect(
      createPayerAccount(database, { kind: "unknown_owner", id: junkKey }),
    ).rejects.toThrow(TypeError);
  });

  test("a deployment prefix is not an identity: the ghost key stayed quarantined", async () => {
    // The ghost key carries the deployment spelling but names no claimed id and no directory
    // tenant, so prefix-shaped guessing would have attributed it — the mapping must not.
    const quarantined = await readPayerAccountForKey(database, ghostKey);
    expect(quarantined?.kind).toBe("unknown_owner");
  });

  test("the quarantined key's history stays readable under its original key", async () => {
    const credits = createCredits({
      database,
      externalCustomerKey: junkKey,
      catalog: new Map(),
    });
    const page = await credits.consumption({ from: null, to: null, page: 1 });
    // The junk key has a grant but no settled draw, so its consumption page is empty — the
    // audit read that must still work is the grants read under the original key.
    expect(page.entries).toHaveLength(0);
    expect(await credits.grants()).toHaveLength(1);
    expect((await credits.grants())[0].total).toBe(10);
  });

  test("the ledger-only key was enumerated and quarantined too", async () => {
    const quarantined = await readPayerAccountForKey(database, ledgerOnlyKey);
    expect(quarantined).toMatchObject({
      kind: "unknown_owner",
      payerId: ledgerOnlyKey,
    });
    const rows = await rowsOf(ledgerOnlyKey);
    expect(rows.ledger).toHaveLength(1);
    expect(rows.grants).toHaveLength(0);
  });
});
