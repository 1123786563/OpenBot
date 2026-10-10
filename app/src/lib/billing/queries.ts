import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * The billing seam as the browser sees it.
 *
 * The server keeps the provider's plan vocabulary to itself on both endpoints: entitlements are
 * `{active, codes}` and usage is period, amounts and charges. These types mirror exactly that, so
 * a field added server-side shows up here as a typecheck question rather than a runtime surprise.
 */

/** What this deployment is entitled to. */
export type BillingEntitlements = {
  active: boolean;
  codes: string[];
};

/** One charge's usage in the current billing period. */
export type BillingUsageCharge = {
  metricCode: string;
  metricName: string;
  /** A string decimal, the way the provider sends it, so precision survives the trip. */
  units: string;
  amountCents: number;
};

/** The current billing period's usage, or `active: false` when there is no active subscription. */
export type BillingUsage = {
  active: boolean;
  fromDatetime?: string;
  toDatetime?: string;
  currency?: string;
  amountCents?: number;
  totalAmountCents?: number;
  charges: BillingUsageCharge[];
};

export const billingKeys = {
  entitlements: ["billing", "entitlements"] as const,
  usage: ["billing", "usage"] as const,
};

/**
 * Entitlements are a stable fact behind a server-side TTL, so a modest `staleTime` keeps the
 * settings page from re-asking on every visit without ever showing a stale code for long.
 */
export const entitlementsQueryOptions = queryOptions({
  queryKey: billingKeys.entitlements,
  staleTime: 30_000,
  queryFn: async (): Promise<BillingEntitlements> => {
    const response = await client("/api/billing/entitlements", {
      fallback: "Your entitlements could not be loaded.",
    });
    return response.json();
  },
});

/** Usage moves with every event the provider accepts, so this is always fetched fresh. */
export const usageQueryOptions = queryOptions({
  queryKey: billingKeys.usage,
  staleTime: 0,
  queryFn: async (): Promise<BillingUsage> => {
    const response = await client("/api/billing/usage", {
      fallback: "Your usage could not be loaded.",
    });
    return response.json();
  },
});
