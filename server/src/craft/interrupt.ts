/**
 * Cross-replica interrupt fence for craft sessions — ported from onyx
 * `session/interrupt_signal.py`.
 *
 * A direct opencode-serve abort only works once the session's opencode id has been minted,
 * which on the first turn happens lazily inside the streaming request. An interrupt arriving
 * during that window can't abort anything. This fence closes that race: the interrupt
 * endpoint sets a flag the streaming flow checks at the point the opencode session becomes
 * known and on every event thereafter, aborting itself when set.
 *
 * Two implementations behind one interface (the module's whole shape): Redis for
 * multi-replica, in-process for single-replica — the caller picks at assembly.
 */

import type { RedisPort } from "../redis";

const FENCE_PREFIX = "buildsessioninterrupt_fence";
/** Backstop: a turn never outlives this, so a fence can't leak past one. */
export const FENCE_TTL_SECONDS = 10 * 60;

const fenceKey = (sessionId: string) => `${FENCE_PREFIX}_${sessionId}`;

export type InterruptFence = {
  /** Signal that the in-flight turn for this session should be interrupted. */
  requestInterrupt(sessionId: string): Promise<void>;
  isInterruptRequested(sessionId: string): Promise<boolean>;
  /** Clear the fence — called at the start and end of each turn. */
  clearInterrupt(sessionId: string): Promise<void>;
};

export function createRedisInterruptFence(redis: RedisPort): InterruptFence {
  return {
    async requestInterrupt(sessionId) {
      await redis.eval(
        "return redis.call('set', KEYS[1], '0', 'ex', ARGV[1])",
        1,
        fenceKey(sessionId),
        FENCE_TTL_SECONDS,
      );
    },
    async isInterruptRequested(sessionId) {
      return (await redis.get(fenceKey(sessionId))) !== null;
    },
    async clearInterrupt(sessionId) {
      await redis.eval(
        "return redis.call('del', KEYS[1])",
        1,
        fenceKey(sessionId),
      );
    },
  };
}

export function createInProcessInterruptFence(): InterruptFence {
  const fences = new Map<string, number>(); // sessionId → expiresAt ms
  const live = (sessionId: string): boolean => {
    const expiresAt = fences.get(sessionId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      fences.delete(sessionId);
      return false;
    }
    return true;
  };
  return {
    async requestInterrupt(sessionId) {
      fences.set(sessionId, Date.now() + FENCE_TTL_SECONDS * 1000);
    },
    async isInterruptRequested(sessionId) {
      return live(sessionId);
    },
    async clearInterrupt(sessionId) {
      fences.delete(sessionId);
    },
  };
}

export function createInterruptFence(redis: RedisPort | null): InterruptFence {
  return redis ? createRedisInterruptFence(redis) : createInProcessInterruptFence();
}
