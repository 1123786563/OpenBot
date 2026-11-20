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
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { withoutOpenBotWorking } from "@/components/manage/audit-page";
import { settingsSidebarItems } from "@/components/settings/settings-sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { managePaths } from "@/lib/manage-paths";
import { Route as AdminAuditRoute } from "@/routes/_authed/admin/audit";
import { Route as ActivityRoute } from "@/routes/_authed/settings/_personal/activity";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/*
 * The trail is called one thing per edition, on its page and in the sidebar that leads to it. Seen
 * on Windows: the personal edition's Settings listed "Activity", and the page it opened was titled
 * "Audit" and spoke of "this deployment's policy" to the one person using it.
 */

beforeAll(() => GlobalRegistrator.register());
const openObserveUrl = "https://observe.example.test/ops/";
let configuredUrl: string | null = null;
const requests: string[] = [];
let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = String(input);
      requests.push(path);
      return path === "/api/admin/audit-events/openobserve"
        ? Response.json({ url: configuredUrl })
        : new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  requests.length = 0;
  configuredUrl = null;
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

async function renderAs(
  edition: "team" | "personal",
  Page: ComponentType,
  entry = "/",
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  // Activity asks without OpenBot's own working; Admin asks for everything.
  seedAuditPage(
    queryClient,
    edition === "personal" ? withoutOpenBotWorking("") : "",
    { events: [] },
  );
  queryClient.setQueryData(agentKeys.list(false), []);
  queryClient.setQueryData(agentKeys.list(true), []);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Page /> }),
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByText("No matches");
  return view;
}

test("the personal edition's page is titled as its Settings entry, and says nothing of a deployment", async () => {
  configuredUrl = openObserveUrl;
  const entry = settingsSidebarItems("personal").find(
    (item) => (item.linkOptions as { to?: string }).to === "/settings/activity",
  );
  expect(entry?.title).toBe("Activity");
  const view = await renderAs(
    "personal",
    ActivityRoute.options.component as ComponentType,
  );
  const heading = view.getByRole("heading", { level: 1 });
  expect(heading.textContent).toBe(entry?.title ?? "no Settings entry");
  const header = heading.closest("header") as HTMLElement;
  expect(header.textContent).not.toContain("deployment");
  expect(header.textContent).toContain("See what your Bots did");
  expect(view.queryByRole("link", { name: "Open in OpenObserve" })).toBeNull();
  expect(requests).not.toContain("/api/admin/audit-events/openobserve");
});

test("Admin keeps Audit, the name an admin reviews policy under", async () => {
  const view = await renderAs(
    "team",
    AdminAuditRoute.options.component as ComponentType,
  );
  expect(view.getByRole("heading", { level: 1 }).textContent).toBe("Audit");
  expect(view.queryByRole("link", { name: "Open in OpenObserve" })).toBeNull();
});

test("Admin Audit offers plain external navigation without passing audit search", async () => {
  configuredUrl = openObserveUrl;
  const view = await renderAs(
    "team",
    AdminAuditRoute.options.component as ComponentType,
    "/?query=private",
  );
  expect(requests).toContain("/api/admin/audit-events/openobserve");
  const link = await view.findByRole("link", { name: "Open in OpenObserve" });
  expect(link.getAttribute("href")).toBe(openObserveUrl);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(view.container.querySelector("iframe")).toBeNull();
  expect(requests).not.toContain(openObserveUrl);
});

test("pages that send a person to the trail call it what the trail is called", () => {
  expect(managePaths("personal").auditLabel).toBe("Activity");
  expect(
    settingsSidebarItems("personal").some(
      (item) => item.title === managePaths("personal").auditLabel,
    ),
  ).toBe(true);
});
