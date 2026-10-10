import { IconCircleCheck } from "@tabler/icons-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { QrCode } from "@/components/billing/qr-code";
import type { PurchaseOrderView } from "@/lib/billing/payments";
import { cn } from "@/lib/utils";

/** mm:ss against the QR's own expiry. */
function remaining(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The order in flight, from QR to outcome: presentation only — the polling that keeps this honest
 * lives in the page that owns the order.
 */
export function CheckoutCard({
  view,
  now,
  onCancel,
  cancelPending,
  cancelError,
  onDismiss,
}: {
  view: PurchaseOrderView;
  now: number;
  onCancel: () => void;
  cancelPending: boolean;
  cancelError: string | null;
  onDismiss: () => void;
}) {
  const { t } = useTranslation("settings");

  if (view.status !== "pending") {
    const paid = view.status === "paid";
    const text = (() => {
      if (paid) {
        if (view.activationState === "applied") return t("subscribe.statusPaid");
        if (view.activationState === "pending") return t("subscribe.statusPaidActivating");
        return t("subscribe.statusPaidFailed");
      }
      if (view.status === "canceled") return t("subscribe.statusCanceled");
      if (view.status === "expired") return t("subscribe.statusExpired");
      return t("subscribe.statusBlocked");
    })();
    const good = paid && view.activationState === "applied";
    return (
      <div className="flex flex-col items-center py-8 text-center">
        {good ? (
          <motion.div
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 260, damping: 18 }}
          >
            <IconCircleCheck className="text-success size-12" />
          </motion.div>
        ) : null}
        <p className="mt-3 text-sm">{text}</p>
        <Button size="sm" className="mt-4" onClick={onDismiss}>
          {t("subscribe.backToPlans")}
        </Button>
      </div>
    );
  }

  const expiredLocally = Date.parse(view.expiresAt) <= now;
  const qr =
    view.checkout?.kind === "qrcode" && !expiredLocally ? view.checkout : null;

  if (expiredLocally) {
    return (
      <div className="flex flex-col items-center py-8 text-center">
        <p className="text-sm">{t("subscribe.statusExpired")}</p>
        <Button size="sm" className="mt-4" onClick={onDismiss}>
          {t("subscribe.backToPlans")}
        </Button>
      </div>
    );
  }

  // The bar's denominator is the order's own lifetime, so a resumed order starts mid-bar.
  const totalMs = Math.max(1, Date.parse(view.expiresAt) - Date.parse(view.createdAt));
  const remainingMs = Math.max(0, Date.parse(view.expiresAt) - now);
  const pct = Math.max(0, Math.min(1, remainingMs / totalMs));

  return (
    <div className="flex flex-col items-center py-4">
      {qr ? <QrCode payload={qr.payload} /> : null}
      <div
        role="progressbar"
        aria-label={t("subscribe.countdownAria")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct * 100)}
        className="bg-muted mt-4 h-1.5 w-full max-w-xs overflow-hidden rounded-full"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-1000 ease-linear",
            pct < 0.2 ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${pct * 100}%` }}
        />
      </div>
      <p className="mt-2 text-sm tabular-nums">
        {t("subscribe.expiresIn", { time: remaining(view.expiresAt, now) })}
      </p>
      <p className="text-muted-foreground mt-1 text-sm">{t("subscribe.statusPending")}</p>
      <div className="mt-4">
        <Button variant="outline" size="sm" disabled={cancelPending} onClick={onCancel}>
          {t("subscribe.cancel")}
        </Button>
        {cancelError ? (
          <p className="text-destructive mt-2 text-sm">{cancelError}</p>
        ) : null}
      </div>
    </div>
  );
}
