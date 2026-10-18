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

// MT059（Issue #102）：用户私有 OpenMuse Bot 的存储面。expand-only——两张
// 新表，不修改任何既有表/策略/授权。
//
//   1. enterprise_personal_bots：一行 = 一位用户在一个公司一个团队内的私有
//      Bot。复合主键 (tenant_id, workspace_id, principal_id) 就是幂等键本
//      身——票面「幂等键 = (公司, 团队, 用户) 三元组」不是服务层约定，而是
//      数据库结构：同一个三元组在物理上至多存在一行，重复请求在 INSERT 冲突
//      处被结构挡住（服务层幂等读回同一行，绝不产生重复记录）。agent_id 由
//      服务端生成（专属 pbot- 命名空间 + 全局唯一索引）：私有 Bot 身份不接
//      受客户端指定，两行私有 Bot 永不共享身份。document 是该 Bot 的扁平字
//      段文档；template_ref + template_source_revision 记录模板来源（可空，
//      两者同空同非空——无模板的私有 Bot 合法，模板元信息不允许半截）。
//      复合外键钉到 enterprise_workspaces 与 enterprise_memberships，均
//      cascade——私有 Bot 无法在公司/团队或成员关系之外存在（Spec §4.2「根
//      对象的子记录包含 tenant_id 并通过复合关联保持公司一致」）。
//   2. enterprise_personal_bot_field_ownership：字段级所有权表——一行 = 一
//      个字段名在一个私有 Bot 上的所有权事实（managed_by ∈
//      {'template','user'}）。「哪些字段归模板管、哪些归用户」是这张表里的
//      显式清单，不是命名约定或服务层推断（brief 交付约束逐字实现）。模板
//      升级只写 managed_by='template' 的行；'user' 行的文档值逐位保留由服
//      务层保证、本表结构性可见。复合外键钉到私有 Bot 行与公司成员关系，均
//      cascade：Bot 消失字段所有权消失，成员资格消失同样消失。
//
// RLS 沿 enterprise-bot-ownership.ts 既有模式：REVOKE PUBLIC + 四能力角色
// → ENABLE + FORCE → data 角色租户范围 SELECT + restrictive 主体自读（私
// 有 Bot 是逐主体事实，与 enterprise_bot_preferences 的 self-read 同款）→
// operator 角色租户 + 主体上下文范围读/写。目录角色无任何策略与授权（私有
// Bot 内容不是目录数据）。

/** 一个用户在一个公司团队内的私有 OpenMuse Bot；一行 = 一个三元组事实。 */
export const enterprisePersonalBots = pgTable(
  "enterprise_personal_bots",
  {
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    agentId: text("agent_id").notNull(),
    displayName: text("display_name").notNull(),
    templateRef: text("template_ref"),
    templateSourceRevision: integer("template_source_revision"),
    document: jsonb("document").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // 幂等键 = (公司, 团队, 用户) 三元组：主键即票面 AC1 的结构实现。
    primaryKey({
      columns: [table.tenantId, table.workspaceId, table.principalId],
    }),
    // 私有 Bot 身份全局唯一：服务端 pbot- 命名空间 + 唯一索引，两行私有
    // Bot 永不共享身份。
    uniqueIndex("enterprise_personal_bots_agent_id_global_uq").on(
      table.agentId,
    ),
    foreignKey({
      name: "enterprise_personal_bots_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_personal_bots_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    check("enterprise_personal_bots_revision", sql`${table.revision} > 0`),
    check(
      "enterprise_personal_bots_template_pairing",
      sql`(${table.templateRef} IS NULL) = (${table.templateSourceRevision} IS NULL)`,
    ),
    check(
      "enterprise_personal_bots_template_source_revision",
      sql`${table.templateSourceRevision} IS NULL OR ${table.templateSourceRevision} > 0`,
    ),
    pgPolicy("enterprise_personal_bot_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_personal_bots.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_personal_bot_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_personal_bots.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_personal_bot_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_personal_bots.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_personal_bots.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_personal_bot_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_personal_bots.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_personal_bots.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_personal_bot_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`enterprise_personal_bots.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_personal_bots.principal_id = nullif(current_setting('app.principal_id', true), '')`,
      withCheck: sql`enterprise_personal_bots.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_personal_bots.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_personal_bot_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`enterprise_personal_bots.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_personal_bots.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
  ],
).enableRLS();

/**
 * 字段级所有权：一行 = 一个字段名在一个私有 Bot 上的所有权事实。模板管理
 * 字段集合与用户字段集合都是这张表的显式行，不是约定。
 */
export const enterprisePersonalBotFieldOwnership = pgTable(
  "enterprise_personal_bot_field_ownership",
  {
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    fieldName: text("field_name").notNull(),
    managedBy: text("managed_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.workspaceId,
        table.principalId,
        table.fieldName,
      ],
    }),
    foreignKey({
      name: "enterprise_personal_bot_field_ownership_personal_bot_fk",
      columns: [table.tenantId, table.workspaceId, table.principalId],
      foreignColumns: [
        enterprisePersonalBots.tenantId,
        enterprisePersonalBots.workspaceId,
        enterprisePersonalBots.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_personal_bot_field_ownership_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    check(
      "enterprise_personal_bot_field_ownership_managed_by",
      sql`${table.managedBy} in ('template','user')`,
    ),
    pgPolicy("enterprise_personal_bot_field_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_personal_bot_field_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_personal_bot_field_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_personal_bot_field_ownership.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_personal_bot_field_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_personal_bot_field_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_personal_bot_field_ownership.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_personal_bot_field_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_personal_bot_field_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_personal_bot_field_ownership.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_personal_bot_field_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`enterprise_personal_bot_field_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_personal_bot_field_ownership.principal_id = nullif(current_setting('app.principal_id', true), '')`,
      withCheck: sql`enterprise_personal_bot_field_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_personal_bot_field_ownership.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_personal_bot_field_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`enterprise_personal_bot_field_ownership.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_personal_bot_field_ownership.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
  ],
).enableRLS();
