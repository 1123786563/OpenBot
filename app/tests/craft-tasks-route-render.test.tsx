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
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { Route as CraftTasksRoute } from "@/routes/_authed/_app/craft/tasks";
import { settleReactWork } from "./settle-react-work";

/**
 * THE ROUTE FILE ITSELF, MOUNTED.
 *
 * The scheduled-tasks page once answered "finish is not defined" to everyone who opened it. The
 * cause was not a broken component: a merge resolved a conflict by keeping the page's
 * `onClose={finish}` while dropping the `const finish = () => navigate({ search: {} })` line that
 * defined it — the two halves of the same edit, kept on opposite sides of the conflict. Nothing
 * else in the tree noticed, because the missing name only appears when this module renders.
 *
 * So every test of the page's PARTS passes happily while the page itself is dead: the editor
 * presenter, the roster, the status chip are all exercised elsewhere, and none of them reads this
 * route module. Only mounting this file can see it. That is the whole point of this file: a route
 * that names a symbol it never imported throws before it can render, and this is the failure it
 * pins.
 *
 * The mount is the real route file under the real route ids (`/_authed/_app/craft/tasks`), so
 * `Route.useSearch()` and `Route.useNavigate()` resolve the way they do in the app — the same
 * wiring `skills-read-failure.test.tsx` uses for the page whose search it reads.
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

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      // The scope source (who is signed in) is what opens the scope; the roster and the list
      // are the reads that ride it. Both answer empty — states this page already draws.
      if (url === "/api/me") return Response.json({ user: { id: "user-1" } });
      if (url === "/api/craft/scheduled-tasks") return Response.json({ items: [] });
      if (url === "/api/craft/sessions") return Response.json({ items: [] });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

/** `/craft/tasks`, at the id its `Route.useSearch()` reads. */
function renderCraftTasks() {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const appRoute = createRoute({
    id: "/_app",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  // In the generated tree `/craft/tasks` hangs directly off `/_authed/_app` (there is no
  // intermediate `craft` route): its full route id is `/craft/tasks`.
  const tasks = (
    CraftTasksRoute as unknown as { update: (options: unknown) => unknown }
  ).update({
    id: "/craft/tasks",
    path: "/craft/tasks",
    getParentRoute: () => appRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([appRoute.addChildren([tasks as never])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ["/craft/tasks"] }),
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

test("定时任务页能挂起来：路由引用的符号必须真的存在", async () => {
  // No assertion on content: this file is about whether the route module can render at all. A
  // route that names a symbol it never imported throws here, before any text is on screen.
  const view = renderCraftTasks();

  // The page's own heading is the marker that the module rendered rather than threw.
  expect(await view.findByText("Scheduled tasks")).toBeTruthy();
});
