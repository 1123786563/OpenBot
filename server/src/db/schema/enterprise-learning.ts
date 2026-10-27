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
import {
  enterpriseMemberships,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// MT040（Issue #83）：学习容器、研究与演示记录隔离。expand-only。
//
// 票面：学习容器、连接应用研究与演示记录按归属隔离；外部学习服务不会
// 把不同公司的客户内容放进同一个容器或同一个命名空间。
//
// 两张表（与 migrate-test 的 MT040 任务一一对应）：
//
//   1. enterprise_learning_containers —— 一行 = 一次容器分配。归属键
//      (tenant, workspace) 复合外键内嵌 tenant_id；namespace 是服务端从
//      归属派生的十六进制摘要（绝不掺用户输入，也不含任何凭据片段）；
//      status allocated/released 闭集 + released ⇔ released_at 行形
//      CHECK。回收（release）后不复用：每次分配都是新行（新 id + 新
//      namespace），旧容器的状态不迁移到新范围——"回收后给另一范围而不
//      清理状态"结构性不可能。
//
//   2. enterprise_learning_records —— 一行 = 一条研究或演示记录，归属
//      (tenant, workspace, principal) + 容器外键（内嵌 tenant_id）。kind
//      research/demonstration 闭集。data 角色读走租户 pin（应用谓词再收
//      到本团队 + 有效成员），插自己；operator 租户 pin 读 + 改（释放/
//      管理通道）；零 DELETE；directory 零授权。
export const enterpriseLearningContainers = pgTable(
  "enterprise_learning_containers",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    namespace: text("namespace").notNull(),
    allocatedByPrincipalId: text("allocated_by_principal_id").notNull(),
    status: text("status").notNull().default("allocated"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    check(
      "enterprise_learning_container_status",
      sql`${table.status} in ('allocated', 'released')`,
    ),
    check(
      "enterprise_learning_container_release_shape",
      sql`(${table.status} = 'released') = (${table.releasedAt} is not null)`,
    ),
    check(
      "enterprise_learning_container_namespace_shape",
      sql`${table.namespace} ~ '^mt040-ns-[0-9a-f]{32}$'`,
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
      columns: [table.tenantId, table.allocatedByPrincipalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }),
    index("enterprise_learning_container_scope_idx").on(
      table.tenantId,
      table.workspaceId,
      table.status,
    ),
    pgPolicy("enterprise_learning_container_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_learning_container_data_insert", {
      for: "insert",
      to: "ob_ent_data",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')
        and ${table.allocatedByPrincipalId} = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_learning_container_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_learning_container_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

export const enterpriseLearningRecords = pgTable(
  "enterprise_learning_records",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    containerId: text("container_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    payload: text("payload").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    check(
      "enterprise_learning_record_kind",
      sql`${table.kind} in ('research', 'demonstration')`,
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
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }),
    foreignKey({
      columns: [table.tenantId, table.containerId],
      foreignColumns: [
        enterpriseLearningContainers.tenantId,
        enterpriseLearningContainers.id,
      ],
    }),
    index("enterprise_learning_record_scope_idx").on(
      table.tenantId,
      table.workspaceId,
      table.kind,
    ),
    pgPolicy("enterprise_learning_record_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_learning_record_data_insert", {
      for: "insert",
      to: "ob_ent_data",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')
        and ${table.principalId} = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_learning_record_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_learning_record_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();
