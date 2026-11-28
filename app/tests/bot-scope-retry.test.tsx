import { afterEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { botActivityQueryOptions } from "@/lib/bot-lifecycle/queries";
import { proactiveSuggestionsQueryOptions } from "@/lib/proactive";
import { taskListQueryOptions } from "@/lib/tasks/queries";
import { Route as IdeasRoute } from "@/routes/_authed/_app/ideas";
import { Route as GoalsRoute } from "@/routes/_authed/_app/responsibilities";
import { Route as ScreenRoute } from "@/routes/_authed/_app/s/$screen";
import { settleReactWork } from "./settle-react-work";

afterEach(async () => {
  cleanup();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

type ScopeRead = "/api/agents" | "/api/me";
const botListFailure: readonly ScopeRead[] = ["/api/agents"];

test.each<{
  route: typeof IdeasRoute | typeof GoalsRoute | typeof ScreenRoute;
  path: string;
  url: string;
  failedReads: readonly ScopeRead[];
}>([
  {
    route: IdeasRoute,
    path: "/ideas",
    url: "/ideas",
    failedReads: botListFailure,
  },
  {
    route: ScreenRoute,
    path: "/s/$screen",
    url: "/s/activity",
    failedReads: botListFailure,
  },
  {
    route: GoalsRoute,
    path: "/responsibilities",
    url: "/responsibilities?view=goals",
    failedReads: botListFailure,
  },
  {
    route: GoalsRoute,
    path: "/responsibilities",
    url: "/responsibilities?view=goals&panel=routines",
    failedReads: botListFailure,
  },
  {
    route: GoalsRoute,
    path: "/responsibilities",
    url: "/responsibilities?view=goals",
    failedReads: ["/api/me"],
  },
  {
    route: GoalsRoute,
    path: "/responsibilities",
    url: "/responsibilities?view=goals",
    failedReads: ["/api/agents", "/api/me"],
  },
])(
  "$url restores focus to the Bot selector after retrying $failedReads",
  async ({ route, path, url, failedReads }) => {
    GlobalRegistrator.register({ url: "http://openbot.test" });
    let recovered = false;
    using fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL) => {
          const path = String(input);
          if (!recovered && failedReads.some((read) => read === path))
            return Response.json({}, { status: 503 });
          if (path === "/api/me") return new Response(null, { status: 401 });
          if (path === "/api/routines")
            return Response.json({ routines: [], sweep: null });
          if (path === "/api/responsibilities")
            return Response.json({ responsibilities: [] });
          if (path === "/api/agents")
            return Response.json({ agents: [{ id: "desk", name: "Desk" }] });
          return Response.json({});
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    if (!failedReads.includes("/api/me"))
      client.setQueryData(currentUserQueryOptions().queryKey, null);
    client.setQueryData(botActivityQueryOptions("desk").queryKey, null);
    client.setQueryData(proactiveSuggestionsQueryOptions().queryKey, []);
    client.setQueryData(taskListQueryOptions().queryKey, []);
    const root = createRootRoute();
    const authed = createRoute({ id: "_authed", getParentRoute: () => root });
    const app = createRoute({ id: "_app", getParentRoute: () => authed });
    const screen = createRoute({
      getParentRoute: () => app,
      path,
      component: route.options.component,
      validateSearch: route.options.validateSearch,
    });
    const router = createRouter({
      routeTree: root.addChildren([
        authed.addChildren([app.addChildren([screen])]),
      ]),
      history: createMemoryHistory({ initialEntries: [url] }),
    });
    const view = render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    try {
      const retry = await view.findByRole("button", {
        name: "Retry loading Bot choices",
      });
      const initialCalls = fetchMock.mock.calls.length;
      recovered = true;
      retry.focus();
      fireEvent.click(retry);
      const selector = await view.findByRole("combobox", { name: "Bot" });
      await waitFor(() => expect(document.activeElement).toBe(selector));
      if (url.includes("view=goals")) {
        const retriedReads = fetchMock.mock.calls
          .slice(initialCalls)
          .map(([input]) => String(input))
          .filter((read) => read === "/api/agents" || read === "/api/me");
        expect(retriedReads.sort()).toEqual([...failedReads].sort());
        expect(
          view.getByRole("heading", { name: "Goals and routines by Bot" }),
        ).toBeTruthy();
        expect(view.getByRole("link", { name: "All Bot goals" })).toBeTruthy();
      }
      if (url.includes("panel=routines")) {
        await view.findByText("No routines for this Bot yet");
        expect(view.container.querySelector("[data-slot=empty]")).toBeNull();
        expect(view.getAllByRole("link", { name: "New routine" })).toHaveLength(
          1,
        );
        expect(view.getByRole("heading", { name: "Routines" }).id).toBe(
          "bot-goal-routines",
        );
      }
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      cleanup();
      client.clear();
    }
  },
);
