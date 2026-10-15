import { integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * The gateway connection configuration, one singleton row (`id = 'default'`).
 *
 * `config_version` increments on every successful save, so every consumer (probe, readiness gate,
 * credential ref) can pin the version it acted on and refuse to act on stale assumptions. No
 * secret lives here: admin credentials are stored by the credential store (ticket 01.2), never in
 * this row, so this table is safe to read for status display.
 */
export const gatewayConfigs = pgTable(
  "gateway_configs",
  {
    id: text("id").primaryKey(),
    baseUrl: text("base_url").notNull(),
    requestTimeoutMs: integer("request_timeout_ms").notNull().default(10_000),
    configVersion: integer("config_version").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("gateway_configs_singleton").on(table.id)],
);
