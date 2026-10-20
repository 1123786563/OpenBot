import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { enterpriseBotOwnership } from "./enterprise-bot-ownership";
import {
  enterpriseMemberships,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// MT035（Issue #78）：Host Access、签入帮助与危险动作审批的归属。expand-only。
//
// 票面：host access 与签入帮助只对本范围授权主体开放，跨范围请求被拒绝；
// 危险动作（write_file / run_command）仍按既有规则要求审批，且审批归属与
// 执行归属一致；执行过程中撤权让后续敏感动作失败。
//
// 两张表（与 migrate-test 的 MT035 任务一一对应）：
//
//   1. enterprise_host_access_grants —— 一行 = 一位成员把自己主机的访问
//      授权给某 Bot。归属键 (tenant, workspace, principal, agent) 全内嵌：
//      复合外键到 tenancy 三表 + bot 归属行，跨公司授权行结构性不可能。
//      status active/revoked 闭集，revoked ⇔ revoked_at 行形 CHECK。
//      data 角色租户 pin 读 + 插自己行 + 只能撤本人 active 行；operator
//      租户 pin 读 + 改（管理撤销通道，workspace-admin 先例）；零 DELETE；
//      directory 零授权。
//
//   2. enterprise_host_action_approvals —— 一行 = 一次危险动作审批，锁定
//      (tenant, workspace, principal, agent, operation_kind, params_digest)。
//      摘要是服务端对提议参数的规范序列化 sha256（64 位十六进制 CHECK），
//      客户端声称的摘要一律 INVALID（只由服务端计算，MT034 同款纪律）。
//      status pending/approved/declined 闭集 + 决定配对行形 CHECK；审批行
//      不可变（零 UPDATE 授权给 operator 的改是决定动作，pending → 终态，
//      data 只能撤回本人 pending）。执行时重读 approved 行并把执行 scope
//      的四元组与摘要逐字比对——审批归属与执行归属一致由读取谓词保证。
export const enterpriseHostAccessGrants = pgTable(
  "enterprise_host_access_grants",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    agentId: text("agent_id").notNull(),
    principalId: text("principal_id").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("active"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    check(
      "enterprise_host_access_grant_status",
      sql`${table.status} in ('active', 'revoked')`,
    ),
    check(
      "enterprise_host_access_grant_revocation_shape",
      sql`(${table.status} = 'revoked') = (${table.revokedAt} is not null)`,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [
        enterpriseBotOwnership.tenantId,
        enterpriseBotOwnership.agentId,
      ],
    }),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }),
    index("enterprise_host_access_grant_subject_idx").on(
      table.tenantId,
      table.principalId,
      table.status,
    ),
    pgPolicy("enterprise_host_access_grant_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_host_access_grant_data_insert", {
      for: "insert",
      to: "ob_ent_data",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')
        and ${table.principalId} = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_host_access_grant_data_revoke", {
      for: "update",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')
        and ${table.principalId} = nullif(current_setting('app.principal_id', true), '')
        and ${table.status} = 'active'`,
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')
        and ${table.principalId} = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_host_access_grant_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_host_access_grant_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
);

export const enterpriseHostActionApprovals = pgTable(
  "enterprise_host_action_approvals",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    agentId: text("agent_id").notNull(),
    principalId: text("principal_id").notNull(),
    grantId: text("grant_id").notNull(),
    operationKind: text("operation_kind").notNull(),
    paramsDigest: text("params_digest").notNull(),
    status: text("status").notNull().default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    check(
      "enterprise_host_action_approval_kind",
      sql`${table.operationKind} in ('write_file', 'run_command')`,
    ),
    check(
      "enterprise_host_action_approval_status",
      sql`${table.status} in ('pending', 'approved', 'declined', 'withdrawn')`,
    ),
    check(
      "enterprise_host_action_approval_digest_shape",
      sql`${table.paramsDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "enterprise_host_action_approval_decision_shape",
      sql`(${table.status} in ('approved', 'declined')) = (${table.decidedBy} is not null and ${table.decidedAt} is not null)`,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [
        enterpriseBotOwnership.tenantId,
        enterpriseBotOwnership.agentId,
      ],
    }),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }),
    foreignKey({
      columns: [table.tenantId, table.grantId],
      foreignColumns: [
        enterpriseHostAccessGrants.tenantId,
        enterpriseHostAccessGrants.id,
      ],
    }),
    index("enterprise_host_action_approval_object_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.agentId,
      table.operationKind,
      table.paramsDigest,
    ),
    pgPolicy("enterprise_host_action_approval_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_host_action_approval_data_insert", {
      for: "insert",
      to: "ob_ent_data",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')
        and ${table.principalId} = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_host_action_approval_data_withdraw", {
      for: "update",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')
        and ${table.principalId} = nullif(current_setting('app.principal_id', true), '')
        and ${table.status} = 'pending'`,
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')
        and ${table.principalId} = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_host_action_approval_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_host_action_approval_operator_decide", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')
        and ${table.status} = 'pending'`,
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
);
