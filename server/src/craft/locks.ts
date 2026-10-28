/**
 * Craft's cross-flow per-user locks — ported from onyx `session/locks.py`.
 *
 * One lock serializes the session create/restore flow per user (the sandbox attempt + snapshot
 * restore + workspace materialization run under it). Lease sizing follows onyx's
 * SESSION_FLOW_LOCK_LEASE derivation: the sum of the flow's bounded phases, so the lease never
 * outlives the work it guards. The OpenBot first phase keeps sandboxes warm, so the restore
 * path is a no-op — but create still wants the mutex to converge concurrent pre-provisioners.
 */

import { randomUUID } from "node:crypto";
import type { RedisPort } from "../redis";

/** onyx: ATTEMPT_DEADLINE (240s) + BULK_TRANSFER (300s) + WORKSPACE_SETUP (180s) = 720s. */
export const SESSION_FLOW_LOCK_LEASE_SECONDS = 720;
/** How long a creator blocks on another create/restore of the same user. */
export const SESSION_FLOW_LOCK_WAIT_SECONDS = 60;

export class SessionCreationLockAcquisitionError extends Error {
  constructor(userId: string) {
    super(`Timed out waiting to create a session for user ${userId}`);
    this.name = "SessionCreationLockAcquisitionError";
  }
}

const lockKey = (userId: string) => `craft:session_flow_lock:${userId}`;

const ACQUIRE_SCRIPT = `
if redis.call("exists", KEYS[1]) == 0 then
  redis.call("set", KEYS[1], ARGV[1], "ex", ARGV[2])
  return 1
end
return 0`;

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`;

export type SessionFlowLocks = {
  /**
   * Run `body` holding the user's session-flow lock; throws
   * {@link SessionCreationLockAcquisitionError} past the wait budget.
   */
  withSessionCreationLock<T>(
    userId: string,
    body: () => Promise<T>,
  ): Promise<T>;
  /** Non-blocking probe: true when the lock is free (the restore endpoint 409s otherwise). */
  trySessionCreationLock<T>(
    userId: string,
    body: () => Promise<T>,
  ): Promise<T | null>;
  readonly mode: "redis" | "memory";
};

export function createRedisSessionFlowLocks(
  redis: RedisPort,
): SessionFlowLocks {
  const acquire = async (
    userId: string,
    waitSeconds: number,
  ): Promise<string | null> => {
    const token = randomUUID();
    const key = lockKey(userId);
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const ok =
        (await redis.eval(
          ACQUIRE_SCRIPT,
          1,
          key,
          token,
          SESSION_FLOW_LOCK_LEASE_SECONDS,
        )) === 1;
      if (ok) return token;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const release = async (userId: string, token: string) => {
    await redis
      .eval(RELEASE_SCRIPT, 1, lockKey(userId), token)
      .catch(() => undefined);
  };
  /** Distinguishes "the lock was not acquired" from a body that legitimately answers null. */
  const NOT_ACQUIRED = Symbol("session-flow-lock-not-acquired");
  const run = async <T>(
    userId: string,
    waitSeconds: number,
    body: () => Promise<T>,
  ): Promise<T | typeof NOT_ACQUIRED> => {
    const token = await acquire(userId, waitSeconds);
    if (token === null) return NOT_ACQUIRED;
    try {
      return await body();
    } finally {
      await release(userId, token);
    }
  };

  return {
    mode: "redis" as const,
    async withSessionCreationLock(userId, body) {
      const result = await run(userId, SESSION_FLOW_LOCK_WAIT_SECONDS, body);
      if (result === NOT_ACQUIRED)
        throw new SessionCreationLockAcquisitionError(userId);
      return result;
    },
    async trySessionCreationLock(userId, body) {
      const result = await run(userId, 0, body);
      return result === NOT_ACQUIRED ? null : result;
    },
  };
}

export function createInProcessSessionFlowLocks(): SessionFlowLocks {
  const held = new Map<string, { token: string; expiresAt: number }>();
  const acquire = async (
    userId: string,
    waitSeconds: number,
  ): Promise<string | null> => {
    const token = randomUUID();
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const existing = held.get(userId);
      if (!existing || existing.expiresAt <= Date.now()) {
        held.set(userId, {
          token,
          expiresAt: Date.now() + SESSION_FLOW_LOCK_LEASE_SECONDS * 1000,
        });
        return token;
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const release = (userId: string, token: string) => {
    const existing = held.get(userId);
    if (existing && existing.token === token) held.delete(userId);
  };
  /** Distinguishes "the lock was not acquired" from a body that legitimately answers null. */
  const NOT_ACQUIRED = Symbol("session-flow-lock-not-acquired");
  const run = async <T>(
    userId: string,
    waitSeconds: number,
    body: () => Promise<T>,
  ): Promise<T | typeof NOT_ACQUIRED> => {
    const token = await acquire(userId, waitSeconds);
    if (token === null) return NOT_ACQUIRED;
    try {
      return await body();
    } finally {
      release(userId, token);
    }
  };

  return {
    mode: "memory" as const,
    async withSessionCreationLock(userId, body) {
      const result = await run(userId, SESSION_FLOW_LOCK_WAIT_SECONDS, body);
      if (result === NOT_ACQUIRED)
        throw new SessionCreationLockAcquisitionError(userId);
      return result;
    },
    async trySessionCreationLock(userId, body) {
      const result = await run(userId, 0, body);
      return result === NOT_ACQUIRED ? null : result;
    },
  };
}

export function createSessionFlowLocks(
  redis: RedisPort | null,
): SessionFlowLocks {
  return redis
    ? createRedisSessionFlowLocks(redis)
    : createInProcessSessionFlowLocks();
}
