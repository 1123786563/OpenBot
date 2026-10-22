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
  companyLearningQueryOptions,
} from "@/lib/enterprise/tenant/company-admin";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

export const Route = createFileRoute("/_authed/tenant/admin/learning")({
  component: LearningPage,
});

/*
 * The learning page (MT096 / Issue #139, AC3): the research and demonstration records of the
 * selected scope. The server answers under the scope pin — another scope's containers and
 * content are structurally invisible (an empty page, not an error), and this page renders exactly
 * what arrived: no other-scope vocabulary exists in it.
 */
function LearningPage() {
  const { t } = useTranslation("company-admin");
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const learning = useQuery(companyLearningQueryOptions(queryClient, scope));

  return (
    <SectionPage
      title={t("learning.title")}
      description={t("learning.description")}
    >
      {learning.isPending ? (
        <TableSkeleton />
      ) : learning.error instanceof CompanyAdminRefusedError ? (
        <SectionRefused message={t("learning.refused")} />
      ) : learning.error !== null ? (
        <SectionFailed
          message={t("learning.failed")}
          onRetry={() => void learning.refetch()}
        />
      ) : learning.data.records.length === 0 ? (
        <p className="text-muted-foreground mt-3 rounded-lg border border-dashed bg-card/50 px-4 py-10 text-center text-sm">
          {t("learning.empty")}
        </p>
      ) : (
        <SectionTable
          head={[
            t("learning.column.title"),
            t("learning.column.kind"),
            t("learning.column.container"),
          ]}
          label={t("learning.title")}
        >
          {learning.data.records.map((record) => (
            <tr className="border-border border-t" key={record.recordId}>
              <td className="px-4 py-2">{record.title}</td>
              <td className="px-4 py-2 whitespace-nowrap">
                {t(`learning.kind.${record.kind}`)}
              </td>
              <td className="px-4 py-2 font-mono text-xs">
                {record.containerId}
              </td>
            </tr>
          ))}
        </SectionTable>
      )}
    </SectionPage>
  );
}
