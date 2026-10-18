import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * jsonb whose JS value is passed to the driver verbatim (no JSON.stringify).
 *
 * The app database client is Bun SQL. Bun JSON-encodes parameter values for
 * jsonb targets itself; drizzle's default jsonb mapping stringifies first, so
 * a string param arrives as a jsonb SCALAR (double-encoded) and object-shape
 * CHECKs (`not detail ?| array[...]`) would evaluate false for perfectly
 * valid rows (enterprise-credential-lease 同款定制类型，MT027 套件钉死).
 */
const jsonbDocument = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return "jsonb";
  },
});

/**
 * MT074（波次 16 补位）——供应商计费交互审计：一行 = 一次供应商计费交互尝试
 * （outbound call 或 inbound callback，applied 与 refused 都是事实）。设计见
 * checkpoints/MT074/design.md，要点：
 *
 * 跟随 MT069/MT070/MT073 D2 裁决的 billing 域访问模型（owner 通道、无 RLS，
 * 与 billing_customers/billing_call_attributions/billing_company_finance_grants
 * 一致）：唯一写入面是服务层（../../billing/vendor-billing.ts）；受限 ob_ent_*
 * 角色对本表零授权 = 结构隔离（套件以 has_table_privilege 全枚举反证钉死）。
 *
 * 审计面纪律（MT069 billing_account_audit / MT029 lease audit 同款）：
 *   - 无外键：审计不随对象消亡（MT069 先例）；且「成员行已删」的拒绝回调和
 *     非成员调用拒绝必须可记录——membership 外键会让拒绝本身抛 23503。
 *   - tenant_id 可空：null = 不可归属（未映射回调）——不臆造公司归属。
 *   - detail 闭形 CHECK：必须 JSON object 且禁止秘密载体键（envelope/
 *     plaintext/secret/value/password/token/apiKey）；detail 只含非值事实
 *     （字段名/供应商状态码），客户键与公司名等值绝不入 detail。
 *   - outcome/denial_code 行形配对 CHECK：applied ⇒ 无拒绝码、refused ⇒ 必有
 *     非空拒绝码——每个结局可归因。
 *
 * 语义边界：这是尝试留痕（attempt trail），不是收件箱——供应商事件去重/重放
 * 防线在既有 webhook inbox（billing/service.ts，零改动）。
 */
export const billingVendorInteractions = pgTable(
  "billing_vendor_interactions",
  {
    id: text("id").primaryKey(),
    /** 'call'（我方 → 供应商）| 'callback'（供应商 → 我方）。 */
    direction: text("direction").notNull(),
    /** null = 不可归属（未映射回调）；绝不臆造公司。 */
    tenantId: text("tenant_id"),
    /** acting 身份（服务端事实或被拒声称者）；不可归属回调为空。 */
    principalId: text("principal_id"),
    /** 供应商侧客户键（映射值或观察值）。 */
    externalCustomerId: text("external_customer_id"),
    /** 'customer.provision' / 回调类型标签（≤128 非空，服务层校验）。 */
    operation: text("operation").notNull(),
    /** 'applied' | 'refused'。 */
    outcome: text("outcome").notNull(),
    /** 行形配对：applied ⇒ null；refused ⇒ 非空非''。 */
    denialCode: text("denial_code"),
    /** 闭形非值事实（{fields, vendorStatus}）；CHECK 禁秘密载体键。 */
    detail: jsonbDocument("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "billing_vendor_interactions_direction",
      sql`${table.direction} in ('call', 'callback')`,
    ),
    check(
      "billing_vendor_interactions_outcome",
      sql`${table.outcome} in ('applied', 'refused')`,
    ),
    check(
      "billing_vendor_interactions_denial_pair",
      sql`(${table.outcome} = 'applied' AND ${table.denialCode} IS NULL) OR (${table.outcome} = 'refused' AND ${table.denialCode} IS NOT NULL AND ${table.denialCode} <> '')`,
    ),
    check(
      "billing_vendor_interactions_detail_shape",
      sql`${table.detail} IS NULL OR (jsonb_typeof(${table.detail}) = 'object' AND NOT ${table.detail} ?| array['envelope','plaintext','secret','value','password','token','apiKey'])`,
    ),
    index("billing_vendor_interactions_tenant_time_idx").on(
      table.tenantId,
      table.createdAt,
    ),
    index("billing_vendor_interactions_customer_time_idx").on(
      table.externalCustomerId,
      table.createdAt,
    ),
  ],
);
