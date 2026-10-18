import { useTranslation } from "react-i18next";
import type { PersonalCreditBalance } from "@/lib/billing/credits";
import { credits } from "@/lib/billing/format";

/**
 * The personal credit account card (ticket 02.7): the account type the server named, the four
 * numbers a reader acts on — available, consumed, expired and the holds the admission gate lives
 * by — and the pending-settlement line.
 *
 * The account type is always rendered from the answer, never assumed: 02.6's contract names the
 * account in the response (`accountType: "personal"`) so the page can never dress someone else's
 * numbers under a wrong label. Every figure on this card comes from the one server read; the card
 * has no defaults to fall into, so a failed read renders the page's LoadError instead of this
 * component — a failure never becomes a zero here.
 */
export function PersonalBalanceCard({
  balance,
}: {
  balance: PersonalCreditBalance;
}) {
  const { t } = useTranslation("settings");
  const stats = [
    { label: t("creditsPage.statAvailable"), value: balance.available },
    { label: t("creditsPage.statConsumed"), value: balance.consumed },
    { label: t("creditsPage.statExpired"), value: balance.expired },
    { label: t("creditsPage.statHeld"), value: balance.held },
  ];
  const ledgerEmpty =
    balance.grants.length === 0 && stats.every((stat) => stat.value === 0);

  return (
    <div
      className="rounded-xl border bg-card p-5"
      data-testid="personal-balance"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className="rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success"
          data-testid="account-type"
        >
          {balance.accountType === "personal"
            ? t("creditsPage.accountTypePersonal")
            : balance.accountType}
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label}>
            <dt className="text-muted-foreground text-xs">{stat.label}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">
              {credits(stat.value)}
              <span className="text-muted-foreground ml-1 text-xs font-normal">
                {t("creditsPage.creditUnit")}
              </span>
            </dd>
          </div>
        ))}
      </dl>

      {/*
       * Pending settlement is group 06's answer (ticket 06.12): the quota, its reserved vs
       * unknown split, and the latest reservations with status and reason each. A pre-06.12
       * server's `enabled: false` still renders the honest 未启用 marker — never a bare 0.
       * Both branches keep the same testid: the server's gate is the visible contract change
       * that routes answers into the amounts branch.
       */}
      {balance.pendingSettlement.enabled ? (
        <>
          <p
            className="text-muted-foreground mt-4 text-sm tabular-nums"
            data-testid="pending-settlement"
          >
            {t("creditsPage.pendingSettlement")}{" "}
            {credits(balance.pendingSettlement.available)}
            <span className="ml-2">
              {t("creditsPage.pendingReserved")}{" "}
              {credits(balance.pendingSettlement.reserved)}
            </span>
            <span className="ml-2">
              {t("creditsPage.pendingUnknown")}{" "}
              {credits(balance.pendingSettlement.unknown)}
            </span>
          </p>
          {balance.pendingSettlement.reservations.length > 0 ? (
            <ul className="mt-2 space-y-1" data-testid="reservation-list">
              {balance.pendingSettlement.reservations.map((reservation) => (
                <li
                  key={reservation.id}
                  className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
                  data-status={reservation.status}
                  data-testid="reservation-row"
                >
                  <span
                    className={
                      reservation.status === "unknown"
                        ? "font-medium text-warning"
                        : undefined
                    }
                    data-testid="reservation-status"
                  >
                    {t(`creditsPage.reservationStatus.${reservation.status}`)}
                  </span>
                  <span className="tabular-nums">
                    {credits(reservation.maximum)}
                    {t("creditsPage.creditUnit")}
                  </span>
                  <span>
                    {[reservation.botName, reservation.model]
                      .filter(Boolean)
                      .join(" · ") || "–"}
                  </span>
                  {reservation.unknownReason || reservation.releaseReason ? (
                    <span className="truncate">
                      {t("creditsPage.reservationReason")}
                      {reservation.unknownReason ?? reservation.releaseReason}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p
          className="text-muted-foreground mt-4 text-sm tabular-nums"
          data-testid="pending-settlement"
        >
          {t("creditsPage.pendingSettlementDisabled")}
        </p>
      )}

      {/*
       * An account with no records yet: the zeros above are true facts (the ledger has nothing),
       * and this sentence keeps them from reading as a failure or a placeholder (AC: 空态文案
       * 明确，不显示误导性 0). An account WITH records shows no such note — its zeros are real.
       */}
      {ledgerEmpty ? (
        <p
          className="text-muted-foreground mt-2 text-sm"
          data-testid="empty-ledger"
        >
          {t("creditsPage.emptyLedger")}
        </p>
      ) : null}
    </div>
  );
}
