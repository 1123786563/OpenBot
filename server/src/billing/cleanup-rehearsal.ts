import { inArray, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Database } from "../db/client";
import {
  billingCustomers,
  billingSubscriptions,
  billingWebhookEvents,
  payerAccounts,
} from "../db/schema/billing";
import {
  creditChargeRemainders,
  creditReservationAllocations,
  creditReservations,
} from "../db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../db/schema/credits";
import { paymentEvents, paymentOrders } from "../db/schema/payment";
import { usageOutbox } from "../db/schema/usage-outbox";
import {
  classifyCleanup,
  type TestEvidenceInput,
} from "./cleanup-classification";
import {
  assembleCleanupDryRunReport,
  buildCleanupDryRun,
} from "./cleanup-dry-run";
import {
  assertCleanupDeletionAllowed,
  type GUARDS_VERSION,
  guardCleanupDeletion,
} from "./cleanup-guards";
import { evaluateCleanupRelations } from "./cleanup-relations";
import { readCapacity } from "./capacity";
import { createCreditWriter } from "./credits-writer";

/*
 * The transactional cleanup and rebuild rehearsal (group 21.6). Everything upstream decides
 * or reviews; this module is the first thing that DELETES — and it does so only as a
 * rehearsal on a dedicated, isolated test database, so the authorized run (21.7) inherits a
 * proven program instead of a hopeful one. The acceptance criteria, made mechanical:
 *
 * - Transactional with full rollback (AC-a): the deletion runs in ONE `REPEATABLE READ`
 *   read-write transaction. REPEATABLE READ is load-bearing, not decoration: every read in
 *   the transaction — the freshness check, the row-count baselines — sees one snapshot, so
 *   rows another session commits mid-flight are simultaneously invisible to the deletes
 *   (they are never named) AND detectable when they would matter (the catalog's own
 *   foreign-key machinery refuses to cascade over a concurrently committed row with a
 *   serialization error — verified empirically — which aborts and rolls the run back rather
 *   than eating the new row). Any failure — a guard refusal, a drifted row, a mismatched
 *   count, an injected fault — throws inside the transaction and PostgreSQL undoes every
 *   delete.
 * - Deleted rows ≡ the reviewed dry-run scope (AC-b): the scope executed is exactly the
 *   fresh dry-run's to-delete list, re-cleared by 21.5's `guardCleanupDeletion` (the N1
 *   last-gate contract) immediately before the transaction. Inside the transaction every
 *   target row must still exist, each table's deletes must return EXACTLY the named ids,
 *   and the per-table estate count deltas must equal the deleted counts — a rogue cascade
 *   victim or a mis-scoped WHERE cannot pass silently. The executor trusts no manifest it
 *   was handed: classification, relations, dry-run and guard are all re-derived fresh.
 * - Concurrency safety (AC-c): deletes name explicit record ids, children before parents
 *   along the estate's live FK topology — never a predicate, never a reliance on CASCADE to
 *   reach scope. A record created mid-flight has an id the scope never named, so it is
 *   structurally undeletable by this program; the one way a mid-flight row could still be
 *   reached (a child inserted under a parent the scope deletes) is the foreign-key
 *   refusal-and-rollback above, which is the protection working, not failing. `dumpCleanupEstate`
 *   before/after comparisons and the `onTableDeleted` observation seam (the drill's failure
 *   injection point) make both halves provable in tests.
 * - The new accounting system still works (AC-d): after a committed run,
 *   `runAccountingSmoke` exercises the surviving personal account and any freshly rebuilt
 *   one through the full grant → reserve → settle cycle on the same database, refusing to
 *   call the rehearsal successful if the ledger arithmetic comes back insane.
 *
 * Write discipline: the program deletes ONLY the twelve legacy billing tables' guarded rows.
 * Users, bots, sessions, knowledge-base objects and every other application table are outside
 * its vocabulary entirely (21.5's estate wall). `runCleanupRehearsal` chains the drills into
 * one reviewable rehearsal report (rollback verification, deletion counts, retention counts,
 * post-state verification, accounting smoke) for 21.7 to consume.
 */

/** The rehearsal contract version; bumped when the report shape or the execution semantics change. */
export const REHEARSAL_VERSION = 1;

/**
 * The estate tables in the execution's fixed CHILDREN-FIRST order: every table is deleted
 * before any table that can cascade into it, and before its SET NULL parents acquire
 * dangling referencing rows. This order is checked against the LIVE catalog every run —
 * 21.3's relation evaluation and 21.5's guard re-derive the graph and would pull (or
 * refuse) any candidate whose deletion violates it — and the count-delta check inside the
 * transaction catches a row that left by any door other than its own named delete.
 */
const ESTATE_DELETION_ORDER = [
  { table: "usage_outbox", pg: usageOutbox, idField: "eventId" },
  { table: "billing_webhook_events", pg: billingWebhookEvents, idField: "eventId" },
  { table: "payment_events", pg: paymentEvents, idField: "id" },
  { table: "payment_orders", pg: paymentOrders, idField: "id" },
  { table: "credit_reservation_allocations", pg: creditReservationAllocations, idField: "id" },
  { table: "credit_reservations", pg: creditReservations, idField: "id" },
  { table: "credit_charge_remainders", pg: creditChargeRemainders, idField: "externalCustomerId" },
  { table: "credit_ledger", pg: creditLedger, idField: "id" },
  { table: "credit_grants", pg: creditGrants, idField: "id" },
  { table: "billing_subscriptions", pg: billingSubscriptions, idField: "externalSubscriptionId" },
  { table: "payer_accounts", pg: payerAccounts, idField: "id" },
  { table: "billing_customers", pg: billingCustomers, idField: "externalId" },
] as const;

type EstateSpec = (typeof ESTATE_DELETION_ORDER)[number];

/** The id column of an estate spec, resolved once from the drizzle table object. */
function idColumnOf(spec: EstateSpec): PgColumn {
  const column = (spec.pg as unknown as Record<string, PgColumn>)[spec.idField];
  if (!column) {
    throw new Error(
      `estate table ${spec.table} has no id field ${spec.idField}: the deletion order and the schema have drifted`,
    );
  }
  return column;
}

/** One completed table step inside the cleanup transaction, handed to the observation seam. */
export type CleanupRehearsalStep = {
  table: string;
  /** Rows this step deleted — always exactly the scope's ids for this table. */
  deleted: number;
  /** Rows deleted so far in this transaction. */
  cumulative: number;
};

/** Options of `executeTransactionalCleanup`; the hook is the rehearsal's observation seam. */
export type CleanupExecutionOptions = {
  /**
   * Called after each NON-EMPTY table step, INSIDE the cleanup transaction (its failure
   * rolls everything back — the rollback drill's injection point). Long-running work here
   * stalls the transaction; work on OTHER connections (the concurrency drill's mid-flight
   * inserts) may run concurrently but MUST NOT be awaited from a connection the caller
   * needs during the transaction beyond the hook's own return.
   */
  onTableDeleted?: (step: CleanupRehearsalStep) => void | Promise<void>;
};

/** What a committed (or refuted) execution reports — the verifiable deletion record. */
export type CleanupExecutionReport = {
  rehearsalVersion: typeof REHEARSAL_VERSION;
  /** `current_database()` and schema of the database the deletion ran on. */
  database: string;
  schema: string;
  generatedAt: string;
  basis: {
    /** The fresh dry-run scope hash this execution's deletes are bound to. */
    dryRunScopeHash: string;
    guardsVersion: typeof GUARDS_VERSION;
    classificationEvidenceSha256: string;
    /** Guard refusals among the dry-run scope — always 0: a refusal aborts the run. */
    guardRefused: number;
  };
  execution: {
    isolationLevel: "repeatable_read";
    /** Non-empty table steps completed. */
    steps: number;
    deletedTotal: number;
    deletedByTable: { table: string; rows: number }[];
    /** True: the ids physically returned by the deletes ≡ the scope's ids, per table. */
    deletedIdsMatchScope: boolean;
  };
  /** The dry-run's three lists, carried for the reviewer's cross-check. */
  scope: {
    toDeleteTotalRows: number;
    toRetainTotalRows: number;
    quarantineTotalRows: number;
    /** The executed scope's ids per table — what "deleted" must mean, verifiably. */
    idsByTable: Record<string, string[]>;
  };
};

/** One estate table's full row dump, deterministically ordered by its id. */
export type EstateDumpEntry = {
  table: string;
  /** The TS property name of the table's record id inside each dumped row. */
  idField: string;
  rows: Record<string, unknown>[];
};

export type EstateDump = EstateDumpEntry[];

/**
 * The whole legacy estate, table by table, inside one `REPEATABLE READ, READ ONLY` snapshot
 * so a dump is a consistent moment. JSON-stringified dumps are the rollback drill's
 * byte-equality instrument (timestamps serialize as ISO; ordering is by record id).
 */
export async function dumpCleanupEstate(database: Database): Promise<EstateDump> {
  return database.transaction(async (tx) => {
    await tx.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
    );
    const dump: EstateDump = [];
    for (const spec of ESTATE_DELETION_ORDER) {
      const rows = await tx
        .select()
        .from(spec.pg)
        .orderBy(idColumnOf(spec));
      dump.push({
        table: spec.table,
        idField: spec.idField,
        rows: rows as Record<string, unknown>[],
      });
    }
    return dump;
  });
}

/** Every (table/id) pair a dump contains, as `table/id` strings. */
export function dumpRecordIds(dump: EstateDump): Set<string> {
  const ids = new Set<string>();
  for (const entry of dump) {
    for (const row of entry.rows) {
      ids.add(`${entry.table}/${String(row[entry.idField])}`);
    }
  }
  return ids;
}

/**
 * Execute the reviewed cleanup scope in ONE transaction: re-derive classification,
 * relations, dry-run and the 21.5 guard fresh (no handed manifest is trusted), then delete
 * exactly the cleared rows, children first, with in-transaction freshness, id-identity and
 * count-delta verification. Any mismatch throws BEFORE the transaction commits, and
 * PostgreSQL rolls every delete back.
 */
export async function executeTransactionalCleanup(
  database: Database,
  evidence: TestEvidenceInput,
  options: CleanupExecutionOptions = {},
): Promise<CleanupExecutionReport> {
  // --- Phase A (read-only fences): the fresh manifests and the last gate. The executed
  // scope is the dry-run's to-delete list; the guard re-derives everything itself and must
  // clear every row of it or the run ends here, having deleted nothing.
  const classification = await classifyCleanup(database, evidence);
  const relations = await evaluateCleanupRelations(database, classification);
  const dryRun = assembleCleanupDryRunReport(classification, relations);
  const guardReport = await guardCleanupDeletion(database, evidence, {
    targets: dryRun.toDelete.records.map((record) => ({
      table: record.table,
      recordId: record.recordId,
    })),
  });
  assertCleanupDeletionAllowed(guardReport);

  const idsByTable = new Map<string, string[]>();
  for (const deletable of guardReport.deletable) {
    const ids = idsByTable.get(deletable.table) ?? [];
    ids.push(deletable.recordId);
    idsByTable.set(deletable.table, ids);
  }
  const scopeIdsByTable: Record<string, string[]> = {};
  for (const [table, ids] of idsByTable) {
    scopeIdsByTable[table] = [...ids].sort();
  }

  // --- Phase B: the one read-write transaction.
  return database.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    const identity = await tx.execute<{ database: string; schema: string }>(
      sql`SELECT current_database() AS database, current_schema() AS schema`,
    );

    // Freshness: every scoped row must still exist in THIS snapshot. A row the pre-flight
    // manifests named but the transaction cannot see is drift — refuse, roll back, let the
    // caller re-derive.
    for (const spec of ESTATE_DELETION_ORDER) {
      const ids = idsByTable.get(spec.table);
      if (!ids || ids.length === 0) continue;
      const column = idColumnOf(spec);
      const found = await tx
        .select({ id: column })
        .from(spec.pg)
        .where(inArray(column, ids));
      const foundIds = new Set(found.map((row) => String(row.id)));
      const missing = ids.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new Error(
          `cleanup scope drifted before execution: ${spec.table} no longer contains [${missing.join(", ")}] — re-derive the manifests and the guard instead of deleting a stale scope`,
        );
      }
    }

    // Snapshot row counts per estate table: the baseline the count-delta detector closes over.
    // `count(*)` is bigint and read as a string: the delta discipline never casts through int32.
    const estateCount = async () => {
      const counts = new Map<string, bigint>();
      for (const spec of ESTATE_DELETION_ORDER) {
        const [row] = await tx
          .select({ n: sql<string>`count(*)` })
          .from(spec.pg);
        counts.set(spec.table, BigInt(row.n));
      }
      return counts;
    };
    const beforeCounts = await estateCount();

    // The deletes: children first, explicit ids only, one step per table, observed.
    const deletedByTable: { table: string; rows: number }[] = [];
    let cumulative = 0;
    let steps = 0;
    for (const spec of ESTATE_DELETION_ORDER) {
      const ids = idsByTable.get(spec.table);
      if (!ids || ids.length === 0) continue;
      const column = idColumnOf(spec);
      const deletedRows = await tx
        .delete(spec.pg)
        .where(inArray(column, ids))
        .returning({ id: column });
      const deletedIds = deletedRows.map((row) => String(row.id)).sort();
      const expectedIds = [...ids].sort();
      const identical =
        deletedIds.length === expectedIds.length &&
        deletedIds.every((id, index) => id === expectedIds[index]);
      if (!identical) {
        throw new Error(
          `cleanup delete for ${spec.table} returned ${deletedIds.length} row(s) but the scope names ${expectedIds.length}: the executed deletion no longer matches the reviewed scope — rolling back`,
        );
      }
      cumulative += deletedRows.length;
      steps += 1;
      deletedByTable.push({ table: spec.table, rows: deletedRows.length });
      const step: CleanupRehearsalStep = {
        table: spec.table,
        deleted: deletedRows.length,
        cumulative,
      };
      if (step.deleted > 0) await options.onTableDeleted?.(step);
    }

    // Count-delta detector: each estate table must have lost exactly its named rows — no
    // more (a rogue cascade reached an unnamed row), no fewer (an unnamed door deleted them).
    const afterCounts = await estateCount();
    for (const spec of ESTATE_DELETION_ORDER) {
      const deleted = BigInt(
        deletedByTable.find((e) => e.table === spec.table)?.rows ?? 0,
      );
      const delta = (beforeCounts.get(spec.table) ?? 0n) - (afterCounts.get(spec.table) ?? 0n);
      if (delta !== BigInt(deleted)) {
        throw new Error(
          `estate count delta for ${spec.table} is ${delta} but the scope deleted ${deleted}: rows left the estate by an unnamed door — rolling back`,
        );
      }
    }

    // Reconciliation with the reviewed dry-run, per table and in total.
    const dryRunByTable = new Map(
      dryRun.toDelete.byTable.map((group) => [group.table, group.rows]),
    );
    for (const [table, rows] of dryRunByTable) {
      const actual = deletedByTable.find((e) => e.table === table)?.rows ?? 0;
      if (actual !== rows) {
        throw new Error(
          `committed deletes for ${table} (${actual}) do not match the dry-run report (${rows}) — rolling back`,
        );
      }
    }
    if (cumulative !== dryRun.toDelete.totalRows) {
      throw new Error(
        `committed deletes total ${cumulative} but the dry-run report names ${dryRun.toDelete.totalRows} — rolling back`,
      );
    }

    return {
      rehearsalVersion: REHEARSAL_VERSION,
      database: identity[0].database,
      schema: identity[0].schema,
      generatedAt: new Date().toISOString(),
      basis: {
        dryRunScopeHash: dryRun.binding.scopeHash,
        guardsVersion: guardReport.guardsVersion,
        classificationEvidenceSha256: classification.evidenceInput.sha256,
        guardRefused: guardReport.refused.length,
      },
      execution: {
        isolationLevel: "repeatable_read",
        steps,
        deletedTotal: cumulative,
        deletedByTable,
        deletedIdsMatchScope: true,
      },
      scope: {
        toDeleteTotalRows: dryRun.toDelete.totalRows,
        toRetainTotalRows: dryRun.toRetain.totalRows,
        quarantineTotalRows: dryRun.quarantine.totalRows,
        idsByTable: scopeIdsByTable,
      },
    };
  });
}

/** The rollback drill's verdict: did the injected failure roll the estate back completely. */
export type RollbackRehearsalReport = {
  /** The estate dump after the failed run is byte-identical to the one before it. */
  rolledBackCompletely: boolean;
  /** The table step after which the fault was injected. */
  injectedFailureAfterTable: string;
  /** Non-empty steps completed before the fault fired. */
  stepsCompletedBeforeFailure: number;
  /** Estate tables the byte-comparison covered. */
  estateTablesChecked: number;
  /** The injected error's message, for the report trail. */
  injectedError: string;
};

/**
 * The rollback drill (AC-a): run a real execution with a fault injected after a real table
 * step, then prove the whole legacy estate is byte-identical to its pre-run state. A drill
 * whose execution does NOT fail is a failed drill — there was nothing to roll back.
 */
export async function rehearseCleanupRollback(
  database: Database,
  evidence: TestEvidenceInput,
  drill: { failAfterTable?: string } = {},
): Promise<RollbackRehearsalReport> {
  const before = await dumpCleanupEstate(database);
  let stepsCompletedBeforeFailure = 0;
  let injectedAfter: string | null = null;
  let injectedError: string | null = null;
  try {
    await executeTransactionalCleanup(database, evidence, {
      onTableDeleted: (step) => {
        stepsCompletedBeforeFailure += 1;
        if (drill.failAfterTable === undefined || step.table === drill.failAfterTable) {
          injectedAfter = step.table;
          throw new Error(
            `rehearsal-injected failure after ${step.table} (${step.deleted} row(s), ${step.cumulative} cumulative)`,
          );
        }
      },
    });
  } catch (error) {
    injectedError = error instanceof Error ? error.message : String(error);
  }
  if (injectedAfter === null || injectedError === null) {
    throw new Error(
      "rollback drill did not fail: the execution completed, so there was no rollback to verify — check the drill's failAfterTable against the derived scope",
    );
  }
  const after = await dumpCleanupEstate(database);
  const identical = JSON.stringify(before) === JSON.stringify(after);
  if (!identical) {
    throw new Error(
      "rollback drill FAILED: the legacy estate changed across a failed cleanup — the transaction did not roll back completely",
    );
  }
  return {
    rolledBackCompletely: true,
    injectedFailureAfterTable: injectedAfter,
    stepsCompletedBeforeFailure,
    estateTablesChecked: before.length,
    injectedError,
  };
}

/** One account's grant → reserve → settle smoke result, with the sanity gates applied. */
export type AccountingSmokeResult = {
  externalCustomerId: string;
  grantedCents: number;
  availableBeforeCents: number;
  availableAfterCents: number;
  /** The owed-fraction unit penalty before and after the settle (capacity accounting). */
  owedUnitBefore: number;
  owedUnitAfter: number;
  reservedCents: number;
  reservationId: string;
  chargedCents: number;
  appliedCents: number;
  releasedCents: number;
};

/**
 * The rebuild smoke (AC-d): prove the NEW accounting system works on this database right
 * now — one full grant → reserve → settle cycle through the production writer. Every gate
 * throws rather than passing: a smoke that cannot show its arithmetic is no smoke.
 */
export async function runAccountingSmoke(
  database: Database,
  externalCustomerId: string,
  options: { grantCents?: number; reserveCents?: number; idempotencyPrefix?: string } = {},
): Promise<AccountingSmokeResult> {
  const writer = createCreditWriter(database);
  const grantCents = options.grantCents ?? 10_000;
  const reserveCents = options.reserveCents ?? 3_000;
  const prefix =
    options.idempotencyPrefix ?? `cleanup-rehearsal-smoke:${externalCustomerId}`;
  const expiresAt = new Date("2030-01-01T00:00:00Z");

  await writer.grantCredits({
    externalCustomerId,
    source: "promo",
    totalCents: grantCents,
    expiresAt,
    reason: "cleanup rehearsal smoke grant",
    idempotencyKey: `${prefix}:grant`,
  });
  const availableBeforeCents = await writer.availableBalance(externalCustomerId);
  const owedUnitBefore = (await readCapacity(database, externalCustomerId)).owedUnit;
  const reserved = await writer.reserveCredits({
    externalCustomerId,
    idempotencyKey: `${prefix}:reserve`,
    maximumCents: reserveCents,
    expiresAt,
  });
  if (!reserved.reserved) {
    throw new Error(
      `accounting smoke: reserve was refused for ${externalCustomerId} (available ${reserved.availableCents}) — the new accounting system is not serving holds`,
    );
  }
  const settled = await writer.settleReservation({
    reservationId: reserved.reservationId,
    actual: { numerator: 1234n, denominator: 100n },
    title: "cleanup rehearsal smoke settle",
  });
  const availableAfterCents = await writer.availableBalance(externalCustomerId);
  // The owed fraction keeps counting against capacity (one unit while owed), so the balance
  // moves by the applied charge PLUS any change in the owed-unit status across the settle.
  const owedUnitAfter = settled.remainder.numerator > 0n ? 1 : 0;

  if (settled.appliedCents <= 0 || settled.appliedCents > reserveCents) {
    throw new Error(
      `accounting smoke: applied ${settled.appliedCents} outside (0, ${reserveCents}] for ${externalCustomerId}`,
    );
  }
  if (settled.releasedCents !== reserveCents - settled.appliedCents) {
    throw new Error(
      `accounting smoke: released ${settled.releasedCents} != held ${reserveCents} - applied ${settled.appliedCents} for ${externalCustomerId}`,
    );
  }
  if (
    availableBeforeCents - availableAfterCents !==
    settled.appliedCents + (owedUnitAfter - owedUnitBefore)
  ) {
    throw new Error(
      `accounting smoke: balance moved ${availableBeforeCents - availableAfterCents} but applied was ${settled.appliedCents} for ${externalCustomerId}`,
    );
  }

  return {
    externalCustomerId,
    grantedCents: grantCents,
    availableBeforeCents,
    availableAfterCents,
    owedUnitBefore,
    owedUnitAfter,
    reservedCents: reserveCents,
    reservationId: reserved.reservationId,
    chargedCents: settled.chargedCents,
    appliedCents: settled.appliedCents,
    releasedCents: settled.releasedCents,
  };
}

/** The post-execution verification the full rehearsal reports. */
export type RehearsalPostVerification = {
  /** Every executed scope row is gone from the live data. */
  scopeRowsRemoved: boolean;
  /** Every row present before the run and outside the scope is present and identical after. */
  keptRowsUntouched: boolean;
  /** Rows that appeared during the run and survived outside the scope (concurrent writers). */
  concurrentRowsSurviving: number;
  /** A fresh dry-run after the rehearsal: the candidates that still exist (0 when done). */
  freshCandidatesRemaining: number;
  /** A second execution right after: a committed no-op (0 deletes) proves re-runnability. */
  rerunDeletedTotal: number;
};

/** The full rehearsal report `runCleanupRehearsal` produces for review (and for 21.7). */
export type CleanupRehearsalReport = {
  rehearsalVersion: typeof REHEARSAL_VERSION;
  database: string;
  schema: string;
  generatedAt: string;
  rollback: RollbackRehearsalReport;
  execution: CleanupExecutionReport["execution"] & {
    basis: CleanupExecutionReport["basis"];
    scope: CleanupExecutionReport["scope"];
  };
  postVerification: RehearsalPostVerification;
  accountingSmoke: AccountingSmokeResult[];
};

export type CleanupRehearsalOptions = CleanupExecutionOptions & {
  /** Which table step the rollback drill's fault fires after (default: the first step). */
  failAfterTable?: string;
  /** Accounts the rebuild smoke runs on after the committed execution (in order). */
  smokeKeys?: string[];
};

/**
 * The full rehearsal on a dedicated test database: rollback drill → real transactional
 * execution (with the caller's optional mid-flight hook for concurrency drills) → post-state
 * verification (scope removed, kept rows untouched, fresh candidates zero, no-op rerun) →
 * accounting smoke on the named accounts. Every stage throws on failure; the returned report
 * is the reviewable evidence (deletion counts, retention counts, rollback verification,
 * accounting results) 21.7 builds on.
 */
export async function runCleanupRehearsal(
  database: Database,
  evidence: TestEvidenceInput,
  options: CleanupRehearsalOptions = {},
): Promise<CleanupRehearsalReport> {
  const rollback = await rehearseCleanupRollback(database, evidence, {
    failAfterTable: options.failAfterTable,
  });

  const before = await dumpCleanupEstate(database);
  const execution = await executeTransactionalCleanup(database, evidence, {
    onTableDeleted: options.onTableDeleted,
  });
  const after = await dumpCleanupEstate(database);

  // Post-state verification against the executed scope's own ids.
  const scopeKeys = new Set<string>();
  for (const [table, ids] of Object.entries(execution.scope.idsByTable)) {
    for (const id of ids) scopeKeys.add(`${table}/${id}`);
  }
  const beforeRows = new Map<string, string>();
  for (const entry of before) {
    for (const row of entry.rows) {
      beforeRows.set(
        `${entry.table}/${String(row[entry.idField])}`,
        JSON.stringify(row),
      );
    }
  }
  const afterRows = new Map<string, string>();
  for (const entry of after) {
    for (const row of entry.rows) {
      afterRows.set(
        `${entry.table}/${String(row[entry.idField])}`,
        JSON.stringify(row),
      );
    }
  }
  let scopeRowsRemoved = true;
  for (const key of scopeKeys) {
    if (afterRows.has(key)) scopeRowsRemoved = false;
  }
  let keptRowsUntouched = true;
  for (const [key, json] of beforeRows) {
    if (scopeKeys.has(key)) continue;
    if (afterRows.get(key) !== json) keptRowsUntouched = false;
  }
  let concurrentRowsSurviving = 0;
  for (const key of afterRows.keys()) {
    if (!beforeRows.has(key) && !scopeKeys.has(key)) concurrentRowsSurviving += 1;
  }
  if (!scopeRowsRemoved) {
    throw new Error(
      "rehearsal post-verification failed: scoped rows survive the committed execution",
    );
  }
  if (!keptRowsUntouched) {
    throw new Error(
      "rehearsal post-verification failed: a kept row changed or vanished across the committed execution",
    );
  }

  const fresh = await buildCleanupDryRun(database, evidence);
  const rerun = await executeTransactionalCleanup(database, evidence);
  if (rerun.execution.deletedTotal !== 0) {
    throw new Error(
      `rehearsal rerun deleted ${rerun.execution.deletedTotal} row(s): the estate still holds deletable candidates the first run should have removed`,
    );
  }

  const accountingSmoke: AccountingSmokeResult[] = [];
  for (const key of options.smokeKeys ?? []) {
    accountingSmoke.push(
      await runAccountingSmoke(database, key, {
        idempotencyPrefix: `cleanup-rehearsal-smoke:${key}`,
      }),
    );
  }

  return {
    rehearsalVersion: REHEARSAL_VERSION,
    database: fresh.database,
    schema: fresh.schema,
    generatedAt: new Date().toISOString(),
    rollback,
    execution: {
      ...execution.execution,
      basis: execution.basis,
      scope: execution.scope,
    },
    postVerification: {
      scopeRowsRemoved,
      keptRowsUntouched,
      concurrentRowsSurviving,
      freshCandidatesRemaining: fresh.toDelete.totalRows,
      rerunDeletedTotal: rerun.execution.deletedTotal,
    },
    accountingSmoke,
  };
}

if (import.meta.main) {
  // Operator entry: `bun server/src/billing/cleanup-rehearsal.ts [smokeKey ...]` runs the
  // full rehearsal against the DEDICATED TEST DATABASE `TEST_DATABASE_URL` names and prints
  // the report. The entry refuses to fall back to DATABASE_URL: the rehearsal deletes rows,
  // and a rehearsal pointed at a deployment database by accident is not a rehearsal. No
  // migration is applied here; the target database must already be at the workspace's
  // migration chain.
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "TEST_DATABASE_URL must point at a dedicated, disposable test database for the cleanup rehearsal. DATABASE_URL is deliberately ignored here.",
    );
  }
  const smokeKeys = process.argv.slice(2);
  const { createDatabase } = await import("../db/client");
  const databaseInstance = createDatabase(databaseUrl);
  try {
    const evidence: TestEvidenceInput = { testOrderIds: [], testUserIds: [] };
    const report = await runCleanupRehearsal(databaseInstance, evidence, {
      smokeKeys,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await databaseInstance.$client.end();
  }
}
