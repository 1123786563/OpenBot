import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * 套餐用量 as the browser sees it, mirroring `/api/billing/plan-usage` exactly.
 *
 * A field added server-side shows up here as a typecheck question rather than a runtime surprise,
 * which is the whole reason this file exists rather than a `useQuery` in the page.
 */

/** One metered resource's allowance for the current period. */
export type BillingQuotaEntry = {
  metricCode: string;
  metricName: string;
  unit: string;
  used: number;
  /** `null` means this deployment measures the metric but set no ceiling on it. */
  limit: number | null;
  remaining: number | null;
  usedCents: number;
};

/** The plan, its period, and what has been used of it. */
export type BillingPlanUsage = {
  active: boolean;
  planCode?: string;
  status?: string;
  currency?: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  /** When the allowances go back to full: the period's end. */
  resetsAt: string | null;
  totalCents?: number;
  quotas: BillingQuotaEntry[];
};

export const planUsageKeys = {
  all: ["billing", "plan-usage"] as const,
};

/**
 * The period's allowances. Always fresh: usage moves with every metered event, so a cached number
 * is a stale number, and this is the one screen whose whole job is to be right about it.
 */
export const planUsageQueryOptions = queryOptions({
  queryKey: planUsageKeys.all,
  staleTime: 0,
  queryFn: async (): Promise<BillingPlanUsage> => {
    const response = await client("/api/billing/plan-usage", {
      fallback: "Your plan usage could not be loaded.",
    });
    return response.json();
  },
});
