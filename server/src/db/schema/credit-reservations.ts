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
import { billingCustomers } from "./billing";
import { creditGrants, creditLedger } from "./credits";

/**
 * A hard-cap hold on a customer's credit capacity, taken before metered work runs.
 *
 * `maximum` is the integer ceiling (scaled units, ×100) the hold may consume; each allocation row
 * names the grant that backs part of it. While `status = 'reserved'` the allocations count against
 * their grants' free capacity; a terminal state (`settled`/`released`) is written once and never
 * changes, which is what makes settle/release replays return the first result.
 *
 * `unknown` is the result-unconfirmed state (Bifrost 06.8, Q12/AC15): a hold whose provider
 * outcome never reliably arrived keeps occupying capacity FOREVER as far as the clock is
 * concerned — `expires_at` fences only plain reserved holds and new admissions, never an
 * unknown one. Entering the state records `unknown_at`/`unknown_reason` (the evidence 08.x's
 * recovery and an operator's evidenced disposal stand on); only recovery settles it (the
 * ordinary settle path, same reservation id) or the recovery release moves it.
 *
 * The actual cost of a settled hold is kept as the exact rational `actual_numerator /
 * actual_denominator` (scaled units), because per-token rates are fractional; the integer actually
 * charged is `charged`, and the fraction left over lives in `credit_charge_remainders`.
 */
export const creditReservations = pgTable(
  "credit_reservations",
  {
    id: text("id").primaryKey(),
    externalCustomerId: text("external_customer_id")
      .notNull()
      .references(() => billingCustomers.externalId, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    maximum: integer("maximum").notNull(),
    status: text("status")
      .$type<"reserved" | "unknown" | "settled" | "released">()
      .notNull()
      .default("reserved"),
    /** After this instant recovery may release the hold; it does not release itself. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** When the hold entered `unknown` (set once, kept as history afterwards). */
    unknownAt: timestamp("unknown_at", { withTimezone: true }),
    /** Why the hold entered `unknown` (the unsettled reason), kept as history. */
    unknownReason: text("unknown_reason"),
    actualNumerator: text("actual_numerator"),
    actualDenominator: text("actual_denominator"),
    /** Whole units the exact actual cost (plus the carried remainder) came to. */
    charged: integer("charged"),
    /** The carried fraction as it stood right after this settlement, so a replay answers it. */
    remainderNumerator: text("remainder_numerator"),
    remainderDenominator: text("remainder_denominator"),
    /** What the grants absorbed of `charged` (the hold caps it). */
    applied: integer("applied"),
    /** Held capacity handed back, unused. */
    released: integer("released"),
    releaseReason: text("release_reason"),
    ledgerId: text("ledger_id").references(() => creditLedger.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "credit_reservations_status_check",
      sql`${table.status} IN ('reserved', 'unknown', 'settled', 'released')`,
    ),
    check("credit_reservations_maximum_check", sql`${table.maximum} > 0`),
    check(
      "credit_reservations_terminal_check",
      sql`(${table.status} IN ('reserved', 'unknown') AND ${table.terminalAt} IS NULL) OR (${table.status} IN ('settled', 'released') AND ${table.terminalAt} IS NOT NULL)`,
    ),
    // An unknown hold carries its evidence (06.8 step 3): the reason and the instant it
    // entered, paired and present exactly when the hold is unknown. Later terminal states
    // keep both as history; a hold that was never unknown has neither.
    check(
      "credit_reservations_unknown_evidence_check",
      sql`(${table.unknownAt} IS NULL) = (${table.unknownReason} IS NULL) AND (${table.status} <> 'reserved' OR ${table.unknownAt} IS NULL) AND (${table.status} <> 'unknown' OR ${table.unknownAt} IS NOT NULL)`,
    ),
    check(
      "credit_reservations_settled_check",
      sql`${table.status} <> 'settled' OR (${table.actualNumerator} ~ '^[0-9]+$' AND ${table.actualDenominator} ~ '^[0-9]+$' AND ${table.actualDenominator} !~ '^0+$' AND ${table.charged} >= 0 AND ${table.applied} >= 0 AND ${table.applied} <= ${table.maximum} AND ${table.released} = ${table.maximum} - ${table.applied})`,
    ),
    uniqueIndex("credit_reservations_idempotency_key_unique_idx").on(
      table.idempotencyKey,
    ),
    index("credit_reservations_customer_status_idx").on(
      table.externalCustomerId,
      table.status,
    ),
    index("credit_reservations_status_expires_idx").on(
      table.status,
      table.expiresAt,
    ),
  ],
);

/** The grants backing one reservation; `consumed` is what settlement drew from each. */
export const creditReservationAllocations = pgTable(
  "credit_reservation_allocations",
  {
    id: text("id").primaryKey(),
    reservationId: text("reservation_id")
      .notNull()
      .references(() => creditReservations.id, { onDelete: "cascade" }),
    grantId: text("grant_id")
      .notNull()
      .references(() => creditGrants.id, { onDelete: "cascade" }),
    amount: integer("amount").notNull(),
    consumed: integer("consumed").notNull().default(0),
  },
  (table) => [
    check(
      "credit_reservation_allocations_amount_check",
      sql`${table.amount} > 0`,
    ),
    check(
      "credit_reservation_allocations_consumed_check",
      sql`${table.consumed} >= 0 AND ${table.consumed} <= ${table.amount}`,
    ),
    uniqueIndex("credit_reservation_allocations_reservation_grant_idx").on(
      table.reservationId,
      table.grantId,
    ),
    index("credit_reservation_allocations_grant_idx").on(table.grantId),
  ],
);

/**
 * The per-customer fraction of a scaled unit that exact-rational costs have accrued but not yet
 * charged: `numerator / denominator`, always in [0, 1) and in lowest terms. It carries from one
 * settlement into the next so fractional rates are never rounded per event.
 */
export const creditChargeRemainders = pgTable(
  "credit_charge_remainders",
  {
    externalCustomerId: text("external_customer_id")
      .primaryKey()
      .references(() => billingCustomers.externalId, { onDelete: "cascade" }),
    numerator: text("numerator").notNull(),
    denominator: text("denominator").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "credit_charge_remainders_shape_check",
      sql`${table.numerator} ~ '^[0-9]+$' AND ${table.denominator} ~ '^[1-9][0-9]*$'`,
    ),
  ],
);
