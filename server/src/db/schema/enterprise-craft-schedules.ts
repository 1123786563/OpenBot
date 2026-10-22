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
import { users } from "./core";
import {
  enterpriseMemberships,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// MT054（Issue #97）：Craft 计划任务、子任务与应用连接的归属协会表。
// expand-only——一张新表，不修改任何既有表/策略/授权（MT060 openmuse_
// task_scopes 同型判例 + MT042 扫描臂）。
//
// enterprise_craft_schedule_scopes：一行 = 一个 Craft 计划域对象
// （kind ∈ {'scheduled_task','subtask','connection'}）在一个
// (公司, 团队, 主体) 三元组上的归属关联。
//
//   - (kind, object_id) 复合主键：一个对象在一个 kind 下至多一条归属。
//     不做 FK 到 craft_scheduled_tasks——subtask 与 connection 是企业面
//     计划域对象（既有 craft 表没有它们的行），scheduled_task 的行存在
//     性由写入路径钉死（pin 只接创建者本人创建的任务行）。
//   - 复合外键钉到 enterprise_workspaces(tenant_id, id) 与
//     enterprise_memberships(tenant_id, principal_id)，均 cascade。
//   - parent_object_id：仅 subtask 有值（父计划任务）；CHECK 钉死
//     「subtask ⇔ parent 非空」。跨范围父引用在服务层拒绝（FK 无法表达
//     「父必须同三元组」——范围一致性是服务层事实，测试钉死）。
//   - credential_ref：仅 connection 有值（连接绑定的凭据引用名，创建时
//     固定；解析与 lease 取用发生在触发时，MT029）；CHECK 钉死
//     「connection ⇔ credential_ref 非空」。
//
// RLS 沿 MT059/MT060 既有模式 + MT042 扫描臂：REVOKE PUBLIC + 四能力角色
// → ENABLE + FORCE → data 角色租户臂 SELECT + restrictive 主体自读 →
// operator 角色租户 + 主体上下文读/插/删 → operator 在
// app.scan_sweep='on' 上下文下的跨租户 SELECT 臂（平台触发重建专用；
// 普通业务事务永不设置该键，租户臂语义不变）。零 UPDATE 授权——归属不可
// 改写是结构不是纪律。目录角色无任何策略与授权。

/** Craft 计划域对象的封闭词表。 */
export const CRAFT_SCHEDULE_OBJECT_KINDS = [
  "scheduled_task",
  "subtask",
  "connection",
] as const;

export type CraftScheduleObjectKind =
  (typeof CRAFT_SCHEDULE_OBJECT_KINDS)[number];

/** 一个 Craft 计划域对象在一个公司团队主体三元组上的归属关联；一行 = 一条。 */
export const enterpriseCraftScheduleScopes = pgTable(
  "enterprise_craft_schedule_scopes",
  {
    kind: text("kind").$type<CraftScheduleObjectKind>().notNull(),
    objectId: text("object_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    userId: text("user_id").notNull(),
    /** 仅 subtask：父计划任务的 object_id（同 kind='scheduled_task'）。 */
    parentObjectId: text("parent_object_id"),
    /** 仅 connection：绑定的凭据引用名（创建时固定，触发时经 lease 解析）。 */
    credentialRef: text("credential_ref"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.objectId] }),
    // 范围列表的稳定全序：(created_at DESC, object_id) keyset 分页的索引面。
    index("enterprise_craft_schedule_scopes_scope_list_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.createdAt,
      table.objectId,
    ),
    // 子任务 → 父任务的引用面（范围一致性在服务层，本索引只服务查找）。
    index("enterprise_craft_schedule_scopes_parent_idx").on(
      table.tenantId,
      table.workspaceId,
      table.parentObjectId,
    ),
    foreignKey({
      name: "enterprise_craft_schedule_scopes_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_craft_schedule_scopes_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "enterprise_craft_schedule_scopes_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    check(
      "enterprise_craft_schedule_scopes_kind",
      sql`${table.kind} in ('scheduled_task','subtask','connection')`,
    ),
    check(
      "enterprise_craft_schedule_scopes_subtask_parent",
      sql`(${table.kind} = 'subtask') = (${table.parentObjectId} is not null)`,
    ),
    check(
      "enterprise_craft_schedule_scopes_connection_credential",
      sql`(${table.kind} = 'connection') = (${table.credentialRef} is not null)`,
    ),
    check(
      "enterprise_craft_schedule_scopes_parent_plain",
      sql`${table.parentObjectId} is null or ${table.parentObjectId} <> ''`,
    ),
    check(
      "enterprise_craft_schedule_scopes_credential_plain",
      sql`${table.credentialRef} is null or ${table.credentialRef} <> ''`,
    ),
    pgPolicy("enterprise_craft_schedule_scope_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_craft_schedule_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_craft_schedule_scope_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`enterprise_craft_schedule_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_craft_schedule_scope_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_craft_schedule_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_craft_schedule_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_craft_schedule_scope_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_craft_schedule_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_craft_schedule_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_craft_schedule_scope_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`enterprise_craft_schedule_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_craft_schedule_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_craft_schedule_scope_operator_sweep_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`current_setting('app.scan_sweep', true) = 'on'`,
    }),
  ],
).enableRLS();

export type EnterpriseCraftScheduleScopeRow =
  typeof enterpriseCraftScheduleScopes.$inferSelect;
export type NewEnterpriseCraftScheduleScopeRow =
  typeof enterpriseCraftScheduleScopes.$inferInsert;
