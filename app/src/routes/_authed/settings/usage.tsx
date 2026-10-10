import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  type BillingUsageCharge,
  usageQueryOptions,
} from "@/lib/billing/queries";

export const Route = createFileRoute("/_authed/settings/usage")({
  component: RouteComponent,
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

/**
 * What this deployment has used in the current billing period.
 *
 * The amounts come from the provider's own usage answer, uncached by design: usage moves with
 * every event it accepts, so this page always fetches fresh rather than showing a stale number.
 */
function RouteComponent() {
  const { t } = useTranslation("settings");
  const usage = useQuery(usageQueryOptions);

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
      )}
    </PageShell>
  );
}
