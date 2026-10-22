import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { CreditGrantEntry } from "@/lib/billing/credits";
import { credits, dateTime } from "@/lib/billing/format";
import { cn } from "@/lib/utils";
import { CreditBar } from "./credit-bar";

/**
 * The reward-grant row's status tones: one distinction, like the invoice pill keeps — only the
 * active state gets ink, the two ended states stay neutral chips. A grant about to lapse shows
 * the red "24小时内过期" cue — that is the one thing a reader must act on.
 */
const STATUS_TONE: Record<CreditGrantEntry["status"], string> = {
  active: "bg-success/10 text-success",
  exhausted: "bg-ob-muted-surface text-muted-foreground",
  expired: "bg-ob-muted-surface text-muted-foreground",
};

/**
 * One grant row: its balance, its life and its reason.
 *
 * Extracted (ticket 10.6) so the orders page renders exactly the row the rewards block renders
 * plus two optional slots — the grant's source, and where its credits came from. With both
 * absent this is the row this file has always drawn, unchanged.
 */
export function CreditGrantRow({
  grant,
  sourceLabel,
  trace,
}: {
  grant: CreditGrantEntry;
  /** The grant's source in the caller's words — a purchase, a check-in, a campaign. */
  sourceLabel?: string;
  /** Drawn after the reason line: the orders page's trace to the grant's funding order. */
  trace?: ReactNode;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex flex-wrap items-center gap-2">
          {sourceLabel ? (
            <span className="rounded-full bg-ob-muted-surface px-2.5 py-0.5 text-xs font-medium whitespace-nowrap text-muted-foreground">
              {sourceLabel}
            </span>
          ) : null}
          <span className="text-sm tabular-nums">
            {credits(grant.used)}/{credits(grant.total)}
            {t("creditsPage.creditUnit")}
          </span>
          <span
            className={cn(
              "rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
              STATUS_TONE[grant.status],
            )}
          >
            {t(`creditsPage.grantStatus.${grant.status}`)}
          </span>
          {grant.expiringSoon ? (
            <span className="text-destructive text-xs font-medium">
              {t("creditsPage.expiringSoon")}
            </span>
          ) : null}
        </div>
        <span className="text-muted-foreground text-xs tabular-nums">
          {t("creditsPage.expiresAt", {
            time: dateTime(grant.expiresAt),
          })}
        </span>
      </div>

      <CreditBar total={grant.total} used={grant.used} className="mt-2.5" />

      {grant.reason ? (
        <p className="text-muted-foreground mt-2 text-xs">
          {t("creditsPage.reason", { reason: grant.reason })}
        </p>
      ) : null}
      {trace}
    </div>
  );
}

/**
 * The reward-grant block: one row per grant, with its balance, its life and its reason, and a
 * summary line underneath.
 */
export function CreditGrantList({
  grants,
  grantCount,
  remaining,
  held,
  onViewAll,
}: {
  grants: readonly CreditGrantEntry[];
  grantCount: number;
  remaining: number;
  held: number;
  onViewAll?: () => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div>
      <div className="space-y-3">
        {grants.map((grant) => (
          <CreditGrantRow key={grant.id} grant={grant} />
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <span className="text-sm tabular-nums">
          {t("creditsPage.rewardsSummary", {
            count: grantCount,
            remaining: credits(remaining),
            held: credits(held),
          })}
        </span>
        {onViewAll ? (
          <button
            type="button"
            onClick={onViewAll}
            className="text-sm font-medium hover:underline"
          >
            {t("creditsPage.viewAll")} &gt;
          </button>
        ) : null}
      </div>
    </div>
  );
}
