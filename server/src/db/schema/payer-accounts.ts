import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { billingCustomers } from "./billing";
import { users } from "./core";
import { enterpriseTenants } from "./enterprise-tenancy";

/**
 * MT069（Issue #112）——公司计费 Customer 映射与公司/个人账户类型（expand-only）。
 *
 * 三张表都跟随 billing 域的既有访问模型（owner 通道、无 RLS）——与
 * billing_customers、credit_grants、credit_ledger、credit_reservations 完全一致：
 * 它们是计费事实（谁为这家公司付款、哪个账户在消费），不是成员关系或工作空间
 * 事实；受限 ob_ent_* 角色对 billing 域零授权（结构隔离，套件以
 * has_table_privilege 断言钉死）。唯一性与行形状约束在 DB 层（任务迁移 MT069
 * 与本文件一一对应），服务层（../../billing/payer-accounts.ts）是唯一写入面。
 *
 * 本票只扩展模型，不改既有扣费路径——四张既有计费表的列清单与 ×100 整数纪律
 * 由回归测试钉死；账户解析接入扣费路径属 MT070+。
 */

/**
 * 公司 ↔ 计费 Customer 的唯一映射（票面验收 1）。
 *
 * 一行 = 一家公司唯一明确的付款 Customer。两方向唯一都在 DB 层：tenant 主键
 * （一家公司至多一个 Customer）+ customer 唯一索引（一个 Customer 至多一家
 * 公司）。映射写入一次后不变——没有 updated_at，服务层也不暴露任何解除或改绑
 * 路径（稳定）。完全相同的重复绑定由服务幂等返回既有行，任何冲突组合被拒绝。
 */
export const billingCustomerMappings = pgTable(
  "billing_customer_mappings",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => enterpriseTenants.id, { onDelete: "cascade" }),
    externalCustomerId: text("external_customer_id")
      .notNull()
      .references(() => billingCustomers.externalId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_customer_mappings_customer_unique").on(
      table.externalCustomerId,
    ),
  ],
);

/**
 * 积分账户注册（票面验收 2/3）：显式的 company/personal 类型与稳定标识约束。
 *
 * 账户类型是显式字段——注册入口按类型分开（公司账户的 Customer 从映射派生，
 * 个人账户的 Customer 由调用方显式给出），不存在"从用户身份或字符串猜测"的
 * 路径。`status='quarantined'` 是未知归属记录的唯一去处：隔离行强制
 * account_type/account_key/tenant_id/owner_user_id 全空 + 必留隔离原因，绝不
 * 默认归为某一类；分类晋升属 MT070+。
 *
 * 两个稳定标识：external_customer_id 全局唯一（一个计费 Customer 至多一个
 * 账户行）+ account_key 派生自归属（`company:<tenant_id>` / `personal:<user_id>`，
 * 派生 CHECK 自证一致，MT112 anchors 同款纪律）并 partial UNIQUE。
 */
export const billingCreditAccounts = pgTable(
  "billing_credit_accounts",
  {
    id: text("id").primaryKey(),
    externalCustomerId: text("external_customer_id")
      .notNull()
      .references(() => billingCustomers.externalId, { onDelete: "cascade" }),
    /** 显式分类；NULL 仅在隔离态合法（row_shape CHECK 强制）。 */
    accountType: text("account_type"),
    /** 'active'（已分类）或 'quarantined'（未知归属被隔离）。 */
    status: text("status").notNull(),
    /** company 账户的公司归属（personal/隔离行为 NULL）。 */
    tenantId: text("tenant_id").references(() => enterpriseTenants.id, {
      onDelete: "cascade",
    }),
    /** personal 账户的部署级用户归属（company/隔离行为 NULL）。 */
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    /** 派生稳定键：'company:'||tenant_id / 'personal:'||owner_user_id；隔离行为 NULL。 */
    accountKey: text("account_key"),
    /** 隔离原因；隔离态必填（quarantine_reason CHECK 强制）。 */
    quarantineReason: text("quarantine_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "billing_credit_accounts_type",
      sql`${table.accountType} in ('company', 'personal')`,
    ),
    check(
      "billing_credit_accounts_status",
      sql`${table.status} in ('active', 'quarantined')`,
    ),
    // 行形状：三态互斥且列配对自洽——隔离行归属列全空，active+company 归属公司，
    // active+personal 归属用户；active 行必有派生键。
    check(
      "billing_credit_accounts_row_shape",
      sql`(${table.status} = 'quarantined' and ${table.accountType} is null and ${table.tenantId} is null and ${table.ownerUserId} is null and ${table.accountKey} is null) or (${table.status} = 'active' and ${table.accountType} = 'company' and ${table.tenantId} is not null and ${table.ownerUserId} is null and ${table.accountKey} is not null) or (${table.status} = 'active' and ${table.accountType} = 'personal' and ${table.ownerUserId} is not null and ${table.tenantId} is null and ${table.accountKey} is not null)`,
    ),
    // 隔离必留原因 = 审计纪律。
    check(
      "billing_credit_accounts_quarantine_reason",
      sql`(${table.status} = 'quarantined') = (${table.quarantineReason} is not null)`,
    ),
    // 派生键自证一致：分类行的键必须由归属列派生；隔离行的键为 NULL
    // （NULL = NULL 为 NULL，CHECK 只拒绝 FALSE，隔离行因此通过）。
    check(
      "billing_credit_accounts_key_derivation",
      sql`${table.accountKey} = case ${table.accountType} when 'company' then 'company:' || ${table.tenantId} when 'personal' then 'personal:' || ${table.ownerUserId} else null end`,
    ),
    uniqueIndex("billing_credit_accounts_customer_unique").on(
      table.externalCustomerId,
    ),
    uniqueIndex("billing_credit_accounts_key_unique")
      .on(table.accountKey)
      .where(sql`${table.accountKey} is not null`),
  ],
);

/**
 * 映射与账户操作审计（brief 验收 4）：bind / register / quarantine 每个成功
 * 写入操作一行。actor 由受信调用方传入（服务校验非空）；主体列按动作子集非空。
 * 只追加——本票不提供任何更新或删除路径。
 */
export const billingAccountAudit = pgTable(
  "billing_account_audit",
  {
    id: text("id").primaryKey(),
    action: text("action").notNull(),
    actor: text("actor").notNull(),
    tenantId: text("tenant_id").references(() => enterpriseTenants.id, {
      onDelete: "cascade",
    }),
    externalCustomerId: text("external_customer_id"),
    accountId: text("account_id"),
    detail: jsonb("detail"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "billing_account_audit_action",
      sql`${table.action} in ('customer_mapping.bound', 'credit_account.registered', 'credit_account.quarantined')`,
    ),
    index("billing_account_audit_tenant_time_idx").on(
      table.tenantId,
      table.occurredAt,
    ),
    index("billing_account_audit_customer_time_idx").on(
      table.externalCustomerId,
      table.occurredAt,
    ),
  ],
);
