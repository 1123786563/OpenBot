import "./preload";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { Route as BillingAdminRoute } from "@/routes/_authed/admin/billing";
import { settleReactWork } from "./settle-react-work";

/**
 * The billing SCREEN, not the credit-grant card alone.
 *
 * `admin-credit-grant-ui.test.tsx` mounts the card directly, so the page that puts the card on
 * screen was never under test — and a page that lost its import stays invisible to everything
 * but the browser: a merge that resolved the conflict by dropping the import and keeping the
 * `<AdminCreditGrantCard />` usage type-checks into an already-red job, and then the screen
 * answers "AdminCreditGrantCard is not defined" to the administrator who opened it.
 *
 * So this file mounts the REAL route file and asks for the card's form. A route that names a
 * component it never imported throws before it can render, which is the failure this pins.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(async () => {
  // Drain React before the document goes away (see settle-react-work.ts): a callback the
  // scheduler already posted would otherwise fire against a window that no longer exists.
  await settleReactWork();
  cleanup();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

// The one true fetch, captured by preload.ts before any sibling file could stub it (see
// that file's note): a module-level `global.fetch` here could pick up a sibling's stub.
const originalFetch = globalThis.BunTEST_ORIGINAL_FETCH ?? globalThis.fetch;

beforeEach(() => {
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      const url = String(path);
      // The two sibling cards read once each; both answers are empty, which is a state each
      // card already draws. This file is about which components the page mounts, not what the
      // reads found.
      if (url === "/api/admin/billing/cleanup/execution")
        return Response.json({ execution: null });
      if (url === "/api/admin/billing/recovery-items")
        return Response.json({ items: [] });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

function drawBillingAdmin() {
  const BillingAdmin = BillingAdminRoute.options.component as ComponentType;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => <BillingAdmin /> }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("账单页挂上发放卡：路由引用的组件必须真的被导入", async () => {
  const view = drawBillingAdmin();

  // The card's own form is the marker: it can only be on screen if the route rendered
  // <AdminCreditGrantCard /> successfully.
  expect(await view.findByTestId("grant-user-id")).toBeTruthy();
});
