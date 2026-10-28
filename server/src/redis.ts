import Redis from "ioredis";

/**
 * The workshop's whole Redis surface, as one narrow interface.
 *
 * Redis here is two things and nothing else: the turn lock (SET NX PX, PEXPIRE and a Lua
 * compare-and-delete — hence `eval`) and the event fan-out bus (PUBLISH, and SUBSCRIBE through a
 * dedicated connection — hence `duplicate`). Everything else ioredis can do stays behind this
 * port, so the in-process fallback, the tests' fake and any future client swap all implement
 * seven methods rather than one hundred and fifty.
 *
 * `null` is a first-class answer, not an error: a deployment that has not set OPENBOT_REDIS_URL
 * runs single-replica with an in-process lock and database-polling fan-out, by design (plan
 * §3.5.2). Callers check for null and take the fallback; nothing in the workshop layer should
 * ever read this module's environment variables itself.
 */
export type RedisPort = {
  /** GET, for reading lock state in diagnostics. */
  get(key: string): Promise<string | null>;
  /**
   * SET key value PX ttl NX — the lock's acquire primitive. Only the millisecond expiry form is
   * exposed because only the lock uses SET, and lock TTLs are reasoned about in milliseconds
   * (WORKSHOP_LOCK_TTL_MS); a seconds-mode overload here would be a unit bug waiting for a caller.
   */
  set(
    key: string,
    value: string,
    mode: "PX",
    ttlMs: number,
    nx: "NX",
  ): Promise<"OK" | null>;
  /**
   * EVAL for the two lock scripts (CAS release, conditional PEXPIRE). Kept raw: the scripts are
   * short, live next to their callers, and change for reasons this port should not know about.
   */
  eval(
    script: string,
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<unknown>;
  /** PUBLISH on the shared connection; the payload is `{turnId, seq}` and nothing bigger. */
  publish(channel: string, message: string): Promise<number>;
  /**
   * SUBSCRIBE on a dedicated connection. The bus needs one connection per subscriber mode, so
   * this hands back its own port rather than flipping the shared one in and out of subscriber
   * state — which ioredis forbids on a connection that also issues commands.
   */
  subscribe(
    channel: string,
    onMessage: (channel: string, message: string) => void,
  ): Promise<void>;
  /** A second port sharing this one's options but with its own connection. */
  duplicate(): RedisPort;
  /** Close this port's connections. Idempotent; safe to call from a shutdown hook. */
  quit(): Promise<void>;
};

/** What {@link createRedisPort} reads. `NodeJS.ProcessEnv` shaped so tests can build fakes. */
export type RedisEnv = {
  OPENBOT_REDIS_URL?: string | undefined;
  WORKSHOP_REQUIRE_REDIS?: string | undefined;
};

/**
 * Turn env into a Redis port, or into a deliberate nothing.
 *
 * Three outcomes, and the third is the one that needs care:
 *
 * - URL set → a port backed by ioredis with `lazyConnect: true`. No connection is opened here:
 *   the workshop layer connects when it first needs the bus or the lock, so a deployment with
 *   Redis configured but a workshop nobody has opened holds no sockets.
 * - URL unset, WORKSHOP_REQUIRE_REDIS unset or 0 → `null`. The single-replica fallback, and a
 *   legitimate deployment shape rather than a degraded one.
 * - URL unset, WORKSHOP_REQUIRE_REDIS=1 → throws. A multi-replica deployment that asked to be
 *   hard-required into Redis and then did not get it must not boot into the in-process lock,
 *   which would silently let two replicas run the same turn. Failing at startup, naming both
 *   variables, is the alternative to failing at the worst possible moment.
 */
export function createRedisPort(env: RedisEnv): RedisPort | null {
  const url = env.OPENBOT_REDIS_URL?.trim();
  const required = env.WORKSHOP_REQUIRE_REDIS?.trim() === "1";

  if (!url) {
    if (required) {
      throw new Error(
        "WORKSHOP_REQUIRE_REDIS=1 but OPENBOT_REDIS_URL is not set: refusing to start " +
          "single-replica with an in-process lock when Redis was required. Set OPENBOT_REDIS_URL " +
          "or unset WORKSHOP_REQUIRE_REDIS.",
      );
    }
    return null;
  }

  return wrapRedisClient(
    new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 }),
  );
}

/** Wrap an ioredis client in the port, so tests can wrap their own fakes the same way. */
function wrapRedisClient(client: Redis): RedisPort {
  /** Subscriber connections, one per channel, each with its own client. */
  const subscribers = new Map<string, Redis>();

  return {
    get: (key) => client.get(key),
    set: (key, value, mode, ttl, nx) =>
      client.set(key, value, mode, ttl, nx) as Promise<"OK" | null>,
    eval: (script, numKeys, ...keysAndArgs) =>
      client.eval(script, numKeys, ...keysAndArgs) as Promise<unknown>,
    publish: (channel, message) => client.publish(channel, message),
    subscribe: async (channel, onMessage) => {
      let subscriber = subscribers.get(channel);
      if (!subscriber) {
        subscriber = client.duplicate({ lazyConnect: false });
        subscriber.on("message", onMessage);
        subscribers.set(channel, subscriber);
      }
      try {
        await subscriber.subscribe(channel);
      } catch (error) {
        // The dead connection must not stay cached: a retry would keep reusing it and
        // failing forever, and nothing else removes an entry from this map.
        subscribers.delete(channel);
        subscriber.disconnect();
        throw error;
      }
    },
    duplicate: () => wrapRedisClient(client.duplicate({ lazyConnect: true })),
    quit: async () => {
      // A reconnecting subscriber refuses quit() without closing the socket, so the disconnect
      // fallback rides along exactly as it does for the main client below.
      await Promise.allSettled(
        [...subscribers.values()].map((s) =>
          s.quit().catch(() => s.disconnect()),
        ),
      );
      subscribers.clear();
      await client.quit().catch(() => client.disconnect());
    },
  };
}
