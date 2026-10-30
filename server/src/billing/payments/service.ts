/**
 * The payment orchestration: ordering, the anonymous callback's triage, activation into the
 * billing projection, and the expiry sweep — the only place the pieces above are wired together.
 *
 * The state machine is forward-only. `paid` and `blocked` absorb; `expired` and `canceled` may be
 * pulled back to `paid` inside the late-fulfilment window (anchored on `terminalAt`, the moment
 * the order ended — the window exists so an expiring-then-paying order loses no money, and it
 * closes after the configured hours so an expired QR cannot be replayed forever). Activation is
 * orthogonal progress on a paid order: it can fail and be retried without the money state moving.
 *
 * Every money transition runs through the store's single transaction (confirmPaid: CAS + paid
 * fact), so the idempotency answers a redelivery gives — same transaction id, another order's
 * transaction id, a concurrent confirmation — are all read from committed state. Callbacks are
 * answered from this triage alone; polling and the sweep share the same core, which is the
 * three-source convergence the flow relies on.
 */

import { getLogger } from "../../../../shared/logger";
import type { PayerRef } from "../payer";
import { payerKey } from "../payer";
import { BillingError } from "../types";
import type { NotificationRefusal, PaymentProvider } from "./provider";
import {
  fulfillmentStateOfOrder,
  type PaymentAnomalyCode,
  type PaymentCatalog,
  type PaymentOrderReadScope,
  type PaymentOrderRecord,
  type PaymentOrderView,
  type PaymentPlanEntry,
  type PaymentProviderId,
  type PaymentSettlementResult,
  type PaymentStore,
} from "./types";

/** What the payment service needs from the billing projection, and nothing more. */
export type PaymentLagoFacade = {
  /**
   * The reconciliation gate: the plan must exist at the provider, bill monthly (the interval the
   * activation creates on the wire) and — unless the deployment opted in — be priced in CNY.
   */
  getPlan(planCode: string): Promise<{
    found: boolean;
    interval?: string;
    currency?: string;
  }>;
  /** The same ensure the admin sync runs: read-before-create, idempotent under a race. */
  ensureSubscription(input: {
    externalCustomerId: string;
    externalSubscriptionId: string;
    planCode: string;
  }): Promise<{
    currentPeriodStart?: string | null;
    currentPeriodEnd?: string | null;
  }>;
  /**
   * 10.3 (AC14/Q27): stamp the subscription's owner — the paid order's payer, resolved
   * server-side — and the paid period onto the projection row. The activation call is the
   * only writer that names ownership; the projection refresh's own upsert names none of the
   * columns, so a delivery can never move an owner. Optional only so an assembly predating
   * the seam still compiles: production wires it (index.ts), and an assembly without it
   * logs a warning on every activation, never silently.
   */
  stampSubscriptionOwnership?(input: {
    /** The customer the subscription was ensured under — half of the row's identity (BP05). */
    externalCustomerId: string;
    externalSubscriptionId: string;
    ownerPayerKind: PayerRef["kind"];
    ownerPayerId: string;
    allowancePeriodStart: Date;
    allowancePeriodEnd: Date;
  }): Promise<boolean>;
};

/** Why a purchase request cannot proceed; the routes map these to 400/409. */
export type PurchaseRefusal =
  | { reason: "unknown-plan" }
  | {
      reason: "unknown-cycle";
      planCode: string;
      cycle: "monthly" | "recurring_monthly";
    }
  | { reason: "unknown-provider" }
  | { reason: "pending-purchase"; pendingPlanCode: string }
  | { reason: "active-subscription"; activePlanCode: string }
  | { reason: "missing-owner" };

export class PurchaseError extends Error {
  override name = "PurchaseError";
  readonly refusal: PurchaseRefusal;
  constructor(refusal: PurchaseRefusal) {
    super(
      refusal.reason === "unknown-plan"
        ? "That plan is not purchasable here."
        : refusal.reason === "unknown-cycle"
          ? `Plan "${refusal.planCode}" is not priced for cycle "${refusal.cycle}" on this deployment.`
          : refusal.reason === "unknown-provider"
            ? "That channel is not configured on this deployment."
            : refusal.reason === "pending-purchase"
              ? "Another purchase is already pending for this deployment."
              : refusal.reason === "missing-owner"
                ? "An order requires an owner resolved from the signed-in identity."
                : "This deployment already has an active subscription.",
    );
    this.refusal = refusal;
  }
}

/** How a callback was answered; only a durable claim/duplicate earns the channel's success ack. */
export type CallbackOutcome =
  | { kind: "success" }
  | {
      kind: "settlement-refused";
      settlement: Extract<PaymentSettlementResult, { kind: "refused" }>;
    }
  | { kind: "unknown-provider" }
  | { kind: "unverified"; refusal?: NotificationRefusal }
  | { kind: "not-success" }
  | { kind: "unknown-order" }
  | { kind: "store-failure" };

/**
 * The plan-allowance payout: what the payments module needs from the credit writer, and nothing
 * more. `creditsFor` answers the catalog's whole-credit number for the plan (scaled ×100 by the
 * caller that owns the catalog — kept out of the seam so the payments module keeps no second
 * copy of the scale), and `grantPlanCredits` records the deposit idempotently.
 *
 * `readCurrentPeriodEnd` supplies the expiry the grant aligns to (the provider's own period), so
 * the allowance lapses when the subscription's period does — not on a local +1 month guess.
 */
export type PlanCreditGrantor = {
  /** Scaled credit units (×100) for the plan, or null when the plan grants no credits. */
  creditsFor(planCode: string): number | null;
  grantPlanCredits(input: {
    /**
     * The account key the allowance lands in — derived by the SERVICE from the order's own
     * `ownerPayerRef` (payerKey), never the deployment's default key and never anything a
     * delivery carried. The caller of this seam only spells the account it was given
     * (10.2: the callback's payout follows the order's ownership).
     */
    externalCustomerId: string;
    planCode: string;
    /** The order whose activation pays this allowance out — the idempotency key's anchor. */
    orderId: string;
    totalCents: number;
    expiresAt: Date | null;
  }): Promise<{ inserted: boolean }>;
  /** The subscription's current period end at the provider, when it answers one. */
  readCurrentPeriodEnd(planCode: string): Promise<Date | null>;
};

/** The owner kinds a NEW order may carry; `unknown_owner` is a legacy-row verdict, not a buyer. */
const OWNABLE_PAYER_KINDS = new Set([
  "personal",
  "company",
  "legacy_deployment",
]);

/**
 * The owner a purchase binds, as the seam demands it: present, well-formed, whitespace-strict,
 * and never the quarantined kind. The ROUTE resolves this ref server-side from the session
 * (payer-personal's `resolvePayerForPersonalUser`); the service's job is to refuse to create
 * an order when no resolvable owner arrived — the AC14 answer to "missing ownership refuses
 * the order", and the guarantee that no caller can slip an ownerless or quarantined order
 * past the boundary.
 */
function isResolvableOwnerPayerRef(ref: PayerRef | undefined): ref is PayerRef {
  return (
    typeof ref === "object" &&
    ref !== null &&
    typeof ref.id === "string" &&
    ref.id.length > 0 &&
    ref.id.trim() === ref.id &&
    typeof ref.kind === "string" &&
    OWNABLE_PAYER_KINDS.has(ref.kind)
  );
}

export type PaymentService = {
  /** The catalog, price-snapshotted at boot; `canPurchase` and `activePlanCode` are the caller's. */
  catalog(canPurchase: boolean, activePlanCode: string | null): PaymentCatalog;
  /**
   * Open or replay one order. Same plan + same provider + still pending returns it untouched;
   * the same plan on a *different* provider cancels the old order (and best-effort closes it at
   * the channel) before the new one opens. The checkout arrives after the order row, so a channel
   * failure leaves a pending order to replay rather than a phantom.
   */
  createPurchase(input: {
    planCode: string;
    provider: PaymentProviderId;
    /**
     * The billing cycle being bought — one of the two monthly spellings the routes' zod
     * enum accepts. The price is read from the catalog's entry for THIS cycle (per-cycle
     * pricing); both cycles activate the same one-month Lago interval, so the cycle's only
     * other footprint is the amount charged.
     */
    cycle: "monthly" | "recurring_monthly";
    /** The audit actor who opened the order — not the payment subject (CONTEXT.md). */
    createdBy: string | null;
    /**
     * The order's payment subject, resolved SERVER-SIDE from the authenticated identity and
     * REQUIRED (AC14/Q27): a purchase without one is refused before any row exists, and the
     * quarantined `unknown_owner` kind never passes. Requests carry no ownership field at all.
     */
    ownerPayerRef: PayerRef;
  }): Promise<{ order: PaymentOrderView }>;
  /** One order as its creator may see it. A pending order's channel is asked once (the poll). */
  readOrder(
    id: string,
    scope?: PaymentOrderReadScope,
  ): Promise<{ order: PaymentOrderView | null; storeFailure?: boolean }>;
  /** The newest still-live order (pending or paid), or null — the settings page's "current". */
  readCurrentOrder(
    scope?: PaymentOrderReadScope,
  ): Promise<{ order: PaymentOrderView | null }>;
  /** Administrator cancel. Terminal states refuse; canceling twice is the same answer once. */
  cancelPurchase(
    id: string,
  ): Promise<
    | { outcome: "canceled"; order: PaymentOrderView }
    | { outcome: "idempotent"; order: PaymentOrderView }
    | { outcome: "unknown" }
    | { outcome: "terminal"; order: PaymentOrderView }
  >;
  /** One anonymous delivery, triaged. Never throws at the caller; the outcome is the answer. */
  handleCallback(
    providerId: string,
    headers: Headers,
    rawBody: string,
  ): Promise<CallbackOutcome>;
  /** The expiry pass: query-first on every pending order past its TTL, then close. */
  sweepExpired(): Promise<void>;
  /**
   * The activation pass: every paid order whose activation has not landed gets another attempt.
   * A paid order must never depend on somebody re-opening its page to become a subscription —
   * a failed activation (a plan removed mid-flight, a currency rule) is retried here forever, so
   * a rule fixed later still pays out.
   */
  sweepActivations(): Promise<void>;
};

export function createPaymentService(deps: {
  providers: ReadonlyMap<PaymentProviderId, PaymentProvider>;
  store: PaymentStore;
  catalog: ReadonlyMap<
    string,
    {
      currency: "CNY";
      /** 收款价按周期计价：cycleCode → amountCents。v1 仅两月度拼写可入目录。 */
      cycles: ReadonlyMap<"monthly" | "recurring_monthly", number>;
    }
  >;
  notifyBaseUrl: string;
  orderTtlMinutes: number;
  latePaymentWindowHours: number;
  acceptForeignCurrency: boolean;
  lago: PaymentLagoFacade;
  externalCustomerKey: string;
  /** The plan active at the provider right now — the single-subscription guard's fact. */
  activePlanCode(): Promise<string | null>;
  /**
   * The same guard's UNCACHED fact, read straight from the local subscription projection
   * (P1-5). `activePlanCode` above rides a 10-minute TTL cache whose failure fallback answers
   * "not active" — two windows the purchase guard must not inherit: a cache that lags a sync
   * or a provider blip would let a duplicate purchase through (money collected, activation
   * refused) or refuse a legitimate one for minutes. One indexed local read per purchase
   * attempt is cheap; absent falls back to the cached read (back-compat).
   */
  activePlanCodeUncached?(): Promise<string | null>;
  /** Called the moment activation lands, so the entitlement read never lags behind a payment. */
  invalidateEntitlementCache(): void;
  /**
   * The plan allowance's payout. Optional: an assembly that wires no credit writer (a deployment
   * testing payments before the ledger is on) still activates, just without granting.
   */
  grantor?: PlanCreditGrantor;
  /**
   * The cadence the activation sweep re-asks a paid order at (BP03/#371). The sweep interval IS
   * the scheduler — this value only computes the `activationNextRetryAt` fact a failed attempt
   * retains, so the recorded schedule and the real cadence cannot drift apart.
   */
  activationRetryDelayMs?: number;
  now?: () => Date;
  log?: { warn(message: string): void };
}): PaymentService {
  const now = deps.now ?? (() => new Date());
  // The sweep's pass cadence, as the retained-retry-schedule arithmetic (default 60s, the
  // maintenance sweep's own default — see ../payments/maintenance.ts).
  const activationRetryDelayMs = deps.activationRetryDelayMs ?? 60_000;
  // The shared server logger satisfies the narrow `{ warn }` shape, so the fallback is a
  // plain injection default — warnings route through the one logger, never bare stdout.
  const log = deps.log ?? getLogger("server");

  /*
   * Consecutive failed activation verdicts per paid order, this process. The exhaustion ALARM
   * (see sweepActivations) reads it; a restart simply re-arms it, because the anomaly the
   * alarm writes is idempotent per order anyway. Not a column, deliberately: it is alarm
   * bookkeeping, not money state.
   */
  const activationStrikes = new Map<string, number>();
  const ACTIVATION_ALARM_AFTER = 3;
  /*
   * How many "paid, but no amount" answers end the order (P2-3). Three balances two failure
   * shapes: a transient gateway hiccup (one bad answer) never blocks, and a channel that
   * genuinely cannot state amounts is ended within one poll interval's worth of sweeps rather
   * than asked forever.
   */
  const AMOUNT_UNREADABLE_LIMIT = 3;

  function notifyUrlFor(provider: PaymentProviderId): string {
    return `${deps.notifyBaseUrl}/api/payments/callbacks/${provider}`;
  }

  function addMonths(from: Date, months: number): Date {
    const to = new Date(from.getTime());
    to.setUTCMonth(to.getUTCMonth() + months);
    return to;
  }

  function toView(order: PaymentOrderRecord): PaymentOrderView {
    return {
      orderId: order.id,
      planCode: order.planCode,
      provider: order.provider,
      amountCents: order.amountCents,
      currency: order.currency,
      status: order.status,
      activationState: order.activationState,
      // "已付款，权益处理中" is a sentence about DELIVERY, not about money (BP03/#371: the two
      // states are independent). The rule lives in one place (fulfillmentStateOfOrder) so the
      // statement read answers the same word this poll does — see the helper's own account.
      fulfillmentState: fulfillmentStateOfOrder(order),
      // The QR exists to be paid once: a paid (or terminal) order stops showing it.
      checkout:
        order.status === "pending" && order.checkoutPayload
          ? { kind: "qrcode", payload: order.checkoutPayload }
          : null,
      expiresAt: order.expiresAt.toISOString(),
      periodEnd: order.periodEnd?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
    };
  }

  /**
   * Retain one activation attempt's failure (BP03/#371): the reason word and, unless the verdict
   * is a `needs_resolution` conflict (no retry is coming), the next pass's schedule. Best-effort
   * on purpose — a store that cannot take this write is the same store the sweep's next pass
   * reads through, and the retry itself is the recovery.
   */
  async function recordActivationFailureQuietly(
    id: string,
    reason: string,
    activationState?: "failed" | "needs_resolution",
  ): Promise<void> {
    try {
      await deps.store.recordActivationFailure({
        id,
        reason,
        nextRetryAt:
          activationState === "needs_resolution"
            ? null
            : new Date(now().getTime() + activationRetryDelayMs),
        ...(activationState ? { activationState } : {}),
      });
    } catch {
      // The order stays listed for the sweep; the next attempt rewrites the fact.
    }
  }

  function withinLateWindow(order: PaymentOrderRecord, at: Date): boolean {
    if (!order.terminalAt) return false;
    return (
      at.getTime() <=
      order.terminalAt.getTime() + deps.latePaymentWindowHours * 3600_000
    );
  }

  async function recordAnomalyQuietly(input: {
    orderId: string;
    code: PaymentAnomalyCode;
    channelTransactionId: string | null;
    amountCents: number | null;
    detail: string;
  }): Promise<boolean> {
    try {
      await deps.store.recordAnomaly({ ...input, kind: "anomaly" });
      return true;
    } catch {
      return false;
    }
  }

  async function recordDuplicatePaidEvidence(
    order: PaymentOrderRecord,
    ownerOrder: PaymentOrderRecord,
    transactionId: string,
    amountCents: number,
  ): Promise<boolean> {
    return recordAnomalyQuietly({
      orderId: order.id,
      code: "duplicate_paid",
      channelTransactionId: transactionId,
      amountCents,
      detail: `overlaps entitlement owned by ${ownerOrder.id} via ${ownerOrder.channelTransactionId ?? "unknown-transaction"}`,
    });
  }

  function exactPeriodOf(period: {
    currentPeriodStart?: string | null;
    currentPeriodEnd?: string | null;
  }): { start: Date; end: Date } | null {
    if (!period.currentPeriodStart || !period.currentPeriodEnd) return null;
    const start = new Date(period.currentPeriodStart);
    const end = new Date(period.currentPeriodEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
      return null;
    return { start, end };
  }

  /**
   * The plan allowance payout, run inside activation after the subscription exists and before
   * `applied` is written. Idempotency: the grant's idempotency key is `plan:<orderId>`, so an
   * activation retried by the sweep, a replayed callback or a re-opened page inserts the grant
   * exactly once — the credit writer's insert-or-nothing against the unique index is the
   * guarantee, the same shape the paid fact uses.
   *
   * Answers why the allowance has NOT settled, or null when it has (granted, or rightly absent).
   * A reason means the payout has not landed, so the caller does NOT write `applied` and the
   * sweep's next pass re-runs the whole sequence — the subscription half is idempotent
   * (read-before-create), the grant half is idempotent (the key), so the retry converges. Writing
   * `applied` over a failed payout would strand the allowance with no sweeper ever looking at
   * the order again.
   */
  async function grantPlanCreditsFor(
    order: PaymentOrderRecord,
  ): Promise<string | null> {
    const grantor = deps.grantor;
    if (!grantor) return null;
    const totalCents = grantor.creditsFor(order.planCode);
    // A plan the catalog grants no credits to (or a zero allowance) grants nothing — not an
    // error, not a warning: "this plan has no credit component" is a configured fact.
    if (totalCents === null || totalCents <= 0) return null;
    /*
     * THE recipient is the order's own owner (10.2/Q27/AC14): the payout lands in the account
     * the order bound at creation, and nothing else names it — the delivery's bytes carry no
     * user field the service would read, and the deployment's own key is not a fallback. An
     * order that resolves to NO billable account (a pre-attribution legacy row, or the
     * quarantined `unknown_owner` kind) has its allowance WITHHELD: the activation stays
     * un-applied so the sweep retries — converging the moment the write-once attribution pass
     * gives the row an owner — and the withheld payout is recorded (`unowned_payout`), never
     * silently dropped into a guessed account (Q23: stock deployment credits are not
     * auto-attributed).
     */
    let recipientKey: string | null = null;
    if (order.ownerPayerRef) {
      try {
        recipientKey = payerKey(order.ownerPayerRef);
      } catch {
        // The quarantined kind, or a malformed ref: no billable account, by design.
        recipientKey = null;
      }
    }
    if (recipientKey === null) {
      await recordAnomalyQuietly({
        orderId: order.id,
        code: "unowned_payout",
        channelTransactionId: order.channelTransactionId,
        amountCents: order.amountCents,
        detail: `plan credit payout withheld: the order resolves to no billable account (owner ${order.ownerPayerRef ? order.ownerPayerRef.kind : "absent"}); the activation retry re-runs it once an owner is attributed`,
      });
      log.warn(
        `payments: plan credit payout for order ${order.id} withheld — the order has no billable owner (Q23); the sweep retries after attribution`,
      );
      return "unowned_payout";
    }
    try {
      // The expiry aligns to the provider's period end. Unknown period (provider refused the
      // courtesy read) falls back to the order's own paid period — never to "no expiry", which
      // would make a one-month allowance permanent. Neither answering one withholds the grant
      // and keeps the order pending-activation: better a retried payout than an allowance with
      // no defensible expiry.
      const periodEnd =
        (await grantor.readCurrentPeriodEnd(order.planCode)) ?? order.periodEnd;
      if (!periodEnd) {
        log.warn(
          `payments: plan ${order.planCode} credits withheld on order ${order.id} — neither the provider's period nor the order's own period answered an expiry`,
        );
        return "grant_no_period";
      }
      const { inserted } = await grantor.grantPlanCredits({
        externalCustomerId: recipientKey,
        planCode: order.planCode,
        orderId: order.id,
        totalCents,
        expiresAt: periodEnd,
      });
      if (!inserted) {
        // The retry answer: the allowance this order pays was already granted. Expected under
        // the sweep's retry; a log line, not an anomaly — this is the idempotency working.
        log.warn(
          `payments: plan credit grant for order ${order.id} already recorded; nothing added`,
        );
      }
      return null;
    } catch {
      // The ledger refused: the subscription stands, but the allowance is not yet paid out.
      // The reason keeps the order out of `applied` so the sweep retries — the idempotency key
      // is what makes that retry safe.
      log.warn(
        `payments: plan credit grant for order ${order.id} failed; the activation retry re-runs it`,
      );
      return "grant_write_failed";
    }
  }

  /**
   * 10.3: the subscription row carries the order's owner — the pair resolved from the
   * persisted order (already duplicate-refused by `resolveActivationOwnership`), plus the
   * period the order paid for: the provider's exact period when it answered one, the order's
   * own snapshot otherwise. Answers why the stamp has NOT landed, or null when it has (or is
   * rightly absent): a reason keeps the order out of `applied` so the sweep's next pass re-runs
   * the whole idempotent sequence (the grant key and the stamp are both retry-safe); a stamp
   * that moved nothing silently would let a paid subscription sit unattributed forever.
   */
  async function stampOwnershipFor(
    order: PaymentOrderRecord,
    subscription: {
      currentPeriodStart?: string | null;
      currentPeriodEnd?: string | null;
    },
  ): Promise<string | null> {
    const stamp = deps.lago.stampSubscriptionOwnership;
    if (!stamp) {
      log.warn(
        `payments: order ${order.id} activated without a subscription-ownership stamp seam; the projection row stays unattributed`,
      );
      return null;
    }
    // A pre-attribution legacy order names nobody (Q23): the grant upstream already withheld
    // its payout, so its activation never reaches this branch in practice.
    const owner = order.ownerPayerRef;
    if (!owner) return null;
    const period =
      exactPeriodOf(subscription) ??
      (order.periodStart && order.periodEnd
        ? { start: order.periodStart, end: order.periodEnd }
        : null);
    if (!period) {
      log.warn(
        `payments: order ${order.id} answered no period for the ownership stamp; the activation retry re-runs it`,
      );
      return "stamp_no_period";
    }
    try {
      const stamped = await stamp({
        externalCustomerId: deps.externalCustomerKey,
        externalSubscriptionId: `${deps.externalCustomerKey}-${order.planCode}`,
        ownerPayerKind: owner.kind,
        ownerPayerId: owner.id,
        allowancePeriodStart: period.start,
        allowancePeriodEnd: period.end,
      });
      if (!stamped) {
        log.warn(
          `payments: ownership stamp for order ${order.id} found no subscription row; the activation retry re-runs it`,
        );
        return "stamp_missing";
      }
      return null;
    } catch {
      log.warn(
        `payments: ownership stamp for order ${order.id} failed; the activation retry re-runs it`,
      );
      return "stamp_failed";
    }
  }

  /**
   * Activation: the reconciliation gate, then the subscription, then the credit payout, then the
   * cache drop. Unreachable keeps the order pending-activation for the next pass; every verdict
   * that does not land retains its reason and next-retry schedule (BP03/#371). A DETERMINISTIC
   * conflict — an entitlement another order already owns — lands in `needs_resolution` instead of
   * an endless retry: the sweep stops listing it, the reader sees it unresolved, and the money
   * facts and anomaly evidence stay untouched for the operator. A re-run on an already-applied
   * order writes nothing.
   */
  async function activateOrder(
    order: PaymentOrderRecord,
  ): Promise<"applied" | "failed" | "pending" | "needs_resolution"> {
    if (order.activationState === "applied") return "applied";
    if (order.activationState === "needs_resolution") return "needs_resolution";
    let ownership: Awaited<
      ReturnType<PaymentStore["resolveActivationOwnership"]>
    >;
    try {
      ownership = await deps.store.resolveActivationOwnership(order.id);
    } catch {
      await recordActivationFailureQuietly(order.id, "ownership_unresolved");
      return "pending";
    }
    if (ownership.outcome === "duplicate") {
      await recordDuplicatePaidEvidence(
        ownership.order,
        ownership.ownerOrder,
        order.channelTransactionId ?? order.id,
        order.amountCents,
      );
      // The conflict is a fact about the data, not about a retry that has not happened yet:
      // needs_resolution is the operator's queue (the anomaly above is its evidence), and no
      // number of passes can make a second transaction the owner of a period already owned.
      await recordActivationFailureQuietly(
        order.id,
        "duplicate_paid",
        "needs_resolution",
      );
      return "needs_resolution";
    }
    if (ownership.outcome !== "owner") {
      await recordActivationFailureQuietly(order.id, "ownership_unresolved");
      return "pending";
    }
    order = ownership.order;
    try {
      const plan = await deps.lago.getPlan(order.planCode);
      if (!plan.found) {
        await recordActivationFailureQuietly(
          order.id,
          "plan_not_found",
          "failed",
        );
        return "failed";
      }
      // The interval is the wire's word, compared as a string: the activation below creates a
      // monthly subscription, and a plan billed any other way is a mismatch worth refusing —
      // with no override, ever.
      if (plan.interval !== "monthly") {
        await recordActivationFailureQuietly(
          order.id,
          "plan_interval_mismatch",
          "failed",
        );
        return "failed";
      }
      if (plan.currency !== "CNY") {
        if (!deps.acceptForeignCurrency) {
          await recordActivationFailureQuietly(
            order.id,
            "plan_currency_mismatch",
            "failed",
          );
          return "failed";
        }
        log.warn(
          `payments: plan ${order.planCode} is priced in ${plan.currency ?? "a non-CNY currency"}; activating under PAYMENT_ACCEPT_FOREIGN_CURRENCY — the order table (${order.id}, CNY ${order.amountCents}) remains the authority on what was collected`,
        );
      }
      const subscription = await deps.lago.ensureSubscription({
        externalCustomerId: deps.externalCustomerKey,
        externalSubscriptionId: `${deps.externalCustomerKey}-${order.planCode}`,
        planCode: order.planCode,
      });
      // The subscription is the entitlement; the credits are the allowance that rides with it.
      // Granted here — after `ensureSubscription` (no allowance without the entitlement it
      // belongs to) and before `recordActivation(applied)` (a payout that has not landed leaves
      // the activation un-applied, so the sweep's next pass retries it).
      const grantFailure = await grantPlanCreditsFor(order);
      if (grantFailure) {
        await recordActivationFailureQuietly(order.id, grantFailure);
        return "pending";
      }
      // The subscription row now carries the order's owner (10.3): stamped after the payout
      // (the allowance and the row name the same account) and before `applied`, so a stamp
      // that did not land is retried by the sweep like every other un-applied half.
      const stampFailure = await stampOwnershipFor(order, subscription);
      if (stampFailure) {
        await recordActivationFailureQuietly(order.id, stampFailure);
        return "pending";
      }
      deps.invalidateEntitlementCache();
      await deps.store.recordActivation(
        order.id,
        "applied",
        exactPeriodOf(subscription),
      );
      return "applied";
    } catch (error) {
      if (error instanceof BillingError && error.retryable) {
        // The provider could not be reached: activation stays pending and the next pass (poll,
        // callback replay, sweep) retries it. Writing `failed` here would strand a paid order.
        await recordActivationFailureQuietly(order.id, "provider_unreachable");
        return "pending";
      }
      await recordActivationFailureQuietly(
        order.id,
        "activation_error",
        "failed",
      );
      return "failed";
    }
  }

  /**
   * One paid fact against one order, shared by the callback, the poll and the sweep: the amount
   * gate, the replay verdicts, the window, and the single confirm transaction. A callback may
   * acknowledge only a claimed fact or a duplicate the store has confirmed.
   */
  async function settlePaidFact(
    order: PaymentOrderRecord,
    fact: {
      channelTransactionId?: string;
      amountCents?: number;
      currency?: string;
    },
  ): Promise<PaymentSettlementResult> {
    const at = now();
    const transactionId = fact.channelTransactionId ?? order.id;

    if (fact.amountCents === undefined) {
      const recorded = await recordAnomalyQuietly({
        orderId: order.id,
        code: "amount_unreadable",
        channelTransactionId: fact.channelTransactionId ?? null,
        amountCents: null,
        detail: "paid fact carried no comparable amount",
      });
      if (!recorded) return { kind: "retryable-failure" };
      if (order.status === "blocked") {
        return { kind: "refused", reason: "blocked" };
      }
      let strikes: number;
      try {
        strikes = await deps.store.countAnomalies(
          order.id,
          "amount_unreadable",
        );
      } catch {
        return { kind: "retryable-failure" };
      }
      if (strikes >= AMOUNT_UNREADABLE_LIMIT && order.status === "pending") {
        let blocked: boolean;
        try {
          blocked = await deps.store.blockOrder({
            id: order.id,
            expectedVersion: order.version,
            channelTransactionId: fact.channelTransactionId ?? null,
            amountCents: null,
            detail: `channel stated no amount ${strikes} times; blocked to end the sweep`,
          });
        } catch {
          return { kind: "retryable-failure" };
        }
        if (!blocked) return { kind: "retryable-failure" };
      }
      return { kind: "refused", reason: "amount-mismatch" };
    }
    /*
     * Currency before amount (audit A5): "49.00 USD" and "49.00 CNY" are the same integer and
     * different money. The channel's silence is not a mismatch — plenty of domestic notifications
     * carry no currency member — but a stated currency that disagrees with the order snapshot is
     * an operator case, never a settlement.
     */
    if (fact.currency !== undefined && fact.currency !== order.currency) {
      const recorded = await recordAnomalyQuietly({
        orderId: order.id,
        code: "currency_mismatch",
        channelTransactionId: transactionId,
        amountCents: fact.amountCents ?? null,
        detail: `channel reports ${fact.currency}, order snapshot says ${order.currency}`,
      });
      return recorded
        ? { kind: "refused", reason: "currency-mismatch" }
        : { kind: "retryable-failure" };
    }
    if (fact.amountCents !== order.amountCents) {
      if (order.status === "pending") {
        let blocked: boolean;
        try {
          blocked = await deps.store.blockOrder({
            id: order.id,
            expectedVersion: order.version,
            channelTransactionId: fact.channelTransactionId ?? null,
            amountCents: fact.amountCents,
            detail: `channel reports ${fact.amountCents}, order says ${order.amountCents}`,
          });
        } catch {
          return { kind: "retryable-failure" };
        }
        if (!blocked) return { kind: "retryable-failure" };
      } else {
        const recorded = await recordAnomalyQuietly({
          orderId: order.id,
          code: "amount_mismatch",
          channelTransactionId: fact.channelTransactionId ?? null,
          amountCents: fact.amountCents,
          detail: `report after ${order.status}`,
        });
        if (!recorded) return { kind: "retryable-failure" };
      }
      return { kind: "refused", reason: "amount-mismatch" };
    }

    if (order.status === "paid") {
      if (order.channelTransactionId === transactionId) {
        const ownership = await deps.store
          .resolveActivationOwnership(order.id)
          .catch(() => null);
        if (ownership?.outcome === "duplicate") {
          await recordDuplicatePaidEvidence(
            ownership.order,
            ownership.ownerOrder,
            transactionId,
            fact.amountCents,
          );
        }
        return { kind: "duplicate" };
      }
      const recorded = await recordAnomalyQuietly({
        orderId: order.id,
        code: "over_paid",
        channelTransactionId: transactionId,
        amountCents: fact.amountCents,
        detail: `a second transaction landed on a paid order`,
      });
      return recorded
        ? { kind: "refused", reason: "blocked" }
        : { kind: "retryable-failure" };
    }
    if (order.status === "blocked") {
      const recorded = await recordAnomalyQuietly({
        orderId: order.id,
        code: "paid_after_blocked",
        channelTransactionId: transactionId,
        amountCents: fact.amountCents,
        detail: "money arrived for an order already blocked on amount",
      });
      return recorded
        ? { kind: "refused", reason: "blocked" }
        : { kind: "retryable-failure" };
    }
    if (
      (order.status === "expired" || order.status === "canceled") &&
      !withinLateWindow(order, at)
    ) {
      const recorded = await recordAnomalyQuietly({
        orderId: order.id,
        code: "late_payment",
        channelTransactionId: transactionId,
        amountCents: fact.amountCents,
        detail: `outside the ${deps.latePaymentWindowHours}h window anchored at terminalAt`,
      });
      return recorded
        ? { kind: "refused", reason: "late" }
        : { kind: "retryable-failure" };
    }

    // The order snapshots a period the moment money lands, even if activation cannot reach Lago.
    // A successful activation later replaces this local fallback with the provider's exact period
    // when Lago answered one.
    // v1 collects the two monthly spellings only, so every priced cycle is one month — the
    // fallback period is the one month the activation will create, whatever cycle priced it.
    const fallbackPeriodMonths = 1;
    const fallbackPeriodStart = at;
    const fallbackPeriodEnd = addMonths(at, fallbackPeriodMonths);
    let result: { claimed: boolean; alreadyKnown: boolean };
    try {
      result = await deps.store.confirmPaid({
        id: order.id,
        expectedVersion: order.version,
        fromStatuses:
          order.status === "pending" ? ["pending"] : ["expired", "canceled"],
        channelTransactionId: transactionId,
        amountCents: fact.amountCents,
        periodStart: fallbackPeriodStart,
        periodEnd: fallbackPeriodEnd,
      });
    } catch {
      return { kind: "retryable-failure" };
    }
    if (!result.claimed) {
      if (result.alreadyKnown) {
        // This transaction's paid fact is held by another order: an anomaly about the data, and
        // no migration here — the first claim stands. The duplicate is already durably known, so
        // callback acknowledgement does not depend on best-effort anomaly persistence here.
        const owner = await deps.store
          .readPaidOrderByTransaction(transactionId)
          .catch(() => null);
        await recordAnomalyQuietly({
          orderId: order.id,
          code: "duplicate_paid",
          channelTransactionId: transactionId,
          amountCents: fact.amountCents,
          detail: owner
            ? `transaction ${transactionId} already settled on ${owner.id} via ${owner.channelTransactionId ?? transactionId}`
            : `transaction ${transactionId} already settled against another order`,
        });
        return { kind: "duplicate" };
      }
      // A stale CAS is not proof that this paid fact is already committed. Let a replay re-read
      // the order and establish either the winning fact or a durable duplicate.
      return { kind: "retryable-failure" };
    }

    /*
     * The confirm stands on its own evidence: the paid fact's partial unique index makes one
     * channel transaction claimable by exactly one order, and cross-order duplicates are settled
     * by `resolveActivationOwnership` inside `activateOrder` below (which records the
     * `duplicate_paid` anomaly and withholds the second entitlement). An earlier revision compared
     * `readLatestPaidOrder` here as well; that check was folded into the ownership resolution in
     * 88664e88, and this comment is the record of why nothing here looks like it.
     */
    const fresh = await deps.store.readOrder(order.id).catch(() => null);
    if (fresh) await activateOrder(fresh);
    return { kind: "claimed" };
  }

  return {
    catalog(canPurchase, activePlanCode) {
      const plans: PaymentPlanEntry[] = [...deps.catalog.entries()].map(
        ([planCode, entry]) => ({
          planCode,
          currency: entry.currency,
          cycles: [...entry.cycles.entries()]
            .map(([code, amountCents]) => ({ code, amountCents }))
            .sort((a, b) => a.code.localeCompare(b.code)),
        }),
      );
      plans.sort((a, b) => a.planCode.localeCompare(b.planCode));
      // The configured channels, in a stable order the UI can render and a purchase must name.
      const providers = [...deps.providers.keys()].sort();
      return {
        plans,
        canPurchase,
        activePlanCode,
        providers,
        // The cycles some plan actually prices — a purchase may name exactly these; each
        // plan's own priced cycles ride on its plans[] entry (the dialog intersects with the
        // display catalog's cycles per plan).
        cycles: [
          ...new Set(plans.flatMap((p) => p.cycles.map((c) => c.code))),
        ].sort(),
      };
    },

    async createPurchase(input) {
      // Ownership first, before anything the request chose is even looked at: an order binds a
      // server-resolved PayerRef or it does not happen (AC14). Nothing below can create an
      // ownerless or quarantined order.
      if (!isResolvableOwnerPayerRef(input.ownerPayerRef)) {
        throw new PurchaseError({ reason: "missing-owner" });
      }
      const entry = deps.catalog.get(input.planCode);
      if (!entry) {
        throw new PurchaseError({ reason: "unknown-plan" });
      }
      // Per-cycle pricing: the amount is the catalog's price for the cycle this request named.
      // A plan whose catalog prices no such cycle (a cycle the display catalog offers but the
      // collector does not) is refused before any order row exists.
      const amountCents = entry.cycles.get(input.cycle);
      if (amountCents === undefined) {
        throw new PurchaseError({
          reason: "unknown-cycle",
          planCode: input.planCode,
          cycle: input.cycle,
        });
      }
      // The channel must be one this deployment configured — checked BEFORE the replay lookup
      // and the order row, so a wrong channel can neither strand a pending order no sweeper can
      // query nor surface as a plan refusal.
      const provider = deps.providers.get(input.provider);
      if (!provider) {
        throw new PurchaseError({ reason: "unknown-provider" });
      }
      // The single-subscription guard, on the UNCACHED read when the assembly wired one (the
      // projection is one indexed query; the cached read lags syncs by its TTL and its failure
      // fallback answers "not active" — either window lets a duplicate purchase through, which
      // is money collected against an activation the service will refuse).
      const active = await (
        deps.activePlanCodeUncached ?? deps.activePlanCode
      )();
      if (active !== null) {
        // One subscription at a time: the guard that also blocks the admin sync's other-plan
        // route, so an upgrade cannot bypass the front door.
        throw new PurchaseError({
          reason: "active-subscription",
          activePlanCode: active,
        });
      }

      // Replay: the same plan on the same channel at the SAME cycle's price, still open, comes
      // back untouched. The read is OWNER-SCOPED (AC14: another person's open order is neither
      // replayed nor shown) and a fast path only — the pending-scope partial unique index and
      // the store's conflict re-read below are the actual guarantee, so concurrent requests
      // converge on one order. A different amount is a cycle switch: it falls through to the
      // cancel-and-reopen path below rather than replaying a price the caller did not name.
      const replayed = await deps.store
        .readPendingOrder(input.planCode, input.provider, input.ownerPayerRef)
        .catch(() => null);
      if (replayed && replayed.amountCents === amountCents)
        return { order: toView(replayed) };

      const pending = await deps.store.readPendingPurchase().catch(() => null);
      if (pending) {
        // The deployment holds one pending purchase at a time. If it belongs to someone else,
        // this request refuses — it must NEVER replay the other person's view (and its QR) or
        // cancel their open order in the channel-switch path below.
        if (
          pending.ownerPayerRef?.kind !== input.ownerPayerRef.kind ||
          pending.ownerPayerRef?.id !== input.ownerPayerRef.id
        ) {
          throw new PurchaseError({
            reason: "pending-purchase",
            pendingPlanCode: pending.planCode,
          });
        }
        if (pending.planCode !== input.planCode) {
          throw new PurchaseError({
            reason: "pending-purchase",
            pendingPlanCode: pending.planCode,
          });
        }
        // Same plan, same channel, same cycle's price: replay. A different price means a
        // different cycle (per-cycle pricing prices each cycle distinctly at boot's
        // cross-check) — the switch reopens below, exactly like a channel switch, so changing
        // 连续包月↔单月 mid-checkout replaces the order instead of replaying the wrong price.
        if (
          pending.provider === input.provider &&
          pending.amountCents === amountCents
        ) {
          return { order: toView(pending) };
        }

        // A same-plan channel switch cancels the old order first — locally for certain (CAS),
        // remotely best-effort (a close that fails leaves the channel to time out on its own).
        const canceled = await deps.store
          .cancelOrder(pending.id, pending.version)
          .catch(() => false);
        if (!canceled) {
          const latest = await deps.store
            .readOrder(pending.id)
            .catch(() => null);
          if (latest?.status === "paid") return { order: toView(latest) };
          if (!latest || latest.status === "pending") {
            throw new PurchaseError({
              reason: "pending-purchase",
              pendingPlanCode: pending.planCode,
            });
          }
        } else {
          const oldProvider = deps.providers.get(pending.provider);
          try {
            await oldProvider?.closePayment(pending.id);
          } catch {
            // The channel-side order dies at its own expiry; the local one is terminal.
          }
        }
      }

      const expiresAt = new Date(
        now().getTime() + deps.orderTtlMinutes * 60_000,
      );
      const { order, conflict } = await deps.store.insertOrder({
        planCode: input.planCode,
        provider: input.provider,
        amountCents,
        currency: "CNY",
        expiresAt,
        createdBy: input.createdBy,
        ownerPayerRef: input.ownerPayerRef,
        checkoutPayload: null,
      });
      if (conflict === "pending-pair") {
        // Another caller's insert won the same plan/provider slot while we were between the read
        // above and this insert. No second QR is created; the winner is the replay answer — but
        // ONLY for the same owner: the store's conflict re-read is deployment-wide (the pending
        // slot is single), so a winner belonging to someone else is a refusal here, never a
        // replay of another person's order view.
        if (
          order.ownerPayerRef?.kind !== input.ownerPayerRef.kind ||
          order.ownerPayerRef?.id !== input.ownerPayerRef.id
        ) {
          throw new PurchaseError({
            reason: "pending-purchase",
            pendingPlanCode: order.planCode,
          });
        }
        return { order: toView(order) };
      }
      if (conflict === "pending-purchase") {
        throw new PurchaseError({
          reason: "pending-purchase",
          pendingPlanCode: order.planCode,
        });
      }

      // Order first, code second: a channel failure here leaves a pending order that a retry
      // replays into, instead of a QR the ledger cannot account for. The session create itself
      // retries the sandbox gateway's load-shedding (404/302 HTML, mapped to retryable
      // unreachable) a bounded two times — a retried create replays into this same pending
      // order, so no second order row can appear.
      let session: Awaited<ReturnType<typeof provider.createSession>>;
      for (let attempt = 1; ; attempt += 1) {
        try {
          session = await provider.createSession({
            outTradeNo: order.id,
            description: `OpenBot plan ${order.planCode} · one month`,
            amountCents: order.amountCents,
            currency: "CNY",
            notifyUrl: notifyUrlFor(input.provider),
            expiresAt: order.expiresAt,
          });
          break;
        } catch (error) {
          const retryable =
            error instanceof BillingError && error.retryable && attempt < 3;
          if (!retryable) throw error;
        }
      }
      if (session.checkout.kind === "qrcode") {
        await deps.store.setCheckoutPayload(order.id, session.checkout.payload);
      }
      const fresh = await deps.store.readOrder(order.id);
      return { order: toView(fresh ?? { ...order, checkoutPayload: null }) };
    },

    async readOrder(id, scope) {
      const order = await deps.store.readOrder(id, scope).catch(() => null);
      if (!order) return { order: null };

      // The poll's one side effect: a pending order gets its channel asked once. Money found
      // here flows through the same settle core as a callback would.
      if (order.status === "pending") {
        const provider = deps.providers.get(order.provider);
        if (provider) {
          try {
            const fact = await provider.queryPayment(order.id);
            if (fact.state === "paid") {
              await settlePaidFact(order, fact);
            }
          } catch {
            // Unreachable: the answer is the order as it stands, and the poll tries again.
          }
        }
      }
      const fresh = await deps.store.readOrder(id, scope).catch(() => null);
      return { order: fresh ? toView(fresh) : toView(order) };
    },

    async readCurrentOrder(scope) {
      const order = await deps.store
        .readLatestLiveOrder(scope)
        .catch(() => null);
      return { order: order ? toView(order) : null };
    },

    async cancelPurchase(id) {
      const order = await deps.store.readOrder(id).catch(() => null);
      if (!order) return { outcome: "unknown" as const };
      if (
        order.status === "paid" ||
        order.status === "expired" ||
        order.status === "blocked"
      ) {
        return { outcome: "terminal" as const, order: toView(order) };
      }
      if (order.status === "canceled") {
        return { outcome: "idempotent" as const, order: toView(order) };
      }
      const done = await deps.store
        .cancelOrder(id, order.version)
        .catch(() => false);
      if (!done) {
        const fresh = await deps.store.readOrder(id).catch(() => null);
        if (!fresh) return { outcome: "unknown" as const };
        return fresh.status === "canceled"
          ? { outcome: "idempotent" as const, order: toView(fresh) }
          : { outcome: "terminal" as const, order: toView(fresh) };
      }
      const provider = deps.providers.get(order.provider);
      if (provider) {
        try {
          await provider.closePayment(id);
        } catch {
          // Best-effort: the channel-side order still dies at its expiry.
        }
      }
      const fresh = await deps.store.readOrder(id).catch(() => null);
      return {
        outcome: "canceled" as const,
        order: toView(fresh ?? { ...order, status: "canceled" }),
      };
    },

    async handleCallback(providerId, headers, rawBody) {
      const provider = deps.providers.get(providerId as PaymentProviderId);
      if (!provider || providerId !== provider.id) {
        return { kind: "unknown-provider" };
      }

      let verified: Awaited<ReturnType<typeof provider.verifyNotification>>;
      try {
        verified = await provider.verifyNotification(headers, rawBody);
      } catch {
        return { kind: "unverified" };
      }
      if (!verified.ok) {
        /*
         * Signature-failure discipline (10.2): nothing about any order moves, and the attempt
         * is not silently dropped — when the raw bytes even name an order and that order
         * exists, one anomaly row anchors the attempt to it. The name is UNVERIFIED data: it
         * decides nothing about the order, and the detail says so; the (order, code) dedup
         * index keeps a repeat delivery from stacking rows. A delivery that names no existing
         * order leaves no row at all — fabricating one from attacker-chosen bytes would be a
         * worse record than the refusal itself, and the HTTP 401 is that refusal.
         */
        const referenced = verified.referencedOutTradeNo;
        if (referenced) {
          const named = await deps.store
            .readOrder(referenced)
            .catch(() => null);
          if (named) {
            await recordAnomalyQuietly({
              orderId: named.id,
              code: "callback_unverified",
              channelTransactionId: null,
              amountCents: null,
              detail: `a delivery naming this order failed signature verification${verified.refusal ? ` (${verified.refusal})` : ""}; its contents are not evidence and nothing moved`,
            });
          }
        }
        return { kind: "unverified", refusal: verified.refusal };
      }
      const fact = verified.fact;

      // A verified delivery that is not money: the channel is told so, and it retries if it
      // disagrees. Nothing about any order moves.
      if (fact.state !== "paid") {
        return { kind: "not-success" };
      }

      let order: PaymentOrderRecord | null;
      try {
        order = await deps.store.readOrder(fact.outTradeNo);
      } catch {
        return { kind: "store-failure" };
      }
      if (!order) {
        return { kind: "unknown-order" };
      }

      let settlement: PaymentSettlementResult;
      try {
        settlement = await settlePaidFact(order, fact);
      } catch {
        return { kind: "store-failure" };
      }
      switch (settlement.kind) {
        case "claimed":
        case "duplicate":
          return { kind: "success" };
        case "refused":
          return { kind: "settlement-refused", settlement };
        case "retryable-failure":
          return { kind: "store-failure" };
      }
    },

    async sweepExpired() {
      const at = now();
      const expired = await deps.store
        .listExpiredPendingOrders(at, 100)
        .catch(() => []);
      for (const order of expired) {
        const provider = deps.providers.get(order.provider);
        if (!provider) continue;
        let fact: Awaited<ReturnType<typeof provider.queryPayment>>;
        try {
          fact = await provider.queryPayment(order.id);
        } catch {
          // Unreachable (or an answer nothing could act on): skip; the next pass asks again
          // before anything expires twice. The channel's TERMINAL verdicts are not exceptions —
          // each adapter spells "no such order" (WeChat's 404, Alipay's ACQ.TRADE_NOT_EXIST) as
          // a closed fact, so a settled answer can never strand here as a thrown error.
          continue;
        }
        if (fact.state === "paid") {
          await settlePaidFact(order, fact);
          continue;
        }
        // Still unpaid (or closed at the channel): the order expires for certain, terminalAt
        // lands now, and only then is the channel-side order closed — a close that comes back
        // "already paid" is left to the next pass's query, never turned into a local paid.
        const done = await deps.store
          .expireOrder(order.id, order.version)
          .catch(() => false);
        if (done) {
          try {
            await provider.closePayment(order.id);
          } catch {
            // The next sweep's query re-reads the truth; a failed close is not a lost order.
          }
        }
      }
    },

    async sweepActivations() {
      const orders = await deps.store
        .listPaidPendingActivationOrders(100)
        .catch(() => [] as const);
      for (const order of orders) {
        try {
          const outcome = await activateOrder(order);
          /*
           * The exhaustion alarm (T5-2, widened by BP03/#371): a paid order whose activation
           * has not LANDED — a rule refusal (`failed`, retried per P1-4 because the rule can
           * change) or a transient verdict (`pending`: provider unreachable, ledger refusing)
           * — pass after pass is a fact an operator needs to see. After ACTIVATION_ALARM_AFTER
           * consecutive not-landed verdicts, one anomaly row names the order; the (order_id,
           * code) business key keeps it one row however long the order stays stuck, and any
           * settled or escalated verdict clears the counter. `needs_resolution` orders never
           * reach here at all — the store pass no longer lists them, and their conflict
           * already wrote its own evidence.
           */
          if (outcome === "failed" || outcome === "pending") {
            const strikes = activationStrikes.get(order.id) ?? 0;
            const next = strikes + 1;
            activationStrikes.set(order.id, next);
            if (next === ACTIVATION_ALARM_AFTER) {
              await recordAnomalyQuietly({
                orderId: order.id,
                code: "activation_retry_exhausted",
                channelTransactionId: order.channelTransactionId,
                amountCents: order.amountCents,
                detail: `activation has not landed in ${next} passes in a row (plan ${order.planCode}, last reason ${order.activationFailureReason ?? "unknown"}); money collected, entitlement not landing — needs an operator`,
              });
            }
          } else {
            activationStrikes.delete(order.id);
          }
        } catch {
          // One order's failure is not the batch's: the next pass re-asks. Anything thrown
          // here is transport; the retryable verdict already left the order pending.
        }
      }
    },
  };
}
