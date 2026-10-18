import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  classifyCleanup,
  isReservationInFlight,
  type CleanupClassification,
  type CleanupRecordClass,
} from "./cleanup-classification";

/*
 * The legacy billing relation mapping and cascade evaluation (group 21.3) on top of 21.2's
 * classification. Where the classification answers "may this record ever be cleaned", this
 * module answers the question the ticket puts next: for every cleanup candidate, what would
 * deleting it actually reach — and is anything on the other end a record that must be kept?
 *
 * The evidence discipline is the cleanup group's, extended one hop:
 *
 * - Foreign keys are read from the LIVE catalog (`pg_constraint`), then confirmed against the
 *   rows themselves. The schema declaration is an expectation to compare against, never the
 *   truth: a historical database may carry an edge no migration declares, or have lost one
 *   that does. Every edge records whether it matches the declaration, and every mismatch is
 *   counted in the summary — the reverse-reference direction is established by probing actual
 *   child rows, so the manifest's FK claims always have data behind them.
 * - Cascade evaluation follows the catalog's own delete behaviors: CASCADE edges extend the
 *   deletion transitively; SET NULL edges MUTATE the referencing row (nulling its evidence
 *   pointer) without deleting it; RESTRICT/NO ACTION edges make the deletion impossible while
 *   the referencing row stands. A row that any of the three would touch, whose classification
 *   verdict is a keep (company_history, personal_records, unknown_owner) — or that the passed
 *   classification does not know at all, which defaults to protected — pulls the candidate out
 *   of the cleanup set, with every touched row named in the evaluation.
 * - Value-level linkages with no foreign key (usage_outbox's customer and reservation keys,
 *   the webhook inbox's object_id, an order's `plan:<orderId>` payout grant) are probed and
 *   recorded as observed links — evidence that deletion does NOT travel them, which is exactly
 *   the kind of assumption this ticket exists to retire.
 * - External live subscriptions (status active or incomplete: not yet ended at the payment
 *   gateway) and open gateway orders (status pending: the channel can still report payment)
 *   are anchors: their rows are pulled from the cleanup set, their cascade subtrees pulled
 *   with them, and each is listed separately for human confirmation. Nothing here cancels,
 *   closes or otherwise disposes of an external association (Q28/Q29).
 * - A payer_accounts mapping row whose key still keeps any protected record is pulled as that
 *   key's attribution evidence (Q29: kept quarantine must stay explicable) — and every kept
 *   row is then protected against OTHER candidates' cascades, which is how a clean key's
 *   customer row gets pulled when its only sin is cascading into the kept mapping.
 * - Read-only by construction: one READ ONLY, REPEATABLE READ transaction, like 21.1/21.2 —
 *   persisting the manifest is the operator's act of saving the JSON. The shape is
 *   deterministic (21.2's table order, record-id sorting, timestamps only as metadata), so
 *   21.4 can hash it and two evaluations of the same data agree byte for byte.
 */

/** The statuses that mean "the subscription still exists at the payment gateway". */
export const EXTERNAL_LIVE_SUBSCRIPTION_STATUSES = ["active", "incomplete"] as const;

/** Why a candidate was pulled from the cleanup set; every removal cites exactly one. */
export type RemovalReason =
  | "cascade_impact_on_retained"
  | "external_subscription_anchor"
  | "external_payment_order_open"
  | "attribution_basis_of_kept_records"
  | "deletion_blocked_by_retained_reference";

/** What makes a touched row untouchable: its class, its anchor role, or its evidence role. */
export type ProtectionKind =
  | "retained"
  | "external_subscription_anchor"
  | "external_payment_order_open"
  | "attribution_kept";

/** How deleting the candidate would touch the row. */
export type ImpactEffect = "cascade_delete" | "set_null_mutate" | "delete_blocked";

/** The classification verdict of a probed row; `unclassified` rows default to protected. */
export type RowClass = CleanupRecordClass | "unclassified";

/** One FK edge, exactly as the live catalog states it. */
export type RelationFkEdge = {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
  constraintName: string;
  onDelete: "cascade" | "set_null" | "restrict" | "no_action" | "set_default";
  /** False = the catalog disagrees with the schema declaration: a finding, never a silent fix. */
  matchesDeclaration: boolean;
  evidence: string;
};

/** One row another row references or is referenced by, with the linkage that was probed. */
export type RelationReference = {
  table: string;
  recordId: string;
  /** The exact FK the reference rides: `child.col -> parent.col (constraint)`. */
  via: string;
  class: RowClass;
};

/** One row inside a candidate's deletion reach. */
export type ScopeRow = { table: string; recordId: string; class: RowClass };

/** One touched row that must survive: what deleting the candidate would do to it, and why it is protected. */
export type RetainedImpact = {
  table: string;
  recordId: string;
  effect: ImpactEffect;
  protection: ProtectionKind;
  class: RowClass;
};

/** A value-level linkage with no FK, confirmed (or refuted) by row probes. */
export type ObservedLink = {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
  foreignKey: false;
  /** Candidate-estate rows whose link resolves to a live parent row. */
  matchedRows: number;
  evidence: string;
};

/** The value-level links one candidate participates in, probe-confirmed. */
export type EvaluationObservedLink = {
  link: string;
  matchedRecords: { table: string; recordId: string }[];
};

/** The full association and cascade verdict for one 21.2 candidate. */
export type CandidateRelationEvaluation = {
  table: string;
  recordId: string;
  externalCustomerId: string | null;
  /** Parent rows this record references through live FKs. */
  outgoingReferences: RelationReference[];
  /** Child rows referencing this record through live FKs. */
  incomingReferences: RelationReference[];
  observedLinks: EvaluationObservedLink[];
  /** Rows that would vanish with this record (transitive CASCADE closure). */
  cascadeDeletionScope: ScopeRow[];
  /** Rows a SET NULL edge would mutate (evidence pointer nulled), not delete. */
  setNullMutationScope: { table: string; recordId: string; column: string; class: RowClass }[];
  /** Rows whose RESTRICT/NO ACTION reference makes the deletion impossible while they stand. */
  blockedBy: ScopeRow[];
  /** The touched rows that must survive — non-empty exactly when the candidate is pulled. */
  retainedImpact: RetainedImpact[];
  /** Live external subscriptions this record's key carries (never auto-cancelled). */
  activeExternalSubscriptions: {
    externalSubscriptionId: string;
    status: string;
    planCode: string;
  }[];
  removed: boolean;
  removalReason: RemovalReason | null;
  evidence: string;
};

/** One pulled candidate, with the reason and impact a reviewer checks. */
export type RemovedCandidate = {
  table: string;
  recordId: string;
  reason: RemovalReason;
  evidence: string;
  retainedImpact: RetainedImpact[];
};

/** A live external subscription: listed for human confirmation, never auto-cancelled. */
export type ExternalActiveSubscription = {
  externalSubscriptionId: string;
  externalCustomerId: string;
  planCode: string;
  status: string;
  updatedAt: string;
  note: string;
};

/** An open gateway order: listed for human confirmation, never auto-closed. */
export type ExternalOpenOrder = {
  orderId: string;
  externalCustomerId: string | null;
  provider: string;
  planCode: string;
  amountCents: number;
  status: string;
  createdAt: string;
  evidence: string;
};

/** The relations manifest 21.4 (dry-run output and hash) consumes. */
export type CleanupRelationsManifest = {
  relationsVersion: 1;
  /** `current_database()` — the database the evidence was read from. */
  database: string;
  schema: string;
  generatedAt: string;
  /** The classification this evaluation consumed, identified for the review trail. */
  basis: {
    classificationVersion: 1;
    classificationDatabase: string;
    classificationGeneratedAt: string;
    evidenceSha256: string;
    candidatesIn: number;
  };
  fkEdges: RelationFkEdge[];
  observedLinks: ObservedLink[];
  evaluations: CandidateRelationEvaluation[];
  /** The candidates that survive evaluation — the set 21.4 may dry-run. */
  safeCandidates: { table: string; recordId: string }[];
  removedCandidates: RemovedCandidate[];
  externalActiveSubscriptions: ExternalActiveSubscription[];
  externalOpenOrders: ExternalOpenOrder[];
  summary: {
    candidatesIn: number;
    safeCandidates: number;
    removedCandidates: number;
    byReason: Record<RemovalReason, number>;
    externalActiveSubscriptions: number;
    externalOpenOrders: number;
    fkEdges: number;
    declarationMismatches: number;
  };
};

/** A drizzle transaction, typed the way the repo types transaction callbacks. */
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The legacy tables, in 21.2's fixed order — the probe universe. */
const TABLE_ORDER = [
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

type TableSpec = {
  /** The column the classification's recordId names. */
  idColumn: string;
  /** The columns a probe of this table must return for traversal and live-state reads. */
  columns: string[];
};

const TABLE_SPECS: Record<string, TableSpec> = {
  billing_customers: { idColumn: "external_id", columns: ["external_id"] },
  payer_accounts: { idColumn: "id", columns: ["id", "external_customer_id"] },
  billing_subscriptions: {
    idColumn: "external_subscription_id",
    columns: ["external_subscription_id", "external_customer_id", "status"],
  },
  billing_webhook_events: {
    idColumn: "event_id",
    columns: ["event_id", "object_id"],
  },
  credit_grants: { idColumn: "id", columns: ["id", "external_customer_id"] },
  credit_ledger: {
    idColumn: "id",
    columns: ["id", "external_customer_id", "grant_id"],
  },
  credit_reservations: {
    idColumn: "id",
    columns: ["id", "external_customer_id", "ledger_id", "status"],
  },
  credit_reservation_allocations: {
    idColumn: "id",
    columns: ["id", "reservation_id", "grant_id"],
  },
  credit_charge_remainders: {
    idColumn: "external_customer_id",
    columns: ["external_customer_id"],
  },
  payment_orders: {
    idColumn: "id",
    columns: ["id", "status", "provider", "plan_code", "amount_cents", "created_at"],
  },
  payment_events: { idColumn: "id", columns: ["id", "order_id"] },
  usage_outbox: {
    idColumn: "event_id",
    columns: ["event_id", "external_customer_id", "reservation_id"],
  },
  // One hop beyond the estate, added by migration 0145 (#263): the attribution row every
  // protocol reserve writes under its hold. It is not a legacy billing table (the
  // classification never names it), but its CASCADE edge into credit_reservations is an edge
  // a candidate's deletion can travel, so the probe universe must know the child — a probe
  // spec entry, not an estate membership (21.5's estate wall stays closed to it).
  credit_reservation_attribution: {
    idColumn: "reservation_id",
    columns: ["reservation_id", "grant_id", "bot_id"],
  },
  // Same shape, added by migration 0147 (#276): 08.1's recovery item, the discovery row the
  // recovery scan writes under an unknown-result hold. Its CASCADE edge into
  // credit_reservations is an endangerment path like any other — deleting a hold must not
  // silently take its recovery item with it while recovery handlers still reference it —
  // so the probe universe knows the child here too.
  credit_recovery_items: {
    idColumn: "id",
    columns: ["id", "reservation_id", "state"],
  },
};

/** The FK edges the drizzle schema declares among the legacy tables: the comparison basis. */
const DECLARED_EDGES: {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
  onDelete: RelationFkEdge["onDelete"];
}[] = [
  { childTable: "payer_accounts", childColumn: "external_customer_id", parentTable: "billing_customers", parentColumn: "external_id", onDelete: "cascade" },
  { childTable: "billing_subscriptions", childColumn: "external_customer_id", parentTable: "billing_customers", parentColumn: "external_id", onDelete: "cascade" },
  { childTable: "credit_grants", childColumn: "external_customer_id", parentTable: "billing_customers", parentColumn: "external_id", onDelete: "cascade" },
  { childTable: "credit_ledger", childColumn: "external_customer_id", parentTable: "billing_customers", parentColumn: "external_id", onDelete: "cascade" },
  { childTable: "credit_ledger", childColumn: "grant_id", parentTable: "credit_grants", parentColumn: "id", onDelete: "set_null" },
  { childTable: "credit_reservations", childColumn: "external_customer_id", parentTable: "billing_customers", parentColumn: "external_id", onDelete: "cascade" },
  { childTable: "credit_reservations", childColumn: "ledger_id", parentTable: "credit_ledger", parentColumn: "id", onDelete: "set_null" },
  { childTable: "credit_reservation_allocations", childColumn: "reservation_id", parentTable: "credit_reservations", parentColumn: "id", onDelete: "cascade" },
  { childTable: "credit_reservation_allocations", childColumn: "grant_id", parentTable: "credit_grants", parentColumn: "id", onDelete: "cascade" },
  { childTable: "credit_charge_remainders", childColumn: "external_customer_id", parentTable: "billing_customers", parentColumn: "external_id", onDelete: "cascade" },
  { childTable: "payment_events", childColumn: "order_id", parentTable: "payment_orders", parentColumn: "id", onDelete: "cascade" },
  { childTable: "credit_reservation_attribution", childColumn: "reservation_id", parentTable: "credit_reservations", parentColumn: "id", onDelete: "cascade" },
  // 0147 (#276): 08.1's recovery item, the same one-hop shape as the attribution row above.
  { childTable: "credit_recovery_items", childColumn: "reservation_id", parentTable: "credit_reservations", parentColumn: "id", onDelete: "cascade" },
];

const ON_DELETE_BY_CODE: Record<string, RelationFkEdge["onDelete"]> = {
  c: "cascade",
  n: "set_null",
  r: "restrict",
  a: "no_action",
  d: "set_default",
};

const KEEP_CLASSES: ReadonlySet<RowClass> = new Set<RowClass>([
  "company_history",
  "personal_records",
  "unknown_owner",
]);

/** A probed legacy row: its identity and the columns traversal needs. */
type ProbeRow = {
  table: string;
  recordId: string;
  cols: Record<string, string | null>;
};

const rowKey = (table: string, recordId: string) => `${table}/${recordId}`;

/** One row probe: the named columns of every row of `table` whose `whereColumn` equals `value`. */
async function probeRows(
  tx: Transaction,
  table: string,
  whereColumn: string,
  value: string,
): Promise<ProbeRow[]> {
  const spec = TABLE_SPECS[table];
  if (!spec) throw new Error(`no probe spec for legacy table ${table}`);
  const rows = await tx.execute<Record<string, unknown>>(
    sql`SELECT ${sql.join(
      spec.columns.map((column) => sql.identifier(column)),
      sql`, `,
    )}
      FROM ${sql.identifier(table)}
      WHERE ${sql.identifier(whereColumn)} = ${value}`,
  );
  return rows.map((row) => ({
    table,
    recordId: String(row[spec.idColumn]),
    cols: Object.fromEntries(
      spec.columns.map((column) => [
        column,
        row[column] === null || row[column] === undefined
          ? null
          : String(row[column]),
      ]),
    ),
  }));
}

/** Deterministic sort: 21.2's table order, then record id. */
function byTableOrderThenId(
  a: { table: string; recordId: string },
  b: { table: string; recordId: string },
) {
  return (
    TABLE_ORDER.indexOf(a.table as (typeof TABLE_ORDER)[number]) -
      TABLE_ORDER.indexOf(b.table as (typeof TABLE_ORDER)[number]) ||
    (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0)
  );
}

/**
 * Map every 21.2 cleanup candidate's associations and cascade reach, pull the candidates
 * whose deletion would touch a kept record, and list the live external anchors. Read-only by
 * construction: one READ ONLY, REPEATABLE READ transaction.
 */
export async function evaluateCleanupRelations(
  database: Database,
  classification: CleanupClassification,
): Promise<CleanupRelationsManifest> {
  // The classification's tables must all be tables this module knows how to probe; a
  // classification covering an unknown table means the two contracts have drifted.
  const classifiedTables = new Set(classification.records.map((r) => r.table));
  const unknown = [...classifiedTables].filter(
    (table) => !TABLE_SPECS[table],
  );
  if (unknown.length > 0) {
    throw new Error(
      `classification covers tables this evaluation cannot probe: [${unknown.join(", ")}] — reconcile the two contracts before evaluating relations.`,
    );
  }

  return database.transaction(async (tx) => {
    // The read-only fence: the database refuses every write in this transaction, so the
    // evaluation cannot mutate the data its evidence describes. REPEATABLE READ pins every
    // read to one snapshot, so edges, rows and anchors answer one moment.
    await tx.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
    );

    const identity = await tx.execute<{ database: string; schema: string }>(
      sql`SELECT current_database() AS database, current_schema() AS schema`,
    );

    // --- The FK graph, from the live catalog: every edge whose child OR parent is a legacy
    // table, whatever the counterpart is (an edge out of the estate is still an edge the
    // cascade can travel). Compared against the declaration; mismatches are findings.
    type CatalogEdge = {
      childTable: string;
      childColumn: string;
      parentTable: string;
      parentColumn: string;
      constraintName: string;
      onDelete: RelationFkEdge["onDelete"];
    };
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
        AND (child.relname = ANY(${sql.raw(
          `ARRAY[${TABLE_ORDER.map((t) => `'${t}'`).join(",")}]`,
        )})
          OR parent.relname = ANY(${sql.raw(
            `ARRAY[${TABLE_ORDER.map((t) => `'${t}'`).join(",")}]`,
          )}))
      ORDER BY child.relname, parent.relname, ck.ord
    `);
    const edges: CatalogEdge[] = catalogRows.map((row) => ({
      childTable: row.child_table,
      childColumn: row.child_column,
      parentTable: row.parent_table,
      parentColumn: row.parent_column,
      constraintName: row.constraint_name,
      // confdeltype is one of a/c/n/d/r; an unknown code would be a PostgreSQL the
      // declaration set has never met — surface it as a finding, not a guess.
      onDelete:
        ON_DELETE_BY_CODE[row.on_delete] ??
        (() => {
          throw new Error(
            `unknown confdeltype ${row.on_delete} on constraint ${row.constraint_name}`,
          );
        })(),
    }));

    const fkEdges: RelationFkEdge[] = [];
    for (const edge of edges) {
      // Data evidence for the edge itself: how many child rows actually ride it.
      const count = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n
        FROM ${sql.identifier(edge.childTable)}
        JOIN ${sql.identifier(edge.parentTable)}
          ON ${sql.identifier(edge.parentTable)}.${sql.identifier(edge.parentColumn)}
           = ${sql.identifier(edge.childTable)}.${sql.identifier(edge.childColumn)}
      `);
      const declared = DECLARED_EDGES.find(
        (candidate) =>
          candidate.childTable === edge.childTable &&
          candidate.childColumn === edge.childColumn &&
          candidate.parentTable === edge.parentTable &&
          candidate.parentColumn === edge.parentColumn &&
          candidate.onDelete === edge.onDelete,
      );
      fkEdges.push({
        ...edge,
        matchesDeclaration: declared !== undefined,
        evidence: `pg_constraint constraint ${edge.constraintName}: ${edge.childTable}.${edge.childColumn} -> ${edge.parentTable}.${edge.parentColumn} on delete ${edge.onDelete}; ${count[0].n} child rows ride it in the current data`,
      });
    }
    const declarationMismatches = fkEdges.filter(
      (edge) => !edge.matchesDeclaration,
    ).length;

    // --- Live state the classification's per-record verdicts are combined with: reservation
    // statuses (in-flight duty is live data, not manifest data), allocation parents, live
    // subscriptions, and the order rows' own status.
    const reservationStatus = new Map<string, string>();
    for (const row of await tx.execute<{ id: string; status: string }>(
      sql`SELECT id, status FROM ${sql.identifier("credit_reservations")}`,
    )) {
      reservationStatus.set(row.id, row.status);
    }
    const allocationReservation = new Map<string, string>();
    for (const row of await tx.execute<{ id: string; reservation_id: string }>(
      sql`SELECT id, reservation_id FROM ${sql.identifier("credit_reservation_allocations")}`,
    )) {
      allocationReservation.set(row.id, row.reservation_id);
    }
    const liveSubscriptions = await tx.execute<{
      external_subscription_id: string;
      external_customer_id: string;
      plan_code: string;
      status: string;
      updated_at: Date;
    }>(sql`SELECT external_subscription_id, external_customer_id, plan_code, status, updated_at
           FROM ${sql.identifier("billing_subscriptions")}
           WHERE status = ANY(${sql.raw(
             `ARRAY[${EXTERNAL_LIVE_SUBSCRIPTION_STATUSES.map((s) => `'${s}'`).join(",")}]`,
           )})`);
    const liveSubscriptionIds = new Set(
      liveSubscriptions.map((row) => row.external_subscription_id),
    );
    const orderRows = await tx.execute<{
      id: string;
      status: string;
      provider: string;
      plan_code: string;
      amount_cents: number;
      created_at: Date;
    }>(sql`SELECT id, status, provider, plan_code, amount_cents, created_at
           FROM ${sql.identifier("payment_orders")}`);
    const orderRowById = new Map(orderRows.map((row) => [row.id, row]));

    // --- The candidates, verified against the data: a candidate the data no longer holds is
    // drift between the classification snapshot and now, and refusing beats guessing.
    const recordClassByKey = new Map<string, CleanupRecordClass>();
    for (const record of classification.records) {
      recordClassByKey.set(rowKey(record.table, record.recordId), record.class);
    }
    type Candidate = {
      table: string;
      recordId: string;
      externalCustomerId: string | null;
      row: ProbeRow;
    };
    const candidates: Candidate[] = [];
    for (const record of classification.candidates) {
      const spec = TABLE_SPECS[record.table];
      const found = await probeRows(
        tx,
        record.table,
        spec.idColumn,
        record.recordId,
      );
      if (found.length === 0) {
        throw new Error(
          `classification candidate ${rowKey(record.table, record.recordId)} no longer exists in the data; the classification and the data have drifted — regenerate the classification before evaluating relations.`,
        );
      }
      candidates.push({
        table: record.table,
        recordId: record.recordId,
        externalCustomerId: record.externalCustomerId,
        row: found[0],
      });
    }
    const candidateByKey = new Map(candidates.map((c) => [rowKey(c.table, c.recordId), c]));

    const classOf = (row: ProbeRow): RowClass =>
      recordClassByKey.get(rowKey(row.table, row.recordId)) ?? "unclassified";

    /** Live in-flight duty: a reserved or unknown-result hold (06.8), or an allocation of one. */
    const isLiveInFlight = (row: ProbeRow) => {
      if (row.table === "credit_reservations") {
        return isReservationInFlight(reservationStatus.get(row.recordId) ?? "");
      }
      if (row.table === "credit_reservation_allocations") {
        return isReservationInFlight(
          reservationStatus.get(allocationReservation.get(row.recordId) ?? "") ?? "",
        );
      }
      return false;
    };

    /** The closure a deletion of `root` takes with it, its SET NULL mutations and its blockers. */
    async function deletionReach(root: ProbeRow) {
      const visited = new Set<string>([rowKey(root.table, root.recordId)]);
      const closure: ProbeRow[] = [];
      // Pass 1: CASCADE edges, transitively — these rows vanish with the root.
      const frontier: ProbeRow[] = [root];
      while (frontier.length > 0) {
        const row = frontier.pop();
        if (!row) break;
        for (const edge of edges) {
          if (edge.parentTable !== row.table || edge.onDelete !== "cascade") continue;
          const parentValue = row.cols[edge.parentColumn];
          if (parentValue === null || parentValue === undefined) continue;
          for (const childRow of await probeRows(
            tx,
            edge.childTable,
            edge.childColumn,
            parentValue,
          )) {
            const key = rowKey(childRow.table, childRow.recordId);
            if (visited.has(key)) continue;
            visited.add(key);
            closure.push(childRow);
            frontier.push(childRow);
          }
        }
      }
      // Pass 2: SET NULL edges from the deleted set — the referencing rows survive, their
      // evidence pointer does not. Moot for rows the closure already deletes.
      const mutations: { row: ProbeRow; column: string }[] = [];
      for (const deleted of [root, ...closure]) {
        for (const edge of edges) {
          if (edge.parentTable !== deleted.table || edge.onDelete !== "set_null") continue;
          const parentValue = deleted.cols[edge.parentColumn];
          if (parentValue === null || parentValue === undefined) continue;
          for (const childRow of await probeRows(
            tx,
            edge.childTable,
            edge.childColumn,
            parentValue,
          )) {
            const key = rowKey(childRow.table, childRow.recordId);
            if (visited.has(key)) continue;
            visited.add(key);
            mutations.push({ row: childRow, column: edge.childColumn });
          }
        }
      }
      // Pass 3: RESTRICT / NO ACTION references — the deletion cannot happen while they stand.
      const blocked: ProbeRow[] = [];
      for (const deleted of [root, ...closure]) {
        for (const edge of edges) {
          if (
            edge.parentTable !== deleted.table ||
            (edge.onDelete !== "restrict" && edge.onDelete !== "no_action")
          ) {
            continue;
          }
          const parentValue = deleted.cols[edge.parentColumn];
          if (parentValue === null || parentValue === undefined) continue;
          for (const childRow of await probeRows(
            tx,
            edge.childTable,
            edge.childColumn,
            parentValue,
          )) {
            const key = rowKey(childRow.table, childRow.recordId);
            if (visited.has(key)) continue;
            visited.add(key);
            blocked.push(childRow);
          }
        }
      }
      return { closure, mutations, blocked };
    }

    // --- Anchors first: the external associations whose local rows must survive until a
    // human confirms. A live subscription row; a pending order row. Their cascade subtrees
    // (the rows that would vanish with them) ride along — an event is part of its order.
    const anchorReasonByKey = new Map<string, RemovalReason>();
    const anchorEvidenceByKey = new Map<string, string>();
    for (const candidate of candidates) {
      if (
        candidate.table === "billing_subscriptions" &&
        liveSubscriptionIds.has(candidate.recordId)
      ) {
        anchorReasonByKey.set(
          rowKey(candidate.table, candidate.recordId),
          "external_subscription_anchor",
        );
        anchorEvidenceByKey.set(
          rowKey(candidate.table, candidate.recordId),
          `billing_subscriptions ${candidate.recordId} is ${liveSubscriptions.find((s) => s.external_subscription_id === candidate.recordId)?.status} at the external payment gateway: never auto-cancelled, held for manual confirmation (Q28/Q29)`,
        );
      }
      if (
        candidate.table === "payment_orders" &&
        orderRowById.get(candidate.recordId)?.status === "pending"
      ) {
        anchorReasonByKey.set(
          rowKey(candidate.table, candidate.recordId),
          "external_payment_order_open",
        );
        anchorEvidenceByKey.set(
          rowKey(candidate.table, candidate.recordId),
          `payment_orders ${candidate.recordId} is pending at the payment channel: the channel can still report payment against it, so it is held for manual confirmation, never auto-closed (Q28)`,
        );
      }
    }
    // Anchor subtrees: candidate rows inside an anchor's cascade closure are pulled with it.
    for (const candidate of candidates) {
      const key = rowKey(candidate.table, candidate.recordId);
      const reason = anchorReasonByKey.get(key);
      if (!reason) continue;
      const { closure } = await deletionReach(candidate.row);
      for (const row of closure) {
        const rowKeyStr = rowKey(row.table, row.recordId);
        if (!candidateByKey.has(rowKeyStr)) continue;
        if (anchorReasonByKey.has(rowKeyStr)) continue;
        anchorReasonByKey.set(rowKeyStr, reason);
        anchorEvidenceByKey.set(
          rowKeyStr,
          `${row.table} ${row.recordId} rides in the cascade subtree of the external anchor ${candidate.table} ${candidate.recordId} and is held with it: ${anchorEvidenceByKey.get(key)}`,
        );
      }
    }

    // --- The mapping rule: a payer_accounts candidate whose key still keeps any protected
    // record is that key's attribution evidence (Q29: a kept quarantine must stay
    // explicable). Pulled before the cascade checks, so the kept mapping then protects
    // itself against other candidates' cascades (a customer row cascading into it).
    const mappingKeptIds = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.table !== "payer_accounts") continue;
      const key = candidate.externalCustomerId ?? candidate.row.cols.external_customer_id;
      if (!key) continue;
      const kept = classification.records.filter(
        (record) =>
          record.externalCustomerId === key &&
          !(
            record.table === "payer_accounts" &&
            record.recordId === candidate.recordId
          ) &&
          (KEEP_CLASSES.has(record.class) ||
            anchorReasonByKey.has(rowKey(record.table, record.recordId))),
      );
      if (kept.length > 0) {
        mappingKeptIds.add(rowKey(candidate.table, candidate.recordId));
      }
    }

    /** Why a touched row is untouchable — or null when it is itself cleanable. */
    const protectionOf = (row: ProbeRow): ProtectionKind | null => {
      const key = rowKey(row.table, row.recordId);
      if (anchorReasonByKey.has(key)) {
        return anchorReasonByKey.get(key) === "external_subscription_anchor"
          ? "external_subscription_anchor"
          : "external_payment_order_open";
      }
      if (mappingKeptIds.has(key)) return "attribution_kept";
      if (KEEP_CLASSES.has(classOf(row)) || isLiveInFlight(row)) return "retained";
      return null;
    };

    // --- Per-candidate evaluation, in the classification's deterministic order.
    const evaluations: CandidateRelationEvaluation[] = [];
    const removedCandidates: RemovedCandidate[] = [];
    for (const candidate of candidates) {
      const key = rowKey(candidate.table, candidate.recordId);

      // Outgoing references: the parent rows this record's FKs land on, probed.
      const outgoingReferences: RelationReference[] = [];
      for (const edge of edges) {
        if (edge.childTable !== candidate.table) continue;
        const value = candidate.row.cols[edge.childColumn];
        if (value === null || value === undefined) continue;
        for (const parentRow of await probeRows(
          tx,
          edge.parentTable,
          edge.parentColumn,
          value,
        )) {
          outgoingReferences.push({
            table: parentRow.table,
            recordId: parentRow.recordId,
            via: `${edge.childTable}.${edge.childColumn} -> ${edge.parentTable}.${edge.parentColumn} (${edge.constraintName})`,
            class: classOf(parentRow),
          });
        }
      }
      outgoingReferences.sort(
        (a, b) =>
          TABLE_ORDER.indexOf(a.table as (typeof TABLE_ORDER)[number]) -
            TABLE_ORDER.indexOf(b.table as (typeof TABLE_ORDER)[number]) ||
          (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0),
      );

      // Incoming references: the child rows that point at this record, probed.
      const incomingReferences: RelationReference[] = [];
      for (const edge of edges) {
        if (edge.parentTable !== candidate.table) continue;
        const value = candidate.row.cols[edge.parentColumn];
        if (value === null || value === undefined) continue;
        for (const childRow of await probeRows(
          tx,
          edge.childTable,
          edge.childColumn,
          value,
        )) {
          incomingReferences.push({
            table: childRow.table,
            recordId: childRow.recordId,
            via: `${edge.childTable}.${edge.childColumn} -> ${edge.parentTable}.${edge.parentColumn} (${edge.constraintName})`,
            class: classOf(childRow),
          });
        }
      }
      incomingReferences.sort(
        (a, b) =>
          TABLE_ORDER.indexOf(a.table as (typeof TABLE_ORDER)[number]) -
            TABLE_ORDER.indexOf(b.table as (typeof TABLE_ORDER)[number]) ||
          (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0),
      );

      // Value-level links: the linkages no FK carries, probed so the manifest can state
      // that deletion does NOT travel them.
      const observedLinks: EvaluationObservedLink[] = [];
      if (candidate.table === "usage_outbox") {
        const customerKey = candidate.row.cols.external_customer_id;
        if (customerKey) {
          const customers = await probeRows(
            tx,
            "billing_customers",
            "external_id",
            customerKey,
          );
          observedLinks.push({
            link: "usage_outbox.external_customer_id -> billing_customers.external_id (no FK: deletion does not travel this link)",
            matchedRecords: customers.map((row) => ({
              table: row.table,
              recordId: row.recordId,
            })),
          });
        }
        const reservationId = candidate.row.cols.reservation_id;
        if (reservationId) {
          const reservations = await probeRows(
            tx,
            "credit_reservations",
            "id",
            reservationId,
          );
          observedLinks.push({
            link: "usage_outbox.reservation_id -> credit_reservations.id (no FK: deletion does not travel this link)",
            matchedRecords: reservations.map((row) => ({
              table: row.table,
              recordId: row.recordId,
            })),
          });
        }
      }
      if (candidate.table === "billing_webhook_events") {
        const objectId = candidate.row.cols.object_id;
        if (objectId) {
          const subscriptions = await probeRows(
            tx,
            "billing_subscriptions",
            "external_subscription_id",
            objectId,
          );
          observedLinks.push({
            link: `billing_webhook_events.object_id -> billing_subscriptions.external_subscription_id (no FK: ${subscriptions.length === 0 ? "resolves to nothing in the data" : "deletion does not travel this link"})`,
            matchedRecords: subscriptions.map((row) => ({
              table: row.table,
              recordId: row.recordId,
            })),
          });
        }
      }
      if (candidate.table === "payment_orders") {
        const grants = await probeRows(
          tx,
          "credit_grants",
          "idempotency_key",
          `plan:${candidate.recordId}`,
        );
        if (grants.length > 0) {
          observedLinks.push({
            link: "payment_orders.id -> credit_grants.idempotency_key 'plan:<orderId>' (no FK: the payout-grant attribution linkage)",
            matchedRecords: grants.map((row) => ({
              table: row.table,
              recordId: row.recordId,
            })),
          });
        }
      }

      // The cascade reach, and the impact the protected rows turn it into.
      const { closure, mutations, blocked } = await deletionReach(candidate.row);
      const retainedImpact: RetainedImpact[] = [];
      for (const row of closure) {
        const protection = protectionOf(row);
        if (protection) {
          retainedImpact.push({
            table: row.table,
            recordId: row.recordId,
            effect: "cascade_delete",
            protection,
            class: classOf(row),
          });
        }
      }
      for (const mutation of mutations) {
        const protection = protectionOf(mutation.row);
        if (protection) {
          retainedImpact.push({
            table: mutation.row.table,
            recordId: mutation.row.recordId,
            effect: "set_null_mutate",
            protection,
            class: classOf(mutation.row),
          });
        }
      }
      for (const row of blocked) {
        const protection = protectionOf(row);
        if (protection) {
          retainedImpact.push({
            table: row.table,
            recordId: row.recordId,
            effect: "delete_blocked",
            protection,
            class: classOf(row),
          });
        }
      }
      retainedImpact.sort(
        (a, b) =>
          TABLE_ORDER.indexOf(a.table as (typeof TABLE_ORDER)[number]) -
            TABLE_ORDER.indexOf(b.table as (typeof TABLE_ORDER)[number]) ||
          (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0),
      );

      // The key's live external subscriptions, for the per-record association view.
      const candidateCustomerKey =
        candidate.externalCustomerId ?? candidate.row.cols.external_customer_id;
      const activeExternalSubscriptions = liveSubscriptions
        .filter((row) => row.external_customer_id === candidateCustomerKey)
        .map((row) => ({
          externalSubscriptionId: row.external_subscription_id,
          status: row.status,
          planCode: row.plan_code,
        }))
        .sort((a, b) => (a.externalSubscriptionId < b.externalSubscriptionId ? -1 : 1));

      // The verdict, in the ticket's order: external anchors first, then the cascade rule,
      // then the mapping-evidence rule, then blocked deletions.
      const anchorReason = anchorReasonByKey.get(key);
      let removalReason: RemovalReason | null = null;
      let evidence: string;
      if (anchorReason) {
        removalReason = anchorReason;
        evidence = anchorEvidenceByKey.get(key) ?? anchorReason;
      } else if (retainedImpact.length > 0) {
        removalReason = "cascade_impact_on_retained";
        evidence = `deleting ${candidate.table} ${candidate.recordId} would reach ${retainedImpact.length} protected row(s): ${retainedImpact
          .map(
            (impact) =>
              `${impact.effect} ${impact.table}/${impact.recordId} (${impact.protection})`,
          )
          .join("; ")}`;
      } else if (mappingKeptIds.has(key)) {
        removalReason = "attribution_basis_of_kept_records";
        const keptKey = candidate.row.cols.external_customer_id;
        const kept = classification.records.filter(
          (record) =>
            record.externalCustomerId === keptKey &&
            !(
              record.table === "payer_accounts" &&
              record.recordId === candidate.recordId
            ) &&
            (KEEP_CLASSES.has(record.class) ||
              anchorReasonByKey.has(rowKey(record.table, record.recordId))),
        );
        evidence = `payer_accounts ${candidate.recordId} is the attribution evidence the kept records of key ${keptKey} cite (${kept
          .map((record) => `${record.table}/${record.recordId}`)
          .join(", ")}); deleting it would leave the kept quarantine unexplicable (Q29)`;
      } else {
        evidence = `deleting ${candidate.table} ${candidate.recordId} reaches only cleanable rows: ${closure.length} in the cascade scope, ${mutations.length} SET NULL mutations of cleanable rows, ${blocked.length} blocked references — no protected row touched`;
        if (incomingReferences.length > 0) {
          evidence += `; children to delete first: ${incomingReferences
            .map((reference) => `${reference.table}/${reference.recordId}`)
            .join(", ")}`;
        }
      }

      const evaluation: CandidateRelationEvaluation = {
        table: candidate.table,
        recordId: candidate.recordId,
        externalCustomerId: candidate.externalCustomerId,
        outgoingReferences,
        incomingReferences,
        observedLinks,
        cascadeDeletionScope: closure
          .map((row) => ({
            table: row.table,
            recordId: row.recordId,
            class: classOf(row),
          }))
          .sort(byTableOrderThenId),
        setNullMutationScope: mutations
          .map((mutation) => ({
            table: mutation.row.table,
            recordId: mutation.row.recordId,
            column: mutation.column,
            class: classOf(mutation.row),
          }))
          .sort(byTableOrderThenId),
        blockedBy: blocked
          .map((row) => ({
            table: row.table,
            recordId: row.recordId,
            class: classOf(row),
          }))
          .sort(byTableOrderThenId),
        retainedImpact,
        activeExternalSubscriptions,
        removed: removalReason !== null,
        removalReason,
        evidence,
      };
      evaluations.push(evaluation);
      if (removalReason) {
        removedCandidates.push({
          table: candidate.table,
          recordId: candidate.recordId,
          reason: removalReason,
          evidence,
          retainedImpact,
        });
      }
    }

    // --- The value-level link summary across the candidate estate.
    const candidateOutboxKeys = new Set(
      candidates
        .filter((candidate) => candidate.table === "usage_outbox")
        .map((candidate) => candidate.row.cols.external_customer_id)
        .filter((key): key is string => key !== null && key !== undefined),
    );
    let outboxLinkMatched = 0;
    for (const key of candidateOutboxKeys) {
      if (
        (await probeRows(tx, "billing_customers", "external_id", key)).length > 0
      ) {
        outboxLinkMatched += 1;
      }
    }
    const candidateWebhookCount = candidates.filter(
      (candidate) => candidate.table === "billing_webhook_events",
    ).length;
    const candidateOrderPlanGrants = candidates.filter(
      (candidate) => candidate.table === "payment_orders",
    ).length;
    const observedLinks: ObservedLink[] = [
      {
        childTable: "usage_outbox",
        childColumn: "external_customer_id",
        parentTable: "billing_customers",
        parentColumn: "external_id",
        foreignKey: false,
        matchedRows: outboxLinkMatched,
        evidence:
          "the outbox carries the customer key by VALUE: deleting the customer does not remove these rows, they are independent candidates deleted by their own id",
      },
      {
        childTable: "billing_webhook_events",
        childColumn: "object_id",
        parentTable: "billing_subscriptions",
        parentColumn: "external_subscription_id",
        foreignKey: false,
        matchedRows: candidateWebhookCount,
        evidence:
          "the webhook inbox links to subscriptions by VALUE: no FK protects or travels this link in either direction",
      },
      {
        childTable: "payment_orders",
        childColumn: "id (as 'plan:<orderId>' idempotency key)",
        parentTable: "credit_grants",
        parentColumn: "idempotency_key",
        foreignKey: false,
        matchedRows: candidateOrderPlanGrants,
        evidence:
          "an order's payout-grant attribution linkage: value-level, no FK; probed per candidate order in the evaluations",
      },
    ];

    // --- The manifest, deterministic: classification order in, classification order out.
    const safeCandidates = evaluations
      .filter((evaluation) => !evaluation.removed)
      .map((evaluation) => ({
        table: evaluation.table,
        recordId: evaluation.recordId,
      }));
    const byReason = Object.fromEntries(
      (
        [
          "cascade_impact_on_retained",
          "external_subscription_anchor",
          "external_payment_order_open",
          "attribution_basis_of_kept_records",
          "deletion_blocked_by_retained_reference",
        ] as const
      ).map((reason) => [
        reason,
        removedCandidates.filter((removed) => removed.reason === reason).length,
      ]),
    ) as Record<RemovalReason, number>;

    const externalActiveSubscriptions: ExternalActiveSubscription[] =
      liveSubscriptions
        .filter((row) =>
          candidates.some(
            (candidate) =>
              candidate.table === "billing_subscriptions" &&
              candidate.recordId === row.external_subscription_id,
          ),
        )
        .map((row) => ({
          externalSubscriptionId: row.external_subscription_id,
          externalCustomerId: row.external_customer_id,
          planCode: row.plan_code,
          status: row.status,
          updatedAt: row.updated_at.toISOString(),
          note: "live at the external payment gateway: never auto-cancelled, manual confirmation required before any disposition (Q28/Q29)",
        }))
        .sort((a, b) =>
          a.externalSubscriptionId < b.externalSubscriptionId ? -1 : 1,
        );

    const externalOpenOrders: ExternalOpenOrder[] = candidates
      .filter(
        (candidate) =>
          candidate.table === "payment_orders" &&
          anchorReasonByKey.get(rowKey(candidate.table, candidate.recordId)) ===
            "external_payment_order_open",
      )
      .map((candidate) => {
        const orderRow = orderRowById.get(candidate.recordId);
        if (!orderRow) {
          throw new Error(
            `pending order ${candidate.recordId} vanished from payment_orders mid-evaluation`,
          );
        }
        return {
          orderId: candidate.recordId,
          externalCustomerId: candidate.externalCustomerId,
          provider: orderRow.provider,
          planCode: orderRow.plan_code,
          amountCents: orderRow.amount_cents,
          status: orderRow.status,
          createdAt: orderRow.created_at.toISOString(),
          evidence:
            anchorEvidenceByKey.get(rowKey(candidate.table, candidate.recordId)) ??
            "pending at the payment channel: held for manual confirmation",
        };
      })
      .sort((a, b) => (a.orderId < b.orderId ? -1 : 1));

    return {
      relationsVersion: 1,
      database: identity[0].database,
      schema: identity[0].schema,
      generatedAt: new Date().toISOString(),
      basis: {
        classificationVersion: classification.classificationVersion,
        classificationDatabase: classification.database,
        classificationGeneratedAt: classification.generatedAt,
        evidenceSha256: classification.evidenceInput.sha256,
        candidatesIn: classification.candidates.length,
      },
      fkEdges: fkEdges.sort(
        (a, b) =>
          TABLE_ORDER.indexOf(a.childTable as (typeof TABLE_ORDER)[number]) -
            TABLE_ORDER.indexOf(b.childTable as (typeof TABLE_ORDER)[number]) ||
          TABLE_ORDER.indexOf(a.parentTable as (typeof TABLE_ORDER)[number]) -
            TABLE_ORDER.indexOf(b.parentTable as (typeof TABLE_ORDER)[number]) ||
          (a.childColumn < b.childColumn ? -1 : 1),
      ),
      observedLinks,
      evaluations,
      safeCandidates,
      removedCandidates: removedCandidates.sort(byTableOrderThenId),
      externalActiveSubscriptions,
      externalOpenOrders,
      summary: {
        candidatesIn: classification.candidates.length,
        safeCandidates: safeCandidates.length,
        removedCandidates: removedCandidates.length,
        byReason,
        externalActiveSubscriptions: externalActiveSubscriptions.length,
        externalOpenOrders: externalOpenOrders.length,
        fkEdges: fkEdges.length,
        declarationMismatches,
      },
    };
  });
}

if (import.meta.main) {
  // Operator entry: `bun server/src/billing/cleanup-relations.ts [registries.json]` classifies
  // the deployment database DATABASE_URL names (with the test-evidence registries read from
  // the JSON file argument, defaulting to empty) and prints the relations manifest. Read-only
  // by construction — the evaluation runs inside its own READ ONLY transaction. Persisting
  // the manifest is saving this output; 21.4 hashes exactly this JSON.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL must point at the deployment database this evaluation should read.",
    );
  }
  const registryPath = process.argv[2];
  const registryInput: { testOrderIds: string[]; testUserIds: string[] } =
    registryPath
      ? await Bun.file(registryPath).json()
      : { testOrderIds: [], testUserIds: [] };
  const { createDatabase } = await import("../db/client");
  const databaseInstance = createDatabase(databaseUrl);
  try {
    const classification = await classifyCleanup(databaseInstance, registryInput);
    const manifest = await evaluateCleanupRelations(databaseInstance, classification);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    await databaseInstance.$client.end();
  }
}
