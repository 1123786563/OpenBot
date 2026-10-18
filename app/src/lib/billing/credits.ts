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

/** The pending-settlement answer, mirroring the server's 06.12 contract (ticket 06.12).
 *
 * The field names are the ones 02.6 fixed; the amounts are group 06's real data now. `enabled`
 * stays a plain boolean: a pre-06.12 server's `{ enabled: false, zeros }` remains a valid wire
 * answer this client renders honestly (the 未启用 marker), while an enabled answer carries the
 * pending quota — every capacity-occupying hold, unexpired `reserved` plus every `unknown` —
 * its reserved/unknown split, the settled total, the lapsed holds, and the latest reservations
 * with status and reason each.
 */
export type PendingSettlementSummary = {
  /** The gate, switched on by group 06; false remains a valid answer from a pre-06.12 server. */
  enabled: boolean;
  /** The pending quota: Σ maximum of unexpired `reserved` holds plus every `unknown` one. */
  available: number;
  /** Σ charged over settled reservations — the ledger's figure. */
  consumed: number;
  /** Σ maximum of plain `reserved` holds whose expiry has passed. */
  expired: number;
  /** The quota's `reserved` share. */
  reserved: number;
  /** The quota's `unknown` share — occupies until recovery disposes it. */
  unknown: number;
  /** The account's latest reservations, newest first. */
  reservations: CreditReservationEntry[];
};

/** One of the account's own reservations, as the pending view itemizes it (ticket 06.12). */
export type CreditReservationEntry = {
  id: string;
  status: "reserved" | "unknown" | "settled" | "released";
  /** The hold ceiling, in credits. */
  maximum: number;
  /** What settlement charged, in credits — settled rows only. */
  charged: number | null;
  /** Held capacity handed back unused, in credits — terminal rows only. */
  released: number | null;
  provider: string | null;
  model: string | null;
  capability: string | null;
  /** The Bot the reservation was admitted for, when the protocol recorded it. */
  botId: string | null;
  botName: string | null;
  /** Why the hold entered `unknown`, verbatim. */
  unknownReason: string | null;
  /** Why the hold was released, verbatim. */
  releaseReason: string | null;
  createdAt: string;
  expiresAt: string;
  terminalAt: string | null;
};

/**
 * The credits summary read, mirroring the server's `PersonalCreditBalance` (ticket 02.6) exactly:
 * the signed-in user's OWN account — the account is never a parameter, the route resolves it
 * from the authenticated identity, so the response names the account type it answers.
 *
 * `available` is the spendable figure admission uses, `consumed` the lifetime amount charged,
 * `expired` the lapsed-unused part of past grants, `held` the open reservations; `grants` carries
 * every grant with its derived life, `pendingSettlement` the group-06 pending answer (ticket
 * 06.12): the quota, its reserved/unknown split, and the latest reservations with status and
 * reason each.
 */
export type PersonalCreditBalance = {
  /** The billing subject kind the answer names — always the authenticated user's own. */
  accountType: "personal";
  /** What a new draw or hold could take right now, the gate's own admission figure. */
  available: number;
  /** The lifetime amount the account's grants have absorbed, live and expired grants alike. */
  consumed: number;
  /** The lapsed-unused part of expired grants — gone from the balance, visible here. */
  expired: number;
  /** Active holds against live grants: reserved, still occupying the balance. */
  held: number;
  /** Every grant of the account, soonest expiry first, with its derived status. */
  grants: CreditGrantEntry[];
  /** Group 06's pending answer: the quota, its split, and the latest reservations. */
  pendingSettlement: PendingSettlementSummary;
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
  /** What the grants absorbed of that cost; `credits - applied` is the unfunded shortfall. */
  applied: number;
  model: string | null;
  client: string | null;
  /** The Bot the call was admitted for (06.12's attribution), null when not protocol-born. */
  botId: string | null;
  botName: string | null;
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

/** The signed-in user's own credit balance, the account read from the session. Always fresh. */
export const creditsSummaryQueryOptions = queryOptions({
  queryKey: creditsKeys.summary,
  staleTime: 0,
  queryFn: () =>
    read<PersonalCreditBalance>(
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
