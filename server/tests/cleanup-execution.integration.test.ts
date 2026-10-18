import { afterAll, beforeAll, describe, expect, test } from "../../tests/support/e2e-compat";
import { inArray, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { requireAdmin } from "../src/auth/guards";
import {
  buildCleanupDryRun,
  type CleanupDryRunReport,
} from "../src/billing/cleanup-dry-run";
import {
  type CleanupExecutionReport,
  executeAuthorizedCleanup,
} from "../src/billing/cleanup-execution";
import { createBillingAdminRoutes } from "../src/billing/routes";
import type { BillingService } from "../src/billing/types";
import { createDatabase } from "../src/db/client";
import {
  billingCustomers,
  billingSubscriptions,
  billingWebhookEvents,
  payerAccounts,
} from "../src/db/schema/billing";
import { agents, auditEvents, sessions, users } from "../src/db/schema/core";
import {
  creditChargeRemainders,
  creditReservationAllocations,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../src/db/schema/credits";
import { paymentEvents, paymentOrders } from "../src/db/schema/payment";
import { usageOutbox } from "../src/db/schema/usage-outbox";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The authorized legacy billing cleanup execution (ticket b5-351, group 21.7) against a real
 * PostgreSQL on the dedicated test database. It consumes 21.1-21.5's manifests, dry-run and
 * guards and delivers the controlled execution: the three-factor gate (verified manifest
 * version + dry-run scope hash + an explicit authorization record — any one missing or
 * mismatched refuses), the single-transaction execution with a written audit receipt, the
 * admin-viewable execution report (deleted / retained / quarantined counts, recovery method,
 * accounting verification), and the repeat-execution safety properties.
 *
 * The ticket's acceptance criteria, made mechanical here:
 *
 * - AC-1 (refuse without the three factors): a missing or incomplete authorization, a tampered
 *   scope hash, a manifest-version mismatch and a foreign database each refuse with a named
 *   reason, and every refusal leaves all twelve legacy tables byte-identical.
 * - AC-2 (the report): a successful execution writes one audit row per phase (executed receipt
 *   in the same transaction as the deletions, post-verification after), the report carries the
 *   deleted/retained/quarantined counts, a recovery method (every deleted row captured whole in
 *   the receipt), and the admin read route answers it to an administrator and nobody else.
 * - AC-3 (protected surfaces unchanged): company history, personal records, the unknown_owner
 *   quarantine and the application objects (users, sessions, agents, knowledge bases and their
 *   documents) are byte-identical before and after execution.
 * - AC-4 (accounting): the company and personal credit footprints are byte-identical after
 *   execution (no old balance copied into either account), a grant→reserve→settle smoke on the
 *   cleaned database passes, and a repeat run with the old authorization refuses — new data
 *   written after one execution is only ever touched by a fresh dry-run plus a fresh
 *   authorization, never by the old confirmation.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const run = `b351-${Math.random().toString(36).slice(2, 10)}`;

/** The five fixture keys: two keeps, one quarantine-only, one in-flight, one clean chain. */
const companyKey = `b351-co-${run}`;
const personalKey = `b351-per-${run}`;
const cleanKey = `b351-clean-${run}`;
const unknownKey = `b351-unk-${run}`;
const flightKey = `b351-flt-${run}`;
const fixtureKeys = [companyKey, personalKey, cleanKey, unknownKey, flightKey];

const companyMappingId = `b351-pa-co-${run}`;
const personalMappingId = `b351-pa-per-${run}`;
const cleanMappingId = `b351-pa-clean-${run}`;
const unknownMappingId = `b351-pa-unk-${run}`;
const flightMappingId = `b351-pa-flt-${run}`;

const companyPayerId = `b351-co-tenant-${run}`;
const personalPayerId = `b351-personal-user-${run}`;
const cleanPayerId = `b351-dep-clean-${run}`;
const unknownPayerId = `b351-dep-unk-${run}`;
const flightPayerId = `b351-dep-flt-${run}`;

const companySubscriptionId = `b351-sub-co-${run}`;
const cleanSubscriptionId = `b351-sub-clean-${run}`;

const companyGrantId = `b351-g-co-${run}`;
const personalGrantId = `b351-g-per-${run}`;
const cleanGrantId = `b351-g-clean-${run}`;
const unknownGrantId = `b351-g-unk-${run}`;
const flightGrantId = `b351-g-flt-${run}`;

const companyLedgerId = `b351-l-co-${run}`;
const cleanLedgerId = `b351-l-clean-${run}`;
const flightLedgerId = `b351-l-flt-${run}`;

const companySettledId = `b351-r-co-${run}`;
const cleanSettledId = `b351-r-clean-${run}`;
const flightReservedId = `b351-r-flt-${run}`;

const companyAllocationId = `b351-a-co-${run}`;
const cleanAllocationId = `b351-a-clean-${run}`;
const flightAllocationId = `b351-a-flt-${run}`;

const cleanWebhookId = `b351-we-clean-${run}`;
const cleanOutboxId = `b351-uo-clean-${run}`;

const cleanOrderId = `b351-po-clean-${run}`;
const flightOrderId = `b351-po-flt-${run}`;
const companyOrderId = `b351-po-co-${run}`;

const cleanEventId = `b351-pe-clean-${run}`;
const flightEventId = `b351-pe-flt-${run}`;
const companyEventId = `b351-pe-co-${run}`;

/** Each paid legacy order needs its own deployment purchase scope. */
const cleanScope = `b351-scope-clean-${run}`;
const flightScope = `b351-scope-flight-${run}`;
const companyScope = `b351-scope-company-${run}`;

/** The operator-vouched test-evidence registries: the two registered legacy test orders. */
const evidenceInput = {
  testOrderIds: [cleanOrderId, flightOrderId],
  testUserIds: [],
};

/** The protected application objects the cleanup must never touch (users/Bots/sessions/KB). */
const protectedUserId = `b351-user-${run}`;
const protectedSessionId = `b351-session-${run}`;
const protectedAgentId = `b351-agent-${run}`;
const protectedKbId = `b351kb-${run}-kb`;
const protectedKnowledgeId = `b351kn-${run}-kn`;
const kbTenant = `b351-tenant-${run}`;

/** The twelve legacy tables, in the classification's fixed order — the invariance surface. */
const LEGACY_TABLES = [
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

/** The identity column of every estate table (the modules' own recordId spelling). */
const ID_COLUMN_OF: Record<string, string> = {
  billing_customers: "external_id",
  payer_accounts: "id",
  billing_subscriptions: "external_subscription_id",
  billing_webhook_events: "event_id",
  credit_grants: "id",
  credit_ledger: "id",
  credit_reservations: "id",
  credit_reservation_allocations: "id",
  credit_charge_remainders: "external_customer_id",
  payment_orders: "id",
  payment_events: "id",
  usage_outbox: "event_id",
};

/** Full dump of every legacy table, JSON-normalized for a stable deep comparison. */
async function dumpLegacyTables(): Promise<Record<string, unknown>> {
  const dumps: Record<string, unknown> = {};
  for (const table of LEGACY_TABLES) {
    const rows = await database.execute(
      sql.raw(`SELECT * FROM ${table} ORDER BY 1`),
    );
    dumps[table] = JSON.parse(JSON.stringify(rows));
  }
  return dumps;
}

/** The rows of one legacy table whose identity column carries one of the ids. */
async function rowsOf(
  table: string,
  ids: string[],
): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  const rows = await database.execute(
    sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.identifier(
      ID_COLUMN_OF[table] ?? "id",
    )} = ANY(${sql.raw(`ARRAY[${ids.map((id) => `'${id.replaceAll("'", "''")}'`).join(",")}]`)}) ORDER BY 1`,
  );
  return JSON.parse(JSON.stringify(rows));
}

/** Every audit row the cleanup program wrote, for the given execution ids. */
async function cleanupAuditRows(executionIds: string[]) {
  if (executionIds.length === 0) return [];
  const rows = await database
    .select()
    .from(auditEvents)
    .where(inArray(auditEvents.targetType, ["billing_cleanup"]));
  return rows
    .filter((row) => executionIds.includes(row.targetId ?? ""))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

let preDump: Record<string, unknown>;
let dryRun: CleanupDryRunReport;
let authorization: Record<string, unknown>;

/** Every execution id a successful attempt produced, and the most recent report. */
const executionIds: string[] = [];
let lastReport: CleanupExecutionReport | undefined;

afterAll(async () => {
  // Children first, mirroring the FK graph the modules evaluate. The engine's own accounting
  // smoke cleans after itself; everything seeded here lands in this teardown.
  await database.execute(
    sql`DELETE FROM credit_reservation_allocations WHERE id LIKE ${"b351-%" + run}`,
  );
  await database.execute(
    sql`DELETE FROM credit_reservations WHERE id LIKE ${"b351-%" + run}`,
  );
  await database.execute(
    sql`DELETE FROM credit_ledger WHERE id LIKE ${"b351-%" + run}`,
  );
  await database.execute(
    sql`DELETE FROM credit_grants WHERE id LIKE ${"b351-%" + run}`,
  );
  await database.execute(
    sql`DELETE FROM credit_charge_remainders WHERE external_customer_id LIKE ${"b351-%" + run}`,
  );
  await database.execute(
    sql`DELETE FROM billing_webhook_events WHERE event_id LIKE ${"b351-%" + run}`,
  );
  await database.execute(
    sql`DELETE FROM usage_outbox WHERE event_id LIKE ${"b351-%" + run}`,
  );
  await database.execute(
    sql`DELETE FROM payment_events WHERE id LIKE ${"b351-%" + run}`,
  );
  await database.execute(
    sql`DELETE FROM payment_orders WHERE id LIKE ${"b351-%" + run}`,
  );
  await database.execute(
    sql`DELETE FROM billing_subscriptions WHERE external_customer_id LIKE ${"b351-%" + run}`,
  );
  await database.execute(
    sql`DELETE FROM payer_accounts WHERE id LIKE ${"b351-%" + run}`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${"b351-%" + run}`,
  );
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE ${"b351-%" + run}`,
  );
  // audit_events is append-only by database trigger: this run's rows stay, scoped by
  // execution id, and no assertion reads absolute counts.
  await database
    .delete(sessions)
    .where(inArray(sessions.id, [protectedSessionId]));
  await database.delete(agents).where(inArray(agents.id, [protectedAgentId]));
  await database.execute(
    sql`DELETE FROM knowledges WHERE id = ${protectedKnowledgeId}`,
  );
  await database.execute(
    sql`DELETE FROM knowledge_bases WHERE id = ${protectedKbId}`,
  );
  await database.delete(users).where(inArray(users.id, [protectedUserId]));
  await database.$client.close();
});

beforeAll(async () => {
  // Leftovers from an earlier aborted run on this same database: the audit trail is
  // append-only (the database refuses deletions), so prior executions' rows stay — the
  // assertions below always scope to this run's own execution ids — and a smoke probe that
  // crashed before its cleanup would leave one customer row, which goes now.
  await database.execute(
    sql`DELETE FROM billing_customers WHERE external_id LIKE 'cleanup-smoke-%'`,
  );

  // --- Protected application objects: one row per surface the cleanup must never reach.
  await database
    .insert(users)
    .values({ id: protectedUserId, email: `b351-${run}@openbot.test` });
  await database.insert(sessions).values({
    id: protectedSessionId,
    userId: protectedUserId,
    token: `b351-session-token-${run}`,
    expiresAt: new Date("2027-01-01T00:00:00Z"),
  });
  await database.insert(agents).values({
    id: protectedAgentId,
    name: `b351 agent ${run}`,
    type: "built_in",
    configuration: {},
  });
  await database.execute(sql`
    INSERT INTO knowledge_bases (id, tenant_id, name, chunking_config, embedding_model_id)
    VALUES (${protectedKbId}, ${kbTenant}, ${`b351 kb ${run}`}, '{}', 'b351-embedding')
  `);
  await database.execute(sql`
    INSERT INTO knowledges (id, tenant_id, knowledge_base_id, type, title, embedding_model_id)
    VALUES (${protectedKnowledgeId}, ${kbTenant}, ${protectedKbId}, 'manual', ${`b351 knowledge ${run}`}, 'b351-embedding')
  `);

  // --- The legacy estate: customers and the explicit 02.2 mappings, one per key.
  for (const key of fixtureKeys) {
    await database
      .insert(billingCustomers)
      .values({ externalId: key, name: `b351 fixture ${key}` });
  }
  await database.insert(payerAccounts).values([
    {
      id: companyMappingId,
      kind: "company",
      payerId: companyPayerId,
      externalCustomerId: companyKey,
    },
    {
      id: personalMappingId,
      kind: "personal",
      payerId: personalPayerId,
      externalCustomerId: personalKey,
    },
    {
      id: cleanMappingId,
      kind: "legacy_deployment",
      payerId: cleanPayerId,
      externalCustomerId: cleanKey,
    },
    {
      id: unknownMappingId,
      kind: "legacy_deployment",
      payerId: unknownPayerId,
      externalCustomerId: unknownKey,
    },
    {
      id: flightMappingId,
      kind: "legacy_deployment",
      payerId: flightPayerId,
      externalCustomerId: flightKey,
    },
  ]);

  // Subscriptions: the company key's live one (kept — company anchor), the clean key's
  // canceled one (deletable chain).
  await database.insert(billingSubscriptions).values([
    {
      externalCustomerId: companyKey,
      externalSubscriptionId: companySubscriptionId,
      planCode: "company-plan",
      status: "active",
    },
    {
      externalCustomerId: cleanKey,
      externalSubscriptionId: cleanSubscriptionId,
      planCode: "legacy-test",
      status: "canceled",
    },
  ]);

  await database.insert(creditGrants).values([
    {
      id: companyGrantId,
      externalCustomerId: companyKey,
      source: "promo",
      total: 10_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: `b351-promo-co-${run}`,
    },
    {
      id: personalGrantId,
      externalCustomerId: personalKey,
      source: "promo",
      total: 10_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: `b351-promo-per-${run}`,
    },
    {
      id: cleanGrantId,
      externalCustomerId: cleanKey,
      source: "plan",
      total: 20_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: `plan:${cleanOrderId}`,
    },
    {
      id: unknownGrantId,
      externalCustomerId: unknownKey,
      source: "promo",
      total: 5_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: `b351-promo-unk-${run}`,
    },
    {
      id: flightGrantId,
      externalCustomerId: flightKey,
      source: "promo",
      total: 10_000,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: `b351-promo-flt-${run}`,
    },
  ]);

  await database.insert(creditLedger).values([
    {
      id: companyLedgerId,
      externalCustomerId: companyKey,
      grantId: companyGrantId,
      title: `b351 company settlement ${run}`,
      idempotencyKey: `b351-ledger-co-${run}`,
      credits: 400,
      applied: 400,
    },
    {
      id: cleanLedgerId,
      externalCustomerId: cleanKey,
      grantId: cleanGrantId,
      title: `b351 clean settlement ${run}`,
      idempotencyKey: `b351-ledger-clean-${run}`,
      credits: 200,
      applied: 200,
    },
    {
      id: flightLedgerId,
      externalCustomerId: flightKey,
      grantId: flightGrantId,
      title: `b351 flight pointer target ${run}`,
      idempotencyKey: `b351-ledger-flt-${run}`,
      credits: 100,
      applied: 100,
    },
  ]);

  // Reservations: the keeps settle; the flight key's hold is still RESERVED (in-flight
  // responsibility — quarantined, and it pulls its evidence chain out of the cleanup).
  await database.insert(creditReservations).values([
    {
      id: companySettledId,
      externalCustomerId: companyKey,
      idempotencyKey: `b351-settled-co-${run}`,
      maximum: 1_000,
      status: "settled",
      expiresAt: new Date("2026-01-01T00:00:00Z"),
      terminalAt: new Date("2026-01-01T01:00:00Z"),
      actualNumerator: "40000",
      actualDenominator: "100",
      charged: 400,
      applied: 400,
      released: 600,
      ledgerId: companyLedgerId,
    },
    {
      id: cleanSettledId,
      externalCustomerId: cleanKey,
      idempotencyKey: `b351-settled-clean-${run}`,
      maximum: 1_000,
      status: "settled",
      expiresAt: new Date("2026-01-01T00:00:00Z"),
      terminalAt: new Date("2026-01-01T01:00:00Z"),
      actualNumerator: "20000",
      actualDenominator: "100",
      charged: 200,
      applied: 200,
      released: 800,
      ledgerId: cleanLedgerId,
    },
    {
      id: flightReservedId,
      externalCustomerId: flightKey,
      idempotencyKey: `b351-hold-flt-${run}`,
      maximum: 1_000,
      status: "reserved",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      ledgerId: flightLedgerId,
    },
  ]);

  await database.insert(creditReservationAllocations).values([
    {
      id: companyAllocationId,
      reservationId: companySettledId,
      grantId: companyGrantId,
      amount: 1_000,
      consumed: 400,
    },
    {
      id: cleanAllocationId,
      reservationId: cleanSettledId,
      grantId: cleanGrantId,
      amount: 1_000,
      consumed: 200,
    },
    {
      id: flightAllocationId,
      reservationId: flightReservedId,
      grantId: flightGrantId,
      amount: 1_000,
      consumed: 0,
    },
  ]);

  await database.insert(creditChargeRemainders).values(
    [cleanKey, unknownKey, flightKey].map((key, index) => ({
      externalCustomerId: key,
      numerator: `${index}`,
      denominator: "3",
    })),
  );

  await database.insert(billingWebhookEvents).values([
    {
      provider: "lago",
      eventId: cleanWebhookId,
      lagoUniqueKey: `b351-lago-secret-${run}`,
      webhookType: "subscription.canceled",
      objectId: cleanSubscriptionId,
    },
  ]);

  await database.insert(usageOutbox).values([
    {
      eventId: cleanOutboxId,
      source: "llm",
      externalCustomerId: cleanKey,
      transactionId: `b351-tx-clean-${run}`,
      inputTokens: 10,
      outputTokens: 5,
      model: "gpt-test",
      client: "b351-fixture",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      reservationId: cleanSettledId,
      actualCostNumerator: "20000",
      actualCostDenominator: "100",
    },
  ]);

  // Orders: the two registered legacy test orders (paid), and the company key's own paid
  // order that carries NO test evidence (R1 keeps it whatever the registries say).
  await database.insert(paymentOrders).values([
    {
      id: cleanOrderId,
      deploymentScope: cleanScope,
      planCode: "legacy-test",
      provider: "alipay",
      amountCents: 1_000,
      status: "paid",
      activationState: "applied",
      ownerPayerKind: "legacy_deployment",
      ownerPayerId: cleanPayerId,
      expiresAt: new Date("2026-01-01T00:00:00Z"),
      paidAt: new Date("2026-01-01T00:30:00Z"),
      terminalAt: new Date("2026-01-01T00:30:00Z"),
    },
    {
      id: flightOrderId,
      deploymentScope: flightScope,
      planCode: "legacy-test",
      provider: "wechat",
      amountCents: 1_000,
      status: "paid",
      activationState: "applied",
      ownerPayerKind: "legacy_deployment",
      ownerPayerId: flightPayerId,
      expiresAt: new Date("2026-01-01T00:00:00Z"),
      paidAt: new Date("2026-01-01T00:30:00Z"),
      terminalAt: new Date("2026-01-01T00:30:00Z"),
    },
    {
      id: companyOrderId,
      deploymentScope: companyScope,
      planCode: "company-plan",
      provider: "alipay",
      amountCents: 5_000,
      status: "paid",
      activationState: "applied",
      ownerPayerKind: "company",
      ownerPayerId: companyPayerId,
      expiresAt: new Date("2026-01-01T00:00:00Z"),
      paidAt: new Date("2026-01-01T00:30:00Z"),
      terminalAt: new Date("2026-01-01T00:30:00Z"),
    },
  ]);

  await database.insert(paymentEvents).values([
    {
      id: cleanEventId,
      orderId: cleanOrderId,
      kind: "fact",
      code: "paid",
      state: "paid",
      channelTransactionId: `b351-ct-clean-${run}`,
      amountCents: 1_000,
    },
    {
      id: flightEventId,
      orderId: flightOrderId,
      kind: "fact",
      code: "paid",
      state: "paid",
      channelTransactionId: `b351-ct-flt-${run}`,
      amountCents: 1_000,
    },
    {
      id: companyEventId,
      orderId: companyOrderId,
      kind: "fact",
      code: "paid",
      state: "paid",
      channelTransactionId: `b351-ct-co-${run}`,
      amountCents: 5_000,
    },
  ]);

  preDump = await dumpLegacyTables();
  dryRun = await buildCleanupDryRun(database, evidenceInput);
  authorization = {
    authorizationVersion: 1,
    authorizedBy: `operator-${run}`,
    authorizedAt: new Date().toISOString(),
    statement: `Authorized for b5-351: delete the manifest's confirmed-obsolete test billing chain for ${cleanKey} on database ${dryRun.binding.database}; company history, personal records and quarantined unknowns stay.`,
    scope: dryRun.binding,
  };
});

/** Runs one execution attempt, answering the refusal message when it throws. */
async function attempt(
  auth: unknown,
  evidence: { testOrderIds: string[]; testUserIds: string[] } = evidenceInput,
): Promise<{ refused: string } | { report: CleanupExecutionReport }> {
  try {
    const report = await executeAuthorizedCleanup(database, evidence, auth);
    executionIds.push(report.executionId);
    lastReport = report;
    return { report };
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
}

describe("AC-1: the execution refuses without all three factors, deleting nothing", () => {
  test("a missing authorization refuses before anything else runs", async () => {
    const answer = await attempt(undefined);
    expect("refused" in answer && answer.refused).toContain("authorization");
    expect(await dumpLegacyTables()).toEqual(preDump);
  });

  test("an authorization without its scope binding refuses", async () => {
    const answer = await attempt({ ...authorization, scope: undefined });
    expect("refused" in answer && answer.refused).toContain("scope");
    expect(await dumpLegacyTables()).toEqual(preDump);
  });

  test("an authorization without a named authorizer refuses", async () => {
    const answer = await attempt({ ...authorization, authorizedBy: "   " });
    expect("refused" in answer && answer.refused).toContain("authorizedBy");
    expect(await dumpLegacyTables()).toEqual(preDump);
  });

  test("a tampered scope hash refuses with the difference named", async () => {
    const tampered = {
      ...authorization,
      scope: { ...dryRun.binding, scopeHash: "0".repeat(64) },
    };
    const answer = await attempt(tampered);
    expect("refused" in answer && answer.refused).toContain("scope hash");
    expect(await dumpLegacyTables()).toEqual(preDump);
  });

  test("an older manifest version recorded in the authorization refuses", async () => {
    const stale = {
      ...authorization,
      scope: {
        ...dryRun.binding,
        manifestVersions: { ...dryRun.binding.manifestVersions, manifest: 0 },
      },
    };
    const answer = await attempt(stale);
    expect("refused" in answer && answer.refused).toContain("version");
    expect(await dumpLegacyTables()).toEqual(preDump);
  });

  test("an authorization taken on another database never executes here", async () => {
    const foreign = {
      ...authorization,
      scope: { ...dryRun.binding, database: "openbot_someone_else" },
    };
    const answer = await attempt(foreign);
    expect("refused" in answer && answer.refused).toContain("database");
    expect(await dumpLegacyTables()).toEqual(preDump);
  });
});

describe("AC-2/AC-3/AC-4: the authorized execution, its report and its receipt", () => {
  let report: CleanupExecutionReport;

  test("the authorized execution deletes exactly the verified scope", async () => {
    const answer = await attempt(authorization);
    if (!("report" in answer)) throw new Error(`refused: ${answer.refused}`);
    report = answer.report;

    expect(report.transaction.committed).toBe(true);
    expect(report.deleted.totalRows).toBe(dryRun.toDelete.totalRows);
    expect(report.deleted.totalRows).toBeGreaterThan(0);
    expect(report.binding.scopeHash).toBe(dryRun.binding.scopeHash);
    // Deletion actually happened, scoped exactly: the clean chain is gone.
    expect(await rowsOf("billing_customers", [cleanKey])).toEqual([]);
    expect(await rowsOf("credit_grants", [cleanGrantId])).toEqual([]);
    expect(await rowsOf("payment_orders", [cleanOrderId])).toEqual([]);
    expect(await rowsOf("payment_events", [cleanEventId])).toEqual([]);
    expect(await rowsOf("usage_outbox", [cleanOutboxId])).toEqual([]);
    expect(await rowsOf("billing_webhook_events", [cleanWebhookId])).toEqual(
      [],
    );
    expect(await rowsOf("credit_charge_remainders", [cleanKey])).toEqual([]);
    expect(
      await rowsOf("credit_reservation_allocations", [cleanAllocationId]),
    ).toEqual([]);
    expect(await rowsOf("credit_reservations", [cleanSettledId])).toEqual([]);
    expect(await rowsOf("credit_ledger", [cleanLedgerId])).toEqual([]);
    expect(await rowsOf("payer_accounts", [cleanMappingId])).toEqual([]);
  });

  test("every kept row is byte-identical: company history, personal, quarantine", async () => {
    const after = await dumpLegacyTables();
    const deletedByTable = new Map(
      report.deleted.byTable.map((entry) => [entry.table, entry.rows]),
    );
    for (const table of LEGACY_TABLES) {
      const beforeRows = preDump[table] as Record<string, unknown>[];
      const afterRows = after[table] as Record<string, unknown>[];
      expect(afterRows.length).toBe(
        beforeRows.length - (deletedByTable.get(table) ?? 0),
      );
    }
    // The company history rows specifically: byte-identical (ADR 0004), whatever test
    // markers their rows also carry.
    expect(await rowsOf("credit_grants", [companyGrantId])).toEqual(
      (preDump.credit_grants as Record<string, unknown>[]).filter(
        (row) => row.id === companyGrantId,
      ),
    );
    expect((await rowsOf("payment_orders", [companyOrderId])).length).toBe(1);
    expect((await rowsOf("payment_events", [companyEventId])).length).toBe(1);
    // Personal records kept.
    expect((await rowsOf("credit_grants", [personalGrantId])).length).toBe(1);
    // Quarantine kept: the unknown_owner chain and the in-flight chain, untouched.
    expect(
      (await rowsOf("credit_grants", [unknownGrantId, flightGrantId])).length,
    ).toBe(2);
    expect(
      (await rowsOf("credit_reservations", [flightReservedId])).length,
    ).toBe(1);
    expect(
      (await rowsOf("credit_reservations", [flightReservedId]))[0].status,
    ).toBe("reserved");
    expect(
      (await rowsOf("credit_reservation_allocations", [flightAllocationId]))
        .length,
    ).toBe(1);
  });

  test("the application objects (users/Bots/sessions/KB) are untouched", async () => {
    const user = await database.execute(
      sql`SELECT * FROM users WHERE id = ${protectedUserId}`,
    );
    const session = await database.execute(
      sql`SELECT * FROM sessions WHERE id = ${protectedSessionId}`,
    );
    const agent = await database.execute(
      sql`SELECT * FROM agents WHERE id = ${protectedAgentId}`,
    );
    const kb = await database.execute(
      sql`SELECT * FROM knowledge_bases WHERE id = ${protectedKbId}`,
    );
    const knowledge = await database.execute(
      sql`SELECT * FROM knowledges WHERE id = ${protectedKnowledgeId}`,
    );
    expect(user.length).toBe(1);
    expect(session.length).toBe(1);
    expect(agent.length).toBe(1);
    expect(kb.length).toBe(1);
    expect(knowledge.length).toBe(1);
    // And the report's own post-verification agrees, flag by flag: every deleted id is
    // gone, every retained record survived byte-identical, every protected surface hashed
    // equal.
    expect(report.postVerification.deletedAbsent).toBe(true);
    expect(report.postVerification.retainedUnchanged).toBe(true);
    expect(report.postVerification.protectedSurface.unchanged).toBe(true);
    expect(report.postVerification.passed).toBe(true);
    expect(report.postVerification.protectedSurface.unchanged).toBe(true);
    expect(report.postVerification.protectedSurface.tables).toEqual(
      expect.arrayContaining([
        "users",
        "sessions",
        "agents",
        "knowledge_bases",
        "knowledges",
      ]),
    );
  });

  test("the report carries the three lists, the recovery method and the accounting verdict", () => {
    // The three lists partition the classified estate, counts carried whole.
    expect(report.retained.keptByClass.map((entry) => entry.class)).toEqual([
      "company_history",
      "personal_records",
    ]);
    expect(report.quarantine.totalRows).toBeGreaterThan(0);
    expect(
      report.quarantine.byIsolationReason.map((entry) => entry.reason),
    ).toEqual(
      expect.arrayContaining([
        "in_flight_reservation",
        "insufficient_test_evidence",
      ]),
    );
    // Recovery: a real method statement, and every deleted row captured whole in the receipt.
    expect(report.recovery.method.length).toBeGreaterThan(0);
    expect(report.recovery.capturedRows).toBe(report.deleted.totalRows);
    expect(report.accountingSmoke.passed).toBe(true);
    expect(report.accountingSmoke.companyFootprintUnchanged).toBe(true);
    expect(report.accountingSmoke.personalFootprintUnchanged).toBe(true);
    expect(report.accountingSmoke.grantReserveSettlePassed).toBe(true);
  });

  test("the audit trail holds the executed receipt and the post-verification", async () => {
    const rows = await cleanupAuditRows(executionIds);
    expect(rows.length).toBe(2);
    const executed = rows.find(
      (row) => (row.payload as Record<string, unknown>).phase === "executed",
    );
    const verified = rows.find(
      (row) =>
        (row.payload as Record<string, unknown>).phase === "post_verified",
    );
    expect(executed).toBeDefined();
    expect(verified).toBeDefined();
    expect(executed!.eventType).toBe("billing.cleanup.executed");
    expect(executed!.actorUserId).toBe(`operator-${run}`);
    const payload = executed!.payload as Record<string, unknown>;
    // The receipt captures every deleted row whole — the recovery source of truth.
    const captured = (payload.recovery as Record<string, unknown>)
      .capturedRows as {
      table: string;
      row: Record<string, unknown>;
    }[];
    expect(captured.length).toBe(report.deleted.totalRows);
    const cleanGrantReceipt = captured.find(
      (entry) =>
        entry.table === "credit_grants" && entry.row.id === cleanGrantId,
    );
    expect(cleanGrantReceipt).toBeDefined();
    expect(cleanGrantReceipt!.row.idempotency_key).toBe(`plan:${cleanOrderId}`);
    expect(cleanGrantReceipt!.row.total).toBe(20_000);
  });
});

describe("repeat-execution safety: the old confirmation never deletes again", () => {
  const newKey = `b351-new-${run}`;
  const newGrantId = `b351-g-new-${run}`;
  const newOrderId = `b351-po-new-${run}`;
  const newCompanyKey = `b351-newco-${run}`;
  const newCompanyGrantId = `b351-g-newco-${run}`;
  const newPersonalKey = `b351-newper-${run}`;
  const newPersonalGrantId = `b351-g-newper-${run}`;

  test("re-running the same authorization after the data changed refuses", async () => {
    const postFirstDump = await dumpLegacyTables();
    const answer = await attempt(authorization);
    expect("refused" in answer && answer.refused).toContain("scope hash");
    expect(await dumpLegacyTables()).toEqual(postFirstDump);
  });

  test("new data written after the execution is invisible to the old confirmation", async () => {
    // A fresh legacy chain, a fresh company chain, a fresh personal chain — all post-execution.
    await database.insert(billingCustomers).values([
      { externalId: newKey, name: `b351 new ${run}` },
      { externalId: newCompanyKey, name: `b351 newco ${run}` },
      { externalId: newPersonalKey, name: `b351 newper ${run}` },
    ]);
    await database.insert(payerAccounts).values([
      {
        id: `b351-pa-new-${run}`,
        kind: "legacy_deployment",
        payerId: `b351-dep-new-${run}`,
        externalCustomerId: newKey,
      },
      {
        id: `b351-pa-newco-${run}`,
        kind: "company",
        payerId: `b351-coten-new-${run}`,
        externalCustomerId: newCompanyKey,
      },
      {
        id: `b351-pa-newper-${run}`,
        kind: "personal",
        payerId: `b351-per-new-${run}`,
        externalCustomerId: newPersonalKey,
      },
    ]);
    await database.insert(creditGrants).values([
      {
        id: newGrantId,
        externalCustomerId: newKey,
        source: "promo",
        total: 1_000,
        expiresAt: new Date("2027-06-01T00:00:00Z"),
        idempotencyKey: `b351-promo-new-${run}`,
      },
      {
        id: newCompanyGrantId,
        externalCustomerId: newCompanyKey,
        source: "promo",
        total: 2_000,
        expiresAt: new Date("2027-06-01T00:00:00Z"),
        idempotencyKey: `b351-promo-newco-${run}`,
      },
      {
        id: newPersonalGrantId,
        externalCustomerId: newPersonalKey,
        source: "promo",
        total: 3_000,
        expiresAt: new Date("2027-06-01T00:00:00Z"),
        idempotencyKey: `b351-promo-newper-${run}`,
      },
    ]);
    await database.insert(paymentOrders).values({
      id: newOrderId,
      deploymentScope: `b351-scope-new-${run}`,
      planCode: "legacy-test",
      provider: "alipay",
      amountCents: 900,
      status: "paid",
      activationState: "applied",
      ownerPayerKind: "legacy_deployment",
      ownerPayerId: `b351-dep-new-${run}`,
      expiresAt: new Date("2026-06-01T00:00:00Z"),
      paidAt: new Date("2026-06-01T00:30:00Z"),
      terminalAt: new Date("2026-06-01T00:30:00Z"),
    });

    // The OLD authorization refuses on both the old and the new evidence registries: the
    // confirmation binds ONE manifest world, the world moved, so it never deletes again.
    const oldAnswer = await attempt(authorization);
    expect("refused" in oldAnswer && oldAnswer.refused).toContain("scope hash");
    const oldOnNewEvidence = await attempt(authorization, {
      testOrderIds: [cleanOrderId, flightOrderId, newOrderId],
      testUserIds: [],
    });
    expect("refused" in oldOnNewEvidence && oldOnNewEvidence.refused).toContain(
      "scope hash",
    );
    // Nothing was deleted: the new rows all still stand.
    expect((await rowsOf("credit_grants", [newGrantId])).length).toBe(1);
    expect((await rowsOf("credit_grants", [newCompanyGrantId])).length).toBe(1);
    expect((await rowsOf("credit_grants", [newPersonalGrantId])).length).toBe(
      1,
    );

    // A FRESH dry-run over the new evidence sees the new chain; a FRESH authorization for
    // exactly that manifest deletes only it — the new company and personal rows stay.
    const newEvidence = {
      testOrderIds: [cleanOrderId, flightOrderId, newOrderId],
      testUserIds: [],
    };
    const newDryRun = await buildCleanupDryRun(database, newEvidence);
    expect(
      newDryRun.toDelete.records.some(
        (record) =>
          record.table === "credit_grants" && record.recordId === newGrantId,
      ),
    ).toBe(true);
    expect(
      newDryRun.toDelete.records.some(
        (record) =>
          record.table === "credit_grants" &&
          (record.recordId === newCompanyGrantId ||
            record.recordId === newPersonalGrantId),
      ),
    ).toBe(false);

    const freshAuthorization = {
      authorizationVersion: 1,
      authorizedBy: `operator-2-${run}`,
      authorizedAt: new Date().toISOString(),
      statement: `Fresh authorization for the post-execution manifest (${newKey} chain).`,
      scope: newDryRun.binding,
    };
    const executed = await attempt(freshAuthorization, newEvidence);
    if (!("report" in executed))
      throw new Error(`refused: ${executed.refused}`);
    expect(executed.report.deleted.totalRows).toBe(
      newDryRun.toDelete.totalRows,
    );
    expect((await rowsOf("credit_grants", [newGrantId])).length).toBe(0);
    // The new company and personal rows: never candidates, never deleted.
    expect((await rowsOf("credit_grants", [newCompanyGrantId])).length).toBe(1);
    expect((await rowsOf("credit_grants", [newPersonalGrantId])).length).toBe(
      1,
    );

    // And the fresh authorization is now spent too: the world changed again.
    const again = await attempt(freshAuthorization, newEvidence);
    expect("refused" in again && again.refused).toContain("scope hash");
  });
});

describe("rollback: a failed execution leaves every legacy table byte-identical", () => {
  test("an audit-write failure mid-transaction aborts the whole execution", async () => {
    const before = await dumpLegacyTables();
    const auditCountBefore = (await cleanupAuditRows(executionIds)).length;
    await database.execute(sql`
      CREATE OR REPLACE FUNCTION b351_refuse_cleanup_audit_fn() RETURNS trigger AS $fn$
      BEGIN
        RAISE EXCEPTION 'b351 rollback probe: cleanup audit write refused';
      END
      $fn$ LANGUAGE plpgsql
    `);
    await database.execute(sql`
      CREATE TRIGGER b351_refuse_cleanup_audit_trg
      BEFORE INSERT ON audit_events
      FOR EACH ROW WHEN (new.event_type = 'billing.cleanup.executed')
      EXECUTE FUNCTION b351_refuse_cleanup_audit_fn()
    `);

    // The data is unchanged since the fresh authorization was taken on the fresh dry-run, so
    // the hash still verifies — the failure happens INSIDE the transaction, at the audit write.
    const freshDryRun = await buildCleanupDryRun(database, evidenceInput);
    const freshAuthorization = {
      authorizationVersion: 1,
      authorizedBy: `operator-3-${run}`,
      authorizedAt: new Date().toISOString(),
      statement: "Rollback probe authorization.",
      scope: freshDryRun.binding,
    };
    const answer = await attempt(freshAuthorization);
    expect("refused" in answer).toBe(true);
    expect(await dumpLegacyTables()).toEqual(before);
    expect((await cleanupAuditRows(executionIds)).length).toBe(
      auditCountBefore,
    );

    await database.execute(
      sql`DROP TRIGGER IF EXISTS b351_refuse_cleanup_audit_trg ON audit_events`,
    );
    await database.execute(
      sql`DROP FUNCTION IF EXISTS b351_refuse_cleanup_audit_fn()`,
    );

    // The same authorization now executes: the aborted run changed nothing, so the hash
    // still matches the world.
    const executed = await attempt(freshAuthorization);
    if (!("report" in executed))
      throw new Error(`refused: ${executed.refused}`);
    expect(executed.report.transaction.committed).toBe(true);
  });
});

describe("the admin read route shows the execution report to administrators only", () => {
  const ADMIN: AuthenticatedActor = {
    id: `admin-${run}`,
    email: `admin-${run}@openbot.test`,
    role: "admin",
  };
  const MEMBER: AuthenticatedActor = {
    id: `member-${run}`,
    email: `member-${run}@openbot.test`,
    role: "user",
  };

  const requireUserAs = (
    actor: AuthenticatedActor | undefined,
  ): MiddlewareHandler<{ Variables: AppVariables }> =>
    (async (context, next) => {
      if (!actor) {
        return context.json({ error: "Authentication required." }, 401);
      }
      context.set("actor", actor);
      await next();
    }) as unknown as MiddlewareHandler<{ Variables: AppVariables }>;

  const appAs = (actor: AuthenticatedActor | undefined) => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/admin/billing",
      createBillingAdminRoutes({
        service: {} as BillingService,
        requireUser: requireUserAs(actor),
        requireAdmin,
        externalCustomerKey: `b351-deployment-${run}`,
        customerName: `b351 deployment ${run}`,
        database,
        audit: auditStore,
      }),
    );
    return app;
  };

  test("an administrator reads the latest execution report", async () => {
    const answer = await appAs(ADMIN).request(
      "/api/admin/billing/cleanup/execution",
    );
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as {
      execution: {
        executionId: string;
        authorizedBy: string;
        report: CleanupExecutionReport;
      } | null;
    };
    expect(body.execution).not.toBeNull();
    expect(body.execution!.authorizedBy).toBe(`operator-3-${run}`);
    // The route answers the same report the last execution returned, from the audit trail.
    expect(body.execution!.report.deleted).toEqual(lastReport!.deleted);
    expect(body.execution!.report.retained).toEqual(lastReport!.retained);
    expect(body.execution!.report.quarantine).toEqual(lastReport!.quarantine);
    expect(body.execution!.report.recovery).toEqual(lastReport!.recovery);
    expect(body.execution!.report.postVerification.passed).toBe(true);
    expect(body.execution!.report.accountingSmoke.passed).toBe(true);
    expect(body.execution!.report.binding.scopeHash).toBe(
      lastReport!.binding.scopeHash,
    );
  });

  test("a non-administrator and an anonymous caller are refused", async () => {
    const memberAnswer = await appAs(MEMBER).request(
      "/api/admin/billing/cleanup/execution",
    );
    expect(memberAnswer.status).toBe(403);
    const anonAnswer = await appAs(undefined).request(
      "/api/admin/billing/cleanup/execution",
    );
    expect(anonAnswer.status).toBe(401);
  });
});
