import { describe, expect, test } from "bun:test";
import type { PaymentProvider } from "../src/billing/payments/provider";
import {
  createPaymentService,
  type PlanCreditGrantor,
} from "../src/billing/payments/service";
import type {
  PaymentEventInput,
  PaymentOrderRecord,
  PaymentProviderId,
  PaymentStore,
} from "../src/billing/payments/types";

/*
 * QA batch-1 probe (c)+(d), aligned with the deployment-scoped purchase semantics: the SERVICE
 * layer's duplicate-payment visibility and the pending-activation guarantee around the
 * plan-credit payout, on in-memory doubles that honour the CAS, the pending-scope conflict, and
 * the paid-fact uniqueness the real store guarantees.
 *
 * The sharpest question (probe c): a second paid order on the same plan must remain paid (the
 * money is real) but is HELD from activation — the entitlement owner stays the first claimant —
 * and the double collection is visible as a durable duplicate_paid anomaly. Whether that
 * contract holds on the sequential cross-provider path is exactly what these tests decide.
 */
const clockMs = 1_791_900_000_000;
const tick = () => new Date(clockMs);

function memoryStore(): PaymentStore & {
  anomalies: Array<{ orderId: string; code: string; detail: string }>;
  orders: Map<string, PaymentOrderRecord>;
} {
  const orders = new Map<string, PaymentOrderRecord>();
  const paidFacts = new Set<string>();
  const anomalies: Array<{ orderId: string; code: string; detail: string }> = [];
  let serial = 0;

  return {
    orders,
    anomalies,
    async insertOrder(input) {
      serial += 1;
      const order: PaymentOrderRecord = {
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
        createdBy: "qa",
        ownerPayerRef: { kind: "personal" as const, id: "qa" },
        createdAt: new Date(clockMs + serial),
        version: 0,
        ...input,
        id: `po-qa${String(serial).padStart(10, "0")}`,
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
    async readPaidOrderByTransaction(channelTransactionId) {
      return (
        [...orders.values()].find(
          (order) =>
            order.status === "paid" &&
            order.channelTransactionId === channelTransactionId,
        ) ?? null
      );
    },
    async countAnomalies(orderId, code) {
      return anomalies.filter(
        (a) => a.orderId === orderId && a.code === code,
      ).length;
    },
    async resolveActivationOwnership(orderId) {
      const anchor = orders.get(orderId);
      if (!anchor) return { outcome: "unknown" as const };
      if (anchor.status !== "paid" || !anchor.periodStart || !anchor.periodEnd) {
        return { outcome: "not-paid" as const };
      }
      const locked = [...orders.values()].filter(
        (order) =>
          order.planCode === anchor.planCode &&
          order.status === "paid" &&
          order.periodStart !== null &&
          order.periodEnd !== null &&
          order.periodStart < (anchor.periodEnd as Date) &&
          order.periodEnd > (anchor.periodStart as Date),
      );
      const current = locked.find((order) => order.id === orderId);
      if (!current) return { outcome: "unknown" as const };
      const byClaimedOwner = (a: PaymentOrderRecord, b: PaymentOrderRecord) =>
        Number(b.activationState === "applied") -
          Number(a.activationState === "applied") ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id);
      const byOverlapWinner = (a: PaymentOrderRecord, b: PaymentOrderRecord) =>
        (a.periodStart?.getTime() ?? Number.MAX_SAFE_INTEGER) -
          (b.periodStart?.getTime() ?? Number.MAX_SAFE_INTEGER) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id);
      // A claimant that is not `pending` owns the period; the earliest-starting paid order
      // claims an unowned one, exactly like the real store's row-locked resolution.
      const existingOwner = [...locked]
        .filter((order) => order.activationState !== "pending")
        .sort(byClaimedOwner)[0];
      if (existingOwner) {
        if (existingOwner.id === current.id) {
          return { outcome: "owner" as const, order: current };
        }
        return {
          outcome: "duplicate" as const,
          order: current,
          ownerOrder: existingOwner,
        };
      }
      const winner = [...locked].sort(byOverlapWinner)[0];
      if (!winner) return { outcome: "unknown" as const };
      if (winner.id !== current.id) {
        return {
          outcome: "duplicate" as const,
          order: current,
          ownerOrder: winner,
        };
      }
      if (current.activationState === "pending") {
        const claimed: PaymentOrderRecord = {
          ...current,
          activationState: "failed",
        };
        orders.set(current.id, claimed);
        return { outcome: "owner" as const, order: claimed };
      }
      return { outcome: "owner" as const, order: current };
    },
    async readLatestLiveOrder() {
      return null;
    },
    async setCheckoutPayload() {},
    async cancelOrder(id, expectedVersion) {
      const order = orders.get(id);
      if (!order || order.version !== expectedVersion || order.status !== "pending") {
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
      if (!order || order.version !== input.expectedVersion || order.status !== "pending") {
        return false;
      }
      orders.set(input.id, {
        ...order,
        status: "blocked",
        terminalAt: tick(),
        version: input.expectedVersion + 1,
      });
      anomalies.push({ orderId: input.id, code: "amount_mismatch", detail: input.detail });
      return true;
    },
    async expireOrder(id, expectedVersion) {
      const order = orders.get(id);
      if (!order || order.version !== expectedVersion || order.status !== "pending") {
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
    async recordAnomaly(event: PaymentEventInput) {
      anomalies.push({ orderId: event.orderId, code: event.code, detail: event.detail });
    },
    async recordPaidFact(event) {
      if (paidFacts.has(event.channelTransactionId)) return false;
      paidFacts.add(event.channelTransactionId);
      return true;
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
    async listExpiredPendingOrders() {
      return [];
    },
    async listPaidPendingActivationOrders() {
      return [...orders.values()].filter(
        (order) =>
          order.status === "paid" &&
          (order.activationState === "pending" ||
            order.activationState === "failed"),
      );
    },
  };
}

function paidDelivery(orderId: string, transactionId: string): PaymentProvider {
  return {
    id: "alipay",
    async createSession() {
      return { checkout: { kind: "qrcode", payload: "qr" } };
    },
    async queryPayment() {
      return { outTradeNo: orderId, state: "pending" as const };
    },
    async closePayment() {},
    async verifyNotification() {
      return {
        ok: true as const,
        fact: {
          outTradeNo: orderId,
          state: "paid" as const,
          channelTransactionId: transactionId,
          amountCents: 8800,
        },
      };
    },
    successAck: { body: "success", contentType: "text/plain" },
  };
}

describe("probe c: duplicate_paid visibility on the sequential path", () => {
  test("a second paid order on the plan (cross-provider) records duplicate_paid", async () => {
    const store = memoryStore();
    const { order: first } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "qa",
      ownerPayerRef: { kind: "personal" as const, id: "qa" },
      checkoutPayload: null,
    });
    // The first purchase pays through the callback path.
    const firstService = createPaymentService({
      providers: new Map([["alipay", paidDelivery(first.id, "tx-first")]]),
      store,
      catalog: new Map([["pro", { amountCents: 8800, currency: "CNY", periodMonths: 1 }]]),
      notifyBaseUrl: "https://x.example",
      orderTtlMinutes: 15,
      latePaymentWindowHours: 24,
      acceptForeignCurrency: false,
      lago: {
        async getPlan() {
          return { found: true, interval: "monthly", currency: "CNY" };
        },
        async ensureSubscription() {
          return {};
        },
      },
      externalCustomerKey: "qa-deployment",
      activePlanCode: async () => null,
      invalidateEntitlementCache: () => undefined,
      now: tick,
      log: { warn: () => undefined },
    });
    expect(
      await firstService.handleCallback("alipay", new Headers(), "x"),
    ).toEqual({ kind: "success" });
    expect(store.anomalies).toHaveLength(0);

    // The second purchase on the OTHER provider (the pair the pending-pair index cannot bar).
    const { order: second } = await store.insertOrder({
      planCode: "pro",
      provider: "wechat",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "qa",
      ownerPayerRef: { kind: "personal" as const, id: "qa" },
      checkoutPayload: null,
    });
    const wechatDelivery: PaymentProvider = {
      ...paidDelivery(second.id, "tx-second"),
      id: "wechat",
      successAck: { body: '{"code":"SUCCESS"}', contentType: "text/plain" },
    };
    const secondService = createPaymentService({
      providers: new Map([["wechat", wechatDelivery]] as ReadonlyMap<
        PaymentProviderId,
        PaymentProvider
      >),
      store,
      catalog: new Map([["pro", { amountCents: 8800, currency: "CNY", periodMonths: 1 }]]),
      notifyBaseUrl: "https://x.example",
      orderTtlMinutes: 15,
      latePaymentWindowHours: 24,
      acceptForeignCurrency: false,
      lago: {
        async getPlan() {
          return { found: true, interval: "monthly", currency: "CNY" };
        },
        async ensureSubscription() {
          return {};
        },
      },
      externalCustomerKey: "qa-deployment",
      activePlanCode: async () => null,
      invalidateEntitlementCache: () => undefined,
      now: tick,
      log: { warn: () => undefined },
    });
    expect(
      await secondService.handleCallback("wechat", new Headers(), "x"),
    ).toEqual({ kind: "success" });

    // THE contract under the deployment-scoped semantics: the second paid order is paid (money
    // is real, not swallowed) but HELD from activation — the first claimant owns the entitlement
    // — and the duplicate is visible as a durable duplicate_paid anomaly naming the second order.
    const settled = store.orders.get(second.id);
    expect(settled?.status).toBe("paid");
    expect(settled?.activationState).not.toBe("applied");
    expect(store.orders.get(first.id)?.activationState).toBe("applied");
    const duplicate = store.anomalies.filter(
      (a) => a.code === "duplicate_paid" && a.orderId === second.id,
    );
    expect(duplicate.length).toBeGreaterThanOrEqual(1);
    expect(duplicate[0].detail).toContain(first.id);
  });

  test("the same transaction delivered against a second order answers alreadyKnown + duplicate_paid", async () => {
    const store = memoryStore();
    const { order: first } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "qa",
      ownerPayerRef: { kind: "personal" as const, id: "qa" },
      checkoutPayload: null,
    });
    const service = createPaymentService({
      providers: new Map([["alipay", paidDelivery(first.id, "tx-shared")]]),
      store,
      catalog: new Map([["pro", { amountCents: 8800, currency: "CNY", periodMonths: 1 }]]),
      notifyBaseUrl: "https://x.example",
      orderTtlMinutes: 15,
      latePaymentWindowHours: 24,
      acceptForeignCurrency: false,
      lago: {
        async getPlan() {
          return { found: true, interval: "monthly", currency: "CNY" };
        },
        async ensureSubscription() {
          return {};
        },
      },
      externalCustomerKey: "qa-deployment",
      activePlanCode: async () => null,
      invalidateEntitlementCache: () => undefined,
      now: tick,
      log: { warn: () => undefined },
    });
    expect(
      await service.handleCallback("alipay", new Headers(), "x"),
    ).toEqual({ kind: "success" });

    // The SAME channel transaction, now reported against a different order.
    const { order: second } = await store.insertOrder({
      planCode: "pro",
      provider: "wechat",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "qa",
      ownerPayerRef: { kind: "personal" as const, id: "qa" },
      checkoutPayload: null,
    });
    const wechatService = createPaymentService({
      providers: new Map([
        ["wechat", { ...paidDelivery(second.id, "tx-shared"), id: "wechat" }],
      ] as ReadonlyMap<PaymentProviderId, PaymentProvider>),
      store,
      catalog: new Map([["pro", { amountCents: 8800, currency: "CNY", periodMonths: 1 }]]),
      notifyBaseUrl: "https://x.example",
      orderTtlMinutes: 15,
      latePaymentWindowHours: 24,
      acceptForeignCurrency: false,
      lago: {
        async getPlan() {
          return { found: true, interval: "monthly", currency: "CNY" };
        },
        async ensureSubscription() {
          return {};
        },
      },
      externalCustomerKey: "qa-deployment",
      activePlanCode: async () => null,
      invalidateEntitlementCache: () => undefined,
      now: tick,
      log: { warn: () => undefined },
    });
    // The channel is still acknowledged — the anomaly is data, not a failed delivery.
    expect(
      await wechatService.handleCallback("wechat", new Headers(), "x"),
    ).toEqual({ kind: "success" });

    const secondRow = store.orders.get(second.id);
    expect(secondRow?.status).toBe("pending"); // the fact key belongs to the first order
    const duplicate = store.anomalies.filter(
      (a) => a.code === "duplicate_paid" && a.orderId === second.id,
    );
    expect(duplicate).toHaveLength(1);
    // The evidence names the order that already holds the paid fact.
    expect(duplicate[0].detail).toContain(first.id);
  });
});

describe("probe d: the payout keeps applied honest", () => {
  function grantorThrows(): PlanCreditGrantor {
    return {
      creditsFor: () => 900_000,
      async grantPlanCredits() {
        throw new Error("ledger down");
      },
      async readCurrentPeriodEnd() {
        return new Date("2026-11-01T00:00:00Z");
      },
    };
  }

  function baseDeps(store: PaymentStore) {
    return {
      store,
      catalog: new Map([["pro", { amountCents: 8800, currency: "CNY" as const, periodMonths: 1 }]]),
      notifyBaseUrl: "https://x.example",
      orderTtlMinutes: 15,
      latePaymentWindowHours: 24,
      acceptForeignCurrency: false,
      lago: {
        async getPlan() {
          return { found: true, interval: "monthly", currency: "CNY" };
        },
        async ensureSubscription() {
          return {};
        },
      },
      externalCustomerKey: "qa-deployment",
      activePlanCode: async () => null as string | null,
      invalidateEntitlementCache: () => undefined,
      now: tick,
      log: { warn: () => undefined },
    };
  }

  test("a throwing grantor leaves the order claimed but never applied", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "qa",
      ownerPayerRef: { kind: "personal" as const, id: "qa" },
      checkoutPayload: null,
    });
    const service = createPaymentService({
      ...baseDeps(store),
      providers: new Map([["alipay", paidDelivery(order.id, `tx-${order.id}`)]]),
      grantor: grantorThrows(),
    });
    await service.handleCallback("alipay", new Headers(), "x");

    const row = store.orders.get(order.id);
    expect(row?.status).toBe("paid");
    // The ownership claim already landed (activationState "failed"), so no overlapping duplicate
    // can take the entitlement while the payout is outstanding — but "applied" never wrote.
    expect(row?.activationState).toBe("failed");

    // And the sweeper still finds it: the retry pass is the recovery path.
    const found = await store.listPaidPendingActivationOrders(100);
    expect(found.map((o) => o.id)).toContain(order.id);
  });

  test("a withheld expiry (no period from anywhere) also keeps the order unapplied", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "qa",
      ownerPayerRef: { kind: "personal" as const, id: "qa" },
      checkoutPayload: null,
    });
    const service = createPaymentService({
      ...baseDeps(store),
      providers: new Map([["alipay", paidDelivery(order.id, `tx-${order.id}`)]]),
      grantor: {
        creditsFor: () => 900_000,
        async grantPlanCredits() {
          throw new Error("should not be reached: no expiry");
        },
        async readCurrentPeriodEnd() {
          return null;
        },
      },
    });
    await service.handleCallback("alipay", new Headers(), "x");
    const row = store.orders.get(order.id);
    // Claimed ("failed"), payout withheld — the sweep's next pass re-runs it, never "applied".
    expect(row?.activationState).toBe("failed");
  });

  test("a recovered grantor on the sweep lands applied with exactly one payout", async () => {
    const store = memoryStore();
    const { order } = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "qa",
      ownerPayerRef: { kind: "personal" as const, id: "qa" },
      checkoutPayload: null,
    });
    const failing = createPaymentService({
      ...baseDeps(store),
      providers: new Map([["alipay", paidDelivery(order.id, `tx-${order.id}`)]]),
      grantor: grantorThrows(),
    });
    await failing.handleCallback("alipay", new Headers(), "x");

    const payouts: string[] = [];
    const recovered = createPaymentService({
      ...baseDeps(store),
      providers: new Map([["alipay", paidDelivery(order.id, `tx-${order.id}`)]]),
      grantor: {
        creditsFor: () => 900_000,
        async grantPlanCredits(input) {
          payouts.push(input.orderId);
          return { inserted: true };
        },
        async readCurrentPeriodEnd() {
          return new Date("2026-11-01T00:00:00Z");
        },
      },
    });
    await recovered.sweepActivations();
    expect(payouts).toEqual([order.id]);
    expect(store.orders.get(order.id)?.activationState).toBe("applied");
  });
});
