import type { CreditWriter } from "./credits-writer";
import type { SubscriptionRenewalGrantor } from "./types";

/**
 * The renewal payout's ledger identity (10.3, AC14; BP05/#373): the ONE place the
 * `plan-renewal` grant's idempotency key is composed. The key carries the ACCOUNT the
 * payout lands in, the subscription id, AND the period start, so a duplicate or racing
 * notification of the same period folds into the first insert (the duplicate-notification
 * fence) while the NEXT period's renewal is a new key that pays again — never mistaken for
 * a replay of the last one. The account leads the key because the idempotency DOMAIN
 * includes it (the spec's 两类 ID 的唯一键和幂等域均包含 type): a personal subscription
 * and a company subscription that share the provider's id string are two payouts in two
 * accounts, and the globally-unique index must not collapse the second into the first's
 * "already granted". The composition lives here rather than at the assembly site so the
 * fence is tested, not remembered.
 *
 * One-time upgrade note (BP05): grants written before the account joined the key carry
 * `plan-renewal:<subId>:<periodStart>`. No company subscriptions existed then, so the
 * collision the account segment exists to prevent could not have fired; and the
 * subscription row's forward-only allowance marker (which does not depend on the key
 * format) still refuses to re-cover a period the old key already paid, so a replay across
 * the upgrade re-grants nothing. The ledger's old-key rows are history and are left as
 * written.
 */
export function planRenewalIdempotencyKey(
  accountKey: string,
  externalSubscriptionId: string,
  periodStart: Date,
): string {
  return `plan-renewal:${accountKey}:${externalSubscriptionId}:${periodStart.toISOString()}`;
}

/**
 * The production renewal grantor (10.3): pays a subscription period's plan allowance into
 * the account the billing service derived from the row's owner pair. The write is the credit
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
          input.externalCustomerId,
          input.externalSubscriptionId,
          input.periodStart,
        ),
      });
      return { inserted: result.inserted };
    },
  };
}
