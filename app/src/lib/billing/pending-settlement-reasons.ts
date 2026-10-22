/**
 * The pending-settlement reason vocabulary as the person's balance page reads it
 * (Bifrost 08.7, #282).
 *
 * The server stores WHY a hold is pending as a stable code (`unknown_reason` /
 * `release_reason` — 06.8's mark, the recovery scan's detections, the settlement failure
 * codes, the confirmed-no-cost releases). Those codes are for machines and support; the
 * page owes the reader a sentence. This module is the one place that translates, so the
 * mapping follows the server's code tables the way the ticket's rule demands — and a code
 * nobody mapped can never leak through as-is.
 *
 * THE REDACTION IS THE DESIGN, not a filter bolted on: `pendingSettlementReasonCopyKey`
 * answers an i18n key for the closed vocabulary below and the FALLBACK key for everything
 * else — a raw internal error string a future writer might leave, a typo'd code, anything.
 * The component renders only the translated copy, so the DOM can carry the raw text of
 * neither an unmapped code nor an internal detail. The fallback says what is true (the
 * item is being reconciled and updates when it completes) without diagnosing anything.
 *
 * KEEP IN SYNC WITH THE WRITERS (the ticket's 08.5/08.6 code-table rule): unknown-mark
 * reasons come from the stream failure path (`usage_missing`, `stream_error`, `cancelled`,
 * the settlement charge refusals) and the recovery scan's DETECTION_REASONS
 * (`dispatch_result_unknown`, `hold_expired_without_result`); release reasons are the
 * confirmed-no-cost vocabulary (usage-evidence.ts's CONFIRMED_NO_COST_REASONS). A new
 * server code lands here with its sentence in the same change, or it reads as the
 * fallback — honest, but the reader deserves the specific sentence.
 */

/** The reason codes the page has a specific sentence for, per status it may ride on. */
const UNKNOWN_REASON_COPY_KEYS: ReadonlySet<string> = new Set([
  // 06.8's unknown mark, written by the stream failure path.
  "usage_missing",
  "stream_error",
  "cancelled",
  // The settlement charge refusals that keep a hold occupied (copilot's settle-fail codes).
  "usage_invalid",
  "usage_over_bound",
  "usage_charge_failed",
  // The recovery scan's detection vocabulary (recovery-scan.ts's DETECTION_REASONS).
  "dispatch_result_unknown",
  "hold_expired_without_result",
  // The async lanes' own marks (17.2/17.3's lost dispatch answer, 17.7's unknown cancel
  // result) — the jobs page's waiting states read through this same table.
  "async_dispatch_answer_lost",
  "async_cancel_result_unknown",
]);

/** The confirmed-no-cost vocabulary a release reason may carry (usage-evidence.ts). */
const RELEASE_REASON_COPY_KEYS: ReadonlySet<string> = new Set([
  "provider_error",
  "bound_refused",
  "no_usage",
]);

/**
 * The i18n keys a reason can render under — a literal union, so the typed `t` accepts the
 * answer and typecheck itself holds the locale tables to these keys (a sentence missing
 * from a locale fails the build, not the reader).
 */
export type PendingSettlementReasonCopyKey =
  | `creditsPage.pendingReasons.usage_missing`
  | `creditsPage.pendingReasons.stream_error`
  | `creditsPage.pendingReasons.cancelled`
  | `creditsPage.pendingReasons.usage_invalid`
  | `creditsPage.pendingReasons.usage_over_bound`
  | `creditsPage.pendingReasons.usage_charge_failed`
  | `creditsPage.pendingReasons.dispatch_result_unknown`
  | `creditsPage.pendingReasons.hold_expired_without_result`
  | `creditsPage.pendingReasons.async_dispatch_answer_lost`
  | `creditsPage.pendingReasons.async_cancel_result_unknown`
  | `creditsPage.pendingReasons.provider_error`
  | `creditsPage.pendingReasons.bound_refused`
  | `creditsPage.pendingReasons.no_usage`
  | `creditsPage.pendingReasons.fallback`;

/** The i18n key one reservation's reason renders under (settings namespace, creditsPage). */
export function pendingSettlementReasonCopyKey(
  reason: string | null | undefined,
): PendingSettlementReasonCopyKey | null {
  if (!reason) return null;
  if (UNKNOWN_REASON_COPY_KEYS.has(reason)) {
    return `creditsPage.pendingReasons.${reason}` as PendingSettlementReasonCopyKey;
  }
  if (RELEASE_REASON_COPY_KEYS.has(reason)) {
    return `creditsPage.pendingReasons.${reason}` as PendingSettlementReasonCopyKey;
  }
  // Everything else — an unmapped code, an internal error string — reads as the generic
  // sentence. Never the raw text.
  return "creditsPage.pendingReasons.fallback";
}
