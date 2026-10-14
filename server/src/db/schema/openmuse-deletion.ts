import { jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/*
 * The §9 account-deletion tables (D01/D04), living in db/schema like every
 * other table so drizzle-kit's bundled import graph stays inside the
 * schema directory: when the definitions lived in
 * openmuse-deletion/store.ts, the migration toolchain also executed that
 * module's value-level import graph (store → manifest → google-oauth → a
 * pino logger constructed at module top level; store → manifest →
 * retention → restore → store, a cycle) — load-time side effects in
 * migration tooling that only "happened to work". openmuse-deletion/store.ts
 * imports these definitions back and keeps re-exporting them, so no caller
 * changes (round 6 M7).
 */

/** The deletion marker itself, in the §9 shape (see openmuse-deletion/store.ts). */
export const openmuseAccountDeletions = pgTable("openmuse_account_deletions", {
  userId: text("user_id").primaryKey(),
  disabledAt: timestamp("disabled_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  phase: text("phase")
    .$type<"fenced" | "restored" | "completed">()
    .notNull()
    .default("fenced"),
  restoreUntil: timestamp("restore_until", { withTimezone: true }),
  resources: jsonb("resources").$type<string[]>().notNull().default([]),
});

/** One durable row per owner resource, hanging from the marker by manifestId (D04). */
export const openmuseDeletionResources = pgTable(
  "openmuse_deletion_resources",
  {
    manifestId: text("manifest_id").notNull(),
    kind: text("kind").notNull(),
    id: text("id").notNull(),
    externalKey: text("external_key").notNull().default(""),
    state: text("state")
      .$type<"pending" | "deleted" | "retryable_error">()
      .notNull()
      .default("pending"),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.manifestId, table.kind, table.id, table.externalKey],
    }),
  ],
);
