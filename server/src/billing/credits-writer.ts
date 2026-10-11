import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { creditGrants } from "../db/schema/credits";
import { billingCustomers } from "../db/schema/billing";
import type { CreditGrantSource } from "./types";

/**
 * The local credit ledger's WRITE side — the deposit half (grantCredits). The reads live in
 * ./credits.ts and stay untouched; this module is the only writer `credit_grants` has, so every
 * invariant about how a row is born is decided here, once.
 *
 * Discipline carried over from the payments module: credits stay integers scaled by
 * `CREDIT_SCALE` (×100) from input to storage — a grant of "23.63 credits" is the integer 2363
 * and never a binary float — timestamps are timestamptz, and failures answer with the billing
 * seam's sentinel codes rather than raw messages.
 *
 * Idempotency: every grant carries an idempotency key, and the caller that names one gets the
 * occurrence recorded exactly once — the unique index on `credit_grants.idempotency_key` is the
 * authority, and the insert-or-nothing against it turns a retry into a read of the row that
 * already exists. A caller with no natural key (an operator pressing the promo button, where two
 * presses MEAN two grants) gets a random one derived here, which keeps the insert always-fresh
 * while holding the column NOT NULL — that is what lets the index be plain unique, so ON CONFLICT
 * can infer it (Postgres cannot infer a partial index without its WHERE spelled in-statement).
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
  // T2 (consumeCredits) mounts here: the withdrawal half of the same ledger, one transaction
  // across `credit_grants.used` and `credit_ledger`. Deliberately absent from batch 1.
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
