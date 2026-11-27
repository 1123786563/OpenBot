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
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { pluginKeys } from "@/lib/plugins/queries";
import { Route as Detail } from "@/routes/_authed/admin/plugins/$key";
import { Route as Tool } from "@/routes/_authed/admin/plugins/$key_.tools.$tool";
import { Route as List } from "@/routes/_authed/admin/plugins/index";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
const routeOptions = [List, Detail, Tool].map((route) => ({
  route,
  options: { ...route.options },
}));
afterEach(() => {
  for (const { route, options } of routeOptions)
    Object.assign(route.options, options);
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function draw(url: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), { edition: "team" });
  client.setQueryData(pluginKeys.connections(), { connections: [] });
  client.setQueryData(pluginKeys.page(), {
    catalogue: [],
    servers: [
      {
        id: "notion",
        title: "Notion",
        vendor: "Notion",
        summary: "Notes and databases",
        provenance: "manual",
        hasCredential: true,
        tools: [
          {
            serverId: "notion",
            name: "read_page",
            ref: "notion/read_page",
            description: "Read a page",
            inputSchema: {},
            effect: "read",
            destructive: false,
            grantedTo: [],
          },
        ],
        withdrawn: [],
      },
    ],
    skills: [],
    botsMayCallBack: true,
  });
  client.setQueryData(agentKeys.list(false), [
    { id: "ada", name: "Ada" },
    { id: "grace", name: "Grace" },
  ]);
  client.setQueryData(agentKeys.list(true), []);
  const root = createRootRoute({ component: Outlet });
  const authed = createRoute({ id: "/_authed", getParentRoute: () => root });
  const admin = createRoute({ path: "/admin", getParentRoute: () => authed });
  const routes = [
    [List, "/plugins/"],
    [Detail, "/plugins/$key"],
    [Tool, "/plugins/$key/tools/$tool", "/plugins/$key_/tools/$tool"],
  ] as const;
  const wired = routes.map(([route, path, id]) =>
    // Wire the file routes using the same path and ID as the generated router.
    route.update({
      id: id ?? path,
      path,
      getParentRoute: () => admin,
    } as never),
  );
  const history = createMemoryHistory({ initialEntries: [url] });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([admin.addChildren(wired)]),
    ]),
    history,
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, history, user: userEvent.setup({ document }) };
}

test("plugin Back restores the list query and focus to the opened row", async () => {
  const { view, history, user } = draw("/admin/plugins?q=notion");
  await user.click(await view.findByRole("link", { name: /Notion/ }));
  const back = await view.findByRole("link", { name: "Plugins" });
  expect(history.location.search).toBe("?q=notion");
  await user.click(back);
  expect(await view.findByLabelText("Search plugins")).toHaveProperty(
    "value",
    "notion",
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      view.getByRole("link", { name: /Notion/ }),
    ),
  );
});

test("tool Bot search survives returning via browser Back with the inherited plugin query", async () => {
  const { view, history, user } = draw(
    "/admin/plugins/notion/tools/read_page?q=notion&filter=Ada",
  );
  expect(await view.findByPlaceholderText("Bot name")).toHaveProperty(
    "value",
    "Ada",
  );
  await user.type(view.getByPlaceholderText("Bot name"), "m");
  await user.click(view.getByRole("link", { name: "Notion" }));
  expect(history.location.href).toBe("/admin/plugins/notion?q=notion");
  await act(async () => history.back());
  expect(await view.findByPlaceholderText("Bot name")).toHaveProperty(
    "value",
    "Adam",
  );
  expect(history.location.search).toBe("?q=notion&filter=Adam");
});
