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

// MT062（Issue #105）：OpenMuse 个人域（目标/想法/记忆）与财务产物的归属
// 协会表。expand-only——一张新表，不修改任何既有表/策略/授权。
//
// openmuse_personal_scopes：一行 = 一个个人域根记录（openmuse_goals /
// openmuse_ideas / openmuse_memories，或作为财务产物 pin 的 openmuse_files
// 行 id）在一个 (公司, 团队, 主体) 三元组上的归属关联（Spec §4.2 同 MT060
// 的逐字形状）：
//   - (object_type, object_id) 复合主键：一个对象至多一条归属。三类根表
//     各自的主键都是 text id，跨表外键无法表达——根行存在性与 owner 一致
//     性由服务面写入路径钉死（pin 前先经 rows 缝核 owner 根行存在），删除
//     的级联清理由 scopedDelete 的删除路径承担（先删协会行再 tombstone，
//     或依赖 MT117 后续回填清理——诚实披露，见服务面边界）。
//   - object_type ∈ {'goal','idea','memory','finance_artifact'} CHECK。
//     finance_artifact 的 object_id 是 openmuse_files 行 id（财务产物的
//     载体是文件——csv 与导出附件），读取面 readFinanceArtifact 在归属
//     匹配之外还按 MT073 账务可见性规则放行公司财务读者（AC2）。
//   - 复合外键钉到 enterprise_workspaces 与 enterprise_memberships（证明
//     workspace 属该公司、principal 是该公司成员）与 users，均 cascade。
//
// RLS 沿 MT059/MT060 既有模式 + MT042 扫描臂：REVOKE PUBLIC + 四能力角色 →
// ENABLE + FORCE → data 角色租户臂 SELECT + restrictive 主体自读（AC1：
// 同团队他人连行都不可见）→ operator 角色租户 + 主体上下文读/插/删 →
// operator 在 app.scan_sweep='on' 上下文下的跨租户 SELECT 臂。目录角色无
// 任何策略与授权。零 UPDATE 授权——归属不可改写是结构不是纪律。

/** 个人域对象的封闭种类（CHECK 的同名集合是唯一事实源）。 */
export const OPENMUSE_PERSONAL_OBJECT_TYPES = [
  "goal",
  "idea",
  "memory",
  "finance_artifact",
] as const;

export type OpenMusePersonalObjectType =
  (typeof OPENMUSE_PERSONAL_OBJECT_TYPES)[number];

/** 一个个人域对象在一个公司团队主体三元组上的归属关联；一行 = 一条。 */
export const openmusePersonalScopes = pgTable(
  "openmuse_personal_scopes",
  {
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    userId: text("user_id").notNull(),
    attribution: text("attribution").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: "openmuse_personal_scopes_pk",
      columns: [table.objectType, table.objectId],
    }),
    index("openmuse_personal_scopes_scope_list_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.objectType,
      table.createdAt,
      table.objectId,
    ),
    foreignKey({
      name: "openmuse_personal_scopes_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_personal_scopes_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_personal_scopes_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    check(
      "openmuse_personal_scopes_object_type",
      sql`${table.objectType} in ('goal','idea','memory','finance_artifact')`,
    ),
    check(
      "openmuse_personal_scopes_attribution",
      sql`${table.attribution} in ('created','import')`,
    ),
    pgPolicy("openmuse_personal_scope_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`openmuse_personal_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("openmuse_personal_scope_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`openmuse_personal_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_personal_scope_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`openmuse_personal_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_personal_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_personal_scope_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`openmuse_personal_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_personal_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_personal_scope_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`openmuse_personal_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_personal_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_personal_scope_operator_sweep_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`current_setting('app.scan_sweep', true) = 'on'`,
    }),
  ],
).enableRLS();

export type OpenMusePersonalScopeRow =
  typeof openmusePersonalScopes.$inferSelect;
export type NewOpenMusePersonalScopeRow =
  typeof openmusePersonalScopes.$inferInsert;
