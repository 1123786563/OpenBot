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
import { accessGrants } from "./access-grants";
import { billingCustomers } from "./billing";
import { botServices } from "./bot-services";
import { creditGrants, creditLedger } from "./credits";

/**
 * A hard-cap hold on a customer's credit capacity, taken before metered work runs.
 *
 * `maximum` is the integer ceiling (scaled units, ×100) the hold may consume; each allocation row
 * names the grant that backs part of it. While `status = 'reserved'` the allocations count against
 * their grants' free capacity; a terminal state (`settled`/`released`) is written once and never
 * changes, which is what makes settle/release replays return the first result.
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
    /**
     * The locked pricing basis (Bifrost 06.5): the model cell the hold was admitted against,
     * with the exact snapshotVersion and rateVersion it priced. Settlement resolves THIS
     * combination, never whatever is newest. All five fields are present together or absent
     * together (the completeness CHECK): a pre-06.5 row or a non-protocol writer carries no
     * lock, and a half-lock is refused outright — it is not a basis anyone can price from.
     *
     * `unknown` is the result-unconfirmed state (Bifrost 06.8, Q12/AC15): a hold whose provider
     * outcome never reliably arrived keeps occupying capacity FOREVER as far as the clock is
     * concerned — `expires_at` fences only plain reserved holds and new admissions, never an
     * unknown one. Entering the state records `unknown_at`/`unknown_reason` (the evidence 08.x's
     * recovery and an operator's evidenced disposal stand on); only recovery settles it (the
     * ordinary settle path, same reservation id) or the recovery release moves it.
     */
    provider: text("provider"),
    model: text("model"),
    capability: text("capability"),
    snapshotVersion: integer("snapshot_version"),
    rateVersion: integer("rate_version"),
    status: text("status")
      .$type<"reserved" | "unknown" | "settled" | "released">()
      .notNull()
      .default("reserved"),
    /** After this instant recovery may release the hold; it does not release itself. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
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
    /** When the hold entered `unknown` (set once, kept as history afterwards). */
    unknownAt: timestamp("unknown_at", { withTimezone: true }),
    /** Why the hold entered `unknown` (the unsettled reason), kept as history. */
    unknownReason: text("unknown_reason"),
  },
  (table) => [
    check(
      "credit_reservations_status_check",
      sql`${table.status} IN ('reserved', 'unknown', 'settled', 'released')`,
    ),
    check("credit_reservations_maximum_check", sql`${table.maximum} > 0`),
    /*
     * The completeness CHECK, written so PostgreSQL can never answer NULL for it: a CHECK whose
     * expression evaluates to NULL PASSES, which is how the earlier all-or-nothing phrasing
     * (all five NULL OR all five valid) let half-locked rows land — a partial row made the valid
     * branch NULL, and FALSE OR NULL is NULL. Each equality below compares two booleans that are
     * always TRUE or FALSE, so every partial shape is a hard FALSE; the value checks run only
     * where every field is present. (Same `(x) = (y IS NOT NULL)` shape as the catalog-sync-state
     * failure-details CHECK in db/schema/gateway.ts.)
     */
    check(
      "credit_reservations_lock_completeness_check",
      sql`(${table.provider} IS NULL) = (${table.model} IS NULL) AND (${table.provider} IS NULL) = (${table.capability} IS NULL) AND (${table.provider} IS NULL) = (${table.snapshotVersion} IS NULL) AND (${table.provider} IS NULL) = (${table.rateVersion} IS NULL) AND (${table.provider} IS NULL OR (${table.provider} <> '' AND ${table.model} <> '' AND ${table.capability} IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown') AND ${table.snapshotVersion} >= 1 AND ${table.rateVersion} >= 0))`,
    ),
    check(
      "credit_reservations_terminal_check",
      sql`(${table.status} IN ('reserved', 'unknown') AND ${table.terminalAt} IS NULL) OR (${table.status} IN ('settled', 'released') AND ${table.terminalAt} IS NOT NULL)`,
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

/**
 * Who a reservation was admitted FOR (06.12's consumption attribution): the model access grant
 * the protocol reserve ran under and the registered Bot that grant belongs to. The credit
 * writer owns `credit_reservations` and is deliberately unchanged by this slice — attribution
 * is written beside the hold by the protocol reserve (../billing/credit-reserve.ts), inside
 * the SAME transaction, from the grant row revalidation already proved. A reservation without
 * a row here was not admitted through the protocol (a writer-direct hold, or a row from before
 * the migration) and the user view answers "unattributed" for it — never a guess.
 *
 * One row per reservation (the primary key IS the reservation id) and it never changes: which
 * grant admitted a hold is a fact of the admission, not a mutable label.
 */
export const creditReservationAttribution = pgTable(
  "credit_reservation_attribution",
  {
    reservationId: text("reservation_id")
      .primaryKey()
      .references(() => creditReservations.id, { onDelete: "cascade" }),
    grantId: text("grant_id")
      .notNull()
      .references(() => accessGrants.grantId),
    botId: text("bot_id")
      .notNull()
      .references(() => botServices.botId),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The consumption read walks a customer's ledger to its reservation's Bot.
    index("credit_reservation_attribution_bot_idx").on(table.botId),
  ],
);

/**
 * One unknown-dispatch recovery item (Bifrost 08.1): the durable name of one hold whose
 * provider result never reliably arrived, written by the recovery scan for the downstream
 * handlers (08.2's persisted-result replay, 08.4's background retry, 08.9's evidenced
 * disposal) to consume. The scan itself does NOTHING else — no release, no re-dispatch,
 * no settlement — so the existence of a row here is a discovery record, never a money
 * fact; every ledger and capacity fact still lives in `credit_reservations` and friends.
 *
 * WHAT THE ITEM FIXES (the ticket's Produces contract): the attempt identity (derived,
 * 06.7), the original reservation, the payment account and the price-basis versions the
 * hold was admitted under — all copied from the reservation AT DETECTION TIME, so a later
 * settlement of the hold (or its deletion by the cleanup program, which CASCADEs here)
 * cannot silently change what recovery works from. `payer_kind`/`payer_id` name the payer
 * mapping the account resolved through, when one resolves — a hold with no mapping row
 * (writer-direct, pre-migration) stays null there, unattributed, never guessed.
 *
 * WHY THE RESERVATION IS THE UNIQUE ANCHOR: exactly one item per reservation, ever (the
 * unique indexes) — a re-scan of the same unknown hold re-finds nothing to create, and two
 * scan passes racing (or two replicas) cannot both win the insert. The claim columns carry
 * the one-worker-wins semantics: `state` moves pending→claimed in one atomic UPDATE, and
 * the CHECK keeps the claim's who/when inseparable from the claimed state.
 */
export const creditRecoveryItems = pgTable(
  "credit_recovery_items",
  {
    /** `cri-` plus 8 random bytes as hex, minted by the scan. */
    id: text("id").primaryKey(),
    /** The attempt identity (06.7): a pure function of the reservation id, duplicated here
     * so recovery consumers can key on the attempt without re-deriving it. */
    attemptId: text("attempt_id").notNull(),
    /** The unknown hold this item names; one item per reservation, ever. */
    reservationId: text("reservation_id")
      .notNull()
      .references(() => creditReservations.id, { onDelete: "cascade" }),
    /** The payment account the hold bills through, copied at detection (the ticket's
     * "fixed original reservation, payment account"). */
    externalCustomerId: text("external_customer_id").notNull(),
    /** The payer mapping behind the account, when one resolves; null stays null. */
    payerKind: text("payer_kind"),
    payerId: text("payer_id"),
    /** The locked price basis copied from the hold (06.5): all five or none, as the
     * reservation's own completeness CHECK already guarantees. */
    provider: text("provider"),
    model: text("model"),
    capability: text("capability"),
    snapshotVersion: integer("snapshot_version"),
    rateVersion: integer("rate_version"),
    /** The hold ceiling at detection. */
    maximum: integer("maximum").notNull(),
    /** Claim lifecycle: pending (unclaimed) → claimed (one worker owns it) → resolved (a
     * handler finished it; the claim's who/when stay as the resolution's evidence). A
     * failed handler hands the item back to pending with failure_count incremented (08.2;
     * 08.4 owns the retry policy on top). */
    state: text("state")
      .$type<"pending" | "claimed" | "resolved">()
      .notNull()
      .default("pending"),
    /** How many times a handler has failed to finish this item (08.4 records; 08.1
     * initializes at 0). */
    failureCount: integer("failure_count").notNull().default(0),
    /** Why the item exists (the unknown mark's reason, or the expired-hold reason), later
     * the handler's last failure reason. */
    lastReason: text("last_reason"),
    /** When the scan first saw the unknown hold. */
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    /** The claim: who owns the item and when, together or not at all (the CHECK). */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("credit_recovery_items_attempt_unique_idx").on(table.attemptId),
    uniqueIndex("credit_recovery_items_reservation_unique_idx").on(
      table.reservationId,
    ),
    check(
      "credit_recovery_items_state_check",
      sql`${table.state} IN ('pending', 'claimed', 'resolved')`,
    ),
    check(
      "credit_recovery_items_payer_kind_check",
      sql`${table.payerKind} IS NULL OR ${table.payerKind} IN ('personal', 'company', 'legacy_deployment', 'unknown_owner')`,
    ),
    check(
      "credit_recovery_items_failure_count_check",
      sql`${table.failureCount} >= 0`,
    ),
    // A claim without its owner (or the reverse) is not a state this table can hold: the
    // who and the when are part of the claimed fact, not adjacent columns. A resolved item
    // keeps both — who finished it is part of the resolution's evidence (08.2).
    check(
      "credit_recovery_items_claim_consistency_check",
      sql`(${table.state} = 'pending' AND ${table.claimedAt} IS NULL AND ${table.claimedBy} IS NULL) OR (${table.state} IN ('claimed', 'resolved') AND ${table.claimedAt} IS NOT NULL AND ${table.claimedBy} IS NOT NULL)`,
    ),
    // The claim queue read: pending items, oldest detection first.
    index("credit_recovery_items_state_detected_idx").on(
      table.state,
      table.detectedAt,
    ),
  ],
);
