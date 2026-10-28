import { useTranslation } from "react-i18next";
import { BillingPager } from "@/components/billing/pager";
import { Button } from "@/components/ui/button";
import type { CreditConsumptionEntry } from "@/lib/billing/credits";
import { credits } from "@/lib/billing/format";
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

      {/*
       * An empty WINDOW is still a window: the switcher above stays up (the field bug — an
       * empty 今天 after local midnight unmounted the switcher with the table, and the only way
       * back to a window with data was editing the URL by hand), the empty sentence replaces
       * the table, and a pager over zero rows is hidden rather than asked to say "共 0 条".
       * The empty sentence is for a window with NOTHING in it (totalCount 0), not for a page
       * walked off the end: a shared ?page=99 link has no rows but the window does, and the
       * pager — which clamps its own display — is that reader's way back.
       */}
      {pagination.totalCount === 0 ? (
        <p className="text-muted-foreground mt-3 rounded-lg border border-dashed bg-card/50 px-4 py-10 text-center text-sm">
          {t("creditsPage.emptyConsumption")}
        </p>
      ) : (
        <>
          {/* Six columns, the request one widest; a phone gives up the bot and model first. */}
          <section
            aria-label={t("creditsPage.consumptionTable")}
            className="mt-3 overflow-x-auto rounded-lg border border-border bg-card focus-visible:outline-2 focus-visible:outline-ring"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: An overflow region needs keyboard focus to scroll in Safari; the region has an accessible name.
            tabIndex={0}
          >
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr className="border-border border-b">
                  <th className="px-4 py-2 font-medium">
                    {t("creditsPage.columnTime")}
                  </th>
                  <th className="px-4 py-2 font-medium">
                    {t("creditsPage.columnRequest")}
                  </th>
                  <th className="px-4 py-2 text-right font-medium">
                    {t("creditsPage.columnCredits")}
                  </th>
                  <th className="hidden px-4 py-2 font-medium sm:table-cell">
                    {t("creditsPage.columnBot")}
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
                      {/*
                       * The unfunded suffix (audit D1): a settlement that cost more than the
                       * balance could fund records the full cost with `applied` clamped to the
                       * hold. Only a shortfall row says so — a fully funded row looks exactly as
                       * it always has.
                       */}
                      {entry.applied < entry.credits ? (
                        <span
                          className="text-muted-foreground ml-1 text-xs"
                          title={t("creditsPage.overdrawHint", {
                            shortfall: credits(entry.credits - entry.applied),
                          })}
                        >
                          {t("creditsPage.overdrawBadge", {
                            shortfall: credits(entry.credits - entry.applied),
                          })}
                        </span>
                      ) : null}
                      {/*
                       * 20.3's fee split: a settlement that carries a surcharge shows its
                       * two parts (model fee / tool-route surcharge) under the total — each
                       * part traceable to the same entry, the parts summing to it. A row
                       * whose settlement wrote no split, or whose surcharge is genuinely
                       * zero, shows nothing: no empty line, no misleading 0 (AC4).
                       */}
                      {entry.feeBreakdown &&
                      entry.feeBreakdown.surchargeCredits > 0 ? (
                        <p className="text-muted-foreground mt-0.5 text-xs whitespace-nowrap">
                          {t("creditsPage.feeSplitModel", {
                            amount: credits(entry.feeBreakdown.modelCredits),
                          })}
                          {" · "}
                          {t("creditsPage.feeSplitSurcharge", {
                            amount: credits(
                              entry.feeBreakdown.surchargeCredits,
                            ),
                          })}
                        </p>
                      ) : null}
                    </td>
                    <td className="text-muted-foreground hidden px-4 py-2 sm:table-cell">
                      {/*
                       * 06.12's Bot attribution: the Bot the call was admitted for, from the
                       * reservation's own record; a row without one (writer-direct, or a row
                       * from before attribution existed) stays honestly blank — never guessed.
                       */}
                      {entry.botName ?? "–"}
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
          </section>

          <BillingPager
            page={pagination.currentPage}
            totalPages={pagination.totalPages}
            totalCount={pagination.totalCount}
            hasNext={pagination.nextPage !== null}
            onPage={onPage}
            statusTemplate={statusTemplate}
          />
        </>
      )}
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
