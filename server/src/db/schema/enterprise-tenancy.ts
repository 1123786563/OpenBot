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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const enterpriseTenants = pgTable(
  "enterprise_tenants",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    policyRevision: text("policy_revision").notNull().default("tenancy-v1"),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "enterprise_tenant_status",
      sql`${table.status} in ('active','suspended')`,
    ),
    pgPolicy("enterprise_tenant_member_read", {
      for: "select",
      to: "ob_ent_directory",
      using: sql`exists (select 1 from enterprise_memberships m join enterprise_principals p on p.id = m.principal_id where m.tenant_id = enterprise_tenants.id and p.user_id = nullif(current_setting('app.user_id', true), ''))`,
    }),
    pgPolicy("enterprise_tenant_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_tenants.id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_tenant_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_tenants.id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_tenant_context_write", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_tenants.id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

export const enterprisePrincipals = pgTable(
  "enterprise_principals",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("enterprise_principal_user").on(table.userId),
    check(
      "enterprise_principal_status",
      sql`${table.status} in ('active','suspended')`,
    ),
    pgPolicy("enterprise_principal_self_read", {
      for: "select",
      to: "ob_ent_directory",
      using: sql`enterprise_principals.user_id = nullif(current_setting('app.user_id', true), '')`,
    }),
    pgPolicy("enterprise_principal_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_principals.id = nullif(current_setting('app.principal_id', true), '') and enterprise_principals.user_id = nullif(current_setting('app.user_id', true), '')`,
    }),
    pgPolicy("enterprise_principal_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_principals.id = nullif(current_setting('app.operator_principal_id', true), '')`,
    }),
  ],
).enableRLS();

export const enterpriseMemberships = pgTable(
  "enterprise_memberships",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => enterpriseTenants.id, { onDelete: "cascade" }),
    principalId: text("principal_id")
      .notNull()
      .references(() => enterprisePrincipals.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    status: text("status").notNull().default("active"),
    epoch: integer("epoch").notNull().default(1),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.principalId] }),
    uniqueIndex("enterprise_memberships_principal_tenant").on(
      table.principalId,
      table.tenantId,
    ),
    check(
      "enterprise_member_role",
      sql`${table.role} in ('tenant_admin','member','auditor')`,
    ),
    check(
      "enterprise_member_status",
      sql`${table.status} in ('active','suspended')`,
    ),
    check("enterprise_member_epoch", sql`${table.epoch} > 0`),
    pgPolicy("enterprise_membership_self_read", {
      for: "select",
      to: "ob_ent_directory",
      using: sql`exists (select 1 from enterprise_principals p where p.id = enterprise_memberships.principal_id and p.user_id = nullif(current_setting('app.user_id', true), ''))`,
    }),
    pgPolicy("enterprise_membership_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_memberships.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_memberships.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_membership_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_memberships.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_membership_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_memberships.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_membership_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`enterprise_memberships.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_memberships.principal_id = nullif(current_setting('app.operator_principal_id', true), '')`,
      withCheck: sql`enterprise_memberships.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_memberships.principal_id = nullif(current_setting('app.operator_principal_id', true), '')`,
    }),
  ],
).enableRLS();

export const enterpriseWorkspaces = pgTable(
  "enterprise_workspaces",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }).onDelete("cascade"),
    pgPolicy("enterprise_workspace_tenant_scope", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_workspaces.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_workspace_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_workspaces.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_workspace_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_workspaces.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

export const enterpriseResources = pgTable(
  "enterprise_resources",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    kind: text("kind").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("active"),
    revision: integer("revision").notNull().default(1),
    aclEpoch: integer("acl_epoch").notNull().default(1),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }),
    check(
      "enterprise_resource_status",
      sql`${table.status} in ('active','deleted')`,
    ),
    check(
      "enterprise_resource_versions",
      sql`${table.revision} > 0 and ${table.aclEpoch} > 0`,
    ),
    pgPolicy("enterprise_resource_tenant_scope", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_resources.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_resource_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_resources.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_resource_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_resources.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_resource_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`enterprise_resources.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_resources.id = nullif(current_setting('app.resource_id', true), '')`,
      withCheck: sql`enterprise_resources.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_resources.id = nullif(current_setting('app.resource_id', true), '')`,
    }),
  ],
).enableRLS();

export const enterpriseResourceGrants = pgTable(
  "enterprise_resource_grants",
  {
    tenantId: text("tenant_id").notNull(),
    resourceId: text("resource_id").notNull(),
    principalId: text("principal_id").notNull(),
    action: text("action").notNull().default("read"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.resourceId,
        table.principalId,
        table.action,
      ],
    }),
    foreignKey({
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [enterpriseResources.tenantId, enterpriseResources.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    check("enterprise_grant_action", sql`${table.action} = 'read'`),
    pgPolicy("enterprise_grant_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_resource_grants.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_grant_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_resource_grants.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_grant_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_resource_grants.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_grant_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_resource_grants.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_grant_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`enterprise_resource_grants.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_resource_grants.resource_id = nullif(current_setting('app.resource_id', true), '') and enterprise_resource_grants.principal_id = nullif(current_setting('app.operator_principal_id', true), '')`,
    }),
  ],
).enableRLS();

export const enterpriseSecurityEvents = pgTable(
  "enterprise_security_events",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => enterpriseTenants.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    operationId: text("operation_id").notNull(),
    actorId: text("actor_id").notNull(),
    eventType: text("event_type").notNull(),
    details: jsonb("details").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    pgPolicy("enterprise_security_event_tenant_scope", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_security_events.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_security_events.id = nullif(current_setting('app.operation_id', true), '')`,
    }),
    pgPolicy("enterprise_security_event_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_security_events.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_security_events.id = nullif(current_setting('app.operation_id', true), '')`,
    }),
  ],
).enableRLS();

// MT004（Issue #47）：企业团队成员关系（workspace membership），expand-only。
// 唯一成员关系 = (tenant_id, workspace_id, principal_id)；复合外键同时证明
// workspace 属于该公司（→ enterprise_workspaces）与 principal 是该公司成员
// （→ enterprise_memberships）。status 沿用 active/suspended 先例，epoch 为
// 正整数版本号（单调递增由应用写入路径保证，CHECK 兜底正整数）。
// RLS 按同文件既有模式最小新增（全面 RLS 属 MT012）。
export const enterpriseWorkspaceMemberships = pgTable(
  "enterprise_workspace_memberships",
  {
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    status: text("status").notNull().default("active"),
    epoch: integer("epoch").notNull().default(1),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.workspaceId, table.principalId],
    }),
    uniqueIndex("enterprise_workspace_membership_principal_tenant").on(
      table.principalId,
      table.tenantId,
      table.workspaceId,
    ),
    check(
      "enterprise_workspace_member_status",
      sql`${table.status} in ('active','suspended')`,
    ),
    check("enterprise_workspace_member_epoch", sql`${table.epoch} > 0`),
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
    pgPolicy("enterprise_workspace_membership_self_read", {
      for: "select",
      to: "ob_ent_directory",
      using: sql`exists (select 1 from enterprise_principals p where p.id = enterprise_workspace_memberships.principal_id and p.user_id = nullif(current_setting('app.user_id', true), ''))`,
    }),
    pgPolicy("enterprise_workspace_membership_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_workspace_memberships.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_workspace_memberships.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_workspace_membership_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_workspace_memberships.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_workspace_membership_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_workspace_memberships.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_workspace_membership_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`enterprise_workspace_memberships.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_workspace_memberships.principal_id = nullif(current_setting('app.operator_principal_id', true), '')`,
      withCheck: sql`enterprise_workspace_memberships.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_workspace_memberships.principal_id = nullif(current_setting('app.operator_principal_id', true), '')`,
    }),
  ],
).enableRLS();
