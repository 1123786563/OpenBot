import { IconRefresh } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
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
  type CreditGrantEntry,
  catalogQueryOptions,
  creditsSummaryQueryOptions,
} from "@/lib/billing/credits";
import { money } from "@/lib/billing/format";
import {
  type BillingInvoice,
  BillingUnavailableError,
  invoicesQueryOptions,
} from "@/lib/billing/invoices";
import { entitlementsQueryOptions } from "@/lib/billing/queries";
import {
  scopedCreditsSummaryQueryOptions,
  scopedEntitlementsQueryOptions,
  scopedInvoicesQueryOptions,
} from "@/lib/billing/scoped";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { orderIdOfPlanGrant } from "@/lib/billing/trace";
import { useDateTime } from "@/lib/i18n/datetime";
import { CreditGrantRow } from "./credit-grant-list";
import { InvoiceStatusPill } from "./invoice-status";
import { BillingPager } from "./pager";
import { PlanCard } from "./plan-card";

/**
 * 订单与积分 as one view, lifted out of the route file so the page's whole surface — queries,
 * states, sections — renders and is tested without a router under it, the seam the 套餐与积分
 * page takes. The route file keeps only the URL contract and hands the page down as a prop.
 *
 * What the page answers, top-down the way the question does: the orders this person paid for and
 * the money state each is in, the subscription those orders bought, and every credit grant their
 * account holds — each with its source, its expiry, and (when the ledger's own sentence names
 * one) the order that funded it. Traceability here is reading, never deriving: an order id shows
 * up only because the grant's reason names it, and a grant's life is the server's answer quoted,
 * not recomputed.
 *
 * Every money-fact read is uncached by design because a balance and an order's state both move.
 * The account these reads answer is never a parameter: the server resolves it from the session
 * (10.1's read scope), so the page sends no account identifier of any kind — naming one would be
 * answered 400, and asking for one is the cross-account leak this page must not have.
 */

/**
 * The grant sources, spelled out rather than built with a template literal: i18next's `t` is
 * typed over the keys it can actually find, and a `ordersPage.grantSource.${source}` string is
 * not one of them. Spelling them out is also what makes a missing translation a build error
 * rather than a chip reading "ordersPage.grantSource.plan".
 */
const SOURCE_LABELS = {
  plan: "ordersPage.grantSource.plan",
  signin: "ordersPage.grantSource.signin",
  promo: "ordersPage.grantSource.promo",
} as const satisfies Record<CreditGrantEntry["source"], string>;

export function OrdersGrantsView({
  page,
  onPage,
  scope,
}: {
  page: number;
  onPage: (next: number) => void;
  /**
   * The scope the page holds (MT097 / Issue #140, AC4): every money read files under the
   * scope's own prefix and carries the selection pair, so a switch drops the old scope's
   * amounts wholesale. A pending scope reads nothing — the seam's own refusal.
   */
  scope: ScopedCache;
}) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const invoices = useQuery(
    scopedInvoicesQueryOptions(queryClient, scope, {}, page),
  );
  const summary = useQuery(
    scopedCreditsSummaryQueryOptions(queryClient, scope),
  );
  const entitlements = useQuery(
    scopedEntitlementsQueryOptions(queryClient, scope),
  );
  const catalog = useQuery(catalogQueryOptions);

  // A deployment with no billing provider has no order or grant surface at all, which is a fact
  // about the deployment and not a failure — said as one, with no retry button, because retrying
  // a route that is not mounted will never work.
  if (
    summary.error instanceof BillingUnavailableError ||
    invoices.error instanceof BillingUnavailableError
  ) {
    return (
      <PageShell
        title={t("ordersPage.title")}
        description={t("ordersPage.description")}
        width="wide"
      >
        <Empty className="mt-8 border-border">
          <EmptyHeader>
            <EmptyTitle>{t("ordersPage.ordersUnavailable")}</EmptyTitle>
            <EmptyDescription>
              {t("ordersPage.ordersUnavailableDescription")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageShell>
    );
  }

  const planName = entitlements.data?.planCode
    ? (catalog.data?.[entitlements.data.planCode]?.name ??
      entitlements.data.planCode)
    : t("creditsPage.freePlan");

  const refresh = () => {
    // A status change lands with the webhook, not with this page — refresh is the reader asking
    // every money-fact read to ask again. The catalog stays cached; plan names do not move.
    void invoices.refetch();
    void summary.refetch();
    void entitlements.refetch();
  };

  return (
    <PageShell
      action={
        <Button
          onClick={refresh}
          size="sm"
          variant="ghost"
          aria-label={t("ordersPage.refresh")}
        >
          <IconRefresh />
          <span className="hidden sm:inline">{t("ordersPage.refresh")}</span>
        </Button>
      }
      description={t("ordersPage.description")}
      title={t("ordersPage.title")}
      width="wide"
    >
      <PageSection title={t("ordersPage.ordersTitle")}>
        <div data-testid="orders-section" className="mt-4">
          {invoices.isPending ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : invoices.error ? (
            <>
              <p className="text-destructive text-sm" role="alert">
                {(invoices.error as Error).message}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void invoices.refetch()}
              >
                {t("billing.retry")}
              </Button>
            </>
          ) : invoices.data.invoices.length === 0 ? (
            <Empty className="border-border">
              <EmptyHeader>
                <EmptyTitle>{t("ordersPage.ordersEmpty")}</EmptyTitle>
                <EmptyDescription>
                  {t("ordersPage.ordersEmptyDescription")}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              {/*
               * The same scroll region the bill list draws: an overflow area needs keyboard focus
               * to scroll in Safari, and an accessible name to be worth focusing.
               */}
              <section
                data-testid="orders-table"
                aria-label={t("ordersPage.ordersTitle")}
                className="overflow-x-auto rounded-lg border border-border bg-card focus-visible:outline-2 focus-visible:outline-ring"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: An overflow region needs keyboard focus to scroll in Safari; the region has an accessible name.
                tabIndex={0}
              >
                <table className="w-full text-left text-sm">
                  <thead className="text-muted-foreground text-xs">
                    <tr className="border-border border-b">
                      <th className="px-4 py-2 font-medium">
                        {t("ordersPage.columnPlan")}
                      </th>
                      <th className="px-4 py-2 text-right font-medium">
                        {t("ordersPage.columnAmount")}
                      </th>
                      <th className="px-4 py-2 font-medium">
                        {t("ordersPage.columnStatus")}
                      </th>
                      <th className="hidden px-4 py-2 font-medium md:table-cell">
                        {t("ordersPage.columnCreated")}
                      </th>
                      <th className="hidden px-4 py-2 font-medium lg:table-cell">
                        {t("ordersPage.columnNumber")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.data.invoices.map((invoice) => (
                      <OrderRow key={invoice.invoiceId} invoice={invoice} />
                    ))}
                  </tbody>
                </table>
              </section>
              <BillingPager
                page={page}
                totalPages={invoices.data.pagination.totalPages}
                totalCount={invoices.data.pagination.totalCount}
                hasNext={invoices.data.pagination.nextPage !== null}
                onPage={onPage}
                statusTemplate={t("invoicesPage.pagerStatus")}
              />
            </>
          )}
        </div>
      </PageSection>

      <PageSection title={t("ordersPage.subscriptionTitle")}>
        {entitlements.isPending || catalog.isPending ? (
          <Skeleton className="h-40 w-full rounded-xl" />
        ) : entitlements.error ? (
          <LoadError
            message={(entitlements.error as Error).message}
            onRetry={() => void entitlements.refetch()}
          />
        ) : (
          /*
           * The plan's face only: no upgrade entry here — buying happens on the 套餐与积分 page,
           * and this page's job is to show what a purchase became, not to start another one.
           */
          <PlanCard
            planName={planName}
            resetsAt={entitlements.data.subscription?.currentPeriodEnd ?? null}
          />
        )}
      </PageSection>

      <PageSection
        title={t("ordersPage.grantsTitle")}
        description={t("ordersPage.grantsDescription")}
      >
        {summary.isPending ? (
          <Skeleton className="h-32 w-full rounded-xl" />
        ) : summary.error ? (
          <LoadError
            message={(summary.error as Error).message}
            onRetry={() => void summary.refetch()}
          />
        ) : summary.data.grants.length === 0 ? (
          <PageEmpty>{t("ordersPage.grantsEmpty")}</PageEmpty>
        ) : (
          <div className="mt-4">
            <p className="text-muted-foreground mb-3 text-xs tabular-nums">
              {t("ordersPage.grantsSummary", {
                count: summary.data.grants.length,
              })}
            </p>
            <div className="space-y-3">
              {summary.data.grants.map((grant) => (
                <div key={grant.id} data-testid={`credit-grant-${grant.id}`}>
                  <CreditGrantRow
                    grant={grant}
                    sourceLabel={t(SOURCE_LABELS[grant.source])}
                    trace={
                      <GrantTrace
                        grant={grant}
                        orders={invoices.data?.invoices ?? []}
                      />
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </PageSection>
    </PageShell>
  );
}

/**
 * One order row: what the money bought, how much, which state the money is in, and which order to
 * quote. The detail dialog and the download stay on the bill page — this row's job is to be
 * recognizable, and to be the row a grant's trace chip points at.
 */
function OrderRow({ invoice }: { invoice: BillingInvoice }) {
  const { formatDate, formatDateTime } = useDateTime();
  return (
    <tr className="border-border border-t">
      <td className="px-4 py-2 whitespace-nowrap tabular-nums">
        {invoice.periodStart && invoice.periodEnd
          ? `${formatDate(invoice.periodStart)} – ${formatDate(invoice.periodEnd)}`
          : "–"}
        <span className="text-muted-foreground block text-xs">
          {invoice.planCode}
        </span>
      </td>
      <td className="px-4 py-2 text-right whitespace-nowrap tabular-nums">
        {money(invoice.amountCents, invoice.currency)}
      </td>
      <td className="px-4 py-2">
        <InvoiceStatusPill status={invoice.status} />
      </td>
      <td className="text-muted-foreground hidden px-4 py-2 whitespace-nowrap text-xs md:table-cell">
        {formatDateTime(invoice.issuedAt)}
      </td>
      <td className="text-muted-foreground hidden px-4 py-2 font-mono text-xs lg:table-cell">
        {invoice.invoiceId}
      </td>
    </tr>
  );
}

/**
 * One grant's trace, as the ledger itself states it: the order id its reason names — with the
 * funding order's money state riding along when that order is on the page — or, for a plan grant
 * whose reason names nothing, the absence said out loud. A check-in or a campaign grant is a
 * granting ACTION, not a purchase: it traces to no order, so no order is named — the source chip
 * is the whole of its trace.
 */
function GrantTrace({
  grant,
  orders,
}: {
  grant: CreditGrantEntry;
  orders: readonly BillingInvoice[];
}) {
  const { t } = useTranslation("settings");
  const orderId = orderIdOfPlanGrant(grant);
  if (orderId === null) {
    if (grant.source !== "plan") return null;
    return (
      <p
        data-testid={`trace-no-order-${grant.id}`}
        className="text-muted-foreground mt-2 text-xs"
      >
        {t("ordersPage.traceNoOrder")}
      </p>
    );
  }
  const order = orders.find((candidate) => candidate.invoiceId === orderId);
  return (
    <p
      data-testid={`trace-${grant.id}`}
      className="mt-2 flex flex-wrap items-center gap-2 text-xs"
    >
      <span className="text-muted-foreground">
        {t("ordersPage.traceOrder", { order: orderId })}
      </span>
      {order ? <InvoiceStatusPill status={order.status} /> : null}
    </p>
  );
}

/**
 * What a failed read looks like on this page: the server's sentence, then one way back in.
 * Written once because three reads on this screen can each fail, and a reader who has to work out
 * which one broke has been given a puzzle instead of an error.
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
