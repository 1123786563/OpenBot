import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { aiObservationExperimentExecutions } from "./ai-observability-executions";
// The repo's single-serialization jsonb (m192): drizzle's native jsonb double-encodes
// under the Bun SQL driver, landing jsonb_typeof = "string". dataType stays "jsonb".
import { jsonb } from "./json";

/**
 * The per-case write-ahead record of one execution (Issue #30 / DAG T24).
 *
 * One row is one case of one execution, and the row's life is the billing
 * promise: a case is marked `in_flight` BEFORE its model call — the write-ahead
 * marker — and its outcome lands afterwards in one conditional flip. A process
 * that dies mid-case leaves the marker behind, so whichever worker takes over
 * after the lease lapses finds `in_flight` and does NOT invoke again: an
 * outcome it cannot observe is recorded `unknown`, never re-spent. A case whose
 * row already carries a final status is skipped, so resuming an execution never
 * re-runs a completed sample. The insert conflicts on the primary key, which is
 * what makes "two workers, one case" a one-invocation fact rather than a hope.
 *
 * The status vocabulary is its own four words, deliberately not the execution
 * row's five: `in_flight` is the write-ahead marker only that table can carry,
 * and `unknown` is an ending the runner could not observe — the same honesty
 * word T23 gave case outcomes. `detail` holds the case's projected output and
 * usage envelopes — each projected once at record time with its own budget
 * (T28's result contract) — and may not exist on an `in_flight` row: a marker
 * carries nothing it has not learned yet.
 */
export type AiObservationCaseOutcomeStatus =
  | "in_flight"
  | "completed"
  | "failed"
  | "unknown";

export const aiObservationExecutionCaseOutcomes = pgTable(
  "ai_observation_execution_case_outcomes",
  {
    /** The execution this case belongs to. Rows die with it (cascade). */
    executionId: text("execution_id").notNull(),
    /** The case's position in the frozen dataset version. */
    caseIndex: integer("case_index").notNull(),
    /** The write-ahead marker or the final, observed status. */
    status: text("status").$type<AiObservationCaseOutcomeStatus>().notNull(),
    /** The projected outcome envelope; projected once at record time, stored as-is. */
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Explicit short names: both defaults land past Postgres' 63-byte identifier limit.
    foreignKey({
      name: "ai_observation_execution_case_outcomes_execution_id_fk",
      columns: [table.executionId],
      foreignColumns: [aiObservationExperimentExecutions.id],
    }).onDelete("cascade"),
    primaryKey({
      name: "ai_observation_execution_case_outcomes_pk",
      columns: [table.executionId, table.caseIndex],
    }),
    check(
      "ai_observation_execution_case_outcomes_status_check",
      sql`${table.status} IN ('in_flight', 'completed', 'failed', 'unknown')`,
    ),
    // The marker carries no detail: nothing has been observed while in flight.
    check(
      "ai_observation_execution_case_outcomes_detail_final_check",
      sql`${table.detail} IS NULL OR ${table.status} <> 'in_flight'`,
    ),
    // No secondary index: the primary key (execution_id, case_index) already serves
    // the one read this table ever gets — one execution's rows, in case order.
  ],
);
