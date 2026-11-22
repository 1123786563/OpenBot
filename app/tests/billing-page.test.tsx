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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { microcreditsFromCredits } from "@/lib/billing/mutations";
import {
  billingKeys,
  type BillLine,
  type BudgetRecord,
  type PaidSource,
  type ResumePoint,
  creditsText,
} from "@/lib/billing/queries";
import { Route as CreditsRoute } from "@/routes/_authed/_app/billing";

/**
 * A person's credits (#107): the Test Credit balance and the paid side are in view together, each
 * charge says which source paid for it and which app it ran for, usage filters by app and Credit
 * type, a budget is set under the Credit type the person picks, and a paused task continues on the
 * budget the person confirms for it.
 *
 * THE HARNESS IS THIS REPOSITORY'S: `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, and a `QueryClient` with `retry: false` and no staleness, so seeded answers stay put.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
const posts: { path: string; body: unknown }[] = [];
const CONFIRM = "/api/billing/resume-points/op-1/confirm";

beforeEach(() => {
  posts.length = 0;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input).split("?")[0];
      if (init?.method === "POST") {
        // A revoke sends no body.
        posts.push({
          path,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(
          JSON.stringify(
            path === CONFIRM
              ? { state: "confirmed", creditType: "paid" }
              : createdBudget,
          ),
          { headers: { "content-type": "application/json" } },
        );
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
    applicationId: "weknora",
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
    applicationId: "weknora",
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
    applicationId: null,
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
  // 99 of the pack spendable, 2 held by a running request, 4 charged.
  queryClient.setQueryData(billingKeys.paidSources, [pack]);
  queryClient.setQueryData(billingKeys.paidBalance, {
    availableMicrocredits: "99000000",
    reservedMicrocredits: "2000000",
    chargedMicrocredits: "4000000",
  });
  queryClient.setQueryData(billingKeys.budgets, [createdBudget]);
  queryClient.setQueryData(billingKeys.bill, lines);
  queryClient.setQueryData(billingKeys.resumePoints, []);
  return queryClient;
}

test("the Test Credit balance and the paid side are in view together", async () => {
  const view = renderCredits(answered());
  // Each side shows the same three figures, counted on that side alone.
  expect(await view.findAllByText("Available")).toHaveLength(2);
  expect(view.getAllByText("Reserved")).toHaveLength(2);
  expect(view.getAllByText("Charged")).toHaveLength(2);
  expect(view.getAllByText("4")).toHaveLength(1);
  // The paid pack says what it still holds.
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

test("usage filters by app and by Credit type", async () => {
  const user = userEvent.setup({ document });
  const view = renderCredits(answered());
  await view.findByText("Usage");
  // Each charge says which app its step ran for, or that none was named.
  expect(view.getByText("WeKnora, op-1 on Feb 15, 2026")).toBeTruthy();
  expect(view.getByText("WeKnora, op-2 on Feb 15, 2026")).toBeTruthy();
  expect(view.getByText("metered double count")).toBeTruthy();

  // Only what ran for WeKnora.
  await user.click(view.getByRole("combobox", { name: "App" }));
  await user.click(await view.findByRole("option", { name: "WeKnora" }));
  expect(view.getByText("WeKnora, op-1 on Feb 15, 2026")).toBeTruthy();
  expect(view.getByText("WeKnora, op-2 on Feb 15, 2026")).toBeTruthy();
  expect(view.queryByText("metered double count")).toBeNull();

  // And among that, only what paid credits paid for.
  await user.click(view.getByRole("combobox", { name: "Credit type" }));
  await user.click(await view.findByRole("option", { name: "Paid credits" }));
  expect(view.queryByText("WeKnora, op-1 on Feb 15, 2026")).toBeNull();
  expect(view.getByText("WeKnora, op-2 on Feb 15, 2026")).toBeTruthy();

  // A correction is a paid charge, under whichever app its step ran.
  await user.click(view.getByRole("combobox", { name: "App" }));
  await user.click(await view.findByRole("option", { name: "No app named" }));
  expect(view.queryByText("WeKnora, op-2 on Feb 15, 2026")).toBeNull();
  expect(view.getByText("metered double count")).toBeTruthy();

  // Nothing is behind a Test Credit filter here.
  await user.click(view.getByRole("combobox", { name: "Credit type" }));
  await user.click(await view.findByRole("option", { name: "Test credits" }));
  expect(view.getByText("No matches")).toBeTruthy();
});

test("a paused task continues on the budget the person sets for it", async () => {
  const user = userEvent.setup({ document });
  const queryClient = answered();
  const paused: ResumePoint = {
    operationId: "op-1",
    applicationId: "weknora",
    reason: "insufficient_credits",
    createdAt: "2026-02-16T05:00:00.000Z",
    budgetId: null,
    confirmedAt: null,
    creditType: null,
  };
  queryClient.setQueryData(billingKeys.resumePoints, [
    paused,
    {
      ...paused,
      operationId: "op-9",
      applicationId: null,
      reason: "execution_limit",
      budgetId: "budget-1",
      confirmedAt: "2026-02-16T06:00:00.000Z",
      creditType: "paid",
    },
  ]);
  const view = renderCredits(queryClient);
  // Each paused task says what it is and why it stopped. One that already has
  // a budget says which, and has nothing left to click.
  expect(await view.findByText("Paused tasks")).toBeTruthy();
  expect(view.getByText("WeKnora")).toBeTruthy();
  expect(view.getByText("Its Test credits ran out.")).toBeTruthy();
  expect(view.getByText("A task")).toBeTruthy();
  expect(view.getByText("Continues on a Paid budget.")).toBeTruthy();
  const buttons = view.getAllByRole("button", {
    name: "Set a budget to continue",
  });
  expect(buttons).toHaveLength(1);

  await user.click(buttons[0]);
  const dialog = await view.findByRole("dialog");
  // A task out of Test credits continues on paid credits: that is the entry offered.
  const entry = within(dialog).getByRole("combobox", { name: "Credit type" });
  expect(entry.textContent?.trim()).toMatch(/^Paid credits/);
  await user.type(within(dialog).getByLabelText("Limit"), "3");
  const submit = within(dialog).getByRole("button", { name: "Set budget" });
  await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
  await user.click(submit);
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[0]).toMatchObject({
    path: "/api/billing/budgets",
    body: { creditType: "paid", limitMicrocredits: "3000000" },
  });
  // The budget alone continues nothing: the step is confirmed on it.
  expect(posts[1]).toEqual({ path: CONFIRM, body: { budgetId: "budget-1" } });
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
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

test("an app spends only under the grant the person makes, and the grant can be revoked", async () => {
  const user = userEvent.setup({ document });
  const queryClient = answered();
  const registered = (id: string, name: string, open: boolean) => ({
    id,
    name,
    operator: "independent" as const,
    resourcePrefix: `${id}-`,
    approvedAt: open ? "2026-02-01T00:00:00.000Z" : null,
    pausedAt: null,
    createdAt: "2026-02-01T00:00:00.000Z",
  });
  queryClient.setQueryData(billingKeys.applications, [
    registered("mail", "Mail agent", true),
    registered("draft", "Draft app", false),
  ]);
  const grant = (extra: Record<string, unknown>) => ({
    authorizationId: "auth-1",
    applicationId: "mail",
    kind: "online",
    taskId: null,
    resourcePrefix: "mail-",
    expiresAt: "2026-03-01T00:00:00.000Z",
    limitMicrocredits: "25000000",
    spentMicrocredits: "3000000",
    revokedAt: null,
    state: "active",
    ...extra,
  });
  queryClient.setQueryData(billingKeys.authorizations, [
    grant({}),
    grant({
      authorizationId: "auth-2",
      kind: "background",
      taskId: "nightly",
      spentMicrocredits: "25000000",
      state: "expired",
    }),
  ]);
  const view = renderCredits(queryClient);
  // Each grant says its limit, its use and when it ends. One that is over has nothing to revoke.
  const row = await view.findByText(
    "Limit 25 credits. Used 3. Until Mar 1, 2026.",
  );
  expect(row).toBeTruthy();
  expect(
    view.getByText(
      "For task nightly. Limit 25 credits. Used 25. Until Mar 1, 2026.",
    ),
  ).toBeTruthy();
  expect(view.getByText("Expired")).toBeTruthy();
  const revoke = view.getAllByRole("button", { name: "Revoke" });
  expect(revoke).toHaveLength(1);
  await user.click(revoke[0]);
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]?.path).toBe("/api/billing/authorizations/auth-1/revoke");

  // A new grant starts from the app's own resources, and nothing sends while the limit is missing.
  await user.click(view.getByRole("button", { name: "Authorize an app" }));
  const dialog = await view.findByRole("dialog");
  expect(within(dialog).getByText("Mail agent")).toBeTruthy();
  expect(within(dialog).queryByText("Draft app")).toBeNull();
  const submit = within(dialog).getByRole("button", { name: "Authorize" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  await user.type(within(dialog).getByLabelText("Limit"), "5");
  await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
  await user.click(submit);
  await waitFor(() => expect(posts).toHaveLength(2));
  const sent = posts[1];
  if (!sent) throw new Error("the grant was not sent");
  expect(sent.path).toBe("/api/billing/authorizations");
  expect(sent.body).toMatchObject({
    applicationId: "mail",
    kind: "online",
    resourcePrefix: "mail-",
    limitMicrocredits: "5000000",
    authorizationId: expect.stringMatching(/^authorization-/),
  });
  // Seven days from now, by default.
  const { expiresAt } = sent.body as { expiresAt: string };
  expect(
    Math.abs(Date.parse(expiresAt) - Date.now() - 7 * 86_400_000),
  ).toBeLessThan(60_000);
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
});

test("a person without a Billing Account is told so, not shown a failure", async () => {
  const queryClient = client();
  const view = renderCredits(queryClient);
  // No seeded answers: every read fails, as a server without the person's account answers.
  expect(await view.findByText("No credits yet")).toBeTruthy();
  // The other sections say what they could not load, each in its own place.
  expect(view.getAllByText("Could not load your credits").length).toBe(4);
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
