import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { KpiCard } from "@/components/billing/kpi-card";
import { fillDays } from "@/components/billing/usage-chart";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("KpiCard renders label and value", () => {
  // `screen` binds `document.body` at import time, before `GlobalRegistrator` has run, so the
  // queries come from `render`'s own view — the harness every other component test here uses.
  const view = render(<KpiCard label="总 tokens" value="1,204,556" />);
  expect(view.getByText("总 tokens")).toBeTruthy();
  expect(view.getByText("1,204,556")).toBeTruthy();
});

describe("fillDays", () => {
  test("fills the missing days with zero buckets", () => {
    const filled = fillDays(
      "2026-10-01T00:00:00Z",
      "2026-10-04T00:00:00Z",
      [{ date: "2026-10-02", tokens: 5, inputTokens: 2, outputTokens: 3, calls: 1 }],
    );
    expect(filled.map((day) => day.date)).toEqual([
      "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
    ]);
    expect(filled[1].tokens).toBe(5);
    expect(filled[0].tokens).toBe(0);
  });
  test("caps a pathological span at 62 days", () => {
    const filled = fillDays("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z", []);
    expect(filled.length).toBeLessThanOrEqual(62);
  });
});
