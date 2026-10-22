/*
 * The desktop's namespaced local state, MT102 (Issue #145).
 *
 * THE RULE, NOT THE WIRING — the same station `scoped-cache.ts` holds on the web side (MT083):
 * this module fixes where one scope's business state (caches, drafts, media indexes) lives and
 * what happens when it cannot be trusted, and the surfaces that adopt it each carry their own
 * wiring. The Rust side already owns the on-disk halves of the same discipline — MT099 gave every
 * organization its own credential namespace, MT100 its own media/cache/subscription directories —
 * so what was missing is the renderer's own store: the webview's localStorage, which nothing
 * partitioned.
 *
 * THE THREE RULES, mirroring the Rust namespaces and the web cache discipline:
 *
 * 1. One scope, one subtree. A slot's key names the namespace (`:personal`, or one organization's
 *    authority), the person, the company and the team (AC1) — two organizations' states are not
 *    readable from each other's keys, and neither is a team's from another team's. The record
 *    carries its own scope beside the value, so even a key collision or a hand-moved entry is
 *    caught on read rather than interpreted (defense in depth, not the only wall).
 *
 * 2. Untrusted state is never guessed at (AC2). A slot that fails to parse, carries a version
 *    this build does not know, embeds a scope that does not match the reading scope, or has
 *    expired reads as `corrupt`/`expired` — never as a value, never as "no state at all": the
 *    caller's honest reaction is to ask for the choice again (re-sign-in or re-choose), which is
 *    exactly what the corrupted-state story in the ticket demands.
 *
 * 3. Personal and organizational states live apart (AC3). Clearing one organization removes only
 *    that organization's slots; clearing the personal namespace removes no organization's. Either
 *    deletion leaves the other untouched — the same guarantee MT099's Rust namespaces give the
 *    credential store, applied to the renderer's own state.
 */

/** The storage contract this module needs; the webview's localStorage satisfies it. */
export interface LocalStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The one record shape this module writes; a version bump is a migration, not an overwrite. */
export type LocalStateRecord = {
  version: number;
  scope: {
    kind: "organization" | "personal";
    authority: string | null;
    userId: string;
    tenantId: string | null;
    workspaceId: string | null;
  };
  writtenAtMs: number;
  /** Optional expiry: after this moment the slot is stale state, not live state. */
  expiresAtMs?: number;
  value: unknown;
};

/** The scope one piece of business state belongs to. */
export type LocalScope =
  | {
      kind: "organization";
      /** The authority whose organization this is — the partition a switch or a leave clears. */
      authority: string;
      userId: string;
      /** The company, or null while only the organization is chosen. */
      tenantId: string | null;
      /** The team, or null while only the company is chosen. */
      workspaceId: string | null;
    }
  | {
      kind: "personal";
      userId: string;
    };

/** The version this build writes and reads; anything else is not ours to interpret. */
export const LOCAL_STATE_VERSION = 1;

const PREFIX = "openbot.local-state.v1";

/**
 * The slot one (scope, key) pair lives in.
 *
 * A leading colon on the namespace tokens keeps `:personal` from ever colliding with an authority
 * string (authorities are origins, which cannot start with a colon) — the same trick the web
 * cache's reserved tokens play.
 */
export function localStateKey(scope: LocalScope, key: string): string {
  const parts =
    scope.kind === "personal"
      ? [PREFIX, ":personal", scope.userId]
      : [PREFIX, "org", scope.authority, scope.userId, scope.tenantId ?? "-", scope.workspaceId ?? "-"];
  return [...parts, key].join(":");
}

/** What a read found: a value, nothing, or state that must not be trusted. */
export type LocalStateRead =
  | { status: "present"; value: unknown }
  | { status: "absent" }
  /** Stale by its own stamp: not corrupt, but not live either — the safe degrade, not a value. */
  | { status: "expired" }
  /** Damaged, a foreign version, or a scope mismatch: never guessed at, never shown. */
  | { status: "corrupt" };

function scopeOf(
  scope: LocalScope,
): LocalStateRecord["scope"] {
  return scope.kind === "personal"
    ? {
        kind: "personal",
        authority: null,
        userId: scope.userId,
        tenantId: null,
        workspaceId: null,
      }
    : {
        kind: "organization",
        authority: scope.authority,
        userId: scope.userId,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
      };
}

/**
 * Read one slot. Absence, expiry and damage are three different answers, because the surfaces
 * react differently: absence may seed a default, expiry and damage must not — they ask for the
 * choice again (AC2).
 */
export function readLocalState(
  storage: LocalStateStorage,
  scope: LocalScope,
  key: string,
  nowMs: number = Date.now(),
): LocalStateRead {
  const raw = storage.getItem(localStateKey(scope, key));
  if (raw === null) return { status: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "corrupt" };
  }
  if (parsed === null || typeof parsed !== "object") return { status: "corrupt" };
  const record = parsed as Partial<LocalStateRecord>;
  if (record.version !== LOCAL_STATE_VERSION) return { status: "corrupt" };
  if (
    record.scope === undefined ||
    record.scope === null ||
    typeof record.scope !== "object"
  ) {
    return { status: "corrupt" };
  }
  // The record must claim the exact scope it is being read under — a slot moved between scopes
  // (or a key that collided) is damage, not data (AC1's defense in depth).
  const expected = scopeOf(scope);
  if (
    record.scope.kind !== expected.kind ||
    record.scope.authority !== expected.authority ||
    record.scope.userId !== expected.userId ||
    record.scope.tenantId !== expected.tenantId ||
    record.scope.workspaceId !== expected.workspaceId
  ) {
    return { status: "corrupt" };
  }
  if (
    typeof record.expiresAtMs === "number" &&
    record.expiresAtMs <= nowMs
  ) {
    return { status: "expired" };
  }
  if (!("value" in record)) return { status: "corrupt" };
  return { status: "present", value: record.value };
}

/** Write one slot: the value, the scope it belongs to, this build's version, and its moment. */
export function writeLocalState(
  storage: LocalStateStorage,
  scope: LocalScope,
  key: string,
  value: unknown,
  options?: { expiresAtMs?: number; nowMs?: number },
): void {
  const record: LocalStateRecord = {
    version: LOCAL_STATE_VERSION,
    scope: scopeOf(scope),
    writtenAtMs: options?.nowMs ?? Date.now(),
    ...(options?.expiresAtMs !== undefined
      ? { expiresAtMs: options.expiresAtMs }
      : {}),
    value,
  };
  storage.setItem(localStateKey(scope, key), JSON.stringify(record));
}

/** Remove one slot — the targeted way out for state its own surface declares finished. */
export function removeLocalState(
  storage: LocalStateStorage,
  scope: LocalScope,
  key: string,
): void {
  storage.removeItem(localStateKey(scope, key));
}

/** The keys of the store (localStorage has none of its own in the interface this module needs). */
function keysOf(storage: LocalStateStorage & { key?: (index: number) => string | null }): string[] {
  if (typeof storage.key !== "function") return [];
  const found: string[] = [];
  for (let index = 0; ; index += 1) {
    const key = storage.key(index);
    if (key === null) break;
    found.push(key);
  }
  return found;
}

/**
 * Remove one organization's local state — exactly its slots, nobody else's (AC3). The authority is
 * the partition, matching MT100's leave-organization cleanup: leaving organization A never touches
 * organization B's state, the personal namespace, or another user's slots.
 *
 * Returns how many slots were removed, so a caller can show (and a test can pin) the blast radius.
 */
export function clearOrganizationState(
  storage: LocalStateStorage & { key?: (index: number) => string | null },
  authority: string,
): number {
  const prefix = `${PREFIX}:org:${authority}:`;
  const doomed = keysOf(storage).filter((key) => key.startsWith(prefix));
  for (const key of doomed) storage.removeItem(key);
  return doomed.length;
}

/**
 * Remove one person's personal local state — the personal namespace only (AC3). An organization's
 * slots (any organization's) are not this call's to touch.
 */
export function clearPersonalState(
  storage: LocalStateStorage & { key?: (index: number) => string | null },
  userId: string,
): number {
  const prefix = `${PREFIX}::personal:${userId}:`;
  const doomed = keysOf(storage).filter((key) => key.startsWith(prefix));
  for (const key of doomed) storage.removeItem(key);
  return doomed.length;
}

/**
 * The production storage: the webview's own localStorage, delivered as the narrow interface above
 * so tests run the real code against an in-memory stand-in without faking the module.
 */
export function windowLocalStorage(): LocalStateStorage | null {
  if (typeof window === "undefined") return null;
  const candidate = window as { localStorage?: Storage } | undefined;
  const storage = candidate?.localStorage;
  if (storage === undefined) return null;
  return storage as LocalStateStorage;
}
