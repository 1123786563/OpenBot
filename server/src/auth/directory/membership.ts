/*
 * Invitation membership commands (T04.01 / #545, original task P08;
 * interfaces §2 payload table, §3.1 resend ruling, §3.2 D-class rows).
 *
 * What this file owns, and nothing else: the three DirectoryCommandHandlers
 * behind `invitation.create` / `invitation.cancel` / `invitation.resend`,
 * the delegable-role lock, and the one fixed-build seam the create half
 * writes through. The executor owns the tenant lock, the authority gate,
 * the receipt, the commit fences and the finalizer — every refusal here is
 * an in-lock authorization or state verdict, raised before any DML, and the
 * writes themselves run inside the command's own transaction under the
 * T02.06 guard (0216 admits the resend's fresh half).
 *
 * The role lock is the §2 sentence "邀请不能授予 owner": an invitation
 * delegates exactly one of admin/member/auditor. `owner` is a valid
 * DirectoryRole elsewhere (membership, transfer) but never a delegable
 * invitation role, and the wider legacy/finance/platform authorities are not
 * DirectoryRoles at all — the HTTP translation refuses those before the
 * envelope, this handler refuses owner and anything else by name.
 *
 * `invitation.resend` is the OpenBot controlled command the §3.1 ruling
 * defines: it CANCELS the pending record and INSERTS a fresh one inside the
 * same command transaction — one receipt, one audit fact per half, no
 * resurrection of an expired/canceled record, and never the pinned build's
 * native resend branch (whose in-place expiresAt write commits outside the
 * executor transaction; the ingress refuses `resend: true` by name so that
 * branch is unreachable over HTTP).
 */

import { randomUUID } from "node:crypto";
import { getOrgAdapter } from "better-auth/plugins/organization";
import { and, eq, sql } from "drizzle-orm";
import { authInvitations } from "../../db/schema/auth-directory";
import type { DirectoryOperation, DirectoryTx } from "./contracts";
import type {
  DirectoryAuthorizeContext,
  DirectoryCommandHandler,
  DirectoryCommandOutcome,
  DirectorySyncContext,
} from "./executor";

/**
 * The roles an invitation may delegate (interfaces §2: "邀请不能授予
 * owner"). Owner, finance and platform authority are never granted by an
 * invitation; a role outside this closed set is a named 403, never a shape
 * nuance the envelope's Zod enum happens to answer.
 */
export const INVITATION_DELEGABLE_ROLES: readonly string[] = Object.freeze([
  "admin",
  "member",
  "auditor",
]);

export const MEMBERSHIP_INVITATION_ACTOR_FORBIDDEN =
  "MEMBERSHIP_INVITATION_ACTOR_FORBIDDEN";
export const MEMBERSHIP_INVITATION_COMPANY_NOT_FOUND =
  "MEMBERSHIP_INVITATION_COMPANY_NOT_FOUND";
export const MEMBERSHIP_INVITATION_COMPANY_CLOSED =
  "MEMBERSHIP_INVITATION_COMPANY_CLOSED";
export const MEMBERSHIP_INVITATION_ROLE_NOT_DELEGABLE =
  "MEMBERSHIP_INVITATION_ROLE_NOT_DELEGABLE";
export const MEMBERSHIP_INVITATION_EMAIL_INVALID =
  "MEMBERSHIP_INVITATION_EMAIL_INVALID";
export const MEMBERSHIP_INVITATION_TARGET_ALREADY_MEMBER =
  "MEMBERSHIP_INVITATION_TARGET_ALREADY_MEMBER";
export const MEMBERSHIP_INVITATION_ALREADY_PENDING =
  "MEMBERSHIP_INVITATION_ALREADY_PENDING";
export const MEMBERSHIP_INVITATION_WORKSPACE_OUT_OF_COMPANY =
  "MEMBERSHIP_INVITATION_WORKSPACE_OUT_OF_COMPANY";
export const MEMBERSHIP_INVITATION_TEAM_UNBOUND =
  "MEMBERSHIP_INVITATION_TEAM_UNBOUND";
export const MEMBERSHIP_INVITATION_NOT_FOUND =
  "MEMBERSHIP_INVITATION_NOT_FOUND";
export const MEMBERSHIP_INVITATION_NOT_PENDING =
  "MEMBERSHIP_INVITATION_NOT_PENDING";

/**
 * A membership refusal. The status is the HTTP projection of interfaces §4:
 * a malformed invitation is 400, a delegation/authorization refusal is 403,
 * an invisible object is 404, a state conflict is 409.
 */
export class DirectoryMembershipRefusal extends Error {
  constructor(
    readonly code: string,
    detail: string,
    readonly status: 400 | 403 | 404 | 409 | 500 | 503,
  ) {
    super(`${code}: ${detail}`);
    this.name = "DirectoryMembershipRefusal";
  }
}

export function isDirectoryMembershipRefusal(
  error: unknown,
): error is DirectoryMembershipRefusal {
  return error instanceof DirectoryMembershipRefusal;
}

/**
 * The pinned build's invitation writer, bound to the command transaction.
 * The seam is the same shape T01.05 pinned for team members: the fixed
 * organization plugin's own adapter, resolved over the executor's
 * request-local ALS store, restricted to the one operation an invitation
 * command needs. The invitation's id is the server's (the adapter's
 * `forceAllowId` honors it), so the result's resourceId is deterministic.
 */
export interface InvitationBaAccess {
  createInvitation(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly email: string;
    readonly role: string;
    readonly inviterId: string;
    readonly teamIds: readonly string[];
  }): Promise<Readonly<{ invitationId: string; expiresAt: Date }>>;
}

/** The fixed plugin's own createInvitation over the executor's ALS store. */
export function createFixedVersionInvitationCommands(
  context: Parameters<typeof getOrgAdapter>[0],
  options: Parameters<typeof getOrgAdapter>[1] = { teams: { enabled: true } },
): InvitationBaAccess {
  if (options?.teams?.enabled !== true) {
    throw new Error(
      "MEMBERSHIP_INVITATION_REQUIRES_TEAMS: the fixed organization plugin must be configured with teams.enabled; the caller's own resolved options are the ones the pinned adapter sees",
    );
  }
  const adapter = getOrgAdapter(context, options);
  return {
    async createInvitation({ id, tenantId, email, role, inviterId, teamIds }) {
      const created = await adapter.createInvitation({
        invitation: {
          id,
          role,
          email: email.toLowerCase(),
          organizationId: tenantId,
          teamIds: [...teamIds],
        },
        // The pinned adapter reads only the inviter's id; the fixed build
        // resolves everything else from its own context.
        user: { id: inviterId } as never,
      });
      return {
        invitationId: String(created.id),
        expiresAt: new Date(created.expiresAt),
      };
    },
  };
}

export interface InvitationMembershipDeps {
  readonly ba: InvitationBaAccess;
}

interface InvitationPayload {
  readonly invitationId: string;
}

interface InvitationRow {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: string | null;
  readonly status: string;
  readonly teamId: string | null;
}

/** Drizzle's execute answers rows directly on Bun SQL; both shapes read the same. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
}

function refusal(
  code: string,
  detail: string,
  status: 400 | 403 | 404 | 409,
): DirectoryMembershipRefusal {
  return new DirectoryMembershipRefusal(code, detail, status);
}

/** The invitation address shape: exactly one @, non-empty halves, no spaces. */
function assertDelegableEmail(email: string): void {
  const valid =
    email.length > 0 &&
    !/\s/.test(email) &&
    (email.match(/@/g) ?? []).length === 1 &&
    email.split("@").every((half) => half.length > 0);
  if (!valid) {
    throw refusal(
      MEMBERSHIP_INVITATION_EMAIL_INVALID,
      `"${email}" is not a usable invitation address; an invitation targets one verified mailbox`,
      400,
    );
  }
}

async function readInvitationRow(
  tx: DirectoryTx,
  invitationId: string,
): Promise<InvitationRow | null> {
  const [row] = await tx
    .select({
      id: authInvitations.id,
      organizationId: authInvitations.organizationId,
      email: authInvitations.email,
      role: authInvitations.role,
      status: authInvitations.status,
      teamId: authInvitations.teamId,
    })
    .from(authInvitations)
    .where(eq(authInvitations.id, invitationId))
    .limit(1);
  return row ?? null;
}

/**
 * The locked authorization, re-run on every call — replay included, so a
 * revoked actor can never borrow a receipt. The always-half proves the
 * actor is a live company administrator of an active company (session kind,
 * current BA role, active projection membership, untombstoned clock). The
 * fresh-only half (a replay's authorization must not fail because its own
 * earlier commit moved the target's state) proves the operation's payload:
 * a delegable role and address for a create, an in-company pending
 * invitation for a cancel/resend.
 */
async function authorizeInvitation(
  context: DirectoryAuthorizeContext,
): Promise<void> {
  const actor = context.actor;
  if (actor.kind !== "session" || !actor.userId) {
    throw refusal(
      MEMBERSHIP_INVITATION_ACTOR_FORBIDDEN,
      `a ${actor.kind} actor cannot exercise an invitation command; invitations are issued by a signed-in company administrator, and the actor is the server's, never a client field`,
      403,
    );
  }
  const [tenant] = rowsOf(
    await context.tx.execute(
      sql`SELECT status FROM enterprise_tenants WHERE id = ${context.command.tenantId} LIMIT 1`,
    ),
  );
  if (!tenant) {
    throw refusal(
      MEMBERSHIP_INVITATION_COMPANY_NOT_FOUND,
      `company ${context.command.tenantId} does not exist; the invitation answers not-found rather than inventing a directory`,
      404,
    );
  }
  if (String(tenant.status) !== "active") {
    throw refusal(
      MEMBERSHIP_INVITATION_COMPANY_CLOSED,
      `company ${context.command.tenantId} is ${String(tenant.status)}; every invitation command of a suspended or provisioning company is refused`,
      403,
    );
  }
  const [member] = rowsOf(
    await context.tx.execute(
      sql`SELECT role FROM auth_members
           WHERE organization_id = ${context.command.tenantId}
             AND user_id = ${actor.userId} LIMIT 1`,
    ),
  );
  if (!member) {
    throw refusal(
      MEMBERSHIP_INVITATION_ACTOR_FORBIDDEN,
      `user ${actor.userId} is not a member of company ${context.command.tenantId}; a non-member never invites, cancels or resends`,
      403,
    );
  }
  if (!["owner", "admin"].includes(String(member.role))) {
    throw refusal(
      MEMBERSHIP_INVITATION_ACTOR_FORBIDDEN,
      `the caller's live company role is "${String(member.role)}"; inviting needs an owner or admin`,
      403,
    );
  }
  const [principal] = rowsOf(
    await context.tx.execute(
      sql`SELECT id, status FROM enterprise_principals WHERE user_id = ${actor.userId} LIMIT 1`,
    ),
  );
  if (!principal || String(principal.status) !== "active") {
    throw refusal(
      MEMBERSHIP_INVITATION_ACTOR_FORBIDDEN,
      `the principal behind user ${actor.userId} is ${String(principal?.status ?? "missing")}; a disabled identity's invitation commands are closed`,
      403,
    );
  }
  const [membership] = rowsOf(
    await context.tx.execute(
      sql`SELECT status FROM enterprise_memberships
           WHERE tenant_id = ${context.command.tenantId}
             AND principal_id = ${String(principal.id)} LIMIT 1`,
    ),
  );
  if (!membership || String(membership.status) !== "active") {
    throw refusal(
      MEMBERSHIP_INVITATION_ACTOR_FORBIDDEN,
      `the business membership of user ${actor.userId} in company ${context.command.tenantId} is ${String(membership?.status ?? "missing")}; a suspended member's invitation commands are closed`,
      403,
    );
  }
  const [clock] = rowsOf(
    await context.tx.execute(
      sql`SELECT tombstone FROM auth_eligibility_clocks
           WHERE tenant_id = ${context.command.tenantId}
             AND principal_id = ${String(principal.id)}
             AND kind = 'company' AND scope_id = ${context.command.tenantId}
           LIMIT 1`,
    ),
  );
  if (!clock || clock.tombstone === true) {
    throw refusal(
      MEMBERSHIP_INVITATION_ACTOR_FORBIDDEN,
      `no live company clock exists for the actor in company ${context.command.tenantId}; a removed member's invitation commands stay closed`,
      403,
    );
  }

  if (context.commandId !== null) return; // replay: the current-actor half above is the contract
  const payload = context.command.payload as unknown as {
    readonly email?: string;
  };
  switch (context.command.operation) {
    case "invitation.create": {
      const role = String(context.command.payload.role ?? "");
      if (!INVITATION_DELEGABLE_ROLES.includes(role)) {
        throw refusal(
          MEMBERSHIP_INVITATION_ROLE_NOT_DELEGABLE,
          `an invitation cannot delegate the role "${role}"; only admin, member and auditor are delegable, and owner/finance/platform authority is never granted by an invitation`,
          403,
        );
      }
      assertDelegableEmail(String(payload.email ?? ""));
      break;
    }
    case "invitation.cancel":
    case "invitation.resend": {
      const { invitationId } = context.command
        .payload as unknown as InvitationPayload;
      const row = await readInvitationRow(context.tx, invitationId);
      if (!row || row.organizationId !== context.command.tenantId) {
        throw refusal(
          MEMBERSHIP_INVITATION_NOT_FOUND,
          `invitation ${invitationId} does not exist in company ${context.command.tenantId}; another company's invitation is answered exactly like a missing one`,
          404,
        );
      }
      if (row.status !== "pending") {
        throw refusal(
          MEMBERSHIP_INVITATION_NOT_PENDING,
          `invitation ${invitationId} is ${row.status}; only a pending invitation can be canceled or resent, and a resend never revives a canceled or expired record`,
          409,
        );
      }
      break;
    }
    default:
      break;
  }
}

/** Resolves the invitation's granted workspaces to this company's teams. */
async function teamIdsOfWorkspaces(
  tx: DirectoryTx,
  tenantId: string,
  workspaceIds: readonly string[],
): Promise<string[]> {
  const teamIds: string[] = [];
  for (const workspaceId of workspaceIds) {
    const [workspace] = rowsOf(
      await tx.execute(
        sql`SELECT 1 AS present FROM enterprise_workspaces
             WHERE tenant_id = ${tenantId} AND id = ${workspaceId} LIMIT 1`,
      ),
    );
    if (!workspace) {
      throw refusal(
        MEMBERSHIP_INVITATION_WORKSPACE_OUT_OF_COMPANY,
        `workspace ${workspaceId} is not a workspace of company ${tenantId}; another company's workspace is answered exactly like a missing one`,
        404,
      );
    }
    const [binding] = rowsOf(
      await tx.execute(
        sql`SELECT t.id AS team_id FROM auth_team_bindings b
             JOIN auth_teams t ON t.id = b.team_id
             WHERE b.tenant_id = ${tenantId} AND b.workspace_id = ${workspaceId}
             LIMIT 1`,
      ),
    );
    if (!binding) {
      throw refusal(
        MEMBERSHIP_INVITATION_TEAM_UNBOUND,
        `workspace ${workspaceId} has no team binding in company ${tenantId}; an invitation cannot grant an unshaped scope`,
        400,
      );
    }
    teamIds.push(String(binding.team_id));
  }
  return teamIds;
}

/**
 * The `invitation.create` / `invitation.cancel` / `invitation.resend`
 * DirectoryCommandHandlers. Registered on the executor by the assembly; the
 * executor owns the envelope, the locks, the receipt and the finalizer —
 * these handlers own the in-lock authorization above and the atomic writes.
 */
export function createInvitationMembershipHandlers(
  deps: InvitationMembershipDeps,
): Partial<Record<DirectoryOperation, DirectoryCommandHandler>> {
  if (typeof deps?.ba?.createInvitation !== "function") {
    throw new Error(
      "MEMBERSHIP_INVITATION_DEPS_REQUIRED: createInvitationMembershipHandlers needs the fixed-build invitation seam; an invitation command's fresh half is written through the pinned adapter inside the command transaction",
    );
  }
  const ba = deps.ba;

  async function createSync(
    context: DirectorySyncContext,
  ): Promise<DirectoryCommandOutcome> {
    const payload = context.command.payload as {
      readonly email: string;
      readonly role: string;
      readonly workspaceIds: readonly string[];
    };
    const email = payload.email.toLowerCase();
    const [memberByEmail] = rowsOf(
      await context.tx.execute(
        sql`SELECT 1 AS present FROM auth_members m
             JOIN users u ON u.id = m.user_id
             WHERE m.organization_id = ${context.command.tenantId}
               AND lower(u.email) = ${email} LIMIT 1`,
      ),
    );
    if (memberByEmail) {
      throw refusal(
        MEMBERSHIP_INVITATION_TARGET_ALREADY_MEMBER,
        `${email} is already a member of company ${context.command.tenantId}; inviting an existing member is a conflict, never a role overwrite`,
        409,
      );
    }
    const [pending] = rowsOf(
      await context.tx.execute(
        sql`SELECT 1 AS present FROM auth_invitations
             WHERE organization_id = ${context.command.tenantId}
               AND lower(email) = ${email}
               AND status = 'pending' AND expires_at > now() LIMIT 1`,
      ),
    );
    if (pending) {
      throw refusal(
        MEMBERSHIP_INVITATION_ALREADY_PENDING,
        `${email} already holds a pending invitation in company ${context.command.tenantId}; renew it with the controlled resend, never a second pending row`,
        409,
      );
    }
    const teamIds = await teamIdsOfWorkspaces(
      context.tx,
      context.command.tenantId,
      payload.workspaceIds,
    );
    const invitationId = randomUUID();
    await ba.createInvitation({
      id: invitationId,
      tenantId: context.command.tenantId,
      email,
      role: payload.role,
      inviterId: context.actor.userId as string,
      teamIds,
    });
    return { resourceId: invitationId };
  }

  async function cancelSync(
    context: DirectorySyncContext,
  ): Promise<DirectoryCommandOutcome> {
    const { invitationId } = context.command
      .payload as unknown as InvitationPayload;
    await context.tx
      .update(authInvitations)
      .set({ status: "canceled" })
      .where(
        and(
          eq(authInvitations.id, invitationId),
          eq(authInvitations.organizationId, context.command.tenantId),
          eq(authInvitations.status, "pending"),
        ),
      );
    return { resourceId: invitationId };
  }

  async function resendSync(
    context: DirectorySyncContext,
  ): Promise<DirectoryCommandOutcome> {
    const { invitationId } = context.command
      .payload as unknown as InvitationPayload;
    const original = await readInvitationRow(context.tx, invitationId);
    if (
      !original ||
      original.organizationId !== context.command.tenantId ||
      original.status !== "pending"
    ) {
      // The authorize half proved this moments ago inside the same locked
      // transaction; a violation here is an inconsistency, not a state race.
      throw refusal(
        MEMBERSHIP_INVITATION_NOT_PENDING,
        `invitation ${invitationId} is no longer a pending invitation of company ${context.command.tenantId}; the resend is refused rather than resurrecting anything`,
        409,
      );
    }
    // Half one: the old record is canceled (the 0214 allowlist already names
    // invitation.resend for UPDATE), keeping its audit trail intact.
    await context.tx
      .update(authInvitations)
      .set({ status: "canceled" })
      .where(
        and(
          eq(authInvitations.id, invitationId),
          eq(authInvitations.organizationId, context.command.tenantId),
          eq(authInvitations.status, "pending"),
        ),
      );
    // Half two: the fresh invitation — new id, fresh expiry, same grant —
    // written through the pinned adapter (0216 admits this INSERT under the
    // resend receipt). A failure anywhere rolls BOTH halves back.
    const teamIds = original.teamId
      ? original.teamId.split(",").filter((teamId) => teamId.length > 0)
      : [];
    const renewedId = randomUUID();
    await ba.createInvitation({
      id: renewedId,
      tenantId: context.command.tenantId,
      email: original.email,
      role: original.role ?? "member",
      inviterId: context.actor.userId as string,
      teamIds,
    });
    return { resourceId: renewedId };
  }

  const syncOf: Record<string, typeof createSync> = {
    "invitation.create": createSync,
    "invitation.cancel": cancelSync,
    "invitation.resend": resendSync,
  };

  const entries = Object.entries(syncOf).map(([operation, sync]) => [
    operation,
    {
      authorize: authorizeInvitation,
      sync,
    } satisfies DirectoryCommandHandler,
  ]);
  return Object.fromEntries(entries) as Partial<
    Record<DirectoryOperation, DirectoryCommandHandler>
  >;
}
