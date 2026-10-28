/*
 * Membership commands: the invitation half (T04.01 / #545 and T04.02 / #546)
 * and the member lifecycle half (T04.03 / #547), original task P08;
 * interfaces §2 payload table, §3.1 resend ruling, §3.2 D-class rows, §2's
 * last-owner ruling, design §8.2.
 *
 * What this file owns, and nothing else:
 *
 * 1. The five invitation DirectoryCommandHandlers behind `invitation.create` /
 *    `invitation.cancel` / `invitation.resend` / `invitation.accept` /
 *    `invitation.reject`, the delegable-role lock, and the fixed-build seams
 *    the creating and the accepting halves write through.
 * 2. The six member-lifecycle handlers behind `member.role.set` /
 *    `member.suspend` / `member.restore` / `member.remove` / `member.leave` /
 *    `owner.transfer`, and the last-owner protection all of them honour.
 *
 * The executor owns the tenant lock, the authority gate, the receipt, the
 * commit fences and the finalizer — every refusal here is an in-lock
 * authorization or state verdict, raised before any DML, and the writes
 * themselves run inside the command's own transaction under the T02.06 guard.
 *
 * The acceptance half (T04.02) is the invitee's own command, not an
 * administrator's: `invitation.accept` / `invitation.reject` take only an
 * invitation id, and the in-lock half proves the actor is the signed-in,
 * verified recipient before a single row moves. Accepting establishes the
 * principal (the executor's registry lock does it in this transaction), the
 * company member, the invited teams' memberships, the clocks, the projection
 * and one audit fact — team memberships first, exactly the pinned build's own
 * order (design §8.2: 先建立 teamMember，再建立 member) — and it never grants
 * an existing member a different role: that is a separate explicit command.
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
import type { Database } from "../../db/client";
import {
  authInvitations,
  authMembers,
  authTeamMembers,
  authTeams,
} from "../../db/schema/auth-directory";
import type {
  Directory,
  DirectoryActor,
  DirectoryOperation,
  DirectoryTx,
} from "./contracts";
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
export const MEMBERSHIP_INVITATION_RECIPIENT_MISMATCH =
  "MEMBERSHIP_INVITATION_RECIPIENT_MISMATCH";
export const MEMBERSHIP_INVITATION_EMAIL_UNVERIFIED =
  "MEMBERSHIP_INVITATION_EMAIL_UNVERIFIED";
export const MEMBERSHIP_INVITATION_EXPIRED = "MEMBERSHIP_INVITATION_EXPIRED";
export const MEMBERSHIP_INVITATION_ROLE_UNUSABLE =
  "MEMBERSHIP_INVITATION_ROLE_UNUSABLE";
export const MEMBERSHIP_INVITATION_TEAM_GONE =
  "MEMBERSHIP_INVITATION_TEAM_GONE";
export const MEMBERSHIP_INVITATION_SEATS_EXHAUSTED =
  "MEMBERSHIP_INVITATION_SEATS_EXHAUSTED";

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
 * request-local ALS store, restricted to the operations an invitation
 * command needs. The invitation's id is the server's (the adapter's
 * `forceAllowId` honors it), so the result's resourceId is deterministic.
 *
 * `acceptInvitations` / `rejectInvitation` (T04.02) are the pinned adapter's
 * own team-member and invitation-state writers — the acceptance half must
 * write the team memberships through the plugin's helper (membership key,
 * seat counting, the team's memberCount +1) so the guard sees exactly the
 * plugin's own shape rather than a hand-rolled imitation.
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
  /** The pinned `findOrCreateTeamMember`: membership key, no duplicate seat. */
  addTeamMember(input: {
    readonly teamId: string;
    readonly userId: string;
  }): Promise<void>;
  /** The pinned `updateInvitation` with its `fromStatus` guard. */
  updateInvitation(input: {
    readonly invitationId: string;
    readonly status: "accepted" | "rejected";
    readonly fromStatus: "pending";
  }): Promise<boolean>;
  /** The pinned `createMember`: one member row for the accepted invitation. */
  createMember(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly role: string;
  }): Promise<string>;
  /**
   * The deployment's seat limit for one company — the pinned build's own
   * `membershipLimit` when it resolved to a number, else its documented
   * default of 100. A function-valued limit is NOT evaluated here (it needs
   * the user and organization objects at call time); a deployment that
   * configures one passes its own `InvitationMembershipDeps.seatLimit`
   * instead, and the difference is disclosed rather than approximated.
   */
  seatLimit(): number;
}

/** The pinned build's own default when `membershipLimit` is unset. */
export const DEFAULT_MEMBERSHIP_LIMIT = 100;

/** The fixed plugin's own invitation + membership writes over the ALS store. */
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
    async addTeamMember({ teamId, userId }) {
      await adapter.findOrCreateTeamMember({ teamId, userId });
    },
    async updateInvitation({ invitationId, status, fromStatus }) {
      // The pinned incrementOne answers the updated row, or null when the
      // fromStatus guard matched nothing — the exact "already moved" signal
      // the acceptance half needs, without a second read.
      const updated = await adapter.updateInvitation({
        invitationId,
        status,
        fromStatus,
      });
      return Boolean(updated);
    },
    async createMember({ tenantId, userId, role }) {
      const member = await adapter.createMember({
        organizationId: tenantId,
        userId,
        role,
        createdAt: new Date(),
      });
      return String(member.id);
    },
    seatLimit() {
      // The pinned route's own read: `orgOptions.membershipLimit || 100`.
      // A function-valued limit needs the user and organization objects at
      // call time, so it cannot be resolved here; the default is returned and
      // the narrowing is disclosed (see the interface's docblock).
      const configured = (options as { membershipLimit?: unknown })
        .membershipLimit;
      return typeof configured === "number"
        ? configured
        : DEFAULT_MEMBERSHIP_LIMIT;
    },
  };
}

export interface InvitationMembershipDeps {
  readonly ba: InvitationBaAccess;
  /**
   * The company seat limit the acceptance half enforces inside the tenant
   * lock. Defaults to the fixed seam's own `seatLimit()` (the pinned build's
   * `membershipLimit`, else 100). A deployment (or a suite) that owns a
   * per-company plan capacity passes its own reader; the invitation handler
   * never guesses one.
   */
  readonly seatLimit?: number;
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
  /** The acceptance half needs the expiry; create/cancel/resend ignore it. */
  readonly expiresAt?: Date | null;
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
      expiresAt: authInvitations.expiresAt,
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

/** The caller's own user row: the verified mailbox the invitation must match. */
async function readCallerIdentity(
  tx: DirectoryTx,
  userId: string,
): Promise<{ email: string; emailVerified: boolean }> {
  const [row] = rowsOf(
    await tx.execute(
      sql`SELECT email, email_verified FROM users WHERE id = ${userId} LIMIT 1`,
    ),
  );
  if (!row) {
    throw refusal(
      MEMBERSHIP_INVITATION_ACTOR_FORBIDDEN,
      `user ${userId} has no identity row; an invitation is answered only by a signed-in, verified account`,
      403,
    );
  }
  return {
    email: String(row.email ?? "").toLowerCase(),
    emailVerified: row.email_verified === true,
  };
}

/**
 * The invitee's own locked authorization for `invitation.accept` /
 * `invitation.reject` (design §8.2). Distinct from the administrator half
 * above in every check that matters: the actor needs no company role, no
 * prior membership and no company SSO proof — the invitation's address, the
 * caller's verified mailbox and the invitation's own state are the whole
 * qualification.
 *
 * The always-half (replay included) proves the caller is the signed-in,
 * verified recipient and that the invitation is a live record of the company
 * this command names: a revoked or re-bound account can never borrow a
 * receipt. The fresh-only half proves the state the acceptance needs — still
 * pending, still unexpired, a still-delegable role, teams still in the
 * company, seats left, and whether the caller is already a member.
 */
async function authorizeInvitationResponse(
  context: DirectoryAuthorizeContext,
  seatLimit: number,
): Promise<void> {
  const actor = context.actor;
  if (actor.kind !== "session" || !actor.userId) {
    throw refusal(
      MEMBERSHIP_INVITATION_ACTOR_FORBIDDEN,
      `a ${actor.kind} actor cannot accept or reject an invitation; the invitee answers in person from a signed-in session, and the actor is the server's, never a client field`,
      403,
    );
  }
  const caller = await readCallerIdentity(context.tx, actor.userId);
  if (!caller.emailVerified) {
    // Design §8.2: 只有验证成功才能接受邀请. This is the invitation's own
    // verification, not a company SSO proof — accepting grants no proof.
    throw refusal(
      MEMBERSHIP_INVITATION_EMAIL_UNVERIFIED,
      `user ${actor.userId} has not verified their mailbox; an invitation is accepted only by its verified recipient, and accepting never substitutes for email verification`,
      403,
    );
  }
  const { invitationId } = context.command
    .payload as unknown as InvitationPayload;
  const row = await readInvitationRow(context.tx, invitationId);
  if (!row || row.organizationId !== context.command.tenantId) {
    throw refusal(
      MEMBERSHIP_INVITATION_NOT_FOUND,
      `invitation ${invitationId} does not exist in company ${context.command.tenantId}; another company's invitation is answered exactly like a missing one, and an invitation id is never a credential by itself`,
      404,
    );
  }
  if (row.email.toLowerCase() !== caller.email) {
    throw refusal(
      MEMBERSHIP_INVITATION_RECIPIENT_MISMATCH,
      `invitation ${invitationId} addresses a different mailbox than the caller's verified one; a changed address or a wrong account cannot accept or reject it`,
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
      `company ${context.command.tenantId} is ${String(tenant.status)}; an invitation of a suspended or provisioning company cannot be accepted or rejected`,
      403,
    );
  }

  if (context.commandId !== null) return; // replay: the recipient half above is the contract
  if (row.status !== "pending") {
    throw refusal(
      MEMBERSHIP_INVITATION_NOT_PENDING,
      `invitation ${invitationId} is ${row.status}; only a pending invitation can be accepted or rejected, and a repeat answer never reopens one`,
      409,
    );
  }
  if (context.command.operation === "invitation.reject") return;
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) {
    throw refusal(
      MEMBERSHIP_INVITATION_EXPIRED,
      `invitation ${invitationId} expired at ${new Date(row.expiresAt).toISOString()}; an expired invitation is refused and is never extended by accepting it`,
      409,
    );
  }
  const role = row.role ?? "member";
  if (!INVITATION_DELEGABLE_ROLES.includes(role)) {
    throw refusal(
      MEMBERSHIP_INVITATION_ROLE_UNUSABLE,
      `invitation ${invitationId} delegates the role "${role}", which is no longer a delegable invitation role; the invitation is refused rather than re-shaped into one`,
      409,
    );
  }
  // The teams the invitation grants must still be this company's (design
  // §8.2: 团队是否仍属该公司). A team that moved or vanished is a refusal,
  // never a silent drop: the invitee was told which scopes they would join.
  for (const teamId of splitTeamIds(row.teamId)) {
    const [team] = rowsOf(
      await context.tx.execute(
        sql`SELECT 1 AS present FROM auth_teams
             WHERE id = ${teamId} AND organization_id = ${context.command.tenantId} LIMIT 1`,
      ),
    );
    if (!team) {
      throw refusal(
        MEMBERSHIP_INVITATION_TEAM_GONE,
        `invitation ${invitationId} grants team ${teamId}, which is no longer a team of company ${context.command.tenantId}; the acceptance is refused rather than granting a narrower scope than the invitee accepted`,
        409,
      );
    }
  }
  // Seats: the directory's own capacity limit, checked in the tenant lock so
  // two concurrent acceptances cannot both take the last seat. Package and
  // billing capacity is a separate read (T07.03) — this is the membership
  // limit the pinned build itself enforces.
  const [existingMember] = rowsOf(
    await context.tx.execute(
      sql`SELECT 1 AS present FROM auth_members
           WHERE organization_id = ${context.command.tenantId}
             AND user_id = ${actor.userId} LIMIT 1`,
    ),
  );
  if (existingMember) return; // a member already holds a seat; the role is never rewritten here
  const [seats] = rowsOf(
    await context.tx.execute(
      sql`SELECT count(*)::int AS n FROM auth_members
           WHERE organization_id = ${context.command.tenantId}`,
    ),
  );
  if (Number(seats?.n ?? 0) >= seatLimit) {
    throw refusal(
      MEMBERSHIP_INVITATION_SEATS_EXHAUSTED,
      `company ${context.command.tenantId} has no free seat left; the acceptance is refused in the tenant lock so a concurrent acceptance cannot oversubscribe it`,
      409,
    );
  }
}

/** The invitation's granted team ids, in the pinned build's comma shape. */
function splitTeamIds(teamId: string | null): string[] {
  return teamId ? teamId.split(",").filter((id) => id.length > 0) : [];
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
  for (const method of [
    "addTeamMember",
    "updateInvitation",
    "createMember",
  ] as const) {
    if (typeof deps.ba[method] !== "function") {
      throw new Error(
        `MEMBERSHIP_INVITATION_DEPS_REQUIRED: the invitation seam is missing ${method}; invitation.accept/reject establish the membership and move the record through the pinned adapter's own operations inside the command transaction`,
      );
    }
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

  /**
   * `invitation.accept` (T04.02, design §8.2): the invitee's own atomic
   * establishment. The pinned build's own order is kept — team memberships
   * FIRST, then the company member (crud-invites.mjs accepting a team
   * invitation writes teamMember before member; the T02.06 commit fence
   * reads the FINAL state, so the legal intermediate order is the plugin's)
   * — and the invitation flips to `accepted` under its `fromStatus: pending`
   * guard, so a second acceptance of the same record matches no row and is
   * refused rather than duplicating a membership.
   *
   * The principal is the executor's own work (registry.ensure runs at the
   * lock layer for every command), and the finalizer derives the projection,
   * the clocks and the audit fact from the change keys these writes
   * register — nothing is patched up afterwards.
   */
  async function acceptSync(
    context: DirectorySyncContext,
  ): Promise<DirectoryCommandOutcome> {
    const { invitationId } = context.command
      .payload as unknown as InvitationPayload;
    const userId = context.actor.userId as string;
    const row = await readInvitationRow(context.tx, invitationId);
    if (
      !row ||
      row.organizationId !== context.command.tenantId ||
      row.status !== "pending"
    ) {
      // The authorize half proved this moments ago inside the same locked
      // transaction; a violation here is an inconsistency, not a state race.
      throw refusal(
        MEMBERSHIP_INVITATION_NOT_PENDING,
        `invitation ${invitationId} is no longer a pending invitation of company ${context.command.tenantId}; the acceptance is refused rather than reviving it`,
        409,
      );
    }
    const role = row.role ?? "member";
    // The existing member is NOT re-roled: the lower invitation never
    // overwrites a live company role (design §8.2). The seat already exists,
    // so only the team grants are (idempotently) applied.
    const [existing] = rowsOf(
      await context.tx.execute(
        sql`SELECT role FROM auth_members
             WHERE organization_id = ${context.command.tenantId}
               AND user_id = ${userId} LIMIT 1`,
      ),
    );
    for (const teamId of splitTeamIds(row.teamId)) {
      // The pinned findOrCreateTeamMember: membership key, existing pair
      // reused, the team's memberCount moved exactly +1 (the guard admits
      // that single delta under invitation.accept).
      await ba.addTeamMember({ teamId, userId });
    }
    if (!existing) {
      await ba.createMember({
        tenantId: context.command.tenantId,
        userId,
        role,
      });
    }
    const moved = await ba.updateInvitation({
      invitationId,
      status: "accepted",
      fromStatus: "pending",
    });
    if (!moved) {
      throw refusal(
        MEMBERSHIP_INVITATION_NOT_PENDING,
        `invitation ${invitationId} matched no pending row when the acceptance moved it; the command is rolled back rather than reporting an acceptance the record does not carry`,
        409,
      );
    }
    return { resourceId: invitationId };
  }

  /**
   * `invitation.reject`: the recipient declines the record. No membership,
   * team or clock is touched — rejecting grants nothing, so the command
   * carries exactly one write (the state flip, under the same fromStatus
   * guard) and finalizes with an empty change-key set.
   */
  async function rejectSync(
    context: DirectorySyncContext,
  ): Promise<DirectoryCommandOutcome> {
    const { invitationId } = context.command
      .payload as unknown as InvitationPayload;
    const row = await readInvitationRow(context.tx, invitationId);
    if (
      !row ||
      row.organizationId !== context.command.tenantId ||
      row.status !== "pending"
    ) {
      throw refusal(
        MEMBERSHIP_INVITATION_NOT_PENDING,
        `invitation ${invitationId} is no longer a pending invitation of company ${context.command.tenantId}; the rejection is refused rather than re-stating a settled record`,
        409,
      );
    }
    const moved = await ba.updateInvitation({
      invitationId,
      status: "rejected",
      fromStatus: "pending",
    });
    if (!moved) {
      throw refusal(
        MEMBERSHIP_INVITATION_NOT_PENDING,
        `invitation ${invitationId} matched no pending row when the rejection moved it; the command is rolled back rather than reporting a rejection the record does not carry`,
        409,
      );
    }
    return { resourceId: invitationId };
  }

  const syncOf: Record<string, typeof createSync> = {
    "invitation.create": createSync,
    "invitation.cancel": cancelSync,
    "invitation.resend": resendSync,
    "invitation.accept": acceptSync,
    "invitation.reject": rejectSync,
  };

  const seatLimit = deps.seatLimit ?? ba.seatLimit();
  if (
    typeof seatLimit !== "number" ||
    !Number.isSafeInteger(seatLimit) ||
    seatLimit <= 0
  ) {
    throw new Error(
      `MEMBERSHIP_INVITATION_SEAT_LIMIT_INVALID: the seat limit must be a positive safe integer, got ${String(seatLimit)}; a company with no admit-able seats is a configuration error, not a silent refusal of every invitation`,
    );
  }

  const entries = Object.entries(syncOf).map(([operation, sync]) => [
    operation,
    {
      // The acceptance pair has its own invitee-side authorization; the
      // administrator trio keeps the company-administrator one.
      authorize:
        operation === "invitation.accept" || operation === "invitation.reject"
          ? (context: DirectoryAuthorizeContext) =>
              authorizeInvitationResponse(context, seatLimit)
          : authorizeInvitation,
      sync,
    } satisfies DirectoryCommandHandler,
  ]);
  return Object.fromEntries(entries) as Partial<
    Record<DirectoryOperation, DirectoryCommandHandler>
  >;
}

// ---------------------------------------------------------------------------
// T04.03 (#547, original task P08; interfaces §2 payload table and the §2
// last-owner ruling, plan Task 3/4): the member lifecycle commands.
//
// What this half owns: `member.role.set`, `member.suspend`, `member.restore`,
// `member.remove`, `member.leave` and `owner.transfer` as
// DirectoryCommandHandlers. The executor owns the tenant-exclusive lock, so
// every check here runs against the state the command will commit and two
// concurrent member commands are serialised per company — which is exactly
// what makes the last-owner protection sound.
//
// The §2 ruling this file implements, in one sentence per clause:
//
// - "最后 owner 检查覆盖所有角色、暂停、退出和移除路径": every operation that
//   could drop the owner count to zero (demotion out of owner, suspension of
//   an owner, removal, leave, and an owner transfer that names a non-owner as
//   the only survivor) refuses when it would leave no active owner. The check
//   runs in the lock, reads the live rows, and counts the owners this command
//   is NOT changing — never a cached or client-supplied count.
// - "owner.transfer 原 owner 原子降为 admin": the successor becomes owner and
//   the outgoing owner becomes admin inside the SAME command transaction —
//   two auth_members UPDATEs, both registered as company change keys, one
//   receipt.
// - "member.remove ... remove清该公司所有team关系但保留历史FK/clock": removal
//   deletes every auth_team_members row of THAT company (the 0214
//   auth_member_orphan_fence refuses the commit otherwise), lets the 0214
//   guard tombstone the company and team clocks, and keeps the receipts,
//   change keys and audit facts as the durable history. The company member row
//   itself is DELETEd — the physical removal is the operation's own
//   semantics: `member.suspend` is the reversible state, `member.remove` is
//   the removal, and the clock tombstone is what makes the old authority dead.
// - "恢复不复活旧Grant/lease/凭据": `member.suspend` advances the company
//   GENERATION, `member.restore` advances the EPOCH and keeps the advanced
//   generation (the 0214 guard's own rules). A pre-suspension scope carries
//   the old version pair, so the frozen BA workspace gate denies it forever;
//   the restore is a new admission. Nothing here touches a Grant, lease or
//   credential — reviving one would need a NEW issuance at the new versions,
//   which is a different command's job.
// - "legacy旧受控写保持": this module is registered on the executor only; the
//   legacy writer's path is untouched, and the executor's authority gate keeps
//   the legacy/paused branches working (a paused directory refuses every
//   write with 503 before a handler is reached).
// ---------------------------------------------------------------------------

export const MEMBERSHIP_LIFECYCLE_ACTOR_FORBIDDEN =
  "MEMBERSHIP_LIFECYCLE_ACTOR_FORBIDDEN";
export const MEMBERSHIP_LIFECYCLE_COMPANY_NOT_FOUND =
  "MEMBERSHIP_LIFECYCLE_COMPANY_NOT_FOUND";
export const MEMBERSHIP_LIFECYCLE_COMPANY_CLOSED =
  "MEMBERSHIP_LIFECYCLE_COMPANY_CLOSED";
export const MEMBERSHIP_LIFECYCLE_MEMBER_NOT_FOUND =
  "MEMBERSHIP_LIFECYCLE_MEMBER_NOT_FOUND";
export const MEMBERSHIP_LIFECYCLE_ROLE_INVALID =
  "MEMBERSHIP_LIFECYCLE_ROLE_INVALID";
export const MEMBERSHIP_LIFECYCLE_ROLE_UNCHANGED =
  "MEMBERSHIP_LIFECYCLE_ROLE_UNCHANGED";
export const MEMBERSHIP_LIFECYCLE_NOT_SUSPENDED =
  "MEMBERSHIP_LIFECYCLE_NOT_SUSPENDED";
export const MEMBERSHIP_LIFECYCLE_ALREADY_SUSPENDED =
  "MEMBERSHIP_LIFECYCLE_ALREADY_SUSPENDED";
export const MEMBERSHIP_LIFECYCLE_LAST_OWNER =
  "MEMBERSHIP_LIFECYCLE_LAST_OWNER";
export const MEMBERSHIP_LIFECYCLE_TRANSFER_TARGET_INVALID =
  "MEMBERSHIP_LIFECYCLE_TRANSFER_TARGET_INVALID";
export const MEMBERSHIP_LIFECYCLE_TRANSFER_SELF =
  "MEMBERSHIP_LIFECYCLE_TRANSFER_SELF";

/** The lifecycle commands this module implements. */
const MEMBERSHIP_LIFECYCLE_OPERATIONS = [
  "member.role.set",
  "member.suspend",
  "member.restore",
  "member.remove",
  "member.leave",
  "owner.transfer",
] as const;

/** One live company member as the lifecycle checks read it. */
interface LiveMember {
  readonly id: string;
  readonly userId: string;
  readonly role: string;
}

/**
 * The locked authorization every lifecycle command shares (replay included,
 * so a revoked administrator can never borrow a receipt): a session or
 * platform actor with a userId (server-issued in both cases — the BA native
 * ingress mints the session actor from the verified session; the T04.03
 * translation port mints the platform actor for the old entrances, exactly
 * the shape T03.04's platform lifecycle actor set), an existing active
 * company, and an actor who is a live owner/admin of that company with an
 * active principal, an active projection membership and an untombstoned
 * company clock.
 *
 * The payload half is fresh-only: a replay's authorization must not fail
 * because its own earlier commit moved the target's state, so the target
 * existence/state checks live in the sync half where they belong.
 */
async function authorizeMembershipLifecycle(
  context: DirectoryAuthorizeContext,
  action: string,
): Promise<void> {
  const actor = context.actor;
  if (
    (actor.kind !== "session" && actor.kind !== "platform") ||
    !actor.userId
  ) {
    throw refusal(
      MEMBERSHIP_LIFECYCLE_ACTOR_FORBIDDEN,
      `a ${actor.kind} actor cannot ${action}; member lifecycle commands are exercised by a signed-in company administrator or a server-orchestrated operator identity, and the actor is the server's, never a client field`,
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
      MEMBERSHIP_LIFECYCLE_COMPANY_NOT_FOUND,
      `company ${context.command.tenantId} does not exist; the command answers not-found rather than inventing a directory`,
      404,
    );
  }
  if (String(tenant.status) !== "active") {
    throw refusal(
      MEMBERSHIP_LIFECYCLE_COMPANY_CLOSED,
      `company ${context.command.tenantId} is ${String(tenant.status)}; every member command of a suspended or provisioning company is refused`,
      403,
    );
  }
  const [me] = rowsOf(
    await context.tx.execute(
      sql`SELECT role FROM auth_members
           WHERE organization_id = ${context.command.tenantId}
             AND user_id = ${actor.userId} LIMIT 1`,
    ),
  );
  if (!me) {
    throw refusal(
      MEMBERSHIP_LIFECYCLE_ACTOR_FORBIDDEN,
      `user ${actor.userId} is not a member of company ${context.command.tenantId}; a non-member never changes another member's standing`,
      403,
    );
  }
  if (!["owner", "admin"].includes(String(me.role))) {
    throw refusal(
      MEMBERSHIP_LIFECYCLE_ACTOR_FORBIDDEN,
      `the caller's live company role is "${String(me.role)}"; changing members needs an owner or admin`,
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
      MEMBERSHIP_LIFECYCLE_ACTOR_FORBIDDEN,
      `the principal behind user ${actor.userId} is ${String(principal?.status ?? "missing")}; a disabled identity's member commands are closed`,
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
      MEMBERSHIP_LIFECYCLE_ACTOR_FORBIDDEN,
      `the business membership of user ${actor.userId} in company ${context.command.tenantId} is ${String(membership?.status ?? "missing")}; a suspended member's commands are closed`,
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
      MEMBERSHIP_LIFECYCLE_ACTOR_FORBIDDEN,
      `no live company clock exists for the actor in company ${context.command.tenantId}; a removed member's commands stay closed`,
      403,
    );
  }
}

/**
 * `member.leave` is the member's own command, not an administrator's: the
 * payload is empty and the subject is the actor. It shares the "live member of
 * an active company" half above but must not require the actor to be an
 * owner or admin — anybody may leave.
 */
async function authorizeOwnLeave(
  context: DirectoryAuthorizeContext,
): Promise<void> {
  const actor = context.actor;
  if (
    (actor.kind !== "session" && actor.kind !== "platform") ||
    !actor.userId
  ) {
    throw refusal(
      MEMBERSHIP_LIFECYCLE_ACTOR_FORBIDDEN,
      `a ${actor.kind} actor cannot leave a company; leaving is the member's own action, exercised from a signed-in session or by a server-orchestrated identity (global account deletion), and the actor is the server's, never a client field`,
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
      MEMBERSHIP_LIFECYCLE_COMPANY_NOT_FOUND,
      `company ${context.command.tenantId} does not exist; leaving answers not-found rather than inventing a directory`,
      404,
    );
  }
  if (String(tenant.status) !== "active") {
    throw refusal(
      MEMBERSHIP_LIFECYCLE_COMPANY_CLOSED,
      `company ${context.command.tenantId} is ${String(tenant.status)}; a suspended company's leave command is refused`,
      403,
    );
  }
  const [me] = rowsOf(
    await context.tx.execute(
      sql`SELECT role FROM auth_members
           WHERE organization_id = ${context.command.tenantId}
             AND user_id = ${actor.userId} LIMIT 1`,
    ),
  );
  if (!me) {
    throw refusal(
      MEMBERSHIP_LIFECYCLE_MEMBER_NOT_FOUND,
      `user ${actor.userId} is not a member of company ${context.command.tenantId}; there is nothing to leave`,
      404,
    );
  }
}

/** The live member row of one user in one company, or null. */
async function readLiveMember(
  tx: DirectoryTx,
  tenantId: string,
  userId: string,
): Promise<LiveMember | null> {
  const [row] = await tx
    .select({
      id: authMembers.id,
      userId: authMembers.userId,
      role: authMembers.role,
    })
    .from(authMembers)
    .where(
      and(
        eq(authMembers.organizationId, tenantId),
        eq(authMembers.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The last-owner protection (interfaces §2). `survivingOwners` is called with
 * the set of userIds this command takes OUT of the owner role, and returns the
 * owners that remain. A count of zero is refused by name — the check reads the
 * live rows inside the tenant lock, so two concurrent commands cannot both
 * observe "one owner remains" and both proceed.
 */
async function requireSurvivingOwner(
  tx: DirectoryTx,
  tenantId: string,
  leavingOwnerUserIds: readonly string[],
  action: string,
): Promise<void> {
  const rows = rowsOf(
    await tx.execute(
      sql`SELECT user_id FROM auth_members
           WHERE organization_id = ${tenantId} AND role = 'owner'`,
    ),
  );
  const leaving = new Set(leavingOwnerUserIds);
  const remaining = rows
    .map((row) => String(row.user_id))
    .filter((userId) => !leaving.has(userId));
  if (remaining.length === 0) {
    throw refusal(
      MEMBERSHIP_LIFECYCLE_LAST_OWNER,
      `company ${tenantId} would be left with no active owner by this ${action}; the last owner cannot be demoted, suspended, removed or leave — transfer ownership first (owner.transfer) or promote another member`,
      409,
    );
  }
}

/**
 * The `member.role.set` / `member.suspend` / `member.restore` /
 * `member.remove` / `member.leave` / `owner.transfer` handlers.
 *
 * Every write below runs inside the executor's command transaction under the
 * T02.06 DML guard, whose 0215/0216 allowlists already admit exactly these
 * statements: `auth_members` UPDATE for role.set/suspend/restore/
 * owner.transfer (suspend advances the generation, the others the epoch),
 * `auth_members` DELETE for remove/leave (generation +1), `auth_team_members`
 * DELETE and `auth_teams.member_count` −1 for remove/leave. No new migration
 * is required, and none is added.
 */
export function createMembershipLifecycleHandlers(): Partial<
  Record<DirectoryOperation, DirectoryCommandHandler>
> {
  /**
   * The shared shape of a single-subject, reason-bearing command: read the
   * target (missing → one invisible not-found), apply the operation's state
   * rule, and let the guard/finalizer derive the clocks and projection.
   */
  async function singleSubjectSync(
    context: DirectorySyncContext,
    apply: (member: LiveMember) => Promise<DirectoryCommandOutcome>,
  ): Promise<DirectoryCommandOutcome> {
    const payload = context.command.payload as { readonly userId?: string };
    const userId = String(payload.userId ?? "");
    const member = await readLiveMember(
      context.tx,
      context.command.tenantId,
      userId,
    );
    if (!member) {
      // Another company's member and a fabricated id answer identically: no
      // existence leak across companies (§2's invisible not-found).
      throw refusal(
        MEMBERSHIP_LIFECYCLE_MEMBER_NOT_FOUND,
        `no member row for user ${userId} exists in company ${context.command.tenantId}; another company's member is answered exactly like a missing one`,
        404,
      );
    }
    return apply(member);
  }

  const roleSetSync = (context: DirectorySyncContext) =>
    singleSubjectSync(context, async (member) => {
      const payload = context.command.payload as { readonly role?: string };
      const role = String(payload.role ?? "");
      if (!DIRECTORY_MEMBER_ROLES.includes(role)) {
        throw refusal(
          MEMBERSHIP_LIFECYCLE_ROLE_INVALID,
          `"${role}" is not a company directory role; the closed vocabulary is owner, admin, member and auditor`,
          400,
        );
      }
      // Setting owner through member.role.set would silently create a second
      // owner with no transfer semantics — the ingress already translates
      // role=owner into owner.transfer, and this refuses the shape the
      // envelope should never have carried.
      if (role === "owner") {
        throw refusal(
          MEMBERSHIP_LIFECYCLE_ROLE_INVALID,
          "member.role.set never grants owner; ownership moves through owner.transfer, which steps the outgoing owner down atomically",
          400,
        );
      }
      if (member.role === role) {
        throw refusal(
          MEMBERSHIP_LIFECYCLE_ROLE_UNCHANGED,
          `user ${member.userId} already holds "${role}" in company ${context.command.tenantId}; a no-op role write is refused rather than advancing the epoch for nothing`,
          409,
        );
      }
      // Demoting the last owner is the §2 case: the company must keep one.
      if (member.role === "owner") {
        await requireSurvivingOwner(
          context.tx,
          context.command.tenantId,
          [member.userId],
          "demotion",
        );
      }
      await context.tx
        .update(authMembers)
        .set({ role })
        .where(
          and(
            eq(authMembers.organizationId, context.command.tenantId),
            eq(authMembers.userId, member.userId),
          ),
        );
      return { resourceId: member.id };
    });

  const suspendSync = (context: DirectorySyncContext) =>
    singleSubjectSync(context, async (member) => {
      // `member.suspend` is a directory-state move with no separate status
      // column on auth_members: the suspended state is the company
      // projection's legacy status (the finalizer writes `suspended` for this
      // operation) plus the advanced generation that kills old scopes. The BA
      // member row itself stays active — a suspended member is still a member
      // of the company, which is what makes `restore` possible.
      if (member.role === "owner") {
        await requireSurvivingOwner(
          context.tx,
          context.command.tenantId,
          [member.userId],
          "suspension",
        );
      }
      // The self-assigning UPDATE the 0215 guard admits for member.suspend:
      // the row is rewritten in place (role unchanged) so the per-row trigger
      // registers this member's company change key (epoch unchanged,
      // generation +1).
      await context.tx
        .update(authMembers)
        .set({ role: sql`${authMembers.role}` })
        .where(
          and(
            eq(authMembers.organizationId, context.command.tenantId),
            eq(authMembers.userId, member.userId),
          ),
        );
      return { resourceId: member.id };
    });

  const restoreSync = (context: DirectorySyncContext) =>
    singleSubjectSync(context, async (member) => {
      const [principal] = rowsOf(
        await context.tx.execute(
          sql`SELECT id FROM enterprise_principals WHERE user_id = ${member.userId} LIMIT 1`,
        ),
      );
      if (!principal) {
        throw refusal(
          MEMBERSHIP_LIFECYCLE_MEMBER_NOT_FOUND,
          `user ${member.userId} has no principal in company ${context.command.tenantId}; a member without a stable subject cannot be restored`,
          404,
        );
      }
      const [projection] = rowsOf(
        await context.tx.execute(
          sql`SELECT status FROM enterprise_memberships
               WHERE tenant_id = ${context.command.tenantId}
                 AND principal_id = ${String(principal.id)} LIMIT 1`,
        ),
      );
      if (String(projection?.status ?? "missing") !== "suspended") {
        throw refusal(
          MEMBERSHIP_LIFECYCLE_NOT_SUSPENDED,
          `the membership of user ${member.userId} in company ${context.command.tenantId} is ${String(projection?.status ?? "missing")}; restore reopens a suspended member and never re-states an active one`,
          409,
        );
      }
      // The same self-assigning UPDATE under restore's rule (epoch +1,
      // generation kept): the finalizer advances the clock and the projection,
      // so old scopes stay dead on the already-advanced generation while fresh
      // issuance reads the new epoch.
      await context.tx
        .update(authMembers)
        .set({ role: sql`${authMembers.role}` })
        .where(
          and(
            eq(authMembers.organizationId, context.command.tenantId),
            eq(authMembers.userId, member.userId),
          ),
        );
      return { resourceId: member.id };
    });

  /**
   * Removal: the company member row and EVERY team relation of that company.
   * The 0214 orphan fence refuses a commit that leaves a team member behind,
   * so the team rows are deleted first and the company row last. `member.leave`
   * shares this body — leaving IS removing yourself, with the actor as the
   * subject.
   *
   * The team half is the command's own DML rather than the pinned adapter's
   * `removeTeamMember`: that helper is `deleteMany` plus an unconditional
   * `member_count -= n` seat release, and both statements are already admitted
   * by operation name in the 0214 guard (`auth_team_members` DELETE and the
   * `auth_teams` UPDATE branch that demands exactly `member_count - 1` with
   * the name untouched). There is no membership key or seat arithmetic to
   * reproduce here — unlike acceptance, which must create rows through the
   * plugin's own key/counter path — so a second adapter seam would add a
   * dependency without changing what the guard sees.
   */
  async function removeMemberRows(
    context: DirectorySyncContext,
    member: LiveMember,
  ): Promise<DirectoryCommandOutcome> {
    const tenantId = context.command.tenantId;
    const teams = rowsOf(
      await context.tx.execute(
        sql`SELECT t.id AS team_id FROM auth_team_members tm
             JOIN auth_teams t ON t.id = tm.team_id
             WHERE t.organization_id = ${tenantId} AND tm.user_id = ${member.userId}`,
      ),
    );
    for (const team of teams) {
      const teamId = String(team.team_id);
      await context.tx
        .delete(authTeamMembers)
        .where(
          and(
            eq(authTeamMembers.teamId, teamId),
            eq(authTeamMembers.userId, member.userId),
          ),
        );
      // The seat release, in the exact shape the guard admits: exactly −1 per
      // removed relation, with every other column untouched.
      await context.tx
        .update(authTeams)
        .set({ memberCount: sql`${authTeams.memberCount} - 1` })
        .where(eq(authTeams.id, teamId));
    }
    // The company member row goes last: the orphan fence reads the FINAL
    // state, so no team relation of this company may survive it.
    await context.tx
      .delete(authMembers)
      .where(
        and(
          eq(authMembers.organizationId, tenantId),
          eq(authMembers.userId, member.userId),
        ),
      );
    return { resourceId: member.id };
  }

  const removeSync = (context: DirectorySyncContext) =>
    singleSubjectSync(context, async (member) => {
      if (member.role === "owner") {
        await requireSurvivingOwner(
          context.tx,
          context.command.tenantId,
          [member.userId],
          "removal",
        );
      }
      return removeMemberRows(context, member);
    });

  /**
   * `member.leave`: the actor is the subject (interfaces §2: 目标只取当前主体),
   * so a payload naming anyone else is refused rather than silently ignored.
   */
  const leaveSync = async (
    context: DirectorySyncContext,
  ): Promise<DirectoryCommandOutcome> => {
    const actorUserId = context.actor.userId as string;
    const member = await readLiveMember(
      context.tx,
      context.command.tenantId,
      actorUserId,
    );
    if (!member) {
      throw refusal(
        MEMBERSHIP_LIFECYCLE_MEMBER_NOT_FOUND,
        `user ${actorUserId} is not a member of company ${context.command.tenantId}; there is nothing to leave`,
        404,
      );
    }
    if (member.role === "owner") {
      await requireSurvivingOwner(
        context.tx,
        context.command.tenantId,
        [member.userId],
        "departure",
      );
    }
    return removeMemberRows(context, member);
  };

  /**
   * `owner.transfer`: the successor becomes owner and the outgoing owner steps
   * down to admin in the SAME command (interfaces §2: 原 owner 原子降为 admin).
   * Both rows move inside one transaction, so there is never a moment — nor a
   * committed state — with two owners or none.
   */
  const transferSync = async (
    context: DirectorySyncContext,
  ): Promise<DirectoryCommandOutcome> => {
    const payload = context.command.payload as {
      readonly nextOwnerUserId?: string;
    };
    const nextUserId = String(payload.nextOwnerUserId ?? "");
    const actorUserId = context.actor.userId as string;
    if (nextUserId === actorUserId) {
      throw refusal(
        MEMBERSHIP_LIFECYCLE_TRANSFER_SELF,
        `owner.transfer names the caller as the successor; transferring ownership to yourself is not a transfer, and the command never rewrites the caller's own row`,
        400,
      );
    }
    const successor = await readLiveMember(
      context.tx,
      context.command.tenantId,
      nextUserId,
    );
    if (!successor) {
      throw refusal(
        MEMBERSHIP_LIFECYCLE_TRANSFER_TARGET_INVALID,
        `user ${nextUserId} is not a member of company ${context.command.tenantId}; ownership moves only to an existing active member`,
        404,
      );
    }
    const currentOwner = await readLiveMember(
      context.tx,
      context.command.tenantId,
      actorUserId,
    );
    if (currentOwner?.role !== "owner") {
      throw refusal(
        MEMBERSHIP_LIFECYCLE_ACTOR_FORBIDDEN,
        `the caller's live company role is "${currentOwner?.role ?? "missing"}"; only an owner hands ownership over`,
        403,
      );
    }
    // The successor becomes owner first, then the outgoing owner steps down:
    // the intermediate state has two owners, never zero, so the last-owner
    // invariant holds at every point inside the transaction too.
    await context.tx
      .update(authMembers)
      .set({ role: "owner" })
      .where(
        and(
          eq(authMembers.organizationId, context.command.tenantId),
          eq(authMembers.userId, successor.userId),
        ),
      );
    await context.tx
      .update(authMembers)
      .set({ role: "admin" })
      .where(
        and(
          eq(authMembers.organizationId, context.command.tenantId),
          eq(authMembers.userId, currentOwner.userId),
        ),
      );
    return { resourceId: successor.id };
  };

  return Object.freeze({
    "member.role.set": Object.freeze({
      authorize: (context: DirectoryAuthorizeContext) =>
        authorizeMembershipLifecycle(context, "change a member's role"),
      sync: roleSetSync,
    }),
    "member.suspend": Object.freeze({
      authorize: (context: DirectoryAuthorizeContext) =>
        authorizeMembershipLifecycle(context, "suspend a member"),
      sync: suspendSync,
    }),
    "member.restore": Object.freeze({
      authorize: (context: DirectoryAuthorizeContext) =>
        authorizeMembershipLifecycle(context, "restore a member"),
      sync: restoreSync,
    }),
    "member.remove": Object.freeze({
      authorize: (context: DirectoryAuthorizeContext) =>
        authorizeMembershipLifecycle(context, "remove a member"),
      sync: removeSync,
    }),
    "member.leave": Object.freeze({
      authorize: authorizeOwnLeave,
      sync: leaveSync,
    }),
    "owner.transfer": Object.freeze({
      authorize: (context: DirectoryAuthorizeContext) =>
        authorizeMembershipLifecycle(context, "transfer company ownership"),
      sync: transferSync,
    }),
  } satisfies Partial<Record<DirectoryOperation, DirectoryCommandHandler>>);
}

/** The closed company directory role vocabulary (interfaces §2). */
const DIRECTORY_MEMBER_ROLES: readonly string[] = Object.freeze([
  "owner",
  "admin",
  "member",
  "auditor",
]);

/** The lifecycle operations this module registers, for callers' own wiring. */
export const MEMBERSHIP_LIFECYCLE_SUPPORTED_OPERATIONS =
  MEMBERSHIP_LIFECYCLE_OPERATIONS;

// ---------------------------------------------------------------------------
// T04.03：旧管理入口的 ba 分支转译端口（P08 收口半边）
// ---------------------------------------------------------------------------

/**
 * The authority mode an old admin entry branches on (ticket step 5: the old
 * management entrances translate through Directory on the ba branch only;
 * legacy keeps its original path; paused answers the one 503).
 */
export type MembershipAuthorityMode = "legacy" | "paused" | "ba";

/** The refusal code every paused-mode admin entrance answers with (a 503). */
export const MEMBERSHIP_LIFECYCLE_PAUSED = "MEMBERSHIP_LIFECYCLE_PAUSED";

export interface MembershipAdminTranslationPort {
  /**
   * The authority read the branch decision runs on. One read per call, on the
   * single-writer connection, so the branch a service takes is the state the
   * row carries — never a boot-time snapshot.
   */
  readonly modeOf: () => Promise<MembershipAuthorityMode>;
  /**
   * The command half: the executor owns the authority gate, the tenant lock,
   * the receipt and the finalizer, so a translated write is one atomic
   * command. The executor's own `requireWrite(tx, version, "ba")` is the
   * second, in-transaction gate — a mode that drifts after `modeOf` read
   * legacy is refused there, never silently executed the other way.
   */
  readonly execute: Directory["execute"];
  /** The server-issued platform actor a translated admin command runs under. */
  readonly actorOf: (actorUserId: string) => DirectoryActor;
  /**
   * The narrow member context an old entrance translates: one principal's
   * live projection facts inside one company — the userId the command payload
   * names, plus the projection state the entrance's pre-check and its
   * report's `previousRole` read. Null is the invisible not-found (another
   * company's principal answers exactly like a fabricated id, matching the
   * legacy entrances' no-existence-leak discipline).
   */
  readonly memberOf: (input: {
    readonly tenantId: string;
    readonly principalId: string;
  }) => Promise<Readonly<{
    userId: string;
    role: string;
    status: string;
    epoch: number;
  }> | null>;
  /**
   * The translated command's own audit fact (the finalizer's
   * `directory.command.finalized` row in enterprise_audit_events), by
   * commandId — the id a translated report's `auditEventId` carries.
   */
  readonly auditEventIdOf: (input: {
    readonly tenantId: string;
    readonly commandId: string;
  }) => Promise<string | null>;
}

/**
 * The provenance extension every translated (ba-branch) report carries: the
 * legacy fields are the real post-command projection facts, and these four
 * name the directory transition that produced them. A consumer that sees
 * `via: "directory"` reads `commandId`/`replayed` for the receipt, never a
 * fabricated legacy audit id.
 */
export interface DirectoryTransitionReport {
  readonly via: "directory";
  readonly operation:
    | "member.role.set"
    | "member.suspend"
    | "member.restore"
    | "member.remove"
    | "member.leave";
  readonly commandId: string;
  readonly replayed: boolean;
}

export interface MembershipAdminTranslationDeps {
  /** The single-writer (directory-role) connection the authority read runs on. */
  readonly database: Database;
  /** The authority port the mode read goes through (T03.01's seam). */
  readonly authority: Pick<import("./authority").DirectoryAuthority, "read">;
  /** The Directory executor the command half runs through. */
  readonly directory: Directory;
}

/**
 * The shared skeleton every old entrance's ba branch runs (T04.03, ticket
 * step 5): the narrow member read with the entrance's own state gate (a
 * refused gate is the legacy invisible not-found) → ONE directory command
 * (the executor owns the lock, the receipt, the commit fences and the
 * finalizer) → the committed projection facts and the command's audit id for
 * the caller's report. The mode branch is the caller's — this runs only
 * after `modeOf()` answered `ba`.
 */
export async function translateMembershipLifecycle(
  port: MembershipAdminTranslationPort,
  input: {
    readonly actorUserId: string;
    readonly tenantId: string;
    readonly principalId: string;
    readonly operation:
      | "member.role.set"
      | "member.suspend"
      | "member.restore"
      | "member.remove"
      | "member.leave";
    readonly payloadOf: (userId: string) => Readonly<Record<string, unknown>>;
    /** Mirrors the entrance's legacy state rule; false → invisible not-found. */
    readonly stateGate?: (member: {
      readonly role: string;
      readonly status: string;
    }) => boolean;
  },
): Promise<{
  readonly before: Readonly<{
    userId: string;
    role: string;
    status: string;
    epoch: number;
  }>;
  readonly after: Readonly<{
    userId: string;
    role: string;
    status: string;
    epoch: number;
  }>;
  readonly commandId: string;
  readonly replayed: boolean;
  readonly auditEventId: string;
}> {
  const before = await port.memberOf({
    tenantId: input.tenantId,
    principalId: input.principalId,
  });
  // The default gate mirrors the legacy entrances' shared rule (only an
  // active member moves); a caller with a different rule passes its own.
  const stateGate = input.stateGate ?? ((member) => member.status === "active");
  if (!before || !stateGate(before)) {
    throw new Error("COMPANY_MEMBER_NOT_FOUND");
  }
  const result = await port.execute(port.actorOf(input.actorUserId), {
    operation: input.operation,
    tenantId: input.tenantId,
    idempotencyKey: randomUUID(),
    payload: input.payloadOf(before.userId),
  });
  const after = await port.memberOf({
    tenantId: input.tenantId,
    principalId: input.principalId,
  });
  if (!after) {
    throw new Error(
      "MEMBERSHIP_TRANSLATION_PROJECTION_LOST: the translated command committed but the projection row is gone; the directory and the projection are out of agreement and the report cannot be shaped",
    );
  }
  const auditEventId = await port.auditEventIdOf({
    tenantId: input.tenantId,
    commandId: result.commandId,
  });
  if (!auditEventId) {
    // The finalizer writes the audit fact in the command's own transaction:
    // a missing row is an invariant break, never a silently skipped trail.
    throw new Error(
      "MEMBERSHIP_TRANSLATION_AUDIT_MISSING: the translated command has no directory.command.finalized audit row; the audit write must never fold into success",
    );
  }
  return {
    before,
    after,
    commandId: result.commandId,
    replayed: result.replayed,
    auditEventId,
  };
}

/**
 * Builds the translation port the old management entrances consume. The three
 * pieces are all required: a port without the executor would hand ba-state
 * calls a promise of translation that cannot happen, and a permissive
 * stand-in is the bypass interfaces §3.3 forbids. Production wiring arrives
 * with the assembly that registers the handlers; until then the entrances
 * keep their legacy path by simply not receiving a port (disclosed in the
 * T04.03 report).
 */
export function createMembershipAdminTranslation(
  deps: MembershipAdminTranslationDeps,
): MembershipAdminTranslationPort {
  if (typeof deps?.database?.transaction !== "function") {
    throw new Error(
      "MEMBERSHIP_TRANSLATION_DEPS_REQUIRED: createMembershipAdminTranslation needs the single-writer database the authority read runs on",
    );
  }
  if (typeof deps?.authority?.read !== "function") {
    throw new Error(
      "MEMBERSHIP_TRANSLATION_DEPS_REQUIRED: createMembershipAdminTranslation needs the directory authority port — without an in-transaction authority read the entrance cannot tell a ba state from a legacy one, and an optional read is the bypass interfaces §3.3 forbids",
    );
  }
  if (typeof deps?.directory?.execute !== "function") {
    throw new Error(
      "MEMBERSHIP_TRANSLATION_DEPS_REQUIRED: createMembershipAdminTranslation needs the Directory executor; without the command envelope there is no translated write",
    );
  }
  return Object.freeze({
    async modeOf() {
      return deps.database.transaction(async (tx) => {
        const state = await deps.authority.read(tx);
        return state.directoryAuthority;
      });
    },
    execute: (
      actor: DirectoryActor,
      command: import("./contracts").DirectoryCommand,
    ) => deps.directory.execute(actor, command),
    actorOf: (actorUserId: string) =>
      Object.freeze({
        userId: actorUserId,
        principalId: null,
        sessionId: null,
        // Platform, not session: the old entrances do not carry a session id
        // (store.ts's identity seam resolves only {actorId, entrypoint}), and
        // a session actor must name one. This is exactly T03.04's platform
        // lifecycle-actor shape — server-issued provenance for a
        // server-orchestrated translation, never a client-supplied field.
        kind: "platform" as const,
        bindingId: null,
        provisioning: null,
      }),
    async memberOf({
      tenantId,
      principalId,
    }: {
      readonly tenantId: string;
      readonly principalId: string;
    }) {
      return deps.database.transaction(async (tx) => {
        const [row] = rowsOf(
          await tx.execute(
            sql`SELECT p.user_id AS user_id, m.role AS role,
                       m.status AS status, m.epoch::int AS epoch
                  FROM enterprise_principals p
                  JOIN enterprise_memberships m
                    ON m.principal_id = p.id
                 WHERE p.id = ${principalId}
                   AND m.tenant_id = ${tenantId}
                 LIMIT 1`,
          ),
        );
        if (!row) return null;
        return Object.freeze({
          userId: String(row.user_id),
          role: String(row.role),
          status: String(row.status),
          epoch: Number(row.epoch),
        });
      });
    },
    async auditEventIdOf({
      tenantId,
      commandId,
    }: {
      readonly tenantId: string;
      readonly commandId: string;
    }) {
      return deps.database.transaction(async (tx) => {
        const [row] = rowsOf(
          await tx.execute(
            sql`SELECT id FROM enterprise_audit_events
                  WHERE tenant_id = ${tenantId}
                    AND event_type = 'directory.command.finalized'
                    AND payload->>'commandId' = ${commandId}
                  LIMIT 1`,
          ),
        );
        return row ? String(row.id) : null;
      });
    },
  });
}
