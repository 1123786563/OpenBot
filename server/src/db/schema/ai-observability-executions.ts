import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { aiObservationExperiments } from "./ai-observability-experiments";
// The repo's single-serialization jsonb (m193): same reasoning as the sibling tables.
import { jsonb } from "./json";

/**
 * The execution record of an evaluation experiment (Issue #29 / DAG T23).
 *
 * One row is one isolated execution of one FROZEN experiment: the row pins
 * `experiment_config_hash`, so an execution always names the exact immutable
 * configuration it runs under — a draft configuration can never be behind one,
 * because the store refuses to enqueue against anything but a frozen row and
 * frozen rows cannot change (migration 0126's trigger on the experiment).
 *
 * The state vocabulary is the fail-closed discipline of this slice, and it is
 * its own word set, not the export jobs': `pending` (enqueued, no worker has
 * claimed it), `running`, and the three terminal outcomes `completed`,
 * `failed`, `cancelled`. `queued` — the export word — is refused by the
 * database, because a vocabulary nobody shares is a vocabulary nobody can
 * lie in by borrowing.
 *
 * The isolation facts this table carries rather than trusts:
 *
 *  - `tool_rejections` counts every production write-tool call the runner
 *    refused in this execution. It is a governance counter, not telemetry:
 *    the settle audit row carries it into the trail, so "the evaluation
 *    tried to reach the world and was stopped" is a queryable fact.
 *  - `result` may be non-null only on `completed`, `error_code` only on
 *    `failed`: a cancelled or failed execution cannot carry a product that
 *    reads as finished work, the same way an export cannot.
 *  - `settled_at` is non-null exactly on the terminal states, so "terminal"
 *    is decidable from either column and the two cannot disagree.
 */
export type AiObservationExecutionState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export const aiObservationExperimentExecutions = pgTable(
  "ai_observation_experiment_executions",
  {
    id: text("id").primaryKey(),
    /** The trusted scope's key. The execution and its results live in this key space. */
    scopeKey: text("scope_key").notNull(),
    actorId: text("actor_id").notNull(),
    botId: text("bot_id").notNull(),
    /** The frozen experiment this execution runs. The foreign key pins it physically. */
    experimentId: text("experiment_id")
      .notNull()
      .references(() => aiObservationExperiments.id),
    /**
     * The config hash of the experiment at enqueue: the execution's own copy of which
     * frozen configuration it runs under. Never empty — an empty hash is a draft's, and
     * drafts do not execute.
     */
    experimentConfigHash: text("experiment_config_hash").notNull(),
    state: text("state")
      .$type<AiObservationExecutionState>()
      .notNull()
      .default("pending"),
    /** Why a failed execution ended. Null unless failed — a cancellation needs no reason. */
    errorCode: text("error_code"),
    /** Cases the execution ran; set only on completion. */
    caseCount: integer("case_count"),
    /** Production write-tool calls refused in this execution (the governance counter). */
    toolRejections: integer("tool_rejections").notNull().default(0),
    /** The projected per-case outcomes. Non-null only on completed (check constraint). */
    result: jsonb("result").$type<{
      cases: ReadonlyArray<Record<string, unknown>>;
    }>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** When the execution reached its terminal state. Non-null exactly on terminal states. */
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "ai_observation_experiment_executions_state_check",
      sql`${table.state} IN ('pending', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    // A draft's hash is the empty string; an execution backed by one is refused here as
    // well as at the store, so no path can launder a mutable configuration into a run.
    check(
      "ai_observation_experiment_executions_config_hash_frozen_check",
      sql`${table.experimentConfigHash} <> ''`,
    ),
    check(
      "ai_observation_experiment_executions_result_completed_check",
      sql`${table.result} IS NULL OR ${table.state} = 'completed'`,
    ),
    check(
      "ai_observation_experiment_executions_error_failed_check",
      sql`${table.errorCode} IS NULL OR ${table.state} = 'failed'`,
    ),
    check(
      "ai_observation_experiment_executions_case_count_completed_check",
      sql`${table.caseCount} IS NULL OR ${table.state} = 'completed'`,
    ),
    check(
      "ai_observation_experiment_executions_settled_terminal_check",
      sql`(${table.settledAt} IS NULL AND ${table.state} IN ('pending', 'running')) OR (${table.settledAt} IS NOT NULL AND ${table.state} NOT IN ('pending', 'running'))`,
    ),
    // The scope's own listing read, newest first.
    index("ai_observation_experiment_executions_scope_created_idx").on(
      table.scopeKey,
      table.createdAt,
    ),
    // One experiment's executions, newest first.
    index("ai_observation_experiment_executions_experiment_created_idx").on(
      table.experimentId,
      table.createdAt,
    ),
    // The revocation seam: every not-yet-terminal execution of one actor, in one place.
    index("ai_observation_experiment_executions_active_actor_idx")
      .on(table.actorId)
      .where(sql`${table.state} IN ('pending', 'running')`),
  ],
);
