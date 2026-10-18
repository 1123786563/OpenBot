import type { CreditWriter } from "./credits-writer";
import type { SubscriptionRenewalGrantor } from "./types";

/**
 * The renewal payout's ledger identity (10.3, AC14): the ONE place the `plan-renewal` grant's
 * idempotency key is composed. The key carries the subscription id AND the period start, so
 * a duplicate or racing notification of the same period folds into the first insert (the
 * duplicate-notification fence) while the NEXT period's renewal is a new key that pays again —
 * never mistaken for a replay of the last period. The composition lives here rather than at the
 * assembly site so the fence is tested, not remembered.
 */
export function planRenewalIdempotencyKey(
  externalSubscriptionId: string,
  periodStart: Date,
): string {
  return `plan-renewal:${externalSubscriptionId}:${periodStart.toISOString()}`;
}

/**
 * The production renewal grantor (10.3): pays a subscription period's plan allowance into the
 * account the billing service derived from the row's owner pair. The write is the credit
 * ledger's own idempotent deposit — `source: "plan"`, expiring with the period — under the
 * period-tagged key above. `creditsFor` answers the plan's allowance in scaled units (×100),
 * or null for a plan that grants none (the caller then covers the period without a payout).
 */
export function createPlanRenewalGrantor(deps: {
  creditsFor(planCode: string): number | null;
  grantCredits: CreditWriter["grantCredits"];
}): SubscriptionRenewalGrantor {
  return {
    creditsFor: deps.creditsFor,
    async grantRenewal(input) {
      const result = await deps.grantCredits({
        externalCustomerId: input.externalCustomerId,
        source: "plan",
        totalCents: input.totalCents,
        expiresAt: input.periodEnd,
        reason: `plan renewal · ${input.planCode} · period ${input.periodStart.toISOString()}`,
        idempotencyKey: planRenewalIdempotencyKey(
          input.externalSubscriptionId,
          input.periodStart,
        ),
      });
      return { inserted: result.inserted };
    },
  };
}
