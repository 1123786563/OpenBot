import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * The authoritative ownership record for one observed run attempt.
 *
 * What OpenBot must never lose to Opik lives here: who was authorized (actor, bot, scope key),
 * where the upstream copy sits (locator, upstream trace id) and the durable task state. What
 * must never arrive here is business content — no prompts, outputs, tool arguments, credentials,
 * account emails or attachment URLs. The column set is deliberately this short; a column that
 * could hold content is the leak, not the code that fills it.
 *
 * Idempotency is a database property, not a store discipline: (scope, run, attempt) makes a
 * replayed begin land on the same row, and (scope, upstream trace) keeps reconciliation from
 * minting a second local subject for one upstream record. Scope participates in both keys, so
 * the same run id under another scope is a different subject, never a collision.
 */

export type AiObservationBindingCapability =
  | "basic"
  | "detailed"
  | "unavailable";
export type AiObservationBindingState =
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted"
  | "unknown";

export const aiObservationBindings = pgTable(
  "ai_observation_bindings",
  {
    id: text("id").primaryKey(),
    /** The trusted scope's key. Ownership resolution starts here, never from Opik metadata. */
    scopeKey: text("scope_key").notNull(),
    actorId: text("actor_id").notNull(),
    botId: text("bot_id").notNull(),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    /** OTel trace id: an opaque reference to our own instrumentation, not upstream authority. */
    traceId: text("trace_id").notNull(),
    /** Opik's trace id, opaque and informational: recorded at reconciliation, never trusted. */
    opikTraceId: text("opik_trace_id"),
    /** Where this scope's records live upstream — derived from the scope, never client-supplied. */
    locatorWorkspace: text("locator_workspace").notNull(),
    locatorProject: text("locator_project").notNull(),
    capability: text("capability")
      .$type<AiObservationBindingCapability>()
      .notNull(),
    state: text("state")
      .$type<AiObservationBindingState>()
      .notNull()
      .default("running"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "ai_observation_bindings_capability_check",
      sql`${table.capability} IN ('basic', 'detailed', 'unavailable')`,
    ),
    check(
      "ai_observation_bindings_state_check",
      sql`${table.state} IN ('running', 'completed', 'failed', 'canceled', 'interrupted', 'unknown')`,
    ),
    uniqueIndex("ai_observation_bindings_scope_run_attempt_uq").on(
      table.scopeKey,
      table.runId,
      table.attemptId,
    ),
    uniqueIndex("ai_observation_bindings_scope_opik_trace_uq")
      .on(table.scopeKey, table.opikTraceId)
      .where(sql`${table.opikTraceId} IS NOT NULL`),
    // The retention discovery predicate's filter column (m164): scanned every poll.
    index("ai_observation_bindings_created_at_idx").on(table.createdAt),
  ],
);
