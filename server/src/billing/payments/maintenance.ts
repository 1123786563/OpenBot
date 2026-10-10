/**
 * The payment sweeper: one pass, then an interval, in the retention sweeps' shape
 * (../../audit-retention.ts) — starting shortly after boot rather than in the middle of it, the
 * timer unref'd so housekeeping never holds the process open.
 *
 * The pass is query-first by design. A pending order past its TTL is ASKED about before it is
 * buried: a channel that answers "paid" settles the money through the service's confirm core and
 * activates; one that answers "pending" or "closed" lets the order expire for certain (terminalAt
 * lands now, anchoring the late-fulfilment window) and only then is the channel-side order closed
 * — a close that comes back "already paid" is left to the next pass's query, never turned into a
 * local paid. An unreachable channel is skipped outright: expiring an order the deployment could
 * not ask about is how a payment gets lost, and the next pass asks again.
 */
import type { PaymentService } from "./service";

export function startPaymentSweeps(
  service: PaymentService,
  options: { intervalMs?: number; firstRunMs?: number } = {},
): { stop(): void } {
  const intervalMs = options.intervalMs ?? 60_000;
  const firstRunMs = options.firstRunMs ?? 60_000;
  const timers: ReturnType<typeof setTimeout>[] = [];

  const run = () => {
    void service.sweepExpired().catch(() => {
      // The sweep is best-effort housekeeping over the money the callbacks and the poll already
      // cover; a failed pass is retried on the interval, and nothing here can lose an order
      // that a channel has not answered about yet.
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
