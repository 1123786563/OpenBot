import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { client } from "@/lib/client";

const microcredits = z.string().regex(/^-?\d+$/);
const creditType = z.enum(["test", "paid"]);
const rate = z.object({
  inputPerMillion: z.number().int().nonnegative(),
  outputPerMillion: z.number().int().nonnegative(),
});
const paidBalanceSchema = z.object({
  availableMicrocredits: microcredits,
  reservedMicrocredits: microcredits,
  chargedMicrocredits: microcredits,
});
const billingBalanceSchema = paidBalanceSchema.extend({
  creditType: z.literal("test"),
  trialEnded: z.boolean().optional(),
  grantedMicrocredits: microcredits,
});
export type BillingBalance = z.infer<typeof billingBalanceSchema>;

export const billingQuoteSchema = z.object({
  creditType: z.literal("test"),
  paidAvailable: z.boolean().optional(),
  priceVersion: z.string().min(1),
  route: z.string().min(1),
  tools: z.boolean().optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  price: rate,
  maxChargeMicrocredits: microcredits,
  usageDisclosure: z.string(),
});
export type BillingQuote = z.infer<typeof billingQuoteSchema>;
const ingestionPreviewSchema = billingQuoteSchema.pick({
  creditType: true,
  price: true,
  maxChargeMicrocredits: true,
});
const billingOperationSchema = billingQuoteSchema
  .pick({
    route: true,
    provider: true,
    model: true,
    priceVersion: true,
    price: true,
  })
  .extend({
    parentRunId: z.string().nullish(),
    reservedMicrocredits: microcredits,
    chargedMicrocredits: microcredits.nullable(),
    releasedMicrocredits: microcredits.nullable(),
  });

const paidSourceSchema = z.object({
  entitlementId: z.string(),
  kind: z.enum(["subscription", "credit_pack", "correction_credit"]),
  arrivedAt: z.string(),
  remainingMicrocredits: microcredits,
});
export type PaidSource = z.infer<typeof paidSourceSchema>;
export type PaidBalance = z.infer<typeof paidBalanceSchema>;

export const paymentDisputeSchema = z.object({
  id: z.uuid(),
  progress: z.enum([
    "open",
    "awaiting_settlement",
    "reversed",
    "manual_reconciliation",
    "reconciled",
  ]),
  usedMicrocredits: microcredits,
  revokedMicrocredits: microcredits.nullable(),
  manualReviewCents: z.number().int().nonnegative().nullable(),
});
export type PaymentDispute = z.infer<typeof paymentDisputeSchema>;
const billLineSchema = z.object({
  operationId: z.string().nullable(),
  orderId: z.string().nullish(),
  dispute: paymentDisputeSchema.nullish(),
  applicationId: z.string().nullable(),
  source: z.enum([
    "test",
    "subscription",
    "credit_pack",
    "correction_credit",
    "correction",
    "dispute",
  ]),
  entitlementId: z.string().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  arrivedAt: z.string().nullable(),
  amountMicrocredits: microcredits,
  at: z.string().nullable(),
  reason: z.string().nullable(),
  correction: z
    .object({
      id: z.string(),
      kind: z.enum(["overcharge_refund", "fault_compensation"]),
      evidence: z.string(),
      operator: z.string(),
      availableBeforeMicrocredits: microcredits.nullable(),
      availableAfterMicrocredits: microcredits.nullable(),
      correctionCreditsMicrocredits: microcredits.nullable(),
    })
    .optional(),
});
export type BillLine = z.infer<typeof billLineSchema>;

const resumePointSchema = z.object({
  operationId: z.string(),
  authorizationId: z.string().optional(),
  applicationId: z.string().nullable(),
  reason: z.enum(["insufficient_credits", "execution_limit", "trial_ended"]),
  createdAt: z.string(),
  requiredBudgetId: z.string().nullish(),
  budgetId: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  creditType: creditType.nullable(),
});
export type ResumePoint = z.infer<typeof resumePointSchema>;

const budgetSchema = z.object({
  budgetId: z.string(),
  creditType,
  limitMicrocredits: microcredits,
  usedMicrocredits: microcredits,
  state: z.enum(["active", "paused", "completed"]),
  confirmed: z.boolean(),
});
export type BudgetRecord = z.infer<typeof budgetSchema>;

const billingApplicationSchema = z.object({
  id: z.string(),
  name: z.string(),
  operator: z.enum(["platform", "independent"]),
  resourcePrefix: z.string(),
  approvedAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type BillingApplication = z.infer<typeof billingApplicationSchema>;

const spendingAuthorizationSchema = z.object({
  creditType: creditType.optional(),
  authorizationId: z.string(),
  applicationId: z.string(),
  kind: z.enum(["online", "background"]),
  taskId: z.string().nullable(),
  resourcePrefix: z.string(),
  expiresAt: z.string(),
  limitMicrocredits: microcredits,
  spentMicrocredits: microcredits,
  revokedAt: z.string().nullable(),
  state: z.enum(["active", "expired", "revoked"]),
});
export type SpendingAuthorization = z.infer<typeof spendingAuthorizationSchema>;

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

async function read<T>(
  path: string,
  schema: z.ZodType<T>,
  options?: { signal?: AbortSignal; fallback?: string },
): Promise<T> {
  const fallback = options?.fallback ?? FALLBACK;
  const response = await client(path, { fallback, signal: options?.signal });
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error(fallback);
  return parsed.data;
}

export function billingBalanceQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.balance,
    queryFn: () => read("/api/billing/balance", billingBalanceSchema),
  });
}

export function billingQuoteQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.quote,
    queryFn: () => read("/api/billing/quote", billingQuoteSchema),
  });
}

export function billingOperationQueryOptions(operationId: string) {
  return queryOptions({
    queryKey: [...billingKeys.all, "operations", operationId],
    queryFn: () =>
      read(
        `/api/billing/operations/${encodeURIComponent(operationId)}`,
        billingOperationSchema,
      ),
    retry: false,
  });
}

export function conversationCreditQuoteQueryOptions(
  threadId: string,
  agentId: string,
) {
  return queryOptions({
    queryKey: [...billingKeys.quote, threadId, agentId],
    queryFn: ({ signal }) =>
      read(
        `/api/copilotkit/agent/${encodeURIComponent(agentId)}/test-credit-quote?${new URLSearchParams({ threadId })}`,
        billingQuoteSchema,
        { fallback: "Could not get a Test Credit quote", signal },
      ),
    retry: false,
  });
}

export function weknoraPreviewQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.weknoraPreview,
    queryFn: () => read("/api/billing/weknora/preview", ingestionPreviewSchema),
    retry: false,
  });
}

export function paidSourcesQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.paidSources,
    queryFn: () => read("/api/billing/paid/sources", z.array(paidSourceSchema)),
  });
}

export function paidBalanceQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.paidBalance,
    queryFn: () => read("/api/billing/paid/balance", paidBalanceSchema),
  });
}

export function resumePointsQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.resumePoints,
    queryFn: () =>
      read("/api/billing/resume-points", z.array(resumePointSchema)),
  });
}

export function applicationsQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.applications,
    queryFn: () =>
      read("/api/billing/applications", z.array(billingApplicationSchema)),
  });
}

export function authorizationsQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.authorizations,
    queryFn: () =>
      read("/api/billing/authorizations", z.array(spendingAuthorizationSchema)),
  });
}

export function billLinesQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.bill,
    queryFn: () => read("/api/billing/paid/bill", z.array(billLineSchema)),
  });
}

export function budgetsQueryOptions() {
  return queryOptions({
    queryKey: billingKeys.budgets,
    queryFn: () => read("/api/billing/budgets", z.array(budgetSchema)),
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

const beijingTimeFormat = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Shanghai",
});

export function beijingBillingTime(iso: string) {
  return beijingTimeFormat.format(new Date(iso));
}
