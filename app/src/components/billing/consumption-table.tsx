import { useTranslation } from "react-i18next";
import { BillingPager } from "@/components/billing/pager";
import { Button } from "@/components/ui/button";
import { credits } from "@/lib/billing/format";
import type { CreditConsumptionEntry } from "@/lib/billing/credits";
import { cn } from "@/lib/utils";

/** The three quick windows the consumption table offers, mapping to from/to in the page. */
export type ConsumptionRange = "today" | "7d" | "30d";

const RANGES: readonly ConsumptionRange[] = ["today", "7d", "30d"];

export function ConsumptionTable({
  entries,
  pagination,
  range,
  onRangeChange,
  onExport,
  onPage,
  statusTemplate,
}: {
  entries: readonly CreditConsumptionEntry[];
  pagination: {
    totalCount: number;
    totalPages: number;
    currentPage: number;
    nextPage: number | null;
  };
  range: ConsumptionRange;
  onRangeChange: (range: ConsumptionRange) => void;
  onExport?: () => void;
  onPage: (page: number) => void;
  statusTemplate: string;
}) {
  const { t } = useTranslation("settings");
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 rounded-lg border bg-card p-1">
          {RANGES.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => onRangeChange(key)}
              className={cn(
                "rounded-md px-3 py-1 text-sm transition-colors",
                range === key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`creditsPage.range.${key}`)}
            </button>
          ))}
        </div>
        {onExport ? (
          <Button variant="outline" size="sm" onClick={onExport}>
            {t("creditsPage.export")}
          </Button>
        ) : null}
      </div>

      {/* Five columns, the request one widest; a phone gives up the model and client first. */}
      <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="text-muted-foreground text-xs uppercase">
            <tr className="border-border border-b">
              <th className="px-4 py-2 font-medium">{t("creditsPage.columnTime")}</th>
              <th className="px-4 py-2 font-medium">{t("creditsPage.columnRequest")}</th>
              <th className="px-4 py-2 text-right font-medium">
                {t("creditsPage.columnCredits")}
              </th>
              <th className="hidden px-4 py-2 font-medium sm:table-cell">
                {t("creditsPage.columnModel")}
              </th>
              <th className="hidden px-4 py-2 font-medium md:table-cell">
                {t("creditsPage.columnClient")}
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-border border-t">
                <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                  {formatDateTime(entry.timestamp)}
                </td>
                <td className="max-w-56 px-4 py-2">
                  <p className="truncate">{entry.title}</p>
                  {entry.requestId ? (
                    <p className="text-muted-foreground truncate font-mono text-xs">
                      {entry.requestId}
                    </p>
                  ) : null}
                </td>
                <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                  {credits(entry.credits)}
                  {t("creditsPage.creditUnit")}
                </td>
                <td className="text-muted-foreground hidden px-4 py-2 sm:table-cell">
                  {entry.model ?? "–"}
                </td>
                <td className="text-muted-foreground hidden px-4 py-2 md:table-cell">
                  {entry.client ?? "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <BillingPager
        page={pagination.currentPage}
        totalPages={pagination.totalPages}
        totalCount={pagination.totalCount}
        hasNext={pagination.nextPage !== null}
        onPage={onPage}
        statusTemplate={statusTemplate}
      />
    </div>
  );
}

/** The consumption row's time: date and time, in the reader's locale. */
function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
