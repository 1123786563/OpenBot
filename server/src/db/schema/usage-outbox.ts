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

export type UsageOutboxSource = "llm" | "code_run";
export type UsageOutboxDeliveryStatus = "pending" | "delivered";

export const usageOutbox = pgTable(
  "usage_outbox",
  {
    eventId: text("event_id").primaryKey(),
    source: text("source").$type<UsageOutboxSource>().notNull(),
    externalCustomerId: text("external_customer_id").notNull(),
    transactionId: text("transaction_id").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    model: text("model").notNull(),
    client: text("client").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    runId: text("run_id"),
    botId: text("bot_id"),
    ownerUserId: text("owner_user_id"),
    sessionId: text("session_id"),
    status: text("status"),
    lagoStatus: text("lago_status")
      .$type<UsageOutboxDeliveryStatus>()
      .notNull()
      .default("pending"),
    creditsStatus: text("credits_status")
      .$type<UsageOutboxDeliveryStatus>()
      .notNull()
      .default("pending"),
    lagoLastErrorCode: text("lago_last_error_code"),
    creditsLastErrorCode: text("credits_last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "usage_outbox_source_check",
      sql`${table.source} IN ('llm', 'code_run')`,
    ),
    check("usage_outbox_input_tokens_check", sql`${table.inputTokens} >= 0`),
    check("usage_outbox_output_tokens_check", sql`${table.outputTokens} >= 0`),
    check(
      "usage_outbox_lago_status_check",
      sql`${table.lagoStatus} IN ('pending', 'delivered')`,
    ),
    check(
      "usage_outbox_credits_status_check",
      sql`${table.creditsStatus} IN ('pending', 'delivered')`,
    ),
    uniqueIndex("usage_outbox_transaction_id_unique_idx").on(
      table.transactionId,
    ),
    index("usage_outbox_lago_pending_updated_idx").on(
      table.lagoStatus,
      table.updatedAt,
    ),
    index("usage_outbox_credits_pending_updated_idx").on(
      table.creditsStatus,
      table.updatedAt,
    ),
  ],
);
