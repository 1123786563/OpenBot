import { describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  assessImageGenerationEnablement,
  IMAGE_GENERATION_BILLED_DIMENSIONS,
  IMAGE_GENERATION_MAX_COUNT,
  imageGenerationCeilingDims,
  imageGenerationSpecOf,
  imageTierPriceTableFromSnapshot,
  resolveImageTierPrice,
} from "../src/billing/image-generation-pricing";
import { computeReservationCeiling } from "../src/billing/reserve-bound";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import {
  assertPriceSnapshotDims,
  mapPriceDims,
  PRICE_DIMENSIONS,
  type PriceDimension,
  type PriceDimState,
  type PriceSnapshotDims,
} from "../src/gateway/price-snapshot";

/*
 * Bifrost #302 (12.1): the image-generation spec/tier/ceiling boundary, as pure
 * functions over tier-table fixtures and 03.2-shaped dims.
 *
 * WHAT THE ACs DEMAND OF THESE TESTS:
 *   按数量与规格全维度预留，上限不低于最坏情况成本 — the composed ceiling prices
 *     count × the REQUESTED TIER's per-image amount (multi-tier fixtures with distinct
 *     amounts per size/quality pin that no tier is priced at another's rate), and the
 *     ceiling is 足额: ≥ the exact worst case, never below it.
 *   缺任一规格价格时标记 unknown 并拒绝，不按 0 成本执行 — a tier with no row
 *     refuses (never a zero, never the nearest row); and on a REAL v1-wire snapshot —
 *     where `image_output` is unknown because the wire has no field for it — the whole
 *     capability refuses with the dimension named, which is today's honest answer.
 *   数量与规格在派发前确定 — the spec extractor freezes n/size/quality before any
 *     price is read, and refuses the shapes it cannot certify.
 *   预留锁定当时的价格快照与比例版本 — the conversion consumes the caller's dims and
 *     rate as the locked basis (two fixture versions of one basis price the same spec
 *     differently, each at its own version's terms); this module never reads a price
 *     itself.
 */

/** 100 credits per USD — with the ledger's ×100 scale, 1 USD = 10 000 units. */
const RATE_100: ConversionRate = { numerator: 100n, denominator: 1n };

/** A tiered basis in the shape dall-e-class pricing actually takes. */
const TIER_TABLE = [
  { size: "1024x1024", quality: "standard", amount: "0.04" },
  { size: "1024x1024", quality: "hd", amount: "0.08" },
  { size: "1792x1024", quality: "standard", amount: "0.08" },
  { size: "1792x1024", quality: "hd", amount: "0.12" },
] as const;

/** The uniform shape: one wildcard row pricing every tier. */
const UNIFORM_TABLE = [{ size: null, quality: null, amount: "0.03" }] as const;

function dims(
  overrides: Partial<Record<PriceDimension, PriceDimState>> = {},
): PriceSnapshotDims {
  const base = {} as Record<PriceDimension, PriceDimState>;
  for (const dimension of PRICE_DIMENSIONS) {
    base[dimension] = { status: "known", amount: "0.000001" };
  }
  base.image = { status: "known", amount: "0.01" };
  base.image_output = { status: "known", amount: "0.04" };
  return assertPriceSnapshotDims(
    { ...base, ...overrides },
    "image-generation-pricing fixture",
  );
}

// ── AC3: the spec is fixed before dispatch ──

describe("imageGenerationSpecOf", () => {
  test("copies n/size/quality; n defaults to the wire's own default of 1", () => {
    expect(
      imageGenerationSpecOf({ model: "dall-e-3", prompt: "a cat" }),
    ).toEqual({
      ok: true,
      spec: { count: 1, size: null, quality: null, inputImages: 0 },
    });
    expect(
      imageGenerationSpecOf({
        model: "dall-e-3",
        n: 3,
        size: "1792x1024",
        quality: "hd",
      }),
    ).toEqual({
      ok: true,
      spec: { count: 3, size: "1792x1024", quality: "hd", inputImages: 0 },
    });
  });

  test("a spec it cannot certify refuses before any price is read", () => {
    expect(imageGenerationSpecOf({ n: 0 })).toMatchObject({
      ok: false,
      issue: { field: "n" },
    });
    expect(imageGenerationSpecOf({ n: 2.5 })).toMatchObject({
      ok: false,
      issue: { field: "n" },
    });
    expect(imageGenerationSpecOf({ n: -1 })).toMatchObject({
      ok: false,
      issue: { field: "n" },
    });
    expect(
      imageGenerationSpecOf({ n: IMAGE_GENERATION_MAX_COUNT + 1 }),
    ).toMatchObject({
      ok: false,
      issue: { field: "n" },
    });
    expect(imageGenerationSpecOf({ size: "" })).toMatchObject({
      ok: false,
      issue: { field: "size" },
    });
    expect(imageGenerationSpecOf({ quality: 7 })).toMatchObject({
      ok: false,
      issue: { field: "quality" },
    });
    expect(imageGenerationSpecOf("not a request")).toMatchObject({
      ok: false,
      issue: { field: "n" },
    });
  });

  test("input image entries are counted exactly (the edits shape 12.3 prices)", () => {
    expect(
      imageGenerationSpecOf({ n: 1, image: ["a.png", "b.png"] }),
    ).toMatchObject({ ok: true, spec: { inputImages: 2 } });
    expect(imageGenerationSpecOf({ n: 1, image: "one.png" })).toMatchObject({
      ok: true,
      spec: { inputImages: 1 },
    });
    expect(imageGenerationSpecOf({ n: 1, image: 42 })).toMatchObject({
      ok: false,
      issue: { field: "image" },
    });
    // Blank entries are not nameable images: counted exactly refuses the spec, the same
    // discipline size/quality follow — never a count of entries nobody can read.
    expect(imageGenerationSpecOf({ n: 1, image: "" })).toMatchObject({
      ok: false,
      issue: { field: "image" },
    });
    expect(
      imageGenerationSpecOf({ n: 1, image: ["a.png", "  "] }),
    ).toMatchObject({
      ok: false,
      issue: { field: "image" },
    });
  });
});

// ── The tier resolution: no tier priced at another's rate ──

describe("resolveImageTierPrice", () => {
  test("the exact (size, quality) row answers, each tier at its own rate", () => {
    expect(
      resolveImageTierPrice(TIER_TABLE, {
        size: "1024x1024",
        quality: "standard",
      }),
    ).toEqual({ ok: true, amount: "0.04" });
    expect(
      resolveImageTierPrice(TIER_TABLE, { size: "1024x1024", quality: "hd" }),
    ).toEqual({ ok: true, amount: "0.08" });
    expect(
      resolveImageTierPrice(TIER_TABLE, { size: "1792x1024", quality: "hd" }),
    ).toEqual({ ok: true, amount: "0.12" });
  });

  test("a wildcard row prices every tier uniformly; a tier on no row is unpriced", () => {
    expect(
      resolveImageTierPrice(UNIFORM_TABLE, {
        size: "1024x1024",
        quality: "hd",
      }),
    ).toEqual({ ok: true, amount: "0.03" });
    expect(
      resolveImageTierPrice(UNIFORM_TABLE, { size: null, quality: null }),
    ).toEqual({ ok: true, amount: "0.03" });
    expect(
      resolveImageTierPrice(TIER_TABLE, {
        size: "512x512",
        quality: "standard",
      }),
    ).toEqual({ ok: false });
  });
});

// ── AC2: the enablement verdict ──

describe("assessImageGenerationEnablement", () => {
  test("a priced tier over a certifiable spec enables with the image quantities", () => {
    const verdict = assessImageGenerationEnablement({
      dims: dims(),
      tierTable: TIER_TABLE,
      request: { n: 3, size: "1792x1024", quality: "hd" },
    });
    expect(verdict).toMatchObject({
      enabled: true,
      free: false,
      perImageUsd: "0.12",
    });
    if (!verdict.enabled) return;
    expect(verdict.quantities.image_output).toBe(3);
    expect(verdict.quantities.image).toBe(0);
    for (const dimension of PRICE_DIMENSIONS) {
      if (
        (IMAGE_GENERATION_BILLED_DIMENSIONS as readonly string[]).includes(
          dimension,
        )
      ) {
        continue;
      }
      expect(verdict.quantities[dimension]).toBe(0);
    }
  });

  test("an unpriced tier refuses — never a zero, never the nearest row", () => {
    const verdict = assessImageGenerationEnablement({
      dims: dims(),
      tierTable: TIER_TABLE,
      request: { n: 1, size: "512x512", quality: "standard" },
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: { code: "image_tier_price_unknown" },
    });
  });

  test("an uncertifiable spec refuses before the prices are read", () => {
    const verdict = assessImageGenerationEnablement({
      dims: dims(),
      tierTable: TIER_TABLE,
      request: { n: 0 },
    });
    expect(verdict).toMatchObject({
      enabled: false,
      issue: { code: "image_spec_indeterminable", field: "n" },
    });
  });

  test("input images demand the input-image price, unknown refuses", () => {
    const withUnknownInput = dims({
      image: { status: "unknown", reason: "price_dim_no_source" },
    });
    const verdict = assessImageGenerationEnablement({
      dims: withUnknownInput,
      tierTable: TIER_TABLE,
      request: {
        n: 1,
        size: "1024x1024",
        quality: "standard",
        image: ["a.png"],
      },
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: {
        code: "image_input_price_unknown",
        reason: "price_dim_no_source",
      },
    });
    // The same request with the input price known passes, carrying both quantities.
    const ok = assessImageGenerationEnablement({
      dims: dims(),
      tierTable: TIER_TABLE,
      request: {
        n: 1,
        size: "1024x1024",
        quality: "standard",
        image: ["a.png"],
      },
    });
    expect(ok).toMatchObject({ enabled: true });
    if (ok.enabled) {
      expect(ok.quantities.image).toBe(1);
      expect(ok.quantities.image_output).toBe(1);
    }
  });

  test("an explicitly free tier enables as FREE — free is a price, not a pass", () => {
    const freeTable = [{ size: null, quality: null, amount: "0" }] as const;
    const verdict = assessImageGenerationEnablement({
      dims: dims(),
      tierTable: freeTable,
      request: { n: 2 },
    });
    expect(verdict).toMatchObject({
      enabled: true,
      free: true,
      perImageUsd: "0",
    });
  });

  test("a v1-wire snapshot cannot fill the tier table: the capability refuses, not 0-cost", () => {
    // The mapping from a REAL v1 catalog entry: pricing.image prices the INPUT side;
    // image_output — the generated side this ticket is about — has no wire field and is
    // unknown on every v1 snapshot (03.2 reserved it for exactly this ticket).
    const v1Dims = mapPriceDims({
      id: "openai/dall-e-3",
      pricing: {
        prompt: "0",
        completion: "0",
        image: "0.04",
        request: "0",
      },
    });
    expect(v1Dims.image_output).toEqual({
      status: "unknown",
      reason: "price_dim_no_source",
    });
    expect(imageTierPriceTableFromSnapshot(v1Dims)).toEqual([]);

    const verdict = assessImageGenerationEnablement({
      dims: v1Dims,
      tierTable: imageTierPriceTableFromSnapshot(v1Dims),
      request: { n: 1, size: "1024x1024", quality: "standard" },
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: { code: "image_tier_price_unknown" },
    });
  });
});

// ── AC1 + AC4: the composed ceiling, 足额 and version-locked ──

describe("the composed ceiling", () => {
  test("prices count × the requested tier's rate, and never below the worst case", () => {
    const standard = assessImageGenerationEnablement({
      dims: dims(),
      tierTable: TIER_TABLE,
      request: { n: 3, size: "1024x1024", quality: "standard" },
    });
    const hd = assessImageGenerationEnablement({
      dims: dims(),
      tierTable: TIER_TABLE,
      request: { n: 3, size: "1024x1024", quality: "hd" },
    });
    expect(standard.enabled).toBe(true);
    expect(hd.enabled).toBe(true);
    if (!standard.enabled || !hd.enabled) return;

    const standardCeiling = computeReservationCeiling({
      dims: imageGenerationCeilingDims(dims(), standard.perImageUsd),
      quantities: standard.quantities,
      rate: RATE_100,
    });
    const hdCeiling = computeReservationCeiling({
      dims: imageGenerationCeilingDims(dims(), hd.perImageUsd),
      quantities: hd.quantities,
      rate: RATE_100,
    });
    expect(standardCeiling.ok).toBe(true);
    expect(hdCeiling.ok).toBe(true);
    if (!standardCeiling.ok || !hdCeiling.ok) return;

    // 3 × $0.04 = $0.12 → 1200 scaled units; 3 × $0.08 = $0.24 → 2400. Exact here, and
    // 足额 by construction: the ceiling can only sit at or above the exact cost.
    expect(standardCeiling.maximumCredits).toBe(1_200);
    expect(hdCeiling.maximumCredits).toBe(2_400);
    expect(hdCeiling.maximumCredits).toBe(standardCeiling.maximumCredits * 2);
  });

  test("input image cost rides along at its own dimension's price", () => {
    const verdict = assessImageGenerationEnablement({
      dims: dims(),
      tierTable: TIER_TABLE,
      request: {
        n: 2,
        size: "1024x1024",
        quality: "standard",
        image: ["a.png"],
      },
    });
    expect(verdict.enabled).toBe(true);
    if (!verdict.enabled) return;
    const priced = computeReservationCeiling({
      dims: imageGenerationCeilingDims(dims(), verdict.perImageUsd),
      quantities: verdict.quantities,
      rate: RATE_100,
    });
    expect(priced.ok).toBe(true);
    if (!priced.ok) return;
    // 2 × $0.04 + 1 × $0.01 (the fixture's input-image price) = $0.09 → 900 units.
    expect(priced.maximumCredits).toBe(900);
  });

  test("a fractional tier price still rounds 足额 — never below the exact cost", () => {
    const oddTable = [
      { size: null, quality: null, amount: "0.00333" },
    ] as const;
    const verdict = assessImageGenerationEnablement({
      dims: dims(),
      tierTable: oddTable,
      request: { n: 1 },
    });
    expect(verdict.enabled).toBe(true);
    if (!verdict.enabled) return;
    const priced = computeReservationCeiling({
      dims: imageGenerationCeilingDims(dims(), verdict.perImageUsd),
      quantities: verdict.quantities,
      rate: RATE_100,
    });
    expect(priced.ok).toBe(true);
    if (!priced.ok) return;
    // $0.00333 × 100 credits/USD × 100 scale = 33.3 units → the ceiling is 34, above
    // the exact 33.3, never the floor 33.
    expect(priced.maximumCredits).toBe(34);
  });

  test("the conversion prices the LOCKED basis's version, never whatever is newest", () => {
    // Two versions of one basis: the tier price moved 0.04 → 0.05. The same frozen spec
    // prices at whichever version the caller locked — the reservation's 06.5 basis.
    const spec = { n: 2, size: "1024x1024", quality: "standard" };
    const v1Verdict = assessImageGenerationEnablement({
      dims: dims(),
      tierTable: [{ size: "1024x1024", quality: "standard", amount: "0.04" }],
      request: spec,
    });
    const v2Verdict = assessImageGenerationEnablement({
      dims: dims(),
      tierTable: [{ size: "1024x1024", quality: "standard", amount: "0.05" }],
      request: spec,
    });
    expect(v1Verdict.enabled).toBe(true);
    expect(v2Verdict.enabled).toBe(true);
    if (!v1Verdict.enabled || !v2Verdict.enabled) return;
    const v1 = computeReservationCeiling({
      dims: imageGenerationCeilingDims(dims(), v1Verdict.perImageUsd),
      quantities: v1Verdict.quantities,
      rate: RATE_100,
    });
    const v2 = computeReservationCeiling({
      dims: imageGenerationCeilingDims(dims(), v2Verdict.perImageUsd),
      quantities: v2Verdict.quantities,
      rate: RATE_100,
    });
    expect(v1).toMatchObject({ ok: true, maximumCredits: 800 });
    expect(v2).toMatchObject({ ok: true, maximumCredits: 1_000 });
  });
});
