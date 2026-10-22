import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
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
import { useDateTime } from "@/lib/i18n/datetime";
import {
  AuditScopeForbiddenError,
  companyAuditEventsQueryOptions,
  exportCompanyAuditEvents,
} from "@/lib/enterprise/tenant/company-admin";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

export const Route = createFileRoute("/_authed/tenant/admin/audit")({
  component: AuditPage,
});

/*
 * The audit page (MT096 / Issue #139, AC1): this company's business-domain audit trail, queried
 * under the MT078 domain matrix (an auditor or an administrator of THIS company), and exported
 * through the same gate — the export is a fetch (a bare link cannot carry the selection pair),
 * the rows arrive masked the same way the list shows them, and the server records the export
 * itself in the trail; the notice below says exactly that.
 */
function AuditPage() {
  const { t } = useTranslation("company-admin");
  const { formatDateTime } = useDateTime();
  const queryClient = useQueryClient();
  const scope = useScopedCache();

  const [appliedFilter, setAppliedFilter] = useState<string | undefined>(
    undefined,
  );
  const [draftFilter, setDraftFilter] = useState("");
  const [exported, setExported] = useState(false);

  const events = useQuery(
    companyAuditEventsQueryOptions(queryClient, scope, appliedFilter),
  );

  const exportCsv = async () => {
    const csv = await exportCompanyAuditEvents(queryClient, scope);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "company-audit.csv";
    anchor.click();
    URL.revokeObjectURL(url);
    setExported(true);
  };

  return (
    <SectionPage title={t("audit.title")} description={t("audit.description")}>
      {events.isPending ? (
        <TableSkeleton />
      ) : events.error instanceof AuditScopeForbiddenError ? (
        <SectionRefused message={t("audit.refused")} />
      ) : events.error !== null ? (
        <SectionFailed
          message={t("audit.failed")}
          onRetry={() => void events.refetch()}
        />
      ) : (
        <>
          <form
            className="mt-3 flex flex-wrap items-center gap-2"
            onSubmit={(formEvent) => {
              formEvent.preventDefault();
              setAppliedFilter(draftFilter.trim() || undefined);
              setExported(false);
            }}
          >
            <Input
              aria-label={t("audit.filter.label")}
              className="max-w-xs"
              onChange={(changeEvent) =>
                setDraftFilter(changeEvent.target.value)
              }
              placeholder={t("audit.filter.placeholder")}
              value={draftFilter}
            />
            <Button size="sm" type="submit" variant="outline">
              {t("audit.filter.apply")}
            </Button>
            <Button
              onClick={() => void exportCsv()}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("audit.export")}
            </Button>
          </form>
          {exported ? (
            <p className="text-muted-foreground mt-2 text-xs">
              {t("audit.exportDone")}
            </p>
          ) : null}
          {events.data.events.length === 0 ? (
            <p className="text-muted-foreground mt-3 rounded-lg border border-dashed bg-card/50 px-4 py-10 text-center text-sm">
              {t("audit.empty")}
            </p>
          ) : (
            <SectionTable
              head={[
                t("audit.column.at"),
                t("audit.column.event"),
                t("audit.column.actor"),
                t("audit.column.target"),
              ]}
              label={t("audit.title")}
            >
              {events.data.events.map((event) => (
                <tr className="border-border border-t" key={event.id}>
                  <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                    {formatDateTime(event.createdAt)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {event.eventType}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {event.actorId}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {event.targetId ?? "—"}
                  </td>
                </tr>
              ))}
            </SectionTable>
          )}
        </>
      )}
    </SectionPage>
  );
}
