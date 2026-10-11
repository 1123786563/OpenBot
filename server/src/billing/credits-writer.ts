import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { creditGrants, creditLedger as ledger } from "../db/schema/credits";
import { billingCustomers } from "../db/schema/billing";
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
      if (known) return { inserted: false, applied: known.applied, remaining: 0 };

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

/** The live balance over one customer's grants, on a transaction or the plain database. */
async function liveBalanceOf(
  db: Pick<Database, "select"> | Parameters<Parameters<Database["transaction"]>[0]>[0],
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
