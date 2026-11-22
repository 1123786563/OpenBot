import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { microcreditsFromCredits } from "@/lib/billing/mutations";
import {
  billingKeys,
  type BillLine,
  type BudgetRecord,
  type PaidSource,
  creditsText,
} from "@/lib/billing/queries";
import { Route as CreditsRoute } from "@/routes/_authed/_app/billing";

/**
 * A person's credits (#107): the Test Credit balance and the paid side are in view together, each
 * charge says which source paid for it, and a budget is set under the Credit type the person picks.
 *
 * THE HARNESS IS THIS REPOSITORY'S: `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, and a `QueryClient` with `retry: false` and no staleness, so seeded answers stay put.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
const posts: { path: string; body: unknown }[] = [];

beforeEach(() => {
  posts.length = 0;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input).split("?")[0];
      if (init?.method === "POST") {
        posts.push({ path, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify(createdBudget), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 500 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

function client() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
}

function renderCredits(queryClient: QueryClient) {
  const Page = CreditsRoute.options.component as ComponentType;
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/billing"] }),
    routeTree: createRootRoute({ component: () => <Page /> }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const createdBudget: BudgetRecord = {
  budgetId: "budget-1",
  creditType: "paid",
  limitMicrocredits: "2_500_000".replace(/_/g, ""),
  usedMicrocredits: "0",
  state: "active",
  confirmed: true,
};

const pack: PaidSource = {
  entitlementId: "ent-1",
  kind: "credit_pack",
  arrivedAt: "2026-02-15T04:30:00.000Z",
  remainingMicrocredits: "99000000",
};

const lines: BillLine[] = [
  {
    operationId: "op-1",
    source: "test",
    entitlementId: null,
    periodStart: null,
    periodEnd: null,
    arrivedAt: null,
    amountMicrocredits: "6000000",
    at: "2026-02-15T05:00:00.000Z",
    reason: null,
  },
  {
    operationId: "op-2",
    source: "credit_pack",
    entitlementId: "ent-1",
    periodStart: null,
    periodEnd: null,
    arrivedAt: "2026-02-15T04:30:00.000Z",
    amountMicrocredits: "1000000",
    at: "2026-02-15T05:05:00.000Z",
    reason: null,
  },
  {
    operationId: "op-3",
    source: "correction",
    entitlementId: null,
    periodStart: null,
    periodEnd: null,
    arrivedAt: null,
    amountMicrocredits: "10000000",
    at: "2026-02-16T05:00:00.000Z",
    reason: "metered double count",
  },
];

/** A client already holding every answer the page reads. */
function answered() {
  const queryClient = client();
  queryClient.setQueryData(billingKeys.balance, {
    creditType: "test",
    grantedMicrocredits: "6000000",
    reservedMicrocredits: "0",
    chargedMicrocredits: "6000000",
    availableMicrocredits: "0",
  });
  queryClient.setQueryData(billingKeys.quote, {
    creditType: "test",
    priceVersion: "11111111-1111-4111-8111-111111111111",
    route: "route-a",
    provider: "fixture",
    model: "model-a",
    price: { inputPerMillion: 1_000_000, outputPerMillion: 0 },
    maxChargeMicrocredits: 10,
  });
  queryClient.setQueryData(billingKeys.paidSources, [pack]);
  queryClient.setQueryData(billingKeys.budgets, [createdBudget]);
  queryClient.setQueryData(billingKeys.bill, lines);
  return queryClient;
}

test("the Test Credit balance and the paid side are in view together", async () => {
  const view = renderCredits(answered());
  expect(await view.findByText("Available")).toBeTruthy();
  // Test Credit rows name their value; the paid pack says what it still holds.
  expect(view.getByText("Charged")).toBeTruthy();
  // Charged is 6, and the same charge appears again under Usage.
  expect(view.getAllByText("6").length).toBeGreaterThan(1);
  expect(view.getAllByText("Credit pack").length).toBeGreaterThan(1);
  expect(view.getByText("99 available")).toBeTruthy();
  // The rate: Credit type, price, and the most one request can charge.
  expect(view.getByText("Credit type")).toBeTruthy();
  expect(view.getAllByText("Test credits").length).toBeGreaterThan(0);
  expect(view.getByText("0.00001 credits")).toBeTruthy();
  // A budget names the type it fixed and its limit.
  expect(view.getByText("Paid budget")).toBeTruthy();
  expect(
    view.getByText("Limit 2.5 credits. Used 0.", { exact: false }),
  ).toBeTruthy();
  // Every charge names the source that paid, and a correction its reason.
  expect(view.getByText("Correction")).toBeTruthy();
  expect(view.getByText("metered double count")).toBeTruthy();
});

test("each charge is listed by the source that paid for it", async () => {
  const view = renderCredits(answered());
  await view.findByText("Usage");
  expect(view.getAllByText("Test credits").length).toBeGreaterThan(1);
  expect(view.getAllByText("Credit pack").length).toBeGreaterThan(1);
  // The charge values, in credits a person reads.
  expect(view.getByText("1")).toBeTruthy();
  expect(view.getByText("10")).toBeTruthy();
});

test("a budget is set under the Credit type the person picks", async () => {
  const user = userEvent.setup({ document });
  const view = renderCredits(answered());
  await user.click(await view.findByRole("button", { name: "Set a budget" }));
  expect(await view.findByRole("dialog")).toBeTruthy();
  // Both entries are offered, by name.
  expect(view.getByText(/Test credits are free to try/)).toBeTruthy();
  // Nothing sends while the limit is missing or impossible.
  const submit = view.getByRole("button", { name: "Set budget" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  const limit = view.getByLabelText("Limit");
  await user.type(limit, "0");
  expect(submit.hasAttribute("disabled")).toBe(true);
  await user.clear(limit);
  await user.type(limit, "2.5");
  await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
  await user.click(submit);
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toMatchObject({
    path: "/api/billing/budgets",
    body: { creditType: "test", limitMicrocredits: "2500000" },
  });
});

test("a person without a Billing Account is told so, not shown a failure", async () => {
  const queryClient = client();
  const view = renderCredits(queryClient);
  // No seeded answers: every read fails, as a server without the person's account answers.
  expect(await view.findByText("No credits yet")).toBeTruthy();
  // The other sections say what they could not load, each in its own place.
  expect(view.getAllByText("Could not load your credits").length).toBe(3);
});

test("credits read as people write them, and typed limits become microcredits", () => {
  expect(creditsText("8192")).toBe("0.008192");
  expect(creditsText("5000000")).toBe("5");
  expect(creditsText("1500000")).toBe("1.5");
  expect(microcreditsFromCredits("2.5")).toBe("2500000");
  expect(microcreditsFromCredits("5")).toBe("5000000");
  expect(microcreditsFromCredits("0")).toBeUndefined();
  expect(microcreditsFromCredits("abc")).toBeUndefined();
  expect(microcreditsFromCredits("1.1234567")).toBeUndefined();
});
