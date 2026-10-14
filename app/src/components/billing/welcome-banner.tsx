import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/**
 * The one-time welcome offer: a first-month grant, with a time-boxed bonus badge and a claim
 * button that flips to "claimed on <date>" once the grant has been taken.
 *
 * The claim itself is a write the page hands off through `onClaim`; this component owns only the
 * two faces of the banner and the badge, because "claimed" is a fact the deployment remembers and
 * the page receives, not something the banner decides.
 */
export function WelcomeBanner({
  claimed,
  claimedAt,
  onClaim,
}: {
  claimed: boolean;
  /** The date the claim landed, shown as "5月13日已领取". */
  claimedAt?: string;
  onClaim?: () => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="relative rounded-xl border bg-card p-5">
      <span className="bg-success/10 text-success absolute -top-2.5 left-4 rounded-full px-2.5 py-0.5 text-xs font-medium">
        {t("welcomeBanner.badge")}
      </span>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm">{t("welcomeBanner.message")}</p>
        {claimed ? (
          <span className="text-muted-foreground text-sm">
            {t("welcomeBanner.claimed", {
              date: claimedAt
                ? new Intl.DateTimeFormat(undefined, {
                    month: "numeric",
                    day: "numeric",
                  }).format(new Date(claimedAt))
                : "",
            })}
          </span>
        ) : onClaim ? (
          <Button size="sm" onClick={onClaim}>
            {t("welcomeBanner.claim")}
          </Button>
        ) : (
          /*
           * No claim write wired: the banner still tells the reader the offer exists, but the
           * button cannot beg to be clicked and then do nothing (the field finding) — it is
           * disabled and the sentence beside it says the claim is not open yet.
           */
          <span className="flex items-center gap-2">
            <Button size="sm" disabled>
              {t("welcomeBanner.claim")}
            </Button>
            <span className="text-muted-foreground text-xs">
              {t("welcomeBanner.claimUnavailable")}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
