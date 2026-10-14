import { getLogger } from "../../../shared/logger";
import type { Database } from "../db/client";
import type { ReviewedActionRows } from "../openmuse-reviewed-actions/store";
import type { OpenMuseTaskStore } from "../openmuse-tasks/store";
import { recordDeletionResources } from "./store";

const log = getLogger("server");

/**
 * D02's best-effort T12 emit seam, the runner's `OpenMuseNotificationEmit`
 * shape. `task.cancelled` is in the notifications store's enumeration now;
 * the seam's `eventKind` stays a string so the assembly can adapt (the real
 * store's emit takes the DELETION-FENCE BYPASS for these — the owner is
 * fenced by the time a shutdown fires, and without the bypass every emit
 * would throw and the notice could never land).
 */
export type OpenMuseWorkShutdownEmit = (event: {
  userId: string;
  taskId: string;
  eventKind: string;
  attemptKey: string;
  title: string;
  detail?: string;
}) => Promise<unknown>;

/** What the shutdown landed, by id — the marker's bookkeeping input. */
export type OpenMuseWorkShutdownReport = {
  tasksCancelled: string[];
  tasksCancelRequested: string[];
  reviewedCancelled: string[];
};

/**
 * The §9 work shutdown the delete route runs after D01's marker: Tasks and
 * Monitors bulk-transition (running rows only raise the §7 cancellation
 * flag — the sweep's post-turn finalize lands them cancelled), awaiting
 * Reviewed actions cancel (executing rows stay untouched for R04's
 * reconciliation), the transition ids land in the marker's resources
 * (bookkeeping only), and each landed Task cancellation emits a
 * best-effort notification that can never fail the shutdown.
 */
export function createOpenMuseWorkShutdown(deps: {
  tasks: Pick<OpenMuseTaskStore, "shutdownOwner">;
  reviewed: Pick<ReviewedActionRows, "cancelAwaiting">;
  /** The marker's bookkeeping seam; absent in tests that pin the rest. */
  record?: (ownerUserId: string, transitions: string[]) => Promise<unknown>;
  emit?: OpenMuseWorkShutdownEmit;
}) {
  return async function shutdownOwnerWork(
    userId: string,
  ): Promise<OpenMuseWorkShutdownReport> {
    const tasks = await deps.tasks.shutdownOwner(userId);
    const reviewedCancelled = await deps.reviewed.cancelAwaiting(userId);
    const transitions = [
      ...tasks.cancelled.map((id) => `openmuse-task:${id}:cancelled`),
      ...tasks.cancelRequested.map(
        (id) => `openmuse-task:${id}:cancel-requested`,
      ),
      ...reviewedCancelled.map(
        (id) => `openmuse-reviewed-action:${id}:cancelled`,
      ),
    ];
    if (transitions.length > 0 && deps.record) {
      try {
        await deps.record(userId, transitions);
      } catch (error) {
        /*
         * The rows already landed cancelled — the state-guarded UPDATEs above
         * will not match them again, so a RETRY of this shutdown finds an
         * empty transitions list and would report ok, silently masking this
         * failure and losing the marker's append-only evidence. Fail loudly
         * with the landed ids carried in the message: the route records the
         * step failed (G06-sanitized), and the ids are what a compensating
         * append of marker.resources replays from.
         *
         * Round 6 (M17): the full id list is ALSO logged server-side here,
         * because the route's G06 display guard truncates the message to 120
         * chars — past that, the thrown sentence is the only place the ids
         * exist, and the retry's empty-transitions ok would erase them. The
         * log outlives the display guard; the compensation replays from it.
         */
        log.error(
          {
            type: "openmuse-work-shutdown-record-failed",
            userId,
            transitions,
            error: error instanceof Error ? error.message : String(error),
          },
          "openmuse-work-shutdown-record-failed",
        );
        throw new Error(
          `Failed recording ${transitions.length} shutdown transitions for ${userId} (${transitions.join(", ")}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    // Only rows whose status actually landed cancelled emit — a running row
    // is still publicly running until its sweep finalizes it. The emits are
    // mutually independent and each is individually best-effort, so they fan
    // out concurrently: a bulk shutdown costs one round-trip of latency, not
    // one per cancelled Task.
    await Promise.all(
      tasks.cancelled.map(async (taskId) => {
        try {
          await deps.emit?.({
            userId,
            taskId,
            eventKind: "task.cancelled",
            attemptKey: "shutdown",
            title: "Task cancelled",
            detail: "Cancelled by account deletion.",
          });
        } catch (error) {
          // Logged and swallowed: an unreachable notification store must not
          // unwind a transition that already landed on the row.
          log.error(
            {
              type: "openmuse-work-shutdown-emit-failed",
              taskId,
              error: error instanceof Error ? error.message : String(error),
            },
            "openmuse-work-shutdown-emit-failed",
          );
        }
      }),
    );
    return {
      tasksCancelled: tasks.cancelled,
      tasksCancelRequested: tasks.cancelRequested,
      reviewedCancelled,
    };
  };
}

/**
 * The drizzle bookkeeping: append the shutdown's transition entries to the
 * marker's `resources` array. D04's manifest later enumerates from it; D02
 * only records what landed. (The append itself is the one D02/D03 share —
 * see {@link recordDeletionResources}.)
 */
export function recordWorkShutdown(
  database: Database,
): (userId: string, transitions: string[]) => Promise<void> {
  return recordDeletionResources(database);
}
