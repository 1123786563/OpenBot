import "./preload";
import "./preload";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import { money, period, totalTokensOf } from "@/lib/billing/format";

describe("money", () => {
  test("formats cents in the plan's currency", () => {
    expect(money(19900, "CNY")).toContain("199");
  });
  test("tolerates a missing currency", () => {
    expect(money(100, undefined)).toBeTruthy();
  });
});

describe("period", () => {
  test("joins both ends with an en dash", () => {
    const text = period("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z");
    expect(text).toContain("–");
  });
  test("answers empty for a missing period", () => {
    expect(period(undefined, undefined)).toBe("");
  });
});

describe("totalTokensOf", () => {
  test("sums the units of every charge", () => {
    expect(totalTokensOf([{ units: "1.5" }, { units: "2" }])).toBe(3.5);
  });
  test("treats a non-numeric unit as zero", () => {
    expect(totalTokensOf([{ units: "abc" }])).toBe(0);
  });
});
