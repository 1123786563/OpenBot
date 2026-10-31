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
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
 * THE READING AIDS AND THE BULK WRITE.
 *
 * The catalog is one whole answer, so narrowing it is the page's own work: the
 * search box and the state filter run before the pager, and the pager's count
 * names the filtered list, not the whole catalog. The bulk write is the
 * single-model write asked once per selected row — one shared reason, one PUT
 * each, and a refusal names the models it refused instead of stopping the run.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(async () => {
  await settleReactWork();
  cleanup();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;

/** The models the mocked catalog answers: closed and priced, openable one by one. */
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

/** Every scope PUT this run saw, in order. */
const scopeWrites: { model: string; state: string; reason: string }[] = [];

/** One model the server refuses to open, or null when all writes succeed. */
let refuseModel: string | null = null;

beforeEach(() => {
  scopeWrites.length = 0;
  refuseModel = null;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/me") return Response.json({ user: { id: "user-1" } });
      if (url === "/api/admin/gateway/models") {
        return Response.json({ models: catalogModels(60) });
      }
      if (url === "/api/admin/gateway/models/scope" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as {
          model: string;
          state: string;
          reason: string;
        };
        scopeWrites.push(body);
        if (body.model === refuseModel) {
          return Response.json(
            {
              error: "model_scope_price_unknown",
              code: "model_scope_price_unknown",
            },
            { status: 409 },
          );
        }
        return Response.json({
          scope: {
            state: body.state,
            reason: body.reason,
            changedBy: "admin@example.com",
            changedAt: "2026-10-30T00:00:00.000Z",
          },
        });
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

test("搜索在分页前收窄列表，页脚报筛选后的数量", async () => {
  const view = renderModelCatalog();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  expect(await view.findByText("Page 1 of 2 · 60 models")).toBeTruthy();

  await user.type(
    view.getByRole("textbox", { name: "Search models or providers" }),
    "model-01",
  );
  await settleReactWork();

  // The ten model-01x models are the whole filtered list, on one page.
  expect(view.getByText("Page 1 of 1 · 10 models")).toBeTruthy();
  expect(view.getAllByRole("button", { name: "Open" })).toHaveLength(10);
  expect(view.getByText("model-010")).toBeTruthy();
  expect(view.queryByText("model-000")).toBeNull();
});

test("全选 + 共用一个原因批量开放：逐个写入，拒绝不中断并点名", async () => {
  const view = renderModelCatalog();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  expect(await view.findByText("Page 1 of 2 · 60 models")).toBeTruthy();

  await user.type(
    view.getByRole("textbox", { name: "Search models or providers" }),
    "model-01",
  );
  await settleReactWork();
  await user.click(view.getByRole("button", { name: "Select all" }));
  await settleReactWork();
  expect(view.getByText("10 selected")).toBeTruthy();

  await user.click(view.getByRole("button", { name: "Open selected" }));
  await settleReactWork();
  expect(view.getByText("Open 10 models")).toBeTruthy();

  // The one shared reason reaches every write the run makes.
  refuseModel = "model-013";
  await user.type(
    view.getByPlaceholderText("Why this model is being opened or closed"),
    "reviewed pricing",
  );
  await user.click(view.getByRole("button", { name: "Save" }));
  // The notice names the refused models in the same paragraph as the count.
  expect(
    await view.findByText("1 model could not be opened:", { exact: false }),
  ).toBeTruthy();

  expect(scopeWrites).toHaveLength(10);
  expect(scopeWrites.every((write) => write.state === "open")).toBe(true);
  expect(
    scopeWrites.every((write) => write.reason === "reviewed pricing"),
  ).toBe(true);
  // The refused model is named in the notice, not merely absent from the writes.
  const notice = view.getByRole("alert");
  expect(notice.textContent).toContain("could not be opened");
  expect(notice.textContent).toContain("model-013");
});
