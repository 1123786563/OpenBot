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
       * Pending settlement is group 06's lane. Until that group's work is delivered the server
       * sends the placeholders (constant zeros behind `enabled: false`), and this page says
       * 未启用 — not 0, because a zero would claim a settled fact about calls that have not
       * happened. Both branches keep the same testid: group 06 flipping the server's literal
       * `false` is the visible contract change that routes answers into the amounts branch.
       */}
      <p
        className="text-muted-foreground mt-4 text-sm tabular-nums"
        data-testid="pending-settlement"
      >
        {balance.pendingSettlement.enabled
          ? // Group 06 lands here: amounts once the server's gate is on.
            `${t("creditsPage.pendingSettlement")} ${credits(balance.pendingSettlement.available)}`
          : t("creditsPage.pendingSettlementDisabled")}
      </p>

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
