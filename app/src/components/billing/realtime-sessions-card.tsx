import { useTranslation } from "react-i18next";
import { credits } from "@/lib/billing/format";
import type { RealtimeSessionUsage } from "@/lib/billing/realtime";

/**
 * The realtime session consumption rows (Bifrost 15.8, #321): what each of the reader's own
 * realtime sessions consumed, what still awaits settlement, and why a session is abnormal —
 * the reason the DOORS wrote (15.5's stop, 15.6's close), translated through the closed
 * vocabulary below, never a raw internal string.
 *
 * THE LIST IS THE PERSON'S OWN. The query this card renders answers the session-resolved
 * payer (the same rule every credits read keeps), so there is nothing here to filter: the
 * component renders exactly the sessions the server said, and the reason copy is the one
 * place a door's code becomes a sentence — an unmapped code reads as the fallback, honest
 * without diagnosing (the pending-settlement reasons module's own rule).
 */

/** The abnormal reasons the page has a specific sentence for; everything else falls back. */
const STOPPED_REASON_COPY_KEYS: ReadonlySet<string> = new Set([
  "insufficient_credits",
]);

const CLOSED_REASON_COPY_KEYS: ReadonlySet<string> = new Set([
  "grant_invalid",
  "payer_conflict",
  "payer_unresolved",
]);

/** The i18n key for one abnormal verdict, or the fallback — never the raw code. */
export function realtimeAbnormalCopyKey(
  abnormal: RealtimeSessionUsage["abnormal"],
): string {
  if (abnormal === null) return "creditsPage.realtimeAbnormalNone";
  const known =
    abnormal.kind === "stopped"
      ? STOPPED_REASON_COPY_KEYS.has(abnormal.reason)
      : CLOSED_REASON_COPY_KEYS.has(abnormal.reason);
  if (!known) return "creditsPage.realtimeAbnormalFallback";
  return `creditsPage.realtimeAbnormal_${abnormal.kind}_${abnormal.reason}`;
}

export function RealtimeSessionsCard({
  sessions,
}: {
  sessions: RealtimeSessionUsage[];
}) {
  const { t } = useTranslation("settings");
  if (sessions.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("creditsPage.realtimeEmpty")}
      </p>
    );
  }
  return (
    <ul className="mt-4 divide-y">
      {sessions.map((session) => (
        <li
          key={session.sessionId}
          className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0"
          data-testid="realtime-session-row"
          data-session-state={session.state}
        >
          <div className="min-w-44 flex-1">
            <p className="text-sm font-medium">{session.model}</p>
            <p className="text-muted-foreground text-xs">
              {t("creditsPage.realtimeStartedAt", {
                time: new Date(session.startedAt).toLocaleString(),
              })}
            </p>
          </div>
          <div className="text-sm">
            <p>
              <span className="text-muted-foreground">
                {t("creditsPage.realtimeConsumed")}
              </span>{" "}
              {credits(session.consumedCents / 100)}
            </p>
            <p>
              <span className="text-muted-foreground">
                {t("creditsPage.realtimePending")}
              </span>{" "}
              {credits(session.pendingCents / 100)}
            </p>
          </div>
          <div className="text-muted-foreground text-xs">
            {t("creditsPage.realtimeUnits", {
              settled: session.units.settled,
              holding: session.units.holding,
              unknown: session.units.unknown,
            })}
          </div>
          <span
            className={
              session.abnormal === null
                ? "text-muted-foreground text-xs"
                : "text-destructive text-xs"
            }
            data-testid="realtime-session-status"
          >
            {session.abnormal === null
              ? t(
                  session.state === "open"
                    ? "creditsPage.realtimeStateOpen"
                    : "creditsPage.realtimeStateClosed",
                )
              : t(realtimeAbnormalCopyKey(session.abnormal) as never)}
          </span>
        </li>
      ))}
    </ul>
  );
}
