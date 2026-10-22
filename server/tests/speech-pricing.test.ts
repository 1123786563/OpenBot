import { describe, expect, test } from "../../tests/support/bun-test-compat";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import { mapPriceDims } from "../src/gateway/price-snapshot";
import {
  assessSpeechGeneration,
  speechGenerationCeiling,
  speechTierPriceTableFromSnapshot,
  type SpeechTierPriceTable,
} from "../src/billing/speech-pricing";
import { PRICE_DIMENSIONS } from "../src/gateway/price-snapshot";

/*
 * Bifrost #306 (13.1): the speech-generation ceiling boundary, as pure functions over
 * tier-table fixtures and 03.2-shaped dims — the quantity-and-evidence dimensions a hold
 * must cover before any audio is synthesized.
 *
 * WHAT THE ACs DEMAND OF THESE TESTS:
 *   输入、输出音频与时长成本受控才允许生成 — the ceiling covers BOTH sides: every input
 *     character at the tier's per-character price AND the enforceable output-duration cap
 *     at the tier's per-second price (the resume hint's trap: pricing only the input
 *     characters misses the output audio cost entirely);
 *   输出时长必须有可强制上限，否则不启用 — a call without a duration cap refuses;
 *   缺音频维度价格时标记 unknown 并拒绝 — a v1 snapshot (no audio fields on the wire)
 *     yields an empty tier table and a refusal, never a zero cost;
 *   预留锁定当时价格快照与比例版本 — the caller hands the LOCKED dims and rate, and the
 *     same spec prices at each version's own terms.
 */

const RATE: ConversionRate = { numerator: 100n, denominator: 1n }; // 100 credits per USD

/** A tier table fixture: two voices priced on both sides, plus a wildcard row. */
const TIER_TABLE: SpeechTierPriceTable = [
  { voiceTier: "alloy", perInputCharacterUsd: "0.00001", perOutputSecondUsd: "0.0005" },
  { voiceTier: "premium-voice", perInputCharacterUsd: "0.00002", perOutputSecondUsd: "0.001" },
  { voiceTier: null, perInputCharacterUsd: "0.000015", perOutputSecondUsd: "0.00075" },
];

/** Complete dims over the whole vocabulary at a fixed surcharge, for the exact conversion. */
function completeDims(surchargePerRequest = "0.0001") {
  const mapped = mapPriceDims({
    pricing: {
      prompt: "0",
      completion: "0",
      internal_reasoning: "0",
      image: "0",
      input_cache_read: "0",
      input_cache_write: "0",
      web_search: "0",
      request: surchargePerRequest,
    },
  });
  return Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [
      dimension,
      dimension === "audio_input" ||
        dimension === "audio_output" ||
        dimension === "video" ||
        dimension === "video_input" ||
        dimension === "surcharge_tool_call" ||
        dimension === "surcharge_a2a_call"
        ? { status: "known", amount: "0" }
        : mapped[dimension],
    ]),
  );
}

describe("the tier table", () => {
  test("a v1 snapshot (no audio fields on the wire) yields an empty table — unknown, refused", () => {
    const v1Dims = mapPriceDims({
      pricing: { prompt: "0", completion: "0", request: "0.0001" },
    });
    expect(v1Dims.audio_input).toEqual({ status: "unknown", reason: "price_dim_no_source" });
    expect(v1Dims.audio_output).toEqual({ status: "unknown", reason: "price_dim_no_source" });
    expect(speechTierPriceTableFromSnapshot(v1Dims)).toEqual([]);
  });

  test("a tier row always carries both sides — the table never prices half a call", () => {
    for (const row of TIER_TABLE) {
      expect(row.perInputCharacterUsd).toMatch(/^\d+(\.\d+)?$/);
      expect(row.perOutputSecondUsd).toMatch(/^\d+(\.\d+)?$/);
    }
  });
});

describe("the enablement verdict", () => {
  test("a complete spec with a duration cap enables; the verdict carries both quantities", () => {
    const verdict = assessSpeechGeneration({
      dims: completeDims(),
      tierTable: TIER_TABLE,
      request: { model: "tts-1", input: "Hello there.", voice: "alloy" },
      durationCapSeconds: 60,
    });
    expect(verdict.enabled).toBe(true);
    if (!verdict.enabled) return;
    expect(verdict.spec.inputCharacters).toBe(12);
    expect(verdict.tier.voiceTier).toBe("alloy");
  });

  test("no enforceable duration cap refuses the call method", () => {
    const verdict = assessSpeechGeneration({
      dims: completeDims(),
      tierTable: TIER_TABLE,
      request: { model: "tts-1", input: "Hello", voice: "alloy" },
      durationCapSeconds: 0,
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: { code: "speech_output_duration_uncapped" },
    });
  });

  test("a voice the table does not price refuses as unknown — never the nearest tier", () => {
    // No wildcard row in this table: a voice no exact row carries is genuinely unpriced.
    const noWildcard = TIER_TABLE.filter((row) => row.voiceTier !== null);
    const verdict = assessSpeechGeneration({
      dims: completeDims(),
      tierTable: noWildcard,
      request: { model: "tts-1", input: "Hello", voice: "unlisted-voice" },
      durationCapSeconds: 30,
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: { code: "speech_tier_price_unknown", voiceTier: "unlisted-voice" },
    });
  });

  test("an empty tier table (the v1 reality) refuses every voice as unknown", () => {
    const verdict = assessSpeechGeneration({
      dims: completeDims(),
      tierTable: speechTierPriceTableFromSnapshot(
        mapPriceDims({ pricing: { prompt: "0", completion: "0", request: "0.0001" } }),
      ),
      request: { model: "tts-1", input: "Hello", voice: "alloy" },
      durationCapSeconds: 30,
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: { code: "speech_tier_price_unknown", voiceTier: "alloy" },
    });
  });

  test("an input that is not a string cannot be counted and refuses", () => {
    const verdict = assessSpeechGeneration({
      dims: completeDims(),
      tierTable: TIER_TABLE,
      request: { model: "tts-1", input: 42, voice: "alloy" },
      durationCapSeconds: 30,
    });
    expect(verdict).toEqual({
      enabled: false,
      issue: { code: "speech_input_uncountable" },
    });
  });

  test("a wildcard row prices a voice no exact row carries", () => {
    const verdict = assessSpeechGeneration({
      dims: completeDims(),
      tierTable: TIER_TABLE,
      request: { model: "tts-1", input: "Hello", voice: "some-other-voice" },
      durationCapSeconds: 30,
    });
    expect(verdict.enabled).toBe(true);
    if (!verdict.enabled) return;
    expect(verdict.tier.perOutputSecondUsd).toBe("0.00075");
  });
});

describe("the ceiling conversion", () => {
  test("covers BOTH sides exactly: characters + seconds + surcharge, rounded up", () => {
    // 5000 chars × $0.00001 = $0.05; 300s × $0.0005 = $0.15; 1 request × $0.0001.
    // Exact $0.2001 × 100 credits/USD × 100 scale = 2001 scaled units — already whole.
    const ceiling = speechGenerationCeiling({
      dims: completeDims("0.0001"),
      tierTable: TIER_TABLE,
      request: { model: "tts-1", input: "x".repeat(5000), voice: "alloy" },
      durationCapSeconds: 300,
      rate: RATE,
    });
    expect(ceiling).toMatchObject({ ok: true, maximumCredits: 2001 });
    if (!ceiling.ok) return;
    expect(ceiling.exactScaledUnits).toEqual({ numerator: 2001n, denominator: 1n });
  });

  test("a fractional exact cost rounds UP — 足额, never below", () => {
    // 3 chars × $0.00002 = $0.00006; 1s × $0.001 = $0.001; + $0.0001 = $0.00116 exact
    // → 11.6 scaled units → the hold is 12.
    const ceiling = speechGenerationCeiling({
      dims: completeDims("0.0001"),
      tierTable: TIER_TABLE,
      request: { model: "tts-1", input: "abc", voice: "premium-voice" },
      durationCapSeconds: 1,
      rate: RATE,
    });
    expect(ceiling).toMatchObject({ ok: true, maximumCredits: 12 });
    if (!ceiling.ok) return;
    expect(ceiling.exactScaledUnits).toEqual({ numerator: 58n, denominator: 5n });
  });

  test("tiers never mix: the premium voice's BOTH sides price its own ceiling", () => {
    const standard = speechGenerationCeiling({
      dims: completeDims("0"),
      tierTable: TIER_TABLE,
      request: { model: "tts-1", input: "y".repeat(1000), voice: "alloy" },
      durationCapSeconds: 100,
      rate: RATE,
    });
    const premium = speechGenerationCeiling({
      dims: completeDims("0"),
      tierTable: TIER_TABLE,
      request: { model: "tts-1", input: "y".repeat(1000), voice: "premium-voice" },
      durationCapSeconds: 100,
      rate: RATE,
    });
    // standard: 1000×$0.00001 + 100×$0.0005 = $0.06 → 600 scaled units.
    // premium:  1000×$0.00002 + 100×$0.001   = $0.12 → 1200 — twice, on BOTH sides.
    expect(standard).toMatchObject({ ok: true, maximumCredits: 600 });
    expect(premium).toMatchObject({ ok: true, maximumCredits: 1200 });
  });

  test("an unknown surcharge on the locked basis refuses — unknown is never a zero cost", () => {
    const dims = mapPriceDims({ pricing: { prompt: "0", completion: "0" } });
    const ceiling = speechGenerationCeiling({
      dims,
      tierTable: TIER_TABLE,
      request: { model: "tts-1", input: "hello", voice: "alloy" },
      durationCapSeconds: 10,
      rate: RATE,
    });
    expect(ceiling).toEqual({
      ok: false,
      issue: { code: "price_unknown", dimension: "surcharge_per_request", reason: "price_dim_no_source" },
    });
  });

  test("the LOCKED basis prices the same spec at its own version, not the newest", () => {
    const v1Table: SpeechTierPriceTable = [
      { voiceTier: null, perInputCharacterUsd: "0.00001", perOutputSecondUsd: "0.0005" },
    ];
    const v2Table: SpeechTierPriceTable = [
      { voiceTier: null, perInputCharacterUsd: "0.00002", perOutputSecondUsd: "0.001" },
    ];
    const atV1 = speechGenerationCeiling({
      dims: completeDims("0"),
      tierTable: v1Table,
      request: { model: "tts-1", input: "y".repeat(1000), voice: "alloy" },
      durationCapSeconds: 100,
      rate: RATE,
    });
    const atV2 = speechGenerationCeiling({
      dims: completeDims("0"),
      tierTable: v2Table,
      request: { model: "tts-1", input: "y".repeat(1000), voice: "alloy" },
      durationCapSeconds: 100,
      rate: RATE,
    });
    // v1: $0.06 → 600; v2: $0.12 → 1200. Each locked basis prices its own.
    expect(atV1).toMatchObject({ ok: true, maximumCredits: 600 });
    expect(atV2).toMatchObject({ ok: true, maximumCredits: 1200 });
  });
});
