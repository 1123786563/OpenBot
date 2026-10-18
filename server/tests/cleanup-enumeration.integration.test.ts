import { afterAll, describe, expect, test } from "../../tests/support/e2e-compat";
import { eq, inArray, sql } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import {
  enumerateCleanupManifest,
  type CleanupManifest,
} from "../src/billing/cleanup-manifest";
import { createDatabase } from "../src/db/client";
import { billingCustomers } from "../src/db/schema/billing";
import { payerAccounts } from "../src/db/schema/billing";
import {
  billingSubscriptions,
  billingWebhookEvents,
} from "../src/db/schema/billing";
import {
  creditChargeRemainders,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { paymentEvents, paymentOrders } from "../src/db/schema/payment";
import { usageOutbox } from "../src/db/schema/usage-outbox";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The legacy billing enumeration (ticket b5-345) against a real PostgreSQL, gated on
 * TEST_DATABASE_URL like the rest of the integration suite. The fixture is the mixed billing
 * data the ticket names — every object class of the old billing stack, attributed through
 * group 02.2's explicit payer mapping:
 *
 * - a personal key and a company key, each mapped by an explicit payer_accounts row,
 * - a legacy_deployment key carrying the full old stack: grants, a real hold/settlement
 *   (reservation + allocation + ledger), a remainder, a subscription, webhook events (one
 *   whose object_id resolves through the subscription, one that resolves to nothing), a
 *   usage-outbox row, and a paid order whose payout grant carries the `plan:<orderId>`
 *   idempotency key the credits writer documents,
 * - an unknown_owner quarantined key, and a key with NO payer mapping at all.
 *
 * Under enumeration:
 * - the manifest covers the exact table set (no more, no fewer) with query-equal counts,
 *   id ranges and schema/database names — nothing from naming guesses,
 * - every fixture key lands in the customers list with per-table row counts matching live
 *   counts, and sum(attribution) === rowCount per table (no join fan-out),
 * - unknown attribution is listed separately (unknown_owner AND unmapped), never folded
 *   into personal or company,
 * - the enumeration is read-only: it runs inside a READ ONLY transaction, table row counts
 *   are byte-identical before and after, two runs agree, and a control write inside a
 *   manual READ ONLY transaction throws — proving the read-only enforcement bites.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const run = `b345-${randomId()}`;

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

/** The five attribution classes the enumeration must keep apart. */
const personalKey = `b345-per-${run}`;
const companyKey = `b345-co-${run}`;
const legacyKey = `b345-leg-${run}`;
const unknownKey = `b345-unk-${run}`;
const unmappedKey = `b345-map-${run}`;
const fixtureKeys = [personalKey, companyKey, legacyKey, unknownKey, unmappedKey];

const legacySubscriptionId = `b345-sub-${run}`;
const legacyOrderId = `b345-po-${run}`;
const webhookHitId = `b345-we-hit-${run}`;
const webhookMissId = `b345-we-miss-${run}`;
const personalOutboxId = `b345-uo-per-${run}`;
const legacyOutboxId = `b345-uo-leg-${run}`;

/** The exact table set the legacy billing stack occupies (schema evidence, fixed order). */
const expectedTables = [
  "billing_customers",
  "payer_accounts",
  "billing_subscriptions",
  "billing_webhook_events",
  "credit_grants",
  "credit_ledger",
  "credit_reservations",
  "credit_reservation_allocations",
  "credit_charge_remainders",
  "payment_orders",
  "payment_events",
  "usage_outbox",
] as const;

/** The keyed tables whose rows the customers list counts per external customer key. */
const keyedTables = [
  ["billing_customers", billingCustomers, billingCustomers.externalId],
  ["billing_subscriptions", billingSubscriptions, billingSubscriptions.externalCustomerId],
  ["credit_grants", creditGrants, creditGrants.externalCustomerId],
  ["credit_ledger", creditLedger, creditLedger.externalCustomerId],
  ["credit_reservations", creditReservations, creditReservations.externalCustomerId],
  ["credit_charge_remainders", creditChargeRemainders, creditChargeRemainders.externalCustomerId],
  ["usage_outbox", usageOutbox, usageOutbox.externalCustomerId],
] as const;

/** The live row count of one table, read the same way the manifest must read it. */
async function liveRowCount(table: string) {
  const rows = await database.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`,
  );
  return rows[0].n;
}

/** The live row count of one keyed table for one external customer key. */
async function liveKeyCount(
  table: (typeof keyedTables)[number][0],
  key: string,
) {
  const entry = keyedTables.find(([name]) => name === table);
  if (!entry) throw new Error(`not a keyed table: ${table}`);
  const rows = await database.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ${entry[1]} WHERE ${entry[2]} = ${key}`,
  );
  return rows[0].n;
}

async function snapshotCounts() {
  const counts = new Map<string, number>();
  for (const table of expectedTables) {
    counts.set(table, await liveRowCount(table));
  }
  return counts;
}

afterAll(async () => {
  // Children first: payment rows and outbox/webhook rows have no customer FK to cascade for.
  await database
    .delete(paymentEvents)
    .where(eq(paymentEvents.orderId, legacyOrderId));
  await database.delete(paymentOrders).where(eq(paymentOrders.id, legacyOrderId));
  await database
    .delete(usageOutbox)
    .where(inArray(usageOutbox.externalCustomerId, fixtureKeys));
  await database
    .delete(billingWebhookEvents)
    .where(
      inArray(billingWebhookEvents.eventId, [webhookHitId, webhookMissId]),
    );
  // billing_customers cascades to payer_accounts, subscriptions, grants, ledger,
  // reservations (and their allocations) and remainders.
  await database
    .delete(billingCustomers)
    .where(inArray(billingCustomers.externalId, fixtureKeys));
  await database.$client.close();
});

describe("the legacy billing enumeration covers the old stack, read-only", () => {
  test("seeding: every attribution class carries its own billing objects", async () => {
    for (const key of fixtureKeys) {
      await database
        .insert(billingCustomers)
        .values({ externalId: key, name: `b5-345 fixture ${key}` });
    }
    // Explicit payer mappings for exactly four of the five keys; the fifth stays unmapped.
    await database.insert(payerAccounts).values([
      {
        id: `b345-pa-per-${run}`,
        kind: "personal",
        payerId: `b345-user-${run}`,
        externalCustomerId: personalKey,
      },
      {
        id: `b345-pa-co-${run}`,
        kind: "company",
        payerId: `b345-tenant-${run}`,
        externalCustomerId: companyKey,
      },
      {
        id: `b345-pa-leg-${run}`,
        kind: "legacy_deployment",
        payerId: `b345-deploy-${run}`,
        externalCustomerId: legacyKey,
      },
      {
        id: `b345-pa-unk-${run}`,
        kind: "unknown_owner",
        payerId: unknownKey,
        externalCustomerId: unknownKey,
      },
    ]);

    // Personal: a grant and a real hold/settlement, so reservations, allocations and the
    // ledger all carry personal rows.
    await writer.grantCredits({
      externalCustomerId: personalKey,
      source: "plan",
      totalCents: 50_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      reason: `b5-345 fixture ${run}`,
      idempotencyKey: `b345-per-grant-${run}`,
    });
    const hold = await writer.reserveCredits({
      externalCustomerId: personalKey,
      idempotencyKey: `b345-per-hold-${run}`,
      maximumCents: 800,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    });
    if (!hold.reserved) throw new Error("fixture hold was refused");
    await writer.settleReservation({
      reservationId: hold.reservationId,
      actual: { numerator: 250n, denominator: 1n },
      title: "b5-345 fixture personal call",
    });

    // Company: a grant and one direct ledger draw (history that must stay intact).
    await writer.grantCredits({
      externalCustomerId: companyKey,
      source: "promo",
      totalCents: 20_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      reason: `b5-345 fixture ${run}`,
      idempotencyKey: `b345-co-grant-${run}`,
    });
    await database.insert(creditLedger).values({
      id: `b345-co-draw-${run}`,
      externalCustomerId: companyKey,
      title: "b5-345 fixture company draw",
      idempotencyKey: `b345-co-draw-${run}`,
      credits: 300,
      applied: 300,
    });

    // Legacy deployment: subscription, webhook events (hit + miss), a paid order whose
    // payout grant carries the documented `plan:<orderId>` key, a second usage-outbox row
    // and a charge remainder.
    await database.insert(billingSubscriptions).values({
      externalCustomerId: legacyKey,
      externalSubscriptionId: legacySubscriptionId,
      planCode: "plan-pro",
      status: "active",
    });
    await database.insert(billingWebhookEvents).values([
      {
        provider: "lago",
        eventId: webhookHitId,
        webhookType: "subscription.updated",
        objectId: legacySubscriptionId,
      },
      {
        provider: "lago",
        eventId: webhookMissId,
        webhookType: "invoice.created",
        objectId: `b345-lago-nope-${run}`,
      },
    ]);
    await database.insert(paymentOrders).values({
      id: legacyOrderId,
      planCode: "plan-pro",
      provider: "alipay",
      amountCents: 1000,
      status: "paid",
      activationState: "applied",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      paidAt: new Date(),
      terminalAt: new Date(),
      createdBy: `b5-345 fixture ${run}`,
    });
    await database.insert(paymentEvents).values({
      id: `b345-pe-${run}`,
      orderId: legacyOrderId,
      kind: "fact",
      code: "paid",
      state: "paid",
      channelTransactionId: `b345-ch-${run}`,
      amountCents: 1000,
      detail: "",
    });
    await writer.grantCredits({
      externalCustomerId: legacyKey,
      source: "plan",
      totalCents: 10_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      reason: `b5-345 fixture paid order ${legacyOrderId}`,
      idempotencyKey: `plan:${legacyOrderId}`,
    });
    await database.insert(creditChargeRemainders).values({
      externalCustomerId: legacyKey,
      numerator: "1",
      denominator: "3",
    });

    // Unknown owner: quarantined by 02.2, still holding a grant nobody may move.
    await writer.grantCredits({
      externalCustomerId: unknownKey,
      source: "signin",
      totalCents: 1_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      reason: `b5-345 fixture ${run}`,
      idempotencyKey: `b345-unk-grant-${run}`,
    });

    // Unmapped: billing rows but no payer_accounts row at all — attribution undeterminable.
    await writer.grantCredits({
      externalCustomerId: unmappedKey,
      source: "promo",
      totalCents: 2_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      reason: `b5-345 fixture ${run}`,
      idempotencyKey: `b345-map-grant-${run}`,
    });

    // Usage outbox rows for the personal and the legacy key.
    await database.insert(usageOutbox).values([
      {
        eventId: personalOutboxId,
        source: "llm",
        externalCustomerId: personalKey,
        transactionId: `b345-tx-per-${run}`,
        inputTokens: 100,
        outputTokens: 50,
        model: "gpt-test",
        client: "web",
        occurredAt: new Date(),
      },
      {
        eventId: legacyOutboxId,
        source: "code_run",
        externalCustomerId: legacyKey,
        transactionId: `b345-tx-leg-${run}`,
        inputTokens: 10,
        outputTokens: 5,
        model: "gpt-test",
        client: "cli",
        occurredAt: new Date(),
      },
    ]);

    for (const key of fixtureKeys) {
      const grants = await liveKeyCount("credit_grants", key);
      expect(grants).toBeGreaterThan(0);
    }
  });

  test("the manifest names every legacy table with query-equal counts and ranges", async () => {
    const manifest = await enumerateCleanupManifest(database);

    // The exact table set: no legacy billing table missed, nothing outside the stack.
    expect(manifest.tables.map((t) => t.table)).toEqual([...expectedTables]);
    for (const table of manifest.tables) {
      expect(table.exists).toBe(true);
      expect(table.schema).toBe("public");
      expect(table.attributionBasis.length).toBeGreaterThan(0);
      // Query evidence, not assumption: the manifest count equals the live count read now.
      expect(table.rowCount).toBe(await liveRowCount(table.table));
      // The attribution join never fans rows out: the classes partition the table exactly.
      const sum =
        table.attribution.personal +
        table.attribution.company +
        table.attribution.legacyDeployment +
        table.attribution.unknownOwner +
        table.attribution.unmapped;
      expect(sum).toBe(table.rowCount);
    }

    // The id range is real query evidence for at least one table.
    const grants = manifest.tables.find((t) => t.table === "credit_grants");
    const liveRange = await database.execute<{ min: string; max: string }>(
      sql`SELECT min(id) AS min, max(id) AS max FROM ${creditGrants}`,
    );
    expect(grants?.idRange).toEqual({
      min: liveRange[0].min,
      max: liveRange[0].max,
    });

    // Database and schema names come from the queried database, not configuration.
    expect(manifest.database).toBe(
      new URL(testDatabaseUrl()).pathname.replace(/^\//, ""),
    );
    expect(manifest.manifestVersion).toBe(1);
  });

  test("every fixture key lands in the customers list with live per-table counts", async () => {
    const manifest = await enumerateCleanupManifest(database);
    const byKey = new Map(
      manifest.customers.map((entry) => [entry.externalCustomerId, entry]),
    );
    expect(byKey.size).toBeGreaterThanOrEqual(fixtureKeys.length);

    for (const key of fixtureKeys) {
      const entry = byKey.get(key);
      expect(entry, `missing customers entry for ${key}`).toBeDefined();
      for (const [table] of keyedTables) {
        const live = await liveKeyCount(table, key);
        expect(entry?.appearsIn[table] ?? 0).toBe(live);
      }
    }

    // The explicit mapping decides attribution — never a name or a prefix.
    expect(byKey.get(personalKey)?.attribution).toBe("personal");
    expect(byKey.get(companyKey)?.attribution).toBe("company");
    expect(byKey.get(legacyKey)?.attribution).toBe("legacy_deployment");
    expect(byKey.get(unknownKey)?.attribution).toBe("unknown_owner");
    expect(byKey.get(unmappedKey)?.attribution).toBe("unmapped");

    // The paid order attributes to the legacy deployment through the `plan:<orderId>`
    // grant linkage, and the resolving webhook rides the subscription's customer.
    const orderRow = manifest.tables.find((t) => t.table === "payment_orders");
    expect(orderRow?.attribution.legacyDeployment).toBeGreaterThanOrEqual(1);
    const webhookRow = manifest.tables.find(
      (t) => t.table === "billing_webhook_events",
    );
    expect(webhookRow?.attribution.legacyDeployment).toBeGreaterThanOrEqual(1);
    // The unresolvable webhook is not guessed into any attribution.
    expect(webhookRow?.attribution.unmapped).toBeGreaterThanOrEqual(1);
    // The reservation allocation rides its reservation's customer.
    const allocationRow = manifest.tables.find(
      (t) => t.table === "credit_reservation_allocations",
    );
    expect(allocationRow?.attribution.personal).toBeGreaterThanOrEqual(1);
  });

  test("unknown attribution is listed separately, never folded into cleanable classes", async () => {
    const manifest = await enumerateCleanupManifest(database);
    const unknownKeys = manifest.unknownOwners.map((e) => e.externalCustomerId);

    // Both unknown classes are listed: the explicit quarantine AND the unmapped key.
    expect(unknownKeys).toContain(unknownKey);
    expect(unknownKeys).toContain(unmappedKey);
    for (const entry of manifest.unknownOwners) {
      expect(["unknown_owner", "unmapped"]).toContain(entry.attribution);
    }
    // Personal, company and legacy keys never appear as unknown — and company history is
    // never marked cleanable-by-default anywhere in the manifest.
    expect(unknownKeys).not.toContain(personalKey);
    expect(unknownKeys).not.toContain(companyKey);
    expect(unknownKeys).not.toContain(legacyKey);
  });

  test("the enumeration is read-only and deterministic", async () => {
    // Control: the read-only enforcement actually bites on this database — a write inside
    // a READ ONLY transaction must throw.
    await expect(
      database.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        await tx
          .insert(billingCustomers)
          .values({ externalId: `b345-ro-probe-${run}` });
      }),
    ).rejects.toThrow();

    const before = await snapshotCounts();
    const first = await enumerateCleanupManifest(database);
    const after = await snapshotCounts();
    expect([...after.entries()]).toEqual([...before.entries()]);

    const second = await enumerateCleanupManifest(database);
    const stable = (m: CleanupManifest) =>
      JSON.stringify({
        tables: m.tables,
        customers: m.customers,
        unknownOwners: m.unknownOwners,
        reservationStatusCounts: m.reservationStatusCounts,
      });
    expect(stable(second)).toBe(stable(first));

    // The settled hold shows up in the status evidence 21.5's in-flight guards need.
    expect(first.reservationStatusCounts.settled).toBeGreaterThanOrEqual(1);
  });
});
