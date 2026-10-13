/**
 * Cache-backed lifecycle state for active interactive craft turns — ported from onyx
 * `interactive_turns/state.py`.
 *
 * Two implementations behind one interface, the workshop locks.ts pattern: a Redis one for
 * multi-replica deployments, an in-process one for single-replica (no OPENBOT_REDIS_URL).
 * Ownership is decided by the runner_id compare inside every mutation, never by the mutex
 * lease — the mutex only guards the handful of round-trips each mutation makes.
 *
 * Key names keep onyx's `craft:` prefix verbatim: `craft:interactive_turn:{id}`,
 * `craft:session:{id}:active_turn`, `…:active_turn_lock`, `…:turn_request:{user}:{req}`.
 */

import { randomUUID } from "node:crypto";
import type { RedisPort } from "../redis";
import type { CraftConfig } from "./config";
import type { PromptAttachment } from "./opencode/serve-client";

export type InteractiveTurnStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export const TURN_STATUS_QUEUED: InteractiveTurnStatus = "QUEUED";
export const TURN_STATUS_RUNNING: InteractiveTurnStatus = "RUNNING";
export const TURN_STATUS_SUCCEEDED: InteractiveTurnStatus = "SUCCEEDED";
export const TURN_STATUS_FAILED: InteractiveTurnStatus = "FAILED";
export const TURN_STATUS_CANCELLED: InteractiveTurnStatus = "CANCELLED";

const ACTIVE_TURN_STATUSES = new Set<InteractiveTurnStatus>([
  TURN_STATUS_QUEUED,
  TURN_STATUS_RUNNING,
]);

export type InteractiveTurn = {
  turnId: string;
  sessionId: string;
  userId: string;
  prompt: string;
  status: InteractiveTurnStatus;
  turnIndex: number;
  attachments: PromptAttachment[];
  lastHeartbeatAt: string | null; // ISO UTC
  errorDetail: string | null;
  runnerId: string | null;
  /**
   * Claim-local flag for stale-RUNNING recovery; not persisted (stripped on save, like the
   * Python dataclass field onyx's _save_turn pops).
   */
  reclaimed: boolean;
};

export function turnIsActive(turn: InteractiveTurn): boolean {
  return ACTIVE_TURN_STATUSES.has(turn.status);
}

/** Thrown when the session active-turn mutex cannot be acquired. */
export class InteractiveTurnLockError extends Error {
  constructor() {
    super("Failed to acquire active turn lock");
    this.name = "InteractiveTurnLockError";
  }
}

// Turn-state mutex: guards a handful of round-trips per mutation; the lease only
// needs to exceed the longest critical section. Ownership is decided by the
// runner_id compare, never by this lease.
const TURN_LOCK_LEASE_SECONDS = 60;
const TURN_LOCK_WAIT_SECONDS = 10;

type SerializedTurn = Omit<InteractiveTurn, "reclaimed">;

// ── Key helpers (onyx names verbatim) ─────────────────────────────────────────

const turnKey = (turnId: string) => `craft:interactive_turn:${turnId}`;
const activeTurnKey = (sessionId: string) =>
  `craft:session:${sessionId}:active_turn`;
const activeTurnLockKey = (sessionId: string) =>
  `craft:session:${sessionId}:active_turn_lock`;
const requestKey = (
  sessionId: string,
  userId: string,
  clientRequestId: string,
) => `craft:session:${sessionId}:turn_request:${userId}:${clientRequestId}`;

// ── The interface ─────────────────────────────────────────────────────────────

export type TurnStateStore = {
  createInteractiveTurn(input: {
    sessionId: string;
    userId: string;
    clientRequestId: string;
    prompt: string;
    turnIndex: number;
    attachments?: PromptAttachment[];
  }): Promise<InteractiveTurn>;
  getTurn(turnId: string): Promise<InteractiveTurn | null>;
  getTurnForRequest(input: {
    sessionId: string;
    userId: string;
    clientRequestId: string;
  }): Promise<InteractiveTurn | null>;
  getActiveTurn(input: {
    sessionId: string;
    userId: string;
  }): Promise<InteractiveTurn | null>;
  /** CAS claim: QUEUED/stale-RUNNING → RUNNING + fresh runner_id; null when refused. */
  claimTurnForRunner(turnId: string): Promise<InteractiveTurn | null>;
  /** Refresh the heartbeat (ownership-checked). False = lost ownership. */
  touchTurn(input: {
    turnId: string;
    runnerId?: string | null;
  }): Promise<boolean>;
  finishTurn(input: {
    turnId: string;
    status: InteractiveTurnStatus;
    errorDetail?: string | null;
    runnerId?: string | null;
  }): Promise<InteractiveTurn | null>;
  /** The active-turn mutex, exposed for the send-message admission path. */
  withActiveTurnLock<T>(sessionId: string, body: () => Promise<T>): Promise<T>;
  readonly mode: "redis" | "memory";
};

// ── Serialization ─────────────────────────────────────────────────────────────

function serialize(turn: InteractiveTurn): string {
  const payload: SerializedTurn = {
    turnId: turn.turnId,
    sessionId: turn.sessionId,
    userId: turn.userId,
    prompt: turn.prompt,
    status: turn.status,
    turnIndex: turn.turnIndex,
    attachments: turn.attachments,
    lastHeartbeatAt: turn.lastHeartbeatAt,
    errorDetail: turn.errorDetail,
    runnerId: turn.runnerId,
  };
  return JSON.stringify(payload);
}

function deserialize(raw: string | null): InteractiveTurn | null {
  if (raw === null) return null;
  try {
    const payload = JSON.parse(raw) as Partial<SerializedTurn>;
    if (
      typeof payload.turnId !== "string" ||
      typeof payload.sessionId !== "string" ||
      typeof payload.userId !== "string" ||
      typeof payload.prompt !== "string" ||
      typeof payload.status !== "string" ||
      typeof payload.turnIndex !== "number"
    ) {
      return null;
    }
    return {
      turnId: payload.turnId,
      sessionId: payload.sessionId,
      userId: payload.userId,
      prompt: payload.prompt,
      status: payload.status as InteractiveTurnStatus,
      turnIndex: payload.turnIndex,
      attachments: Array.isArray(payload.attachments)
        ? payload.attachments
        : [],
      lastHeartbeatAt: payload.lastHeartbeatAt ?? null,
      errorDetail: payload.errorDetail ?? null,
      runnerId: payload.runnerId ?? null,
      reclaimed: false,
    };
  } catch {
    return null;
  }
}

function runnerIsStale(
  turn: InteractiveTurn,
  staleAfterSeconds: number,
): boolean {
  if (turn.lastHeartbeatAt === null) return true;
  const age = Date.now() - Date.parse(turn.lastHeartbeatAt);
  return Number.isFinite(age) && age >= staleAfterSeconds * 1000;
}

// ── Redis implementation ──────────────────────────────────────────────────────

const LOCK_ACQUIRE_SCRIPT = `
if redis.call("exists", KEYS[1]) == 0 then
  redis.call("set", KEYS[1], ARGV[1], "ex", ARGV[2])
  return 1
end
return 0`;

const LOCK_RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`;

/**
 * A spin-wait mutex over SET NX, honoring the TURN_LOCK_WAIT_SECONDS budget. The RedisPort
 * surface is deliberately narrow (no blocking BLPOP-style lock), so the wait is a bounded
 * retry loop at a short cadence — the critical sections it guards are a few round-trips.
 */
async function withRedisTurnLock<T>(
  redis: RedisPort,
  sessionId: string,
  body: () => Promise<T>,
): Promise<T> {
  const key = activeTurnLockKey(sessionId);
  const token = randomUUID();
  const deadline = Date.now() + TURN_LOCK_WAIT_SECONDS * 1000;
  let acquired = false;
  while (!acquired) {
    acquired =
      (await redis.eval(
        LOCK_ACQUIRE_SCRIPT,
        1,
        key,
        token,
        TURN_LOCK_LEASE_SECONDS,
      )) === 1;
    if (!acquired) {
      if (Date.now() >= deadline) throw new InteractiveTurnLockError();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await body();
  } finally {
    await redis.eval(LOCK_RELEASE_SCRIPT, 1, key, token).catch(() => undefined);
  }
}

export type RedisTurnStateStoreOptions = {
  redis: RedisPort;
  config: CraftConfig;
};

export function createRedisTurnStateStore(
  options: RedisTurnStateStoreOptions,
): TurnStateStore {
  const { redis, config } = options;

  const loadTurn = async (turnId: string) =>
    deserialize(await redis.get(turnKey(turnId)));

  const saveTurn = async (turn: InteractiveTurn, ttlSeconds: number) => {
    await redis.set(
      turnKey(turn.turnId),
      serialize(turn),
      "PX",
      ttlSeconds * 1000,
      "NX",
    );
    // SET NX is the port's only set; a turn key is written before anyone else can
    // see it (creation) or under the mutex (mutation), so an NX miss here means a
    // key we own exists — fall through to GET/DEL-free overwrite via eval.
    await redis.eval(
      `
if redis.call("get", KEYS[1]) == false or redis.call("get", KEYS[1]) == ARGV[1] or ARGV[2] == "1" then
  return redis.call("set", KEYS[1], ARGV[1], "ex", ARGV[3])
end
return 0`,
      1,
      turnKey(turn.turnId),
      serialize(turn),
      0,
      Math.round(ttlSeconds),
    );
  };

  return {
    mode: "redis" as const,

    async withActiveTurnLock(sessionId, body) {
      return withRedisTurnLock(redis, sessionId, body);
    },

    async createInteractiveTurn(input) {
      const now = new Date().toISOString();
      const turn: InteractiveTurn = {
        turnId: randomUUID(),
        sessionId: input.sessionId,
        userId: input.userId,
        prompt: input.prompt,
        status: TURN_STATUS_QUEUED,
        turnIndex: input.turnIndex,
        attachments: input.attachments ?? [],
        lastHeartbeatAt: now,
        errorDetail: null,
        runnerId: null,
        reclaimed: false,
      };
      await redis.eval(
        "return redis.call('set', KEYS[1], ARGV[1], 'ex', ARGV[2])",
        1,
        turnKey(turn.turnId),
        serialize(turn),
        Math.round(config.activeTurnTtlSeconds),
      );
      await redis.eval(
        "return redis.call('set', KEYS[1], ARGV[1], 'ex', ARGV[2])",
        1,
        activeTurnKey(turn.sessionId),
        turn.turnId,
        Math.round(config.activeTurnTtlSeconds),
      );
      await redis.eval(
        "return redis.call('set', KEYS[1], ARGV[1], 'ex', ARGV[2])",
        1,
        requestKey(input.sessionId, input.userId, input.clientRequestId),
        turn.turnId,
        Math.round(config.requestIdTtlSeconds),
      );
      return turn;
    },

    async getTurn(turnId) {
      return loadTurn(turnId);
    },

    async getTurnForRequest(input) {
      const rawTurnId = await redis.get(
        requestKey(input.sessionId, input.userId, input.clientRequestId),
      );
      if (rawTurnId === null) return null;
      const turn = await loadTurn(rawTurnId);
      if (
        turn === null ||
        turn.sessionId !== input.sessionId ||
        turn.userId !== input.userId
      ) {
        return null;
      }
      return turn;
    },

    async getActiveTurn(input) {
      const rawTurnId = await redis.get(activeTurnKey(input.sessionId));
      if (rawTurnId === null) return null;
      const turn = await loadTurn(rawTurnId);
      if (
        turn === null ||
        turn.sessionId !== input.sessionId ||
        turn.userId !== input.userId
      ) {
        await redis.eval(
          "return redis.call('del', KEYS[1])",
          1,
          activeTurnKey(input.sessionId),
        );
        return null;
      }
      if (!turnIsActive(turn)) {
        await redis.eval(
          "return redis.call('del', KEYS[1])",
          1,
          activeTurnKey(input.sessionId),
        );
        return null;
      }
      return turn;
    },

    async claimTurnForRunner(turnId) {
      let turn = await loadTurn(turnId);
      if (turn === null || !turnIsActive(turn)) return null;
      // Pre-lock rejection so periodic reclaim retries don't contend on the mutex;
      // re-checked under it.
      if (
        turn.status === TURN_STATUS_RUNNING &&
        !runnerIsStale(turn, config.runnerStaleAfterSeconds)
      ) {
        return null;
      }

      return withRedisTurnLock(redis, turn.sessionId, async () => {
        turn = await loadTurn(turnId);
        if (turn === null || !turnIsActive(turn)) return null;
        if (
          turn.status === TURN_STATUS_RUNNING &&
          !runnerIsStale(turn, config.runnerStaleAfterSeconds)
        ) {
          return null;
        }
        const wasStaleReclaim = turn.status === TURN_STATUS_RUNNING;
        turn.status = TURN_STATUS_RUNNING;
        turn.lastHeartbeatAt = new Date().toISOString();
        turn.runnerId = randomUUID();
        turn.errorDetail = null;
        turn.reclaimed = wasStaleReclaim;
        await saveTurn(turn, config.activeTurnTtlSeconds);
        await redis.eval(
          "return redis.call('set', KEYS[1], ARGV[1], 'ex', ARGV[2])",
          1,
          activeTurnKey(turn.sessionId),
          turn.turnId,
          Math.round(config.activeTurnTtlSeconds),
        );
        return turn;
      }).catch(() => null);
    },

    async touchTurn(input) {
      let turn = await loadTurn(input.turnId);
      if (turn === null || !turnIsActive(turn)) return false;
      return withRedisTurnLock(redis, turn.sessionId, async () => {
        turn = await loadTurn(input.turnId);
        if (turn === null || !turnIsActive(turn)) return false;
        if (input.runnerId != null && turn.runnerId !== input.runnerId)
          return false;
        turn.lastHeartbeatAt = new Date().toISOString();
        await saveTurn(turn, config.activeTurnTtlSeconds);
        await redis.eval(
          "return redis.call('expire', KEYS[1], ARGV[1])",
          1,
          activeTurnKey(turn.sessionId),
          Math.round(config.activeTurnTtlSeconds),
        );
        return true;
      }).catch(() => false);
    },

    async finishTurn(input) {
      let turn = await loadTurn(input.turnId);
      if (turn === null) return null;
      return withRedisTurnLock(redis, turn.sessionId, async () => {
        turn = await loadTurn(input.turnId);
        if (turn === null) return null;
        if (input.runnerId != null && turn.runnerId !== input.runnerId)
          return null;
        turn.status = input.status;
        turn.lastHeartbeatAt = new Date().toISOString();
        turn.errorDetail = input.errorDetail ?? null;
        turn.runnerId = null;
        await saveTurn(turn, config.requestIdTtlSeconds);

        const rawActiveId = await redis.get(activeTurnKey(turn.sessionId));
        if (rawActiveId === input.turnId) {
          await redis.eval(
            "return redis.call('del', KEYS[1])",
            1,
            activeTurnKey(turn.sessionId),
          );
        }
        return turn;
      }).catch(() => null);
    },
  };
}

// ── In-process implementation (single replica) ────────────────────────────────

interface MemLock {
  token: string;
  expiresAt: number;
}

/**
 * The single-replica fallback and the reference semantics for the Redis one. Everything lives
 * in one process, so the mutex is a token-checked Map entry with a lease, and "TTL expiry" is
 * enforced lazily on read.
 */
export function createInProcessTurnStateStore(
  options: { config: CraftConfig } = { config: loadDefaultConfig() },
): TurnStateStore {
  const { config } = options;
  const turns = new Map<string, { turn: InteractiveTurn; expiresAt: number }>();
  const activeTurns = new Map<string, { turnId: string; expiresAt: number }>();
  const requests = new Map<string, { turnId: string; expiresAt: number }>();
  const locks = new Map<string, MemLock>();

  const getLive = (turnId: string): InteractiveTurn | null => {
    const entry = turns.get(turnId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      turns.delete(turnId);
      return null;
    }
    // Copy so callers can't mutate stored state without saving. `reclaimed` is
    // claim-local (see the field's docblock): the Redis store strips it on save, so the
    // copy resets it here — reads never resurrect a stale reclaim flag.
    return {
      ...entry.turn,
      reclaimed: false,
      attachments: [...entry.turn.attachments],
    };
  };

  const put = (turn: InteractiveTurn, ttlSeconds: number) => {
    turns.set(turn.turnId, { turn, expiresAt: Date.now() + ttlSeconds * 1000 });
  };

  const withLock = async <T>(
    sessionId: string,
    body: () => Promise<T>,
  ): Promise<T> => {
    const key = activeTurnLockKey(sessionId);
    const deadline = Date.now() + TURN_LOCK_WAIT_SECONDS * 1000;
    const token = randomUUID();
    for (;;) {
      const existing = locks.get(key);
      if (!existing || existing.expiresAt <= Date.now()) {
        locks.set(key, {
          token,
          expiresAt: Date.now() + TURN_LOCK_LEASE_SECONDS * 1000,
        });
        break;
      }
      if (Date.now() >= deadline) throw new InteractiveTurnLockError();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      return await body();
    } finally {
      const held = locks.get(key);
      if (held && held.token === token) locks.delete(key);
    }
  };

  return {
    mode: "memory" as const,

    async withActiveTurnLock(sessionId, body) {
      return withLock(sessionId, body);
    },

    async createInteractiveTurn(input) {
      const turn: InteractiveTurn = {
        turnId: randomUUID(),
        sessionId: input.sessionId,
        userId: input.userId,
        prompt: input.prompt,
        status: TURN_STATUS_QUEUED,
        turnIndex: input.turnIndex,
        attachments: input.attachments ?? [],
        lastHeartbeatAt: new Date().toISOString(),
        errorDetail: null,
        runnerId: null,
        reclaimed: false,
      };
      put(turn, config.activeTurnTtlSeconds);
      activeTurns.set(input.sessionId, {
        turnId: turn.turnId,
        expiresAt: Date.now() + config.activeTurnTtlSeconds * 1000,
      });
      requests.set(
        requestKey(input.sessionId, input.userId, input.clientRequestId),
        {
          turnId: turn.turnId,
          expiresAt: Date.now() + config.requestIdTtlSeconds * 1000,
        },
      );
      return turn;
    },

    async getTurn(turnId) {
      return getLive(turnId);
    },

    async getTurnForRequest(input) {
      const entry = requests.get(
        requestKey(input.sessionId, input.userId, input.clientRequestId),
      );
      if (!entry || entry.expiresAt <= Date.now()) return null;
      const turn = getLive(entry.turnId);
      if (
        turn === null ||
        turn.sessionId !== input.sessionId ||
        turn.userId !== input.userId
      ) {
        return null;
      }
      return turn;
    },

    async getActiveTurn(input) {
      const entry = activeTurns.get(input.sessionId);
      if (!entry || entry.expiresAt <= Date.now()) {
        activeTurns.delete(input.sessionId);
        return null;
      }
      const turn = getLive(entry.turnId);
      if (
        turn === null ||
        turn.sessionId !== input.sessionId ||
        turn.userId !== input.userId ||
        !turnIsActive(turn)
      ) {
        activeTurns.delete(input.sessionId);
        return null;
      }
      return turn;
    },

    async claimTurnForRunner(turnId) {
      let turn = getLive(turnId);
      if (turn === null || !turnIsActive(turn)) return null;
      if (
        turn.status === TURN_STATUS_RUNNING &&
        !runnerIsStale(turn, config.runnerStaleAfterSeconds)
      ) {
        return null;
      }
      return withLock(turn.sessionId, async () => {
        turn = getLive(turnId);
        if (turn === null || !turnIsActive(turn)) return null;
        if (
          turn.status === TURN_STATUS_RUNNING &&
          !runnerIsStale(turn, config.runnerStaleAfterSeconds)
        ) {
          return null;
        }
        const wasStaleReclaim = turn.status === TURN_STATUS_RUNNING;
        turn.status = TURN_STATUS_RUNNING;
        turn.lastHeartbeatAt = new Date().toISOString();
        turn.runnerId = randomUUID();
        turn.errorDetail = null;
        turn.reclaimed = wasStaleReclaim;
        put(turn, config.activeTurnTtlSeconds);
        activeTurns.set(turn.sessionId, {
          turnId: turn.turnId,
          expiresAt: Date.now() + config.activeTurnTtlSeconds * 1000,
        });
        return turn;
      }).catch(() => null);
    },

    async touchTurn(input) {
      let turn = getLive(input.turnId);
      if (turn === null || !turnIsActive(turn)) return false;
      return withLock(turn.sessionId, async () => {
        turn = getLive(input.turnId);
        if (turn === null || !turnIsActive(turn)) return false;
        if (input.runnerId != null && turn.runnerId !== input.runnerId)
          return false;
        turn.lastHeartbeatAt = new Date().toISOString();
        put(turn, config.activeTurnTtlSeconds);
        activeTurns.set(turn.sessionId, {
          turnId: turn.turnId,
          expiresAt: Date.now() + config.activeTurnTtlSeconds * 1000,
        });
        return true;
      }).catch(() => false);
    },

    async finishTurn(input) {
      let turn = getLive(input.turnId);
      if (turn === null) return null;
      return withLock(turn.sessionId, async () => {
        turn = getLive(input.turnId);
        if (turn === null) return null;
        if (input.runnerId != null && turn.runnerId !== input.runnerId)
          return null;
        turn.status = input.status;
        turn.lastHeartbeatAt = new Date().toISOString();
        turn.errorDetail = input.errorDetail ?? null;
        turn.runnerId = null;
        put(turn, config.requestIdTtlSeconds);
        const active = activeTurns.get(turn.sessionId);
        if (active && active.turnId === input.turnId) {
          activeTurns.delete(turn.sessionId);
        }
        return turn;
      }).catch(() => null);
    },
  };
}

// Lazy default-config import keeps this module's test surface free of env reads at
// import time; the value only materializes when the fallback store is built without one.
import { loadCraftConfig } from "./config";

function loadDefaultConfig() {
  return loadCraftConfig({});
}

/** Pick the store for a deployment: Redis when configured, the in-process one otherwise. */
export function createTurnStateStore(input: {
  redis: RedisPort | null;
  config: CraftConfig;
}): TurnStateStore {
  return input.redis
    ? createRedisTurnStateStore({ redis: input.redis, config: input.config })
    : createInProcessTurnStateStore({ config: input.config });
}
