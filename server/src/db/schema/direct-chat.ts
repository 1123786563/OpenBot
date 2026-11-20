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

export const directChatRuns = pgTable(
  "direct_chat_runs",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => intelligenceChannelMappings.threadId, {
        onDelete: "cascade",
      }),
    id: text("id").notNull(),
    userMessageId: text("user_message_id").notNull(),
    prompt: text("prompt").notNull(),
    assistantMessageId: text("assistant_message_id"),
    reply: text("reply"),
    status: text("status")
      .$type<"running" | "completed" | "failed">()
      .notNull(),
    eventCursor: integer("event_cursor").notNull().default(0),
    partialMessageId: text("partial_message_id"),
    partialReply: text("partial_reply"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.id] }),
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
