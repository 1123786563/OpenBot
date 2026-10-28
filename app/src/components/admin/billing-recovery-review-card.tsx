import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { client } from "@/lib/client";

/**
 * The administrator's settlement-anomaly review (Bifrost 08.8, #283).
 *
 * THIS CARD READS, IT NEVER DISPOSES. The anomaly queue it lists is waiting for 08.9's
 * evidenced disposal — a separately authorized command with its own gate — so there is no
 * settle button, no release button, and no route for one to call: a review surface that
 * could act would put a money decision one click away from the judgment that is supposed
 * to precede it (the same discipline the cleanup execution card keeps, for the same
 * reason). What an administrator needs here is the answer to "what is stuck, whose
 * account does it hold, how much is the ceiling, how long has it waited, and what did
 * the provider say when asked" — each item with the bounded evidence 08.5 recorded.
 *
 * The answer is redacted by construction: account refs are the payer layer's opaque keys,
 * the reason is the item's stable code, and the evidence rows are the bounded excerpts
 * the query handler wrote — never a credential, never another account's row.
 */

/** One evidence row the provider-query pass (08.5) recorded for an item. */
type RecoveryEvidenceView = {
  conclusion: "settled_evidence" | "no_charge_evidence" | "still_unknown";
  source: string;
  summary: string;
  usageInput: number | null;
  usageOutput: number | null;
  queriedAt: string;
};

/** One recovery item, as the read route builds it (08.8's produced contract). */
type RecoveryItemView = {
  itemId: string;
  attemptId: string;
  reservationId: string;
  accountRef: string;
  payerKind: string | null;
  payerId: string | null;
  provider: string | null;
  model: string | null;
  maximumCredits: number;
  failureCount: number;
  lastReason: string | null;
  state: "pending" | "claimed";
  detectedAt: string;
  dwellSeconds: number;
  evidence: RecoveryEvidenceView[];
};

/** A dwell in hours-and-minutes, the resolution an operator triages by. */
function dwellText(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) {
    return `${minutes}m`;
  }
  return `${hours}h ${minutes}m`;
}

/** One labelled fact, so an item reads as a sheet rather than a sentence. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-medium break-all">{value}</span>
    </div>
  );
}

/** The conclusion's badge color: settled is information, no-charge is a release
 * candidate (for 08.9 to act on — never this page), unknown is the open question. */
function conclusionClass(
  conclusion: RecoveryEvidenceView["conclusion"],
): string {
  if (conclusion === "settled_evidence") {
    return "bg-sky-100 text-sky-900 rounded px-2 py-0.5 text-xs font-medium";
  }
  if (conclusion === "no_charge_evidence") {
    return "bg-emerald-100 text-emerald-900 rounded px-2 py-0.5 text-xs font-medium";
  }
  return "bg-amber-100 text-amber-900 rounded px-2 py-0.5 text-xs font-medium";
}

export function BillingRecoveryReviewCard() {
  const { t } = useTranslation("admin");
  const review = useQuery({
    queryKey: ["billing", "recovery-items"],
    queryFn: () =>
      client("/api/admin/billing/recovery-items", {
        fallbackKey: "billing.loadRecoveryReview",
      }).then(
        (response) => response.json() as Promise<{ items: RecoveryItemView[] }>,
      ),
  });

  if (review.isPending) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("recoveryReview.loading")}
      </p>
    );
  }
  if (review.isError) {
    return (
      <p className="text-destructive text-sm" role="alert">
        {t("recoveryReview.loadProblem")}
      </p>
    );
  }
  const items = review.data.items;
  if (items.length === 0) {
    return (
      <p
        className="text-muted-foreground text-sm"
        data-testid="recovery-review-empty"
      >
        {t("recoveryReview.empty")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4" data-testid="recovery-review-list">
      {items.map((item) => (
        <div
          key={item.itemId}
          className="flex flex-col gap-3 rounded-lg border p-4"
          data-testid="recovery-review-item"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium">
              {t("recoveryReview.state")}: {item.state}
            </span>
            <span className="text-muted-foreground text-xs">
              {item.model ?? "unknown model"}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Fact label={t("recoveryReview.account")} value={item.accountRef} />
            <Fact
              label={t("recoveryReview.ceiling")}
              value={`${(item.maximumCredits / 100).toFixed(2)}`}
            />
            <Fact
              label={t("recoveryReview.dwell")}
              value={dwellText(item.dwellSeconds)}
            />
            <Fact
              label={t("recoveryReview.failures")}
              value={String(item.failureCount)}
            />
          </div>
          <Fact
            label={t("recoveryReview.reason")}
            value={item.lastReason ?? "—"}
          />
          <div className="flex flex-col gap-2">
            <span className="text-muted-foreground text-xs">
              {t("recoveryReview.evidence")}
            </span>
            {item.evidence.length === 0 ? (
              <span className="text-muted-foreground text-xs">
                {t("recoveryReview.evidenceEmpty")}
              </span>
            ) : (
              item.evidence.map((row) => (
                <div
                  key={`${item.itemId}-${row.queriedAt}-${row.summary}`}
                  className="flex flex-col gap-1 text-xs"
                  data-testid="recovery-review-evidence"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={conclusionClass(row.conclusion)}>
                      {row.conclusion}
                    </span>
                    <span className="text-muted-foreground">
                      {row.source} · {row.queriedAt}
                    </span>
                    {row.usageInput !== null && row.usageOutput !== null ? (
                      <span className="text-muted-foreground">
                        {t("recoveryReview.usage")}: {row.usageInput}/
                        {row.usageOutput}
                      </span>
                    ) : null}
                  </div>
                  <span className="break-all">{row.summary}</span>
                </div>
              ))
            )}
          </div>
        </div>
      ))}
      <p className="text-muted-foreground text-xs">
        {t("recoveryReview.noWriteActions")}
      </p>
    </div>
  );
}
