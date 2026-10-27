import { queryOptions } from "@tanstack/react-query";
import { authKeys } from "@/lib/auth/queries";
import { ClientResponseError, client, tryClient } from "@/lib/client";
import type { ScopedCache } from "./scoped-cache";
import type { WorkspaceScopeCompany } from "./selection";

/*
 * The tenant Directory command adapters the organization pages consume, T04.09 (Issue #553).
 *
 * TWO ADAPTERS, TWO AUTHORITIES. The company profile write goes to the BA-native
 * `/api/auth/organization/update`, which the ingress translates into the Directory command
 * `company.profile.update` — with a FLAT body (`{organizationId, name?, slug?, logo?}`, as the
 * ingress's own coverage suite pins), so the Better Auth client's `{data: …}` wrapper would be
 * refused outright and is never used here. Team member changes go to the scoped team routes
 * T04.08 owns (`/api/enterprise/workspace-scope/admin/teams/:workspaceId/members`), carrying the
 * selection pair as the scope headers the server's resolver reads. A scoped team manager's page
 * therefore never touches a company-profile write, and a company-role manager's profile write
 * never touches a team route: the surfaces compose different adapters, not one adapter with a
 * flag.
 *
 * THE SERVER STAYS THE AUTHORITY. `ProfileWriteUnavailable` covers the one fact the frontend
 * can see (a legacy listing row carries no `organizationId`, so there is nothing to address the
 * write to); every other judgment — company role, team grant, suspension — is the server's, and
 * arrives here as a `ClientResponseError` status the page maps to its recoverable copy.
 */

/** The scope half every adapter here needs: open, with a company-and-team pair in force. */
export type DirectoryScope = Extract<ScopedCache, { status: "open" }> & {
  selection: NonNullable<Extract<ScopedCache, { status: "open" }>["selection"]>;
};

/** The company profile fields the first phase may write — exactly these three, nothing else. */
export type CompanyProfileWrite = Readonly<{
  name?: string;
  slug?: string;
  logo?: string;
}>;

/**
 * The profile write has no address: the listing row named no BA binding (a legacy deployment's
 * answer), so there is no organization the Directory command could name. The page renders the
 * read-only profile instead of ever surfacing this.
 */
export class ProfileWriteUnavailable extends Error {
  constructor() {
    super("This company has no directory binding to write to.");
    this.name = "ProfileWriteUnavailable";
  }
}

/**
 * The company-role command adapter: the profile write, and nothing else. It takes no scope:
 * the BA-native endpoint resolves the actor from the session and the flat body names the
 * organization, so the enterprise scope headers (which the client only attaches to enterprise
 * paths anyway) have no part in this call.
 */
export function companyCommandAdapter(company: WorkspaceScopeCompany): {
  updateProfile(fields: CompanyProfileWrite): Promise<void>;
} {
  return {
    updateProfile: async (fields) => {
      const organizationId = company.organizationId;
      if (organizationId === undefined) throw new ProfileWriteUnavailable();
      // Flat body, only the fields that carry a value: the ingress validates exactly
      // {organizationId, name?, slug?, logo?} and refuses anything nested or unknown.
      const body: Record<string, string> = { organizationId };
      for (const key of ["name", "slug", "logo"] as const) {
        const value = fields[key]?.trim();
        if (value) body[key] = value;
      }
      await client("/api/auth/organization/update", {
        method: "POST",
        body,
        fallbackKey: "companyAdmin.saveCompanyProfile",
      });
    },
  };
}

/** The scoped team manager's command adapter: add and remove on the selected team only. */
export function scopedTeamCommandAdapter(scope: DirectoryScope): {
  addMember(principalId: string): Promise<void>;
  removeMember(principalId: string): Promise<void>;
} {
  const { tenantId, workspaceId } = scope.selection;
  const membersPath = `/api/enterprise/workspace-scope/admin/teams/${encodeURIComponent(workspaceId)}/members`;
  const scoped = {
    tenantId,
    workspaceId,
    fallbackKey: "companyAdmin.changeTeamMembers",
  } as const;
  return {
    addMember: async (principalId) => {
      await client(membersPath, {
        ...scoped,
        method: "POST",
        body: { principalId },
      });
    },
    removeMember: async (principalId) => {
      await client(`${membersPath}/${encodeURIComponent(principalId)}`, {
        ...scoped,
        method: "DELETE",
      });
    },
  };
}

/** The failure kinds the organization pages have words for, from the server's status alone. */
export type DirectoryFailureKind = "refused" | "invalid" | "paused" | "failed";

/**
 * Maps a failed command to the copy a person can act on: a refusal says who to ask, an invalid
 * request says what to check, a paused directory says to wait, and anything else says the reach
 * failed. The server's own message is never shown here — it is a code for the audit trail, not
 * a sentence for the page.
 */
export function directoryFailureKind(error: unknown): DirectoryFailureKind {
  if (error instanceof ClientResponseError) {
    if (error.status === 401 || error.status === 403) return "refused";
    if (error.status === 400 || error.status === 404 || error.status === 409) {
      return "invalid";
    }
    if (error.status === 503) return "paused";
  }
  return "failed";
}

/*
 * The people page's Directory half, T04.10 (Issue #554). The roster and its actions ride the
 * BA-native organization surface the ingress classifies: `get-full-organization` is an R-class
 * read (the gate re-proves membership in its own transaction, then the pinned build answers), and
 * the member/invitation writes are D-class translations with FLAT bodies, like the profile write
 * above. The STABLE ID of a member is the userId — the ingress resolves its member selector onto
 * the directory command by userId, while a BA member row id is recreated on re-join — so every
 * command here carries the row's userId and nothing else addresses a person.
 *
 * THE CONFLICTS HAVE NAMES. The four refusals a person can act on are the last owner, the seat
 * limit, an invitation that already exists, and a paused directory: the first three are 409s whose
 * codes the server's own envelope carries, the fourth is the M2/M3 503. They resolve here, off the
 * status plus the code, into a `PeopleActionFailure` the page has distinct words for — so the form
 * that failed keeps its input while the sentence says what to do next. `directoryFailureKind`
 * above stays untouched: its callers (the T04.09 cards) keep their four-word vocabulary.
 */

/** The fixed roles the directory holds (interfaces §2): nobody invents a fifth one here. */
export type DirectoryRole = "owner" | "admin" | "member" | "auditor";

/** The roles an invitation may delegate (the ingress refuses owner by invitation). */
export type DirectoryInvitableRole = Extract<
  DirectoryRole,
  "admin" | "member" | "auditor"
>;

/** One member row of the full-organization answer, trimmed to what the page shows and commands. */
export type DirectoryMemberRow = Readonly<{
  /** The stable id every command addresses; the BA row id never leaves the wire shape. */
  userId: string;
  role: DirectoryRole;
  createdAt: string;
}>;

/** One pending invitation of the same answer. */
export type DirectoryInvitationRow = Readonly<{
  id: string;
  email: string;
  role: DirectoryInvitableRole;
  status: string;
  expiresAt: string;
}>;

/** The failure vocabulary of the people commands, with the conflict causes named. */
export type PeopleActionFailure =
  | DirectoryFailureKind
  | "lastOwner"
  | "seats"
  | "invitation";

/** One stable team-management grant row of the T04.07 answer. */
export type TeamGrantRow = Readonly<{
  grantId: string;
  userId: string;
  actions: readonly ("team.member.add" | "team.member.remove")[];
  generation: number;
  status: "active" | "revoked";
}>;

/** The failed people/grant command, carrying the sentence-kind the page already has words for. */
export class DirectoryPeopleActionError extends Error {
  readonly failure: PeopleActionFailure;

  constructor(failure: PeopleActionFailure) {
    super("The directory refused that change.");
    this.name = "DirectoryPeopleActionError";
    this.failure = failure;
  }
}

/** Reads the refusal code out of either envelope the deployment answers with. */
async function refusalCodeOf(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
    error?: unknown;
  } | null;
  if (typeof body?.code === "string") return body.code;
  const error = body?.error;
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/** The status-plus-code verdict a refused write resolves to. */
async function peopleActionFailure(
  response: Response,
): Promise<PeopleActionFailure> {
  if (response.status === 409) {
    const code = await refusalCodeOf(response);
    if (code === "MEMBERSHIP_LIFECYCLE_LAST_OWNER") return "lastOwner";
    if (code === "MEMBERSHIP_INVITATION_SEATS_EXHAUSTED") return "seats";
    if (
      code === "MEMBERSHIP_INVITATION_ALREADY_PENDING" ||
      code === "MEMBERSHIP_INVITATION_TARGET_ALREADY_MEMBER"
    ) {
      return "invitation";
    }
  }
  return directoryFailureKind(
    new ClientResponseError(response.status, "", null),
  );
}

/** Sends one flat-bodied BA-native command and turns a refusal into the named failure. */
async function directoryCommand(
  path: string,
  body: Record<string, unknown>,
  fallbackKey: string,
  init: { headers?: Record<string, string> } = {},
): Promise<void> {
  const response = await tryClient(path, {
    method: "POST",
    body,
    fallbackKey,
    ...(init.headers ? { headers: init.headers } : {}),
  });
  if (!response.ok) {
    throw new DirectoryPeopleActionError(await peopleActionFailure(response));
  }
}

const DIRECTORY_MEMBERS = ":directory-members";
const TEAM_GRANTS = ":team-grants";

function rowsOf(value: unknown): readonly Record<string, unknown>[] | null {
  return Array.isArray(value)
    ? (value as readonly Record<string, unknown>[])
    : null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The Directory roster and pending invitations of the selected company: the full-organization
 * answer behind the R-class gate. Asked for only when the listing row carries the BA binding — a
 * legacy row renders the MT095 roster it always had, so this read never fires there.
 */
export function directoryMembersQueryOptions(
  scope: ScopedCache,
  company: WorkspaceScopeCompany | null,
) {
  const organizationId =
    company !== null && company.organizationId !== undefined
      ? company.organizationId
      : null;
  const open =
    scope.status === "open" &&
    scope.selection !== null &&
    organizationId !== null
      ? scope
      : null;
  return queryOptions({
    enabled: open !== null,
    queryKey:
      open !== null
        ? [...open.prefix, DIRECTORY_MEMBERS]
        : [DIRECTORY_MEMBERS, ":scope-pending"],
    queryFn: async (): Promise<{
      members: readonly DirectoryMemberRow[];
      invitations: readonly DirectoryInvitationRow[];
    }> => {
      if (organizationId === null) {
        // Unreachable while enabled; the guard keeps the read honest about its own address.
        throw new Error("The directory roster needs a bound company.");
      }
      const response = await tryClient(
        `/api/auth/organization/get-full-organization?organizationId=${encodeURIComponent(organizationId)}`,
        { fallbackKey: "companyAdmin.loadDirectoryMembers" },
      );
      if (!response.ok) {
        throw new DirectoryPeopleActionError(
          directoryFailureKind(
            new ClientResponseError(response.status, "", null),
          ),
        );
      }
      const body = (await response.json().catch(() => null)) as {
        members?: unknown;
        invitations?: unknown;
      } | null;
      const memberRows = rowsOf(body?.members) ?? [];
      const invitationRows = rowsOf(body?.invitations) ?? [];
      return {
        members: memberRows.flatMap((row) => {
          const userId = textOf(row.userId);
          const role = textOf(row.role);
          if (userId === null || role === null) return [];
          return [
            {
              userId,
              role: role as DirectoryRole,
              createdAt: textOf(row.createdAt) ?? "",
            },
          ];
        }),
        invitations: invitationRows.flatMap((row) => {
          const id = textOf(row.id);
          const email = textOf(row.email);
          const role = textOf(row.role);
          if (id === null || email === null || role === null) return [];
          return [
            {
              id,
              email,
              role: role as DirectoryInvitableRole,
              status: textOf(row.status) ?? "",
              expiresAt: textOf(row.expiresAt) ?? "",
            },
          ];
        }),
      };
    },
  });
}

/**
 * The company-role people commands (T04.10): role changes, removal, invitations. All flat bodies
 * the ingress pins; `memberId` IS the userId (the stable id), and a removal always carries the
 * reason its audit row records. Composed only for a listing row with the BA binding; whether this
 * member may actually command any of it is the server's call inside the command.
 */
export function directoryPeopleCommandAdapter(company: WorkspaceScopeCompany): {
  setMemberRole(memberId: string, role: DirectoryRole): Promise<void>;
  removeMember(memberId: string, reason: string): Promise<void>;
  inviteMember(email: string, role: DirectoryInvitableRole): Promise<void>;
  cancelInvitation(invitationId: string): Promise<void>;
} {
  const organizationId = company.organizationId;
  if (organizationId === undefined) {
    throw new ProfileWriteUnavailable();
  }
  return {
    setMemberRole: (memberId, role) =>
      directoryCommand(
        "/api/auth/organization/update-member-role",
        { organizationId, memberId, role },
        "companyAdmin.setMemberRole",
      ),
    removeMember: (memberId, reason) =>
      directoryCommand(
        "/api/auth/organization/remove-member",
        { organizationId, memberId, reason },
        "companyAdmin.removeMember",
      ),
    inviteMember: (email, role) =>
      directoryCommand(
        "/api/auth/organization/invite-member",
        { organizationId, email, role },
        "companyAdmin.inviteMember",
      ),
    cancelInvitation: (invitationId) =>
      directoryCommand(
        "/api/auth/organization/cancel-invitation",
        { organizationId, invitationId },
        "companyAdmin.cancelInvitation",
      ),
  };
}

/**
 * The T04.07 management grants of the selected team: the stable rows, the grant and the revoke.
 * The POST carries the idempotency key the route demands; the revoke carries the reason its audit
 * row records. A READ grant (finance, audit) is a different thing entirely — nothing here reads or
 * writes those, and the section that renders this adapter is gated on `company:manage`, which the
 * §4 listing derives from the role row alone.
 */
export function teamGrantsQueryOptions(scope: ScopedCache) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    enabled: open !== null,
    queryKey:
      open !== null
        ? [...open.prefix, TEAM_GRANTS]
        : [TEAM_GRANTS, ":scope-pending"],
    queryFn: async (): Promise<{ grants: readonly TeamGrantRow[] }> => {
      if (open === null || open.selection === null) {
        throw new Error("The team's grants are not readable yet.");
      }
      const response = await tryClient(
        `/api/enterprise/workspace-scope/admin/teams/${encodeURIComponent(open.selection.workspaceId)}/management-grants`,
        {
          fallbackKey: "companyAdmin.loadTeamGrants",
          tenantId: open.selection.tenantId,
          workspaceId: open.selection.workspaceId,
        },
      );
      if (!response.ok) {
        throw new DirectoryPeopleActionError(
          await peopleActionFailure(response),
        );
      }
      const body = (await response.json().catch(() => null)) as {
        grants?: unknown;
      } | null;
      const grantRows = rowsOf(body?.grants) ?? [];
      return {
        grants: grantRows.flatMap((row) => {
          const grantId = textOf(row.grantId);
          const userId = textOf(row.userId);
          const actions = Array.isArray(row.actions)
            ? (row.actions as readonly unknown[])
            : null;
          if (grantId === null || userId === null || actions === null)
            return [];
          return [
            {
              grantId,
              userId,
              actions: actions.flatMap((action) =>
                action === "team.member.add" || action === "team.member.remove"
                  ? [action]
                  : [],
              ),
              generation:
                typeof row.generation === "number" ? row.generation : 0,
              status: row.status === "revoked" ? "revoked" : "active",
            },
          ];
        }),
      };
    },
  });
}

/** The grant/revoke commands of the T04.07 routes, riding the selected scope pair. */
export function teamGrantCommandAdapter(scope: DirectoryScope): {
  grant(userId: string, actions: readonly string[]): Promise<void>;
  revoke(grantId: string, reason: string): Promise<void>;
} {
  const { tenantId, workspaceId } = scope.selection;
  const grantsPath = `/api/enterprise/workspace-scope/admin/teams/${encodeURIComponent(workspaceId)}/management-grants`;
  const scoped = {
    tenantId,
    workspaceId,
    fallbackKey: "companyAdmin.changeTeamGrants",
  } as const;
  return {
    grant: async (userId, actions) => {
      const response = await tryClient(grantsPath, {
        ...scoped,
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: { userId, actions },
      });
      if (!response.ok) {
        throw new DirectoryPeopleActionError(
          await peopleActionFailure(response),
        );
      }
    },
    revoke: async (grantId, reason) => {
      const response = await tryClient(
        `${grantsPath}/${encodeURIComponent(grantId)}`,
        {
          ...scoped,
          method: "DELETE",
          body: { reason },
        },
      );
      if (!response.ok) {
        throw new DirectoryPeopleActionError(
          await peopleActionFailure(response),
        );
      }
    },
  };
}

/*
 * The public invitation landing, T04.11 (#555). The page at /accept-invitation?id=… reads ONE
 * invitation through the U-class surface T04.01 froze (`GET /api/enterprise/invitations/:id`):
 * the minimal landing state while nobody is signed in, the caller's own view once they are, and
 * a 404 that answers every other case exactly like a missing one. The BA native GETs stay
 * closed (the ingress X rows), so this adapter is the page's only read — no roster, no
 * directory, no company listing ever loads for a landing.
 *
 * The answer the page acts on, and the commands it answers with, both carry the invitation's
 * own refusals as names: expired, settled (the concurrent double-accept among them), the
 * unverified mailbox, the wrong account, the seat limit and the closed company each land on
 * their own sentence, the way the people page's conflicts do.
 */

/** Who is looking at the invitation: their mailbox, and whether they have verified it. */
export type InvitationSession = Readonly<{
  email: string;
  emailVerified: boolean;
}>;

/** The narrow invitation read's one answer: the public landing, the caller's own view, or nothing. */
export type PublicInvitationRead =
  | Readonly<{ kind: "landing"; status: string; expired: boolean }>
  | Readonly<{
      kind: "own";
      organizationName: string;
      role: string | null;
      expiresAt: string;
    }>
  | Readonly<{ kind: "unavailable" }>;

/** The invitation commands' failure vocabulary, with the invitation's own refusals named. */
export type InvitationActionFailure =
  | DirectoryFailureKind
  | "expired"
  | "settled"
  | "unverified"
  | "mismatch"
  | "seats"
  | "closed";

/** The refused accept/decline, carrying the named outcome the page has words for. */
export class DirectoryInvitationActionError extends Error {
  readonly failure: InvitationActionFailure;

  constructor(failure: InvitationActionFailure) {
    super("The invitation refused that change.");
    this.name = "DirectoryInvitationActionError";
    this.failure = failure;
  }
}

export const invitationKeys = {
  root: ["invitation"] as const,
  landing: (invitationId: string) =>
    ["invitation", "landing", invitationId] as const,
};

/** The status-plus-code verdict a refused accept or decline resolves to. */
async function invitationActionFailure(
  response: Response,
): Promise<InvitationActionFailure> {
  if (response.status === 409) {
    const code = await refusalCodeOf(response);
    if (code === "MEMBERSHIP_INVITATION_EXPIRED") return "expired";
    if (code === "MEMBERSHIP_INVITATION_NOT_PENDING") return "settled";
    if (code === "MEMBERSHIP_INVITATION_SEATS_EXHAUSTED") return "seats";
  }
  if (response.status === 403) {
    const code = await refusalCodeOf(response);
    if (code === "MEMBERSHIP_INVITATION_EMAIL_UNVERIFIED") return "unverified";
    if (code === "MEMBERSHIP_INVITATION_RECIPIENT_MISMATCH") return "mismatch";
    if (code === "MEMBERSHIP_INVITATION_COMPANY_CLOSED") return "closed";
  }
  return directoryFailureKind(
    new ClientResponseError(response.status, "", null),
  );
}

/**
 * The invitee's two answers. Flat bodies the ingress pins (`{invitationId}` is the whole
 * command); no membership, company proof or role is asked for first — the invitee's verified
 * mailbox is the server's whole qualification, and it checks it itself.
 */
export function invitationCommandAdapter(): {
  accept(invitationId: string): Promise<void>;
  decline(invitationId: string): Promise<void>;
} {
  const send = async (path: string, invitationId: string): Promise<void> => {
    const response = await tryClient(path, {
      method: "POST",
      body: { invitationId },
      fallback: "The invitation could not be answered.",
    });
    if (!response.ok) {
      throw new DirectoryInvitationActionError(
        await invitationActionFailure(response),
      );
    }
  };
  return {
    accept: (invitationId) =>
      send("/api/auth/organization/accept-invitation", invitationId),
    decline: (invitationId) =>
      send("/api/auth/organization/reject-invitation", invitationId),
  };
}

/**
 * The one invitation read the landing page performs. A 404 is an answer, not a failure — the
 * server's own rule answers a cancelled, expired-for-the-caller, wrong-mailbox or missing
 * invitation exactly alike — so it resolves to `unavailable` and the page's sentence, while a
 * transport failure still throws the sentence the page shows for a reach problem.
 */
export function invitationLandingQueryOptions(
  invitationId: string | undefined,
) {
  return queryOptions({
    enabled: invitationId !== undefined,
    queryKey:
      invitationId !== undefined
        ? invitationKeys.landing(invitationId)
        : [...invitationKeys.root, "landing", ":no-id"],
    queryFn: async (): Promise<PublicInvitationRead> => {
      if (invitationId === undefined) {
        // Unreachable while enabled; the guard keeps the read honest about its own address.
        throw new Error("The invitation read needs its id.");
      }
      const response = await tryClient(
        `/api/enterprise/invitations/${encodeURIComponent(invitationId)}`,
        { fallback: "The invitation could not be loaded." },
      );
      if (response.status === 404) return { kind: "unavailable" };
      if (!response.ok) {
        throw new Error(`Could not read the invitation (${response.status}).`);
      }
      const body = (await response.json().catch(() => null)) as {
        invitation?: Record<string, unknown> | null;
      } | null;
      const invitation = body?.invitation ?? null;
      if (invitation === null) return { kind: "unavailable" };
      // The caller's own view carries the company; the public landing carries the state alone.
      const organizationName = textOf(invitation.organizationName);
      if (organizationName !== null) {
        return {
          kind: "own",
          organizationName,
          role: textOf(invitation.role),
          expiresAt: textOf(invitation.expiresAt) ?? "",
        };
      }
      const status = textOf(invitation.status);
      if (status === null) return { kind: "unavailable" };
      return { kind: "landing", status, expired: invitation.expired === true };
    },
  });
}

/**
 * The session half of the landing: the mailbox looking at the invitation and whether it is
 * verified. Better Auth's own session endpoint, not `/api/me` — the landing needs the
 * verification flag `/api/me` does not carry, and nobody is authenticated to need more. Keyed
 * under the auth keys so the sign-out that switches accounts clears it with everything else.
 */
export function invitationSessionQueryOptions() {
  return queryOptions({
    queryKey: [...authKeys.all, "invitation-session"],
    queryFn: async (): Promise<InvitationSession | null> => {
      const response = await tryClient("/api/auth/get-session", {
        fallback: "The session could not be read.",
      });
      if (!response.ok) return null;
      const body = (await response.json().catch(() => null)) as {
        user?: { email?: unknown; emailVerified?: unknown } | null;
      } | null;
      const user = body?.user ?? null;
      if (user === null) return null;
      const email = textOf(user.email);
      if (email === null) return null;
      return { email, emailVerified: user.emailVerified === true };
    },
  });
}
