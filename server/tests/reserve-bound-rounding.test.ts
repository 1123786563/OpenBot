import { describe, expect, test } from "../../tests/support/e2e-compat";
import { readFileSync } from "node:fs";
import {
  PRICE_DIMENSIONS,
  type PriceDimension,
  type PriceDimState,
  type PriceSnapshotDims,
  assertPriceSnapshotDims,
} from "../src/gateway/price-snapshot";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import {
  computeReservationCeiling,
  type ReservationBoundQuantities,
} from "../src/billing/reserve-bound";

/*
 * Bifrost #256 (06.5): the hold-ceiling conversion, as a pure function over the FULL billing
 * dimension vocabulary — every dimension the price snapshot can price contributes its term,
 * never just input/output — and the rounding direction is 足额 (sufficient): the ceiling is the
 * smallest whole CREDIT_SCALE unit that is ≥ the exact possible cost, so a request admitted
 * against it can never spend more than was held (取整方向错误会导致系统性超支).
 *
 * All arithmetic is exact (BigInt rationals end to end); a float anywhere in the chain is a
 * defect. The exact rational the ceiling rounds is returned beside it, so the direction
 * assertions compare the ceiling against the cost itself, not against a re-derived number.
 */

/** 100 credits per USD — a clean rate, with the ledger's ×100 scale that makes 1 USD = 10 000 units. */
const RATE_100: ConversionRate = { numerator: 100n, denominator: 1n };

/** Every dimension priced, with the fixture amounts the integration world seeds as version 1. */
const FULL_DIMS: Readonly<Record<PriceDimension, string>> = {
  input: "0.000001",
  output: "0.000002",
  reasoning: "0.000003",
  image: "0.01",
  image_output: "0.02",
  audio_input: "0.0001",
  audio_output: "0.0002",
  cache_read: "0.0000001",
  cache_write: "0.0000015",
  video: "0.01",
  surcharge_web_search: "0.001",
  surcharge_per_request: "0.0001",
};

/** Quantities sized so every dimension's dollar term is distinct and checkable by hand. */
const FULL_QUANTITIES: ReservationBoundQuantities = {
  input: 2_000_000,
  output: 1_000_000,
  reasoning: 500_000,
  image: 3,
  image_output: 1,
  audio_input: 60,
  audio_output: 30,
  cache_read: 1_000_000,
  cache_write: 100_000,
  video: 10,
  surcharge_web_search: 2,
  surcharge_per_request: 1,
};

function knownDims(
  amounts: Readonly<Record<PriceDimension, string>>,
): PriceSnapshotDims {
  const dims = {} as Record<PriceDimension, PriceDimState>;
  for (const dimension of PRICE_DIMENSIONS) {
    dims[dimension] = { status: "known", amount: amounts[dimension] };
  }
  return assertPriceSnapshotDims(dims, "reserve-bound-rounding fixture");
}

function quantities(
  overrides: Partial<ReservationBoundQuantities> = {},
): ReservationBoundQuantities {
  const base = Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [dimension, 0]),
  ) as ReservationBoundQuantities;
  return { ...base, ...overrides };
}

/** ceiling − exact, as an exact rational's numerator over the given denominator. */
function ceilingMinusExactNumerator(
  ceiling: number,
  exact: { numerator: bigint; denominator: bigint },
): bigint {
  return BigInt(ceiling) * exact.denominator - exact.numerator;
}

describe("computeReservationCeiling — full-dimension conversion", () => {
  test("prices every dimension of the vocabulary, not only input and output", () => {
    const outcome = computeReservationCeiling({
      dims: knownDims(FULL_DIMS),
      quantities: FULL_QUANTITIES,
      rate: RATE_100,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // By hand: $2 + $2 + $1.50 + $0.03 + $0.02 + $0.006 + $0.006 + $0.10 + $0.15 + $0.10
    //          + $0.002 + $0.0001 = $5.9141 → ×100 credits/$ ×100 scale = 59 141 units exactly.
    expect(outcome.maximumCredits).toBe(59_141);
    expect(outcome.exactScaledUnits).toEqual({ numerator: 59_141n, denominator: 1n });
  });

  test("each dimension's term is exactly its quantity × its own price", () => {
    // Only the reasoning dimension carries quantity; its term alone must be the total.
    const outcome = computeReservationCeiling({
      dims: knownDims(FULL_DIMS),
      quantities: quantities({ reasoning: 500_000 }),
      rate: RATE_100,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // $0.000003 × 500 000 = $1.50 → 15 000 scaled units.
    expect(outcome.maximumCredits).toBe(15_000);

    // Only the reserved (not-yet-on-wire) dimensions carry quantity: they price too.
    const reserved = computeReservationCeiling({
      dims: knownDims(FULL_DIMS),
      quantities: quantities({ image_output: 1, audio_input: 60, audio_output: 30, video: 10 }),
      rate: RATE_100,
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    // $0.02 + $0.006 + $0.006 + $0.10 = $0.132 → 1 320 scaled units.
    expect(reserved.maximumCredits).toBe(1_320);
  });

  test("an explicitly free basis (every price exactly 0) has an exact ceiling of 0", () => {
    const free = Object.fromEntries(
      PRICE_DIMENSIONS.map((dimension) => [dimension, "0"]),
    ) as Record<PriceDimension, string>;
    const outcome = computeReservationCeiling({
      dims: knownDims(free),
      quantities: FULL_QUANTITIES,
      rate: RATE_100,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.maximumCredits).toBe(0);
    expect(outcome.exactScaledUnits).toEqual({ numerator: 0n, denominator: 1n });
  });
});

describe("computeReservationCeiling — the 足额 (sufficient) rounding direction", () => {
  test("a fractional exact cost rounds UP to the next whole unit", () => {
    // input $0.0000001 × 1 token → exact 1/1000 of a scaled unit → ceiling 1, never 0.
    const outcome = computeReservationCeiling({
      dims: knownDims({ ...FULL_DIMS, input: "0.0000001" }),
      quantities: quantities({ input: 1 }),
      rate: RATE_100,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.maximumCredits).toBe(1);
    expect(outcome.exactScaledUnits).toEqual({ numerator: 1n, denominator: 1000n });
  });

  test("a fraction introduced by the conversion rate's denominator rounds UP too", () => {
    // 1/3 credits per USD: $0.0001 of input → exact 1/300 scaled unit → ceiling 1.
    const outcome = computeReservationCeiling({
      dims: knownDims({ ...FULL_DIMS, input: "0.000001" }),
      quantities: quantities({ input: 100 }),
      rate: { numerator: 1n, denominator: 3n },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.maximumCredits).toBe(1);
    expect(outcome.exactScaledUnits).toEqual({ numerator: 1n, denominator: 300n });
  });

  test("an exact whole cost keeps its exact value — the ceiling never overshoots by a unit", () => {
    const outcome = computeReservationCeiling({
      dims: knownDims({ ...FULL_DIMS, input: "0.0000015" }),
      quantities: quantities({ input: 1_000 }),
      rate: RATE_100,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // $0.0015 → 15 scaled units exactly; 足额 means the LEAST sufficient integer, not +1.
    expect(outcome.maximumCredits).toBe(15);
    expect(outcome.exactScaledUnits).toEqual({ numerator: 15n, denominator: 1n });
  });

  test("for every case: exact ≤ ceiling < exact + 1 — never under, never a unit over", () => {
    const cases: { dims: PriceSnapshotDims; quantities: ReservationBoundQuantities; rate: ConversionRate }[] = [
      {
        dims: knownDims(FULL_DIMS),
        quantities: FULL_QUANTITIES,
        rate: RATE_100,
      },
      {
        dims: knownDims({ ...FULL_DIMS, input: "0.0000001" }),
        quantities: quantities({ input: 1 }),
        rate: RATE_100,
      },
      {
        dims: knownDims({ ...FULL_DIMS, output: "0.000002" }),
        quantities: quantities({ output: 333_333 }),
        rate: { numerator: 7n, denominator: 13n },
      },
      {
        dims: knownDims({ ...FULL_DIMS, cache_write: "0.0000015", surcharge_web_search: "0.001" }),
        quantities: quantities({ cache_write: 123_457, surcharge_web_search: 3 }),
        rate: { numerator: 250n, denominator: 7n },
      },
    ];
    for (const [index, input] of cases.entries()) {
      const outcome = computeReservationCeiling(input);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      const { maximumCredits, exactScaledUnits } = outcome;
      const aboveExact = ceilingMinusExactNumerator(maximumCredits, exactScaledUnits);
      expect(aboveExact >= 0n).toBe(true); // 上限 ≥ 实际可能成本: never under
      expect(aboveExact < exactScaledUnits.denominator).toBe(true); // tighter than +1: 足额
      expect(Number.isSafeInteger(maximumCredits)).toBe(true);
      expect(maximumCredits).toBeGreaterThanOrEqual(0);
      expect(exactScaledUnits.numerator).toBeGreaterThanOrEqual(0n);
      expect(exactScaledUnits.denominator).toBeGreaterThan(0n);
      // Sanity for the loop body: the case index reaches here only with a full ok outcome.
      expect(typeof index).toBe("number");
    }
  });
});

describe("computeReservationCeiling — refusals", () => {
  test("a dimension the snapshot prices as unknown refuses — unknown is never a zero cost", () => {
    const dims = knownDims(FULL_DIMS);
    dims.cache_write = { status: "unknown", reason: "price_dim_no_source" };
    const outcome = computeReservationCeiling({
      dims,
      quantities: FULL_QUANTITIES,
      rate: RATE_100,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issue).toEqual({
      code: "price_unknown",
      dimension: "cache_write",
      reason: "price_dim_no_source",
    });
  });

  test("an unknown dimension refuses even when its quantity is zero — the basis, not the usage, gates", () => {
    const dims = knownDims(FULL_DIMS);
    dims.video = { status: "unknown", reason: "price_dim_no_source" };
    const outcome = computeReservationCeiling({
      dims,
      quantities: quantities(),
      rate: RATE_100,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issue.code).toBe("price_unknown");
  });

  test("a tampered amount (a known dimension whose amount is not exact) is a thrown defect", () => {
    const dims = knownDims(FULL_DIMS) as Record<PriceDimension, PriceDimState>;
    dims.image_output = { status: "known", amount: "1e-5" };
    expect(() =>
      computeReservationCeiling({
        dims: dims as PriceSnapshotDims,
        quantities: quantities(),
        rate: RATE_100,
      }),
    ).toThrow(TypeError);
  });

  test("a negative, fractional, or missing quantity refuses with the dimension it fails on", () => {
    const negative = computeReservationCeiling({
      dims: knownDims(FULL_DIMS),
      quantities: quantities({ video: -1 }),
      rate: RATE_100,
    });
    expect(negative.ok).toBe(false);
    if (negative.ok) return;
    expect(negative.issue).toEqual({ code: "quantity_invalid", dimension: "video" });

    const fractional = computeReservationCeiling({
      dims: knownDims(FULL_DIMS),
      quantities: quantities({ image: 1.5 }),
      rate: RATE_100,
    });
    expect(fractional.ok).toBe(false);
    if (fractional.ok) return;
    expect(fractional.issue).toEqual({ code: "quantity_invalid", dimension: "image" });

    const incomplete = quantities({ input: 5 });
    delete (incomplete as Record<string, unknown>).output;
    const missing = computeReservationCeiling({
      dims: knownDims(FULL_DIMS),
      quantities: incomplete,
      rate: RATE_100,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.issue).toEqual({ code: "quantity_invalid", dimension: "output" });
  });

  test("a rate with a zero or negative term refuses — it is not an exchange", () => {
    for (const rate of [
      { numerator: 0n, denominator: 1n },
      { numerator: 100n, denominator: 0n },
      { numerator: -1n, denominator: 1n },
    ]) {
      const outcome = computeReservationCeiling({
        dims: knownDims(FULL_DIMS),
        quantities: quantities({ input: 1 }),
        rate,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.issue).toEqual({ code: "rate_invalid" });
    }
  });

  test("a ceiling beyond the 32-bit ledger column refuses instead of stranding the hold", () => {
    // $214 749 × 10 000 units/$ > 2 147 483 647: no 32-bit ledger row could ever settle it.
    const over = computeReservationCeiling({
      dims: knownDims({ ...FULL_DIMS, input: "1" }),
      quantities: quantities({ input: 214_749 }),
      rate: RATE_100,
    });
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.issue).toEqual({ code: "ceiling_exceeds_ledger" });
  });

  test("a ceiling exactly inside the 32-bit bound passes — the boundary is inclusive", () => {
    // $214 748 + $0.00000648 → exact 2 147 480 000.0648 → ceiling 2 147 480 001 ≤ 2^31−1.
    const inside = computeReservationCeiling({
      dims: knownDims({ ...FULL_DIMS, input: "1", surcharge_per_request: "0.00000648" }),
      quantities: quantities({ input: 214_748, surcharge_per_request: 1 }),
      rate: RATE_100,
    });
    expect(inside.ok).toBe(true);
    if (!inside.ok) return;
    expect(inside.maximumCredits).toBe(2_147_480_001);
  });
});

describe("the module's own discipline", () => {
  test("the ceiling module never reads the latest price or the latest rate", () => {
    const source = readFileSync(
      new URL("../src/billing/reserve-bound.ts", import.meta.url),
      "utf8",
    );
    // 结算禁止读最新价格/比例 (AC12): the lock resolver may name the locked-version reads
    // (priceSnapshot, readRateVersion) but never the latest-price/latest-rate reads.
    expect(source).not.toContain("latestPriceSnapshot");
    expect(source).not.toContain("readConversionRate");
    expect(source).not.toContain("rateVersionAt");
  });
});
