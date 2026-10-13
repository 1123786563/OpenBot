/**
 * The usage delivery sweeper, in the payment sweeper's shape (./payments/maintenance.ts): a delayed
 * first pass, then an interval, timers unref'd so housekeeping never holds the process open. Passes
 * never overlap, and a failed pass is logged by error name only and retried on the next tick.
 *
 * Started in production by the billing assembly (server/src/index.ts wires
 * `startUsageDeliverySweeps` whenever the usage outbox exists) — the delivery targets it
 * sweeps are the Lago and credits targets that same assembly builds.
 */
import type { UsageDelivery } from "./usage-delivery";

export function startUsageDeliverySweeps(
  delivery: UsageDelivery,
  options: {
    intervalMs?: number;
    firstRunMs?: number;
    limit?: number;
    log?: (message: string) => void;
  } = {},
): { stop(): void } {
  const intervalMs = options.intervalMs ?? 30_000;
  const firstRunMs = options.firstRunMs ?? 30_000;
  const limit = options.limit ?? 100;
  // biome-ignore lint/suspicious/noConsole: stable-code operational log
  const log = options.log ?? ((message: string) => console.warn(message));
  const timers: ReturnType<typeof setTimeout>[] = [];
  let running = false;

  const run = () => {
    if (running) return;
    running = true;
    void delivery
      .runBatch(limit)
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
