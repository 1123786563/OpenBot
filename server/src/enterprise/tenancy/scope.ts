/**
 * Scope issuance and process-internal trust, per plan 02 §6 T2-A.
 *
 * `resolveScope` is the ONLY way a scope comes to exist: it takes the userId the AuthService
 * verified (never a body/header value), the tenant selector the caller chose, and the directory's
 * answer about that user's memberships — and refuses everything that is not a fully active
 * user → principal → membership → tenant chain. There is no global "current tenant" variable; the
 * scope is an explicit argument every consumer must carry.
 *
 * Trust is recorded in a module-private WeakSet: only the frozen objects this process actually
 * issued answer `assertScope`. A serialized-and-restored scope, a spread copy, or a hand-built
 * plain object is not in the set and fails closed. Background workers must re-derive a scope from
 * their own authenticated identity and the live directory; deliberately NOT exported is any
 * `issueScopeUnsafe`-style escape hatch.
 */
import type { Directory, Scope } from "../contracts";
import { EnterpriseError } from "../errors";

const issued = new WeakSet<object>();

/** Same shape the tenant selector allows: URL-safe, non-empty, bounded. */
const SELECTOR_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export async function resolveScope(
  directory: Directory,
  userId: string,
  selector: string | undefined,
): Promise<Scope> {
  if (!userId || userId === "dev-local-user") {
    throw new EnterpriseError("AUTH_REQUIRED", 401);
  }
  if (!selector || !SELECTOR_PATTERN.test(selector)) {
    throw new EnterpriseError("TENANT_REQUIRED", 400);
  }
  const rows = await directory.listForUser(userId);
  const member = rows.find((row) => row.tenantId === selector);
  /* A missing membership and a degraded one are the same refusal: no scope. */
  if (
    member?.tenantStatus !== "active" ||
    member.principalStatus !== "active" ||
    member.memberStatus !== "active"
  ) {
    throw new EnterpriseError("TENANT_FORBIDDEN", 403);
  }
  const scope: Scope = Object.freeze({
    tenantId: member.tenantId,
    principalId: member.principalId,
    userId,
    role: member.role,
    epoch: member.epoch,
  });
  issued.add(scope);
  return scope;
}

export function assertScope(scope: Scope): void {
  if (!issued.has(scope)) {
    throw new EnterpriseError("UNVERIFIED_SCOPE", 403);
  }
}
