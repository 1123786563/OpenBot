import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Registered bot services — the server-side identity every external or builtin bot presents.
 * Registration grants no credentials and no credit authority (auth is 04.2, grants are 04.5).
 * There is no delete: `disabled` is terminal-but-reversible by re-enable, and a botId is never
 * reused, so an audit trail cannot be repointed by recycling an id.
 */
export const botServices = pgTable("bot_services", {
  botId: text("bot_id").primaryKey(),
  displayName: text("display_name").notNull(),
  kind: text("kind").$type<"builtin" | "external">().notNull(),
  capabilities: jsonb("capabilities").$type<string[]>().notNull(),
  status: text("status").$type<"active" | "disabled">().notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
