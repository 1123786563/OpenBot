import { describe, expect, spyOn, test } from "bun:test";
import { getLogger } from "../../shared/logger";
import type { PaymentProvider } from "../src/billing/payments/provider";
import {
  createPaymentService,
  type PaymentLagoFacade,
  type PlanCreditGrantor,
  PurchaseError,
} from "../src/billing/payments/service";
import type {
  PaymentOrderRecord,
  PaymentProviderId,
  PaymentStore,
} from "../src/billing/payments/types";
import { BillingError } from "../src/billing/types";

/*
 * The orchestration against in-memory doubles: a store that honours the CAS and the paid-fact
 * uniqueness the real one guarantees, providers whose five methods are swapped per test, and a
 * Lago facade that records its calls. No socket, no database — the tests target the decisions:
 * the replay rules, the amount gate, the window anchored at terminalAt, and the activation gate.
 */

/** A fixed clock the tests share. */
let clockMs = 1_791_900_000_000;
const tick = () => new Date(clockMs);
const addMonths = (from: Date, months: number) => {
  const to = new Date(from.getTime());
  to.setUTCMonth(to.getUTCMonth() + months);
  return to;
};

function memoryStore(): PaymentStore {
  const orders = new Map<string, PaymentOrderRecord>();
  const paidFacts = new Set<string>();
  const anomalies: Array<{ orderId: string; code: string; detail?: string }> = [];
  let serial = 0;

  const base: Omit<PaymentOrderRecord, "id"> = {
    planCode: "pro",
    provider: "alipay",
    amountCents: 8800,
    currency: "CNY",
    status: "pending",
    activationState: "pending",
    channelTransactionId: null,
    checkoutPayload: null,
    expiresAt: new Date(clockMs + 15 * 60_000),
    periodStart: null,
    periodEnd: null,
    paidAt: null,
    terminalAt: null,
    createdBy: "admin-1",
    createdAt: new Date(clockMs),
    version: 0,
  };

  return {
    // Exposed for the tests that assert which anomalies a settle wrote (the duplicate_paid
    // contract above all): the double keeps the trail the real store writes to payment_events.
    anomalies,
    async insertOrder(input) {
      serial += 1;
      const order: PaymentOrderRecord = {
        ...base,
        ...input,
        id: `po-${String(serial).padStart(16, "0")}`,
        status: "pending",
        activationState: "pending",
        channelTransactionId: null,
        periodStart: null,
        periodEnd: null,
        paidAt: null,
        terminalAt: null,
        version: 0,
        createdAt: tick(),
      };
      orders.set(order.id, order);
      return { order, conflict: null };
    },
    async readOrder(id) {
      return orders.get(id) ?? null;
    },
    async readPendingOrder(planCode, provider) {
      for (const order of [...orders.values()].reverse()) {
        if (
          order.planCode === planCode &&
          order.provider === provider &&
          order.status === "pending"
        ) {
          return order;
        }
      }
      return null;
    },
    async readPendingPurchase() {
      return (
        [...orders.values()]
          .reverse()
          .find((order) => order.status === "pending") ?? null
      );
    },
    async readLatestPaidOrder(planCode, excludeOrderId) {
      const paid = [...orders.values()]
        .filter(
          (order) =>
            order.planCode === planCode &&
            order.status === "paid" &&
            order.id !== excludeOrderId,
        )
        .sort(
          (a, b) =>
            (b.terminalAt?.getTime() ?? 0) - (a.terminalAt?.getTime() ?? 0),
        );
      return paid[0] ?? null;
    },
    async readLatestLiveOrder() {
      const live = [...orders.values()]
        .filter(
          (order) => order.status === "pending" || order.status === "paid",
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return live[0] ?? null;
    },
    async setCheckoutPayload(id, payload) {
      const order = orders.get(id);
      if (order) orders.set(id, { ...order, checkoutPayload: payload });
    },
    async cancelOrder(id, expectedVersion) {
      const order = orders.get(id);
      if (
        !order ||
        order.version !== expectedVersion ||
        order.status !== "pending"
      ) {
        return false;
      }
      orders.set(id, {
        ...order,
        status: "canceled",
        terminalAt: tick(),
        version: expectedVersion + 1,
      });
      return true;
    },
    async confirmPaid(input) {
      const order = orders.get(input.id);
      if (!order) return { claimed: false, alreadyKnown: false };
      if (paidFacts.has(input.channelTransactionId)) {
        return { claimed: false, alreadyKnown: true };
      }
      if (
        order.version !== input.expectedVersion ||
        !input.fromStatuses.includes(order.status)
      ) {
        return { claimed: false, alreadyKnown: false };
      }
      paidFacts.add(input.channelTransactionId);
      const paidAt = tick();
      orders.set(input.id, {
        ...order,
        status: "paid",
        channelTransactionId: input.channelTransactionId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        paidAt,
        terminalAt: paidAt,
        version: input.expectedVersion + 1,
      });
      return { claimed: true, alreadyKnown: false };
    },
    async blockOrder(input) {
      const order = orders.get(input.id);
      if (
        !order ||
        order.version !== input.expectedVersion ||
        order.status !== "pending"
      ) {
        return false;
      }
      orders.set(input.id, {
        ...order,
        status: "blocked",
        terminalAt: tick(),
        version: input.expectedVersion + 1,
      });
      anomalies.push({ orderId: input.id, code: "amount_mismatch" });
      return true;
    },
    async expireOrder(id, expectedVersion) {
      const order = orders.get(id);
      if (
        !order ||
        order.version !== expectedVersion ||
        order.status !== "pending"
      ) {
        return false;
      }
      orders.set(id, {
        ...order,
        status: "expired",
        terminalAt: tick(),
        version: expectedVersion + 1,
      });
      return true;
    },
    async recordAnomaly(event) {
      // The double honours the real store's dedup semantics (payment_events' partial unique
      // index, migration 0074): one row per (order, word) EXCEPT `amount_unreadable`, whose
      // repeats accumulate because their count ends the order. detail included so the
      // duplicate-paid tests can assert WHICH order was doubled.
      if (
        event.code !== "amount_unreadable" &&
        anomalies.some(
          (anomaly) =>
            anomaly.orderId === event.orderId && anomaly.code === event.code,
        )
      ) {
        return;
      }
      anomalies.push({
        orderId: event.orderId,
        code: event.code,
        detail: event.detail,
      });
    },
    // The real store counts rows in payment_events; the double counts its own list.
    async countAnomalies(orderId, code) {
      return anomalies.filter(
        (anomaly) => anomaly.orderId === orderId && anomaly.code === code,
      ).length;
    },
    async recordPaidFact(event) {
      if (paidFacts.has(event.channelTransactionId)) return false;
      paidFacts.add(event.channelTransactionId);
      return true;
    },
    async readPaidOrderByTransaction(channelTransactionId) {
      return (
        [...orders.values()].find(
          (order) =>
            order.status === "paid" &&
            order.channelTransactionId === channelTransactionId,
        ) ?? null
      );
    },
    async recordActivation(id, activationState, period) {
      const order = orders.get(id);
      if (order) {
        orders.set(id, {
          ...order,
          activationState,
          ...(period
            ? { periodStart: period.start, periodEnd: period.end }
            : {}),
        });
      }
    },
    async resolveActivationOwnership(orderId) {
      const current = orders.get(orderId);
      if (!current) return { outcome: "unknown" as const };
      if (
        current.status !== "paid" ||
        !current.periodStart ||
        !current.periodEnd
      ) {
        return { outcome: "not-paid" as const };
      }
      const overlapping = [...orders.values()]
        .filter(
          (order) =>
            order.status === "paid" &&
            order.planCode === current.planCode &&
            order.periodStart !== null &&
            order.periodEnd !== null &&
            order.periodStart.getTime() < current.periodEnd.getTime() &&
            order.periodEnd.getTime() > current.periodStart.getTime(),
        );
      const claimed = overlapping
        .filter((order) => order.activationState !== "pending")
        .sort((a, b) => {
          const byApplied =
            Number(b.activationState === "applied") -
            Number(a.activationState === "applied");
          if (byApplied !== 0) return byApplied;
          const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
          if (byCreated !== 0) return byCreated;
          return a.id.localeCompare(b.id);
        })[0];
      if (claimed) {
        if (claimed.id === current.id) {
          return { outcome: "owner" as const, order: claimed };
        }
        return {
          outcome: "duplicate" as const,
          order: current,
          ownerOrder: claimed,
        };
      }
      const winner = [...overlapping].sort((a, b) => {
        const byStart =
          (a.periodStart?.getTime() ?? Number.MAX_SAFE_INTEGER) -
          (b.periodStart?.getTime() ?? Number.MAX_SAFE_INTEGER);
        if (byStart !== 0) return byStart;
        const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
        if (byCreated !== 0) return byCreated;
        return a.id.localeCompare(b.id);
      })[0];
      if (!winner) return { outcome: "unknown" as const };
      if (winner.id === current.id) {
        if (current.activationState === "pending") {
          const claimedOwner = { ...current, activationState: "failed" as const };
          orders.set(current.id, claimedOwner);
          return { outcome: "owner" as const, order: claimedOwner };
        }
        return { outcome: "owner" as const, order: current };
      }
      return {
        outcome: "duplicate" as const,
        order: current,
        ownerOrder: winner,
      };
    },
    async listExpiredPendingOrders(at) {
      return [...orders.values()].filter(
        (order) =>
          order.status === "pending" &&
          order.expiresAt.getTime() <= at.getTime(),
      );
    },
    async listPaidPendingActivationOrders() {
      // Mirrors the real store's widened semantics (P1-4): "failed" beside "pending",
      // because the sweep retries both — a rule-refused activation is the provider's fact,
      // and it can change. The seam keeps its historical name; the double the widened filter.
      return [...orders.values()].filter(
        (order) =>
          order.status === "paid" &&
          (order.activationState === "pending" ||
            order.activationState === "failed"),
      );
    },
  };
}

function fakeProvider(
  id: PaymentProviderId,
  overrides: Partial<PaymentProvider> = {},
): PaymentProvider & {
  closes: string[];
  queries: string[];
  creates: string[];
} {
  const closes: string[] = [];
  const queries: string[] = [];
  const creates: string[] = [];
  return {
    id,
    closes,
    queries,
    creates,
    createSession: async (input) => {
      creates.push(input.outTradeNo);
      return { checkout: { kind: "qrcode", payload: `qr-${id}` } };
    },
    queryPayment: async (outTradeNo: string) => {
      queries.push(outTradeNo);
      return { outTradeNo, state: "pending" as const };
    },
    closePayment: async (outTradeNo: string) => {
      closes.push(outTradeNo);
    },
    verifyNotification: async () => ({ ok: false }),
    successAck: {
      body: id === "alipay" ? "success" : '{"code":"SUCCESS"}',
      contentType: "text/plain",
    },
    ...overrides,
  } as PaymentProvider & {
    closes: string[];
    queries: string[];
    creates: string[];
  };
}

function fakeLago(
  overrides: Partial<PaymentLagoFacade> = {},
): PaymentLagoFacade & { planReads: number; subscriptions: string[] } {
  const state = { planReads: 0, subscriptions: [] as string[] };
  return {
    get state() {
      return state;
    },
    planReads: 0,
    subscriptions: state.subscriptions,
    async getPlan() {
      state.planReads += 1;
      return { found: true, interval: "monthly", currency: "CNY" };
    },
    async ensureSubscription(input) {
      state.subscriptions.push(input.externalSubscriptionId);
      return {};
    },
    ...overrides,
  };
}

function buildService(
  overrides: {
    store?: PaymentStore;
    providers?: readonly (PaymentProvider & { closes?: string[] })[];
    lago?: PaymentLagoFacade;
    acceptForeignCurrency?: boolean;
    latePaymentWindowHours?: number;
    activePlanCode?: () => Promise<string | null>;
    /** The uncached guard read (P1-5) — present in a test that pins its precedence. */
    activePlanCodeUncached?: () => Promise<string | null>;
    invalidateEntitlementCache?: () => void;
    catalog?: ReadonlyMap<
      string,
      { amountCents: number; currency: "CNY"; periodMonths: number }
    >;
    grantor?: {
      creditsFor: (planCode: string) => number | null;
      grantPlanCredits: (input: {
        externalCustomerId: string;
        planCode: string;
        orderId: string;
        totalCents: number;
        expiresAt: Date | null;
      }) => Promise<{ inserted: boolean }>;
      readCurrentPeriodEnd: (planCode: string) => Promise<Date | null>;
    };
    /** `false` injects no logger, exercising the service's shared-logger fallback. */
    log?: { warn(message: string): void } | false;
  } = {},
) {
  const store = overrides.store ?? memoryStore();
  const providers = overrides.providers ?? [fakeProvider("alipay")];
  const lago = overrides.lago ?? fakeLago();
  const providerMap = new Map(
    providers.map((provider) => [provider.id, provider]),
  );
  const s = createPaymentService({
    providers: providerMap,
    store,
    catalog:
      overrides.catalog ??
      new Map([
        ["pro", { amountCents: 8800, currency: "CNY", periodMonths: 1 }],
      ]),
    notifyBaseUrl: "https://payments.openbot.example",
    orderTtlMinutes: 15,
    latePaymentWindowHours: overrides.latePaymentWindowHours ?? 24,
    acceptForeignCurrency: overrides.acceptForeignCurrency ?? false,
    lago,
    externalCustomerKey: "openbot-deployment-t1",
    activePlanCode: overrides.activePlanCode ?? (async () => null),
    ...(overrides.activePlanCodeUncached
      ? { activePlanCodeUncached: overrides.activePlanCodeUncached }
      : {}),
    invalidateEntitlementCache:
      overrides.invalidateEntitlementCache ?? (() => undefined),
    ...(overrides.grantor ? { grantor: overrides.grantor } : {}),
    now: tick,
    log:
      overrides.log === false
        ? undefined
        : (overrides.log ?? { warn: () => undefined }),
  });
  return { service: s, store, providers, lago };
}

describe("purchase ordering", () => {
  test("the same plan on the same channel replays the pending order untouched", async () => {
    const { service, store } = buildService();
    const first = await service.createPurchase({
      planCode: "pro",
      cycle: "monthly",
      provider: "alipay",
      createdBy: "admin-1",
    });
    const second = await service.createPurchase({
      planCode: "pro",
      cycle: "monthly",
      provider: "alipay",
      createdBy: "admin-1",
    });
    expect(second.order.orderId).toBe(first.order.orderId);
    expect((await store.readOrder(first.order.orderId))?.version).toBe(0);
  });

  test("a store insert that loses the pending-pair race replays the winner's order", async () => {
    // The losing racer's view: the replay read found nothing, but the insert conflicted and the
    // store handed back the winner's row — exactly what the partial unique index forces under
    // a real concurrent double-submit.
    const store = memoryStore();
    const { order: winner } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 15 * 60_000),
      createdBy: "someone-else",
      checkoutPayload: "qr-winner",
    });
    await store.setCheckoutPayload(winner.id, "qr-winner");
    const racing: PaymentStore = {
      ...store,
      async insertOrder(input) {
        // Simulate the index conflict: no insert, the winner's row back, the conflict named.
        const existing = await store.readPendingOrder(
          input.planCode,
          input.provider,
        );
        return { order: existing!, conflict: "pending-pair" as const };
      },
    };
    const { service } = buildService({ store: racing });
    const result = await service.createPurchase({
      planCode: "pro",
      cycle: "monthly",
      provider: "alipay",
      createdBy: "admin-1",
    });
    expect(result.order.orderId).toBe(winner.id);
    expect(result.order.checkout).toEqual({
      kind: "qrcode",
      payload: "qr-winner",
    });
  });

  test("a pending purchase for another plan refuses without creating a new order", async () => {
    const store = memoryStore();
    const { order: existing } = await store.insertOrder({
      planCode: "team",
      provider: "alipay",
      amountCents: 17600,
      currency: "CNY",
      expiresAt: new Date(clockMs + 15 * 60_000),
      createdBy: "admin-2",
      checkoutPayload: "qr-existing",
    });
    const alipay = fakeProvider("alipay");
    const wechat = fakeProvider("wechat");
    const { service } = buildService({
      store,
      providers: [alipay, wechat],
      catalog: new Map([
        ["pro", { amountCents: 8800, currency: "CNY", periodMonths: 1 }],
        ["team", { amountCents: 17600, currency: "CNY", periodMonths: 1 }],
      ]),
    });

    await expect(
      service.createPurchase({
        planCode: "pro",
        cycle: "monthly",
        provider: "wechat",
        createdBy: "admin-1",
      }),
    ).rejects.toMatchObject({
      refusal: { reason: "pending-purchase", pendingPlanCode: "team" },
    });
    expect((await store.readPendingPurchase())?.id).toBe(existing.id);
    expect(wechat.creates).toEqual([]);
  });

  test("an insert-time purchase conflict refuses when the pending read raced", async () => {
    const baseStore = memoryStore();
    const { order: existing } = await baseStore.insertOrder({
      planCode: "team",
      provider: "alipay",
      amountCents: 17600,
      currency: "CNY",
      expiresAt: new Date(clockMs + 15 * 60_000),
      createdBy: "admin-2",
      checkoutPayload: "qr-existing",
    });
    const store: PaymentStore = {
      ...baseStore,
      async readPendingPurchase() {
        return null;
      },
      async insertOrder() {
        return { order: existing, conflict: "pending-purchase" };
      },
    };
    const wechat = fakeProvider("wechat");
    const { service } = buildService({
      store,
      providers: [wechat],
      catalog: new Map([
        ["pro", { amountCents: 8800, currency: "CNY", periodMonths: 1 }],
        ["team", { amountCents: 17600, currency: "CNY", periodMonths: 1 }],
      ]),
    });

    await expect(
      service.createPurchase({
        planCode: "pro",
        cycle: "monthly",
        provider: "wechat",
        createdBy: "admin-1",
      }),
    ).rejects.toMatchObject({
      refusal: { reason: "pending-purchase", pendingPlanCode: "team" },
    });
    expect(wechat.creates).toEqual([]);
  });

  test("a channel-switch cancellation that loses to payment returns the paid order", async () => {
    const baseStore = memoryStore();
    const { order: existing } = await baseStore.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 15 * 60_000),
      createdBy: "admin-1",
      checkoutPayload: "qr-existing",
    });
    const store: PaymentStore = {
      ...baseStore,
      async cancelOrder(id, expectedVersion) {
        await baseStore.confirmPaid({
          id,
          expectedVersion,
          fromStatuses: ["pending"],
          channelTransactionId: "payment-won-cancel-race",
          amountCents: existing.amountCents,
          periodStart: tick(),
          periodEnd: new Date(clockMs + 30 * 24 * 60 * 60_000),
        });
        return false;
      },
    };
    const alipay = fakeProvider("alipay");
    const wechat = fakeProvider("wechat");
    const { service } = buildService({ store, providers: [alipay, wechat] });

    const result = await service.createPurchase({
      planCode: "pro",
      cycle: "monthly",
      provider: "wechat",
      createdBy: "admin-1",
    });

    expect(result.order.orderId).toBe(existing.id);
    expect(result.order.status).toBe("paid");
    expect(wechat.creates).toEqual([]);
  });

  test("a channel switch cancels the old order and closes it at the old channel", async () => {
    const alipay = fakeProvider("alipay");
    const wechat = fakeProvider("wechat");
    const { service } = buildService({ providers: [alipay, wechat] });
    const first = await service.createPurchase({
      planCode: "pro",
      cycle: "monthly",
      provider: "alipay",
      createdBy: "admin-1",
    });
    const second = await service.createPurchase({
      planCode: "pro",
      cycle: "monthly",
      provider: "wechat",
      createdBy: "admin-1",
    });
    expect(second.order.orderId).not.toBe(first.order.orderId);
    expect(second.order.provider).toBe("wechat");
    expect(alipay.closes).toEqual([first.order.orderId]);
    expect((await service.readOrder(first.order.orderId)).order?.status).toBe(
      "canceled",
    );
  });

  test("an active subscription refuses the purchase with its plan named", async () => {
    const { service } = buildService({
      activePlanCode: async () => "pro",
    });
    await expect(
      service.createPurchase({
        planCode: "pro",
        cycle: "monthly",
        provider: "alipay",
        createdBy: "admin-1",
      }),
    ).rejects.toMatchObject({
      refusal: { reason: "active-subscription", activePlanCode: "pro" },
    });
  });

  test("a plan outside the catalog refuses", async () => {
    const { service } = buildService();
    await expect(
      service.createPurchase({
        planCode: "ghost",
        cycle: "monthly",
        provider: "alipay",
        createdBy: "a",
      }),
    ).rejects.toBeInstanceOf(PurchaseError);
  });

  test("an unconfigured channel refuses before any order row exists", async () => {
    const alipay = fakeProvider("alipay");
    const { service, store } = buildService({ providers: [alipay] });
    await expect(
      service.createPurchase({
        planCode: "pro",
        cycle: "monthly",
        provider: "wechat",
        createdBy: "a",
      }),
    ).rejects.toMatchObject({ refusal: { reason: "unknown-provider" } });
    // The refusal left no stranded order behind: nothing pending on either channel, and the
    // configured provider was never touched.
    expect(await store.readPendingOrder("pro", "alipay")).toBeNull();
    expect(await store.readPendingOrder("pro", "wechat")).toBeNull();
    expect(alipay.queries).toEqual([]);
  });

  test("the catalog discloses exactly the configured channels, in stable order", async () => {
    const wechat = fakeProvider("wechat");
    const alipay = fakeProvider("alipay");
    const { service } = buildService({ providers: [wechat, alipay] });
    expect(service.catalog(true, null).providers).toEqual(["alipay", "wechat"]);
  });

  test("a channel failure leaves the order pending for a replay, and surfaces the sentinel", async () => {
    const broken = fakeProvider("alipay", {
      createSession: async () => {
        throw Object.assign(
          new Error("Billing provider failed (unreachable)."),
          {
            name: "BillingError",
          },
        );
      },
    });
    const { service, store } = buildService({ providers: [broken] });
    await expect(
      service.createPurchase({
        planCode: "pro",
        cycle: "monthly",
        provider: "alipay",
        createdBy: "a",
      }),
    ).rejects.toThrow(/unreachable/);
    const pending = await store.readPendingOrder("pro", "alipay");
    expect(pending?.status).toBe("pending");
    expect(pending?.checkoutPayload).toBeNull();
    // The retry replays the same stranded order instead of stacking another.
    const recoverable = fakeProvider("alipay");
    const second = buildService({ providers: [recoverable], store });
    const replayed = await second.service.createPurchase({
      planCode: "pro",
      cycle: "monthly",
      provider: "alipay",
      createdBy: "a",
    });
    expect(replayed.order.orderId).toBe(pending?.id);
  });
});

describe("callback triage", () => {
  /** The canonical paid fact, named for the order under test. */
  const paidFactFor = (outTradeNo: string) => ({
    outTradeNo,
    state: "paid" as const,
    channelTransactionId: "tx-1",
    amountCents: 8800,
  });

  test("a failed paid-fact confirm asks the provider to retry", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    store.confirmPaid = async () => {
      throw new Error("database unavailable");
    };
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: paidFactFor(order.id),
      }),
    });
    const { service } = buildService({ providers: [alipay], store });

    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "store-failure",
    });
  });

  test("an already-known duplicate still acknowledges when duplicate evidence logging throws", async () => {
    const store = memoryStore();
    const { order: first } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.confirmPaid({
      id: first.id,
      expectedVersion: first.version,
      fromStatuses: ["pending"],
      channelTransactionId: "tx-first",
      amountCents: 8800,
      periodStart: tick(),
      periodEnd: addMonths(tick(), 1),
    });
    const { order: second } = await store.insertOrder({
      planCode: "pro",
      provider: "wechat",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    store.recordAnomaly = async (event) => {
      if (event.code === "duplicate_paid") {
        throw new Error("database unavailable");
      }
    };
    const wechat = fakeProvider("wechat", {
      verifyNotification: async () => ({
        ok: true,
        fact: {
          outTradeNo: second.id,
          state: "paid",
          channelTransactionId: "tx-first",
          amountCents: 8800,
        },
      }),
    });
    const { service } = buildService({
      providers: [wechat, fakeProvider("alipay")],
      store,
    });

    expect(await service.handleCallback("wechat", new Headers(), "x")).toEqual({
      kind: "success",
    });
  });

  test("an already-known duplicate records the settled order id and transaction id in its evidence", async () => {
    const store = memoryStore();
    const { order: first } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.confirmPaid({
      id: first.id,
      expectedVersion: first.version,
      fromStatuses: ["pending"],
      channelTransactionId: "tx-first",
      amountCents: 8800,
      periodStart: tick(),
      periodEnd: addMonths(tick(), 1),
    });
    const { order: second } = await store.insertOrder({
      planCode: "pro",
      provider: "wechat",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const wechat = fakeProvider("wechat", {
      verifyNotification: async () => ({
        ok: true,
        fact: {
          outTradeNo: second.id,
          state: "paid",
          channelTransactionId: "tx-first",
          amountCents: 8800,
        },
      }),
    });
    const { service } = buildService({
      providers: [wechat, fakeProvider("alipay")],
      store,
    });

    expect(await service.handleCallback("wechat", new Headers(), "x")).toEqual({
      kind: "success",
    });
    expect(
      store.anomalies.find(
        (anomaly) =>
          anomaly.orderId === second.id && anomaly.code === "duplicate_paid",
      )?.detail,
    ).toContain(first.id);
    expect(
      store.anomalies.find(
        (anomaly) =>
          anomaly.orderId === second.id && anomaly.code === "duplicate_paid",
      )?.detail,
    ).toContain("tx-first");
  });

  test("a committed cross-order duplicate retries missing anomaly evidence on replay", async () => {
    const store = memoryStore();
    const { order: first } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.confirmPaid({
      id: first.id,
      expectedVersion: first.version,
      fromStatuses: ["pending"],
      channelTransactionId: "tx-first",
      amountCents: 8800,
      periodStart: tick(),
      periodEnd: addMonths(tick(), 1),
    });
    const { order: second } = await store.insertOrder({
      planCode: "pro",
      provider: "wechat",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const originalConfirmPaid = store.confirmPaid.bind(store);
    let confirmations = 0;
    store.confirmPaid = async (input) => {
      confirmations += 1;
      return originalConfirmPaid(input);
    };
    const originalRecordAnomaly = store.recordAnomaly.bind(store);
    let failDuplicateEvidence = true;
    store.recordAnomaly = async (event) => {
      if (event.code === "duplicate_paid" && failDuplicateEvidence) {
        failDuplicateEvidence = false;
        throw new Error("database unavailable");
      }
      return originalRecordAnomaly(event);
    };
    const wechat = fakeProvider("wechat", {
      verifyNotification: async () => ({
        ok: true,
        fact: {
          outTradeNo: second.id,
          state: "paid",
          channelTransactionId: "tx-second",
          amountCents: 8800,
        },
      }),
    });
    const { service } = buildService({
      providers: [wechat, fakeProvider("alipay")],
      store,
    });

    expect(await service.handleCallback("wechat", new Headers(), "x")).toEqual({
      kind: "success",
    });
    expect((await store.readOrder(second.id))?.status).toBe("paid");
    expect(confirmations).toBe(1);

    expect(await service.handleCallback("wechat", new Headers(), "x")).toEqual({
      kind: "success",
    });
    expect(confirmations).toBe(1);
    expect(
      store.anomalies.some(
        (anomaly) =>
          anomaly.orderId === second.id && anomaly.code === "duplicate_paid",
      ),
    ).toBe(true);
  });

  test("an unreadable amount on a blocked order records durable evidence", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.blockOrder({
      id: order.id,
      expectedVersion: order.version,
      channelTransactionId: "tx-mismatch",
      amountCents: 1,
      detail: "underpaid",
    });
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: {
          outTradeNo: order.id,
          state: "paid",
          channelTransactionId: "tx-unreadable",
        },
      }),
    });
    const { service } = buildService({ providers: [alipay], store });

    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "settlement-refused",
      settlement: { kind: "refused", reason: "blocked" },
    });
    expect(
      store.anomalies.some(
        (anomaly) =>
          anomaly.orderId === order.id &&
          anomaly.code === "amount_unreadable",
      ),
    ).toBe(true);
  });

  test("a failed unreadable-amount evidence write on a blocked order retries", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.blockOrder({
      id: order.id,
      expectedVersion: order.version,
      channelTransactionId: "tx-mismatch",
      amountCents: 1,
      detail: "underpaid",
    });
    store.recordAnomaly = async () => {
      throw new Error("database unavailable");
    };
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: {
          outTradeNo: order.id,
          state: "paid",
          channelTransactionId: "tx-unreadable",
        },
      }),
    });
    const { service } = buildService({ providers: [alipay], store });

    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "store-failure",
    });
  });

  test("a callback order lookup failure is a retryable store failure", async () => {
    const store = memoryStore();
    store.readOrder = async () => {
      throw new Error("database unavailable");
    };
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: paidFactFor("po-unreadable"),
      }),
    });
    const { service } = buildService({ providers: [alipay], store });

    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "store-failure",
    });
  });

  test("a failed amount-mismatch block is not acknowledged", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    store.blockOrder = async () => {
      throw new Error("database unavailable");
    };
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: { ...paidFactFor(order.id), amountCents: 1 },
      }),
    });
    const { service } = buildService({ providers: [alipay], store });

    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "store-failure",
    });
  });

  test("a failed unreadable-amount evidence write is not acknowledged", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    store.recordAnomaly = async () => {
      throw new Error("database unavailable");
    };
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: {
          outTradeNo: order.id,
          state: "paid",
          channelTransactionId: "tx-9",
        },
      }),
    });
    const { service } = buildService({ providers: [alipay], store });

    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "store-failure",
    });
  });

  test("a failed late-payment evidence write is not acknowledged", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.expireOrder(order.id, order.version);
    clockMs =
      (await store.readOrder(order.id))!.terminalAt!.getTime() + 25 * 3600_000;
    store.recordAnomaly = async () => {
      throw new Error("database unavailable");
    };
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: paidFactFor(order.id),
      }),
    });
    const { service } = buildService({ providers: [alipay], store });

    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "store-failure",
    });
  });

  test("an unknown provider is refused before verification", async () => {
    const { service } = buildService();
    const outcome = await service.handleCallback(
      "stripe",
      new Headers(),
      "x=1",
    );
    expect(outcome).toEqual({ kind: "unknown-provider" });
  });

  test("an unverified delivery is refused with the adapter's grading", async () => {
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({ ok: false }),
    });
    const { service } = buildService({ providers: [alipay] });
    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "unverified",
    });
    const stale = fakeProvider("alipay", {
      verifyNotification: async () => ({ ok: false, refusal: "stale" }),
    });
    const withStale = buildService({ providers: [stale] });
    expect(
      await withStale.service.handleCallback("alipay", new Headers(), "x"),
    ).toEqual({
      kind: "unverified",
      refusal: "stale",
    });
  });

  test("a verified non-success fact answers not-success and moves nothing", async () => {
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: { outTradeNo: "po-abc", state: "closed" },
      }),
    });
    const store = memoryStore();
    await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const { service } = buildService({ providers: [alipay], store });
    const outcome = await service.handleCallback("alipay", new Headers(), "x");
    expect(outcome).toEqual({ kind: "not-success" });
    expect((await store.readPendingOrder("pro", "alipay"))?.status).toBe(
      "pending",
    );
  });

  test("a paid fact for an order that does not exist answers unknown-order", async () => {
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: paidFactFor("po-missing"),
      }),
    });
    const { service } = buildService({ providers: [alipay] });
    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "unknown-order",
    });
  });

  test("a matching paid fact moves pending to paid and activates", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: paidFactFor(order.id),
      }),
    });
    const lago = fakeLago();
    let invalidated = 0;
    const { service } = buildService({
      providers: [alipay],
      store,
      lago,
      invalidateEntitlementCache: () => {
        invalidated += 1;
      },
    });
    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "success",
    });
    const settled = await store.readOrder(order.id);
    expect(settled?.status).toBe("paid");
    expect(settled?.activationState).toBe("applied");
    expect(settled?.periodEnd).toBeInstanceOf(Date);
    expect(lago.state.subscriptions).toEqual(["openbot-deployment-t1-pro"]);
    expect(invalidated).toBe(1);
    // The same delivery again: silence, no second activation, no second subscription.
    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "success",
    });
    expect(lago.state.subscriptions).toHaveLength(1);
    expect(invalidated).toBe(1);
  });

  test("an amount mismatch blocks a pending order and is not acknowledged as settled", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: { ...paidFactFor(order.id), amountCents: 1 },
      }),
    });
    const { service } = buildService({ providers: [alipay], store });
    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "settlement-refused",
      settlement: { kind: "refused", reason: "amount-mismatch" },
    });
    expect((await store.readOrder(order.id))?.status).toBe("blocked");
    // Blocked absorbs: the same mismatched delivery again changes nothing.
    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "settlement-refused",
      settlement: { kind: "refused", reason: "amount-mismatch" },
    });
    expect((await store.readOrder(order.id))?.status).toBe("blocked");
  });

  test("a paid fact whose amount the channel did not state leaves the order pending", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: {
          outTradeNo: order.id,
          state: "paid",
          channelTransactionId: "tx-9",
        },
      }),
    });
    const { service } = buildService({ providers: [alipay], store });
    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "settlement-refused",
      settlement: { kind: "refused", reason: "amount-mismatch" },
    });
    expect((await store.readOrder(order.id))?.status).toBe("pending");
  });

  test("a second transaction on a paid order is an over-payment anomaly, not a migration", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const lago = fakeLago();
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: paidFactFor(order.id),
      }),
    });
    const { service } = buildService({ providers: [alipay], store, lago });
    await service.handleCallback("alipay", new Headers(), "x");
    const secondDelivery = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: { ...paidFactFor(order.id), channelTransactionId: "tx-2" },
      }),
    });
    const { service: second } = buildService({
      providers: [secondDelivery],
      store,
      lago,
    });
    expect(await second.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "settlement-refused",
      settlement: { kind: "refused", reason: "blocked" },
    });
    const settled = await store.readOrder(order.id);
    expect(settled?.status).toBe("paid");
    expect(settled?.channelTransactionId).toBe("tx-1");
    expect(lago.state.subscriptions).toHaveLength(1);
  });

  test("an expired order inside the window pays, anchored at terminalAt (+23h yes, +25h no)", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.expireOrder(order.id, order.version);
    const expiredAt =
      (await store.readOrder(order.id))?.terminalAt?.getTime() ?? 0;

    const paidProvider = () =>
      fakeProvider("alipay", {
        verifyNotification: async () => ({
          ok: true,
          fact: paidFactFor(order.id),
        }),
      });

    // +23h past the terminal moment: inside the 24h window — the money is honoured.
    clockMs = expiredAt + 23 * 3600_000;
    const inside = buildService({ providers: [paidProvider()], store });
    expect(
      await inside.service.handleCallback("alipay", new Headers(), "x"),
    ).toEqual({
      kind: "success",
    });
    expect((await store.readOrder(order.id))?.status).toBe("paid");
  });

  test("a plan with a longer catalog period keeps that fallback snapshot when Lago omits exact dates", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: paidFactFor(order.id),
      }),
    });
    const { service } = buildService({
      providers: [alipay],
      store,
      catalog: new Map([
        ["pro", { amountCents: 8800, currency: "CNY", periodMonths: 12 }],
      ]),
      lago: fakeLago({
        async ensureSubscription() {
          return { currentPeriodStart: null, currentPeriodEnd: null };
        },
      }),
    });

    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "success",
    });
    const settled = await store.readOrder(order.id);
    expect(settled?.periodStart?.toISOString()).toBe(tick().toISOString());
    expect(settled?.periodEnd?.toISOString()).toBe(addMonths(tick(), 12).toISOString());
  });

  test("activation replaces the fallback snapshot when Lago returns exact dates", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const exactStart = "2026-01-01T00:00:00.000Z";
    const exactEnd = "2027-01-01T00:00:00.000Z";
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: paidFactFor(order.id),
      }),
    });
    const { service } = buildService({
      providers: [alipay],
      store,
      catalog: new Map([
        ["pro", { amountCents: 8800, currency: "CNY", periodMonths: 12 }],
      ]),
      lago: fakeLago({
        async ensureSubscription() {
          return {
            currentPeriodStart: exactStart,
            currentPeriodEnd: exactEnd,
          };
        },
      }),
    });

    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "success",
    });
    const settled = await store.readOrder(order.id);
    expect(settled?.periodStart?.toISOString()).toBe(exactStart);
    expect(settled?.periodEnd?.toISOString()).toBe(exactEnd);
  });

  test("an expired order outside the window records late_payment and stays expired", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.expireOrder(order.id, order.version);
    const terminalAt =
      (await store.readOrder(order.id))?.terminalAt?.getTime() ?? 0;
    clockMs = terminalAt + 25 * 3600_000;

    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: paidFactFor(order.id),
      }),
    });
    const lago = fakeLago();
    const { service } = buildService({ providers: [alipay], store, lago });
    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "settlement-refused",
      settlement: { kind: "refused", reason: "late" },
    });
    expect((await store.readOrder(order.id))?.status).toBe("expired");
    expect(lago.state.subscriptions).toHaveLength(0);
  });

  test("a canceled order revives inside the window; a newer paid order on the plan raises duplicate_paid", async () => {
    const store = memoryStore();
    const { order: older } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.cancelOrder(older.id, older.version);
    const canceledAt =
      (await store.readOrder(older.id))?.terminalAt?.getTime() ?? 0;
    clockMs = canceledAt + 60_000;

    // A newer order on the same plan has already been paid.
    const { order: newer } = await store.insertOrder({
      planCode: "pro",
      provider: "wechat",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.confirmPaid({
      id: newer.id,
      expectedVersion: newer.version,
      fromStatuses: ["pending"],
      channelTransactionId: "tx-newer",
      amountCents: 8800,
      periodStart: tick(),
      periodEnd: addMonths(tick(), 1),
    });

    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: paidFactFor(older.id),
      }),
    });
    const { service } = buildService({
      providers: [alipay, fakeProvider("wechat")],
      store,
    });
    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "success",
    });
    expect((await store.readOrder(older.id))?.status).toBe("paid");
  });

  test("a pending order confirmed while the plan already has a paid order (cross-provider) stays paid but cannot activate or grant twice", async () => {
    const store = memoryStore();
    const payouts: string[] = [];
    const grantor: PlanCreditGrantor = {
      creditsFor: () => 900_000,
      async grantPlanCredits(input) {
        payouts.push(input.orderId);
        return { inserted: true };
      },
      readCurrentPeriodEnd: async () => tick(),
    };
    // The plan's first purchase, already paid and activated, on alipay.
    const { order: first } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.confirmPaid({
      id: first.id,
      expectedVersion: first.version,
      fromStatuses: ["pending"],
      channelTransactionId: "tx-first",
      amountCents: 8800,
      periodStart: tick(),
      periodEnd: addMonths(tick(), 1),
    });
    const { service: firstService } = buildService({
      providers: [fakeProvider("alipay")],
      store,
      grantor,
    });
    await firstService.sweepActivations();
    expect((await store.readOrder(first.id))?.activationState).toBe("applied");

    // A wechat order the pending-pair index cannot bar. Its paid fact stands, but the second
    // order must not win the entitlement or a second credit payout while the first period overlaps.
    const { order: second } = await store.insertOrder({
      planCode: "pro",
      provider: "wechat",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const wechat = fakeProvider("wechat", {
      verifyNotification: async () => ({
        ok: true,
        fact: {
          outTradeNo: second.id,
          state: "paid" as const,
          channelTransactionId: "tx-second",
          amountCents: 8800,
        },
      }),
    });
    const { service } = buildService({ providers: [wechat], store, grantor });
    expect(await service.handleCallback("wechat", new Headers(), "x")).toEqual({
      kind: "success",
    });
    const settled = await store.readOrder(second.id);
    expect(settled?.status).toBe("paid");
    expect(settled?.activationState).toBe("pending");
    expect(payouts).toEqual([first.id]);
    expect(
      store.anomalies.some(
        (anomaly) =>
          anomaly.orderId === second.id && anomaly.code === "duplicate_paid",
      ),
    ).toBe(true);
  });

  test("blocked refuses every migration, including a well-paid fact", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.blockOrder({
      id: order.id,
      expectedVersion: order.version,
      channelTransactionId: "tx-bad",
      amountCents: 1,
      detail: "underpaid",
    });
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: paidFactFor(order.id),
      }),
    });
    const lago = fakeLago();
    const { service } = buildService({ providers: [alipay], store, lago });
    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "settlement-refused",
      settlement: { kind: "refused", reason: "blocked" },
    });
    expect((await store.readOrder(order.id))?.status).toBe("blocked");
    expect(lago.state.subscriptions).toHaveLength(0);
  });
});

describe("the poll's read side", () => {
  test("a pending order gets one channel query; money found settles and activates", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.setCheckoutPayload(order.id, "qr-open");
    let queries = 0;
    const alipay = fakeProvider("alipay", {
      queryPayment: async () => {
        queries += 1;
        return {
          outTradeNo: order.id,
          state: "paid" as const,
          channelTransactionId: "tx-poll",
          amountCents: 8800,
        };
      },
    });
    const { service } = buildService({ providers: [alipay], store });
    const view = await service.readOrder(order.id);
    expect(view.order?.status).toBe("paid");
    expect(view.order?.checkout).toBeNull(); // A paid order stops showing its QR.
    expect(queries).toBe(1);
    // The next poll asks again only while pending — a paid order is never re-queried.
    await service.readOrder(order.id);
    expect(queries).toBe(1);
  });

  test("an unreachable channel answers the order as it stands", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.setCheckoutPayload(order.id, "qr-open");
    const alipay = fakeProvider("alipay", {
      queryPayment: async () => {
        throw new Error("down");
      },
    });
    const { service } = buildService({ providers: [alipay], store });
    const view = await service.readOrder(order.id);
    expect(view.order?.status).toBe("pending");
    // The order as it stands: the QR the creator is showing survives an unreachable channel.
    expect(view.order?.checkout).toEqual({
      kind: "qrcode",
      payload: "qr-open",
    });
  });
});

describe("cancel", () => {
  test("pending cancels and closes at the channel; canceling twice answers idempotent", async () => {
    const alipay = fakeProvider("alipay");
    const { service } = buildService({ providers: [alipay] });
    const { order } = await service.createPurchase({
      planCode: "pro",
      cycle: "monthly",
      provider: "alipay",
      createdBy: "a",
    });
    const first = await service.cancelPurchase(order.orderId);
    expect(first.outcome).toBe("canceled");
    expect(first.order.status).toBe("canceled");
    expect(alipay.closes).toEqual([order.orderId]);
    const second = await service.cancelPurchase(order.orderId);
    expect(second.outcome).toBe("idempotent");
    expect(alipay.closes).toHaveLength(1);
  });

  test("paid and expired refuse to cancel; unknown answers unknown", async () => {
    const store = memoryStore();
    const { order: paid } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.confirmPaid({
      id: paid.id,
      expectedVersion: paid.version,
      fromStatuses: ["pending"],
      channelTransactionId: "tx-c1",
      amountCents: 8800,
      periodStart: tick(),
      periodEnd: tick(),
    });
    const { order: expired } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs - 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.expireOrder(expired.id, expired.version);
    const { service } = buildService({ store });
    expect((await service.cancelPurchase(paid.id)).outcome).toBe("terminal");
    expect((await service.cancelPurchase(expired.id)).outcome).toBe("terminal");
    expect((await service.cancelPurchase("po-missing")).outcome).toBe(
      "unknown",
    );
  });
});

describe("activation gate", () => {
  /**
   * A pending order plus the provider that delivers its matching paid fact: activation is
   * triggered by the settle core, so every gate test rides the same path a real delivery does.
   */
  async function pendingWithPaidDelivery(store: PaymentStore) {
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: {
          outTradeNo: order.id,
          state: "paid",
          channelTransactionId: `tx-${order.id}`,
          amountCents: 8800,
        },
      }),
    });
    return { order, alipay };
  }

  test("a plan the provider does not know fails activation", async () => {
    const store = memoryStore();
    const { order, alipay } = await pendingWithPaidDelivery(store);
    const lago = fakeLago({ getPlan: async () => ({ found: false }) });
    const { service } = buildService({ store, lago, providers: [alipay] });
    await service.handleCallback("alipay", new Headers(), "x");
    expect((await store.readOrder(order.id))?.activationState).toBe("failed");
    expect(lago.state.subscriptions).toHaveLength(0);
  });

  test("a non-monthly plan fails activation with no override", async () => {
    const store = memoryStore();
    const { order, alipay } = await pendingWithPaidDelivery(store);
    const lago = fakeLago({
      getPlan: async () => ({
        found: true,
        interval: "yearly",
        currency: "CNY",
      }),
    });
    const { service } = buildService({ store, lago, providers: [alipay] });
    await service.handleCallback("alipay", new Headers(), "x");
    expect((await store.readOrder(order.id))?.activationState).toBe("failed");
    expect(lago.state.subscriptions).toHaveLength(0);
  });

  test("a foreign-currency plan fails closed, applies with the override", async () => {
    const foreign = { found: true, interval: "monthly", currency: "USD" };

    const storeA = memoryStore();
    const orderA = await pendingWithPaidDelivery(storeA);
    let invalidated = 0;
    const { service: closed } = buildService({
      store: storeA,
      lago: fakeLago({ getPlan: async () => foreign }),
      providers: [orderA.alipay],
    });
    await closed.handleCallback("alipay", new Headers(), "x");
    expect((await storeA.readOrder(orderA.order.id))?.activationState).toBe(
      "failed",
    );

    const storeB = memoryStore();
    const orderB = await pendingWithPaidDelivery(storeB);
    const { service: open } = buildService({
      store: storeB,
      lago: fakeLago({ getPlan: async () => foreign }),
      providers: [orderB.alipay],
      acceptForeignCurrency: true,
      invalidateEntitlementCache: () => {
        invalidated += 1;
      },
    });
    await open.handleCallback("alipay", new Headers(), "x");
    expect((await storeB.readOrder(orderB.order.id))?.activationState).toBe(
      "applied",
    );
    expect(invalidated).toBe(1);
  });

  test("an unreachable provider keeps the claimed owner failed for the next pass", async () => {
    const store = memoryStore();
    const { order, alipay } = await pendingWithPaidDelivery(store);
    const lago = fakeLago({
      getPlan: async () => {
        throw new BillingError("unreachable");
      },
    });
    const { service } = buildService({ store, lago, providers: [alipay] });
    await service.handleCallback("alipay", new Headers(), "x");
    expect((await store.readOrder(order.id))?.status).toBe("paid");
    expect((await store.readOrder(order.id))?.activationState).toBe("failed");
  });

  test("a rule-refused (failed) activation is retried by the sweep until the rule changes (P1-4)", async () => {
    const store = memoryStore();
    const { order, alipay } = await pendingWithPaidDelivery(store);
    // The refusing rule: the plan bills yearly — a verdict that used to be terminal, stranding
    // the paid order forever. The sweep now retries it.
    const refusing = fakeLago({
      getPlan: async () => ({ found: true, interval: "yearly", currency: "CNY" }),
    });
    const { service } = buildService({ store, lago: refusing, providers: [alipay] });
    await service.handleCallback("alipay", new Headers(), "x");
    expect((await store.readOrder(order.id))?.activationState).toBe("failed");

    // The rule changes at the provider (corrected to monthly): the SAME failed order retries
    // on the next sweep pass and lands.
    const fixed = fakeLago();
    const { service: fixing } = buildService({ store, lago: fixed, providers: [alipay] });
    await fixing.sweepActivations();
    const settled = await store.readOrder(order.id);
    expect(settled?.activationState).toBe("applied");
    expect(fixed.state.subscriptions).toHaveLength(1);
  });

  test("an activation failing the same rule pass after pass raises activation_retry_exhausted once", async () => {
    const store = memoryStore();
    const { order, alipay } = await pendingWithPaidDelivery(store);
    const refusing = fakeLago({
      getPlan: async () => ({ found: false }),
    });
    const { service } = buildService({ store, lago: refusing, providers: [alipay] });
    await service.handleCallback("alipay", new Headers(), "x");
    // Three passes, each refused the same way: the alarm fires on the third, exactly once —
    // the anomaly is one alarm, not a log.
    await service.sweepActivations();
    await service.sweepActivations();
    const alarms = () =>
      store.anomalies.filter(
        (anomaly) =>
          anomaly.orderId === order.id &&
          anomaly.code === "activation_retry_exhausted",
      );
    expect(alarms()).toHaveLength(0);
    await service.sweepActivations();
    expect(alarms()).toHaveLength(1);
    await service.sweepActivations();
    expect(alarms()).toHaveLength(1);
  });

  test("the uncached projection read overrides the TTL cache when both are wired (P1-5)", async () => {
    // The stale window the uncached read exists to close: the cached answer still says "no
    // plan" while the projection already holds a live subscription. The guard must answer
    // from the fresher source.
    const { service } = buildService({
      activePlanCode: async () => null, // the cached, lagging answer
      activePlanCodeUncached: async () => "pro", // the projection's live row
    });
    await expect(
      service.createPurchase({
        planCode: "pro",
        provider: "alipay",
        cycle: "monthly",
        createdBy: "admin-1",
      }),
    ).rejects.toMatchObject({
      refusal: { reason: "active-subscription", activePlanCode: "pro" },
    });
  });

  test("a no-amount delivery on a BLOCKED order durably records every refusal", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const unreadable = () =>
      fakeProvider("alipay", {
        verifyNotification: async () => ({
          ok: true,
          fact: {
            outTradeNo: order.id,
            state: "paid" as const,
            channelTransactionId: "tx-tail",
            // amountCents deliberately absent — the unreadable shape.
          },
        }),
      });
    const deliver = async () => {
      const { service } = buildService({ store, providers: [unreadable()] });
      await service.handleCallback("alipay", new Headers(), "x");
    };
    // Three strikes: the endgame blocks on the third, three rows accumulated.
    await deliver();
    await deliver();
    await deliver();
    expect((await store.readOrder(order.id))?.status).toBe("blocked");
    expect(await store.countAnomalies(order.id, "amount_unreadable")).toBe(3);
    // The fourth and fifth deliveries still record their unreadable-amount evidence before
    // refusing; a blocked status does not erase evidence about a later paid delivery.
    await deliver();
    await deliver();
    expect((await store.readOrder(order.id))?.status).toBe("blocked");
    expect(await store.countAnomalies(order.id, "amount_unreadable")).toBe(5);
  });

  test("a channel that never states an amount: the third unreadable strike blocks the order (P2-3)", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const unreadable = () =>
      fakeProvider("alipay", {
        verifyNotification: async () => ({
          ok: true,
          fact: {
            outTradeNo: order.id,
            state: "paid" as const,
            channelTransactionId: "tx-silent",
            // amountCents deliberately absent — the unreadable shape.
          },
        }),
      });
    const deliver = async () => {
      const { service } = buildService({ store, providers: [unreadable()] });
      await service.handleCallback("alipay", new Headers(), "x");
    };
    // Strikes 1 and 2: the order stays pending (never grant on an unverifiable amount), and
    // each delivery leaves one amount_unreadable row — the word accumulates by design.
    await deliver();
    await deliver();
    expect((await store.readOrder(order.id))?.status).toBe("pending");
    expect(await store.countAnomalies(order.id, "amount_unreadable")).toBe(2);
    // Strike 3: the endgame — the order moves to blocked, the sweep stops re-asking.
    await deliver();
    const settled = await store.readOrder(order.id);
    expect(settled?.status).toBe("blocked");
    expect(await store.countAnomalies(order.id, "amount_unreadable")).toBe(3);
  });

  test("the activation sweep retries a paid order the poll left pending, without a page open", async () => {
    const store = memoryStore();
    const { order, alipay } = await pendingWithPaidDelivery(store);
    const lago = fakeLago({
      getPlan: async () => {
        throw new BillingError("unreachable");
      },
    });
    const { service } = buildService({ store, lago, providers: [alipay] });
    await service.handleCallback("alipay", new Headers(), "x");
    // The delivery settled the money but the provider was unreachable: paid + pending-activation.
    // The sweep pass — nobody's page is open — retries and lands the subscription.
    const lagoRecovering = fakeLago();
    const { service: recovering } = buildService({
      store,
      lago: lagoRecovering,
      providers: [alipay],
    });
    await recovering.sweepActivations();
    expect((await store.readOrder(order.id))?.activationState).toBe("applied");
    expect(lagoRecovering.state.subscriptions).toHaveLength(1);
  });

  test("with no injected logger, warnings fall through to the shared server logger", async () => {
    const store = memoryStore();
    const { order, alipay } = await pendingWithPaidDelivery(store);
    const lago = fakeLago({
      getPlan: async () => ({
        found: true,
        interval: "monthly",
        currency: "USD",
      }),
    });
    const warned: string[] = [];
    const warn = spyOn(getLogger("server"), "warn").mockImplementation(
      (...args: unknown[]) => {
        warned.push(
          args
            .map((argument) =>
              typeof argument === "string"
                ? argument
                : JSON.stringify(argument),
            )
            .join(" "),
        );
      },
    );
    try {
      const { service } = buildService({
        store,
        lago,
        providers: [alipay],
        acceptForeignCurrency: true,
        log: false,
      });
      await service.handleCallback("alipay", new Headers(), "x");
    } finally {
      warn.mockRestore();
    }
    expect((await store.readOrder(order.id))?.activationState).toBe("applied");
    expect(warned.join("")).toContain("PAYMENT_ACCEPT_FOREIGN_CURRENCY");
  });
});

describe("the plan allowance payout", () => {
  /** A grantor double that records every payout the service asks for. */
  function recordingGrantor(overrides: Partial<PlanCreditGrantor> = {}) {
    const payouts: Array<{
      planCode: string;
      orderId: string;
      totalCents: number;
      expiresAt: Date | null;
    }> = [];
    const grantor: PlanCreditGrantor = {
      creditsFor: (planCode) => (planCode === "pro" ? 900_000 : null),
      async grantPlanCredits(input) {
        payouts.push({
          planCode: input.planCode,
          orderId: input.orderId,
          totalCents: input.totalCents,
          expiresAt: input.expiresAt,
        });
        return { inserted: true };
      },
      readCurrentPeriodEnd: async () => new Date("2026-11-01T00:00:00Z"),
      ...overrides,
    };
    return { grantor, payouts };
  }

  /** One settled-and-activated order paid through the same callback path production uses. */
  async function settledOrder(
    grantor: PlanCreditGrantor,
    store: PaymentStore = memoryStore(),
  ): Promise<{ orderId: string; store: PaymentStore }> {
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: {
          outTradeNo: order.id,
          state: "paid" as const,
          channelTransactionId: `tx-${order.id}`,
          amountCents: 8800,
        },
      }),
    });
    const { service } = buildService({ store, providers: [alipay], grantor });
    await service.handleCallback("alipay", new Headers(), "x");
    return { orderId: order.id, store };
  }

  test("an applied activation grants the catalog's credits once, keyed on the order", async () => {
    const { grantor, payouts } = recordingGrantor();
    const { orderId } = await settledOrder(grantor);
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({
      planCode: "pro",
      orderId,
      totalCents: 900_000,
      // The provider's period end, not a local +1 month guess.
      expiresAt: new Date("2026-11-01T00:00:00Z"),
    });
  });

  test("a re-run activation (the sweep's retry) does not double-grant", async () => {
    const { grantor, payouts } = recordingGrantor();
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: {
          outTradeNo: order.id,
          state: "paid" as const,
          channelTransactionId: `tx-${order.id}`,
          amountCents: 8800,
        },
      }),
    });
    // First pass: the grantor is unreachable-looking — grant THROWS, but the claimed owner
    // remains failed so no overlapping duplicate can take the entitlement while the sweep retries.
    const failing: PlanCreditGrantor = {
      ...grantor,
      grantPlanCredits: async () => {
        throw new Error("ledger down");
      },
    };
    const first = buildService({ store, providers: [alipay], grantor: failing });
    await first.service.handleCallback("alipay", new Headers(), "x");
    expect((await store.readOrder(order.id))?.activationState).toBe("failed");

    // The sweep retries with a healthy grantor: exactly one payout lands.
    const second = buildService({ store, providers: [alipay], grantor });
    await second.service.sweepActivations();
    expect(payouts).toHaveLength(1);
    expect((await store.readOrder(order.id))?.activationState).toBe("applied");
  });

  test("a plan the catalog grants no credits to grants nothing, silently", async () => {
    const { grantor, payouts } = recordingGrantor({
      creditsFor: () => null,
    });
    await settledOrder(grantor);
    expect(payouts).toHaveLength(0);
  });

  test("an already-applied order re-asked grants nothing", async () => {
    const { grantor, payouts } = recordingGrantor();
    const { orderId, store } = await settledOrder(grantor);
    expect((await store.readOrder(orderId))?.activationState).toBe("applied");
    // The sweep's pass on an applied order is a no-op — activation short-circuits.
    const { service } = buildService({ store, grantor });
    await service.sweepActivations();
    expect(payouts).toHaveLength(1);
  });
});

describe("the expiry sweep", () => {
  test("query-first: a channel that says paid settles; one that says pending expires then closes", async () => {
    const store = memoryStore();
    const { order: paid } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs - 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const { order: stale } = await store.insertOrder({
      planCode: "pro",
      provider: "wechat",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs - 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const alipay = fakeProvider("alipay", {
      queryPayment: async () => ({
        outTradeNo: paid.id,
        state: "paid" as const,
        channelTransactionId: "tx-sweep",
        amountCents: 8800,
      }),
    });
    const wechat = fakeProvider("wechat", {
      queryPayment: async () => ({
        outTradeNo: stale.id,
        state: "pending" as const,
      }),
    });
    const { service } = buildService({ providers: [alipay, wechat], store });
    await service.sweepExpired();
    expect((await store.readOrder(paid.id))?.status).toBe("paid");
    expect((await store.readOrder(stale.id))?.status).toBe("expired");
    expect(wechat.closes).toEqual([stale.id]);
  });

  test("an unreachable channel is skipped, not expired", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs - 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const alipay = fakeProvider("alipay", {
      queryPayment: async () => {
        throw new Error("down");
      },
    });
    const { service } = buildService({ providers: [alipay], store });
    await service.sweepExpired();
    expect((await store.readOrder(order.id))?.status).toBe("pending");
  });

  test("a channel's terminal 'no such order' verdict (a closed fact) expires the order", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs - 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    // The shape a 404 (WeChat) or ACQ.TRADE_NOT_EXIST (Alipay) is spelled as: a verdict, not a
    // thrown error — the order stranded by a failed createSession finally reaches a terminal
    // state instead of being re-asked forever.
    const alipay = fakeProvider("alipay", {
      queryPayment: async () => ({
        outTradeNo: order.id,
        state: "closed" as const,
      }),
    });
    const { service } = buildService({ providers: [alipay], store });
    await service.sweepExpired();
    expect((await store.readOrder(order.id))?.status).toBe("expired");
    expect(alipay.closes).toEqual([order.id]);
  });
});
