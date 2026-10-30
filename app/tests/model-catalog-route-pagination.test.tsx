import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Route as ModelCatalogRoute } from "@/routes/_authed/admin/model-catalog";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { settleReactWork } from "./settle-react-work";

/**
 * THE CATALOG LIST, PAGED.
 *
 * The catalog is one answer (the gateway's whole last-good list), and the page walks it
 * with the billing screens' own pager: 50 rows per page, previous/next at the ends, the
 * status sentence naming the page the reader is actually on. This file pins the three
 * facts an administrator relies on — the first page holds exactly the first 50 models,
 * the second page holds the rest, and the pager never claims a page past the end.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(async () => {
  // Drain React before the document goes away (see settle-react-work.ts).
  await settleReactWork();
  cleanup();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;

/** One closed, fully-priced model per index — the shape a successful sync answers. */
function catalogModels(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ref: {
      provider: "openai",
      model: `model-${String(index).padStart(3, "0")}`,
      capability: "chat",
    },
    capabilitySource: "supported_methods",
    unknownReason: null,
    priceStatus: "known",
    priceStatusReason: null,
    priceMissingDims: null,
    scope: null,
    open: false,
  }));
}

beforeEach(() => {
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === "/api/me") return Response.json({ user: { id: "user-1" } });
      if (url === "/api/admin/gateway/models") {
        return Response.json({ models: catalogModels(60) });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

/** `/admin/model-catalog`, at the id its route file declares. */
function renderModelCatalog() {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const page = (
    ModelCatalogRoute as unknown as { update: (options: unknown) => unknown }
  ).update({
    id: "/_authed/admin/model-catalog",
    path: "/admin/model-catalog",
    getParentRoute: () => authedRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([page as never]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ["/admin/model-catalog"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The count of row action buttons is the count of rows on screen: one "Open" per model. */
function openButtons(
  view: ReturnType<typeof renderModelCatalog>,
): HTMLElement[] {
  return view.getAllByRole("button", { name: "Open" });
}

test("目录分页：第一页 50 条，下一页余量，回到第一页", async () => {
  const view = renderModelCatalog();

  // The first page settles: exactly the first 50 of 60 models, and the sentence says so.
  expect(await view.findByText("Page 1 of 2 · 60 models")).toBeTruthy();
  expect(openButtons(view)).toHaveLength(50);
  expect(view.getByText("model-000")).toBeTruthy();
  expect(view.queryByText("model-050")).toBeNull();
  expect(
    (view.getByRole("button", { name: "Previous" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);

  // The next page holds the rest, and the ends flip: next is out, previous is back.
  fireEvent.click(view.getByRole("button", { name: "Next" }));
  await settleReactWork();
  expect(view.getByText("Page 2 of 2 · 60 models")).toBeTruthy();
  expect(openButtons(view)).toHaveLength(10);
  expect(view.getByText("model-050")).toBeTruthy();
  expect(view.queryByText("model-000")).toBeNull();
  expect(
    (view.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled,
  ).toBe(true);

  // And back: the first page again, in full.
  fireEvent.click(view.getByRole("button", { name: "Previous" }));
  await settleReactWork();
  expect(view.getByText("Page 1 of 2 · 60 models")).toBeTruthy();
  expect(openButtons(view)).toHaveLength(50);
  expect(view.getByText("model-000")).toBeTruthy();

  // Drain the mount (see settle-react-work.ts) before the document goes away.
  await settleReactWork();
  expect(view).toBeTruthy();
});
