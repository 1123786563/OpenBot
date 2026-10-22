import type {
  BillingPaymentAnomaly,
  InvoiceFulfillment,
} from "@/lib/billing/invoices";

/*
 * The payment record's progress vocabulary as the reader meets it (BP07, #375).
 *
 * The server stores delivery progress and anomaly events as STABLE CODES — the activation
 * failure words BP03 writes (`ownership_unresolved`, `grant_write_failed`, …) and the
 * `PaymentAnomalyCode` table the settlement refusals record with (`duplicate_paid`,
 * `over_paid`, …). Those codes are for machines and support; the record owes the reader a
 * sentence. This module is the one place that translates, the same discipline
 * pending-settlement-reasons.ts set: a CLOSED map per vocabulary, and a FALLBACK for every
 * code nobody mapped — a raw internal word can never leak into the DOM as-is, and a new
 * server code lands here with its sentence in the same change or reads as the fallback
 * (honest: something is being worked on), never as the code itself.
 *
 * The i18n keys are literal unions, spelled out rather than template-built, for the same
 * reason orders-view's SOURCE_LABELS spells its sources: i18next's `t` is typed over the keys
 * it can actually find, so a missing translation is a build error rather than a chip reading
 * "ordersPage.fulfillment.reason.plan".
 */

/** The delivery-progress sentences, keyed by the state the wire spells. */
export const FULFILLMENT_COPY_KEYS = {
  // The spec's own sentence: 收款已确认、交付未完成——处理中，不是“支付成功”。
  processing: "ordersPage.fulfillment.processing",
  delivered: "ordersPage.fulfillment.delivered",
  // 重复收款/确定性冲突：运营的队列，明确待处置，绝不显示为完成。
  needs_resolution: "ordersPage.fulfillment.needs_resolution",
} as const satisfies Record<
  NonNullable<InvoiceFulfillment["state"]>,
  `ordersPage.fulfillment.${string}`
>;

/** The closed map: activation failure word → its i18n key, spelled out for the typed `t`. */
const ACTIVATION_FAILURE_COPY_KEYS = {
  ownership_unresolved: "ordersPage.fulfillment.reason.ownership_unresolved",
  duplicate_paid: "ordersPage.fulfillment.reason.duplicate_paid",
  plan_not_found: "ordersPage.fulfillment.reason.plan_not_found",
  plan_interval_mismatch:
    "ordersPage.fulfillment.reason.plan_interval_mismatch",
  grant_no_period: "ordersPage.fulfillment.reason.grant_no_period",
  grant_write_failed: "ordersPage.fulfillment.reason.grant_write_failed",
  stamp_no_period: "ordersPage.fulfillment.reason.stamp_no_period",
  stamp_missing: "ordersPage.fulfillment.reason.stamp_missing",
  stamp_failed: "ordersPage.fulfillment.reason.stamp_failed",
  provider_unreachable: "ordersPage.fulfillment.reason.provider_unreachable",
} as const satisfies Record<string, `ordersPage.fulfillment.reason.${string}`>;

/** The i18n keys a failure word can render under — the fallback closes the union. */
export type ActivationFailureCopyKey =
  | (typeof ACTIVATION_FAILURE_COPY_KEYS)[keyof typeof ACTIVATION_FAILURE_COPY_KEYS]
  | "ordersPage.fulfillment.reason.unmapped";

/** A failure word's i18n key, or the fallback when the word is not in the closed map. */
export function activationFailureCopyKey(
  reason: string,
): ActivationFailureCopyKey {
  return (
    (ACTIVATION_FAILURE_COPY_KEYS as Record<string, ActivationFailureCopyKey>)[
      reason
    ] ?? "ordersPage.fulfillment.reason.unmapped"
  );
}

/** The closed map: anomaly code → its i18n key, spelled out for the typed `t`. */
const ANOMALY_COPY_KEYS = {
  amount_mismatch: "ordersPage.anomaly.amount_mismatch",
  paid_after_blocked: "ordersPage.anomaly.paid_after_blocked",
  over_paid: "ordersPage.anomaly.over_paid",
  duplicate_paid: "ordersPage.anomaly.duplicate_paid",
  late_payment: "ordersPage.anomaly.late_payment",
  amount_unreadable: "ordersPage.anomaly.amount_unreadable",
  currency_mismatch: "ordersPage.anomaly.currency_mismatch",
  activation_retry_exhausted: "ordersPage.anomaly.activation_retry_exhausted",
  unowned_payout: "ordersPage.anomaly.unowned_payout",
  callback_unverified: "ordersPage.anomaly.callback_unverified",
} as const satisfies Record<string, `ordersPage.anomaly.${string}`>;

/** The i18n keys an anomaly code can render under — the fallback closes the union. */
export type AnomalyCopyKey =
  | (typeof ANOMALY_COPY_KEYS)[keyof typeof ANOMALY_COPY_KEYS]
  | "ordersPage.anomaly.unmapped";

/** An anomaly code's i18n key, or the fallback when the code is not in the closed map. */
export function anomalyCopyKey(code: string): AnomalyCopyKey {
  return (
    (ANOMALY_COPY_KEYS as Record<string, AnomalyCopyKey>)[code] ??
    "ordersPage.anomaly.unmapped"
  );
}

/**
 * The anomaly lines one record shows, deduplicated by code with a count — the SAME word
 * recorded twice (a retried duplicate callback) is one line that says twice, not two lines
 * that say the same thing. Order is first-occurrence order: the oldest event opens the case.
 */
export function anomalyLines(
  anomalies: readonly BillingPaymentAnomaly[],
): { code: string; count: number; copyKey: AnomalyCopyKey }[] {
  const byCode = new Map<string, { code: string; count: number }>();
  for (const anomaly of anomalies) {
    const entry = byCode.get(anomaly.code) ?? { code: anomaly.code, count: 0 };
    entry.count += 1;
    byCode.set(anomaly.code, entry);
  }
  return [...byCode.values()].map((entry) => ({
    ...entry,
    copyKey: anomalyCopyKey(entry.code),
  }));
}
