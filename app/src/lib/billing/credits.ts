import { queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
import { BillingUnavailableError } from "./invoices";

/**
 * 套餐与积分 as the browser sees it, mirroring `/api/billing/credits/*` exactly.
 *
 * Credits are the deployment's own currency, kept in a local ledger; a field added server-side
 * shows up here as a typecheck question rather than a runtime surprise, which is the whole reason
 * this file exists rather than `useQuery` calls in the page.
 */

/** The whole "套餐与积分" answer, split the way the page splits it. */
export type CreditSummary = {
  plan: { total: number; used: number; remaining: number; held: number };
  rewards: {
    total: number;
    used: number;
    remaining: number;
    held: number;
    grantCount: number;
  };
};

/** One credit grant as the reward list renders it. */
export type CreditGrantEntry = {
  id: string;
  source: "plan" | "promo" | "signin";
  reason: string | null;
  total: number;
  used: number;
  remaining: number;
  grantedAt: string;
  expiresAt: string;
  status: "active" | "exhausted" | "expired";
  expiringSoon: boolean;
};

/** One line of the consumption ledger. */
export type CreditConsumptionEntry = {
  id: string;
  title: string;
  requestId: string | null;
  credits: number;
  model: string | null;
  client: string | null;
  timestamp: string;
};

export type CreditConsumptionPage = {
  entries: CreditConsumptionEntry[];
  pagination: {
    totalCount: number;
    totalPages: number;
    currentPage: number;
    nextPage: number | null;
  };
};

/** One billing cycle in the upgrade dialog. */
export type PlanCatalogCycle = {
  code: "recurring_monthly" | "monthly" | "recurring_yearly" | "yearly";
  label: string;
  priceCents: number;
  originalCents: number | null;
  discountLabel: string | null;
  unit: "month" | "year";
};

/** One plan in the catalog, as the upgrade dialog draws it. */
export type PlanCatalogEntry = {
  name: string;
  credits: number;
  features: string[];
  pricing: PlanCatalogCycle[];
};

/** The consumption window, both ends ISO-8601 and optional. */
export type ConsumptionWindow = { from?: string; to?: string };

export const creditsKeys = {
  all: ["billing", "credits"] as const,
  summary: [...(["billing", "credits"] as const), "summary"] as const,
  grants: [...(["billing", "credits"] as const), "grants"] as const,
  catalog: [...(["billing", "credits"] as const), "catalog"] as const,
  consumption: (window: ConsumptionWindow, page: number) =>
    [
      ...(["billing", "credits"] as const),
      "consumption",
      window.from ?? "",
      window.to ?? "",
      page,
    ] as const,
};

/** Reads a credits path and turns a 404 (the surface absent) into the unavailable error. */
async function read<T>(path: string, fallback: string): Promise<T> {
  const response = await tryClient(path);
  if (response.status === 404) throw new BillingUnavailableError();
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? fallback);
  }
  return response.json();
}

/** The plan's base allowance and the reward totals. Always fresh, like the plan usage read. */
export const creditsSummaryQueryOptions = queryOptions({
  queryKey: creditsKeys.summary,
  staleTime: 0,
  queryFn: () =>
    read<CreditSummary>(
      "/api/billing/credits/summary",
      "Your credits could not be loaded.",
    ),
});

/** The reward grant list, soonest-to-lapse first. */
export const creditsGrantsQueryOptions = queryOptions({
  queryKey: creditsKeys.grants,
  staleTime: 0,
  queryFn: () =>
    read<{ grants: CreditGrantEntry[] }>(
      "/api/billing/credits/grants",
      "Your credit grants could not be loaded.",
    ),
});

/** The plan catalog for the upgrade dialog. */
export const catalogQueryOptions = queryOptions({
  queryKey: creditsKeys.catalog,
  staleTime: 60_000,
  queryFn: () =>
    read<Record<string, PlanCatalogEntry>>(
      "/api/billing/catalog",
      "The plan catalog could not be loaded.",
    ),
});

/** One page of the consumption ledger in a window, newest first. */
export const creditsConsumptionQueryOptions = (
  window: ConsumptionWindow,
  page: number,
) =>
  queryOptions({
    queryKey: creditsKeys.consumption(window, page),
    staleTime: 0,
    queryFn: () => {
      const params = new URLSearchParams();
      if (window.from) params.set("from", window.from);
      if (window.to) params.set("to", window.to);
      params.set("page", String(page));
      return read<CreditConsumptionPage>(
        `/api/billing/credits/consumption?${params}`,
        "Your credit usage could not be loaded.",
      );
    },
  });
