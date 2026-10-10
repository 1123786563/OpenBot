import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type ConsumptionRange,
  ConsumptionTable,
} from "@/components/billing/consumption-table";
import { CreditGrantList } from "@/components/billing/credit-grant-list";
import { PlanCard } from "@/components/billing/plan-card";
import { UpgradeDialog } from "@/components/billing/upgrade-dialog";
import { WelcomeBanner } from "@/components/billing/welcome-banner";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type ConsumptionWindow,
  catalogQueryOptions,
  creditsConsumptionQueryOptions,
  creditsGrantsQueryOptions,
  creditsSummaryQueryOptions,
  type PlanCatalogEntry,
} from "@/lib/billing/credits";
import { BillingUnavailableError } from "@/lib/billing/invoices";
import { entitlementsQueryOptions } from "@/lib/billing/queries";

export const Route = createFileRoute("/_authed/settings/usage")({
  component: RouteComponent,
  /*
   * `?range=` and `?page=` are the consumption window and the page the reader is on, in the URL
   * rather than component state — the same reason the bill list keeps them there: a reader who
   * wants to quote "the last 30 days of spending" sends a link, and a filter that reset itself on
   * reload would make that link useless.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    range: ConsumptionRange;
    page: number;
  } => {
    const range = String(search.range ?? "7d");
    const parsed = Number.parseInt(String(search.page ?? "1"), 10);
    return {
      range: isRangeKey(range) ? range : "7d",
      page: Number.isInteger(parsed) && parsed >= 1 ? parsed : 1,
    };
  },
});

/** The three quick windows, the same three the consumption table offers. */
const RANGES: readonly ConsumptionRange[] = ["today", "7d", "30d"];

function isRangeKey(value: string): value is ConsumptionRange {
  return (RANGES as readonly string[]).includes(value);
}

/** The window a saved range means, as the two ISO ends the API takes. */
function windowFor(range: ConsumptionRange): ConsumptionWindow {
  const to = new Date();
  const from = new Date();
  if (range === "today") {
    from.setHours(0, 0, 0, 0);
  } else {
    from.setDate(from.getDate() - (range === "7d" ? 7 : 30));
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

/** The plan's display name: the catalog's own word, else the code, else nothing. */
function planNameFor(
  planCode: string | undefined,
  catalog: Record<string, PlanCatalogEntry> | undefined,
): string | undefined {
  if (!planCode) return undefined;
  return catalog?.[planCode]?.name ?? planCode;
}

/**
 * 套餐与积分: what this deployment's plan allows, what the local credit ledger holds, and where
 * every credit went.
 *
 * The page reads top-down the way the question does: a welcome offer (one banner), the plan and its
 * base allowance (one card, with the upgrade dialog behind it), the reward grants the platform gave
 * away (one row per grant), then the line items that spent them (the consumption ledger).
 *
 * Credits are the deployment's own currency, kept in a local ledger; every read is uncached by
 * design because a balance moves with every accepted call. The plan's own facts (name, period,
 * reset) come from the entitlements read, the ledger's from the credits reads.
 */
function RouteComponent() {
  const { t } = useTranslation("settings");
  const { range, page } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  const entitlements = useQuery(entitlementsQueryOptions);
  const summary = useQuery(creditsSummaryQueryOptions);
  const grants = useQuery(creditsGrantsQueryOptions);
  const catalog = useQuery(catalogQueryOptions);
  /*
   * Same discipline as the bill list's window: `windowFor` reads the clock, and an unmemoized
   * call changes the query key every render — the refetch loop this ledger once had. One clock
   * read per range change is one query per range change.
   */
  const window = useMemo(() => windowFor(range), [range]);
  const consumption = useQuery(creditsConsumptionQueryOptions(window, page));

  // A deployment with no billing provider has no credit surface at all, which is a fact about the
  // deployment and not a failure — said as one, with no retry, because retrying a route that is not
  // mounted will never work.
  if (summary.error instanceof BillingUnavailableError) {
    return (
      <PageShell
        title={t("creditsPage.title")}
        description={t("creditsPage.description")}
        width="wide"
      >
        <Empty className="mt-8 border-border">
          <EmptyHeader>
            <EmptyTitle>{t("creditsPage.unavailable")}</EmptyTitle>
            <EmptyDescription>
              {t("creditsPage.unavailableDescription")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageShell>
    );
  }

  const hasCatalog = !!catalog.data && Object.keys(catalog.data).length > 0;
  const planName = planNameFor(entitlements.data?.planCode, catalog.data);

  return (
    <PageShell
      title={t("creditsPage.title")}
      description={t("creditsPage.description")}
      width="wide"
    >
      <div className="mt-8">
        {/* The welcome offer is a one-time grant the deployment remembers; its claim is the write
            phase three adds, so until then the button is present but does nothing. */}
        <WelcomeBanner claimed={false} />
      </div>

      <PageSection title={t("creditsPage.subscriptionTitle")}>
        {summary.isPending || entitlements.isPending || catalog.isPending ? (
          <Skeleton className="mt-4 h-40 w-full rounded-xl" />
        ) : summary.error ? (
          <LoadError
            message={(summary.error as Error).message}
            onRetry={() => void summary.refetch()}
          />
        ) : entitlements.error ? (
          <LoadError
            message={(entitlements.error as Error).message}
            onRetry={() => void entitlements.refetch()}
          />
        ) : (
          <PlanCard
            planName={planName ?? t("creditsPage.freePlan")}
            planCredits={summary.data.plan}
            resetsAt={entitlements.data.subscription?.currentPeriodEnd ?? null}
            onUpgrade={hasCatalog ? () => setUpgradeOpen(true) : undefined}
          />
        )}
      </PageSection>

      <PageSection
        title={t("creditsPage.rewardsTitle")}
        description={t("creditsPage.rewardsDescription")}
      >
        {grants.isPending ? (
          <Skeleton className="mt-4 h-32 w-full rounded-xl" />
        ) : grants.error ? (
          <LoadError
            message={(grants.error as Error).message}
            onRetry={() => void grants.refetch()}
          />
        ) : grants.data.grants.length === 0 ? (
          <PageEmpty>{t("creditsPage.emptyGrants")}</PageEmpty>
        ) : (
          <div className="mt-4">
            <CreditGrantList
              grants={grants.data.grants}
              grantCount={summary.data?.rewards.grantCount ?? 0}
              remaining={summary.data?.rewards.remaining ?? 0}
            />
          </div>
        )}
      </PageSection>

      <PageSection
        title={t("creditsPage.consumptionTitle")}
        description={t("creditsPage.consumptionDescription")}
      >
        {consumption.isPending ? (
          <Skeleton className="mt-4 h-60 w-full rounded-xl" />
        ) : consumption.error ? (
          <LoadError
            message={(consumption.error as Error).message}
            onRetry={() => void consumption.refetch()}
          />
        ) : consumption.data.entries.length === 0 ? (
          <PageEmpty>{t("creditsPage.emptyConsumption")}</PageEmpty>
        ) : (
          <ConsumptionTable
            entries={consumption.data.entries}
            pagination={consumption.data.pagination}
            range={range}
            onRangeChange={(next) =>
              void navigate({ search: { range: next, page: 1 } })
            }
            onPage={(next) => void navigate({ search: { range, page: next } })}
            statusTemplate={t("creditsPage.pagerStatus")}
          />
        )}
      </PageSection>

      <UpgradeDialog
        open={upgradeOpen}
        onOpenChange={setUpgradeOpen}
        catalog={catalog.data ?? {}}
        currentPlanName={planName}
      />
    </PageShell>
  );
}

/**
 * What a failed read looks like on this page: the server's sentence, then one way back in.
 *
 * Written once because three queries on this screen can each fail, and a reader who has to work out
 * whether the thing that broke is the plan, the grants or the ledger has been given a puzzle
 * instead of an error.
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
