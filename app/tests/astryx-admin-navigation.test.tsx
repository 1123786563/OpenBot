import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import { searchAdminSettings } from "@/components/admin/admin-navigation";
import { Route as AdminRoute } from "@/routes/_authed/admin/route";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280 });
});
afterEach(cleanup);
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

test("Admin navigation identifies the current page and preserves the child outlet", async () => {
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
  const router = createRouter({
    routeTree: root.addChildren([admin.addChildren([providers])]),
    history: createMemoryHistory({ initialEntries: ["/admin/providers"] }),
  });
  await router.load();
  const page = render(<RouterProvider router={router} />);

  const nav = page.getByRole("navigation", { name: "Admin" });
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
  expect(page.getByRole("heading", { name: "Provider settings" })).toBeTruthy();
});
