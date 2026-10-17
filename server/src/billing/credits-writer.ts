import { randomBytes } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { billingCustomers } from "../db/schema/billing";
import {
  creditChargeRemainders,
  creditReservationAllocations,
  creditReservations,
} from "../db/schema/credit-reservations";
import { creditGrants, creditLedger as ledger } from "../db/schema/credits";
import {
  carriedRemainder,
  liveGrants,
  readCapacity,
  type Tx,
} from "./capacity";
import type { ReservationLockedBasis } from "./reserve-bound";
import type { CreditGrantSource } from "./types";

/**
 * The local credit ledger's WRITE side. The deposit (grantCredits) is the only writer
 * `credit_grants` has ever had; the reserve/settle/release trio (reserveCredits,
 * settleReservation, releaseReservation) is the only writer that moves `used` or writes
 * `credit_ledger`, so every invariant about the ledger is decided here, once. The reads live
 * in ./credits.ts and stay untouched.
 *
 * Discipline carried over from the payments module: credits stay integers scaled by
 * `CREDIT_SCALE` (×100) from input to storage — a grant of "23.63 credits" is the integer 2363
 * and never a binary float — timestamps are timestamptz, and failures answer with the billing
 * seam's sentinel codes rather than raw messages.
 *
 * Idempotency: every grant AND every reservation carries an idempotency key, and the unique
 * indexes on `credit_grants.idempotency_key` / `credit_ledger.idempotency_key` are the
 * authorities — the insert-or-nothing against them turns a retry into a read of the row that
 * already exists. A caller with no natural key (an operator pressing the promo button, where
 * two presses MEAN two grants) gets a random one derived here, which keeps the insert
 * always-fresh while holding the columns NOT NULL — that is what lets both indexes be plain
 * unique, so ON CONFLICT can infer them (Postgres cannot infer a partial index without its
 * WHERE spelled in-statement). A settled hold's ledger row carries the derived key
 * `reservation:<id>`, so the ledger's own index fences a double settle.
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
/** Bounds a single rational charge; accumulated remainders may need a larger denominator. */
const MAX_ACTUAL_DENOMINATOR = 10n ** 60n;

/** An exact non-negative rational, in scaled credit units (×100). */
export type CreditAmount = { numerator: bigint; denominator: bigint };

export type CreditReservationState =
  | "reserved"
  | "unknown"
  | "settled"
  | "released";

/** A reservation call that conflicts with the reservation's recorded identity or terminal state. */
export class CreditReservationConflictError extends Error {
  /** Stable, snake_case, matched by the delivery worker's non-retryable set (audit C1). */
  readonly code = "reservation_conflict";
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
   * The capacity a new hold could take now: live grant capacity minus every active hold, and one
   * unit while a fractional remainder is owed (the owed fraction keeps counting against capacity).
   */
  availableBalance(externalCustomerId: string): Promise<number>;

  /**
   * Hold `maximumCents` (scaled units, a positive 32-bit integer) across the customer's live
   * grants, earliest expiry first, atomically with respect to every other hold and settlement of
   * the customer. A replay of `idempotencyKey` answers the original reservation; a replay with a
   * different customer or amount throws `CreditReservationConflictError`. A refused hold writes
   * nothing and reports what was available. When `lockedBasis` is given (the credit protocol's
   * reserve path, 06.5), it is persisted with the hold: the pricing basis — cell plus
   * snapshotVersion plus rateVersion — the admission priced, for settlement to resolve exactly.
   */
  reserveCredits(input: {
    externalCustomerId: string;
    idempotencyKey: string;
    maximumCents: number;
    expiresAt: Date;
    lockedBasis?: ReservationLockedBasis;
  }): Promise<
    | { reserved: true; reservationId: string }
    | { reserved: false; availableCents: number }
  >;
  /*
   * Replay semantics: a replay of `idempotencyKey` answers the original reservation only
   * while it is still `reserved`; a replay against a settled or released hold — or with a
   * different customer or amount — throws `CreditReservationConflictError`, because a
   * terminal hold carries no capacity and must never admit work.
   */

  /**
   * Convert a hold into a charge. `actual` is the exact rational cost in scaled units; the
   * customer's carried remainder is added, the whole-unit floor is drawn from the held grants
   * (written once to `credit_ledger`), and the new fraction is persisted. Unused hold is
   * released. Replaying the same actual returns the first result; a different actual, or settling
   * a released hold, throws `CreditReservationConflictError`. Cost above the hold is recorded in
   * the ledger in full but only the held capacity is applied. An `unknown` hold settles too —
   * that IS recovery's settlement (06.8/AC15): the same reservation, the same attempt id, and
   * the entry evidence stays on the row as history.
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
   * changes nothing (the first terminal result stands). An `unknown` hold is REFUSED: its
   * provider outcome never arrived, so a release is never ordinary — only 08.x's recovery flow
   * or an evidenced admin disposal may move it, through `releaseUnknownReservation`.
   */
  releaseReservation(reservationId: string, reason: string): Promise<void>;

  /**
   * The recovery-only release (06.8): move a result-unconfirmed (`unknown`) hold to `released`
   * once evidence says no cost was produced (08.x's recovery flow, or an evidenced admin
   * disposal). A still-`reserved` hold refuses — this door is never a second ordinary release —
   * and a terminal hold changes nothing (the first terminal result stands). `reason` names the
   * evidence the disposal stands on; the row keeps its `unknownAt`/`unknownReason` history.
   */
  releaseUnknownReservation(
    reservationId: string,
    reason: string,
  ): Promise<void>;

  /**
   * Record that a hold's provider outcome is unknown (06.8, Q12/AC15): a stream error, a
   * missing usage report, a cancellation — anything that is NOT a confirmed no-cost. The hold
   * leaves the plain `reserved` state for `unknown`, keeping its FULL capacity occupied no
   * matter how far the clock advances past `expiresAt`, with the reason and instant recorded
   * for 08.x's recovery. Idempotent: the first reason and instant stand; a hold already
   * settled or released changes nothing (a terminal fact is never reopened).
   */
  markReservationUnknown(reservationId: string, reason: string): Promise<void>;
};

export function createCreditWriter(database: Database): CreditWriter {
  return {
    async grantCredits(input) {
      // Integer discipline enforced at the seam: a fractional or negative amount is a caller's
      // bug, and storing it rounded would silently corrupt the ledger it lands in. The upper
      // bound is the column's: an amount the 32-bit ledger cannot hold is refused here, before
      // the insert strands a paid activation in a permanent retry (audit A6).
      if (
        !Number.isInteger(input.totalCents) ||
        input.totalCents < 0 ||
        input.totalCents > MAX_STORED_UNITS ||
        !Number.isFinite(input.expiresAt.getTime())
      ) {
        throw new TypeError(
          "grantCredits needs a whole non-negative scaled amount that fits the 32-bit credit column, and a real expiry.",
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

    async availableBalance(externalCustomerId) {
      return (await readCapacity(database, externalCustomerId)).spendableUnits;
    },

    async reserveCredits(input) {
      if (
        !Number.isInteger(input.maximumCents) ||
        input.maximumCents <= 0 ||
        input.maximumCents > MAX_STORED_UNITS ||
        !Number.isFinite(input.expiresAt.getTime()) ||
        input.expiresAt.getTime() <= Date.now() ||
        input.idempotencyKey.length === 0
      ) {
        throw new TypeError(
          "reserveCredits needs a positive 32-bit scaled amount, a future expiry and a key.",
        );
      }
      const basis = input.lockedBasis;
      if (
        basis !== undefined &&
        (typeof basis.provider !== "string" ||
          basis.provider.length === 0 ||
          typeof basis.model !== "string" ||
          basis.model.length === 0 ||
          typeof basis.capability !== "string" ||
          basis.capability.length === 0 ||
          !Number.isSafeInteger(basis.snapshotVersion) ||
          basis.snapshotVersion < 1 ||
          !Number.isSafeInteger(basis.rateVersion) ||
          basis.rateVersion < 0)
      ) {
        throw new TypeError(
          "reserveCredits needs a complete locked basis: a non-empty cell with a positive snapshot version and a non-negative rate version.",
        );
      }
      await ensureCustomer(database, input.externalCustomerId);

      const at = new Date();
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
          if (existing.status !== "reserved") {
            // A terminal hold carries no capacity: answering `reserved` would admit work
            // the gate never priced and settle could never charge — the same refusal
            // settle gives a released hold.
            throw new CreditReservationConflictError(
              `reserveCredits: the reservation for this idempotency key is ${existing.status}.`,
            );
          }
          return { reserved: true as const, reservationId: existing.id };
        }

        const grants = await liveGrants(tx, input.externalCustomerId, at, true);
        const owed = await carriedRemainder(tx, input.externalCustomerId);
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
          ...(basis === undefined
            ? {}
            : {
                provider: basis.provider,
                model: basis.model,
                capability: basis.capability,
                snapshotVersion: basis.snapshotVersion,
                rateVersion: basis.rateVersion,
              }),
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
        denominator > MAX_ACTUAL_DENOMINATOR
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

        const owed = await carriedRemainder(tx, reservation.externalCustomerId);
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
            total: creditGrants.total,
            used: creditGrants.used,
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
          const remainingGrantCapacity = Math.max(
            allocation.total - allocation.used,
            0,
          );
          const drew = Math.min(
            toApply,
            allocation.amount,
            remainingGrantCapacity,
          );
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
        if (reservation?.status === "unknown") {
          // 06.8: an unknown hold is never ordinary-release evidence — the provider may have
          // produced billable work nobody reported. Refuse loudly instead of silently leaving
          // the caller to believe capacity was handed back.
          throw new CreditReservationConflictError(
            "releaseReservation: the reservation's outcome is unknown; only recovery may dispose of it.",
          );
        }
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

    async releaseUnknownReservation(reservationId, reason) {
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
        if (!reservation) return;
        if (reservation.status === "reserved") {
          // The recovery door is never a second ordinary release: a hold still in the plain
          // reserved state has an ordinary path, and evidence-backed disposal must not
          // bypass it.
          throw new CreditReservationConflictError(
            "releaseUnknownReservation: the reservation is still reserved; use the ordinary release.",
          );
        }
        if (reservation.status !== "unknown") return;
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

    async markReservationUnknown(reservationId, reason) {
      const [head] = await database
        .select({ customer: creditReservations.externalCustomerId })
        .from(creditReservations)
        .where(eq(creditReservations.id, reservationId))
        .limit(1);
      if (!head) return;
      await database.transaction(async (tx) => {
        await lockCustomer(tx, head.customer);
        const [reservation] = await tx
          .select({ status: creditReservations.status })
          .from(creditReservations)
          .where(eq(creditReservations.id, reservationId))
          .limit(1);
        // Only a plain hold becomes unknown: the first evidence stands, and a terminal
        // fact (settled/released) is never reopened.
        if (reservation?.status !== "reserved") return;
        await tx
          .update(creditReservations)
          .set({
            status: "unknown",
            unknownAt: new Date(),
            unknownReason: reason,
          })
          .where(eq(creditReservations.id, reservationId));
      });
    },
  };
}

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
  return reduce(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
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
