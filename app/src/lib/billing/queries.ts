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
  maxChargeMicrocredits: string;
  usageDisclosure: string;
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
  /** The app the step ran for, where the caller named one. */
  applicationId: string | null;
  source: "test" | "subscription" | "credit_pack" | "correction";
  entitlementId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  arrivedAt: string | null;
  amountMicrocredits: string;
  at: string | null;
  reason: string | null;
};

/** The paid side of a person's balance: what can be spent, what running steps hold, and what finished steps charged. */
export type PaidBalance = {
  availableMicrocredits: string;
  reservedMicrocredits: string;
  chargedMicrocredits: string;
};

/** A step that stopped for want of credits or budget room, waiting on the person. */
export type ResumePoint = {
  operationId: string;
  authorizationId?: string;
  applicationId: string | null;
  reason: "insufficient_credits" | "execution_limit";
  createdAt: string;
  /** The budget the person confirmed for this step, once they have. */
  budgetId: string | null;
  confirmedAt: string | null;
  creditType: "test" | "paid" | null;
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

/** An app whose steps can spend from a person's account, once it is approved. */
export type BillingApplication = {
  id: string;
  name: string;
  operator: "platform" | "independent";
  /** The resources it may be authorized for, as a prefix of their names. */
  resourcePrefix: string;
  approvedAt: string | null;
  pausedAt: string | null;
  createdAt: string;
};

/** A person's explicit grant to an app (#111): what it may spend, on which resources, and until when. */
export type SpendingAuthorization = {
  authorizationId: string;
  applicationId: string;
  /** A background grant is for one task. */
  kind: "online" | "background";
  taskId: string | null;
  resourcePrefix: string;
  expiresAt: string;
  limitMicrocredits: string;
  spentMicrocredits: string;
  revokedAt: string | null;
  state: "active" | "expired" | "revoked";
};

export const billingKeys = {
  all: ["billing"] as const,
  applications: ["billing", "applications"] as const,
  authorizations: ["billing", "authorizations"] as const,
  balance: ["billing", "balance"] as const,
  quote: ["billing", "quote"] as const,
  weknoraPreview: ["billing", "weknora-preview"] as const,
  paidSources: ["billing", "paid-sources"] as const,
  paidBalance: ["billing", "paid-balance"] as const,
  bill: ["billing", "bill"] as const,
  budgets: ["billing", "budgets"] as const,
  resumePoints: ["billing", "resume-points"] as const,
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

export function billingOperationQueryOptions(operationId: string) {
  return queryOptions({
    queryKey: [...billingKeys.all, "operations", operationId],
    queryFn: (): Promise<
      Pick<
        BillingQuote,
        "route" | "provider" | "model" | "priceVersion" | "price"
      > & {
        reservedMicrocredits: string;
        chargedMicrocredits: string | null;
        releasedMicrocredits: string | null;
      }
    > => read(`/api/billing/operations/${encodeURIComponent(operationId)}`),
    retry: false,
  });
}

export function conversationCreditQuoteQueryOptions(
  threadId: string,
  agentId: string,
) {
  return queryOptions({
    queryKey: [...billingKeys.quote, threadId, agentId],
    queryFn: ({ signal }): Promise<BillingQuote> =>
      client(
        `/api/copilotkit/agent/${encodeURIComponent(agentId)}/test-credit-quote?${new URLSearchParams({ threadId })}`,
        { fallback: "Could not get a Test Credit quote", signal },
      ).then((response) => response.json()),
    retry: false,
  });
}

export function weknoraPreviewQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.weknoraPreview,
    queryFn: (): Promise<BillingQuote> => read("/api/billing/weknora/preview"),
    retry: false,
  });
}

export function paidSourcesQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.paidSources,
    queryFn: (): Promise<PaidSource[]> => read("/api/billing/paid/sources"),
  });
}

export function paidBalanceQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.paidBalance,
    queryFn: (): Promise<PaidBalance> => read("/api/billing/paid/balance"),
  });
}

export function resumePointsQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.resumePoints,
    queryFn: (): Promise<ResumePoint[]> => read("/api/billing/resume-points"),
  });
}

export function applicationsQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.applications,
    queryFn: (): Promise<BillingApplication[]> =>
      read("/api/billing/applications"),
  });
}

export function authorizationsQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.authorizations,
    queryFn: (): Promise<SpendingAuthorization[]> =>
      read("/api/billing/authorizations"),
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
