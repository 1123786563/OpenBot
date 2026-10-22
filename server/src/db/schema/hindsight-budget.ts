import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  enterpriseMemberships,
  enterpriseTenants,
} from "./enterprise-tenancy";

// Hindsight 15（Issue #393）：个人记忆后台处理的预算上限与准入台账。
//
// hindsight_budget_caps：平台为一家公司设定的月度上限（公司总量 + 个人默认量）。没有行
// = 未设上限（平台未表达控制意图时不挡后台处理）；上限按月历周期核算，由台账聚合而
// 来，不在本表累计。
//
// hindsight_budget_reservations：一行 = 一次后台处理的准入占位。admit 以
// (tenant_id, work_key) 幂等——同一 work_key 重复 admit 返回同一预留，重试不重复扣费；
// 预算耗尽时 admit 被拒（公司上限或个人上限分别给出原因），新处理排队等待，而不是
// 绕开预算发送。状态机 reserved → settled（实际处理完成，计入用量）/ released（未
// 发生处理，释放占位，不计用量）。released 后同一 work_key 再次 admit 复用该行重新
// reserved——第一次尝试未计入用量，第二次计入一次，不会双扣。
//
// 用量口径：某公司当月用量 = 该租户当月 reserved+settled 的 units 之和；某个人当月
// 用量 = 加上 principal_id 过滤的同一聚合。released 不计。所有行都钉在 tenant_id 上，
// 跨公司计入在表形上就不可能。已确认内容的读取路径完全不经过本表——预算只挡后台
// 处理，不改动授权读取。
export const hindsightBudgetCaps = pgTable(
  "hindsight_budget_caps",
  {
    tenantId: text("tenant_id").notNull(),
    /** Whole-company monthly ceiling on background processing units. */
    companyMonthlyUnits: integer("company_monthly_units").notNull(),
    /** Per-person monthly ceiling applied to each principal of the company. */
    personalMonthlyUnits: integer("personal_monthly_units").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId] }),
    check(
      "hindsight_budget_caps_company_positive",
      sql`${table.companyMonthlyUnits} >= 0`,
    ),
    check(
      "hindsight_budget_caps_personal_positive",
      sql`${table.personalMonthlyUnits} >= 0`,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }),
  ],
);

export const hindsightBudgetReservations = pgTable(
  "hindsight_budget_reservations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    /**
     * The idempotency key the admission is keyed on: the sync work row's own id plus its
     * attempt count, so a budget-deferred retry (which does not bump attempts) re-admits the
     * SAME reservation, while a genuinely new processing attempt admits a fresh one.
     */
    workKey: text("work_key").notNull(),
    /** Calendar month the reservation counts against, 'YYYY-MM'. */
    period: text("period").notNull(),
    units: integer("units").notNull(),
    state: text("state")
      .$type<"reserved" | "settled" | "released">()
      .notNull()
      .default("reserved"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "hindsight_budget_reservation_state",
      sql`${table.state} in ('reserved', 'settled', 'released')`,
    ),
    check("hindsight_budget_reservation_units", sql`${table.units} >= 1`),
    // One admission per work key, ever: re-admitting after a release reuses the row.
    uniqueIndex("hindsight_budget_reservation_work_key").on(
      table.tenantId,
      table.workKey,
    ),
    index("hindsight_budget_reservation_usage_idx").on(
      table.tenantId,
      table.principalId,
      table.period,
      table.state,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [enterpriseTenants.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [
        enterpriseMemberships.tenantId,
        enterpriseMemberships.principalId,
      ],
    }),
  ],
);
