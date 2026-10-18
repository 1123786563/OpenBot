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
 * The one connection a lock pass owns for its length: a tagged-template query handle plus the
 * `end` that releases the session-scoped lock. Shaped like the postgres.js handle the default
 * factory returns, so an injected factory can stand in for a real database in tests without a
 * process-global module mock (bun's mock.module cannot be undone and would poison every later
 * test file in the same run).
 */
export type SweepLockConnection = {
  (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): PromiseLike<Record<string, unknown>[]>;
  end: (options?: { timeout?: number }) => Promise<void>;
};

/** How a lock pass opens its dedicated connection. Injectable for the same reason as above. */
export type SweepLockConnector = (databaseUrl: string) => SweepLockConnection;

const postgresLockConnector: SweepLockConnector = (databaseUrl) =>
  // The Sql handle is structurally the query-callable plus `end` (plus extras the lock pass
  // never touches); the cast keeps this module's public type free of postgres.js's private
  // thenable plumbing.
  postgres(databaseUrl, { max: 1 }) as unknown as SweepLockConnection;

/**
 * Run one sweep pass under an advisory lock, or skip it when another replica holds the lock.
 * Absent lock config, the pass runs unguarded — a single-replica deployment and the tests do
 * not need a second database connection to work.
 */
export async function withSweepLock<T>(
  lock: SweepLock | undefined,
  work: () => Promise<T>,
  connect: SweepLockConnector = postgresLockConnector,
): Promise<T | undefined> {
  if (!lock) return await work();

  // Session-scoped, on a connection this pass owns for its length. It cannot go through the
  // shared pool: a session lock belongs to one connection, so a pool would happily take it on
  // one and try to release it on another, and the lock would leak until that connection died.
  const connection = connect(lock.databaseUrl);

  try {
    const [row] =
      (await connection`select pg_try_advisory_lock(${lock.key}) as held`) as Record<
        string,
        unknown
      >[];
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
    /** Overrides how a lock pass opens its dedicated connection; tests inject a fake here. */
    connect?: SweepLockConnector;
  } = {},
): { stop(): void } {
  const intervalMs = options.intervalMs ?? 30_000;
  const firstRunMs = options.firstRunMs ?? 30_000;
  const limit = options.limit ?? 100;
  const lock = options.lock;
  const connect = options.connect;
  // biome-ignore lint/suspicious/noConsole: stable-code operational log
  const log = options.log ?? ((message: string) => console.warn(message));
  const timers: ReturnType<typeof setTimeout>[] = [];
  let running = false;

  const run = () => {
    if (running) return;
    running = true;
    void withSweepLock(lock, () => delivery.runBatch(limit), connect)
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
