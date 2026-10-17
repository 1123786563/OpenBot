import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  PaymentActivationState,
  PaymentOrderStatus,
  PaymentProviderId,
} from "../../billing/payments/types";
import type { PayerKind } from "../../billing/payer";

/**
 * One local payment order, keyed by the out-trade number this deployment generated (`po-` plus
 * 16 hex, 19 characters — inside WeChat's 32-byte ceiling). The id is the only identity the
 * anonymous callbacks carry, so it is the primary key rather than a surrogate.
 *
 * Idempotency semantics, in one place:
 *
 * - The money state moves forward only (`pending → paid/blocked/canceled/expired`, plus the
 *   late-fulfilment window `expired/canceled → paid`); `paid` and `blocked` absorb. Every
 *   transition is a CAS on `version`, so two concurrent confirmations of the same delivery are
 *   one win and one re-read.
 * - `amount_cents` and `currency` are the catalog price snapshotted at order time. A callback
 *   amount is compared against this snapshot, never written over it — the order is the authority
 *   on what was bought; the channel transaction is the authority on what was paid.
 * - `terminal_at` records when a terminal state was reached, and anchors the late-payment window:
 *   an expired order may still be paid within `terminal_at + window`, never after, so an
 *   expiring-then-paying order loses no money and cannot be replayed forever.
 * - `paid_at` records only the paid transition itself. Old paid rows backfill it from
 *   `terminal_at`; every non-paid row keeps it null, so invoice settlement time never has to
 *   guess whether a terminal timestamp means "money landed" or merely "this order ended".
 * - `created_by` names the administrator who opened the order, for the audit trail.
 * - The channel's transaction id lands both here (the latest seen) and, once money moved, as a
 *   paid fact in `payment_events` — the events row is the cross-order idempotency key (see the
 *   partial unique index there); this column is the per-order read.
 */
export const paymentOrders = pgTable(
  "payment_orders",
  {
    id: text("id").primaryKey(),
    deploymentScope: text("deployment_scope").notNull().default("default"),
    planCode: text("plan_code").notNull(),
    provider: text("provider").$type<PaymentProviderId>().notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("CNY"),
    status: text("status").$type<PaymentOrderStatus>().notNull(),
    activationState: text("activation_state")
      .$type<PaymentActivationState>()
      .notNull()
      .default("pending"),
    channelTransactionId: text("channel_transaction_id"),
    /** The checkout artifact (QR payload), echoed only to the order's creator. */
    checkoutPayload: text("checkout_payload"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    createdBy: text("created_by"),
    /**
     * The order's payment subject, as a PayerRef ({ kind, id }) resolved SERVER-SIDE from the
     * authenticated identity at creation — never from a request field (AC14/Q27). Nullable
     * only as the legacy rows' pre-attribution state: new orders refuse to insert without one
     * (the store refuses; the pair CHECK keeps the columns togther), the legacy-owner
     * attribution pass fills them from 02.2's explicit mapping or quarantines the row as
     * `unknown_owner`. A null or non-personal owner never matches a personal read scope.
     */
    ownerPayerKind: text("owner_payer_kind").$type<PayerKind>(),
    ownerPayerId: text("owner_payer_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    check(
      "payment_orders_status_check",
      sql`${table.status} IN ('pending', 'paid', 'blocked', 'canceled', 'expired')`,
    ),
    check(
      "payment_orders_activation_state_check",
      sql`${table.activationState} IN ('pending', 'applied', 'failed')`,
    ),
    check(
      "payment_orders_provider_check",
      sql`${table.provider} IN ('alipay', 'wechat')`,
    ),
    check("payment_orders_amount_check", sql`${table.amountCents} > 0`),
    check("payment_orders_currency_check", sql`${table.currency} = 'CNY'`),
    // The owner pair moves together: a half-written owner is a bug, not a state.
    check(
      "payment_orders_owner_pair_check",
      sql`(${table.ownerPayerKind} IS NULL) = (${table.ownerPayerId} IS NULL)`,
    ),
    // The owner kind is a PayerKind: the quarantine vocabulary rides in the column, so an
    // unknown_owner row is data an operator can query, never a guessable default.
    check(
      "payment_orders_owner_kind_check",
      sql`${table.ownerPayerKind} IS NULL OR ${table.ownerPayerKind} IN ('personal', 'company', 'legacy_deployment', 'unknown_owner')`,
    ),
    // The replay lookup for "same plan, same provider, still open": one live order per pair.
    index("payment_orders_plan_provider_status_idx").on(
      table.planCode,
      table.provider,
      table.status,
    ),
    // The database is one deployment's purchase scope: plan and provider must not create parallel
    // payable orders because the subscription and entitlement are deployment-wide. Terminal rows
    // remain durable history and free this slot.
    uniqueIndex("payment_orders_pending_scope_unique_idx")
      .on(table.deploymentScope)
      .where(sql`${table.status} = 'pending'`),
    // The sweeper's query-first pass reads exactly this.
    index("payment_orders_status_expires_idx").on(
      table.status,
      table.expiresAt,
    ),
    // The owner-scoped reads (a person's order list, the statement window) filter on exactly this.
    index("payment_orders_owner_idx").on(
      table.ownerPayerId,
      table.ownerPayerKind,
    ),
  ],
);

/**
 * One channel event on one order, in exactly two kinds:
 *
 * - `fact` — "the channel reports this transaction landed". The rows this deployment acts on are
 *   the paid ones, and the partial unique index below makes a paid fact claim its channel
 *   transaction id once, server-side: a redelivery, or a second order the same transaction is
 *   reported against, cannot insert a second paid fact. The insert-or-nothing IS the idempotency;
 *   the code answers from the unique violation, not from a read that can race.
 * - `anomaly` — something worth keeping that is not money moving: an amount mismatch, an
 *   over-payment, a late payment. Anomalies never claim the fact key (several can coexist, and
 *   none may block a later legitimate fact), so the partial index is the whole design: a unique
 *   index over all rows would make the second anomaly impossible to record.
 */
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => paymentOrders.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"fact" | "anomaly">().notNull(),
    /** The settled word: `paid` for a fact; an anomaly names itself (`amount-mismatch`, …). */
    code: text("code").notNull(),
    state: text("state"),
    channelTransactionId: text("channel_transaction_id"),
    amountCents: integer("amount_cents"),
    detail: text("detail").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "payment_events_kind_check",
      sql`${table.kind} IN ('fact', 'anomaly')`,
    ),
    // THE idempotency key: one paid fact per channel transaction, across all orders. `ON CONFLICT
    // DO NOTHING` against this index answers a replay, and the insert that wins the race is the
    // one whose order transition also won its CAS — the two live in one transaction.
    uniqueIndex("payment_events_paid_fact_unique_idx")
      .on(table.channelTransactionId)
      .where(sql`${table.kind} = 'fact' AND ${table.state} = 'paid'`),
    index("payment_events_order_idx").on(table.orderId),
    // One anomaly row per (order, word): the retry-storm dam (P2-2). Partial on kind so facts
    // never touch it, and EXCLUDING `amount_unreadable` — that word's repeats are not a storm
    // but a counter: a channel that keeps saying "paid, amount unreadable" is the signal that
    // ends the order (settlePaidFact's exhaustion), so those rows must accumulate. Targetless
    // ON CONFLICT DO NOTHING in recordAnomaly answers this index.
    uniqueIndex("payment_events_anomaly_unique_idx")
      .on(table.orderId, table.code)
      .where(
        sql`${table.kind} = 'anomaly' AND ${table.code} <> 'amount_unreadable'`,
      ),
  ],
);
