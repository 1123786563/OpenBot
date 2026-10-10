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
export function fakeRedisPort(): RedisPort & {
  /** Test hooks into the fake's storage and failure injection. */
  keys: Map<string, { value: string; expiresAt: number | null }>;
  listeners: Map<string, (channel: string, message: string) => void>;
  failNext: () => void;
} {
  const core = {
    keys: new Map<string, { value: string; expiresAt: number | null }>(),
    listeners: new Map<string, (channel: string, message: string) => void>(),
    /** Duplicated handles share this, so PUBLISH on one reaches subscribers on another. */
    closed: new Set<Map<string, (channel: string, message: string) => void>>(),
    shouldFail: false,
  };

  const portOf = (): RedisPort & {
    keys: Map<string, { value: string; expiresAt: number | null }>;
    listeners: Map<string, (channel: string, message: string) => void>;
    failNext: () => void;
  } => {
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
        if (script.includes("pexpire")) {
          const entry = core.keys.get(key);
          if (!entry || entry.value !== token) return 0;
          entry.expiresAt = Date.now() + Number(args[2]);
          return 1;
        }
        if (script.includes("del")) {
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
        // Fan out to every live listener, including those on duplicated handles — the way a
        // real Redis reaches subscribers regardless of which connection published.
        let count = 0;
        for (const listener of core.listeners.values()) {
          if (!core.closed.has(core.listeners)) listener(channel, message);
          count += 1;
        }
        return count;
      },
      async subscribe(channel, onMessage) {
        maybeFail();
        core.listeners.set(channel, onMessage);
      },
      duplicate: () => {
        // A duplicate is a new handle onto the same fake server: its subscriptions land in the
        // same listener table, and quitting it removes only what it registered.
        const before = new Map(core.listeners);
        const handle = portOf();
        handle.quit = async () => {
          for (const [channel, listener] of core.listeners) {
            if (before.get(channel) !== listener) core.listeners.delete(channel);
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
