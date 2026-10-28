import { describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  assessRerankEnablement,
  countRerankInputTokens,
  RERANK_BILLED_DIMENSIONS,
  RERANK_PER_DOCUMENT_OVERHEAD_TOKENS,
  rerankRequestShape,
} from "../src/billing/rerank-pricing";
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
 * Bifrost #298 (11.3): the rerank pricing boundary — the dimension mapping, the
 * query+documents counter, and the enablement gate — as a pure-function suite over fixture
 * dims in 03.2's exact snapshot shape, in 11.1's (#296) own discipline.
 *
 * WHAT THE ACs DEMAND OF THESE TESTS:
 *   Rerank 的全部上游计费维度进入价格快照 — the mapping reads the rerank-billed dimensions
 *     from the full snapshot dims and answers each known/unknown exactly; the token side AND
 *     the document-count side both map (the Resume hint: 只按其一实现会系统性低估上限).
 *   文档与查询按完整内容计数，不因截断低估 — the counter serializes the WHOLE request:
 *     the query and every document's full text are inside the count (fixtures pin that the
 *     count grows with content AND document count); uncountable shapes refuse.
 *   缺维度时标记 unknown 且不启用 — each missing billed dimension refuses with its own
 *     reason and never produces a 0-cost pass; the ceiling conversion refuses the same
 *     snapshot (price_unknown) so no hold could form on it.
 *   启用后的预留上限覆盖最坏情况 — complete dims + countable input → enabled, and the
 *     composed ceiling covers tokens × input price + documents × flat price, 足额 upward.
 *
 * The rankings-output evidence is pinned from both sides: the quantities certify 0 for every
 * non-billed dimension, and a KNOWN non-zero output price contributes nothing to the composed
 * ceiling — a rerank response's payload is scores and indices, with no field an output-token
 * price could multiply against (the upstream evidence is the field's absence, as in 11.1).
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
  video_input: "0.0001",
  surcharge_web_search: "0.001",
  surcharge_per_request: "0.0001",
  surcharge_tool_call: "0.002",
  surcharge_a2a_call: "0.003",
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
    "rerank-pricing fixture",
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

describe("the rerank billed-dimension set", () => {
  test("bills exactly input tokens and the flat per-request surcharge", () => {
    expect([...RERANK_BILLED_DIMENSIONS]).toEqual([
      "input",
      "surcharge_per_request",
    ]);
  });

  test("the enablement reads only the billed dimensions from the full snapshot", () => {
    // A snapshot where the billed pair is known but other wire dims are unknown: the rerank
    // verdict is about ITS dimensions — the cell's own 03.3 classification is the filter's
    // question, and a variant is its own cell, never a discount here.
    const verdict = assessRerankEnablement({
      dims: dims({
        output: unknown(),
        reasoning: unknown("price_dim_unreadable"),
        cache_read: unknown(),
      }),
      params: { model: "rerank-v2", query: "q", documents: ["a", "b"] },
    });
    expect(verdict.enabled).toBe(true);
  });
});

// ── AC2: the query+documents counter ──

describe("countRerankInputTokens", () => {
  test("counts a single-document request conservatively, query included", () => {
    const params = {
      model: "rerank-v2",
      query: "what is the capital of france",
      documents: ["Paris is the capital of France."],
    };
    const counted = countRerankInputTokens(params);
    expect(counted).not.toBeNull();
    // Conservative ABOVE the byte floor: the serialized request is the whole payload, so
    // the count must exceed bytes/2 and include the per-document overhead.
    const bytes = Buffer.byteLength(JSON.stringify(params), "utf8");
    expect(counted!).toBeGreaterThan(bytes / 2);
    expect(counted!).toBeGreaterThanOrEqual(
      Math.ceil((bytes / 2) * 1.25) + RERANK_PER_DOCUMENT_OVERHEAD_TOKENS,
    );
    // The query is inside the count: dropping it from the payload shrinks the count.
    const withoutQuery = countRerankInputTokens({
      model: "rerank-v2",
      query: "",
      documents: ["Paris is the capital of France."],
    });
    expect(withoutQuery!).toBeLessThan(counted!);
  });

  test("every document's full text is inside the count — none escapes", () => {
    const single = countRerankInputTokens({
      model: "m",
      query: "q",
      documents: ["x".repeat(10_000)],
    });
    const many = countRerankInputTokens({
      model: "m",
      query: "q",
      documents: Array.from({ length: 10 }, () => "x".repeat(10_000)),
    });
    expect(single).not.toBeNull();
    expect(many).not.toBeNull();
    // The Resume hint's trap: a counter that counted one document's text would answer the
    // single's count. The batch must be ~10× the single plus 10 documents' overhead.
    expect(many!).toBeGreaterThan(single! * 9);
    expect(rerankRequestShape({ documents: ["a", "b", "c"] })).toEqual({
      documents: 3,
    });
  });

  test("object documents ({ text }) serialize and count in full", () => {
    const counted = countRerankInputTokens({
      model: "m",
      query: "q",
      documents: [{ text: "full body one" }, { text: "full body two" }],
    });
    expect(counted).not.toBeNull();
    expect(counted!).toBeGreaterThan(0);
    expect(rerankRequestShape({ documents: [{ text: "a" }, "b"] })).toEqual({
      documents: 2,
    });
  });

  test("the per-document overhead grows with the document count", () => {
    const one = countRerankInputTokens({
      model: "m",
      query: "q",
      documents: ["same text"],
    });
    const five = countRerankInputTokens({
      model: "m",
      query: "q",
      documents: [
        "same text",
        "same text",
        "same text",
        "same text",
        "same text",
      ],
    });
    expect(five! - one!).toBeGreaterThanOrEqual(
      4 * RERANK_PER_DOCUMENT_OVERHEAD_TOKENS,
    );
  });

  test("uncountable shapes refuse instead of guessing", () => {
    // No documents at all is not a rerank this module can certify (ranking needs
    // candidates; an empty candidate set is the wire's own refusal).
    expect(
      countRerankInputTokens({ model: "m", query: "q", documents: [] }),
    ).toBeNull();
    // A missing or non-string query cannot be counted in full.
    expect(countRerankInputTokens({ model: "m", documents: ["a"] })).toBeNull();
    expect(
      countRerankInputTokens({ model: "m", query: 42, documents: ["a"] }),
    ).toBeNull();
    // A document entry whose text cannot be named in full.
    expect(
      countRerankInputTokens({ model: "m", query: "q", documents: [42] }),
    ).toBeNull();
    expect(
      countRerankInputTokens({
        model: "m",
        query: "q",
        documents: [{ text: 7 }],
      }),
    ).toBeNull();
    expect(
      countRerankInputTokens({
        model: "m",
        query: "q",
        documents: "not-an-array",
      }),
    ).toBeNull();
    expect(countRerankInputTokens("not even a request object")).toBeNull();
    expect(rerankRequestShape({ documents: [{ noText: true }] })).toBeNull();
  });
});

// ── AC3/AC4: the enablement gate ──

describe("assessRerankEnablement", () => {
  const PARAMS = {
    model: "rerank-v2",
    query: "capital of france",
    documents: ["Paris is the capital.", "Lyon is a city in France."],
  };

  test("complete dimensions and a countable input enable the capability", () => {
    const verdict = assessRerankEnablement({ dims: dims(), params: PARAMS });
    expect(verdict).toMatchObject({ enabled: true, free: false, documents: 2 });
    if (!verdict.enabled) return;
    expect(verdict.inputTokens).toBe(countRerankInputTokens(PARAMS));
    expect(verdict.quantities.input).toBe(verdict.inputTokens);
    // The per-DOCUMENT surcharge quantity: the worst case a ceiling must cover when an
    // upstream bills per document (the hint's "按文档数" side), not 1.
    expect(verdict.quantities.surcharge_per_request).toBe(2);
    // The rankings-output evidence, stated numerically: nothing else is billed.
    for (const dimension of PRICE_DIMENSIONS) {
      if (dimension === "input" || dimension === "surcharge_per_request")
        continue;
      expect(verdict.quantities[dimension]).toBe(0);
    }
  });

  test("an unknown input-token price refuses with the dimension and its reason", () => {
    const verdict = assessRerankEnablement({
      dims: dims({ input: unknown() }),
      params: PARAMS,
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: {
        code: "rerank_price_unknown",
        dimension: "input",
        reason: "price_dim_no_source",
      },
    });
  });

  test("an unreadable billed price refuses with the unreadable reason", () => {
    const verdict = assessRerankEnablement({
      dims: dims({ surcharge_per_request: unknown("price_dim_unreadable") }),
      params: PARAMS,
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: {
        code: "rerank_price_unknown",
        dimension: "surcharge_per_request",
        reason: "price_dim_unreadable",
      },
    });
  });

  test("a missing dimension is never a 0-cost pass — the ceiling refuses the same basis", () => {
    const missing = dims({ input: unknown() });
    const verdict = assessRerankEnablement({
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
    const verdict = assessRerankEnablement({
      dims: dims({
        input: { status: "known", amount: "0" },
        surcharge_per_request: { status: "known", amount: "0" },
      }),
      params: PARAMS,
    });
    expect(verdict).toMatchObject({ enabled: true, free: true });
  });

  test("an uncountable input refuses regardless of the prices", () => {
    const verdict = assessRerankEnablement({
      dims: dims(),
      params: { model: "m", query: "q", documents: [] },
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: { code: "rerank_input_uncountable", shape: "documents_empty" },
    });
    const noQuery = assessRerankEnablement({
      dims: dims(),
      params: { model: "m", documents: ["a"] },
    });
    expect(noQuery).toEqual({
      enabled: false,
      issue: { code: "rerank_input_uncountable", shape: "query_not_string" },
    });
  });

  test("the composed ceiling covers the worst case, and a known output price adds nothing", () => {
    const verdict = assessRerankEnablement({ dims: dims(), params: PARAMS });
    expect(verdict.enabled).toBe(true);
    if (!verdict.enabled) return;
    const priced = computeReservationCeiling({
      dims: dims(),
      quantities: verdict.quantities,
      rate: RATE_100,
    });
    expect(priced.ok).toBe(true);
    if (!priced.ok) return;

    // Worst case, exactly: tokens × input price + documents × flat price, in scaled units
    // (×100 more for CREDIT_SCALE). The ceiling is 足额 — ≥ this, never below it.
    const inputPerToken = Number(FULL_AMOUNTS.input) * 100 * 100; // USD → credits → scale
    const perDocument = Number(FULL_AMOUNTS.surcharge_per_request) * 100 * 100;
    const worstCase =
      verdict.inputTokens * inputPerToken + verdict.documents * perDocument;
    expect(priced.maximumCredits).toBeGreaterThanOrEqual(worstCase - 1e-6);

    // The rankings-output evidence from the price side: zero out the non-billed prices and
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
