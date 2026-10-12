/**
 * Ephemeral signals for the craft approval rendezvous — the port of onyx
 * `sandbox_proxy/approval_cache.py`'s two lists (announce + wake).
 *
 * The `approval_requests` row is the source of truth; everything here is best-effort over the
 * same dual store shape as turn-state.ts (Redis when configured, in-process otherwise — the
 * RedisPort is narrow, so the list verbs ride `eval` exactly like turn-state's writes):
 *
 * - `craft:approval:announce:{sessionId}` — the producer RPUSHes after opening the row; the
 *   live SSE stream drains it to emit the approval_requested packet. A miss degrades to the
 *   frontend's next 5s `/approvals/live` refetch (onyx parity).
 * - `craft:approval:wake:{approvalId}` — the decide endpoint RPUSHes after recording a
 *   decision; the waiting producer takes it to resolve before its wait window. A miss just
 *   means it waits out the window (onyx parity).
 *
 * Keys carry the `craft:` prefix (the deployment namespace turn-state.ts keeps), not onyx's
 * bare `approval:*` — they are internal to this server and never cross systems.
 */

import type { RedisPort } from "../redis";

/** Only need to outlive the gap between RPUSH and the consumer's read (onyx: 60s). */
const ANNOUNCE_TTL_SECONDS = 60;
/** A wake nobody takes within this is gone for good (onyx: 30s). */
const WAKE_TTL_SECONDS = 30;

const announceKey = (sessionId: string) =>
  `craft:approval:announce:${sessionId}`;
const wakeKey = (approvalId: string) => `craft:approval:wake:${approvalId}`;

export type CraftApprovalSignals = {
  /** RPUSH an approval id onto the session's announce list, refreshing its TTL. */
  announce(sessionId: string, approvalId: string): Promise<void>;
  /** LPOP-everything: the session's pending announcements, oldest first. */
  drainAnnouncements(sessionId: string): Promise<string[]>;
  /** RPUSH a decision onto the approval's wake list (best-effort, never throws upstream). */
  sendWake(approvalId: string, decision: string): Promise<void>;
  /** LPOP one wake value, or null when none is pending. */
  takeWake(approvalId: string): Promise<string | null>;
  readonly mode: "redis" | "memory";
};

const RPUSH_WITH_TTL = `
redis.call('rpush', KEYS[1], ARGV[1])
redis.call('expire', KEYS[1], ARGV[2])
return 1`;

const DRAIN_ALL = `
local out = {}
while true do
  local v = redis.call('lpop', KEYS[1])
  if not v then break end
  table.insert(out, v)
end
return out`;

const LPOP_ONE = `return redis.call('lpop', KEYS[1])`;

function createRedisSignals(redis: RedisPort): CraftApprovalSignals {
  return {
    mode: "redis" as const,
    async announce(sessionId, approvalId) {
      await redis.eval(
        RPUSH_WITH_TTL,
        1,
        announceKey(sessionId),
        approvalId,
        ANNOUNCE_TTL_SECONDS,
      );
    },
    async drainAnnouncements(sessionId) {
      const out = await redis.eval(DRAIN_ALL, 1, announceKey(sessionId));
      return Array.isArray(out) ? out.map((value) => String(value)) : [];
    },
    async sendWake(approvalId, decision) {
      await redis.eval(
        RPUSH_WITH_TTL,
        1,
        wakeKey(approvalId),
        decision,
        WAKE_TTL_SECONDS,
      );
    },
    async takeWake(approvalId) {
      const out = await redis.eval(LPOP_ONE, 1, wakeKey(approvalId));
      return typeof out === "string" ? out : null;
    },
  };
}

/**
 * The single-replica fallback and the reference semantics for the Redis one: two lists with
 * lazy TTL expiry, mirroring the key-scoped lists Redis would hold.
 */
export function createInProcessApprovalSignals(): CraftApprovalSignals {
  const lists = new Map<string, { values: string[]; expiresAt: number }>();

  const live = (key: string): { values: string[]; expiresAt: number } => {
    const entry = lists.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      lists.delete(key);
      return { values: [], expiresAt: 0 };
    }
    return entry ?? { values: [], expiresAt: 0 };
  };

  const push = (key: string, value: string, ttlSeconds: number) => {
    const entry = live(key);
    // A fresh entry adopts the list shape; expiry is refreshed per push, as the
    // Redis RPUSH+EXPIRE pair does.
    lists.set(key, {
      values: [...entry.values, value],
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  };

  return {
    mode: "memory" as const,
    async announce(sessionId, approvalId) {
      push(announceKey(sessionId), approvalId, ANNOUNCE_TTL_SECONDS);
    },
    async drainAnnouncements(sessionId) {
      const key = announceKey(sessionId);
      const entry = live(key);
      lists.delete(key);
      return entry.values;
    },
    async sendWake(approvalId, decision) {
      push(wakeKey(approvalId), decision, WAKE_TTL_SECONDS);
    },
    async takeWake(approvalId) {
      const key = wakeKey(approvalId);
      const entry = live(key);
      const [first, ...rest] = entry.values;
      if (first === undefined) return null;
      if (rest.length === 0) lists.delete(key);
      else lists.set(key, { values: rest, expiresAt: entry.expiresAt });
      return first;
    },
  };
}

/** Pick the signal store for a deployment: Redis when configured, in-process otherwise. */
export function createCraftApprovalSignals(input: {
  redis: RedisPort | null;
}): CraftApprovalSignals {
  return input.redis
    ? createRedisSignals(input.redis)
    : createInProcessApprovalSignals();
}
