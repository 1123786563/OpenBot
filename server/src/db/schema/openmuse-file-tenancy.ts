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
import { openmuseFiles } from "./openmuse";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// MT061（Issue #104）：OpenMuse 文件/文档/个人工作区域的归属协会表。
// expand-only——两张新表，不修改任何既有表/策略/授权。
//
// openmuse_file_scopes：一行 = 一个 OpenMuse 文件根记录（openmuse_files，
// 只有 owner_user_id 的用户级形状）在一个 (公司, 团队, 主体) 三元组上的
// 归属关联（Spec §4.2 同 MT060 的逐字形状）：
//   - file_id 主键：一个文件至多一条归属；FK → openmuse_files(id) cascade。
//   - 复合外键钉到 enterprise_workspaces(tenant_id, id) 与
//     enterprise_memberships(tenant_id, principal_id)，均 cascade。
//   - user_id FK → users cascade：与根行 owner_user_id 的一致性由写入路径
//     钉死（pinFileScope 在 owner 行存在的前提下写入）。
//   - attribution ∈ {'created','import'}：本地上传 pin 与外部引用（邮件
//     附件导入）pin 的来源区分（AC4 的事实，不是推断）。
//
// openmuse_document_actions：一行 = 一次 PDF 填写/传输动作的**发起归属**
// （AC2「保存发起归属，执行时校验」的持久面）：
//   - (file_id, action_kind) 复合主键：同一文件同类动作的重放收敛到一行
//     （create-once，同三元组幂等 existing——与 MT060 pin 同纪律）。
//   - action_kind ∈ {'fill','transfer'} CHECK。
//   - 复合外键钉到 openmuse_files / enterprise_workspaces /
//     enterprise_memberships / users，均 cascade。
//   - 执行侧（authorizeDocumentAction）以本行事实经扫描臂 + 真实签发入口
//     重建受信 Scope；撤权后的重建拒绝 = 动作失败而不是继续（AC2）。
//
// RLS 沿 MT059/MT060 既有模式 + MT042 扫描臂：REVOKE PUBLIC + 四能力角色 →
// ENABLE + FORCE → data 角色租户臂 SELECT + restrictive 主体自读（逐主体
// 事实——同团队他人连行都不可见）→ operator 角色租户 + 主体上下文读/插/删
// → operator 在 app.scan_sweep='on' 上下文下的跨租户 SELECT 臂（平台触发
// 重建专用）。目录角色无任何策略与授权。零 UPDATE 授权——归属不可改写是
// 结构不是纪律。

/** 一个 OpenMuse 文件在一个公司团队主体三元组上的归属关联；一行 = 一条。 */
export const openmuseFileScopes = pgTable(
  "openmuse_file_scopes",
  {
    fileId: text("file_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    userId: text("user_id").notNull(),
    attribution: text("attribution").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("openmuse_file_scopes_scope_list_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.createdAt,
      table.fileId,
    ),
    foreignKey({
      name: "openmuse_file_scopes_file_fk",
      columns: [table.fileId],
      foreignColumns: [openmuseFiles.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_file_scopes_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_file_scopes_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_file_scopes_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    check(
      "openmuse_file_scopes_attribution",
      sql`${table.attribution} in ('created','import')`,
    ),
    pgPolicy("openmuse_file_scope_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`openmuse_file_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("openmuse_file_scope_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`openmuse_file_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_file_scope_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`openmuse_file_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_file_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_file_scope_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`openmuse_file_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_file_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_file_scope_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`openmuse_file_scopes.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_file_scopes.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_file_scope_operator_sweep_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`current_setting('app.scan_sweep', true) = 'on'`,
    }),
  ],
).enableRLS();

/** 一次 PDF 填写/传输动作的发起归属；一行 = 一条（同键重放收敛）。 */
export const openmuseDocumentActions = pgTable(
  "openmuse_document_actions",
  {
    fileId: text("file_id").notNull(),
    actionKind: text("action_kind").notNull(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: "openmuse_document_actions_pk",
      columns: [table.fileId, table.actionKind],
    }),
    index("openmuse_document_actions_scope_list_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.createdAt,
      table.fileId,
    ),
    foreignKey({
      name: "openmuse_document_actions_file_fk",
      columns: [table.fileId],
      foreignColumns: [openmuseFiles.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_document_actions_workspace_fk",
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_document_actions_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "openmuse_document_actions_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    check(
      "openmuse_document_actions_kind",
      sql`${table.actionKind} in ('fill','transfer')`,
    ),
    pgPolicy("openmuse_document_action_data_tenant_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`openmuse_document_actions.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("openmuse_document_action_data_self_read", {
      as: "restrictive",
      for: "select",
      to: "ob_ent_data",
      using: sql`openmuse_document_actions.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_document_action_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`openmuse_document_actions.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_document_actions.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_document_action_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`openmuse_document_actions.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_document_actions.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_document_action_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`openmuse_document_actions.tenant_id = nullif(current_setting('app.tenant_id', true), '') and openmuse_document_actions.principal_id = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("openmuse_document_action_operator_sweep_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`current_setting('app.scan_sweep', true) = 'on'`,
    }),
  ],
).enableRLS();

export type OpenMuseFileScopeRow = typeof openmuseFileScopes.$inferSelect;
export type NewOpenMuseFileScopeRow = typeof openmuseFileScopes.$inferInsert;
export type OpenMuseDocumentActionRow =
  typeof openmuseDocumentActions.$inferSelect;
export type NewOpenMuseDocumentActionRow =
  typeof openmuseDocumentActions.$inferInsert;
