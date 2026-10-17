import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageEmpty, PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type ConsumptionRange,
  ConsumptionTable,
} from "./consumption-table";
import { CreditGrantList } from "./credit-grant-list";
import { PersonalBalanceCard } from "./personal-balance-card";
import { PlanCard } from "./plan-card";
import { UpgradeDialog } from "./upgrade-dialog";
import { WelcomeBanner } from "./welcome-banner";
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

/**
 * 套餐与积分 as one view, lifted out of the route file (ticket 02.7) so the page's whole surface
 * — queries, states, sections — renders and is tested without a router under it, the same seam
 * the model-access settings page takes. The route file keeps only the URL contract and hands the
 * window and page down as props.
 *
 * What the page reads, top-down the way the question does: a welcome offer (one banner), the
 * subscription plan and its upgrade entry (one card, catalog-driven), the person's OWN credit
 * account — account type, available/consumed/expired and holds, the 02.6 read's answer (one
 * card) — the purchase entry, the reward grants (one row per grant), then the line items that
 * spent them (the consumption ledger).
 *
 * Every credit read is uncached by design because a balance moves with every accepted call. The
 * account these reads answer is never a parameter: the server resolves it from the session
 * (02.6), so the page sends no account identifier of any kind — naming one would be answered
 * 400, and asking for one is the cross-account leak this page must not have.
 */

/** The three quick windows, the same three the consumption table offers. */
export const RANGES: readonly ConsumptionRange[] = ["today", "7d", "30d"];

export function isRangeKey(value: string): value is ConsumptionRange {
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

export function UsageCreditsView({
  range,
  page,
  onRangeChange,
  onPage,
}: {
  range: ConsumptionRange;
  page: number;
  onRangeChange: (next: ConsumptionRange) => void;
  onPage: (next: number) => void;
}) {
  const { t } = useTranslation("settings");
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
  // deployment and not a failure — said as one, with no retry, because retrying a route that is
  // not mounted will never work.
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
  /*
   * A deployment with a live subscription cannot buy another one — the server refuses the purchase
   * with "already has an active subscription". Knowing that here lets the dialog say it up front
   * (a disabled pay button with the reason) instead of letting the reader click into the refusal.
   */
  const hasActivePlan = !!entitlements.data?.active;

  return (
    <PageShell
      title={t("creditsPage.title")}
      description={t("creditsPage.description")}
      width="wide"
    >
      <div className="mt-8">
        {/* The welcome offer is a one-time grant the deployment remembers; its claim is the write
            phase three adds. Until that write exists the banner renders its claim DISABLED with a
            plain "not open yet" — a button that begged to be clicked and then did nothing was
            worse than no button. */}
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
          /* The plan allowance bar is gone with the 02.6 contract — the summary read now answers
           * the personal balance, and no endpoint carries a plan figure to draw. Hiding it beats
           * drawing a 0/0 the server never said; the balance below is the real story now. */
          <PlanCard
            planName={planName ?? t("creditsPage.freePlan")}
            resetsAt={entitlements.data.subscription?.currentPeriodEnd ?? null}
            onUpgrade={hasCatalog ? () => setUpgradeOpen(true) : undefined}
          />
        )}
      </PageSection>

      <PageSection
        title={t("creditsPage.personalAccountTitle")}
        description={t("creditsPage.personalAccountDescription")}
      >
        {summary.isPending ? (
          <Skeleton className="mt-4 h-40 w-full rounded-xl" />
        ) : summary.error ? (
          <LoadError
            message={(summary.error as Error).message}
            onRetry={() => void summary.refetch()}
          />
        ) : (
          /* The account card mounts only on a landed read: the failure above speaks instead of
           * it, so a broken read can never dress itself up as a zero balance. */
          <PersonalBalanceCard balance={summary.data} />
        )}
      </PageSection>

      {/*
       * 购买积分: the design's fifth block — a purchase entry. The buy itself is a phase-three
       * write; what this pass renders is the design's empty state, so the page's shape matches
       * while the transaction lane is not built. The numbers live in the balance card now.
       */}
      <PageSection
        title={t("creditsPage.purchaseTitle")}
        action={
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-muted-foreground text-xs">
              {t("creditsPage.purchaseBadge")}
            </span>
            {/*
             * Credits ride a plan in this model, so buying credits IS choosing a plan: the button
             * opens the same dialog the upgrade button does. The standalone top-up order (buying
             * credit packs without a plan change) is the phase-three write this entry grows into.
             */}
            <Button
              size="sm"
              variant="outline"
              onClick={hasCatalog ? () => setUpgradeOpen(true) : undefined}
              disabled={!hasCatalog}
            >
              {t("creditsPage.purchaseButton")}
            </Button>
          </div>
        }
      >
        <div className="rounded-xl border bg-card p-5">
          <p className="text-muted-foreground text-sm">
            {t("creditsPage.purchaseEmpty")}
          </p>
        </div>
      </PageSection>

      <PageSection
        title={t("creditsPage.rewardsTitle")}
        description={t("creditsPage.rewardsDescription")}
      >
        {grants.isPending || summary.isPending ? (
          <Skeleton className="mt-4 h-32 w-full rounded-xl" />
        ) : grants.error ? (
          <LoadError
            message={(grants.error as Error).message}
            onRetry={() => void grants.refetch()}
          />
        ) : summary.error ? (
          <LoadError
            message={(summary.error as Error).message}
            onRetry={() => void summary.refetch()}
          />
        ) : grants.data.grants.length === 0 ? (
          <PageEmpty>{t("creditsPage.emptyGrants")}</PageEmpty>
        ) : (
          /* The summary line's three figures, derived — never defaulted: the count comes from the
           * grant list itself (grants still holding something to spend), the available and held
           * figures from the personal balance read. The branches above retire pending and failed
           * reads, so no `?? 0` ever mints a balance the server did not say (the exact failure
           * the old `summary.rewards ?? 0` shape invited when the contract changed). */
          <div className="mt-4">
            <CreditGrantList
              grants={grants.data.grants}
              grantCount={
                grants.data.grants.filter(
                  (grant) => grant.status === "active" && grant.remaining > 0,
                ).length
              }
              remaining={summary.data.available}
              held={summary.data.held}
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
        ) : (
          /* An empty window is the table's own case to state — the switcher must survive it
           * (the field bug: an empty window unmounted the switcher and trapped the reader). */
          <ConsumptionTable
            entries={consumption.data.entries}
            pagination={consumption.data.pagination}
            range={range}
            onRangeChange={onRangeChange}
            onPage={onPage}
            statusTemplate={t("creditsPage.pagerStatus")}
          />
        )}
      </PageSection>

      <UpgradeDialog
        open={upgradeOpen}
        onOpenChange={setUpgradeOpen}
        catalog={catalog.data ?? {}}
        currentPlanName={planName}
        purchaseBlocked={hasActivePlan}
      />
    </PageShell>
  );
}

/**
 * What a failed read looks like on this page: the server's sentence, then one way back in.
 *
 * Written once because four reads on this screen can each fail, and a reader who has to work out
 * whether the thing that broke is the plan, the balance, the grants or the ledger has been given
 * a puzzle instead of an error.
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
