import type { RedisPort } from "../redis";

/**
 * Turn-event fan-out: Redis pub/sub as a doorbell, the database as the truth.
 *
 * The bus never carries payloads. A published message is `{turnId, seq}` and nothing more, and a
 * subscriber that hears one goes back to `readEventsSince` for the rows — so a lost message
 * costs one poll's latency and can never invent or drop an event, and two replicas holding the
 * same rows answer identically (plan §3.5.4).
 *
 * `redis: null` (or a Redis that dies mid-flight) is not an error state: the bus degrades to
 * polling `readEventsSince` on a timer, which is slower and always correct. Callers learn which
 * mode they are in through `mode` for logs and probes.
 */
export type TurnEventBus = {
  /** Announce that a turn has a new event at `seq`. Fire-and-forget; failures degrade to poll. */
  publish(turnId: string, seq: number): Promise<void>;
  /**
   * Hear events for one turn. Resolves to a stop function; a second subscriber for the same turn
   * shares the underlying subscription (reference-counted) and both stoppers must run before the
   * channel is truly unsubscribed.
   */
  subscribe(
    turnId: string,
    onEvents: (events: Array<{ seq: number }>) => void,
  ): Promise<() => void>;
  /** Which fan-out path is live: "redis" or the poll fallback. */
  readonly mode: "redis" | "poll";
  /** Stop every subscription and any poll timer. Idempotent; call from a shutdown hook. */
  close(): Promise<void>;
};

/** What the bus needs from the database side of the fan-out: the replay read, one turn at a time. */
export type TurnEventReader = {
  readEventsSince(
    turnId: string,
    seq: number,
    limit?: number,
  ): Promise<Array<{ seq: number }>>;
};

export type TurnEventBusOptions = {
  /** The replay read for both the catch-up path and the poll fallback. */
  reader: TurnEventReader;
  /** Poll cadence when Redis is absent or degraded; default 1000ms. */
  pollIntervalMs?: number;
  /** Injection point for tests; default is the global setTimeout/setInterval pair. */
  schedule?: (callback: () => void, ms: number) => () => void;
};

const channelOf = (turnId: string) => `ws:turn:${turnId}`;

export function createTurnEventBus(
  redis: RedisPort | null,
  options: TurnEventBusOptions,
): TurnEventBus {
  const reader = options.reader;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const schedule =
    options.schedule ??
    ((callback: () => void, ms: number) => {
      const handle = setInterval(callback, ms);
      return () => clearInterval(handle);
    });

  /**
   * Per-turn subscriber state. One entry per turn regardless of how many callbacks are
   * attached: the refcount decides when the subscription actually ends, so ten listeners for
   * one turn share one subscription instead of ten.
   *
   * Each turn holds its OWN dedicated subscriber connection (a `duplicate()` of the port):
   * ioredis forbids SUBSCRIBE and ordinary commands on one connection, and there is no
   * channel-level UNSUBSCRIBE behind the narrow RedisPort — so the last listener out closes
   * the whole connection, which unsubscribes everything it held in one step.
   */
  type TurnSub = {
    callbacks: Set<(events: Array<{ seq: number }>) => void>;
    lastSeq: number;
    stop: () => void;
  };

  const turns = new Map<string, TurnSub>();
  let degraded = redis === null;
  let closed = false;
  /** Poll timers, kept so `close()` can stop them all and degrade can end them. */
  const stoppers = new Set<() => void>();

  async function deliver(turnId: string, seq: number): Promise<void> {
    const sub = turns.get(turnId);
    if (!sub) return;
    // Deduplicate: pub/sub is at-least-once in spirit, and the poll fallback can race a late
    // Redis message. A seq at or below the last delivered one is a duplicate the subscribers
    // have already seen, so it is dropped here rather than re-read.
    if (seq <= sub.lastSeq) return;
    sub.lastSeq = seq;
    const events = await reader.readEventsSince(turnId, 0, 500).catch(() => []);
    for (const callback of sub.callbacks) {
      try {
        callback(events);
      } catch {
        // A subscriber's rendering bug must not take the fan-out down for everybody else.
      }
    }
  }

  function startPolling(turnId: string, sub: TurnSub): void {
    const stop = schedule(() => {
      void (async () => {
        const events = await reader
          .readEventsSince(turnId, sub.lastSeq, 100)
          .catch(() => []);
        const newest = events.at(-1);
        if (newest && newest.seq > sub.lastSeq) {
          sub.lastSeq = newest.seq;
          for (const callback of sub.callbacks) {
            try {
              callback(events);
            } catch {
              // Same rule as deliver(): one bad subscriber stops nothing.
            }
          }
        }
      })();
    }, pollIntervalMs);
    stoppers.add(stop);
    sub.stop = () => {
      stop();
      stoppers.delete(stop);
    };
  }

  return {
    get mode() {
      return degraded ? ("poll" as const) : ("redis" as const);
    },

    async publish(turnId, seq) {
      if (degraded || !redis || closed) return;
      try {
        await redis.publish(channelOf(turnId), JSON.stringify({ turnId, seq }));
      } catch {
        // Redis died between two healthy calls: degrade every live turn to polling now. The
        // database still holds everything; the bus gets slower, not wrong.
        degraded = true;
        for (const [id, sub] of turns) startPolling(id, sub);
      }
    },

    async subscribe(turnId, onEvents) {
      if (closed) return () => undefined;
      let sub = turns.get(turnId);
      if (!sub) {
        sub = { callbacks: new Set(), lastSeq: 0, stop: () => undefined };
        turns.set(turnId, sub);
        if (degraded || !redis) {
          degraded = true;
          startPolling(turnId, sub);
        } else {
          // A dedicated connection per turn: subscribing puts a connection into subscriber
          // mode, and the last listener for the turn ends it by closing that connection.
          const subscriber = redis.duplicate();
          try {
            await subscriber.subscribe(
              channelOf(turnId),
              (_channel, message) => {
                const parsed = JSON.parse(message) as {
                  turnId: string;
                  seq: number;
                };
                void deliver(parsed.turnId, parsed.seq);
              },
            );
            sub.stop = () => {
              void subscriber.quit();
            };
          } catch {
            degraded = true;
            startPolling(turnId, sub);
          }
        }
      }
      sub.callbacks.add(onEvents);

      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        const live = turns.get(turnId);
        if (!live) return;
        live.callbacks.delete(onEvents);
        // Reference counting: the subscription ends when the last listener for the turn goes,
        // not when the first stopper runs — one SSE connection dropping must not end what a
        // second tab is still listening on.
        if (live.callbacks.size === 0) {
          live.stop();
          turns.delete(turnId);
        }
      };
    },

    async close() {
      closed = true;
      for (const sub of turns.values()) sub.stop();
      turns.clear();
      for (const stop of stoppers) stop();
      stoppers.clear();
    },
  };
}
