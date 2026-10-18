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
import { openmuseTasks } from "./openmuse";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// MT060（Issue #103）：OpenMuse 任务/计划/监控根记录的归属协会表。
// expand-only——一张新表，不修改任何既有表/策略/授权。
//
// openmuse_task_scopes：一行 = 一个 OpenMuse 任务根记录（openmuse_tasks，
// 只有 owner_user_id 的旧根形状）在一个 (公司, 团队, 主体) 三元组上的归属
// 关联。Spec §4.2「根对象的子记录包含 tenant_id 并通过复合关联保持公司一
// 致」的逐字形状：
//
//   - task_id 主键：一个任务至多一条归属；FK → openmuse_tasks(id) cascade，
//     根记录删除则归属随之消失（不残留孤儿归属）。
//   - 复合外键钉到 enterprise_workspaces(tenant_id, id) 与
//     enterprise_memberships(tenant_id, principal_id)，均 cascade——归属无
//     法在公司/团队或成员关系之外存在。
//   - user_id 记录 OpenBot 全局用户（FK → users cascade）：旧根行的
//     owner_user_id 与归属 user_id 的一致性由写入路径钉死；回填行直接继承
//     owner_user_id。
//   - bot_id 记录执行 Bot：新路径 = MT059 私有 Bot 的 pbot- 身份（服务层
//     验证绑定）；回填行 = 旧 agents 命名空间的原值。两命名空间不做跨 FK
//     （旧值不指向 enterprise_personal_bots）。
//   - attribution ∈ {'created','backfill'}：新路径 pin 与 MT117 回填的来源
//     区分（审计与 MT117 执行面的事实，不是推断）。
//
// RLS 沿 MT059 既有模式 + MT042 扫描臂：REVOKE PUBLIC + 四能力角色 →
// ENABLE + FORCE → data 角色租户臂 SELECT + restrictive 主体自读（逐主体
// 事实）→ operator 角色租户 + 主体上下文读/写/删 → operator 在
// app.scan_sweep='on' 上下文下的跨租户 SELECT 臂（平台触发重建专用；普通
// 业务事务永不设置该键，租户臂语义不变）。目录角色无任何策略与授权。

/** 一个 OpenMuse 任务在一个公司团队主体三元组上的归属关联；一行 = 一条。 */
export const openmuseTaskScopes = pgTable(
  "openmuse_task_scopes",
  {
    taskId: text("task_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    userId: text("user_id").notNull(),
    botId: text("bot_id").notNull(),
    attribution: text("attribution").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // 范围列表的稳定全序：(created_at DESC, task_id) keyset 分页的索引面。
    index("openmuse_task_scopes_scope_list_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.createdAt,
      table.taskId,
    ),
    foreignKey({
      name: "openmuse_task_scopes_task_fk",
      columns: [table.taskId],
      foreignColumns: [openmuseTasks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_task_scopes_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_task_scopes_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_task_scopes_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    check(
      "openmuse_task_scopes_attribution",
      sql`${table.attribution} in ('created','backfill')`,
    ),
    pgPolicy("openmuse_task_scope_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`openmuse_task_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("openmuse_task_scope_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`openmuse_task_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_task_scope_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`openmuse_task_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_task_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_task_scope_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`openmuse_task_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_task_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_task_scope_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`openmuse_task_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_task_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_task_scope_operator_sweep_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`current_setting('app.scan_sweep', true) = 'on'`,
    }),
  ],
).enableRLS();

export type OpenMuseTaskScopeRow = typeof openmuseTaskScopes.$inferSelect;
export type NewOpenMuseTaskScopeRow = typeof openmuseTaskScopes.$inferInsert;
