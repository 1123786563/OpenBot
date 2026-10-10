import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  type BillingUsageCharge,
  type BillingUsageEvent,
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

/** Whole currency units from cents, in the reader's own locale and the provider's own currency. */
function money(cents: number, currency: string | undefined): string {
  const format = new Intl.NumberFormat(undefined, {
    style: "currency",
    ...(currency ? { currency } : {}),
  });
  return format.format(cents / 100);
}

/** The period as one line: "Oct 1 – Oct 31, 2026", in the reader's locale. */
function period(from: string | undefined, to: string | undefined): string {
  if (from === undefined && to === undefined) return "";
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  const fromPart = from === undefined ? "" : format.format(new Date(from));
  const toPart = to === undefined ? "" : format.format(new Date(to));
  return fromPart && toPart ? `${fromPart} – ${toPart}` : fromPart || toPart;
}

/** One charge row: the metric a person knows, with its code for the support conversation. */
function ChargeRow({
  charge,
  currency,
}: {
  charge: BillingUsageCharge;
  currency: string | undefined;
}) {
  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>{charge.metricName}</ItemTitle>
        <ItemDescription className="font-mono">
          {charge.metricCode}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <span className="text-muted-foreground tabular-nums">
          {charge.units} ×
        </span>
        <span className="tabular-nums">
          {money(charge.amountCents, currency)}
        </span>
      </ItemActions>
    </Item>
  );
}

/** One metered event: when it happened and how many tokens it consumed, in and out. */
function EventRow({ event }: { event: BillingUsageEvent }) {
  const { t } = useTranslation("settings");
  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle className="tabular-nums">
          {new Intl.DateTimeFormat(undefined, {
            dateStyle: "short",
            timeStyle: "short",
          }).format(new Date(event.timestamp))}
        </ItemTitle>
        <ItemDescription className="font-mono">
          {event.metricCode}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <span className="text-muted-foreground text-xs tabular-nums">
          {t("usagePage.eventIn")} {event.inputTokens ?? "–"} ·{" "}
          {t("usagePage.eventOut")} {event.outputTokens ?? "–"}
        </span>
        <span className="tabular-nums">
          {event.tokens ?? "–"} {t("usagePage.eventTokens")}
        </span>
      </ItemActions>
    </Item>
  );
}

/**
 * What this deployment has used in the current billing period.
 *
 * The amounts come from the provider's own usage answer, uncached by design: usage moves with
 * every event it accepts, so this page always fetches fresh rather than showing a stale number.
 */
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

function RouteComponent() {
  const { t } = useTranslation("settings");
  const { eventsPage } = Route.useSearch();
  const usage = useQuery(usageQueryOptions);
  const events = useQuery(usageEventsQueryOptions(eventsPage));

  return (
    <PageShell
      title={t("usagePage.title")}
      description={t("usagePage.description")}
    >
      {usage.isPending ? null : usage.error ? (
        <PageEmpty>{(usage.error as Error).message}</PageEmpty>
      ) : !usage.data.active ? (
        <PageEmpty>{t("usagePage.noSubscription")}</PageEmpty>
      ) : (
        <>
          <PageSection
            title={t("usagePage.currentPeriod")}
            description={period(usage.data.fromDatetime, usage.data.toDatetime)}
            action={
              usage.data.totalAmountCents === undefined ? undefined : (
                <span className="text-sm tabular-nums">
                  {t("usagePage.totalThisPeriod")}{" "}
                  {money(usage.data.totalAmountCents, usage.data.currency)}
                </span>
              )
            }
          >
            {usage.data.charges.length === 0 ? (
              <PageEmpty>{t("usagePage.noCharges")}</PageEmpty>
            ) : (
              <PageRows>
                {usage.data.charges.map((charge) => (
                  <ChargeRow
                    key={charge.metricCode}
                    charge={charge}
                    currency={usage.data.currency}
                  />
                ))}
              </PageRows>
            )}
          </PageSection>
          <PageSection
            title={t("usagePage.eventLog")}
            description={t("usagePage.eventLogDescription")}
          >
            {events.isPending ? null : events.error ? (
              <PageEmpty>{(events.error as Error).message}</PageEmpty>
            ) : events.data.events.length === 0 ? (
              <PageEmpty>{t("usagePage.noEvents")}</PageEmpty>
            ) : (
              <>
                <PageRows>
                  {events.data.events.map((event) => (
                    <EventRow
                      key={`${event.timestamp}-${event.metricCode}`}
                      event={event}
                    />
                  ))}
                </PageRows>
                <EventsPager
                  totalPages={events.data.pagination.totalPages}
                  totalCount={events.data.pagination.totalCount}
                  nextPage={events.data.pagination.nextPage}
                />
              </>
            )}
          </PageSection>
        </>
      )}
    </PageShell>
  );
}
