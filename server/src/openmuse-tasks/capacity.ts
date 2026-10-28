/**
 * O04 (contracts §10 rows 4–6, issue #91): the Task queue's two bounds.
 *
 * Task 0 citations, recorded rather than re-derived:
 *
 *  - work/queue.ts `claim` selects `run_at asc` with `for update skip locked`
 *    and a database-clock lease: any number of workers take disjoint due
 *    items, oldest due first, and a leased item is invisible to claims until
 *    its lease expires. The order is NOT owner-fair — no owner rotation
 *    anywhere in the claim.
 *  - FAIRNESS DECISION: oldest-first cannot starve a user behind the per-user
 *    cap this same ticket enforces. A claimed item is executed and finished by
 *    the claiming sweep — the head of the line is always being consumed, never
 *    parked — and one owner holds at most 100 active Tasks (below), so another
 *    owner's runnable Task waits a bounded number of item-runs behind them,
 *    never indefinitely. A true owner-round-robin would live in the shared
 *    claim query (work/queue.ts, every kind's), which O04 does not own;
 *    recorded for O05's visibility rather than faked here.
 *
 * The worker bound is per process — the unit the runner's sweep owns. The
 * queue's lease already keeps two processes off one item;
 * OPENMUSE_TASK_WORKERS caps how many items one process runs at once. A
 * sweep claims ONE item at a time — each claim made only when its execution
 * is next, so its lease spans its own run — and loops until no worker slot
 * is free or the queue hands out nothing more: one sweep call runs up to
 * the free-slot count, production's repeatAfterEach wiring then re-sweeps.
 *
 * The per-user bound ports the OpenMuse service limit verbatim
 * (apps/server/src/engine/service.ts createTask): 100 non-terminal Tasks, the
 * 101st answered with the same message, terminal statuses never counting.
 * The create path reads it as one count query (the rows seam's
 * countActiveByOwner), never a page scan of the jsonb-heavy rows.
 */

/** §10 row 5: how many active (non-terminal) Tasks one user may hold. */
export const ACTIVE_TASKS_PER_USER = 100;

/**
 * T07's attempt bound (one fresh attempt plus exactly one recovery): the
 * number the runner's queue claim hands the work queue, exported (round 6
 * M34) so the ops signals reader can tell an awaiting-worker row from a
 * row whose retries are exhausted — the latter is a terminal state the
 * claim will never hand out again, not a stuck task.
 */
export const OPENMUSE_TASK_MAX_ATTEMPTS = 2;

/** §10 row 4: concurrent Task workers per process, when the env does not say. */
export const DEFAULT_TASK_WORKERS = 4;

/**
 * §10 row 5's failure, the legacy service's exact message: a 409 that says
 * what to do, never a silent drop.
 */
export const TASK_LIMIT_MESSAGE =
  "Finish or cancel some tasks before adding more";

export type TaskWorkerCapacity = {
  /**
   * How many items this sweep may claim next: one per free worker slot (a
   * sweep runs its claims one at a time, so more than one claim would
   * outlive the lease it was claimed under; the sweep's claim loop is what
   * turns "one at a time" into "up to the free slots per sweep"), zero when
   * the cap is full.
   */
  claimLimit(): number;
  /** Occupy one worker slot; false means the cap is full. */
  begin(): boolean;
  /** Free one worker slot, when its item settles. */
  end(): void;
};

export function taskWorkerCapacity(options?: {
  /** §10 row 4's bound; defaults to OPENMUSE_TASK_WORKERS, default 4. */
  maxWorkers?: number;
}): TaskWorkerCapacity {
  const raw = process.env.OPENMUSE_TASK_WORKERS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  // A whole number of workers or the default: 4.5 workers is 4, not a
  // fractional slot the comparisons treat as an extra nobody can take.
  const wholeWorkers =
    Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Number.NaN;
  const maxWorkers =
    options?.maxWorkers ??
    (Number.isSafeInteger(wholeWorkers) && wholeWorkers > 0
      ? wholeWorkers
      : DEFAULT_TASK_WORKERS);
  let running = 0;
  return {
    claimLimit() {
      return running >= maxWorkers ? 0 : 1;
    },
    begin() {
      if (running >= maxWorkers) return false;
      running += 1;
      return true;
    },
    end() {
      running = Math.max(0, running - 1);
    },
  };
}
