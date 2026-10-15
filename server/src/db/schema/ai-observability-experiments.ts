import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { FrozenExperimentConfig } from "../../ai-observability/experiments";
import { aiObservationDatasetVersions } from "./ai-observability-datasets";

/**
 * The experiment side of evaluation: one experiment subject per (scope, name), whose
 * configuration is exactly what it was at submit — forever (Issue #28 / DAG T22).
 *
 * A submitted experiment pins a T19 dataset version by id, and the `dataset_content_hash`
 * column repeats that version's content hash so the row alone can name which frozen content
 * it evaluates against. The rest of the frozen configuration — Bot configuration snapshot,
 * prompt, model and parameters, tool fixtures, judge/scorer configuration and version — lives
 * in one projected `config` jsonb: the submit pipeline projects every field through the T05
 * policy before it is hashed or stored, so no path into this table can freeze a credential
 * into an evaluation configuration even if a caller claims it is safe.
 *
 * Identity is content, exactly like T19's versions: the canonical JSON of the projected
 * configuration under the current redaction policy hashes to `config_hash`, and a frozen row
 * is unique on (scope, config hash). Submitting the same configuration again — same name or
 * not — hits the experiment that already exists instead of minting a second one. The database
 * decides the replay; retries cannot produce a second experiment.
 *
 * The state vocabulary is two words, fail-closed: `draft` (mutable, `frozen_at` null, hash
 * empty) and `frozen` (immutable, hash and freeze time set), and the coherence check refuses
 * any row that is half of either. Immutability is a database fact, not a discipline:
 * migration 0125 installs a BEFORE UPDATE trigger that raises on any UPDATE of a frozen row,
 * so a later code change cannot rewrite what an evaluation already ran under, and a BEFORE
 * DELETE trigger that refuses every delete outside the cleanup path.
 */

export type AiObservationExperimentState = "draft" | "frozen";

export const aiObservationExperiments = pgTable(
  "ai_observation_experiments",
  {
    id: text("id").primaryKey(),
    /** The trusted scope's key. The experiment and its name live in this key space. */
    scopeKey: text("scope_key").notNull(),
    actorId: text("actor_id").notNull(),
    botId: text("bot_id").notNull(),
    name: text("name").notNull(),
    /** The T19 frozen dataset version this experiment evaluates against. */
    datasetVersionId: text("dataset_version_id")
      .notNull()
      .references(() => aiObservationDatasetVersions.id),
    /** That version's content hash, so the pin is traceable to concrete frozen content. */
    datasetContentHash: text("dataset_content_hash").notNull(),
    /** The frozen configuration: every field projected before it reached here. */
    config: jsonb("config").$type<FrozenExperimentConfig>().notNull(),
    /** sha-256 of the canonical JSON of the projected config under the recorded policy. */
    configHash: text("config_hash").notNull().default(""),
    state: text("state")
      .$type<AiObservationExperimentState>()
      .notNull()
      .default("draft"),
    /** Set by the freeze itself; null exactly while the row is still a draft. */
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "ai_observation_experiments_state_check",
      sql`${table.state} IN ('draft', 'frozen')`,
    ),
    // A row is wholly a draft or wholly frozen: a frozen row without its hash and freeze time,
    // or a draft carrying them, is a state machine lie and the database refuses it.
    check(
      "ai_observation_experiments_frozen_coherence_check",
      sql`(${table.state} = 'draft' AND ${table.frozenAt} IS NULL) OR (${table.state} = 'frozen' AND ${table.frozenAt} IS NOT NULL AND ${table.configHash} <> '')`,
    ),
    uniqueIndex("ai_observation_experiments_scope_name_uq").on(
      table.scopeKey,
      table.name,
    ),
    // The idempotency key: within one scope, one canonical configuration is one frozen
    // experiment, whatever name a retry arrives under. Draft rows are exempt — their hash is
    // empty and their content is still being composed.
    uniqueIndex("ai_observation_experiments_scope_config_hash_frozen_uq")
      .on(table.scopeKey, table.configHash)
      .where(sql`${table.state} = 'frozen'`),
  ],
);
