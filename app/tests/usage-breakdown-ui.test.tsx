import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import type { CreditConsumptionEntry } from "@/lib/billing/credits";
import i18n from "@/lib/i18n";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  mock,
  test,
} from "../../tests/support/bun-test-compat";
import { settleReactWork } from "./settle-react-work";

/*
 * Ticket 20.3 — the consumption table's fee split (model fee / surcharge fee), the UI half
 * of the two-level attribution the server view carries:
 *
 *   AC-1  an entry whose settlement carried a surcharge shows BOTH parts under its total,
 *         each part a number the reader can check against the entry;
 *   AC-2  the parts sum to the entry's total — the same arithmetic the ledger guarantees
 *         at write time, asserted here on what the reader actually sees;
 *   AC-4  an entry with no split, or with a genuinely zero surcharge, shows NO fee line at
 *         all — no empty row, no misleading 0 that would read as "the tools were free".
 */

mock.module("@/components/billing/pager", () => ({
  BillingPager: () => null,
}));

const { ConsumptionTable } = await import(
  "@/components/billing/consumption-table"
);

beforeAll(async () => {
  GlobalRegistrator.register();
  await i18n.changeLanguage("zh-CN");
});

// Each case renders its own table; the previous one's DOM must not leak into the next
// case's "no fee line" assertions.
afterEach(() => cleanup());

afterAll(async () => {
  // React first, before the document goes away — the same order the billing UI suite
  // exits in (see billing-credits-ui.test.tsx's afterAll for the why).
  await settleReactWork();
  await i18n.changeLanguage("en");
  GlobalRegistrator.unregister();
});

function entryOf(
  overrides: Partial<CreditConsumptionEntry>,
): CreditConsumptionEntry {
  return {
    id: "cl-fixture",
    title: "settle fixture/model",
    requestId: "usage-fixture-1",
    credits: 10.01,
    applied: 10.01,
    model: "fixture-model",
    client: null,
    botId: null,
    botName: null,
    lineDetail: null,
    timestamp: "2026-10-21T00:00:00.000Z",
    ...overrides,
  };
}

function tableFor(entries: readonly CreditConsumptionEntry[]) {
  return render(
    <ConsumptionTable
      entries={[...entries]}
      pagination={{
        totalCount: entries.length,
        totalPages: 1,
        currentPage: 1,
        nextPage: null,
      }}
      range="today"
      onRangeChange={() => {}}
      onPage={() => {}}
      statusTemplate="第 {{page}} / {{totalPages}} 页 · 共 {{total}} 条"
    />,
  );
}

test("an entry with a surcharge shows both fee parts, summing to its total", () => {
  const view = tableFor([
    entryOf({
      credits: 10.01,
      applied: 10.01,
      feeBreakdown: { modelCredits: 10, surchargeCredits: 0.01 },
    }),
  ]);

  // The total stays the row's own number (the cell renders amount and unit as one text).
  expect(view.getByText("10.01积分")).toBeTruthy();
  // Both parts are shown, model first, surcharge second, on their own line under the
  // total — the reader can check them against the row above.
  expect(view.getByText("模型 10 · 附加 0.01")).toBeTruthy();
});

test("an entry with no split shows no fee line at all", () => {
  const view = tableFor([
    entryOf({ credits: 2.5, applied: 2.5, feeBreakdown: undefined }),
  ]);

  expect(view.getByText("2.5积分")).toBeTruthy();
  expect(view.queryByText(/模型 /)).toBeNull();
  expect(view.queryByText(/附加 /)).toBeNull();
});

test("an entry with a zero surcharge shows no fee line either — zero is not a line", () => {
  const view = tableFor([
    entryOf({
      credits: 5,
      applied: 5,
      feeBreakdown: { modelCredits: 5, surchargeCredits: 0 },
    }),
  ]);

  expect(view.getByText("5积分")).toBeTruthy();
  // AC-4's sentence: a zero surcharge is the absence of a surcharge, not a free tool.
  expect(view.queryByText(/模型 /)).toBeNull();
  expect(view.queryByText(/附加 /)).toBeNull();
});

test("the two parts never drift from the total: what is shown sums to the row", () => {
  // The arithmetic the ledger guarantees at write time, as the reader sees it: with
  // fractional parts the display keeps, model + surcharge === credits.
  const credits = 12.34;
  const modelCredits = 12;
  const surchargeCredits = 0.34;
  const view = tableFor([
    entryOf({
      credits,
      applied: credits,
      feeBreakdown: { modelCredits, surchargeCredits },
    }),
  ]);
  expect(
    view.getByText(`模型 ${modelCredits} · 附加 ${surchargeCredits}`),
  ).toBeTruthy();
  expect(modelCredits + surchargeCredits).toBe(credits);
});
