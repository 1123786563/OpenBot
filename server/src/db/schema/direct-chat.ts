import type { BaseEvent } from "@ag-ui/client";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { intelligenceChannelMappings } from "./core";
import { groupBotThreads } from "./group";

export const directChatRuns = pgTable(
  "direct_chat_runs",
  {
    threadId: text("thread_id").notNull(),
    groupThreadId: text("group_thread_id").references(
      () => groupBotThreads.threadId,
      { onDelete: "cascade" },
    ),
    directThreadId: text("direct_thread_id")
      .generatedAlwaysAs(
        sql`case when group_thread_id is null then thread_id end`,
      )
      .references(() => intelligenceChannelMappings.threadId, {
        onDelete: "cascade",
      }),
    waitingApprovalId: text("waiting_approval_id"),
    handoffFromBotId: text("handoff_from_bot_id"),
    id: text("id").notNull(),
    userMessageId: text("user_message_id").notNull(),
    prompt: text("prompt").notNull(),
    assistantMessageId: text("assistant_message_id"),
    reply: text("reply"),
    status: text("status")
      .$type<"running" | "completed" | "failed">()
      .notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    externalOutcome: text("external_outcome").$type<
      "dispatching" | "unknown" | "executed" | "not_dispatched"
    >(),
    stopReason: text("stop_reason").$type<"stopped" | "access_revoked" | "context_revoked">(),
    eventCursor: integer("event_cursor").notNull().default(0),
    partialMessageId: text("partial_message_id"),
    partialReply: text("partial_reply"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.id] }),
    check(
      "direct_chat_runs_group_thread_check",
      sql`${table.groupThreadId} is null or ${table.groupThreadId} = ${table.threadId}`,
    ),
    uniqueIndex("direct_chat_runs_request_idx").on(
      table.threadId,
      table.userMessageId,
    ),
    check(
      "direct_chat_runs_status_check",
      sql`${table.status} in ('running', 'completed', 'failed')`,
    ),
  ],
);

export const directChatRunEvents = pgTable(
  "direct_chat_run_events",
  {
    threadId: text("thread_id").notNull(),
    runId: text("run_id").notNull(),
    cursor: integer("cursor").notNull(),
    event: jsonb("event").$type<BaseEvent>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.runId, table.cursor] }),
    foreignKey({
      columns: [table.threadId, table.runId],
      foreignColumns: [directChatRuns.threadId, directChatRuns.id],
    }).onDelete("cascade"),
    index("direct_chat_run_events_created_idx").on(table.createdAt),
  ],
);
