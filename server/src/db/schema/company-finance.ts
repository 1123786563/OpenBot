import {
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { enterpriseMemberships, enterpriseTenants } from "./enterprise-tenancy";

/**
 * MT073（Issue #116）——公司财务读取授权：一家公司内一个主体被明确授予
 * 「查看公司账务与团队用量」的管理授权事实（设计 spec §7：余额共用不把账单
 * 变成全员可读；公司财务读取是明确管理动作授权，C3：旧按 created_by 限制的
 * 订单读取不被直接放宽）。
 *
 * 跟随 MT069/MT070 D2 裁决的 billing 域访问模型（owner 通道、无 RLS，与
 * billing_customers/billing_call_attributions 一致）：授权是账务读取面的事实
 * 而非成员关系事实；受限 ob_ent_* 角色对本表零授权（结构隔离，套件以
 * has_table_privilege 反证钉死）。唯一写入面是服务层
 * （../../billing/company-finance-visibility.ts）。
 *
 * 授权语义：
 *   - PK (tenant_id, principal_id)：一主体在公司内至多一行授权；撤销=删行
 *     （无可达中间态，过期/撤销后立即失效由判定现场核对保证——MT010 分享表
 *     同款纪律）；重复授权是显式拒绝（服务层 FINANCE_GRANT_EXISTS），不是
 *     静默幂等。
 *   - granted_by 记录管理动作的发出主体：授权来自人，trail 随行。
 *   - 两条复合外键把伪造授权行变成结构上不可能（MT010 同款纪律）：
 *     (tenant_id, principal_id) → enterprise_memberships 证明被授权人是该
 *     公司成员；(tenant_id, granted_by) → enterprise_memberships 证明发出
 *     主体也是该公司成员——跨公司授权行在 DB 层不存在。
 *   - 公司成员资格被暂停/删除时授权行随成员资格级联消亡；判定侧仍活查
 *     membership status（撤销语义双保险，A5 邻接：停用立即失效）。
 *   - tenant_admin 角色不自动获得财务读取（「明确管理动作授权」）：无授权
 *     行的 tenant_admin 与普通成员在判定面同形拒绝（不泄露角色差异）。
 */
export const billingCompanyFinanceGrants = pgTable(
  "billing_company_finance_grants",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => enterpriseTenants.id, { onDelete: "cascade" }),
    principalId: text("principal_id").notNull(),
    /** 授权管理动作的发出主体（trail；FK 证明同为该公司成员）。 */
    grantedBy: text("granted_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.principalId] }),
    // 被授权人必须是该公司的成员（跨公司授权行结构上不可能）。
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    // 授权发出主体也必须是该公司的成员（MT010 granted_by 同款纪律）。
    foreignKey({
      columns: [table.tenantId, table.grantedBy],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    index("billing_company_finance_grants_tenant_idx").on(table.tenantId),
  ],
);
