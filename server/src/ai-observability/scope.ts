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
import {
  ObservationScopeError,
  type ObservationScope,
  type ScopeResolutionInput,
} from "./contracts";

const issued = new WeakSet<object>();

/** The dev placeholder the enterprise seam also refuses: a scope needs a real authenticated id. */
const PLACEHOLDER_ACTOR = "dev-local-user";

/**
 * Key layout: length-prefixed so a botId containing the separator cannot shift fields and collide
 * with another (actor, bot, epoch) triple. `wb` is the kind tag; a future kind gets its own tag and
 * therefore its own key space rather than sharing this one.
 */
export function scopeKey(actorId: string, botId: string, epoch: number): string {
  const parts = ["wb", actorId, botId, String(epoch)];
  return parts.map((part) => `${part.length}:${part}`).join("|");
}

function isEnterpriseHint(hint: unknown): boolean {
  return hint !== undefined && hint !== null;
}

export function resolveObservationScope(input: ScopeResolutionInput): ObservationScope {
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
export function assertObservationScope(scope: unknown): asserts scope is ObservationScope {
  if (typeof scope !== "object" || scope === null || !issued.has(scope)) {
    throw new ObservationScopeError("OWNERSHIP_REQUIRED", 403);
  }
}
