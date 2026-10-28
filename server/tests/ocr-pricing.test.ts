import { describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  assessOcrEnablement,
  OCR_BILLED_DIMENSIONS,
  ocrCeiling,
  ocrRequestShape,
} from "../src/billing/ocr-pricing";
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
 * Bifrost #300 (11.5): the OCR pricing boundary — the page/image/output dimension mapping,
 * the pre-dispatch page determination, and the enablement verdict — as a pure-function suite
 * over fixture dims in 03.2's exact snapshot shape, in 11.1's (#296) and 14.1's (#310) own
 * discipline.
 *
 * WHAT THE ACs DEMAND OF THESE TESTS:
 *   OCR 的页数、图像与输出维度都进入价格快照 — the mapping bills exactly the three sides
 *     upstream OCR pricing denominates (页/图像/输出 token), each riding the closed
 *     vocabulary's own member: the per-page price on the flat dimension (BifrostCost's
 *     RequestCost "also OCR per-page"), the per-image price on `image`, the output price on
 *     `output`.
 *   页数与图像规格在派发前可确定，否则不启用 — a document whose page count the request
 *     does not pin (no params.pages selection) refuses as 证据不足, never as an estimate;
 *     a pinned selection certifies every named page (多页请求的上限覆盖全部页).
 *   缺维度时标记 unknown，不按 0 成本执行 — each missing billed dimension refuses with
 *     its own reason and never produces a 0-cost pass; the ceiling conversion refuses the
 *     same snapshot so no hold could form on it.
 *
 * The usage-schema evidence is pinned from both sides: the quantities certify 0 for every
 * non-billed dimension, and a KNOWN non-zero input price contributes nothing to the composed
 * ceiling — an OCR response's usage_info carries pages_processed and doc_size_bytes only,
 * with no field an input-token price could multiply against (the upstream evidence is the
 * field's absence, as in 11.1).
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
  /** The per-page price an OCR ref carries on the wire's flat field. */
  surcharge_per_request: "0.01",
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
    "ocr-pricing fixture",
  );
}

function unknown(
  reason:
    | "price_dim_no_source"
    | "price_dim_unreadable" = "price_dim_no_source",
): PriceDimState {
  return { status: "unknown", reason };
}

/** A document request over a pinned page selection. */
function documentRequest(pages: unknown): unknown {
  return {
    model: "mistral-ocr",
    document: {
      type: "document_url",
      document_url: "https://example.com/report.pdf",
    },
    params: { pages },
  };
}

/** An image request: one image document, no page selection to pin. */
const IMAGE_REQUEST = {
  model: "mistral-ocr",
  document: {
    type: "image_url",
    image_url: "https://example.com/receipt.png",
  },
};

describe("Bifrost 11.5 (#300): OCR billed dimensions", () => {
  test("the mapping bills exactly the three upstream OCR sides, on the vocabulary's own members", () => {
    expect([...OCR_BILLED_DIMENSIONS]).toEqual([
      "surcharge_per_request",
      "image",
      "output",
    ]);
  });

  test("every dimension of the vocabulary is present in the certified quantities", () => {
    const verdict = assessOcrEnablement({
      dims: dims(),
      params: documentRequest([1, 2, 3, 5]),
      outputTokenCap: 1000,
    });
    expect(verdict.enabled).toBe(true);
    if (!verdict.enabled) return;
    expect(Object.keys(verdict.quantities).sort()).toEqual(
      [...PRICE_DIMENSIONS].sort(),
    );
  });

  test("a document request certifies the flat side at the PAGE count and the image side at 0", () => {
    const verdict = assessOcrEnablement({
      dims: dims(),
      params: documentRequest([1, 2, 3, 5]),
      outputTokenCap: 1000,
    });
    expect(verdict.enabled).toBe(true);
    if (!verdict.enabled) return;
    expect(verdict.quantities.surcharge_per_request).toBe(4);
    expect(verdict.quantities.image).toBe(0);
    expect(verdict.quantities.output).toBe(1000);
  });

  test("duplicate page entries are billed as sent — the ceiling covers every named page", () => {
    const verdict = assessOcrEnablement({
      dims: dims(),
      params: documentRequest([1, 1, 2]),
      outputTokenCap: 1000,
    });
    expect(verdict.enabled).toBe(true);
    if (!verdict.enabled) return;
    expect(verdict.quantities.surcharge_per_request).toBe(3);
  });

  test("an image request certifies one image unit AND one flat unit — both sides the wire can bill", () => {
    const verdict = assessOcrEnablement({
      dims: dims(),
      params: IMAGE_REQUEST,
      outputTokenCap: 1000,
    });
    expect(verdict.enabled).toBe(true);
    if (!verdict.enabled) return;
    expect(verdict.shape).toEqual({ kind: "image" });
    expect(verdict.quantities.image).toBe(1);
    expect(verdict.quantities.surcharge_per_request).toBe(1);
    expect(verdict.quantities.output).toBe(1000);
  });

  test("non-billed dimensions are certified 0 even when their price is KNOWN non-zero", () => {
    const verdict = assessOcrEnablement({
      dims: dims(),
      params: documentRequest([1, 2]),
      outputTokenCap: 1000,
    });
    expect(verdict.enabled).toBe(true);
    if (!verdict.enabled) return;
    for (const dimension of [
      "input",
      "reasoning",
      "image_output",
      "audio_input",
      "audio_output",
      "cache_read",
      "cache_write",
      "video",
      "surcharge_web_search",
    ] as const) {
      expect(verdict.quantities[dimension]).toBe(0);
    }
    // And the composed ceiling agrees: a KNOWN non-zero input price contributes nothing.
    const priced = computeReservationCeiling({
      dims: dims(),
      quantities: verdict.quantities,
      rate: RATE_100,
    });
    expect(priced.ok).toBe(true);
    if (!priced.ok) return;
    const withoutInput = computeReservationCeiling({
      dims: dims({ input: { status: "known", amount: "0" } }),
      quantities: verdict.quantities,
      rate: RATE_100,
    });
    expect(withoutInput.ok).toBe(true);
    if (!withoutInput.ok) return;
    expect(priced.exactScaledUnits).toEqual(withoutInput.exactScaledUnits);
  });
});

describe("Bifrost 11.5 (#300): pre-dispatch page determination", () => {
  test("a document without a page selection is 证据不足 — refused, never estimated", () => {
    const verdict = assessOcrEnablement({
      dims: dims(),
      params: documentRequest(undefined),
      outputTokenCap: 1000,
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: { code: "ocr_pages_indeterminable", shape: "pages_not_pinned" },
    });
  });

  test("an empty page selection pins nothing", () => {
    const verdict = assessOcrEnablement({
      dims: dims(),
      params: documentRequest([]),
      outputTokenCap: 1000,
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: { code: "ocr_pages_indeterminable", shape: "pages_not_pinned" },
    });
  });

  test("a non-positive or fractional page entry is not a countable selection", () => {
    for (const pages of [[0], [-1], [1.5], ["1"], [1, null]]) {
      const verdict = assessOcrEnablement({
        dims: dims(),
        params: documentRequest(pages),
        outputTokenCap: 1000,
      });
      expect(verdict).toEqual({
        enabled: false,
        issue: {
          code: "ocr_pages_indeterminable",
          shape: "pages_not_positive_integers",
        },
      });
    }
  });

  test("unreadable shapes name their own refusal", () => {
    expect(ocrRequestShape(null)).toEqual({
      ok: false,
      issue: "document_type_missing",
    });
    expect(
      ocrRequestShape({
        document: { type: "document_url", document_url: "" },
      }),
    ).toEqual({ ok: false, issue: "document_url_missing" });
    expect(
      ocrRequestShape({ document: { type: "image_url", image_url: "" } }),
    ).toEqual({ ok: false, issue: "image_url_missing" });
    expect(ocrRequestShape({ document: { type: "video" } })).toEqual({
      ok: false,
      issue: "document_type_unknown",
    });
    expect(
      assessOcrEnablement({
        dims: dims(),
        params: { document: { type: "video" } },
        outputTokenCap: 1000,
      }),
    ).toEqual({
      enabled: false,
      issue: {
        code: "ocr_request_unreadable",
        shape: "document_type_unknown",
      },
    });
  });
});

describe("Bifrost 11.5 (#300): unknown dimensions never enable", () => {
  test("a missing per-page price (flat side unknown) refuses with its reason", () => {
    const verdict = assessOcrEnablement({
      dims: dims({ surcharge_per_request: unknown() }),
      params: documentRequest([1, 2]),
      outputTokenCap: 1000,
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: {
        code: "price_unknown",
        dimension: "surcharge_per_request",
        reason: "price_dim_no_source",
      },
    });
  });

  test("a missing image price refuses — an image document needs it", () => {
    const verdict = assessOcrEnablement({
      dims: dims({ image: unknown("price_dim_unreadable") }),
      params: IMAGE_REQUEST,
      outputTokenCap: 1000,
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: {
        code: "price_unknown",
        dimension: "image",
        reason: "price_dim_unreadable",
      },
    });
  });

  test("a missing output price refuses — upstream silence about output tokens is never free", () => {
    // The v1 wire carries no completion field for OCR refs today; that is exactly the
    // basis 11.6's entrance will refuse, pinned here as the verdict's own answer.
    const verdict = assessOcrEnablement({
      dims: dims({ output: unknown() }),
      params: documentRequest([1, 2]),
      outputTokenCap: 1000,
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: {
        code: "price_unknown",
        dimension: "output",
        reason: "price_dim_no_source",
      },
    });
    // And the ceiling refuses the same snapshot, so no hold could form on it.
    const priced = ocrCeiling({
      dims: dims({ output: unknown() }),
      params: documentRequest([1, 2]),
      outputTokenCap: 1000,
      rate: RATE_100,
    });
    expect(priced).toEqual({
      ok: false,
      issue: {
        code: "price_unknown",
        dimension: "output",
        reason: "price_dim_no_source",
      },
    });
  });

  test("no attested output cap refuses the call method (Q11)", () => {
    for (const outputTokenCap of [0, -5, 1.5]) {
      const verdict = assessOcrEnablement({
        dims: dims(),
        params: documentRequest([1, 2]),
        outputTokenCap,
      });
      expect(verdict).toEqual({
        enabled: false,
        issue: { code: "ocr_output_uncapped" },
      });
    }
  });
});

describe("Bifrost 11.5 (#300): the ceiling covers the worst case", () => {
  test("a multi-page document's ceiling prices every page, 足额 upward", () => {
    // 4 pages × $0.01 + 0 images × $0.01 + 1000 tokens × $0.0000002 = $0.0402 exactly
    // → ×100 rate ×100 ledger scale = 402 units exactly (no rounding needed).
    const priced = ocrCeiling({
      dims: dims(),
      params: documentRequest([1, 2, 3, 5]),
      outputTokenCap: 1000,
      rate: RATE_100,
    });
    expect(priced.ok).toBe(true);
    if (!priced.ok) return;
    expect(priced.maximumCredits).toBe(402);
    expect(priced.exactScaledUnits).toEqual({
      numerator: 402n,
      denominator: 1n,
    });
    // 足额 in the odd case too: 3 pages × $0.01 + 1000 × $0.0000002 = $0.0302 → 302 units
    // exactly; a fractional exact cost rounds UP — one page at $0.0000035 each is the pin.
    const oddPriced = ocrCeiling({
      dims: dims({
        surcharge_per_request: { status: "known", amount: "0.0000035" },
      }),
      params: documentRequest([1]),
      outputTokenCap: 0,
      rate: RATE_100,
    });
    // outputTokenCap must stay positive — use cap 1 with a zero output price instead.
    const oddPricedCapped = ocrCeiling({
      dims: dims({
        surcharge_per_request: { status: "known", amount: "0.0000035" },
        output: { status: "known", amount: "0" },
      }),
      params: documentRequest([1]),
      outputTokenCap: 1,
      rate: RATE_100,
    });
    expect(oddPriced).toEqual({
      ok: false,
      issue: { code: "ocr_output_uncapped" },
    });
    expect(oddPricedCapped.ok).toBe(true);
    if (!oddPricedCapped.ok) return;
    // $0.0000035 × 10000 = 0.035 units → the one upward rounding answers 1.
    expect(oddPricedCapped.maximumCredits).toBe(1);
  });

  test("halving the page selection shrinks the flat side — the count is the selection's", () => {
    const four = ocrCeiling({
      dims: dims(),
      params: documentRequest([1, 2, 3, 4]),
      outputTokenCap: 1000,
      rate: RATE_100,
    });
    const two = ocrCeiling({
      dims: dims(),
      params: documentRequest([1, 2]),
      outputTokenCap: 1000,
      rate: RATE_100,
    });
    expect(four.ok).toBe(true);
    expect(two.ok).toBe(true);
    if (!four.ok || !two.ok) return;
    expect(four.maximumCredits).toBeGreaterThan(two.maximumCredits);
  });

  test("an image document's ceiling prices the image side and the flat unit", () => {
    // 1 image × $0.01 + 1 flat unit × $0.01 + 1000 × $0.0000002 = $0.0202 → 202 units exactly.
    const priced = ocrCeiling({
      dims: dims(),
      params: IMAGE_REQUEST,
      outputTokenCap: 1000,
      rate: RATE_100,
    });
    expect(priced.ok).toBe(true);
    if (!priced.ok) return;
    expect(priced.maximumCredits).toBe(202);
  });

  test('a free basis (every billed dimension exactly "0") is free, and certifies a zero ceiling', () => {
    const freeDims = dims({
      surcharge_per_request: { status: "known", amount: "0" },
      image: { status: "known", amount: "0" },
      output: { status: "known", amount: "0" },
    });
    const verdict = assessOcrEnablement({
      dims: freeDims,
      params: documentRequest([1, 2]),
      outputTokenCap: 1000,
    });
    expect(verdict.enabled).toBe(true);
    if (!verdict.enabled) return;
    expect(verdict.free).toBe(true);
    const priced = ocrCeiling({
      dims: freeDims,
      params: documentRequest([1, 2]),
      outputTokenCap: 1000,
      rate: RATE_100,
    });
    expect(priced.ok).toBe(true);
    if (!priced.ok) return;
    expect(priced.maximumCredits).toBe(0);
  });
});
