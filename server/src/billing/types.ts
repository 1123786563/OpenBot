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

/** What a customer is entitled to, flattened from its plan. */
export type BillingEntitlements = {
  active: boolean;
  planCode?: string;
  codes: readonly string[];
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

/** The current billing period's usage for one subscription, straight from the provider. */
export type BillingUsage = {
  fromDatetime?: string;
  toDatetime?: string;
  currency?: string;
  amountCents?: number;
  totalAmountCents?: number;
  charges: readonly BillingUsageCharge[];
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
  /** The active subscription's current-period usage, or null when there is no active one. */
  usage(externalCustomerId?: string): Promise<BillingUsage | null>;
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
