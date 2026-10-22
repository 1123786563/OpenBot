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
import { useDateTime } from "@/lib/i18n/datetime";
import {
  CompanyFinanceRequiredError,
  companyBooksQueryOptions,
} from "@/lib/enterprise/tenant/company-admin";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

export const Route = createFileRoute("/_authed/tenant/admin/billing")({
  component: BillingPage,
});

/*
 * The company books page (MT097 / Issue #140, AC2/AC3 — and #139 AC4's entry): the finance
 * reader's view of the company — balance, the two usage projections (by team, by member) and the
 * company total they must reconcile with, plus the read-only usage lines that evidence them.
 *
 * THE GATE IS THE GRANT, NOT THE ROLE: an administrator without the explicit finance read grant
 * gets the same typed refusal as a plain member (MT073's single sentinel — the page renders one
 * refusal sentence and never says which gate refused). PERSONAL DIRECT CONSUMPTION IS NOT HERE:
 * the server projects the company's own customer only, so a personal Bifrost charge has no way
 * into either the totals or the lines — this page adds nothing on top of that answer (AC3).
 */
function BillingPage() {
  const { t } = useTranslation("company-admin");
  const { formatDateTime } = useDateTime();
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const books = useQuery(companyBooksQueryOptions(queryClient, scope));

  return (
    <SectionPage title={t("billing.title")} description={t("billing.description")}>
      {books.isPending ? (
        <TableSkeleton />
      ) : books.error instanceof CompanyFinanceRequiredError ? (
        <SectionRefused message={t("billing.refused")} />
      ) : books.error !== null ? (
        <SectionFailed
          message={t("billing.failed")}
          onRetry={() => void books.refetch()}
        />
      ) : (
        <>
          <p className="text-muted-foreground mt-2 text-xs">
            {t("billing.books.authorization", {
              grantor: books.data.books.authorization.grantedBy,
              at: formatDateTime(books.data.books.authorization.grantedAt),
            })}
          </p>
          {books.data.books.customer === null ? (
            <p className="text-muted-foreground mt-3 rounded-lg border border-dashed bg-card/50 px-4 py-10 text-center text-sm">
              {t("billing.books.noMapping")}
            </p>
          ) : (
            <>
              <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border bg-card px-4 py-3">
                  <dt className="text-muted-foreground text-xs">
                    {t("billing.books.balance")}
                  </dt>
                  <dd className="mt-1 font-medium tabular-nums">
                    {books.data.books.balanceUnits}
                  </dd>
                </div>
                <div className="rounded-lg border border-border bg-card px-4 py-3">
                  <dt className="text-muted-foreground text-xs">
                    {t("billing.books.companyTotal")}
                  </dt>
                  <dd className="mt-1 font-medium tabular-nums">
                    {books.data.books.usage.companyTotal.chargedUnits}{" "}
                    {t("billing.books.charged")} ·{" "}
                    {books.data.books.usage.companyTotal.heldUnits}{" "}
                    {t("billing.books.held")}
                  </dd>
                </div>
              </dl>
              <SectionTable
                head={[
                  t("billing.books.column.team"),
                  t("billing.books.column.held"),
                  t("billing.books.column.charged"),
                ]}
                label={t("billing.books.teamUsage")}
              >
                {books.data.books.usage.byTeam.map((row) => (
                  <tr className="border-border border-t" key={row.workspaceId}>
                    <td className="px-4 py-2 font-mono text-xs">
                      {row.workspaceId}
                    </td>
                    <td className="px-4 py-2 tabular-nums">{row.heldUnits}</td>
                    <td className="px-4 py-2 tabular-nums">{row.chargedUnits}</td>
                  </tr>
                ))}
              </SectionTable>
              <SectionTable
                head={[
                  t("billing.books.column.member"),
                  t("billing.books.column.held"),
                  t("billing.books.column.charged"),
                ]}
                label={t("billing.books.userUsage")}
              >
                {books.data.books.usage.byUser.map((row) => (
                  <tr className="border-border border-t" key={row.principalId}>
                    <td className="px-4 py-2 font-mono text-xs">
                      {row.principalId}
                    </td>
                    <td className="px-4 py-2 tabular-nums">{row.heldUnits}</td>
                    <td className="px-4 py-2 tabular-nums">{row.chargedUnits}</td>
                  </tr>
                ))}
              </SectionTable>
            </>
          )}
          <SectionPage
            description={t("billing.usage.description")}
            title={t("billing.usage.title")}
          >
            {books.data.recentUsage.length === 0 ? (
              <p className="text-muted-foreground mt-3 rounded-lg border border-dashed bg-card/50 px-4 py-10 text-center text-sm">
                {t("billing.usage.empty")}
              </p>
            ) : (
              <SectionTable
                head={[
                  t("billing.usage.column.at"),
                  t("billing.usage.column.source"),
                  t("billing.usage.column.model"),
                  t("billing.usage.column.team"),
                  t("billing.usage.column.tokens"),
                ]}
                label={t("billing.usage.title")}
              >
                {books.data.recentUsage.map((line) => (
                  <tr className="border-border border-t" key={line.eventId}>
                    <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                      {formatDateTime(line.occurredAt)}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">{line.source}</td>
                    <td className="max-w-40 truncate px-4 py-2 font-mono text-xs">
                      {line.model}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {line.workspaceId ?? "—"}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                      {line.inputTokens} / {line.outputTokens}
                    </td>
                  </tr>
                ))}
              </SectionTable>
            )}
          </SectionPage>
        </>
      )}
    </SectionPage>
  );
}
