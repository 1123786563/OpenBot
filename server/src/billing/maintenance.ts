/**
 * The usage delivery sweeper, in the payment sweeper's shape (./payments/maintenance.ts): a delayed
 * first pass, then an interval, timers unref'd so housekeeping never holds the process open. Passes
 * never overlap, and a failed pass is logged by error name only and retried on the next tick.
 *
 * One server sweeps at a time, across replicas (audit C3). Every replica runs the same interval,
 * and although the delivery targets are idempotent, N replicas means N times the provider calls
 * and N times the row contention for the same work — so each pass runs under the Postgres
 * session-scoped advisory lock `withSweepLock` takes below, on the pattern
 * ../../audit-retention.ts already proves with its SWEEP_LOCK = 4_192_004. The keys 4_192_004
 * (audit retention, audit-retention.ts), 4_192_005 (usage delivery, this file) and 4_192_006
 * (payments, ./payments/maintenance.ts) are reserved and must not be reused: two sweepers sharing
 * a key would silently skip each other's passes.
 *
 * Started in production by the billing assembly (server/src/index.ts wires
 * `startUsageDeliverySweeps` whenever the usage outbox exists) — the delivery targets it
 * sweeps are the Lago and credits targets that same assembly builds.
 */
import postgres from "postgres";
import type { UsageDelivery } from "./usage-delivery";

/** Where a sweep's single-instance guard runs: one dedicated connection, one advisory lock key. */
export type SweepLock = { databaseUrl: string; key: number };

/**
 * Run one sweep pass under an advisory lock, or skip it when another replica holds the lock.
 * Absent lock config, the pass runs unguarded — a single-replica deployment and the tests do
 * not need a second database connection to work.
 */
export async function withSweepLock<T>(
  lock: SweepLock | undefined,
  work: () => Promise<T>,
): Promise<T | undefined> {
  if (!lock) return await work();

  // Session-scoped, on a connection this pass owns for its length. It cannot go through the
  // shared pool: a session lock belongs to one connection, so a pool would happily take it on
  // one and try to release it on another, and the lock would leak until that connection died.
  const connection = postgres(lock.databaseUrl, { max: 1 });

  try {
    const [row] =
      await connection`select pg_try_advisory_lock(${lock.key}) as held`;
    if (!row?.held) return undefined;
    return await work();
  } finally {
    // Ending the connection releases the lock with it, so a pass that threw halfway (or a
    // process that died mid-pass) does not leave the lock held and every later sweep skipped.
    await connection.end({ timeout: 5 }).catch(() => undefined);
  }
}

export function startUsageDeliverySweeps(
  delivery: UsageDelivery,
  options: {
    intervalMs?: number;
    firstRunMs?: number;
    limit?: number;
    log?: (message: string) => void;
    lock?: SweepLock;
  } = {},
): { stop(): void } {
  const intervalMs = options.intervalMs ?? 30_000;
  const firstRunMs = options.firstRunMs ?? 30_000;
  const limit = options.limit ?? 100;
  const lock = options.lock;
  // biome-ignore lint/suspicious/noConsole: stable-code operational log
  const log = options.log ?? ((message: string) => console.warn(message));
  const timers: ReturnType<typeof setTimeout>[] = [];
  let running = false;

  const run = () => {
    if (running) return;
    running = true;
    void withSweepLock(lock, () => delivery.runBatch(limit))
      .catch((error: unknown) => {
        log(
          `billing: usage delivery pass failed error=${
            error instanceof Error ? error.name : "unknown"
          }`,
        );
      })
      .finally(() => {
        running = false;
      });
  };

  const first = setTimeout(() => {
    run();
    const repeating = setInterval(run, intervalMs);
    repeating.unref?.();
    timers.push(repeating);
  }, firstRunMs);
  first.unref?.();
  timers.push(first);

  return {
    stop: () => {
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

/**
 * The renewal sweep (10.3), in the payment sweeper's shape: a delayed first pass, then an
 * interval, timers unref'd so housekeeping never holds the process open. The webhook path pays
 * a period the moment its notification arrives; this pass asks the provider directly about
 * every live owned subscription, so a period whose notification never arrived still pays and a
 * grant that failed after a delivery still retries — the ledger's `plan-renewal:` key and the
 * forward-only allowance marker make every re-run a no-op.
 *
 * One server sweeps at a time, across replicas, under the Postgres advisory lock the other
 * sweeps use. The key 4_192_007 is reserved for this sweep (4_192_004 audit retention,
 * 4_192_005 usage delivery, 4_192_006 payments) and must not be reused.
 */
export function startBillingRenewalSweeps(
  service: { sweepRenewals(): Promise<void> },
  options: {
    intervalMs?: number;
    firstRunMs?: number;
    log?: (message: string) => void;
    lock?: SweepLock;
  } = {},
): { stop(): void } {
  const intervalMs = options.intervalMs ?? 60_000;
  const firstRunMs = options.firstRunMs ?? 60_000;
  const lock = options.lock;
  // biome-ignore lint/suspicious/noConsole: stable-code operational log
  const log = options.log ?? ((message: string) => console.warn(message));
  const timers: ReturnType<typeof setTimeout>[] = [];
  let running = false;

  const run = () => {
    if (running) return;
    running = true;
    void withSweepLock(lock, () => service.sweepRenewals())
      .catch((error: unknown) => {
        log(
          `billing: renewal sweep pass failed error=${
            error instanceof Error ? error.name : "unknown"
          }`,
        );
      })
      .finally(() => {
        running = false;
      });
  };

  const first = setTimeout(() => {
    run();
    const repeating = setInterval(run, intervalMs);
    repeating.unref?.();
    timers.push(repeating);
  }, firstRunMs);
  first.unref?.();
  timers.push(first);

  return {
    stop: () => {
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

/**
 * The recovery scan sweep (Bifrost 08.1), in the same shape again: a delayed first pass,
 * then an interval, timers unref'd, never overlapping, a failed pass logged by error name
 * and retried on the next tick. Each pass asks the scanner to discover holds whose provider
 * result nobody knows — 06.8's unknown marks and the expired plain holds a killed process
 * left behind — and to name each once in `credit_recovery_items`. The scan's own writes are
 * already idempotent (one item per reservation, ever), so even without the lock two
 * replicas could not duplicate an item; the lock exists so N replicas do not run N identical
 * discovery reads every interval (audit C3's shape).
 *
 * The key 4_192_008 is reserved for this sweep (4_192_004 audit retention, 4_192_005 usage
 * delivery, 4_192_006 payments, 4_192_007 renewal) and must not be reused: two sweepers
 * sharing a key would silently skip each other's passes.
 */
export function startRecoveryScanSweeps(
  scanner: {
    scanOnce(): Promise<{ itemsGenerated: number }>;
  },
  options: {
    intervalMs?: number;
    firstRunMs?: number;
    log?: (message: string) => void;
    lock?: SweepLock;
  } = {},
): { stop(): void } {
  const intervalMs = options.intervalMs ?? 60_000;
  const firstRunMs = options.firstRunMs ?? 60_000;
  const lock = options.lock;
  // biome-ignore lint/suspicious/noConsole: stable-code operational log
  const log = options.log ?? ((message: string) => console.warn(message));
  const timers: ReturnType<typeof setTimeout>[] = [];
  let running = false;

  const run = () => {
    if (running) return;
    running = true;
    void withSweepLock(lock, () => scanner.scanOnce())
      .then((pass) => {
        if (pass && pass.itemsGenerated > 0) {
          log(
            `billing: recovery scan named ${pass.itemsGenerated} unknown-dispatch hold(s)`,
          );
        }
      })
      .catch((error: unknown) => {
        log(
          `billing: recovery scan pass failed error=${
            error instanceof Error ? error.name : "unknown"
          }`,
        );
      })
      .finally(() => {
        running = false;
      });
  };

  const first = setTimeout(() => {
    run();
    const repeating = setInterval(run, intervalMs);
    repeating.unref?.();
    timers.push(repeating);
  }, firstRunMs);
  first.unref?.();
  timers.push(first);

  return {
    stop: () => {
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

/**
 * The recovery retry sweep (Bifrost 08.4, #279): the background driver that hands the
 * recovery lanes their items on a schedule — the same shape as the scan sweep above. Each
 * pass reads the pending items whose backoff has elapsed and whose failure count is still
 * below the threshold, routes each to its lane (a persisted result to 08.2's replay; a
 * no-result item to 08.5's provider query where a source is wired), and stamps the next
 * retry's backoff on every failure. The pass itself is safe to race — the claim is 08.1's
 * atomic one — and the lock exists for the same reason as the scan's: N replicas should
 * not run N identical due-reads every interval (audit C3's shape).
 *
 * The key 4_192_009 is reserved for this sweep and must not be reused: two sweepers
 * sharing a key would silently skip each other's passes.
 */
export function startRecoveryRetrySweeps(
  retry: {
    runRetryPass(workerId: string): Promise<{
      due: number;
      escalatedToManual: number;
    }>;
  },
  options: {
    workerId?: string;
    intervalMs?: number;
    firstRunMs?: number;
    log?: (message: string) => void;
    lock?: SweepLock;
  } = {},
): { stop(): void } {
  const workerId =
    options.workerId ??
    `recovery-retry-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const intervalMs = options.intervalMs ?? 60_000;
  const firstRunMs = options.firstRunMs ?? 90_000;
  const lock = options.lock;
  // biome-ignore lint/suspicious/noConsole: stable-code operational log
  const log = options.log ?? ((message: string) => console.warn(message));
  const timers: ReturnType<typeof setTimeout>[] = [];
  let running = false;

  const run = () => {
    if (running) return;
    running = true;
    void withSweepLock(lock, () => retry.runRetryPass(workerId))
      .then((batch) => {
        if (batch && batch.escalatedToManual > 0) {
          log(
            `billing: recovery retry pass due=${batch.due} escalated=${batch.escalatedToManual} to manual queue`,
          );
        }
      })
      .catch((error: unknown) => {
        log(
          `billing: recovery retry pass failed error=${
            error instanceof Error ? error.name : "unknown"
          }`,
        );
      })
      .finally(() => {
        running = false;
      });
  };

  const first = setTimeout(() => {
    run();
    const repeating = setInterval(run, intervalMs);
    repeating.unref?.();
    timers.push(repeating);
  }, firstRunMs);
  first.unref?.();
  timers.push(first);

  return {
    stop: () => {
      for (const timer of timers) clearTimeout(timer);
    },
  };
}
