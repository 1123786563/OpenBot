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
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import {
  type PluginSkill,
  type PluginsPage,
  pluginKeys,
} from "@/lib/plugins/queries";
import { Route as SkillsRoute } from "@/routes/_authed/_app/skills";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "../../tests/support/e2e-compat";

class Observer implements ResizeObserver {
  static targets = new Map<Element, Observer>();
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    Observer.targets.set(target, this);
  }
  unobserve(target: Element) {
    Observer.targets.delete(target);
  }
  disconnect() {
    for (const [target, observer] of Observer.targets)
      if (observer === this) Observer.targets.delete(target);
  }
  resize(target: Element, width: number) {
    this.callback(
      [
        {
          target,
          contentRect: new DOMRect(0, 0, width, 640),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      this,
    );
  }
}

let originalObserver: typeof ResizeObserver;
const originalFetch = globalThis.fetch;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = Observer;
});
afterEach(() => {
  cleanup();
  Observer.targets.clear();
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  globalThis.ResizeObserver = originalObserver;
  GlobalRegistrator.unregister();
});

function captureRouteState(route: object): Record<string, unknown> {
  return { ...route, options: { ...(route as { options: object }).options } };
}
function restoreRouteState(route: object, snapshot: Record<string, unknown>) {
  for (const key of Object.keys(route))
    if (!(key in snapshot)) delete (route as Record<string, unknown>)[key];
  Object.assign(route, snapshot);
}
const pristineSkillsRouteState = captureRouteState(SkillsRoute);

function skill(
  overrides: Partial<PluginSkill> & { id: string; slug: string },
): PluginSkill {
  return {
    ownerUserId: "user-1",
    title: "Skill",
    summary: "",
    instructions: "",
    origin: "personal",
    installedBy: "user-1",
    grantedTo: [],
    tools: [],
    ...overrides,
  };
}

/*
 * The edit target is a search parameter, so `edit:alpha → edit:beta` is one router navigation with
 * the panel never closing. The route-level draft is keyed per target, but a form component that is
 * REUSED across that navigation keeps its own internal state — which would carry alpha's typed
 * values into beta's form and, worse, into beta's save payload under a slug that still says alpha.
 */
test("switching the edit target starts from that skill, not the reused form's stale state", async () => {
  const routeSnapshot = captureRouteState(pristineSkillsRouteState);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const page: PluginsPage = {
    catalogue: [],
    servers: [],
    skills: [
      skill({
        id: "s-alpha",
        slug: "alpha",
        title: "Alpha skill",
        instructions: "Alpha instructions",
      }),
      skill({
        id: "s-beta",
        slug: "beta",
        title: "Beta skill",
        instructions: "Beta instructions",
      }),
    ],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: false,
    openConnectorConfigured: false,
  };
  const me: AuthenticatedUser = {
    id: "user-1",
    email: "person@example.com",
    role: "user",
    onboarding: null,
  };
  client.setQueryData(pluginKeys.page(), page);
  client.setQueryData(authKeys.currentUser(), me);

  // The POST body is the observable half of "the save belongs to beta".
  const posts: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(String(init.body));
        return Response.json({ ok: true });
      }
      if (String(input).includes("/api/plugins")) {
        return Response.json(page);
      }
      return Response.json({}, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );

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
  const skills = (
    SkillsRoute as unknown as { update: (options: unknown) => unknown }
  ).update({
    path: "/skills",
    getParentRoute: () => appRoute,
  });
  const history = createMemoryHistory({
    initialEntries: ["/skills?edit=alpha"],
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([appRoute.addChildren([skills as never])]),
    ]),
    history,
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  try {
    const alphaTitle = (await view.findByPlaceholderText(
      "My standup skill",
    )) as HTMLInputElement;
    expect(alphaTitle.value).toBe("Alpha skill");

    const user = userEvent.setup({ document: view.baseElement.ownerDocument });
    await user.type(alphaTitle, " (dirtied)");
    expect(
      (alphaTitle.closest("form") as HTMLFormElement).getAttribute(
        "data-dirty",
      ),
    ).toBe("true");

    await act(async () => {
      await router.navigate({ to: "/skills", search: { edit: "beta" } });
    });

    const betaTitle = view.getByPlaceholderText(
      "My standup skill",
    ) as HTMLInputElement;
    expect(betaTitle.value).toBe("Beta skill");
    expect(
      (betaTitle.closest("form") as HTMLFormElement).getAttribute("data-dirty"),
    ).toBe("false");

    await user.click(view.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(posts.length).toBeGreaterThan(0));
    const payload = JSON.parse(posts.at(-1) as string) as {
      slug: string;
      title: string;
    };
    expect(payload.slug).toBe("beta");
    expect(payload.title).toBe("Beta skill");
  } finally {
    restoreRouteState(SkillsRoute, routeSnapshot);
  }
});
