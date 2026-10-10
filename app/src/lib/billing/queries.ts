import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * The billing seam as the browser sees it.
 *
 * The server keeps the provider's plan vocabulary to itself: entitlements are
 * `{active, planCode?, codes, subscription?}` and the usage answers are period, amounts, charges
 * and date buckets. These types mirror exactly that, so a field added server-side shows up here
 * as a typecheck question rather than a runtime surprise.
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

/** One day of the period's usage, bucketed on the server's clock. */
export type BillingUsageDailyBucket = {
  date: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
};

/** The period's daily buckets, with `truncated` marking a window the provider capped. */
export type BillingUsageDaily = {
  fromDatetime?: string;
  toDatetime?: string;
  days: BillingUsageDailyBucket[];
  truncated: boolean;
};

/** One metered event: the line item behind the aggregate. */
export type BillingUsageEvent = {
  timestamp: string;
  metricCode: string;
  inputTokens?: number;
  outputTokens?: number;
  tokens?: number;
};

/** One page of metered events, with what a pager needs to offer the next one. */
export type BillingUsageEventPageResponse = {
  events: BillingUsageEvent[];
  pagination: {
    totalCount: number;
    totalPages: number;
    currentPage: number;
    nextPage: number | null;
  };
};

export const billingKeys = {
  entitlements: ["billing", "entitlements"] as const,
  usage: ["billing", "usage"] as const,
  usageDaily: ["billing", "usage-daily"] as const,
  usageEvents: ["billing", "usage-events"] as const,
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

/** The period's daily buckets. Always fresh, like every usage answer. */
export const usageDailyQueryOptions = queryOptions({
  queryKey: billingKeys.usageDaily,
  staleTime: 0,
  queryFn: async (): Promise<BillingUsageDaily> => {
    const response = await client("/api/billing/usage/daily", {
      fallback: "Your daily usage could not be loaded.",
    });
    return response.json();
  },
});

/**
 * Alias of `usageDailyQueryOptions` under the name the redesign spec gives this query, so either
 * import site resolves to the one definition.
 */
export const billingUsageDailyQueryOptions = usageDailyQueryOptions;

/**
 * The most recent metered events: the line items the aggregate is made of. Always fresh, one
 * fixed server-side page at a time; the page number lives in the route's search params.
 */
export const usageEventsQueryOptions = (page: number) =>
  queryOptions({
    queryKey: [...billingKeys.usageEvents, page],
    staleTime: 0,
    queryFn: async (): Promise<BillingUsageEventPageResponse> => {
      const response = await client(`/api/billing/usage/events?page=${page}`, {
        fallback: "Your usage details could not be loaded.",
      });
      return response.json();
    },
  });
