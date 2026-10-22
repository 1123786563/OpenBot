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
import { openmuseReviewedActions } from "./openmuse";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// MT064（Issue #107）：OpenMuse 审阅动作提案与回执的归属域。expand-only
// ——一张新协会表与按既有模式的最小 RLS；不修改任何既有表/策略/授权。
//
// openmuse_reviewed_action_scopes：一行 = 一条审阅动作提案根记录
// （openmuse_reviewed_actions，只有 owner_user_id 的用户级形状）在一个
// (公司, 团队, 主体) 三元组上的归属关联（Spec §4.2 同 MT060/MT061 逐字
// 形状）：
//   - action_id 主键：一条提案至多一条归属；FK →
//     openmuse_reviewed_actions(id) cascade——回执（attempt 行）经该 FK
//     级联继承同一归属，票面「提案与回执按归属授权」的单事实源。
//   - 复合外键钉到 enterprise_workspaces(tenant_id, id) 与
//     enterprise_memberships(tenant_id, principal_id)，均 cascade；user_id
//     FK → users cascade：与根行 owner_user_id 的一致性由写入路径钉死
//     （pinReviewedActionScope 在 owner 行存在的前提下写入）。
//   - 无 attribution 列：审阅动作没有外部导入路径，每条 pin 都是本范围
//     创建（MT061 的 attribution 区分的是本地上传与邮件附件导入两种
//     来源事实；本域只有一种来源，列不存在才是不撒谎的形状）。
//
// RLS 沿 MT059/MT060/MT061 既有模式 + MT042 扫描臂：REVOKE PUBLIC + 四能
// 力角色 → ENABLE + FORCE → data 角色租户臂 SELECT + restrictive 主体自读
// （逐主体事实——同团队他人连行都不可见）→ operator 角色租户 + 主体上下
// 文读/插/删 → operator 在 app.scan_sweep='on' 上下文下的跨租户 SELECT
// 臂。目录角色无任何策略与授权。零 UPDATE 授权——归属不可改写是结构不是
// 纪律。

/** 一条 OpenMuse 审阅动作提案在一个公司团队主体三元组上的归属关联；一行 = 一条。 */
export const openmuseReviewedActionScopes = pgTable(
  "openmuse_reviewed_action_scopes",
  {
    actionId: text("action_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("openmuse_reviewed_action_scopes_scope_list_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.createdAt,
      table.actionId,
    ),
    foreignKey({
      name: "openmuse_reviewed_action_scopes_action_fk",
      columns: [table.actionId],
      foreignColumns: [openmuseReviewedActions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_reviewed_action_scopes_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_reviewed_action_scopes_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_reviewed_action_scopes_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    pgPolicy("openmuse_reviewed_action_scope_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`openmuse_reviewed_action_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("openmuse_reviewed_action_scope_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`openmuse_reviewed_action_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_reviewed_action_scope_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`openmuse_reviewed_action_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_reviewed_action_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_reviewed_action_scope_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`openmuse_reviewed_action_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_reviewed_action_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_reviewed_action_scope_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`openmuse_reviewed_action_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_reviewed_action_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_reviewed_action_scope_operator_sweep_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`current_setting('app.scan_sweep', true) = 'on'`,
    }),
  ],
).enableRLS();

export type OpenMuseReviewedActionScopeRow =
  typeof openmuseReviewedActionScopes.$inferSelect;
export type NewOpenMuseReviewedActionScopeRow =
  typeof openmuseReviewedActionScopes.$inferInsert;
