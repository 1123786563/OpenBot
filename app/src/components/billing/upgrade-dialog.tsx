import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { credits } from "@/lib/billing/format";
import type {
  PlanCatalogCycle,
  PlanCatalogEntry,
} from "@/lib/billing/credits";
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: Record<string, PlanCatalogEntry>;
  currentPlanName?: string;
}) {
  const { t } = useTranslation("settings");
  const entries = Object.entries(catalog);
  const [selected, setSelected] = useState<string>(entries[0]?.[0] ?? "");
  const [cycle, setCycle] = useState<PlanCatalogCycle["code"]>(
    "recurring_monthly",
  );
  const [agreed, setAgreed] = useState(false);

  const plan = catalog[selected];
  const cycleEntry = plan?.pricing.find((c) => c.code === cycle);

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
                      <span className="text-success text-xs">{c.discountLabel}</span>
                    ) : null}
                  </span>
                  <span className="tabular-nums">
                    {yuan(c.priceCents)}
                    <span className="text-muted-foreground text-xs">/{t(`upgradeDialog.unit.${c.unit}`)}</span>
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

          {/* The checkout summary and the scan-to-pay placeholder. */}
          {cycleEntry ? (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="flex h-36 w-36 shrink-0 items-center justify-center rounded-lg border border-dashed bg-muted/50 text-center">
                <span className="text-muted-foreground text-xs">
                  {t("upgradeDialog.qrPlaceholder")}
                </span>
              </div>
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
                  {t("upgradeDialog.autoRenew")}
                </p>
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
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("billing.cancel")}
          </Button>
          <Button disabled={!agreed || !cycleEntry}>
            {t("upgradeDialog.pay")}
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
