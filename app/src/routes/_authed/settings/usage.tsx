import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BillingEmpty } from "@/components/billing/billing-empty";
import { KpiCard } from "@/components/billing/kpi-card";
import { UsageChart } from "@/components/billing/usage-chart";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { money, period, totalTokensOf } from "@/lib/billing/format";
import {
  type BillingUsage,
  usageDailyQueryOptions,
  usageEventsQueryOptions,
  usageQueryOptions,
} from "@/lib/billing/queries";

export const Route = createFileRoute("/_authed/settings/usage")({
  component: RouteComponent,
  /*
   * `?eventsPage=` is which page of the metered-event log the reader is on. In the URL rather
   * than component state, so a reader mid-review can hand someone the exact page they were on.
   * Absent means the first page.
   */
  validateSearch: (search: Record<string, unknown>): { eventsPage: number } => {
    const parsed = Number.parseInt(String(search.eventsPage ?? "1"), 10);
    return Number.isInteger(parsed) && parsed >= 1
      ? { eventsPage: parsed }
      : { eventsPage: 1 };
  },
});

/**
 * What this deployment has used in the current billing period.
 *
 * The page reads top-down the way the question does: how much (three numbers), then the shape of
 * the spending (one bar per day), then the line items that make both up (charges, then the raw
 * event log). Every answer the provider sends is uncached by design — usage moves with every
 * event it accepts, so each query fetches fresh rather than showing a stale number.
 */
function RouteComponent() {
  const { t } = useTranslation("settings");
  const { eventsPage } = Route.useSearch();
  const usage = useQuery(usageQueryOptions);

  return (
    <PageShell
      title={t("usagePage.title")}
      description={t("usagePage.description")}
      width="wide"
    >
      {usage.isPending ? (
        <div className="mt-8 space-y-6">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
          </div>
          <Skeleton className="h-60 w-full rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      ) : usage.error ? (
        <div className="mt-4">
          <p className="text-destructive text-sm">{(usage.error as Error).message}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void usage.refetch()}
          >
            {t("billing.retry")}
          </Button>
        </div>
      ) : !usage.data.active ? (
        <div className="mt-4">
          <BillingEmpty message={t("usagePage.noSubscription")} />
        </div>
      ) : (
        <UsageBody usage={usage.data} eventsPage={eventsPage} />
      )}
    </PageShell>
  );
}

/**
 * The period's numbers, once the page knows there is a subscription to measure.
 *
 * The daily and event queries live here rather than in the route component, because that is what
 * keeps "no subscription" meaning "no requests": they only mount when this component does.
 */
function UsageBody({ usage, eventsPage }: { usage: BillingUsage; eventsPage: number }) {
  const { t } = useTranslation("settings");
  const daily = useQuery(usageDailyQueryOptions);
  const events = useQuery(usageEventsQueryOptions(eventsPage));
  const formatCount = new Intl.NumberFormat();

  return (
    <>
      <div className="mt-8 grid grid-cols-1 gap-3 md:grid-cols-3">
        <KpiCard
          label={t("usagePage.kpiTotal")}
          value={
            usage.totalAmountCents === undefined
              ? "–"
              : money(usage.totalAmountCents, usage.currency)
          }
        />
        <KpiCard
          label={t("usagePage.kpiTokens")}
          value={formatCount.format(totalTokensOf(usage.charges))}
        />
        <KpiCard
          label={t("usagePage.kpiEvents")}
          value={
            events.data
              ? formatCount.format(events.data.pagination.totalCount)
              : "–"
          }
        />
      </div>

      <PageSection
        title={t("usagePage.trendTitle")}
        description={period(usage.fromDatetime, usage.toDatetime)}
      >
        {daily.isPending ? (
          <Skeleton className="mt-4 h-60 w-full rounded-xl" />
        ) : daily.error ? (
          <div className="mt-4">
            <p className="text-destructive text-sm">{(daily.error as Error).message}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void daily.refetch()}
            >
              {t("billing.retry")}
            </Button>
          </div>
        ) : (
          <UsageChart daily={daily.data} />
        )}
      </PageSection>

      <PageSection title={t("usagePage.currentPeriod")}>
        {usage.charges.length === 0 ? (
          <PageEmpty>{t("usagePage.noCharges")}</PageEmpty>
        ) : (
          <table className="mt-4 w-full text-left text-sm">
            <thead className="text-muted-foreground text-xs uppercase">
              <tr>
                <th className="px-4 py-2 font-medium">{t("usagePage.columnMetric")}</th>
                <th className="px-4 py-2 text-right font-medium">
                  {t("usagePage.eventTokens")}
                </th>
                <th className="px-4 py-2 text-right font-medium">
                  {t("usagePage.columnAmount")}
                </th>
              </tr>
            </thead>
            <tbody>
              {usage.charges.map((charge) => (
                <tr key={charge.metricCode} className="border-border border-t">
                  <td className="px-4 py-2">
                    <p>{charge.metricName}</p>
                    <p className="text-muted-foreground font-mono text-xs">
                      {charge.metricCode}
                    </p>
                  </td>
                  {/* `units` is the provider's own string decimal, shown as sent. */}
                  <td className="px-4 py-2 text-right tabular-nums">{charge.units}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {money(charge.amountCents, usage.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </PageSection>

      <PageSection
        title={t("usagePage.eventLog")}
        description={t("usagePage.eventLogDescription")}
      >
        {events.isPending ? (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : events.error ? (
          <div className="mt-4">
            <p className="text-destructive text-sm">{(events.error as Error).message}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void events.refetch()}
            >
              {t("billing.retry")}
            </Button>
          </div>
        ) : events.data.events.length === 0 ? (
          <PageEmpty>{t("usagePage.noEvents")}</PageEmpty>
        ) : (
          <>
            <table className="mt-4 w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 font-medium">{t("usagePage.columnTime")}</th>
                  <th className="px-4 py-2 font-medium">{t("usagePage.columnMetric")}</th>
                  <th className="px-4 py-2 text-right font-medium">
                    {t("usagePage.eventIn")}
                  </th>
                  <th className="px-4 py-2 text-right font-medium">
                    {t("usagePage.eventOut")}
                  </th>
                  <th className="px-4 py-2 text-right font-medium">
                    {t("usagePage.eventTokens")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.data.events.map((event) => (
                  <tr
                    key={`${event.timestamp}-${event.metricCode}`}
                    className="border-border border-t"
                  >
                    <td className="px-4 py-2 tabular-nums">{formatEventTime(event.timestamp)}</td>
                    <td className="text-muted-foreground px-4 py-2 font-mono text-xs">
                      {event.metricCode}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {event.inputTokens ?? "–"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {event.outputTokens ?? "–"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{event.tokens ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <EventsPager
              totalPages={events.data.pagination.totalPages}
              totalCount={events.data.pagination.totalCount}
              nextPage={events.data.pagination.nextPage}
            />
          </>
        )}
      </PageSection>
    </>
  );
}

/** The event row's timestamp: the reader's own short date and time. */
function formatEventTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

/** The event log's pager: page facts on the left, previous/next on the right. */
function EventsPager({
  totalPages,
  totalCount,
  nextPage,
}: {
  totalPages: number;
  totalCount: number;
  nextPage: number | null;
}) {
  const { t } = useTranslation("settings");
  const { eventsPage } = Route.useSearch();
  const navigate = Route.useNavigate();
  const go = (page: number) => {
    void navigate({ search: { eventsPage: page } });
  };
  return (
    <div className="flex items-center justify-between pt-2">
      <span className="text-muted-foreground text-xs tabular-nums">
        {t("usagePage.eventPagerStatus", {
          page: Math.min(eventsPage, totalPages || eventsPage),
          totalPages,
          total: totalCount,
        })}
      </span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={eventsPage <= 1}
          onClick={() => go(eventsPage - 1)}
        >
          {t("usagePage.eventPagerPrev")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={nextPage === null}
          onClick={() => nextPage !== null && go(nextPage)}
        >
          {t("usagePage.eventPagerNext")}
        </Button>
      </div>
    </div>
  );
}
