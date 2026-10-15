import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Trusted control-plane registry. Runtime identities receive no grants on this table. */
export const mastraTenantStorageRegistry = pgTable(
  "mastra_tenant_storage_registry",
  {
    tenantId: text("tenant_id").primaryKey(),
    storageKey: text("storage_key").notNull(),
    schemaName: text("schema_name").notNull(),
    roleVersion: integer("role_version").notNull(),
    status: text("status").notNull(),
    claimToken: uuid("claim_token"),
    credentialRef: text("credential_ref"),
    runtimeRole: text("runtime_role"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("mastra_tenant_storage_key_unique").on(table.storageKey),
    uniqueIndex("mastra_tenant_storage_schema_unique").on(table.schemaName),
    check("mastra_tenant_storage_role_version", sql`${table.roleVersion} > 0`),
    check(
      "mastra_tenant_storage_status",
      sql`${table.status} in ('provisioning','ready')`,
    ),
    check(
      "mastra_tenant_storage_state",
      sql`(${table.status} = 'provisioning' and ${table.claimToken} is not null and ${table.credentialRef} is null and ${table.runtimeRole} is null and ${table.readyAt} is null) or (${table.status} = 'ready' and ${table.claimToken} is null and ${table.credentialRef} is not null and ${table.runtimeRole} is not null and ${table.readyAt} is not null)`,
    ),
  ],
);
