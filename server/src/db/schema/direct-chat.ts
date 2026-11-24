import { sql } from "drizzle-orm";
import {
  check,
  index,
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
    testCreditOperationId: text("test_credit_operation_id"),
    assistantMessageId: text("assistant_message_id"),
    reply: text("reply"),
    status: text("status")
      .$type<"running" | "completed" | "failed">()
      .notNull(),
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
    index("direct_chat_runs_credit_recovery_idx")
      .on(table.startedAt)
      .where(
        sql`${table.testCreditOperationId} IS NOT NULL AND ${table.status} <> 'completed'`,
      ),
    check(
      "direct_chat_runs_status_check",
      sql`${table.status} in ('running', 'completed', 'failed')`,
    ),
  ],
);
