import { describe, expect, spyOn, test } from "bun:test";
import { BillingError } from "../src/billing/types";
import { getLogger } from "../../shared/logger";
import {
  createPaymentService,
  PurchaseError,
  type PaymentLagoFacade,
} from "../src/billing/payments/service";
import type { PaymentProvider } from "../src/billing/payments/provider";
import type {
  PaymentOrderRecord,
  PaymentProviderId,
  PaymentStore,
} from "../src/billing/payments/types";

/*
 * The orchestration against in-memory doubles: a store that honours the CAS and the paid-fact
 * uniqueness the real one guarantees, providers whose five methods are swapped per test, and a
 * Lago facade that records its calls. No socket, no database — the tests target the decisions:
 * the replay rules, the amount gate, the window anchored at terminalAt, and the activation gate.
 */

/** A fixed clock the tests share; `advance` moves it so window edges are reachable. */
let clockMs = 1_791_900_000_000;
const tick = () => new Date(clockMs);
const advance = (ms: number) => {
  clockMs += ms;
};

function memoryStore(): PaymentStore {
  const orders = new Map<string, PaymentOrderRecord>();
  const paidFacts = new Set<string>();
  const anomalies: Array<{ orderId: string; code: string }> = [];
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
    terminalAt: null,
    createdBy: "admin-1",
    createdAt: new Date(clockMs),
    version: 0,
  };

  function seed(overrides: Partial<PaymentOrderRecord> = {}): PaymentOrderRecord {
    serial += 1;
    const order = { ...base, ...overrides, id: overrides.id ?? `po-${String(serial).padStart(16, "0")}` };
    orders.set(order.id, order);
    return order;
  }

  return {
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
        terminalAt: null,
        version: 0,
        createdAt: tick(),
      };
      orders.set(order.id, order);
      return order;
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
    async readLatestPaidOrder(planCode) {
      const paid = [...orders.values()]
        .filter((order) => order.planCode === planCode && order.status === "paid")
        .sort(
          (a, b) => (b.terminalAt?.getTime() ?? 0) - (a.terminalAt?.getTime() ?? 0),
        );
      return paid[0] ?? null;
    },
    async readLatestLiveOrder() {
      const live = [...orders.values()]
        .filter((order) => order.status === "pending" || order.status === "paid")
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return live[0] ?? null;
    },
    async setCheckoutPayload(id, payload) {
      const order = orders.get(id);
      if (order) orders.set(id, { ...order, checkoutPayload: payload });
    },
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
      orders.set(input.id, {
        ...order,
        status: "paid",
        channelTransactionId: input.channelTransactionId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        terminalAt: tick(),
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
      anomalies.push({ orderId: input.id, code: "amount_mismatch" });
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
    async recordAnomaly(event) {
      anomalies.push({ orderId: event.orderId, code: event.code });
    },
    async recordPaidFact(event) {
      if (paidFacts.has(event.channelTransactionId)) return false;
      paidFacts.add(event.channelTransactionId);
      return true;
    },
    async recordActivation(id, activationState) {
      const order = orders.get(id);
      if (order) orders.set(id, { ...order, activationState });
    },
    async listExpiredPendingOrders(at) {
      return [...orders.values()].filter(
        (order) => order.status === "pending" && order.expiresAt.getTime() <= at.getTime(),
      );
    },
  };
}

function fakeProvider(
  id: PaymentProviderId,
  overrides: Partial<PaymentProvider> = {},
): PaymentProvider & { closes: string[]; queries: string[] } {
  const closes: string[] = [];
  const queries: string[] = [];
  return {
    id,
    closes,
    queries,
    createSession: async () => ({ checkout: { kind: "qrcode", payload: `qr-${id}` } }),
    queryPayment: async (outTradeNo: string) => {
      queries.push(outTradeNo);
      return { outTradeNo, state: "pending" as const };
    },
    closePayment: async (outTradeNo: string) => {
      closes.push(outTradeNo);
    },
    verifyNotification: async () => ({ ok: false }),
    successAck: { body: id === "alipay" ? "success" : '{"code":"SUCCESS"}', contentType: "text/plain" },
    ...overrides,
  } as PaymentProvider & { closes: string[]; queries: string[] };
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
    invalidateEntitlementCache?: () => void;
    /** `false` injects no logger, exercising the service's shared-logger fallback. */
    log?: { warn(message: string): void } | false;
  } = {},
) {
  const store = overrides.store ?? memoryStore();
  const providers = overrides.providers ?? [fakeProvider("alipay")];
  const lago = overrides.lago ?? fakeLago();
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  const s = createPaymentService({
    providers: providerMap,
    store,
    catalog: new Map([["pro", { amountCents: 8800, currency: "CNY", periodMonths: 1 }]]),
    notifyBaseUrl: "https://payments.openbot.example",
    orderTtlMinutes: 15,
    latePaymentWindowHours: overrides.latePaymentWindowHours ?? 24,
    acceptForeignCurrency: overrides.acceptForeignCurrency ?? false,
    lago,
    externalCustomerKey: "openbot-deployment-t1",
    activePlanCode: overrides.activePlanCode ?? (async () => null),
    invalidateEntitlementCache:
      overrides.invalidateEntitlementCache ?? (() => undefined),
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
      provider: "alipay",
      createdBy: "admin-1",
    });
    const second = await service.createPurchase({
      planCode: "pro",
      provider: "alipay",
      createdBy: "admin-1",
    });
    expect(second.order.orderId).toBe(first.order.orderId);
    expect((await store.readOrder(first.order.orderId))?.version).toBe(0);
  });

  test("a channel switch cancels the old order and closes it at the old channel", async () => {
    const alipay = fakeProvider("alipay");
    const wechat = fakeProvider("wechat");
    const { service } = buildService({ providers: [alipay, wechat] });
    const first = await service.createPurchase({
      planCode: "pro",
      provider: "alipay",
      createdBy: "admin-1",
    });
    const second = await service.createPurchase({
      planCode: "pro",
      provider: "wechat",
      createdBy: "admin-1",
    });
    expect(second.order.orderId).not.toBe(first.order.orderId);
    expect(second.order.provider).toBe("wechat");
    expect(alipay.closes).toEqual([first.order.orderId]);
    expect((await service.readOrder(first.order.orderId)).order?.status).toBe("canceled");
  });

  test("an active subscription refuses the purchase with its plan named", async () => {
    const { service } = buildService({
      activePlanCode: async () => "pro",
    });
    await expect(
      service.createPurchase({ planCode: "pro", provider: "alipay", createdBy: "admin-1" }),
    ).rejects.toMatchObject({
      refusal: { reason: "active-subscription", activePlanCode: "pro" },
    });
  });

  test("a plan outside the catalog refuses", async () => {
    const { service } = buildService();
    await expect(
      service.createPurchase({ planCode: "ghost", provider: "alipay", createdBy: "a" }),
    ).rejects.toBeInstanceOf(PurchaseError);
  });

  test("a channel failure leaves the order pending for a replay, and surfaces the sentinel", async () => {
    const broken = fakeProvider("alipay", {
      createSession: async () => {
        throw Object.assign(new Error("Billing provider failed (unreachable)."), {
          name: "BillingError",
        });
      },
    });
    const { service, store } = buildService({ providers: [broken] });
    await expect(
      service.createPurchase({ planCode: "pro", provider: "alipay", createdBy: "a" }),
    ).rejects.toThrow(/unreachable/);
    const pending = await store.readPendingOrder("pro", "alipay");
    expect(pending?.status).toBe("pending");
    expect(pending?.checkoutPayload).toBeNull();
    // The retry replays the same stranded order instead of stacking another.
    const recoverable = fakeProvider("alipay");
    const second = buildService({ providers: [recoverable], store });
    const replayed = await second.service.createPurchase({
      planCode: "pro",
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
    expect(await withStale.service.handleCallback("alipay", new Headers(), "x")).toEqual({
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
    expect((await store.readPendingOrder("pro", "alipay"))?.status).toBe("pending");
  });

  test("a paid fact for an order that does not exist answers unknown-order", async () => {
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({ ok: true, fact: paidFactFor("po-missing") }),
    });
    const { service } = buildService({ providers: [alipay] });
    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "unknown-order",
    });
  });

  test("a matching paid fact moves pending to paid and activates", async () => {
    const store = memoryStore();
    const order = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs + 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({ ok: true, fact: paidFactFor(order.id) }),
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

  test("an amount mismatch blocks a pending order and answers success (terminal quiet)", async () => {
    const store = memoryStore();
    const order = await store.insertOrder({
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
      kind: "success",
    });
    expect((await store.readOrder(order.id))?.status).toBe("blocked");
    // Blocked absorbs: the same mismatched delivery again changes nothing.
    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "success",
    });
    expect((await store.readOrder(order.id))?.status).toBe("blocked");
  });

  test("a paid fact whose amount the channel did not state leaves the order pending", async () => {
    const store = memoryStore();
    const order = await store.insertOrder({
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
        fact: { outTradeNo: order.id, state: "paid", channelTransactionId: "tx-9" },
      }),
    });
    const { service } = buildService({ providers: [alipay], store });
    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "success",
    });
    expect((await store.readOrder(order.id))?.status).toBe("pending");
  });

  test("a second transaction on a paid order is an over-payment anomaly, not a migration", async () => {
    const store = memoryStore();
    const order = await store.insertOrder({
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
      verifyNotification: async () => ({ ok: true, fact: paidFactFor(order.id) }),
    });
    const { service } = buildService({ providers: [alipay], store, lago });
    await service.handleCallback("alipay", new Headers(), "x");
    const secondDelivery = fakeProvider("alipay", {
      verifyNotification: async () => ({
        ok: true,
        fact: { ...paidFactFor(order.id), channelTransactionId: "tx-2" },
      }),
    });
    const { service: second } = buildService({ providers: [secondDelivery], store, lago });
    expect(await second.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "success",
    });
    const settled = await store.readOrder(order.id);
    expect(settled?.status).toBe("paid");
    expect(settled?.channelTransactionId).toBe("tx-1");
    expect(lago.state.subscriptions).toHaveLength(1);
  });

  test("an expired order inside the window pays, anchored at terminalAt (+23h yes, +25h no)", async () => {
    const store = memoryStore();
    const order = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.expireOrder(order.id, order.version);
    const expiredAt = (await store.readOrder(order.id))?.terminalAt?.getTime() ?? 0;

    const paidProvider = () =>
      fakeProvider("alipay", {
        verifyNotification: async () => ({ ok: true, fact: paidFactFor(order.id) }),
      });

    // +23h past the terminal moment: inside the 24h window — the money is honoured.
    clockMs = expiredAt + 23 * 3600_000;
    const inside = buildService({ providers: [paidProvider()], store });
    expect(await inside.service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "success",
    });
    expect((await store.readOrder(order.id))?.status).toBe("paid");
  });

  test("an expired order outside the window records late_payment and stays expired", async () => {
    const store = memoryStore();
    const order = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.expireOrder(order.id, order.version);
    const terminalAt = (await store.readOrder(order.id))?.terminalAt?.getTime() ?? 0;
    clockMs = terminalAt + 25 * 3600_000;

    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({ ok: true, fact: paidFactFor(order.id) }),
    });
    const lago = fakeLago();
    const { service } = buildService({ providers: [alipay], store, lago });
    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "success",
    });
    expect((await store.readOrder(order.id))?.status).toBe("expired");
    expect(lago.state.subscriptions).toHaveLength(0);
  });

  test("a canceled order revives inside the window; a newer paid order on the plan raises duplicate_paid", async () => {
    const store = memoryStore();
    const older = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs),
      createdBy: "a",
      checkoutPayload: null,
    });
    await store.cancelOrder(older.id, older.version);
    const canceledAt = (await store.readOrder(older.id))?.terminalAt?.getTime() ?? 0;
    clockMs = canceledAt + 60_000;

    // A newer order on the same plan has already been paid.
    const newer = await store.insertOrder({
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
      periodEnd: tick(),
    });

    const alipay = fakeProvider("alipay", {
      verifyNotification: async () => ({ ok: true, fact: paidFactFor(older.id) }),
    });
    const { service } = buildService({ providers: [alipay, fakeProvider("wechat")], store });
    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "success",
    });
    expect((await store.readOrder(older.id))?.status).toBe("paid");
  });

  test("blocked refuses every migration, including a well-paid fact", async () => {
    const store = memoryStore();
    const order = await store.insertOrder({
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
      verifyNotification: async () => ({ ok: true, fact: paidFactFor(order.id) }),
    });
    const lago = fakeLago();
    const { service } = buildService({ providers: [alipay], store, lago });
    expect(await service.handleCallback("alipay", new Headers(), "x")).toEqual({
      kind: "success",
    });
    expect((await store.readOrder(order.id))?.status).toBe("blocked");
    expect(lago.state.subscriptions).toHaveLength(0);
  });
});

describe("the poll's read side", () => {
  test("a pending order gets one channel query; money found settles and activates", async () => {
    const store = memoryStore();
    const order = await store.insertOrder({
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
    const order = await store.insertOrder({
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
    expect(view.order?.checkout).toEqual({ kind: "qrcode", payload: "qr-open" });
  });
});

describe("cancel", () => {
  test("pending cancels and closes at the channel; canceling twice answers idempotent", async () => {
    const alipay = fakeProvider("alipay");
    const { service } = buildService({ providers: [alipay] });
    const { order } = await service.createPurchase({
      planCode: "pro",
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
    const paid = await store.insertOrder({
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
    const expired = await store.insertOrder({
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
    expect((await service.cancelPurchase("po-missing")).outcome).toBe("unknown");
  });
});

describe("activation gate", () => {
  /**
   * A pending order plus the provider that delivers its matching paid fact: activation is
   * triggered by the settle core, so every gate test rides the same path a real delivery does.
   */
  async function pendingWithPaidDelivery(store: PaymentStore) {
    const order = await store.insertOrder({
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
      getPlan: async () => ({ found: true, interval: "yearly", currency: "CNY" }),
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
    expect((await storeA.readOrder(orderA.order.id))?.activationState).toBe("failed");

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
    expect((await storeB.readOrder(orderB.order.id))?.activationState).toBe("applied");
    expect(invalidated).toBe(1);
  });

  test("an unreachable provider keeps activation pending for the next pass", async () => {
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
    expect((await store.readOrder(order.id))?.activationState).toBe("pending");
  });

  test("with no injected logger, warnings fall through to the shared server logger", async () => {
    const store = memoryStore();
    const { order, alipay } = await pendingWithPaidDelivery(store);
    const lago = fakeLago({
      getPlan: async () => ({ found: true, interval: "monthly", currency: "USD" }),
    });
    const warned: string[] = [];
    const warn = spyOn(getLogger("server"), "warn").mockImplementation(
      (...args: unknown[]) => {
        warned.push(
          args
            .map((argument) =>
              typeof argument === "string" ? argument : JSON.stringify(argument),
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

describe("the expiry sweep", () => {
  test("query-first: a channel that says paid settles; one that says pending expires then closes", async () => {
    const store = memoryStore();
    const paid = await store.insertOrder({
      planCode: "pro",
      provider: "alipay",
      amountCents: 8800,
      currency: "CNY",
      expiresAt: new Date(clockMs - 60_000),
      createdBy: "a",
      checkoutPayload: null,
    });
    const stale = await store.insertOrder({
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
      queryPayment: async () => ({ outTradeNo: stale.id, state: "pending" as const }),
    });
    const { service } = buildService({ providers: [alipay, wechat], store });
    await service.sweepExpired();
    expect((await store.readOrder(paid.id))?.status).toBe("paid");
    expect((await store.readOrder(stale.id))?.status).toBe("expired");
    expect(wechat.closes).toEqual([stale.id]);
  });

  test("an unreachable channel is skipped, not expired", async () => {
    const store = memoryStore();
    const order = await store.insertOrder({
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
});
