/**
 * Enterprise tenancy: tenants, the principals that bind authenticated users into them, memberships,
 * and workspaces. Plan 02 §5 T1-A.
 *
 * Tenancy is never added to `users`: the global identity record stays deployment-wide, and a
 * person's presence in an enterprise is expressed as rows here — one principal per user, one
 * membership per (tenant, principal). Composite keys are the exact combinations the plan lists;
 * migration generation goes through T1-B's isolated migration entry, never `db:generate`.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./core";

const stamp = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const enterpriseTenants = pgTable(
  "enterprise_tenants",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    /*
     * The authorization rule revision every reader in this tenant is held to. Changed only under
     * the tenant exclusive lock, so a scope minted against one revision can be re-checked against
     * exactly one answer.
     */
    policyRevision: text("policy_revision").notNull().default("tenancy-v1"),
    createdAt: stamp(),
  },
  (t) => [
    check(
      "enterprise_tenant_status",
      sql`${t.status} in ('active','suspended')`,
    ),
  ],
);

export const enterprisePrincipals = pgTable(
  "enterprise_principals",
  {
    id: text("id").primaryKey(),
    /*
     * The deployment's own authenticated user this principal speaks for. One principal per user:
     * the directory answers "who is this person in enterprises" from this binding, so a second row
     * would make the answer depend on whichever row the query found first.
     */
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    status: text("status").notNull().default("active"),
    createdAt: stamp(),
  },
  (t) => [
    uniqueIndex("enterprise_principal_user").on(t.userId),
    check(
      "enterprise_principal_status",
      sql`${t.status} in ('active','suspended')`,
    ),
  ],
);

export const enterpriseMemberships = pgTable(
  "enterprise_memberships",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => enterpriseTenants.id),
    principalId: text("principal_id")
      .notNull()
      .references(() => enterprisePrincipals.id),
    role: text("role").notNull(),
    status: text("status").notNull().default("active"),
    /*
     * Bumped on every suspension or revocation. A scope carries the epoch it was minted at, and a
     * read transaction re-checks it, so a stale scope cannot keep answering for a member that has
     * since been suspended.
     */
    epoch: integer("epoch").notNull().default(1),
    createdAt: stamp(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.principalId] }),
    check(
      "enterprise_member_role",
      sql`${t.role} in ('tenant_admin','member','auditor')`,
    ),
    check(
      "enterprise_member_status",
      sql`${t.status} in ('active','suspended')`,
    ),
    check("enterprise_member_epoch", sql`${t.epoch} > 0`),
    /*
     * The primary key serves tenant-first scans; suspension and revocation lookups start from the
     * principal ("what does this person still hold"), so this is the reverse direction rather than
     * a duplicate of the key.
     */
    index("enterprise_memberships_principal_tenant_idx").on(
      t.principalId,
      t.tenantId,
    ),
  ],
);

export const enterpriseWorkspaces = pgTable(
  "enterprise_workspaces",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => enterpriseTenants.id),
    id: text("id").notNull(),
    name: text("name").notNull(),
    createdAt: stamp(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);
