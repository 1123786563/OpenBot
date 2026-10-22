import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  SectionFailed,
  SectionPage,
  SectionRefused,
  SectionTable,
} from "@/components/company-admin/company-admin-area";
import { TableSkeleton } from "@/components/layout/page-skeletons";
import {
  CompanyAdminRefusedError,
  companyConfigQueryOptions,
} from "@/lib/enterprise/tenant/company-admin";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

export const Route = createFileRoute("/_authed/tenant/admin/enterprise")({
  component: EnterprisePage,
});

/*
 * The enterprise settings page (MT096 / Issue #139, AC2): this company's own configuration —
 * the company row, its teams and its member counts. The read consumes the selection, and a
 * selection that names a company the reader does not administer answers the typed refusal:
 * cross-company reading is refused, never displayed (the invisible-not-error discipline).
 */
function EnterprisePage() {
  const { t } = useTranslation("company-admin");
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const config = useQuery(companyConfigQueryOptions(queryClient, scope));

  return (
    <SectionPage
      title={t("enterprise.title")}
      description={t("enterprise.description")}
    >
      {config.isPending ? (
        <TableSkeleton />
      ) : config.error instanceof CompanyAdminRefusedError ? (
        <SectionRefused message={t("enterprise.refused")} />
      ) : config.error !== null ? (
        <SectionFailed
          message={t("enterprise.failed")}
          onRetry={() => void config.refetch()}
        />
      ) : (
        <>
          <SectionTable
            head={[t("enterprise.company.title"), t("enterprise.company.status")]}
            label={t("enterprise.company.title")}
          >
            <tr className="border-border border-t">
              <td className="px-4 py-2">{config.data.name}</td>
              <td className="px-4 py-2">{config.data.status}</td>
            </tr>
          </SectionTable>
          <SectionTable
            head={[t("enterprise.company.teams")]}
            label={t("enterprise.company.teams")}
          >
            {config.data.teams.length === 0 ? null : (
              config.data.teams.map((team) => (
                <tr className="border-border border-t" key={team.workspaceId}>
                  <td className="px-4 py-2">
                    {team.name}
                    <span className="text-muted-foreground ml-2 font-mono text-xs">
                      {team.workspaceId}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </SectionTable>
          <SectionTable
            head={[t("enterprise.members.title"), t("people.column.status")]}
            label={t("enterprise.members.title")}
          >
            {config.data.membersByRole.map((row) => (
              <tr className="border-border border-t" key={row.role}>
                <td className="px-4 py-2">{t(`people.role.${row.role}`)}</td>
                <td className="px-4 py-2 tabular-nums">{row.count}</td>
              </tr>
            ))}
            <tr className="border-border border-t">
              <td className="px-4 py-2">{t("enterprise.members.offboarded")}</td>
              <td className="px-4 py-2 tabular-nums">
                {config.data.offboardedCount}
              </td>
            </tr>
          </SectionTable>
        </>
      )}
    </SectionPage>
  );
}
