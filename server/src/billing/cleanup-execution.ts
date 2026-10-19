import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { redactAuditPayload } from "../audit";
import type { Database } from "../db/client";
import { auditEvents } from "../db/schema";
import {
  assembleCleanupDryRunReport,
  verifyCleanupScopeConfirmation,
  MANIFEST_VERSIONS,
  type CleanupDryRunReport,
  type CleanupScopeConfirmationInput,
  type CleanupScopeBinding,
  type ManifestVersions,
} from "./cleanup-dry-run";
import {
  assertCleanupDeletionAllowed,
  ESTATE_ID_COLUMNS,
  guardCleanupDeletion,
  GUARDS_VERSION,
  type CleanupDeletionGuardReport,
} from "./cleanup-guards";
import {
  CLEANUP_ESTATE_TABLES,
  classifyCleanup,
  IN_FLIGHT_RESERVATION_STATUSES,
  type CleanupClassification,
  type TestEvidenceInput,
} from "./cleanup-classification";
import { evaluateCleanupRelations } from "./cleanup-relations";
import { createCreditWriter } from "./credits-writer";

/*
 * The controlled execution of the legacy billing cleanup (group 21.7) — the door every
 * previous group prepared for and none opened. 21.1 enumerated the estate, 21.2 classified
 * it, 21.3 evaluated what deleting candidates would reach, 21.4 bound that verdict into a
 * content hash an administrator can confirm, and 21.5 walled the deletions themselves. This
 * module is where a confirmed scope finally deletes rows, under three conditions that must
 * ALL hold — the ticket's three factors, checked fail-closed, in the open:
 *
 * 1. The manifest version: the authorization's recorded manifest versions must equal the
 *    current ones. A bumped contract invalidates every confirmation ever taken.
 * 2. The dry-run scope hash: the authorization's scopeHash must equal a FRESHLY re-derived
 *    hash of the full manifests, read at execution time. A confirmation binds content, not a
 *    moment — one changed row (even an unsampled one), one registry edit, one foreign
 *    database, and the old confirmation is spent: it refuses forever after, so a repeated
 *    run and new data written between runs can never ride an old yes.
 * 3. The authorization record itself: a named authorizer, a parseable instant, the
 *    authorization's own words, and the scope binding. The resume hint's rule is enforced
 *    here in code: without an explicit, current authorization this module refuses before it
 *    reads a single row's fate, and a refusal never deletes anything.
 *
 * The execution is one REPEATABLE READ transaction: inside it, the in-flight universe
 * (reserved|unknown holds and their allocations — 06.8's never-release-evidence rows) is
 * re-read and compared against the guard's, every target's existence is re-confirmed, the
 * estate's own foreign keys order the deletions children-first, each target row is captured
 * WHOLE before it is deleted (the recovery source of truth), and the audit receipt is
 * written in the same transaction — committed together with the deletions or not at all,
 * so the trail never describes a deletion that did not happen and a rollback erases both.
 * After the commit, the post-verification re-derives the classification and re-hashes the
 * protected surfaces (company history, personal records, the unknown_owner quarantine, and
 * the application objects — users, sessions, agents),
 * and the accounting smoke proves the old balances moved nowhere (company and personal
 * credit footprints byte-identical) while the new credit system still grants, reserves and
 * settles. Its verdict rides a second audit row, appended, never rewritten.
 */

/** The execution report contract version; recorded in every report and receipt. */
export const CLEANUP_EXECUTION_VERSION = 1;

/**
 * The protected application surfaces, hashed before and after execution (AC: company
 * history and the users/Bots/sessions objects are unchanged). Absent tables
 * are named in the report rather than silently
 * skipped, and everything outside the estate is unreachable by construction — 21.5's wall 1
 * refuses any target the estate does not name — so the hash is proof, not decoration.
 */
const PROTECTED_TABLES = [
  "users",
  "sessions",
  "agents",
] as const;

/** The audit event type this program writes; one row per phase, keyed by execution id. */
export const CLEANUP_AUDIT_EVENT_TYPE = "billing.cleanup.executed";

/** The loose shape a caller hands in; parsing fails closed on every missing field. */
export type CleanupAuthorizationInput = {
  authorizationVersion?: unknown;
  authorizedBy?: unknown;
  authorizedAt?: unknown;
  statement?: unknown;
  scope?: unknown;
};

/** The parsed authorization record the execution acts on. */
export type CleanupAuthorization = {
  authorizationVersion: 1;
  authorizedBy: string;
  authorizedAt: string;
  statement: string;
  scope: CleanupScopeConfirmationInput;
};

/** Why the execution refused; every reason is a reviewable sentence, never a bare code. */
export class CleanupExecutionRefusedError extends Error {
  /** Each refused factor, spelled out. */
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(
      `cleanup execution refused: ${reasons.join(" | ")} — nothing was deleted`,
    );
    this.name = "CleanupExecutionRefusedError";
    this.reasons = reasons;
  }
}

/**
 * Parse the authorization record, refusing on every missing or malformed field BEFORE any
 * data is read. The three-factor gate's third factor: an execution without a named
 * authorizer, a moment, the authorization's own words and the scope binding does not run.
 */
export function parseCleanupAuthorization(
  input: CleanupAuthorizationInput,
): CleanupAuthorization {
  const reasons: string[] = [];
  const record =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : undefined;
  if (!record) {
    throw new CleanupExecutionRefusedError([
      "authorization missing: the execution was invoked without an authorization record — the legacy billing cleanup never runs unauthenticated (pass the administrator's signed authorization JSON)",
    ]);
  }
  if (record.authorizationVersion !== 1) {
    reasons.push(
      `authorization version mismatch: the record declares ${JSON.stringify(record.authorizationVersion)}, this program executes version 1 only`,
    );
  }
  if (
    typeof record.authorizedBy !== "string" ||
    record.authorizedBy.trim() === ""
  ) {
    reasons.push(
      "authorization incomplete: authorizedBy must name the person who authorized this execution — an unnamed yes is no yes",
    );
  }
  if (
    typeof record.authorizedAt !== "string" ||
    Number.isNaN(new Date(record.authorizedAt).getTime())
  ) {
    reasons.push(
      "authorization incomplete: authorizedAt must be the ISO instant the authorization was given",
    );
  }
  if (typeof record.statement !== "string" || record.statement.trim() === "") {
    reasons.push(
      "authorization incomplete: statement must carry the authorization's own words — what was authorized, in the authorizer's terms",
    );
  }
  if (
    typeof record.scope !== "object" ||
    record.scope === null ||
    Array.isArray(record.scope)
  ) {
    reasons.push(
      "authorization incomplete: the scope binding (scope) is missing — the confirmation taken on the reviewed dry-run must travel with the authorization",
    );
  }
  if (reasons.length > 0) throw new CleanupExecutionRefusedError(reasons);
  return {
    authorizationVersion: 1,
    authorizedBy: record.authorizedBy as string,
    authorizedAt: record.authorizedAt as string,
    statement: record.statement as string,
    scope: record.scope as CleanupScopeConfirmationInput,
  };
}

/** One deleted-table entry: the table, how many rows, and which identities. */
export type ExecutionDeletedByTable = {
  table: string;
  rows: number;
  recordIds: string[];
};

/** One captured row: its table and the whole row as it stood just before deletion. */
export type CapturedRow = { table: string; row: Record<string, unknown> };

/** The post-commit verification's verdict. */
export type ExecutionPostVerification = {
  passed: boolean;
  deletedAbsent: boolean;
  retainedUnchanged: boolean;
  protectedSurface: {
    /** The protected tables hashed in this deployment (absent modules named in `absent`). */
    tables: string[];
    /** Protected tables this deployment does not have; named, never silently skipped. */
    absent: string[];
    unchanged: boolean;
  };
};

/** The accounting smoke's verdict (AC: old balances move nowhere; the new system works). */
export type ExecutionAccountingSmoke = {
  passed: boolean;
  companyFootprintUnchanged: boolean;
  personalFootprintUnchanged: boolean;
  grantReserveSettlePassed: boolean;
};

/** The admin-viewable execution report. */
export type CleanupExecutionReport = {
  executionVersion: typeof CLEANUP_EXECUTION_VERSION;
  executionId: string;
  executedAt: string;
  database: string;
  schema: string;
  authorization: {
    authorizedBy: string;
    authorizedAt: string;
    statement: string;
  };
  /** The scope binding the execution verified and acted under (the authorization's twin). */
  binding: CleanupScopeBinding;
  guardsVersion: typeof GUARDS_VERSION;
  manifestVersions: ManifestVersions;
  evidenceInput: TestEvidenceInput & { sha256: string };
  deleted: { totalRows: number; byTable: ExecutionDeletedByTable[] };
  retained: CleanupDryRunReport["toRetain"];
  quarantine: CleanupDryRunReport["quarantine"];
  /** The in-flight rows this execution found and left standing. */
  inFlight: CleanupDeletionGuardReport["inFlight"];
  /** How a deleted record can be recovered, and how many rows the receipt holds. */
  recovery: { method: string; capturedRows: number };
  transaction: {
    committed: boolean;
    deletedRows: number;
    auditReceiptWritten: boolean;
  };
  postVerification: ExecutionPostVerification;
  accountingSmoke: ExecutionAccountingSmoke;
};

/** Deterministic JSON: keys sorted recursively (the dry-run's canonical form). */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The one database operation the in-transaction helpers need: raw SQL execution. */
type SqlExecutor = { execute: Database["execute"] };

/** Reads rows as plain JSON objects (dates ISO-normalized), ordered by the first column. */
async function readRowsJson(
  database: Database,
  query: Parameters<Database["execute"]>[0],
): Promise<Record<string, unknown>[]> {
  const rows = await database.execute(query);
  return JSON.parse(JSON.stringify(rows));
}

/** sha256 over the canonical JSON of any value — the protected surfaces' invariance proof. */
function hashValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function hashRows(rows: Record<string, unknown>[]): string {
  return hashValue(rows);
}

/** Which of the named protected tables exist in this deployment's schema. */
async function existingProtectedTables(
  database: Database,
): Promise<{ present: string[]; absent: string[] }> {
  const rows = await database.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = ANY(${sql.raw(`ARRAY[${PROTECTED_TABLES.map((t) => `'${t}'`).join(",")}]`)})
  `);
  const present = new Set(rows.map((row) => row.table_name));
  return {
    present: PROTECTED_TABLES.filter((table) => present.has(table)),
    absent: PROTECTED_TABLES.filter((table) => !present.has(table)),
  };
}

/** Full dump of one table, ordered by its first column, JSON-normalized. */
async function dumpTable(
  database: Database,
  table: string,
): Promise<Record<string, unknown>[]> {
  return readRowsJson(
    database,
    sql.raw(`SELECT * FROM ${table} ORDER BY 1`),
  );
}

/** The in-flight universe under one handle: every reserved|unknown hold and its allocations. */
async function readInFlightSet(
  exec: SqlExecutor,
): Promise<CleanupDeletionGuardReport["inFlight"]> {
  const statusArray = sql.raw(
    `ARRAY[${IN_FLIGHT_RESERVATION_STATUSES.map((status) => `'${status}'`).join(",")}]`,
  );
  const reservationRows = await exec.execute<{
    id: string;
    status: string;
    external_customer_id: string | null;
  }>(sql`
    SELECT id, status, external_customer_id
    FROM credit_reservations
    WHERE status = ANY(${statusArray})
    ORDER BY id
  `);
  const allocationRows = await exec.execute<{
    id: string;
    reservation_id: string;
  }>(sql`
    SELECT a.id, a.reservation_id
    FROM credit_reservation_allocations a
    JOIN credit_reservations r ON r.id = a.reservation_id
    WHERE r.status = ANY(${statusArray})
    ORDER BY a.id
  `);
  return {
    reservations: reservationRows.map((row) => ({
      reservationId: row.id,
      status: row.status,
      externalCustomerId: row.external_customer_id,
    })),
    allocations: allocationRows.map((row) => ({
      allocationId: row.id,
      reservationId: row.reservation_id,
    })),
  };
}

/** Set identity of two in-flight universes, order-insensitive, field-exact. */
function inFlightSetsEqual(
  a: CleanupDeletionGuardReport["inFlight"],
  b: CleanupDeletionGuardReport["inFlight"],
): boolean {
  return (
    canonicalJson([...a.reservations].sort(byId((row) => row.reservationId))) ===
      canonicalJson([...b.reservations].sort(byId((row) => row.reservationId))) &&
    canonicalJson([...a.allocations].sort(byId((row) => row.allocationId))) ===
      canonicalJson([...b.allocations].sort(byId((row) => row.allocationId)))
  );
}

function byId<T>(keyOf: (row: T) => string) {
  return (a: T, b: T) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);
}

/** An inline string array literal, quote-escaped, for `= ANY(...)` probes. */
function stringArrayLiteral(values: string[]): string {
  return `ARRAY[${values
    .map((value) => `'${value.replaceAll("'", "''")}'`)
    .join(",")}]`;
}

/**
 * Deletion order over the estate's own foreign keys: every child before its parent, so a
 * RESTRICT/NO ACTION edge can never block a delete mid-transaction and a CASCADE edge
 * reaches only rows already gone. Children first is also the recovery order reversed — the
 * receipt replays parents before children. Cycles refuse (a real FK graph has none; a
 * drifted one must not be deleted through).
 */
async function deletionOrder(exec: SqlExecutor): Promise<string[]> {
  const estateArray = sql.raw(
    `ARRAY[${CLEANUP_ESTATE_TABLES.map((table) => `'${table}'`).join(",")}]`,
  );
  const edges = await exec.execute<{
    child_table: string;
    parent_table: string;
  }>(sql`
    SELECT child.relname AS child_table, parent.relname AS parent_table
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = con.confrelid
    WHERE con.contype = 'f'
      AND ns.nspname = current_schema()
      AND child.relname = ANY(${estateArray})
      AND parent.relname = ANY(${estateArray})
    GROUP BY child.relname, parent.relname
  `);
  const childrenOf = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.child_table === edge.parent_table) continue;
    const set = childrenOf.get(edge.parent_table) ?? new Set<string>();
    set.add(edge.child_table);
    childrenOf.set(edge.parent_table, set);
  }
  // Kahn, children first, ties broken by the estate's fixed order.
  const emitted = new Set<string>();
  const order: string[] = [];
  const remaining = [...CLEANUP_ESTATE_TABLES];
  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((table) =>
      [...(childrenOf.get(table) ?? [])].every((child) => emitted.has(child)),
    );
    if (readyIndex === -1) {
      throw new CleanupExecutionRefusedError([
        `the estate's foreign-key graph has a cycle among [${remaining.join(", ")}] — refusing to delete through a drifted schema`,
      ]);
    }
    const [table] = remaining.splice(readyIndex, 1);
    emitted.add(table);
    order.push(table);
  }
  return order;
}

/** The credit rows of one account class: grants and ledger, whole, ordered. */
async function creditFootprint(
  database: Database,
  keys: string[],
): Promise<string> {
  if (keys.length === 0) return hashRows([]);
  const grants = await readRowsJson(
    database,
    sql`SELECT * FROM credit_grants WHERE external_customer_id = ANY(${sql.raw(stringArrayLiteral(keys))}) ORDER BY id`,
  );
  const ledger = await readRowsJson(
    database,
    sql`SELECT * FROM credit_ledger WHERE external_customer_id = ANY(${sql.raw(stringArrayLiteral(keys))}) ORDER BY id`,
  );
  return hashValue({ grants, ledger });
}

/** Whole-row dumps of the retained classes' records, keyed per table. */
async function dumpRetainedRows(
  database: Database,
  classification: CleanupClassification,
): Promise<Record<string, Record<string, unknown>[]>> {
  const byTable = new Map<string, string[]>();
  for (const record of classification.records) {
    if (record.class === "confirmed_obsolete_test") continue;
    const ids = byTable.get(record.table) ?? [];
    ids.push(record.recordId);
    byTable.set(record.table, ids);
  }
  return dumpRowsByIdentity(database, byTable);
}

/** Re-dump the SAME identities a previous retained dump held (the anchor is the authorized manifest). */
async function dumpRetainedRowsByIdentity(
  database: Database,
  retained: Record<string, Record<string, unknown>[]>,
): Promise<Record<string, Record<string, unknown>[]>> {
  const byTable = new Map<string, string[]>();
  for (const [table, rows] of Object.entries(retained)) {
    const idColumn = ESTATE_ID_COLUMNS[table];
    byTable.set(
      table,
      rows.map((row) => String(row[idColumn])),
    );
  }
  return dumpRowsByIdentity(database, byTable);
}

async function dumpRowsByIdentity(
  database: Database,
  byTable: Map<string, string[]>,
): Promise<Record<string, Record<string, unknown>[]>> {
  const dumps: Record<string, Record<string, unknown>[]> = {};
  for (const [table, ids] of byTable) {
    const idColumn = ESTATE_ID_COLUMNS[table];
    dumps[table] = await readRowsJson(
      database,
      sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.identifier(idColumn)} = ANY(${sql.raw(stringArrayLiteral([...new Set(ids)]))}) ORDER BY ${sql.identifier(idColumn)}`,
    );
  }
  return dumps;
}

/** Distinct external customer keys of one class's records (the account footprint). */
function keysOfClass(
  classification: CleanupClassification,
  klass: "company_history" | "personal_records",
): string[] {
  return [
    ...new Set(
      classification.records
        .filter((record) => record.class === klass && record.externalCustomerId)
        .map((record) => record.externalCustomerId as string),
    ),
  ];
}

/**
 * The controlled execution. See the module header for the whole contract; the short form:
 * parse the authorization, re-derive the manifests, verify the binding, guard, snapshot the
 * protected surfaces, delete in one REPEATABLE READ transaction with the receipt written in
 * it, then verify the aftermath and smoke the accounting — refusing at every door where a
 * factor is missing, stale or drifting, and never deleting on a refusal.
 */
export async function executeAuthorizedCleanup(
  database: Database,
  evidence: TestEvidenceInput,
  authorization: CleanupAuthorizationInput,
): Promise<CleanupExecutionReport> {
  // --- Factor 3: the authorization record itself, before anything else runs.
  const auth = parseCleanupAuthorization(authorization);

  // --- Factors 1+2: fresh manifests, fresh binding, exact match against the record.
  const classification = await classifyCleanup(database, evidence);
  const relations = await evaluateCleanupRelations(database, classification);
  const dryRun = assembleCleanupDryRunReport(classification, relations);
  const verdict = verifyCleanupScopeConfirmation(auth.scope, dryRun);
  if (!verdict.valid) throw new CleanupExecutionRefusedError(verdict.differences);

  // --- 21.5's fresh walls, and their agreement with the reviewed scope: the guard re-derives
  // everything from the live data, so if the world moved between the dry-run and now, the
  // two disagree and the execution refuses rather than reconciling silently.
  const guard = await guardCleanupDeletion(database, evidence);
  assertCleanupDeletionAllowed(guard);
  const dryRunKeys = new Set(
    dryRun.toDelete.records.map((record) => `${record.table}/${record.recordId}`),
  );
  const guardKeys = new Set(
    guard.deletable.map((target) => `${target.table}/${target.recordId}`),
  );
  if (
    dryRunKeys.size !== guardKeys.size ||
    [...dryRunKeys].some((key) => !guardKeys.has(key))
  ) {
    throw new CleanupExecutionRefusedError([
      "the deletion guard and the reviewed dry-run disagree on the deletable set — the data moved between the dry-run and the guard: re-run the dry-run and re-authorize",
    ]);
  }

  const executedAt = new Date().toISOString();
  const executionId = `cleanup-${randomUUID()}`;
  const targets = [...guard.deletable];

  // --- Pre-execution snapshots: the protected surfaces and the account footprints, hashed
  // now so the post-verification compares like with like.
  const protectedTables = await existingProtectedTables(database);
  const protectedHashesBefore = new Map<string, string>();
  for (const table of protectedTables.present) {
    protectedHashesBefore.set(table, hashRows(await dumpTable(database, table)));
  }
  const retainedBefore = await dumpRetainedRows(database, classification);
  const companyKeys = keysOfClass(classification, "company_history");
  const personalKeys = keysOfClass(classification, "personal_records");
  const companyFootprintBefore = await creditFootprint(database, companyKeys);
  const personalFootprintBefore = await creditFootprint(database, personalKeys);

  // --- The one transaction: verify under its snapshot, capture, delete children-first,
  // write the receipt, commit — or abort with zero changes.
  const deletion = await database.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    const identity = await tx.execute<{ database: string; schema: string }>(
      sql`SELECT current_database() AS database, current_schema() AS schema`,
    );
    if (identity[0].database !== dryRun.binding.database) {
      throw new CleanupExecutionRefusedError([
        `database mismatch inside the execution transaction: the transaction reads ${identity[0].database}, the authorization names ${dryRun.binding.database} — a confirmation never crosses databases`,
      ]);
    }

    // The in-flight universe under THIS snapshot must equal the guard's: a hold that
    // appeared, vanished or changed state between the walls and the deletion is drift the
    // authorization never saw.
    const inFlightNow = await readInFlightSet(tx);
    if (!inFlightSetsEqual(inFlightNow, guard.inFlight)) {
      throw new CleanupExecutionRefusedError([
        "open settlement responsibility changed between the deletion guards and the execution transaction — in-flight rows are never cleanable and never deletable-on-stale-evidence: re-run the dry-run and re-authorize",
      ]);
    }

    // Existence recheck and whole-row capture, per target, before anything is deleted.
    const capturedRows: CapturedRow[] = [];
    for (const target of targets) {
      const idColumn = ESTATE_ID_COLUMNS[target.table];
      const rows = await tx.execute<Record<string, unknown>>(
        sql`SELECT * FROM ${sql.identifier(target.table)} WHERE ${sql.identifier(idColumn)} = ${target.recordId}`,
      );
      if (rows.length !== 1) {
        throw new CleanupExecutionRefusedError([
          `target ${target.table}/${target.recordId} is ${rows.length} rows under the execution snapshot (expected exactly 1) — the manifests and the data have drifted: re-run the dry-run and re-authorize`,
        ]);
      }
      capturedRows.push({
        table: target.table,
        row: JSON.parse(JSON.stringify(rows[0])),
      });
    }

    // Children first, from the estate's own foreign keys.
    const order = await deletionOrder(tx);
    const targetsByTable = new Map<string, string[]>();
    for (const target of targets) {
      const ids = targetsByTable.get(target.table) ?? [];
      ids.push(target.recordId);
      targetsByTable.set(target.table, ids);
    }
    const deletedByTable: ExecutionDeletedByTable[] = [];
    for (const table of order) {
      const ids = targetsByTable.get(table);
      if (!ids) continue;
      const idColumn = ESTATE_ID_COLUMNS[table];
      const deletedRows = await tx.execute<Record<string, unknown>>(
        sql`DELETE FROM ${sql.identifier(table)} WHERE ${sql.identifier(idColumn)} = ANY(${sql.raw(stringArrayLiteral(ids))}) RETURNING ${sql.identifier(idColumn)}`,
      );
      const deletedIds = new Set(
        deletedRows.map((row) => String(row[idColumn])),
      );
      if (ids.some((id) => !deletedIds.has(id))) {
        throw new Error(
          `deleting ${table} removed ${deletedIds.size} of ${ids.length} named rows — the deletion did not do exactly what the authorization named, aborting the transaction`,
        );
      }
      deletedByTable.push({
        table,
        rows: ids.length,
        recordIds: [...ids].sort(),
      });
    }
    const totalDeleted = deletedByTable.reduce(
      (sum, entry) => sum + entry.rows,
      0,
    );

    // The receipt, in the same transaction as the deletions: committed together or not at
    // all. Every deleted row rides whole — the recovery source of truth — and the payload's
    // key names stay clear of the audit redactor's sensitive set, because a redacted
    // receipt would be a recovery promise the trail cannot keep.
    const receipt = {
      phase: "executed",
      executionVersion: CLEANUP_EXECUTION_VERSION,
      executionId,
      executedAt,
      database: identity[0].database,
      schema: identity[0].schema,
      authorizedBy: auth.authorizedBy,
      authorizedAt: auth.authorizedAt,
      statement: auth.statement,
      binding: dryRun.binding,
      guardsVersion: GUARDS_VERSION,
      manifestVersions: MANIFEST_VERSIONS,
      evidenceInput: classification.evidenceInput,
      deleted: { totalRows: totalDeleted, byTable: deletedByTable },
      retained: dryRun.toRetain,
      quarantine: dryRun.quarantine,
      inFlight: guard.inFlight,
      recovery: {
        method:
          "every deleted row was captured whole into this receipt (capturedRows) before deletion; recovery is a administrator-supervised replay of the receipt rows into their tables (parents before children), checked against the receipt's retained/quarantine/protected hashes — the program provides no automatic undo, and the replay itself must never run through this cleanup program",
        capturedRows,
      },
      transaction: {
        committed: true,
        deletedRows: totalDeleted,
        auditReceiptWritten: true,
      },
    };
    await tx.insert(auditEvents).values({
      actorUserId: auth.authorizedBy,
      eventType: CLEANUP_AUDIT_EVENT_TYPE,
      targetType: "billing_cleanup",
      targetId: executionId,
      payload: redactAuditPayload(receipt) as Record<string, unknown>,
    });
    return { receipt, deletedByTable, capturedRows };
  });

  // --- Post-commit verification: the world after, read fresh.
  const postClassification = await classifyCleanup(database, evidence);
  let deletedAbsent = true;
  for (const entry of deletion.deletedByTable) {
    const idColumn = ESTATE_ID_COLUMNS[entry.table];
    const remaining = await database.execute<Record<string, unknown>>(
      sql`SELECT ${sql.identifier(idColumn)} FROM ${sql.identifier(entry.table)} WHERE ${sql.identifier(idColumn)} = ANY(${sql.raw(stringArrayLiteral(entry.recordIds))})`,
    );
    if (remaining.length > 0) deletedAbsent = false;
  }
  const retainedAfter = await dumpRetainedRowsByIdentity(
    database,
    retainedBefore,
  );
  // The kept classes' verdicts are anchored in the AUTHORIZED manifest, not re-derived:
  // deleting an evidenced test order legitimately removes the evidence under its key's
  // remaining rows, and the fresh classification then quarantines them (fail-safe: lost
  // evidence means keep, never delete). What must hold is that every row the authorization
  // classified as a keep is still there, byte-identical — and that the reclassification
  // only ever moves rows TOWARD quarantine: company and personal counts exact, unknown
  // counts never shrinking.
  const keptClassesStable =
    classification.summary.company_history.count ===
      postClassification.summary.company_history.count &&
    classification.summary.personal_records.count ===
      postClassification.summary.personal_records.count &&
    postClassification.summary.unknown_owner.count >=
      classification.summary.unknown_owner.count;
  const retainedUnchanged =
    keptClassesStable &&
    canonicalJson(retainedBefore) === canonicalJson(retainedAfter);
  const protectedHashesAfter = new Map<string, string>();
  for (const table of protectedTables.present) {
    protectedHashesAfter.set(table, hashRows(await dumpTable(database, table)));
  }
  const protectedUnchanged = [...protectedHashesBefore.entries()].every(
    ([table, before]) => protectedHashesAfter.get(table) === before,
  );
  const postVerification: ExecutionPostVerification = {
    passed: deletedAbsent && retainedUnchanged && protectedUnchanged,
    deletedAbsent,
    retainedUnchanged,
    protectedSurface: {
      tables: protectedTables.present,
      absent: protectedTables.absent,
      unchanged: protectedUnchanged,
    },
  };

  // --- The accounting smoke: the old balances moved nowhere (company and personal credit
  // footprints byte-identical — nothing copied into either account), and the new credit
  // system still grants, reserves and settles on the cleaned database. The smoke's own
  // rows live under one throwaway key and are deleted before it reports.
  const companyFootprintUnchanged =
    (await creditFootprint(database, companyKeys)) === companyFootprintBefore;
  const personalFootprintUnchanged =
    (await creditFootprint(database, personalKeys)) === personalFootprintBefore;
  const smokeKey = `cleanup-smoke-${executionId}`;
  let grantReserveSettlePassed = false;
  const writer = createCreditWriter(database);
  try {
    const grant = await writer.grantCredits({
      externalCustomerId: smokeKey,
      source: "promo",
      totalCents: 100_00,
      expiresAt: new Date(Date.now() + 3600_000),
      idempotencyKey: `${smokeKey}-grant`,
    });
    const available = await writer.availableBalance(smokeKey);
    const reservation = await writer.reserveCredits({
      externalCustomerId: smokeKey,
      idempotencyKey: `${smokeKey}-reserve`,
      maximumCents: 40_00,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    if (reservation.reserved && available >= 40_00 && grant.inserted) {
      await writer.settleReservation({
        reservationId: reservation.reservationId,
        actual: { numerator: 1_500n, denominator: 100n },
        title: `legacy cleanup accounting smoke ${executionId}`,
      });
      grantReserveSettlePassed = true;
    }
  } catch {
    grantReserveSettlePassed = false;
  } finally {
    // The smoke deletes its own footprint: it is a probe, not new books. grantCredits
    // ensures a billing_customers row for its key, so the customer row goes too — a probe
    // that left a row behind would move the estate the execution just verified.
    await database.execute(sql`
      DELETE FROM credit_reservation_allocations
      WHERE reservation_id IN (SELECT id FROM credit_reservations WHERE external_customer_id = ${smokeKey})
    `);
    await database.execute(
      sql`DELETE FROM credit_reservations WHERE external_customer_id = ${smokeKey}`,
    );
    await database.execute(
      sql`DELETE FROM credit_ledger WHERE external_customer_id = ${smokeKey}`,
    );
    await database.execute(
      sql`DELETE FROM credit_charge_remainders WHERE external_customer_id = ${smokeKey}`,
    );
    await database.execute(
      sql`DELETE FROM credit_grants WHERE external_customer_id = ${smokeKey}`,
    );
    await database.execute(
      sql`DELETE FROM billing_customers WHERE external_id = ${smokeKey}`,
    );
  }
  const accountingSmoke: ExecutionAccountingSmoke = {
    companyFootprintUnchanged,
    personalFootprintUnchanged,
    grantReserveSettlePassed,
    passed:
      companyFootprintUnchanged &&
      personalFootprintUnchanged &&
      grantReserveSettlePassed,
  };

  const report: CleanupExecutionReport = {
    executionVersion: CLEANUP_EXECUTION_VERSION,
    executionId,
    executedAt,
    database: deletion.receipt.database,
    schema: deletion.receipt.schema,
    authorization: {
      authorizedBy: auth.authorizedBy,
      authorizedAt: auth.authorizedAt,
      statement: auth.statement,
    },
    binding: dryRun.binding,
    guardsVersion: GUARDS_VERSION,
    manifestVersions: MANIFEST_VERSIONS,
    evidenceInput: classification.evidenceInput,
    deleted: deletion.receipt.deleted,
    retained: dryRun.toRetain,
    quarantine: dryRun.quarantine,
    inFlight: guard.inFlight,
    recovery: {
      method: deletion.receipt.recovery.method,
      capturedRows: deletion.capturedRows.length,
    },
    transaction: deletion.receipt.transaction,
    postVerification,
    accountingSmoke,
  };

  // The second audit row: the post-commit verdicts, appended once the reads finished. The
  // receipt above is atomic with the deletions; this row is the verification's own trail —
  // a crash between the two leaves an execution whose verification is honestly pending.
  await database.insert(auditEvents).values({
    actorUserId: auth.authorizedBy,
    eventType: CLEANUP_AUDIT_EVENT_TYPE,
    targetType: "billing_cleanup",
    targetId: executionId,
    payload: redactAuditPayload({
      phase: "post_verified",
      executionId,
      report,
    }) as Record<string, unknown>,
  });

  return report;
}

if (import.meta.main) {
  // Operator entry: `bun server/src/billing/cleanup-execution.ts <authorization.json>
  // [registries.json]` executes the cleanup on the database DATABASE_URL names. The
  // authorization file is the administrator's record: { authorizationVersion, authorizedBy,
  // authorizedAt, statement, scope: <the reviewed dry-run report's `binding`> }. Without it
  // this entry refuses; nothing here reads a confirmation from anywhere else. A dry-run
  // (cleanup-dry-run.ts) is taken first, reviewed, confirmed, and its binding copied into
  // the authorization — the execution verifies that binding against a fresh derivation.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL must point at the deployment database this cleanup executes on.",
    );
  }
  const authorizationPath = process.argv[2];
  if (!authorizationPath) {
    throw new Error(
      "usage: bun server/src/billing/cleanup-execution.ts <authorization.json> [registries.json] — no authorization record, no execution",
    );
  }
  const registryPath = process.argv[3];
  const registryInput: TestEvidenceInput = registryPath
    ? await Bun.file(registryPath).json()
    : { testOrderIds: [], testUserIds: [] };
  const { createDatabase } = await import("../db/client");
  const databaseInstance = createDatabase(databaseUrl);
  try {
    const authorizationRecord = await Bun.file(authorizationPath).json();
    const report = await executeAuthorizedCleanup(
      databaseInstance,
      registryInput,
      authorizationRecord,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await databaseInstance.$client.end();
  }
}

/** Re-exported for the admin route's typing convenience. */
export type { CleanupDryRunReport };
