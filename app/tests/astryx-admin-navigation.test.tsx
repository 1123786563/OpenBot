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
