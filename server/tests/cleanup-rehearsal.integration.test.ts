import { afterAll, beforeAll, describe, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  executeTransactionalCleanup,
  rehearseCleanupRollback,
  runAccountingSmoke,
  runCleanupRehearsal,
  type EstateDump,
} from "../src/billing/cleanup-rehearsal";
import { buildCleanupDryRun } from "../src/billing/cleanup-dry-run";
import { guardCleanupDeletion } from "../src/billing/cleanup-guards";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createDatabase } from "../src/db/client";
import {
  billingCustomers,
  billingSubscriptions,
  billingWebhookEvents,
  payerAccounts,
} from "../src/db/schema/billing";
import {
  creditChargeRemainders,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditGrants } from "../src/db/schema/credits";
import { paymentEvents, paymentOrders } from "../src/db/schema/payment";
import { usageOutbox } from "../src/db/schema/usage-outbox";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The transactional cleanup and rebuild rehearsal (ticket b5-350, group 21.6) against a real,
 * dedicated PostgreSQL database, gated on TEST_DATABASE_URL like the rest of the integration
 * suite. The rehearsal proves — on isolated test data only — that the reviewed dry-run scope
 * (21.4) cleared by the deletion guards (21.5) can actually be executed:
 *
 * - AC-a (transactional, full rollback): the cleanup runs in ONE transaction; a failure
 *   injected mid-way (after a real table step) leaves the whole legacy estate byte-identical.
 * - AC-b (row counts match the dry-run): the committed run deletes exactly the dry-run
 *   report's to-delete rows — same total, same per-table counts, same ids — and nothing else.
 * - AC-c (concurrency safety): records added while the cleanup runs are never mistakenly
 *   deleted. A brand-new personal account inserted mid-flight survives untouched; a row
 *   inserted under a dying candidate's parent makes PostgreSQL abort the cleanup with a
 *   serialization failure (the foreign-key protection — nothing is deleted, everything rolls
 *   back) instead of silently eating the new row by cascade.
 * - AC-d (the new accounting system still works after cleanup): grant → reserve → settle
 *   smoke passes for the kept personal account and for a freshly rebuilt one.
 *
 * Fixture: five keys, one per ticket situation — company (kept, loudest markers), personal
 * (kept, smoke target), confirmed-obsolete-test (the full deletable legacy stack), unknown
 * owner (kept quarantine), and a legacy key with a still-RESERVED hold (kept: in-flight duty,
 * 06.8). The fixtures are removed children-first in afterAll; no scenario mutates another's
 * rows. The tests within this file are sequential and share the fixture deliberately: the
 * rollback drill and the FK-protection drill must both end in a rolled-back estate for the
 * later clean run to be a faithful rehearsal.
 *
 * Runner note: registered with `bun:test` like the other cleanup-group suites, because the
 * dedicated test database is driven by `bun test` (TEST_DATABASE_URL) and the server's db
 * client imports the `bun` package.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const run = `b350-${randomUUID().slice(0, 8)}`;

// The five fixture keys: candidate (test), personal, company, unknown, in-flight.
const candidateKey = `b350-cand-${run}`;
const personalKey = `b350-pers-${run}`;
const companyKey = `b350-co-${run}`;
const unknownKey = `b350-unk-${run}`;
const flightKey = `b350-flt-${run}`;
const fixtureKeys = [candidateKey, personalKey, companyKey, unknownKey, flightKey];

const companyPayerId = `b350-co-tenant-${run}`;
const candidateDeploymentId = `b350-deploy-${run}`;
const flightDeploymentId = `b350-deploy-flt-${run}`;

const candidateMappingId = `b350-pa-cand-${run}`;
const personalMappingId = `b350-pa-pers-${run}`;
const companyMappingId = `b350-pa-co-${run}`;
const unknownMappingId = `b350-pa-unk-${run}`;
const flightMappingId = `b350-pa-flt-${run}`;

const candidateSubscriptionId = `b350-sub-${run}`;
const webhookHitId = `b350-we-${run}`;
const candidateOrderId = `b350-po-${run}`;
const candidateEventId = `b350-pe-${run}`;
const candidateOutboxId = `b350-uo-${run}`;
const companyOrderId = `b350-po-co-${run}`;
const companyEventId = `b350-pe-co-${run}`;

const testUser = `b350-test-user-${run}`;
const realUser = `b350-real-user-${run}`;

/** The operator-vouched registries: the candidate AND the company key carry test evidence. */
const evidenceInput = {
  testOrderIds: [candidateOrderId, companyOrderId],
  testUserIds: [testUser],
};

const future = new Date("2027-06-01T00:00:00Z");

/** Stable handles resolved during seeding. */
let flightHold: { reservationId: string };
let scopeBefore: Awaited<ReturnType<typeof buildCleanupDryRun>>;
let estateBefore: EstateDump;

afterAll(async () => {
  // Children first, mirroring the estate's own topology.
  await database.delete(usageOutbox).where(inArray(usageOutbox.eventId, [candidateOutboxId]));
  await database.delete(billingWebhookEvents).where(inArray(billingWebhookEvents.eventId, [webhookHitId]));
  await database.delete(paymentEvents).where(inArray(paymentEvents.orderId, [candidateOrderId, companyOrderId]));
  await database.delete(paymentOrders).where(inArray(paymentOrders.id, [candidateOrderId, companyOrderId]));
  await database.delete(creditChargeRemainders).where(eq(creditChargeRemainders.externalCustomerId, candidateKey));
  // billing_customers cascades to payer_accounts, subscriptions, grants, ledger,
  // reservations and their allocations — including any row a drill added mid-flight.
  await database.delete(billingCustomers).where(inArray(billingCustomers.externalId, fixtureKeys));
  await database.$client.close();
});

/** The full message chain of an error, cause included — drizzle wraps the PostgresError. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    parts.push(current instanceof Error ? current.message : String(current));
  }
  return parts.join(": ");
}

/** One estate row's (table, id) pairs — the identity the dry-run and the dump both name. */
function dumpIds(dump: EstateDump): Set<string> {
  const ids = new Set<string>();
  for (const entry of dump) {
    for (const row of entry.rows) {
      ids.add(`${entry.table}/${String(row[entry.idField])}`);
    }
  }
  return ids;
}

beforeAll(async () => {
  for (const key of fixtureKeys) {
    await database
      .insert(billingCustomers)
      .values({ externalId: key, name: `b5-350 fixture ${key}` });
  }
  await database.insert(payerAccounts).values([
    { id: companyMappingId, kind: "company", payerId: companyPayerId, externalCustomerId: companyKey },
    { id: candidateMappingId, kind: "legacy_deployment", payerId: candidateDeploymentId, externalCustomerId: candidateKey },
    { id: personalMappingId, kind: "personal", payerId: `b350-personal-${run}`, externalCustomerId: personalKey },
    { id: unknownMappingId, kind: "unknown_owner", payerId: `b350-unknown-${run}`, externalCustomerId: unknownKey },
    { id: flightMappingId, kind: "legacy_deployment", payerId: flightDeploymentId, externalCustomerId: flightKey },
  ]);

  // The candidate key: the full legacy stack, settled hold included (settled IS cleanable).
  await database.insert(billingSubscriptions).values({
    externalCustomerId: candidateKey,
    externalSubscriptionId: candidateSubscriptionId,
    planCode: "plan-pro",
    status: "canceled",
  });
  await database.insert(billingWebhookEvents).values({
    provider: "lago",
    eventId: webhookHitId,
    webhookType: "subscription.updated",
    objectId: candidateSubscriptionId,
  });
  await writer.grantCredits({
    externalCustomerId: candidateKey,
    source: "plan",
    totalCents: 10_000,
    expiresAt: future,
    reason: `b5-350 fixture ${run}`,
    // The plan payout grant: the documented attribution linkage (02.x) that resolves the
    // order's test evidence to this key — idempotency_key `plan:<orderId>`.
    idempotencyKey: `plan:${candidateOrderId}`,
  });
  const reserved = await writer.reserveCredits({
    externalCustomerId: candidateKey,
    idempotencyKey: `b350-cand-hold-${run}`,
    maximumCents: 2_000,
    expiresAt: future,
  });
  if (!reserved.reserved) throw new Error("candidate fixture hold was refused");
  await writer.settleReservation({    reservationId: reserved.reservationId,
    actual: { numerator: 500n, denominator: 100n },
    title: `b5-350 fixture settle ${run}`,
  });
  // (The settle above persists the customer's credit_charge_remainders row itself —
  // exact-rational bookkeeping — so the candidate key's remainder row is fixture data too.)
  await database.insert(paymentOrders).values({
    id: candidateOrderId,
    planCode: "plan-pro",
    provider: "alipay",
    amountCents: 1000,
    status: "paid",
    activationState: "applied",
    expiresAt: future,
    paidAt: new Date(),
    terminalAt: new Date(),
    createdBy: realUser,
  });
  await database.insert(paymentEvents).values({
    id: candidateEventId,
    orderId: candidateOrderId,
    kind: "fact",
    code: "paid",
    state: "paid",
    channelTransactionId: `b350-ch-${run}`,
    amountCents: 1000,
    detail: "",
  });
  await database.insert(usageOutbox).values({
    eventId: candidateOutboxId,
    source: "llm",
    externalCustomerId: candidateKey,
    transactionId: `b350-tx-${run}`,
    inputTokens: 10,
    outputTokens: 5,
    model: "gpt-test",
    client: `b5-350-${run}`,
    occurredAt: new Date("2026-01-01T00:00:00Z"),
  });

  // The company key: grant + a pending order carrying BOTH registered markers.
  await writer.grantCredits({
    externalCustomerId: companyKey,
    source: "promo",
    totalCents: 20_000,
    expiresAt: future,
    reason: `b5-350 fixture ${run}`,
    idempotencyKey: `b350-co-grant-${run}`,
  });
  await database.insert(paymentOrders).values({
    id: companyOrderId,
    planCode: "plan-pro",
    provider: "alipay",
    amountCents: 1000,
    status: "pending",
    expiresAt: future,
    createdBy: testUser,
    ownerPayerKind: "company",
    ownerPayerId: companyPayerId,
  });
  await database.insert(paymentEvents).values({
    id: companyEventId,
    orderId: companyOrderId,
    kind: "fact",
    code: "created",
    state: "pending",
    channelTransactionId: `b350-ch-co-${run}`,
    amountCents: 1000,
    detail: "",
  });

  // Personal and unknown keys: one grant each.
  await writer.grantCredits({
    externalCustomerId: personalKey,
    source: "promo",
    totalCents: 8_000,
    expiresAt: future,
    reason: `b5-350 fixture ${run}`,
    idempotencyKey: `b350-pers-grant-${run}`,
  });
  await writer.grantCredits({
    externalCustomerId: unknownKey,
    source: "promo",
    totalCents: 3_000,
    expiresAt: future,
    reason: `b5-350 fixture ${run}`,
    idempotencyKey: `b350-unk-grant-${run}`,
  });

  // The in-flight key: a still-RESERVED hold — open settlement duty, never cleanable.
  await writer.grantCredits({
    externalCustomerId: flightKey,
    source: "promo",
    totalCents: 5_000,
    expiresAt: future,
    reason: `b5-350 fixture ${run}`,
    idempotencyKey: `b350-flt-grant-${run}`,
  });
  const flightReserved = await writer.reserveCredits({
    externalCustomerId: flightKey,
    idempotencyKey: `b350-flt-hold-${run}`,
    maximumCents: 1_500,
    expiresAt: future,
  });
  if (!flightReserved.reserved) throw new Error("flight fixture hold was refused");
  flightHold = { reservationId: flightReserved.reservationId };

  // The reviewed scope the drills execute against, and the untouched estate baseline.
  scopeBefore = await buildCleanupDryRun(database, evidenceInput);
  const guardReport = await guardCleanupDeletion(database, evidenceInput, {
    targets: scopeBefore.toDelete.records.map((record) => ({
      table: record.table,
      recordId: record.recordId,
    })),
  });
  expect(guardReport.refused).toEqual([]);
  expect(guardReport.deletable.length).toBe(scopeBefore.toDelete.totalRows);
  estateBefore = await import("../src/billing/cleanup-rehearsal").then((m) =>
    m.dumpCleanupEstate(database),
  );
});

describe("cleanup rehearsal (b5-350, group 21.6)", () => {
  test("the reviewed scope is exactly the candidate key's legacy stack", () => {
    expect(scopeBefore.toDelete.totalRows).toBe(12);
    const tables = Object.fromEntries(
      scopeBefore.toDelete.byTable.map((group) => [group.table, group.rows]),
    );
    expect(tables).toEqual({
      usage_outbox: 1,
      billing_webhook_events: 1,
      payment_events: 1,
      payment_orders: 1,
      credit_reservation_allocations: 1,
      credit_reservations: 1,
      credit_charge_remainders: 1,
      credit_ledger: 1,
      credit_grants: 1,
      billing_subscriptions: 1,
      payer_accounts: 1,
      billing_customers: 1,
    });
    for (const record of scopeBefore.toDelete.records) {
      expect(record.externalCustomerId).toBe(candidateKey);
    }
  });

  test("AC-a: an injected mid-way failure rolls the whole estate back", async () => {
    const report = await rehearseCleanupRollback(database, evidenceInput, {
      failAfterTable: "credit_grants",
    });
    expect(report.rolledBackCompletely).toBe(true);
    expect(report.injectedFailureAfterTable).toBe("credit_grants");
    expect(report.stepsCompletedBeforeFailure).toBeGreaterThanOrEqual(1);
    // The estate is byte-identical after the failed run.
    const estateAfter = await import("../src/billing/cleanup-rehearsal").then((m) =>
      m.dumpCleanupEstate(database),
    );
    expect(JSON.stringify(estateAfter)).toBe(JSON.stringify(estateBefore));
  });

  test("AC-c: a row added under a dying candidate aborts the cleanup (FK protection), rolls back, and survives", async () => {
    let concurrentGrantInserted = false;
    const execution = executeTransactionalCleanup(database, evidenceInput, {
      onTableDeleted: async (step) => {
        if (step.table !== "credit_grants" || concurrentGrantInserted) return;
        concurrentGrantInserted = true;
        // A concurrent writer attaches a NEW grant to the candidate's customer while the
        // cleanup transaction is running. The insert itself commits on a second connection.
        await database.insert(creditGrants).values({
          id: `b350-cnew-${run}`,
          externalCustomerId: candidateKey,
          source: "promo",
          reason: `b5-350 concurrent ${run}`,
          total: 1_000,
          used: 0,
          expiresAt: future,
          status: "active",
          idempotencyKey: `b350-cnew-grant-${run}`,
        });
      },
    });
    // PostgreSQL refuses to let the cleanup's cascade eat the concurrently committed row:
    // the whole execution fails with a serialization error and rolls back in full.
    let caught: unknown;
    try {
      await execution;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(errorText(caught)).toMatch(/could not serialize access/);
    expect(concurrentGrantInserted).toBe(true);

    // Nothing was deleted: the candidate's stack is intact, and the new row survives.
    const estateAfter = await import("../src/billing/cleanup-rehearsal").then((m) =>
      m.dumpCleanupEstate(database),
    );
    const beforeIds = dumpIds(estateBefore);
    const afterIds = dumpIds(estateAfter);
    for (const id of beforeIds) expect(afterIds.has(id)).toBe(true);
    expect(afterIds.has(`credit_grants/b350-cnew-${run}`)).toBe(true);
    expect(afterIds.size).toBe(beforeIds.size + 1);

    // The concurrently committed grant joined the estate (it survives the rollback — it was
    // never part of the failed transaction), so the fresh classification now names one more
    // record and the scope grows to 13: the clean run deletes it too.
    const scopeAfterDrill = await buildCleanupDryRun(database, evidenceInput);
    expect(scopeAfterDrill.basis.candidatesIn).toBe(scopeBefore.basis.candidatesIn + 1);
    expect(scopeAfterDrill.toDelete.totalRows).toBe(13);
  });

  test("AC-b + AC-c: the clean run deletes exactly the dry-run scope; a new personal account opened mid-flight survives", async () => {
    const newAccountKey = `b350-new-${run}`;
    const scope = await buildCleanupDryRun(database, evidenceInput);
    expect(scope.toDelete.totalRows).toBe(13);

    const report = await runCleanupRehearsal(database, evidenceInput, {
      failAfterTable: "credit_grants",
      onTableDeleted: async (step) => {
        if (step.table !== "usage_outbox") return;
        // A brand-new personal account opens DURING the cleanup: customer + personal
        // mapping + grant, committed on the pool while the cleanup transaction runs.
        await writer.grantCredits({
          externalCustomerId: newAccountKey,
          source: "promo",
          totalCents: 6_000,
          expiresAt: future,
          reason: `b5-350 rebuilt account ${run}`,
          idempotencyKey: `b350-new-grant-${run}`,
        });
        await database.insert(payerAccounts).values({
          id: `b350-pa-new-${run}`,
          kind: "personal",
          payerId: `b350-new-user-${run}`,
          externalCustomerId: newAccountKey,
        });
      },
      smokeKeys: [personalKey, newAccountKey],
    });

    // --- AC-b: committed deletions ≡ the dry-run report, per table and in total.
    expect(report.execution.deletedTotal).toBe(scope.toDelete.totalRows);
    const deletedByTable = Object.fromEntries(
      report.execution.deletedByTable.map((entry) => [entry.table, entry.rows]),
    );
    expect(deletedByTable).toEqual(
      Object.fromEntries(scope.toDelete.byTable.map((group) => [group.table, group.rows])),
    );
    expect(report.execution.deletedIdsMatchScope).toBe(true);

    // Every scoped row is gone from the live data; the report's post-verification agrees.
    const estateAfter = await import("../src/billing/cleanup-rehearsal").then((m) =>
      m.dumpCleanupEstate(database),
    );
    const afterIds = dumpIds(estateAfter);
    for (const record of scope.toDelete.records) {
      expect(afterIds.has(`${record.table}/${record.recordId}`)).toBe(false);
    }
    expect(report.postVerification.scopeRowsRemoved).toBe(true);

    // --- AC-c: kept rows untouched, concurrent records alive, in-flight duty untouched.
    expect(report.postVerification.keptRowsUntouched).toBe(true);
    expect(report.postVerification.concurrentRowsSurviving).toBeGreaterThanOrEqual(3);
    expect(afterIds.has(`credit_grants/b350-cnew-${run}`)).toBe(false); // scoped by the fresh run
    expect(afterIds.has(`billing_customers/${newAccountKey}`)).toBe(true);
    expect(
      afterIds.has(`payer_accounts/b350-pa-new-${run}`),
    ).toBe(true);
    const flightReservation = await database
      .select({ id: creditReservations.id, status: creditReservations.status })
      .from(creditReservations)
      .where(eq(creditReservations.id, flightHold.reservationId))
      .limit(1);
    expect(flightReservation[0]?.status).toBe("reserved");

    // --- AC-d: the smoke ran for the kept and the rebuilt personal account.
    expect(report.accountingSmoke.map((smoke) => smoke.externalCustomerId)).toEqual([
      personalKey,
      newAccountKey,
    ]);
    for (const smoke of report.accountingSmoke) {
      expect(smoke.chargedCents).toBeGreaterThan(0);
      expect(smoke.appliedCents).toBe(smoke.chargedCents);
      expect(smoke.releasedCents).toBe(smoke.reservedCents - smoke.appliedCents);
      expect(smoke.availableBeforeCents - smoke.availableAfterCents).toBe(
        smoke.appliedCents + (smoke.owedUnitAfter - smoke.owedUnitBefore),
      );
    }

    // The rehearsal's rollback drill ran first inside the same report.
    expect(report.rollback.rolledBackCompletely).toBe(true);
  });

  test("re-runnable: no candidates remain and a second execution commits zero deletes", async () => {
    const fresh = await buildCleanupDryRun(database, evidenceInput);
    expect(fresh.toDelete.totalRows).toBe(0);
    expect(fresh.toDelete.records).toEqual([]);

    const report = await executeTransactionalCleanup(database, evidenceInput);
    expect(report.execution.deletedTotal).toBe(0);
    expect(report.execution.deletedByTable).toEqual([]);
  });

  test("AC-d: the accounting smoke runs standalone on a surviving account", async () => {
    const smoke = await runAccountingSmoke(database, personalKey, {
      idempotencyPrefix: `b350-smoke2-${run}`,
    });
    expect(smoke.chargedCents).toBeGreaterThan(0);
    expect(smoke.availableBeforeCents - smoke.availableAfterCents).toBe(
      smoke.appliedCents + (smoke.owedUnitAfter - smoke.owedUnitBefore),
    );
  });
});
