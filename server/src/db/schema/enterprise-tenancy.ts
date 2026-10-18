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
    // MT008（Issue #51）：资源可见性属性，expand-only 追加。NULL = 未标记
    // （遗留资源：行为 = 既有 grant 语义，两个策略版本下都不变）；
    // 'private' = 个人资源（显式选择，仍走 grant 授权）；
    // 'workspace' = 团队公共（有效团队成员可读，仅 workspace-v1 生效）。
    // 取值域由 CHECK 兑底；迁移经 migrate-test 的 MT008 任务。
    visibility: text("visibility"),
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
    check(
      "enterprise_resource_visibility",
      sql`${table.visibility} is null or ${table.visibility} in ('private', 'workspace')`,
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

// MT112（执行轮 Ticket）：历史部署「原有公司」锚点映射表，expand-only。
// 一行 = 原有公司租户 ↔ 既有部署身份（deployment_packages.tenant_id，启动时
// 由 synchronizeTenantPackage upsert 的持久化身份）↔ 计费 Customer 键
// （deploymentExternalCustomerId 的派生规则：'openbot-deployment-' ||
// deployment_tenant_id，见 src/billing/service.ts；派生 CHECK 让映射自证
// 一致）。tenant 主键 + 两个方向唯一索引 = 映射在两个方向上都唯一；
// 锚点行只能由 MT112 迁移写入（对受限角色只授予租户范围 SELECT，
// 无 INSERT/UPDATE 授权），后续回填 Ticket（MT113/MT074）以本表为锚。
export const enterpriseDeploymentAnchors = pgTable(
  "enterprise_deployment_anchors",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => enterpriseTenants.id, { onDelete: "cascade" }),
    deploymentTenantId: text("deployment_tenant_id").notNull(),
    billingExternalCustomerId: text("billing_external_customer_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("enterprise_deployment_anchor_identity").on(
      table.deploymentTenantId,
    ),
    uniqueIndex("enterprise_deployment_anchor_billing_customer").on(
      table.billingExternalCustomerId,
    ),
    check(
      "enterprise_deployment_anchor_billing_derivation",
      sql`${table.billingExternalCustomerId} = 'openbot-deployment-' || ${table.deploymentTenantId}`,
    ),
    pgPolicy("enterprise_deployment_anchor_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_deployment_anchors.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();
