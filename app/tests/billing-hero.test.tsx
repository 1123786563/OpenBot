import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { SubscriptionHero } from "@/components/billing/subscription-hero";
import { entitlementIconFor } from "@/components/billing/entitlement-icon";
import { IconShieldCheck } from "@tabler/icons-react";
import i18n from "@/lib/i18n";

beforeAll(async () => {
  GlobalRegistrator.register();
  // The suite's detector resolves happy-dom's "en-US" to English; these assertions are written
  // against the zh-CN bundle, so pin the language before anything renders.
  await i18n.changeLanguage("zh-CN");
});
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("SubscriptionHero shows the plan, the active badge and the period", () => {
  // `screen` binds `document.body` at import time, before `GlobalRegistrator` has run, so the
  // queries come from `render`'s own view — the harness every other component test here uses.
  const view = render(
    <SubscriptionHero
      planCode="pro-monthly"
      status="active"
      currentPeriodStart="2026-10-01T00:00:00Z"
      currentPeriodEnd="2026-11-01T00:00:00Z"
    />,
  );
  expect(view.getByText("pro-monthly")).toBeTruthy();
  expect(view.getByText("生效中")).toBeTruthy();
  expect(view.getByText(/–/)).toBeTruthy();
});

test("SubscriptionHero marks a non-active status without a period", () => {
  const view = render(
    <SubscriptionHero planCode="pro" status="canceled" currentPeriodStart={null} currentPeriodEnd={null} />,
  );
  expect(view.getByText("未生效")).toBeTruthy();
});

test("entitlementIconFor falls back to the shield", () => {
  expect(entitlementIconFor("weird.custom.code")).toBe(IconShieldCheck);
  expect(entitlementIconFor("agents.pro")).not.toBe(IconShieldCheck);
});

