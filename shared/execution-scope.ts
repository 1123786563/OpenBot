/**
 * The execution ownership every native component carries on its wire (MT050 / Issue #93).
 *
 * The deployment token a native process checks (supervisor Bearer, sandbox and computer
 * `x-*-token`) proves only "a caller of this deployment" — every holder of the shared secret is
 * equivalent at the machine level, so the ownership facts of the execution (which company, which
 * team) were dropped at the boundary. These two headers put them back the same way on every native
 * surface, mirroring what `VerifiedRun` carries for the Go runtime: the caller states the scope the
 * execution belongs to, the native process refuses to act without it, and refuses again when the
 * stated scope disagrees with the one a Bot is already bound to.
 *
 * The value set is deliberately small: a plain id for the company (tenant) and one for the team
 * (workspace), the same identifiers `PlatformScope` carries. No principal, no epoch, no secrets —
 * this is a routing-and-isolation fact, not a credential. A header here never authorizes anything on
 * its own; each native surface still applies its token first and its own scope binding second.
 */

/** The header names, frozen in one place so the three native surfaces cannot drift apart. */
export const EXECUTION_TENANT_HEADER = "x-openbot-tenant-id";
export const EXECUTION_WORKSPACE_HEADER = "x-openbot-workspace-id";

/** The ownership an execution belongs to, as the caller stated it on the wire. */
export interface ExecutionScope {
  readonly tenantId: string;
  readonly workspaceId: string;
}

/**
 * What a scope id may contain: lowercase letters, digits, dashes — the shape of the ids the
 * tenancy tables mint. Enforced rather than trusted because these values become directory names
 * inside native processes (`…/tenants/<t>/workspaces/<w>/bots/<b>`), so a crafted id must not be
 * able to climb out of its segment.
 */
const PLAIN_SCOPE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

/** Whether a value is a scope id a native process may act on. */
export function isPlainScopeId(value: unknown): value is string {
  return typeof value === "string" && PLAIN_SCOPE_ID.test(value);
}

/**
 * The execution scope a request claims, or null when either field is missing or not a plain id.
 *
 * Null, not a partial scope: an execution whose company is known but whose team is not is an
 * execution whose ownership was dropped halfway, and "reject when missing" (acceptance 1) is the
 * only answer that cannot be widened later into "defaulted to the company".
 */
export function parseExecutionScope(
  headers: Headers | Record<string, string | undefined>,
): ExecutionScope | null {
  const read = (name: string): unknown =>
    typeof (headers as { get?: unknown }).get === "function"
      ? (headers as Headers).get(name)
      : (headers as Record<string, string | undefined>)[name];
  const tenantId = read(EXECUTION_TENANT_HEADER);
  const workspaceId = read(EXECUTION_WORKSPACE_HEADER);
  if (!isPlainScopeId(tenantId) || !isPlainScopeId(workspaceId)) return null;
  return { tenantId, workspaceId };
}

/**
 * The scope, for a log line or an audit row: the identifiers only, never anything that could
 * carry a secret. Presence-checked by the caller so a refusal can say "none" without echoing
 * what was offered.
 */
export function describeExecutionScope(scope: ExecutionScope): string {
  return `tenant ${scope.tenantId} workspace ${scope.workspaceId}`;
}

/**
 * The per-Bot binding a native process keeps: which scope a Bot's execution state belongs to.
 *
 * Bot ids are globally unique and pinned to exactly one (company, team) by the ownership table
 * the server resolves from, so a first use binds and every later use must agree. A disagreement
 * is not a migration — it is one scope's caller reaching for another scope's Bot, and the native
 * process is the last place that fact can still be refused (acceptance 2: local trust is not a
 * reason to skip the check).
 */
export class ExecutionScopeRegistry {
  private readonly bound = new Map<string, ExecutionScope>();

  /**
   * Bind on first sight, agree forever after. False when the scope contradicts an earlier
   * binding, which is the refusal the caller must hear.
   */
  bind(botId: string, scope: ExecutionScope): boolean {
    const existing = this.bound.get(botId);
    if (existing) {
      return (
        existing.tenantId === scope.tenantId &&
        existing.workspaceId === scope.workspaceId
      );
    }
    this.bound.set(botId, scope);
    return true;
  }

  /** The scope a Bot is bound to, for naming new state before any request arrives. */
  scopeOf(botId: string): ExecutionScope | undefined {
    return this.bound.get(botId);
  }

  // No release: a workspace reset deletes content, not ownership — the Bot's
  // scope is a fact the server pinned, and a native process has no signal that
  // could honestly reverse it. The binding lives as long as the process does.
}

/**
 * The ownership-named layout for a Bot's execution state (MT047: 快照与工作目录按归属命名与隔离).
 *
 * `<root>/tenants/<tenant>/workspaces/<workspace>/bots/<botId>` — the segments the sandbox builds
 * its Bot directories from and the server-side artifact service builds its registry paths from, so
 * the two sides cannot drift into disagreeing about where a scope's state lives. Pure segments, no
 * filesystem: the caller joins them against its own root. Because every segment is a plain id
 * (validated above) plus the fixed literal names, a scope can never name a path that climbs into
 * another scope's tree — and a cleanup that enumerates one scope's segments cannot reach another's.
 */
export function executionWorkspaceSegments(
  scope: ExecutionScope,
  botId: string,
): readonly string[] {
  return [
    "tenants",
    scope.tenantId,
    "workspaces",
    scope.workspaceId,
    "bots",
    botId,
  ];
}
