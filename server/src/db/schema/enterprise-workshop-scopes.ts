import { sql } from "drizzle-orm";
import {
  check,
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
import { sandboxInstances } from "./sandbox-instances";
import { workshopSessions } from "./workshop";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// MT057（Issue #100）：Workshop 会话、执行、产物与沙箱实例关联的作用域。
// expand-only——两张新表，不修改任何既有表/策略/授权（MT053 enterprise_
// craft_scopes 同型判例）。
//
//   1. enterprise_workshop_scopes：一行 = 一个 Workshop 会话
//      （workshop_sessions，只有 owner_user_id 的个人形状）在一个
//      (公司, 团队, 主体) 三元组上的归属关联。Spec §4.2「根对象的子记录
//      包含 tenant_id 并通过复合关联保持公司一致」的逐字形状；turn、
//      turn 事件、产物与调度行全部经 session_id cascade 挂在会话下——
//      归属随根行成立，执行记录的读经同一道范围门。
//   2. enterprise_workshop_sandbox_bindings：一行 = 一个沙箱实例
//      （sandbox_instances）到一个同范围会话的绑定（AC2：沙箱实例只与
//      同范围会话关联）。绑定事实 create-once；回收只走列级 UPDATE
//      （status → 'recycled' + recycled_at，0178 credential-lease 列级
//      GRANT 同纪律）——「回收后不复用给其他范围而不清理」由 pin 的
//      create-once + 服务层清理门钉死：一个实例的绑定行换三元组必须
//      先清掉旧绑定（DELETE 属原范围），不清就跨范围重绑在结构上
//      走不通（主键不变、三元组不可改写——零 UPDATE 于归属列）。
//
// RLS 沿 MT053 既有模式：REVOKE PUBLIC + 四能力角色 → ENABLE + FORCE →
// data 角色租户臂 SELECT + restrictive 主体自读 → operator 角色租户 +
// 主体上下文读/插/删 + workspace 读臂。绑定表另有 operator 列级 UPDATE
// （status, recycled_at 两列——生命周期可变，归属不可变）。零 UPDATE
// 授权于归属列。目录角色无任何策略与授权。

/** 一个 Workshop 会话在一个公司团队主体三元组上的归属关联；一行 = 一条。 */
export const enterpriseWorkshopScopes = pgTable(
  "enterprise_workshop_scopes",
  {
    sessionId: text("session_id").primaryKey(),
    channelId: text("channel_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("enterprise_workshop_scopes_scope_list_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.createdAt,
      table.sessionId,
    ),
    // 频道面关联读（workshop 路由按频道寻址）。
    index("enterprise_workshop_scopes_channel_idx").on(table.channelId),
    foreignKey({
      name: "enterprise_workshop_scopes_session_fk",
      columns: [table.sessionId],
      foreignColumns: [workshopSessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_workshop_scopes_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_workshop_scopes_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_workshop_scopes_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    pgPolicy("enterprise_workshop_scope_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_workshop_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_workshop_scope_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_workshop_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_workshop_scope_operator_workspace_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_workshop_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_workshop_scopes.workspace_id = nullif(current_setting('app.workspace_id', true), '')`,
    }),
    pgPolicy("enterprise_workshop_scope_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_workshop_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_workshop_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_workshop_scope_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_workshop_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_workshop_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_workshop_scope_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`enterprise_workshop_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_workshop_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
  ],
).enableRLS();

export type EnterpriseWorkshopScopeRow =
  typeof enterpriseWorkshopScopes.$inferSelect;
export type NewEnterpriseWorkshopScopeRow =
  typeof enterpriseWorkshopScopes.$inferInsert;

/** 绑定生命周期闭集：bound 活绑定 / recycled 已回收（清理后可由原范围重绑）。 */
export type WorkshopSandboxBindingStatus = "bound" | "recycled";

/**
 * 一个沙箱实例到一个同范围会话的绑定；一行 = 一条（instance_id 主键，
 * create-once）。status 'recycled' ⇔ recycled_at 非空——回收是可审计的
 * 状态翻转，不是删除；重绑（换三元组）必须先删旧行（清理由原范围完成，
 * DELETE 授权只有租户+主体上下文臂）。
 */
export const enterpriseWorkshopSandboxBindings = pgTable(
  "enterprise_workshop_sandbox_bindings",
  {
    instanceId: text("instance_id").primaryKey(),
    sessionId: text("session_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    userId: text("user_id").notNull(),
    status: text("status")
      .$type<WorkshopSandboxBindingStatus>()
      .notNull()
      .default("bound"),
    boundAt: timestamp("bound_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    recycledAt: timestamp("recycled_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      "enterprise_workshop_sandbox_bindings_status_check",
      sql`${table.status} IN ('bound', 'recycled')`,
    ),
    check(
      "enterprise_workshop_sandbox_bindings_recycled_check",
      sql`(${table.status} = 'recycled') = (${table.recycledAt} IS NOT NULL)`,
    ),
    index("enterprise_workshop_sandbox_bindings_scope_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
    ),
    index("enterprise_workshop_sandbox_bindings_session_idx").on(
      table.sessionId,
    ),
    foreignKey({
      name: "enterprise_workshop_sandbox_bindings_instance_fk",
      columns: [table.instanceId],
      foreignColumns: [sandboxInstances.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_workshop_sandbox_bindings_session_fk",
      columns: [table.sessionId],
      foreignColumns: [workshopSessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_workshop_sandbox_bindings_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_workshop_sandbox_bindings_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_workshop_sandbox_bindings_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    pgPolicy("enterprise_workshop_sandbox_binding_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_workshop_sandbox_bindings.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_workshop_sandbox_binding_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_workshop_sandbox_bindings.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_workshop_sandbox_binding_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_workshop_sandbox_bindings.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_workshop_sandbox_bindings.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_workshop_sandbox_binding_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_workshop_sandbox_bindings.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_workshop_sandbox_bindings.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_workshop_sandbox_binding_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`enterprise_workshop_sandbox_bindings.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_workshop_sandbox_bindings.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    // 生命周期 UPDATE 臂（0178 列级 GRANT 的 RLS 半边）：归属列不可改写
    // 由列级授权钉死（只有 status/recycled_at/updated_at 可 UPDATE）。
    pgPolicy("enterprise_workshop_sandbox_binding_operator_update", {
      for: "update",
      to: "ob_ent_operator",
      using: sql`enterprise_workshop_sandbox_bindings.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_workshop_sandbox_bindings.principal_id = nullif(current_setting('app.principal_id', true), '')`,
      withCheck: sql`enterprise_workshop_sandbox_bindings.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_workshop_sandbox_bindings.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
  ],
).enableRLS();

export type EnterpriseWorkshopSandboxBindingRow =
  typeof enterpriseWorkshopSandboxBindings.$inferSelect;
export type NewEnterpriseWorkshopSandboxBindingRow =
  typeof enterpriseWorkshopSandboxBindings.$inferInsert;
