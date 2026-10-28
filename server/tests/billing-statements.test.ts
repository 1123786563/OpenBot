import { describe, expect, test } from "../../tests/support/e2e-compat";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import type {
  PaymentOrderEventRecord,
  PaymentOrderReadScope,
  PaymentOrderRecord,
  PaymentStore,
} from "../src/billing/payments/types";
import {
  createBillingStatementRoutes,
  statementQueryInput,
} from "../src/billing/routes";
import { createBillingStatements } from "../src/billing/statements";
import type {
  BillingEntitlements,
  BillingQuotaEntry,
  BillingService,
  BillingUsage,
} from "../src/billing/types";

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
    activationFailureReason: null,
    activationNextRetryAt: null,
    channelTransactionId: "2026100122001",
    checkoutPayload: null,
    expiresAt: new Date("2026-10-01T00:15:00.000Z"),
    periodStart: new Date(PERIOD_START),
    periodEnd: new Date(PERIOD_END),
    paidAt: new Date("2026-10-01T00:05:00.000Z"),
    terminalAt: new Date("2026-10-01T00:05:00.000Z"),
    createdBy: "user-admin",
        ownerPayerRef: { kind: "personal" as const, id: "user-admin" },
    createdAt: new Date("2026-10-01T00:01:00.000Z"),
    version: 1,
    ...over,
  } as PaymentOrderRecord;
}

function matchesScope(
  row: PaymentOrderRecord,
  scope: PaymentOrderReadScope | undefined,
): boolean {
  // The converged read scope: the order's OWNER PayerRef against the scope's ref — a null
  // owner (a pre-attribution legacy row) never matches, exactly like the real store.
  if (!scope) return true;
  const ref = scope.actorPayerRef;
  return (
    row.ownerPayerRef !== null &&
    row.ownerPayerRef.kind === ref.kind &&
    row.ownerPayerRef.id === ref.id
  );
}

/** A payment ledger over a fixed list, recording the window it was asked for. */
function fakeOrders(rows: PaymentOrderRecord[], anomalies: PaymentOrderEventRecord[] = []) {
  const calls: { from: Date | null; to: Date | null }[] = [];
  const store = {
    insertOrder: async () => order(),
    readOrder: async (id: string, scope?: PaymentOrderReadScope) =>
      rows.find((row) => row.id === id && matchesScope(row, scope)) ?? null,
    readPendingOrder: async () => null,
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
      scope?: PaymentOrderReadScope;
    }) => {
      calls.push({ from: input.from, to: input.to });
      return rows
        .filter(
          (row) =>
            matchesScope(row, input.scope) &&
            (!input.from || row.createdAt >= input.from) &&
            (!input.to || row.createdAt <= input.to),
        )
        .slice(input.offset, input.offset + input.limit);
    },
    countOrdersInWindow: async (input: {
      from: Date | null;
      to: Date | null;
      scope?: PaymentOrderReadScope;
    }) =>
      rows.filter(
        (row) =>
          matchesScope(row, input.scope) &&
          (!input.from || row.createdAt >= input.from) &&
          (!input.to || row.createdAt <= input.to),
      ).length,
    // BP07/#375: the anomaly read the record's 异常进度 hangs on — kind-filtered like the real
    // store's partial index, oldest first, one call for the whole page.
    listAnomalyEvents: async (orderIds: readonly string[]) =>
      anomalies
        .filter(
          (event) => event.kind === "anomaly" && orderIds.includes(event.orderId),
        )
        .sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        ),
  } as unknown as PaymentStore;
  return { calls, store };
}

/** One anomaly event row, spelled the way the store's own rows answer. */
function anomaly(
  over: Partial<PaymentOrderEventRecord> = {},
): PaymentOrderEventRecord {
  return {
    id: `pe-${Math.random().toString(36).slice(2, 10)}`,
    orderId: "po-aaaaaaaaaaaaaaaa",
    kind: "anomaly",
    code: "duplicate_paid",
    state: null,
    channelTransactionId: "2026100122002",
    amountCents: 19900,
    detail: "a second transaction landed on an already-paid order",
    createdAt: new Date("2026-10-01T00:06:00.000Z"),
    ...over,
  };
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

  test("a ceiling entry whose limit is null answers remaining null, never a floored zero", async () => {
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map([
        ["pro", [{ ...QUOTAS[0], limit: null, remaining: null }]],
      ]),
    });
    const answer = await statements.planUsage();
    expect(answer.quotas[0]?.remaining).toBeNull();
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
  test("a page below 1 clamps to the first page — a negative offset never reaches the store", async () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      order({ id: `po-${String(index).padStart(16, "0")}` }),
    );
    const { store } = fakeOrders(rows);
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map(),
      orders: store,
    });
    const page = await statements.invoices({ from: null, to: null, page: 0 });
    expect(page.pagination.currentPage).toBe(1);
    expect(page.invoices).toHaveLength(20);
  });

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

  test("historical paid orders keep their own stored periods when the current plan moved on", async () => {
    const { store } = fakeOrders([
      order({
        id: "po-august",
        createdAt: new Date("2026-08-15T00:01:00.000Z"),
        periodStart: new Date("2026-08-01T00:00:00.000Z"),
        periodEnd: new Date("2026-09-01T00:00:00.000Z"),
      }),
      order({
        id: "po-september",
        createdAt: new Date("2026-09-15T00:01:00.000Z"),
        periodStart: new Date("2026-09-01T00:00:00.000Z"),
        periodEnd: new Date("2026-10-01T00:00:00.000Z"),
      }),
    ]);
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map(),
      orders: store,
    });

    const page = await statements.invoices({ from: null, to: null, page: 1 });

    expect(page.invoices.map((invoice) => invoice.periodStart)).toEqual([
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    ]);
    expect(page.invoices.map((invoice) => invoice.periodEnd)).toEqual([
      "2026-09-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    ]);
  });

  test("expired and canceled orders do not expose a paid settlement time", async () => {
    const { store } = fakeOrders([
      order({
        id: "po-expired",
        status: "expired",
        activationState: "pending",
        channelTransactionId: null,
        paidAt: null,
        terminalAt: new Date("2026-09-01T00:05:00.000Z"),
      }),
      order({
        id: "po-canceled",
        status: "canceled",
        activationState: "pending",
        channelTransactionId: null,
        paidAt: null,
        terminalAt: new Date("2026-09-02T00:05:00.000Z"),
      }),
    ]);
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map(),
      orders: store,
    });

    const page = await statements.invoices({ from: null, to: null, page: 1 });
    const expiredInvoice = page.invoices.find(
      (invoice) => invoice.invoiceId === "po-expired",
    );
    const canceledInvoice = page.invoices.find(
      (invoice) => invoice.invoiceId === "po-canceled",
    );

    expect(expiredInvoice?.settledAt).toBeNull();
    expect(canceledInvoice?.settledAt).toBeNull();
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

  test("statement reads only expose orders created by the authenticated actor", async () => {
    const { store } = fakeOrders([
      order({
        id: "po-member",
        createdBy: MEMBER.id,
        ownerPayerRef: { kind: "personal" as const, id: MEMBER.id },
        createdAt: new Date("2026-10-02T00:01:00.000Z"),
      }),
      order({
        id: "po-other",
        createdBy: "user-other",
        ownerPayerRef: { kind: "personal" as const, id: "user-other" },
        createdAt: new Date("2026-10-01T00:01:00.000Z"),
      }),
    ]);
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map(),
      orders: store,
    });

    const page = await statements.invoices(
      { from: null, to: null, page: 1 },
      { actorPayerRef: { kind: "personal" as const, id: MEMBER.id } },
    );

    expect(page.invoices.map((invoice) => invoice.invoiceId)).toEqual([
      "po-member",
    ]);
    expect(await statements.invoice("po-member", { actorPayerRef: { kind: "personal" as const, id: MEMBER.id } })).toMatchObject(
      {
        invoiceId: "po-member",
      },
    );
    expect(
      await statements.invoice("po-other", { actorPayerRef: { kind: "personal" as const, id: MEMBER.id } }),
    ).toBeNull();
  });

  /*
   * BP07/#375 — the delivery progress the payment record owes its reader. 收款状态与交付状态
   * 独立: a paid order that has not delivered answers "processing" with the retained failure
   * reason and retry schedule (the 已付款，权益处理中 record), an applied one answers
   * "delivered", a deterministic conflict answers "needs_resolution" — and an order no money
   * landed on owes no delivery at all (null, never a disguised state).
   */
  test("a paid order answers its delivery progress; an unpaid one owes none (BP07 AC1)", async () => {
    const { store } = fakeOrders([
      order({
        id: "po-processing",
        status: "paid",
        activationState: "pending",
        activationFailureReason: null,
        activationNextRetryAt: new Date("2026-10-01T00:10:00.000Z"),
      }),
      order({
        id: "po-retrying",
        status: "paid",
        activationState: "failed",
        activationFailureReason: "grant_write_failed",
        activationNextRetryAt: new Date("2026-10-01T00:12:00.000Z"),
      }),
      order({ id: "po-delivered", status: "paid", activationState: "applied" }),
      order({
        id: "po-conflict",
        status: "paid",
        activationState: "needs_resolution",
        activationFailureReason: "duplicate_paid",
        activationNextRetryAt: null,
      }),
      order({
        id: "po-still-pending",
        status: "pending",
        activationState: "pending",
      }),
    ]);
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map(),
      orders: store,
    });
    const page = await statements.invoices({ from: null, to: null, page: 1 });
    const byId = new Map(page.invoices.map((row) => [row.invoiceId, row]));
    expect(byId.get("po-processing")?.fulfillment).toEqual({
      state: "processing",
      failureReason: null,
      nextRetryAt: "2026-10-01T00:10:00.000Z",
    });
    expect(byId.get("po-retrying")?.fulfillment).toEqual({
      state: "processing",
      failureReason: "grant_write_failed",
      nextRetryAt: "2026-10-01T00:12:00.000Z",
    });
    expect(byId.get("po-delivered")?.fulfillment).toEqual({
      state: "delivered",
      failureReason: null,
      nextRetryAt: null,
    });
    expect(byId.get("po-conflict")?.fulfillment).toEqual({
      state: "needs_resolution",
      failureReason: "duplicate_paid",
      nextRetryAt: null,
    });
    // No money landed: the absence is the answer — not "processing", never "delivered".
    expect(byId.get("po-still-pending")?.fulfillment).toBeNull();
  });

  test("the record labels the paying account's own kind (BP07 AC2)", async () => {
    const { store } = fakeOrders([
      order({ id: "po-personal" }),
      order({
        id: "po-company",
        ownerPayerRef: { kind: "company" as const, id: "tenant-a" },
      }),
    ]);
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map(),
      orders: store,
    });
    // An unscoped read (the operator's own list) sees both labels; the scoped reads below
    // split them — the label is carried, the scope decides who may read which.
    const page = await statements.invoices({ from: null, to: null, page: 1 });
    const byId = new Map(page.invoices.map((row) => [row.invoiceId, row]));
    expect(byId.get("po-personal")?.payerKind).toBe("personal");
    expect(byId.get("po-company")?.payerKind).toBe("company");
  });

  test("a company-owned order never answers a personal scope — the personal page shows no company money (BP07 AC2)", async () => {
    const { store } = fakeOrders([
      order({
        id: "po-mine",
        ownerPayerRef: { kind: "personal" as const, id: MEMBER.id },
      }),
      // Same id string, different kind: the exact collision the spec's unique-key rule exists
      // for — a personal read must not pick it up by string coincidence.
      order({
        id: "po-company-same-id",
        ownerPayerRef: { kind: "company" as const, id: MEMBER.id },
      }),
    ]);
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map(),
      orders: store,
    });
    const scope = { actorPayerRef: { kind: "personal" as const, id: MEMBER.id } };
    const page = await statements.invoices(
      { from: null, to: null, page: 1 },
      scope,
    );
    expect(page.invoices.map((row) => row.invoiceId)).toEqual(["po-mine"]);
    expect(
      await statements.invoice("po-company-same-id", scope),
    ).toBeNull();
  });

  /*
   * BP07/#375 — 重复收款和异常有明确进度: the recorded anomaly events ride their order's
   * record, oldest first, one batched read for the page; a paid FACT never lists as an anomaly
   * (the money state is the order row's own answer — listing it here would double-count it).
   */
  test("anomaly events ride the record oldest-first; paid facts never do (BP07 AC1)", async () => {
    const { store } = fakeOrders(
      [order({ id: "po-first" }), order({ id: "po-second" })],
      [
        anomaly({
          orderId: "po-first",
          code: "duplicate_paid",
          createdAt: new Date("2026-10-01T00:07:00.000Z"),
        }),
        anomaly({
          orderId: "po-first",
          code: "over_paid",
          createdAt: new Date("2026-10-01T00:06:00.000Z"),
        }),
        anomaly({ orderId: "po-second", code: "late_payment" }),
        // A paid fact is not an anomaly — the read must not hand it back.
        anomaly({ kind: "fact", code: "paid", state: "paid" }),
      ],
    );
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map(),
      orders: store,
    });
    const page = await statements.invoices({ from: null, to: null, page: 1 });
    const byId = new Map(page.invoices.map((row) => [row.invoiceId, row]));
    expect(
      byId.get("po-first")?.anomalies.map((event) => event.code),
    ).toEqual(["over_paid", "duplicate_paid"]);
    expect(byId.get("po-first")?.anomalies[0]).toMatchObject({
      amountCents: 19900,
      channelTransactionId: "2026100122002",
      occurredAt: "2026-10-01T00:06:00.000Z",
    });
    expect(byId.get("po-second")?.anomalies.map((e) => e.code)).toEqual([
      "late_payment",
    ]);
    // The detail answers the same progress the list does — one record, one story.
    const detail = await statements.invoice("po-first");
    expect(detail?.anomalies.map((event) => event.code)).toEqual([
      "over_paid",
      "duplicate_paid",
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
    const { store } = fakeOrders([
      order({
        createdBy: MEMBER.id,
        ownerPayerRef: { kind: "personal" as const, id: MEMBER.id },
      }),
    ]);
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

  /*
   * BP07/#375 — the wire carries what the page renders: the payer label, the delivery
   * progress (with its retained reason and retry schedule) and the anomaly events, exactly as
   * the statement read computed them. What the route adds is nothing — it is the no-drift
   * guarantee between the projection and the response the app types mirror.
   */
  test("the invoices route carries the payer label, delivery progress and anomalies (BP07 AC1)", async () => {
    const { store } = fakeOrders(
      [
        order({
          id: "po-paid-processing",
          createdBy: MEMBER.id,
          ownerPayerRef: { kind: "personal" as const, id: MEMBER.id },
          status: "paid",
          activationState: "failed",
          activationFailureReason: "provider_unreachable",
          activationNextRetryAt: new Date("2026-10-01T00:12:00.000Z"),
        }),
      ],
      [
        anomaly({
          orderId: "po-paid-processing",
          code: "duplicate_paid",
        }),
      ],
    );
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map(),
      orders: store,
    });
    const response = await app(statements, MEMBER).request(
      "/api/billing/invoices",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      invoices: {
        payerKind: string;
        fulfillment: {
          state: string;
          failureReason: string | null;
          nextRetryAt: string | null;
        } | null;
        anomalies: { code: string }[];
      }[];
    };
    expect(body.invoices[0]).toMatchObject({
      payerKind: "personal",
      fulfillment: {
        state: "processing",
        failureReason: "provider_unreachable",
        nextRetryAt: "2026-10-01T00:12:00.000Z",
      },
      anomalies: [{ code: "duplicate_paid" }],
    });
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

  test("bill list and detail return only the signed-in actor's orders", async () => {
    const { store } = fakeOrders([
      order({
        id: "po-member",
        createdBy: MEMBER.id,
        ownerPayerRef: { kind: "personal" as const, id: MEMBER.id },
        createdAt: new Date("2026-10-02T00:01:00.000Z"),
      }),
      order({
        id: "po-other",
        createdBy: "user-other",
        ownerPayerRef: { kind: "personal" as const, id: "user-other" },
        createdAt: new Date("2026-10-01T00:01:00.000Z"),
      }),
    ]);
    const statements = createBillingStatements({
      service: fakeService(ACTIVE, USAGE),
      quotas: new Map([["pro", QUOTAS]]),
      orders: store,
    });

    const list = await app(statements, MEMBER).request("/api/billing/invoices");
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { invoices: Array<{ invoiceId: string }> }).invoices.map(
        (invoice) => invoice.invoiceId,
      ),
    ).toEqual(["po-member"]);

    const own = await app(statements, MEMBER).request(
      "/api/billing/invoices/po-member",
    );
    expect(own.status).toBe(200);

    const other = await app(statements, MEMBER).request(
      "/api/billing/invoices/po-other",
    );
    expect(other.status).toBe(404);
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
