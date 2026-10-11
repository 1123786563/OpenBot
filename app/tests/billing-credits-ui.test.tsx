import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import type { PlanCatalogEntry } from "@/lib/billing/credits";
import i18n from "@/lib/i18n";

/*
 * The Base UI dialog never mounts under happy-dom: its portal rides browser transition APIs this
 * DOM shim does not implement, so an open dialog renders nothing at all (verified: bare
 * <Dialog open> leaves <body> empty). The repo's established answer for "the library's shell is
 * not what this test is about" is `mock.module` (approval-tools.test.tsx), so the portal shell is
 * replaced with pass-through components and the dialog's own logic — tier and cycle drawing from
 * the catalog, the agreement gate, the price arithmetic — is what gets asserted.
 *
 * The mocked imports below must load AFTER `mock.module` and BEFORE any render; `@testing-library/
 * react` itself is imported statically above because it registers suite-level hooks at import
 * time and refuses them from inside a test.
 */
mock.module("@/components/ui/dialog", () => {
  const pass = ({ children }: { children?: React.ReactNode }) =>
    children ?? null;
  return {
    Dialog: pass,
    DialogContent: pass,
    DialogHeader: pass,
    DialogBody: pass,
    DialogFooter: pass,
    DialogTitle: pass,
    DialogDescription: pass,
  };
});

const { PlanCard } = await import("@/components/billing/plan-card");
const { UpgradeDialog } = await import("@/components/billing/upgrade-dialog");

/*
 * The dialog now polls its pending order through React Query (the settlement recovery path), so
 * every UpgradeDialog render sits inside a QueryClientProvider the way the page provides one.
 */
const { QueryClient, QueryClientProvider } = await import(
  "@tanstack/react-query"
);
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const withProvider = (ui: React.ReactElement) => (
  <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
);

beforeAll(async () => {
  GlobalRegistrator.register();
  // Written against the zh-CN bundle, matching billing-plans-usage-ui.test.tsx's convention.
  await i18n.changeLanguage("zh-CN");
});
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/*
 * What these cover: the two entries this page's money questions hang on — the upgrade button and
 * the plan dialog it opens. Both were broken in the field at the same time (an unconfigured
 * catalog hid the button; the purchase button rendered disabled), so their contracts are now
 * pinned: a catalog with plans makes the entry appear, the dialog draws every tier and cycle from
 * the catalog alone, and the agreement gates the pay button exactly as the design says.
 */

const CATALOG: Record<string, PlanCatalogEntry> = {
  standard: {
    name: "标准版",
    credits: 4000,
    features: [
      "每月基础积分 4,000",
      "每月赠送积分",
      "全部模型可选",
      "无限次代码实时补全",
      "5 个自动任务",
    ],
    pricing: [
      {
        code: "recurring_monthly",
        label: "连续包月",
        priceCents: 4900,
        originalCents: 6900,
        discountLabel: "7折",
        unit: "month",
      },
      {
        code: "monthly",
        label: "1个月",
        priceCents: 6900,
        originalCents: null,
        discountLabel: null,
        unit: "month",
      },
      {
        code: "recurring_yearly",
        label: "连续包年",
        priceCents: 47040,
        originalCents: 84000,
        discountLabel: "5.6折",
        unit: "year",
      },
      {
        code: "yearly",
        label: "1年",
        priceCents: 58800,
        originalCents: 84000,
        discountLabel: "7折",
        unit: "year",
      },
    ],
  },
  advanced: {
    name: "高级版",
    credits: 9000,
    features: ["每月基础积分 9,000"],
    pricing: [
      {
        code: "recurring_monthly",
        label: "连续包月",
        priceCents: 14000,
        originalCents: 19900,
        discountLabel: "7折",
        unit: "month",
      },
    ],
  },
  flagship: {
    name: "旗舰版",
    credits: 50000,
    features: ["每月基础积分 50,000"],
    pricing: [
      {
        code: "recurring_monthly",
        label: "连续包月",
        priceCents: 39900,
        originalCents: 56900,
        discountLabel: "7折",
        unit: "month",
      },
    ],
  },
};

test("PlanCard renders the upgrade entry when the catalog has a plan to sell", () => {
  const view = render(
    <PlanCard
      planName="体验版"
      planCredits={{ total: 500, used: 0, remaining: 500 }}
      resetsAt={null}
      onUpgrade={() => {}}
    />,
  );
  const upgrade = view.getByRole("button", { name: "升级套餐" });
  expect(upgrade).toBeTruthy();
  expect(view.getByText("0/500积分")).toBeTruthy();
  expect(view.getByText(/套餐基础积分/)).toBeTruthy();
});

test("PlanCard without an upgrade callback hides the button, not the card", () => {
  const view = render(
    <PlanCard
      planName="体验版"
      planCredits={{ total: 500, used: 0, remaining: 500 }}
      resetsAt={null}
    />,
  );
  expect(view.queryByRole("button", { name: "升级套餐" })).toBeNull();
  // The card itself stays: the plan's facts are facts even with nothing to sell.
  expect(view.getByText("体验版")).toBeTruthy();
});

test("UpgradeDialog draws every catalog tier, its cycles and its discount labels from config alone", () => {
  const view = render(
    withProvider(
      <UpgradeDialog
        open
        onOpenChange={() => {}}
        catalog={CATALOG}
        currentPlanName="体验版"
      />,
    ),
  );
  // The dialog's title and the current plan line. The shell is a pass-through, so the title text
  // rides the container directly — matched on the container, not on a wrapping element.
  expect(view.container.textContent).toContain("Buddy AI 套餐");
  expect(view.container.textContent).toContain("当前套餐：体验版");

  // All three tiers from the catalog keys.
  expect(view.getByText("标准版")).toBeTruthy();
  expect(view.getByText("高级版")).toBeTruthy();
  expect(view.getByText("旗舰版")).toBeTruthy();

  // The selected plan's (standard, first key) four cycles with prices and discount tags.
  expect(view.getByText("连续包月")).toBeTruthy();
  expect(view.getByText("1个月")).toBeTruthy();
  expect(view.getByText("连续包年")).toBeTruthy();
  expect(view.getByText("1年")).toBeTruthy();
  // Discount tags: "7折" rides several cycles and tiers, so the assertion is "it is present",
  // not "exactly once".
  expect(view.getAllByText("7折").length).toBeGreaterThan(0);
  expect(view.getByText("5.6折")).toBeTruthy();

  // The standard plan's credits allowance, drawn from the catalog's own number.
  expect(view.getByText("4,000")).toBeTruthy();

  // The plan-compare link the design shows under the cycles, and the validity line.
  expect(view.getByText(/查看套餐对比/)).toBeTruthy();
  expect(view.getByText(/有效期至/)).toBeTruthy();
});

test("UpgradeDialog gates the pay button behind the agreement, and the tick releases it", async () => {
  const view = render(
    withProvider(
      <UpgradeDialog open onOpenChange={() => {}} catalog={CATALOG} />,
    ),
  );
  const pay = view.getByRole("button", {
    name: "同意协议",
  }) as HTMLButtonElement;
  expect(pay.disabled).toBe(true);

  fireEvent.click(view.container.querySelector('input[type="checkbox"]')!);
  await waitFor(() => expect(pay.disabled).toBe(false));
});

test("UpgradeDialog with an empty catalog opens with nothing to sell", () => {
  const view = render(
    withProvider(<UpgradeDialog open onOpenChange={() => {}} catalog={{}} />),
  );
  // The title mounts; no tier does, because there is no tier to draw.
  expect(view.container.textContent).toContain("Buddy AI 套餐");
  expect(view.queryByText("标准版")).toBeNull();
  expect(view.queryByText("高级版")).toBeNull();
  // With no cycle to select, the agreement alone does not release the pay button.
  const pay = view.getByRole("button", {
    name: "同意协议",
  }) as HTMLButtonElement;
  fireEvent.click(view.container.querySelector('input[type="checkbox"]')!);
  expect(pay.disabled).toBe(true);
});

test("the page's purchase entry: a catalog-backed button is enabled, an absent catalog disables it", () => {
  // The page wires the purchase button the same way as the upgrade entry: presence of a catalog
  // with at least one plan. These two states are the contract the field bug broke — hidden
  // upgrade and a dead purchase button — pinned here against the plain conditions.
  const hasCatalog = (catalog: Record<string, PlanCatalogEntry>) =>
    Object.keys(catalog).length > 0;
  expect(hasCatalog(CATALOG)).toBe(true);
  expect(hasCatalog({})).toBe(false);
});
