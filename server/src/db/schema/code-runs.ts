import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export type CodeRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "refused";

/**
 * One governed execution of the run_code tool.
 *
 * The row is the audit trail's join key: the gateway writes it (and the `code.run_started` audit
 * event) BEFORE the sandbox is called, so a run that was never recorded is a run that never
 * reached the sandbox. Usage lands here even when no billing backend is mounted, so a deployment
 * can retro-fit metering without losing history.
 */
export const codeRuns = pgTable(
  "code_runs",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    task: text("task").notNull(),
    model: text("model"),
    status: text("status").$type<CodeRunStatus>().notNull().default("running"),
    sessionId: text("session_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    artifactPaths: text("artifact_paths"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("code_runs_bot_idx").on(table.botId)],
);
