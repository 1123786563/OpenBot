import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
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
import userEvent from "@testing-library/user-event";
import { deploymentKeys } from "@/lib/deployment/queries";
import { identityKeys } from "@/lib/identity/queries";
import { type PluginsPage, pluginKeys } from "@/lib/plugins/queries";
import { Route as ConnectionsRoute } from "@/routes/_authed/_app/connections.index";
import { settleReactWork } from "./settle-react-work";

/**
 * WHAT THE CORSAIR APP DIRECTORY SAYS WHEN ITS READ FAILS.
 *
 * The section kept its heading and then said "Couldn't load the app directory. Reload the page." —
 * a full page reload to retry one read, unlike the broker directories beside it, which retry in
 * place. The fix is the shared `ReadError` the rest of this page already uses.
 *
 * The harness is `personal-connections.test.tsx`'s: `GlobalRegistrator` in `beforeAll`/`afterAll`,
 * `cleanup` in `afterEach`, a memory router over the real route singleton, and a `QueryClient` with
 * `retry: false` so the failing read settles in one attempt.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
const originalOptions = { ...ConnectionsRoute.options };
afterEach(() => {
  Object.assign(ConnectionsRoute.options, originalOptions);
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const INTEGRATION = {
  id: "notion",
  displayName: "Notion",
  description: "Notes and documents.",
  npmPackageName: "@corsair-dev/notion",
  authTypes: ["api_key"],
  defaultAuthType: "api_key",
  counts: { api: 14, webhooks: 3, db: 4 },
  icon: "svg",
  credentialConfigured: true,
  oauthClientConfigured: false,
  validationSkipped: true,
  connected: false,
};

/** Whether the integrations read answers, flipped by the test between the press and its retry. */
let integrationsUp = false;
let integrationReads = 0;

const originalFetch = global.fetch;
beforeEach(() => {
  integrationsUp = false;
  integrationReads = 0;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const path = String(input).split("?")[0] ?? "";
      if (path === "/api/plugins")
        return Response.json({
          catalogue: [],
          servers: [],
          skills: [],
          botsMayCallBack: true,
          redirectUri: null,
          composioConfigured: false,
          authorizesPerAction: false,
        } as unknown as PluginsPage);
      if (path === "/api/plugins/connections")
        return Response.json({ connections: [] });
      if (path === "/api/identity/links") return Response.json({ links: [] });
      if (path === "/api/identity/providers")
        return Response.json({ providers: { slack: false, github: false } });
      if (path === "/api/corsair/integrations") {
        integrationReads += 1;
        return integrationsUp
          ? Response.json({ integrations: [INTEGRATION] })
          : new Response(null, { status: 503 });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: true,
    edition: "personal",
  });
  client.setQueryData(pluginKeys.connections(), { connections: [] });
  client.setQueryData(identityKeys.links(), []);
  client.setQueryData(identityKeys.providers(), {
    slack: false,
    github: false,
  });

  const root = createRootRoute({ component: Outlet });
  const authed = createRoute({
    id: "/_authed",
    getParentRoute: () => root,
    component: Outlet,
  });
  const app = createRoute({
    id: "/_app",
    getParentRoute: () => authed,
    component: Outlet,
  });
  const list = (
    ConnectionsRoute as unknown as { update: (o: unknown) => unknown }
  ).update({
    id: "/connections/",
    path: "/connections/",
    getParentRoute: () => app,
  });
  const history = createMemoryHistory({ initialEntries: ["/connections"] });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([app.addChildren([list as never])]),
    ]),
    history,
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, user: userEvent.setup({ document }) };
}

test("a failed app-directory read keeps the section and retries in place", async () => {
  const { view, user } = draw();

  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("Couldn't load the app directory");
  // The frame stays: the section keeps its heading rather than blanking the page.
  expect(view.getByRole("heading", { name: "App directory" })).toBeTruthy();

  expect(view.getByLabelText("Search the app directory")).toBeTruthy();
  expect(integrationReads).toBe(1);

  // One Retry, and it refetches the read that failed rather than the page.
  integrationsUp = true;
  await user.click(view.getByRole("button", { name: "Retry" }));

  expect(await view.findByText("Notion")).toBeTruthy();
  expect(integrationReads).toBe(2);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      view.getByLabelText("Search the app directory"),
    ),
  );
});
