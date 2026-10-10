import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import {
  InvoiceMethodLabel,
  InvoiceStatusPill,
} from "@/components/billing/invoice-status";
import { BillingPager } from "@/components/billing/pager";
import { QuotaBar } from "@/components/billing/quota-bar";
import type { BillingQuotaEntry } from "@/lib/billing/plan-usage";
import i18n from "@/lib/i18n";

beforeAll(async () => {
  GlobalRegistrator.register();
  // The suite's detector resolves happy-dom's "en-US" to English; these assertions are written
  // against the zh-CN bundle, so pin the language before anything renders.
  await i18n.changeLanguage("zh-CN");
});
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/**
 * The quota bar is the one place a number on this screen can lie, so these cover the two ways it
 * could: a bar drawn against a denominator that does not exist, and a bar that stops being
 * alarming exactly when the reader is about to run out.
 */

const CAPPED: BillingQuotaEntry = {
  metricCode: "llm_tokens",
  metricName: "模型 Token",
  unit: "tokens",
  used: 1000,
  limit: 2000,
  remaining: 1000,
  usedCents: 1200,
};

test("QuotaBar draws a capped resource as a bar with its own percentage", () => {
  const view = render(<QuotaBar quota={CAPPED} currency="CNY" resetsAt={null} />);
  expect(view.getByText("已用 50%")).toBeTruthy();

  const bar = view.container.querySelector('[role="progressbar"]');
  expect(bar).not.toBeNull();
  expect(bar?.getAttribute("aria-valuenow")).toBe("50");
  // The bar is labelled by the resource, not by a generic word: a screen reader reading four
  // of these in a row has to be able to tell which one it is on.
  expect(bar?.getAttribute("aria-label")).toBe("模型 Token");
  expect(view.getByText(/剩余/)).toBeTruthy();
});

/*
 * A metric this deployment measures without capping has no denominator. The bar is replaced by
 * prose rather than drawn against an invented one — see the note at the top of quota-bar.tsx.
 */
test("QuotaBar draws an uncapped resource as prose, with no bar at all", () => {
  const view = render(
    <QuotaBar
      quota={{ ...CAPPED, limit: null, remaining: null }}
      currency="CNY"
      resetsAt={null}
    />,
  );
  expect(view.getByText("不限量")).toBeTruthy();
  expect(view.container.querySelector('[role="progressbar"]')).toBeNull();
});

test("QuotaBar marks a nearly-exhausted resource in the destructive colour", () => {
  const view = render(
    <QuotaBar
      quota={{ ...CAPPED, used: 1900, remaining: 100 }}
      currency="CNY"
      resetsAt={null}
    />,
  );
  expect(view.getByText("已用 95%")).toBeTruthy();
  const fill = view.container.querySelector('[role="progressbar"] > div');
  expect(fill?.className.includes("bg-destructive")).toBe(true);
});

test("QuotaBar reads a reset date as a date, not as an ISO string", () => {
  const view = render(
    <QuotaBar quota={CAPPED} currency="CNY" resetsAt="2026-11-01T00:00:00Z" />,
  );
  // The raw ISO would be a fact only a machine wants; the row must read as a day.
  expect(view.getByText(/重置/)).toBeTruthy();
  expect(view.queryByText("2026-11-01T00:00:00Z")).toBeNull();
});

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
      // The real key, so a renamed or missing translation fails here rather than on the page.
      statusTemplate={i18n.t("invoicesPage.pagerStatus", { ns: "settings" })}
    />,
  );
  expect(view.getByText(/第 2 \/ 2 页/)).toBeTruthy();

  const buttons = view.container.querySelectorAll("button");
  expect(buttons[0].hasAttribute("disabled")).toBe(false);
  expect(buttons[1].hasAttribute("disabled")).toBe(true);
});

test("InvoiceStatusPill names each money state in words", () => {
  const paid = render(<InvoiceStatusPill status="paid" />);
  expect(paid.getByText("已支付")).toBeTruthy();

  const pending = render(<InvoiceStatusPill status="pending" />);
  expect(pending.getByText("等待支付")).toBeTruthy();
});

test("InvoiceMethodLabel names the channel that carried the money", () => {
  expect(render(<InvoiceMethodLabel method="alipay" />).getByText("支付宝")).toBeTruthy();
  expect(render(<InvoiceMethodLabel method="wechat" />).getByText("微信支付")).toBeTruthy();
});
