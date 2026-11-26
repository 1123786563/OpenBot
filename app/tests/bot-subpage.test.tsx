import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as BotAccessRoute } from "@/routes/_authed/_app/bots.$agentId.access";
import { Route as BotSharingRoute } from "@/routes/_authed/_app/bots.$agentId.sharing";
import { settleReactWork } from "./settle-react-work";

/**
 * Every Bot area page sits in one frame, so the frame's shared read recovery is proved here once
 * instead of per area: the loading sentence, the first-load failure with its retry, the refusal for
 * a Bot that is gone or not shared, and a refresh that fails while the last loaded page stays.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const BOT: AgentProfile = {
  id: "expenses",
  name: "Expenses",
  title: "Finance",
  roleDescription: "Review receipts.",
  avatarSeed: "expenses",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

/** Byte-for-byte the two area routes the app mounts, at their own addresses. */
const AREAS = [
  {
    name: "access",
    path: "/bots/$agentId/access",
    title: "Skills and access",
    route: BotAccessRoute,
  },
  {
    name: "sharing",
    path: "/bots/$agentId/sharing",
    title: "Sharing",
    route: BotSharingRoute,
  },
] as const;

function draw(
  route: (typeof AREAS)[number]["route"],
  at: string,
  respond: (path: string) => Promise<Response> | Response,
) {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => respond(String(input)),
    { preconnect: originalFetch.preconnect },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: Outlet,
  });
  const page = (path: string, name: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <p>{name}</p>,
    });
  const Area = route.options.component as ComponentType;
  const area = createRoute({
    getParentRoute: () => root,
    path: at,
    component: () => <Area />,
  });
  const router = createRouter({
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [at] }),
    routeTree: root.addChildren([
      page("/bots", "Bots"),
      page("/bots/$agentId", "Bot profile"),
      area,
    ]),
  });
  const params = spyOn(route, "useParams").mockImplementation((() => ({
    agentId: "expenses",
  })) as never);
  const view = render(
    <QueryClientProvider client={client}>
      <main>
        <RouterProvider router={router as never} />
      </main>
    </QueryClientProvider>,
  );
  return { client, params, view };
}

function extras(path: string) {
  if (path === "/api/team-bots") {
    return Response.json({ teamBots: [], publishable: [] });
  }
  if (path === "/api/me") {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  return new Response(null, { status: 404 });
}

for (const area of AREAS) {
  test(`${area.name}: a failed first load offers Retry, and the retry focuses the page title`, async () => {
    let status = 503;
    let first = true;
    let gate: ((response: Response) => void) | undefined;
    const { params, view } = draw(area.route, area.path, (path) => {
      if (path !== "/api/agents/expenses") return extras(path);
      // Hold the first read so the loading sentence can be read before it settles.
      if (first) {
        first = false;
        return new Promise<Response>((resolve) => {
          gate = resolve;
        });
      }
      return Response.json(status === 200 ? { agent: BOT } : { error: "No" }, {
        status,
      });
    });
    try {
      expect(await view.findByText("Loading Bot…")).toBeTruthy();
      gate?.(Response.json({ error: "No" }, { status: 503 }));
      expect(await view.findByText("Couldn’t load this Bot")).toBeTruthy();

      status = 200;
      await userEvent
        .setup({ document: view.baseElement.ownerDocument })
        .click(view.getByRole("button", { name: "Retry" }));
      const heading = await view.findByRole("heading", {
        level: 1,
        name: area.title,
      });
      await waitFor(() => expect(document.activeElement).toBe(heading));
      expect(status).toBe(200);
    } finally {
      params.mockRestore();
    }
  });

  test(`${area.name}: a Bot that is gone or not shared says so, and Back returns to Bots`, async () => {
    for (const status of [403, 404]) {
      const { params, view } = draw(area.route, area.path, (path) =>
        path === "/api/agents/expenses"
          ? Response.json({ error: "No" }, { status })
          : extras(path),
      );
      try {
        expect(
          await view.findByText(
            "This Bot was removed or is no longer shared with you",
          ),
        ).toBeTruthy();
        expect(
          view.getByRole("link", { name: "Bots" }).getAttribute("href"),
        ).toBe("/bots");
      } finally {
        params.mockRestore();
      }
      cleanup();
    }
  });
}

test("sharing: a failed refresh keeps the last loaded page and says so", async () => {
  let status = 200;
  const { client, params, view } = draw(
    BotSharingRoute,
    "/bots/$agentId/sharing",
    (path) => {
      if (path !== "/api/agents/expenses") return extras(path);
      return status === 200
        ? Response.json({ agent: BOT })
        : Response.json({ error: "No" }, { status });
    },
  );
  try {
    expect(
      await view.findByRole("heading", { level: 1, name: "Sharing" }),
    ).toBeTruthy();
    expect(await view.findByText("Published")).toBeTruthy();

    status = 503;
    await act(async () => {
      await client.refetchQueries({
        queryKey: agentKeys.detail("expenses"),
      });
    });
    expect(await view.findByText("Couldn’t refresh this Bot")).toBeTruthy();
    expect(view.getByText("Published")).toBeTruthy();
  } finally {
    params.mockRestore();
  }
});
