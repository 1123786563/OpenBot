import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { enterpriseMemberships, enterpriseTenants } from "./enterprise-tenancy";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * MT078（Issue #121）——租户审计事件的分域存储。
 *
 * 业务审计、身份审计与平台审计分域保存与查询：一行 = 一条已落域
 * （business | identity | platform）的审计事件，域在写入时固定、查询时
 * 只在授权域内返回。表跟随 enterprise_security_events 的受限通道模型
 * （ob_ent_operator + RLS），但读策略只有租户 pin——审计查询要读多行，
 * 不是「只读刚写的那行」的 operation pin 面：
 *
 *   - SELECT（ob_ent_operator）：tenant pin——跨租户读取被 RLS 结构性排除，
 *     服务层再按域授权收口（公司侧只读 business；平台侧只读 identity/
 *     platform）。
 *   - INSERT（ob_ent_operator）：tenant pin ∧ id = operation pin（与
 *     enterprise_security_events 同款写入纪律：一行一操作）。
 *   - ob_ent_directory / ob_ent_data 零授权（结构隔离，套件以
 *     has_table_privilege 反证钉死）。FORCE RLS。
 */
export const enterpriseAuditEvents = pgTable(
  "enterprise_audit_events",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => enterpriseTenants.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    /** 分域：business | identity | platform（写入时固定，CHECK 封闭）。 */
    domain: text("domain").notNull(),
    eventType: text("event_type").notNull(),
    actorId: text("actor_id").notNull(),
    targetId: text("target_id"),
    /** 已脱敏载荷（redactAuditPayload 同款规则）；明文秘密不落域。 */
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    check(
      "enterprise_audit_event_domain",
      sql`${table.domain} in ('business','identity','platform')`,
    ),
    index("enterprise_audit_event_tenant_domain_time").on(
      table.tenantId,
      table.domain,
      table.createdAt,
    ),
    pgPolicy("enterprise_audit_event_operator_read", {
      for: "select",
      to: "ob_ent_operator",
      using: sql`enterprise_audit_events.tenant_id = nullif(current_setting('app.tenant_id', true), '')`,
    }),
    pgPolicy("enterprise_audit_event_operator_insert", {
      for: "insert",
      to: "ob_ent_operator",
      withCheck: sql`enterprise_audit_events.tenant_id = nullif(current_setting('app.tenant_id', true), '') and enterprise_audit_events.id = nullif(current_setting('app.operation_id', true), '')`,
    }),
  ],
).enableRLS();

/**
 * MT078（Issue #121）——公司计费管理授权（发放、调整、退款）。
 *
 * 计费管理动作需要明确授权并留审计（票面 AC3）：一主体在一家公司至多一行
 * 「计费管理」授权事实。跟随 MT073 公司财务读取授权的同款纪律：
 *
 *   - PK (tenant_id, principal_id)；撤销=删行；重复授权显式拒绝。
 *   - grantee 与 granted_by 两侧复合外键→enterprise_memberships（非成员行
 *     结构上不可能）。
 *   - 跟随 MT069/MT070/MT073 D2 裁决的 billing 域访问模型（owner 通道、
 *     无 RLS、受限 ob_ent_* 零授权=结构隔离）。
 *   - tenant_admin 不自动获得（角色与授权是两个事实）。
 */
export const billingCompanyManageGrants = pgTable(
  "billing_company_manage_grants",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => enterpriseTenants.id, { onDelete: "cascade" }),
    principalId: text("principal_id").notNull(),
    /** 授权管理动作的发出主体（trail；FK 证明同为该公司成员）。 */
    grantedBy: text("granted_by").notNull(),
    /** 授权覆盖的管理动作位（发放|调整|退款；查询用位集整数）。 */
    actions: integer("actions").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.principalId] }),
    check(
      "billing_company_manage_actions",
      sql`${table.actions} between 1 and 7`,
    ),
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
  ],
);

export const BILLING_MANAGE_ACTIONS = ["grant", "adjust", "refund"] as const;
export type BillingManageAction = (typeof BILLING_MANAGE_ACTIONS)[number];

/** 动作→授权位（发放=1、调整=2、退款=4）。 */
export function billingManageActionBit(action: BillingManageAction): number {
  return action === "grant" ? 1 : action === "adjust" ? 2 : 4;
}

export const BILLING_MANAGE_ALL_ACTIONS = 7;
