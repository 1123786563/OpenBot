import { describe, expect, test } from "bun:test";
import { summarizeCapacity } from "../src/billing/credits";
import type { GrantCapacity } from "../src/billing/capacity";

const grant = (over: Partial<GrantCapacity> = {}): GrantCapacity => ({
  id: "cg-1",
  source: "plan",
  total: 10_000,
  used: 1_000,
  held: 0,
  free: 9_000,
  expiresAt: new Date(Date.now() + 86_400_000),
  ...over,
});

describe("summarizeCapacity", () => {
  test("held capacity is not spendable and is reported separately", () => {
    const summary = summarizeCapacity([grant({ held: 2_100, free: 6_900 })]);
    expect(summary.plan.total).toBe(100);
    expect(summary.plan.used).toBe(10);
    expect(summary.plan.held).toBe(21);
    expect(summary.plan.remaining).toBe(69);
  });

  test("a grant drawn to zero by a hold counts as held, not as remaining", () => {
    const summary = summarizeCapacity([grant({ held: 10_000, free: 0 })]);
    expect(summary.plan.remaining).toBe(0);
    expect(summary.plan.held).toBe(100);
  });

  test("reward grantCount counts exactly the grants that still have remaining", () => {
    const summary = summarizeCapacity([
      grant({
        id: "cg-a",
        source: "promo",
        total: 5_000,
        used: 5_000,
        free: 0,
      }),
      grant({
        id: "cg-b",
        source: "signin",
        total: 5_000,
        used: 0,
        free: 5_000,
      }),
      grant({
        id: "cg-c",
        source: "promo",
        total: 5_000,
        used: 0,
        held: 5_000,
        free: 0,
      }),
    ]);
    expect(summary.rewards.grantCount).toBe(1);
    expect(summary.rewards.remaining).toBe(50);
    expect(summary.rewards.held).toBe(50);
  });

  test("an empty ledger is all zeros, never NaN", () => {
    expect(summarizeCapacity([])).toEqual({
      plan: { total: 0, used: 0, remaining: 0, held: 0 },
      rewards: { total: 0, used: 0, remaining: 0, held: 0, grantCount: 0 },
    });
  });
});
