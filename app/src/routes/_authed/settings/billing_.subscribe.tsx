import * as QRCode from "qrcode";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
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

/** Whole currency units from cents, in the reader's own locale and the plan's own currency. */
function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(cents / 100);
}

/** The countdown, mm:ss, against the QR code's own expiry. */
function remaining(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** One plan row: the price, the period it buys, and whether it is the one being bought now. */
function PlanRow({
  entry,
  selected,
  onSelect,
  disabled,
}: {
  entry: PurchasePlanEntry;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation("settings");
  return (
    <Item
      size="sm"
      render={
        <button
          type="button"
          className="cursor-pointer text-left"
          onClick={onSelect}
          disabled={disabled}
        />
      }
    >
      <ItemContent>
        <ItemTitle className="font-mono">{entry.planCode}</ItemTitle>
        <ItemDescription>{t("subscribe.perMonth")}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <span className="tabular-nums">
          {money(entry.amountCents, entry.currency)}
        </span>
        <span
          aria-hidden
          className={
            selected
              ? "size-3 rounded-full border-4 border-primary"
              : "size-3 rounded-full border"
          }
        />
      </ItemActions>
    </Item>
  );
}

/** One channel row, same shape as a plan row so the two read as one decision. */
function ProviderRow({
  provider,
  selected,
  onSelect,
}: {
  provider: PurchaseProvider;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <Item
      size="sm"
      render={
        <button
          type="button"
          className="cursor-pointer text-left"
          onClick={onSelect}
        />
      }
    >
      <ItemContent>
        <ItemTitle>{t(`subscribe.provider.${provider}`)}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <span
          aria-hidden
          className={
            selected
              ? "size-3 rounded-full border-4 border-primary"
              : "size-3 rounded-full border"
          }
        />
      </ItemActions>
    </Item>
  );
}

/** The QR code itself, rendered locally from the payload the order carries. */
function QrCode({ payload }: { payload: string }) {
  const { t } = useTranslation("settings");
  const [dataUrl, setDataUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setFailed(false);
    QRCode.toDataURL(payload, { margin: 1, width: 224 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [payload]);

  if (failed) {
    return (
      <p className="mt-4 text-muted-foreground text-sm">
        {t("subscribe.qrFailed")}
      </p>
    );
  }
  if (dataUrl === null) {
    // Same footprint as the code, so the layout does not jump when it arrives.
    return (
      <div className="mt-4 size-56 animate-pulse self-start rounded-lg border bg-muted" />
    );
  }
  return (
    <img
      src={dataUrl}
      alt={t("subscribe.qrAlt")}
      className="size-56 self-start rounded-lg border bg-white p-2"
      // The payload is the one thing on this page that must not lag its caption: rendering the
      // previous order's code under this order's countdown would invite paying a dead order.
      key={payload}
    />
  );
}

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
        <PageEmpty>{(order.error as Error).message}</PageEmpty>
      </PageSection>
    );
  }
  if (!view) return null;

  const expiredLocally = Date.parse(view.expiresAt) <= now;
  // The QR exists to be paid once: shown only while the order is pending and carries a payload,
  // and never after the local countdown has run out.
  const qr =
    view.status === "pending" &&
    view.checkout?.kind === "qrcode" &&
    !expiredLocally
      ? view.checkout
      : null;

  return (
    <PageSection
      title={t("subscribe.checkoutTitle")}
      description={t("subscribe.checkoutDescription", {
        planCode: view.planCode,
      })}
    >
      {qr ? (
        <>
          <QrCode payload={qr.payload} />
          <p className="mt-3 text-sm tabular-nums">
            {t("subscribe.expiresIn", { time: remaining(view.expiresAt, now) })}
          </p>
          <p className="mt-1 text-muted-foreground text-sm">
            {t("subscribe.statusPending")}
          </p>
          <div className="mt-4">
            <Button
              variant="outline"
              size="sm"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              {t("subscribe.cancel")}
            </Button>
            {cancel.error ? (
              <p className="mt-2 text-destructive text-sm">
                {(cancel.error as Error).message}
              </p>
            ) : null}
          </div>
        </>
      ) : view.status === "pending" ? (
        // The countdown ran out before the server recorded the outcome. The expiry is the
        // order's own timestamp, so the page says expired now; the polling above keeps going
        // until the server's word arrives, in case a payment landed in the last seconds.
        <div className="mt-4">
          <p className="text-sm">{t("subscribe.statusExpired")}</p>
          <div className="mt-4">
            <Button size="sm" onClick={dismiss}>
              {t("subscribe.backToPlans")}
            </Button>
          </div>
        </div>
      ) : (
        <OutcomeCard view={view} onDone={dismiss} />
      )}
    </PageSection>
  );
}

/** An order that has settled: what happened, and the one verb out of the view. */
function OutcomeCard({
  view,
  onDone,
}: {
  view: PurchaseOrderView;
  onDone: () => void;
}) {
  const { t } = useTranslation("settings");
  const outcome = (() => {
    if (view.status === "paid") {
      if (view.activationState === "applied")
        return { text: t("subscribe.statusPaid") };
      if (view.activationState === "pending")
        return { text: t("subscribe.statusPaidActivating") };
      return { text: t("subscribe.statusPaidFailed") };
    }
    if (view.status === "canceled")
      return { text: t("subscribe.statusCanceled") };
    if (view.status === "expired")
      return { text: t("subscribe.statusExpired") };
    return { text: t("subscribe.statusBlocked") };
  })();

  return (
    <div className="mt-4">
      <p className="text-sm">{outcome.text}</p>
      <div className="mt-4">
        <Button size="sm" onClick={onDone}>
          {t("subscribe.backToPlans")}
        </Button>
      </div>
    </div>
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
      >
        <PageEmpty>{(catalog.error as Error).message}</PageEmpty>
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
    >
      {flowOrderId ? (
        <PurchaseFlow
          orderId={flowOrderId}
          onDone={() => setFlowOrderId(null)}
        />
      ) : (
        <>
          {data.activePlanCode !== null ? (
            <p className="mt-4 rounded-lg border bg-card px-4 py-3 text-sm">
              {t("subscribe.activeSubscriptionNotice", {
                planCode: data.activePlanCode,
              })}
            </p>
          ) : null}
          {!data.canPurchase ? (
            <PageEmpty>{t("subscribe.notAdmin")}</PageEmpty>
          ) : (
            <PlanChooser
              plans={data.plans}
              providers={data.providers}
              canBuy={canBuy}
              onStarted={(order) => setFlowOrderId(order.orderId)}
            />
          )}
        </>
      )}
    </PageShell>
  );
}

/**
 * Picking the plan and the channel, then starting the order.
 *
 * With one plan in the catalog the choice collapses to nothing and the plan row is pre-selected —
 * the common deployment has one price, and making its administrator pick from a list of one is
 * ceremony, not clarity.
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

  return (
    <>
      <PageSection
        title={t("subscribe.plansTitle")}
        description={t("subscribe.plansDescription")}
      >
        {plans.length === 0 ? (
          <PageEmpty>{t("subscribe.noPlans")}</PageEmpty>
        ) : (
          <PageRows>
            {plans.map((entry) => (
              <PlanRow
                key={entry.planCode}
                entry={entry}
                selected={planCode === entry.planCode}
                onSelect={() => setPlanCode(entry.planCode)}
                disabled={!canBuy}
              />
            ))}
          </PageRows>
        )}
      </PageSection>
      {plans.length > 0 && providers.length > 0 ? (
        <PageSection
          title={t("subscribe.providerTitle")}
          description={t("subscribe.providerDescription")}
        >
          <PageRows>
            {providers.map((id) => (
              <ProviderRow
                key={id}
                provider={id}
                selected={provider === id}
                onSelect={() => setProvider(id)}
              />
            ))}
          </PageRows>
          <div className="mt-4 flex items-center gap-3">
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
        </PageSection>
      ) : null}
    </>
  );
}
