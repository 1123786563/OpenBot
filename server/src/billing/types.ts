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
import type { PayerKind } from "./payer";

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

/**
 * The idempotency-key prefix tying one admitted model call's reservation to the usage event
 * its finish is expected to commit: the gate writes `usage:<eventId>`, the reconciler reads
 * the same prefix back out to name the event an expired hold belongs to. One constant so the
 * write side and the read side cannot drift apart silently.
 */
export const USAGE_IDEMPOTENCY_KEY_PREFIX = "usage:";

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

export type BillingPersistenceOperation =
  | "customer_upsert"
  | "customer_ensure"
  | "subscription_upsert"
  | "subscription_stamp"
  | "subscription_allowance"
  | "subscription_retire"
  | "subscription_read"
  | "webhook_lookup"
  | "webhook_record"
  | "webhook_apply"
  | "snapshot";

/** A database operation failed after the request reached the billing store. */
export class BillingPersistenceError extends Error {
  override name = "BillingPersistenceError";
  /**
   * Whether the same delivery could succeed a moment later (a deadlock, a failover, a refused
   * connection) or is a fact about the data (a constraint violation, a value too long). Both are
   * OURS, so both are answered 5xx and the provider retries: a 4xx would tell the provider its
   * delivery was bad and lose the projection permanently (audit A8). The flag only grades the log
   * line and the operator's expectation.
   */
  readonly retryable: boolean;
  constructor(
    readonly operation: BillingPersistenceOperation,
    retryable = true,
    options?: { cause?: unknown },
  ) {
    super(`Billing persistence failed (${operation}).`);
    this.retryable = retryable;
    // The driver's own error, kept for a debugger. It is never serialised into a response or into
    // a log message: a driver error can quote a connection string.
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** A customer that exists remotely. Echoes the local, deterministic external ID only. */
export type CustomerReceipt = { externalId: string };

/** A subscription that exists remotely. Echoes local IDs only; no provider identifiers. */
export type SubscriptionReceipt = {
  externalCustomerId: string;
  externalSubscriptionId: string;
  planCode: string;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
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
/**
 * One reconciliation finding (T7): what broke, where, in one sentence. The words are fixed
 * here — the seam's vocabulary rule — so a report is greppable and a consumer can group it.
 */
export type ReconcileFinding = {
  /**
   * The invariant's family: `payment` (the three-way), `credits` (the identity), or `usage`
   * (delivery backlog evidence).
   */
  category: "payment" | "credits" | "usage";
  /** The specific break, stable and greppable. */
  code:
    | "paid_without_fact"
    | "fact_transaction_mismatch"
    | "fact_amount_mismatch"
    | "applied_without_subscription"
    | "grants_ledger_divergence"
    | "credit_overdraw"
    | "expired_reserved_reservation"
    | "reservation_allocation_imbalance"
    | "plan_grant_missing"
    | "plan_grant_amount_mismatch"
    | "plan_grant_owner_mismatch"
    | "activation_backlog"
    | "duplicate_paid_order"
    | "usage_target_pending"
    | "usage_target_blocked"
    | "usage_findings_omitted"
    | "webhook_body_replay"
    | "webhook_replays_omitted";
  /**
   * The row the finding is about: an order id, a customer key, a reservation id, or a usage
   * event id.
   */
  subject: string;
  /** The human sentence — numbers included, because the report is the evidence. */
  detail: string;
};

/** One reconciliation pass's answer: what was checked, and what (if anything) disagrees. */
export type ReconcileReport = {
  /** When the pass ran (ISO) — a report is a snapshot, not a stream. */
  ranAt: string;
  /** The counts an operator needs to trust an empty findings list. */
  checked: {
    paidOrders: number;
    appliedOrders: number;
    creditCustomers: number;
    /**
     * The whole-report overdraw total (audit D1): what consumption the grants could not fund,
     * summed from `credits - applied` across the ledger. `units` is an exact decimal string (the
     * reconciler's BigInt discipline — a money figure is never rounded on its way into a report
     * that audits somebody else's arithmetic); `entries` counts the shortfall-carrying rows.
     */
    overdraw: { entries: number; units: string };
    usageDeliveryTargets: {
      pending: { lago: number; credits: number };
      blocked: { lago: number; credits: number };
    };
    usageFindings: {
      limit: number;
      emitted: number;
      omitted: number;
    };
    /** How many rows the pass walked, and the page size it walked them in (audit C3). */
    scanned: {
      paidOrders: number;
      paidFacts: number;
      reservedRows: number;
      pageSize: number;
    };
    /** The replay-evidence window, in the usage findings' shape (audit C3, closing A7's marker). */
    webhookReplays: {
      limit: number;
      emitted: number;
      omitted: number;
    };
  };
  findings: readonly ReconcileFinding[];
};

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
  currency: string;
  status: "pending" | "paid" | "blocked" | "canceled" | "expired";
  method: "alipay" | "wechat";
  /** When the bill was raised: the order's creation. */
  issuedAt: string;
  /** When money landed. Absent unless the order actually settled as paid. */
  settledAt: string | null;
  /** The channel's own transaction id, once seen — what a person quotes to the channel. */
  channelTransactionId: string | null;
  /**
   * The paying account's kind, spelled so a list can label 个人/公司 without guessing (BP07/
   * #375: 个人与公司账户必须有清晰标识). Only `personal` and `company` are displayable — the
   * owner kinds a scope can never match (`legacy_deployment`, `unknown_owner`) do not reach a
   * payment record in the first place.
   */
  payerKind: "personal" | "company";
  /**
   * The delivery progress a PAID order owes its reader (spec: 收款状态与交付状态独立 — 已收款
   * 未交付显示「已付款，权益处理中」，不得被表示为完成). Null while no money landed: a pending,
   * blocked, expired or canceled order owes no delivery and says so by absence. `failureReason`
   * and `nextRetryAt` are the order row's own retained facts (BP03), quoted — never re-derived.
   */
  fulfillment: {
    state: "processing" | "delivered" | "needs_resolution";
    failureReason: string | null;
    nextRetryAt: string | null;
  } | null;
  /**
   * The order's recorded anomaly events, oldest first (重复收款和异常有明确进度): the writer's
   * own closed vocabulary and bounded words, projected read-only. Empty on an order with no
   * anomaly — absence is the honest answer, not "all clear".
   */
  anomalies: readonly BillingPaymentAnomaly[];
};

/**
 * One anomaly event on a payment order, as the record's progress displays it (BP07/#375). The
 * `code` is the writer's stable word (the `PaymentAnomalyCode` vocabulary by construction); the
 * `detail` is what the writer recorded, quoted verbatim.
 */
export type BillingPaymentAnomaly = {
  code: string;
  detail: string;
  channelTransactionId: string | null;
  amountCents: number | null;
  occurredAt: string;
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
  /** How many credits this call cost, in full. */
  credits: number;
  /**
   * How much of that cost the grants absorbed. Equal to `credits` except when the balance came up
   * short; `credits - applied` is the shortfall the reconciler totals as `overdraw`.
   */
  applied: number;
  model: string | null;
  /** The surface that made the call (web/api/cli). */
  client: string | null;
  /** The Bot the call was admitted for (06.12's attribution), null when not protocol-born. */
  botId: string | null;
  botName: string | null;
  /**
   * The capability line this entry settled as, when its settlement wrote one: the image
   * line (12.2), the speech line (13.2) or the async job line (17.6) — the entry shows
   * WHAT was consumed, distinguishable across capabilities. Other entries carry null.
   * `kind` is the discriminator every consumer narrows on; `capability` stays the
   * provider's own capability word (an async job may be chat, video, …).
   */
  lineDetail:
    | {
        kind: "image";
        capability: string;
        image: {
          size: string | null;
          quality: string | null;
          requestedCount: number;
          generatedCount: number;
        };
      }
    | {
        kind: "speech";
        capability: string;
        speech: {
          inputCharacters: number;
          voiceTier: string | null;
          cappedSeconds: number;
          actualSeconds: string;
        };
      }
    | {
        kind: "async_job";
        capability: string;
        asyncJob: {
          jobId: string;
          providerJobId: string | null;
          entryCount: number;
          terminalState: "completed" | "failed" | "cancelled";
        };
      }
    | null;
  /**
   * The model/surcharge fee split of this entry (20.3), in credits — absent when the
   * settlement wrote no split, never a zero surcharge line the UI would read as free.
   */
  feeBreakdown?: { modelCredits: number; surchargeCredits: number };
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
 * The 套餐与积分 page's balance answer, over LIVE grants only (unexpired), in credits (×100
 * scaled units on the wire). `remaining` is what a draw or a new hold could take per grant, so it
 * already excludes `held`; `total`/`used` are the same live grants' lifetime figures, which is why
 * `remaining` is not `total - used`. Expired grants drop out of this answer entirely and stay
 * visible, with their derived `expired` status, in the grant list.
 *
 * Computed by `summarizeCapacity` in ./credits.ts over the SAME `liveGrants` read the credit
 * writer admits against (./capacity.ts) — one standard, so the page can no longer show a balance the
 * gate would refuse. The one deliberate difference: the writer also occupies a single extra unit
 * while a fractional remainder is owed (`owedUnit`, at most 0.01 credit), which this answer does
 * not subtract.
 */
export type CreditSummary = {
  plan: { total: number; used: number; remaining: number; held: number };
  rewards: {
    total: number;
    used: number;
    remaining: number;
    held: number;
    /** How many reward grants still have something to spend ("可用 N 个"). */
    grantCount: number;
  };
};

/**
 * The personal read's pending-settlement placeholders (ticket 02.6).
 *
 * Settlement-disposition views are group 06's slice, and group 06 has landed (ticket 06.12):
 * the fields 02.6 reserved now carry the real answer behind the SAME names — the pending
 * quota (every capacity-occupying hold: unexpired `reserved` plus every `unknown`), its
 * reserved/unknown split, the settled total, the lapsed holds, and the per-reservation
 * status-and-reason list. The quota is computed from the same occupying definition admission
 * uses (./capacity.ts), so the page and the gate cannot disagree; `consumed` is the ledger's
 * own figure, never a parallel truth.
 */
export type PendingSettlementSummary = {
  /** The gate, switched on by group 06: every amount below is computed, never a constant. */
  enabled: true;
  /** The pending quota: Σ maximum of unexpired `reserved` holds plus every `unknown` one. */
  available: number;
  /** Σ charged over settled reservations — the ledger's figure, not a parallel truth. */
  consumed: number;
  /** Σ maximum of plain `reserved` holds whose expiry has passed (no longer occupying). */
  expired: number;
  /** The quota's `reserved` share (unexpired plain holds). */
  reserved: number;
  /** The quota's `unknown` share — occupies no matter how far the clock runs (Q12). */
  unknown: number;
  /** The account's latest reservations, newest first, bounded at twenty. */
  reservations: readonly CreditReservationEntry[];
};

/**
 * One of the account's own reservations, as the user view answers it (ticket 06.12): the
 * hold's status and reason, in credits (×100 scaled units, scaled down for the wire).
 * `status` and the reason fields are the row's persisted state — the view never derives or
 * guesses one.
 */
export type CreditReservationEntry = {
  id: string;
  status: "reserved" | "unknown" | "settled" | "released";
  /** The hold ceiling, in credits. */
  maximum: number;
  /** What settlement charged, in credits — settled rows only, else null. */
  charged: number | null;
  /** Held capacity handed back unused, in credits — terminal rows only, else null. */
  released: number | null;
  /** The locked price basis the hold was admitted against, when the protocol wrote one. */
  provider: string | null;
  model: string | null;
  capability: string | null;
  /** The Bot the reservation was admitted for (06.12's attribution table), when known. */
  botId: string | null;
  botName: string | null;
  /** Why the hold entered `unknown` (06.8's evidence), verbatim — unknown rows carry it. */
  unknownReason: string | null;
  /** Why the hold was released, verbatim — released rows carry it. */
  releaseReason: string | null;
  createdAt: string;
  expiresAt: string;
  terminalAt: string | null;
};

/**
 * The personal credit read's whole answer (ticket 02.6): the signed-in user's own account, in
 * credits (×100 scaled units on the wire). The account is never a parameter — the route resolves
 * it from the authenticated identity through the payer resolution module — so the response names
 * the account type it answers, and a client can never be shown someone else's numbers under a
 * different label.
 *
 * `available` is the writer's own spendable figure (live grant capacity minus active holds and
 * the owed remainder unit, `readCapacity`), `consumed` the lifetime amount charged to the
 * account's grants, `expired` the lapsed-unused part of past grants, and `held` the open
 * reservations — the four numbers the parent spec says a user sees. `grants` carries every
 * grant of the account with its derived life, and `pendingSettlement` the group-06 placeholders.
 */
export type PersonalCreditBalance = {
  /** The billing subject kind the answer names — always the authenticated user's own. */
  accountType: "personal";
  /**
   * The account-level capability status (BP07/#375): a quarantined account's billing
   * capabilities are unavailable, and the row's own quarantine reason is the 能力不可用原因
   * the balance card displays. An account with no account row was never quarantined — `active`
   * is the absence of a quarantine fact, not a guess.
   */
  account: {
    status: "active" | "quarantined";
    quarantineReason: string | null;
  };
  /** What a new draw or hold could take right now, the gate's own admission figure. */
  available: number;
  /** The lifetime amount the account's grants have absorbed, live and expired grants alike. */
  consumed: number;
  /** The lapsed-unused part of expired grants — gone from the balance, visible here. */
  expired: number;
  /** Active holds against live grants: reserved, still occupying the balance. */
  held: number;
  /** Every grant of the account, soonest expiry first, with its derived status. */
  grants: readonly CreditGrantEntry[];
  /** Group 06's pending answer: the quota, its reserved/unknown split, and every reservation. */
  pendingSettlement: PendingSettlementSummary;
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
 * The ownership write (10.3, AC14/Q27): the owner pair resolved SERVER-SIDE from the paid
 * order at activation, plus the allowance period the order paid for. This is the ONLY input
 * that can name the ownership columns; the projection upsert's input carries no such fields,
 * so a webhook refresh or a sync call physically cannot move an owner.
 */
export type SubscriptionOwnershipStamp = {
  /** The customer the subscription row lives under — half of the row's identity (BP05). */
  externalCustomerId: string;
  externalSubscriptionId: string;
  ownerPayerKind: PayerKind;
  ownerPayerId: string;
  /** The billing period whose plan allowance the order paid for — the renewal marker. */
  allowancePeriodStart: Date;
  allowancePeriodEnd: Date;
};

/** A live subscription row that carries its owner — the renewal pass's walk (10.3). */
export type OwnedSubscriptionRow = {
  externalCustomerId: string;
  externalSubscriptionId: string;
  planCode: string;
  status: BillingSubscriptionStatus;
  ownerPayerKind: PayerKind;
  ownerPayerId: string;
  /** The period whose allowance has been covered; null until the first payout landed. */
  allowancePeriodStart: Date | null;
  allowancePeriodEnd: Date | null;
};

/**
 * The renewal payout (10.3): what the billing service needs to pay a period's allowance into
 * the subscription owner's account, and nothing more. The account key is derived by the
 * SERVICE from the row's own owner pair — a delivery's bytes carry no OpenBot identity — and
 * the idempotency key (`plan-renewal:<accountKey>:<externalSubscriptionId>:<periodStart>`,
 * composed in ./plan-renewals) is the ledger's own fence: a duplicate or racing delivery of
 * the same period is a no-op, while the next period's key never collides with the last one's,
 * and the account leading the key keeps a personal and a company subscription that share the
 * provider's id string from collapsing into one payout (BP05).
 */
export type SubscriptionRenewalGrantor = {
  /** Scaled credit units (×100) the plan's period allowance pays, or null when it grants none. */
  creditsFor(planCode: string): number | null;
  grantRenewal(input: {
    externalCustomerId: string;
    planCode: string;
    externalSubscriptionId: string;
    periodStart: Date;
    periodEnd: Date;
    totalCents: number;
  }): Promise<{ inserted: boolean }>;
};

/**
 * The projections the sync keeps, and the webhook inbox.
 *
 * An inbox row means "the projections this event implies have been refreshed" — it is written after
 * the re-read succeeds, never before, so a row always stands for finished work. Redelivery of a
 * known event is answered from the inbox alone; see the service for the ordering and why.
 */
export type BillingWebhookProjection = {
  /** An authoritative customer refresh, or an insert-only floor when the name is absent. */
  customer?: { externalId: string; name?: string | null };
  subscriptions?: readonly BillingSubscriptionRow[];
  /**
   * The customer whose FULL present list `subscriptions` is, straight from the provider's own
   * read: set only by a `subscription.*` delivery, and the scope its apply retires absent rows
   * inside the same transaction (audit B6). Absent means the delivery says nothing about
   * subscriptions — a `customer.*` event, an unprojected type — so nothing retires. The field
   * exists because an empty list names no customer of its own: the delivery's customer is the
   * only thing left to scope an everything-retires answer to.
   */
  subscriptionsPresentFor?: string;
  /**
   * Retirement evidence (audit B6 review r1): the count is captured at the retirement UPDATE
   * inside the apply transaction — the rows that transaction actually moved — because a number
   * read before the transaction can describe a retirement another delivery performed, or miss
   * one this delivery performs. The callback runs only once the transaction committed, so a
   * rolled-back apply (a duplicate loser) cannot have already told the world a retirement
   * happened. It is synchronous and must only log — I/O here would be a defect inside a
   * transaction.
   */
  onRetired?: (info: { externalCustomerId: string; count: number }) => void;
  event: {
    provider: string;
    eventId: string;
    uniqueKey?: string;
    webhookType: string;
    objectId?: string;
    /** sha256 of the raw body; the replay-evidence trail (audit A7). */
    bodyHash?: string;
  };
};

export type BillingStore = {
  /** Commit all local delivery work together; a duplicate retains the durable winner's writes. */
  applyWebhookProjection(
    input: BillingWebhookProjection,
  ): Promise<"processed" | "duplicate">;
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
  /**
   * Stamp the ownership pair and the allowance period onto one subscription row — the write
   * only the ACTIVATION path performs (10.3). Update-only, answered `false` when the row the
   * activation just created through `ensureSubscription` is absent: stamping a ghost would
   * quietly invent a subscription this deployment never projected. The conflict-free update
   * means a stamp never touches a row's provider facts (status/plan), and — because the
   * projection upsert names none of these columns — a delivery can never touch them either.
   */
  stampSubscriptionOwnership(
    input: SubscriptionOwnershipStamp,
  ): Promise<boolean>;
  /**
   * Advance the allowance marker (10.3's renewal marker), forward-only: a row whose marker
   * already names this period — or a later one — is left untouched, so an out-of-order or
   * racing delivery cannot walk the marker backwards. `false` means nothing moved.
   */
  advanceSubscriptionAllowance(input: {
    /** The customer the subscription row lives under — half of the row's identity (BP05). */
    externalCustomerId: string;
    externalSubscriptionId: string;
    allowancePeriodStart: Date;
    allowancePeriodEnd: Date;
  }): Promise<boolean>;
  /**
   * The live, OWNED subscription rows (10.3): the renewal pass's walk, scoped to one customer
   * when the caller is a delivery for that customer, deployment-wide for the sweep. Ownerless
   * rows are excluded — they have no account to pay (Q23), and the pass logs their skip.
   */
  readLiveOwnedSubscriptions(
    externalCustomerId?: string,
  ): Promise<readonly OwnedSubscriptionRow[]>;
  /**
   * Retire the local rows for one customer that the provider's own list no longer contains:
   * status → `terminated`, `updatedAt` → now. Returns how many rows moved. Never deletes —
   * the row is the audit of what this deployment believed.
   */
  retireAbsentSubscriptions(
    externalCustomerId: string,
    presentExternalSubscriptionIds: readonly string[],
  ): Promise<number>;
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
    /** sha256 of the raw body; absent on rows written before it existed (audit A7). */
    bodyHash?: string;
  }): Promise<boolean>;
  /** How many distinct event ids carried this exact body; >1 is replay evidence (audit A7). */
  countDeliveriesOfBody(bodyHash: string): Promise<number>;
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
  /**
   * sha256 of the raw body, lowercase hex. The signature does not cover the delivery's identity
   * header, so this is the evidence that ties "same content, different event id" together for
   * reconciliation (audit A7). Not a dedupe key: identical bodies under distinct event ids are
   * legitimate, if rare.
   */
  bodyHash: string;
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
   * Delivery-grade usage metering for the durable outbox: resolves only once the provider accepted
   * or deduplicated the event, and rejects with a `UsageDeliveryError` (no active subscription,
   * provider refusal) or the provider's `BillingError` (transient) so the caller can retry.
   */
  deliverUsage(input: {
    metricCode: string;
    properties: Record<string, number | string>;
    transactionId: string;
    timestamp?: Date;
    externalCustomerId?: string;
  }): Promise<void>;
  snapshot(): Promise<BillingSnapshot>;
  /**
   * The reconciliation pass (T7's skeleton): a READ-ONLY audit of the books' two invariants —
   * the payment three-way agreement (paid orders ↔ paid facts ↔ a live subscription in the
   * Lago projection) and the credit identity (Σ grants.used = Σ ledger.applied, per
   * customer) — answering a structured report; findings name their category/code/subject,
   * and an empty list is the books agreeing. Never repairs: reconciliation that fixes what
   * it finds erases the evidence. The pass is injected (see createBillingService's deps) and
   * absent keeps the honest refusal.
   */
  reconcile(): Promise<ReconcileReport>;
  /**
   * The renewal pass (10.3): every live owned subscription whose provider period has moved
   * past its allowance marker gets that period's payout into the owner's account, once — the
   * ledger key (`plan-renewal:<id>:<periodStart>`) is the fence. The webhook path runs it for
   * the delivery's subscriptions; this sweep asks the provider directly, so a period whose
   * notification never arrived still pays. Absent renewal config keeps it a no-op.
   */
  sweepRenewals(): Promise<void>;
};
