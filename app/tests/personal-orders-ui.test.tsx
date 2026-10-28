import "./preload";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { BillingInvoicePage } from "@/lib/billing/invoices";
import { money } from "@/lib/billing/format";
import { orderIdOfPlanGrant } from "@/lib/billing/trace";
import i18n from "@/lib/i18n";
import { settleReactWork } from "./settle-react-work";

/*
 * Bifrost 10.6 (#295): the personal orders & grants traceability page.
 *
 * What the ticket owes — per its acceptance criteria — is exactly what this file pins:
 *
 * - the signed-in reader sees their OWN orders (with money status), subscription, and every
 *   credit grant with its source and expiry (AC14, traceability);
 * - the page never sends an account identifier of any kind — the account is decided
 *   server-side from the session (10.1 scope + 02.4 answer 400 to any request naming one),
 *   so the client must not even ask;
 * - grant source and expiry render exactly what the server's 02.6 contract said — the page
 *   derives nothing about a grant's life;
 * - an order's money state change reaches the screen on refresh (AC: 订单状态变化在页面正确反映).
 *
 * The network is a stub serving the contracts the real server answers (the invoices page's
 * BillingInvoicePage, the credits summary's PersonalCreditBalance); the route contracts
 * themselves are pinned server-side in server/tests (billing routes + 10.1–10.5 suites).
 */

/** Two orders: one still waiting for money, one settled — the two states the table must tell apart. */
const PENDING_INVOICES: BillingInvoicePage = {
  invoices: [
    {
      invoiceId: "po_123",
      planCode: "plan_pro",
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z",
      amountCents: 19900,
      currency: "CNY",
      status: "pending",
      method: "alipay",
      issuedAt: "2026-10-01T00:00:00.000Z",
      settledAt: null,
      channelTransactionId: null,
      payerKind: "personal",
      fulfillment: null,
      anomalies: [],
    },
    {
      invoiceId: "po_100",
      planCode: "plan_basic",
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      amountCents: 9900,
      currency: "CNY",
      status: "paid",
      method: "wechat",
      issuedAt: "2026-09-01T00:00:00.000Z",
      settledAt: "2026-09-01T00:01:00.000Z",
      channelTransactionId: "ch_1",
      payerKind: "personal",
      // 已收款且已交付：老单是「已交付」的对照面。
      fulfillment: {
        state: "delivered",
        failureReason: null,
        nextRetryAt: null,
      },
      anomalies: [],
    },
  ],
  pagination: { totalCount: 2, totalPages: 1, currentPage: 1, nextPage: null },
};

/** The same two orders after the pending one's money landed — what refresh must reach the screen. */
const PAID_INVOICES: BillingInvoicePage = {
  ...PENDING_INVOICES,
  invoices: PENDING_INVOICES.invoices.map((invoice) =>
    invoice.invoiceId === "po_123"
      ? {
          ...invoice,
          status: "paid" as const,
          settledAt: "2026-10-02T08:00:00.000Z",
          channelTransactionId: "ch_2",
          // 钱到了、权益还没到：刷新后这行必须说「已付款，权益处理中」（BP07/#375）。
          fulfillment: {
            state: "processing" as const,
            failureReason: null,
            nextRetryAt: null,
          },
        }
      : invoice,
  ),
};

/**
 * The 02.6 summary, as the server builds it for a personal account: a plan grant whose reason
 * carries its funding order (the payout sentence server/src/index.ts writes), a check-in reward,
 * a lapsed campaign grant, and a plan grant whose reason is OFF the payout's exact shape —
 * which must trace to nothing, never to a guessed order id.
 */
const BALANCE = {
  accountType: "personal" as const,
  account: { status: "active" as const, quarantineReason: null },
  available: 88,
  consumed: 12,
  expired: 0,
  held: 0,
  grants: [
    {
      id: "cg-plan",
      source: "plan" as const,
      reason: "plan allowance · plan_pro · order po_123",
      total: 100,
      used: 12,
      remaining: 88,
      grantedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-11-01T00:00:00.000Z",
      status: "active" as const,
      expiringSoon: false,
    },
    {
      id: "cg-signin",
      source: "signin" as const,
      reason: "每日签到奖励",
      total: 1,
      used: 0,
      remaining: 1,
      grantedAt: "2026-10-17T00:00:00.000Z",
      expiresAt: "2027-10-17T00:00:00.000Z",
      status: "active" as const,
      expiringSoon: true,
    },
    {
      id: "cg-promo",
      source: "promo" as const,
      reason: "运营活动补发",
      total: 5,
      used: 5,
      remaining: 0,
      grantedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-09-15T00:00:00.000Z",
      status: "expired" as const,
      expiringSoon: false,
    },
    {
      id: "cg-orphan",
      source: "plan" as const,
      reason: "管理员调整",
      total: 3,
      used: 0,
      remaining: 3,
      grantedAt: "2026-10-10T00:00:00.000Z",
      expiresAt: "2026-11-10T00:00:00.000Z",
      status: "active" as const,
      expiringSoon: false,
    },
  ],
  pendingSettlement: {
    enabled: false as const,
    available: 0,
    consumed: 0,
    expired: 0,
  },
};

const ENTITLEMENTS = {
  active: true,
  planCode: "plan_pro",
  codes: [],
  subscription: {
    status: "active",
    currentPeriodStart: "2026-10-01T00:00:00.000Z",
    currentPeriodEnd: "2026-11-01T00:00:00.000Z",
  },
};

type Stub = { status: number; body: unknown } | undefined;

/** The invoices cell the status-change test flips between the two pages above. */
const state: { invoices: BillingInvoicePage } = { invoices: PENDING_INVOICES };

/** Every URL the page asked for, for the no-account-identifier assertion. */
let requestedUrls: string[] = [];

function installFetchStub(
  overrides: {
    invoices?: Stub;
    summary?: Stub;
    entitlements?: Stub;
    catalog?: Stub;
  } = {},
) {
  requestedUrls = [];
  state.invoices = PENDING_INVOICES;
  globalThis.fetch = (async (
    input: string | URL | Request,
  ): Promise<Response> => {
    const url = String(input);
    requestedUrls.push(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.startsWith("/api/billing/invoices")) {
      const o = overrides.invoices;
      if (o) return json(o.body, o.status);
      return json(state.invoices);
    }
    if (url.startsWith("/api/billing/credits/summary")) {
      const o = overrides.summary;
      if (o) return json(o.body, o.status);
      return json(BALANCE);
    }
    if (url.startsWith("/api/billing/entitlements")) {
      const o = overrides.entitlements;
      if (o) return json(o.body, o.status);
      return json(ENTITLEMENTS);
    }
    if (url.startsWith("/api/billing/catalog")) {
      const o = overrides.catalog;
      if (o) return json(o.body, o.status);
      return json({});
    }
    // Nothing else has any business being asked on this page.
    return json({ error: "not stubbed" }, 404);
  }) as typeof fetch;
}

const { OrdersGrantsView } = await import("@/components/billing/orders-view");

function renderView({ page = 1 }: { page?: number } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OrdersGrantsView page={page} onPage={() => {}} scope={PERSONAL_SCOPE} />
    </QueryClientProvider>,
  );
}

/*
 * The paint flush this harness needs under the e2e native runner: React 19 + RTL + happy-dom
 * land react-query results without repainting the mounted tree (the hbc4-diagnosed freeze —
 * memory preview-tab-e2e-render-freeze). An `act` wrapping a REAL async gap lets the stub's
 * fetch resolution ride a macrotask inside act's batching, and the tree paints. Every render
 * test here calls it once after mount, before its first assertion.
 */
async function flushPaint() {
  // Two rounds: the first lands the reads' promises, the second the tree they repaint —
  // a single round left later mounts on the skeleton in this runner.
  for (let round = 0; round < 2; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
  }
}

beforeAll(async () => {
  GlobalRegistrator.register();
  await i18n.changeLanguage("zh-CN");
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  await i18n.changeLanguage("en");
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;

/*
 * The personal context's scope (MT097): the billing views now read through the scoped seam, so
 * the harness hands them the no-selection scope a person without a company selection holds —
 * the reads still hit the same /api/billing paths the stubs answer.
 */
const scopedCachePrefixMod = await import(
  "@/lib/enterprise/tenant/scoped-cache"
);
const PERSONAL_SCOPE = {
  status: "open" as const,
  userId: "ui-test-user",
  selection: null,
  generation: 1,
  prefix: scopedCachePrefixMod.scopedCachePrefix("ui-test-user", null),
  key: "ui-test-user:personal",
};

test("orderIdOfPlanGrant traces a plan grant to its funding order", () => {
  expect(
    orderIdOfPlanGrant({
      source: "plan",
      reason: "plan allowance · plan_pro · order po_123",
    }),
  ).toBe("po_123");
});

test("orderIdOfPlanGrant refuses to guess for non-plan or off-format reasons", () => {
  expect(
    orderIdOfPlanGrant({ source: "signin", reason: "coupon for order po_x" }),
  ).toBeNull();
  expect(
    orderIdOfPlanGrant({ source: "promo", reason: "运营活动补发 order po_x" }),
  ).toBeNull();
  expect(
    orderIdOfPlanGrant({ source: "plan", reason: "管理员调整" }),
  ).toBeNull();
  expect(orderIdOfPlanGrant({ source: "plan", reason: null })).toBeNull();
});

test("订单与积分追溯页渲染本人订单、订阅与 Grant（状态、来源、有效期、追溯到订单）", async () => {
  installFetchStub({});
  const view = renderView();
  await flushPaint();

  // The grants read landed — the page's slowest answer is in.
  await view.findByTestId("credit-grant-cg-plan");

  // Both orders render, each with its money state — the two rows the fixture holds.
  const ordersTable = view.getByTestId("orders-table");
  expect(within(ordersTable).getByText("po_123")).toBeTruthy();
  expect(within(ordersTable).getByText("po_100")).toBeTruthy();
  expect(within(ordersTable).getByText("等待支付")).toBeTruthy();
  expect(within(ordersTable).getByText("已支付")).toBeTruthy();
  // The money is said as money, not cents.
  expect(ordersTable.textContent).toContain("199");
  expect(ordersTable.textContent).toContain("99");
  // The subscription face names the plan the entitlements read answered.
  expect(view.container.textContent).toContain("plan_pro");

  // Every grant row carries its source, in the server's own source word.
  const planRow = view.getByTestId("credit-grant-cg-plan");
  expect(within(planRow).getByText("套餐")).toBeTruthy();
  expect(
    within(view.getByTestId("credit-grant-cg-signin")).getByText("签到奖励"),
  ).toBeTruthy();
  expect(
    within(view.getByTestId("credit-grant-cg-promo")).getByText(
      "活动/管理员发放",
    ),
  ).toBeTruthy();

  // The plan grant traces to its funding order, whose money state rides along…
  const trace = view.getByTestId("trace-cg-plan");
  expect(trace.textContent).toContain("po_123");
  expect(trace.textContent).toContain("等待支付");
  // …and the row carries the expiry the server said, not one the page derived.
  expect(planRow.textContent).toContain("到期时间");

  // An off-format plan grant traces to nothing: an absence note, never a guessed order id.
  const orphanRow = view.getByTestId("credit-grant-cg-orphan");
  expect(view.getByTestId("trace-no-order-cg-orphan")).toBeTruthy();
  expect(orphanRow.textContent).not.toMatch(/po_\w+/);

  // Grants that are granting ACTIONS (check-in, campaign) name no order at all.
  expect(view.queryByTestId("trace-cg-signin")).toBeNull();
  expect(view.queryByTestId("trace-cg-promo")).toBeNull();

  // No untranslated template leaked through a missing interpolation.
  expect(view.container.textContent).not.toContain("{{");
});

test("页面不携带任何账户标识，仅请求本人作用域读取", async () => {
  installFetchStub({});
  const view = renderView();
  await flushPaint();
  await view.findByTestId("credit-grant-cg-plan");
  // Let every read's request land before auditing the URLs the page asked for.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const allowed = [
    "/api/billing/invoices",
    "/api/billing/credits/summary",
    "/api/billing/entitlements",
    "/api/billing/catalog",
  ];
  for (const url of requestedUrls) {
    expect(
      allowed.some((prefix) => url.startsWith(prefix)),
      `unexpected request: ${url}`,
    ).toBe(true);
  }
  const identity =
    /userId=|externalCustomerId=|payerId=|accountId=|companyId=|tenantId=/i;
  const offenders = requestedUrls.filter((url) => identity.test(url));
  expect(offenders, JSON.stringify(offenders)).toEqual([]);
  // And the page did ask for its own reads by path alone — no account naming anywhere.
  expect(
    requestedUrls.some((url) => url.startsWith("/api/billing/invoices")),
  ).toBe(true);
  expect(
    requestedUrls.some((url) => url.startsWith("/api/billing/credits/summary")),
  ).toBe(true);
});

test("订单读取失败时显示错误与重试，不渲染空表", async () => {
  installFetchStub({
    invoices: { status: 503, body: { error: "订单服务暂不可用" } },
  });
  const view = renderView();
  await flushPaint();

  const ordersSection = await view.findByTestId("orders-section");
  // The server's sentence is shown with a way back in…
  expect(within(ordersSection).getByRole("alert").textContent).toContain(
    "订单服务暂不可用",
  );
  expect(
    within(ordersSection).getByRole("button", { name: "重试" }),
  ).toBeTruthy();
  // …and no empty table dressed up as "no orders": neither rows nor the empty state.
  expect(view.queryByTestId("orders-table")).toBeNull();
  expect(within(ordersSection).queryByText("暂无订单")).toBeNull();
  expect(within(ordersSection).queryByText("po_123")).toBeNull();
});

test("计费未启用的部署显示不可用空态", async () => {
  const missing = { status: 404, body: { error: "nope" } } as const;
  installFetchStub({
    invoices: missing,
    summary: missing,
    entitlements: missing,
    catalog: missing,
  });
  const view = renderView();
  await flushPaint();

  await view.findByText("此部署未启用计费");
  // The deployment's fact, said once — no table, no grant rows, no crash.
  expect(view.queryByTestId("orders-table")).toBeNull();
  expect(view.queryByTestId("credit-grant-cg-plan")).toBeNull();
});

test("Grant 过期状态与服务器一致", async () => {
  installFetchStub({});
  const view = renderView();
  await flushPaint();

  await view.findByTestId("credit-grant-cg-promo");
  // The statuses ARE the server's answer: the lapsed grant reads 已过期, the live one 使用中 —
  // the page recomputed neither.
  expect(
    within(view.getByTestId("credit-grant-cg-promo")).getByText("已过期"),
  ).toBeTruthy();
  expect(
    within(view.getByTestId("credit-grant-cg-plan")).getByText("使用中"),
  ).toBeTruthy();
  // The server's expiringSoon cue rides the row it was said for.
  expect(
    within(view.getByTestId("credit-grant-cg-signin")).getByText(
      "24小时内过期",
    ),
  ).toBeTruthy();
  // And each row names the expiry instant the server gave it.
  expect(view.getByTestId("credit-grant-cg-promo").textContent).toContain(
    "到期时间",
  );
  expect(view.getByTestId("credit-grant-cg-signin").textContent).toContain(
    "到期时间",
  );
});

test("订单状态变化在页面正确反映：pending → paid 经刷新后更新", async () => {
  installFetchStub({});
  const view = renderView();
  await flushPaint();

  await view.findByTestId("orders-table", {}, { timeout: 15000 });
  const pendingRow = within(view.getByTestId("orders-table"))
    .getByText("po_123")
    .closest("tr");
  expect(pendingRow?.textContent).toContain("等待支付");

  // The webhook lands, the order settles — then the reader hits refresh.
  state.invoices = PAID_INVOICES;
  fireEvent.click(view.getByRole("button", { name: "刷新" }));
  await flushPaint();

  await waitFor(() => {
    const row = within(view.getByTestId("orders-table"))
      .getByText("po_123")
      .closest("tr");
    expect(row?.textContent).toContain("已支付");
    expect(row?.textContent).not.toContain("等待支付");
  });
});

/*
 * BP07（#375）AC1/AC3 —— 支付记录的交付进度、异常进度与用语。
 *
 * 已收款未交付是独立于支付状态的事实：钱到而权益未到的行必须说「已付款，权益处理中」，
 * 确定性冲突说「待人工处置」并把重复收款等异常行带出来（×N 计次），已交付说「已交付」；
 * 未收款的行不欠交付（dash）。金额只按订单自身快照币种渲染；本地订单视图通篇不称
 * 「发票」——它是支付记录，不是税务凭证。
 */
test("已收款未交付显示「已付款，权益处理中」，异常与处置进度明确（BP07）", async () => {
  const INVOICES: BillingInvoicePage = {
    ...PENDING_INVOICES,
    invoices: [
      {
        ...PENDING_INVOICES.invoices[0]!,
        invoiceId: "po_paid_processing",
        status: "paid",
        settledAt: "2026-10-02T08:00:00.000Z",
        fulfillment: {
          state: "processing",
          failureReason: "grant_write_failed",
          nextRetryAt: "2026-10-02T08:05:00.000Z",
        },
      },
      {
        ...PENDING_INVOICES.invoices[0]!,
        invoiceId: "po_needs_resolution",
        status: "paid",
        settledAt: "2026-10-02T09:00:00.000Z",
        fulfillment: {
          state: "needs_resolution",
          failureReason: "duplicate_paid",
          nextRetryAt: null,
        },
        // 同一异常词记录两次：一行 + ×2，不是两行同句。
        anomalies: [
          {
            code: "duplicate_paid",
            detail: "second transaction on a covered period",
            channelTransactionId: "ch_d1",
            amountCents: 19900,
            occurredAt: "2026-10-02T09:00:00.000Z",
          },
          {
            code: "duplicate_paid",
            detail: "second transaction on a covered period",
            channelTransactionId: "ch_d2",
            amountCents: 19900,
            occurredAt: "2026-10-02T09:01:00.000Z",
          },
          {
            code: "late_payment",
            detail: "paid outside the fulfilment window",
            channelTransactionId: "ch_l1",
            amountCents: 19900,
            occurredAt: "2026-10-02T09:02:00.000Z",
          },
        ],
      },
    ],
  };
  installFetchStub({ invoices: { status: 200, body: INVOICES } });
  const view = renderView();
  // 已知环境故障（hbc4 诊断）：e2e 原生层挂载后 react-query 结果不 paint，一次 act
  // flush 即可（详见 memory preview-tab-e2e-render-freeze）。
  await flushPaint();
  await view.findByTestId("orders-table", {}, { timeout: 15000 });

  const processingRow = within(view.getByTestId("orders-table"))
    .getByText("po_paid_processing")
    .closest("tr");
  expect(
    within(processingRow as HTMLElement).getByTestId(
      "fulfillment-po_paid_processing-processing",
    ).textContent,
  ).toBe("已付款，权益处理中");
  // 保留的失败原因与下次处理时间是「在处理」的证据，不是内部码原文照搬（经词表翻译）。
  expect(processingRow?.textContent).toContain("积分发放失败，自动重试");
  expect(processingRow?.textContent).toContain("下次处理");

  const conflictRow = within(view.getByTestId("orders-table"))
    .getByText("po_needs_resolution")
    .closest("tr");
  expect(
    within(conflictRow as HTMLElement).getByTestId(
      "fulfillment-po_needs_resolution-needs_resolution",
    ).textContent,
  ).toBe("待人工处置");
  expect(
    within(conflictRow as HTMLElement).getByTestId(
      "anomaly-po_needs_resolution-duplicate_paid",
    ).textContent,
  ).toBe("权益周期已被覆盖的收款 ×2");
  expect(
    within(conflictRow as HTMLElement).getByTestId(
      "anomaly-po_needs_resolution-late_payment",
    ).textContent,
  ).toBe("超时到账的收款");
});

test("未收款的行不欠交付；已交付的行说「已交付」（BP07）", async () => {
  installFetchStub();
  const view = renderView();
  await flushPaint();
  await view.findByTestId("orders-table", {}, { timeout: 15000 });
  const pendingRow = within(view.getByTestId("orders-table"))
    .getByText("po_123")
    .closest("tr");
  // 无收款即无交付：金额照旧、状态照旧，交付列是「–」，不是任何进度词。
  expect(pendingRow?.querySelector('[data-testid^="fulfillment-"]')).toBeNull();
  const deliveredRow = within(view.getByTestId("orders-table"))
    .getByText("po_100")
    .closest("tr");
  expect(
    within(deliveredRow as HTMLElement).getByTestId(
      "fulfillment-po_100-delivered",
    ).textContent,
  ).toBe("已交付");
});

test("金额按订单自身快照币种渲染；本地订单视图不称「发票」（BP07 AC3）", async () => {
  installFetchStub();
  const view = renderView();
  await flushPaint();
  await view.findByTestId("orders-table", {}, { timeout: 15000 });
  // 订单快照币种是唯一金额来源：CNY 订单按 CNY 渲染（money() 的词，不猜符号）。
  const pendingRow = within(view.getByTestId("orders-table"))
    .getByText("po_123")
    .closest("tr");
  expect(pendingRow?.textContent).toContain(money(19900, "CNY"));
  // 本地订单视图是支付记录：整页（含文案）不出现「发票」二字。
  expect(view.container.textContent).not.toContain("发票");
});
