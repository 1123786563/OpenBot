import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as SetupRoute } from "@/routes/_authed/settings/setup";
import { pinLocale } from "./i18n";
import { settleReactWork } from "./settle-react-work";

/**
 * Settings → Setup: onboarding's setup checklist, kept where an admin can reopen it after a
 * restart. An admin and the one person on a local install get it; a member is sent to General and
 * is never offered it in the sidebar.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const CHECKLIST = {
  audience: "admin",
  rows: [
    {
      id: "model",
      scope: "deployment",
      title: "AI model",
      required: true,
      status: "needs_setup",
      ready: false,
      detail: "Without a model key, OpenBot can't answer.",
      fix: {
        kind: "env",
        names: ["OPENAI_API_KEY"],
        docsUrl: "https://github.com/CopilotKit/openbot#quick-start",
        page: { label: "Credentials", path: "/admin/credentials" },
      },
    },
  ],
};

const originalFetch = globalThis.fetch;
let role: "admin" | "user";
let localEvaluation: boolean;
let edition: "team" | "personal";
let rechecked: number;
/** Every path asked for, to say what a member's sidebar never reads. */
let requested: string[];
/** What `GET /api/setup` answers. */
let checklist: { audience: string; rows: unknown[] };
const defaults = queryClient.getDefaultOptions();

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, retry: false },
  });
  role = "admin";
  localEvaluation = false;
  edition = "team";
  rechecked = 0;
  requested = [];
  checklist = CHECKLIST;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      requested.push(path);
      if (path === "/api/me")
        return Response.json({
          user: {
            id: "person-1",
            email: "maya@example.com",
            name: "Maya",
            needsName: false,
            role,
          },
        });
      if (path === "/api/capabilities")
        return Response.json({ localEvaluation, edition });
      if (path === "/api/setup/check" && init?.method === "POST") {
        rechecked += 1;
        return Response.json({ checklist: CHECKLIST });
      }
      if (path === "/api/setup") return Response.json({ checklist });
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(async () => {
  cleanup();
  await pinLocale("en");
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  globalThis.fetch = originalFetch;
  queryClient.clear();
  queryClient.setDefaultOptions(defaults);
});

function open(path: string) {
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: Outlet,
  });
  const settingsRoute = createRoute({
    path: "/settings",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const generalRoute = createRoute({
    path: "/",
    getParentRoute: () => settingsRoute,
    component: () => <p>General settings</p>,
  });
  const credentialsRoute = createRoute({
    path: "/admin/credentials",
    getParentRoute: () => rootRoute,
    component: () => <p>Credentials page</p>,
  });
  const setupRoute = (
    SetupRoute as unknown as {
      update: (options: unknown) => typeof SetupRoute;
    }
  ).update({
    id: "/setup",
    path: "/setup",
    getParentRoute: () => settingsRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      settingsRoute.addChildren([generalRoute, setupRoute as never]),
      credentialsRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return Object.assign(view, { router });
}

/** The settings sidebar, inside a router so its links resolve. */
function sidebar() {
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: () => (
      <SidebarProvider>
        <SettingsSidebar />
      </SidebarProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { queryClient },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("an admin reopens the setup checklist in Settings, and can check again", async () => {
  const view = open("/settings/setup");

  expect(await view.findByRole("heading", { name: "Setup" })).toBeTruthy();
  expect(await view.findByRole("list", { name: "Setup" })).toBeTruthy();
  expect(view.getByText("OPENAI_API_KEY")).toBeTruthy();

  fireEvent.click(view.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(rechecked).toBe(1));
});

test("a fix's page opens straight from Settings", async () => {
  const view = open("/settings/setup");

  fireEvent.click(await view.findByRole("link", { name: "Credentials" }));

  expect(await view.findByText("Credentials page")).toBeTruthy();
  expect(view.router.state.location.pathname).toBe("/admin/credentials");
});

test("a member doesn't get the page, and lands on General", async () => {
  role = "user";
  const view = open("/settings/setup");

  expect(await view.findByText("General settings")).toBeTruthy();
  expect(view.router.state.location.pathname).toBe("/settings");
  expect(view.queryByRole("heading", { name: "Setup" })).toBeNull();
});

test("the one person on a local install gets the page", async () => {
  role = "user";
  localEvaluation = true;
  const view = open("/settings/setup");

  expect(await view.findByRole("heading", { name: "Setup" })).toBeTruthy();
});

test("the sidebar lists Setup for an admin", async () => {
  const view = sidebar();

  const link = await view.findByRole("link", { name: /^Setup/ });
  expect(link.getAttribute("href")).toBe("/settings/setup");
});

/** A checklist row, needing setup unless told otherwise. */
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  scope: "deployment",
  title: id,
  required: false,
  status: "needs_setup",
  ready: false,
  detail: "",
  fix: { kind: "env", names: ["SOME_KEY"], docsUrl: "https://example.test" },
  ...over,
});

/** The sidebar's Setup link, once it reads `text`, the count's words included. */
const setupLink = (view: ReturnType<typeof render>, text: string) =>
  waitFor(() => {
    const link = view.getByRole("link", { name: /^Setup/ });
    expect(link.textContent).toBe(text);
    return link;
  });

test("an admin's sidebar counts beside Setup the rows they can fix", async () => {
  checklist = {
    audience: "admin",
    rows: [
      row("model"),
      row("apps"),
      // Nothing to do about it here, so not counted.
      row("computer", { fix: null }),
      row("search", { status: "ready", ready: true }),
    ],
  };
  const view = sidebar();

  const link = await setupLink(view, "Setup, 2 need setup");
  const badge = link.parentElement?.querySelector(
    '[data-sidebar="menu-badge"]',
  );
  expect(badge?.textContent).toBe("2");
  // Said once, in the link's name: the number on its own is hidden.
  expect(badge?.getAttribute("aria-hidden")).toBe("true");
});

test("one row to fix reads in the singular", async () => {
  checklist = { audience: "admin", rows: [row("model")] };
  const view = sidebar();

  expect(await setupLink(view, "Setup, 1 needs setup")).toBeTruthy();
});

test("an admin with nothing to fix sees Setup without a count", async () => {
  checklist = {
    audience: "admin",
    rows: [row("model", { status: "ready", ready: true })],
  };
  const view = sidebar();

  await view.findByRole("link", { name: /^Setup/ });
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  expect(view.getByRole("link", { name: /^Setup/ }).textContent).toBe("Setup");
  expect(view.container.querySelector('[data-sidebar="menu-badge"]')).toBe(
    null,
  );
});

test("the sidebar never offers Setup to a member", async () => {
  role = "user";
  const view = sidebar();

  await view.findByRole("link", { name: "General" });
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  expect(view.queryByRole("link", { name: /^Setup/ })).toBeNull();
  // Nor is the checklist asked for: there is nothing in it a member could fix.
  expect(requested).not.toContain("/api/setup");
  expect(view.container.querySelector('[data-sidebar="menu-badge"]')).toBe(
    null,
  );
});

test("in Chinese the sidebar speaks the interface language, destinations unchanged", async () => {
  checklist = { audience: "admin", rows: [row("model")] };
  await pinLocale("zh-CN");
  const view = sidebar();

  await view.findByRole("link", { name: "通用" });
  expect(view.getByRole("link", { name: "通知" }).getAttribute("href")).toBe(
    "/settings/notifications",
  );
  expect(view.getByRole("link", { name: "审批" }).getAttribute("href")).toBe(
    "/settings/approvals",
  );
  expect(view.getByRole("link", { name: "浏览器" }).getAttribute("href")).toBe(
    "/settings/browsers",
  );
  expect(view.getByRole("link", { name: "学习" }).getAttribute("href")).toBe(
    "/settings/learning",
  );
  expect(view.getByRole("link", { name: "密码" }).getAttribute("href")).toBe(
    "/settings/passwords",
  );
  expect(view.getByRole("link", { name: "组件库" }).getAttribute("href")).toBe(
    "/settings/components-gallery",
  );
  const setup = view.getByRole("link", { name: /^配置/ });
  await waitFor(() => expect(setup.textContent).toBe("配置，1 项需要配置"));
  expect(setup.getAttribute("href")).toBe("/settings/setup");
  const badge = view.container.querySelector('[data-sidebar="menu-badge"]');
  expect(badge?.textContent).toBe("1");
  expect(badge?.getAttribute("aria-hidden")).toBe("true");
  for (const group of ["偏好设置", "访问与设备", "工作区工具"])
    expect(view.getByText(group)).toBeTruthy();
  expect(view.getByRole("navigation", { name: "设置" })).toBeTruthy();
  expect(view.getByRole("link", { name: "工作区" })).toBeTruthy();
});

test("in Chinese the personal edition's own entries speak too, This computer included in OpenBot Desktop", async () => {
  role = "user";
  localEvaluation = true;
  edition = "personal";
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (command: string) => {
      throw `command ${command} not found`;
    },
    transformCallback: () => 0,
  };
  await pinLocale("zh-CN");
  const view = sidebar();

  const destination = (name: string) =>
    view.getByRole("link", { name }).getAttribute("href");
  await view.findByRole("link", { name: "密钥" });
  expect(destination("密钥")).toBe("/settings/credentials");
  expect(destination("技能")).toBe("/settings/skills");
  expect(destination("电脑")).toBe("/settings/computer");
  expect(destination("活动")).toBe("/settings/activity");
  // Passwords goes by the name Connections gives it there.
  expect(destination("保存的登录")).toBe("/settings/passwords");
  expect(view.queryByRole("link", { name: "密码" })).toBeNull();
  expect(destination("这台电脑")).toBe("/settings/this-computer");
});
