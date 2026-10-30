import { useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PlanCatalogCycle, PlanCatalogEntry } from "@/lib/billing/credits";
import { credits } from "@/lib/billing/format";
import {
  cancelPurchase,
  createPurchase,
  currentPurchaseQueryOptions,
  type PurchaseCycle,
  type PurchaseOrderView,
  type PurchaseProvider,
  PurchaseRequestError,
  purchaseCatalogQueryOptions,
  purchaseOrderQueryOptions,
} from "@/lib/billing/payments";
import { cn } from "@/lib/utils";

/**
 * The upgrade dialog: three plan cards, the billing-cycle choice, the channel choice, a price
 * summary and the scan-to-pay block with the agreement gate.
 *
 * EVERYTHING THE READER CAN CHOOSE IS SERVER-DRIVEN: the channels render from the purchase
 * catalog's `providers` (the configured channels and nothing else — the old hardcoded alipay
 * sent readers of a wechat-only deployment into a 400), and the cycle choice renders from the
 * catalog's `cycles` (v1 offers the monthly spellings only; a yearly cycle the server cannot
 * activate is not shown at all rather than shown and refused).
 *
 * The QR renders LOCALLY (`qrcode`, already a dependency): the payload is a payment credential
 * (merchant, order, amount) and used to be shipped to a public third-party image service to be
 * drawn — a data egress nobody accepted, fixed by drawing it in this tab.
 */
export function UpgradeDialog({
  open,
  onOpenChange,
  catalog,
  currentPlanName,
  purchaseBlocked = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: Record<string, PlanCatalogEntry>;
  currentPlanName?: string;
  /**
   * The deployment already has a live subscription, so the server will refuse any purchase with
   * "already has an active subscription". Set by the page from the entitlements read; the dialog
   * says it up front rather than letting the reader click into the refusal.
   */
  purchaseBlocked?: boolean;
}) {
  const { t } = useTranslation("settings");
  const entries = Object.entries(catalog);
  const [selected, setSelected] = useState<string>(entries[0]?.[0] ?? "");
  const [agreed, setAgreed] = useState(false);
  /*
   * The catalog can arrive after mount (React Query), and `useState` above captured the empty
   * first render's "" — a selection that matches no tier, so neither cycles nor the summary ever
   * render. Re-anchor on the entries as they land: an invalid selection (a stale catalog's tier,
   * or the initial empty one) falls back to the first tier once there is one.
   */
  if (entries.length > 0 && !catalog[selected]) {
    setSelected(entries[0][0]);
  }

  /*
   * The purchase catalog (channels + purchasable cycles). Fetched here rather than threaded from
   * the page because the dialog is its only consumer: a page that never opens the dialog never
   * pays for the read.
   */
  const queryClient = useQueryClient();
  const [purchaseCatalog, setPurchaseCatalog] = useState<{
    providers: PurchaseProvider[];
    cycles: PurchaseCycle[];
  } | null>(null);
  /* The read is in flight: the choosers cannot render yet, and that silence used to read as a
   * broken dialog (the pay button sat disabled with nothing saying why). One line says it. */
  const [catalogPending, setCatalogPending] = useState(false);
  const [provider, setProvider] = useState<PurchaseProvider | null>(null);
  const [cycle, setCycle] = useState<PurchaseCycle | null>(null);
  useEffect(() => {
    if (!open || purchaseCatalog) return;
    setCatalogPending(true);
    void queryClient
      .fetchQuery(purchaseCatalogQueryOptions)
      .then((catalogAnswer) => {
        setPurchaseCatalog({
          providers: catalogAnswer.providers,
          cycles: catalogAnswer.cycles,
        });
        // First-listed channel and cycle preselect; a single-option deployment shows no chooser.
        setProvider((current) => current ?? catalogAnswer.providers[0] ?? null);
        setCycle((current) => current ?? catalogAnswer.cycles[0] ?? null);
      })
      .catch(() => {
        /* A failed catalog read leaves the choosers empty and the pay button disabled — the
         * reader sees nothing to click rather than a choice the server would refuse. */
      })
      .finally(() => setCatalogPending(false));
  }, [open, purchaseCatalog, queryClient]);

  const plan = catalog[selected];
  /*
   * The cycle the summary prices: the PURCHASE cycle chosen above (what the checkout will send),
   * matched into the display catalog's pricing for its label and price. A display-only cycle the
   * server does not offer never reaches `cycle`, so this always finds its pricing entry.
   */
  const cycleEntry =
    plan && cycle
      ? plan.pricing.find((c) => c.code === cycle)
      : (plan?.pricing.find((c) => c.code === "recurring_monthly") ??
        plan?.pricing.find((c) => c.code === "monthly"));

  /*
   * The checkout state: once an order exists the QR block shows the channel's real code and this
   * dialog polls the order (the page reads it back; see the poll below) until the money lands or
   * the code expires. A failed create keeps the dialog open with the server's sentence.
   */
  const [order, setOrder] = useState<PurchaseOrderView | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [canceling, setCanceling] = useState(false);
  // The QR drawn locally: the payload rendered to a data URL the <img> can show.
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  useEffect(() => {
    if (order?.checkout?.kind !== "qrcode") {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(order.checkout.payload, {
      margin: 1,
      width: 280,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [order?.checkout?.kind, order?.checkout]);

  const startCheckout = async () => {
    // One lane at a time: a cancel in flight and a checkout in flight can cross setOrder
    // writes (a late cancel callback erased a freshly created order and left the dialog
    // 409-locked with no cancel entry), so each lane refuses the other.
    if (canceling || !provider || !cycle) return;
    setPayError(null);
    setPaying(true);
    try {
      // The contract the server validates: plan, the CONFIGURED channel, an OFFERED cycle.
      const created = await createPurchase({
        planCode: selected,
        provider,
        cycle,
      });
      setOrder(created);
    } catch (error) {
      /*
       * The two 409s a reader can actually meet are said in the reader's language, not the
       * server's English: a pending order blocks every new purchase deployment-wide, and an
       * active subscription blocks a repeat. Both travel their plan code on the typed error,
       * which is what they are matched on — never the message string.
       */
      if (
        error instanceof PurchaseRequestError &&
        error.status === 409 &&
        error.pendingPlanCode !== null
      ) {
        setPayError(t("upgradeDialog.errors.pendingPurchase"));
        /*
         * A REMOUNTED dialog holds no local order, so the refusal's own escape — "cancel it"
         * — would point at a button that does not render. The server's current-order read is
         * exactly this recovery path (the query already exists for the page): pull the blocking
         * pending order back into view so the cancel entry the message names exists.
         */
        if (!orderRef.current) {
          void queryClient
            .fetchQuery(currentPurchaseQueryOptions)
            .then(({ order: current }) => {
              if (current?.status === "pending") setOrder(current);
            })
            .catch(() => {
              /* The refusal sentence still stands on its own; this is only the escape hatch. */
            });
        }
      } else if (
        error instanceof PurchaseRequestError &&
        error.status === 409 &&
        error.activePlanCode !== null
      ) {
        setPayError(t("upgradeDialog.alreadySubscribed"));
      } else {
        setPayError((error as Error).message);
      }
    } finally {
      setPaying(false);
    }
  };

  /*
   * The reader's own way out of a pending order: cancel it here rather than wait out the TTL
   * (the field finding — a pending order 409-blocked every new purchase and the dialog offered
   * no cancel, so an abandoned checkout locked buying for the order's whole lifetime). A cancel
   * clears the order, which stops the poll and re-arms the checkout lane; cancelling an
   * already-cancelled order is the server's own no-op success.
   */
  const cancelOrder = async () => {
    if (order?.status !== "pending" || canceling || paying) return;
    setCanceling(true);
    try {
      await cancelPurchase(order.orderId);
      setOrder(null);
      setPayError(null);
    } catch (error) {
      /* The server's own refusal (an order that settled between click and landing) is English;
       * this dialog says its refusals in the reader's language, and a cancel refusal is one. */
      setPayError(
        error instanceof PurchaseRequestError
          ? t("upgradeDialog.errors.cancelFailed")
          : (error as Error).message,
      );
    } finally {
      setCanceling(false);
    }
  };

  /*
   * The settlement poll: the sandbox channel's callback cannot reach this deployment (and even in
   * production a callback can be missed), so the order's own read — which asks the channel as its
   * side effect — is the recovery path. While a pending order is showing, re-read it every few
   * seconds until it settles, expires or the dialog closes. This is exactly what the subscribe
   * page's PurchaseFlow does (POLL_INTERVAL_MS there); without it a reader who paid sees
   * "订单待支付" forever until somebody else asks the channel.
   */
  const orderRef = useRef(order);
  orderRef.current = order;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the timer polls the live order through `orderRef` each tick, and the liveness guard below drops a stale poll — the listed deps (open, order identity, status) are the re-arm triggers, deliberately narrower than the captured guard.
  useEffect(() => {
    if (!open || !order || order.status !== "pending") return;
    const timer = setInterval(() => {
      const current = orderRef.current;
      if (current?.status !== "pending") return;
      void queryClient
        .fetchQuery(purchaseOrderQueryOptions(current.orderId))
        .then(({ order: fresh }) => {
          /*
           * Liveness guard: a cancel (or any later transition) may have cleared or replaced
           * the order while this poll was on the wire. Applying its answer anyway resurrected
           * a cancelled order into the cleared dialog, so a stale poll is dropped, not applied.
           */
          if (orderRef.current?.orderId !== current.orderId) return;
          if (
            fresh.status !== current.status ||
            fresh.activationState !== current.activationState
          ) {
            setOrder(fresh);
          }
        })
        .catch(() => {
          /* A failed poll is just the next poll's problem. */
        });
    }, 5_000);
    return () => clearInterval(timer);
  }, [open, order?.orderId, order?.status, queryClient]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("upgradeDialog.title")}</DialogTitle>
          <DialogDescription>
            {currentPlanName
              ? t("upgradeDialog.currentPlan", { plan: currentPlanName })
              : t("upgradeDialog.subtitle")}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {/* Three plan cards; the selected one is ringed. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {entries.map(([code, entry]) => (
              <button
                key={code}
                type="button"
                onClick={() => setSelected(code)}
                className={cn(
                  "flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors",
                  selected === code
                    ? "border-primary ring-2 ring-primary/50"
                    : "border-border hover:border-muted-foreground",
                )}
              >
                <span className="font-medium">{entry.name}</span>
                <span className="text-lg font-semibold tabular-nums">
                  {credits(entry.credits)}
                  <span className="text-muted-foreground ml-1 text-xs font-normal">
                    {t("creditsPage.creditUnit")}
                  </span>
                </span>
                <ul className="text-muted-foreground space-y-1 text-xs">
                  {entry.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
              </button>
            ))}
          </div>

          {/*
           * The purchase catalog is on the wire: the choosers cannot render yet, and the
           * silence used to look like a broken dialog (the pay button disabled, nothing saying
           * why). One line says it, and it leaves when the choosers land.
           */}
          {catalogPending && !purchaseCatalog ? (
            <p className="text-muted-foreground animate-pulse text-xs">
              {t("upgradeDialog.loadingOptions")}
            </p>
          ) : null}

          {/* The billing cycles the SERVER offers (not the display catalog's wider set): v1
              shows the monthly spellings; yearly is absent until the provider can activate it. */}
          {purchaseCatalog && purchaseCatalog.cycles.length > 0 ? (
            <div className="grid grid-cols-2 gap-2">
              {purchaseCatalog.cycles.map((code) => {
                const pricing = plan?.pricing.find((c) => c.code === code);
                if (!pricing) return null;
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => setCycle(code)}
                    className={cn(
                      "flex flex-col gap-0.5 rounded-xl border p-3 text-left transition-colors",
                      cycle === code
                        ? "border-primary ring-2 ring-primary/50"
                        : "border-border hover:border-muted-foreground",
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {pricing.label}
                      {pricing.discountLabel ? (
                        <span className="text-success text-xs">
                          {pricing.discountLabel}
                        </span>
                      ) : null}
                    </span>
                    <span className="tabular-nums">
                      {yuan(pricing.priceCents)}
                      <span className="text-muted-foreground text-xs">
                        /{t(`upgradeDialog.unit.${pricing.unit}`)}
                      </span>
                    </span>
                    {pricing.originalCents ? (
                      <span className="text-muted-foreground text-xs line-through tabular-nums">
                        {yuan(pricing.originalCents)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* The channel choice, from the configured channels only. A one-channel deployment
              renders one row (a fact, not a broken chooser); the purchase names what it shows. */}
          {purchaseCatalog && purchaseCatalog.providers.length > 0 ? (
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs">
                {t("upgradeDialog.payWith")}
              </p>
              <div className="flex gap-2">
                {purchaseCatalog.providers.map((channel) => (
                  <button
                    key={channel}
                    type="button"
                    onClick={() => setProvider(channel)}
                    className={cn(
                      "rounded-xl border px-4 py-2 text-sm transition-colors",
                      provider === channel
                        ? "border-primary ring-2 ring-primary/50"
                        : "border-border hover:border-muted-foreground",
                    )}
                  >
                    {t(`upgradeDialog.provider.${channel}`)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* The checkout summary and the scan-to-pay block. Once an order exists the block shows
              the channel's real QR payload; before that it is the design's placeholder. */}
          {cycleEntry ? (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              {qrDataUrl ? (
                <div className="flex h-36 w-36 shrink-0 items-center justify-center rounded-lg border bg-card p-2 text-center">
                  {/* Drawn locally from the payload — the payment credential never leaves this
                      tab (the old public QR-render service was an egress nobody accepted). */}
                  <img
                    src={qrDataUrl}
                    alt={t("upgradeDialog.qrPlaceholder")}
                    className="h-full w-full object-contain"
                  />
                </div>
              ) : (
                <div className="flex h-36 w-36 shrink-0 items-center justify-center rounded-lg border border-dashed bg-ob-muted-surface/50 text-center">
                  <span className="text-muted-foreground text-xs">
                    {t("upgradeDialog.qrPlaceholder")}
                  </span>
                </div>
              )}
              <div className="flex-1 space-y-1 text-sm">
                <p className="font-medium">
                  {plan.name} · {cycleEntry.label}
                </p>
                <p className="tabular-nums">
                  {yuan(cycleEntry.priceCents)}
                  <span className="text-muted-foreground">
                    /{t(`upgradeDialog.unit.${cycleEntry.unit}`)}
                  </span>
                </p>
                <p className="text-muted-foreground text-xs">
                  {t("upgradeDialog.validUntil", {
                    date: formatDate(validUntilOf(cycleEntry.code)),
                  })}
                </p>
                {/* The renewal line says what v1 DOES: renewal is another purchase. The old
                    "到期前一天自动续费" promised a scheduler that does not exist. */}
                <p className="text-muted-foreground text-xs">
                  {t("upgradeDialog.autoRenew")}
                </p>
                {order ? (
                  <p
                    className={cn(
                      "text-xs",
                      order.status === "paid"
                        ? "text-success"
                        : "text-muted-foreground",
                    )}
                  >
                    {t(`upgradeDialog.orderStatus.${order.status}`)}
                    {order.activationState === "applied"
                      ? ` · ${t("upgradeDialog.applied")}`
                      : null}
                  </p>
                ) : null}
                {/* The way out of an abandoned checkout: cancel here, not by waiting out the
                    order's TTL — a pending order otherwise 409-blocks every new purchase. */}
                {order?.status === "pending" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={canceling}
                    onClick={() => void cancelOrder()}
                  >
                    {canceling
                      ? t("upgradeDialog.canceling")
                      : t("upgradeDialog.cancelOrder")}
                  </Button>
                ) : null}
                {purchaseBlocked ? (
                  <p className="text-muted-foreground text-xs" role="note">
                    {t("upgradeDialog.alreadySubscribed")}
                  </p>
                ) : null}
                {payError ? (
                  <p className="text-destructive text-xs" role="alert">
                    {payError}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
              className="mt-0.5"
            />
            <span>{t("upgradeDialog.agreement")}</span>
          </label>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("billing.cancel")}
          </Button>
          <Button
            disabled={
              !agreed ||
              !cycleEntry ||
              !provider ||
              !cycle ||
              paying ||
              canceling ||
              purchaseBlocked
            }
            onClick={() => void startCheckout()}
          >
            {paying ? t("upgradeDialog.paying") : t("upgradeDialog.pay")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A settled price, whole yuan — the design's prices are all round numbers. */
function yuan(cents: number): string {
  return `¥${(cents / 100).toLocaleString(undefined, {
    maximumFractionDigits: 0,
  })}`;
}

/**
 * When the period being bought ends: one cycle from today, the same date the design's summary
 * shows ("有效期至 2026-11-11"). The settled order carries its own period; this is the
 * pre-checkout estimate the summary shows beside it.
 */
function validUntilOf(code: PlanCatalogCycle["code"]): Date {
  const end = new Date();
  if (code === "recurring_yearly" || code === "yearly") {
    end.setFullYear(end.getFullYear() + 1);
  } else {
    end.setMonth(end.getMonth() + 1);
  }
  return end;
}

/** The summary's date, in the reader's locale. */
function formatDate(value: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(value);
}
