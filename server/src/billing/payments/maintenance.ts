/**
 * The payment sweeper: one pass, then an interval, in the retention sweeps' shape
 * (../../audit-retention.ts) — starting shortly after boot rather than in the middle of it, the
 * timer unref'd so housekeeping never holds the process open.
 *
 * One server sweeps at a time, across replicas (audit C3), under the same session-scoped
 * advisory-lock guard ../maintenance.ts's `withSweepLock` takes (key 4_192_006 here). The keys
 * 4_192_004 (audit retention, ../../audit-retention.ts), 4_192_005 (usage delivery,
 * ../maintenance.ts) and 4_192_006 (payments, this file) are reserved and must not be reused:
 * two sweepers sharing a key would silently skip each other's passes.
 *
 * The pass is query-first by design. A pending order past its TTL is ASKED about before it is
 * buried: a channel that answers "paid" settles the money through the service's confirm core and
 * activates; one that answers "pending" or "closed" lets the order expire for certain (terminalAt
 * lands now, anchoring the late-fulfilment window) and only then is the channel-side order closed
 * — a close that comes back "already paid" is left to the next pass's query, never turned into a
 * local paid. An unreachable channel is skipped outright: expiring an order the deployment could
 * not ask about is how a payment gets lost, and the next pass asks again.
 */
import { type SweepLock, withSweepLock } from "../maintenance";
import type { PaymentService } from "./service";

export function startPaymentSweeps(
  service: PaymentService,
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

  const run = () => {
    // One guarded pass around both sweeps: two `withSweepLock` calls on the same key in the
    // same tick would have the second find its own pass's lock held and skip every time.
    void withSweepLock(lock, async () => {
      // The sweep is best-effort housekeeping over the money the callbacks and the poll already
      // cover; a failed pass is retried on the interval, and nothing here can lose an order
      // that a channel has not answered about yet.
      const sweepExpired = service.sweepExpired().catch((error: unknown) => {
        log(
          `billing: payments expiry sweep failed error=${
            error instanceof Error ? error.name : "unknown"
          }`,
        );
      });
      // The activation pass runs on the same discipline: paid orders waiting for their Lago
      // subscription are retried on the interval until the rule that refused them changes.
      const sweepActivations = service
        .sweepActivations()
        .catch((error: unknown) => {
          log(
            `billing: payments activation sweep failed error=${
              error instanceof Error ? error.name : "unknown"
            }`,
          );
        });
      await sweepExpired;
      await sweepActivations;
    }).catch((error: unknown) => {
      // A pass that could not take its guard (or lost the database doing it) is retried on the
      // interval; housekeeping never throws into the timer.
      log(
        `billing: payments sweep pass failed error=${
          error instanceof Error ? error.name : "unknown"
        }`,
      );
    });
  };

  const first = setTimeout(() => {
    run();
    const repeating = setInterval(run, intervalMs);
    // Housekeeping should not hold the process open.
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
