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
import {
  enterpriseMemberships,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";
import { workshopArtifacts } from "./workshop";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// MT055（Issue #98）：产物归属协会表。expand-only——一张新表，不修改任何
// 既有表/策略/授权（MT053 enterprise_craft_scopes 同型判例）。
//
// enterprise_artifact_scopes：一行 = 一个 Workshop 产物行（workshop_
// artifacts，只有 session 归属的个人形状）在一个 (公司, 团队, 主体) 三元组
// 上的归属关联。Spec §4.2「根对象的子记录包含 tenant_id 并通过复合关联
// 保持公司一致」的逐字形状；产物行经 session_id cascade 挂在会话下，本表
// 把「哪次企业接线创建了它」钉死成行——路径前缀只用于寻址，授权一律
// 走本表的三元组比对（票面 AC1：路径包含归属标识但不可作为授权依据）。
//
//   - artifact_id 主键：一个产物至多一条归属；FK → workshop_artifacts(id)
//     cascade，产物行删除则归属随之消失（不残留孤儿归属）。
//   - 复合外键钉到 enterprise_workspaces(tenant_id, id) 与
//     enterprise_memberships(tenant_id, principal_id)，均 cascade——归属无
//     法在公司/团队或成员关系之外存在。
//   - user_id 记录 OpenBot 全局用户（FK → users cascade）：与产物行所属
//     会话 owner_user_id 的一致性由写入路径钉死（pin 只接本人会话下的
//     产物行）。
//
// RLS 沿 MT053 既有模式：REVOKE PUBLIC + 四能力角色 → ENABLE + FORCE →
// data 角色租户臂 SELECT + restrictive 主体自读（逐主体事实）→ operator
// 角色租户 + 主体上下文读/插/删 + workspace 读臂（团队面存在性事实，无
// 主体 pin）。零 UPDATE 授权——归属不可改写是结构不是纪律。目录角色无
// 任何策略与授权。

/** 一个 Workshop 产物在一个公司团队主体三元组上的归属关联；一行 = 一条。 */
export const enterpriseArtifactScopes = pgTable(
  "enterprise_artifact_scopes",
  {
    artifactId: text("artifact_id").primaryKey(),
    sessionId: text("session_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // 范围列表的稳定全序：(created_at DESC, artifact_id) keyset 分页的索引面。
    index("enterprise_artifact_scopes_scope_list_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.createdAt,
      table.artifactId,
    ),
    // 会话面关联读（该会话下已 pin 的产物集合）。
    index("enterprise_artifact_scopes_session_idx").on(table.sessionId),
    foreignKey({
      name: "enterprise_artifact_scopes_artifact_fk",
      columns: [table.artifactId],
      foreignColumns: [workshopArtifacts.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_artifact_scopes_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_artifact_scopes_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_artifact_scopes_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    pgPolicy("enterprise_artifact_scope_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_artifact_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_artifact_scope_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_artifact_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    // 团队面存在性事实（operator 的 workspace 读臂：归属行存在且同团队，
    // 不含属主主体标识——与 MT053 同形）。
    pgPolicy("enterprise_artifact_scope_operator_workspace_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_artifact_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_artifact_scopes.workspace_id = nullif(current_setting('app.workspace_id', true), '')`,
    }),
    pgPolicy("enterprise_artifact_scope_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_artifact_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_artifact_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_artifact_scope_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_artifact_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_artifact_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_artifact_scope_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`enterprise_artifact_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_artifact_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
  ],
).enableRLS();

export type EnterpriseArtifactScopeRow =
  typeof enterpriseArtifactScopes.$inferSelect;
export type NewEnterpriseArtifactScopeRow =
  typeof enterpriseArtifactScopes.$inferInsert;
