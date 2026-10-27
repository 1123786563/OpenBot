import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SectionFailed,
  SectionPage,
  SectionRefused,
  SectionTable,
} from "@/components/company-admin/company-admin-area";
import { TableSkeleton } from "@/components/layout/page-skeletons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CompanyAdminRefusedError,
  companyCredentialsQueryOptions,
  companyDemoteMutationOptions,
  companyIdentityQueryOptions,
  companyOffboardMutationOptions,
  companyPeopleQueryOptions,
  companyPromoteMutationOptions,
} from "@/lib/enterprise/tenant/company-admin";
import {
  type DirectoryFailureKind,
  type DirectoryInvitableRole,
  DirectoryPeopleActionError,
  type DirectoryRole,
  directoryMembersQueryOptions,
  directoryPeopleCommandAdapter,
  type PeopleActionFailure,
  teamGrantCommandAdapter,
  teamGrantsQueryOptions,
} from "@/lib/enterprise/tenant/directory";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  findSelection,
  type WorkspaceScopeCompany,
  workspaceScopeListingQueryOptions,
} from "@/lib/enterprise/tenant/selection";
import { useDateTime } from "@/lib/i18n/datetime";

export const Route = createFileRoute("/_authed/tenant/admin/people")({
  component: PeoplePage,
});

/*
 * The people page (MT095 / Issue #138, the Directory half T04.10 / Issue #554): the company roster,
 * the masked credential roster and the company's identity providers.
 *
 * WHICH ROSTER ANSWERS IS THE LISTING'S OWN AUTHORITY FACT (interfaces §4). A row that carries the
 * BA binding (`organizationId`) renders the Directory roster — fixed owner/admin/member/auditor
 * roles, actions the ingress translates, invitations, and the T04.07 team-management grants for a
 * member whose capabilities name `company:manage`. A legacy row keeps the MT095 roster it always
 * had, with its own actions and DTO: this page never issues a /api/auth read there. Who may
 * actually command any of it stays the server's call — capabilities decide what renders, the
 * command's own authorization decides what succeeds — and no control here deletes a company,
 * impersonates a member, or treats a read grant as a management grant.
 */

/** The fixed roles the directory holds; the page renders exactly these, in this order. */
const DIRECTORY_ROLES = ["owner", "admin", "member", "auditor"] as const;
/** The roles an invitation may delegate (an invitation never names an owner). */
const INVITABLE_ROLES = ["admin", "member", "auditor"] as const;
/** The two actions a team-management grant can carry. */
const GRANT_ACTIONS = ["team.member.add", "team.member.remove"] as const;
/** The invitation states this page has words for; any other renders verbatim. */
const INVITATION_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "canceled",
  "expired",
] as const;

/** The named failure a refused people command resolves to; anything else keeps its status kind. */
function failureOf(error: unknown): PeopleActionFailure {
  return error instanceof DirectoryPeopleActionError ? error.failure : "failed";
}

/** The grants' own vocabulary: a 409 that names no grant-specific cause reads as a checkable form. */
function grantFailureOf(error: unknown): DirectoryFailureKind {
  const failure = failureOf(error);
  return failure === "lastOwner" ||
    failure === "seats" ||
    failure === "invitation"
    ? "invalid"
    : failure;
}

/** The recoverable sentence a refused action becomes, with the focus landing on it. */
function ActionFailure({ message }: { message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message !== "") ref.current?.focus();
  }, [message]);
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="mt-4 max-w-prose rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm outline-none"
    >
      {message}
    </div>
  );
}

function PeoplePage() {
  const { t } = useTranslation("company-admin");
  const scope = useScopedCache();
  const open = scope.status === "open" ? scope : null;
  const listing = useQuery({
    ...workspaceScopeListingQueryOptions(open?.userId ?? ""),
    enabled: open !== null,
  });

  // The selected company's own row is the authority fact: its binding names the roster, its
  // capabilities name who commands. A race that drops the pair says choose again, not guess.
  const found =
    open !== null &&
    open.selection !== null &&
    listing.data !== undefined &&
    listing.isSuccess
      ? findSelection(listing.data, open.selection)
      : null;
  const company = found?.company ?? null;
  const directory =
    company !== null && company.organizationId !== undefined ? company : null;
  // The delegation surface belongs to a company manager alone: a scoped team manager's page (a
  // plain member holding a grant, so the §4 row carries no capability bits) and a read-grant
  // holder render none of it and ask for none of its reads.
  const canManageDirectory =
    directory !== null &&
    (directory.capabilities ?? []).includes("company:manage");

  return (
    <>
      {directory !== null ? (
        <DirectoryPeopleSection company={directory} />
      ) : listing.isError || (listing.isSuccess && company === null) ? (
        <SectionPage
          title={t("people.title")}
          description={t("people.description")}
        >
          <SectionFailed
            message={t("people.failed")}
            onRetry={() => void listing.refetch()}
          />
        </SectionPage>
      ) : listing.isSuccess ? (
        <LegacyPeopleSection />
      ) : (
        <SectionPage
          title={t("people.title")}
          description={t("people.description")}
        >
          <TableSkeleton />
        </SectionPage>
      )}
      {directory !== null ? <InvitationsSection company={directory} /> : null}
      {canManageDirectory && open?.selection !== null ? (
        <TeamGrantsSection />
      ) : null}

      <CredentialsSection />
      <IdentitySection />
    </>
  );
}

/*
 * The Directory roster (T04.10): members with their fixed roles, the role form and the removal a
 * company manager commands, and the invite form. Every command addresses the member's userId — the
 * stable id the ingress maps onto the directory command — and a refused command keeps the form
 * exactly as the person left it while the named sentence says what to do next.
 */
function DirectoryPeopleSection({
  company,
}: {
  company: WorkspaceScopeCompany;
}) {
  const { t } = useTranslation("company-admin");
  const { formatDateTime } = useDateTime();
  const queryClient = useQueryClient();
  const scope = useScopedCache();

  const canManage = (company.capabilities ?? []).includes("company:manage");
  const rosterOptions = directoryMembersQueryOptions(scope, company);
  const roster = useQuery(rosterOptions);
  const commands = canManage ? directoryPeopleCommandAdapter(company) : null;

  const [failure, setFailure] = useState<PeopleActionFailure | null>(null);
  const [pendingAction, setPendingAction] = useState(false);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, DirectoryRole>>(
    {},
  );
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] =
    useState<DirectoryInvitableRole>("member");

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setPendingAction(true);
    setFailure(null);
    try {
      await operation();
      // The roster and the invitations answer together; the next read asks again.
      await queryClient.invalidateQueries({ queryKey: rosterOptions.queryKey });
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setPendingAction(false);
    }
  };

  return (
    <SectionPage
      title={t("people.title")}
      description={t("people.directory.description")}
    >
      {roster.isPending ? (
        <TableSkeleton />
      ) : roster.error instanceof DirectoryPeopleActionError &&
        roster.error.failure === "refused" ? (
        <SectionRefused message={t("people.directory.refused")} />
      ) : roster.error !== null ? (
        <SectionFailed
          message={t("people.directory.failed")}
          onRetry={() => void roster.refetch()}
        />
      ) : (
        <>
          <SectionTable
            head={[
              t("people.directory.column.member"),
              t("people.directory.column.role"),
              t("people.directory.column.joined"),
              t("people.directory.column.actions"),
            ]}
            label={t("people.title")}
          >
            {roster.data.members.map((member) => {
              const draft = roleDrafts[member.userId] ?? member.role;
              return (
                <tr className="border-border border-t" key={member.userId}>
                  <td className="px-4 py-2 font-mono text-xs">
                    {member.userId}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {canManage ? (
                      <select
                        aria-label={t("people.directory.roleOf", {
                          id: member.userId,
                        })}
                        className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                        onChange={(event) =>
                          setRoleDrafts((before) => ({
                            ...before,
                            [member.userId]: event.target
                              .value as DirectoryRole,
                          }))
                        }
                        value={draft}
                      >
                        {DIRECTORY_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {t(`people.role.${role}`)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      t(`people.role.${member.role}`)
                    )}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                    {formatDateTime(member.createdAt)}
                  </td>
                  <td className="px-4 py-2">
                    {canManage ? (
                      removing === member.userId ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <Input
                            aria-label={t("people.directory.removeReason")}
                            className="max-w-56"
                            onChange={(event) =>
                              setRemoveReason(event.target.value)
                            }
                            value={removeReason}
                          />
                          <Button
                            disabled={
                              pendingAction || removeReason.trim() === ""
                            }
                            onClick={() =>
                              void run(async () => {
                                await commands?.removeMember(
                                  member.userId,
                                  removeReason.trim(),
                                );
                                setRemoving(null);
                                setRemoveReason("");
                              })
                            }
                            size="sm"
                            variant="outline"
                          >
                            {t("people.directory.removeConfirm")}
                          </Button>
                          <Button
                            disabled={pendingAction}
                            onClick={() => {
                              setRemoving(null);
                              setRemoveReason("");
                            }}
                            size="sm"
                            variant="ghost"
                          >
                            {t("people.directory.cancel")}
                          </Button>
                        </span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          <Button
                            disabled={pendingAction || draft === member.role}
                            onClick={() =>
                              void run(async () => {
                                await commands?.setMemberRole(
                                  member.userId,
                                  draft,
                                );
                                setRoleDrafts((before) => {
                                  const next = { ...before };
                                  delete next[member.userId];
                                  return next;
                                });
                              })
                            }
                            size="sm"
                            variant="outline"
                          >
                            {t("people.directory.setRole")}
                          </Button>
                          <Button
                            disabled={pendingAction}
                            onClick={() => setRemoving(member.userId)}
                            size="sm"
                            variant="outline"
                          >
                            {t("people.directory.remove")}
                          </Button>
                        </span>
                      )
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </SectionTable>
          {canManage ? (
            <div className="mt-6 max-w-sm space-y-2">
              <p className="text-sm font-medium">
                {t("people.directory.inviteTitle")}
              </p>
              <Label htmlFor="people-invite-email">
                {t("people.directory.email")}
              </Label>
              <Input
                id="people-invite-email"
                onChange={(event) => setInviteEmail(event.target.value)}
                value={inviteEmail}
                autoComplete="off"
              />
              <Label htmlFor="people-invite-role">
                {t("people.directory.inviteAs")}
              </Label>
              <select
                aria-label={t("people.directory.inviteAs")}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                id="people-invite-role"
                onChange={(event) =>
                  setInviteRole(event.target.value as DirectoryInvitableRole)
                }
                value={inviteRole}
              >
                {INVITABLE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {t(`people.role.${role}`)}
                  </option>
                ))}
              </select>
              <Button
                className="mt-2"
                disabled={pendingAction || inviteEmail.trim() === ""}
                onClick={() =>
                  void run(async () => {
                    await commands?.inviteMember(
                      inviteEmail.trim(),
                      inviteRole,
                    );
                    // A clean send clears the address; the chosen role stays for the next one.
                    setInviteEmail("");
                  })
                }
                size="sm"
              >
                {t("people.directory.invite")}
              </Button>
            </div>
          ) : null}
        </>
      )}
      {failure !== null ? (
        <ActionFailure message={t(`people.directory.${failure}`)} />
      ) : null}
    </SectionPage>
  );
}

/** The pending invitations of the same Directory answer, with the cancel a manager commands. */
function InvitationsSection({ company }: { company: WorkspaceScopeCompany }) {
  const { t } = useTranslation("company-admin");
  const { formatDateTime } = useDateTime();
  const queryClient = useQueryClient();
  const scope = useScopedCache();

  const canManage = (company.capabilities ?? []).includes("company:manage");
  const rosterOptions = directoryMembersQueryOptions(scope, company);
  const roster = useQuery(rosterOptions);
  const commands = canManage ? directoryPeopleCommandAdapter(company) : null;
  const [failure, setFailure] = useState<PeopleActionFailure | null>(null);
  const [pendingAction, setPendingAction] = useState(false);

  const cancel = async (invitationId: string): Promise<void> => {
    setPendingAction(true);
    setFailure(null);
    try {
      await commands?.cancelInvitation(invitationId);
      await queryClient.invalidateQueries({ queryKey: rosterOptions.queryKey });
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setPendingAction(false);
    }
  };

  const statusText = (status: string): string =>
    (INVITATION_STATUSES as readonly string[]).includes(status)
      ? t(
          `people.directory.invitationStatus.${status as (typeof INVITATION_STATUSES)[number]}`,
        )
      : status;

  return (
    <SectionPage
      title={t("people.directory.invitationsTitle")}
      description={t("people.directory.description")}
    >
      {roster.isPending ? (
        <TableSkeleton />
      ) : (
        <SectionTable
          head={[
            t("people.directory.invitationsColumn.email"),
            t("people.directory.invitationsColumn.role"),
            t("people.directory.invitationsColumn.status"),
            t("people.directory.invitationsColumn.expires"),
            t("people.directory.invitationsColumn.actions"),
          ]}
          label={t("people.directory.invitationsTitle")}
        >
          {roster.data?.invitations.length === 0 ? (
            <tr className="border-border border-t">
              <td className="text-muted-foreground px-4 py-3" colSpan={5}>
                {t("people.directory.noInvitations")}
              </td>
            </tr>
          ) : (
            roster.data?.invitations.map((invitation) => (
              <tr className="border-border border-t" key={invitation.id}>
                <td className="px-4 py-2">{invitation.email}</td>
                <td className="px-4 py-2 whitespace-nowrap">
                  {t(`people.role.${invitation.role}`)}
                </td>
                <td className="px-4 py-2 whitespace-nowrap">
                  {statusText(invitation.status)}
                </td>
                <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                  {formatDateTime(invitation.expiresAt)}
                </td>
                <td className="px-4 py-2">
                  {canManage ? (
                    <Button
                      disabled={pendingAction}
                      onClick={() => void cancel(invitation.id)}
                      size="sm"
                      variant="outline"
                    >
                      {t("people.directory.cancelInvitation")}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))
          )}
        </SectionTable>
      )}
      {failure !== null ? (
        <ActionFailure message={t(`people.directory.${failure}`)} />
      ) : null}
    </SectionPage>
  );
}

/*
 * The T04.07 team-management grants of the selected team (T04.10's consumer): the stable rows with
 * their state echo, the grant and the revoke. This is the delegation surface a company manager
 * owns — a scoped team manager's page renders none of it, and a read grant (finance, audit) is a
 * different thing that never appears here.
 */
function TeamGrantsSection() {
  const { t } = useTranslation("company-admin");
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const open = scope.status === "open" ? scope : null;

  const grantsOptions = teamGrantsQueryOptions(scope);
  const grants = useQuery(grantsOptions);
  const commands = open?.selection
    ? teamGrantCommandAdapter({ ...open, selection: open.selection })
    : null;
  const [failure, setFailure] = useState<DirectoryFailureKind | null>(null);
  const [pendingAction, setPendingAction] = useState(false);
  const [userId, setUserId] = useState("");
  // None chosen: the Grant button waits until the person names at least one action.
  const [actions, setActions] = useState<Record<string, boolean>>({});
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState("");

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setPendingAction(true);
    setFailure(null);
    try {
      await operation();
      await queryClient.invalidateQueries({ queryKey: grantsOptions.queryKey });
    } catch (error) {
      setFailure(grantFailureOf(error));
    } finally {
      setPendingAction(false);
    }
  };

  const chosen = GRANT_ACTIONS.filter((action) => actions[action]);

  return (
    <SectionPage
      title={t("people.grants.title")}
      description={t("people.grants.description")}
    >
      {grants.isPending ? (
        <TableSkeleton />
      ) : grants.error instanceof DirectoryPeopleActionError &&
        grants.error.failure === "refused" ? (
        <SectionRefused message={t("people.grants.refused")} />
      ) : grants.error !== null ? (
        <SectionFailed
          message={t("people.grants.failed")}
          onRetry={() => void grants.refetch()}
        />
      ) : (
        <>
          <SectionTable
            head={[
              t("people.grants.column.user"),
              t("people.grants.column.actions"),
              t("people.grants.column.status"),
              t("people.grants.column.generation"),
              t("people.grants.column.operations"),
            ]}
            label={t("people.grants.title")}
          >
            {grants.data.grants.length === 0 ? (
              <tr className="border-border border-t">
                <td className="text-muted-foreground px-4 py-3" colSpan={5}>
                  {t("people.grants.none")}
                </td>
              </tr>
            ) : (
              grants.data.grants.map((grant) => (
                <tr className="border-border border-t" key={grant.grantId}>
                  <td className="px-4 py-2 font-mono text-xs">
                    {grant.userId}
                  </td>
                  <td className="px-4 py-2">
                    {grant.actions
                      .map((action) =>
                        t(
                          action === "team.member.add"
                            ? "people.grants.actionAdd"
                            : "people.grants.actionRemove",
                        ),
                      )
                      .join(", ")}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {grant.status === "active"
                      ? t("people.grants.statusActive")
                      : t("people.grants.statusRevoked")}
                  </td>
                  <td className="px-4 py-2 tabular-nums">{grant.generation}</td>
                  <td className="px-4 py-2">
                    {revoking === grant.grantId ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <Input
                          aria-label={t("people.grants.revokeReason")}
                          className="max-w-56"
                          onChange={(event) =>
                            setRevokeReason(event.target.value)
                          }
                          value={revokeReason}
                        />
                        <Button
                          disabled={pendingAction || revokeReason.trim() === ""}
                          onClick={() =>
                            void run(async () => {
                              await commands?.revoke(
                                grant.grantId,
                                revokeReason.trim(),
                              );
                              setRevoking(null);
                              setRevokeReason("");
                            })
                          }
                          size="sm"
                          variant="outline"
                        >
                          {t("people.grants.revokeConfirm")}
                        </Button>
                        <Button
                          disabled={pendingAction}
                          onClick={() => {
                            setRevoking(null);
                            setRevokeReason("");
                          }}
                          size="sm"
                          variant="ghost"
                        >
                          {t("people.directory.cancel")}
                        </Button>
                      </span>
                    ) : grant.status === "active" ? (
                      <Button
                        disabled={pendingAction}
                        onClick={() => setRevoking(grant.grantId)}
                        size="sm"
                        variant="outline"
                      >
                        {t("people.grants.revoke")}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </SectionTable>
          <div className="mt-6 max-w-sm space-y-2">
            <Label htmlFor="team-grant-user">{t("people.grants.userId")}</Label>
            <Input
              id="team-grant-user"
              onChange={(event) => setUserId(event.target.value)}
              value={userId}
              autoComplete="off"
            />
            {GRANT_ACTIONS.map((action) => (
              <label className="flex items-center gap-2 text-sm" key={action}>
                <input
                  checked={actions[action] ?? false}
                  onChange={(event) =>
                    setActions((before) => ({
                      ...before,
                      [action]: event.target.checked,
                    }))
                  }
                  type="checkbox"
                />
                {t(
                  action === "team.member.add"
                    ? "people.grants.actionAdd"
                    : "people.grants.actionRemove",
                )}
              </label>
            ))}
            <Button
              className="mt-2"
              disabled={
                pendingAction || userId.trim() === "" || chosen.length === 0
              }
              onClick={() =>
                void run(async () => {
                  await commands?.grant(userId.trim(), chosen);
                  setUserId("");
                })
              }
              size="sm"
            >
              {t("people.grants.grant")}
            </Button>
          </div>
        </>
      )}
      {failure !== null ? (
        <ActionFailure message={t(`people.grants.${failure}`)} />
      ) : null}
    </SectionPage>
  );
}

/** The MT095 roster of a legacy row: unchanged actions, unchanged DTO, no directory read. */
function LegacyPeopleSection() {
  const { t } = useTranslation("company-admin");
  const { formatDateTime } = useDateTime();
  const queryClient = useQueryClient();
  const scope = useScopedCache();

  const people = useQuery(companyPeopleQueryOptions(queryClient, scope));
  const promote = useMutation(
    companyPromoteMutationOptions(queryClient, scope),
  );
  const demote = useMutation(companyDemoteMutationOptions(queryClient, scope));
  const offboard = useMutation(
    companyOffboardMutationOptions(queryClient, scope),
  );

  return (
    <SectionPage
      title={t("people.title")}
      description={t("people.description")}
    >
      {people.isPending ? (
        <TableSkeleton />
      ) : people.error instanceof CompanyAdminRefusedError ? (
        <SectionRefused message={t("people.refused")} />
      ) : people.error !== null ? (
        <SectionFailed
          message={t("people.failed")}
          onRetry={() => void people.refetch()}
        />
      ) : (
        <SectionTable
          head={[
            t("people.column.principal"),
            t("people.column.role"),
            t("people.column.status"),
            t("people.column.joined"),
            t("people.column.actions"),
          ]}
          label={t("people.title")}
        >
          {people.data.members.map((member) => (
            <tr className="border-border border-t" key={member.principalId}>
              <td className="px-4 py-2 font-mono text-xs">
                {member.principalId}
              </td>
              <td className="px-4 py-2 whitespace-nowrap">
                {t(`people.role.${member.role}`)}
              </td>
              <td className="px-4 py-2 whitespace-nowrap">
                {t(`people.status.${member.status}`)}
              </td>
              <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                {formatDateTime(member.joinedAt)}
              </td>
              <td className="px-4 py-2">
                {member.status !== "active" ? null : (
                  <span className="flex flex-wrap gap-1">
                    {member.role !== "tenant_admin" ? (
                      <Button
                        onClick={() => promote.mutate(member.principalId)}
                        size="sm"
                        variant="outline"
                      >
                        {t("people.action.promote")}
                      </Button>
                    ) : (
                      <>
                        <Button
                          onClick={() =>
                            demote.mutate({
                              principalId: member.principalId,
                              to: "member",
                            })
                          }
                          size="sm"
                          variant="outline"
                        >
                          {t("people.action.demoteMember")}
                        </Button>
                        <Button
                          onClick={() =>
                            demote.mutate({
                              principalId: member.principalId,
                              to: "auditor",
                            })
                          }
                          size="sm"
                          variant="outline"
                        >
                          {t("people.action.demoteAuditor")}
                        </Button>
                      </>
                    )}
                    <Button
                      onClick={() => offboard.mutate(member.principalId)}
                      size="sm"
                      variant="outline"
                    >
                      {t("people.action.offboard")}
                    </Button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </SectionTable>
      )}
    </SectionPage>
  );
}

/** The masked credential roster: rendered from the server's redacted shape, nothing re-derived. */
function CredentialsSection() {
  const { t } = useTranslation("company-admin");
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const credentials = useQuery(
    companyCredentialsQueryOptions(queryClient, scope),
  );

  return (
    <SectionPage
      title={t("credentials.title")}
      description={t("credentials.description")}
    >
      {credentials.isPending ? (
        <TableSkeleton />
      ) : credentials.error instanceof CompanyAdminRefusedError ? (
        <SectionRefused message={t("credentials.refused")} />
      ) : credentials.error !== null ? (
        <SectionFailed
          message={t("people.failed")}
          onRetry={() => void credentials.refetch()}
        />
      ) : (
        <SectionTable
          head={[
            t("credentials.column.label"),
            t("credentials.column.classification"),
            t("credentials.column.target"),
            t("credentials.column.actions"),
          ]}
          label={t("credentials.title")}
        >
          {credentials.data.credentials.map((credential) => (
            <tr
              className="border-border border-t"
              key={credential.credentialId}
            >
              <td className="px-4 py-2">{credential.label}</td>
              <td className="px-4 py-2 whitespace-nowrap">
                {t(`credentials.classification.${credential.classification}`)}
              </td>
              <td className="max-w-56 truncate px-4 py-2 font-mono text-xs">
                {credential.target}
              </td>
              <td className="px-4 py-2 whitespace-nowrap">
                {credential.effectiveActions.use ? "use" : "—"} /{" "}
                {credential.effectiveActions.disclose ? "disclose" : "—"}
              </td>
            </tr>
          ))}
        </SectionTable>
      )}
    </SectionPage>
  );
}

/** The company's identity providers: its SSO reference document and SCIM bindings. */
function IdentitySection() {
  const { t } = useTranslation("company-admin");
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const identity = useQuery(companyIdentityQueryOptions(queryClient, scope));

  return (
    <SectionPage
      title={t("identity.title")}
      description={t("identity.description")}
    >
      {identity.isPending ? (
        <TableSkeleton />
      ) : identity.error instanceof CompanyAdminRefusedError ? (
        <SectionRefused message={t("identity.refused")} />
      ) : identity.error !== null ? (
        <SectionFailed
          message={t("people.failed")}
          onRetry={() => void identity.refetch()}
        />
      ) : (
        <>
          <SectionTable
            head={[
              t("identity.sso.protocol"),
              t("identity.sso.issuer"),
              t("identity.sso.domain"),
              t("identity.sso.revision"),
            ]}
            label={t("identity.sso.title")}
          >
            {identity.data.sso === null ? (
              <tr className="border-border border-t">
                <td className="text-muted-foreground px-4 py-3" colSpan={4}>
                  {t("identity.sso.none")}
                </td>
              </tr>
            ) : (
              <tr className="border-border border-t">
                <td className="px-4 py-2 uppercase">
                  {identity.data.sso.protocol}
                </td>
                <td className="max-w-56 truncate px-4 py-2 font-mono text-xs">
                  {identity.data.sso.issuer}
                </td>
                <td className="px-4 py-2 font-mono text-xs">
                  {identity.data.sso.domain}
                </td>
                <td className="px-4 py-2 tabular-nums">
                  {identity.data.sso.revision}
                </td>
              </tr>
            )}
          </SectionTable>
          <SectionTable
            head={[t("identity.scim.connectionKey"), t("identity.scim.status")]}
            label={t("identity.scim.title")}
          >
            {identity.data.scimBindings.length === 0 ? (
              <tr className="border-border border-t">
                <td className="text-muted-foreground px-4 py-3" colSpan={2}>
                  {t("identity.scim.none")}
                </td>
              </tr>
            ) : (
              identity.data.scimBindings.map((binding) => (
                <tr className="border-border border-t" key={binding.bindingId}>
                  <td className="px-4 py-2 font-mono text-xs">
                    {binding.connectionKey}
                  </td>
                  <td className="px-4 py-2">{binding.status}</td>
                </tr>
              ))
            )}
          </SectionTable>
        </>
      )}
    </SectionPage>
  );
}
