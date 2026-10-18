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

const timestampColumn = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();

// MT077（Issue #120）：网络策略、能力开关、模型路由与模板的分层归属存储面。
// expand-only——三张新表，不修改任何既有表/策略/授权。策略文档列只存
// 「引用与开关」（egress 规则、能力布尔、路由引用），凭据值永远不进文档；
// 平台模板目录不落库（平台静态能力，进程内深冻结封闭清单，见
// tenancy/routing-policy.ts），这里只存各范围的「安装」副本。
//
// RLS 沿 enterprise-runtime-config.ts（MT014）既有模式：data 角色租户范围
// SELECT（解析读取路径经受限角色 + 事务本地 app.tenant_id），operator 角色
// 租户范围读 + INSERT/UPDATE（override 与 install 的 UPDATE 另要求
// app.workspace_id 上下文——团队行被行级收窄到该团队）。

/** 一家公司（Tenant）的治理策略文档与版本号；一行 = 一家公司。 */
export const enterpriseGovernancePolicies = pgTable(
  "enterprise_governance_policies",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => enterpriseTenants.id, { onDelete: "cascade" }),
    document: jsonb("document").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  (table) => [
    check("enterprise_governance_policy_revision", sql`${table.revision} > 0`),
    pgPolicy("enterprise_governance_policy_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_governance_policies.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_governance_policy_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_governance_policies.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_governance_policy_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_governance_policies.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_governance_policy_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`enterprise_governance_policies.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`enterprise_governance_policies.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

/** 一个团队（Workspace）对公司治理策略的收窄覆盖；一行 = 一个团队。 */
export const enterpriseGovernanceOverrides = pgTable(
  "enterprise_governance_overrides",
  {
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    document: jsonb("document").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.workspaceId] }),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    check(
      "enterprise_governance_override_revision",
      sql`${table.revision} > 0`,
    ),
    pgPolicy("enterprise_governance_override_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_governance_overrides.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_governance_override_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_governance_overrides.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_governance_override_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_governance_overrides.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_governance_override_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`enterprise_governance_overrides.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_governance_overrides.workspace_id = nullif(current_setting('app.workspace_id', true), '')`,
      withCheck: sql`enterprise_governance_overrides.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_governance_overrides.workspace_id = nullif(current_setting('app.workspace_id', true), '')`,
    }),
  ],
).enableRLS();

/**
 * 平台模板在某个团队范围的安装副本；一行 = 一个 (公司, 团队, 模板)。
 * document 是该范围的客户内容副本，更新只落本行——平台目录没有对应
 * 表（不可回写是结构性质，不只是约定）。
 */
export const enterpriseTemplateInstalls = pgTable(
  "enterprise_template_installs",
  {
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    templateRef: text("template_ref").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    document: jsonb("document").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.workspaceId, table.templateRef],
    }),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    check(
      "enterprise_template_install_source_revision",
      sql`${table.sourceRevision} > 0`,
    ),
    check("enterprise_template_install_revision", sql`${table.revision} > 0`),
    pgPolicy("enterprise_template_install_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_template_installs.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_template_install_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_template_installs.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_template_install_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_template_installs.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_template_install_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`enterprise_template_installs.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_template_installs.workspace_id = nullif(current_setting('app.workspace_id', true), '')`,
      withCheck: sql`enterprise_template_installs.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_template_installs.workspace_id = nullif(current_setting('app.workspace_id', true), '')`,
    }),
  ],
).enableRLS();
