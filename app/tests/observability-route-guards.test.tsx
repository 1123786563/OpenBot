import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
import i18next from "i18next";
// Side effect: initializes i18next before the components under test render.
import "@/lib/i18n";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import { Route as BotDatasetsRoute } from "@/routes/_authed/_app/bots.$agentId.datasets";
import { Route as BotEvaluationsRoute } from "@/routes/_authed/_app/bots.$agentId.evaluations";
import { Route as BotRunsRoute } from "@/routes/_authed/_app/bots.$agentId.runs";
import { Route as AdminObservabilityRoute } from "@/routes/_authed/admin/observability";
import { Route as AdminRoute } from "@/routes/_authed/admin/route";

beforeAll(() => {
  GlobalRegistrator.register();
  void i18next.changeLanguage("en");
});

afterEach(cleanup);

afterAll(() => GlobalRegistrator.unregister());

const BOTS_MARK = "bots-roster-page";

function user(role: AuthenticatedUser["role"]): AuthenticatedUser {
  return {
    id: "user-1",
    email: "user@example.com",
    name: "User",
    role,
    onboarding: null,
  };
}

function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
    avatarSeed: "seed",
    builtIn: false,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    mine: true,
    name: "Agent",
    roleDescription: "Role",
    systemOwned: false,
    title: "Title",
    visibility: "private",
    ...overrides,
  };
}

function queryClientWith(overrides: {
  role?: AuthenticatedUser["role"];
  agent?: AgentProfile;
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(
    authKeys.currentUser(),
    user(overrides.role ?? "user"),
  );
  if (overrides.agent) {
    queryClient.setQueryData(
      agentKeys.detail(overrides.agent.id),
      overrides.agent,
    );
  }
  return queryClient;
}

/*
 * TanStack's generated route tree wires file routes with update({ id, path, getParentRoute })
 * (app/src/routeTree.gen.ts). The createFileRoute update type exposed to tests does not include
 * those generated wiring fields, so this cast is confined to the file-route attachment point —
 * the same pattern as tests/bot-route-default-agent.test.tsx.
 */
type FileRouteWiring<Parent> = Record<string, unknown> & {
  id: string;
  path: string;
  getParentRoute: () => Parent;
};

const rootRoute = createRootRoute({ component: Outlet });
const homeRoute = createRoute({
  path: "/",
  getParentRoute: () => rootRoute,
  component: () => <p>home</p>,
});
const botsRoute = createRoute({
  path: "/bots",
  getParentRoute: () => rootRoute,
  component: () => <p>{BOTS_MARK}</p>,
});

const testAdminRoute = AdminRoute.update({
  id: "/_authed/admin",
  path: "/admin",
  // The sidebar layout is not under test here; the guard is.
  component: Outlet,
  getParentRoute: () => rootRoute,
} as FileRouteWiring<typeof rootRoute>);
const testAdminObservabilityRoute = AdminObservabilityRoute.update({
  id: "/_authed/admin/observability",
  path: "/observability",
  getParentRoute: () => testAdminRoute,
} as FileRouteWiring<typeof testAdminRoute>);

const testBotRunsRoute = BotRunsRoute.update({
  id: "/_authed/_app/bots/$agentId/runs",
  path: "/bots/$agentId/runs",
  getParentRoute: () => rootRoute,
} as FileRouteWiring<typeof rootRoute>);
const testBotDatasetsRoute = BotDatasetsRoute.update({
  id: "/_authed/_app/bots/$agentId/datasets",
  path: "/bots/$agentId/datasets",
  getParentRoute: () => rootRoute,
} as FileRouteWiring<typeof rootRoute>);
const testBotEvaluationsRoute = BotEvaluationsRoute.update({
  id: "/_authed/_app/bots/$agentId/evaluations",
  path: "/bots/$agentId/evaluations",
  getParentRoute: () => rootRoute,
} as FileRouteWiring<typeof rootRoute>);

const routeTree = rootRoute.addChildren([
  homeRoute,
  botsRoute,
  testAdminRoute.addChildren([testAdminObservabilityRoute]),
  testBotRunsRoute,
  testBotDatasetsRoute,
  testBotEvaluationsRoute,
]);

function renderAt(path: string, queryClient: QueryClient) {
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("a non-admin directly opening /admin/observability is redirected away", async () => {
  const view = renderAt(
    "/admin/observability",
    queryClientWith({ role: "user" }),
  );

  expect(await view.findByText("home")).toBeTruthy();
  expect(view.queryByText("AI observability")).toBeNull();
});

test("an admin directly opening /admin/observability reaches the page", async () => {
  const view = renderAt(
    "/admin/observability",
    queryClientWith({ role: "admin" }),
  );

  expect(
    await view.findByRole("heading", { name: "AI observability" }),
  ).toBeTruthy();
  expect(view.getByText("Observability is not enabled")).toBeTruthy();
});

for (const [path, heading, disabledTitle] of [
  ["/bots/bot-1/runs", "Run records", "Run tracking is not enabled"],
  ["/bots/bot-1/datasets", "Datasets", "Evaluation is not enabled"],
  ["/bots/bot-1/evaluations", "Experiments", "Evaluation is not enabled"],
] as const) {
  test(`a Bot the person cannot manage redirects from ${path} to the roster`, async () => {
    const view = renderAt(
      path,
      queryClientWith({
        agent: agent({ id: "bot-1", canManage: false, mine: false }),
      }),
    );

    expect(await view.findByText(BOTS_MARK)).toBeTruthy();
    expect(view.queryByText(heading)).toBeNull();
  });

  test(`the Bot's manager directly opening ${path} reaches the page`, async () => {
    const view = renderAt(
      path,
      queryClientWith({ agent: agent({ id: "bot-1" }) }),
    );

    expect(await view.findByRole("heading", { name: heading })).toBeTruthy();
    expect(view.getByText(disabledTitle)).toBeTruthy();
  });
}
