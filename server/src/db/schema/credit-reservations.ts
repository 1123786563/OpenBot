import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
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
      sql`(${table.provider} IS NULL) = (${table.model} IS NULL) AND (${table.provider} IS NULL) = (${table.capability} IS NULL) AND (${table.provider} IS NULL) = (${table.snapshotVersion} IS NULL) AND (${table.provider} IS NULL) = (${table.rateVersion} IS NULL) AND (${table.provider} IS NULL OR (${table.provider} <> '' AND ${table.model} <> '' AND ${table.capability} IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'ocr', 'realtime', 'video', 'unknown') AND ${table.snapshotVersion} >= 1 AND ${table.rateVersion} >= 0))`,
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
    reservationId: text("reservation_id").primaryKey(),
    grantId: text("grant_id").notNull(),
    botId: text("bot_id")
      .notNull()
      .references(() => botServices.botId),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Explicit short names: drizzle's default spells both table names and lands past the
    // 63-byte identifier limit Postgres silently truncates at.
    foreignKey({
      name: "credit_reservation_attribution_reservation_id_fk",
      columns: [table.reservationId],
      foreignColumns: [creditReservations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "credit_reservation_attribution_grant_id_fk",
      columns: [table.grantId],
      foreignColumns: [accessGrants.grantId],
    }),
    // The consumption read walks a customer's ledger to its reservation's Bot.
    index("credit_reservation_attribution_bot_idx").on(table.botId),
  ],
);

/**
 * One settlement's line detail (Bifrost 12.2, #303): the structured entry a capability's
 * settlement writes beside its ledger row — the frozen request spec (12.1), the
 * provider-reported actual count, and the locked unit price the settlement priced at.
 * Written only inside the credit writer's settle transaction (one commit with the ledger
 * row and the reservation's terminal update), keyed uniquely by the reservation: one
 * settlement is one terminal fact of one hold, so one line. The MONEY stays on the ledger
 * row (`credit_ledger.credits` is the amount the view shows); this row is what the
 * consumption entry says was consumed, per capability — the closed `capability` vocabulary
 * keeps entries distinguishable, and a new capability arrives with its own migration.
 */
export const creditSettlementDetails = pgTable(
  "credit_settlement_details",
  {
    reservationId: text("reservation_id").primaryKey(),
    ledgerId: text("ledger_id")
      .notNull()
      .references(() => creditLedger.id),
    capability: text("capability").notNull(),
    requestedCount: integer("requested_count").notNull(),
    generatedCount: integer("generated_count").notNull(),
    inputImages: integer("input_images").notNull().default(0),
    size: text("size"),
    quality: text("quality"),
    /** The locked per-image USD the settlement priced at — an exact decimal string. */
    unitPriceUsd: text("unit_price_usd").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "credit_settlement_details_reservation_id_fk",
      columns: [table.reservationId],
      foreignColumns: [creditReservations.id],
    }),
    check(
      "credit_settlement_details_capability_check",
      sql`${table.capability} in ('image')`,
    ),
    check(
      "credit_settlement_details_counts_check",
      sql`${table.requestedCount} > 0 and ${table.generatedCount} >= 0 and ${table.generatedCount} <= ${table.requestedCount} and ${table.inputImages} >= 0`,
    ),
    check(
      "credit_settlement_details_unit_price_shape_check",
      sql`${table.unitPriceUsd} ~ '^[0-9]+(\\.[0-9]+)?$'`,
    ),
    index("credit_settlement_details_ledger_idx").on(table.ledgerId),
  ],
);

/**
 * The SPEECH settlement line detail (Bifrost 13.2, #307) — the speech counterpart of
 * {@link creditSettlementDetails}, in its own table because that one states the IMAGE
 * facts in its NOT NULLs and a speech row would have to fake them to fit. Written only
 * inside the credit writer's settle transaction (one commit with the ledger row and the
 * reservation's terminal update), keyed uniquely by the reservation. The MONEY stays on
 * the ledger row; this row carries what was actually spoken — the characters in, the
 * seconds out (an exact decimal string, the shape the settlement priced), the cap the
 * hold was certified against, and the TWO locked tier prices it priced at. The closed
 * `capability` vocabulary stays closed on each side ('speech' here, 'image' there).
 */
export const creditSpeechSettlementDetails = pgTable(
  "credit_speech_settlement_details",
  {
    reservationId: text("reservation_id").primaryKey(),
    ledgerId: text("ledger_id")
      .notNull()
      .references(() => creditLedger.id),
    capability: text("capability").notNull(),
    inputCharacters: integer("input_characters").notNull(),
    /** The output-duration cap the hold was certified against (13.1's frozen spec). */
    cappedSeconds: integer("capped_seconds").notNull(),
    /** The actual billed seconds — the exact decimal the settlement priced, never a float. */
    actualSeconds: text("actual_seconds").notNull(),
    /** The locked per-input-character USD the settlement priced at. */
    perInputCharacterUsd: text("per_input_character_usd").notNull(),
    /** The locked per-output-second USD the settlement priced at. */
    perOutputSecondUsd: text("per_output_second_usd").notNull(),
    voiceTier: text("voice_tier"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "credit_speech_settlement_details_reservation_id_fk",
      columns: [table.reservationId],
      foreignColumns: [creditReservations.id],
    }),
    check(
      "credit_speech_settlement_details_capability_check",
      sql`${table.capability} = 'speech'`,
    ),
    check(
      "credit_speech_settlement_details_quantities_check",
      sql`${table.inputCharacters} >= 0 and ${table.cappedSeconds} > 0`,
    ),
    check(
      "credit_speech_settlement_details_actual_seconds_shape_check",
      sql`${table.actualSeconds} ~ '^[0-9]+(\\.[0-9]+)?$'`,
    ),
    check(
      "credit_speech_settlement_details_per_input_character_shape_check",
      sql`${table.perInputCharacterUsd} ~ '^[0-9]+(\\.[0-9]+)?$'`,
    ),
    check(
      "credit_speech_settlement_details_per_output_second_shape_check",
      sql`${table.perOutputSecondUsd} ~ '^[0-9]+(\\.[0-9]+)?$'`,
    ),
    index("credit_speech_settlement_details_ledger_idx").on(table.ledgerId),
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
    /**
     * When the background retry scheduler (08.4) may claim the item again: stamped
     * `now + backoff(failure_count)` by the failure path, NULL while never attempted or
     * once the failure count reached the threshold (no next retry — the manual queue
     * owns the item from there). The retry's own truth, never re-armed by unrelated
     * writes (0175).
     */
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    /** When the scan first saw the unknown hold. */
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    /** The claim: who owns the item and when, together or not at all (the CHECK). */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    /**
     * The optimistic-concurrency version (08.9): what an operator's `expectedVersion`
     * stands on. A disposal resolves the item through a guarded UPDATE on this column, so
     * a command built from a stale read cannot land; the resolution itself bumps it, which
     * is what fences a second disposal behind the resolved-state check.
     */
    version: integer("version").notNull().default(1),
    /**
     * THE DISPOSAL RECORD (08.9) — all five columns together or all five absent (the
     * CHECK): the action an administrator commanded, who commanded it and when, the
     * specific evidence row (credit_recovery_queries) the action stood on, and the
     * command's own idempotency key (a transport retry of the SAME command reads the
     * recorded answer; a DIFFERENT disposal of a resolved item refuses). The recovery
     * handlers' own resolutions (08.2's replay) leave these NULL — their evidence is the
     * replay's reason, not an operator's evidence row. `compensate` (08.10) is the
     * platform-loss action: it stands on still_unknown evidence and is audited under its
     * OWN event type — never recorded as a release, never read back as "no charge".
     */
    resolvedAction: text("resolved_action").$type<
      "settle" | "release" | "compensate"
    >(),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // No drizzle-level FK here on purpose: this table and credit_recovery_queries already
    // reference each other (the trail's own item_id FK points back), and a second
    // cross-edge makes the schema's type inference circular. The REAL constraint lives in
    // the SQL migration (0169), which is what any migrated database enforces; the drift
    // gate checks columns, and the service validates the evidence row itself.
    resolutionEvidenceId: text("resolution_evidence_id"),
    resolutionIdempotencyKey: text("resolution_idempotency_key"),
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
    check("credit_recovery_items_version_check", sql`${table.version} >= 1`),
    check(
      "credit_recovery_items_resolved_action_check",
      sql`${table.resolvedAction} IS NULL OR ${table.resolvedAction} IN ('settle', 'release', 'compensate')`,
    ),
    // A disposal record is complete or absent: an action without its operator, or an
    // evidence pointer without an action, is a half-fact this table refuses to hold.
    check(
      "credit_recovery_items_disposal_shape_check",
      sql`(${table.resolvedAction} IS NULL AND ${table.resolvedBy} IS NULL AND ${table.resolvedAt} IS NULL AND ${table.resolutionEvidenceId} IS NULL AND ${table.resolutionIdempotencyKey} IS NULL) OR (${table.resolvedAction} IN ('settle', 'release', 'compensate') AND ${table.resolvedBy} IS NOT NULL AND ${table.resolvedAt} IS NOT NULL AND ${table.resolutionEvidenceId} IS NOT NULL AND ${table.resolutionIdempotencyKey} IS NOT NULL)`,
    ),
    // One disposal per command key, ever — a database-level truth, so two replicas racing
    // the same command cannot both record it (partial: the handlers' NULL keys don't
    // collide with each other).
    uniqueIndex("credit_recovery_items_resolution_idempotency_key_unique_idx")
      .on(table.resolutionIdempotencyKey)
      .where(sql`${table.resolutionIdempotencyKey} IS NOT NULL`),
    // A claim without its owner (or the reverse) is not a state this table can hold: the
    // who and the when are part of the claimed fact, not adjacent columns. A handler's
    // resolved item keeps both — who finished it is part of the resolution's evidence
    // (08.2). The THIRD shape (08.9, 0169): an evidenced disposal resolves an item
    // straight out of `pending` — the review queue's items are unclaimed, that is why an
    // operator reads them — so `resolved` without a claim is legal exactly when a
    // disposal record exists (the disposal-shape CHECK above guarantees its
    // who/when/evidence/key completeness).
    check(
      "credit_recovery_items_claim_consistency_check",
      sql`(${table.state} = 'pending' AND ${table.claimedAt} IS NULL AND ${table.claimedBy} IS NULL) OR (${table.state} IN ('claimed', 'resolved') AND ${table.claimedAt} IS NOT NULL AND ${table.claimedBy} IS NOT NULL) OR (${table.state} = 'resolved' AND ${table.resolvedAction} IS NOT NULL)`,
    ),
    // The claim queue read: pending items, oldest detection first.
    index("credit_recovery_items_state_detected_idx").on(
      table.state,
      table.detectedAt,
    ),
  ],
);

/**
 * One provider final-state query against a recovery item (Bifrost 08.5): the durable,
 * append-only evidence row a query leaves behind, one per query, readable by the
 * administrator-facing recovery views (08.8) and by the evidenced disposal (08.9) as the
 * fact its action stands on.
 *
 * WHY A TABLE AND NOT A COLUMN. The item's `last_reason` names only the NEWEST fact; a
 * query pass that runs again (08.4's cadence) must not overwrite the trail that led there
 * — "queried twice, provider still has no record" is a different fact from "queried once",
 * and the disposal's evidence must survive later queries. The row is therefore written
 * once and never updated: `conclusion` is a closed vocabulary, `summary` is the bounded
 * raw excerpt of what the source answered, and `queried_at`/`recorded_at` keep the query's
 * own time apart from the write's.
 *
 * WHAT THE CONCLUSIONS MEAN (the ticket's three-way classification, snake_case):
 * `settled_evidence` — the provider confirms the work completed (with its own usage
 * summary when it has one); `no_charge_evidence` — the provider confirms the request was
 * never billed (refused/undispatched), the only conclusion that may ENTER the release
 * path; `still_unknown` — the provider has no record of the request, or the query itself
 * failed (unreachable, timeout, unmappable answer). "No record" is NOT release evidence
 * (Q12: 查不到不等于没发生), which is why it shares a conclusion with transport failure.
 */
export const creditRecoveryQueries = pgTable(
  "credit_recovery_queries",
  {
    /** `crq-` plus 8 random bytes as hex, minted by the query handler. */
    id: text("id").primaryKey(),
    /** The recovery item this query was run for; deleting the item takes its trail. */
    itemId: text("item_id")
      .notNull()
      .references(() => creditRecoveryItems.id, { onDelete: "cascade" }),
    /** The hold the item names, copied for reads that key on the reservation. */
    reservationId: text("reservation_id").notNull(),
    /** The attempt identity the source was asked about, copied the same way. */
    attemptId: text("attempt_id").notNull(),
    /** Who answered: the source's own name (e.g. "bifrost-jobaccounting"), not a free
     * string the handler invents — the source names itself. */
    source: text("source").notNull(),
    /** The three-way classification (see the table comment); CHECK-enforced. */
    conclusion: text("conclusion")
      .$type<"settled_evidence" | "no_charge_evidence" | "still_unknown">()
      .notNull(),
    /** The bounded raw excerpt of what the source answered — evidence, not prose; when
     * the query failed, the stable failure code. */
    summary: text("summary").notNull(),
    /** The provider's own usage report, when it completed with one; null otherwise. The
     * shape is the settle contract's closed dimension vocabulary, never a partial guess. */
    usageInput: integer("usage_input"),
    usageOutput: integer("usage_output"),
    /** When the query ran, kept apart from when the row was written. */
    queriedAt: timestamp("queried_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "credit_recovery_queries_conclusion_check",
      sql`${table.conclusion} IN ('settled_evidence', 'no_charge_evidence', 'still_unknown')`,
    ),
    // Usage dimensions travel together or not at all: a settled conclusion may carry them,
    // and nothing else may — a half-present usage would be a guess dressed as evidence.
    check(
      "credit_recovery_queries_usage_pair_check",
      sql`(${table.usageInput} IS NULL AND ${table.usageOutput} IS NULL) OR (${table.usageInput} IS NOT NULL AND ${table.usageOutput} IS NOT NULL)`,
    ),
    // The recovery trail read: everything asked about one item, newest first.
    index("credit_recovery_queries_item_queried_idx").on(
      table.itemId,
      table.queriedAt,
    ),
  ],
);

/**
 * One alert row per recovery item (Bifrost 08.6): the durable state that makes alerting
 * honest across restarts — what was alerted, when it started, when it last fired, and
 * whether it has already escalated. The row IS the dedup: the unique index on item_id
 * means one alert state per item, ever, so a restart (or two replicas racing) cannot
 * re-notify from zero.
 *
 * WHY A TABLE AND NOT THE SINK'S MEMORY. Dedup and escalation are facts about the
 * DEPLOYMENT's alerting posture, not about one process: a supervisor restart that
 * forgot every first-alert would blast a fresh "new anomaly" for every item on every
 * boot — exactly the spam the ticket's 去重 exists to prevent. Escalation needs
 * first_alerted_at, which must survive whatever the process does.
 *
 * WHAT THE ROW CARRIES — AND WHAT IT NEVER CARRIES. The disposal facts an operator
 * needs (归属账户 masked, 金额上限, 停留时长 via detected_at, 最近原因 as the stable
 * code, 失败次数) are copied at alert time so the row reads standalone. It never
 * carries credentials, raw provider answer bodies, or any OTHER account's data: the
 * account reference is masked at write time (`maskAccountRef`), the reason is the item's
 * closed-vocabulary last_reason, and the source summaries stay in
 * `credit_recovery_queries` where 08.8's view reads them under its own rules.
 *
 * THE LEVEL LADDER. `first` (a threshold or dwell limit was crossed, first
 * notification) → `repeat` (still unresolved after the repeat interval: a reminder,
 * not a new alert) → `escalated` (unhandled past the escalation window: the terminal
 * level — an escalated alert never re-fires, so an unattended queue plateaus instead
 * of filling the channel). `escalated_at` travels with the escalated level and with
 * nothing else, the same who/when inseparability the item's own claim CHECK keeps.
 */
export const creditRecoveryAlerts = pgTable(
  "credit_recovery_alerts",
  {
    /** `cra-` plus 8 random bytes as hex, minted by the alerting pass. */
    id: text("id").primaryKey(),
    /** The recovery item this alert state tracks; one per item, ever (unique index). */
    itemId: text("item_id")
      .notNull()
      .references(() => creditRecoveryItems.id, { onDelete: "cascade" }),
    /** The hold and attempt the item names, copied for reads that key on them. */
    reservationId: text("reservation_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    /** The OWNING account, masked at write time — the full key is the payer layer's
     * business, not the alert channel's. */
    accountMasked: text("account_masked").notNull(),
    /** The hold ceiling at alert time, in scaled units (×100). */
    maximumCredits: integer("maximum_credits").notNull(),
    /** The item's failure count when this alert last advanced. */
    failureCount: integer("failure_count").notNull(),
    /** The item's last_reason stable code when this alert last advanced. */
    reasonCode: text("reason_code"),
    /** The alert level ladder: first → repeat → escalated (terminal). */
    level: text("level").$type<"first" | "repeat" | "escalated">().notNull(),
    /** What last crossed: the retry threshold, or the dwell limit. */
    lastTrigger: text("last_trigger")
      .$type<"failure_threshold" | "dwell_limit">()
      .notNull(),
    /** When the anomaly was first detected (the item's detected_at, copied so dwell
     * reads standalone). */
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    /** The dedup anchors: when alerting started and when it last fired. */
    firstAlertedAt: timestamp("first_alerted_at", {
      withTimezone: true,
    }).notNull(),
    lastAlertedAt: timestamp("last_alerted_at", {
      withTimezone: true,
    }).notNull(),
    /** Set exactly when the level becomes escalated, never unset. */
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    /** How many notifications this alert state has emitted (first counts as 1). */
    alertCount: integer("alert_count").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("credit_recovery_alerts_item_unique_idx").on(table.itemId),
    check(
      "credit_recovery_alerts_level_check",
      sql`${table.level} IN ('first', 'repeat', 'escalated')`,
    ),
    check(
      "credit_recovery_alerts_trigger_check",
      sql`${table.lastTrigger} IN ('failure_threshold', 'dwell_limit')`,
    ),
    check(
      "credit_recovery_alerts_maximum_check",
      sql`${table.maximumCredits} > 0`,
    ),
    check(
      "credit_recovery_alerts_failure_count_check",
      sql`${table.failureCount} >= 0`,
    ),
    check(
      "credit_recovery_alerts_alert_count_check",
      sql`${table.alertCount} >= 1`,
    ),
    // The escalated level and its timestamp travel together or not at all — a level the
    // ladder has not reached must not wear the escalation's badge (the item claim's own
    // who/when discipline, applied to the alert).
    check(
      "credit_recovery_alerts_escalation_check",
      sql`(${table.level} <> 'escalated' AND ${table.escalatedAt} IS NULL) OR (${table.level} = 'escalated' AND ${table.escalatedAt} IS NOT NULL)`,
    ),
    check(
      "credit_recovery_alerts_ordering_check",
      sql`${table.lastAlertedAt} >= ${table.firstAlertedAt}`,
    ),
    // The operational read: what is still firing, newest first.
    index("credit_recovery_alerts_level_last_idx").on(
      table.level,
      table.lastAlertedAt,
    ),
  ],
);

/**
 * One accepted async submit's durable record (Bifrost 17.2, #326): the local job identity
 * a replayed submit converges on (the submit idempotency key is UNIQUE), with the
 * attribution facts — grant, payer, model, locked versions — fixed at creation (17.1's
 * contract members, carried here while the dedicated identity ticket is open) and the
 * full-cap reservation the submit held BEFORE any provider dispatch.
 *
 * `providerJobId` is nullable on purpose: the provider's answer can be lost (17.3), and
 * "not yet known" is a state the row must hold while the reservation stays occupied. The
 * state CHECK keeps dispatch's own outcome honest — `submitted` carries a provider job id,
 * `dispatch_unconfirmed` does not — while the money's terminal states stay on the
 * reservation, where 06.x owns them.
 */
export const asyncJobs = pgTable(
  "async_jobs",
  {
    /** `aj-` plus random bytes, minted by the submit path. */
    jobId: text("job_id").primaryKey(),
    /** The submit request's stable identity; one submit is one job, ever. */
    submitIdempotencyKey: text("submit_idempotency_key").notNull(),
    /** The authorization the submit ran under; attribution never re-resolves. */
    grantId: text("grant_id")
      .notNull()
      .references(() => accessGrants.grantId),
    /** The payer the reservation billed, copied at creation (17.1's fixed attribution). */
    payerKind: text("payer_kind").notNull(),
    payerId: text("payer_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    capability: text("capability").notNull(),
    snapshotVersion: integer("snapshot_version").notNull(),
    rateVersion: integer("rate_version").notNull(),
    /** The provider's job id when its answer arrived; null when lost (17.3's lane). */
    providerJobId: text("provider_job_id"),
    /** The full-cap hold; NOT NULL by migration — an accepted submit always holds one. */
    reservationId: text("reservation_id")
      .notNull()
      .references(() => creditReservations.id),
    /** The worst-case ceiling the submit reserved (all entries, one upward rounding). */
    maximumCredits: integer("maximum_credits").notNull(),
    /** How many entries the cap conversion covered. */
    entryCount: integer("entry_count").notNull(),
    /** Dispatch's own outcome; the money's states live on the reservation. */
    state: text("state")
      .$type<"submitted" | "dispatch_unconfirmed">()
      .notNull()
      .default("submitted"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("async_jobs_submit_idempotency_key_unique_idx").on(
      table.submitIdempotencyKey,
    ),
    check(
      "async_jobs_payer_kind_check",
      sql`${table.payerKind} IN ('personal', 'company', 'legacy_deployment', 'unknown_owner')`,
    ),
    check(
      "async_jobs_capability_check",
      sql`${table.capability} IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'ocr', 'realtime', 'video', 'unknown')`,
    ),
    check(
      "async_jobs_state_check",
      sql`${table.state} IN ('submitted', 'dispatch_unconfirmed')`,
    ),
    check(
      "async_jobs_version_check",
      sql`${table.snapshotVersion} >= 1 AND ${table.rateVersion} >= 0`,
    ),
    check("async_jobs_maximum_check", sql`${table.maximumCredits} > 0`),
    check("async_jobs_entry_count_check", sql`${table.entryCount} > 0`),
    check(
      "async_jobs_dispatch_shape_check",
      sql`(${table.state} = 'submitted' AND ${table.providerJobId} IS NOT NULL AND ${table.dispatchedAt} IS NOT NULL) OR (${table.state} = 'dispatch_unconfirmed' AND ${table.providerJobId} IS NULL)`,
    ),
    // The recovery sweep and the status read arrive by grant and by provider job id.
    index("async_jobs_grant_idx").on(table.grantId, table.createdAt),
    uniqueIndex("async_jobs_provider_job_id_idx").on(table.providerJobId),
  ],
);

/**
 * One async job's settle-trigger observability row (Bifrost 17.5, #329): how many times
 * settlement was triggered, by which lane (poll or completion notification), and the ONE
 * unified idempotency key both lanes computed (jobId + terminal version) — so a duplicate
 * trigger shows up as a count, never as a double charge (the reservation's own settle
 * fence, 06.9, is the money guarantee; this row is the visibility).
 *
 * The first trigger writes the key, the terminal state and the first timestamp, and they
 * never move; every trigger increments the counters atomically. No amounts live here —
 * the ledger is one, and it is not this table.
 */
export const asyncSettleTriggers = pgTable(
  "async_settle_triggers",
  {
    /** The job whose settlement was triggered — one row per job, ever. */
    jobId: text("job_id")
      .primaryKey()
      .references(() => asyncJobs.jobId),
    /** The unified key the first trigger computed (`async-terminal-settle:<job>:<state>:<digest>`). */
    idempotencyKey: text("idempotency_key").notNull(),
    /** The terminal state the first report carried. */
    terminalState: text("terminal_state")
      .$type<"completed" | "failed" | "cancelled">()
      .notNull(),
    totalTriggers: integer("total_triggers").notNull().default(1),
    pollTriggers: integer("poll_triggers").notNull().default(0),
    notificationTriggers: integer("notification_triggers").notNull().default(0),
    firstTriggeredAt: timestamp("first_triggered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Which lane triggered last — the closed two-member set the tickets name. */
    lastSource: text("last_source")
      .$type<"poll" | "notification">()
      .notNull(),
  },
  (table) => [
    uniqueIndex("async_settle_triggers_idempotency_key_idx").on(
      table.idempotencyKey,
    ),
    check(
      "async_settle_triggers_counts_check",
      sql`${table.totalTriggers} >= 1 AND ${table.pollTriggers} >= 0 AND ${table.notificationTriggers} >= 0 AND ${table.totalTriggers} >= ${table.pollTriggers} + ${table.notificationTriggers}`,
    ),
    // The operational read: recently triggered jobs, newest first.
    index("async_settle_triggers_last_idx").on(table.lastTriggeredAt),
  ],
);

/**
 * The async job's settlement line detail (Bifrost 17.6, #330) — the async counterpart of
 * {@link creditSettlementDetails} (image, 0179) and {@link creditSpeechSettlementDetails}
 * (speech, 0181), in its own table because its facts are neither: the attribution anchor
 * is the JOB (`jobId`, UNIQUE — the one key every surface of an async charge names), the
 * capability is the job's own (the closed vocabulary `async_jobs`' CHECK owns), and the
 * usage is the whole per-dimension map the provider's terminal report carried. Written
 * only inside the credit writer's settle transaction (one commit with the ledger row and
 * the reservation's terminal update), keyed uniquely by the reservation; the MONEY stays
 * on the ledger row.
 */
export const creditAsyncSettlementDetails = pgTable(
  "credit_async_settlement_details",
  {
    reservationId: text("reservation_id").primaryKey(),
    ledgerId: text("ledger_id")
      .notNull()
      .references(() => creditLedger.id),
    /** The job's own capability — the same closed vocabulary async_jobs' CHECK owns. */
    capability: text("capability").notNull(),
    /** The local job identity — the attribution anchor of the whole charge. */
    jobId: text("job_id").notNull(),
    /** The provider's job id, when the mapping is known (null is a state, 17.1). */
    providerJobId: text("provider_job_id"),
    entryCount: integer("entry_count").notNull(),
    terminalState: text("terminal_state")
      .$type<"completed" | "failed" | "cancelled">()
      .notNull(),
    /** The provider's real terminal usage, one whole number per billing dimension. */
    actualUsage: jsonb("actual_usage").$type<Record<string, number>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("credit_async_settlement_details_job_id_idx").on(table.jobId),
    check(
      "credit_async_settlement_details_capability_check",
      sql`${table.capability} in ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'ocr', 'realtime', 'video', 'unknown')`,
    ),
    check(
      "credit_async_settlement_details_terminal_state_check",
      sql`${table.terminalState} in ('completed', 'failed', 'cancelled')`,
    ),
    check("credit_async_settlement_details_entry_count_check", sql`${table.entryCount} > 0`),
    check(
      "credit_async_settlement_details_usage_shape_check",
      sql`jsonb_typeof(${table.actualUsage}) = 'object'`,
    ),
    index("credit_async_settlement_details_ledger_idx").on(table.ledgerId),
  ],
);

/**
 * The async job's cancellation record (Bifrost 17.7, #331): one row per job — the
 * provider's own cancel conclusion, the unbilled evidence an evidenced release stands on,
 * and the money reaction that conclusion produced. A cancel request is not a no-charge
 * proof: only the provider's own unbilled confirmation releases (through the Release
 * protocol's `no_usage` evidence kind, the receipt as reference); `unsupported`/`failed`
 * keep the hold held, and an unknown RESULT moves the hold to 06.8's unknown — full
 * capacity still occupied. Key expiry and client departure have no column here because
 * neither is a conclusion about the job. The row is the audit-visible fact (取消动作与
 * 结论可审计); the money truth stays on the reservation and the ledger.
 */
export const asyncJobCancellations = pgTable(
  "async_job_cancellations",
  {
    /** The job whose cancellation this row records — one row per job, ever. */
    jobId: text("job_id")
      .primaryKey()
      .references(() => asyncJobs.jobId),
    /** The most recent cancel request's idempotency key — the replay detector. */
    lastRequestKey: text("last_request_key").notNull(),
    /** The provider's own conclusion, latest ask: closed set, money follows it. */
    providerCancelResult: text("provider_cancel_result")
      .$type<
        | "succeeded_unbilled_evidenced"
        | "succeeded_no_evidence"
        | "unsupported"
        | "failed"
        | "result_unknown"
      >()
      .notNull(),
    /** The evidence kind an evidenced cancel released on (Release protocol's own). */
    evidenceKind: text("evidence_kind"),
    /** The verifiable trail id — the provider's cancellation receipt. */
    evidenceReference: text("evidence_reference"),
    /** The money reaction: released on evidence, kept held, or moved to unknown. */
    conclusion: text("conclusion")
      .$type<"released_on_evidence" | "hold_kept" | "hold_unknown">()
      .notNull(),
    /** What the Release protocol handed back; null unless released_on_evidence. */
    releasedCredits: integer("released_credits"),
    /** Every cancel request, replays included — the retry storm as a count. */
    requests: integer("requests").notNull().default(1),
    firstRequestedAt: timestamp("first_requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "async_job_cancel_result_check",
      sql`${table.providerCancelResult} IN ('succeeded_unbilled_evidenced', 'succeeded_no_evidence', 'unsupported', 'failed', 'result_unknown')`,
    ),
    check(
      "async_job_cancel_evidence_shape_check",
      sql`(${table.providerCancelResult} = 'succeeded_unbilled_evidenced' AND ${table.evidenceKind} IS NOT NULL AND ${table.evidenceReference} IS NOT NULL) OR (${table.providerCancelResult} <> 'succeeded_unbilled_evidenced' AND ${table.evidenceKind} IS NULL AND ${table.evidenceReference} IS NULL)`,
    ),
    check(
      "async_job_cancel_conclusion_check",
      sql`${table.conclusion} IN ('released_on_evidence', 'hold_kept', 'hold_unknown')`,
    ),
    check(
      "async_job_cancel_released_shape_check",
      sql`(${table.conclusion} = 'released_on_evidence' AND ${table.releasedCredits} IS NOT NULL AND ${table.releasedCredits} >= 0) OR (${table.conclusion} <> 'released_on_evidence' AND ${table.releasedCredits} IS NULL)`,
    ),
    check("async_job_cancel_requests_check", sql`${table.requests} >= 1`),
    // The operational read: recently cancelled jobs, newest first.
    index("async_job_cancel_last_idx").on(table.lastSeenAt),
  ],
);

/**
 * One established realtime session (Bifrost 15.1, #314): the durable identity a WebSocket
 * or WebRTC session is born under — the grant, the payer the door RESOLVED server-side,
 * the model cell and BOTH locked versions, frozen at establishment so the session's
 * attribution and price basis cannot drift mid-flight (会话期间身份与账务基准固定不变).
 * Disconnection or restart loses nothing: the row is the recovery input 15.8 restores
 * from, and 15.2's billing units attribute to the same account this row names. The row
 * carries no reservation — a session's money moves per unit, not per session, and the
 * establishment path itself holds, charges and dispatches nothing.
 */
export const realtimeSessions = pgTable(
  "realtime_sessions",
  {
    /** `rs-` plus random bytes, minted at establishment. */
    sessionId: text("session_id").primaryKey(),
    /** The authorization the session runs under; attribution never re-resolves. */
    grantId: text("grant_id")
      .notNull()
      .references(() => accessGrants.grantId),
    /** The payer the establishment door resolved, copied at creation. */
    payerKind: text("payer_kind").notNull(),
    payerId: text("payer_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    capability: text("capability").notNull(),
    snapshotVersion: integer("snapshot_version").notNull(),
    rateVersion: integer("rate_version").notNull(),
    /** `open` until 15.6's revocation/expiry stop closes it. */
    state: text("state")
      .$type<"open" | "closed">()
      .notNull()
      .default("open"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * 15.5's stop: when balance exhaustion stopped this session's later units, and the
     * door's own refusal code that did it. Stop is not close — the row stays `open`.
     */
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    stopReason: text("stop_reason"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: text("close_reason"),
  },
  (table) => [
    check(
      "realtime_sessions_capability_check",
      sql`${table.capability} = 'realtime'`,
    ),
    check(
      "realtime_sessions_payer_kind_check",
      sql`${table.payerKind} IN ('personal', 'company', 'legacy_deployment', 'unknown_owner')`,
    ),
    check(
      "realtime_sessions_state_check",
      sql`${table.state} IN ('open', 'closed')`,
    ),
    check(
      "realtime_sessions_version_check",
      sql`${table.snapshotVersion} >= 1 AND ${table.rateVersion} >= 0`,
    ),
    check(
      "realtime_sessions_stopped_shape_check",
      sql`(${table.stoppedAt} IS NULL AND ${table.stopReason} IS NULL) OR (${table.stoppedAt} IS NOT NULL AND ${table.stopReason} IS NOT NULL)`,
    ),
    check(
      "realtime_sessions_closed_shape_check",
      sql`(${table.state} = 'open' AND ${table.closedAt} IS NULL AND ${table.closeReason} IS NULL) OR (${table.state} = 'closed' AND ${table.closedAt} IS NOT NULL)`,
    ),
    // Recovery and the user's session list read by grant, newest first.
    index("realtime_sessions_grant_idx").on(table.grantId, table.startedAt),
    // 15.8's person-facing read: the payer's own sessions, newest first (0206).
    index("realtime_sessions_payer_idx").on(
      table.payerKind,
      table.payerId,
      table.startedAt,
    ),
  ],
);

/**
 * One realtime billing unit (Bifrost 15.2, #315): the independently reserved, independently
 * attempt-identified segment a realtime session's money moves in — the durable counterpart of
 * the ticket's RealtimeUnit contract {unitId, sessionId, attemptId, reservationId, kind,
 * boundCents}. The unit's admission facts (grant, payer, model cell, both locked versions)
 * are NOT copied here: they live frozen on the unit's {@link realtimeSessions} row, and the
 * unit's reserve composes 06.3's transactional door OVER that frozen identity, so a unit can
 * never re-resolve what its session already fixed (会话期间身份与账务基准固定不变).
 *
 * THE STATE MACHINE IS THE CLOSED SET the ticket pins — pending → reserved → processing →
 * settled | unknown | refused — and the shape CHECK keeps every state honest about its
 * companions: the reserved family carries the attempt and reservation the door answered,
 * `refused` carries the door's own reason code and NO reservation (the row is the recorded
 * evidence that no provider input could be billed to this unit), and `pending` — which only
 * exists inside the open transaction, the unit insert and the reserve outcome committing as
 * one fact — carries neither. `(session_id, unit_key)` is UNIQUE: one unit per key, ever, so
 * a replayed open converges on the original row and its original answer (结算重放不重扣).
 */
export const realtimeUnits = pgTable(
  "realtime_units",
  {
    /** `ru-` plus random bytes, minted by the unit door. */
    unitId: text("unit_id").primaryKey(),
    /** The session whose frozen identity this unit reserves under. */
    sessionId: text("session_id")
      .notNull()
      .references(() => realtimeSessions.sessionId),
    /** The caller's stable unit identity; one unit per (session, key), ever. */
    unitKey: text("unit_key").notNull(),
    /** Which side of the session's money this unit covers. */
    kind: text("kind")
      .$type<"input_audio" | "output_audio" | "response" | "duration">()
      .notNull(),
    /** The certified hold ceiling in scaled credit units (×100). */
    boundCents: integer("bound_cents").notNull(),
    state: text("state")
      .$type<
        | "pending"
        | "reserved"
        | "processing"
        | "settled"
        | "unknown"
        | "refused"
      >()
      .notNull()
      .default("pending"),
    /** The unit's attempt identity (06.7's `att-` mapping of the reservation). */
    attemptId: text("attempt_id"),
    /** The hold this unit reserved; absent exactly when no hold ever formed. */
    reservationId: text("reservation_id").references(() => creditReservations.id),
    /** The 06.3 door's own refusal code, recorded on the refused unit. */
    refusalReason: text("refusal_reason"),
    /**
     * 15.6's shutdown tail: why a holding unit became `unknown` — the shutdown that could
     * not confirm it (`shutdown_tail_unconfirmed`) or, from 15.7, a tail whose exact cost
     * exceeds the unit's bound (`tail_exceeds_bound`). Present exactly when state is
     * `unknown`.
     */
    unknownReason: text("unknown_reason"),
    /** 15.7's settled tail: when the unit's hold settled through 06.9 — present exactly when state is `settled`. */
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    stateUpdatedAt: timestamp("state_updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "realtime_units_settled_shape_check",
      sql`(${table.state} = 'settled' AND ${table.settledAt} IS NOT NULL AND ${table.unknownReason} IS NULL) OR (${table.state} <> 'settled' AND ${table.settledAt} IS NULL)`,
    ),
    check(
      "realtime_units_unknown_reason_shape_check",
      sql`(${table.state} = 'unknown' AND ${table.unknownReason} IS NOT NULL) OR (${table.state} <> 'unknown' AND ${table.unknownReason} IS NULL)`,
    ),
    check(
      "realtime_units_state_shape_check",
      sql`(${table.state} = 'pending' AND ${table.attemptId} IS NULL AND ${table.reservationId} IS NULL AND ${table.refusalReason} IS NULL) OR (${table.state} IN ('reserved', 'processing', 'settled', 'unknown') AND ${table.attemptId} IS NOT NULL AND ${table.reservationId} IS NOT NULL AND ${table.refusalReason} IS NULL) OR (${table.state} = 'refused' AND ${table.attemptId} IS NULL AND ${table.reservationId} IS NULL AND ${table.refusalReason} IS NOT NULL)`,
    ),
    // One unit per (session, key), ever — the replay's convergence point.
    uniqueIndex("realtime_units_session_key_idx").on(
      table.sessionId,
      table.unitKey,
    ),
    // One attempt identity names at most one unit, wherever present.
    uniqueIndex("realtime_units_attempt_idx")
      .on(table.attemptId)
      .where(sql`${table.attemptId} IS NOT NULL`),
    // The recovery and user reads walk a session's units oldest first.
    index("realtime_units_session_created_idx").on(
      table.sessionId,
      table.createdAt,
    ),
  ],
);

/**
 * One settlement's per-dimension split (Bifrost 20.3, #343): the integer share of a ledger
 * row's credits each billing dimension accounts for, written only inside the credit
 * writer's settle transaction with the write-time invariant that the rows sum to exactly
 * the row they explain. The consumption view groups them — `surcharge_*` dimensions are
 * the surcharge side, everything else the model side — so the two-level attribution
 * reconciles with the ledger by construction. Tool/routing surcharge dimensions join this
 * same table when 20.1's mapping lands (#341); nothing here pre-names them.
 */
export const creditSettlementDimensionBreakdown = pgTable(
  "credit_settlement_dimension_breakdown",
  {
    ledgerId: text("ledger_id")
      .primaryKey()
      .references(() => creditLedger.id, { onDelete: "cascade" }),
    dimension: text("dimension").primaryKey(),
    /** The dimension's whole scaled units of this ledger row (≥ 0; Σ units = the row). */
    units: integer("units").notNull(),
  },
  (table) => [
    check(
      "credit_settlement_dimension_breakdown_units_check",
      sql`${table.units} >= 0`,
    ),
  ],
);

/**
 * One row per REAL tool call — the tool execution's own billing identity (Bifrost 20.1,
 * #341). Every real tool call gets a local `tc-` charge id plus the caller's idempotency
 * key (a replay converges on the row its hold already minted), the entrance it arrived
 * through (the closed registry in `billing/tool-surcharge-pricing.ts` — MCP, injected,
 * responses, web search, A2A), the surcharge dimension it bills on, and the attribution
 * frozen at creation exactly the way `async_jobs` freezes its own. A charged row carries
 * its reservation's `att-` attempt id — the 07.x bijection — so tool fees and model fees
 * are distinguishable by construction: the dimension is always a `surcharge_*` member,
 * and the settlement breakdown's surcharge group says the same thing about the same call.
 *
 * `refused` rows never hold a reservation or an attempt — a refusal writes no money rows,
 * and the refusal reason plus the audit trail carry the attempt; a `charged` row holds the
 * reservation the call settled against, or carries `pricedFree` when the basis priced the
 * call exactly zero (free is a price, executable hold-free). The routing-attached
 * embedding call is deliberately not an entry: it bills on the attached model's own token
 * dimensions through the request's reservation.
 */
export const toolCallCharges = pgTable(
  "tool_call_charges",
  {
    /** The call's local identity, writer-minted — recognisable on sight, like `cr-`/`aj-`. */
    chargeId: text("charge_id").primaryKey(),
    /** The caller's durable request identity; a replay answers the existing row. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** The entrance id, from the closed tool-execution registry. */
    entry: text("entry").notNull(),
    /** What executed: the `<client>-<tool>` pattern, the search tool, or the agent name. */
    tool: text("tool").notNull(),
    /** The surcharge dimension this call bills on (never a model dimension). */
    dimension: text("dimension").notNull(),
    /** The authorization the call ran under — frozen, like every attribution fact here. */
    grantId: text("grant_id")
      .notNull()
      .references(() => accessGrants.grantId),
    /** The resolved payer the attribution froze at creation, never the request's spelling. */
    payerKind: text("payer_kind").notNull(),
    payerId: text("payer_id").notNull(),
    /** The admission's own outcome: charged (with its hold, or priced exactly free) or refused. */
    state: text("state")
      .$type<"charged" | "refused">()
      .notNull(),
    /** The reservation this call's hold minted; absent exactly when no hold formed. */
    reservationId: text("reservation_id").references(
      () => creditReservations.id,
    ),
    /** True when the basis priced the call exactly zero — charged, hold-free. */
    pricedFree: boolean("priced_free").notNull().default(false),
    /** The admission's own refusal code, recorded on the refused row. */
    refusalReason: text("refusal_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("tool_call_charges_idempotency_key_unique_idx").on(
      table.idempotencyKey,
    ),
    check(
      "tool_call_charges_entry_check",
      sql`${table.entry} IN ('mcp.tool_call', 'injected.tool_call', 'injected.web_search', 'responses.tool_call', 'a2a.call')`,
    ),
    check(
      "tool_call_charges_dimension_check",
      sql`${table.dimension} IN ('surcharge_web_search', 'surcharge_tool_call', 'surcharge_a2a_call')`,
    ),
    check(
      "tool_call_charges_payer_kind_check",
      sql`${table.payerKind} IN ('personal', 'company', 'legacy_deployment', 'unknown_owner')`,
    ),
    check(
      "tool_call_charges_state_check",
      sql`${table.state} IN ('charged', 'refused')`,
    ),
    check(
      "tool_call_charges_state_shape_check",
      sql`(${table.state} = 'charged' AND ${table.refusalReason} IS NULL AND (${table.reservationId} IS NOT NULL OR ${table.pricedFree} = true)) OR (${table.state} = 'refused' AND ${table.reservationId} IS NULL AND ${table.refusalReason} IS NOT NULL AND ${table.pricedFree} = false)`,
    ),
    // The user view and the sweep walk a grant's calls oldest first.
    index("tool_call_charges_grant_idx").on(
      table.grantId,
      table.createdAt,
    ),
    // One charge per reservation: a hold mints exactly one tool-call identity.
    uniqueIndex("tool_call_charges_reservation_idx")
      .on(table.reservationId)
      .where(sql`${table.reservationId} IS NOT NULL`),
  ],
);

/**
 * One accepted batch submit's durable parent identity (Bifrost 18.1, #333): the local
 * `bj-` batch identity a replayed submit converges on (the submit idempotency key is
 * UNIQUE), with the attribution facts — grant, resolved payer, locked versions — fixed at
 * creation, and the ONE whole-batch reservation the submit held BEFORE any provider
 * dispatch. The cap is every item's worst-case exact cost summed across the items' own
 * model cells with a single upward rounding at the end; it is fixed at creation, so there
 * is no reservation that can follow it ("不允许部分派发后再追加预留" is a structural
 * property, not a checked rule).
 *
 * The batch carries no model cell of its own: its items' models (and unit prices) differ,
 * so the pricing basis is the PAIR (batch versions × each item's cell) on the child rows.
 * The reservation's own basis lock names the batch's anchor cell — the first distinct cell
 * admitted — which is a true resolvable basis but NOT the batch's price basis; batch
 * settlement prices from the child rows, never from the hold's lock.
 *
 * `providerBatchId` is nullable on purpose (the async family's 17.3 lane): "not yet known"
 * is a state the row holds while the reservation stays occupied at its FULL cap, moved to
 * `unknown` the moment the dispatch answer is known lost.
 */
export const batchJobs = pgTable(
  "batch_jobs",
  {
    /** `bj-` plus random bytes, minted by the submit path. */
    batchId: text("batch_id").primaryKey(),
    /** The submit request's stable identity; one submit is one batch, ever. */
    submitIdempotencyKey: text("submit_idempotency_key").notNull(),
    /** The authorization the submit ran under; attribution never re-resolves. */
    grantId: text("grant_id")
      .notNull()
      .references(() => accessGrants.grantId),
    /** The payer the reservation billed, copied at creation (the resolved account). */
    payerKind: text("payer_kind").notNull(),
    payerId: text("payer_id").notNull(),
    /** The batch's locked versions — the version half of every item's price basis. */
    snapshotVersion: integer("snapshot_version").notNull(),
    rateVersion: integer("rate_version").notNull(),
    /** The provider's batch id when its answer arrived; null when lost (17.3's lane). */
    providerBatchId: text("provider_batch_id"),
    /** The whole-batch hold; an accepted submit always holds exactly one. */
    reservationId: text("reservation_id")
      .notNull()
      .references(() => creditReservations.id),
    /** Every item's worst-case exact cost, summed, ONE upward rounding. */
    maximumCredits: integer("maximum_credits").notNull(),
    /** How many child items the cap conversion covered. */
    itemCount: integer("item_count").notNull(),
    /** Dispatch's own outcome; the money's states live on the reservation. The terminal
     * members (18.3) are reachable only after the batch's settlement committed — the
     * dispatch-shape CHECK pins them to a provider id and a settled_at. */
    state: text("state")
      .$type<
        | "submitted"
        | "dispatch_unconfirmed"
        | "partial"
        | "completed"
        | "failed"
        | "cancelled"
      >()
      .notNull()
      .default("dispatch_unconfirmed"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    /** The per-class outcome counts (18.3, cancelled 18.4) — the status view's members. */
    completedCount: integer("completed_count").notNull().default(0),
    failedBillableCount: integer("failed_billable_count").notNull().default(0),
    releasedCount: integer("released_count").notNull().default(0),
    unknownCount: integer("unknown_count").notNull().default(0),
    cancelledCount: integer("cancelled_count").notNull().default(0),
    /** When the batch's ONE settlement committed (null until then). */
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("batch_jobs_submit_idempotency_key_unique_idx").on(
      table.submitIdempotencyKey,
    ),
    check(
      "batch_jobs_payer_kind_check",
      sql`${table.payerKind} IN ('personal', 'company', 'legacy_deployment', 'unknown_owner')`,
    ),
    check(
      "batch_jobs_version_check",
      sql`${table.snapshotVersion} >= 1 AND ${table.rateVersion} >= 0`,
    ),
    check("batch_jobs_maximum_check", sql`${table.maximumCredits} > 0`),
    check("batch_jobs_item_count_check", sql`${table.itemCount} > 0`),
    check(
      "batch_jobs_state_check",
      sql`${table.state} IN ('submitted', 'dispatch_unconfirmed', 'partial', 'completed', 'failed', 'cancelled')`,
    ),
    check(
      "batch_jobs_dispatch_shape_check",
      sql`(${table.state} = 'submitted' AND ${table.providerBatchId} IS NOT NULL AND ${table.dispatchedAt} IS NOT NULL) OR (${table.state} = 'dispatch_unconfirmed' AND ${table.providerBatchId} IS NULL) OR (${table.state} IN ('partial', 'completed', 'failed', 'cancelled') AND ${table.providerBatchId} IS NOT NULL AND ${table.settledAt} IS NOT NULL)`,
    ),
    check(
      "batch_jobs_counts_check",
      sql`${table.completedCount} >= 0 AND ${table.failedBillableCount} >= 0 AND ${table.releasedCount} >= 0 AND ${table.unknownCount} >= 0 AND ${table.cancelledCount} >= 0`,
    ),
    // The recovery sweep and the status reads arrive by grant and by provider batch id.
    index("batch_jobs_grant_idx").on(table.grantId, table.createdAt),
    uniqueIndex("batch_jobs_provider_batch_id_idx").on(table.providerBatchId),
  ],
);

/**
 * One batch item's durable child identity (Bifrost 18.1, #333): the item's own `bi-`
 * identity, the caller's `custom_id` (UNIQUE per batch — the key the provider's per-item
 * results come back keyed by, so a result maps to exactly one item), the item's OWN model
 * cell (items of one batch may price differently — the cap conversion priced each on its
 * own cell), and the item's certified worst-case quantities frozen at submit (the
 * input-side evidence the cap was certified from). The child carries no money and no payer
 * of its own: its attribution IS the parent's — one payer, one hold, by construction.
 */
export const batchItems = pgTable(
  "batch_items",
  {
    /** `bi-` plus random bytes, minted by the submit path. */
    itemId: text("item_id").primaryKey(),
    batchId: text("batch_id")
      .notNull()
      .references(() => batchJobs.batchId),
    /** The item's position in the submit's items array — the stable walk order. */
    itemIndex: integer("item_index").notNull(),
    /** The caller's per-item identity; the provider's results arrive keyed by this. */
    customId: text("custom_id").notNull(),
    /** The item's own model cell — the cell half of its price basis. */
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    capability: text("capability").notNull(),
    /** The item's certified worst-case quantities, one whole number per used dimension. */
    quantities: jsonb("quantities")
      .$type<Record<string, number>>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("batch_items_index_check", sql`${table.itemIndex} >= 0`),
    check(
      "batch_items_custom_id_check",
      sql`length(${table.customId}) > 0 AND length(${table.customId}) <= 512`,
    ),
    check(
      "batch_items_capability_check",
      sql`${table.capability} IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown')`,
    ),
    check(
      "batch_items_quantities_shape_check",
      sql`jsonb_typeof(${table.quantities}) = 'object'`,
    ),
    uniqueIndex("batch_items_batch_index_unique_idx").on(
      table.batchId,
      table.itemIndex,
    ),
    uniqueIndex("batch_items_custom_id_unique_idx").on(
      table.batchId,
      table.customId,
    ),
    // The result lane joins by custom id inside one batch; the item walk joins by parent.
    index("batch_items_batch_idx").on(table.batchId, table.itemIndex),
  ],
);

/**
 * The batch settlement's per-item line details (Bifrost 18.2, #334): one row per item,
 * written inside the credit writer's settle transaction beside the ONE aggregated ledger
 * row of the batch's settlement — so the charge is attributable at both levels: the batch
 * (the ledger row, named by `requestId` = batchId) and every item (its own line here, the
 * same `ledgerId`). The rows of one settlement share one ledger id and their exact costs
 * sum to that row's actual cost (the writer asserts it at write time). The MONEY stays on
 * the ledger row; `exactCost` is the item's exact rational share — a traceable entry, not
 * a second ledger.
 */
export const creditBatchSettlementDetails = pgTable(
  "credit_batch_settlement_details",
  {
    /** The item the line names — the per-item attribution anchor, one line per item. */
    itemId: text("item_id")
      .primaryKey()
      .references(() => batchItems.itemId),
    /** The batch the item belongs to — the batch-level attribution join. */
    batchId: text("batch_id")
      .notNull()
      .references(() => batchJobs.batchId),
    /** The ONE ledger row of the batch's settlement this line shares. */
    ledgerId: text("ledger_id")
      .notNull()
      .references(() => creditLedger.id),
    /** The item's own model cell — the cell its usage was priced on. */
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    capability: text("capability").notNull(),
    /** The caller's per-item identity — the human-readable attribution key. */
    customId: text("custom_id").notNull(),
    /** The item's own terminal state (completed/failed/cancelled — items may differ). */
    terminalState: text("terminal_state")
      .$type<"completed" | "failed" | "cancelled">()
      .notNull(),
    /** The provider's real per-item usage, one whole number per used dimension. */
    actualUsage: jsonb("actual_usage").$type<Record<string, number>>().notNull(),
    /** The item's exact rational share of the settlement, decimal strings in jsonb. */
    exactCost: jsonb("exact_cost")
      .$type<{ numerator: string; denominator: string }>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "credit_batch_settlement_details_capability_check",
      sql`${table.capability} IN ('chat', 'embedding', 'image', 'speech', 'transcription', 'rerank', 'realtime', 'video', 'unknown')`,
    ),
    check(
      "credit_batch_settlement_details_terminal_state_check",
      sql`${table.terminalState} IN ('completed', 'failed', 'cancelled')`,
    ),
    check(
      "credit_batch_settlement_details_custom_id_check",
      sql`length(${table.customId}) > 0`,
    ),
    check(
      "credit_batch_settlement_details_usage_shape_check",
      sql`jsonb_typeof(${table.actualUsage}) = 'object'`,
    ),
    check(
      "credit_batch_settlement_details_cost_shape_check",
      sql`jsonb_typeof(${table.exactCost}) = 'object' AND jsonb_typeof(${table.exactCost}->'numerator') = 'string' AND jsonb_typeof(${table.exactCost}->'denominator') = 'string'`,
    ),
    // The batch-level attribution read; the ledger join for the consumption view.
    index("credit_batch_settlement_details_batch_idx").on(table.batchId),
    index("credit_batch_settlement_details_ledger_idx").on(table.ledgerId),
  ],
);

/**
 * One batch item's reported disposition (Bifrost 18.3, #335): the classification the
 * partial lane derives from the provider's per-item reports — the closed four-class
 * vocabulary the ticket names — with the provider's own terminal word, the release
 * evidence (present exactly when the item released: `not_dispatched` is the only member,
 * the provider's own accounting that the item never ran), the raw usage the item's
 * pricing consumed, and how many reports arrived for the item (a duplicate is a count,
 * never a second charge). NO money lives here: the classification and its counts are
 * observability; the ledger is one, and it is not this table.
 */
export const batchItemOutcomes = pgTable(
  "batch_item_outcomes",
  {
    /** The item the disposition names — one outcome row per item, ever. */
    itemId: text("item_id")
      .primaryKey()
      .references(() => batchItems.itemId),
    batchId: text("batch_id")
      .notNull()
      .references(() => batchJobs.batchId),
    /** The caller's per-item identity — the human-readable correlation key. */
    customId: text("custom_id").notNull(),
    /** The closed classification vocabulary: completed / failed_billable /
     * not_dispatched / unknown / cancelled (18.4 — the cancelled row carries usage when
     * the item was billed for what ran, or `cancelled_unbilled` evidence when it was
     * not; never neither, never both). */
    classification: text("classification")
      .$type<
        | "completed"
        | "failed_billable"
        | "not_dispatched"
        | "unknown"
        | "cancelled"
      >()
      .notNull(),
    /** The provider's own terminal word for the item (null for non-terminal classes). */
    terminalState: text("terminal_state")
      .$type<"completed" | "failed" | "cancelled">(),
    /** The no-charge evidence — present exactly when the classification released. */
    evidence: jsonb("evidence")
      .$type<{ kind: string; reference?: string }>(),
    /** The raw per-item usage the item's pricing consumed (billable classes only). */
    usage: jsonb("usage").$type<Record<string, number>>(),
    /** How many reports arrived for this item — the duplicate-notification observability. */
    reports: integer("reports").notNull().default(1),
    firstReportedAt: timestamp("first_reported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastReportedAt: timestamp("last_reported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "batch_item_outcomes_classification_check",
      sql`${table.classification} IN ('completed', 'failed_billable', 'not_dispatched', 'unknown', 'cancelled')`,
    ),
    check(
      "batch_item_outcomes_terminal_state_check",
      sql`${table.terminalState} IS NULL OR ${table.terminalState} IN ('completed', 'failed', 'cancelled')`,
    ),
    check("batch_item_outcomes_reports_check", sql`${table.reports} >= 1`),
    check(
      "batch_item_outcomes_shape_check",
      sql`((${table.classification} IN ('completed', 'failed_billable') AND ${table.terminalState} IS NOT NULL AND ${table.usage} IS NOT NULL) OR (${table.classification} = 'not_dispatched' AND ${table.evidence} IS NOT NULL) OR (${table.classification} = 'cancelled' AND ((${table.terminalState} IS NOT NULL AND ${table.usage} IS NOT NULL) OR ${table.evidence} IS NOT NULL)) OR (${table.classification} = 'unknown'))`,
    ),
    index("batch_item_outcomes_batch_idx").on(table.batchId, table.customId),
  ],
);
