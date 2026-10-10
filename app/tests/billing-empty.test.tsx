import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import i18n from "@/lib/i18n";
import { BillingEmpty } from "@/components/billing/billing-empty";

beforeAll(async () => {
  GlobalRegistrator.register();
  // The suite's detector resolves happy-dom's "en-US" to English; these assertions are written
  // against the zh-CN bundle, so pin the language before anything renders.
  await i18n.changeLanguage("zh-CN");
});
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("BillingEmpty renders the message and a link to subscribe", async () => {
  // `Link` reads the router from context, so the component renders under a minimal provider.
  const rootRoute = createRootRoute({
    component: () => <BillingEmpty message="这个部署没有生效中的套餐。" />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // `screen` binds `document.body` at import time, before `GlobalRegistrator` has run, so the
  // queries come from `render`'s own view — the harness every other component test here uses.
  const view = render(<RouterProvider router={router} />);
  // The provider matches its route across a tick, so the first assertion awaits the content.
  expect(await view.findByText("这个部署没有生效中的套餐。")).toBeTruthy();
  // A `Button` drawn as an anchor carries `role="button"` here (button-native.test.tsx pins that),
  // so the subscribe CTA is found by button role; the href is what says it navigates.
  const link = view.getByRole("button", { name: /订阅/ });
  expect(link.getAttribute("href")).toContain("/settings/billing/subscribe");
});
