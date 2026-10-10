import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { credits, dateTime } from "@/lib/billing/format";
import { CreditBar } from "./credit-bar";

/**
 * The subscription card: what plan, one line of description, the upgrade and redeem entries, and
 * the plan's own base-credit allowance drawn as a bar with its reset time.
 *
 * The upgrade button opens the dialog; the redeem entry is the "使用兑换卡" path. Both are handed
 * in as callbacks — this card owns the plan's face, not the actions behind it.
 */
export function PlanCard({
  planName,
  planDescription,
  planCredits,
  resetsAt,
  onUpgrade,
  onRedeem,
}: {
  planName: string;
  planDescription?: string;
  planCredits: { total: number; used: number; remaining: number };
  resetsAt: string | null;
  onUpgrade?: () => void;
  onRedeem?: () => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">{planName}</p>
          {planDescription ? (
            <p className="text-muted-foreground mt-1 text-sm">{planDescription}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {onRedeem ? (
            <Button variant="ghost" size="sm" onClick={onRedeem}>
              {t("planCard.redeem")}
            </Button>
          ) : null}
          {onUpgrade ? (
            <Button size="sm" onClick={onUpgrade}>
              {t("planCard.upgrade")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-4">
        <p className="text-muted-foreground text-sm">{t("planCard.usageTitle")}</p>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-sm tabular-nums">
            {credits(planCredits.used)}/{credits(planCredits.total)}
            {t("creditsPage.creditUnit")}
            <span className="text-muted-foreground">
              （{t("planCard.baseCredits")}）
            </span>
          </span>
          <span className="text-sm tabular-nums">
            {credits(planCredits.remaining)}
            {t("creditsPage.remaining")}
          </span>
        </div>
        <CreditBar total={planCredits.total} used={planCredits.used} className="mt-2" />
        {resetsAt ? (
          <p className="text-muted-foreground mt-2 text-xs tabular-nums">
            {t("planCard.resetsAt", { time: dateTime(resetsAt) })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
