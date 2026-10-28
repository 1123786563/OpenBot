import "../preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { act } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { OrdersGrantsView } from "../../src/components/billing/orders-view";
import { scopedCreditsSummaryQueryOptions } from "../../src/lib/billing/scoped";
import {
  CompanyFinanceRequiredError,
  type CompanyBooksAnswer,
  companyBooksQueryOptions,
} from "../../src/lib/enterprise/tenant/company-admin";
import {
  type ScopeSelection,
  selectWorkspaceScope,
  storeSelection,
} from "../../src/lib/enterprise/tenant/selection";
import {
  scopedCachePrefix,
  useScopedCache,
} from "../../src/lib/enterprise/tenant/scoped-cache";

/**
 * MT097 / Issue #140: the billing surfaces bind to the selection. The orders/usage pages read
 * through the scoped billing factories (the real views), and the company books read behind the
 * finance reader's grant.
 *
 *   AC1 the orders page's reads carry the pair and name no account identifier of any kind —
 *      the account is the session's own payer server-side; other people's orders are not in the
 *      answer the page renders (the server's own scope condition, pinned here as the page
 *      rendering exactly what the scoped read returned).
 *   AC2 the company books answer for an authorized finance reader, with the team usage rows
 *      and the company total reconciling in the answer; the grant's absence is the ONE typed
 *      refusal state the page renders.
 *   AC3 the recent usage lines are the company's own: the client asks once, without any
 *      customer selector, and renders exactly the rows the server returned — a personal
 *      direct charge never appears because the server never sends it.
 *   AC4 a switch drops the old scope's amounts wholesale: the old key is gone, the new scope
 *      refetches, and the view shows the new scope's numbers with nothing left over.
 */

const USER = "user-1";
const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };
const GLOBEX: ScopeSelection = {
  tenantId: "globex",
  workspaceId: "globex-ops",
};

const OWN_INVOICES_PAGE = {
  invoices: [
    {
      invoiceId: "po_acme_1",
      planCode: "plan_pro",
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z",
      amountCents: 19900,
      currency: "CNY",
      status: "paid",
      method: "alipay",
      issuedAt: "2026-10-01T00:00:00.000Z",
      settledAt: "2026-10-02T00:00:00.000Z",
      channelTransactionId: null,
    },
  ],
  pagination: { totalCount: 1, totalPages: 1, currentPage: 1, nextPage: null },
};

const OWN_SUMMARY = {
  accountType: "personal",
  available: 500,
  consumed: 300,
  expired: 0,
  held: 40,
  grants: [],
  pendingSettlement: { enabled: false, reason: null },
};

const BOOKS_ACME: CompanyBooksAnswer = {
  books: {
    tenantId: "acme",
    authorization: {
      principalId: "prin-1",
      grantedBy: "prin-owner",
      grantedAt: "2026-10-01T00:00:00.000Z",
    },
    customer: {
      externalCustomerId: "cus_acme",
      boundAt: "2026-10-01T00:00:00.000Z",
    },
    account: { externalCustomerId: "cus_acme", status: "active" },
    balanceUnits: 1000,
    usage: {
      // The two projections reconcile: the team rows sum to the company total.
      companyTotal: { heldUnits: 40, chargedUnits: 300 },
      byTeam: [
        { workspaceId: "acme-finance", heldUnits: 30, chargedUnits: 200 },
        { workspaceId: "acme-ops", heldUnits: 10, chargedUnits: 100 },
      ],
      byUser: [{ principalId: "prin-2", heldUnits: 40, chargedUnits: 300 }],
    },
  },
  // Company rows only: a personal direct charge (personal customer) is not here — the
  // server's own projection excludes it, and this side renders what arrived.
  recentUsage: [
    {
      eventId: "u-1",
      source: "llm",
      model: "model-x",
      workspaceId: "acme-finance",
      inputTokens: 120,
      outputTokens: 80,
      reservationId: "res-1",
      occurredAt: "2026-10-21T09:00:00.000Z",
    },
  ],
};

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());
afterEach(cleanup);

const originalFetch = global.fetch;

type Asked = { input: string; init: RequestInit | undefined };

let asked: Asked[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The billing entrance's answers per scope: acme answers its own books and its own summary,
 * globex answers its own (different numbers — the switch must show them, not acme's), and a
 * finance-refused switch lets the books read answer the typed 403.
 */
function serve(
  options: {
    booksStatus?: number;
    /** Overrides the invoices page — the MT141 gap pin sends both anomaly shapes at once. */
    invoices?: typeof OWN_INVOICES_PAGE;
  } = {},
): void {
  asked = [];
  global.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = String(input);
    const tenant = headerOf(init, "x-openbot-tenant");
    asked.push({ input: path, init });
    if (path === "/api/me") return jsonResponse(200, { user: { id: USER } });
    if (path.includes("/admin/billing/company-books")) {
      if (options.booksStatus !== undefined) {
        return jsonResponse(options.booksStatus, {
          error: {
            code: "COMPANY_FINANCE_REQUIRED",
            message: "refused",
          },
        });
      }
      if (tenant === "globex") {
        return jsonResponse(200, {
          books: {
            ...BOOKS_ACME.books,
            tenantId: "globex",
            balanceUnits: 77,
            usage: {
              companyTotal: { heldUnits: 0, chargedUnits: 77 },
              byTeam: [
                { workspaceId: "globex-ops", heldUnits: 0, chargedUnits: 77 },
              ],
              byUser: [],
            },
          },
          recentUsage: [],
        } satisfies CompanyBooksAnswer);
      }
      return jsonResponse(200, BOOKS_ACME);
    }
    if (path.startsWith("/api/billing/invoices")) {
      return jsonResponse(200, options.invoices ?? OWN_INVOICES_PAGE);
    }
    if (path.startsWith("/api/billing/credits/summary")) {
      return jsonResponse(
        200,
        tenant === "globex" ? { ...OWN_SUMMARY, available: 77 } : OWN_SUMMARY,
      );
    }
    if (path.startsWith("/api/billing/entitlements")) {
      return jsonResponse(200, { active: false });
    }
    if (path === "/api/billing/credits/grants") {
      return jsonResponse(200, { grants: [] });
    }
    if (path === "/api/billing/credits/consumption") {
      return jsonResponse(200, {
        entries: [],
        pagination: { totalCount: 0, pageCount: 1, page: 1 },
      });
    }
    if (path === "/api/billing/catalog") {
      return jsonResponse(200, {});
    }
    return jsonResponse(200, {});
  }) as unknown as typeof fetch;
}

function headerOf(
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  const headers = init?.headers;
  if (headers === undefined || headers === null) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return (headers as Record<string, string>)[name];
}

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function draw(queryClient: QueryClient, node: React.ReactNode) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => node }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

function openScope(queryClient: QueryClient, selection: ScopeSelection): void {
  storeSelection(USER, selection);
  selectWorkspaceScope(queryClient, USER, null, selection);
}

/** The company finance view's read, exactly as the billing page calls it. */
function BooksProbe() {
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const books = useQuery(companyBooksQueryOptions(queryClient, scope));
  if (books.error instanceof CompanyFinanceRequiredError) {
    return <span data-testid="books-state">refused</span>;
  }
  if (books.data === undefined) {
    return <span data-testid="books-state">pending</span>;
  }
  const { usage, balanceUnits, tenantId } = books.data.books;
  return (
    <span data-testid="books-state">
      {[
        tenantId,
        balanceUnits,
        usage.companyTotal.chargedUnits,
        usage.byTeam
          .map((row) => `${row.workspaceId}:${row.chargedUnits}`)
          .join("+"),
        books.data.recentUsage.map((line) => line.eventId).join(","),
      ].join("/")}
    </span>
  );
}

/** The usage page's balance read, through the scoped factory the page now uses. */
function SummaryProbe() {
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const summary = useQuery(
    scopedCreditsSummaryQueryOptions(queryClient, scope),
  );
  return (
    <span data-testid="summary-amount">
      {summary.data ? summary.data.available : "pending"}
    </span>
  );
}

describe("MT097 billing surfaces bind to the selection (Issue #140)", () => {
  test("AC1: the orders page's reads carry the pair and name no account identifier", async () => {
    serve();
    const queryClient = freshClient();
    openScope(queryClient, ACME);
    const view = draw(
      queryClient,
      <OrdersGrantsView
        page={1}
        onPage={() => {}}
        scope={
          {
            status: "open",
            userId: USER,
            selection: ACME,
            generation: 1,
            prefix: scopedCachePrefix(USER, ACME),
            key: "k",
          } as never
        }
      />,
    );
    await waitFor(() => {
      expect(view.getByText("po_acme_1")).toBeTruthy();
    });
    const invoiceRead = asked.find((entry) =>
      entry.input.startsWith("/api/billing/invoices"),
    );
    expect(invoiceRead).toBeDefined();
    expect(headerOf(invoiceRead?.init, "x-openbot-tenant")).toBe("acme");
    // No account identifier of any kind: the read is the path and the page number, nothing else.
    expect(invoiceRead?.input).toBe("/api/billing/invoices?page=1");
    // The read files under the scope's own prefix — the page's amounts are the scope's.
    expect(
      queryClient.getQueryData([
        ...scopedCachePrefix(USER, ACME),
        "billing",
        "invoices",
        "list",
        "",
        "",
        1,
      ]),
    ).toBeDefined();
  });

  test("AC2: the company books answer for the finance reader, team usage reconciling with the total", async () => {
    serve();
    const queryClient = freshClient();
    openScope(queryClient, ACME);
    const view = draw(queryClient, <BooksProbe />);
    await waitFor(() => {
      expect(view.getByTestId("books-state").textContent).toBe(
        "acme/1000/300/acme-finance:200+acme-ops:100/u-1",
      );
    });
    const read = asked.find((entry) =>
      entry.input.endsWith("/admin/billing/company-books"),
    );
    expect(headerOf(read?.init, "x-openbot-tenant")).toBe("acme");
    // The answer itself reconciles: the team rows sum to the company total.
    const byTeamCharged = BOOKS_ACME.books.usage.byTeam.reduce(
      (sum, row) => sum + row.chargedUnits,
      0,
    );
    expect(byTeamCharged).toBe(
      BOOKS_ACME.books.usage.companyTotal.chargedUnits,
    );
  });

  test("AC2: without the finance grant the books render the ONE typed refusal state", async () => {
    serve({ booksStatus: 403 });
    const queryClient = freshClient();
    openScope(queryClient, ACME);
    const view = draw(queryClient, <BooksProbe />);
    await waitFor(() => {
      expect(view.getByTestId("books-state").textContent).toBe("refused");
    });
  });

  test("AC3: the recent usage lines render exactly the server's company rows — no personal direct charge appears", async () => {
    serve();
    const queryClient = freshClient();
    openScope(queryClient, ACME);
    const view = draw(queryClient, <BooksProbe />);
    await waitFor(() => {
      expect(view.getByTestId("books-state").textContent).toContain("u-1");
    });
    // The client asked once, without any customer selector of its own — the company filter
    // is the server's projection, not a query this side built.
    const read = asked.find((entry) =>
      entry.input.endsWith("/admin/billing/company-books"),
    );
    expect(read?.input).toBe(
      "/api/enterprise/workspace-scope/admin/billing/company-books",
    );
    // And the rendered evidence rows are exactly the answer's rows — one company row,
    // no personal row rendered under any name the answer did not carry.
    expect(view.getByTestId("books-state").textContent).not.toContain(
      "personal",
    );
  });

  test("AC4: a switch drops the old scope's amounts wholesale and the new scope's numbers answer", async () => {
    serve();
    const queryClient = freshClient();
    openScope(queryClient, ACME);
    const view = draw(queryClient, <SummaryProbe />);
    await waitFor(() => {
      expect(view.getByTestId("summary-amount").textContent).toBe("500");
    });
    const acmeKey = [
      ...scopedCachePrefix(USER, ACME),
      "billing",
      "credits",
      "summary",
    ];

    // The switch, exactly as the selection page performs it.
    storeSelection(USER, GLOBEX);
    act(() => {
      selectWorkspaceScope(queryClient, USER, ACME, GLOBEX);
    });
    cleanup();
    const after = draw(queryClient, <SummaryProbe />);
    await waitFor(() => {
      expect(after.getByTestId("summary-amount").textContent).toBe("77");
    });

    // The old scope's amount is gone from the cache — no residual amount survives the switch.
    expect(queryClient.getQueryData(acmeKey)).toBeUndefined();
    const globexKey = [
      ...scopedCachePrefix(USER, GLOBEX),
      "billing",
      "credits",
      "summary",
    ];
    expect(queryClient.getQueryData(globexKey)).toBeDefined();
  });

  test("AC4: the books view answers the new scope after the switch too", async () => {
    serve();
    const queryClient = freshClient();
    openScope(queryClient, ACME);
    const view = draw(queryClient, <BooksProbe />);
    await waitFor(() => {
      expect(view.getByTestId("books-state").textContent).toContain("acme");
    });

    storeSelection(USER, GLOBEX);
    act(() => {
      selectWorkspaceScope(queryClient, USER, ACME, GLOBEX);
    });
    cleanup();
    const after = draw(queryClient, <BooksProbe />);
    await waitFor(() => {
      expect(after.getByTestId("books-state").textContent).toContain("globex");
      expect(after.getByTestId("books-state").textContent).toContain("77");
    });
    // The acme books entry is gone with the switch.
    expect(
      queryClient.getQueryData([
        ...scopedCachePrefix(USER, ACME),
        "company-admin-books",
      ]),
    ).toBeUndefined();
  });

  // MT141 / Issue #184 — the explicit pin for the gap MT139 fixed in flight: the server may
  // omit `anomalies` entirely (statements.ts: absent = no anomalies recorded, never an
  // error), and when present the codes land as their own lines. Before the fix the absent
  // field crashed the order row outright; this case rides the real view + real
  // anomalyLines so the contract cannot regress quietly.
  test("MT141 pin: an invoice without the anomalies field renders, one with anomalies lists its codes", async () => {
    serve({
      invoices: {
        invoices: [
          // Shape 1: the field is absent — the contract's own words: "no anomalies recorded".
          { ...OWN_INVOICES_PAGE.invoices[0], invoiceId: "po_absent" },
          // Shape 2: the field is present with one anomaly code.
          {
            ...OWN_INVOICES_PAGE.invoices[0],
            invoiceId: "po_amount_mismatch",
            anomalies: [
              {
                code: "amount_mismatch",
                detail: "paid 19900, expected 20000",
                channelTransactionId: "tx-1",
                amountCents: 19900,
                occurredAt: "2026-10-02T00:00:00.000Z",
              },
            ],
          },
        ],
        pagination: {
          totalCount: 2,
          totalPages: 1,
          currentPage: 1,
          nextPage: null,
        },
      },
    });
    const queryClient = freshClient();
    openScope(queryClient, ACME);
    const view = draw(
      queryClient,
      <OrdersGrantsView
        page={1}
        onPage={() => {}}
        scope={
          {
            status: "open",
            userId: USER,
            selection: ACME,
            generation: 1,
            prefix: scopedCachePrefix(USER, ACME),
            key: "k",
          } as never
        }
      />,
    );
    // Shape 1 renders its row at all (the pre-fix behavior was a crash), with no anomaly block.
    await waitFor(() => {
      expect(view.getByText("po_absent")).toBeTruthy();
    });
    expect(view.queryByTestId("anomalies-po_absent")).toBeNull();
    // Shape 2 renders the code as its own line.
    await waitFor(() => {
      expect(
        view.getByTestId("anomaly-po_amount_mismatch-amount_mismatch"),
      ).toBeTruthy();
    });
  });
});
