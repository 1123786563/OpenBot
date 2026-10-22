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
import { codeRuns } from "./code-runs";
import { agents, channels, users } from "./core";
import { jsonb } from "./json";

export type WorkshopSessionStatus = "active" | "archived";

/**
 * `private` = only the owner's side of `canUseBot`; `unlisted` = a share token reaches it but it is
 * not publicly indexed (the recommended default when sharing); `public` = reachable through the
 * anonymous read path once a share link exists.
 */
export type WorkshopVisibility = "private" | "unlisted" | "public";

/** Whether a share link permits downloading artifacts or only viewing the preview. */
export type WorkshopShareScope = "preview" | "preview_download";

/** Artifacts may be excluded from a share individually; `private` is the way to do that. */
export type WorkshopArtifactVisibility = "private" | "public";

export type WorkshopTurnStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/**
 * Who started a turn. `person` is the default; headless paths (the `run_workshop_turn` tool) and
 * scheduled runs (workshop_schedules, migration 0067) carry their own markers so an audit reader
 * can tell a person asking from a machine asking on somebody's behalf.
 */
export type WorkshopTurnInitiator = "person" | "headless" | "schedule";

const stamp = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();

/**
 * One Bot's workspace inside one channel: the durable handle the workshop tab and its turns hang
 * off. A channel has at most one session (the unique index below), created lazily on first use.
 *
 * SHARE FIELDS LIVE HERE AND NOT IN A LINK TABLE (plan §3.7.1): a session has at most one share
 * link today, so a separate table would buy a second lifecycle to keep in sync — a revoke missed
 * in one of the two places is an authorization leak — while costing the public read path an extra
 * join on every page load. The `share_token_hash` stores sha256(token), never the token: a
 * dragged database cannot be turned back into links. The token itself exists once, at creation,
 * on its way back to the person who asked for it.
 */
export const workshopSessions = pgTable(
  "workshop_sessions",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status")
      .$type<WorkshopSessionStatus>()
      .notNull()
      .default("active"),
    /** The per-bot `opencode serve` session this workshop session drives, once it exists. */
    opencodeSessionId: text("opencode_session_id"),
    /** Port of the static webapp preview inside the sandbox port pool, when one is allocated. */
    webappPort: integer("webapp_port"),
    createdAt: stamp("created_at"),
    /** Bumped on every turn so idle sessions are findable without scanning turns. */
    lastActivityAt: stamp("last_activity_at"),
    visibility: text("visibility")
      .$type<WorkshopVisibility>()
      .notNull()
      .default("private"),
    /**
     * sha256 of the share token. Nullable: most sessions are never shared. The partial unique
     * index below is what keeps "at most one live link per session" true at the database level —
     * a plain unique index would not bind NULLs, which is exactly the case for unshared sessions.
     */
    shareTokenHash: text("share_token_hash"),
    shareScope: text("share_scope")
      .$type<WorkshopShareScope>()
      .notNull()
      .default("preview"),
    /** Null means the link is good until revoked; set for time-boxed shares. */
    shareExpiresAt: timestamp("share_expires_at", { withTimezone: true }),
    /**
     * Revoking keeps the row rather than deleting it (plan §3.7.2): the share's existence stays
     * auditable after it stops working.
     */
    shareRevokedAt: timestamp("share_revoked_at", { withTimezone: true }),
    shareCreatedBy: text("share_created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    shareCreatedAt: timestamp("share_created_at", { withTimezone: true }),
  },
  (table) => [
    // The workshop routes address a session by channel: /api/workshop/:channelId. One channel,
    // one session, or "which session did you mean" becomes a per-request coin flip.
    uniqueIndex("workshop_sessions_channel_idx").on(table.channelId),
    // The public read path's only lookup: sha256(token) in, session out. Partial so unshared
    // sessions (NULL hash) never collide with anything.
    uniqueIndex("workshop_sessions_share_token_idx")
      .on(table.shareTokenHash)
      .where(sql`${table.shareTokenHash} IS NOT NULL`),
    index("workshop_sessions_owner_idx").on(table.ownerUserId),
    check(
      "workshop_sessions_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
    check(
      "workshop_sessions_visibility_check",
      sql`${table.visibility} IN ('private', 'unlisted', 'public')`,
    ),
    check(
      "workshop_sessions_share_scope_check",
      sql`${table.shareScope} IN ('preview', 'preview_download')`,
    ),
  ],
);

export type WorkshopArtifactType =
  | "csv"
  | "chart"
  | "report"
  | "webapp"
  | "file"
  | "dataset";

/**
 * What a run produced, indexed for the gallery. `path` is inside the sandbox workspace; downloads
 * stream from the sandbox rather than through this table.
 *
 * `visibility` exists only to EXCLUDE an artifact from a share (plan §3.7.2): artifacts do not
 * carry their own tokens — one share link covers every `public` artifact of the session — so a
 * `private` artifact is how a sensitive intermediate file stays out of a shared session.
 */
export const workshopArtifacts = pgTable(
  "workshop_artifacts",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => workshopSessions.id, { onDelete: "cascade" }),
    type: text("type").$type<WorkshopArtifactType>().notNull(),
    name: text("name").notNull(),
    path: text("path").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    previewUrl: text("preview_url"),
    visibility: text("visibility")
      .$type<WorkshopArtifactVisibility>()
      .notNull()
      .default("private"),
    createdAt: stamp("created_at"),
  },
  (table) => [
    // The gallery reads a session's artifacts newest-first; this is that query.
    index("workshop_artifacts_session_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    check(
      "workshop_artifacts_type_check",
      sql`${table.type} IN ('csv', 'chart', 'report', 'webapp', 'file', 'dataset')`,
    ),
    check(
      "workshop_artifacts_visibility_check",
      sql`${table.visibility} IN ('private', 'public')`,
    ),
  ],
);

/**
 * One turn of the workshop: the long-form record an orchestrator owns (plan §3.3). Short-form
 * governance and metering stay in `code_runs`, written only by the CodeRunGateway; the two are
 * joined one-way through `code_run_id`, which is null when the sandbox was never reached (a
 * refused run leaves the turn failed but still leaves the turn).
 */
export const workshopTurns = pgTable(
  "workshop_turns",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => workshopSessions.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    status: text("status")
      .$type<WorkshopTurnStatus>()
      .notNull()
      .default("queued"),
    turnIndex: integer("turn_index").notNull(),
    /** The `code_runs.id` this turn delegated to, when it got that far. */
    codeRunId: text("code_run_id").references(() => codeRuns.id),
    /**
     * Renewed by the runner for as long as it is alive. `recoverStale` settles running turns
     * whose heartbeat went quiet — the database is the truth here, locks only make two replicas
     * settling the same turn safe.
     */
    runnerHeartbeatAt: stamp("runner_heartbeat_at"),
    error: text("error"),
    /** Display copy of the run's usage; `code_runs` remains the only metering source. */
    usage: jsonb("usage").notNull().default({}),
    startedAt: stamp("started_at"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    initiator: text("initiator")
      .$type<WorkshopTurnInitiator>()
      .notNull()
      .default("person"),
  },
  (table) => [
    // Turns are numbered within a session; the transcript reads them in this order.
    uniqueIndex("workshop_turns_session_turn_idx").on(
      table.sessionId,
      table.turnIndex,
    ),
    // recoverStale's scan: running turns whose heartbeat is older than the cutoff.
    index("workshop_turns_stale_idx").on(table.status, table.runnerHeartbeatAt),
    // The join back to the short-form record.
    index("workshop_turns_code_run_idx").on(table.codeRunId),
    check(
      "workshop_turns_status_check",
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      "workshop_turns_initiator_check",
      sql`${table.initiator} IN ('person', 'headless', 'schedule')`,
    ),
  ],
);

/**
 * The event stream of one turn, appended in order and replayed over SSE. `(turn_id, seq)` is the
 * replay cursor: a client reconnecting with `Last-Event-ID: N` is caught up from `seq > N` out of
 * this table, never out of a cache — the database is the fan-out bus's source of truth (plan
 * §3.5.4), so a lost Redis message costs one poll and never invents or drops an event.
 */
export const workshopTurnEvents = pgTable(
  "workshop_turn_events",
  {
    id: text("id").primaryKey(),
    turnId: text("turn_id")
      .notNull()
      .references(() => workshopTurns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** Translated event type from the sandbox SSE schema; unknown types become `unknown`. */
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: stamp("created_at"),
  },
  (table) => [
    // The ordering guarantee the whole replay protocol leans on: within a turn, one row per seq.
    uniqueIndex("workshop_turn_events_turn_seq_idx").on(
      table.turnId,
      table.seq,
    ),
  ],
);

export type WorkshopScheduleStatus = "enabled" | "paused" | "deleted";

/**
 * A recurring ask against a workshop session (B16): a schedule fires the same prompt on a RRULE
 * cadence, attributed to its creator's authority. The rule lives as text (RFC 5545); its
 * interpretation belongs to the runner, not the schema — the row is the intent, the runs are
 * the history, and neither pretends to be the other.
 */
export const workshopSchedules = pgTable(
  "workshop_schedules",
  {
    id: text("id").primaryKey(),
    /** The session this schedule fires against; deleting the session deletes the schedule. */
    sessionId: text("session_id")
      .notNull()
      .references(() => workshopSessions.id, { onDelete: "cascade" }),
    /** Whose authority the fired turns run under (the audit's actor_user_id). */
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The prompt, verbatim; the same string every firing sends. */
    prompt: text("prompt").notNull(),
    /** RFC 5545 RRULE text, e.g. `FREQ=DAILY;BYHOUR=9;BYMINUTE=0`. */
    rrule: text("rrule").notNull(),
    /** The timezone the rule's wall clock reads; absent is the deployment's. */
    timezone: text("timezone"),
    /**
     * The firing's operating boundary (B17): what a fired turn may do WITHOUT approval —
     * `{ paths, tools, maxTurnsPerRun }`. Stamped at creation, consumed by the executor as
     * the boundary it states in the firing prompt; tool calls outside it route through the
     * agent layer's approval (see schedule-executor.ts's boundary note).
     */
    preapproved: jsonb("preapproved").$type<{
      paths: string[];
      tools: string[];
      maxTurnsPerRun: number;
    } | null>(),
    status: text("status")
      .$type<WorkshopScheduleStatus>()
      .notNull()
      .default("enabled"),
    /** The last firing this schedule produced, for the overlap guard's next-run math. */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** The runner's next planned firing, set when a run is planned. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: stamp("created_at"),
    updatedAt: stamp("updated_at"),
  },
  (table) => [
    index("workshop_schedules_session_idx").on(table.sessionId),
    index("workshop_schedules_due_idx")
      .on(table.nextRunAt)
      .where(
        sql`${table.status} = 'enabled' AND ${table.nextRunAt} IS NOT NULL`,
      ),
  ],
);

export type WorkshopScheduleRunStatus =
  | "planned"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

/**
 * One firing of one schedule (B16): planned before it runs, settled after, and never deleted —
 * a schedule's history is the audit of what it did, including the firings it skipped (an
 * overlap guard's answer) so a gap in history is a fact, not a mystery.
 */
export const workshopScheduleRuns = pgTable(
  "workshop_schedule_runs",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => workshopSchedules.id, { onDelete: "cascade" }),
    /** The planned firing time; the row exists because of this moment. */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    /** The turn the firing produced, when it produced one; null for skips. */
    turnId: text("turn_id").references(() => workshopTurns.id, {
      onDelete: "set null",
    }),
    status: text("status")
      .$type<WorkshopScheduleRunStatus>()
      .notNull()
      .default("planned"),
    /** Why a skip skipped, or a failure failed: the operator's sentence. */
    note: text("note"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: stamp("created_at"),
  },
  (table) => [
    // One row per (schedule, planned moment): a firing planned twice is the same firing.
    uniqueIndex("workshop_schedule_runs_once_idx").on(
      table.scheduleId,
      table.scheduledFor,
    ),
    index("workshop_schedule_runs_schedule_idx").on(table.scheduleId),
  ],
);
