import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { ExportedRunRow } from "../../ai-observability/exports";
// The repo's single-serialization jsonb (m198): the artifact is the A11-verified
// deliverable — an array column, so the array variant.
import { jsonbArray } from "./json";

/**
 * The export job table (Issue #40 / DAG T34).
 *
 * One row is one bounded export of this scope's run observation data. The state
 * vocabulary is exactly queued/running/completed/failed/cancelled — the T10
 * discipline: a job ends only on an actual outcome, and an unknown stored value
 * is refused by the database, not mapped onto a guess.
 *
 * The security facts are database facts, not discipline:
 *
 *  - `artifact` may be non-null only on `completed`. A cancelled or failed job
 *    cannot carry a product: revocation lands by UPDATE alone, and the row the
 *    settle would write refuses it. This is the "产物不落盘" guarantee as a
 *    constraint, so no code path — present or future — can park an artifact on
 *    a job that was revoked.
 *  - `settled_at` is non-null exactly on the terminal states, so "terminal" is
 *    decidable from either column and the two cannot disagree.
 *  - `error_code` is non-null only on `failed`. A cancellation carries no
 *    reason: the cause is the revocation event, which the caller knows.
 *
 * `row_limit` snapshots the deployment's cap at enqueue time, so a later
 * configuration change never rewrites what an in-flight job promised. The
 * upstream locator columns are derived from the scope at enqueue (T06), never
 * accepted from a caller, and the worker re-derives the locator from live
 * authorization and refuses to run when the two disagree.
 */

export type AiObservationExportJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export const aiObservationExportJobs = pgTable(
  "ai_observation_export_jobs",
  {
    id: text("id").primaryKey(),
    /** The trusted scope's key. The job and its artifact live in this key space. */
    scopeKey: text("scope_key").notNull(),
    actorId: text("actor_id").notNull(),
    botId: text("bot_id").notNull(),
    state: text("state")
      .$type<AiObservationExportJobState>()
      .notNull()
      .default("queued"),
    /** The row cap this job was enqueued under. Exceeding it fails the job, never truncates. */
    rowLimit: integer("row_limit").notNull(),
    /** Rows in the artifact; set only on completion. */
    rowCount: integer("row_count"),
    /** Why a job failed. Null unless failed — a cancellation needs no reason. */
    errorCode: text("error_code"),
    /** The T05 policy the artifact was projected under, e.g. "opik-redaction/5". */
    redactionPolicyVersion: text("redaction_policy_version").notNull(),
    /** The projected rows. Non-null only on completed (check constraint). */
    artifact: jsonbArray("artifact").$type<readonly ExportedRunRow[]>(),
    /** Where this scope's records live upstream — derived from the scope, frozen at enqueue. */
    locatorWorkspace: text("locator_workspace").notNull(),
    locatorProject: text("locator_project").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** When the job reached its terminal state. Non-null exactly on terminal states. */
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "ai_observation_export_jobs_state_check",
      sql`${table.state} IN ('queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    check(
      "ai_observation_export_jobs_artifact_completed_check",
      sql`${table.artifact} IS NULL OR ${table.state} = 'completed'`,
    ),
    check(
      "ai_observation_export_jobs_error_failed_check",
      sql`${table.errorCode} IS NULL OR ${table.state} = 'failed'`,
    ),
    check(
      "ai_observation_export_jobs_settled_terminal_check",
      sql`(${table.settledAt} IS NULL AND ${table.state} IN ('queued', 'running')) OR (${table.settledAt} IS NOT NULL AND ${table.state} NOT IN ('queued', 'running'))`,
    ),
    check(
      "ai_observation_export_jobs_row_count_completed_check",
      sql`${table.rowCount} IS NULL OR ${table.state} = 'completed'`,
    ),
    check(
      "ai_observation_export_jobs_row_limit_positive_check",
      sql`${table.rowLimit} > 0`,
    ),
    // The scope's own listing read, newest first.
    index("ai_observation_export_jobs_scope_created_idx").on(
      table.scopeKey,
      table.createdAt,
    ),
    // The revocation seam: every not-yet-terminal job of one actor, found in one place.
    index("ai_observation_export_jobs_active_actor_idx")
      .on(table.actorId)
      .where(sql`${table.state} IN ('queued', 'running')`),
    // The export discovery predicate filters on settled_at, not created_at (m164):
    // the (scope_key, created_at) index does not serve it.
    index("ai_observation_export_jobs_settled_at_idx").on(table.settledAt),
  ],
);
