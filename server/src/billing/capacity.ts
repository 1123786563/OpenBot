import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { creditChargeRemainders } from "../db/schema/credit-reservations";
import { creditGrants } from "../db/schema/credits";
import type { CreditGrantSource } from "./types";

/**
 * The ONE definition of spendable credit capacity, shared by the writer's admission
 * (./credits-writer.ts) and the reader's page answer (./credits.ts).
 *
 * Before this module the two sides computed capacity separately and disagreed: the writer
 * excluded expired grants and subtracted active holds, the reader did neither, so the page
 * showed a balance admission would refuse (audit A1). Capacity is now a fact with one owner.
 *
 * One clock per computation: the grant-liveness filter and the hold-expiry filter are bound to
 * the SAME app-side instant passed in as `at`, never the database's `now()` — app and database
 * clocks skew, and a skewed pair would let a hold be admitted against capacity an expired hold
 * already vacated (or refuse one that is still live).
 */

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Reader = Pick<Database, "select"> | Tx;

/** One live grant's capacity, in scaled units (×100). `free` is what a new draw or hold may take. */
export type GrantCapacity = {
  id: string;
  source: CreditGrantSource;
  total: number;
  used: number;
  /** Sum of every capacity-occupying hold allocated against this grant. */
  held: number;
  /** max(total - used - held, 0) — per grant, so a clamp on one grant never hides capacity in another. */
  free: number;
  expiresAt: Date;
};

/** The customer's whole capacity picture: the grants, and the three sums a caller needs. */
export type CapacityBreakdown = {
  grants: readonly GrantCapacity[];
  /** Σ free over live grants. */
  freeUnits: number;
  /** A carried fractional charge keeps one whole unit occupied. */
  owedUnit: 0 | 1;
  /** What a new hold could take right now: max(freeUnits - owedUnit, 0). */
  spendableUnits: number;
};

/**
 * Live grants, soonest expiry first, with capacity left after used units and occupying holds.
 *
 * An "occupying" hold is one of two things (audit F4 in the 2026-10-13 remediation, amended by
 * Bifrost 06.8): a PLAIN `reserved` hold whose expiry has not passed — one whose expiry HAS
 * passed no longer occupies, and reconciliation reports the row for an operator — or an
 * `unknown` hold, which occupies NO MATTER HOW FAR THE CLOCK ADVANCES past `expires_at`
 * (Q12/AC15: a result that never arrived is not release evidence, so the expiry field fences
 * only new requests and plain holds, never an unknown one; only recovery settles or releases
 * it). `lock: true` takes `FOR UPDATE` on the grant rows and is only legal inside a
 * transaction that already holds the customer lock.
 */
export async function liveGrants(
  db: Reader,
  externalId: string,
  at: Date,
  lock: boolean,
): Promise<GrantCapacity[]> {
  const query = db
    .select({
      id: creditGrants.id,
      source: creditGrants.source,
      total: creditGrants.total,
      used: creditGrants.used,
      expiresAt: creditGrants.expiresAt,
      held: sql<number>`coalesce((
        select sum(a.amount)::int
        from credit_reservation_allocations a
        join credit_reservations r on r.id = a.reservation_id
        where a.grant_id = credit_grants.id
          and (r.status = 'unknown' or (r.status = 'reserved' and r.expires_at > ${at}))
      ), 0)`,
    })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.externalCustomerId, externalId),
        gt(creditGrants.expiresAt, at),
      ),
    )
    .orderBy(
      asc(creditGrants.expiresAt),
      asc(creditGrants.grantedAt),
      asc(creditGrants.id),
    );
  const rows = await (lock ? query.for("update", { of: creditGrants }) : query);
  return rows.map((row) => {
    const held = Number(row.held);
    return {
      id: row.id,
      source: row.source,
      total: row.total,
      used: row.used,
      held,
      free: Math.max(row.total - row.used - held, 0),
      expiresAt: row.expiresAt,
    };
  });
}

/** The per-customer fraction of a scaled unit that exact-rational charges have accrued. */
export async function carriedRemainder(
  db: Reader,
  externalId: string,
): Promise<{ numerator: bigint; denominator: bigint }> {
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

/** The spendable answer, unlocked: a pre-call signal, never the admission authority. */
export async function readCapacity(
  db: Reader,
  externalId: string,
  at: Date = new Date(),
): Promise<CapacityBreakdown> {
  const grants = await liveGrants(db, externalId, at, false);
  const owed = await carriedRemainder(db, externalId);
  const freeUnits = grants.reduce((sum, grant) => sum + grant.free, 0);
  const owedUnit: 0 | 1 = owed.numerator > 0n ? 1 : 0;
  return {
    grants,
    freeUnits,
    owedUnit,
    spendableUnits: Math.max(freeUnits - owedUnit, 0),
  };
}
