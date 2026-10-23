import "./preload";
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
import { RoutinesList } from "@/components/routines/routines-list";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

test("routine history and delete are available from the secondary actions menu", async () => {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/routines") {
      return Response.json({
        routines: [
          {
            id: "routine-1",
            agentId: "bot-1",
            schedule: "Every day",
            timezone: "UTC",
            instruction: "Send the daily report",
            channel: { id: "channel-1", name: "Reports", gone: false },
            enabled: true,
            nextRunAt: "2030-01-01T00:00:00.000Z",
            lastRun: null,
          },
        ],
        sweep: { lastSweptAt: new Date().toISOString(), working: true },
      });
    }
    if (url.includes("/runs")) return Response.json({ runs: [] });
    return Response.json({ ok: true });
  }) as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => <RoutinesList /> }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  expect(
    await view.findByRole("button", {
      name: "Run the routine scheduled Every day now",
    }),
  ).toBeTruthy();
  const trigger = view.getByRole("button", { name: "More actions" });
  expect(trigger.className).toContain("focus-visible:outline-2");
  expect(trigger.className).toContain("pointer-coarse:min-h-11");
  expect(trigger.querySelector("svg")).toBeTruthy();
  await user.click(trigger);
  const historyItem = await view.findByRole("menuitem", {
    name: "Run history for the routine scheduled Every day",
  });
  await user.click(historyItem);
  await waitFor(() => expect(view.getByText("No runs yet.")).toBeTruthy());
  await user.click(trigger);
  const deleteItem = await view.findByRole("menuitem", {
    name: "Delete the routine scheduled Every day",
  });
  expect(deleteItem.getAttribute("data-variant")).toBe("destructive");
  await user.click(deleteItem);
  expect(
    await view.findByRole("dialog", { name: 'Delete "Every day"?' }),
  ).toBeTruthy();
});
