import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * The billing seam as the browser sees it.
 *
 * The server keeps the provider's plan vocabulary to itself: entitlements are
 * `{active, planCode?, codes, subscription?}`. These types mirror exactly that, so a field added
 * server-side shows up here as a typecheck question rather than a runtime surprise.
 *
 * The usage reads that used to live beside this (aggregate, daily buckets, event pages) went with
 * the old 用量 screens: 套餐与积分 reads the credits seam instead, and no page asks the provider's
 * metered usage any more.
 */

/** One capability the plan unlocks, with the provider's optional reader-facing wording. */
export type BillingEntitlementEntry = {
  code: string;
  label?: string;
  description?: string;
};

/** The subscription behind the entitlements, when the deployment has one. */
export type BillingEntitlementSubscription = {
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
};

/** What this deployment is entitled to. */
export type BillingEntitlements = {
  active: boolean;
  planCode?: string;
  codes: BillingEntitlementEntry[];
  subscription?: BillingEntitlementSubscription | null;
};

export const billingKeys = {
  entitlements: ["billing", "entitlements"] as const,
};

/**
 * Entitlements are a stable fact behind a server-side TTL, so a modest `staleTime` keeps the
 * 套餐与积分 page from re-asking on every visit without ever showing a stale plan for long. It
 * still answers the two facts that page needs from the provider's subscription: the plan's own
 * name and when the current period ends.
 */
export const entitlementsQueryOptions = queryOptions({
  queryKey: billingKeys.entitlements,
  staleTime: 30_000,
  queryFn: async (): Promise<BillingEntitlements> => {
    const response = await client("/api/billing/entitlements", {
      fallbackKey: "billing.loadEntitlements",
    });
    return response.json();
  },
});
