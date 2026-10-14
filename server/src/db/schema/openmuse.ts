import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./core";
// The custom jsonb, not drizzle's: the native one double-serialises under the Bun SQL driver,
// and these columns are read with SQL JSON operators (monitor re-arm, wait claim) that read a
// double-encoded value as a string and never match. See json.ts.
import { jsonb } from "./json";

/*
 * OpenMuse personal Files (F01, contract §5): owner-scoped file rows plus
 * immutable versions whose byte path is always server-derived, and the
 * per-owner disable marker that feeds the §9 lifecycle hook.
 */

/**
 * One field an input wait asks the owner to answer (§7 human wait, T08).
 * Minimal types for now: text and yes/no.
 */
export type OpenMuseWaitField = { name: string; type: "string" | "boolean" };

/**
 * The §7 monitor condition (T10): `change|contains|price_below`, checked every
 * `intervalMinutes` (1–10,080, validated at creation). `price_below` requires
 * a numeric threshold; `contains`/`change` require a source string. The
 * interval rides here rather than in its own column so the schedule is one
 * jsonb shape the seam types, like steps and evidence.
 */
export type OpenMuseMonitorCondition = {
  type: "change" | "contains" | "price_below";
  intervalMinutes: number;
  source?: string;
  selector?: string;
  threshold?: number;
};

/**
 * The §7 human-wait record (T08): one open input question on the Task row.
 * Timestamps are ISO strings, not Dates — the record lives in jsonb and must
 * round-trip through the database identically. T16 adds `kind: "review"` (the
 * §7 catalog's second wait kind): the review wait a document Task's parked
 * reply carries, with the openmuse-tasks store's own subtype naming its
 * proposal binding.
 */
export type OpenMuseTaskWait = {
  waitId: string;
  taskId: string;
  kind: "input" | "review";
  question: string;
  fields?: OpenMuseWaitField[];
  createdAt: string;
  answeredAt?: string;
  /** The first valid answer, stored so a repeat answer replays it. */
  answer?: Record<string, string | boolean>;
};

export const openmuseFileOwnerDisables = pgTable(
  "openmuse_file_owner_disables",
  {
    ownerUserId: text("owner_user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    disabledAt: timestamp("disabled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const openmuseFileVersions = pgTable(
  "openmuse_file_versions",
  {
    versionId: text("version_id").primaryKey(),
    fileId: text("file_id")
      .notNull()
      .references(() => openmuseFiles.id, { onDelete: "cascade" }),
    bytePath: text("byte_path").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /*
     * F06's optimistic-concurrency parent: the fill's stale-parent check is
     * a read, and two overlapping fills could both pass it. Persisted here
     * with one partial unique index, the loser of the race fails AT THE
     * INSERT — the fork the 409 answer promises to prevent (round 6 M23).
     */
    parentVersionId: text("parent_version_id"),
  },
  (table) => [
    index("openmuse_file_versions_file_idx").on(table.fileId),
    uniqueIndex("openmuse_file_versions_parent_uq")
      .on(table.fileId, table.parentVersionId)
      .where(sql`${table.parentVersionId} IS NOT NULL`),
  ],
);

export const openmuseFiles = pgTable(
  "openmuse_files",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("openmuse_files_owner_list_idx").on(
      table.ownerUserId,
      table.createdAt,
      table.id,
    ),
    uniqueIndex("openmuse_files_owner_idem_uq")
      .on(table.ownerUserId, table.idempotencyKey)
      .where(sql`"openmuse_files"."deleted_at" is null`),
  ],
);

/**
 * The OpenMuse Task table (contracts §7). T01 owns creation and listing only:
 * every row starts `queued`; the runner, steps, evidence and control
 * transitions belong to later tickets and arrive as updates to this row.
 *
 * `steps`, `evidence` and `artifactIds` live as jsonb typed at the seam, so a
 * later ticket can enrich the shapes without a migration per field.
 */
export const openmuseTasks = pgTable(
  "openmuse_tasks",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id").notNull(),
    kind: text("kind")
      .$type<"agent" | "document" | "monitor" | "finance" | "plan">()
      .notNull(),
    /** Validated at creation (T01) and consumed by the runner (T02). */
    prompt: text("prompt").notNull().default(""),
    status: text("status")
      .$type<
        | "queued"
        | "running"
        | "waiting_approval"
        | "waiting_input"
        | "waiting_review"
        | "scheduled"
        | "paused"
        | "succeeded"
        | "failed"
        | "cancelled"
      >()
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(1),
    /**
     * T04 (§7): the internal cancel flag. Set on a running Task by the
     * cancel CAS; the public status stays `running` and the runner honours
     * the flag at its next safe step (the turn's end), settling `cancelled`.
     */
    cancellationRequested: boolean("cancellation_requested")
      .notNull()
      .default(false),
    /**
     * T05 (§7): the internal pause flag. Set on a running Task by the pause
     * CAS; the public status stays `running` and the runner honours the flag
     * at its next safe step (the turn's end), settling `paused`. Resume
     * clears it as it requeues.
     */
    pauseRequested: boolean("pause_requested").notNull().default(false),
    /**
     * T06 (§7): the retry key the retry CAS last consumed. A retry whose
     * key the row already recorded is refused, so one key creates only one
     * new attempt, however often it is re-sent.
     */
    lastRetryKey: text("last_retry_key"),
    /**
     * T08 (§7 human wait): the open or answered input wait as one jsonb
     * record on the row — the same seam every other control CAS runs on, so
     * no second wait table to keep in step with the status machine.
     */
    wait: jsonb("wait").$type<OpenMuseTaskWait | null>(),
    steps: jsonb("steps").$type<unknown[]>().notNull().default([]),
    evidence: jsonb("evidence").$type<unknown[]>().notNull().default([]),
    artifactIds: jsonb("artifact_ids").$type<string[]>().notNull().default([]),
    /**
     * T10 (§7 Monitor): the condition and the stored due instant of a monitor
     * Task's next check — null for every other kind. The schedule is UTC
     * database time: creation computes it from the injected clock, the runner
     * re-arms it after each check, and the queue's runAt carries it.
     */
    monitorCondition: jsonb(
      "monitor_condition",
    ).$type<OpenMuseMonitorCondition | null>(),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    /**
     * T11 (§7 Monitor): the dedup cursor — the identity hash of the last
     * committed observation and when it landed. An equal hash on the next
     * check is the SAME observation: no second evidence row, no match
     * signal. Null until the monitor's first observation commits.
     */
    lastObservationHash: text("last_observation_hash"),
    lastObservationAt: timestamp("last_observation_at", {
      withTimezone: true,
    }),
    /**
     * T11 (§7 Monitor): consecutive failed checks — the 15/30/60-minute
     * backoff's counter, capped at six hours, reset to zero by any
     * completed check.
     */
    monitorFailureStreak: integer("monitor_failure_streak")
      .notNull()
      .default(0),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One row per owner per idempotency key; NULL keys are all distinct, so
    // keyless creations never collide. ("key" is the idempotency key — the name predates the
    // family of owner_XXX index names it now sits among, not a key-of-the-owner.)
    uniqueIndex("openmuse_tasks_owner_key_uq").on(
      table.ownerUserId,
      table.idempotencyKey,
    ),
    index("openmuse_tasks_owner_created_idx").on(
      table.ownerUserId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type OpenMuseTaskRow = typeof openmuseTasks.$inferSelect;
export type NewOpenMuseTaskRow = typeof openmuseTasks.$inferInsert;

/*
 * OpenMuse Google OAuth (G01, contract §4): one in-flight consent per vendor
 * state, and the connection a completed consent records. The state is the
 * VENDOR's (parsed from the authorization URL OpenConnector returns); this
 * deployment's own binding — which user, which scopes, which return URI,
 * when it expires, whether it was spent — lives on the pending row.
 */
export const openmuseOauthPending = pgTable(
  "openmuse_oauth_pending",
  {
    state: text("state").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    returnUri: text("return_uri").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Consent older than ten minutes is refused; never cleaned by this ticket. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set by the one consume-once compare-and-swap; a spent state never answers again. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    /*
     * G02: OpenBot's own nonce, appended to the authorization URL and required
     * back on the callback (the vendor owns `state`); the outcome a completed
     * or swept consent records, so a replay re-answers rather than re-exchanges.
     */
    nonce: text("nonce"),
    outcome: text("outcome").$type<"completed" | "expired">(),
    connectionId: text("connection_id"),
  },
  (table) => [
    /*
     * The lazy sweep every OAuth start runs (`consumed_at IS NULL AND outcome IS NULL AND
     * expires_at < now()`); partial so settled rows never bloat it as the table grows with
     * one row per consent attempt.
     */
    index("openmuse_oauth_pending_open_idx")
      .on(table.expiresAt)
      .where(sql`${table.consumedAt} IS NULL AND ${table.outcome} IS NULL`),
  ],
);

export const openmuseGoogleConnections = pgTable(
  "openmuse_google_connections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // G03 widened the one provider G01 stored to the provider union; the
    // column itself was always free-text provider per person.
    provider: text("provider").$type<"gmail" | "googlecalendar">().notNull(),
    accountEmail: text("account_email").notNull(),
    status: text("status")
      .$type<"connected" | "refresh_required" | "disconnected" | "revoked">()
      .notNull()
      .default("connected"),
    grantedScopes: jsonb("granted_scopes")
      .$type<string[]>()
      .notNull()
      .default([]),
    generation: integer("generation").notNull().default(1),
    alias: text("alias").notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /*
     * G04: the sanitized sentence a failed refresh or an auth-expired
     * provider call leaves; null while healthy. FIXED wording on purpose —
     * the vendor's own error may quote the credential it failed on.
     */
    lastError: text("last_error"),
  },
  // One row per person per provider: "is my Gmail connected" has one answer.
  (table) => [
    uniqueIndex("openmuse_google_connections_owner_provider_uq").on(
      table.userId,
      table.provider,
    ),
  ],
);

export type OpenMuseOauthPendingRow = typeof openmuseOauthPending.$inferSelect;
export type OpenMuseGoogleConnectionRow =
  typeof openmuseGoogleConnections.$inferSelect;

/*
 * OpenMuse Reviewed actions (R01, contract §6): a proposal awaiting the
 * owner's decision, and the one durable attempt its approval claims. Status
 * transitions are compare-and-swaps (`claimTransition` in the store); only
 * that claim may enter `executing`.
 */
export const openmuseReviewedActions = pgTable(
  "openmuse_reviewed_actions",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    kind: text("kind")
      .$type<
        | "mail"
        | "calendar"
        | "gmail.send"
        | "gcalendar.create"
        | "gcalendar.update"
        | "gcalendar.delete"
      >()
      .notNull(),
    /** The canonical payload itself; its sha256 rides beside as payload_hash. */
    canonicalPayload: jsonb("canonical_payload").$type<unknown>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    accountEmail: text("account_email").notNull(),
    connectionGeneration: integer("connection_generation").notNull(),
    targetId: text("target_id"),
    targetVersion: text("target_version"),
    /** §6: a proposed attachment binds its immutable File version. */
    attachmentVersionIds: jsonb("attachment_version_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    status: text("status")
      .$type<
        | "awaiting_review"
        | "denied"
        | "expired"
        | "cancelled"
        | "executing"
        | "succeeded"
        | "failed"
        | "outcome_unknown"
      >()
      .notNull()
      .default("awaiting_review"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** The provider message/event id, when one is known (§6 receipt). */
    providerRef: text("provider_ref"),
    error: text("error"),
  },
  (table) => [
    index("openmuse_reviewed_actions_owner_created_idx").on(
      table.ownerUserId,
      table.createdAt,
      table.id,
    ),
    /*
     * R04's never-send-the-same-thing-twice, made durable at the row level: one
     * not-yet-settled row per (owner, kind, payload, target), so the store's
     * gate and a racing propose cannot both land — the loser hits this index
     * rather than a second send. The target rides the key the same way the
     * gate's own query keys it (a delete's payload is only {calendarId}, so
     * the payload alone names every delete on one calendar alike); coalesce
     * keeps the payload-bound kinds — no target, a null column — inside the
     * index instead of exempting them (a bare null would not match itself).
     * Every settled status (denied, failed, succeeded, …) falls out of the
     * index, which is what lets an operator's confirmed_not_sent re-proposal
     * through.
     */
    /*
     * The ops signals reader (O05) filters on status = 'outcome_unknown'
     * alone over an append-only history table; without an index whose first
     * column is that status, every /signals poll degenerates into a full
     * table scan that grows with the history. Partial, because the state is
     * the exception, not the rule: the index stays tiny while the table
     * grows.
     */
    index("openmuse_reviewed_actions_outcome_unknown_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'outcome_unknown'`),
    uniqueIndex("openmuse_reviewed_actions_active_send_uq")
      .on(
        table.ownerUserId,
        table.kind,
        table.payloadHash,
        sql`coalesce(${table.targetId}, '')`,
      )
      .where(
        sql`${table.status} IN ('awaiting_review', 'executing', 'outcome_unknown')`,
      ),
  ],
);

export const openmuseReviewedAttempts = pgTable(
  "openmuse_reviewed_attempts",
  {
    attemptId: text("attempt_id").primaryKey(),
    actionId: text("action_id")
      .notNull()
      .references(() => openmuseReviewedActions.id, { onDelete: "cascade" }),
    /** The provider request fingerprint; recorded by the executing claim. */
    fingerprint: text("fingerprint"),
    outcome: text("outcome").$type<
      "succeeded" | "failed" | "outcome_unknown"
    >(),
    providerRef: text("provider_ref"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** §6 human reconciliation: confirmed_succeeded | confirmed_not_sent | unresolved. */
    reconciliation: jsonb("reconciliation").$type<{
      outcome: "confirmed_succeeded" | "confirmed_not_sent" | "unresolved";
      evidence: string;
      reviewer: string;
    }>(),
  },
  (table) => [
    index("openmuse_reviewed_attempts_action_idx").on(table.actionId),
  ],
);

export type OpenMuseReviewedActionRow =
  typeof openmuseReviewedActions.$inferSelect;
export type OpenMuseReviewedAttemptRow =
  typeof openmuseReviewedAttempts.$inferSelect;

/*
 * OpenMuse private Goals (P01, contract §7): one owner-scoped table with
 * jsonb milestones — a patch (including a full milestone replacement) is a
 * single-row write. `deletedAt` tombstones; D05 restores, D06 purges.
 */
export const openmuseGoals = pgTable(
  "openmuse_goals",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull().default("Personal"),
    status: text("status")
      .$type<"active" | "paused" | "completed">()
      .notNull()
      .default("active"),
    milestones: jsonb("milestones")
      .$type<Array<{ id: string; title: string; status: "todo" | "done" }>>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("openmuse_goals_owner_created_idx").on(
      table.ownerUserId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type OpenMuseGoalRow = typeof openmuseGoals.$inferSelect;
export type NewOpenMuseGoalRow = typeof openmuseGoals.$inferInsert;

/*
 * OpenMuse private Ideas (P02, contract §7): one owner-scoped table with
 * jsonb evidence and a nullable Task link — `taskId` is an FK-ish reference
 * to openmuse_tasks.id validated at accept time by the tasks store's get,
 * not by a database constraint. `deletedAt` tombstones; D05 restores, D06
 * purges; a withdrawn row keeps its Task link as read-only history.
 */
export const openmuseIdeas = pgTable(
  "openmuse_ideas",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    title: text("title").notNull(),
    reason: text("reason").notNull().default(""),
    evidence: jsonb("evidence")
      .$type<Array<{ kind: string; ref: string }>>()
      .notNull()
      .default([]),
    prompt: text("prompt").notNull().default(""),
    /** Enum-free by contract, like a Goal's category. */
    kind: text("kind").notNull().default(""),
    input: text("input").notNull().default(""),
    status: text("status")
      .$type<"pending" | "accepted" | "withdrawn">()
      .notNull()
      .default("pending"),
    taskId: text("task_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("openmuse_ideas_owner_created_idx").on(
      table.ownerUserId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type OpenMuseIdeaRow = typeof openmuseIdeas.$inferSelect;
export type NewOpenMuseIdeaRow = typeof openmuseIdeas.$inferInsert;

/*
 * OpenMuse private Memories (P03, contract §7): one owner-scoped table of
 * immutable texts — a Memory is written once and read back exactly, so
 * there is no update and no updated_at. `deletedAt` tombstones; D05
 * restores, D06 purges.
 */
export const openmuseMemories = pgTable(
  "openmuse_memories",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    text: text("text").notNull(),
    /** Enum-free by contract, like a Goal's category. */
    source: text("source").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("openmuse_memories_owner_created_idx").on(
      table.ownerUserId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type OpenMuseMemoryRow = typeof openmuseMemories.$inferSelect;
export type NewOpenMuseMemoryRow = typeof openmuseMemories.$inferInsert;

/*
 * OpenMuse Task notifications (T12, contracts §7): one user-scoped item per
 * enumerated event, keyed (userId, taskId, eventKind, attemptKey) — the
 * unique index IS the exactly-once. Events are emitted by the owning
 * transition (the task runner and the monitor check), never inferred by
 * polling; per-user readAt persists and is set once.
 */
export const openmuseNotifications = pgTable(
  "openmuse_notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    taskId: text("task_id").notNull(),
    /** The §7 enumerated events, stored as their dotted names. */
    eventKind: text("event_kind")
      .$type<
        | "task.succeeded"
        | "task.failed"
        | "task.waiting_input"
        | "task.waiting_review"
        | "task.cancelled"
        | "monitor.matched"
      >()
      .notNull(),
    /** The attempt number for task events; the observation hash for monitors. */
    attemptKey: text("attempt_key").notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("openmuse_notifications_owner_event_uq").on(
      table.userId,
      table.taskId,
      table.eventKind,
      table.attemptKey,
    ),
    index("openmuse_notifications_owner_created_idx").on(
      table.userId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type OpenMuseNotificationRow = typeof openmuseNotifications.$inferSelect;
export type NewOpenMuseNotificationRow =
  typeof openmuseNotifications.$inferInsert;
