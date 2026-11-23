import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExecutionBudgetDialog } from "@/components/billing/execution-budget-dialog";
import { billingKeys } from "@/lib/billing/queries";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("the background budget shows credit type, rate, and cap before creating a budget", async () => {
  const priceVersion = crypto.randomUUID();
  const queries = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  const quote = {
    creditType: "test",
    model: "Fixture model",
    route: "fixture-route",
    priceVersion,
    price: { inputPerMillion: 10, outputPerMillion: 20 },
    maxChargeMicrocredits: "30",
  };
  queries.setQueryData(billingKeys.quote, quote);
  const submitted: (string | undefined)[] = [];
  const requests: unknown[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method !== "POST") return Response.json(quote);
        requests.push(JSON.parse(String(init.body)));
        return Response.json({});
      },
      { preconnect: () => {} },
    ),
  );
  try {
    const view = render(
      <QueryClientProvider client={queries}>
        <ExecutionBudgetDialog
          title="Set a Task budget"
          onClose={() => {}}
          submit={async (budgetId) => {
            submitted.push(budgetId);
          }}
        />
      </QueryClientProvider>,
    );
    expect(view.getByText(/Fixture model costs 10/)).toBeDefined();
    expect(
      view.getByRole("combobox", { name: "Credit type" }).textContent,
    ).toBe("Test Credits");
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.type(view.getByLabelText("Cumulative cap in Credits"), "2.5");
    expect(requests).toEqual([]);
    await user.click(
      view.getByRole("button", { name: "Confirm and continue" }),
    );
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(requests).toEqual([
      {
        budgetId: submitted[0],
        creditType: "test",
        limitMicrocredits: "2500000",
        modelQuote: { route: "fixture-route", priceVersion },
      },
    ]);
  } finally {
    cleanup();
    queries.clear();
    fetch.mockRestore();
  }
});
