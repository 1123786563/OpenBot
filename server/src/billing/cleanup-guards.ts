import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  CLEANUP_ESTATE_TABLES,
  type CleanupRecordClass,
  classifyCleanup,
  IN_FLIGHT_RESERVATION_STATUSES,
  type TestEvidenceInput,
} from "./cleanup-classification";
import { evaluateCleanupRelations } from "./cleanup-relations";

/*
 * The cleanup deletion guards (group 21.5): the program-level safety gate between 21.4's
 * reviewed dry-run and any future execution (21.6's rehearsal, 21.7's authorized run). The
 * constraints live HERE, in code — never in operator care (the ticket's resume hint) — and
 * this module decides; it never deletes anything.
 *
 * `guardCleanupDeletion(database, evidence, { targets? })` answers one question: which of the
 * handed deletion targets may the cleanup program touch? It trusts NO caller-supplied
 * manifest: it re-derives 21.2's classification and 21.3's relations fresh from the live
 * data (their own READ ONLY fences), then enforces four independent walls per target, in
 * precedence order —
 *
 * 1. The estate wall: only the twelve legacy billing tables may ever be named. Users, bots,
 *    sessions, knowledge-base objects and every other application table are refused before
 *    any row is probed (existence cannot leak), and so is any row of a table the estate
 *    does not know (Q28: this cleanup is scoped to the legacy billing estate only).
 * 2. Candidacy: the fresh classification must name the record `confirmed_obsolete_test`.
 *    A record it does not name was never a candidate; company billing history (ADR 0004),
 *    personal records and `unknown_owner` quarantines are refused by class, whatever any
 *    stale manifest claimed.
 * 3. The fresh in-flight probe — the wall that does not trust even the fresh manifests: in
 *    one READ ONLY, REPEATABLE READ fence of its own, it loads every live reservation whose
 *    status carries open settlement responsibility (`reserved`, or `unknown` per 06.8 — the
 *    clock is never release evidence) and every allocation of one, walks the catalog's own
 *    FK edges UPWARD from those rows (CASCADE deletes travel transitively; SET NULL
 *    mutations count as reaching too), and refuses any target whose deletion would delete
 *    or mutate an in-flight row — the hold itself, its allocation, the customer row whose
 *    cascade would take the hold, the grant an in-flight allocation rides. 08.1's
 *    RecoveryItem storage is not deployed in this workspace; unknown holds ARE the rows
 *    RecoveryItems are generated from, so probing `reserved|unknown` reservations covers
 *    every row a RecoveryItem could reference (recorded in the report; when 08.1 lands its
 *    open items join this probe).
 * 4. The verified scope: the fresh relations evaluation must still call the target safe —
 *    external anchors, cascade impact on kept rows and attribution evidence already pulled
 *    it otherwise.
 *
 * Every refusal names its reason and carries the evidence a reviewer (or 21.6/21.7) needs;
 * every in-flight row the probe found is recorded in the report whether or not a target
 * touched it (ticket: 命中者移出范围并记录). `assertCleanupDeletionAllowed` turns a refused
 * report into a thrown, reason-naming error — the last gate an executor walks through, so a
 * refusal can never be ignored by accident.
 */

/** The guard contract version, bumped when the enforcement semantics change. */
export const GUARDS_VERSION = 1;

/** Why a target was refused; every refusal cites exactly one reason. */
export type DeletionRefusalReason =
  | "table_outside_cleanup_estate"
  | "not_a_classification_candidate"
  | "record_not_found"
  | "in_flight_responsibility"
  | "company_billing_history"
  | "personal_records"
  | "unknown_owner_isolated"
  | "not_in_verified_deletion_scope";

/** One refused target: the identifiers, the reason and the reviewable evidence. */
export type DeletionRefusal = {
  table: string;
  recordId: string;
  reason: DeletionRefusalReason;
  evidence: string;
};

/** A deletion target the guard was asked about: a legacy estate table and a record id. */
export type GuardedDeleteTarget = { table: string; recordId: string };

/** The non-negotiable constraints this run enforced, recorded for the review trail. */
export type EnforcedGuards = {
  estateTables: readonly string[];
  inFlightReservationStatuses: readonly string[];
  protectedClasses: readonly CleanupRecordClass[];
  /** Why the probe needs no RecoveryItem table today (08.1 not deployed), and what joins it when 08.1 lands. */
  recoveryItems: string;
};

/** The guard's verdict: what may be deleted, what may not and why, plus the in-flight record. */
export type CleanupDeletionGuardReport = {
  guardsVersion: typeof GUARDS_VERSION;
  /** `current_database()` and schema of the data the fresh manifests and the probe read. */
  database: string;
  schema: string;
  generatedAt: string;
  /** The constraints enforced — program-level, not operator discretion. */
  enforced: EnforcedGuards;
  /** The fresh manifests this run derived (identified, not trusted from the caller). */
  basis: {
    classificationDatabase: string;
    classificationEvidenceSha256: string;
    candidatesIn: number;
    safeCandidatesIn: number;
  };
  /** Every in-flight row the fresh probe found — recorded even when no target reaches it. */
  inFlight: {
    reservations: {
      reservationId: string;
      status: string;
      externalCustomerId: string | null;
    }[];
    allocations: { allocationId: string; reservationId: string }[];
  };
  /** The targets that passed every wall, in the classification's deterministic order. */
  deletable: GuardedDeleteTarget[];
  /** The refused targets with reasons and evidence, in the same deterministic order. */
  refused: DeletionRefusal[];
  summary: { targetsIn: number; deletable: number; refused: number };
};

/** The options of `guardCleanupDeletion`; omitting targets means the fresh safe candidates. */
export type GuardOptions = { targets?: GuardedDeleteTarget[] };

/**
 * The recordId column of every estate table — the identity the classification, the
 * relations evaluation and this guard all name rows by. Declared once here and checked
 * against the estate list, so a table added upstream without an identity here fails loudly
 * instead of probing the wrong column.
 */
const ESTATE_ID_COLUMNS: Record<string, string> = {
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

/** A probed row: its identity plus the FK child columns following it upward needs. */
type ProbeRow = {
  table: string;
  recordId: string;
  cols: Record<string, string | null>;
};

type CatalogEdge = {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
  constraintName: string;
  onDelete: "cascade" | "set_null";
};

const rowKey = (table: string, recordId: string) => `${table}/${recordId}`;

const byEstateOrderThenId = (
  a: { table: string; recordId: string },
  b: { table: string; recordId: string },
) =>
  CLEANUP_ESTATE_TABLES.indexOf(a.table) -
    CLEANUP_ESTATE_TABLES.indexOf(b.table) ||
  (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0);

/** Deterministic JSON-ish rendering of one refusal, for aggregate error messages. */
function describeRefusal(refusal: DeletionRefusal): string {
  return `${refusal.reason} ${refusal.table}/${refusal.recordId}: ${refusal.evidence}`;
}

/**
 * The last gate an executor walks through: throws, naming every refusal, unless the report
 * cleared every target. A report with refusals is never silently dequeuable.
 */
export function assertCleanupDeletionAllowed(
  report: CleanupDeletionGuardReport,
): void {
  if (report.refused.length === 0) return;
  throw new Error(
    `cleanup deletion refused for ${report.refused.length} of ${report.summary.targetsIn} target(s) — the deletion guards (21.5) forbid this scope: ${report.refused
      .map(describeRefusal)
      .join(" | ")}`,
  );
}

/**
 * Which of the handed targets may the cleanup program delete? Re-derives the classification
 * and the relations evaluation fresh from the live data, then enforces the four walls.
 * Read-only by construction: every read happens inside READ ONLY transactions; this module
 * never deletes anything.
 */
export async function guardCleanupDeletion(
  database: Database,
  evidence: TestEvidenceInput,
  options: GuardOptions = {},
): Promise<CleanupDeletionGuardReport> {
  // The fresh manifests: derived HERE, from the live data — a caller-supplied manifest is
  // never an input, so a stale or tampered one cannot widen this guard by a single row.
  const classification = await classifyCleanup(database, evidence);
  const relations = await evaluateCleanupRelations(database, classification);
  const targets = options.targets ?? relations.safeCandidates;

  return database.transaction(async (tx) => {
    await tx.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
    );
    const identity = await tx.execute<{ database: string; schema: string }>(
      sql`SELECT current_database() AS database, current_schema() AS schema`,
    );

    // --- The live FK graph among estate tables: every CASCADE or SET NULL edge is a way a
    // deletion can reach an in-flight row. RESTRICT/NO ACTION edges do not endanger the
    // child (they block the deletion instead), so they are not endangerment paths.
    const estateArray = sql.raw(
      `ARRAY[${CLEANUP_ESTATE_TABLES.map((table) => `'${table}'`).join(",")}]`,
    );
    const catalogRows = await tx.execute<{
      child_table: string;
      child_column: string;
      parent_table: string;
      parent_column: string;
      constraint_name: string;
      on_delete: string;
    }>(sql`
      SELECT child.relname AS child_table,
             pa.attname AS child_column,
             parent.relname AS parent_table,
             qa.attname AS parent_column,
             con.conname AS constraint_name,
             con.confdeltype AS on_delete
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN unnest(con.conkey) WITH ORDINALITY AS ck(attnum, ord) ON true
      JOIN unnest(con.confkey) WITH ORDINALITY AS pk(attnum, ord) ON pk.ord = ck.ord
      JOIN pg_attribute pa ON pa.attrelid = child.oid AND pa.attnum = ck.attnum
      JOIN pg_attribute qa ON qa.attrelid = parent.oid AND qa.attnum = pk.attnum
      WHERE con.contype = 'f'
        AND ns.nspname = current_schema()
        AND child.relname = ANY(${estateArray})
        AND parent.relname = ANY(${estateArray})
        AND con.confdeltype IN ('c', 'n')
      ORDER BY child.relname, parent.relname, ck.ord
    `);
    const edges: CatalogEdge[] = catalogRows.map((row) => ({
      childTable: row.child_table,
      childColumn: row.child_column,
      parentTable: row.parent_table,
      parentColumn: row.parent_column,
      constraintName: row.constraint_name,
      onDelete:
        row.on_delete === "c"
          ? "cascade"
          : row.on_delete === "n"
            ? "set_null"
            : (() => {
                throw new Error(
                  `unexpected confdeltype ${row.on_delete} on constraint ${row.constraint_name}: the guard only reads cascade and set_null edges`,
                );
              })(),
    }));
    // The columns an upward walk needs per table: its identity plus every FK child column.
    const childColumnsByTable = new Map<string, Set<string>>();
    for (const edge of edges) {
      const columns =
        childColumnsByTable.get(edge.childTable) ?? new Set<string>();
      columns.add(edge.childColumn);
      childColumnsByTable.set(edge.childTable, columns);
    }
    const columnsNeeded = (table: string): string[] => [
      ESTATE_ID_COLUMNS[table] ??
        (() => {
          throw new Error(
            `estate table ${table} has no recordId column declared: the guard's identity map and the estate list have drifted`,
          );
        })(),
      ...[...(childColumnsByTable.get(table) ?? [])].filter(
        (column) => column !== ESTATE_ID_COLUMNS[table],
      ),
    ];

    const probeRow = async (
      table: string,
      column: string,
      value: string,
    ): Promise<ProbeRow[]> => {
      const columns = columnsNeeded(table);
      const rows = await tx.execute<Record<string, unknown>>(
        sql`SELECT ${sql.join(
          columns.map((name) => sql.identifier(name)),
          sql`, `,
        )}
        FROM ${sql.identifier(table)}
        WHERE ${sql.identifier(column)} = ${value}`,
      );
      const idColumn = ESTATE_ID_COLUMNS[table];
      return rows.map((row) => ({
        table,
        recordId: String(row[idColumn]),
        cols: Object.fromEntries(
          columns.map((name) => [
            name,
            row[name] === null || row[name] === undefined
              ? null
              : String(row[name]),
          ]),
        ),
      }));
    };

    // --- The in-flight universe, from live data: every open hold and every allocation of
    // one. These rows are the settlement responsibility the cleanup may never reach — and
    // the rows 08.1's RecoveryItems are generated from, so probing them today covers every
    // RecoveryItem the future scan could name.
    const inFlightStatusArray = sql.raw(
      `ARRAY[${IN_FLIGHT_RESERVATION_STATUSES.map((status) => `'${status}'`).join(",")}]`,
    );
    // Dedupe: external_customer_id may already be a FK child column the walk needs.
    const reservationQueryColumns = [
      ...new Set([
        ...columnsNeeded("credit_reservations"),
        "external_customer_id",
        "status",
      ]),
    ];
    const reservationRows = await tx.execute<{
      id: string;
      status: string;
      external_customer_id: string | null;
    }>(sql`
      SELECT ${sql.join(
        reservationQueryColumns.map((name) => sql.identifier(name)),
        sql`, `,
      )}
      FROM ${sql.identifier("credit_reservations")}
      WHERE status = ANY(${inFlightStatusArray})
      ORDER BY id
    `);
    const allocationRows = await tx.execute<{
      id: string;
      reservation_id: string;
    }>(sql`
      SELECT a.${sql.identifier("id")}, a.${sql.identifier("reservation_id")}
      FROM ${sql.identifier("credit_reservation_allocations")} a
      JOIN ${sql.identifier("credit_reservations")} r ON r.${sql.identifier("id")} = a.${sql.identifier("reservation_id")}
      WHERE r.status = ANY(${inFlightStatusArray})
      ORDER BY a.id
    `);

    const inFlightReservations = reservationRows.map((row) => ({
      reservationId: row.id,
      status: row.status,
      externalCustomerId: row.external_customer_id,
    }));
    const inFlightAllocations = allocationRows.map((row) => ({
      allocationId: row.id,
      reservationId: row.reservation_id,
    }));

    // --- The upward endangerment closure: for every in-flight row, which estate rows could
    // delete it (CASCADE, transitively) or mutate it (SET NULL)? BFS upward through the
    // catalog's own edges; CASCADE travels (deleting a grandparent deletes the parent, which
    // in turn deletes the in-flight row or nulls its pointer), SET NULL marks without
    // traveling (the parent survives, so nothing further up is reached).
    type EndangermentPath = {
      effect: "cascade_delete" | "set_null_mutate";
      via: string;
    };
    type EndangeringRow = { row: ProbeRow; paths: EndangermentPath[] };
    const endangeringByInFlight = new Map<
      string,
      Map<string, EndangeringRow>
    >();
    const inFlightRowsById = new Map<string, ProbeRow>();
    for (const row of reservationRows) {
      inFlightRowsById.set(row.id, {
        table: "credit_reservations",
        recordId: row.id,
        cols: Object.fromEntries(
          columnsNeeded("credit_reservations").map((name) => [
            name,
            (row as unknown as Record<string, unknown>)[name] === null ||
            (row as unknown as Record<string, unknown>)[name] === undefined
              ? null
              : String((row as unknown as Record<string, unknown>)[name]),
          ]),
        ),
      });
    }
    for (const allocation of allocationRows) {
      const [row] = await probeRow(
        "credit_reservation_allocations",
        "id",
        allocation.id,
      );
      if (row) inFlightRowsById.set(allocation.id, row);
    }
    for (const [inFlightId, root] of inFlightRowsById) {
      const endangering = new Map<string, EndangeringRow>();
      // The in-flight row itself is the first entry: targeting it directly is the most
      // direct possible reach. (Its precise status label rides in inFlightLabelById.)
      endangering.set(rowKey(root.table, root.recordId), {
        row: root,
        paths: [{ effect: "cascade_delete", via: "the in-flight row itself" }],
      });
      const expanded = new Set<string>();
      const frontier: ProbeRow[] = [root];
      while (frontier.length > 0) {
        const current = frontier.pop();
        if (!current) break;
        const currentKey = rowKey(current.table, current.recordId);
        if (expanded.has(currentKey)) continue;
        expanded.add(currentKey);
        for (const edge of edges) {
          if (edge.childTable !== current.table) continue;
          const value = current.cols[edge.childColumn];
          if (value === null || value === undefined) continue;
          for (const parentRow of await probeRow(
            edge.parentTable,
            edge.parentColumn,
            value,
          )) {
            const key = rowKey(parentRow.table, parentRow.recordId);
            const path: EndangermentPath = {
              effect:
                edge.onDelete === "cascade"
                  ? "cascade_delete"
                  : "set_null_mutate",
              via: `${edge.childTable}.${edge.childColumn} -> ${edge.parentTable}.${edge.parentColumn} (${edge.constraintName}, on delete ${edge.onDelete})`,
            };
            const existing = endangering.get(key);
            if (existing) {
              if (!existing.paths.some((entry) => entry.via === path.via)) {
                existing.paths.push(path);
              }
            } else {
              endangering.set(key, { row: parentRow, paths: [path] });
            }
            // Only CASCADE keeps deletion traveling upward: a SET NULL parent survives, so
            // nothing above it is reached through it.
            if (edge.onDelete === "cascade" && !expanded.has(key)) {
              frontier.push(parentRow);
            }
          }
        }
      }
      endangeringByInFlight.set(inFlightId, endangering);
    }

    // Which target rows reach in-flight rows, through which path: the freshest protection.
    // The evidence names the in-flight row precisely: the hold itself (with its live
    // status), or the allocation of a hold (with the hold it rides).
    type InFlightReach = { path: EndangermentPath; label: string };
    const inFlightLabelById = new Map<string, string>();
    for (const reservation of inFlightReservations) {
      inFlightLabelById.set(
        reservation.reservationId,
        `credit_reservations/${reservation.reservationId} (status ${reservation.status})`,
      );
    }
    for (const allocation of inFlightAllocations) {
      const status =
        inFlightReservations.find(
          (reservation) =>
            reservation.reservationId === allocation.reservationId,
        )?.status ?? "reserved";
      inFlightLabelById.set(
        allocation.allocationId,
        `credit_reservation_allocations/${allocation.allocationId} (allocation of credit_reservations/${allocation.reservationId}, status ${status})`,
      );
    }
    const inFlightReachByTarget = new Map<string, InFlightReach[]>();
    for (const target of targets) {
      const key = rowKey(target.table, target.recordId);
      const reaches: InFlightReach[] = [];
      for (const [inFlightId, endangering] of endangeringByInFlight) {
        const hit = endangering.get(key);
        if (hit) {
          for (const path of hit.paths) {
            reaches.push({
              path,
              label:
                inFlightLabelById.get(inFlightId) ??
                `in-flight row ${inFlightId}`,
            });
          }
        }
      }
      if (reaches.length > 0) inFlightReachByTarget.set(key, reaches);
    }

    // --- The four walls, per target, in precedence order.
    const namedByKey = new Map(
      classification.records.map((record) => [
        rowKey(record.table, record.recordId),
        record,
      ]),
    );
    const removedByKey = new Map(
      relations.removedCandidates.map((removed) => [
        rowKey(removed.table, removed.recordId),
        removed,
      ]),
    );
    const safeSet = new Set(
      relations.safeCandidates.map((safe) => rowKey(safe.table, safe.recordId)),
    );

    const deletable: GuardedDeleteTarget[] = [];
    const refused: DeletionRefusal[] = [];
    for (const target of targets) {
      const key = rowKey(target.table, target.recordId);
      const refuse = (reason: DeletionRefusalReason, evidence: string) =>
        refused.push({
          table: target.table,
          recordId: target.recordId,
          reason,
          evidence,
        });

      // Wall 1: the estate. Identity-level, before any row is probed — a table outside the
      // estate (users, bots, sessions, knowledge base, everything else) is not the cleanup
      // program's to name, and refusing it here cannot leak whether a row exists.
      if (!CLEANUP_ESTATE_TABLES.includes(target.table)) {
        refuse(
          "table_outside_cleanup_estate",
          `table ${target.table} is outside the legacy billing estate: the cleanup program may only ever name [${CLEANUP_ESTATE_TABLES.join(", ")}] — users, bots, sessions, knowledge-base objects and every other application table are not deletable by this program, whatever recordId it is handed`,
        );
        continue;
      }

      // Wall 2: the fresh classification's verdict.
      const named = namedByKey.get(key);
      if (!named) {
        refuse(
          "not_a_classification_candidate",
          `the fresh classification does not name ${target.table}/${target.recordId} at all: only records it verdicts confirmed_obsolete_test are ever deletable, and this is not one of them`,
        );
        continue;
      }

      // Wall 3: the fresh in-flight probe — live data, trusting no manifest verdict.
      const [live] = await probeRow(
        target.table,
        ESTATE_ID_COLUMNS[target.table],
        target.recordId,
      );
      if (!live) {
        refuse(
          "record_not_found",
          `${target.table}/${target.recordId} is named by the classification but no longer exists in the data: the manifests and the data have drifted, and a nonexistent row is not a deletable one`,
        );
        continue;
      }
      const reach = inFlightReachByTarget.get(key);
      if (reach && reach.length > 0) {
        refuse(
          "in_flight_responsibility",
          `deleting ${target.table}/${target.recordId} would reach open settlement responsibility: ${reach
            .map(
              (entry) =>
                `${entry.path.effect} ${entry.label} via ${entry.path.via}`,
            )
            .join(
              "; ",
            )} — holds whose provider result never arrived are never release evidence (06.8), and the rows they ride are never cleanable`,
        );
        continue;
      }

      // Wall 2 (verdict part): the class refusals, after the in-flight probe so a live hold
      // reports its live reason first.
      if (named.class === "company_history") {
        refuse(
          "company_billing_history",
          `${target.table}/${target.recordId} is class=company_history: company billing history is kept in full (ADR 0004) and is not deletable by this program, whatever test markers its rows also carry`,
        );
        continue;
      }
      if (named.class === "personal_records") {
        refuse(
          "personal_records",
          `${target.table}/${target.recordId} is class=personal_records: kept (migration is a later, separate decision) and not deletable by this program`,
        );
        continue;
      }
      if (named.class === "unknown_owner") {
        refuse(
          "unknown_owner_isolated",
          `${target.table}/${target.recordId} is class=unknown_owner (isolated: ${named.isolationReason ?? "unknown_attribution"}): the quarantine the cleanup program cannot reach`,
        );
        continue;
      }

      // Wall 4: the fresh relations evaluation must still call it safe.
      if (!safeSet.has(key)) {
        const removed = removedByKey.get(key);
        refuse(
          "not_in_verified_deletion_scope",
          removed
            ? `the fresh relations evaluation removed ${target.table}/${target.recordId} from the cleanup set (${removed.reason}): ${removed.evidence}`
            : `the fresh relations evaluation does not list ${target.table}/${target.recordId} among the safe candidates`,
        );
        continue;
      }

      deletable.push({ table: target.table, recordId: target.recordId });
    }

    deletable.sort(byEstateOrderThenId);
    refused.sort(byEstateOrderThenId);

    return {
      guardsVersion: GUARDS_VERSION,
      database: identity[0].database,
      schema: identity[0].schema,
      generatedAt: new Date().toISOString(),
      enforced: {
        estateTables: CLEANUP_ESTATE_TABLES,
        inFlightReservationStatuses: IN_FLIGHT_RESERVATION_STATUSES,
        protectedClasses: [
          "company_history",
          "personal_records",
          "unknown_owner",
        ],
        recoveryItems:
          "08.1's RecoveryItem storage (credit_recovery_items, migration 0147) is deployed; its rows hang off credit_reservations ON DELETE CASCADE, so the live FK walk above already covers every RecoveryItem — deleting an in-flight reservation would delete its recovery item, and the walk refuses any target that reaches the hold. Unknown holds remain the rows RecoveryItems are generated from.",
      },
      basis: {
        classificationDatabase: classification.database,
        classificationEvidenceSha256: classification.evidenceInput.sha256,
        candidatesIn: classification.candidates.length,
        safeCandidatesIn: relations.safeCandidates.length,
      },
      inFlight: {
        reservations: inFlightReservations.sort((a, b) =>
          a.reservationId < b.reservationId ? -1 : 1,
        ),
        allocations: inFlightAllocations.sort((a, b) =>
          a.allocationId < b.allocationId ? -1 : 1,
        ),
      },
      deletable,
      refused,
      summary: {
        targetsIn: targets.length,
        deletable: deletable.length,
        refused: refused.length,
      },
    };
  });
}
