import { useTranslation } from "react-i18next";
import { money } from "@/lib/billing/format";
import { useDateTime } from "@/lib/i18n/datetime";
import { cn } from "@/lib/utils";
import type { BillingQuotaEntry } from "@/lib/billing/plan-usage";

/**
 * One resource's allowance: how much, out of how much, and when it comes back.
 *
 * WHY A `div` AND NOT A NEW UI PRIMITIVE. The design system has no progress bar, and it does not
 * need one for this: usage is seven rows on one screen, and a `<Progress>` in `components/ui`
 * would be a base component invented for a single caller. The project already draws its tables
 * from native `<table>` rather than a `<Table>`, so this is that same decision — ARIA is written
 * out by hand, once, and the tokens are the design system's own.
 *
 * THE ONE THING THIS GETS RIGHT THAT A GENERIC BAR DOES NOT: `limit: null` is drawn as prose, not
 * as a bar. A deployment that measures a metric without capping it has no denominator, and a bar
 * drawn against an invented one is a lie with a fill colour.
 */

/** From here the bar changes colour: at 90% the reader is nearly out, and should be able to see it. */
const NEARLY_OUT = 0.9;

export function QuotaBar({
  quota,
  currency,
  resetsAt,
}: {
  quota: BillingQuotaEntry;
  currency?: string;
  resetsAt: string | null;
}) {
  const { t } = useTranslation("settings");
  const { formatNumber, formatDate } = useDateTime();

  const ratio =
    quota.limit === null || quota.limit <= 0 ? null : quota.used / quota.limit;
  const capped = ratio === null ? 0 : Math.min(Math.max(ratio, 0), 1);
  const nearlyOut = ratio !== null && ratio >= NEARLY_OUT;
  const percent = ratio === null ? null : Math.round(capped * 100);

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate text-sm font-medium">{quota.metricName}</p>
        {percent === null ? (
          <p className="text-muted-foreground shrink-0 text-xs">
            {t("usagePage.unlimited")}
          </p>
        ) : (
          <p
            className={cn(
              "shrink-0 text-xs tabular-nums",
              nearlyOut ? "font-medium text-destructive" : "text-muted-foreground",
            )}
          >
            {t("usagePage.usedPercent", { percent })}
          </p>
        )}
      </div>

      {percent === null ? (
        <p className="text-muted-foreground mt-1 text-xs">
          {t("usagePage.meteredOnly")}
        </p>
      ) : (
        <div
          className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={quota.metricName}
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-300 ease-out",
              nearlyOut ? "bg-destructive" : "bg-primary",
            )}
            style={{ width: `${capped * 100}%` }}
          />
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm tabular-nums">
          {quota.remaining === null
            ? formatNumber(quota.used)
            : t("usagePage.usedOfTotal", {
                used: formatNumber(quota.used),
                total: formatNumber(quota.limit ?? 0),
                unit: quota.unit,
              })}
        </p>
        {quota.remaining === null ? null : (
          <p className="text-muted-foreground text-xs tabular-nums">
            {t("usagePage.remaining", {
              remaining: formatNumber(quota.remaining),
              unit: quota.unit,
            })}
          </p>
        )}
      </div>

      <div className="text-muted-foreground mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
        {quota.usedCents > 0 ? (
          <p className="tabular-nums">{money(quota.usedCents, currency)}</p>
        ) : (
          <span />
        )}
        {resetsAt ? (
          <p className="tabular-nums">
            {t("usagePage.resetsAt", { date: formatDate(resetsAt) })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
