import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { entitlementIconFor } from "@/components/billing/entitlement-icon";
import { BillingEmpty } from "@/components/billing/billing-empty";
import { SubscriptionHero } from "@/components/billing/subscription-hero";
import {
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { entitlementsQueryOptions } from "@/lib/billing/queries";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authed/settings/billing")({
  component: RouteComponent,
});

/**
 * What this deployment is entitled to.
 *
 * The hero is the server's subscription word — `{active, planCode?, codes, subscription?}` — and
 * the grid is the plan's own copy, verbatim from the deployment's configuration. An administrator
 * changes the plan (Admin → Billing → Sync, or at the provider); everybody else reads the result
 * here.
 */
function RouteComponent() {
  const { t } = useTranslation("settings");
  const entitlements = useQuery(entitlementsQueryOptions);

  return (
    <PageShell
      title={t("billing.title")}
      description={t("billing.description")}
      width="wide"
    >
      {entitlements.isPending ? (
        <div className="mt-4 space-y-4">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : entitlements.error ? (
        <div className="mt-4">
          <p className="text-destructive text-sm">{(entitlements.error as Error).message}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void entitlements.refetch()}
          >
            {t("billing.retry")}
          </Button>
        </div>
      ) : !entitlements.data.active ? (
        <div className="mt-4">
          <BillingEmpty message={t("billing.inactive")} />
        </div>
      ) : (
        <>
          <SubscriptionHero
            planCode={entitlements.data.planCode ?? ""}
            status={entitlements.data.subscription?.status ?? "active"}
            currentPeriodStart={entitlements.data.subscription?.currentPeriodStart ?? null}
            currentPeriodEnd={entitlements.data.subscription?.currentPeriodEnd ?? null}
          />
          <div className="mt-6">
            <PageSection
              title={t("billing.includedTitle")}
              description={t("billing.includedDescription")}
            >
              {entitlements.data.codes.length === 0 ? (
                <p className="text-muted-foreground mt-2 text-sm">{t("billing.noCodes")}</p>
              ) : (
                <ul className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                  {entitlements.data.codes.map((entry) => {
                    const Icon = entitlementIconFor(entry.code);
                    return (
                      <li
                        key={entry.code}
                        className="flex items-start gap-3 rounded-xl border bg-card p-4"
                      >
                        <Icon className="text-muted-foreground mt-0.5 size-5 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{entry.label ?? entry.code}</p>
                          {entry.description ? (
                            <p className="text-muted-foreground mt-0.5 text-sm">
                              {entry.description}
                            </p>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </PageSection>
          </div>
        </>
      )}
    </PageShell>
  );
}
