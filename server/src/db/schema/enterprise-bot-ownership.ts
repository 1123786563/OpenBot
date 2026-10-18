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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  enterpriseMemberships,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// MT016（Issue #59）：Bot 归属固定的存储面。expand-only——两张新表，不修改
// 任何既有表/策略/授权。
//
//   1. enterprise_bot_ownership：一行 = 一个 Bot 在一家公司一个团队内的归属
//      （tenant_id + workspace_id + owner_principal_id + 状态与版本号），
//      默认配置文档（default_config jsonb）就在归属行内——配置与 Bot 结构上
//      同一行，归属不可分离（brief 验收 4 的结构实现）。
//   2. enterprise_bot_preferences：一行 = 一个主体对一个 Bot 的偏好文档，
//      复合外键钉到归属行（(tenant_id, agent_id)）与公司成员关系
//      （(tenant_id, principal_id)）——Spec §4.2「根对象的子记录包含
//      tenant_id 并通过复合关联保持公司一致」的逐字实现：偏好行无法在
//      Bot 之外的公司存在。
//
// RLS 沿 enterprise-tenancy.ts / enterprise-runtime-config.ts 既有模式：
// REVOKE PUBLIC + 四个能力角色 → ENABLE + FORCE RLS → data 角色租户范围
// SELECT（偏好表另加 restrictive 主体自读，与 enterprise_resource_grants
// 的 self-read 同款）→ operator 角色租户范围读 + 写（偏好写另钉主体上下
// 文）。目录角色无任何策略与授权（Bot 内容不是逐主体目录数据）。
// 归属表的 UPDATE/DELETE 不钉 workspace 上下文：账号清理/删除清单是公司
// 作用域动作（验收 5），团队级编辑门在服务层判定（bots-ownership.ts）。

/** 一个 Bot 的公司/团队归属与默认配置；一行 = 一个归属事实。 */
export const enterpriseBotOwnership = pgTable(
  "enterprise_bot_ownership",
  {
    tenantId: text("tenant_id").notNull(),
    agentId: text("agent_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    ownerPrincipalId: text("owner_principal_id").notNull(),
    displayName: text("display_name").notNull(),
    defaultConfig: jsonb("default_config").notNull(),
    status: text("status").notNull().default("active"),
    revision: integer("revision").notNull().default(1),
    aclEpoch: integer("acl_epoch").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.agentId] }),
    // 全局唯一：旧工作台 agents 表是 Bot 业务对象的唯一权威存储且主键全局
    // （Spec §4.2），两家公司不得认领同一底层 Bot。约束在 INSERT 处收口，
    // 是唯一不需要 RLS 豁免的跨公司检查点（同公司重复与跨公司占用对外
    // 同一代码 BOT_ID_UNAVAILABLE，不泄露占用发生在哪家）。
    uniqueIndex("enterprise_bot_ownership_agent_id_global_uq").on(
      table.agentId,
    ),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.ownerPrincipalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    check(
      "enterprise_bot_ownership_status",
      sql`${table.status} in ('active','deleted')`,
    ),
    check(
      "enterprise_bot_ownership_versions",
      sql`${table.revision} > 0 and ${table.aclEpoch} > 0`,
    ),
    pgPolicy("enterprise_bot_ownership_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_bot_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_bot_ownership_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_bot_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_bot_ownership_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_bot_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_bot_ownership_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`enterprise_bot_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
      withCheck: sql`enterprise_bot_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_bot_ownership_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`enterprise_bot_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();

/** 一个主体对一个 Bot 的偏好；一行 = 一条逐主体偏好事实（复合 FK 同归属）。 */
export const enterpriseBotPreferences = pgTable(
  "enterprise_bot_preferences",
  {
    tenantId: text("tenant_id").notNull(),
    agentId: text("agent_id").notNull(),
    principalId: text("principal_id").notNull(),
    preferences: jsonb("preferences").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.agentId, table.principalId],
    }),
    foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [
        enterpriseBotOwnership.tenantId,
        enterpriseBotOwnership.agentId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    // 文档列不设 jsonb_typeof 存储检查：drizzle+bun-sql 的 jsonb 写入把
    // JSON.stringify 的产物（JSON 字符串）存为 jsonb 标量（与 MT014/MT026
    // 文档列同款仓库约定），存储层类型检查会拦下全部合法写入；文档必须为
    // JSON object 的校验在服务层写入前完成（assertDocument）。
    pgPolicy("enterprise_bot_preference_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_bot_preferences.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_bot_preference_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_bot_preferences.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_bot_preference_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_bot_preferences.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_bot_preferences.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_bot_preference_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_bot_preferences.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_bot_preferences.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_bot_preference_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`enterprise_bot_preferences.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_bot_preferences.principal_id = nullif(current_setting('app.principal_id', true), '')`,
      withCheck: sql`enterprise_bot_preferences.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_bot_preferences.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_bot_preference_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`enterprise_bot_preferences.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_bot_preferences.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
  ],
).enableRLS();
