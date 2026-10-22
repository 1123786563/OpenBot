import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { craftSessions } from "./craft";
import {
  enterpriseMemberships,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// MT053（Issue #96）：Craft 会话归属协会表。expand-only——一张新表，不修
// 改任何既有表/策略/授权（MT060 openmuse_task_scopes 同型判例）。
//
// enterprise_craft_scopes：一行 = 一个 craft 会话（craft_sessions，只有
// user_id 的个人形状）在一个 (公司, 团队, 主体) 三元组上的归属关联。
// Spec §4.2「根对象的子记录包含 tenant_id 并通过复合关联保持公司一致」的
// 逐字形状；turn 与消息按会话继承归属（craft_messages/craft_snapshots 经
// session_id cascade FK 挂在会话下，归属随根行成立）。
//
//   - session_id 主键：一个会话至多一条归属；FK → craft_sessions(id)
//     cascade，会话删除则归属随之消失（不残留孤儿归属）。
//   - 复合外键钉到 enterprise_workspaces(tenant_id, id) 与
//     enterprise_memberships(tenant_id, principal_id)，均 cascade——归属无
//     法在公司/团队或成员关系之外存在。
//   - user_id 记录 OpenBot 全局用户（FK → users cascade）：与
//     craft_sessions.user_id 的一致性由写入路径钉死（pin 只接创建者本人
//     的会话行）。
//
// RLS 沿 MT059/MT060 既有模式：REVOKE PUBLIC + 四能力角色 → ENABLE +
// FORCE → data 角色租户臂 SELECT + restrictive 主体自读（逐主体事实）→
// operator 角色租户 + 主体上下文读/插/删。零 UPDATE 授权——归属不可改写
// 是结构不是纪律。目录角色无任何策略与授权。

/** 一个 craft 会话在一个公司团队主体三元组上的归属关联；一行 = 一条。 */
export const enterpriseCraftScopes = pgTable(
  "enterprise_craft_scopes",
  {
    sessionId: text("session_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // 范围列表的稳定全序：(created_at DESC, session_id) keyset 分页的索引面。
    index("enterprise_craft_scopes_scope_list_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.createdAt,
      table.sessionId,
    ),
    foreignKey({
      name: "enterprise_craft_scopes_session_fk",
      columns: [table.sessionId],
      foreignColumns: [craftSessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_craft_scopes_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_craft_scopes_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_craft_scopes_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    pgPolicy("enterprise_craft_scope_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_craft_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_craft_scope_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_craft_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    // MT053 团队公共面（AC3）：同团队活跃成员需要确认「该会话是本工作区的
    // 企业内容」——归属行对 operator 的 workspace 读臂（无主体 pin：存在性
    // 事实，不含内容；data 角色仍严格个人可见）。
    pgPolicy("enterprise_craft_scope_operator_workspace_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_craft_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_craft_scopes.workspace_id = nullif(current_setting('app.workspace_id', true), '')`,
    }),
    pgPolicy("enterprise_craft_scope_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_craft_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_craft_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_craft_scope_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_craft_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_craft_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_craft_scope_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`enterprise_craft_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_craft_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
  ],
).enableRLS();

export type EnterpriseCraftScopeRow = typeof enterpriseCraftScopes.$inferSelect;
export type NewEnterpriseCraftScopeRow =
  typeof enterpriseCraftScopes.$inferInsert;
