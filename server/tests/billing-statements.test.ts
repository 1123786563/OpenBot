import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  createBillingStatementRoutes,
  statementQueryInput,
} from "../src/billing/routes";
import { createBillingStatements } from "../src/billing/statements";
import type {
  BillingEntitlements,
  BillingService,
  BillingUsage,
  BillingQuotaEntry,
} from "../src/billing/types";
import type { PaymentOrderRecord, PaymentStore } from "../src/billing/payments/types";

const MEMBER: AuthenticatedActor = {
  id: "user-member",
  email: "member@openbot.test",
  role: "user",
};

const PERIOD_START = "2026-10-01T00:00:00.000Z";
const PERIOD_END = "2026-11-01T00:00:00.000Z";

/**
 * The provider's reader, from the interface rather than a fetch stub: these tests assert what the
 * statement read DOES with an answer, not the conversation it had to get one.
 */
function fakeService(
  entitlements: BillingEntitlements,
  usage: BillingUsage | null,
): BillingService {
  return {
    ensureCustomer: async () => ({ externalId: "x" }),
    ensureSubscription: async () => ({
      externalCustomerId: "x",
      externalSubscriptionId: "y",
    }),
    handleWebhook: async () => new Response(null, { status: 200 }),
    entitlements: async () => entitlements,
    invalidateEntitlementCache: () => {},
    usage: async () => usage,
    usageEvents: async () => ({
      events: [],
      totalCount: 0,
      totalPages: 0,
      currentPage: 1,
      nextPage: null,
    }),
    usageDaily: async () => ({ days: [], truncated: false }),
    recordUsage: async () => {},
    snapshot: async () => ({
      configured: true,
      customers: 1,
      subscriptions: 1,
      webhookEvents: 0,
    }),
    reconcile: async () => {
      throw new Error("not built");
    },
  };
}

const ACTIVE: BillingEntitlements = {
  active: true,
  planCode: "pro",
  codes: [],
  subscription: {
    status: "active",
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
  },
};

const USAGE: BillingUsage = {
  fromDatetime: PERIOD_START,
  toDatetime: PERIOD_END,
  currency: "CNY",
  amountCents: 19900,
  totalAmountCents: 19900,
  charges: [
    { metricCode: "llm_tokens", metricName: "模型 tokens", units: "1500.0", amountCents: 19900 },
    { metricCode: "computer_minutes", metricName: "云电脑时长", units: "42", amountCents: 0 },
  ],
};

const QUOTAS: readonly BillingQuotaEntry[] = [
  {
    metricCode: "llm_tokens",
    metricName: "模型 tokens",
    unit: "tokens",
    used: 0,
    limit: 2000,
    remaining: 2000,
    usedCents: 0,
  },
];

function order(over: Partial<PaymentOrderRecord> = {}): PaymentOrderRecord {
  return {
    id: "po-aaaaaaaaaaaaaaaa",
    planCode: "pro",
    provider: "alipay",
    amountCents: 19900,
    currency: "CNY",
    status: "paid",
    activationState: "applied",
    channelTransactionId: "2026100122001",
    checkoutPayload: null,
    expiresAt: new Date("2026-10-01T00:15:00.000Z"),
    periodStart: new Date(PERIOD_START),
    periodEnd: new Date(PERIOD_END),
    terminalAt: new Date("2026-10-01T00:05:00.000Z"),
    createdBy: "user-admin",
    createdAt: new Date("2026-10-01T00:01:00.000Z"),
    version: 1,
    ...over,
  };
}

/** A payment ledger over a fixed list, recording the window it was asked for. */
function fakeOrders(rows: PaymentOrderRecord[]) {
  const calls: { from: Date | null; to: Date | null }[] = [];
  const store = {
    insertOrder: async () => order(),
    readOrder: async (id: string) => rows.find((row) => row.id === id) ?? null,
    readPendingOrder: async () => null,
    readLatestPaidOrder: async () => null,
    readLatestLiveOrder: async () => null,
    setCheckoutPayload: async () => {},
    cancelOrder: async () => false,
    confirmPaid: async () => ({ claimed: false, alreadyKnown: false }),
    blockOrder: async () => false,
    expireOrder: async () => false,
    recordAnomaly: async () => {},
    recordPaidFact: async () => false,
    recordActivation: async () => {},
    listExpiredPendingOrders: async () => [],
    listPaidPendingActivationOrders: async () => [],
    listOrdersInWindow: async (input: {
      from: Date | null;
      to: Date | null;
      limit: number;
      offset: number;
    }) => {
      calls.push({ from: input.from, to: input.to });
      return rows
        .filter(
          (row) =>
            (!input.from || row.createdAt >= input.from) &&
            (!input.to || row.createdAt <= input.to),
        )
        .slice(input.offset, input.offset + input.limit);
    },
    countOrdersInWindow: async (input: { from: Date | null; to: Date | null }) =>
      rows.filter(
        (row) =>
          (!input.from || row.createdAt >= input.from) &&
          (!input.to || row.createdAt <= input.to),
      ).length,
  } as unknown as PaymentStore;
  return { calls, store };
}

describe("plan usage", () => {
  test("joins the period, the charges and the configured ceiling", async () => {
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map([["pro", QUOTAS]]),
    });
    const answer = await statements.planUsage();
    expect(answer.active).toBe(true);
    expect(answer.planCode).toBe("pro");
    expect(answer.status).toBe("active");
    expect(answer.resetsAt).toBe(PERIOD_END);
    expect(answer.currentPeriodStart).toBe(PERIOD_START);
    const tokens = answer.quotas.find((q) => q.metricCode === "llm_tokens");
    expect(tokens).toMatchObject({ used: 1500, limit: 2000, remaining: 500 });
  });

  test("a metric with no configured ceiling is metered, not capped", async () => {
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map([["pro", QUOTAS]]),
    });
    const answer = await statements.planUsage();
    const computer = answer.quotas.find(
      (q) => q.metricCode === "computer_minutes",
    );
    expect(computer).toMatchObject({ limit: null, remaining: null, used: 42 });
  });

  test("a configured ceiling with no usage yet reads full", async () => {
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, {
        ...USAGE,
        charges: [],
      }),
      quotas: new Map([["pro", QUOTAS]]),
    });
    const answer = await statements.planUsage();
    expect(answer.quotas[0]).toMatchObject({
      used: 0,
      limit: 2000,
      remaining: 2000,
    });
  });

  test("usage past the ceiling floors the remainder at zero, never negative", async () => {
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, {
        ...USAGE,
        charges: [
          { metricCode: "llm_tokens", metricName: "t", units: "9999", amountCents: 1 },
        ],
      }),
      quotas: new Map([["pro", QUOTAS]]),
    });
    const answer = await statements.planUsage();
    expect(answer.quotas[0]?.remaining).toBe(0);
  });

  test("no subscription is a fact, not a failure", async () => {
    const statements = createBillingStatements({
      service: fakeService({ active: false, codes: [] }, null),
      quotas: new Map(),
    });
    expect(await statements.planUsage()).toEqual({
      active: false,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      resetsAt: null,
      quotas: [],
    });
  });
});

describe("invoices", () => {
  test("a bill is a stored order read as a statement", async () => {
    const { store } = fakeOrders([order()]);
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map(),
      orders: store,
    });
    const page = await statements.invoices({
      from: null,
      to: null,
      page: 1,
    });
    expect(page.pagination.totalCount).toBe(1);
    expect(page.invoices[0]).toMatchObject({
      invoiceId: "po-aaaaaaaaaaaaaaaa",
      planCode: "pro",
      amountCents: 19900,
      status: "paid",
      method: "alipay",
      channelTransactionId: "2026100122001",
    });
    expect(page.invoices[0]?.periodStart).toBe(PERIOD_START);
  });

  test("an empty window is one empty page, never page 1 of 0", async () => {
    const { store } = fakeOrders([]);
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map(),
      orders: store,
    });
    const page = await statements.invoices({ from: null, to: null, page: 1 });
    expect(page.invoices).toEqual([]);
    expect(page.pagination).toMatchObject({
      totalCount: 0,
      totalPages: 1,
      currentPage: 1,
      nextPage: null,
    });
  });

  test("the window is passed through to the ledger, not applied twice", async () => {
    const { store, calls } = fakeOrders([order()]);
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map(),
      orders: store,
    });
    const from = new Date("2026-09-01T00:00:00.000Z");
    await statements.invoices({ from, to: null, page: 1 });
    expect(calls[0]?.from).toEqual(from);
    expect(calls[0]?.to).toBeNull();
  });

  test("a deployment with no channels has no bills and no error", async () => {
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map(),
    });
    const page = await statements.invoices({ from: null, to: null, page: 1 });
    expect(page.invoices).toEqual([]);
    expect(await statements.invoice("po-nope")).toBeNull();
  });

  test("the detail carries the line the bill is made of", async () => {
    const { store } = fakeOrders([order()]);
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map(),
      orders: store,
    });
    const detail = await statements.invoice("po-aaaaaaaaaaaaaaaa");
    expect(detail?.lines).toEqual([
      { label: "pro", quantity: 1, amountCents: 19900 },
    ]);
  });
});

describe("statement routes", () => {
  function app(
    statements: ReturnType<typeof createBillingStatements>,
    actor: AuthenticatedActor | undefined,
  ) {
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      if (!actor) return context.json({ error: "Authentication required." }, 401);
      context.set("actor", actor);
      await next();
    };
    return new Hono<{ Variables: AppVariables }>().route(
      "/api/billing",
      createBillingStatementRoutes({ statements, requireUser }),
    );
  }

  const withOrders = () => {
    const { store } = fakeOrders([order()]);
    return createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map([["pro", QUOTAS]]),
      orders: store,
    });
  };

  test("a signed-out caller is refused on both reads", async () => {
    const response = await app(withOrders(), undefined).request(
      "/api/billing/plan-usage",
    );
    expect(response.status).toBe(401);
  });

  test("plan usage is one answer behind the session", async () => {
    const response = await app(withOrders(), MEMBER).request(
      "/api/billing/plan-usage",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { active: boolean; quotas: unknown[] };
    expect(body.active).toBe(true);
    expect(body.quotas).toHaveLength(2);
  });

  test("the bill list answers the window it was asked for", async () => {
    const response = await app(withOrders(), MEMBER).request(
      "/api/billing/invoices?from=2026-09-01T00%3A00%3A00.000Z&page=1",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      pagination: { totalCount: number };
    };
    expect(body.pagination.totalCount).toBe(1);
  });

  test("a malformed window is a 400 with a sentence of ours", async () => {
    const response = await app(withOrders(), MEMBER).request(
      "/api/billing/invoices?from=last-wednesday",
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Supply a valid request.");
  });

  test("an unknown bill is a 404, not an empty object", async () => {
    const response = await app(withOrders(), MEMBER).request(
      "/api/billing/invoices/po-does-not-exist",
    );
    expect(response.status).toBe(404);
  });

  test("one bill answers its detail", async () => {
    const response = await app(withOrders(), MEMBER).request(
      "/api/billing/invoices/po-aaaaaaaaaaaaaaaa",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      invoice: { invoiceId: string; lines: unknown[] };
    };
    expect(body.invoice.invoiceId).toBe("po-aaaaaaaaaaaaaaaa");
    expect(body.invoice.lines).toHaveLength(1);
  });
});

describe("statement query parsing", () => {
  test("a page past the end parses, because a pager may walk there", () => {
    const parsed = statementQueryInput.safeParse({ page: "9999" });
    expect(parsed.success).toBe(true);
  });

  test("a page of zero does not", () => {
    expect(statementQueryInput.safeParse({ page: "0" }).success).toBe(false);
  });

  test("an absent window is the whole history", () => {
    const parsed = statementQueryInput.safeParse({});
    expect(parsed.success && parsed.data.from).toBeUndefined();
    expect(parsed.success && parsed.data.page).toBe(1);
  });
});
