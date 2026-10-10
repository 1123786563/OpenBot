/**
 * The billing seam: what the rest of the server is allowed to know about paid plans.
 *
 * Provider-neutral on purpose. The four sentinel codes, the receipts and the store and service
 * interfaces below are the whole vocabulary every other module sees; the provider's own words live
 * in exactly one adapter file. A second provider is added by implementing these against it, not by
 * widening this file. (The same seam discipline this server's delivery lane uses: transport words
 * stay in the transport.)
 *
 * Errors carry a stable code and nothing else. The message is built from the code alone so no URL,
 * status text, response body or credential can leak through a stack trace into a log. Callers that
 * need to explain themselves to a person match on `code`.
 */
export type BillingErrorCode =
  | "unconfigured"
  | "unreachable"
  | "invalid_response"
  | "unsupported";

/** Which sentinel codes describe a condition that might not hold a moment later. */
const RETRYABLE: Record<BillingErrorCode, boolean> = {
  unconfigured: false,
  unreachable: true,
  invalid_response: false,
  unsupported: false,
};

export class BillingError extends Error {
  override name = "BillingError";
  readonly code: BillingErrorCode;
  readonly retryable: boolean;

  constructor(code: BillingErrorCode) {
    // The code and nothing else. The provider is configured with a URL and an API key, and both are
    // secrets relative to a person reading a log line.
    super(`Billing provider failed (${code}).`);
    this.code = code;
    this.retryable = RETRYABLE[code];
  }
}

/** A customer that exists remotely. Echoes the local, deterministic external ID only. */
export type CustomerReceipt = { externalId: string };

/** A subscription that exists remotely. Echoes local IDs only; no provider identifiers. */
export type SubscriptionReceipt = {
  externalCustomerId: string;
  externalSubscriptionId: string;
  planCode: string;
};

/** One entitlement a plan grants, with optional presentational copy from deployment config. */
export type BillingEntitlementEntry = {
  code: string;
  label?: string;
  description?: string;
};

/* -------------------------------------------------------------------------- */
/*  Plan catalog: what the upgrade dialog shows, from deployment config.      */
/* -------------------------------------------------------------------------- */

/** One billing cycle a plan catalog offers, with the discount it is sold under. */
export type PlanCatalogCycle = {
  /** `recurring_monthly` / `monthly` / `recurring_yearly` / `yearly`. */
  code: "recurring_monthly" | "monthly" | "recurring_yearly" | "yearly";
  /** The display name: 连续包月 / 1个月 / 连续包年 / 1年. */
  label: string;
  /** The settled price, in cents. */
  priceCents: number;
  /** The pre-discount price, in cents; null when the cycle is sold at face value. */
  originalCents: number | null;
  /** The discount label ("7折"); null when there is no discount to name. */
  discountLabel: string | null;
  /** What one period is: a month or a year. */
  unit: "month" | "year";
};

/** One plan in the catalog: what it costs and what it grants. */
export type PlanCatalogEntry = {
  /** The display name: 标准版 / 高级版 / 旗舰版. */
  name: string;
  /** The monthly base credit allowance. */
  credits: number;
  /** The plan's benefit list. */
  features: readonly string[];
  /** Its billing cycles. */
  pricing: readonly PlanCatalogCycle[];
};

/** The subscription facts the entitlements read carries beside the plan. */
export type BillingEntitlementSubscriptionContext = {
  status: BillingSubscriptionStatus;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
};

/** What a customer is entitled to, flattened from its plan. */
export type BillingEntitlements = {
  active: boolean;
  planCode?: string;
  codes: readonly BillingEntitlementEntry[];
  subscription?: BillingEntitlementSubscriptionContext | null;
};

/** The admin status snapshot. Names and counts only; never a key or a URL. */
export type BillingSnapshot = {
  configured: true;
  customers: number;
  subscriptions: number;
  lastSyncedAt?: string;
  webhookMode: "jwt" | "hmac" | "off";
};

/** One charge's usage in the current billing period, in neutral words. */
export type BillingUsageCharge = {
  metricCode: string;
  metricName: string;
  /** The provider sends units as a string decimal; it stays a string so precision survives. */
  units: string;
  amountCents: number;
};

/** One metered event as the provider recorded it: the line item behind the aggregate. */
export type BillingUsageEvent = {
  /** ISO-8601 of when the usage happened. */
  timestamp: string;
  metricCode: string;
  inputTokens?: number;
  outputTokens?: number;
  tokens?: number;
  transactionId: string;
};

/** One page of metered events, with what a pager needs to offer the next one. */
export type BillingUsageEventPage = {
  events: readonly BillingUsageEvent[];
  totalCount: number;
  totalPages: number;
  currentPage: number;
  nextPage: number | null;
};

/** The current billing period's usage for one subscription, straight from the provider. */
export type BillingUsage = {
  fromDatetime?: string;
  toDatetime?: string;
  currency?: string;
  amountCents?: number;
  totalAmountCents?: number;
  charges: readonly BillingUsageCharge[];
};

/** One server-local day of metered usage, aggregated from the provider's event log. */
export type BillingUsageDailyBucket = {
  /** Local `yyyy-mm-dd`. */
  date: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
};

/** The billing period's usage, bucketed by day, for a chart. */
export type BillingUsageDaily = {
  fromDatetime?: string;
  toDatetime?: string;
  days: readonly BillingUsageDailyBucket[];
  /** True when the page ceiling stopped the read before the provider ran out of events. */
  truncated: boolean;
};

/* -------------------------------------------------------------------------- */
/*  Statements: what a person reads as "my plan" and "my bills".              */
/* -------------------------------------------------------------------------- */

/**
 * One metered resource's allowance for the current period.
 *
 * `limit: null` is a real answer, not a missing one: a deployment that configured no ceiling for
 * a metric is measuring that metric, not capping it, and the page says so rather than drawing a
 * bar against a number it invented.
 */
export type BillingQuotaEntry = {
  metricCode: string;
  metricName: string;
  /** What one unit is, in the deployment's own word (`tokens`, `calls`). */
  unit: string;
  used: number;
  /** The configured ceiling, or null when this deployment set none. */
  limit: number | null;
  /** `limit - used`, or null when there is no ceiling to subtract from. Never negative. */
  remaining: number | null;
  usedCents: number;
};

/** The plan, its period, and what has been used of it. The 套餐用量 page's whole answer. */
export type BillingPlanUsage = {
  active: boolean;
  planCode?: string;
  status?: BillingSubscriptionStatus;
  currency?: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  /**
   * When the allowances go back to full. The period's end, because that is when the provider
   * starts a new one — not a countdown anybody has to keep.
   */
  resetsAt: string | null;
  totalCents?: number;
  quotas: readonly BillingQuotaEntry[];
};

/** One bill: a payment order as a person reads it, with the channel that settled it. */
export type BillingInvoice = {
  /** The local order id, and the bill's number: it is already unique and human-quotable. */
  invoiceId: string;
  planCode: string;
  /** The period the paid order buys, or the order's own window when it never settled. */
  periodStart: string | null;
  periodEnd: string | null;
  amountCents: number;
  currency: "CNY";
  status: "pending" | "paid" | "blocked" | "canceled" | "expired";
  method: "alipay" | "wechat";
  /** When the bill was raised: the order's creation. */
  issuedAt: string;
  /** When money landed, or when the bill reached a terminal state. Absent while pending. */
  settledAt: string | null;
  /** The channel's own transaction id, once seen — what a person quotes to the channel. */
  channelTransactionId: string | null;
};

/** One line on a bill's detail. v1 raises one line per order: the plan it bought. */
export type BillingInvoiceLine = {
  label: string;
  quantity: number;
  amountCents: number;
};

/** One bill with its lines, for the detail view and the download. */
export type BillingInvoiceDetail = BillingInvoice & {
  lines: readonly BillingInvoiceLine[];
};

/** One page of bills, with what a pager needs to offer the next one. */
export type BillingInvoicePage = {
  invoices: readonly BillingInvoice[];
  pagination: {
    totalCount: number;
    totalPages: number;
    currentPage: number;
    nextPage: number | null;
  };
};

/* -------------------------------------------------------------------------- */
/*  Credits: the local credit ledger, what "套餐与积分" renders.              */
/* -------------------------------------------------------------------------- */

/**
 * Where a credit grant came from. `plan` is the plan's own monthly allowance, `promo` an operator's
 * campaign, `signin` a recurring check-in reward.
 */
export type CreditGrantSource = "plan" | "promo" | "signin";

/** A grant's own life: active until spent or expired. */
export type CreditGrantStatus = "active" | "exhausted" | "expired";

/**
 * One credit grant as a person reads it. Credits are decimal numbers with two places; the ledger
 * stores them as whole units scaled by `CREDIT_SCALE`, this type carries the already-scaled value.
 */
export type CreditGrantEntry = {
  id: string;
  source: CreditGrantSource;
  /** The operator's own words for why this was granted ("官方活动发放"). */
  reason: string | null;
  /** The grant's total allowance, in credits. */
  total: number;
  /** What has been spent of it, in credits. */
  used: number;
  /** `total - used`, never negative. */
  remaining: number;
  grantedAt: string;
  expiresAt: string;
  status: CreditGrantStatus;
  /** True when the grant has less than 24 hours to live — the red "24小时内过期" cue. */
  expiringSoon: boolean;
};

/** One line of the consumption ledger, newest first. */
export type CreditConsumptionEntry = {
  id: string;
  /** The request's business title (the "请求" column's main line). */
  title: string;
  /** The request id shown under the title, to be truncated by the client. */
  requestId: string | null;
  /** How many credits this call cost. */
  credits: number;
  model: string | null;
  /** The surface that made the call (web/api/cli). */
  client: string | null;
  /** ISO-8601 of when it happened. */
  timestamp: string;
};

/** One page of the consumption ledger, with what a pager needs to offer the next one. */
export type CreditConsumptionPage = {
  entries: readonly CreditConsumptionEntry[];
  pagination: {
    totalCount: number;
    totalPages: number;
    currentPage: number;
    nextPage: number | null;
  };
};

/**
 * The whole "套餐与积分" answer, split the way the page splits it: the plan's own base allowance
 * (the 套餐卡's "套餐基础积分") and the platform reward grants (the "平台奖励积分" block's summary
 * line "可用 N 个 · 剩余 X 积分").
 */
export type CreditSummary = {
  plan: { total: number; used: number; remaining: number };
  rewards: {
    total: number;
    used: number;
    remaining: number;
    /** How many reward grants still have something to spend ("可用 N 个"). */
    grantCount: number;
  };
};

/** The four subscription states the sync reads. */
export type BillingSubscriptionStatus =
  | "active"
  | "incomplete"
  | "canceled"
  | "terminated";

/** One stored subscription projection. */
export type BillingSubscriptionRow = {
  externalCustomerId: string;
  externalSubscriptionId: string;
  planCode: string;
  status: BillingSubscriptionStatus;
};

/**
 * The projections the sync keeps, and the webhook inbox.
 *
 * An inbox row means "the projections this event implies have been refreshed" — it is written after
 * the re-read succeeds, never before, so a row always stands for finished work. Redelivery of a
 * known event is answered from the inbox alone; see the service for the ordering and why.
 */
export type BillingStore = {
  upsertCustomer(input: {
    externalId: string;
    name: string | null;
  }): Promise<void>;
  /**
   * Insert the customer row only if it is absent, never overwriting one that exists: the
   * placeholder a webhook path lands when the provider answers 404 for a customer whose
   * projection (with its name) is already here. `upsertCustomer` is the refreshing write;
   * this one is the floor that keeps a subscription row's foreign key satisfied.
   */
  ensureCustomerRow(input: { externalId: string }): Promise<void>;
  upsertSubscription(input: BillingSubscriptionRow): Promise<void>;
  readSubscriptions(
    externalCustomerId: string,
  ): Promise<readonly BillingSubscriptionRow[]>;
  hasWebhookEvent(provider: string, eventId: string): Promise<boolean>;
  recordWebhookEvent(input: {
    provider: string;
    eventId: string;
    uniqueKey?: string;
    webhookType: string;
    objectId?: string;
  }): Promise<boolean>;
  snapshot(): Promise<{
    customers: number;
    subscriptions: number;
    lastSyncedAt?: Date;
  }>;
};

/**
 * A verified delivery, in neutral words; the wire spelling stays inside the verifier.
 *
 * `eventId` is the delivery's idempotency header (`X-Lago-Unique-Key`), not a body member: the
 * provider's payload names no event of its own, so the header is the one identity an inbox row
 * can be keyed on — which is also why a delivery without it never verifies.
 */
export type VerifiedWebhook = {
  eventId: string;
  webhookType: string;
  objectId?: string;
  externalCustomerId?: string;
};

export type WebhookVerifier = {
  verify(
    headers: Headers,
    rawBody: string,
  ): Promise<{ ok: true; delivery: VerifiedWebhook } | { ok: false }>;
};

export type BillingService = {
  /** Read-before-create, idempotent under a race. */
  ensureCustomer(input: {
    externalId: string;
    name: string;
  }): Promise<CustomerReceipt>;
  /** Same, for the customer's subscription; a different existing plan is a terminal conflict. */
  ensureSubscription(input: {
    externalCustomerId: string;
    externalSubscriptionId: string;
    planCode: string;
  }): Promise<SubscriptionReceipt>;
  /**
   * One verified webhook: signature first, then the inbox, then a fresh read of the authoritative
   * object, then the projection, then the inbox row, then 200.
   */
  handleWebhook(request: Request): Promise<Response>;
  /** Cached entitlements read, per customer key. */
  entitlements(externalCustomerId?: string): Promise<BillingEntitlements>;
  /**
   * Drop the cached entitlement answer — one customer's, or every bucket when no key is named.
   * The payment flow calls this the moment a subscription it activated lands, so a settings page
   * never spends the TTL showing a paid plan as free.
   */
  invalidateEntitlementCache(externalCustomerId?: string): void;
  /** The active subscription's current-period usage, or null when there is no active one. */
  usage(externalCustomerId?: string): Promise<BillingUsage | null>;
  /**
   * One page of the active subscription's metered events, newest first — the line items the
   * aggregate above is made of, with pagination facts for the next ask.
   */
  usageEvents(
    limit: number,
    page: number,
    externalCustomerId?: string,
  ): Promise<BillingUsageEventPage>;
  /** The active subscription's current-period usage bucketed by day, 60s-cached. */
  usageDaily(externalCustomerId?: string): Promise<BillingUsageDaily>;
  /**
   * Meter one consumption event against the active subscription. Fire-and-forget by design: the
   * caller is a model call's epilogue, and billing must never sit in front of a token stream.
   * The transaction id makes a retried report free — the provider stores it once.
   */
  recordUsage(input: {
    metricCode: string;
    properties: Record<string, number | string>;
    /** Stable per-occurrence id; the same value twice is one event at the provider. */
    transactionId: string;
    timestamp?: Date;
    /** Absent means this deployment's own customer key. */
    externalCustomerId?: string;
  }): Promise<void>;
  snapshot(): Promise<BillingSnapshot>;
  /** Not built yet, and refusing rather than half-working. */
  reconcile(): Promise<never>;
};
