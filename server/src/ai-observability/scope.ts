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
 * Key layout: `wb` is the kind tag; a future kind gets its own tag and therefore its own key space
 * rather than sharing this one.
 */
export function scopeKey(
  actorId: string,
  botId: string,
  epoch: number,
): string {
  return joinKey(["wb", actorId, botId, String(epoch)]);
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
    key: scopeKey(input.actorId, input.botId, input.epoch),
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

function mac(scopeKey: string, payload: string): Uint8Array {
  const hmac = createHmac("sha256", CURSOR_KEY);
  hmac.update(scopeKey);
  hmac.update("\u0000");
  hmac.update(payload);
  return new Uint8Array(hmac.digest());
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Bind a pagination payload to the scope that minted it. */
export function bindCursor(scope: ObservationScope, payload: string): string {
  assertObservationScope(scope);
  return `${encode(Buffer.from(payload, "utf8"))}.${encode(mac(scope.key, payload))}`;
}

/**
 * Read a cursor back. A cursor from another scope, another ownership epoch, or a tampered payload
 * is an authorization failure — not an empty page, and not a silent restart from page one.
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
  const expected = mac(scope.key, payload);
  if (
    offered.length !== expected.length ||
    !timingSafeEqual(offered, expected)
  ) {
    throw new ObservationScopeError("OWNERSHIP_REQUIRED", 403);
  }
  return payload;
}

/** Cache, job and export keys all carry the scope key, so none of them can be reused across scopes. */
export function cacheKey(
  scope: ObservationScope,
  name: string,
  ...parts: Array<string | number>
): string {
  assertObservationScope(scope);
  return joinKey(["cache", scope.key, name, ...parts.map(String)]);
}

export function jobKey(
  scope: ObservationScope,
  name: string,
  idempotencyKey: string,
): string {
  assertObservationScope(scope);
  return joinKey(["job", scope.key, name, idempotencyKey]);
}

export function exportKey(scope: ObservationScope, exportId: string): string {
  assertObservationScope(scope);
  return joinKey(["export", scope.key, exportId]);
}

/**
 * Where this scope's records live upstream.
 *
 * Derived FROM the authorized scope key. Never the other way round: an upstream workspace or
 * project name is a storage address, not a permission, and a layout that happens to look like a
 * tenant boundary proves nothing. No function here reconstructs a scope from a locator.
 *
 * The fingerprint carries the key length for readability plus a 16-hex-char prefix of the full
 * key's hash: two scopes can hold the same botId and epochs while their keys stay the same length,
 * so length alone does not separate them. The hash is one-way; the key is not recoverable from a
 * locator.
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
    project: `bot-${scope.botId}-${fingerprint}-${scope.epoch}`,
  });
}

/** Whether this scope may run evaluations. The workbench adapter's answer is the scope itself. */
export function resolveEvaluationEligibility(
  scope: ObservationScope,
): EvaluationEligibility {
  assertObservationScope(scope);
  return Object.freeze({ allowed: true as const, scopeKey: scope.key });
}
