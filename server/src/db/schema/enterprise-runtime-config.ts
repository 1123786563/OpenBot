import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { enterpriseTenants, enterpriseWorkspaces } from "./enterprise-tenancy";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// MT014（Issue #57）：公司运行配置装配的存储面。expand-only——两张新表，
// 不修改任何既有表/策略/授权。文档列只存「引用」（模型、凭据引用、套餐
// 映射、Bot 默认），凭据值永远只存在凭据库，绝不进配置文档。
//
// RLS 沿 enterprise-tenancy.ts 既有模式：data 角色租户范围 SELECT（解析
// 读取路径经受限角色 + 事务本地 app.tenant_id），operator 角色租户范围
// 读 + INSERT/UPDATE（公司配置写入路径属后续管理 Ticket，测试经此写入）。

/** 一家公司（Tenant）的运行配置文档与版本号；一行 = 一家公司。 */
export const enterpriseRuntimeConfigs = pgTable(
  "enterprise_runtime_configs",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => enterpriseTenants.id, { onDelete: "cascade" }),
    document: jsonb("document").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("enterprise_runtime_config_revision", sql`${table.revision} > 0`),
    pgPolicy("enterprise_runtime_config_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_runtime_configs.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_runtime_config_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_runtime_configs.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_runtime_config_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_runtime_configs.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_runtime_config_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`enterprise_runtime_configs.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`enterprise_runtime_configs.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

/** 一个团队（Workspace）对其公司运行配置的收窄覆盖；一行 = 一个团队。 */
export const enterpriseRuntimeConfigOverrides = pgTable(
  "enterprise_runtime_config_overrides",
  {
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    document: jsonb("document").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.workspaceId] }),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    check(
      "enterprise_runtime_config_override_revision",
      sql`${table.revision} > 0`,
    ),
    pgPolicy("enterprise_runtime_config_override_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_runtime_config_overrides.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_runtime_config_override_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_runtime_config_overrides.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_runtime_config_override_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_runtime_config_overrides.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_runtime_config_override_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`enterprise_runtime_config_overrides.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_runtime_config_overrides.workspace_id = nullif(current_setting('app.workspace_id', true), '')`,
      withCheck: sql`enterprise_runtime_config_overrides.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_runtime_config_overrides.workspace_id = nullif(current_setting('app.workspace_id', true), '')`,
    }),
  ],
).enableRLS();
