/**
 * The payments seam, sitting beside ./types (the Lago projection seam) rather than inside it.
 *
 * Same discipline: provider-neutral types here, channel vocabulary (trade_status, trade_state,
 * envelope keys, header names) in exactly one adapter file each. Errors are the billing seam's own
 * four sentinels (../types `BillingError`) — there is no fifth code to invent, because the failure
 * modes are the same three: the gateway cannot be reached (retryable), it answered with something
 * we cannot act on (terminal), or the deployment was wired wrong (terminal).
 *
 * A channel fact (`PaymentFact`) carries no local identity on purpose: the callback that carries it
 * is anonymous, and the local order is found by `outTradeNo` alone, the same way the Go
 * implementation this descends from kept its PaymentFact identity-free.
 */

/** The five states the local order can be in. Only forward; paid and blocked absorb. */
export type PaymentOrderStatus =
  | "pending"
  | "paid"
  | "blocked"
  | "canceled"
  | "expired";

/** Activation is a property of a paid order, orthogonal to its money state. */
export type PaymentActivationState = "pending" | "applied" | "failed";

/** The two channels v1 collects through. */
export type PaymentProviderId = "alipay" | "wechat";

/** One order, as the store holds it. */
export type PaymentOrder = {
  id: string;
  planCode: string;
  provider: PaymentProviderId;
  /** Integer cents, the catalog price at order time. Never re-derived from a callback. */
  amountCents: number;
  currency: "CNY";
  status: PaymentOrderStatus;
  activationState: PaymentActivationState;
  /** The channel's transaction id, once seen; the idempotency key across replays. */
  channelTransactionId: string | null;
  /** When the QR code stops being payable. */
  expiresAt: Date;
  /** The period the paid order buys, when known. */
  periodStart: Date | null;
  periodEnd: Date | null;
  /**
   * When the order reached a terminal money state (paid, blocked, canceled, expired). The anchor
   * for the late-payment fulfilment window: an expired order may still be paid inside
   * `terminalAt + window`, never after — the anchor is when it ended, not when it was created.
   */
  terminalAt: Date | null;
  /** The administrator who created it; the audit trail's actor. */
  createdBy: string | null;
  createdAt: Date;
  /** The optimistic-concurrency token every transition is CAS'd on. */
  version: number;
};

/** What a checkout renders. v1 ships QR codes only; `redirect` is named for a future wap flow. */
export type PaymentCheckout =
  | { kind: "qrcode"; payload: string }
  | { kind: "redirect"; url: string };

/** One order, as the HTTP surface spells it. Times ISO-8601, amounts integer cents, no drift. */
export type PaymentOrderView = {
  orderId: string;
  planCode: string;
  provider: PaymentProviderId;
  amountCents: number;
  currency: "CNY";
  status: PaymentOrderStatus;
  activationState: PaymentActivationState;
  checkout: PaymentCheckout | null;
  expiresAt: string;
  periodEnd: string | null;
  createdAt: string;
};

/** One catalog price, as the HTTP surface spells it. */
export type PaymentPlanEntry = {
  planCode: string;
  amountCents: number;
  currency: "CNY";
  periodMonths: number;
};

/** What the catalog endpoint answers: the prices plus who may buy and what is running. */
export type PaymentCatalog = {
  plans: readonly PaymentPlanEntry[];
  canPurchase: boolean;
  activePlanCode: string | null;
  /**
   * The channels this deployment actually configured, in stable order. The catalog is the one
   * place the configuration is disclosed, so every client renders — and every purchase names —
   * only channels that exist here; the service refuses any other name before an order row exists.
   */
  providers: readonly PaymentProviderId[];
};

/**
 * One order for the store's read paths, carrying the checkout payload separately: the QR string is
 * the one secret-ish artifact on the row and is only ever echoed to its creator, so reads that do
 * not need it (the sweeper, the callback path) do not fetch it.
 */
export type PaymentOrderRecord = PaymentOrder & {
  checkoutPayload: string | null;
};

/** The events the store retains, in two kinds. */
export type PaymentEventKind = "fact" | "anomaly";

/**
 * The anomaly words, fixed here so the trail stays greppable: an amount that did not match the
 * order's snapshot (`amount_mismatch`), a payment arriving after the order was already blocked
 * (`paid_after_blocked`), a second channel transaction on an already-paid order (`over_paid`),
 * a payment re-activating a plan that a newer paid order already covers (`duplicate_paid`), a
 * payment outside the late-fulfilment window (`late_payment`), and a paid fact whose amount the
 * channel did not state (`amount_unreadable`).
 */
export type PaymentAnomalyCode =
  | "amount_mismatch"
  | "paid_after_blocked"
  | "over_paid"
  | "duplicate_paid"
  | "late_payment"
  | "amount_unreadable";

/**
 * One money event on one order.
 *
 * `fact` rows are the authoritative "this channel transaction landed this money" records, unique
 * per channel transaction — a partial unique index enforces that only landed paid facts are unique,
 * so replays are INSERT-or-nothing. `anomaly` rows never claim that key: several anomalies can
 * coexist, and none of them blocks a later legitimate fact.
 */
export type PaymentEventInput = {
  orderId: string;
  kind: PaymentEventKind;
  /** A stable per-occurrence word, e.g. `paid`, `over-paid`, `amount-mismatch`, `late-payment`. */
  code: string;
  channelTransactionId: string | null;
  /** The amount the channel reported, when it reported one. Integer cents. */
  amountCents: number | null;
  detail: string;
};

export type PaymentStore = {
  /**
   * Insert a fresh pending order, or hand back the one that already exists. The store generates
   * the order id itself (short, collision retried), so the caller never sees a database unique
   * violation; and the pending-pair partial unique index ((plan, provider) WHERE status='pending')
   * makes a concurrent purchase of the same pair answer the winner's row — `conflict:
   * "pending-pair"` — instead of opening a second payable order. The replay answer is not an
   * error: the caller shows the existing order.
   */
  insertOrder(input: {
    planCode: string;
    provider: PaymentProviderId;
    amountCents: number;
    currency: "CNY";
    expiresAt: Date;
    createdBy: string | null;
    checkoutPayload: string | null;
  }): Promise<{ order: PaymentOrderRecord; conflict: "pending-pair" | null }>;
  /** The one order an out-trade number names, or null. */
  readOrder(id: string): Promise<PaymentOrderRecord | null>;
  /** The newest order for one (plan, provider) pair still pending — the replay lookup. */
  readPendingOrder(
    planCode: string,
    provider: PaymentProviderId,
  ): Promise<PaymentOrderRecord | null>;
  /** The newest paid order for one plan, any provider — the duplicate-payment check. */
  readLatestPaidOrder(planCode: string): Promise<PaymentOrderRecord | null>;
  /** The newest order still live (pending or paid) — what "current purchase" means. */
  readLatestLiveOrder(): Promise<PaymentOrderRecord | null>;
  /** Attach the checkout artifact after the channel session opens (order first, code second). */
  setCheckoutPayload(id: string, payload: string): Promise<void>;
  /**
   * Cancel a pending order, CAS'd on the version it was read at. `false` means somebody moved it
   * first — the caller re-reads and re-decides, never overwrites.
   */
  cancelOrder(id: string, expectedVersion: number): Promise<boolean>;
  /**
   * One CAS on the order row plus the fact insert, one transaction. `claimed: false` means the
   * version moved under us (someone else confirmed this very callback): the caller answers
   * duplicate-success, not failure. `alreadyKnown: true` means the channel transaction id is
   * already recorded as a paid fact — a replay from a different delivery.
   */
  confirmPaid(input: {
    id: string;
    expectedVersion: number;
    fromStatuses: readonly PaymentOrderStatus[];
    channelTransactionId: string;
    amountCents: number;
    periodStart: Date;
    periodEnd: Date;
    /** Whether the money state is allowed to move (blocked never is). Checked here, last. */
  }): Promise<{ claimed: boolean; alreadyKnown: boolean }>;
  /**
   * Move a pending order to blocked (amount/currency mismatch), writing the anomaly event in the
   * same transaction. Terminal: the sweeper never queries a blocked order again.
   */
  blockOrder(input: {
    id: string;
    expectedVersion: number;
    channelTransactionId: string | null;
    amountCents: number | null;
    detail: string;
  }): Promise<boolean>;
  /**
   * Move a pending order to expired (TTL passed, channel still says unpaid), CAS'd. The terminal
   * timestamp lands here, and it anchors the late-payment window.
   */
  expireOrder(id: string, expectedVersion: number): Promise<boolean>;
  /** Record an anomaly without moving the order (late payment, duplicate paid, over-pay). */
  recordAnomaly(event: PaymentEventInput): Promise<void>;
  /**
   * How many anomaly rows of one word one order holds. The `amount_unreadable` ENDGAME reads
   * this (a channel that cannot state an amount after N asks is not going to): the word is
   * excluded from the anomaly dedup index precisely so these rows accumulate into a count.
   */
  countAnomalies(orderId: string, code: string): Promise<number>;
  /** Record the paid fact alone, after a window transition the confirm transaction skipped. */
  recordPaidFact(event: {
    orderId: string;
    channelTransactionId: string;
    amountCents: number;
  }): Promise<boolean>;
  /** Record an activation outcome on a paid order (applied / failed). */
  recordActivation(
    id: string,
    activationState: PaymentActivationState,
  ): Promise<void>;
  /** Pending orders past their expiry, for the sweeper's query-first pass. */
  listExpiredPendingOrders(
    now: Date,
    limit: number,
  ): Promise<readonly PaymentOrderRecord[]>;
  /**
   * One window of orders, newest first, for the statement read.
   *
   * Every order is a bill whether or not money moved: a person looking at their billing history
   * needs the one that expired as much as the one that paid, because "I was billed" and "I tried
   * to pay" are the same question when you are looking at a list. The window is on `created_at`,
   * which is the only timestamp every order has — a pending one has no period and no terminal
   * moment to filter on.
   */
  listOrdersInWindow(input: {
    from: Date | null;
    to: Date | null;
    limit: number;
    offset: number;
  }): Promise<readonly PaymentOrderRecord[]>;
  /** How many orders the same window holds, for the pager. */
  countOrdersInWindow(input: {
    from: Date | null;
    to: Date | null;
  }): Promise<number>;
  /**
   * Paid orders whose activation has not landed yet, for the sweeper's activation-retry pass —
   * a paid order must never depend on somebody re-opening its page to become a subscription.
   */
  listPaidPendingActivationOrders(
    limit: number,
  ): Promise<readonly PaymentOrderRecord[]>;
};
