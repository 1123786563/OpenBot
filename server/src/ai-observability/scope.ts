/**
 * Scope issuance and process-internal trust.
 *
 * `resolveObservationScope` is the ONLY way an observation scope comes to exist. It takes the
 * actorId the AuthService verified, the Bot the caller named, and the caller's answer about
 * ownership — never a body or header value it parsed itself. There is no module-level "current
 * scope": the scope is an explicit argument every consumer carries.
 *
 * Trust is recorded in a module-private WeakSet, so only the frozen objects this process actually
 * issued answer `assertObservationScope`. A serialized-and-restored scope, a spread copy, or a
 * hand-built plain object is not in the set and fails closed. Background workers must re-derive a
 * scope from their own authenticated identity and live ownership. Deliberately NOT exported is any
 * `issueScopeUnsafe`-style escape hatch.
 *
 * FREV-03: the scope's `key` is the STABLE RESOURCE identity of one Bot's observation range
 * (`resourceScopeKey(botId)` — the kind tag and the Bot id, nothing else). It names the data:
 * every row, cursor-space, upstream workspace and project of one Bot live under one key, so an
 * administrator looking at a creator's Bot, a profile rename, or an ownership transfer all reach
 * the SAME records — data never moves when the actor or the epoch changes. Who may look is
 * answered per request by the live manage gate that precedes scope minting, never by the key.
 *
 * The actor and the epoch live on the scope for the artifacts that ARE per-request: cursors,
 * job idempotency keys and export artifact keys bind `authorizationKey(actorId, botId, epoch)`,
 * so a transferred or renamed Bot's outstanding artifacts die with the generation that minted
 * them while the data underneath stays put. The read-window cache is deliberately data-keyed
 * (see `cacheKey`): a cached upstream page is a fact about the Bot's range, its only readers are
 * scopes freshly authorized by the live gate, and retention must be able to drop it from the
 * stored row key alone.
 *
 * Enterprise tenancy: an unresolved enterprise hint is a refusal, not a suggestion to fall back.
 * This file must not grow a tenant table read, a tenant header parse, a workspace-to-tenant map, or
 * a second scope kind. When the enterprise Spec is approved, the seam to replace is this function.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  type EvaluationEligibility,
  type ObservationScope,
  ObservationScopeError,
  type ObservationStorageLocator,
  type ScopeResolutionInput,
} from "./contracts";

const issued = new WeakSet<object>();

/** The dev placeholder the enterprise seam also refuses: a scope needs a real authenticated id. */
const PLACEHOLDER_ACTOR = "dev-local-user";

/**
 * Length-prefixed join: a segment containing the separator cannot shift fields and collide with
 * another segmentation, so `key(s, "a|b", "c")` never equals `key(s, "a", "b|c")`.
 */
function joinKey(segments: string[]): string {
  return segments.map((segment) => `${segment.length}:${segment}`).join("|");
}

/**
 * The stable resource key of one Bot's observation range (FREV-03): the `wb` kind tag plus the
 * Bot id, nothing else. This is a DATA identity, not a permission — who may hold a scope for it
 * is decided by the live manage gate at mint time, on every request. Because it contains neither
 * the actor nor the epoch, an administrator's scope, the creator's scope and a post-rename scope
 * for the same Bot all answer the same key, so they read and write one range of records.
 *
 * Key layout: `wb` is the kind tag; a future kind gets its own tag and therefore its own key space
 * rather than sharing this one.
 */
export function resourceScopeKey(botId: string): string {
  return joinKey(["wb", botId]);
}

/**
 * The per-request authorization key: actor, Bot and epoch. This is the artifact-binding spelling
 * of a scope — cursors, job idempotency keys and export artifact keys carry it, so an epoch bump
 * (a transfer, a revocation, even a rename) invalidates exactly the artifacts minted under the
 * old generation without moving a single data address. It is never a storage locator input, never
 * a row's scope_key, and never persisted: it exists only inside this module's key derivations.
 *
 * `wb-auth` is deliberately a different tag from the data key's `wb`, so an authorization key can
 * never collide with — or be mistaken for — a resource key, whatever the ids contain.
 */
export function authorizationKey(
  actorId: string,
  botId: string,
  epoch: number,
): string {
  return joinKey(["wb-auth", actorId, botId, String(epoch)]);
}

/** The authorization key of an issued scope — the artifact-binding spelling of this request. */
function authorizationKeyOf(scope: ObservationScope): string {
  return authorizationKey(scope.actorId, scope.botId, scope.epoch);
}

function isEnterpriseHint(hint: unknown): boolean {
  return hint !== undefined && hint !== null;
}

export function resolveObservationScope(
  input: ScopeResolutionInput,
): ObservationScope {
  /*
   * Order matters. The enterprise refusal comes first: an enterprise caller with a perfectly valid
   * workbench ownership answer must NOT be quietly served under workbench scope, because that is
   * exactly the fallback the parent Spec forbids.
   */
  if (isEnterpriseHint(input.enterpriseHint)) {
    throw new ObservationScopeError("ENTERPRISE_SCOPE_UNSUPPORTED", 403);
  }
  if (!input.actorId || input.actorId === PLACEHOLDER_ACTOR) {
    throw new ObservationScopeError("AUTH_REQUIRED", 401);
  }
  if (!input.botId) {
    throw new ObservationScopeError("BOT_REQUIRED", 400);
  }
  /* A missing ownership answer and a denied one are the same refusal: no scope. */
  if (input.ownership !== "owner" && input.ownership !== "admin") {
    throw new ObservationScopeError("OWNERSHIP_REQUIRED", 403);
  }
  if (!Number.isInteger(input.epoch) || input.epoch < 0) {
    throw new ObservationScopeError("OWNERSHIP_REQUIRED", 403);
  }

  const scope: ObservationScope = Object.freeze({
    kind: "workbench" as const,
    key: resourceScopeKey(input.botId),
    actorId: input.actorId,
    botId: input.botId,
    epoch: input.epoch,
  });
  issued.add(scope);
  return scope;
}

/**
 * Fails closed for anything this process did not issue. A forged scope is an authorization failure,
 * so it answers with the same 403 a denied caller gets — it does not leak "this object was almost
 * right".
 */
export function assertObservationScope(
  scope: unknown,
): asserts scope is ObservationScope {
  if (typeof scope !== "object" || scope === null || !issued.has(scope)) {
    throw new ObservationScopeError("OWNERSHIP_REQUIRED", 403);
  }
}

/*
 * Cursor integrity key. Process-local and per-boot on purpose: a cursor is a pagination position,
 * not a durable credential, so a restart invalidating outstanding cursors is the safe failure.
 * What must never happen is one scope accepting another scope's cursor.
 */
const CURSOR_KEY = new TextEncoder().encode(
  `opik-cursor/${process.pid}/${Date.now()}`,
);

function mac(authorizationKey: string, payload: string): Uint8Array {
  const hmac = createHmac("sha256", CURSOR_KEY);
  hmac.update(authorizationKey);
  hmac.update("\u0000");
  hmac.update(payload);
  return new Uint8Array(hmac.digest());
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Bind a pagination payload to the authorization generation that minted it — actor, Bot and
 * epoch, never the data key alone: two currently-authorized viewers of one Bot (an owner and
 * an administrator) must still not accept each other's cursors, and a transfer or rename kills
 * the outstanding ones even though the data they page over stayed at the same address.
 */
export function bindCursor(scope: ObservationScope, payload: string): string {
  assertObservationScope(scope);
  return `${encode(Buffer.from(payload, "utf8"))}.${encode(mac(authorizationKeyOf(scope), payload))}`;
}

/**
 * Read a cursor back. A cursor from another authorization generation — another actor, another
 * epoch — or a tampered payload is an authorization failure — not an empty page, and not a
 * silent restart from page one.
 */
export function readCursor(scope: ObservationScope, cursor: string): string {
  assertObservationScope(scope);
  const parts = cursor.split(".");
  // Exactly two segments: a trailing third is structural damage, not a variant reading of it.
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ObservationScopeError("OWNERSHIP_REQUIRED", 403);
  }
  const [encodedPayload, encodedMac] = parts;
  let payload: string;
  let offered: Uint8Array;
  try {
    payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
    offered = new Uint8Array(Buffer.from(encodedMac, "base64url"));
  } catch {
    throw new ObservationScopeError("OWNERSHIP_REQUIRED", 403);
  }
  const expected = mac(authorizationKeyOf(scope), payload);
  if (
    offered.length !== expected.length ||
    !timingSafeEqual(offered, expected)
  ) {
    throw new ObservationScopeError("OWNERSHIP_REQUIRED", 403);
  }
  return payload;
}

/**
 * Read-cache keys carry the scope's data key, so a cache entry belongs to one Bot's data range,
 * not to one actor's view of it. That is deliberate (FREV-03): every reader of such an entry is a
 * scope the live manage gate freshly authorized — a transferred bot's new owner and its creator
 * are two valid readers of the SAME range, while a revoked one cannot mint a scope at all — and
 * it is what lets the retention worker drop the entry from the stored row key alone (`scopeCacheKey`).
 */
export function cacheKey(
  scope: ObservationScope,
  name: string,
  ...parts: Array<string | number>
): string {
  assertObservationScope(scope);
  return scopeCacheKey(scope.key, name, ...parts);
}

/**
 * The scope-key-only spelling of `cacheKey`: the same key without a scope in
 * hand. The retention worker's read invalidation holds a stored scope key, not
 * a scope (a scope is issued per request, never persisted), and must delete the
 * exact entry the read surface cached under.
 */
export function scopeCacheKey(
  scopeKey: string,
  name: string,
  ...parts: Array<string | number>
): string {
  return joinKey(["cache", scopeKey, name, ...parts.map(String)]);
}

/**
 * Job and export artifact keys bind the AUTHORIZATION generation, not the data range: an
 * idempotency key is one actor's claim, so two authorized viewers of one Bot never share a job
 * identity, and an epoch bump retires the artifacts of the generation that minted them.
 */
export function jobKey(
  scope: ObservationScope,
  name: string,
  idempotencyKey: string,
): string {
  assertObservationScope(scope);
  return joinKey([
    "job",
    authorizationKeyOf(scope),
    name,
    idempotencyKey,
  ]);
}

export function exportKey(scope: ObservationScope, exportId: string): string {
  assertObservationScope(scope);
  return joinKey(["export", authorizationKeyOf(scope), exportId]);
}

/**
 * Where this scope's records live upstream.
 *
 * Derived FROM the scope's stable resource key — the Bot's data identity, not the actor or the
 * epoch. Never the other way round: an upstream workspace or project name is a storage address,
 * not a permission, and a layout that happens to look like a tenant boundary proves nothing. No
 * function here reconstructs a scope from a locator.
 *
 * Because the key carries neither the actor nor the epoch, the locator is a fact about the BOT:
 * an administrator's scope, a post-rename scope and a post-transfer scope for the same Bot all
 * resolve the same workspace and project — profile updates and ownership handovers never move
 * where records live (FREV-03).
 *
 * The fingerprint carries the key length for readability plus a 16-hex-char prefix of the full
 * key's hash: two scopes can hold different keys of the same length, so length alone does not
 * separate them. The hash is one-way; the key is not recoverable from a locator.
 */
export function resolveStorageLocator(
  scope: ObservationScope,
): ObservationStorageLocator {
  assertObservationScope(scope);
  const digest = createHash("sha256")
    .update(scope.key)
    .digest("hex")
    .slice(0, 16);
  const fingerprint = `${scope.key.length}-${digest}`;
  return Object.freeze({
    scopeKey: scope.key,
    workspace: `openbot-${scope.kind}-${fingerprint}`,
    project: `bot-${scope.botId}-${fingerprint}`,
  });
}

/** Whether this scope may run evaluations. The workbench adapter's answer is the scope itself. */
export function resolveEvaluationEligibility(
  scope: ObservationScope,
): EvaluationEligibility {
  assertObservationScope(scope);
  return Object.freeze({ allowed: true as const, scopeKey: scope.key });
}
