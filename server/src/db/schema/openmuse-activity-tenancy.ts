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
import { deliveryBindings } from "./delivery";
import {
  enterpriseMemberships,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";
import { openmuseNotifications } from "./openmuse";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// MT065（Issue #108）：OpenMuse 活动流与通知的归属域。expand-only——两张
// 新协会表与按既有模式的最小 RLS；不修改任何既有表/策略/授权。
//
// openmuse_notification_scopes：一行 = 一条通知根记录（
// openmuse_notifications，只有 user_id 的用户级形状）在一个 (公司, 团队,
// 主体) 三元组上的归属关联（Spec §4.2 同 MT060/MT061 逐字形状）。
//   - notification_id 主键：一条通知至多一条归属；FK →
//     openmuse_notifications(id) cascade。
//   - 复合外键钉到 enterprise_workspaces 与 enterprise_memberships 与
//     users，均 cascade；与根行 user_id 的一致性由写入路径钉死。
//
// openmuse_delivery_binding_scopes：一行 = 一条通知渠道绑定根记录
// （delivery_bindings，(owner, channel, agent, thread) 四元组用户级形状，
// 无租户列）在一个三元组上的归属关联——票面 AC4「通知渠道与推送设备绑定
// 到具体用户与范围」的持久面（推送设备的对应面在 MT066）。
//   - binding_id 主键；FK → delivery_bindings(id) cascade。
//
// RLS 沿 MT059–MT062 既有模式 + MT042 扫描臂（两张表同款）：REVOKE
// PUBLIC + 四能力角色 → ENABLE + FORCE → data 租户臂 SELECT + restrictive
// 主体自读 → operator 租户 + 主体上下文读/插/删 → operator 扫描臂。目录
// 角色无任何策略与授权。零 UPDATE 授权——归属不可改写是结构不是纪律。

/** 一条 OpenMuse 通知在一个公司团队主体三元组上的归属关联；一行 = 一条。 */
export const openmuseNotificationScopes = pgTable(
  "openmuse_notification_scopes",
  {
    notificationId: text("notification_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("openmuse_notification_scopes_scope_list_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.createdAt,
      table.notificationId,
    ),
    foreignKey({
      name: "openmuse_notification_scopes_notification_fk",
      columns: [table.notificationId],
      foreignColumns: [openmuseNotifications.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_notification_scopes_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_notification_scopes_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_notification_scopes_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    pgPolicy("openmuse_notification_scope_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`openmuse_notification_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("openmuse_notification_scope_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`openmuse_notification_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_notification_scope_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`openmuse_notification_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_notification_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_notification_scope_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`openmuse_notification_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_notification_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_notification_scope_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`openmuse_notification_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_notification_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_notification_scope_operator_sweep_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`current_setting('app.scan_sweep', true) = 'on'`,
    }),
  ],
).enableRLS();

/** 一条通知渠道绑定在一个公司团队主体三元组上的归属关联；一行 = 一条。 */
export const openmuseDeliveryBindingScopes = pgTable(
  "openmuse_delivery_binding_scopes",
  {
    bindingId: text("binding_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("openmuse_delivery_binding_scopes_scope_list_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.createdAt,
      table.bindingId,
    ),
    foreignKey({
      name: "openmuse_delivery_binding_scopes_binding_fk",
      columns: [table.bindingId],
      foreignColumns: [deliveryBindings.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_delivery_binding_scopes_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_delivery_binding_scopes_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_delivery_binding_scopes_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    pgPolicy("openmuse_delivery_binding_scope_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`openmuse_delivery_binding_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("openmuse_delivery_binding_scope_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`openmuse_delivery_binding_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_delivery_binding_scope_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`openmuse_delivery_binding_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_delivery_binding_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_delivery_binding_scope_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`openmuse_delivery_binding_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_delivery_binding_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_delivery_binding_scope_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`openmuse_delivery_binding_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_delivery_binding_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_delivery_binding_scope_operator_sweep_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`current_setting('app.scan_sweep', true) = 'on'`,
    }),
  ],
).enableRLS();

export type OpenMuseNotificationScopeRow =
  typeof openmuseNotificationScopes.$inferSelect;
export type NewOpenMuseNotificationScopeRow =
  typeof openmuseNotificationScopes.$inferInsert;
export type OpenMuseDeliveryBindingScopeRow =
  typeof openmuseDeliveryBindingScopes.$inferSelect;
export type NewOpenMuseDeliveryBindingScopeRow =
  typeof openmuseDeliveryBindingScopes.$inferInsert;
