import { useTranslation } from "react-i18next";
import { period } from "@/lib/billing/format";
import { cn } from "@/lib/utils";

/** The deployment's current subscription, one card: what, how alive, until when. */
export function SubscriptionHero({
  planCode,
  status,
  currentPeriodStart,
  currentPeriodEnd,
}: {
  planCode: string;
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
}) {
  const { t } = useTranslation("settings");
  const active = status === "active";
  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">{t("billing.heroTitle")}</p>
        <span
          className={cn(
            "rounded-full px-2.5 py-0.5 text-xs font-medium",
            active
              ? "bg-success/10 text-success"
              : "bg-muted text-muted-foreground",
          )}
        >
          {active ? t("billing.statusActive") : t("billing.statusOther")}
        </span>
      </div>
      <p className="mt-1 font-mono text-lg font-semibold">{planCode}</p>
      {currentPeriodStart && currentPeriodEnd ? (
        <p className="text-muted-foreground mt-1 text-sm tabular-nums">
          {t("billing.periodLabel")} · {period(currentPeriodStart, currentPeriodEnd)}
        </p>
      ) : null}
    </div>
  );
}
