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
  // Stamp built from local-clock parts at local noon: fillDays keys each day by the cursor's local
  // date, so a fixed UTC-midnight stamp reads as the previous local day west of UTC. Local noon
  // cannot cross a day boundary under any ordinary UTC offset, DST shifts included.
  const localIso = (year: number, month: number, day: number): string =>
    new Date(year, month - 1, day, 12).toISOString();

  test("fills the missing days with zero buckets", () => {
    const filled = fillDays(
      localIso(2026, 10, 1),
      localIso(2026, 10, 4),
      [{ date: "2026-10-02", tokens: 5, inputTokens: 2, outputTokens: 3, calls: 1 }],
    );
    expect(filled.map((day) => day.date)).toEqual([
      "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
    ]);
    expect(filled[1].tokens).toBe(5);
    expect(filled[0].tokens).toBe(0);
  });
  test("caps a pathological span at 62 days", () => {
    const filled = fillDays(localIso(2026, 1, 1), localIso(2027, 1, 1), []);
    expect(filled.length).toBeLessThanOrEqual(62);
  });
});
