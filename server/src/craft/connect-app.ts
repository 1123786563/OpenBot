/**
 * Connect-app request plumbing — the port of onyx `build/connect_app.py`: two
 * KV records, no DB, no turn-side waiting.
 *
 * The agent's no-op `connect_app` tool makes opencode pause the turn on a
 * `permission.asked {permission: "connect_app"}`. The turn consumer announces
 * the request (so the live stream can emit a `connect_app_request` card) and
 * stashes the context the decision endpoint needs to answer opencode directly
 * — allow (connected) / reject (declined) — then keeps streaming. Both records
 * are keyed so the producing, live-stream, and decision workers can be
 * different processes (onyx's exact shape, including the `craft:connect_app:*`
 * key names and the 60s announce / 30min pending TTLs).
 *
 * Onyx parity on payloads too: the announce value is the ConnectAppRequest
 * `model_dump_json` (snake_case, `reason: null` preserved — never omitted), and
 * the pending record is ConnectAppPending's — `{build_session_id,
 * opencode_session_id, perm_id, directory}` and nothing else. No credential
 * bytes exist anywhere in this flow by construction: the tool connects an app
 * in OpenBot's own settings surface; the sandbox never sees a token at all.
 */

import type { RedisPort } from "../redis";

/** The permission category the connect-app plugin asks under (onyx template constant). */
export const CONNECT_APP_PERMISSION = "connect_app";

/** Only need to outlive the card's SSE visibility window (onyx _ANNOUNCE_TTL_S). */
export const CONNECT_APP_ANNOUNCE_TTL_SECONDS = 60;
/** Each record only needs to outlive the user's connect/decline interaction (onyx _PENDING_TTL_S). */
export const CONNECT_APP_PENDING_TTL_SECONDS = 60 * 30;

/** The card carried from the turn consumer to the live stream (onyx ConnectAppRequest). */
export type CraftConnectAppRequest = {
  request_id: string;
  external_app_id: number;
  reason: string | null;
};

/**
 * The context the decision endpoint answers one connect_app permission with
 * (onyx ConnectAppPending). One documented extension over onyx's shape:
 * `external_app_id`, which onyx never needs (it audits nothing here) but this
 * deployment's audit row does — the announce card that carried it is long
 * drained by the time a decision lands.
 */
export type CraftConnectAppPending = {
  build_session_id: string;
  opencode_session_id: string;
  perm_id: string;
  directory: string;
  external_app_id?: number;
};

const announceKey = (sessionId: string) =>
  `craft:connect_app:announce:${sessionId}`;
const pendingKey = (requestId: string) =>
  `craft:connect_app:pending:${requestId}`;

export type CraftConnectAppSignals = {
  /** RPUSH the request's JSON onto the session's announce list, refreshing its TTL. */
  announceRequest(
    sessionId: string,
    request: CraftConnectAppRequest,
  ): Promise<void>;
  /** LPOP-everything: the session's announced request JSON strings, oldest first. */
  drainAnnouncements(sessionId: string): Promise<string[]>;
  /** SET the pending context with its TTL (the decision endpoint's answer key). */
  stashPending(
    requestId: string,
    pending: CraftConnectAppPending,
  ): Promise<void>;
  /**
   * The stashed context, or null when expired/already cleared/unparseable.
   * An infrastructure failure THROWS (never folds to null): callers must be
   * able to tell "expired/answered" apart from "KV down" and answer 5xx
   * honestly instead of a false-success no-op.
   */
  loadPending(requestId: string): Promise<CraftConnectAppPending | null>;
  /**
   * Atomically load-AND-clear the context: exactly ONE caller per requestId can
   * ever see a non-null answer (GET+DEL in one Redis script; one synchronous
   * block in-process). The decision endpoint takes through this so concurrent
   * replays (double-click, two tabs) cannot both answer opencode. An
   * infrastructure failure THROWS — the same error contract as loadPending.
   */
  takePending(requestId: string): Promise<CraftConnectAppPending | null>;
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

const SET_WITH_TTL = `
redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1`;

/** GET+DEL as one script — the atomic take the decision endpoint decides through. */
const TAKE_KEY = `
local v = redis.call('get', KEYS[1])
if v then redis.call('del', KEYS[1]) end
return v`;

function createRedisSignals(redis: RedisPort): CraftConnectAppSignals {
  return {
    mode: "redis" as const,
    async announceRequest(sessionId, request) {
      await redis.eval(
        RPUSH_WITH_TTL,
        1,
        announceKey(sessionId),
        JSON.stringify(request),
        CONNECT_APP_ANNOUNCE_TTL_SECONDS,
      );
    },
    async drainAnnouncements(sessionId) {
      const out = await redis.eval(DRAIN_ALL, 1, announceKey(sessionId));
      return Array.isArray(out) ? out.map((value) => String(value)) : [];
    },
    async stashPending(requestId, pending) {
      await redis.eval(
        SET_WITH_TTL,
        1,
        pendingKey(requestId),
        JSON.stringify(pending),
        CONNECT_APP_PENDING_TTL_SECONDS,
      );
    },
    async loadPending(requestId) {
      // No .catch(() => null) here: a Redis outage must surface as a throw so
      // the decision endpoint can 5xx instead of masquerading as the
      // "expired/already answered" no-op (OCR r3) — stashPending and
      // announceRequest already propagate; the take/load gates now do too.
      const raw = await redis.get(pendingKey(requestId));
      return parsePending(raw);
    },
    async takePending(requestId) {
      // Same error contract as loadPending: eval failures propagate.
      const raw = await redis.eval(TAKE_KEY, 1, pendingKey(requestId));
      return parsePending(raw);
    },
  };
}

function parsePending(raw: unknown): CraftConnectAppPending | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CraftConnectAppPending>;
    if (
      typeof parsed.build_session_id !== "string" ||
      typeof parsed.opencode_session_id !== "string" ||
      typeof parsed.perm_id !== "string" ||
      typeof parsed.directory !== "string"
    ) {
      return null;
    }
    return parsed as CraftConnectAppPending;
  } catch {
    return null;
  }
}

/**
 * The single-replica fallback and the reference semantics for the Redis one:
 * the same two records with lazy TTL expiry (the in-process shape
 * approval-signals.ts established).
 */
export function createInProcessConnectAppSignals(): CraftConnectAppSignals & {
  /** Test/diagnostic read: the session's undrained announce payloads, oldest first. */
  peekAnnouncements(sessionId: string): string[];
} {
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
    lists.set(key, {
      values: [...entry.values, value],
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  };

  return {
    mode: "memory" as const,
    async announceRequest(sessionId, request) {
      push(
        announceKey(sessionId),
        JSON.stringify(request),
        CONNECT_APP_ANNOUNCE_TTL_SECONDS,
      );
    },
    async drainAnnouncements(sessionId) {
      const key = announceKey(sessionId);
      const entry = live(key);
      lists.delete(key);
      return entry.values;
    },
    peekAnnouncements(sessionId) {
      return live(announceKey(sessionId)).values;
    },
    async stashPending(requestId, pending) {
      push(
        pendingKey(requestId),
        JSON.stringify(pending),
        CONNECT_APP_PENDING_TTL_SECONDS,
      );
    },
    async loadPending(requestId) {
      return parsePending(live(pendingKey(requestId)).values[0] ?? null);
    },
    async takePending(requestId) {
      // One synchronous block — single-threaded JS makes read+delete atomic
      // the same way the Redis script does.
      const key = pendingKey(requestId);
      const entry = live(key);
      lists.delete(key);
      return parsePending(entry.values[0] ?? null);
    },
  };
}

/** Pick the signal store for a deployment: Redis when configured, in-process otherwise. */
export function createCraftConnectAppSignals(input: {
  redis: RedisPort | null;
}): CraftConnectAppSignals {
  return input.redis
    ? createRedisSignals(input.redis)
    : createInProcessConnectAppSignals();
}

/**
 * Read the app id + reason out of a connect_app ask's metadata (onyx
 * serve_client.py:1750-1775): a missing or non-numeric `external_app_id` means
 * the ask cannot be keyed to any app — null, and the caller denies it
 * immediately WITHOUT announcing (there is no card to show for it).
 */
export function parseConnectAppAsk(
  metadata: Record<string, unknown>,
): { externalAppId: number; reason: string | null } | null {
  const raw = metadata.external_app_id;
  if (raw === null || raw === undefined) return null;
  const parsed =
    typeof raw === "number"
      ? Number.isInteger(raw)
        ? raw
        : Number.NaN
      : typeof raw === "string" && raw.trim() !== ""
        ? Number.parseInt(raw, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  const reasonRaw = metadata.reason;
  const reason =
    typeof reasonRaw === "string" && reasonRaw !== "" ? reasonRaw : null;
  return { externalAppId: parsed, reason };
}

/**
 * Stash the pending context and announce the card — the whole producer side of
 * the handshake (onyx `_handle_connect_app_permission`'s write half). Throws
 * when the KV write fails; the caller must then deny the ask so the parked
 * turn resumes with a decline instead of hanging (onyx: logger.exception + deny).
 * Returns the request id the card and the pending record share.
 */
export async function stashAndAnnounce(
  signals: CraftConnectAppSignals,
  input: {
    sessionId: string;
    opencodeSessionId: string;
    directory: string;
    permissionId: string;
    externalAppId: number;
    reason: string | null;
    /** Injectable for tests; a uuid4 in production (onyx: `str(uuid4())`). */
    newRequestId?: () => string;
  },
): Promise<string> {
  const requestId = input.newRequestId
    ? input.newRequestId()
    : crypto.randomUUID();
  await signals.stashPending(requestId, {
    build_session_id: input.sessionId,
    opencode_session_id: input.opencodeSessionId,
    perm_id: input.permissionId,
    directory: input.directory,
    external_app_id: input.externalAppId,
  });
  await signals.announceRequest(input.sessionId, {
    request_id: requestId,
    external_app_id: input.externalAppId,
    reason: input.reason,
  });
  return requestId;
}
