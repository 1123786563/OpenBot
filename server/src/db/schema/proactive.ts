import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  ProactiveRunStatus,
  SuggestionStatus,
} from "../../proactive/types";
import { agents, users } from "./core";

/**
 * Background research by one of a person's Bots.
 *
 * Default-on adoption left with the memory engine (#732), so OpenBot no longer writes the row on a
 * person's first talk. When a row exists it is never re-created once they turn it off (`enabled =
 * false`) or remove it (`default_opt_outs`). Bounded by `interval_minutes` (one to twenty-four hours) so a Bot never
 * reads a person's apps more often than they chose. The run lands in its own thread, not
 * the person's chat, and what it finds reaches them as suggestions delivered to `channel_id`.
 */
export const proactiveSettings = pgTable(
  "proactive_settings",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    threadId: text("thread_id").notNull(),
    focus: text("focus").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    intervalMinutes: integer("interval_minutes").notNull().default(240),
    nextRunAt: timestamp("next_run_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastStatus: text("last_status")
      .$type<ProactiveRunStatus>()
      .notNull()
      .default("idle"),
    lastError: text("last_error"),
    /**
     * MT045 (Issue #88): the persisted company/team mapping, null on legacy personal settings.
     * Create-once like the MT044 trigger columns; liveness is resolved at delivery time.
     */
    tenantId: text("tenant_id"),
    workspaceId: text("workspace_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("proactive_settings_owner_agent_idx").on(
      table.ownerUserId,
      table.agentId,
    ),
    index("proactive_settings_due_idx").on(table.enabled, table.nextRunAt),
    index("proactive_settings_tenant_idx").on(table.tenantId),
    check(
      "proactive_settings_interval_check",
      sql`${table.intervalMinutes} >= 60 AND ${table.intervalMinutes} <= 1440`,
    ),
    check(
      "proactive_settings_status_check",
      sql`${table.lastStatus} IN ('idle', 'running', 'succeeded', 'error')`,
    ),
  ],
);

/** A next step a background run proposed, for its owner to start or dismiss. */
export const proactiveSuggestions = pgTable(
  "proactive_suggestions",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    settingId: text("setting_id")
      .notNull()
      .references(() => proactiveSettings.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    sourceApp: text("source_app"),
    sourceRef: text("source_ref"),
    sourceLink: text("source_link"),
    status: text("status").$type<SuggestionStatus>().notNull().default("open"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("proactive_suggestions_owner_idx").on(
      table.ownerUserId,
      table.status,
      table.createdAt,
    ),
    index("proactive_suggestions_run_idx").on(table.runId),
    check(
      "proactive_suggestions_status_check",
      sql`${table.status} IN ('open', 'dismissed', 'started')`,
    ),
  ],
);
