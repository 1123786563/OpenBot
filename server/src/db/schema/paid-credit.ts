import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { testCreditAccounts } from "./test-credit";

/**
 * Paid credit ledger (#99–#103, #101): pilot products, orders that lock the
 * purchased product version and price, and the entitlements a verified order
 * grants — one Beijing-time billing period for the subscription plan, or a
 * long-lived Credit Pack amount.
 */

// The pilot sells exactly one monthly Subscription Plan and one long-lived
// Credit Pack; prices and amounts are configurable per version.
export const paidProducts = pgTable(
  "paid_products",
  {
    code: text().primaryKey(),
    kind: text({ enum: ["subscription", "credit_pack"] }).notNull(),
    // Orders lock the version they were created under.
    version: integer().notNull(),
    priceCents: integer().notNull(),
    creditsMicrocredits: bigint("credits_microcredits", {
      mode: "bigint",
    }).notNull(),
    active: boolean().notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "paid_products_amounts",
      sql`${table.version} > 0 AND ${table.priceCents} > 0 AND ${table.creditsMicrocredits} > 0`,
    ),
  ],
);

export const paidOrderStates = [
  "pending",
  "verified",
  "refund_pending",
  "refunded",
  "failed",
] as const;

export const paidOrders = pgTable(
  "paid_orders",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => testCreditAccounts.id),
    productCode: text("product_code").notNull(),
    // Locked at creation: a later price change never rewrites a placed order.
    productVersion: integer("product_version").notNull(),
    priceCents: integer("price_cents").notNull(),
    channel: text({ enum: ["wechat", "alipay"] }).notNull(),
    // The channel's own order reference, unique per channel once verified, so
    // replayed callbacks can never grant twice.
    channelOrderRef: text("channel_order_ref"),
    state: text({ enum: paidOrderStates }).notNull().default("pending"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("paid_orders_channel_ref").on(
      table.channel,
      table.channelOrderRef,
    ),
    check(
      "paid_orders_amounts",
      sql`${table.productVersion} > 0 AND ${table.priceCents} > 0`,
    ),
  ],
);

export const paidEntitlementKinds = ["subscription", "credit_pack"] as const;

// Entitlement states that persist: a not-yet-started future period, a frozen
// refund in flight, and a revoked grant. Active and expired derive from the
// period timestamps at read time.
export const paidEntitlementStates = [
  "future",
  "frozen",
  "revoked",
  "granted",
] as const;

export const paidEntitlements = pgTable(
  "paid_entitlements",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => testCreditAccounts.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => paidOrders.id),
    kind: text({ enum: paidEntitlementKinds }).notNull(),
    // Subscription: the Beijing billing period this order bought. Credit
    // packs are long-lived, so their window is unbounded.
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    anchorDay: integer("anchor_day"),
    creditsMicrocredits: bigint("credits_microcredits", {
      mode: "bigint",
    }).notNull(),
    // Charged amounts consume the entitlement; holds are tracked by the
    // allocation rows so released reservations never reduce this.
    consumedMicrocredits: bigint("consumed_microcredits", {
      mode: "bigint",
    })
      .notNull()
      .default(sql`0`),
    state: text({ enum: paidEntitlementStates }).notNull().default("granted"),
    arrivedAt: timestamp("arrived_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // At most one paid future period per account: concurrent verified orders
    // for the same future window cannot both claim it.
    uniqueIndex("paid_entitlements_one_future")
      .on(table.accountId)
      .where(sql`kind = 'subscription' AND state = 'future'`),
    check(
      "paid_entitlements_amounts",
      sql`${table.creditsMicrocredits} > 0 AND ${table.consumedMicrocredits} >= 0 AND ${table.consumedMicrocredits} <= ${table.creditsMicrocredits} AND (${table.kind} <> 'subscription' OR (${table.periodStart} IS NOT NULL AND ${table.periodEnd} IS NOT NULL AND ${table.periodEnd} > ${table.periodStart} AND ${table.anchorDay} BETWEEN 1 AND 31))`,
    ),
    index("paid_entitlements_account").on(table.accountId, table.arrivedAt),
  ],
);

export const paidAllocationStates = ["held", "settled", "released"] as const;

// A reservation's hold split across paid credit sources, in the order
// consumption must follow: current-period subscription credits first, then
// Credit Packs by arrival. Releases void the hold; settlement consumes the
// sources in the same order.
export const paidCreditAllocations = pgTable(
  "paid_credit_allocations",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => testCreditAccounts.id),
    operationId: text("operation_id").notNull(),
    entitlementId: uuid("entitlement_id").references(() => paidEntitlements.id),
    position: integer().notNull(),
    amountMicrocredits: bigint("amount_microcredits", {
      mode: "bigint",
    }).notNull(),
    // What a settlement actually drew from this source; null while the hold
    // is intact and for released, never-consumed holds. The bill view reads
    // this so partially drawn rows book their true amount per source.
    consumedMicrocredits: bigint("consumed_microcredits", { mode: "bigint" }),
    state: text({ enum: paidAllocationStates }).notNull().default("held"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("paid_credit_allocations_operation").on(
      table.accountId,
      table.operationId,
      table.position,
    ),
    check(
      "paid_credit_allocations_amount",
      sql`${table.amountMicrocredits} > 0`,
    ),
    index("paid_credit_allocations_holds").on(table.entitlementId, table.state),
  ],
);
