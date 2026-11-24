import { describe, expect, test } from "bun:test";
import {
  advancePurchasePeriod,
  firstBillingPeriod,
  nextBillingPeriod,
  withinPeriod,
  type BillingPeriod,
} from "../src/billing/billing-period";

/** Beijing wall-clock instant from UTC calendar parts. */
const beijing = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
) => new Date(Date.UTC(year, month - 1, day, hour - 8, minute));

const utc = (iso: string) => new Date(iso);

function iso(period: BillingPeriod) {
  return {
    start: period.start.toISOString(),
    end: period.end.toISOString(),
    anchorDay: period.anchorDay,
  };
}

describe("first payment anchors a Beijing calendar month", () => {
  test("a mid-month payment renews on its anchor day", () => {
    const period = firstBillingPeriod(beijing(2026, 1, 10, 20, 30));
    expect(iso(period)).toEqual({
      start: "2026-01-10T12:30:00.000Z",
      end: "2026-02-09T16:00:00.000Z", // Beijing 2026-02-10 00:00
      anchorDay: 10,
    });
  });

  test("the anchor is the Beijing day even when UTC has rolled over", () => {
    // 2026-05-01 00:30 Beijing is 2026-04-30 16:30 UTC.
    const period = firstBillingPeriod(beijing(2026, 5, 1, 0, 30));
    expect(period.anchorDay).toBe(1);
    expect(period.end.toISOString()).toBe("2026-05-31T16:00:00.000Z");
  });
});

describe("renewals keep the anchor and survive short months", () => {
  test("an anchor of the 31st takes February's end and recovers in March", () => {
    let period = firstBillingPeriod(beijing(2026, 1, 31, 9));
    expect(period.end.toISOString()).toBe("2026-02-27T16:00:00.000Z"); // Beijing Feb 28 00:00
    period = nextBillingPeriod(period);
    expect(period.end.toISOString()).toBe("2026-03-30T16:00:00.000Z"); // Beijing Mar 31 00:00
    period = nextBillingPeriod(period);
    expect(period.end.toISOString()).toBe("2026-04-29T16:00:00.000Z"); // Beijing Apr 30 00:00
    period = nextBillingPeriod(period);
    expect(period.end.toISOString()).toBe("2026-05-30T16:00:00.000Z"); // Beijing May 31 00:00
  });

  test("a leap-year February clamps to the 29th and the anchor returns", () => {
    let period = firstBillingPeriod(beijing(2028, 1, 30, 12));
    expect(period.end.toISOString()).toBe("2028-02-28T16:00:00.000Z"); // Beijing Feb 29 00:00
    period = nextBillingPeriod(period);
    expect(period.end.toISOString()).toBe("2028-03-29T16:00:00.000Z"); // Beijing Mar 30 00:00
  });

  test("an anchor that always fits never clamps", () => {
    let period = firstBillingPeriod(beijing(2026, 2, 15, 8));
    expect(period.end.toISOString()).toBe("2026-03-14T16:00:00.000Z");
    for (const expected of [
      "2026-04-14T16:00:00.000Z",
      "2026-05-14T16:00:00.000Z",
      "2026-06-14T16:00:00.000Z",
    ]) {
      period = nextBillingPeriod(period);
      expect(period.end.toISOString()).toBe(expected);
    }
  });

  test("a December renewal crosses the year boundary", () => {
    const period = firstBillingPeriod(beijing(2026, 12, 31, 22));
    expect(period.end.toISOString()).toBe("2027-01-30T16:00:00.000Z");
  });
});

describe("gap re-purchase and advance purchase", () => {
  test("a gap re-purchase builds a fresh anchor from the new payment", () => {
    const lapsed = firstBillingPeriod(beijing(2026, 3, 20, 10));
    const later = beijing(2026, 7, 5, 15);
    const reopened = firstBillingPeriod(later);
    expect(reopened.anchorDay).toBe(5);
    expect(reopened.start).toBe(later);
    expect(withinPeriod(lapsed, later)).toBe(false);
  });

  test("an advance purchase takes effect at the current period's end", () => {
    const current = firstBillingPeriod(beijing(2026, 6, 10, 9));
    const replacement = advancePurchasePeriod(current);
    expect(replacement.start).toEqual(current.end);
    expect(withinPeriod(current, replacement.start)).toBe(false);
    expect(withinPeriod(replacement, current.end)).toBe(true);
  });
});

describe("membership at the boundaries", () => {
  test("the boundary instant belongs to the next period only", () => {
    const current = firstBillingPeriod(beijing(2026, 2, 1, 12));
    const next = nextBillingPeriod(current);
    expect(withinPeriod(current, next.start)).toBe(false);
    expect(withinPeriod(current, new Date(next.start.getTime() - 1))).toBe(
      true,
    );
  });

  test("a UTC instant late in the Beijing day still counts for that day", () => {
    const period = firstBillingPeriod(beijing(2026, 8, 9, 23, 59));
    expect(withinPeriod(period, utc("2026-08-09T15:59:30.000Z"))).toBe(true);
  });
});
