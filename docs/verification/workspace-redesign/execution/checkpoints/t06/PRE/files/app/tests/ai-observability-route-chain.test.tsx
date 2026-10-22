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
import { cleanup, render, waitFor } from "@testing-library/react";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
// English copy: the i18n bundles initialize on import, so assertions see real sentences.
import "@/lib/i18n";
import type { RouterContext } from "@/router-context";
import { Route as EvaluationsRoute } from "../src/routes/_authed/_app/bots.$agentId.evaluations";
import { Route as ComparisonsRoute } from "../src/routes/_authed/_app/bots.$agentId.evaluations.experiment-comparisons";
import { Route as RunsRoute } from "../src/routes/_authed/_app/bots.$agentId.runs";
import { Route as RunDetailRoute } from "../src/routes/_authed/_app/bots.$agentId.runs.$bindingId";

/*
 * The production render chain for the observation routes (OCR round 1 critical #1/#2):
 * the generated tree nests `runs/$bindingId` under the runs route and the three
 * evaluations children under the evaluations route, so the PARENT route component is
 * on screen whenever a child mounts. A parent that renders only its own list page and
 * never an `<Outlet />` keeps the child unmountable: the URL changes and the screen
 * stays on the list, which is exactly the bug the ad-hoc flat routers in the page
 * tests could not see (there the detail's parent was the root, not the runs route).
 *
 * This file pins the chain end to end with the REAL route files — the parent and
 * child components under test are the production ones, not re-creations. The layout
 * routes are the one substitution: the real `/_authed` mounts the CopilotKit runtime
 * (which has nothing to say to these pages and no session to speak of here), so the
 * layouts stand in as plain Outlets exactly as bot-route-default-agent.test.tsx
 * justifies for the same reason. The ids and paths mirror routeTree.gen.ts's own
 * `update(...)` calls verbatim, so the shared file-route singletons keep the same
 * shape whichever file wires them first.
 */

/*
 * TanStack's generated route tree wires file routes with update({ id, path,
 * getParentRoute }) (app/src/routeTree.gen.ts), and the memory-router docs use an
 * explicit test tree. The update parameter type is route-specific (it names each
 * route's own registered id inside its match callbacks), so each file route gets its
 * own intersection-cast wiring type — the same confined cast
 * bot-route-default-agent.test.tsx uses at the attachment point; the rendered
 * components, router and assertions stay typed.
 */
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

type RunsWiring = Parameters<typeof RunsRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};
type DetailWiring = Parameters<typeof RunDetailRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof testRunsRoute;
};
type EvaluationsWiring = Parameters<typeof EvaluationsRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};
type ComparisonsWiring = Parameters<typeof ComparisonsRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof testEvaluationsRoute;
};

const testRunsRoute = RunsRoute.update({
  id: "/bots/$agentId/runs",
  path: "/bots/$agentId/runs",
  getParentRoute: () => appRoute,
} as RunsWiring);
const testRunDetailRoute = RunDetailRoute.update({
  id: "/$bindingId",
  path: "/$bindingId",
  getParentRoute: () => testRunsRoute,
} as DetailWiring);
const testEvaluationsRoute = EvaluationsRoute.update({
  id: "/bots/$agentId/evaluations",
  path: "/bots/$agentId/evaluations",
  getParentRoute: () => appRoute,
} as EvaluationsWiring);
const testComparisonsRoute = ComparisonsRoute.update({
  id: "/experiment-comparisons",
  path: "/experiment-comparisons",
  getParentRoute: () => testEvaluationsRoute,
} as ComparisonsWiring);

const testRouteTree = rootRoute.addChildren([
  authedRoute.addChildren([
    appRoute.addChildren([
      testRunsRoute.addChildren([testRunDetailRoute]),
      testEvaluationsRoute.addChildren([testComparisonsRoute]),
    ]),
  ]),
]);

beforeAll(() => GlobalRegistrator.register());
afterEach(async () => {
  /*
   * Yield once before unmounting so React's pending flush drains while the DOM
   * registrar's window still exists — otherwise it fires after unregister and
   * crashes on window.event (the same teardown discipline the run-detail test
   * documents for its steps query).
   */
  await new Promise((resolve) => setTimeout(resolve, 0));
  cleanup();
});
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
beforeEach(() => {
  /*
   * The pages' own reads answer 404 — this test is about WHICH page mounts, not what
   * the pages say about their data. Every page's shell (and with it the anchor sentence
   * below) renders before and regardless of the read's verdict. The one read that must
   * succeed is the route guard's — see draw(), which seeds the cache it reads.
   */
  global.fetch = Object.assign(
    async () => new Response(null, { status: 404 }),
    {
      preconnect: originalFetch.preconnect,
    },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function draw(initial: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  /*
   * The routes under test carry a beforeLoad guard (`requireBotObservabilityAccess`),
   * so the router needs the production context — main.tsx mounts RouterProvider with
   * `{ queryClient }` exactly like this — and the guard's agent read must find a
   * manager in the cache or it would redirect every entry to /bots. Seeding the cache
   * (staleTime ∞, so `ensureQueryData` answers from it and never hits the 404ing fetch)
   * is the same seed observability-route-guards.test.tsx uses when it drives the guard
   * directly.
   */
  queryClient.setQueryData(agentKeys.detail("agent-1"), {
    id: "agent-1",
    canManage: true,
  } as AgentProfile);
  const router = createRouter({
    routeTree: testRouteTree,
    history: createMemoryHistory({ initialEntries: [initial] }),
    context: {} as RouterContext,
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>,
  );
  return { router, ...view };
}

describe("the runs chain mounts its detail through the real parent (OCR critical #1)", () => {
  test("a directly typed detail URL renders the detail page, not the list", async () => {
    const view = draw("/bots/agent-1/runs/binding-9");
    await waitFor(() =>
      expect(view.container.textContent).toContain("Run detail"),
    );
    // The detail replaces the list on screen: it is a full BotSubpage shell with its
    // own back link, so stacking it under the list would clip one of the two.
    expect(view.container.textContent).not.toContain("Run history");
  });

  test("the parent's own URL still renders the list", async () => {
    const view = draw("/bots/agent-1/runs");
    await waitFor(() =>
      expect(view.container.textContent).toContain("Run history"),
    );
  });

  test("navigating from the list to a detail swaps the list for the detail", async () => {
    const view = draw("/bots/agent-1/runs");
    await waitFor(() =>
      expect(view.container.textContent).toContain("Run history"),
    );
    view.router.history.push("/bots/agent-1/runs/binding-9");
    await waitFor(() =>
      expect(view.container.textContent).toContain("Run detail"),
    );
    expect(view.container.textContent).not.toContain("Run history");
  });
});

describe("the evaluations chain mounts its children through the real parent (OCR critical #2)", () => {
  test("a directly typed comparison URL renders the comparison page, not the evaluations page", async () => {
    const view = draw("/bots/agent-1/evaluations/experiment-comparisons");
    await waitFor(() =>
      expect(view.container.textContent).toContain("Compare experiments"),
    );
    // "Evaluations" alone is the child's back-link label, so the parent's absence is
    // asserted on its datasets section — a section only the combined page draws.
    expect(view.container.textContent).not.toContain("Datasets");
  });

  test("the parent's own URL still renders the evaluations page", async () => {
    const view = draw("/bots/agent-1/evaluations");
    await waitFor(() =>
      expect(view.container.textContent).toContain("Evaluations"),
    );
  });
});
