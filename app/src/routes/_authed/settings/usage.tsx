import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BillingEmpty } from "@/components/billing/billing-empty";
import { BillingPager, clampedPage } from "@/components/billing/pager";
import { QuotaBar } from "@/components/billing/quota-bar";
import { SubscriptionHero } from "@/components/billing/subscription-hero";
import { UsageChart } from "@/components/billing/usage-chart";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { period } from "@/lib/billing/format";
import {
  type BillingPlanUsage,
  planUsageQueryOptions,
} from "@/lib/billing/plan-usage";
import {
  usageDailyQueryOptions,
  usageEventsQueryOptions,
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
 * 套餐用量: what this deployment is on, and how much of it is left.
 *
 * The page reads top-down the way the question does: what plan and when does it roll over (one
 * card), what has been used of each resource (one row per resource, with a bar), how the spending
 * was shaped (one bar per day), then the line items that make both up (the raw event log).
 *
 * Every answer is uncached by design — usage moves with every event the provider accepts, so each
 * query fetches fresh rather than showing a stale number.
 */
function RouteComponent() {
  const { t } = useTranslation("settings");
  const { eventsPage } = Route.useSearch();
  const plan = useQuery(planUsageQueryOptions);

  return (
    <PageShell
      title={t("usagePage.title")}
      description={t("usagePage.description")}
      width="wide"
    >
      {plan.isPending ? (
        <div className="mt-8 space-y-6">
          <Skeleton className="h-28 w-full rounded-xl" />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </div>
          <Skeleton className="h-60 w-full rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      ) : plan.error ? (
        <LoadError
          message={(plan.error as Error).message}
          onRetry={() => void plan.refetch()}
        />
      ) : !plan.data.active ? (
        <div className="mt-4">
          <BillingEmpty message={t("usagePage.noSubscription")} />
        </div>
      ) : (
        <UsageBody plan={plan.data} eventsPage={eventsPage} />
      )}
    </PageShell>
  );
}

/**
 * What a failed read looks like on this page.
 *
 * The server's sentence, then one way back in. Written once because three queries on this screen
 * can each fail, and a reader who has to work out whether the thing that broke is the plan, the
 * trend or the log has been given a puzzle instead of an error.
 */
function LoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="mt-4">
      <p className="text-destructive text-sm" role="alert">
        {message}
      </p>
      <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
        {t("billing.retry")}
      </Button>
    </div>
  );
}

/**
 * The period's numbers, once the page knows there is a plan to measure.
 *
 * The daily and event queries live here rather than in the route component, because that is what
 * keeps "no plan" meaning "no requests": they only mount when this component does.
 */
function UsageBody({
  plan,
  eventsPage,
}: {
  plan: BillingPlanUsage;
  eventsPage: number;
}) {
  const { t } = useTranslation("settings");
  const navigate = Route.useNavigate();
  const daily = useQuery(usageDailyQueryOptions);
  const events = useQuery(usageEventsQueryOptions(eventsPage));

  return (
    <>
      <SubscriptionHero
        planCode={plan.planCode ?? ""}
        status={plan.status ?? "active"}
        currentPeriodStart={plan.currentPeriodStart}
        currentPeriodEnd={plan.currentPeriodEnd}
      />

      <PageSection
        title={t("usagePage.overviewTitle")}
        description={t("usagePage.overviewDescription")}
      >
        {plan.quotas.length === 0 ? (
          <PageEmpty>{t("usagePage.noQuotas")}</PageEmpty>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            {plan.quotas.map((quota) => (
              <QuotaBar
                key={quota.metricCode}
                quota={quota}
                currency={plan.currency}
                resetsAt={plan.resetsAt}
              />
            ))}
          </div>
        )}
      </PageSection>

      <PageSection
        title={t("usagePage.trendTitle")}
        description={period(
          plan.currentPeriodStart ?? undefined,
          plan.currentPeriodEnd ?? undefined,
        )}
      >
        {daily.isPending ? (
          <Skeleton className="mt-4 h-60 w-full rounded-xl" />
        ) : daily.error ? (
          <LoadError
            message={(daily.error as Error).message}
            onRetry={() => void daily.refetch()}
          />
        ) : (
          <UsageChart daily={daily.data} />
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
          <LoadError
            message={(events.error as Error).message}
            onRetry={() => void events.refetch()}
          />
        ) : events.data.events.length === 0 ? (
          <PageEmpty>{t("usagePage.noEvents")}</PageEmpty>
        ) : (
          <>
            {/* Five columns of short values: it scrolls sideways rather than wrapping, and the two
                token columns are the ones a phone gives up first. */}
            <div className="mt-4 overflow-x-auto rounded-lg border border-border bg-card">
              <table className="w-full text-left text-sm">
                <thead className="text-muted-foreground text-xs uppercase">
                  <tr className="border-border border-b">
                    <th className="px-4 py-2 font-medium">
                      {t("usagePage.columnTime")}
                    </th>
                    <th className="px-4 py-2 font-medium">
                      {t("usagePage.columnMetric")}
                    </th>
                    <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">
                      {t("usagePage.eventIn")}
                    </th>
                    <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">
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
                      <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                        {formatEventTime(event.timestamp)}
                      </td>
                      <td className="text-muted-foreground px-4 py-2 font-mono text-xs">
                        {event.metricCode}
                      </td>
                      <td className="hidden px-4 py-2 text-right tabular-nums sm:table-cell">
                        {event.inputTokens ?? "–"}
                      </td>
                      <td className="hidden px-4 py-2 text-right tabular-nums sm:table-cell">
                        {event.outputTokens ?? "–"}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {event.tokens ?? "–"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <BillingPager
              page={eventsPage}
              totalPages={events.data.pagination.totalPages}
              totalCount={events.data.pagination.totalCount}
              hasNext={events.data.pagination.nextPage !== null}
              onPage={(page) => {
                void navigate({ search: { eventsPage: page } });
              }}
              statusLabel={t("usagePage.eventPagerStatus", {
                page: clampedPage(eventsPage, events.data.pagination.totalPages),
                totalPages: Math.max(events.data.pagination.totalPages, 1),
                total: events.data.pagination.totalCount,
              })}
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
