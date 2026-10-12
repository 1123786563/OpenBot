import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { billingCustomers } from "../db/schema/billing";
import {
  creditChargeRemainders,
  creditReservationAllocations,
  creditReservations,
} from "../db/schema/credit-reservations";
import { creditGrants, creditLedger as ledger } from "../db/schema/credits";
import type { CreditGrantSource } from "./types";

/**
 * The local credit ledger's WRITE side — both halves. The deposit (grantCredits) is the only
 * writer `credit_grants` has ever had; the withdrawal (consumeCredits) is the only writer that
 * moves `used` or writes `credit_ledger`, so every invariant about the ledger is decided here,
 * once. The reads live in ./credits.ts and stay untouched.
 *
 * Discipline carried over from the payments module: credits stay integers scaled by
 * `CREDIT_SCALE` (×100) from input to storage — a grant of "23.63 credits" is the integer 2363
 * and never a binary float — timestamps are timestamptz, and failures answer with the billing
 * seam's sentinel codes rather than raw messages.
 *
 * Idempotency (both halves): every grant AND every draw carries an idempotency key, and the
 * unique indexes on `credit_grants.idempotency_key` / `credit_ledger.idempotency_key` are the
 * authorities — the insert-or-nothing against them turns a retry into a read of the row that
 * already exists. A caller with no natural key (an operator pressing the promo button, where
 * two presses MEAN two grants) gets a random one derived here, which keeps the insert
 * always-fresh while holding the columns NOT NULL — that is what lets both indexes be plain
 * unique, so ON CONFLICT can infer them (Postgres cannot infer a partial index without its
 * WHERE spelled in-statement).
 *
 * A grant row is born `active` and is never status-flipped afterwards: the read side derives
 * `exhausted`/`expired` from the clock and the balance (credits.ts `deriveGrantStatus`), so the
 * stored `status` is the birth certificate, not a second truth to maintain.
 */

/** One grant row, as the writer answers it: the stored row's facts, ISO times. */
export type CreditGrantResult = {
  id: string;
  externalCustomerId: string;
  source: CreditGrantSource;
  reason: string | null;
  total: number;
  used: number;
  grantedAt: string;
  expiresAt: string;
};

/** A `cg-` grant id: 8 random bytes as hex, the same draw size the payment order ids use. */
function generateGrantId(): string {
  return `cg-${randomBytes(8).toString("hex")}`;
}

/** Largest value a 32-bit PostgreSQL integer column can hold. */
const MAX_STORED_UNITS = 2_147_483_647;
/** Bounds the lowest-terms denominator a customer's carried remainder may reach. */
const MAX_REMAINDER_DENOMINATOR = 10n ** 60n;

/** An exact non-negative rational, in scaled credit units (×100). */
export type CreditAmount = { numerator: bigint; denominator: bigint };

export type CreditReservationState = "reserved" | "settled" | "released";

/** A reservation call that conflicts with the reservation's recorded identity or terminal state. */
export class CreditReservationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditReservationConflictError";
  }
}

export type CreditSettlementResult = {
  /** Whole units charged (the exact cost plus the carried remainder, floored). */
  chargedCents: number;
  /** What the grants absorbed of the charge; the hold caps it. */
  appliedCents: number;
  /** Held capacity handed back unused. */
  releasedCents: number;
  /** The fraction of a unit still owed after this settlement, in lowest terms. */
  remainder: CreditAmount;
};

export type CreditWriter = {
  /**
   * Record one deposit. `totalCents` is scaled credit units (×100) already — the caller derived
   * it from the catalog's whole-credit number times `CREDIT_SCALE`; integers end to end.
   *
   * `inserted: false` means a grant with the same `idempotencyKey` already exists — the retry
   * answer, not an error — and carries the existing row so the caller (and its audit trail) can
   * say which one it was.
   */
  grantCredits(input: {
    externalCustomerId: string;
    source: CreditGrantSource;
    /** Scaled units (×100). Must be a whole, non-negative integer. */
    totalCents: number;
    expiresAt: Date;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<{ inserted: boolean; grant: CreditGrantResult }>;

  /**
   * The live balance, in scaled units (×100): the sum over this customer's grants of
   * `max(total - used, 0)` where the grant has not lapsed. The pre-call gate reads this; the
   * consumption itself never does (its own transaction re-derives inside the row updates).
   */
  readBalance(externalCustomerId: string): Promise<number>;

  /**
   * The capacity a new hold could take now: live grant capacity minus every active hold, and one
   * unit while a fractional remainder is owed (the owed fraction keeps counting against capacity).
   */
  availableBalance(externalCustomerId: string): Promise<number>;

  /**
   * Hold `maximumCents` (scaled units, a positive 32-bit integer) across the customer's live
   * grants, earliest expiry first, atomically with respect to every other hold and settlement of
   * the customer. A replay of `idempotencyKey` answers the original reservation; a replay with a
   * different customer or amount throws `CreditReservationConflictError`. A refused hold writes
   * nothing and reports what was available.
   */
  reserveCredits(input: {
    externalCustomerId: string;
    idempotencyKey: string;
    maximumCents: number;
    expiresAt: Date;
  }): Promise<
    | { reserved: true; reservationId: string }
    | { reserved: false; availableCents: number }
  >;

  /**
   * Convert a hold into a charge. `actual` is the exact rational cost in scaled units; the
   * customer's carried remainder is added, the whole-unit floor is drawn from the held grants
   * (written once to `credit_ledger`), and the new fraction is persisted. Unused hold is
   * released. Replaying the same actual returns the first result; a different actual, or settling
   * a released hold, throws `CreditReservationConflictError`. Cost above the hold is recorded in
   * the ledger in full but only the held capacity is applied.
   */
  settleReservation(input: {
    reservationId: string;
    actual: CreditAmount;
    title: string;
    requestId?: string | null;
    model?: string | null;
    client?: string | null;
  }): Promise<CreditSettlementResult>;

  /**
   * Hand a still-`reserved` hold back, unused. Idempotent: releasing a released or settled hold
   * changes nothing (the first terminal result stands).
   */
  releaseReservation(reservationId: string, reason: string): Promise<void>;

  /**
   * Record one withdrawal, drawn across the customer's live grants.
   *
   * POST-PAID semantics: the amount is what the call ACTUALLY cost (tokens ×100, decided after
   * the model answered), and the ledger row always records it in full — the ledger is the truth
   * about what was consumed. The grants only ever absorb what they can: if the balance was
   * smaller than the cost (the pre-call gate missed, or a concurrent call drained it between
   * gate and finish), the grants are drawn to zero and `applied < amountCents` reports the
   * shortfall — the account reads as overdrawn-but-honest rather than quietly rounded down.
   *
   * Idempotent on `idempotencyKey`: a retried report of the same consumption is the FIRST
   * report's answer (`inserted: false`), never a second deduction — the unique index on
   * `credit_ledger.idempotency_key` is the authority, claimed inside the transaction before any
   * grant moves.
   *
   * `insufficient` is NOT this method's answer: a zero-balance draw is still recorded (a free
   * deployment's calls are real consumption facts). The pre-call gate (readBalance + the model
   * wrapper copilot.ts wires) is where "no credits" refuses the call.
   */
  consumeCredits(input: {
    externalCustomerId: string;
    /** Scaled units (×100). The actual cost; may exceed the balance (see above). */
    amountCents: number;
    /** The consumption's stable id — the same id the Lago meter reports under, when it does. */
    idempotencyKey: string;
    /** The consumption table's two lines. */
    title: string;
    requestId?: string | null;
    model?: string | null;
    client?: string | null;
  }): Promise<{
    inserted: boolean;
    /** How much the grants actually absorbed; < amountCents when the balance came up short. */
    applied: number;
    /** The balance after this draw, before any concurrent one. */
    remaining: number;
  }>;
};

export function createCreditWriter(database: Database): CreditWriter {
  return {
    async grantCredits(input) {
      // Integer discipline enforced at the seam: a fractional or negative amount is a caller's
      // bug, and storing it rounded would silently corrupt the ledger it lands in.
      if (
        !Number.isInteger(input.totalCents) ||
        input.totalCents < 0 ||
        !Number.isFinite(input.expiresAt.getTime())
      ) {
        throw new TypeError(
          "grantCredits needs a whole non-negative scaled amount and a real expiry.",
        );
      }

      // The customer floor, the same insert-if-absent the billing store lays under a subscription:
      // a payment activation can be the first thing that ever names this deployment's customer
      // key locally, and the grant's foreign key must not be the thing that discovers that.
      await database
        .insert(billingCustomers)
        .values({ externalId: input.externalCustomerId, name: null })
        .onConflictDoNothing({ target: billingCustomers.externalId });

      // No natural key → a random one: two admin presses are two grants (a decision), and the
      // column stays NOT NULL so the unique index stays inferable by ON CONFLICT.
      const idempotencyKey =
        input.idempotencyKey ?? `auto:${randomBytes(12).toString("hex")}`;

      const rows = await database
        .insert(creditGrants)
        .values({
          id: generateGrantId(),
          externalCustomerId: input.externalCustomerId,
          source: input.source,
          reason: input.reason ?? null,
          total: input.totalCents,
          used: 0,
          expiresAt: input.expiresAt,
          status: "active",
          idempotencyKey,
        })
        .onConflictDoNothing({
          target: creditGrants.idempotencyKey,
        })
        .returning();

      const row = rows[0];
      if (row) return { inserted: true, grant: resultOf(row) };

      // The occurrence already exists. Re-read by the key — the same committed-state answer the
      // paid-fact replay gets in the payment store, never a read that can race with itself.
      const [existing] = await database
        .select()
        .from(creditGrants)
        .where(eq(creditGrants.idempotencyKey, idempotencyKey))
        .limit(1);
      // A conflict with no findable row means the key raced a concurrent insert of a DIFFERENT
      // grant — impossible under the index, but a missing row here would be a silent no-op, so
      // say it loudly instead.
      if (!existing) {
        throw new TypeError(
          "grantCredits: the idempotency key conflicted but no existing grant was found.",
        );
      }
      return { inserted: false, grant: resultOf(existing) };
    },

    async readBalance(externalCustomerId) {
      // The live grants only: an expired or exhausted row contributes nothing, the same
      // liveness the read side (credits.ts deriveGrantStatus) spells. Floored per-grant in the
      // sum so a data bug (used > total, impossible under the check constraint) cannot mint
      // balance out of a negative.
      const rows = await database
        .select({ total: creditGrants.total, used: creditGrants.used })
        .from(creditGrants)
        .where(
          and(
            eq(creditGrants.externalCustomerId, externalCustomerId),
            gt(creditGrants.expiresAt, new Date()),
          ),
        );
      let balance = 0;
      for (const row of rows) {
        balance += Math.max(row.total - row.used, 0);
      }
      return balance;
    },

    async availableBalance(externalCustomerId) {
      return availableOf(database, externalCustomerId);
    },

    async reserveCredits(input) {
      if (
        !Number.isInteger(input.maximumCents) ||
        input.maximumCents <= 0 ||
        input.maximumCents > MAX_STORED_UNITS ||
        !Number.isFinite(input.expiresAt.getTime()) ||
        input.idempotencyKey.length === 0
      ) {
        throw new TypeError(
          "reserveCredits needs a positive 32-bit scaled amount, a real expiry and a key.",
        );
      }
      await ensureCustomer(database, input.externalCustomerId);

      return database.transaction(async (tx) => {
        await lockCustomer(tx, input.externalCustomerId);

        const [existing] = await tx
          .select()
          .from(creditReservations)
          .where(eq(creditReservations.idempotencyKey, input.idempotencyKey))
          .limit(1);
        if (existing) {
          if (
            existing.externalCustomerId !== input.externalCustomerId ||
            existing.maximum !== input.maximumCents
          ) {
            throw new CreditReservationConflictError(
              "reserveCredits: the idempotency key belongs to a different reservation.",
            );
          }
          return { reserved: true as const, reservationId: existing.id };
        }

        const grants = await freeGrants(tx, input.externalCustomerId, true);
        const owed = await remainderOf(tx, input.externalCustomerId);
        const owedUnit = owed.numerator > 0n ? 1 : 0;
        const free = grants.reduce((sum, grant) => sum + grant.free, 0);
        const available = Math.max(free - owedUnit, 0);
        if (available < input.maximumCents) {
          return { reserved: false as const, availableCents: available };
        }

        const reservationId = `cr-${randomBytes(8).toString("hex")}`;
        await tx.insert(creditReservations).values({
          id: reservationId,
          externalCustomerId: input.externalCustomerId,
          idempotencyKey: input.idempotencyKey,
          maximum: input.maximumCents,
          expiresAt: input.expiresAt,
        });
        let toHold = input.maximumCents;
        for (const grant of grants) {
          if (toHold === 0) break;
          const amount = Math.min(grant.free, toHold);
          if (amount === 0) continue;
          await tx.insert(creditReservationAllocations).values({
            id: `cra-${randomBytes(8).toString("hex")}`,
            reservationId,
            grantId: grant.id,
            amount,
          });
          toHold -= amount;
        }
        return { reserved: true as const, reservationId };
      });
    },

    async settleReservation(input) {
      const { numerator, denominator } = input.actual;
      if (
        typeof numerator !== "bigint" ||
        typeof denominator !== "bigint" ||
        numerator < 0n ||
        denominator <= 0n ||
        denominator > MAX_REMAINDER_DENOMINATOR
      ) {
        throw new TypeError(
          "settleReservation needs a non-negative rational actual cost with a positive bounded denominator.",
        );
      }
      const actual = reduce(numerator, denominator);

      const [head] = await database
        .select({ customer: creditReservations.externalCustomerId })
        .from(creditReservations)
        .where(eq(creditReservations.id, input.reservationId))
        .limit(1);
      if (!head) {
        throw new CreditReservationConflictError(
          "settleReservation: no such reservation.",
        );
      }

      return database.transaction(async (tx) => {
        await lockCustomer(tx, head.customer);
        const [reservation] = await tx
          .select()
          .from(creditReservations)
          .where(eq(creditReservations.id, input.reservationId))
          .limit(1);
        if (!reservation) {
          throw new CreditReservationConflictError(
            "settleReservation: no such reservation.",
          );
        }
        if (reservation.status === "released") {
          throw new CreditReservationConflictError(
            "settleReservation: the reservation was already released.",
          );
        }
        if (reservation.status === "settled") {
          if (
            reservation.actualNumerator !== actual.numerator.toString() ||
            reservation.actualDenominator !== actual.denominator.toString()
          ) {
            throw new CreditReservationConflictError(
              "settleReservation: the reservation was settled with a different actual cost.",
            );
          }
          return settledResultOf(reservation);
        }

        const owed = await remainderOf(tx, reservation.externalCustomerId);
        const total = addAmounts(owed, actual);
        const whole = total.numerator / total.denominator;
        const fraction = reduce(
          total.numerator % total.denominator,
          total.denominator,
        );
        if (whole > BigInt(MAX_STORED_UNITS)) {
          throw new TypeError(
            "settleReservation: the charge exceeds the 32-bit credit storage limit.",
          );
        }
        const charged = Number(whole);

        const allocations = await tx
          .select({
            id: creditReservationAllocations.id,
            grantId: creditReservationAllocations.grantId,
            amount: creditReservationAllocations.amount,
          })
          .from(creditReservationAllocations)
          .innerJoin(
            creditGrants,
            eq(creditGrants.id, creditReservationAllocations.grantId),
          )
          .where(eq(creditReservationAllocations.reservationId, reservation.id))
          .orderBy(
            asc(creditGrants.expiresAt),
            asc(creditGrants.grantedAt),
            asc(creditGrants.id),
          )
          .for("update", { of: creditGrants });

        // A hold keeps its grants even if one lapsed since: the work was admitted while it was live.
        let toApply = Math.min(charged, reservation.maximum);
        let applied = 0;
        for (const allocation of allocations) {
          const drew = Math.min(toApply, allocation.amount);
          if (drew > 0) {
            await tx
              .update(creditGrants)
              .set({ used: sql`${creditGrants.used} + ${drew}` })
              .where(eq(creditGrants.id, allocation.grantId));
            await tx
              .update(creditReservationAllocations)
              .set({ consumed: drew })
              .where(eq(creditReservationAllocations.id, allocation.id));
          }
          applied += drew;
          toApply -= drew;
        }

        const ledgerId = `cl-${randomBytes(8).toString("hex")}`;
        await tx.insert(ledger).values({
          id: ledgerId,
          externalCustomerId: reservation.externalCustomerId,
          grantId: allocations.find((a) => a.amount > 0)?.grantId ?? null,
          title: input.title,
          requestId: input.requestId ?? null,
          idempotencyKey: `reservation:${reservation.id}`,
          credits: charged,
          applied,
          model: input.model ?? null,
          client: input.client ?? null,
        });

        const released = reservation.maximum - applied;
        await tx
          .update(creditReservations)
          .set({
            status: "settled",
            actualNumerator: actual.numerator.toString(),
            actualDenominator: actual.denominator.toString(),
            charged,
            applied,
            released,
            remainderNumerator: fraction.numerator.toString(),
            remainderDenominator: fraction.denominator.toString(),
            ledgerId,
            terminalAt: new Date(),
          })
          .where(eq(creditReservations.id, reservation.id));
        await tx
          .insert(creditChargeRemainders)
          .values({
            externalCustomerId: reservation.externalCustomerId,
            numerator: fraction.numerator.toString(),
            denominator: fraction.denominator.toString(),
          })
          .onConflictDoUpdate({
            target: creditChargeRemainders.externalCustomerId,
            set: {
              numerator: fraction.numerator.toString(),
              denominator: fraction.denominator.toString(),
              updatedAt: new Date(),
            },
          });

        return {
          chargedCents: charged,
          appliedCents: applied,
          releasedCents: released,
          remainder: fraction,
        };
      });
    },

    async releaseReservation(reservationId, reason) {
      const [head] = await database
        .select({ customer: creditReservations.externalCustomerId })
        .from(creditReservations)
        .where(eq(creditReservations.id, reservationId))
        .limit(1);
      if (!head) return;
      await database.transaction(async (tx) => {
        await lockCustomer(tx, head.customer);
        const [reservation] = await tx
          .select({
            status: creditReservations.status,
            maximum: creditReservations.maximum,
          })
          .from(creditReservations)
          .where(eq(creditReservations.id, reservationId))
          .limit(1);
        if (reservation?.status !== "reserved") return;
        await tx
          .update(creditReservations)
          .set({
            status: "released",
            applied: 0,
            released: reservation.maximum,
            releaseReason: reason,
            terminalAt: new Date(),
          })
          .where(eq(creditReservations.id, reservationId));
      });
    },

    async consumeCredits(input) {
      // The same integer discipline the deposit enforces: a fractional or negative cost is a
      // caller's bug, and the ledger it lands in must never inherit it.
      if (!Number.isInteger(input.amountCents) || input.amountCents < 0) {
        throw new TypeError(
          "consumeCredits needs a whole non-negative scaled amount.",
        );
      }

      // The same customer floor the deposit lays: a zero-balance customer's FIRST ledger row
      // must not discover the missing billing_customers row as a foreign-key violation — a
      // deployment that never granted anything still records what it consumed.
      await database
        .insert(billingCustomers)
        .values({ externalId: input.externalCustomerId, name: null })
        .onConflictDoNothing({ target: billingCustomers.externalId });

      // The idempotency pre-check outside the transaction is a fast path (the payment store's
      // confirmPaid uses the same shape): a retried report is answered from the unique index's
      // contents without opening a transaction, and the insert inside re-checks it.
      const [known] = await database
        .select({ applied: ledger.applied })
        .from(ledger)
        .where(eq(ledger.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (known)
        return { inserted: false, applied: known.applied, remaining: 0 };

      return database.transaction(async (tx) => {
        // Insert the ledger row FIRST, inside the transaction: the unique index is the
        // idempotency, and claiming it before any grant moves means a concurrent report of
        // the same key loses HERE (inserted nothing) rather than after having drawn grants.
        const insertedRows = await tx
          .insert(ledger)
          .values({
            id: generateGrantId(),
            externalCustomerId: input.externalCustomerId,
            grantId: null, // Attributed below, to the grant the draw started on.
            title: input.title,
            requestId: input.requestId ?? null,
            idempotencyKey: input.idempotencyKey,
            credits: input.amountCents,
            model: input.model ?? null,
            client: input.client ?? null,
          })
          .onConflictDoNothing({ target: ledger.idempotencyKey })
          .returning({ id: ledger.id });
        if (insertedRows.length === 0) {
          // Another report of this key won the race: its answer is this one's.
          const [existing] = await tx
            .select({ applied: ledger.applied })
            .from(ledger)
            .where(eq(ledger.idempotencyKey, input.idempotencyKey))
            .limit(1);
          return {
            inserted: false,
            applied: existing?.applied ?? 0,
            remaining: 0,
          };
        }

        /*
         * Draw across the live grants, soonest-to-lapse first: expiring allowance is spent
         * before durable allowance, so a person never lapses credits a later grant could have
         * covered.
         *
         * The row is locked BEFORE it moves (`FOR UPDATE` on the SELECT): a concurrent draw
         * against the same grant blocks here rather than racing the UPDATE, so the
         * `capacity = total - used` this loop computes is the committed truth it moves
         * against. Without the lock, two draws could both read capacity 1000 and both take
         * it — the UPDATE would still cap `used` at `total` (no overdraw, the check
         * constraint holds), but each transaction would CREDIT itself with capacity it did
         * not win, and `applied` would lie. The lock makes the accounting exact; the
         * constraint stays the last line of defence either way.
         */
        let toApply = input.amountCents;
        let applied = 0;
        let firstGrantId: string | null = null;
        while (toApply > 0) {
          const [live] = await tx
            .select({
              id: creditGrants.id,
              used: creditGrants.used,
              total: creditGrants.total,
            })
            .from(creditGrants)
            .where(
              and(
                eq(creditGrants.externalCustomerId, input.externalCustomerId),
                gt(creditGrants.expiresAt, new Date()),
                sql`${creditGrants.used} < ${creditGrants.total}`,
              ),
            )
            // Soonest expiry first, then oldest grant — the consumption order the read side
            // shows and the lapsemanship above depends on.
            .orderBy(asc(creditGrants.expiresAt), asc(creditGrants.grantedAt))
            .limit(1)
            // The lock: this row's capacity is ours alone until the transaction ends.
            .for("update");
          if (!live) break; // No live balance left: the ledger keeps the full cost anyway.

          // Under the lock, the arithmetic is plain: draw what this grant can fund of what
          // remains, capped at its capacity. The UPDATE below cannot miss because nobody
          // else can move the row while we hold it.
          const capacity = Math.max(live.total - live.used, 0);
          const drew = Math.min(toApply, capacity);
          await tx
            .update(creditGrants)
            .set({ used: live.used + drew })
            .where(eq(creditGrants.id, live.id));
          applied += drew;
          toApply -= drew;
          if (firstGrantId === null) firstGrantId = live.id;
        }

        // Attribute the draw to its first grant (the display copy the consumption table
        // joins on); a multi-grant draw names where it started, and `applied` records what
        // the balance could fund of the full cost the ledger row already holds.
        await tx
          .update(ledger)
          .set({ grantId: firstGrantId, applied })
          .where(eq(ledger.id, insertedRows[0]!.id));

        // The balance after this draw, inside the same transaction: the caller's "remaining"
        // is consistent with the rows this draw just moved.
        const after = await liveBalanceOf(tx, input.externalCustomerId);
        return { inserted: true, applied, remaining: after };
      });
    },
  };
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Pick<Database, "select"> | Tx;

async function ensureCustomer(
  db: Pick<Database, "insert">,
  externalId: string,
) {
  await db
    .insert(billingCustomers)
    .values({ externalId, name: null })
    .onConflictDoNothing({ target: billingCustomers.externalId });
}

/** Serialises every hold and settlement of one customer; the carried remainder depends on it. */
async function lockCustomer(tx: Tx, externalId: string) {
  await tx
    .select({ id: billingCustomers.externalId })
    .from(billingCustomers)
    .where(eq(billingCustomers.externalId, externalId))
    .for("update");
}

/** Live grants, soonest expiry first, with capacity left after used units and active holds. */
async function freeGrants(db: Reader, externalId: string, lock: boolean) {
  const query = db
    .select({
      id: creditGrants.id,
      total: creditGrants.total,
      used: creditGrants.used,
      held: sql<number>`coalesce((
        select sum(a.amount)::int
        from credit_reservation_allocations a
        join credit_reservations r on r.id = a.reservation_id
        where a.grant_id = credit_grants.id and r.status = 'reserved'
      ), 0)`,
    })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.externalCustomerId, externalId),
        gt(creditGrants.expiresAt, new Date()),
      ),
    )
    .orderBy(
      asc(creditGrants.expiresAt),
      asc(creditGrants.grantedAt),
      asc(creditGrants.id),
    );
  const rows = await (lock ? query.for("update", { of: creditGrants }) : query);
  return rows.map((row) => ({
    id: row.id,
    free: Math.max(row.total - row.used - Number(row.held), 0),
  }));
}

async function availableOf(db: Database, externalId: string): Promise<number> {
  const grants = await freeGrants(db, externalId, false);
  const owed = await remainderOf(db, externalId);
  const free = grants.reduce((sum, grant) => sum + grant.free, 0);
  return Math.max(free - (owed.numerator > 0n ? 1 : 0), 0);
}

async function remainderOf(
  db: Reader,
  externalId: string,
): Promise<CreditAmount> {
  const [row] = await db
    .select({
      numerator: creditChargeRemainders.numerator,
      denominator: creditChargeRemainders.denominator,
    })
    .from(creditChargeRemainders)
    .where(eq(creditChargeRemainders.externalCustomerId, externalId))
    .limit(1);
  return row
    ? { numerator: BigInt(row.numerator), denominator: BigInt(row.denominator) }
    : { numerator: 0n, denominator: 1n };
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function reduce(numerator: bigint, denominator: bigint): CreditAmount {
  if (numerator === 0n) return { numerator: 0n, denominator: 1n };
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function addAmounts(a: CreditAmount, b: CreditAmount): CreditAmount {
  const sum = reduce(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
  if (sum.denominator > MAX_REMAINDER_DENOMINATOR) {
    throw new TypeError(
      "settleReservation: the carried remainder's denominator exceeds the supported bound.",
    );
  }
  return sum;
}

function settledResultOf(
  reservation: typeof creditReservations.$inferSelect,
): CreditSettlementResult {
  return {
    chargedCents: reservation.charged ?? 0,
    appliedCents: reservation.applied ?? 0,
    releasedCents: reservation.released ?? 0,
    remainder: {
      numerator: BigInt(reservation.remainderNumerator ?? "0"),
      denominator: BigInt(reservation.remainderDenominator ?? "1"),
    },
  };
}

/** The live balance over one customer's grants, on a transaction or the plain database. */
async function liveBalanceOf(
  db:
    | Pick<Database, "select">
    | Parameters<Parameters<Database["transaction"]>[0]>[0],
  externalCustomerId: string,
): Promise<number> {
  const rows = await db
    .select({ total: creditGrants.total, used: creditGrants.used })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.externalCustomerId, externalCustomerId),
        gt(creditGrants.expiresAt, new Date()),
      ),
    );
  let balance = 0;
  for (const row of rows) balance += Math.max(row.total - row.used, 0);
  return balance;
}

type GrantRow = typeof creditGrants.$inferSelect;
function resultOf(row: GrantRow): CreditGrantResult {
  return {
    id: row.id,
    externalCustomerId: row.externalCustomerId,
    source: row.source,
    reason: row.reason,
    total: row.total,
    used: row.used,
    grantedAt: row.grantedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
