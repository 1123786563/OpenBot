/*
 * NativeAuthIngress — the one door between the fixed Better Auth HTTP surface
 * and the directory/identity commands (T02.11 / #533, original task P04;
 * interfaces §3.1/§3.2, design §5.2 step 5).
 *
 * The table below IS the frozen classification of the pinned build's native
 * endpoints: every Admin, Organization, SSO and SCIM path of interfaces §3.2,
 * with its disposition (D/I/R/S/P/X, plus the two transitional classes this
 * task introduces and explains) and the task that owns its wiring. Nothing a
 * client sends can add a row or change one: a path outside the lists that
 * lives under a directory prefix is refused, and a method the row does not
 * name is refused — "unknown means refuse", never "unknown means pass".
 *
 * Why the ingress exists at all: the pinned build would serve these endpoints
 * straight from its own handler. That handler opens its own transaction per
 * request and rebuilds the async-local adapter store, so a write arriving
 * there can never be part of the directory executor's outer transaction
 * (F-01). Directory writes are therefore translated into `Directory.execute` /
 * `Identity.execute` commands on this side of the handler; the executor runs
 * the pinned build's own `auth.api.<endpoint>` inside the command transaction,
 * which is the only shape that keeps the business write, its projections, its
 * clocks, its audit and its outbox in one commit. Native reads are gated in a
 * real transaction first and only then forwarded: the gate decides, the pinned
 * build answers.
 *
 * Two transitional dispositions, stated here rather than left implicit:
 *
 * - `closed` marks endpoints whose §3.2 disposition is a translated write (or
 *   a binding-scoped read) this deployment cannot serve yet: the SSO
 *   configuration/domain writes, the SCIM provisioning writes, and the SCIM
 *   resource reads. Interfaces §3.2's vocabulary has no "keep the native
 *   contract" state for them, and forwarding a write to the pinned build's
 *   own handler is exactly the F-01 bypass this ingress exists to close, so
 *   they answer a named 501 until the transcription (T05's SSO/SCIM tickets)
 *   lands. Every such row carries its closedCode and its owning task.
 * - `S` (the two self-preference writes) is refused with 503 until P05 wires
 *   the preference store: a preference must be verified against a live
 *   company/team, and there is no such writer yet.
 *
 * What the ingress deliberately does NOT do: it never calls `auth.api` for a
 * write (the executor owns that call), never opens the pinned build's handler
 * inside a read-gate transaction, and never treats a client-supplied
 * `organizationId`, actor, scope or status as authoritative — those cross the
 * boundary only as intents, and the executor/finalizer re-verify them.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { isCompanyAssuranceRefusal } from "../company-assurance";
import { isAuthorityRefusal } from "./authority";
import type {
  Directory,
  DirectoryActor,
  DirectoryCommand,
  DirectoryOperation,
  IdentityActor,
  IdentityCommand,
  IdentityOperation,
} from "./contracts";
import {
  assertDirectoryActor,
  assertDirectoryCommand,
  isDirectoryCommandRefusal,
} from "./executor";
import {
  assertIdentityActor,
  assertIdentityCommand,
  type IdentityExecutor,
  isIdentityCommandRefusal,
} from "./identity";
import {
  INVITATION_DELEGABLE_ROLES,
  isDirectoryMembershipRefusal,
  MEMBERSHIP_INVITATION_NOT_FOUND,
} from "./membership";
import {
  assertTeamBelongsToCompany,
  type DirectoryReadGate,
  isDirectoryReadRefusal,
  type PlatformReadGate,
} from "./read-gate";

/** The HTTP methods the fixed build declares for these surfaces. */
export type NativeAuthMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * The disposition vocabulary. D/I/R/S/P/X are interfaces §3.2's own; `native`
 * keeps the pinned build's own contract for exactly the cells §3.2 marks
 * "保留 BA 原生合同" (login, OIDC/SAML callbacks, SP metadata, SCIM protocol
 * discovery) and nothing else; `closed` is explained in the file header.
 */
export type NativeAuthDisposition =
  | "D"
  | "I"
  | "R"
  | "S"
  | "P"
  | "X"
  | "native"
  | "closed";

export interface NativeAuthEndpoint {
  readonly method: NativeAuthMethod;
  /** Path relative to /api/auth; `:name` matches exactly one segment. */
  readonly path: string;
  readonly disposition: NativeAuthDisposition;
  /**
   * The closed native operation name. The gate or the command builder receives
   * exactly this value; it is never echoed from a client.
   */
  readonly nativeOperation: string;
  /** The task interfaces §3.2 gives the action to. */
  readonly ownerTask: "P04" | "P05" | "P06" | "P08" | "P09" | "P12";
  readonly directoryOperation?: DirectoryOperation;
  readonly identityOperation?: IdentityOperation;
  /** The pinned build's server API name this row translates/forwards to. */
  readonly api?: string;
  /** The named 501 code a `closed` row answers with. */
  readonly closedCode?: string;
  readonly note?: string;
}

export const CLOSED_SSO_WRITE_NOT_TRANSCRIBED =
  "CLOSED_SSO_WRITE_NOT_TRANSCRIBED";
export const CLOSED_SCIM_WRITE_NOT_TRANSCRIBED =
  "CLOSED_SCIM_WRITE_NOT_TRANSCRIBED";
export const CLOSED_SCIM_READ_UNBOUND = "CLOSED_SCIM_READ_UNBOUND";
export const NATIVE_AUTH_IDEMPOTENCY_KEY_REQUIRED =
  "NATIVE_AUTH_IDEMPOTENCY_KEY_REQUIRED";
export const NATIVE_AUTH_MEMBER_ID_MUST_BE_USER_ID =
  "NATIVE_AUTH_MEMBER_ID_MUST_BE_USER_ID";
export const PASSWORD_RECOVERY_NOT_WIRED = "PASSWORD_RECOVERY_NOT_WIRED";
export const INVITATION_ROLE_NOT_DELEGABLE = "INVITATION_ROLE_NOT_DELEGABLE";
export const INVITATION_RESEND_IS_CONTROLLED =
  "INVITATION_RESEND_IS_CONTROLLED";

const X_ORGANIZATION_ENDPOINTS: ReadonlyArray<
  readonly [NativeAuthMethod, string, string]
> = Object.freeze([
  ["GET", "/organization/list", "organization.list"],
  ["GET", "/organization/list-user-teams", "organization.list-user-teams"],
  ["GET", "/organization/get-invitation", "organization.get-invitation"],
  [
    "GET",
    "/organization/list-user-invitations",
    "organization.list-user-invitations",
  ],
  ["POST", "/organization/create-role", "organization.create-role"],
  ["POST", "/organization/update-role", "organization.update-role"],
  ["POST", "/organization/delete-role", "organization.delete-role"],
  ["GET", "/organization/get-role", "organization.get-role"],
  ["GET", "/organization/list-roles", "organization.list-roles"],
]);

const SSO_CONFIG_WRITE_ENDPOINTS: ReadonlyArray<
  readonly [NativeAuthMethod, string, string, string]
> = Object.freeze([
  ["POST", "/sso/register", "sso.register", "registerSSOProvider"],
  ["POST", "/sso/update-provider", "sso.update-provider", "updateSSOProvider"],
  ["POST", "/sso/delete-provider", "sso.delete-provider", "deleteSSOProvider"],
  [
    "POST",
    "/sso/request-domain-verification",
    "sso.request-domain-verification",
    "requestDomainVerification",
  ],
  ["POST", "/sso/verify-domain", "sso.verify-domain", "verifyDomain"],
]);

const SCIM_DISCOVERY_ENDPOINTS: ReadonlyArray<
  readonly [NativeAuthMethod, string, string]
> = Object.freeze([
  ["GET", "/scim/v2/ServiceProviderConfig", "scim.service-provider-config"],
  ["GET", "/scim/v2/Schemas", "scim.schemas"],
  ["GET", "/scim/v2/Schemas/:schemaId", "scim.schemas.one"],
  ["GET", "/scim/v2/ResourceTypes", "scim.resource-types"],
  ["GET", "/scim/v2/ResourceTypes/:resourceTypeId", "scim.resource-types.one"],
]);

const SCIM_RESOURCE_READ_ENDPOINTS: ReadonlyArray<
  readonly [NativeAuthMethod, string, string]
> = Object.freeze([
  ["GET", "/scim/v2/Users", "scim.users.list"],
  ["GET", "/scim/v2/Users/:userId", "scim.users.get"],
  ["GET", "/scim/v2/Groups", "scim.groups.list"],
  ["GET", "/scim/v2/Groups/:groupId", "scim.groups.get"],
]);

const SCIM_WRITE_ENDPOINTS: ReadonlyArray<
  readonly [NativeAuthMethod, string, string]
> = Object.freeze([
  ["POST", "/scim/v2/Users", "scim.users.create"],
  ["PATCH", "/scim/v2/Users/:userId", "scim.users.patch"],
  ["PUT", "/scim/v2/Users/:userId", "scim.users.replace"],
  ["DELETE", "/scim/v2/Users/:userId", "scim.users.delete"],
  ["POST", "/scim/v2/Groups", "scim.groups.create"],
  ["PATCH", "/scim/v2/Groups/:groupId", "scim.groups.patch"],
  ["PUT", "/scim/v2/Groups/:groupId", "scim.groups.replace"],
  ["DELETE", "/scim/v2/Groups/:groupId", "scim.groups.delete"],
]);

/*
 * The closed table: one row per method and path, every §3.2 cell, no invented
 * endpoints. Read it as the endpoint inventory the surface audit checks.
 */
export const NATIVE_AUTH_ENDPOINTS: readonly NativeAuthEndpoint[] =
  Object.freeze([
    /* ---------- Admin: identity writes (I) ---------- */
    {
      method: "POST",
      path: "/admin/create-user",
      disposition: "I",
      nativeOperation: "admin.create-user",
      ownerTask: "P12",
      identityOperation: "identity.user.create",
      api: "createUser",
    },
    {
      method: "POST",
      path: "/admin/update-user",
      disposition: "I",
      nativeOperation: "admin.update-user",
      ownerTask: "P12",
      identityOperation: "identity.profile.update",
      api: "adminUpdateUser",
    },
    {
      method: "POST",
      path: "/admin/set-user-password",
      disposition: "I",
      nativeOperation: "admin.set-user-password",
      ownerTask: "P12",
      identityOperation: "identity.password.reset",
      api: "setUserPassword",
    },
    {
      method: "POST",
      path: "/admin/set-role",
      disposition: "I",
      nativeOperation: "admin.set-role",
      ownerTask: "P12",
      identityOperation: "identity.role.set",
      api: "setRole",
    },
    {
      method: "POST",
      path: "/admin/ban-user",
      disposition: "I",
      nativeOperation: "admin.ban-user",
      ownerTask: "P12",
      identityOperation: "identity.disable",
      api: "banUser",
    },
    {
      method: "POST",
      path: "/admin/unban-user",
      disposition: "I",
      nativeOperation: "admin.unban-user",
      ownerTask: "P12",
      identityOperation: "identity.restore",
      api: "unbanUser",
    },
    {
      method: "POST",
      path: "/admin/revoke-user-session",
      disposition: "I",
      nativeOperation: "admin.revoke-user-session",
      ownerTask: "P12",
      identityOperation: "identity.session.revoke",
      api: "revokeUserSession",
    },
    {
      method: "POST",
      path: "/admin/revoke-user-sessions",
      disposition: "I",
      nativeOperation: "admin.revoke-user-sessions",
      ownerTask: "P12",
      identityOperation: "identity.sessions.revoke",
      api: "revokeUserSessions",
    },
    /* ---------- Admin: platform reads (P) ---------- */
    {
      method: "GET",
      path: "/admin/get-user",
      disposition: "P",
      nativeOperation: "admin.get-user",
      ownerTask: "P12",
      api: "getUser",
    },
    {
      method: "GET",
      path: "/admin/list-users",
      disposition: "P",
      nativeOperation: "admin.list-users",
      ownerTask: "P12",
      api: "listUsers",
    },
    {
      method: "POST",
      path: "/admin/list-user-sessions",
      disposition: "P",
      nativeOperation: "admin.list-user-sessions",
      ownerTask: "P12",
      api: "listUserSessions",
      note: "read-only and target-verifying: the gate is the authorization, the pinned build is the reader",
    },
    {
      method: "POST",
      path: "/admin/has-permission",
      disposition: "P",
      nativeOperation: "admin.has-permission",
      ownerTask: "P12",
      api: "userHasPermission",
      note: "answers about the caller only; another user's privacy is never returned",
    },
    /* ---------- Admin: always refused (X) ---------- */
    {
      method: "POST",
      path: "/admin/remove-user",
      disposition: "X",
      nativeOperation: "admin.remove-user",
      ownerTask: "P04",
    },
    {
      method: "POST",
      path: "/admin/impersonate-user",
      disposition: "X",
      nativeOperation: "admin.impersonate-user",
      ownerTask: "P04",
      note: "impersonation is not enabled in the first phase; the Admin permission table carries no impersonate",
    },
    {
      method: "POST",
      path: "/admin/stop-impersonating",
      disposition: "X",
      nativeOperation: "admin.stop-impersonating",
      ownerTask: "P04",
    },
    /* ---------- Organization: always refused (X) ---------- */
    {
      method: "POST",
      path: "/organization/create",
      disposition: "X",
      nativeOperation: "organization.create",
      ownerTask: "P04",
      note: "allowUserToCreateOrganization:false; opening a company is the private platform command (P06)",
    },
    {
      method: "POST",
      path: "/organization/delete",
      disposition: "X",
      nativeOperation: "organization.delete",
      ownerTask: "P04",
      note: "disableOrganizationDeletion:true; deletion is a reviewed request, never a physical delete",
    },
    {
      method: "POST",
      path: "/organization/remove-team",
      disposition: "X",
      nativeOperation: "organization.remove-team",
      ownerTask: "P04",
      note: "team.archive.request owns the controlled archive; a team's assets are never deleted",
    },
    /* ---------- Organization: directory writes (D) ---------- */
    {
      method: "POST",
      path: "/organization/update",
      disposition: "D",
      nativeOperation: "organization.update",
      ownerTask: "P08",
      directoryOperation: "company.profile.update",
      api: "updateOrganization",
    },
    {
      method: "POST",
      path: "/organization/invite-member",
      disposition: "D",
      nativeOperation: "organization.invite-member",
      ownerTask: "P08",
      directoryOperation: "invitation.create",
      api: "createInvitation",
    },
    {
      method: "POST",
      path: "/organization/accept-invitation",
      disposition: "D",
      nativeOperation: "organization.accept-invitation",
      ownerTask: "P08",
      directoryOperation: "invitation.accept",
      api: "acceptInvitation",
      note: "the invitee's verified email is the only requirement; member/proof are not prerequisites",
    },
    {
      method: "POST",
      path: "/organization/reject-invitation",
      disposition: "D",
      nativeOperation: "organization.reject-invitation",
      ownerTask: "P08",
      directoryOperation: "invitation.reject",
      api: "rejectInvitation",
    },
    {
      method: "POST",
      path: "/organization/cancel-invitation",
      disposition: "D",
      nativeOperation: "organization.cancel-invitation",
      ownerTask: "P08",
      directoryOperation: "invitation.cancel",
      api: "cancelInvitation",
    },
    {
      method: "POST",
      path: "/organization/remove-member",
      disposition: "D",
      nativeOperation: "organization.remove-member",
      ownerTask: "P08",
      directoryOperation: "member.remove",
      api: "removeMember",
    },
    {
      method: "POST",
      path: "/organization/update-member-role",
      disposition: "D",
      nativeOperation: "organization.update-member-role",
      ownerTask: "P08",
      directoryOperation: "member.role.set",
      api: "updateMemberRole",
      note: "role=owner becomes owner.transfer, with the last-owner protection of the command",
    },
    {
      method: "POST",
      path: "/organization/leave",
      disposition: "D",
      nativeOperation: "organization.leave",
      ownerTask: "P08",
      directoryOperation: "member.leave",
      api: "leaveOrganization",
    },
    {
      method: "POST",
      path: "/organization/create-team",
      disposition: "D",
      nativeOperation: "organization.create-team",
      ownerTask: "P08",
      directoryOperation: "team.create",
      api: "createTeam",
    },
    {
      method: "POST",
      path: "/organization/update-team",
      disposition: "D",
      nativeOperation: "organization.update-team",
      ownerTask: "P08",
      directoryOperation: "team.profile.update",
      api: "updateTeam",
    },
    {
      method: "POST",
      path: "/organization/add-team-member",
      disposition: "D",
      nativeOperation: "organization.add-team-member",
      ownerTask: "P09",
      directoryOperation: "team.member.add",
      api: "addTeamMember",
    },
    {
      method: "POST",
      path: "/organization/remove-team-member",
      disposition: "D",
      nativeOperation: "organization.remove-team-member",
      ownerTask: "P09",
      directoryOperation: "team.member.remove",
      api: "removeTeamMember",
    },
    /* ---------- Organization: read gates (R) ---------- */
    {
      method: "GET",
      path: "/organization/get-organization",
      disposition: "R",
      nativeOperation: "organization.get-organization",
      ownerTask: "P04",
      api: "getOrganization",
    },
    {
      method: "GET",
      path: "/organization/get-full-organization",
      disposition: "R",
      nativeOperation: "organization.get-full-organization",
      ownerTask: "P04",
      api: "getFullOrganization",
    },
    {
      method: "GET",
      path: "/organization/list-members",
      disposition: "R",
      nativeOperation: "organization.list-members",
      ownerTask: "P04",
      api: "listMembers",
    },
    {
      method: "GET",
      path: "/organization/list-invitations",
      disposition: "R",
      nativeOperation: "organization.list-invitations",
      ownerTask: "P04",
      api: "listInvitations",
    },
    {
      method: "GET",
      path: "/organization/list-teams",
      disposition: "R",
      nativeOperation: "organization.list-teams",
      ownerTask: "P04",
      api: "listTeams",
    },
    {
      method: "GET",
      path: "/organization/list-team-members",
      disposition: "R",
      nativeOperation: "organization.list-team-members",
      ownerTask: "P04",
      api: "listTeamMembers",
      note: "team ownership is verified in the same transaction, so another company's team is answered like a missing one",
    },
    {
      method: "GET",
      path: "/organization/get-active-member",
      disposition: "R",
      nativeOperation: "organization.get-active-member",
      ownerTask: "P04",
      api: "getActiveMember",
      note: "the active organization is a preference/selector only; the gate's live facts authorize",
    },
    {
      method: "GET",
      path: "/organization/get-active-member-role",
      disposition: "R",
      nativeOperation: "organization.get-active-member-role",
      ownerTask: "P04",
      api: "getActiveMemberRole",
    },
    {
      method: "POST",
      path: "/organization/has-permission",
      disposition: "R",
      nativeOperation: "organization.has-permission",
      ownerTask: "P04",
      api: "hasPermission",
      note: "read-only query: the gate is the authorization, no change command is fabricated",
    },
    /* ---------- Organization: closed discovery / dynamic roles (X) ---------- */
    ...X_ORGANIZATION_ENDPOINTS.map(([method, path, nativeOperation]) => ({
      method,
      path,
      disposition: "X" as const,
      nativeOperation,
      ownerTask: "P04" as const,
    })),
    /* ---------- Organization: self preferences (S) and platform checks ---------- */
    {
      method: "POST",
      path: "/organization/set-active",
      disposition: "S",
      nativeOperation: "organization.set-active",
      ownerTask: "P05",
      api: "setActiveOrganization",
    },
    {
      method: "POST",
      path: "/organization/set-active-team",
      disposition: "S",
      nativeOperation: "organization.set-active-team",
      ownerTask: "P05",
      api: "setActiveTeam",
    },
    {
      method: "POST",
      path: "/organization/check-slug",
      disposition: "X",
      nativeOperation: "organization.check-slug",
      ownerTask: "P06",
      note: "platform opening only; ordinary users are refused so the endpoint cannot enumerate slugs",
    },
    /* ---------- SSO: native login/callback contract (kept) ---------- */
    {
      method: "POST",
      path: "/sign-in/sso",
      disposition: "native",
      nativeOperation: "sign-in.sso",
      ownerTask: "P12",
      note: "sign-in keeps the fixed build's contract; company proof crosses the §5 evidence bridge",
    },
    {
      method: "GET",
      path: "/sso/callback",
      disposition: "native",
      nativeOperation: "sso.callback",
      ownerTask: "P12",
    },
    {
      method: "GET",
      path: "/sso/callback/:providerId",
      disposition: "native",
      nativeOperation: "sso.callback",
      ownerTask: "P12",
      note: "createAuth pins organizationProvisioning:{disabled:true} (asserted at factory start), so a callback carrying an organizationId never provisions a member",
    },
    {
      method: "GET",
      path: "/sso/saml2/sp/acs/:providerId",
      disposition: "native",
      nativeOperation: "sso.saml.acs",
      ownerTask: "P12",
      note: "the fixed package serves GET and POST on the ACS endpoint; both keep the native callback contract",
    },
    {
      method: "POST",
      path: "/sso/saml2/sp/acs/:providerId",
      disposition: "native",
      nativeOperation: "sso.saml.acs",
      ownerTask: "P12",
    },
    {
      method: "GET",
      path: "/sso/saml2/sp/slo/:providerId",
      disposition: "native",
      nativeOperation: "sso.saml.slo",
      ownerTask: "P12",
      note: "the fixed package serves GET and POST on the SLO endpoint; both keep the native callback contract",
    },
    {
      method: "POST",
      path: "/sso/saml2/sp/slo/:providerId",
      disposition: "native",
      nativeOperation: "sso.saml.slo",
      ownerTask: "P12",
    },
    {
      method: "POST",
      path: "/sso/saml2/sp/acs",
      disposition: "closed",
      nativeOperation: "sso.saml.acs.bare",
      ownerTask: "P12",
      closedCode: CLOSED_SSO_WRITE_NOT_TRANSCRIBED,
      note: "the provider-less ACS post the fixed package registers beside the :providerId route; no provider context means no server-issued binding, so it is closed rather than forwarded",
    },
    {
      method: "POST",
      path: "/sso/saml2/sp/slo",
      disposition: "closed",
      nativeOperation: "sso.saml.slo.bare",
      ownerTask: "P12",
      closedCode: CLOSED_SSO_WRITE_NOT_TRANSCRIBED,
      note: "the provider-less SLO post the fixed package registers beside the :providerId route; closed for the same reason",
    },
    {
      method: "POST",
      path: "/sso/saml2/logout/:providerId",
      disposition: "native",
      nativeOperation: "sso.saml.logout",
      ownerTask: "P12",
    },
    {
      method: "GET",
      path: "/sso/saml2/sp/metadata",
      disposition: "native",
      nativeOperation: "sso.saml.metadata",
      ownerTask: "P12",
    },
    /* ---------- SSO: controlled configuration writes (closed until T05 transcribes) ---------- */
    ...SSO_CONFIG_WRITE_ENDPOINTS.map(
      ([method, path, nativeOperation, api]) => ({
        method,
        path,
        disposition: "closed" as const,
        nativeOperation,
        ownerTask: "P12" as const,
        api,
        closedCode: CLOSED_SSO_WRITE_NOT_TRANSCRIBED,
        note: "controlled configuration write: the fixed-build handler would open its own transaction (F-01), so the endpoint is closed until T05's SSO ticket translates it through auth.api inside the command transaction — the provider↔company binding stays the server's fixed binding either way",
      }),
    ),
    /* ---------- SSO: provider reads (gate, minimal fields) ---------- */
    {
      method: "GET",
      path: "/sso/get-provider",
      disposition: "P",
      nativeOperation: "sso.get-provider",
      ownerTask: "P12",
      api: "getSSOProvider",
    },
    {
      method: "GET",
      path: "/sso/providers",
      disposition: "P",
      nativeOperation: "sso.providers",
      ownerTask: "P12",
      api: "listSSOProviders",
    },
    /* ---------- SCIM: protocol discovery stays native (§3.2 只读保留) ---------- */
    ...SCIM_DISCOVERY_ENDPOINTS.map(([method, path, nativeOperation]) => ({
      method,
      path,
      disposition: "native" as const,
      nativeOperation,
      ownerTask: "P12" as const,
      note: "protocol discovery metadata, read-only by §3.2's cell",
    })),
    /* ---------- SCIM: resource reads closed until the binding-scoped gate exists ---------- */
    ...SCIM_RESOURCE_READ_ENDPOINTS.map(([method, path, nativeOperation]) => ({
      method,
      path,
      disposition: "closed" as const,
      nativeOperation,
      ownerTask: "P12" as const,
      closedCode: CLOSED_SCIM_READ_UNBOUND,
      note: "§3.2 wants a bound-company read gate; that gate does not exist yet, and an ungated native read would answer the whole directory, so the row is closed until T05 lands the binding-scoped check",
    })),
    /* ---------- SCIM: provisioning writes closed until T05 transcribes ---------- */
    ...SCIM_WRITE_ENDPOINTS.map(([method, path, nativeOperation]) => ({
      method,
      path,
      disposition: "closed" as const,
      nativeOperation,
      ownerTask: "P12" as const,
      closedCode: CLOSED_SCIM_WRITE_NOT_TRANSCRIBED,
      note: "provisioning write: the fixed-build handler would write outside the directory command transaction (F-01); T05's SCIM ticket translates it through the executor with a scim actor and the fixed binding",
    })),
  ]);

/** Prefixes whose contents are classified here and nowhere else. */
const DIRECTORY_SURFACE_PREFIXES = Object.freeze([
  "/admin/",
  "/organization/",
  "/sso/",
  "/scim/",
]);

/** The one sign-in path that belongs to the SSO table (not the whole surface). */
const SSO_SIGN_IN_PATH = "/sign-in/sso";

export type NativeAuthClassification =
  | Readonly<{ kind: "outside" }>
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "recovery" }>
  | Readonly<{ kind: "classified"; endpoint: NativeAuthEndpoint }>;

function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function matchesPath(pattern: string, path: string): boolean {
  const wanted = pathSegments(pattern);
  const actual = pathSegments(path);
  if (wanted.length !== actual.length) return false;
  for (let index = 0; index < wanted.length; index += 1) {
    const segment = wanted[index];
    if (segment.startsWith(":")) continue;
    if (segment !== actual[index]) return false;
  }
  return true;
}

/** Pathname relative to /api/auth, without a trailing slash. */
export function nativeAuthPath(pathname: string): string {
  const relative = pathname.startsWith("/api/auth")
    ? pathname.slice("/api/auth".length)
    : pathname;
  return relative.length > 1 && relative.endsWith("/")
    ? relative.slice(0, -1)
    : relative;
}

/**
 * The closed classifier. A path under a directory prefix that no row names is
 * `unknown` (refused); every other path is `outside` and keeps whatever the
 * pinned build does with it (sign-in, sessions, desktop, …).
 */
export function classifyNativeAuthPath(
  method: string,
  pathname: string,
): NativeAuthClassification {
  const path = nativeAuthPath(pathname);
  const normalized = String(method ?? "").toUpperCase();
  for (const endpoint of NATIVE_AUTH_ENDPOINTS) {
    if (endpoint.method !== normalized) continue;
    if (matchesPath(endpoint.path, path)) {
      return { kind: "classified", endpoint };
    }
  }
  if (
    path === SSO_SIGN_IN_PATH ||
    DIRECTORY_SURFACE_PREFIXES.some((prefix) => path.startsWith(prefix))
  ) {
    return { kind: "unknown" };
  }
  /*
   * The password recovery surface (T04.05 / P08): three endpoints the
   * RecoveryIngress owns exclusively. They carry no directory disposition —
   * they are not directory endpoints — so they never enter the frozen
   * table; classifying them here is what closes the bare-handler bypass:
   * handle() answers them (through the wired seam, or with the honest 503
   * below) instead of letting the pinned build's own handler serve them.
   */
  if (
    (normalized === "POST" && path === "/request-password-reset") ||
    (normalized === "POST" && path === "/reset-password") ||
    (normalized === "GET" && path.startsWith("/reset-password/"))
  ) {
    return { kind: "recovery" };
  }
  return { kind: "outside" };
}

/*
 * Stable refusal codes (interfaces §4 projection). Every one is a named answer,
 * never an empty refusal: the client adapter maps them, and the verification
 * suite asserts them.
 */
export const NATIVE_AUTH_UNKNOWN_ENDPOINT = "NATIVE_AUTH_UNKNOWN_ENDPOINT";
export const NATIVE_AUTH_ENDPOINT_CLOSED = "NATIVE_AUTH_ENDPOINT_CLOSED";
export const NATIVE_AUTH_SESSION_REQUIRED = "NATIVE_AUTH_SESSION_REQUIRED";
export const NATIVE_AUTH_ADMIN_REQUIRED = "NATIVE_AUTH_ADMIN_REQUIRED";
export const NATIVE_AUTH_TENANT_REQUIRED = "NATIVE_AUTH_TENANT_REQUIRED";
export const NATIVE_AUTH_STORAGE_REQUIRED = "NATIVE_AUTH_STORAGE_REQUIRED";
export const NATIVE_AUTH_TRANSLATION_INCOMPLETE =
  "NATIVE_AUTH_TRANSLATION_INCOMPLETE";
export const NATIVE_AUTH_SELF_PREFERENCE_NOT_WIRED =
  "NATIVE_AUTH_SELF_PREFERENCE_NOT_WIRED";
export const DIRECTORY_INGRESS_EXECUTOR_UNWIRED =
  "DIRECTORY_INGRESS_EXECUTOR_UNWIRED";
export const IDENTITY_INGRESS_EXECUTOR_UNWIRED =
  "IDENTITY_INGRESS_EXECUTOR_UNWIRED";

export class NativeAuthRefusal extends Error {
  readonly status: 400 | 401 | 403 | 404 | 500 | 501 | 503;

  constructor(
    readonly code: string,
    detail: string,
    status: 400 | 401 | 403 | 404 | 500 | 501 | 503,
  ) {
    super(`${code}: ${detail}`);
    this.name = "NativeAuthRefusal";
    this.status = status;
  }
}

export function isNativeAuthRefusal(
  error: unknown,
): error is NativeAuthRefusal {
  return error instanceof NativeAuthRefusal;
}

/** What the ingress needs from the deployment's session store. */
export interface NativeAuthSessionView {
  readonly session?: {
    readonly id?: string;
    readonly activeOrganizationId?: string | null;
    readonly activeTeamId?: string | null;
  };
  readonly user?: { readonly id?: string };
}

/** The slice of the fixed build the ingress talks to (never auth.api writes). */
export interface NativeAuthPort {
  handler(request: Request): Response | Promise<Response>;
  api: {
    getSession(input: {
      headers: Headers;
      query?: { disableCookieCache: boolean };
    }): Promise<NativeAuthSessionView | null>;
  };
}

export interface DirectoryIngressDeps {
  /**
   * The deployment database. Reads open one transaction per gate; the ingress
   * never holds a connection across the forwarded native read.
   */
  readonly database?: Pick<Database, "transaction"> | null;
  readonly auth: NativeAuthPort;
  /** The R-class gate (read-gate.ts). */
  readonly readGate: DirectoryReadGate;
  /** The P-class gate. */
  readonly platformReadGate: PlatformReadGate;
  /**
   * The production directory executor, when the assembly built it. Absent is an
   * honest 503: a directory write never happens without its transaction owner,
   * and nothing is written before that refusal.
   */
  readonly directory?: Directory | null;
  /** The production identity executor, same rule. */
  readonly identity?: Pick<IdentityExecutor, "execute"> | null;
  /**
   * The private RecoveryIngress (T04.05 / P08): the password recovery
   * endpoints are its alone. Absent is an honest 503 — the pinned build's
   * own handler never serves them, so a reset never happens without its
   * transaction owner.
   */
  readonly passwordRecovery?: {
    handle(request: Request): Promise<Response | null>;
  } | null;
  readonly now?: () => Date;
}

export interface DirectoryIngress {
  /** The closed table, exposed for the surface audit and the tests. */
  readonly endpoints: readonly NativeAuthEndpoint[];
  classify(method: string, pathname: string): NativeAuthClassification;
  /**
   * Answers the request, or `null` meaning "not a directory endpoint — let the
   * pinned build's handler serve it unchanged".
   */
  handle(request: Request): Promise<Response | null>;
}

const FALLBACK_ORIGIN = "http://native-auth-ingress.invalid";

function errorResponse(error: unknown): Response {
  if (isNativeAuthRefusal(error)) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  if (isDirectoryReadRefusal(error)) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  if (isAuthorityRefusal(error)) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  if (isDirectoryCommandRefusal(error)) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  if (isDirectoryMembershipRefusal(error)) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  if (isIdentityCommandRefusal(error)) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  if (isCompanyAssuranceRefusal(error)) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return Response.json(
    { error: message, code: "NATIVE_AUTH_INGRESS_FAILED" },
    { status: 500 },
  );
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim() !== "",
  );
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  try {
    // Clone first: a request the ingress decides to forward must still carry
    // its body to the pinned build.
    const parsed = (await request.clone().json()) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function sessionIdOf(view: NativeAuthSessionView | null): string | null {
  const id = view?.session?.id;
  return typeof id === "string" && id ? id : null;
}

function actorOf(view: NativeAuthSessionView | null): DirectoryActor | null {
  const userId = view?.user?.id;
  const sessionId = sessionIdOf(view);
  if (typeof userId !== "string" || !userId || !sessionId) return null;
  return Object.freeze({
    userId,
    principalId: null,
    sessionId,
    kind: "session" as const,
    bindingId: null,
    provisioning: null,
  });
}

/**
 * The ingress factory. The read gates are required — an ingress without a gate
 * would forward every native directory read — and the executors are optional
 * only because the assembly that builds them arrives with the tasks that
 * register the operations (P08/P09/P12); their absence is a 503 before any body
 * is executed.
 */
export function createDirectoryIngress(
  deps: DirectoryIngressDeps,
): DirectoryIngress {
  if (!deps?.auth || typeof deps.auth.handler !== "function") {
    throw new Error(
      `${NATIVE_AUTH_UNKNOWN_ENDPOINT}: createDirectoryIngress needs the deployment's auth port; without it nothing can be forwarded and no session can be verified`,
    );
  }
  if (!deps.readGate || typeof deps.readGate.require !== "function") {
    throw new Error(
      `${NATIVE_AUTH_UNKNOWN_ENDPOINT}: createDirectoryIngress needs the directory read gate; forwarding a native directory read without it is the bypass interfaces §3.2 forbids`,
    );
  }
  if (
    !deps.platformReadGate ||
    typeof deps.platformReadGate.require !== "function"
  ) {
    throw new Error(
      `${NATIVE_AUTH_UNKNOWN_ENDPOINT}: createDirectoryIngress needs the platform read gate; Admin reads are gated too`,
    );
  }
  const database = deps.database ?? null;
  const auth = deps.auth;

  async function sessionFor(
    request: Request,
  ): Promise<NativeAuthSessionView | null> {
    return auth.api.getSession({
      headers: request.headers,
      // Fresh: a role changed a moment ago has to apply to this request.
      query: { disableCookieCache: true },
    });
  }

  async function isCurrentAdmin(userId: string): Promise<boolean> {
    if (!database) return false;
    return database.transaction(async (tx) => {
      const [row] = rowsOf(
        await tx.execute(
          sql`SELECT 1 AS ok FROM user_roles
               WHERE user_id = ${userId} AND role = 'admin' LIMIT 1`,
        ),
      );
      return Boolean(row);
    });
  }

  async function tenantFrom(
    endpoint: NativeAuthEndpoint,
    request: Request,
    body: Record<string, unknown>,
    view: NativeAuthSessionView | null,
  ): Promise<string> {
    const fromQuery = text(
      new URL(request.url, FALLBACK_ORIGIN).searchParams.get("organizationId"),
    );
    const fromBody = text(body.organizationId);
    const fromSession = text(view?.session?.activeOrganizationId);
    const explicit = fromQuery ?? fromBody ?? fromSession;
    if (explicit) return explicit;
    /*
     * The invitee's own commands (T04.02) name no company: an invitee is not
     * a member yet, so they have no active-organization preference, and the
     * pinned native body carries only the invitation id. The invitation's own
     * organization is the company — read server-side, never taken from the
     * client — and the handler still re-proves the record's company, address,
     * state and recipient inside the locked transaction. An explicit
     * organizationId, when a caller does send one, still wins and is still
     * cross-checked, so a spoofed tenant is refused rather than trusted.
     */
    if (
      endpoint.directoryOperation === "invitation.accept" ||
      endpoint.directoryOperation === "invitation.reject"
    ) {
      const invitationId = text(body.invitationId);
      if (invitationId) {
        return invitationCompany(invitationId);
      }
    }
    throw new NativeAuthRefusal(
      NATIVE_AUTH_TENANT_REQUIRED,
      `${endpoint.nativeOperation} names no company: an explicit organizationId or an active-organization preference is required, and the selection is an intent the gate re-verifies`,
      400,
    );
  }

  /**
   * The company an invitation belongs to, read from the record itself. This is
   * the only tenant source the invitee's commands have; a missing record is
   * answered not-found here rather than surfacing a tenant-shaped 400, and it
   * leaks nothing (the id is the caller's own input).
   */
  async function invitationCompany(invitationId: string): Promise<string> {
    if (!database) {
      throw new NativeAuthRefusal(
        NATIVE_AUTH_STORAGE_REQUIRED,
        "the invitation's company cannot be read without the deployment database",
        503,
      );
    }
    const organizationId = await database.transaction(async (tx) => {
      const [row] = rowsOf(
        await tx.execute(
          sql`SELECT organization_id FROM auth_invitations
               WHERE id = ${invitationId} LIMIT 1`,
        ),
      );
      return text(row?.organization_id);
    });
    if (!organizationId) {
      throw new NativeAuthRefusal(
        MEMBERSHIP_INVITATION_NOT_FOUND,
        `invitation ${invitationId} does not exist; the answer is not-found rather than inventing a company for it`,
        404,
      );
    }
    return organizationId;
  }

  async function workspaceForTeam(
    tenantId: string,
    teamId: string,
  ): Promise<string> {
    if (!database) {
      throw new NativeAuthRefusal(
        NATIVE_AUTH_STORAGE_REQUIRED,
        "the team → workspace binding cannot be read without the deployment database",
        503,
      );
    }
    return database.transaction(async (tx) => {
      const [row] = rowsOf(
        await tx.execute(
          sql`SELECT workspace_id FROM auth_team_bindings
               WHERE tenant_id = ${tenantId} AND team_id = ${teamId} LIMIT 1`,
        ),
      );
      const workspaceId = text(row?.workspace_id);
      if (!workspaceId) {
        throw new NativeAuthRefusal(
          NATIVE_AUTH_TRANSLATION_INCOMPLETE,
          `team ${teamId} has no workspace binding in company ${tenantId}; a team operation without its stable workspace id is refused rather than guessed`,
          400,
        );
      }
      return workspaceId;
    });
  }

  /** Directory command construction from the frozen payload vocabulary (§2). */
  async function buildDirectoryCommand(
    endpoint: NativeAuthEndpoint,
    tenantId: string,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<DirectoryCommand> {
    let operation = endpoint.directoryOperation;
    if (!operation) {
      throw new Error(
        `${NATIVE_AUTH_TRANSLATION_INCOMPLETE}: ${endpoint.nativeOperation} has no directory operation in the frozen classification`,
      );
    }
    if (operation === "member.role.set" && text(body.role) === "owner") {
      operation = "owner.transfer";
    }
    const reason = text(body.reason);
    const memberSelector =
      text(body.userId) ?? text(body.memberId) ?? text(body.memberIdOrEmail);
    if (memberSelector?.includes("@")) {
      throw new NativeAuthRefusal(
        NATIVE_AUTH_MEMBER_ID_MUST_BE_USER_ID,
        `${endpoint.nativeOperation} names its target by email; the directory command targets a userId, and resolving an address to an identity is the handler's verified job (P08), never an ingress guess`,
        400,
      );
    }
    const userId = memberSelector;
    let payload: Record<string, unknown>;
    switch (operation) {
      case "company.profile.update": {
        payload = {
          ...(text(body.name) ? { name: text(body.name) } : {}),
          ...(text(body.slug) ? { slug: text(body.slug) } : {}),
          ...(text(body.logo) ? { logo: text(body.logo) } : {}),
        };
        if (Object.keys(payload).length === 0) {
          throw new NativeAuthRefusal(
            NATIVE_AUTH_TRANSLATION_INCOMPLETE,
            "organization/update names none of name/slug/logo; the command payload has no empty profile update",
            400,
          );
        }
        break;
      }
      case "invitation.create": {
        // The §3.1 direct-write ruling: renewal is the controlled
        // invitation.resend command's job, so the pinned build's native
        // resend branch (an in-place expiresAt write outside the executor
        // transaction) is unreachable here by construction.
        if (body.resend === true) {
          throw new NativeAuthRefusal(
            INVITATION_RESEND_IS_CONTROLLED,
            "invite-member does not renew an existing invitation; the resend branch would write expiresAt outside the command transaction (interfaces §3.1), so use the controlled invitation.resend command instead",
            400,
          );
        }
        const role = text(body.role) ?? "member";
        if (!INVITATION_DELEGABLE_ROLES.includes(role)) {
          throw new NativeAuthRefusal(
            INVITATION_ROLE_NOT_DELEGABLE,
            `an invitation cannot delegate the role "${role}"; only admin, member and auditor are delegable, and owner/finance/platform authority is never granted by an invitation`,
            403,
          );
        }
        const teamId = text(body.teamId);
        const explicit = stringList(body.workspaceIds);
        payload = {
          email: text(body.email) ?? "",
          role,
          workspaceIds:
            explicit.length > 0
              ? explicit
              : teamId
                ? [await workspaceForTeam(tenantId, teamId)]
                : [],
        };
        break;
      }
      case "invitation.accept":
      case "invitation.reject":
      case "invitation.cancel": {
        payload = { invitationId: text(body.invitationId) ?? "" };
        break;
      }
      case "member.remove":
      case "member.suspend":
      case "member.restore": {
        if (!userId || !reason) {
          throw new NativeAuthRefusal(
            NATIVE_AUTH_TRANSLATION_INCOMPLETE,
            `${endpoint.nativeOperation} needs an explicit userId and reason: the command records who was changed and why, and the ingress never fabricates an audit reason`,
            400,
          );
        }
        payload = { userId, reason };
        break;
      }
      case "member.role.set":
      case "owner.transfer": {
        // The native endpoint's single shape maps to two frozen operations:
        // setting owner is the atomic transfer (the original owner steps down
        // in the same command), which is the §2 semantics the last-owner
        // protection lives behind.
        payload =
          operation === "owner.transfer"
            ? { nextOwnerUserId: userId ?? "" }
            : { userId: userId ?? "", role: text(body.role) ?? "" };
        break;
      }
      case "member.leave": {
        payload = {};
        break;
      }
      case "team.create": {
        payload = { name: text(body.name) ?? "" };
        break;
      }
      case "team.profile.update": {
        const teamId = text(body.teamId);
        if (!teamId) {
          throw new NativeAuthRefusal(
            NATIVE_AUTH_TRANSLATION_INCOMPLETE,
            "organization/update-team needs the native teamId so the stable workspace id can be resolved",
            400,
          );
        }
        const data = body.data as Record<string, unknown> | undefined;
        payload = {
          workspaceId: await workspaceForTeam(tenantId, teamId),
          name: text(body.name) ?? text(data?.name) ?? "",
        };
        break;
      }
      case "team.member.add":
      case "team.member.remove": {
        const teamId = text(body.teamId);
        const workspaceId = text(body.workspaceId);
        if (!workspaceId && !teamId) {
          throw new NativeAuthRefusal(
            NATIVE_AUTH_TRANSLATION_INCOMPLETE,
            `${endpoint.nativeOperation} needs a teamId or workspaceId`,
            400,
          );
        }
        payload = {
          workspaceId:
            workspaceId ?? (await workspaceForTeam(tenantId, teamId as string)),
          userId: userId ?? "",
        };
        break;
      }
      default: {
        throw new NativeAuthRefusal(
          NATIVE_AUTH_TRANSLATION_INCOMPLETE,
          `${endpoint.nativeOperation} has no native HTTP translation for ${operation}; the operation is reached through the server API only`,
          400,
        );
      }
    }
    const command: DirectoryCommand = Object.freeze({
      operation,
      tenantId,
      idempotencyKey,
      payload: Object.freeze(payload),
    });
    assertDirectoryCommand(command);
    return command;
  }

  /** Identity command construction, same discipline. */
  function buildIdentityCommand(
    endpoint: NativeAuthEndpoint,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): IdentityCommand {
    const operation = endpoint.identityOperation;
    if (!operation) {
      throw new Error(
        `${NATIVE_AUTH_TRANSLATION_INCOMPLETE}: ${endpoint.nativeOperation} has no identity operation in the frozen classification`,
      );
    }
    const targetUserId =
      operation === "identity.user.create"
        ? randomUUID()
        : (text(body.userId) ?? "");
    const reason = text(body.reason);
    let payload: Record<string, unknown>;
    switch (operation) {
      case "identity.user.create": {
        payload = {
          email: text(body.email) ?? text(body.userEmail) ?? "",
          name: text(body.name) ?? "",
          ...(text(body.image) ? { image: text(body.image) } : {}),
        };
        break;
      }
      case "identity.profile.update": {
        payload = {
          ...(text(body.name) ? { name: text(body.name) } : {}),
          ...(text(body.image) ? { image: text(body.image) } : {}),
        };
        break;
      }
      case "identity.password.reset": {
        if (!reason) {
          throw new NativeAuthRefusal(
            NATIVE_AUTH_TRANSLATION_INCOMPLETE,
            "admin/set-user-password needs an explicit reason: the identity command records why the credential was rewritten",
            400,
          );
        }
        payload = { reason };
        break;
      }
      case "identity.role.set": {
        payload = { role: text(body.role) ?? "", reason: reason ?? "" };
        break;
      }
      case "identity.session.revoke": {
        payload = {
          sessionId: text(body.sessionId) ?? "",
          reason: reason ?? "",
        };
        break;
      }
      default: {
        payload = { reason: reason ?? "" };
        break;
      }
    }
    const newPassword = text(body.newPassword) ?? text(body.password);
    const command: IdentityCommand = Object.freeze({
      operation,
      targetUserId,
      idempotencyKey,
      payload: Object.freeze(payload),
      ...(newPassword ? { secrets: { newPassword } } : {}),
    });
    assertIdentityCommand(command);
    return command;
  }

  /**
   * The idempotency key is the receipt's uniqueness domain, so it is the
   * caller's to name: a key invented here would make every retry a second
   * command, and a key derived from the body would collapse two legitimate
   * identical commands into one replay. The header is required and named.
   */
  function idempotencyKeyOf(request: Request): string {
    const key =
      text(request.headers.get("idempotency-key")) ??
      text(request.headers.get("x-idempotency-key"));
    if (!key) {
      throw new NativeAuthRefusal(
        NATIVE_AUTH_IDEMPOTENCY_KEY_REQUIRED,
        "a translated directory or identity write must carry an idempotency-key header: the receipt's uniqueness domain is the command's identity for retries, and the ingress never invents or derives it",
        400,
      );
    }
    return key;
  }

  async function directoryRead(
    endpoint: NativeAuthEndpoint,
    request: Request,
  ): Promise<Response | null> {
    const view = await sessionFor(request);
    const actor = actorOf(view);
    if (!actor) {
      throw new NativeAuthRefusal(
        NATIVE_AUTH_SESSION_REQUIRED,
        `${endpoint.nativeOperation} requires a signed-in session`,
        401,
      );
    }
    if (!database) {
      throw new NativeAuthRefusal(
        NATIVE_AUTH_STORAGE_REQUIRED,
        "the read gate needs the deployment database; a read that cannot be authorized is refused, never forwarded",
        503,
      );
    }
    const body = await readJson(request);
    const tenantId = await tenantFrom(endpoint, request, body, view);
    const url = new URL(request.url, FALLBACK_ORIGIN);
    const teamId =
      endpoint.nativeOperation === "organization.list-team-members"
        ? (text(url.searchParams.get("teamId")) ??
          text(body.teamId) ??
          text(url.searchParams.get("team")))
        : undefined;
    await database.transaction(async (tx) => {
      await deps.readGate.require(
        tx,
        actor,
        tenantId,
        endpoint.nativeOperation,
      );
      if (teamId !== undefined) {
        await assertTeamBelongsToCompany(tx, tenantId, teamId);
      }
    });
    return null;
  }

  async function platformRead(
    endpoint: NativeAuthEndpoint,
    request: Request,
  ): Promise<Response | null> {
    const view = await sessionFor(request);
    const actor = actorOf(view);
    if (!actor) {
      throw new NativeAuthRefusal(
        NATIVE_AUTH_SESSION_REQUIRED,
        `${endpoint.nativeOperation} requires a signed-in session`,
        401,
      );
    }
    if (!database) {
      throw new NativeAuthRefusal(
        NATIVE_AUTH_STORAGE_REQUIRED,
        "the platform read gate needs the deployment database; a read that cannot be authorized is refused",
        503,
      );
    }
    await database.transaction(async (tx) => {
      await deps.platformReadGate.require(tx, actor, endpoint.nativeOperation);
    });
    return null;
  }

  async function directoryWrite(
    endpoint: NativeAuthEndpoint,
    request: Request,
  ): Promise<Response> {
    const view = await sessionFor(request);
    const actor = actorOf(view);
    if (!actor) {
      throw new NativeAuthRefusal(
        NATIVE_AUTH_SESSION_REQUIRED,
        `${endpoint.nativeOperation} requires a signed-in session`,
        401,
      );
    }
    if (!deps.directory) {
      throw new NativeAuthRefusal(
        DIRECTORY_INGRESS_EXECUTOR_UNWIRED,
        `${endpoint.nativeOperation} is classified as a directory write (${String(endpoint.directoryOperation)}) but this deployment has no directory executor assembled; refusing before anything is written — the owning task (${endpoint.ownerTask}) registers the operation and the assembly`,
        503,
      );
    }
    const body = await readJson(request);
    const tenantId = await tenantFrom(endpoint, request, body, view);
    const command = await buildDirectoryCommand(
      endpoint,
      tenantId,
      body,
      idempotencyKeyOf(request),
    );
    assertDirectoryActor(actor);
    const result = await deps.directory.execute(actor, command);
    return Response.json(result, { status: 200 });
  }

  async function identityWrite(
    endpoint: NativeAuthEndpoint,
    request: Request,
  ): Promise<Response> {
    const view = await sessionFor(request);
    const actor = actorOf(view);
    if (!actor) {
      throw new NativeAuthRefusal(
        NATIVE_AUTH_SESSION_REQUIRED,
        `${endpoint.nativeOperation} requires a signed-in session`,
        401,
      );
    }
    // The platform actor is issued only after the server verifies the current
    // session AND the current global role; the executor re-checks in-lock.
    if (!(await isCurrentAdmin(actor.userId as string))) {
      throw new NativeAuthRefusal(
        NATIVE_AUTH_ADMIN_REQUIRED,
        `${endpoint.nativeOperation} requires a current global administrator; the check is the server's, never a client flag`,
        403,
      );
    }
    if (!deps.identity) {
      throw new NativeAuthRefusal(
        IDENTITY_INGRESS_EXECUTOR_UNWIRED,
        `${endpoint.nativeOperation} is classified as an identity write (${String(endpoint.identityOperation)}) but this deployment has no identity executor assembled; refusing before anything is written`,
        503,
      );
    }
    /*
     * The platform actor is the person's operator identity, not their
     * session: the frozen assertIdentityActor pins sessionId to session
     * actors, so the ingress strips the id the session actor carried.
     */
    const platform = Object.freeze({
      userId: actor.userId,
      principalId: null,
      sessionId: null,
      kind: "platform" as const,
      bindingId: null,
      provisioning: null,
    }) as IdentityActor;
    assertIdentityActor(platform);
    const body = await readJson(request);
    const command = buildIdentityCommand(
      endpoint,
      body,
      idempotencyKeyOf(request),
    );
    const result = await deps.identity.execute(platform, command);
    return Response.json(result, { status: 200 });
  }

  async function answer(
    endpoint: NativeAuthEndpoint,
    request: Request,
  ): Promise<Response | null> {
    switch (endpoint.disposition) {
      case "X":
        throw new NativeAuthRefusal(
          NATIVE_AUTH_ENDPOINT_CLOSED,
          `${endpoint.nativeOperation} is closed in this deployment (${endpoint.ownerTask}); the action exists only behind its controlled surface, and the native endpoint never serves it`,
          403,
        );
      case "S":
        throw new NativeAuthRefusal(
          NATIVE_AUTH_SELF_PREFERENCE_NOT_WIRED,
          `${endpoint.nativeOperation} updates only the caller's own preference after verifying the target company/team; that writer arrives with ${endpoint.ownerTask}, so the endpoint refuses instead of writing an unverified preference`,
          503,
        );
      case "native":
        return null;
      case "closed":
        throw new NativeAuthRefusal(
          endpoint.closedCode ?? NATIVE_AUTH_ENDPOINT_CLOSED,
          `${endpoint.nativeOperation} is closed in this deployment: its interfaces §3.2 disposition is a translated ${endpoint.disposition === "closed" && endpoint.path.startsWith("/scim/") && endpoint.method === "GET" ? "read" : "write"} that the transcription (${endpoint.ownerTask}/T05) has not landed, and the pinned build's own handler would ${endpoint.method === "GET" ? "answer the whole directory" : "write outside the directory command transaction (F-01)"}; the endpoint refuses rather than forwarding`,
          501,
        );
      case "P":
        return platformRead(endpoint, request);
      case "R":
        return directoryRead(endpoint, request);
      case "D":
        return directoryWrite(endpoint, request);
      case "I":
        return identityWrite(endpoint, request);
      default:
        throw new NativeAuthRefusal(
          NATIVE_AUTH_UNKNOWN_ENDPOINT,
          `${endpoint.nativeOperation} carries no disposition the ingress knows; refusing rather than guessing`,
          503,
        );
    }
  }

  return Object.freeze({
    endpoints: NATIVE_AUTH_ENDPOINTS,
    classify: classifyNativeAuthPath,
    async handle(request: Request): Promise<Response | null> {
      const url = new URL(request.url, FALLBACK_ORIGIN);
      const verdict = classifyNativeAuthPath(request.method, url.pathname);
      if (verdict.kind === "outside") return null;
      if (verdict.kind === "unknown") {
        return errorResponse(
          new NativeAuthRefusal(
            NATIVE_AUTH_UNKNOWN_ENDPOINT,
            `${request.method} ${url.pathname} is not a classified native directory endpoint; unknown method/path is refused, never forwarded to the fixed build's handler`,
            404,
          ),
        );
      }
      if (verdict.kind === "recovery") {
        const seam = deps.passwordRecovery ?? null;
        if (!seam) {
          return errorResponse(
            new NativeAuthRefusal(
              PASSWORD_RECOVERY_NOT_WIRED,
              `${request.method} ${url.pathname} is a password recovery endpoint: the RecoveryIngress owns it exclusively, and without it wired there is no transaction owner for a reset token or a password write — the request is refused rather than forwarded to the fixed build's own handler`,
              503,
            ),
          );
        }
        return seam.handle(request);
      }
      try {
        return await answer(verdict.endpoint, request);
      } catch (error) {
        return errorResponse(error);
      }
    },
  });
}
