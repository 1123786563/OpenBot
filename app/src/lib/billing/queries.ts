import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** A person's Test Credit balance, counted in microcredits. */
export type BillingBalance = {
  creditType: "test";
  grantedMicrocredits: string;
  reservedMicrocredits: string;
  chargedMicrocredits: string;
  availableMicrocredits: string;
};

/** The model route a task runs on, what it costs, and the most one request can charge. */
export type BillingQuote = {
  creditType: "test";
  priceVersion: string;
  route: string;
  provider: string;
  model: string;
  price: { inputPerMillion: number; outputPerMillion: number };
  maxChargeMicrocredits: number;
};

/** One paid source of credits, in the order a task spends them. */
export type PaidSource = {
  entitlementId: string;
  kind: "subscription" | "credit_pack";
  arrivedAt: string;
  remainingMicrocredits: string;
};

/** One charge booked against one source. */
export type BillLine = {
  operationId: string;
  source: "test" | "subscription" | "credit_pack" | "correction";
  entitlementId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  arrivedAt: string | null;
  amountMicrocredits: string;
  at: string | null;
  reason: string | null;
};

/** An execution budget: the Credit type a task runs on and the most it may spend. */
export type BudgetRecord = {
  budgetId: string;
  creditType: "test" | "paid";
  limitMicrocredits: string;
  usedMicrocredits: string;
  state: "active" | "paused" | "completed";
  confirmed: boolean;
};

export const billingKeys = {
  all: ["billing"] as const,
  balance: ["billing", "balance"] as const,
  quote: ["billing", "quote"] as const,
  paidSources: ["billing", "paid-sources"] as const,
  bill: ["billing", "bill"] as const,
  budgets: ["billing", "budgets"] as const,
};

const FALLBACK = "Could not load your credits";

async function read<T>(path: string): Promise<T> {
  return (await client(path, { fallback: FALLBACK })).json();
}

export function billingBalanceQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.balance,
    queryFn: (): Promise<BillingBalance> => read("/api/billing/balance"),
  });
}

export function billingQuoteQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.quote,
    queryFn: (): Promise<BillingQuote> => read("/api/billing/quote"),
  });
}

export function paidSourcesQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.paidSources,
    queryFn: (): Promise<PaidSource[]> => read("/api/billing/paid/sources"),
  });
}

export function billLinesQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.bill,
    queryFn: (): Promise<BillLine[]> => read("/api/billing/paid/bill"),
  });
}

export function budgetsQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.budgets,
    queryFn: (): Promise<BudgetRecord[]> => read("/api/billing/budgets"),
  });
}

const MICROCREDITS_PER_CREDIT = 1_000_000n;

/**
 * Microcredits as a person reads them: whole credits when they divide evenly, and otherwise the
 * exact fraction, since a single request can cost a millionth of a credit.
 */
export function creditsText(microcredits: string | number) {
  const value = BigInt(microcredits);
  const whole = value / MICROCREDITS_PER_CREDIT;
  const fraction = value % MICROCREDITS_PER_CREDIT;
  if (fraction === 0n) return whole.toLocaleString("en-US");
  const decimals = fraction.toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}.${decimals}`;
}
