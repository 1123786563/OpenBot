import type { RedisPort } from "../src/redis";

/**
 * An in-memory RedisPort for the lock and bus tests.
 *
 * `set` implements the NX/PX semantics the lock uses (values carry their expiry), `eval`
 * interprets exactly the two Lua scripts the lock sends (renew and release — matched by the
 * commands they call, not by string equality), and `publish`/`subscribe` deliver to local
 * listeners synchronously. Anything else an implementation does is behind RedisPort and behind
 * these tests' needs.
 */
type FakeRedisTestPort = RedisPort & {
  /** Test hooks into the fake's storage and failure injection. */
  keys: Map<string, { value: string; expiresAt: number | null }>;
  listeners: Map<string, (channel: string, message: string) => void>;
  failNext: () => void;
};

export function fakeRedisPort(): FakeRedisTestPort {
  const core = {
    keys: new Map<string, { value: string; expiresAt: number | null }>(),
    listeners: new Map<string, (channel: string, message: string) => void>(),
    /** Duplicated handles share this, so PUBLISH on one reaches subscribers on another. */
    closed: new Set<Map<string, (channel: string, message: string) => void>>(),
    shouldFail: false,
  };

  const portOf = (): FakeRedisTestPort => {
    const maybeFail = () => {
      if (core.shouldFail) {
        core.shouldFail = false;
        throw new Error("fake redis: injected failure");
      }
    };

    const alive = (key: string) => {
      const entry = core.keys.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
        core.keys.delete(key);
        return null;
      }
      return entry.value;
    };

    return {
      keys: core.keys,
      listeners: core.listeners,
      failNext: () => {
        core.shouldFail = true;
      },
      async get(key) {
        maybeFail();
        return alive(key);
      },
      async set(key, value, mode, ttl, nx) {
        maybeFail();
        const current = alive(key);
        if (nx === "NX" && current !== null) return null;
        core.keys.set(key, {
          value,
          expiresAt: mode === "PX" ? Date.now() + ttl : null,
        });
        return "OK";
      },
      async eval(script, numKeys, ...args) {
        maybeFail();
        const key = String(args[0]);
        const token = String(args[1]);
        void numKeys;
        // The lock sends exactly two scripts: renew carries PEXPIRE, release carries DEL.
        // The markers are kept exclusive so a script that grows either command is
        // rejected below instead of being silently misrouted.
        const isRenew = script.includes("pexpire") && !script.includes("del");
        const isRelease = script.includes("del") && !script.includes("pexpire");
        if (isRenew) {
          // alive(), not a bare get: renewing an expired key must fail the way Redis would,
          // or the lock tests cannot tell a held lock from one whose TTL has quietly lapsed.
          const entry = alive(key);
          if (entry === null || entry !== token) return 0;
          const stored = core.keys.get(key)!;
          stored.expiresAt = Date.now() + Number(args[2]);
          return 1;
        }
        if (isRelease) {
          if (alive(key) === token) {
            core.keys.delete(key);
            return 1;
          }
          return 0;
        }
        throw new Error(`fake redis: unrecognised script: ${script}`);
      },
      async publish(channel, message) {
        maybeFail();
        // Deliver only to the subscriber of this channel, from whichever handle
        // published — the listener table is shared across duplicated handles,
        // the way a real Redis reaches subscribers regardless of connection.
        if (core.closed.has(core.listeners)) return 0;
        const listener = core.listeners.get(channel);
        if (!listener) return 0;
        listener(channel, message);
        return 1;
      },
      async subscribe(channel, onMessage) {
        maybeFail();
        // An active subscription revives delivery: a quit() must not leave the shared
        // listener table closed for handles that subscribe afterwards.
        core.closed.delete(core.listeners);
        core.listeners.set(channel, onMessage);
      },
      duplicate: () => {
        // A duplicate is a new handle onto the same fake server: its subscriptions land in the
        // same listener table, and quitting it restores what each channel carried before — a
        // duplicate must not take the original handle's subscription down with it.
        const before = new Map(core.listeners);
        const handle = portOf();
        handle.quit = async () => {
          for (const [channel, listener] of core.listeners) {
            const previous = before.get(channel);
            if (previous !== listener) {
              if (previous === undefined) core.listeners.delete(channel);
              else core.listeners.set(channel, previous);
            }
          }
        };
        return handle;
      },
      async quit() {
        core.closed.add(core.listeners);
        core.listeners.clear();
        core.keys.clear();
      },
    };
  };

  return portOf();
}
