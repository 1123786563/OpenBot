import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { creditReservations } from "./credit-reservations";
import {
  enterpriseMemberships,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "./enterprise-tenancy";

/**
 * MT070（Issue #113）——公司调用归属：每次公司工作台预扣的归属行（预扣 1:1）。
 *
 * 跟随 MT069 D2 裁决的 billing 域访问模型（owner 通道、无 RLS，与
 * billing_customers/credit_grants/credit_ledger/credit_reservations 一致）：
 * 归属是预扣的账务事实（谁的公司账户被预扣、为谁的哪次调用），不是成员关系或
 * 工作空间事实；受限 ob_ent_* 角色对本表零授权（结构隔离，套件以
 * has_table_privilege 反证钉死）。唯一性与引用完整性在 DB 层（任务迁移 MT070
 * 与本文件一一对应），服务层（../../billing/company-reservation.ts）是唯一写入面。
 *
 * 三条复合外键把伪造归属行变成结构上不可能（MT010 分享表同款纪律）：
 *   - (tenant_id, workspace_id) → enterprise_workspaces：团队必须属于该公司；
 *   - (tenant_id, principal_id) → enterprise_memberships：使用人必须是该公司成员。
 * `(tenant_id, call_key)` 唯一索引：一个稳定调用标识在公司内至多一条预扣归属——
 * 幂等键唯一索引（credit_reservations）之外的第二道「重复请求不重复预扣」闸。
 * 本票只扩展模型，不改既有扣费路径——预扣上界/幂等语义仍在 credits-writer。
 */
export const billingCallAttributions = pgTable(
  "billing_call_attributions",
  {
    /** 预扣 1:1；预扣行消失（客户级联）时归属随失——不复制预扣事实。 */
    reservationId: text("reservation_id")
      .primaryKey()
      .references(() => creditReservations.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => enterpriseTenants.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    principalId: text("principal_id").notNull(),
    /** 本次调用的 Bot/授权标识（服务层非空校验 + DB 非空串 CHECK）。 */
    botRef: text("bot_ref").notNull(),
    /** 稳定调用标识：公司内唯一（(tenant_id, call_key) 唯一索引）。 */
    callKey: text("call_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // 复合外键同时证明 workspace 属该公司、principal 是该公司成员。
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [enterpriseWorkspaces.tenantId, enterpriseWorkspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }).onDelete("cascade"),
    // Bot/授权与稳定调用标识必非空串（DB 兜底，服务层先行校验）。
    check(
      "billing_call_attribution_refs_present",
      sql`${table.botRef} <> '' and ${table.callKey} <> ''`,
    ),
    uniqueIndex("billing_call_attributions_tenant_call_key_unique").on(
      table.tenantId,
      table.callKey,
    ),
    index("billing_call_attributions_tenant_idx").on(table.tenantId),
  ],
);
