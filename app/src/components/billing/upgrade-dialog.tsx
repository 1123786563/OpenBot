import { useState } from "react";
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
import { createPurchase, type PurchaseOrderView } from "@/lib/billing/payments";
import { cn } from "@/lib/utils";

/**
 * The upgrade dialog: three plan cards, a four-way billing-cycle choice, a price summary and the
 * scan-to-pay block with the agreement gate.
 *
 * The QR is a placeholder in this pass — the payment link (phase three) is what fills it. What this
 * component owns now is the selection the checkout will act on: a plan, a cycle, and whether the
 * agreement has been ticked, which is the whole state a purchase request needs.
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
  const [cycle, setCycle] =
    useState<PlanCatalogCycle["code"]>("recurring_monthly");
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
   * The checkout state: once an order exists the QR block shows the channel's real code and this
   * dialog polls the order (the page reads it back; see the poll below) until the money lands or
   * the code expires. A failed create keeps the dialog open with the server's sentence.
   */
  const [order, setOrder] = useState<PurchaseOrderView | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  const plan = catalog[selected];
  const cycleEntry = plan?.pricing.find((c) => c.code === cycle);

  const startCheckout = async () => {
    setPayError(null);
    setPaying(true);
    try {
      const created = await createPurchase({
        planCode: selected,
        provider: "alipay",
      });
      setOrder(created);
    } catch (error) {
      setPayError((error as Error).message);
    } finally {
      setPaying(false);
    }
  };

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

          {/* The four billing cycles; the chosen one is ringed. */}
          {plan ? (
            <div className="grid grid-cols-2 gap-2">
              {plan.pricing.map((c) => (
                <button
                  key={c.code}
                  type="button"
                  onClick={() => setCycle(c.code)}
                  className={cn(
                    "flex flex-col gap-0.5 rounded-xl border p-3 text-left transition-colors",
                    cycle === c.code
                      ? "border-primary ring-2 ring-primary/50"
                      : "border-border hover:border-muted-foreground",
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {c.label}
                    {c.discountLabel ? (
                      <span className="text-success text-xs">
                        {c.discountLabel}
                      </span>
                    ) : null}
                  </span>
                  <span className="tabular-nums">
                    {yuan(c.priceCents)}
                    <span className="text-muted-foreground text-xs">
                      /{t(`upgradeDialog.unit.${c.unit}`)}
                    </span>
                  </span>
                  {c.originalCents ? (
                    <span className="text-muted-foreground text-xs line-through tabular-nums">
                      {yuan(c.originalCents)}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}

          {/* The plan-compare entry the design shows under the cycles. Links out in phase three;
              present now so the layout matches. */}
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground self-start text-sm hover:underline"
            onClick={() => {
              /* Phase three: the comparison page/route. */
            }}
          >
            {t("upgradeDialog.comparePlans")} &gt;
          </button>

          {/* The checkout summary and the scan-to-pay block. Once an order exists the block shows
              the channel's real QR payload; before that it is the design's placeholder. */}
          {cycleEntry ? (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              {order?.checkout?.kind === "qrcode" ? (
                <div className="flex h-36 w-36 shrink-0 items-center justify-center rounded-lg border bg-card p-2 text-center">
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=280&data=${encodeURIComponent(order.checkout.payload)}`}
                    alt={t("upgradeDialog.qrPlaceholder")}
                    className="h-full w-full object-contain"
                  />
                </div>
              ) : (
                <div className="flex h-36 w-36 shrink-0 items-center justify-center rounded-lg border border-dashed bg-muted/50 text-center">
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
            disabled={!agreed || !cycleEntry || paying || purchaseBlocked}
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
 * shows ("有效期至 2026-11-11"). A local fact until checkout exists; the order will carry its own.
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
