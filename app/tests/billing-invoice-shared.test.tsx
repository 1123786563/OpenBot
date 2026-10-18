import "./preload";
import "./preload";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "../../tests/support/e2e-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import {
  InvoiceMethodLabel,
  InvoiceStatusPill,
} from "@/components/billing/invoice-status";
import { BillingPager } from "@/components/billing/pager";
import i18n from "@/lib/i18n";

/*
 * The reads 套餐与积分 and 账单管理 share: the pager both tables ride, and the two pills every
 * bill row carries. Kept from the suite that used to test the old usage screen, trimmed to the
 * components the new system still mounts.
 */

beforeAll(() => GlobalRegistrator.register());
/*
 * zh-CN per test, English restored after each one. bun runs every test file in one process,
 * and this suite asserts Chinese strings; without giving the language back, every later file
 * renders Chinese where its assertions expect English — the whole rest of the suite fails with
 * "Unable to find" while each file still passes alone. beforeEach/afterEach (not
 * beforeAll/afterAll) because an afterAll can fire after the next file's beforeAll has already
 * rendered. Switching between bundled languages applies synchronously.
 */
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});
afterEach(() => {
  cleanup();
  void i18n.changeLanguage("en");
});
afterAll(() => GlobalRegistrator.unregister());

/**
 * The pager's one real job is the clamp: a filter that shrank the list under a pager already on
 * page 4 must not tell the reader they are on page 4 of 2.
 */
test("BillingPager clamps a page past the end, and disables previous on the first", () => {
  const view = render(
    <BillingPager
      page={4}
      totalPages={2}
      totalCount={30}
      hasNext={false}
      onPage={() => {}}
      statusTemplate="第 {{page}} / {{totalPages}} 页 · 共 {{total}} 条"
    />,
  );
  expect(view.getByText("第 2 / 2 页 · 共 30 条")).toBeTruthy();
});

test("InvoiceStatusPill names each money state in words", () => {
  const paid = render(<InvoiceStatusPill status="paid" />);
  expect(paid.getByText("已支付")).toBeTruthy();
});

test("InvoiceMethodLabel names the channel that carried the money", () => {
  const view = render(<InvoiceMethodLabel method="wechat" />);
  expect(view.getByText("微信支付")).toBeTruthy();
});
