import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { directChatRuns } from "./direct-chat";

export const opikRuns = pgTable(
  "opik_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: text("thread_id").notNull(),
    runId: text("run_id").notNull(),
    status: text("status").$type<"completed" | "failed">().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    trace: text("trace")
      .$type<"pending" | "delivered" | "dropped">()
      .notNull()
      .default("pending"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leaseId: uuid("lease_id"),
    feedbackId: uuid("feedback_id"),
    score: integer("score"),
    comment: text("comment"),
    feedbackDeliveredAt: timestamp("feedback_delivered_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    foreignKey({
      columns: [table.threadId, table.runId],
      foreignColumns: [directChatRuns.threadId, directChatRuns.id],
    }).onDelete("cascade"),
    unique().on(table.threadId, table.runId),
    check(
      "opik_runs_feedback_check",
      sql`(${table.feedbackId} is null and ${table.score} is null) or (${table.feedbackId} is not null and ${table.score} is not null and ${table.score} in (0, 1))`,
    ),
    index("opik_runs_due_idx")
      .on(table.dueAt)
      .where(
        sql`${table.trace} = 'pending' or (${table.score} is not null and ${table.feedbackDeliveredAt} is null)`,
      ),
    index("opik_runs_expiry_idx")
      .on(table.finishedAt)
      .where(sql`${table.trace} = 'pending'`),
  ],
);
