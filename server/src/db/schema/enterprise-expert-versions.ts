import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { enterpriseTenants } from "./enterprise-tenancy";
import { jsonb } from "./json";

export const enterpriseExpertVersions = pgTable(
  "enterprise_expert_versions",
  {
    tenantId: text("tenant_id").notNull(),
    expertVersionRef: text("expert_version_ref").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    agentId: text("agent_id").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.expertVersionRef] }),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    check(
      "enterprise_expert_versions_schema_version_check",
      sql`${table.schemaVersion} > 0`,
    ),
    pgPolicy("enterprise_expert_versions_data_scope", {
      for: "all",
      to: "ob_ent_data",
      using: sql`enterprise_expert_versions.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`enterprise_expert_versions.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();
