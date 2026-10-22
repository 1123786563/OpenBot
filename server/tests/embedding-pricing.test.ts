import { describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  assessEmbeddingEnablement,
  countEmbeddingInputTokens,
  EMBEDDING_BILLED_DIMENSIONS,
  EMBEDDING_PER_ENTRY_OVERHEAD_TOKENS,
  embeddingEntryCount,
} from "../src/billing/embedding-pricing";
import { computeReservationCeiling } from "../src/billing/reserve-bound";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import {
  assertPriceSnapshotDims,
  PRICE_DIMENSIONS,
  type PriceDimension,
  type PriceDimState,
  type PriceSnapshotDims,
} from "../src/gateway/price-snapshot";

/*
 * Bifrost #296 (11.1): the embedding pricing boundary — the dimension mapping, the batch
 * input counter, and the enablement verdict — as a pure-function suite over fixture dims
 * in 03.2's exact snapshot shape.
 *
 * WHAT THE ACs DEMAND OF THESE TESTS:
 *   全部上游计费维度都进入价格快照 — the mapping reads the embedding-billed dimensions
 *     from the full snapshot dims and answers each known/unknown exactly (multi-dim
 *     fixture), with model variants being separate cells (nothing derives one from
 *     another).
 *   输入按完整序列化计数，批量条目不遗漏 — the counter serializes the WHOLE request:
 *     every batch entry's full text is inside the count (a fixture with long texts and
 *     many entries pins that the count grows with content AND entry count), and
 *     uncountable shapes refuse instead of guessing.
 *   维度齐备且证据可强制时该能力可启用 — complete dims + countable input → enabled,
 *     with quantities ready for 06.5's ceiling; the composed ceiling covers the worst
 *     case (tokens × input price + entries × flat price, 足额 upward).
 *   缺维度时标记 unknown，不启用且不按 0 成本放行 — each missing billed dimension
 *     refuses with its own reason code and never produces a 0-cost pass; the ceiling
 *     conversion refuses the same snapshot (price_unknown) so no hold could form on it.
 *
 * The vector-output evidence is pinned from both sides: the quantities certify 0 for
 * every non-billed dimension, and a KNOWN non-zero output price contributes nothing to
 * the composed ceiling (the wire's usage carries no output-token field to multiply it
 * by — the upstream evidence is the field's absence).
 */

/** 100 credits per USD — with the ledger's ×100 scale, 1 USD = 10 000 units. */
const RATE_100: ConversionRate = { numerator: 100n, denominator: 1n };

/** Every dimension priced, in the fixture style 06.5's own suite uses. */
const FULL_AMOUNTS: Readonly<Record<PriceDimension, string>> = {
  input: "0.0000001",
  output: "0.0000002",
  reasoning: "0.0000003",
  image: "0.01",
  image_output: "0.02",
  audio_input: "0.0001",
  audio_output: "0.0002",
  cache_read: "0.00000001",
  cache_write: "0.000000015",
  video: "0.01",
  surcharge_web_search: "0.001",
  surcharge_per_request: "0.0001",
};

/** Build 03.2-shaped dims: every dimension of the vocabulary, known or unknown. */
function dims(
  overrides: Partial<Record<PriceDimension, PriceDimState>> = {},
): PriceSnapshotDims {
  const base = {} as Record<PriceDimension, PriceDimState>;
  for (const dimension of PRICE_DIMENSIONS) {
    base[dimension] = { status: "known", amount: FULL_AMOUNTS[dimension] };
  }
  return assertPriceSnapshotDims(
    { ...base, ...overrides },
    "embedding-pricing fixture",
  );
}

function unknown(
  reason:
    | "price_dim_no_source"
    | "price_dim_unreadable" = "price_dim_no_source",
): PriceDimState {
  return { status: "unknown", reason };
}

// ── AC1: the dimension mapping ──

describe("the embedding billed-dimension set", () => {
  test("bills exactly input tokens and the flat per-request surcharge", () => {
    expect([...EMBEDDING_BILLED_DIMENSIONS]).toEqual([
      "input",
      "surcharge_per_request",
    ]);
  });

  test("the enablement reads only the billed dimensions from the full snapshot", () => {
    // A snapshot where the billed pair is known but other wire dims are unknown: the
    // embedding verdict is about ITS dimensions — the cell's own 03.3 classification is
    // the filter's question, and a variant is its own cell, never a discount here.
    const verdict = assessEmbeddingEnablement({
      dims: dims({
        output: unknown(),
        reasoning: unknown("price_dim_unreadable"),
        cache_read: unknown(),
      }),
      params: { model: "text-embedding-3-small", input: "hello world" },
    });
    expect(verdict.enabled).toBe(true);
  });
});

// ── AC2: the batch input counter ──

describe("countEmbeddingInputTokens", () => {
  test("counts a single string input conservatively", () => {
    const params = { model: "text-embedding-3-small", input: "hello world" };
    const counted = countEmbeddingInputTokens(params);
    expect(counted).not.toBeNull();
    // Conservative ABOVE the byte floor: the serialized request is ~50 bytes, so the
    // count must exceed bytes/2 and include the per-entry overhead.
    const bytes = Buffer.byteLength(JSON.stringify(params), "utf8");
    expect(counted!).toBeGreaterThan(bytes / 2);
    expect(counted!).toBeGreaterThanOrEqual(
      Math.ceil((bytes / 2) * 1.25) + EMBEDDING_PER_ENTRY_OVERHEAD_TOKENS,
    );
  });

  test("a batch's every entry is inside the count — no entry escapes", () => {
    const single = countEmbeddingInputTokens({
      model: "m",
      input: "x".repeat(10_000),
    });
    const batch = countEmbeddingInputTokens({
      model: "m",
      input: Array.from({ length: 10 }, () => "x".repeat(10_000)),
    });
    expect(single).not.toBeNull();
    expect(batch).not.toBeNull();
    // The Resume hint's trap: a counter that counted one entry's text would answer the
    // single's count. The batch must be ~10× the single (byte serialization includes
    // every entry's full text) plus 10 entries' overhead.
    expect(batch!).toBeGreaterThan(single! * 9);
    const entries = embeddingEntryCount({
      input: Array.from({ length: 10 }, () => "x"),
    });
    expect(entries).toEqual({ entries: 10, shape: "array" });
  });

  test("pre-tokenized inputs (token arrays) serialize and count in full", () => {
    const counted = countEmbeddingInputTokens({
      model: "m",
      input: [
        [1, 2051, 13_462, 8_899, 302, 1_000_000],
        [1, 2051],
      ],
    });
    expect(counted).not.toBeNull();
    expect(counted!).toBeGreaterThan(0);
    expect(embeddingEntryCount({ input: [[1], [2], [3]] })).toEqual({
      entries: 3,
      shape: "array",
    });
  });

  test("the per-entry overhead grows with the entry count", () => {
    const one = countEmbeddingInputTokens({
      model: "m",
      input: ["same text"],
    });
    const five = countEmbeddingInputTokens({
      model: "m",
      input: ["same text", "same text", "same text", "same text", "same text"],
    });
    expect(five! - one!).toBeGreaterThanOrEqual(
      4 * EMBEDDING_PER_ENTRY_OVERHEAD_TOKENS,
    );
  });

  test("uncountable shapes refuse instead of guessing", () => {
    expect(countEmbeddingInputTokens({ model: "m" })).toBeNull();
    expect(countEmbeddingInputTokens({ model: "m", input: 42 })).toBeNull();
    expect(
      countEmbeddingInputTokens({ model: "m", input: { nested: true } }),
    ).toBeNull();
    expect(countEmbeddingInputTokens("not even a request object")).toBeNull();
    // A shape the counter would happily serialize but that is not an embeddings input:
    expect(embeddingEntryCount({ input: true })).toBeNull();
  });
});

// ── AC3/AC4: the enablement verdict ──

describe("assessEmbeddingEnablement", () => {
  const PARAMS = {
    model: "text-embedding-3-small",
    input: ["first entry", "second entry"],
  };

  test("complete dimensions and a countable input enable the capability", () => {
    const verdict = assessEmbeddingEnablement({ dims: dims(), params: PARAMS });
    expect(verdict).toMatchObject({ enabled: true, free: false, entries: 2 });
    if (!verdict.enabled) return;
    expect(verdict.inputTokens).toBe(countEmbeddingInputTokens(PARAMS));
    expect(verdict.quantities.input).toBe(verdict.inputTokens);
    expect(verdict.quantities.surcharge_per_request).toBe(2);
    // The vector-output evidence, stated numerically: nothing else is billed.
    for (const dimension of PRICE_DIMENSIONS) {
      if (dimension === "input" || dimension === "surcharge_per_request")
        continue;
      expect(verdict.quantities[dimension]).toBe(0);
    }
  });

  test("an unknown input-token price refuses with the dimension and its reason", () => {
    const verdict = assessEmbeddingEnablement({
      dims: dims({ input: unknown() }),
      params: PARAMS,
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: {
        code: "embedding_price_unknown",
        dimension: "input",
        reason: "price_dim_no_source",
      },
    });
  });

  test("an unreadable billed price refuses with the unreadable reason", () => {
    const verdict = assessEmbeddingEnablement({
      dims: dims({ surcharge_per_request: unknown("price_dim_unreadable") }),
      params: PARAMS,
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: {
        code: "embedding_price_unknown",
        dimension: "surcharge_per_request",
        reason: "price_dim_unreadable",
      },
    });
  });

  test("a missing dimension is never a 0-cost pass — the ceiling refuses the same basis", () => {
    const missing = dims({ input: unknown() });
    const verdict = assessEmbeddingEnablement({
      dims: missing,
      params: PARAMS,
    });
    expect(verdict.enabled).toBe(false);
    // And no hold could form on it: the quantity side is fine, the PRICE side refuses.
    const fullZero = Object.fromEntries(
      PRICE_DIMENSIONS.map((dimension) => [dimension, 0]),
    ) as Record<PriceDimension, number>;
    const priced = computeReservationCeiling({
      dims: missing,
      quantities: fullZero,
      rate: RATE_100,
    });
    expect(priced).toMatchObject({
      ok: false,
      issue: { code: "price_unknown", dimension: "input" },
    });
  });

  test("explicitly free billed prices enable as FREE — free is a price, not a pass", () => {
    const verdict = assessEmbeddingEnablement({
      dims: dims({
        input: { status: "known", amount: "0" },
        surcharge_per_request: { status: "known", amount: "0" },
      }),
      params: PARAMS,
    });
    expect(verdict).toMatchObject({ enabled: true, free: true });
  });

  test("an uncountable input refuses regardless of the prices", () => {
    const verdict = assessEmbeddingEnablement({
      dims: dims(),
      params: { model: "m", input: null },
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: {
        code: "embedding_input_uncountable",
        shape: "input_not_string_or_array",
      },
    });
  });

  test("the composed ceiling covers the worst case, and a known output price adds nothing", () => {
    const verdict = assessEmbeddingEnablement({ dims: dims(), params: PARAMS });
    expect(verdict.enabled).toBe(true);
    if (!verdict.enabled) return;
    const priced = computeReservationCeiling({
      dims: dims(),
      quantities: verdict.quantities,
      rate: RATE_100,
    });
    expect(priced.ok).toBe(true);
    if (!priced.ok) return;

    // Worst case, exactly: tokens × input price + entries × flat price, in scaled units
    // (×100 more for CREDIT_SCALE). The ceiling is 足额 — ≥ this, never below it.
    const inputPerToken = Number(FULL_AMOUNTS.input) * 100 * 100; // USD → credits → scale
    const perRequest = Number(FULL_AMOUNTS.surcharge_per_request) * 100 * 100;
    const worstCase =
      verdict.inputTokens * inputPerToken + verdict.entries * perRequest;
    expect(priced.maximumCredits).toBeGreaterThanOrEqual(worstCase - 1e-6);

    // The vector-output evidence from the price side: zero out the non-billed prices and
    // the ceiling does not move — output &co multiply against quantity 0 no matter what
    // they cost.
    const withoutOutput = dims(
      Object.fromEntries(
        PRICE_DIMENSIONS.filter(
          (dimension) =>
            dimension !== "input" && dimension !== "surcharge_per_request",
        ).map((dimension) => [
          dimension,
          { status: "known" as const, amount: "0" },
        ]),
      ) as Partial<Record<PriceDimension, PriceDimState>>,
    );
    const pricedWithout = computeReservationCeiling({
      dims: withoutOutput,
      quantities: verdict.quantities,
      rate: RATE_100,
    });
    expect(pricedWithout).toEqual(priced);
  });
});
