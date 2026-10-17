import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Registered bot services — the server-side identity every external or builtin bot presents
 * (ticket 04.1, #234). Registration grants no credentials and no credit authority: service
 * authentication is 04.2 (#235) and per-user model access grants come later still; this table
 * is only the identity list downstream refuses or allows against.
 *
 * There is no delete: a disabled botId stays reserved (status is the only lever), so an audit
 * trail can never be repointed by recycling an id. `bot_id` is the primary key precisely so a
 * second registration of the same id is refused by the database, not by a check that races.
 */
export const botServices = pgTable("bot_services", {
  botId: text("bot_id").primaryKey(),
  displayName: text("display_name").notNull(),
  /** `builtin` bots ship with the deployment; `external` ones an administrator approved. */
  kind: text("kind").$type<"builtin" | "external">().notNull(),
  /** A non-empty subset of the closed capability enum (chat/image/audio/embedding/realtime/async). */
  capabilities: jsonb("capabilities").$type<string[]>().notNull(),
  status: text("status")
    .$type<"active" | "disabled">()
    .notNull()
    .default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
