import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { Database } from "../db/client";
import { payerAccounts } from "../db/schema/billing";
import {
  creditRecoveryItems,
  creditReservations,
} from "../db/schema/credit-reservations";
import type { PayerKind } from "./payer";
import { attemptIdForReservation } from "./reservation-status";

/*
 * The unknown-dispatch recovery scan (Bifrost 08.1): find the holds a dead process left
 * behind, name each once, and let exactly one worker own each name.
 *
 * WHY THIS MODULE EXISTS. Between the reserve (07.2) and the settlement (07.8) a process
 * can die — before the dispatch, after it, after 06.8's unknown mark — and the hold it
 * took keeps occupying credit with nobody holding the thread. The durable facts survive in
 * `credit_reservations`: a `reserved` hold whose expiry passed (nothing ever marked it),
 * or an `unknown` hold (the result never reliably arrived — and the clock is never release
 * evidence, Q12). 07.4's dispatch commitment lives in the admission plugin's own store and
 * is not this server's scan source; the reservation IS this server's side of the same
 * promise (attemptId is a pure function of the reservation id, 06.7). The cleanup guards
 * (21.5) already treat every reserved|unknown reservation as the rows RecoveryItems are
 * generated from — this module writes those rows.
 *
 * WHAT THE SCAN DOES — AND DOES NOT DO. One read of the open holds, one insert into
 * `credit_recovery_items`. It never releases (the unknown hold keeps occupying; an expired
 * plain hold's row stays `reserved` for recovery handlers, not the scan, to resolve), it
 * never re-dispatches (a provider attempt is admitted by a new reserve with a new
 * idempotency key per 07.5 — a scan that re-dispatched would be exactly the double charge
 * AC07 forbids), and it never settles. Every pass is re-runnable: the per-reservation
 * unique index turns a re-scan — or two replicas racing — into a no-op for the holds
 * already named.
 *
 * THE CLAIM. The item's lifecycle starts here and is consumed downstream (08.2's replay,
 * 08.4's retry, 08.9's evidenced disposal). `claimRecoveryItems` hands a batch to one
 * worker inside one transaction — SELECT ... FOR UPDATE SKIP LOCKED, then the state
 * transition — so two workers racing (two processes, two replicas) each get a disjoint
 * set, and the same item is never handed twice. `claimRecoveryItem` is the single-item
 * form: one UPDATE guarded by state='pending', atomic by statement.
 *
 * THE FIXATION. The item copies the hold's identity — attempt, reservation, payment
 * account, payer mapping, price basis, ceiling — AT DETECTION TIME. What recovery works
 * from afterwards is the item's own columns, so a later settlement of the hold (or its
 * eventual disposal) cannot silently change the recovery's basis. `payer_kind`/`payer_id`
 * carry the account's mapping row when one resolves; a key with no mapping is recorded
 * unattributed (null), never guessed — the attribution module's discipline.
 */

/** Why the scan named a hold: the two unknown shapes it can meet. */
export type RecoveryDetectionReason =
  /** 06.8's explicit mark: the provider result never reliably arrived. */
  | "unknown_marked"
  /** Killed between the reserve and any outcome; the hold's own expiry has passed. */
  | "hold_expired_unanswered";

/** The lastReason a scan records for each detection shape (closed vocabulary). */
export const DETECTION_REASONS: Record<RecoveryDetectionReason, string> = {
  unknown_marked: "dispatch_result_unknown",
  hold_expired_unanswered: "hold_expired_without_result",
};

/** How many holds one scan pass names at most (the batch, audit C3's bounded shape). */
const DEFAULT_BATCH_LIMIT = 100;

/** One open hold the scan saw this pass, whether or not it named it. */
export type RecoveryScanCandidate = {
  reservationId: string;
  attemptId: string;
  reason: RecoveryDetectionReason;
};

/** The payment account a recovery item is fixed to (the ticket's payerRef). */
export type RecoveryItemPayerRef = {
  /** The account key every money fact for this hold keys on. */
  externalCustomerId: string;
  /** The payer mapping behind the account, when one resolves; null stays null. */
  kind: PayerKind | null;
  payerId: string | null;
};

/**
 * One RecoveryItem, as the ticket's Produces contract names it — plus the locked price
 * basis and ceiling the downstream handlers (08.2 replay, 08.4 retry, 08.9 disposal) need
 * to act without re-deriving anything from a hold that may have moved on.
 *
 * `state` names the table's full vocabulary (08.2's 0148 added the `resolved` terminal a
 * handler moves a finished item to). The scan itself only ever inserts `pending` and its
 * claims only ever return `claimed`; `resolved` appears in rows downstream handlers write.
 */
export type RecoveryItem = {
  id: string;
  attemptId: string;
  reservationId: string;
  payerRef: RecoveryItemPayerRef;
  maximum: number;
  /** The locked price basis (06.5), copied from the hold: all five or none. */
  provider: string | null;
  model: string | null;
  capability: string | null;
  snapshotVersion: number | null;
  rateVersion: number | null;
  state: "pending" | "claimed" | "resolved";
  failureCount: number;
  lastReason: string | null;
  detectedAt: string;
  claimedAt: string | null;
  claimedBy: string | null;
};

/** What one scan pass did. Re-runnable by design; a repeat pass generates nothing. */
export type RecoveryScanPass = {
  scannedAt: string;
  /** Every open hold the pass saw, named or already named by an earlier pass. */
  candidates: RecoveryScanCandidate[];
  /** Items this pass actually inserted (the unique index absorbed any race). */
  itemsGenerated: number;
  items: RecoveryItem[];
};

export type RecoveryScanner = {
  /** Discover unknown holds and name them. Writes ONLY recovery items; never releases,
   * re-dispatches or settles. Safe to run concurrently: one item per reservation, ever. */
  scanOnce(): Promise<RecoveryScanPass>;
  /** Claim up to `limit` pending items for `workerId` — atomically, so concurrent workers
   * receive disjoint sets. Oldest detection first. */
  claimRecoveryItems(workerId: string, limit?: number): Promise<RecoveryItem[]>;
  /** Claim one item by id for `workerId`; answers null when it is already claimed (or
   * never existed) — never an error, the loser of a race is a normal answer. */
  claimRecoveryItem(
    itemId: string,
    workerId: string,
  ): Promise<RecoveryItem | null>;
};

export type RecoveryScannerDependencies = {
  database: Database;
  /** Injectable clock; the app clock by default. */
  now?: () => Date;
  /** Batch ceiling per scan pass; 100 by default. */
  batchLimit?: number;
};

/** The item id shape the scan mints: `cri-` plus 8 random bytes as hex (the writer's `cr-` draw). */
function generateRecoveryItemId(): string {
  return `cri-${randomBytes(8).toString("hex")}`;
}

function isNonEmptyIdentifier(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

type RecoveryItemRow = typeof creditRecoveryItems.$inferSelect;

function toRecoveryItem(row: RecoveryItemRow): RecoveryItem {
  return {
    id: row.id,
    attemptId: row.attemptId,
    reservationId: row.reservationId,
    payerRef: {
      externalCustomerId: row.externalCustomerId,
      kind: (row.payerKind as PayerKind | null) ?? null,
      payerId: row.payerId,
    },
    maximum: row.maximum,
    provider: row.provider,
    model: row.model,
    capability: row.capability,
    snapshotVersion: row.snapshotVersion,
    rateVersion: row.rateVersion,
    state: row.state,
    failureCount: row.failureCount,
    lastReason: row.lastReason,
    detectedAt: row.detectedAt.toISOString(),
    claimedAt: row.claimedAt ? row.claimedAt.toISOString() : null,
    claimedBy: row.claimedBy,
  };
}

/**
 * The recovery scanner over the real tables. Takes the `database` and nothing else that
 * can lie: the open holds are read from the live reservations, the payer mappings from the
 * live accounts, and every write is an idempotent insert or a state-guarded claim.
 */
export function createRecoveryScanner(
  dependencies: RecoveryScannerDependencies,
): RecoveryScanner {
  const { database } = dependencies;
  const batchLimit = dependencies.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const now = () => dependencies.now?.() ?? new Date();

  return {
    async scanOnce(): Promise<RecoveryScanPass> {
      const at = now();
      const detectedAt = at;

      // --- Discover: every hold whose outcome nobody knows, that no item names yet.
      // `unknown` is the explicit mark; an expired plain hold is the killed-mid-flight
      // shape the unknown mark never reached. Young reserved holds are LIVE requests —
      // the scan never names those, or every in-flight call would become an incident.
      const openHolds = await database
        .select({
          id: creditReservations.id,
          status: creditReservations.status,
          maximum: creditReservations.maximum,
          externalCustomerId: creditReservations.externalCustomerId,
          provider: creditReservations.provider,
          model: creditReservations.model,
          capability: creditReservations.capability,
          snapshotVersion: creditReservations.snapshotVersion,
          rateVersion: creditReservations.rateVersion,
          unknownReason: creditReservations.unknownReason,
        })
        .from(creditReservations)
        .leftJoin(
          creditRecoveryItems,
          eq(creditRecoveryItems.reservationId, creditReservations.id),
        )
        .where(
          and(
            isNull(creditRecoveryItems.id),
            or(
              eq(creditReservations.status, "unknown"),
              and(
                eq(creditReservations.status, "reserved"),
                lt(creditReservations.expiresAt, at),
              ),
            ),
          ),
        )
        .orderBy(asc(creditReservations.createdAt), asc(creditReservations.id))
        .limit(batchLimit);

      const candidates: RecoveryScanCandidate[] = openHolds.map((hold) => ({
        reservationId: hold.id,
        attemptId: attemptIdForReservation(hold.id),
        reason:
          hold.status === "unknown"
            ? "unknown_marked"
            : "hold_expired_unanswered",
      }));
      if (openHolds.length === 0) {
        return {
          scannedAt: at.toISOString(),
          candidates: [],
          itemsGenerated: 0,
          items: [],
        };
      }

      // --- Fix the payer mapping behind each account, once per pass: an account with no
      // mapping row stays unattributed in the item — null, never a guess.
      const accountKeys = [
        ...new Set(openHolds.map((hold) => hold.externalCustomerId)),
      ];
      const mappings = await database
        .select({
          externalCustomerId: payerAccounts.externalCustomerId,
          kind: payerAccounts.kind,
          payerId: payerAccounts.payerId,
        })
        .from(payerAccounts)
        .where(inArray(payerAccounts.externalCustomerId, accountKeys));
      const mappingByAccount = new Map(
        mappings.map((mapping) => [mapping.externalCustomerId, mapping]),
      );

      // --- Name each hold once. One row per reservation, ever (the unique indexes): a
      // concurrent pass's identical insert loses silently here, which is the whole
      // idempotence of the scan across replicas and restarts.
      const inserted = await database
        .insert(creditRecoveryItems)
        .values(
          openHolds.map((hold) => {
            const reason =
              hold.status === "unknown"
                ? (hold.unknownReason ?? DETECTION_REASONS.unknown_marked)
                : DETECTION_REASONS.hold_expired_unanswered;
            const mapping = mappingByAccount.get(hold.externalCustomerId);
            return {
              id: generateRecoveryItemId(),
              attemptId: attemptIdForReservation(hold.id),
              reservationId: hold.id,
              externalCustomerId: hold.externalCustomerId,
              payerKind: mapping?.kind ?? null,
              payerId: mapping?.payerId ?? null,
              provider: hold.provider,
              model: hold.model,
              capability: hold.capability,
              snapshotVersion: hold.snapshotVersion,
              rateVersion: hold.rateVersion,
              maximum: hold.maximum,
              state: "pending" as const,
              failureCount: 0,
              lastReason: reason,
              detectedAt,
            };
          }),
        )
        // No target: ANY unique conflict (a racing pass on either index) is absorbed —
        // the row that won is the item, and this pass simply names fewer holds.
        .onConflictDoNothing()
        .returning();

      return {
        scannedAt: at.toISOString(),
        candidates,
        itemsGenerated: inserted.length,
        items: inserted.map(toRecoveryItem),
      };
    },

    async claimRecoveryItems(workerId, limit = 10): Promise<RecoveryItem[]> {
      if (!isNonEmptyIdentifier(workerId, 512)) {
        throw new TypeError(
          `claimRecoveryItems: workerId must be a non-empty identifier of at most 512 characters`,
        );
      }
      if (!Number.isInteger(limit) || limit < 1) {
        throw new TypeError(
          `claimRecoveryItems: limit must be a positive integer`,
        );
      }
      const at = now();
      // One transaction: the skip-locked select and the state transition it feeds. A
      // second worker's select skips every row this one holds, so disjoint sets are
      // guaranteed by the lock — and the guarded UPDATE re-checks the state inside the
      // same fence, so a row can never change hands twice in one pass.
      return database.transaction(async (tx) => {
        const pending = await tx
          .select({ id: creditRecoveryItems.id })
          .from(creditRecoveryItems)
          .where(eq(creditRecoveryItems.state, "pending"))
          .orderBy(
            asc(creditRecoveryItems.detectedAt),
            asc(creditRecoveryItems.id),
          )
          .limit(limit)
          .for("update", { skipLocked: true });
        if (pending.length === 0) return [];
        const claimed = await tx
          .update(creditRecoveryItems)
          .set({
            state: "claimed",
            claimedBy: workerId,
            claimedAt: at,
            updatedAt: at,
          })
          .where(
            and(
              inArray(
                creditRecoveryItems.id,
                pending.map((entry) => entry.id),
              ),
              eq(creditRecoveryItems.state, "pending"),
            ),
          )
          .returning();
        return claimed.map(toRecoveryItem);
      });
    },

    async claimRecoveryItem(itemId, workerId): Promise<RecoveryItem | null> {
      if (!isNonEmptyIdentifier(workerId, 512)) {
        throw new TypeError(
          `claimRecoveryItem: workerId must be a non-empty identifier of at most 512 characters`,
        );
      }
      if (!isNonEmptyIdentifier(itemId, 512)) {
        throw new TypeError(
          `claimRecoveryItem: itemId must be a non-empty identifier of at most 512 characters`,
        );
      }
      const at = now();
      // One statement: the state guard rides in the WHERE, so of two racing claims only
      // the first commit's UPDATE matches — the second answers null, a normal answer.
      const [claimed] = await database
        .update(creditRecoveryItems)
        .set({
          state: "claimed",
          claimedBy: workerId,
          claimedAt: at,
          updatedAt: at,
        })
        .where(
          and(
            eq(creditRecoveryItems.id, itemId),
            eq(creditRecoveryItems.state, "pending"),
          ),
        )
        .returning();
      return claimed ? toRecoveryItem(claimed) : null;
    },
  };
}
