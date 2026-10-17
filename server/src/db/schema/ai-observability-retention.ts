import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * The retention side of observation data (Issue #41 / DAG T35).
 *
 * Two tables, one per question:
 *
 *  - `ai_observation_retention_overrides` answers "how long does THIS scope keep its
 *    data": one row per scope key, one nullable day-count per category. Null is the
 *    honest "no opinion" — the deployment's global default (an env knob, not a row)
 *    answers, and coalesce is decided in the discovery query, never by writing the
 *    default into the row. An override row that overrides nothing is refused by
 *    check, so the table cannot accumulate noise that reads as policy.
 *
 *  - `ai_observation_retention_deletions` answers "what has retention decided to
 *    delete, and how far did it get". One row per (kind, target) — the unique index
 *    makes re-discovery of the same expired row a no-op, so a deletion is offered
 *    exactly once no matter how often discovery sweeps. The row carries everything
 *    a retry needs even after the target row is gone: the locator, the upstream
 *    reference, and the state machine (`pending` → `upstream_done` → `deleted`,
 *    with `failed` as the retryable parking state). A record only reaches
 *    `deleted` together with a `deleted_at`, so "terminal" is decidable from
 *    either column and the two cannot disagree — the T10 discipline.
 *
 * Nothing here holds content: ids, locators, day counts and a body-free error
 * code. The canary discipline is a fact of the columns — a deletion record has
 * nowhere to put a credential even if a code path tried.
 */

/** What a deletion record may target. The vocabulary of the cleanup surface. */
export type AiObservationDeletionKind =
  | "run"
  | "dataset"
  | "experiment"
  | "export";

/** The upstream thing a target names, when it has an upstream copy at all. */
export type AiObservationUpstreamKind = "trace" | "dataset";

export type AiObservationDeletionState =
  | "pending"
  | "upstream_done"
  | "deleted"
  | "failed";

export const aiObservationRetentionOverrides = pgTable(
  "ai_observation_retention_overrides",
  {
    /** The trusted scope's key. The override lives in this key space. */
    scopeKey: text("scope_key").primaryKey(),
    /** Days this scope keeps run bindings; null defers to the global default. */
    runsDays: integer("runs_days"),
    datasetsDays: integer("datasets_days"),
    experimentsDays: integer("experiments_days"),
    exportsDays: integer("exports_days"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "ai_observation_retention_overrides_runs_days_check",
      sql`${table.runsDays} IS NULL OR (${table.runsDays} >= 1 AND ${table.runsDays} <= 3650)`,
    ),
    check(
      "ai_observation_retention_overrides_datasets_days_check",
      sql`${table.datasetsDays} IS NULL OR (${table.datasetsDays} >= 1 AND ${table.datasetsDays} <= 3650)`,
    ),
    check(
      "ai_observation_retention_overrides_experiments_days_check",
      sql`${table.experimentsDays} IS NULL OR (${table.experimentsDays} >= 1 AND ${table.experimentsDays} <= 3650)`,
    ),
    check(
      "ai_observation_retention_overrides_exports_days_check",
      sql`${table.exportsDays} IS NULL OR (${table.exportsDays} >= 1 AND ${table.exportsDays} <= 3650)`,
    ),
    // An override row that overrides nothing is noise that reads as policy.
    check(
      "ai_observation_retention_overrides_says_something_check",
      sql`${table.runsDays} IS NOT NULL OR ${table.datasetsDays} IS NOT NULL OR ${table.experimentsDays} IS NOT NULL OR ${table.exportsDays} IS NOT NULL`,
    ),
  ],
);

export const aiObservationRetentionDeletions = pgTable(
  "ai_observation_retention_deletions",
  {
    id: text("id").primaryKey(),
    /** The trusted scope's key the target lived in. */
    scopeKey: text("scope_key").notNull(),
    actorId: text("actor_id").notNull(),
    botId: text("bot_id").notNull(),
    kind: text("kind").$type<AiObservationDeletionKind>().notNull(),
    /** The target row's id. Soft reference on purpose: the row may already be gone. */
    targetId: text("target_id").notNull(),
    /** Where the target's upstream copy lives; both null for purely local targets. */
    locatorWorkspace: text("locator_workspace"),
    locatorProject: text("locator_project"),
    /** The upstream id to delete, when the target reconciled/synced upstream. */
    upstreamKind: text("upstream_kind").$type<AiObservationUpstreamKind>(),
    upstreamId: text("upstream_id"),
    /** The policy that expired the target, snapshotted for the audit row. */
    retentionDays: integer("retention_days").notNull(),
    state: text("state")
      .$type<AiObservationDeletionState>()
      .notNull()
      .default("pending"),
    /** How many worker passes have taken this record, including the failing ones. */
    attempts: integer("attempts").notNull().default(0),
    /**
     * When the M1b stop-work pass — a run deletion cancels the scope's
     * queued/running exports before their data face changes — actually ran.
     * Persisted because the state column cannot carry it: a first pass that
     * fails before (or after) the stop rewrites `pending` to `failed`, and a
     * retry that derived "already stopped" from the state would either re-cancel
     * the user's fresh exports or, worse, never cancel at all while the deletion
     * advanced (OCR R3-34). Null means the stop is still owed.
     */
    workStoppedAt: timestamp("work_stopped_at", { withTimezone: true }),
    /** The stored failure vocabulary; a body-free code, never upstream text. */
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("ai_observation_retention_deletions_kind_target_uq").on(
      table.kind,
      table.targetId,
    ),
    index("ai_observation_retention_deletions_state_updated_idx").on(
      table.state,
      table.updatedAt,
    ),
    check(
      "ai_observation_retention_deletions_kind_check",
      sql`${table.kind} IN ('run', 'dataset', 'experiment', 'export')`,
    ),
    check(
      "ai_observation_retention_deletions_state_check",
      sql`${table.state} IN ('pending', 'upstream_done', 'deleted', 'failed')`,
    ),
    // Terminal is decidable from either column and the two cannot disagree.
    check(
      "ai_observation_retention_deletions_deleted_coherence_check",
      sql`(${table.deletedAt} IS NULL AND ${table.state} <> 'deleted') OR (${table.deletedAt} IS NOT NULL AND ${table.state} = 'deleted')`,
    ),
    // A reason rides along only with the state it explains.
    check(
      "ai_observation_retention_deletions_error_failed_check",
      sql`${table.lastError} IS NULL OR ${table.state} = 'failed'`,
    ),
    check(
      "ai_observation_retention_deletions_upstream_kind_check",
      sql`${table.upstreamKind} IS NULL OR ${table.upstreamKind} IN ('trace', 'dataset')`,
    ),
    // Only a run's deletion has a work face to stop: the fact column cannot
    // appear beside any other kind.
    check(
      "ai_observation_retention_deletions_work_stopped_run_check",
      sql`${table.workStoppedAt} IS NULL OR ${table.kind} = 'run'`,
    ),
    // The upstream pair is both-or-neither: an id without its kind names nothing.
    check(
      "ai_observation_retention_deletions_upstream_pair_check",
      sql`(${table.upstreamKind} IS NULL) = (${table.upstreamId} IS NULL)`,
    ),
    // The locator pair is both-or-neither, and only upstream-carrying kinds need one.
    check(
      "ai_observation_retention_deletions_locator_pair_check",
      sql`(${table.locatorWorkspace} IS NULL AND ${table.locatorProject} IS NULL) OR (${table.locatorWorkspace} IS NOT NULL AND ${table.locatorProject} IS NOT NULL)`,
    ),
    check(
      "ai_observation_retention_deletions_attempts_positive_check",
      sql`${table.attempts} >= 0`,
    ),
    check(
      "ai_observation_retention_deletions_retention_days_check",
      sql`${table.retentionDays} >= 1 AND ${table.retentionDays} <= 3650`,
    ),
  ],
);
