/**
 * Craft tables: the AI-colleague session, its message stream, and its workspace snapshots.
 *
 * Ported one-for-one from onyx `build_session` / `build_message` / `snapshot`
 * (backend/onyx/db/models.py). The sandbox side is deliberately NOT new here — craft reuses
 * `sandbox_instances` for container lifecycle; docs/craft-port/schema-notes.md carries the
 * column mapping and the (documented, not yet applied) additions that port asks for there.
 *
 * Enumerations are `text` + check constraints rather than pgEnum, for the same reason onyx
 * declared its build enums `native_enum=False`: these lifecycles were still settling on the
 * source side, and a value added to a check is one migration instead of enum-type surgery.
 * It also matches the house style of the two closest siblings (workshop, sandbox-instances).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";
import { users } from "./core";

const stamp = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();

export type CraftSessionStatus = "initializing" | "active" | "idle" | "failed";

export type CraftSessionOrigin = "INTERACTIVE" | "SCHEDULED" | "SLACK";

export type CraftSharingScope = "private" | "public_org";

export type CraftMessageType =
  | "system"
  | "user"
  | "assistant"
  | "tool_call_response"
  | "user_reminder";

/**
 * One craft conversation: a durable identity the sidebar, turns and artifacts hang off, paired
 * with one workspace directory inside the owner's sandbox (`/workspace/sessions/{id}`).
 *
 * Sessions are born `initializing` — identity reserved, workspace/OpenCode still reconciling —
 * and only the reconcile that built the workspace CASes them to `active` (or `failed`, which is
 * repairable: the row survives and a retry rebuilds under the same id). `idle` means the sandbox
 * slept and the workspace must be restored before the next turn.
 */
export const craftSessions = pgTable(
  "craft_sessions",
  {
    id: text("id").primaryKey(),
    /*
     * onyx leaves this nullable (legacy rows); OpenBot has no such legacy, so the owner is
     * required — matching workshop_sessions. Deleting the owner deletes the conversation.
     */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Display name: LLM-generated after the first turn, or renamed by hand. */
    name: text("name"),
    status: text("status")
      .$type<CraftSessionStatus>()
      .notNull()
      .default("initializing"),
    /*
     * Bumped by the store on every read/turn (onyx does this with an ORM onupdate hook — same
     * job, done where the write happens instead, since nothing at the SQL layer fires on UPDATE).
     */
    lastActivityAt: stamp("last_activity_at"),
    createdAt: stamp("created_at"),
    /**
     * Reserved webapp port inside the owner's sandbox pool [3010, 3100). Null until allocated;
     * the partial unique index below is the durable half of the reservation (allocation retries
     * on collision instead of trusting an application-level scan).
     */
    nextjsPort: integer("nextjs_port"),
    /** Who may open a shared webapp: just the owner, or anyone in the org. */
    sharingScope: text("sharing_scope")
      .$type<CraftSharingScope>()
      .notNull()
      .default("private"),
    /**
     * How this session was created. The sidebar lists INTERACTIVE only — SCHEDULED (task
     * executor) and SLACK sessions exist for their own surfaces. Values keep onyx's uppercase
     * spelling: they are compared as literals, and parity beats tidiness here.
     */
    origin: text("origin")
      .$type<CraftSessionOrigin>()
      .notNull()
      .default("INTERACTIVE"),
    /** The sandbox's `opencode serve` session id — minted lazily, re-minted on 404. */
    opencodeSessionId: text("opencode_session_id"),
    /** The LLM the owner picked; null falls back to opencode's startup default. */
    agentProvider: text("agent_provider"),
    agentModel: text("agent_model"),
    /**
     * Fingerprints of the managed content this session's runtime has CONFIRMED (skills payload,
     * craft MCP set). Compared against the sandbox-side hashes: a mismatch means the runtime
     * predates the sandbox's managed content and must reload (rewrite config + dispose). Kept on
     * the session row even though the first phase does not push skills/MCP — the staleness
     * contract is part of the port, and the columns are where it lives.
     */
    skillsHash: text("skills_hash"),
    mcpConfigHash: text("mcp_config_hash"),
  },
  (table) => [
    /*
     * The sidebar query verbatim: user + INTERACTIVE, newest first, LIMIT — one index scan, no
     * sort. (onyx ix_build_session_user_origin_created.)
     */
    index("craft_sessions_user_origin_created_idx").on(
      table.userId,
      table.origin,
      table.createdAt.desc(),
    ),
    // The sweeps' working set: idle-marking and repair scans start from status.
    index("craft_sessions_status_idx").on(table.status),
    /*
     * Durable port reservation, scoped per user — ports only collide within one user's sandbox.
     * Partial so the unallocated (NULL) majority never collides with anything. (onyx
     * uq_build_session_nextjs_port.)
     */
    uniqueIndex("craft_sessions_user_port_idx")
      .on(table.userId, table.nextjsPort)
      .where(sql`${table.nextjsPort} IS NOT NULL`),
    check(
      "craft_sessions_status_check",
      sql`${table.status} IN ('initializing', 'active', 'idle', 'failed')`,
    ),
    check(
      "craft_sessions_origin_check",
      sql`${table.origin} IN ('INTERACTIVE', 'SCHEDULED', 'SLACK')`,
    ),
    check(
      "craft_sessions_sharing_scope_check",
      sql`${table.sharingScope} IN ('private', 'public_org')`,
    ),
  ],
);

/**
 * The persisted half of a session's transcript. Everything a turn produced — accumulated agent
 * messages and thoughts, completed tool calls, plan upserts, context usage, turn-terminal errors
 * — lands here as the raw sandbox event packet in `messageMetadata`, byte-identical to what the
 * SSE stream sent. Reload and replay therefore read one table and need no translation.
 *
 * `turnIndex` groups every assistant row under the user prompt it answers (0-based, counting
 * USER rows); within a turn, `createdAt` is the order. `type` is the coarse classification only;
 * the packet's own `type` field (`user_message`, `tool_call_progress`, …) is the fine one.
 *
 * onyx stores the enum member NAME ("USER", "ASSISTANT", …) because SQLAlchemy non-native enums
 * do that; here the lowercase wire values are stored instead — the store layer is written
 * against this table, so nothing ported reads the column expecting uppercase.
 */
export const craftMessages = pgTable(
  "craft_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => craftSessions.id, { onDelete: "cascade" }),
    turnIndex: integer("turn_index").notNull(),
    type: text("type").$type<CraftMessageType>().notNull(),
    /** The whole event packet, as sent over SSE. Uncapped by design — parity over prudence. */
    messageMetadata: jsonb("message_metadata").notNull(),
    createdAt: stamp("created_at"),
  },
  (table) => [
    // The transcript read: one session, ordered by (turn, time). (onyx ix_build_message_session_turn.)
    index("craft_messages_session_turn_idx").on(
      table.sessionId,
      table.turnIndex,
      table.createdAt,
    ),
    check(
      "craft_messages_type_check",
      sql`${table.type} IN ('system', 'user', 'assistant', 'tool_call_response', 'user_reminder')`,
    ),
  ],
);

/**
 * One packed backup of a session's workspace (outputs + attachments), taken before the sandbox
 * sleeps; restore replays the newest row. The first phase keeps sandboxes warm, so the
 * sleep/snapshot pipeline is deferred — the table ships now so the port is complete and the
 * restore path has somewhere durable to point when that phase lands.
 */
export const craftSnapshots = pgTable(
  "craft_snapshots",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => craftSessions.id, { onDelete: "cascade" }),
    /** Where the packed bytes live (file store key); bytes are read from there, not this row. */
    storagePath: text("storage_path").notNull(),
    /** bigint because archives cross int4; `number` mode keeps the API boundary a JS number. */
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    createdAt: stamp("created_at"),
  },
  (table) => [
    // "Latest snapshot for this session" is this table's only read. (onyx ix_snapshot_session_created.)
    index("craft_snapshots_session_created_idx").on(
      table.sessionId,
      table.createdAt.desc(),
    ),
  ],
);
