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
import { BillingError } from "../types";
import type {
  PaymentAnomalyCode,
  PaymentCatalog,
  PaymentOrderRecord,
  PaymentOrderView,
  PaymentPlanEntry,
  PaymentProviderId,
  PaymentStore,
} from "./types";
import type { NotificationRefusal, PaymentProvider } from "./provider";
import { getLogger } from "../../../../shared/logger";

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
  }): Promise<void>;
};

/** Why a purchase request cannot proceed; the routes map these to 400/409. */
export type PurchaseRefusal =
  | { reason: "unknown-plan" }
  | { reason: "unknown-provider" }
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
          : "This deployment already has an active subscription.",
    );
    this.refusal = refusal;
  }
}

/** How a callback was answered; the routes translate this to the channel's wire shapes. */
export type CallbackOutcome =
  | { kind: "success" }
  | { kind: "unknown-provider" }
  | { kind: "unverified"; refusal?: NotificationRefusal }
  | { kind: "not-success" }
  | { kind: "unknown-order" }
  | { kind: "store-failure" };

export type PaymentService = {
  /** The catalog, price-snapshotted at boot; `canPurchase` and `activePlanCode` are the caller's. */
  catalog(
    canPurchase: boolean,
    activePlanCode: string | null,
  ): PaymentCatalog;
  /**
   * Open or replay one order. Same plan + same provider + still pending returns it untouched;
   * the same plan on a *different* provider cancels the old order (and best-effort closes it at
   * the channel) before the new one opens. The checkout arrives after the order row, so a channel
   * failure leaves a pending order to replay rather than a phantom.
   */
  createPurchase(input: {
    planCode: string;
    provider: PaymentProviderId;
    createdBy: string | null;
  }): Promise<{ order: PaymentOrderView }>;
  /** One order as its creator may see it. A pending order's channel is asked once (the poll). */
  readOrder(
    id: string,
  ): Promise<{ order: PaymentOrderView | null; storeFailure?: boolean }>;
  /** The newest still-live order (pending or paid), or null — the settings page's "current". */
  readCurrentOrder(): Promise<{ order: PaymentOrderView | null }>;
  /** Administrator cancel. Terminal states refuse; canceling twice is the same answer once. */
  cancelPurchase(id: string): Promise<
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
};

export function createPaymentService(deps: {
  providers: ReadonlyMap<PaymentProviderId, PaymentProvider>;
  store: PaymentStore;
  catalog: ReadonlyMap<string, { amountCents: number; currency: "CNY"; periodMonths: number }>;
  notifyBaseUrl: string;
  orderTtlMinutes: number;
  latePaymentWindowHours: number;
  acceptForeignCurrency: boolean;
  lago: PaymentLagoFacade;
  externalCustomerKey: string;
  /** The plan active at the provider right now — the single-subscription guard's fact. */
  activePlanCode(): Promise<string | null>;
  /** Called the moment activation lands, so the entitlement read never lags behind a payment. */
  invalidateEntitlementCache(): void;
  now?: () => Date;
  log?: { warn(message: string): void };
}): PaymentService {
  const now = deps.now ?? (() => new Date());
  // The shared server logger satisfies the narrow `{ warn }` shape, so the fallback is a
  // plain injection default — warnings route through the one logger, never bare stdout.
  const log = deps.log ?? getLogger("server");

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
  }): Promise<void> {
    try {
      await deps.store.recordAnomaly({ ...input, kind: "anomaly" });
    } catch {
      // An anomaly that cannot be written is a logging miss, not a failed delivery: the caller
      // is answering a channel, and the ack must not hinge on the trail.
    }
  }

  /**
   * Activation: the reconciliation gate, then the subscription, then the cache drop. Unreachable
   * keeps the order pending-activation for the next pass; everything terminal writes `failed`.
   * A re-run on an already-applied order writes nothing.
   */
  async function activateOrder(
    order: PaymentOrderRecord,
  ): Promise<"applied" | "failed" | "pending"> {
    if (order.activationState === "applied") return "applied";
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
      await deps.lago.ensureSubscription({
        externalCustomerId: deps.externalCustomerKey,
        externalSubscriptionId: `${deps.externalCustomerKey}-${order.planCode}`,
        planCode: order.planCode,
      });
      deps.invalidateEntitlementCache();
      await deps.store.recordActivation(order.id, "applied");
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
   * gate, the replay verdicts, the window, and the single confirm transaction.
   * Answers whether money moved (`claimed`), so only that caller activates.
   */
  async function settlePaidFact(
    order: PaymentOrderRecord,
    fact: { channelTransactionId?: string; amountCents?: number },
  ): Promise<{ claimed: boolean }> {
    const at = now();
    const transactionId = fact.channelTransactionId ?? order.id;

    if (fact.amountCents === undefined) {
      // The channel says paid but states no amount: keep the order pending (never grant on an
      // unverified amount), keep the evidence, and let the next query — which carries the
      // amount — decide. The ack still quiets this delivery.
      await recordAnomalyQuietly({
        orderId: order.id,
        code: "amount_unreadable",
        channelTransactionId: fact.channelTransactionId ?? null,
        amountCents: null,
        detail: "paid fact carried no comparable amount",
      });
      return { claimed: false };
    }
    if (fact.amountCents !== order.amountCents) {
      if (order.status === "pending") {
        await deps.store
          .blockOrder({
            id: order.id,
            expectedVersion: order.version,
            channelTransactionId: fact.channelTransactionId ?? null,
            amountCents: fact.amountCents,
            detail: `channel reports ${fact.amountCents}, order says ${order.amountCents}`,
          })
          .catch(() => {});
      } else {
        await recordAnomalyQuietly({
          orderId: order.id,
          code: "amount_mismatch",
          channelTransactionId: fact.channelTransactionId ?? null,
          amountCents: fact.amountCents,
          detail: `report after ${order.status}`,
        });
      }
      return { claimed: false };
    }

    if (order.status === "paid") {
      if (order.channelTransactionId === transactionId) {
        return { claimed: false }; // The same money, delivered again: silence.
      }
      await recordAnomalyQuietly({
        orderId: order.id,
        code: "over_paid",
        channelTransactionId: transactionId,
        amountCents: fact.amountCents,
        detail: `a second transaction landed on a paid order`,
      });
      return { claimed: false };
    }
    if (order.status === "blocked") {
      await recordAnomalyQuietly({
        orderId: order.id,
        code: "paid_after_blocked",
        channelTransactionId: transactionId,
        amountCents: fact.amountCents,
        detail: "money arrived for an order already blocked on amount",
      });
      return { claimed: false };
    }
    if (
      (order.status === "expired" || order.status === "canceled") &&
      !withinLateWindow(order, at)
    ) {
      await recordAnomalyQuietly({
        orderId: order.id,
        code: "late_payment",
        channelTransactionId: transactionId,
        amountCents: fact.amountCents,
        detail: `outside the ${deps.latePaymentWindowHours}h window anchored at terminalAt`,
      });
      return { claimed: false };
    }

    let result: { claimed: boolean; alreadyKnown: boolean };
    try {
      result = await deps.store.confirmPaid({
        id: order.id,
        expectedVersion: order.version,
        fromStatuses:
          order.status === "pending" ? ["pending"] : ["expired", "canceled"],
        channelTransactionId: transactionId,
        amountCents: fact.amountCents,
        periodStart: at,
        periodEnd: addMonths(at, 1),
      });
    } catch {
      return { claimed: false };
    }
    if (!result.claimed) {
      if (result.alreadyKnown) {
        // This transaction's paid fact is held by another order: an anomaly about the data, and
        // no migration here — the first claim stands.
        await recordAnomalyQuietly({
          orderId: order.id,
          code: "duplicate_paid",
          channelTransactionId: transactionId,
          amountCents: fact.amountCents,
          detail: "transaction already settled against another order",
        });
      }
      return { claimed: false };
    }

    // A canceled order coming back to life is worth one more look: if the same plan already has
    // a newer paid order, this payment doubles it — money collected twice for one entitlement.
    if (order.status === "canceled") {
      const latestPaid = await deps.store
        .readLatestPaidOrder(order.planCode)
        .catch(() => null);
      if (latestPaid && latestPaid.id !== order.id) {
        await recordAnomalyQuietly({
          orderId: order.id,
          code: "duplicate_paid",
          channelTransactionId: transactionId,
          amountCents: fact.amountCents,
          detail: `plan already paid by ${latestPaid.id}`,
        });
      }
    }

    const fresh = await deps.store.readOrder(order.id).catch(() => null);
    if (fresh) await activateOrder(fresh);
    return { claimed: true };
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
      return { plans, canPurchase, activePlanCode, providers };
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
      const active = await deps.activePlanCode();
      if (active !== null) {
        // One subscription at a time: the guard that also blocks the admin sync's other-plan
        // route, so an upgrade cannot bypass the front door.
        throw new PurchaseError({ reason: "active-subscription", activePlanCode: active });
      }

      // Replay: the same plan on the same channel, still open, comes back untouched.
      const replayed = await deps.store
        .readPendingOrder(input.planCode, input.provider)
        .catch(() => null);
      if (replayed) return { order: toView(replayed) };

      // A switch of channel cancels the old order first — locally for certain (CAS), remotely
      // best-effort (a close that fails leaves the channel to time the order out on its own).
      for (const [otherId, other] of deps.providers) {
        if (otherId === input.provider) continue;
        const stale = await deps.store
          .readPendingOrder(input.planCode, otherId)
          .catch(() => null);
        if (!stale) continue;
        if (await deps.store.cancelOrder(stale.id, stale.version).catch(() => false)) {
          try {
            await other.closePayment(stale.id);
          } catch {
            // The channel-side order dies at its own expiry; the local one is already terminal.
          }
        }
      }

      const expiresAt = new Date(now().getTime() + deps.orderTtlMinutes * 60_000);
      const order = await deps.store.insertOrder({
        planCode: input.planCode,
        provider: input.provider,
        amountCents: entry.amountCents,
        currency: "CNY",
        expiresAt,
        createdBy: input.createdBy,
        checkoutPayload: null,
      });

      // Order first, code second: a channel failure here leaves a pending order that a retry
      // replays into, instead of a QR the ledger cannot account for.
      const session = await provider.createSession({
        outTradeNo: order.id,
        description: `OpenBot plan ${order.planCode} · one month`,
        amountCents: order.amountCents,
        currency: "CNY",
        notifyUrl: notifyUrlFor(input.provider),
        expiresAt: order.expiresAt,
      });
      if (session.checkout.kind === "qrcode") {
        await deps.store.setCheckoutPayload(order.id, session.checkout.payload);
      }
      const fresh = await deps.store.readOrder(order.id);
      return { order: toView(fresh ?? { ...order, checkoutPayload: null }) };
    },

    async readOrder(id) {
      const order = await deps.store.readOrder(id).catch(() => null);
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
      const fresh = await deps.store.readOrder(id).catch(() => null);
      return { order: fresh ? toView(fresh) : toView(order) };
    },

    async readCurrentOrder() {
      const order = await deps.store.readLatestLiveOrder().catch(() => null);
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

      const order = await deps.store.readOrder(fact.outTradeNo).catch(() => null);
      if (!order) {
        return { kind: "unknown-order" };
      }

      try {
        await settlePaidFact(order, fact);
      } catch {
        return { kind: "store-failure" };
      }
      return { kind: "success" };
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
  };
}
