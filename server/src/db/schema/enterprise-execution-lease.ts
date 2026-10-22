import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  enterpriseMemberships,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";

/**
 * MT046 (Issue #89): what a service identity may do on an execution surface.
 *
 * A lease row fixes who (tenant, workspace, principal), which instance (bot), what (the closed
 * purpose set) and for how long — the MT029 credential-lease shape applied to the computer/browser
 * faces whose deployment tokens are otherwise machine-level equivalent. The registered purposes
 * are the ONLY grants a lease carries: screen viewing, control takeover and instance operation.
 * Nothing here can name company data, so a lease presented for anything beyond its registry —
 * including "read any company's data" — fails validation with the canonical not-found shape.
 * Validation re-reads the live row and the holder's memberships on every checkpoint; revocation
 * and expiry take effect at the next checkpoint, never from a cache.
 *
 * RLS lives in 0178 alongside the grants (data role reads/inserts its own scope's rows; operator
 * reads and flips status/revoked_at only), following the enterprise-bot-ownership shape.
 */
export const enterpriseExecutionCapabilityLeases = pgTable(
  "enterprise_execution_capability_leases",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => enterpriseTenants.id, { onDelete: "cascade" }),
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    botId: text("bot_id").notNull(),
    purposes: text("purposes").array().notNull(),
    status: text("status").notNull().default("active"),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("enterprise_execution_capability_lease_scope_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.issuedAt,
    ),
    index("enterprise_execution_capability_lease_bot_idx").on(
      table.tenantId,
      table.botId,
    ),
    // Composite FKs prove the company is the same across all three scope columns.
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    check(
      "enterprise_execution_capability_leases_status",
      sql`${table.status} IN ('active', 'revoked')`,
    ),
    check(
      "enterprise_execution_capability_leases_purposes",
      sql`${table.purposes} <@ ARRAY['screen.view', 'control.take', 'instance.operate']::text[]`,
    ),
    check(
      "enterprise_execution_capability_leases_ttl",
      sql`${table.expiresAt} > ${table.issuedAt}`,
    ),
  ],
);

export type ExecutionCapabilityLeaseRow =
  typeof enterpriseExecutionCapabilityLeases.$inferSelect;
