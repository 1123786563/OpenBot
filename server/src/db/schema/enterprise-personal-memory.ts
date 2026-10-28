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
import {
  enterpriseMemberships,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// MT039（Issue #82）：个人业务记忆与来源选择保持个人权限。expand-only。
//
// 票面：个人业务记忆、记忆来源选择与相关缓存按个人权限控制；团队成员
// 资格不会让他人读到某人的记忆，公共 Bot 运行时也只会使用当前使用者被
// 授权的记忆来源。
//
// 一张表（与 migrate-test 的 MT039 任务一一对应）：
//
//   enterprise_personal_memories —— 一行 = 一条个人业务记忆。归属键
//   (tenant, workspace, principal) 复合外键全内嵌 tenant_id（跨公司记忆
//   行结构性不可能）；memory_key 是调用侧检索键（去空白、长度上限），
//   content 是记忆内容文本；source_kind manual/kb/document 闭集 + 行形
//   CHECK（kb/document 来源必须带 source_ref）。
//
//   个人记忆比共享审批更严：data 角色的 SELECT 策略也是 tenant +
//   principal 双 pin——同团队他人连行都读不到（RLS 层就挡，不是应用层
//   过滤），列表与搜索天然不泄露存在性。data 全部四动作（读/插/改/删）
//   都限本人行；operator 租户 pin 只读（管理面证据通道）；directory 零
//   授权；零跨主体 UPDATE 通道。
export const enterprisePersonalMemories = pgTable(
  "enterprise_personal_memories",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    memoryKey: text("memory_key").notNull(),
    content: text("content").notNull(),
    sourceKind: text("source_kind").notNull().default("manual"),
    sourceRef: text("source_ref"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    check(
      "enterprise_personal_memory_source_kind",
      sql`${table.sourceKind} in ('manual', 'kb', 'document')`,
    ),
    check(
      "enterprise_personal_memory_source_shape",
      sql`(${table.sourceKind} in ('kb', 'document')) = (${table.sourceRef} is not null)`,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }),
    index("enterprise_personal_memory_subject_idx").on(
      table.tenantId,
      table.workspaceId,
      table.principalId,
      table.memoryKey,
    ),
    pgPolicy("enterprise_personal_memory_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')
        and ${table.principalId} = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_personal_memory_data_insert", {
      for: "insert",
      to: "ob_ent_data",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')
        and ${table.principalId} = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_personal_memory_data_update", {
      for: "update",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')
        and ${table.principalId} = nullif(current_setting('app.principal_id', true), '')`,
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')
        and ${table.principalId} = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_personal_memory_data_delete", {
      for: "delete",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')
        and ${table.principalId} = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_personal_memory_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
  ],
).enableRLS();
