import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  SectionFailed,
  SectionPage,
  SectionRefused,
  SectionTable,
} from "@/components/company-admin/company-admin-area";
import { TableSkeleton } from "@/components/layout/page-skeletons";
import { Button } from "@/components/ui/button";
import { useDateTime } from "@/lib/i18n/datetime";
import {
  CompanyAdminRefusedError,
  companyCredentialsQueryOptions,
  companyDemoteMutationOptions,
  companyIdentityQueryOptions,
  companyOffboardMutationOptions,
  companyPeopleQueryOptions,
  companyPromoteMutationOptions,
} from "@/lib/enterprise/tenant/company-admin";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

export const Route = createFileRoute("/_authed/tenant/admin/people")({
  component: PeoplePage,
});

/*
 * The people page (MT095 / Issue #138): the company roster, the masked credential roster and the
 * company's identity providers, with the three lifecycle actions. Everything here is the server's
 * scoped answer: the roster is this company's members (another company's selection refuses), the
 * credentials are structurally masked (no secret fields exist in the wire shape), and each action
 * submits under the selection pair — the server records its own audit row (AC3) and the roster
 * invalidation makes the answer visible without a manual refresh.
 */
function PeoplePage() {
  const { t } = useTranslation("company-admin");
  const { formatDateTime } = useDateTime();
  const queryClient = useQueryClient();
  const scope = useScopedCache();

  const people = useQuery(companyPeopleQueryOptions(queryClient, scope));
  const promote = useMutation(companyPromoteMutationOptions(queryClient, scope));
  const demote = useMutation(companyDemoteMutationOptions(queryClient, scope));
  const offboard = useMutation(companyOffboardMutationOptions(queryClient, scope));

  return (
    <>
      <SectionPage title={t("people.title")} description={t("people.description")}>
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

      <CredentialsSection />
      <IdentitySection />
    </>
  );
}

/** The masked credential roster: rendered from the server's redacted shape, nothing re-derived. */
function CredentialsSection() {
  const { t } = useTranslation("company-admin");
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const credentials = useQuery(companyCredentialsQueryOptions(queryClient, scope));

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
            <tr className="border-border border-t" key={credential.credentialId}>
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
