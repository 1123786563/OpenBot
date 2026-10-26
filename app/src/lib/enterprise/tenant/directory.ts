import { ClientResponseError, client } from "@/lib/client";
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
