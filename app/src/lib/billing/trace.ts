import type { CreditGrantEntry } from "./credits";

/**
 * Where a grant came from, as the ledger's own words say it.
 *
 * The server keeps one writer for `source: "plan"` grants — the plan-allowance payout that
 * runs inside a paid order's activation (server/src/index.ts `grantor.grantPlanCredits`) —
 * and that writer states its funding order in the grant's reason, always spelled the same
 * way: `plan allowance · <planCode> · order <orderId>`. That fixed sentence is the trace
 * contract this page reads: the order a plan allowance came from, recovered without a second
 * endpoint and without the page ever re-deriving money facts.
 *
 * Everything else stays closed: a `signin`/`promo` grant is a granting ACTION (a check-in, an
 * operator's hand), not a purchase, so it traces to nothing — and a `plan` grant whose reason
 * does not match the payout's exact shape (a value an operator or a future migration wrote)
 * traces to nothing either. Guessing an order id from free text would draw a link the ledger
 * never asserted, which is worse than no link.
 */

/**
 * The plan payout's reason, anchored at both ends: `plan allowance · <planCode> · order
 * <orderId>`. The plan code is the middle span; only the trailing order id answers.
 */
const PLAN_PAYOUT_REASON = /^plan allowance · .+ · order (.+)$/;

/** The funding order of a plan-source grant, or null when the ledger names none. */
export function orderIdOfPlanGrant(
  grant: Pick<CreditGrantEntry, "source" | "reason">,
): string | null {
  if (grant.source !== "plan" || grant.reason === null) return null;
  const match = PLAN_PAYOUT_REASON.exec(grant.reason);
  return match ? (match[1] ?? null) : null;
}
