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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import bookmarks from "../../docs/acceptance/web127-bookmarks.json";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { parseSearchText } from "@/lib/search-text";
import { routeTree } from "@/routeTree.gen";
import { Route as IdeasRoute } from "@/routes/_authed/_app/ideas";
import { Route as GoalsRoute } from "@/routes/_authed/_app/responsibilities";
import { Route as ScreenRoute } from "@/routes/_authed/_app/s/$screen";
import { settleReactWork } from "./settle-react-work";

const roles = ["teamAdmin", "teamMember", "personal"] as const;
type Role = (typeof roles)[number];

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("the contract contains 21 distinct bookmarks including six legacy screens", () => {
  expect(bookmarks).toHaveLength(21);
  expect(
    new Set(
      bookmarks.map(
        ({ source }) => new URL(source, "https://openbot.test").pathname,
      ),
    ).size,
  ).toBe(21);
  expect(
    bookmarks.filter(({ source }) => source.startsWith("/s/")),
  ).toHaveLength(6);
});

function fixtureClient(role: Role) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: role,
    name: "Bookmark fixture",
    email: "bookmark@example.test",
    role: role === "teamAdmin" ? "admin" : "user",
    onboarding: null,
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    edition: role === "personal" ? "personal" : "team",
  });
  return queryClient;
}

function openBookmark(source: string, queryClient: QueryClient) {
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [source] }),
    parseSearch: parseSearchText,
  });
  return router;
}

const agentVariants = [
  ["/agents?new=true", "/bots?new=true"],
  ["/agents?agent=expenses", "/bots/expenses"],
  ["/agents?new=true&agent=expenses", "/bots?new=true"],
];

for (const role of roles) {
  const cases = [
    ...bookmarks.map(({ source, destinations }) => [
      source,
      destinations[role],
    ]),
    ...agentVariants,
  ];
  for (const [source, destination] of cases) {
    test(`${role}: ${source} opens ${destination}`, async () => {
      const queryClient = fixtureClient(role);
      const router = openBookmark(source, queryClient);
      try {
        await router.load();
        expect(router.state.location.href).toBe(destination);
        expect(router.state.matches.length).toBeGreaterThan(1);
        for (const match of router.state.matches) {
          expect(match.status).toBe("success");
        }
      } finally {
        queryClient.clear();
      }
    });
  }
}

test("simulated sign-in returns to the legacy bookmark with its Bot selection", async () => {
  const source = "/s/goals?agent=expenses";
  const signedOut = fixtureClient("teamMember");
  signedOut.setQueryData(authKeys.currentUser(), null);
  const signedIn = fixtureClient("teamMember");
  try {
    const beforeSignIn = openBookmark(source, signedOut);
    await beforeSignIn.load();
    expect(beforeSignIn.state.location.pathname).toBe("/sign");
    expect(beforeSignIn.state.location.search.returnTo).toBe(source);

    // Simulate a successful same-origin return with a signed-in session fixture.
    const returnTo = beforeSignIn.state.location.search.returnTo;
    if (typeof returnTo !== "string")
      throw new Error("Missing sign-in return path");
    const afterSignIn = openBookmark(returnTo, signedIn);
    await afterSignIn.load();
    expect(afterSignIn.state.location.href).toBe(
      "/responsibilities?agent=expenses&view=goals",
    );
  } finally {
    signedOut.clear();
    signedIn.clear();
  }
});

// Mount just the three destination components under their real route IDs. This keeps
// shell queries and Copilot out of the fixture while exercising the pages' own hooks.
function botScopeRouter(source: string) {
  const root = createRootRoute();
  const authed = createRoute({
    getParentRoute: () => root,
    id: "_authed",
    component: Outlet,
  });
  const app = createRoute({
    getParentRoute: () => authed,
    id: "_app",
    component: Outlet,
  });
  const screen = createRoute({
    getParentRoute: () => app,
    path: "/s/$screen",
    beforeLoad: (event) => {
      ScreenRoute.options.beforeLoad?.(event as never);
    },
    validateSearch: ScreenRoute.options.validateSearch,
    component: ScreenRoute.options.component,
  });
  const ideas = createRoute({
    getParentRoute: () => app,
    path: "/ideas",
    validateSearch: IdeasRoute.options.validateSearch,
    component: IdeasRoute.options.component,
  });
  const goals = createRoute({
    getParentRoute: () => app,
    path: "/responsibilities",
    validateSearch: GoalsRoute.options.validateSearch,
    component: GoalsRoute.options.component,
  });
  return createRouter({
    routeTree: root.addChildren([
      authed.addChildren([app.addChildren([screen, ideas, goals])]),
    ]),
    history: createMemoryHistory({ initialEntries: [source] }),
    parseSearch: parseSearchText,
  });
}

test.each(["activity", "ideas", "goals"])(
  "a Team member can reselect a Bot after opening /s/%s with an unavailable Bot",
  async (screen) => {
    const client = fixtureClient("teamMember");
    client.setQueryData(agentKeys.list(), [
      { id: "expenses", name: "Expenses", hidden: false },
    ]);
    const router = botScopeRouter(`/s/${screen}?agent=unavailable`);
    const view = render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    try {
      await view.findByText("This Bot is unavailable");
      const selector = view.getByRole("combobox", { name: "Bot" });
      expect(view.getByDisplayValue("Choose a Bot")).toBe(selector);
      expect(view.getByRole("option", { name: "Expenses" })).toBeTruthy();
      fireEvent.change(selector, { target: { value: "expenses" } });
      await waitFor(() => {
        expect(router.state.location.search).toMatchObject({
          agent: "expenses",
        });
        expect(view.queryByText("This Bot is unavailable")).toBeNull();
      });
    } finally {
      view.unmount();
      client.clear();
    }
  },
);
