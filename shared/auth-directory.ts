/**
 * The stable-ID company/team discovery and selection DTO family (T03.02 /
 * Issue #539, epic #507; interfaces §4).
 *
 * Types and the one closed vocabulary, nothing else: this module never reads a
 * database and owns no behaviour. The listing/validation half lives in
 * `server/src/enterprise/tenancy/workspace-admin.ts`; its HTTP face rides the
 * workspace-scope entrance in `workspace-scope-routes.ts`.
 *
 * The shapes below reproduce interfaces §4 exactly. The BA-v1 DTO is
 * advertised and consumed only under `ba` directory authority: under legacy
 * the same-named routes keep the original DTO, preferences and client
 * branches, and a pseudo-BA id never fills a field of this family — a company
 * with no `auth_organizations` row is hidden from this listing, not invented
 * into it.
 *
 * Every id here is a stable business id: `tenantId` names the company (the BA
 * organization's id IS the tenant id), `workspaceId` the team's historical
 * workspace identity, and `organizationId`/`teamId` the BA directory rows
 * those map to through `auth_organizations` / `auth_team_bindings`. Never a BA
 * member or team-member row id — those are recreated on every re-join.
 */

/** interfaces §2: a non-negative safe integer, the only version this family compares. */
export type Version = number;

/**
 * The directory role vocabulary (interfaces §2/§4), deliberately separate from
 * the global `user`/`admin` domain the platform identity carries.
 */
export type DirectoryRole = "owner" | "admin" | "member" | "auditor";

/** One team a principal is currently eligible in, with its durable versions. */
export type ScopeListingTeam = Readonly<{
  readonly workspaceId: string;
  readonly teamId: string;
  readonly name: string;
  readonly workspaceMemberEpoch: Version;
  readonly teamGeneration: Version;
}>;

/** One company a principal is currently eligible in, with its teams. */
export type ScopeListingCompany = Readonly<{
  readonly tenantId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly memberEpoch: Version;
  readonly companyGeneration: Version;
  readonly role: DirectoryRole;
  readonly capabilities: readonly string[];
  readonly teams: readonly ScopeListingTeam[];
}>;

/** The discovery answer: every company the actor may select into, never a default. */
export type ScopeListing = Readonly<{
  readonly companies: readonly ScopeListingCompany[];
}>;

/** An explicit selection: the client names exactly one company and one team. */
export type SelectionInput = Readonly<{
  readonly tenantId: string;
  readonly workspaceId: string;
}>;

/** The validated selection: the input plus the stable ids and versions the gate compares. */
export type ValidatedSelection = SelectionInput &
  Readonly<{
    readonly organizationId: string;
    readonly teamId: string;
    readonly memberEpoch: Version;
    readonly workspaceMemberEpoch: Version;
    readonly companyGeneration: Version;
    readonly teamGeneration: Version;
    readonly capabilities: readonly string[];
  }>;

/**
 * The closed first-phase capability vocabulary (interfaces §4). A capability
 * is a statement the listing may make from directory facts; writing to the
 * books still goes through the dedicated action checks, never through a
 * capability string.
 */
export const SCOPE_CAPABILITIES = Object.freeze([
  "company:manage",
  "team:members:manage",
  "audit:metadata:read",
  "finance:read",
] as const);

/** One entry of the closed vocabulary above. */
export type ScopeCapability = (typeof SCOPE_CAPABILITIES)[number];
