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
import { BillingError } from "../types";
import type { NotificationRefusal, PaymentProvider } from "./provider";
import type {
  PaymentAnomalyCode,
  PaymentCatalog,
  PaymentOrderReadScope,
  PaymentOrderRecord,
  PaymentOrderView,
  PaymentPlanEntry,
  PaymentProviderId,
  PaymentSettlementResult,
  PaymentStore,
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
};

/** Why a purchase request cannot proceed; the routes map these to 400/409. */
export type PurchaseRefusal =
  | { reason: "unknown-plan" }
  | { reason: "unknown-provider" }
  | { reason: "pending-purchase"; pendingPlanCode: string }
  | { reason: "active-subscription"; activePlanCode: string };

export class PurchaseError extends Error {
  override name = "PurchaseError";
  readonly refusal: PurchaseRefusal;
  constructor(refusal: PurchaseRefusal) {
    super(
      refusal.reason === "unknown-plan"
        ? "That plan is not purchasable here."
        : refusal.reason === "unknown-provider"
          ? "That channel is not configured on this deployment."
          : refusal.reason === "pending-purchase"
            ? "Another purchase is already pending for this deployment."
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
    /** The billing cycle, already normalized to `monthly` by the routes (v1's only cycle). */
    cycle: "monthly";
    createdBy: string | null;
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
    { amountCents: number; currency: "CNY"; periodMonths: number }
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
  now?: () => Date;
  log?: { warn(message: string): void };
}): PaymentService {
  const now = deps.now ?? (() => new Date());
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
      currency: "CNY",
      status: order.status,
      activationState: order.activationState,
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
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    return { start, end };
  }

  /**
   * The plan allowance payout, run inside activation after the subscription exists and before
   * `applied` is written. Idempotency: the grant's idempotency key is `plan:<orderId>`, so an
   * activation retried by the sweep, a replayed callback or a re-opened page inserts the grant
   * exactly once — the credit writer's insert-or-nothing against the unique index is the
   * guarantee, the same shape the paid fact uses.
   *
   * Answers whether the allowance is settled (granted, or rightly absent). `false` means the
   * payout has not landed, so the caller does NOT write `applied` and the sweep's next pass
   * re-runs the whole sequence — the subscription half is idempotent (read-before-create), the
   * grant half is idempotent (the key), so the retry converges. Writing `applied` over a failed
   * payout would strand the allowance with no sweeper ever looking at the order again.
   */
  async function grantPlanCreditsFor(
    order: PaymentOrderRecord,
  ): Promise<boolean> {
    const grantor = deps.grantor;
    if (!grantor) return true;
    const totalCents = grantor.creditsFor(order.planCode);
    // A plan the catalog grants no credits to (or a zero allowance) grants nothing — not an
    // error, not a warning: "this plan has no credit component" is a configured fact.
    if (totalCents === null || totalCents <= 0) return true;
    try {
      // The expiry aligns to the provider's period end. Unknown period (provider refused the
      // courtesy read) falls back to the order's own paid period — never to "no expiry", which
      // would make a one-month allowance permanent. Neither answering one withholds the grant
      // and keeps the order pending-activation: better a retried payout than an allowance with
      // no defensible expiry.
      const periodEnd =
        (await grantor.readCurrentPeriodEnd(order.planCode)) ??
        order.periodEnd;
      if (!periodEnd) {
        log.warn(
          `payments: plan ${order.planCode} credits withheld on order ${order.id} — neither the provider's period nor the order's own period answered an expiry`,
        );
        return false;
      }
      const { inserted } = await grantor.grantPlanCredits({
        externalCustomerId: deps.externalCustomerKey,
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
      return true;
    } catch {
      // The ledger refused: the subscription stands, but the allowance is not yet paid out.
      // `false` keeps the order out of `applied` so the sweep retries — the idempotency key is
      // what makes that retry safe.
      log.warn(
        `payments: plan credit grant for order ${order.id} failed; the activation retry re-runs it`,
      );
      return false;
    }
  }

  /**
   * Activation: the reconciliation gate, then the subscription, then the credit payout, then the
   * cache drop. Unreachable keeps the order pending-activation for the next pass; everything
   * terminal writes `failed`. A re-run on an already-applied order writes nothing.
   */
  async function activateOrder(
    order: PaymentOrderRecord,
  ): Promise<"applied" | "failed" | "pending" | "duplicate"> {
    if (order.activationState === "applied") return "applied";
    let ownership: Awaited<
      ReturnType<PaymentStore["resolveActivationOwnership"]>
    >;
    try {
      ownership = await deps.store.resolveActivationOwnership(order.id);
    } catch {
      return "pending";
    }
    if (ownership.outcome === "duplicate") {
      await recordDuplicatePaidEvidence(
        ownership.order,
        ownership.ownerOrder,
        order.channelTransactionId ?? order.id,
        order.amountCents,
      );
      return "duplicate";
    }
    if (ownership.outcome !== "owner") return "pending";
    order = ownership.order;
    try {
      const plan = await deps.lago.getPlan(order.planCode);
      if (!plan.found) {
        await deps.store.recordActivation(order.id, "failed");
        return "failed";
      }
      // The interval is the wire's word, compared as a string: the activation below creates a
      // monthly subscription, and a plan billed any other way is a mismatch worth refusing —
      // with no override, ever.
      if (plan.interval !== "monthly") {
        await deps.store.recordActivation(order.id, "failed");
        return "failed";
      }
      if (plan.currency !== "CNY") {
        if (!deps.acceptForeignCurrency) {
          await deps.store.recordActivation(order.id, "failed");
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
      if (!(await grantPlanCreditsFor(order))) return "pending";
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
        return "pending";
      }
      await deps.store.recordActivation(order.id, "failed").catch(() => {});
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
    fact: { channelTransactionId?: string; amountCents?: number },
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
    const fallbackPeriodMonths =
      deps.catalog.get(order.planCode)?.periodMonths ?? 1;
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

    // A cross-order duplicate is worth one more look on EVERY confirm, not only a canceled order
    // reviving: two QR codes can coexist only if one predates the pending-pair index, or the pair
    // spans providers (one pending alipay + one pending wechat — the index is per (plan,
    // provider), deliberately, because a channel switch is a legal flow). Either way, the same
    // plan already holding another paid order while this money lands means double collection for
    // one entitlement. The confirm STANDS — the money is real and the payer bought something —
    // the anomaly is what makes it visible to reconciliation instead of hiding inside a second
    const fresh = await deps.store.readOrder(order.id).catch(() => null);
    if (fresh) await activateOrder(fresh);
    return { kind: "claimed" };
  }

  return {
    catalog(canPurchase, activePlanCode) {
      const plans: PaymentPlanEntry[] = [...deps.catalog.entries()].map(
        ([planCode, entry]) => ({
          planCode,
          amountCents: entry.amountCents,
          currency: "CNY",
          periodMonths: entry.periodMonths,
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
        // v1's purchasable cycles: the two monthly spellings (see PaymentCatalog.cycles). The
        // routes' zod enum accepts exactly these; widening either side widens the other.
        cycles: ["monthly", "recurring_monthly"],
      };
    },

    async createPurchase(input) {
      const entry = deps.catalog.get(input.planCode);
      if (!entry) {
        throw new PurchaseError({ reason: "unknown-plan" });
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
      const active = await (deps.activePlanCodeUncached ?? deps.activePlanCode)();
      if (active !== null) {
        // One subscription at a time: the guard that also blocks the admin sync's other-plan
        // route, so an upgrade cannot bypass the front door.
        throw new PurchaseError({
          reason: "active-subscription",
          activePlanCode: active,
        });
      }

      // Replay: the same plan on the same channel, still open, comes back untouched. The read is
      // a fast path only — the pending-scope partial unique index and the store's conflict
      // re-read below are the actual guarantee, so concurrent requests converge on one order.
      const replayed = await deps.store
        .readPendingOrder(input.planCode, input.provider)
        .catch(() => null);
      if (replayed) return { order: toView(replayed) };

      const pending = await deps.store.readPendingPurchase().catch(() => null);
      if (pending) {
        if (pending.planCode !== input.planCode) {
          throw new PurchaseError({
            reason: "pending-purchase",
            pendingPlanCode: pending.planCode,
          });
        }
        if (pending.provider === input.provider) {
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
        amountCents: entry.amountCents,
        currency: "CNY",
        expiresAt,
        createdBy: input.createdBy,
        checkoutPayload: null,
      });
      if (conflict === "pending-pair") {
        // Another caller's insert won the same plan/provider slot while we were between the read
        // above and this insert. No second QR is created; the winner is the replay answer.
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
      const order = await deps.store.readLatestLiveOrder(scope).catch(() => null);
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
           * The exhaustion alarm (T5-2): a `failed` verdict is no longer terminal (the store
           * pass retries both pending AND failed — P1-4), but a paid order failing the SAME
           * gate for days is a fact an operator needs to see. After ACTIVATION_ALARM_AFTER
           * consecutive failed verdicts, one anomaly row names the order; the (order_id,
           * code) business key keeps it one row however long the order stays stuck, and a
           * success clears the counter.
           */
          if (outcome === "failed") {
            const strikes = activationStrikes.get(order.id) ?? 0;
            const next = strikes + 1;
            activationStrikes.set(order.id, next);
            if (next === ACTIVATION_ALARM_AFTER) {
              await recordAnomalyQuietly({
                orderId: order.id,
                code: "activation_retry_exhausted",
                channelTransactionId: order.channelTransactionId,
                amountCents: order.amountCents,
                detail: `activation refused ${next} passes in a row (plan ${order.planCode}); money collected, entitlement not landing — needs an operator`,
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
