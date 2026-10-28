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

import type { PayerRef } from "../payer";

/** The five states the local order can be in. Only forward; paid and blocked absorb. */
export type PaymentOrderStatus =
  | "pending"
  | "paid"
  | "blocked"
  | "canceled"
  | "expired";

/**
 * Activation is a property of a paid order, orthogonal to its money state.
 *
 * `failed` is the durable "owner claimed, not yet landed" state as well as "last activation
 * attempt failed": once a paid order wins an overlapping entitlement period, it leaves `pending`
 * before any external side effect so later overlapping collections can no longer steal ownership.
 *
 * `needs_resolution` (BP03/#371) is the deterministic-conflict verdict: an overlapping
 * entitlement another order already owns, or any conflict retrying cannot resolve. It is the
 * operator's queue, not the sweep's — the activation pass no longer lists it, and it is never
 * "delivered". Money facts and anomalies stay untouched underneath it.
 */
export type PaymentActivationState =
  | "pending"
  | "applied"
  | "failed"
  | "needs_resolution";

/**
 * The fulfillment progress a PAID order shows its reader (spec: 收款状态与交付状态独立 —
 * "已付款，权益处理中" is a different sentence from "支付成功"). Null while no money landed:
 * a pending, blocked, expired or canceled order owes no delivery and says so by absence.
 *
 * `processing` covers everything the sweep is still converging (`pending`/`failed` activation —
 * a failed rule verdict is the last pass's fact, not a terminal one); `delivered` means the
 * subscription AND the period's grant both landed; `needs_resolution` is the deterministic
 * conflict waiting for an operator.
 */
export type PaymentFulfillmentState =
  | "processing"
  | "delivered"
  | "needs_resolution";

/**
 * The one derivation of a paid order's fulfillment state (BP07/#375): the purchase surface's
 * `toView` and the statement read both answer from this function, so the checkout poll and the
 * payment-record list can never disagree about whether an order owes its reader "已付款，权益
 * 处理中". The rule itself is BP03's, lifted here verbatim from the service's `toView` — see
 * the type above for what each word means.
 */
export function fulfillmentStateOfOrder(order: {
  status: PaymentOrderStatus;
  activationState: PaymentActivationState;
}): PaymentFulfillmentState | null {
  if (order.status !== "paid") return null;
  if (order.activationState === "applied") return "delivered";
  if (order.activationState === "needs_resolution") return "needs_resolution";
  // pending AND failed — a failed rule verdict is the last pass's fact, not a terminal one.
  return "processing";
}

/** The two channels v1 collects through. */
export type PaymentProviderId = "alipay" | "wechat";

/** The durable result of deciding whether one paid channel fact may settle an order. */
export type PaymentSettlementResult =
  | { kind: "claimed" }
  | { kind: "duplicate" }
  | {
      kind: "refused";
      reason: "amount-mismatch" | "currency-mismatch" | "blocked" | "late";
    }
  | { kind: "retryable-failure" };

/**
 * One order, as the store holds it.
 *
 * `ownerPayerRef` is the order's payment subject, resolved server-side from the authenticated
 * identity at creation and bound at insert (AC14/Q27): the refund, the read scope and — from
 * 10.2 — the callback's credit all trace to it. It is null ONLY on legacy rows awaiting the
 * write-once attribution pass (`legacy-owner.ts`), and a null owner never matches a personal
 * read scope. `createdBy` is a different thing on purpose: the audit actor who opened the order,
 * which the domain keeps separate from the payment subject (CONTEXT.md, Payment Order).
 */
export type PaymentOrder = {
  id: string;
  planCode: string;
  provider: PaymentProviderId;
  /** Integer cents, the catalog price at order time. Never re-derived from a callback. */
  amountCents: number;
  /**
   * The currency the order snapshotted. The database CHECK keeps every row 'CNY' (no migration
   * widened it); the type is `string` so the code states the column's word instead of a hardcoded
   * one — the settlement gate compares against it (audit A5).
   */
  currency: string;
  status: PaymentOrderStatus;
  activationState: PaymentActivationState;
  /**
   * Why the last activation attempt did not land, in one stable word (BP03/#371: 每次失败保留
   * 原因) — `grant_write_failed`, `provider_unreachable`, `duplicate_paid`, the refusal rule's
   * name, … Null on an order that never failed or whose activation has since landed.
   */
  activationFailureReason: string | null;
  /**
   * When the sweep's next activation pass runs for this order: the failure's retained retry
   * schedule (spec: 每次失败保留…下一次重试时间). The sweep's fixed interval IS the scheduler —
   * this column is the recorded fact of when that next pass lands, rewritten on every failed
   * attempt and cleared when activation lands. Null on `needs_resolution` (no retry is coming)
   * and on applied orders.
   */
  activationNextRetryAt: Date | null;
  /** The channel's transaction id, once seen; the idempotency key across replays. */
  channelTransactionId: string | null;
  /** When the QR code stops being payable. */
  expiresAt: Date;
  /** The period the paid order buys, when known. */
  periodStart: Date | null;
  periodEnd: Date | null;
  /** When money landed on the order. Null unless the order actually reached `paid`. */
  paidAt: Date | null;
  /**
   * When the order reached a terminal money state (paid, blocked, canceled, expired). The anchor
   * for the late-payment fulfilment window: an expired order may still be paid inside
   * `terminalAt + window`, never after — the anchor is when it ended, not when it was created.
   */
  terminalAt: Date | null;
  /** The administrator who created it; the audit trail's actor — not the payment subject. */
  createdBy: string | null;
  /** The order's payment subject (see the type docblock). Null only pre-attribution. */
  ownerPayerRef: PayerRef | null;
  createdAt: Date;
  /** The optimistic-concurrency token every transition is CAS'd on. */
  version: number;
};

/** What a checkout renders. v1 ships QR codes only; `redirect` is named for a future wap flow. */
export type PaymentCheckout =
  | { kind: "qrcode"; payload: string }
  | { kind: "redirect"; url: string };

/** The signed-in actor whose own payment rows may be read, carried as the PayerRef the
 * server resolved from the session — never from a request field. Reads filter on the
 * order's owner columns, so a scope can only ever surface orders owned by exactly this
 * ref: another person's order, and any quarantined or pre-attribution row, answers null.
 */
export type PaymentOrderReadScope = {
  actorPayerRef: PayerRef;
};

/** One order, as the HTTP surface spells it. Times ISO-8601, amounts integer cents, no drift. */
export type PaymentOrderView = {
  orderId: string;
  planCode: string;
  provider: PaymentProviderId;
  amountCents: number;
  currency: string;
  status: PaymentOrderStatus;
  activationState: PaymentActivationState;
  /** The user-facing delivery progress — null unless money landed (see PaymentFulfillmentState). */
  fulfillmentState: PaymentFulfillmentState | null;
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
  /**
   * The billing cycles a purchase may actually name. v1 answers the two monthly spellings
   * only: yearly exists in the DISPLAY catalog but Lago has no yearly plan to activate, so
   * the server not offering it is what keeps the dialog honest (a hidden option cannot be
   * bought by accident). The day Lago carries yearly plans, this list widens and the dialog
   * follows — the contract, not the UI, is the gate.
   */
  cycles: readonly ("monthly" | "recurring_monthly")[];
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
 * payment outside the late-fulfilment window (`late_payment`), a paid fact whose amount the
 * channel did not state (`amount_unreadable`), a paid fact whose stated currency disagrees
 * with the order snapshot (`currency_mismatch`), an activation whose allowance cannot pay out
 * because the order resolves to no billable account (`unowned_payout`), and a delivery that
 * failed signature verification while naming an existing order (`callback_unverified` — the
 * delivery's contents are not evidence; only the attempt itself is being recorded).
 */
export type PaymentAnomalyCode =
  | "amount_mismatch"
  | "paid_after_blocked"
  | "over_paid"
  | "duplicate_paid"
  | "late_payment"
  | "amount_unreadable"
  | "currency_mismatch"
  | "activation_retry_exhausted"
  | "unowned_payout"
  | "callback_unverified";

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

/**
 * One stored event row, as the read-only projections answer it (BP07/#375): the payment record's
 * anomaly progress is these rows quoted — the code is the closed `PaymentAnomalyCode` vocabulary
 * by construction (only `recordAnomaly` and the settlement refusals write them), and the detail is
 * the writer's bounded words, never re-derived by a reader.
 */
export type PaymentOrderEventRecord = {
  id: string;
  orderId: string;
  kind: PaymentEventKind;
  code: string;
  state: string | null;
  channelTransactionId: string | null;
  amountCents: number | null;
  detail: string;
  createdAt: Date;
};

export type PaymentStore = {
  /**
   * Insert a fresh pending order, or hand back the one that already exists. The store generates
   * the order id itself (short, collision retried), so the caller never sees a database unique
   * violation; and the pending-scope partial unique index (deployment_scope WHERE status='pending')
   * makes a concurrent purchase answer the winner's row instead of opening a second payable order.
   * `pending-pair` means the winner matches the requested plan/provider and is replayed;
   * `pending-purchase` means another plan or provider owns the deployment slot.
   */
  insertOrder(input: {
    planCode: string;
    provider: PaymentProviderId;
    amountCents: number;
    currency: "CNY";
    expiresAt: Date;
    createdBy: string | null;
    /**
     * The order's payment subject, REQUIRED: the store refuses to write an ownerless order
     * (the service refuses one step earlier with a business answer; this is the last line).
     * The quarantined `unknown_owner` kind is refused too — an order can be attributed, or it
     * cannot be created; quarantine is a legacy-row verdict, never a new order's owner.
     */
    ownerPayerRef: PayerRef;
    checkoutPayload: string | null;
  }): Promise<{
    order: PaymentOrderRecord;
    conflict: "pending-pair" | "pending-purchase" | null;
  }>;
  /** The one order an out-trade number names, or null. */
  readOrder(
    id: string,
    scope?: PaymentOrderReadScope,
  ): Promise<PaymentOrderRecord | null>;
  /** The deployment's pending purchase, regardless of plan or provider. */
  readPendingPurchase(): Promise<PaymentOrderRecord | null>;
  /**
   * The newest order for one (plan, provider) pair still pending — the replay lookup. When
   * `owner` is passed, the lookup answers only that owner's pending order: a replay must
   * never hand back another person's open order (or its QR), whoever inserted it first.
   */
  readPendingOrder(
    planCode: string,
    provider: PaymentProviderId,
    owner?: PayerRef,
  ): Promise<PaymentOrderRecord | null>;
  /** The newest order still live (pending or paid) — what "current purchase" means. */
  readLatestLiveOrder(
    scope?: PaymentOrderReadScope,
  ): Promise<PaymentOrderRecord | null>;
  /** Attach the checkout artifact after the channel session opens (order first, code second). */
  setCheckoutPayload(id: string, payload: string): Promise<void>;
  /**
   * Cancel a pending order, CAS'd on the version it was read at. `false` means somebody moved it
   * first — the caller re-reads and re-decides, never overwrites.
   */
  cancelOrder(id: string, expectedVersion: number): Promise<boolean>;
  /**
   * One CAS on the order row plus the fact insert, one transaction. `claimed: false` means the
   * version moved or the fact was already known. Only `alreadyKnown: true` confirms a committed
   * duplicate; a plain CAS miss is not proof of settlement and must be retried after a fresh read.
   */
  confirmPaid(input: {
    id: string;
    expectedVersion: number;
    fromStatuses: readonly PaymentOrderStatus[];
    channelTransactionId: string;
    amountCents: number;
    periodStart: Date;
    periodEnd: Date;
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
  /**
   * Record the activation's landing: `applied` plus the provider's exact period, which also
   * CLEARS the retained failure columns — a landed activation has no outstanding failure.
   */
  recordActivation(
    id: string,
    activationState: "applied",
    period?: { start: Date; end: Date } | null,
  ): Promise<void>;
  /**
   * Record one activation attempt that did not land (BP03/#371). The failure `reason` (one
   * stable word) and the `nextRetryAt` schedule persist on the order row so a paid-but-undelivered
   * order can say why it is processing and when the next pass runs. `activationState` moves the
   * state only for verdicts that own it: `"failed"` (a rule refusal the sweep will retry — P1-4)
   * or `"needs_resolution"` (a deterministic conflict no retry can settle, e.g. an entitlement
   * another order already owns); omitted leaves the state as it stands, which is the transient
   * verdict's contract.
   */
  recordActivationFailure(input: {
    id: string;
    reason: string;
    nextRetryAt: Date | null;
    activationState?: "failed" | "needs_resolution";
  }): Promise<void>;
  /**
   * Resolve and DURABLY claim which overlapping paid order owns the entitlement period, under row
   * locks at the database boundary. When no owner exists yet, the deterministic winner leaves
   * `pending` inside this transaction before any external side effect runs, so a later overlapping
   * settlement cannot steal ownership.
   */
  resolveActivationOwnership(orderId: string): Promise<
    | {
        outcome: "owner";
        order: PaymentOrderRecord;
      }
    | {
        outcome: "duplicate";
        order: PaymentOrderRecord;
        ownerOrder: PaymentOrderRecord;
      }
    | {
        outcome: "unknown" | "not-paid";
      }
  >;
  /** The paid order already holding one channel transaction id, for duplicate evidence detail. */
  readPaidOrderByTransaction(
    channelTransactionId: string,
  ): Promise<PaymentOrderRecord | null>;
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
    scope?: PaymentOrderReadScope;
  }): Promise<readonly PaymentOrderRecord[]>;
  /** How many orders the same window holds, for the pager. */
  countOrdersInWindow(input: {
    from: Date | null;
    to: Date | null;
    scope?: PaymentOrderReadScope;
  }): Promise<number>;
  /**
   * The anomaly events of a page of orders, oldest first (BP07/#375): the read the payment
   * record's 异常进度 hangs on. `kind='anomaly'` only — a paid FACT is the money state the order
   * row already carries; listing it here would let a reader double-count a payment. Takes the
   * page's order ids in one call so a list read stays one query, not one per row.
   */
  listAnomalyEvents(
    orderIds: readonly string[],
  ): Promise<readonly PaymentOrderEventRecord[]>;
  /**
   * Paid orders whose activation has not landed — `pending` OR `failed` — for the sweeper's
   * activation-retry pass. `failed` included on purpose (P1-4): a rule-refused activation is a
   * verdict about the last pass, not a terminal state, and a paid order must never sit
   * unactivated because its first attempt hit a plan removed mid-flight. The NAME keeps its
   * historical spelling: this is a seam other suites double against, and the widened semantics
   * are documented here rather than costing every double a rename.
   */
  listPaidPendingActivationOrders(
    limit: number,
  ): Promise<readonly PaymentOrderRecord[]>;
};
