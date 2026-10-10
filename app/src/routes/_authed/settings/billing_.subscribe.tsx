import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { CheckoutCard } from "@/components/billing/checkout-card";
import { PriceCard } from "@/components/billing/price-card";
import { ProviderSegmented } from "@/components/billing/provider-segmented";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { money } from "@/lib/billing/format";
import {
  cancelPurchase,
  createPurchase,
  currentPurchaseQueryOptions,
  PaymentsUnavailableError,
  purchaseCatalogQueryOptions,
  purchaseKeys,
  purchaseOrderQueryOptions,
  type PurchaseOrderView,
  type PurchasePlanEntry,
  type PurchaseProvider,
  PurchaseRequestError,
} from "@/lib/billing/payments";

export const Route = createFileRoute("/_authed/settings/billing_/subscribe")({
  component: RouteComponent,
});

/**
 * Buying a plan, from catalog to paid.
 *
 * The page is one flow with three views: pick a plan and a channel, scan the QR code while the
 * order is pending, then the order's own outcome. The order is the single source of truth the
 * whole time — created locally or found as a pending order on the way back in, it is read by id
 * every few seconds until it settles, because the payment channel's own callback races the page
 * and the server's read is what also asks the channel, so polling is the recovery path for a
 * missed callback rather than a nicety.
 */

/** How often a pending order is re-read: the server grades the read against the channel. */
const POLL_INTERVAL_MS = 5_000;
/**
 * The ceiling on that polling — five seconds × this, fifteen minutes, matching the server's
 * default order TTL. A countdown that runs out first stops the polling too; this is the floor
 * for a deployment configured with a longer one.
 */
const MAX_POLL_ATTEMPTS = 180;

/**
 * The order in flight, from QR code to outcome.
 *
 * The polling lives here and nowhere else. React Query tears an observer's interval down when its
 * component unmounts, so leaving the page stops the asking; the interval callback itself stops it
 * when the order settles, the code expires, or the attempt ceiling is reached — whichever first.
 */
function PurchaseFlow({
  orderId,
  onDone,
}: {
  orderId: string;
  onDone: () => void;
}) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [now, setNow] = React.useState(() => Date.now());

  // The countdown ticks locally; a pause in a background tab does not matter, because the expiry
  // is read from the order's own timestamp, not accumulated here.
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const order = useQuery({
    ...purchaseOrderQueryOptions(orderId),
    refetchInterval: (query) => {
      const data = query.state.data?.order;
      if (!data) return false;
      // Keep asking while the server can still move the order: the money is pending, or the
      // activation of a paid order is still running. A countdown running out does not stop the
      // asking — the server's own expiry (its sweeper) is the fact the outcome is shown from,
      // and the attempt ceiling is what bounds the asking, not the local clock.
      if (data.status !== "pending" && data.activationState !== "pending")
        return false;
      if (query.state.dataUpdateCount >= MAX_POLL_ATTEMPTS) return false;
      return POLL_INTERVAL_MS;
    },
  });

  const cancel = useMutation({
    mutationFn: () => cancelPurchase(orderId),
    onSuccess: () => {
      // Re-read so the cancellation is shown from the server's word, not assumed here.
      void queryClient.invalidateQueries({
        queryKey: purchaseOrderQueryOptions(orderId).queryKey,
      });
    },
  });

  const view = order.data?.order;

  // A paid order changed the deployment's plan: the catalog's active-plan answer is stale now.
  const paid = view?.status === "paid";
  React.useEffect(() => {
    if (!paid) return;
    void queryClient.invalidateQueries({ queryKey: purchaseKeys.current });
    void queryClient.invalidateQueries({ queryKey: purchaseKeys.catalog });
  }, [paid, queryClient]);

  const dismiss = () => {
    void queryClient.invalidateQueries({ queryKey: purchaseKeys.current });
    onDone();
  };

  if (order.isPending && !view) return null;
  if (order.error && !view) {
    return (
      <PageSection title={t("subscribe.checkoutTitle")}>
        <div className="mt-4">
          <p className="text-destructive text-sm">{(order.error as Error).message}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void order.refetch()}
          >
            {t("billing.retry")}
          </Button>
        </div>
      </PageSection>
    );
  }
  if (!view) return null;

  return (
    <PageSection
      title={t("subscribe.checkoutTitle")}
      description={t("subscribe.checkoutDescription", {
        planCode: view.planCode,
      })}
    >
      <CheckoutCard
        view={view}
        now={now}
        onCancel={() => cancel.mutate()}
        cancelPending={cancel.isPending}
        cancelError={cancel.error ? (cancel.error as Error).message : null}
        onDismiss={dismiss}
      />
    </PageSection>
  );
}

function RouteComponent() {
  const { t } = useTranslation("settings");
  const catalog = useQuery(purchaseCatalogQueryOptions);
  const current = useQuery(currentPurchaseQueryOptions);

  /** The order this page is currently walking through, when it started or resumed one. */
  const [flowOrderId, setFlowOrderId] = React.useState<string | null>(null);

  // Arriving back with an order still pending — a refresh, a return from elsewhere — resumes the
  // flow at that order. Settled orders do not resume: the catalog's own active-plan notice says
  // what matters about them.
  React.useEffect(() => {
    const resumed = current.data?.order;
    if (resumed?.status === "pending" && flowOrderId === null) {
      setFlowOrderId(resumed.orderId);
    }
  }, [current.data, flowOrderId]);

  if (catalog.isPending) return null;
  if (catalog.error instanceof PaymentsUnavailableError) {
    return (
      <PageShell
        title={t("subscribe.title")}
        description={t("subscribe.description")}
        width="wide"
      >
        <PageEmpty>{t("subscribe.notEnabled")}</PageEmpty>
      </PageShell>
    );
  }
  if (catalog.error) {
    return (
      <PageShell
        title={t("subscribe.title")}
        description={t("subscribe.description")}
        width="wide"
      >
        <div className="mt-4">
          <p className="text-destructive text-sm">{(catalog.error as Error).message}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void catalog.refetch()}
          >
            {t("billing.retry")}
          </Button>
        </div>
      </PageShell>
    );
  }

  const data = catalog.data;
  const canBuy =
    data.canPurchase && data.activePlanCode === null && data.plans.length > 0;

  return (
    <PageShell
      title={t("subscribe.title")}
      description={t("subscribe.description")}
      width="wide"
    >
      {flowOrderId ? (
        <PurchaseFlow
          orderId={flowOrderId}
          onDone={() => setFlowOrderId(null)}
        />
      ) : (
        <>
          {data.activePlanCode !== null ? (
            <div className="rounded-xl border bg-card p-5">
              <p className="text-muted-foreground text-sm">
                {t("subscribe.statusCardTitle")}
              </p>
              <div className="mt-1 flex items-center justify-between">
                <span className="font-mono text-lg font-semibold">
                  {data.activePlanCode}
                </span>
                <Link
                  to="/settings/billing"
                  className="text-primary text-sm hover:underline"
                >
                  {t("subscribe.viewEntitlements")}
                </Link>
              </div>
            </div>
          ) : null}
          {!data.canPurchase ? (
            <p className="text-muted-foreground text-sm">
              {t("subscribe.notAdmin")}
            </p>
          ) : null}
          <PlanChooser
            plans={data.plans}
            providers={data.providers}
            canBuy={canBuy}
            onStarted={(order) => setFlowOrderId(order.orderId)}
          />
        </>
      )}
    </PageShell>
  );
}

/**
 * Picking the plan and the channel, then starting the order.
 *
 * With one plan in the catalog the choice collapses to nothing and the plan card is pre-selected —
 * the common deployment has one price, and making its administrator pick from a list of one is
 * ceremony, not clarity. A read-only caller still sees the catalog: the cards render disabled
 * rather than the page going empty.
 */
function PlanChooser({
  plans,
  providers,
  canBuy,
  onStarted,
}: {
  plans: PurchasePlanEntry[];
  providers: PurchaseProvider[];
  canBuy: boolean;
  onStarted: (order: PurchaseOrderView) => void;
}) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [planCode, setPlanCode] = React.useState<string | null>(
    plans.length === 1 ? plans[0].planCode : null,
  );
  // The catalog names the channels this deployment configured; the pre-selection is its first
  // entry, so the chooser never offers — and a purchase never names — a channel the server
  // would refuse.
  const [provider, setProvider] = React.useState<PurchaseProvider>(
    providers[0] ?? "alipay",
  );

  const create = useMutation({
    mutationFn: () => {
      if (planCode === null) throw new Error("Pick a plan first.");
      return createPurchase({ planCode, provider });
    },
    onSuccess: (order) => {
      // Seed the flow's poll query so the QR shows without a second round trip, and put the
      // order where the page's resume logic reads it, so a refresh mid-payment lands here again.
      queryClient.setQueryData(
        purchaseOrderQueryOptions(order.orderId).queryKey,
        { order },
      );
      queryClient.setQueryData(purchaseKeys.current, { order });
      onStarted(order);
    },
    // The one-subscription refusal means the catalog's active-plan answer is stale: re-ask it.
    onError: (error) => {
      if (error instanceof PurchaseRequestError && error.status === 409) {
        void queryClient.invalidateQueries({
          queryKey: purchaseCatalogQueryOptions.queryKey,
        });
      }
    },
  });

  const selected = plans.find((entry) => entry.planCode === planCode);

  return (
    <>
      <PageSection
        title={t("subscribe.plansTitle")}
        description={t("subscribe.plansDescription")}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {plans.map((entry) => (
            <PriceCard
              key={entry.planCode}
              entry={entry}
              selected={planCode === entry.planCode}
              onSelect={() => setPlanCode(entry.planCode)}
              disabled={!canBuy}
            />
          ))}
        </div>
      </PageSection>
      {plans.length > 0 && providers.length > 0 ? (
        <PageSection
          title={t("subscribe.providerTitle")}
          description={t("subscribe.providerDescription")}
        >
          <ProviderSegmented
            providers={providers}
            value={provider}
            onChange={setProvider}
          />
        </PageSection>
      ) : null}
      <hr className="my-6" />
      <div className="flex items-center justify-between">
        <p className="text-sm tabular-nums">
          {selected
            ? `${selected.planCode} · ${money(selected.amountCents, selected.currency)}`
            : t("subscribe.noPlans")}
        </p>
        <div className="flex items-center gap-3">
          <Button
            disabled={!canBuy || planCode === null || create.isPending}
            onClick={() => create.mutate()}
          >
            {t("subscribe.buy")}
          </Button>
          {create.error ? (
            <p className="text-destructive text-sm">
              {(create.error as Error).message}
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}
