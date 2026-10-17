import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { FrozenDatasetCase } from "../../ai-observability/datasets";
// The repo's single-serialization jsonb (m190/m194): drizzle's native jsonb
// double-encodes under the Bun SQL driver, landing jsonb_typeof = "string" —
// SQL-side JSON operators read NULL. dataType stays "jsonb", so no migration.
import { jsonbArray } from "./json";

/**
 * The dataset side of evaluation: one dataset subject per (scope, name), and one immutable
 * frozen version per (scope, dataset, content hash).
 *
 * Unlike the binding table, the versions table is deliberately a content store — its whole job
 * is holding reviewed, already-projected case snapshots (safe input, reference output, tool
 * fixtures) plus the provenance a later experiment needs to re-locate the content: the
 * redaction policy version it was projected under, the observed run each case came from, and
 * the T06 storage locator naming where the upstream copy lives. What must never appear in any
 * column is a credential, secret or contact surface — the freeze pipeline projects content
 * before it reaches this table, and the hash is taken after projection.
 *
 * Immutability is a database fact, not a discipline: migration 0123 installs a BEFORE UPDATE
 * trigger that raises on any UPDATE of a version row, so a candidate edit or a later code
 * change cannot rewrite what an experiment already pinned. Saving different cases mints a
 * different content hash and therefore a different version row — the previous one stands.
 *
 * The subject row carries the upstream synchronization truth. `sync_state` starts `pending` and
 * only reaches `synced` together with the upstream dataset id (enforced by check), so a
 * pending or syncing dataset can never be mistaken for one whose upstream copy exists. A
 * failed push parks in `failed` and may retry or be deleted — partial success is recoverable
 * or cleaned up, never silently upgraded.
 */

export type AiObservationDatasetSyncState =
  | "pending"
  | "syncing"
  | "synced"
  | "failed";

export const aiObservationDatasets = pgTable(
  "ai_observation_datasets",
  {
    id: text("id").primaryKey(),
    /** The trusted scope's key. The dataset, its names and its versions live in this key space. */
    scopeKey: text("scope_key").notNull(),
    actorId: text("actor_id").notNull(),
    botId: text("bot_id").notNull(),
    name: text("name").notNull(),
    /** Where this scope's records live upstream — derived from the scope, never client-supplied. */
    locatorWorkspace: text("locator_workspace").notNull(),
    locatorProject: text("locator_project").notNull(),
    /** Opik's dataset id, recorded once a push actually succeeded; null until then. */
    opikDatasetId: text("opik_dataset_id"),
    syncState: text("sync_state")
      .$type<AiObservationDatasetSyncState>()
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "ai_observation_datasets_sync_state_check",
      sql`${table.syncState} IN ('pending', 'syncing', 'synced', 'failed')`,
    ),
    // `synced` is a claim that the upstream copy exists; the id is the proof. The database
    // refuses the claim without it, so no code path can report success speculatively.
    check(
      "ai_observation_datasets_synced_requires_upstream_check",
      sql`${table.opikDatasetId} IS NOT NULL OR ${table.syncState} <> 'synced'`,
    ),
    uniqueIndex("ai_observation_datasets_scope_name_uq").on(
      table.scopeKey,
      table.name,
    ),
    uniqueIndex("ai_observation_datasets_scope_opik_dataset_uq")
      .on(table.scopeKey, table.opikDatasetId)
      .where(sql`${table.opikDatasetId} IS NOT NULL`),
    // The retention discovery predicate's filter column (m164).
    index("ai_observation_datasets_created_at_idx").on(table.createdAt),
  ],
);

export const aiObservationDatasetVersions = pgTable(
  "ai_observation_dataset_versions",
  {
    id: text("id").primaryKey(),
    scopeKey: text("scope_key").notNull(),
    datasetId: text("dataset_id")
      .notNull()
      .references(() => aiObservationDatasets.id, {
        onDelete: "cascade",
      }),
    /** sha-256 of the canonical JSON of the frozen cases under the recorded policy version. */
    contentHash: text("content_hash").notNull(),
    /** The T05 policy the content was projected with before freezing, e.g. "opik-redaction/5". */
    redactionPolicyVersion: text("redaction_policy_version").notNull(),
    /** The frozen case snapshots: projected input, reference output, fixtures and provenance. */
    cases: jsonbArray("cases").$type<readonly FrozenDatasetCase[]>().notNull(),
    locatorWorkspace: text("locator_workspace").notNull(),
    locatorProject: text("locator_project").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The idempotency key: saving the same frozen content again under the same scope and
    // dataset hits the row that already exists instead of minting a new version. Its
    // (scope, dataset) prefix also serves the version listing read for one dataset.
    uniqueIndex("ai_observation_dataset_versions_scope_dataset_hash_uq").on(
      table.scopeKey,
      table.datasetId,
      table.contentHash,
    ),
    // The retention pin anti-join and the FK CASCADE backstop (R2-23≡R2-27) both
    // reach versions by dataset_id alone; the composite uq above leads with
    // scope_key and cannot serve that single-column path.
    index("ai_observation_dataset_versions_dataset_id_idx").on(table.datasetId),
  ],
);
