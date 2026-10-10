/**
 * Enterprise authorization: tenant-scoped resources, the ACL grants that make them readable, and
 * the two audit domains — per-tenant security events and the global identity event log. Plan 02
 * §5 T1-A.
 *
 * PostgreSQL is the single writer-owned authority for resource ACLs: the local authorization
 * service reads these rows as its snapshot and holds no second copy. `read` and `run` are the
 * grantable actions (spec §6.2's conversations widening); further widening means a new model and
 * new tests, not a relaxed check.
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  enterpriseMemberships,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";
// NOT drizzle's `jsonb`: that one serialises, and so does the driver, so the event body would land
// as a double-encoded string. See ./json.ts.
import { jsonb } from "./json";

export const enterpriseResources = pgTable(
  "enterprise_resources",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("active"),
    revision: integer("revision").notNull().default(1),
    aclEpoch: integer("acl_epoch").notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    // Composite on purpose: a resource may only point at a workspace in its own tenant.
    foreignKey({
      columns: [t.tenantId, t.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }),
    check(
      "enterprise_resource_status",
      sql`${t.status} in ('active','deleted')`,
    ),
    check(
      "enterprise_resource_versions",
      sql`${t.revision}>0 and ${t.aclEpoch}>0`,
    ),
  ],
);

export const enterpriseResourceGrants = pgTable(
  "enterprise_resource_grants",
  {
    tenantId: text("tenant_id").notNull(),
    resourceId: text("resource_id").notNull(),
    principalId: text("principal_id").notNull(),
    action: text("action").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.tenantId, t.resourceId, t.principalId, t.action],
    }),
    foreignKey({
      columns: [t.tenantId, t.resourceId],
      foreignColumns: [enterpriseResources.tenantId, enterpriseResources.id],
    }),
    // A grant may only name a principal that is a member of the same tenant.
    foreignKey({
      columns: [t.tenantId, t.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }),
    // Aligned with the migrated database constraint (0058): `read` stops being the only
    // grantable action, `run` is admitted for the conversations domain (spec §6.2).
    check("enterprise_grant_action", sql`${t.action} in ('read','run')`),
  ],
);

export const enterpriseSecurityEvents = pgTable(
  "enterprise_security_events",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => enterpriseTenants.id),
    /*
     * The event id is the operation id: a replayed provisioning operation writes no second row,
     * it returns the recorded outcome.
     */
    id: text("id").notNull(),
    operationId: text("operation_id").notNull(),
    actor: text("actor").notNull(),
    kind: text("kind").notNull(),
    details: jsonb("details").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    // Audit review walks a tenant's timeline; the id breaks ties within one timestamp.
    index("enterprise_security_events_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
      t.id,
    ),
  ],
);

/*
 * The global identity audit domain: principal creation, suspension and approved binding repairs.
 * Deliberately not tenant-scoped — no placeholder tenant column and no arbitrary tenant to carry
 * events that are older than any membership. Appended to and read by the offline identity
 * operator only; no API role holds a grant on this table.
 */
export const enterpriseIdentityEvents = pgTable("enterprise_identity_events", {
  id: text("id").primaryKey(),
  operationId: text("operation_id").notNull(),
  actor: text("actor").notNull(),
  principalId: text("principal_id").notNull(),
  kind: text("kind").notNull(),
  details: jsonb("details").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
