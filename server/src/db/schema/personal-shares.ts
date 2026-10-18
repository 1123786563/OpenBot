import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  enterpriseMemberships,
  enterpriseResources,
} from "./enterprise-tenancy";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// MT010（Issue #53）：个人资源的显式分享事实表，expand-only。
//
// 一行 = 资源属主（granted_by）向同公司一名受众（principal_id）授予的一次
// 显式分享，只允许 'read' 动作（CHECK 兜底：被分享方永远拿不到管理动作，
// 转授在结构上不可能）。有效期是行自身的事实（expires_at），判定入口按
// 数据库时钟 now() 现场核对；撤销 = 删除该行（无可达的中间状态，立即失效）。
//
// 复合外键内嵌 tenant_id（MT012 模板）：(tenant_id, resource_id) 证明资源
// 属于该公司；(tenant_id, principal_id) 与 (tenant_id, granted_by) 分别证明
// 受众与分享人是该公司的有效成员——跨公司分享行在结构上不可能存在。
// RLS 按同文件既有模式最小新增（data 只读本人行，operator 租户范围读写），
// 配套最小列授权由 migrate-test 的 MT010 任务真实执行。
export const enterpriseResourceShares = pgTable(
  "enterprise_resource_shares",
  {
    tenantId: text("tenant_id").notNull(),
    resourceId: text("resource_id").notNull(),
    /** 分享受众：被分享的个人（公司成员），不是被分享的角色或团队。 */
    principalId: text("principal_id").notNull(),
    action: text("action").notNull().default("read"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** 分享人：资源属主（服务层校验，复合外键证明其为同公司成员）。 */
    grantedBy: text("granted_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.resourceId,
        table.principalId,
        table.action,
      ],
    }),
    foreignKey({
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [enterpriseResources.tenantId, enterpriseResources.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.grantedBy],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    check("enterprise_share_action", sql`${table.action} = 'read'`),
    check(
      "enterprise_share_validity",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    pgPolicy("enterprise_share_data_read", {
      for: "select",
      to: "ob_ent_data",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '') and ${table.principalId} = nullif(current_setting('app.principal_id', true), '')`,
    }),
    pgPolicy("enterprise_share_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_share_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_share_operator_delete", {
      for: "delete",
      to: "ob_ent_operator",
      using: sql`${table.tenantId} = nullif(current_setting('app.tenant_id', true), '') and ${table.resourceId} = nullif(current_setting('app.resource_id', true), '') and ${table.grantedBy} = nullif(current_setting('app.operator_principal_id', true), '')`,
    }),
  ],
).enableRLS();
