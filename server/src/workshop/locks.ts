import { randomBytes } from "node:crypto";
import type { RedisPort } from "../redis";

/**
 * The workshop's mutual exclusion for one turn, in two implementations behind one interface.
 *
 * Callers know only `TurnLock`; whether the guard is a Redis key or a process-local Map is a
 * deployment decision (plan §3.5.3). `acquire` answering `null` is how a conflict is reported —
 * no throw, because "someone else is running this turn" is an answer, not an accident.
 */
export type TurnLease = {
  /** Owner token: only the holder that presents this may release or renew. */
  readonly token: string;
  /** Extend the TTL. Returns false when the lock is no longer ours — the holder must stop. */
  renew(): Promise<boolean>;
  /**
   * Compare-and-delete: `if get(key) == token then del`. A release with the wrong token is a
   * no-op, not an error — a late release after TTL expiry must never delete a successor's lock.
   */
  release(): Promise<void>;
  /** Set once renew() has failed, so a long turn can settle itself instead of running unguarded. */
  readonly lost: boolean;
};

export type TurnLock = {
  acquire(turnId: string): Promise<TurnLease | null>;
  /** Mode the lock is actually running in, for logs and for a /health-style probe. */
  readonly mode: "redis" | "memory";
};

const lockKey = (turnId: string) => `ws:lock:turn:${turnId}`;

/** A token nobody can guess and nobody but the holder ever sees on the wire twice. */
function newLeaseToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * The single-replica fallback, and the reference semantics for the Redis implementation.
 *
 * A `Map` keyed by turn id holding the current owner token: presence is the lock, token equality
 * is ownership. Renewal is a no-op that always succeeds — the process holding the Map IS the only
 * runner, so an extension of nothing costs nothing. Release compares tokens before deleting, so a
 * lease that was somehow double-released cannot take a second holder's lock with it.
 */
export function createInProcessTurnLock(): TurnLock {
  const held = new Map<string, string>();

  return {
    mode: "memory" as const,

    async acquire(turnId) {
      if (held.has(turnId)) return null;
      const token = newLeaseToken();
      held.set(turnId, token);
      let lost = false;
      return {
        token,
        get lost() {
          return lost;
        },
        async renew() {
          // The Map cannot expire a lease on its own, but a released one is gone: renewal then
          // reports the loss and latches `lost`, the same contract the Redis lease holds.
          const alive = held.get(turnId) === token;
          if (!alive) lost = true;
          return alive;
        },
        async release() {
          if (held.get(turnId) === token) held.delete(turnId);
        },
      };
    },
  };
}

/*
 * ── Redis implementation (B13) ─────────────────────────────────────────────────────────────
 *
 * SET NX PX for the acquire, PEXPIRE behind a token check for renewal, and the Lua
 * compare-and-delete for release — the shapes §3.5.3 fixes. TTL defaults come from
 * WORKSHOP_LOCK_TTL_MS (30s); renewal cadence is TTL/3, so three missed renewals is one lost
 * lock, which is the property the orchestrator's stale-settle path leans on.
 */

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`;

export type RedisTurnLockOptions = {
  /** Lock lifetime in milliseconds; renewed at TTL/3 by the holder. */
  ttlMs: number;
};

/**
 * The multi-replica implementation. Every verb is token-checked on the server side of Redis:
 * renewal and release are Lua scripts so the read and the write are one atomic step, and a lease
 * that outlived its TTL simply cannot act on a key a successor now owns.
 */
export function createRedisTurnLock(
  redis: RedisPort,
  options: RedisTurnLockOptions,
): TurnLock {
  const ttlMs = options.ttlMs;

  return {
    mode: "redis" as const,

    async acquire(turnId) {
      const token = newLeaseToken();
      // SET key token PX ttl NX: the one-shot acquire. Returns "OK" only when the key was
      // absent, null when somebody else holds it — which is an answer, not an error.
      const ok = await redis.set(lockKey(turnId), token, "PX", ttlMs, "NX");
      if (ok !== "OK") return null;
      let lost = false;
      return {
        token,
        get lost() {
          return lost;
        },
        async renew() {
          const extended = await redis.eval(
            RENEW_SCRIPT,
            1,
            lockKey(turnId),
            token,
            ttlMs,
          );
          const alive = extended === 1;
          if (!alive) lost = true;
          return alive;
        },
        async release() {
          // Wrong-token release is deliberately a no-op (the script returns 0 and deletes
          // nothing): deleting a successor's lock would be the bug this shape exists to prevent.
          await redis.eval(RELEASE_SCRIPT, 1, lockKey(turnId), token);
        },
      };
    },
  };
}
