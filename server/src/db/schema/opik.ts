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

export const opikEvaluations = pgTable(
  "opik_evaluations",
  {
    id: uuid("id").primaryKey(),
    requestId: uuid("request_id").notNull(),
    operatorId: text("operator_id").notNull(),
    project: text("project").notNull(),
    kind: text("kind")
      .$type<"synthetic" | "real">()
      .notNull()
      .default("synthetic"),
    target: text("target"),
    workspace: text("workspace"),
    cleanupDueAt: timestamp("cleanup_due_at", { withTimezone: true }),
    cleanupFirstDeletedAt: timestamp("cleanup_first_deleted_at", {
      withTimezone: true,
    }),
    cleanupCompletedAt: timestamp("cleanup_completed_at", {
      withTimezone: true,
    }),
    cases: integer("cases").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    status: text("status")
      .$type<"pending" | "completed" | "failed">()
      .notNull()
      .default("pending"),
  },
  (table) => [
    index("opik_evaluations_budget_idx").on(table.createdAt),
    unique().on(table.kind, table.requestId),
  ],
);

export const opikEvaluationGrants = pgTable(
  "opik_evaluation_grants",
  {
    id: uuid("id").primaryKey(),
    memoryId: text("memory_id").notNull(),
    ownerId: text("owner_id").notNull(),
    contentSha256: text("content_sha256").notNull(),
    purpose: text("purpose").$type<"normalization-fidelity">().notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("opik_eval_grants_active_source_idx")
      .on(table.memoryId)
      .where(sql`${table.revokedAt} is null`),
    index("opik_eval_grants_revoked_idx")
      .on(table.revokedAt, table.id)
      .where(sql`${table.revokedAt} is not null`),
  ],
);
