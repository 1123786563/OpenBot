/*
 * TeamManagementGrant handlers (T04.07 / #551, original task P09; interfaces
 * §2 payload table, §3 TeamManagementGrantView, design §4.4 / §6.4).
 *
 * What this file owns, and nothing else:
 *
 * 1. Grant. `team.management.grant` lets a current owner/admin of a company
 *    delegate the fixed team-member-management actions of ONE team to an
 *    existing active member of THAT team. The grant carries the grantee's
 *    identity / company / team eligibility generations snapshotted at grant
 *    time (design §4.4: 适用授权保存签发时的代际并在使用时比较) plus its own
 *    `generation`. The same (tenant, workspace, principal) keeps ONE stable
 *    row: a change / revoke / re-grant advances that row's generation, and
 *    revocation is a status, never a deletion.
 *
 * 2. Revoke. `team.management.revoke` sets the stable row's status to
 *    `revoked` and advances its generation by exactly one under the same
 *    tenant lock (0217's guard enforces the +1 and the immutable identity
 *    columns). Any current company owner/admin may revoke, per design §6.4.
 *
 * The handler resolves the grantee's principal from the request `userId`
 * (the server never takes a principal from a client), re-verifies the
 * grantor's live owner/admin role, the target team's binding to the named
 * workspace and tenant, and the grantee's active team membership inside the
 * tenant lock — exactly the locked authorization the executor re-runs on
 * replay. A plain member cannot call these commands, because the authority
 * gate admits `team.management.grant` / `team.management.revoke` only to the
 * company-role writer; those are not team-grant capabilities.
 *
 * The receipt carries grantId / grantGeneration (DirectoryResult.grantId /
 * grantGeneration): a fresh command returns the stable row's id and the
 * generation the command produced; the frozen 0214 finalize function set has
 * no controlled writer for those forward columns, so a replay reads them
 * from the handler outcome and may return null when replayed before a later
 * wiring step stamps them — a disclosed boundary, not a skipped duty.
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { authTeamManagementGrants } from "../../db/schema/auth-directory";
import type {
  Directory,
  DirectoryActor,
  DirectoryTx,
  TeamManagementGrantView,
  Version,
} from "./contracts";
import type { DirectoryCommandHandler } from "./executor";

/** The closed action domain this grant delegates (interfaces §2 / §3). */
const TEAM_MANAGEMENT_ACTIONS = [
  "team.member.add",
  "team.member.remove",
] as const;

/** The handler's refusal codes — each carries its own HTTP status. */
export const TEAM_GRANT_ACTOR_FORBIDDEN = "TEAM_GRANT_ACTOR_FORBIDDEN";
export const TEAM_GRANT_COMPANY_NOT_FOUND = "TEAM_GRANT_COMPANY_NOT_FOUND";
export const TEAM_GRANT_COMPANY_CLOSED = "TEAM_GRANT_COMPANY_CLOSED";
export const TEAM_GRANT_TEAM_FORBIDDEN = "TEAM_GRANT_TEAM_FORBIDDEN";
export const TEAM_GRANT_TARGET_NOT_TEAM_MEMBER =
  "TEAM_GRANT_TARGET_NOT_TEAM_MEMBER";
export const TEAM_GRANT_TARGET_NOT_FOUND = "TEAM_GRANT_TARGET_NOT_FOUND";
export const TEAM_GRANT_GRANT_NOT_FOUND = "TEAM_GRANT_GRANT_NOT_FOUND";
export const TEAM_GRANT_GRANT_ALREADY_REVOKED =
  "TEAM_GRANT_GRANT_ALREADY_REVOKED";
export const TEAM_GRANT_GRANT_WORKSPACE_MISMATCH =
  "TEAM_GRANT_GRANT_WORKSPACE_MISMATCH";
export const TEAM_GRANT_UNKNOWN = "TEAM_GRANT_UNKNOWN";

/** A refusal carrying its own HTTP status (interfaces §4: refusal → projection). */
export class TeamGrantRefusal extends Error {
  readonly status: 400 | 403 | 404 | 409;

  constructor(
    readonly code: string,
    detail: string,
    status: 400 | 403 | 404 | 409,
  ) {
    super(`${code}: ${detail}`);
    this.name = "TeamGrantRefusal";
    this.status = status;
  }
}

export function isTeamGrantRefusal(error: unknown): error is TeamGrantRefusal {
  return error instanceof TeamGrantRefusal;
}

function refusal(
  code: string,
  detail: string,
  status: 400 | 403 | 404 | 409,
): TeamGrantRefusal {
  return new TeamGrantRefusal(code, detail, status);
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * Encodes a string list as a Postgres text[] literal. The bun-sql binding
 * expands a JS array parameter into a row tuple `($1, $2)` — never an array —
 * so `text[]` columns and `= ANY(...)` predicates must take the literal.
 */
function pgTextArray(values: readonly string[]): string {
  return `{${values
    .map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",")}}`;
}

/** The grantee's principal and live eligibility generations in one read. */
interface GranteeEligibility {
  readonly principalId: string;
  readonly identityGeneration: number;
  readonly companyGeneration: number;
  readonly teamGeneration: number;
}

/**
 * Resolves the grantee's principal and eligibility facts from their `userId`:
 * (a) the user maps to exactly one principal, (b) that principal is an active
 * member of the company, (c) the user is a row in auth_team_members for the
 * target team (membership is existence — the table has no status column), and
 * (d) the company and team eligibility clocks exist, are not tombstoned, and
 * carry a verifiable generation. A missing/unverifiable fact is refused, never
 * defaulted to 0.
 */
async function readGrantee(
  tx: DirectoryTx,
  tenantId: string,
  workspaceId: string,
  teamId: string,
  userId: string,
): Promise<GranteeEligibility | null> {
  const [principal] = rowsOf<{
    id: string;
    status: string;
    identity_generation: number;
  }>(
    await tx.execute(
      sql`SELECT id, status, identity_generation FROM enterprise_principals WHERE user_id = ${userId} LIMIT 1`,
    ),
  );
  if (!principal || String(principal.status) !== "active") return null;

  const [membership] = rowsOf<{ status: string }>(
    await tx.execute(
      sql`SELECT status FROM enterprise_memberships
           WHERE tenant_id = ${tenantId} AND principal_id = ${principal.id} LIMIT 1`,
    ),
  );
  if (!membership || String(membership.status) !== "active") return null;

  const [teamMember] = rowsOf<{ user_id: string }>(
    await tx.execute(
      sql`SELECT user_id FROM auth_team_members
           WHERE team_id = ${teamId} AND user_id = ${userId} LIMIT 1`,
    ),
  );
  if (!teamMember) return null;

  const [clock] = rowsOf<{
    company_generation: number | null;
    team_generation: number | null;
    company_tombstone: boolean | null;
    team_tombstone: boolean | null;
  }>(
    await tx.execute(
      sql`SELECT
            MAX(CASE WHEN kind = 'company' THEN generation END) AS company_generation,
            MAX(CASE WHEN kind = 'team' AND scope_id = ${workspaceId} THEN generation END) AS team_generation,
            bool_or(CASE WHEN kind = 'company' THEN tombstone END) AS company_tombstone,
            bool_or(CASE WHEN kind = 'team' AND scope_id = ${workspaceId} THEN tombstone END) AS team_tombstone
         FROM auth_eligibility_clocks
        WHERE tenant_id = ${tenantId} AND principal_id = ${principal.id}`,
    ),
  );
  // An unverifiable clock (missing, null generation, or tombstoned) refuses the
  // grant — we never substitute 0 for a history we cannot read.
  if (
    !clock ||
    clock.company_generation === null ||
    clock.team_generation === null ||
    clock.company_tombstone === true ||
    clock.team_tombstone === true
  ) {
    return null;
  }

  return {
    principalId: principal.id,
    identityGeneration: Number(principal.identity_generation),
    companyGeneration: Number(clock.company_generation),
    teamGeneration: Number(clock.team_generation),
  };
}

/**
 * The locked authorization shared by both commands (replay included): the
 * grantor is a session/platform actor with a userId, the company exists and
 * is active, the grantor is a live owner/admin of that company with an active
 * principal and an active business membership, and the named team is bound to
 * the named workspace and tenant. A non-member, a closed company or a missing
 * team is an invisible not-found, never a disclosure.
 */
async function authorizeTeamGrantScope(
  tx: DirectoryTx,
  actor: { kind: string; userId: string | null },
  tenantId: string,
  workspaceId: string,
  teamId: string,
): Promise<void> {
  if (
    (actor.kind !== "session" && actor.kind !== "platform") ||
    !actor.userId
  ) {
    throw refusal(
      TEAM_GRANT_ACTOR_FORBIDDEN,
      `a ${actor.kind} actor cannot manage team grants; the management-grant commands are exercised by a signed-in company administrator or a server-orchestrated operator identity, and the actor is the server's, never a client field`,
      403,
    );
  }
  const [tenant] = rowsOf<{ status: string }>(
    await tx.execute(
      sql`SELECT status FROM enterprise_tenants WHERE id = ${tenantId} LIMIT 1`,
    ),
  );
  if (!tenant) {
    throw refusal(
      TEAM_GRANT_COMPANY_NOT_FOUND,
      `company ${tenantId} does not exist; the command answers not-found rather than inventing a directory`,
      404,
    );
  }
  if (String(tenant.status) !== "active") {
    throw refusal(
      TEAM_GRANT_COMPANY_CLOSED,
      `company ${tenantId} is ${String(tenant.status)}; every management-grant command of a suspended or provisioning company is refused`,
      403,
    );
  }
  const [me] = rowsOf<{ role: string }>(
    await tx.execute(
      sql`SELECT role FROM auth_members
           WHERE organization_id = ${tenantId} AND user_id = ${actor.userId} LIMIT 1`,
    ),
  );
  if (!me) {
    throw refusal(
      TEAM_GRANT_ACTOR_FORBIDDEN,
      `user ${actor.userId} is not a member of company ${tenantId}; a non-member never grants or revokes`,
      403,
    );
  }
  if (!["owner", "admin"].includes(String(me.role))) {
    throw refusal(
      TEAM_GRANT_ACTOR_FORBIDDEN,
      `the caller's live company role is "${String(me.role)}"; managing team grants needs an owner or admin`,
      403,
    );
  }
  const [grantorPrincipal] = rowsOf<{ id: string; status: string }>(
    await tx.execute(
      sql`SELECT id, status FROM enterprise_principals WHERE user_id = ${actor.userId} LIMIT 1`,
    ),
  );
  if (!grantorPrincipal || String(grantorPrincipal.status) !== "active") {
    throw refusal(
      TEAM_GRANT_ACTOR_FORBIDDEN,
      `the principal behind user ${actor.userId} is ${String(grantorPrincipal?.status ?? "missing")}; a disabled identity's management-grant commands are closed`,
      403,
    );
  }
  const [membership] = rowsOf<{ status: string }>(
    await tx.execute(
      sql`SELECT status FROM enterprise_memberships
           WHERE tenant_id = ${tenantId} AND principal_id = ${grantorPrincipal.id} LIMIT 1`,
    ),
  );
  if (!membership || String(membership.status) !== "active") {
    throw refusal(
      TEAM_GRANT_ACTOR_FORBIDDEN,
      `the business membership of user ${actor.userId} in company ${tenantId} is ${String(membership?.status ?? "missing")}; a suspended member's management-grant commands are closed`,
      403,
    );
  }
  const [team] = rowsOf<{ team_id: string; organization_id: string }>(
    await tx.execute(
      sql`SELECT b.team_id, b.tenant_id AS organization_id
           FROM auth_team_bindings b
           WHERE b.workspace_id = ${workspaceId} AND b.tenant_id = ${tenantId}
           LIMIT 1`,
    ),
  );
  if (!team || team.team_id !== teamId || team.organization_id !== tenantId) {
    throw refusal(
      TEAM_GRANT_TEAM_FORBIDDEN,
      `team ${teamId} is not bound to workspace ${workspaceId} of company ${tenantId}; a grant may only name a team the grantor's company owns`,
      404,
    );
  }
}

/** The (workspace, team) binding: the team bound to this workspace+tenant. */
async function resolveTeamId(
  tx: DirectoryTx,
  tenantId: string,
  workspaceId: string,
): Promise<string> {
  const [binding] = rowsOf<{ team_id: string }>(
    await tx.execute(
      sql`SELECT team_id FROM auth_team_bindings
           WHERE workspace_id = ${workspaceId} AND tenant_id = ${tenantId} LIMIT 1`,
    ),
  );
  if (!binding) {
    throw refusal(
      TEAM_GRANT_TEAM_FORBIDDEN,
      `workspace ${workspaceId} is not bound to a team of company ${tenantId}`,
      404,
    );
  }
  return binding.team_id;
}

/** One stable grant row by (tenant, workspace, principal), or null. */
async function readGrantByScope(
  tx: DirectoryTx,
  tenantId: string,
  workspaceId: string,
  principalId: string,
): Promise<{
  grantId: string;
  generation: number;
  status: string;
} | null> {
  const [row] = await tx
    .select({
      grantId: authTeamManagementGrants.grantId,
      generation: authTeamManagementGrants.generation,
      status: authTeamManagementGrants.status,
    })
    .from(authTeamManagementGrants)
    .where(
      and(
        eq(authTeamManagementGrants.tenantId, tenantId),
        eq(authTeamManagementGrants.workspaceId, workspaceId),
        eq(authTeamManagementGrants.principalId, principalId),
      ),
    )
    .limit(1);
  return row
    ? {
        grantId: row.grantId,
        generation: Number(row.generation),
        status: row.status,
      }
    : null;
}

/** One stable grant row by grantId, or null. */
async function readGrantRow(
  tx: DirectoryTx,
  grantId: string,
): Promise<{
  tenantId: string;
  workspaceId: string;
  teamId: string;
  principalId: string;
  status: string;
  generation: number;
} | null> {
  const [row] = await tx
    .select({
      tenantId: authTeamManagementGrants.tenantId,
      workspaceId: authTeamManagementGrants.workspaceId,
      teamId: authTeamManagementGrants.teamId,
      principalId: authTeamManagementGrants.principalId,
      status: authTeamManagementGrants.status,
      generation: authTeamManagementGrants.generation,
    })
    .from(authTeamManagementGrants)
    .where(eq(authTeamManagementGrants.grantId, grantId))
    .limit(1);
  return row
    ? {
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        teamId: row.teamId,
        principalId: row.principalId,
        status: row.status,
        generation: Number(row.generation),
      }
    : null;
}

/** The grantor's principal id — the row's granted_by. */
async function grantorPrincipalId(
  tx: DirectoryTx,
  userId: string,
): Promise<string> {
  const [principal] = rowsOf<{ id: string }>(
    await tx.execute(
      sql`SELECT id FROM enterprise_principals WHERE user_id = ${userId} LIMIT 1`,
    ),
  );
  if (!principal) {
    throw refusal(
      TEAM_GRANT_ACTOR_FORBIDDEN,
      `the grantor user ${userId} has no principal; the grant cannot be recorded without one`,
      403,
    );
  }
  return principal.id;
}

function dedupeActions(actions: readonly string[]): readonly string[] {
  const set = new Set<string>();
  const out: string[] = [];
  for (const action of actions) {
    if (
      !TEAM_MANAGEMENT_ACTIONS.includes(
        action as (typeof TEAM_MANAGEMENT_ACTIONS)[number],
      )
    ) {
      throw refusal(
        TEAM_GRANT_TARGET_NOT_FOUND,
        `action "${action}" is not a team-management action`,
        400,
      );
    }
    if (!set.has(action)) {
      set.add(action);
      out.push(action);
    }
  }
  return out;
}

/**
 * `team.management.grant` — the directory handler. Resolves the grantee, keeps
 * the one stable row per (tenant, workspace, principal): an INSERT at
 * generation 1 when none exists, otherwise an UPDATE that advances the same
 * row's generation and (re)activates it. Returns the stable row's grantId and
 * the generation the command produced (DirectoryResult.grantId /
 * grantGeneration).
 */
export function createTeamManagementGrantHandler(): DirectoryCommandHandler {
  return {
    async authorize(context) {
      const payload = context.command.payload as {
        readonly workspaceId?: string;
        readonly userId?: string;
        readonly actions?: readonly string[];
      };
      if (
        typeof payload.workspaceId !== "string" ||
        payload.workspaceId.trim() === "" ||
        typeof payload.userId !== "string" ||
        payload.userId.trim() === ""
      ) {
        throw refusal(
          TEAM_GRANT_TARGET_NOT_FOUND,
          "team.management.grant requires a workspaceId and a userId",
          400,
        );
      }
      const teamId = await resolveTeamId(
        context.tx,
        context.command.tenantId,
        payload.workspaceId,
      );
      await authorizeTeamGrantScope(
        context.tx,
        context.actor,
        context.command.tenantId,
        payload.workspaceId,
        teamId,
      );
    },
    async sync(context) {
      const payload = context.command.payload as {
        readonly workspaceId: string;
        readonly userId: string;
        readonly actions: readonly string[];
      };
      const tenantId = context.command.tenantId;
      const workspaceId = payload.workspaceId;
      const teamId = await resolveTeamId(context.tx, tenantId, workspaceId);

      const actions = dedupeActions(payload.actions);
      if (actions.length === 0) {
        throw refusal(
          TEAM_GRANT_TARGET_NOT_FOUND,
          "team.management.grant requires at least one fixed action",
          400,
        );
      }

      const grantee = await readGrantee(
        context.tx,
        tenantId,
        workspaceId,
        teamId,
        payload.userId,
      );
      if (!grantee) {
        throw refusal(
          TEAM_GRANT_TARGET_NOT_TEAM_MEMBER,
          `user ${payload.userId} is not an active member of team ${teamId} with verifiable eligibility; a management grant may only be delegated to such a member`,
          403,
        );
      }

      const actorUserId = context.actor.userId;
      if (!actorUserId) {
        throw refusal(
          TEAM_GRANT_ACTOR_FORBIDDEN,
          "team.management.grant requires a user actor; the executor's authorize phase already guarantees one",
          403,
        );
      }
      const grantedBy = await grantorPrincipalId(context.tx, actorUserId);
      const existing = await readGrantByScope(
        context.tx,
        tenantId,
        workspaceId,
        grantee.principalId,
      );

      let grantId: string;
      let generation: number;
      if (existing) {
        grantId = existing.grantId;
        generation = existing.generation + 1;
        // The snapshot generations are deliberately not refreshed: 0217
        // freezes only the five identity columns, and the common constraint
        // forbids backfilling expired source versions with current identity —
        // a re-grant keeps the original grantee facts and only advances
        // generation, swaps actions, and (re)activates the row.
        await context.tx.execute(
          sql`UPDATE auth_team_management_grants
               SET actions = ${pgTextArray(actions)}::text[],
                   generation = ${generation},
                   status = 'active',
                   granted_by = ${grantedBy},
                   revoked_at = NULL
             WHERE grant_id = ${grantId}`,
        );
      } else {
        grantId = randomUUID();
        generation = 1;
        await context.tx.execute(
          sql`INSERT INTO auth_team_management_grants
              (grant_id, tenant_id, workspace_id, team_id, principal_id, actions,
               generation, identity_generation, company_generation, team_generation,
               granted_by, status, created_at)
            VALUES
              (${grantId}, ${tenantId}, ${workspaceId}, ${teamId}, ${grantee.principalId},
               ${pgTextArray(actions)}::text[], ${generation}, ${grantee.identityGeneration},
               ${grantee.companyGeneration}, ${grantee.teamGeneration},
               ${grantedBy}, 'active', now())`,
        );
      }

      return { grantId, grantGeneration: generation as Version };
    },
  };
}

/**
 * `team.management.revoke` — the directory handler. The grantId names a stable
 * row scoped to this company; revoke sets its status to revoked and advances
 * its generation by one. Returns the row's grantId and the advanced generation.
 */
export function createTeamManagementRevokeHandler(): DirectoryCommandHandler {
  return {
    async authorize(context) {
      const payload = context.command.payload as {
        readonly grantId?: string;
        readonly reason?: string;
      };
      if (
        typeof payload.grantId !== "string" ||
        payload.grantId.trim() === ""
      ) {
        throw refusal(
          TEAM_GRANT_UNKNOWN,
          "team.management.revoke requires a grantId",
          400,
        );
      }
      const row = await readGrantRow(context.tx, payload.grantId);
      if (!row) {
        throw refusal(
          TEAM_GRANT_GRANT_NOT_FOUND,
          `grant ${payload.grantId} does not exist in this company`,
          404,
        );
      }
      if (row.tenantId !== context.command.tenantId) {
        throw refusal(
          TEAM_GRANT_GRANT_NOT_FOUND,
          `grant ${payload.grantId} is not scoped to company ${context.command.tenantId}`,
          404,
        );
      }
      if (row.status === "revoked") {
        throw refusal(
          TEAM_GRANT_GRANT_ALREADY_REVOKED,
          `grant ${payload.grantId} is already revoked`,
          409,
        );
      }
      await authorizeTeamGrantScope(
        context.tx,
        context.actor,
        context.command.tenantId,
        row.workspaceId,
        row.teamId,
      );
    },
    async sync(context) {
      const payload = context.command.payload as { readonly grantId: string };
      const row = await readGrantRow(context.tx, payload.grantId);
      if (!row) {
        throw refusal(
          TEAM_GRANT_GRANT_NOT_FOUND,
          `grant ${payload.grantId} does not exist in this company`,
          404,
        );
      }
      const generation = row.generation + 1;
      await context.tx.execute(
        sql`UPDATE auth_team_management_grants
             SET status = 'revoked', generation = ${generation}, revoked_at = now()
           WHERE grant_id = ${payload.grantId}`,
      );
      return {
        grantId: payload.grantId,
        grantGeneration: generation as Version,
      };
    },
  };
}

/** Read-side: the TeamManagementGrantView rows for one workspace. */
export async function listTeamManagementGrants(
  tx: DirectoryTx,
  tenantId: string,
  workspaceId: string,
): Promise<readonly TeamManagementGrantView[]> {
  const rows = await tx
    .select({
      grantId: authTeamManagementGrants.grantId,
      tenantId: authTeamManagementGrants.tenantId,
      workspaceId: authTeamManagementGrants.workspaceId,
      principalId: authTeamManagementGrants.principalId,
      actions: authTeamManagementGrants.actions,
      generation: authTeamManagementGrants.generation,
      status: authTeamManagementGrants.status,
    })
    .from(authTeamManagementGrants)
    .where(
      and(
        eq(authTeamManagementGrants.tenantId, tenantId),
        eq(authTeamManagementGrants.workspaceId, workspaceId),
      ),
    );
  const principalIds = rows.map((row) => row.principalId);
  const userById = new Map<string, string>();
  if (principalIds.length > 0) {
    const users = rowsOf<{ id: string; user_id: string }>(
      await tx.execute(
        sql`SELECT id, user_id FROM enterprise_principals
             WHERE id = ANY(${pgTextArray(principalIds)}::text[])`,
      ),
    );
    for (const user of users) userById.set(user.id, user.user_id);
  }
  return rows.map((row) => ({
    grantId: row.grantId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    userId: userById.get(row.principalId) ?? row.principalId,
    actions: (row.actions ?? []) as (
      | "team.member.add"
      | "team.member.remove"
    )[],
    generation: Number(row.generation),
    status: row.status as "active" | "revoked",
  }));
}

/*
 * The HTTP port the company admin routes consume (T04.07 / #551, P09): it runs
 * the management-grant commands inside the grantor's trusted server-issued
 * actor and lists the stable rows. The company-role authorization and the
 * team/target eligibility re-verification live in the directory command the
 * handlers execute (the same lock the executor replays), so the port only
 * builds the actor and translates command results.
 */
export interface CompanyTeamGrantPort {
  listGrants(input: {
    readonly tenantId: string;
    readonly workspaceId: string;
  }): Promise<readonly TeamManagementGrantView[]>;
  grant(input: {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly actorPrincipalId: string;
    readonly userId: string;
    readonly actions: readonly ("team.member.add" | "team.member.remove")[];
    readonly idempotencyKey: string;
  }): Promise<{
    readonly grantId: string;
    readonly grantGeneration: number;
    readonly replayed: boolean;
  }>;
  revoke(input: {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly actorPrincipalId: string;
    readonly grantId: string;
    readonly reason: string;
  }): Promise<{
    readonly grantId: string;
    readonly grantGeneration: number;
    readonly replayed: boolean;
  }>;
}

function actorOf(userId: string, principalId: string): DirectoryActor {
  // kind "platform", not "session": assertDirectoryActor demands a sessionId
  // for a session actor, and the admin context seam carries none — the same
  // server-issued platform-actor precedent the membership translation uses
  // (membership.ts actorOf). The handler still re-verifies the live
  // owner/admin role inside the lock, so no authority is assumed.
  return {
    userId,
    principalId,
    sessionId: null,
    kind: "platform",
    bindingId: null,
    provisioning: null,
  };
}

/**
 * Builds the management-grant port over the directory executor. The port reads
 * the stable grant row directly for the workspace-containment check on revoke
 * (the revoke command payload carries only grantId + reason, per the frozen
 * envelope) and derives revoke's idempotency key from that row's CURRENT
 * generation (interfaces §3, r1 remediation 2026-10-27): a same-generation
 * repeat is a true replay, while a revoke after a re-grant — the row's
 * generation has advanced — is a fresh command that never collides with the
 * earlier receipt into a silent no-op. Otherwise authorization is delegated
 * to the command handler.
 */
export function createDirectoryTeamGrantPort(
  directory: Directory,
  db: Database,
): CompanyTeamGrantPort {
  return {
    async listGrants(input) {
      return listTeamManagementGrants(
        db as never,
        input.tenantId,
        input.workspaceId,
      );
    },
    async grant(input) {
      const result = await directory.execute(
        actorOf(input.actorUserId, input.actorPrincipalId),
        {
          operation: "team.management.grant",
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
          payload: {
            workspaceId: input.workspaceId,
            userId: input.userId,
            actions: [...input.actions],
          },
        },
      );
      return {
        grantId: result.grantId ?? "",
        grantGeneration: result.grantGeneration ?? 0,
        replayed: result.replayed,
      };
    },
    async revoke(input) {
      const row = await readGrantRow(db as never, input.grantId);
      if (!row) {
        throw refusal(
          TEAM_GRANT_GRANT_NOT_FOUND,
          `grant ${input.grantId} does not exist in this company`,
          404,
        );
      }
      if (row.tenantId !== input.tenantId) {
        throw refusal(
          TEAM_GRANT_GRANT_NOT_FOUND,
          `grant ${input.grantId} is not scoped to company ${input.tenantId}`,
          404,
        );
      }
      if (row.workspaceId !== input.workspaceId) {
        throw refusal(
          TEAM_GRANT_GRANT_WORKSPACE_MISMATCH,
          `grant ${input.grantId} is not scoped to workspace ${input.workspaceId}`,
          404,
        );
      }
      const result = await directory.execute(
        actorOf(input.actorUserId, input.actorPrincipalId),
        {
          operation: "team.management.revoke",
          tenantId: input.tenantId,
          // Per-generation key (interfaces §3): the pre-read row's generation
          // pins which revocation this command re-attempts.
          idempotencyKey: `revoke-${input.grantId}-${row.generation}`,
          payload: { grantId: input.grantId, reason: input.reason },
        },
      );
      return {
        grantId: result.grantId ?? input.grantId,
        grantGeneration: result.grantGeneration ?? 0,
        replayed: result.replayed,
      };
    },
  };
}
