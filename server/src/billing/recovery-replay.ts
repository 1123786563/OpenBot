import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  creditRecoveryItems,
  creditReservations,
} from "../db/schema/credit-reservations";
import { usageOutbox } from "../db/schema/usage-outbox";
import { createCreditWriter } from "./credits-writer";
import {
  createRecoveryScanner,
  type RecoveryItem,
  type RecoveryScanner,
} from "./recovery-scan";
import { createCreditUsageTarget } from "./usage-delivery";
import { createUsageOutbox, type UsageOutbox } from "./usage-outbox";

/*
 * The recovery branch for a result that was PERSISTED but never ACKED (Bifrost 08.2).
 *
 * THE SHAPE. The PostLLM settlement (07.8) wrote its result to `usage_outbox` — eventId,
 * reservationId, the exact actual cost — and the process died before the delivery sweeper
 * could settle the hold and ack the row. The hold keeps occupying credit, so 08.1's scan
 * names it a RecoveryItem. THIS module is the recovery action for that item: re-deliver
 * the SAME persisted result to Settle under the SAME idempotency key.
 *
 * WHY THE REPLAY CANNOT DOUBLE-CHARGE. The delivery effect is the production one —
 * `createCreditUsageTarget` over the credit writer — so a replay is the same call the
 * first delivery made: `settleReservation` with `requestId = record.eventId` and the
 * recorded exact rational. Usage is never re-collected and no provider attempt is ever
 * re-admitted (the customer keeps the ONE reservation the recovery item names). The
 * settle itself converges (06.x): a hold already `settled` returns the first result, so a
 * replay racing a delayed first delivery still leaves exactly ONE ledger entry at the
 * original amount; a different actual or a released hold is a real conflict that lands in
 * the failure path below. 08.3's own shape — the settle LANDED and only the ack was lost —
 * never reaches the effect at all: the hold's recorded settlement is verified read-only
 * against the persisted result and only the ack is backfilled.
 *
 * THE ITEM LIFECYCLE (the columns 08.1 fixed). A claimed item that finishes moves to
 * `resolved` (0148): the replay succeeded, the record already proved delivered, or — for
 * an item that is not this handler's shape at all — it is handed back to `pending`
 * untouched for the handlers that DO own it (08.4's retry, 08.9's evidenced disposal). A
 * FAILED replay also hands the item back to `pending`, but with failure_count incremented
 * and the stable failure code as lastReason — the item is retained, never lost (AC: 重放
 * 失败不丢失 RecoveryItem). Every transition is guarded on `state = 'claimed'`, so only
 * the worker holding the claim can move it, and a worker that lost its claim to a race
 * writes nothing (08.1's loser-is-a-normal-answer discipline).
 */

/** What processing one claimed RecoveryItem did. */
export type UnackedReplayOutcome =
  /** The persisted result was re-delivered to Settle, acked, and the item resolved. */
  | "replayed"
  /** The ledger already held the settlement and only the ack was lost (08.3): the result
   * was verified read-only against the hold, the ack backfilled, and the item resolved —
   * with NO Settle effect invoked at all. */
  | "settled_ack_recovered"
  /** The record's credits target was already delivered: no re-delivery, item resolved. */
  | "already_delivered"
  /** The credits target is in the terminal `blocked` state (manual review): untouched. */
  | "credits_blocked"
  /** No outbox record exists for the reservation: not this handler's shape; the item is
   * handed back to `pending` with the failure count UNCHANGED, retained for 08.4/08.9. */
  | "no_persisted_result"
  /** The replay failed: the item is retained as `pending`, failure_count incremented,
   * lastReason carrying the stable failure code. */
  | "failed";

export type UnackedReplayResult = {
  outcome: UnackedReplayOutcome;
  /** The outbox event the outcome concerns, when one exists. */
  eventId: string | null;
  /** The stable failure code, for `failed` outcomes only. */
  failureCode?: string;
};

/** What one replay pass over a claimed batch did. */
export type UnackedReplayBatch = {
  claimed: number;
  replayed: number;
  settledAckRecovered: number;
  alreadyDelivered: number;
  creditsBlocked: number;
  noPersistedResult: number;
  failed: number;
};

/** The recovery reason an item is left with after a failed replay. */
export const REPLAY_RETAINED_REASON_NO_RESULT = "no_persisted_result";
export const REPLAY_RESOLVED_REASON_DELIVERED = "result_replayed_delivered";
export const REPLAY_RESOLVED_REASON_ALREADY_DELIVERED = "result_already_delivered";
export const REPLAY_RETAINED_REASON_BLOCKED = "credits_delivery_blocked";
/** 08.3's resolution reason: the settlement was the ledger's own, only the ack was backfilled. */
export const REPLAY_RESOLVED_REASON_ACK_RECOVERED = "result_settled_ack_recovered";

/** Only a short snake_case code survives into `last_reason`; anything else could carry payload. */
const STABLE_CODE = /^[a-z0-9_]{1,64}$/;

/**
 * The stable word for why a delivery effect failed: a conflict's `conflictKind`
 * (`reservation_released`, `settled_with_different_actual`, …) is the finer discriminator
 * the settle surface promises; otherwise the error's own stable `code` (the delivery
 * error's); anything else is `delivery_failed` — never provider text.
 */
export function replayFailureCodeOf(error: unknown): string {
  const candidate =
    typeof error === "object" && error !== null
      ? ((error as { conflictKind?: unknown }).conflictKind ??
        (error as { code?: unknown }).code)
      : undefined;
  return typeof candidate === "string" && STABLE_CODE.test(candidate)
    ? candidate
    : "delivery_failed";
}

export type RecoveryReplay = {
  /**
   * Process ONE claimed RecoveryItem for the "result persisted but unacked" shape. The
   * caller must hold the item's claim (state `claimed`); every transition below is
   * guarded on that claim so a lost race writes nothing.
   */
  processClaimedItem(
    item: RecoveryItem,
    workerId: string,
  ): Promise<UnackedReplayResult>;
  /**
   * Claim up to `limit` pending RecoveryItems for `workerId` (08.1's atomic claim, so
   * concurrent workers receive disjoint sets) and process each. Items that are not the
   * persisted-result shape are released back to `pending` untouched — never lost, never
   * failure-counted.
   */
  replayUnackedResults(
    workerId: string,
    limit?: number,
  ): Promise<UnackedReplayBatch>;
};

export type RecoveryReplayDependencies = {
  database: Database;
  /** The usage outbox holding the persisted results; the real one over `database` by default. */
  outbox?: UsageOutbox;
  /**
   * The delivery effect a replay performs — the exact call the first delivery made.
   * Defaults to the production `createCreditUsageTarget(createCreditWriter(database))`:
   * the persisted facts settle the hold under `requestId = eventId`. Tests inject a
   * wrapper around the same effect to count or fail invocations.
   */
  settle?: (record: typeof usageOutbox.$inferSelect) => Promise<void>;
  /** The recovery scanner owning the claim; the real one over `database` by default. */
  scanner?: RecoveryScanner;
  /** Injectable clock; the app clock by default. */
  now?: () => Date;
  /** Operational log for retained failures; console by default. */
  log?: (message: string) => void;
};

function isNonEmptyIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

/** The batch counter each outcome increments (the outcome vocabulary is snake_case, the
 * batch keys camelCase — one explicit map so neither can drift from the other). */
const OUTCOME_COUNTER: Record<
  UnackedReplayOutcome,
  keyof Omit<UnackedReplayBatch, "claimed">
> = {
  replayed: "replayed",
  settled_ack_recovered: "settledAckRecovered",
  already_delivered: "alreadyDelivered",
  credits_blocked: "creditsBlocked",
  no_persisted_result: "noPersistedResult",
  failed: "failed",
};

export function createRecoveryReplay(
  dependencies: RecoveryReplayDependencies,
): RecoveryReplay {
  const { database } = dependencies;
  const outbox = dependencies.outbox ?? createUsageOutbox(database);
  const settle =
    dependencies.settle ??
    createCreditUsageTarget(createCreditWriter(database));
  const scanner = dependencies.scanner ?? createRecoveryScanner({ database });
  const now = () => dependencies.now?.() ?? new Date();
  // biome-ignore lint/suspicious/noConsole: stable-code operational log
  const log = dependencies.log ?? ((message: string) => console.warn(message));

  /** Resolve a claimed item: the terminal state 0148 added, claim attribution kept. */
  async function resolveItem(itemId: string, reason: string): Promise<void> {
    await database
      .update(creditRecoveryItems)
      .set({ state: "resolved", lastReason: reason, updatedAt: now() })
      .where(
        and(
          eq(creditRecoveryItems.id, itemId),
          eq(creditRecoveryItems.state, "claimed"),
        ),
      );
  }

  /**
   * Hand a claimed item back to `pending`. `countFailure` is true only for a FAILED
   * replay: the item is retained either way, the failure count moves only when a replay
   * actually failed. Guarded on the claim, so a worker that lost the race writes nothing.
   */
  async function releaseItem(
    itemId: string,
    reason: string,
    countFailure: boolean,
  ): Promise<void> {
    await database
      .update(creditRecoveryItems)
      .set({
        state: "pending",
        claimedAt: null,
        claimedBy: null,
        lastReason: reason,
        ...(countFailure
          ? { failureCount: sql`${creditRecoveryItems.failureCount} + 1` }
          : {}),
        updatedAt: now(),
      })
      .where(
        and(
          eq(creditRecoveryItems.id, itemId),
          eq(creditRecoveryItems.state, "claimed"),
        ),
      );
  }

  return {
    async processClaimedItem(item, workerId) {
      if (!isNonEmptyIdentifier(workerId, 512)) {
        throw new TypeError(
          "processClaimedItem: workerId must be a non-empty identifier of at most 512 characters",
        );
      }
      if (item.state !== "claimed") {
        throw new TypeError(
          "processClaimedItem: the item must be claimed (state 'claimed'); claim it via the recovery scanner first",
        );
      }

      // The persisted result (07.8): the outbox row carrying the reservation's identity
      // and exact actual cost. Oldest first, so one reservation with (in a malformed
      // world) several rows converges deterministically on the first-recorded fact.
      const [record] = await database
        .select()
        .from(usageOutbox)
        .where(eq(usageOutbox.reservationId, item.reservationId))
        .orderBy(asc(usageOutbox.createdAt), asc(usageOutbox.eventId))
        .limit(1);

      if (!record) {
        // Not this handler's shape: the hold's outcome was never persisted. The item is
        // retained untouched — back to pending, failure count unchanged, reason naming
        // why — for the handlers that own no-result holds (08.4's retry, 08.9's disposal).
        await releaseItem(item.id, REPLAY_RETAINED_REASON_NO_RESULT, false);
        return { outcome: "no_persisted_result", eventId: null };
      }

      // AC: 已确认送达的记录不会被重复投递 — the delivery status and the settle's own
      // idempotency are the two guards. A delivered record's settle already landed; the
      // hold it settled is terminal, so the item's recovery is complete.
      if (record.creditsStatus === "delivered") {
        await resolveItem(item.id, REPLAY_RESOLVED_REASON_ALREADY_DELIVERED);
        return { outcome: "already_delivered", eventId: record.eventId };
      }

      // The terminal manual-review state: nothing in the delivery path un-blocks a row,
      // and a recovery replay must not either. Retained for the evidenced disposal (08.9).
      if (record.creditsStatus === "blocked") {
        await releaseItem(item.id, REPLAY_RETAINED_REASON_BLOCKED, false);
        return { outcome: "credits_blocked", eventId: record.eventId };
      }

      // THE SHAPE 08.3 EXISTS FOR: the ledger already holds this reservation's settlement
      // and only the ACK was lost. This branch is a READ-ONLY convergence — verify the
      // hold's recorded actual IS the persisted result's own rational, backfill the ack,
      // close the item — with NO Settle effect invoked at all (the ticket's spy count 0:
      // 只补 ack、不补账). A settled hold carrying a DIFFERENT actual is not this record's
      // settlement converging; it is retained as a counted failure under the settle
      // surface's own stable kind, never acked against a settlement it cannot name.
      const [hold] = await database
        .select({
          status: creditReservations.status,
          actualNumerator: creditReservations.actualNumerator,
          actualDenominator: creditReservations.actualDenominator,
        })
        .from(creditReservations)
        .where(eq(creditReservations.id, item.reservationId))
        .limit(1);
      if (hold?.status === "settled") {
        // Exact-rational equality without normalizing either side: the writer stores its
        // actual in lowest terms and the outbox row carries the reported rational as it
        // arrived, so the cross-products — not the digit strings — are the comparison.
        const settledAtSameActual =
          hold.actualNumerator !== null &&
          hold.actualDenominator !== null &&
          record.actualCostNumerator !== null &&
          record.actualCostDenominator !== null &&
          BigInt(hold.actualNumerator) * BigInt(record.actualCostDenominator) ===
            BigInt(record.actualCostNumerator) * BigInt(hold.actualDenominator);
        if (settledAtSameActual) {
          await outbox.markCreditsDelivered(record.eventId);
          await resolveItem(item.id, REPLAY_RESOLVED_REASON_ACK_RECOVERED);
          return { outcome: "settled_ack_recovered", eventId: record.eventId };
        }
        const code = "settled_with_different_actual";
        log(
          `billing: recovery ack refused reservation=${item.reservationId} event=${record.eventId} code=${code}`,
        );
        await releaseItem(item.id, code, true);
        return { outcome: "failed", eventId: record.eventId, failureCode: code };
      }

      // THE SHAPE THIS TICKET EXISTS FOR: the result is persisted, the ack never arrived,
      // and the hold is still open. Replay the SAME delivery — same effect, same eventId
      // as requestId, the recorded exact rational — never a re-collection of usage, never
      // a new provider attempt.
      try {
        await settle(record);
        // The settle landed; write the ack the crash lost. If THIS fails, the catch
        // below retains the item honestly (the delivery did not complete) and the next
        // pass replays a settle that is now an idempotent no-op before acking again.
        await outbox.markCreditsDelivered(record.eventId);
      } catch (error) {
        const code = replayFailureCodeOf(error);
        log(
          `billing: recovery replay failed reservation=${item.reservationId} event=${record.eventId} code=${code}`,
        );
        // The outbox row's own attempt bookkeeping sees the failed delivery too (guarded
        // on its pending status, so a concurrent sweeper's ack stands).
        try {
          await outbox.recordDeliveryFailure(record.eventId, "credits", code);
        } catch {
          // The row's bookkeeping is secondary to the item's retention; a bookkeeping
          // failure here must not mask the replay failure the item already records.
        }
        await releaseItem(item.id, code, true);
        return { outcome: "failed", eventId: record.eventId, failureCode: code };
      }

      await resolveItem(item.id, REPLAY_RESOLVED_REASON_DELIVERED);
      return { outcome: "replayed", eventId: record.eventId };
    },

    async replayUnackedResults(workerId, limit = 10) {
      if (!isNonEmptyIdentifier(workerId, 512)) {
        throw new TypeError(
          "replayUnackedResults: workerId must be a non-empty identifier of at most 512 characters",
        );
      }
      if (!Number.isInteger(limit) || limit < 1) {
        throw new TypeError("replayUnackedResults: limit must be a positive integer");
      }
      // 08.1's claim: SELECT ... FOR UPDATE SKIP LOCKED inside one transaction, so
      // concurrent workers receive disjoint sets and each item is processed once per pass.
      const items = await scanner.claimRecoveryItems(workerId, limit);
      const batch: UnackedReplayBatch = {
        claimed: items.length,
        replayed: 0,
        settledAckRecovered: 0,
        alreadyDelivered: 0,
        creditsBlocked: 0,
        noPersistedResult: 0,
        failed: 0,
      };
      for (const item of items) {
        const result = await this.processClaimedItem(item, workerId);
        batch[OUTCOME_COUNTER[result.outcome]] += 1;
      }
      return batch;
    },
  };
}
