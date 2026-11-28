import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { searchAdminSettings } from "@/components/admin/admin-navigation";
import { pinLocale } from "./i18n";
import { Route as OverviewRoute } from "@/routes/_authed/admin/index";
import { Route as AdminRoute } from "@/routes/_authed/admin/route";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280 });
});
afterEach(async () => {
  cleanup();
  await pinLocale("en");
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("setting names rank ahead of matching descriptions without dropping task or group searches", () => {
  expect(
    searchAdminSettings(" People ")?.items.map(({ title }) => title),
  ).toContain("Skills");
  expect(searchAdminSettings(" People ")?.items[0]?.title).toBe("People");
  expect(
    searchAdminSettings("réquire sso")?.items.map(({ title }) => title),
  ).toEqual(["Identity providers"]);
  expect(
    searchAdminSettings("organization")?.items.map(({ title }) => title),
  ).toEqual(["People", "Permissions", "Providers", "Identity providers"]);
  expect(searchAdminSettings("an unknown setting")?.items).toHaveLength(0);
});

test("admin task phrases find the setting where the work happens", () => {
  expect(searchAdminSettings("single sign-on")?.items[0]?.title).toBe(
    "Identity providers",
  );
  expect(searchAdminSettings("revoke API key")?.items[0]?.title).toBe(
    "Credentials",
  );
  expect(searchAdminSettings("simulate a policy")?.items[0]?.title).toBe(
    "Test a policy",
  );
  expect(searchAdminSettings("grant admin access")?.items[0]?.title).toBe(
    "People",
  );
  expect(searchAdminSettings("revoke sign-on")?.items.length).toBe(0);
});

test("admin search recovers a single typo without replacing ordinary matches", () => {
  for (const query of [
    "identitiy providers",
    "identty providers",
    "identoty providers",
    "identity proivders",
  ]) {
    const result = searchAdminSettings(query);
    expect(result?.spelling).toBe(true);
    expect(result?.items[0]?.title).toBe("Identity providers");
  }
  expect(searchAdminSettings("reovke an API key")?.items[0]?.title).toBe(
    "Credentials",
  );
  expect(searchAdminSettings("people")?.spelling).toBe(false);
  expect(searchAdminSettings("identoty proivders")?.items).toHaveLength(0);
});

/** The Admin shell at `path`, at `width` pixels, with two child pages to navigate between. */
async function renderAdminAt(path: string, width = 1280) {
  const initial = window.innerWidth;
  window.innerWidth = width;
  try {
    const root = createRootRoute();
    const admin = createRoute({
      path: "/admin",
      getParentRoute: () => root,
      component: AdminRoute.options.component,
    });
    const providers = createRoute({
      path: "/providers",
      getParentRoute: () => admin,
      component: () => <h1>Provider settings</h1>,
    });
    const people = createRoute({
      path: "/people",
      getParentRoute: () => admin,
      component: () => <h1>People</h1>,
    });
    const router = createRouter({
      routeTree: root.addChildren([admin.addChildren([providers, people])]),
      history: createMemoryHistory({ initialEntries: [path] }),
    });
    await router.load();
    return { router, view: render(<RouterProvider router={router} />) };
  } finally {
    window.innerWidth = initial;
  }
}

test("Admin navigation identifies the current page and preserves the child outlet", async () => {
  const admin = await renderAdminAt("/admin/providers");
  const nav = admin.view.getByRole("navigation", { name: "Admin" });
  expect(
    within(nav)
      .getByRole("link", { name: "Providers" })
      .getAttribute("aria-current"),
  ).toBe("page");
  expect(
    within(nav)
      .getByRole("link", { name: "Overview" })
      .getAttribute("aria-current"),
  ).toBeNull();
  expect(
    admin.view.getByRole("heading", { name: "Provider settings" }),
  ).toBeTruthy();
});

test("Admin navigation opens from a narrow screen, names its state, and gives focus back", async () => {
  const admin = await renderAdminAt("/admin/people", 520);
  const user = userEvent.setup({ document });
  const toggle = await admin.view.findByRole("button", {
    name: "Open navigation",
  });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  toggle.focus();
  await user.keyboard("{Enter}");
  await admin.view.findByRole("dialog", { name: "Admin" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(toggle));
  expect(
    admin.view.queryByRole("dialog", { name: "Admin", hidden: true }),
  ).toBeNull();

  await user.keyboard("{Enter}");
  const sheet = within(
    await admin.view.findByRole("navigation", { name: "Admin" }),
  );
  sheet.getByRole("link", { name: "Providers" }).focus();
  await user.keyboard("{Enter}");
  await admin.view.findByRole("heading", { name: "Provider settings" });
  await waitFor(() => {
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });
});

test("the Admin sidebar speaks the interface language", async () => {
  const admin = await renderAdminAt("/admin/providers");
  await pinLocale("zh-CN");
  const nav = admin.view.getByRole("navigation", { name: "管理" });
  for (const name of [
    "总览",
    "凭据",
    "边界",
    "审批",
    "电脑",
    "插件",
    "模型提供方",
    "技能",
    "自动学习",
    "定期检查",
    "界面组件",
    "演练场",
    "人员",
    "权限",
    "身份提供方",
    "审计",
    "测试策略",
  ]) {
    expect(within(nav).getByRole("link", { name })).toBeTruthy();
  }
  expect(admin.view.getByRole("link", { name: "工作区" })).toBeTruthy();
});

test("overview search offers examples and preserves keyboard focus through navigation", async () => {
  const root = createRootRoute();
  const authed = createRoute({ getParentRoute: () => root, id: "_authed" });
  const admin = createRoute({ getParentRoute: () => authed, path: "admin" });
  const overview = createRoute({
    getParentRoute: () => admin,
    path: "/",
    component: OverviewRoute.options.component,
    validateSearch: OverviewRoute.options.validateSearch,
  });
  const identity = createRoute({
    getParentRoute: () => admin,
    path: "identity-providers",
    component: () => <h1>Identity providers</h1>,
  });
  const history = createMemoryHistory({ initialEntries: ["/admin/"] });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([admin.addChildren([overview, identity])]),
    ]),
    history,
  });
  await router.load();
  const view = render(<RouterProvider router={router} />);
  const user = userEvent.setup({ document });
  const search = within(
    view.getByRole("region", { name: "Search admin settings" }),
  );
  const input = search.getByRole("searchbox", { name: "Find a setting" });

  await user.type(input, "zzzz");
  expect(
    (await search.findByText("No matching settings.")).getAttribute("role"),
  ).toBe("status");
  expect(
    search.getByText(
      "Try “single sign-on”, “revoke an API key”, or “simulate a policy”.",
    ),
  ).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(input).toHaveProperty("value", ""));
  expect(document.activeElement === input).toBe(true);

  await user.type(input, "single sign-on");
  await waitFor(() =>
    expect(router.state.location.search).toEqual({ q: "single sign-on" }),
  );
  const result = await view.findByRole("link", { name: /Identity providers/ });
  expect(document.activeElement === input).toBe(true);
  await user.keyboard("{Enter}");
  expect(document.activeElement?.getAttribute("href")).toBe(
    result.getAttribute("href"),
  );
  await user.keyboard("{Enter}");
  await view.findByRole("heading", { name: "Identity providers" });
  history.back();
  const returned = await view.findByRole("link", {
    name: /Identity providers/,
  });
  await waitFor(() => expect(document.activeElement === returned).toBe(true));
});
