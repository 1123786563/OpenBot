import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { creditRecoveryItems } from "../db/schema/credit-reservations";
import { usageOutbox } from "../db/schema/usage-outbox";
import type { ProviderQueryRecovery } from "./recovery-provider-query";
import { QUERY_REASON } from "./recovery-provider-query";
import {
  createRecoveryReplay,
  REPLAY_RETAINED_REASON_BLOCKED,
  type RecoveryReplay,
} from "./recovery-replay";
import { createRecoveryScanner, type RecoveryScanner } from "./recovery-scan";

/*
 * The background retry for unknown-dispatch recovery items (Bifrost 08.4, #279): drive the
 * recovery lanes on a schedule that backs off, counts its failures, and knows when to stop.
 *
 * WHAT THIS MODULE IS. The scheduler the two lane handlers named but never had: 08.2's
 * replay (a PERSISTED result whose delivery never acked) and 08.5's provider final-state
 * query (a result nobody persisted, asked of a witness) both left a `queryFinalStates` /
 * `replayUnackedResults` batch entry for "08.4's scheduler" to drive. THIS is that
 * scheduler. One pass reads which pending items are DUE, routes each to the lane its own
 * facts select (a persisted outbox row → the replay; none → the query, when a source is
 * wired), and — the part the lanes could not do themselves — spaces the retries out:
 * every failed attempt stamps `next_retry_at = now + backoff(failure_count)`, so a
 * persistently failing item is re-attempted exponentially slower, not every sweep.
 *
 * WHAT A FAILURE IS. Only an attempt that FAILED TO FINISH counts: 08.2's `failed` (the
 * re-delivery itself threw — transport, conflict, anything) and 08.5's `still_unknown`
 * (the witness had nothing to say; an unreachable witness is not evidence of anything).
 * The lanes already increment `failure_count` for exactly these shapes and write the
 * stable snake_case code as `last_reason` (never provider text); the scheduler reads that
 * count back and schedules the NEXT attempt against it. A lane that answered conclusively
 * — the replay delivered, the query produced settled or no-charge EVIDENCE — resolved or
 * parked the item without counting anything, and the scheduler never re-arms those.
 *
 * THE MANUAL QUEUE IS A STOPPING RULE, NOT A TABLE. When `failure_count` reaches the
 * configured threshold, the failure path writes NO next retry (NULL) and the due-read's
 * `failure_count < threshold` gate keeps the scheduler away for good: the item stays
 * `pending` — which IS 08.9's review queue, the read that shows failureCount and
 * lastReason — and 08.6's alerting fires on the same threshold. Escalation adds no state
 * of its own because the state the AC asks for ("超过阈值后进入人工处置队列") is already
 * exactly "pending, unattemptable, over threshold": a second flag could disagree with
 * failure_count and a queue table could drift from the review read.
 *
 * THE MONEY IS NEVER TOUCHED HERE. The scheduler never releases, settles, re-admits or
 * re-dispatches: it claims items (08.1's atomic claim) and hands them to the lanes, whose
 * own contracts are already idempotent (06.x settle converges on the first terminal
 * result; the query only appends evidence). During every retry the hold keeps occupying
 * available credit — an `unknown` hold is released by nothing here, exactly as Q12
 * demands. Items whose lane already answered conclusively (settled evidence, no-charge
 * evidence, a blocked delivery row) are NOT re-claimed even though they sit `pending`:
 * they await 08.9's evidenced disposal, and re-driving them would only pile duplicate
 * evidence rows every sweep.
 *
 * THE QUERY LANE IS OPTIONAL BECAUSE IT HONESTLY CAN BE ABSENT. 08.5 refuses to exist
 * without a wired provider final-state source (an unwired capability must refuse, not
 * fabricate still-unknown answers from nothing); no deployment wires one today. Without
 * the lane the scheduler drives the replay lane alone — persisted results still converge
 * — and no-result items are skipped WITHOUT a claim or a failure count: nothing can be
 * asked of nobody, and their voice is the dwell alerting on the review queue until a
 * source exists.
 */

/** The retry policy, every knob deployment-tunable (the Resume hint: intervals and
 * thresholds must be configurable, never buried as literals). */
export type RecoveryRetryConfig = {
  /** The delay after the FIRST failure; the base the backoff grows from. */
  baseIntervalMs: number;
  /** What each further failure multiplies the delay by (1 = flat spacing, a choice). */
  backoffMultiplier: number;
  /** The ceiling the backoff never exceeds, however many failures accumulate. */
  maxIntervalMs: number;
  /** failureCount at or beyond this: no more retries, the manual queue only. */
  failureThreshold: number;
  /** How many due items one pass claims at most (the bounded-batch discipline). */
  batchLimit: number;
};

export const DEFAULT_RECOVERY_RETRY_CONFIG: RecoveryRetryConfig = {
  baseIntervalMs: 60_000,
  backoffMultiplier: 2,
  maxIntervalMs: 60 * 60_000,
  failureThreshold: 5,
  batchLimit: 25,
};

/**
 * The backoff for the attempt AFTER the one that left the item with `failureCount`
 * failures: base × multiplier^(failureCount − 1), capped at maxIntervalMs. Computed by
 * repeated multiplication that stops at the cap so a large count cannot overflow into
 * Infinity — the answer for failureCount 1000 is the cap, not 2^1000.
 */
export function retryBackoffMs(
  failureCount: number,
  config: RecoveryRetryConfig,
): number {
  if (!Number.isInteger(failureCount) || failureCount < 1) {
    throw new TypeError(
      "retryBackoffMs: failureCount must be a positive integer (the failure path schedules only after a counted failure)",
    );
  }
  let delay = config.baseIntervalMs;
  for (let i = 1; i < failureCount && delay < config.maxIntervalMs; i += 1) {
    delay *= config.backoffMultiplier;
  }
  return Math.min(config.maxIntervalMs, Math.round(delay));
}

/** Merge a deployment's overrides over the defaults, refusing nonsense: a retry policy
 * that cannot space anything out is a wiring bug, not a policy. */
export function resolveRecoveryRetryConfig(
  override?: Partial<RecoveryRetryConfig>,
): RecoveryRetryConfig {
  const config = { ...DEFAULT_RECOVERY_RETRY_CONFIG, ...override };
  const invalid = [
    !Number.isInteger(config.baseIntervalMs) || config.baseIntervalMs < 1,
    !Number.isFinite(config.backoffMultiplier) || config.backoffMultiplier < 1,
    !Number.isInteger(config.maxIntervalMs) ||
      config.maxIntervalMs < config.baseIntervalMs,
    !Number.isInteger(config.failureThreshold) || config.failureThreshold < 1,
    !Number.isInteger(config.batchLimit) || config.batchLimit < 1,
  ].some(Boolean);
  if (invalid) {
    throw new TypeError(
      "createRecoveryRetry: the retry config must have baseIntervalMs >= 1ms, backoffMultiplier >= 1, maxIntervalMs >= baseIntervalMs, failureThreshold >= 1 and batchLimit >= 1 — a policy that cannot space retries out is a wiring bug, not a policy",
    );
  }
  return config;
}

/**
 * The lastReason codes that mean a lane answered conclusively and the item now waits for
 * 08.9's evidenced disposal — NOT for another retry. Re-driving these would append
 * duplicate evidence rows every sweep without ever moving the item.
 */
const AWAITING_DISPOSAL_REASONS: readonly string[] = [
  QUERY_REASON.settledEvidence,
  QUERY_REASON.noChargeEvidence,
  REPLAY_RETAINED_REASON_BLOCKED,
];

/** What one retry pass did, for the sweep's logs and the tests' assertions. */
export type RecoveryRetryBatch = {
  ranAt: string;
  /** Items the due-read found (its own ceiling is batchLimit). */
  due: number;
  /** Items this pass claimed and handed to a lane. */
  claimed: number;
  /** Claims lost to another worker between the due-read and the claim — normal answers. */
  raced: number;
  replayed: number;
  settledAckRecovered: number;
  alreadyDelivered: number;
  creditsBlocked: number;
  /** Replay-lane failures: failure_count grew, a retry was scheduled or the item escalated. */
  replayFailed: number;
  queryStillUnknown: number;
  querySettledEvidence: number;
  queryNoChargeEvidence: number;
  /** No-result items with no wired query lane: skipped untouched, no claim, no count. */
  skippedNoQueryLane: number;
  /** Failures whose backoff was stamped (next_retry_at set). */
  retryScheduled: number;
  /** Failures whose count reached the threshold: no next retry, manual queue only. */
  escalatedToManual: number;
};

export type RecoveryRetryScheduler = {
  /**
   * One pass: read the due items, route each to its lane, schedule the backoff (or the
   * escalation) for every failure. One item's failure never stops the pass. Safe to run
   * concurrently — the claim is 08.1's atomic one — and re-runnable: a second pass over
   * the same items claims only what is due and unclaimed.
   */
  runRetryPass(workerId: string): Promise<RecoveryRetryBatch>;
};

export type RecoveryRetryDependencies = {
  database: Database;
  /** The persisted-result lane (08.2); the real one over `database` by default. */
  replay?: RecoveryReplay;
  /** The provider final-state lane (08.5), present only where a source is wired. */
  providerQuery?: ProviderQueryRecovery;
  /** The scanner owning the claim; 08.1's over the same database by default. */
  scanner?: RecoveryScanner;
  /** Injectable clock; the app clock by default. The tests' handle on time. */
  now?: () => Date;
  /** Stable-code operational log (no driver error text); console.warn by default. */
  log?: (message: string) => void;
  /** Deployment overrides over the default retry policy. */
  config?: Partial<RecoveryRetryConfig>;
};

export function createRecoveryRetry(
  dependencies: RecoveryRetryDependencies,
): RecoveryRetryScheduler {
  const { database } = dependencies;
  const replay = dependencies.replay ?? createRecoveryReplay({ database });
  const providerQuery = dependencies.providerQuery;
  const scanner = dependencies.scanner ?? createRecoveryScanner({ database });
  const config = resolveRecoveryRetryConfig(dependencies.config);
  const now = () => dependencies.now?.() ?? new Date();
  // biome-ignore lint/suspicious/noConsole: stable-code operational log
  const log = dependencies.log ?? ((message: string) => console.warn(message));

  /**
   * What the failure path does with the item it just failed: below the threshold, stamp
   * the backoff; at or beyond it, write NULL (no next retry) — the manual queue owns the
   * item from there. Guarded on `pending`: the lane already handed the item back, and a
   * claim another worker won in between means that worker owns the schedule now.
   */
  async function scheduleAfterFailure(
    itemId: string,
    failureCountAfter: number,
  ): Promise<"scheduled" | "escalated"> {
    const at = now();
    if (failureCountAfter >= config.failureThreshold) {
      await database
        .update(creditRecoveryItems)
        .set({ nextRetryAt: null, updatedAt: at })
        .where(
          and(
            eq(creditRecoveryItems.id, itemId),
            eq(creditRecoveryItems.state, "pending"),
          ),
        );
      log(
        `billing: recovery retry exhausted item=${itemId} failures=${failureCountAfter} manual-queue`,
      );
      return "escalated";
    }
    await database
      .update(creditRecoveryItems)
      .set({
        nextRetryAt: new Date(
          at.getTime() + retryBackoffMs(failureCountAfter, config),
        ),
        updatedAt: at,
      })
      .where(
        and(
          eq(creditRecoveryItems.id, itemId),
          eq(creditRecoveryItems.state, "pending"),
        ),
      );
    return "scheduled";
  }

  return {
    async runRetryPass(workerId) {
      if (
        typeof workerId !== "string" ||
        workerId.length === 0 ||
        workerId.length > 512 ||
        workerId.trim() !== workerId
      ) {
        throw new TypeError(
          "runRetryPass: workerId must be a non-empty identifier of at most 512 characters",
        );
      }
      const at = now();
      const batch: RecoveryRetryBatch = {
        ranAt: at.toISOString(),
        due: 0,
        claimed: 0,
        raced: 0,
        replayed: 0,
        settledAckRecovered: 0,
        alreadyDelivered: 0,
        creditsBlocked: 0,
        replayFailed: 0,
        queryStillUnknown: 0,
        querySettledEvidence: 0,
        queryNoChargeEvidence: 0,
        skippedNoQueryLane: 0,
        retryScheduled: 0,
        escalatedToManual: 0,
      };

      // --- The due-read: pending items the policy still allows to attempt, whose
      // backoff (if any) has elapsed, oldest detection first, bounded by batchLimit.
      // The read is advisory only — the lanes' own handbacks remain the routing of
      // record, and the claim below is the atomic one, so a replica racing this pass is
      // a normal answer (raced), never a double process.
      const dueRows = await database
        .select({
          id: creditRecoveryItems.id,
          reservationId: creditRecoveryItems.reservationId,
          failureCount: creditRecoveryItems.failureCount,
        })
        .from(creditRecoveryItems)
        .where(
          and(
            eq(creditRecoveryItems.state, "pending"),
            sql`${creditRecoveryItems.failureCount} < ${config.failureThreshold}`,
            or(
              isNull(creditRecoveryItems.nextRetryAt),
              lte(creditRecoveryItems.nextRetryAt, at),
            ),
            sql`(${creditRecoveryItems.lastReason} IS NULL OR ${creditRecoveryItems.lastReason} NOT IN (${sql.join(
              AWAITING_DISPOSAL_REASONS.map((reason) => sql`${reason}`),
              sql`, `,
            )}))`,
          ),
        )
        .orderBy(
          asc(creditRecoveryItems.detectedAt),
          asc(creditRecoveryItems.id),
        )
        .limit(config.batchLimit);
      batch.due = dueRows.length;

      // --- The routing fact, read plainly: which due reservations have a persisted
      // result (08.2's lane) and which do not (08.5's). One DISTINCT read over the
      // batch's own reservations — the same fact both lanes consult, gathered here only
      // to decide whom to hand each item to; the lanes still route by their own reads
      // when they process it.
      const persistedReservations =
        dueRows.length === 0
          ? new Set<string>()
          : new Set(
              (
                await database
                  .selectDistinct({ reservationId: usageOutbox.reservationId })
                  .from(usageOutbox)
                  .where(
                    inArray(
                      usageOutbox.reservationId,
                      dueRows.map((row) => row.reservationId),
                    ),
                  )
              ).map((row) => row.reservationId),
            );

      for (const row of dueRows) {
        const replayShape = persistedReservations.has(row.reservationId);
        // No persisted result and no wired witness: nothing can be asked of nobody.
        // Untouched — no claim churn, no failure count; the dwell alerting is the voice.
        if (!replayShape && !providerQuery) {
          batch.skippedNoQueryLane += 1;
          continue;
        }

        const item = await scanner.claimRecoveryItem(row.id, workerId);
        if (!item) {
          batch.raced += 1;
          continue;
        }
        batch.claimed += 1;

        if (replayShape) {
          const result = await replay.processClaimedItem(item, workerId);
          switch (result.outcome) {
            case "replayed":
              batch.replayed += 1;
              break;
            case "settled_ack_recovered":
              batch.settledAckRecovered += 1;
              break;
            case "already_delivered":
              batch.alreadyDelivered += 1;
              break;
            case "credits_blocked":
              batch.creditsBlocked += 1;
              break;
            case "failed": {
              batch.replayFailed += 1;
              const scheduled = await scheduleAfterFailure(
                item.id,
                row.failureCount + 1,
              );
              if (scheduled === "escalated") {
                batch.escalatedToManual += 1;
              } else {
                batch.retryScheduled += 1;
              }
              break;
            }
            // The outbox row the due-read saw vanished before the claim (the outbox is
            // append-only: a defect, not a shape) — the replay handed the item back
            // untouched; nothing is counted, nothing is scheduled.
            case "no_persisted_result":
              break;
          }
        } else if (providerQuery) {
          // The guard above skipped no-witness items; the else-if keeps that fact true
          // for the compiler as well as the reader.
          const result = await providerQuery.processClaimedItem(item, workerId);
          switch (result.outcome) {
            case "still_unknown": {
              batch.queryStillUnknown += 1;
              const scheduled = await scheduleAfterFailure(
                item.id,
                row.failureCount + 1,
              );
              if (scheduled === "escalated") {
                batch.escalatedToManual += 1;
              } else {
                batch.retryScheduled += 1;
              }
              break;
            }
            case "settled_evidence":
              batch.querySettledEvidence += 1;
              break;
            case "no_charge_evidence":
              batch.queryNoChargeEvidence += 1;
              break;
            // The outbox gained a persisted result between the due-read and the claim —
            // the query handed the item back untouched for the replay, which the next
            // due pass routes to. Nothing counted, nothing is scheduled.
            case "replay_lane":
              break;
          }
        }
      }

      return batch;
    },
  };
}
