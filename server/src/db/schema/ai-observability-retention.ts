import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The per-scope retention override table (Issue #41 / DAG T35).
 *
 * One row widens or narrows one scope's retention windows past the deployment
 * defaults (`OPIK_RETENTION_RUNS_DAYS` / `OPIK_RETENTION_DATASETS_DAYS`); a
 * scope without a row keeps the defaults. Retention here is governance, not
 * authorization: the sweep deletes by these windows whether or not the actor
 * still holds any permission, so the override is written by the operator seam
 * that owns the deployment's retention posture, never by a request body.
 *
 * Zero is a deliberate answer, not a mistake: it says "keep this scope's data
 * forever", which the sweep must respect rather than second-guess — the same
 * off-unless-said stance the audit trail's own retention takes. The CHECK
 * bounds the column at non-negative for exactly that vocabulary; a negative
 * window would mean "already expired before it was written" and is refused.
 */

export const aiObservationRetentionPolicies = pgTable(
  "ai_observation_retention_policies",
  {
    /** The trusted scope's key, as the observation tables store it. */
    scopeKey: text("scope_key").primaryKey(),
    /** Days a run record (binding + upstream trace) survives; 0 keeps forever. */
    runsDays: integer("runs_days").notNull(),
    /** Days dataset versions and experiments survive; 0 keeps forever. */
    datasetsDays: integer("datasets_days").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "ai_observation_retention_policies_runs_days_check",
      sql`${table.runsDays} >= 0`,
    ),
    check(
      "ai_observation_retention_policies_datasets_days_check",
      sql`${table.datasetsDays} >= 0`,
    ),
  ],
);
