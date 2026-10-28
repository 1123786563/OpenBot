import { describe, expect, test } from "../../tests/support/bun-test-compat";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import { mapPriceDims, PRICE_DIMENSIONS } from "../src/gateway/price-snapshot";
import {
  assessTranscription,
  measureAudioDurationSeconds,
  parseWavDurationSeconds,
  transcriptionCeiling,
} from "../src/billing/transcription-pricing";

/*
 * Bifrost #310 (14.1): the transcription input-metering boundary, as pure functions over
 * synthesized audio fixtures and 03.2-shaped dims — the reliable input length a hold may
 * stand on, the output cap it must carry, and the refusal when either cannot exist.
 *
 * WHAT THE ACs DEMAND OF THESE TESTS:
 *   转录按可靠输入时长与输出上限全维度预留 — the ceiling prices the MEASURED input
 *     seconds and the attested output-token cap, every dimension of the basis;
 *   输入时长来自服务端可信测量，而非仅客户端声明 — the duration comes from parsing
 *     the audio container's own metadata on the server; a client-claimed duration never
 *     lowers it and never substitutes for it;
 *   无法可靠确定时长时不启用该请求 — bytes the parser cannot read as a container
 *     refuse the request (unmeasurable is unbillable);
 *   缺音频维度价格时标记 unknown 并拒绝 — a v1 snapshot (no audio fields on the wire)
 *     leaves `audio_input` unknown and the call refuses, never at a zero cost.
 *
 * The fixtures are synthesized in-file: a WAV header of known sample rate and data size
 * IS a known duration (data bytes ÷ byte rate), so the metering is verified exactly
 * without any media file entering the repository.
 */

const RATE: ConversionRate = { numerator: 100n, denominator: 1n }; // 100 credits per USD

/**
 * A complete basis over the closed vocabulary — every dimension priced (the wire set
 * through 03.2's own mapping over a complete pricing object, the reserved set at "0"),
 * with the named dimensions overlaid at their own amounts.
 */
function completeDims(named: Record<string, string>) {
  const mapped = mapPriceDims({
    pricing: {
      prompt: "0",
      completion: "0",
      internal_reasoning: "0",
      image: "0",
      input_cache_read: "0",
      input_cache_write: "0",
      web_search: "0",
      request: "0",
    },
  });
  return Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => {
      if (named[dimension] !== undefined) {
        return [dimension, { status: "known", amount: named[dimension] }];
      }
      if (
        dimension === "audio_input" ||
        dimension === "audio_output" ||
        dimension === "video" ||
        dimension === "image_output" ||
        dimension === "surcharge_tool_call" ||
        dimension === "surcharge_a2a_call"
      ) {
        return [dimension, { status: "known", amount: "0" }];
      }
      return [dimension, mapped[dimension]];
    }),
  );
}

/**
 * Synthesize one WAV file's bytes of an exact duration: 16-bit mono PCM at 8000 Hz (byte
 * rate 16000/s), its `data` chunk sized to the requested duration — a container whose
 * OWN metadata states its length, the thing a server trusts.
 */
function wavOf(durationSeconds: number): Uint8Array {
  const byteRate = 16000; // 8000 Hz × 2 bytes × 1 channel
  const dataSize = Math.round(durationSeconds * byteRate);
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++)
      bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true); // sample rate
  view.setUint32(28, byteRate, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  return bytes;
}

describe("the trusted duration measurement", () => {
  test("a WAV's own metadata states its duration exactly", () => {
    expect(parseWavDurationSeconds(wavOf(2))).toBe(2);
    expect(parseWavDurationSeconds(wavOf(1.5))).toBe(1.5);
    expect(parseWavDurationSeconds(wavOf(0.25))).toBe(0.25);
  });

  test("bytes that are not a readable container measure as unmeasurable", () => {
    expect(parseWavDurationSeconds(new Uint8Array(0))).toBeNull();
    expect(
      parseWavDurationSeconds(new TextEncoder().encode("not audio at all")),
    ).toBeNull();
    expect(
      parseWavDurationSeconds(new Uint8Array([82, 73, 70, 70])),
    ).toBeNull(); // "RIFF" then nothing
  });

  test("the measurement governs; a client's claim never lowers it and never substitutes", () => {
    const audio = wavOf(2); // the container says two seconds
    // The client claims ten: the hold certifies the measured two, and the disagreement
    // is reported — the claim is cross-checked, never adopted.
    const inflated = measureAudioDurationSeconds({
      bytes: audio,
      clientClaimedSeconds: 10,
    });
    expect(inflated).toEqual({
      measuredSeconds: 2,
      clientClaimDisagrees: true,
    });
    // The client claims one: the hold still certifies the measured two.
    const deflated = measureAudioDurationSeconds({
      bytes: audio,
      clientClaimedSeconds: 1,
    });
    expect(deflated).toEqual({
      measuredSeconds: 2,
      clientClaimDisagrees: true,
    });
    // A consistent claim measures the same, flagged as agreeing.
    expect(
      measureAudioDurationSeconds({ bytes: audio, clientClaimedSeconds: 2 }),
    ).toEqual({ measuredSeconds: 2, clientClaimDisagrees: false });
    // No claim at all: the measurement stands on its own — it never needed one.
    expect(measureAudioDurationSeconds({ bytes: audio })).toEqual({
      measuredSeconds: 2,
      clientClaimDisagrees: false,
    });
  });

  test("unmeasurable bytes refuse — unmeasurable is unbillable", () => {
    const measurement = measureAudioDurationSeconds({
      bytes: new TextEncoder().encode("garbage"),
      clientClaimedSeconds: 30,
    });
    expect(measurement).toEqual({
      measuredSeconds: null,
      clientClaimDisagrees: true,
    });
  });
});

describe("the enablement verdict", () => {
  const basis = completeDims({
    audio_input: "0.0006",
    output: "0.00002",
    surcharge_per_request: "0.0001",
  });

  test("a measured input and an attested output cap enable the call", () => {
    const verdict = assessTranscription({
      dims: basis,
      measuredSeconds: 2,
      outputTokenCap: 300,
    });
    expect(verdict.enabled).toBe(true);
    if (!verdict.enabled) return;
    expect(verdict.spec.inputSeconds).toBe(2);
    expect(verdict.spec.outputTokenCap).toBe(300);
  });

  test("an unmeasurable duration refuses the request", () => {
    expect(
      assessTranscription({
        dims: basis,
        measuredSeconds: null,
        outputTokenCap: 300,
      }),
    ).toEqual({
      enabled: false,
      issue: { code: "transcription_input_unmeasurable" },
    });
  });

  test("no attested output cap refuses the call method", () => {
    expect(
      assessTranscription({
        dims: basis,
        measuredSeconds: 2,
        outputTokenCap: 0,
      }),
    ).toEqual({
      enabled: false,
      issue: { code: "transcription_output_uncapped" },
    });
  });

  test("a v1 snapshot's unknown audio price refuses as price_unknown — never a zero", () => {
    const v1Dims = mapPriceDims({
      pricing: {
        prompt: "0.000001",
        completion: "0.000002",
        request: "0.0001",
      },
    });
    expect(v1Dims.audio_input).toEqual({
      status: "unknown",
      reason: "price_dim_no_source",
    });
    expect(
      assessTranscription({
        dims: v1Dims,
        measuredSeconds: 2,
        outputTokenCap: 300,
      }),
    ).toEqual({
      enabled: false,
      issue: {
        code: "price_unknown",
        dimension: "audio_input",
        reason: "price_dim_no_source",
      },
    });
  });
});

describe("the ceiling conversion", () => {
  const basis = completeDims({
    audio_input: "0.0006",
    output: "0.00002",
    surcharge_per_request: "0.0001",
  });

  test("prices measured seconds + the output cap + the surcharge, exactly and 足额", () => {
    // 2s × $0.0006 + 300 × $0.00002 + 1 × $0.0001 = $0.0073 → 73 scaled units.
    const ceiling = transcriptionCeiling({
      dims: basis,
      measuredSeconds: 2,
      outputTokenCap: 300,
      rate: RATE,
    });
    expect(ceiling).toMatchObject({ ok: true, maximumCredits: 73 });
    if (!ceiling.ok) return;
    expect(ceiling.exactScaledUnits).toEqual({
      numerator: 73n,
      denominator: 1n,
    });
  });

  test("a fractional measured second rounds UP to the next whole second — never below", () => {
    // 1.5s certifies 2 seconds: the smallest whole-second count ≥ the measured duration.
    // The output tokens price at "0" here (free is a price), so the seconds are the cost.
    const zeroOutput = completeDims({
      audio_input: "0.0006",
      output: "0",
      surcharge_per_request: "0.0001",
    });
    const ceiling = transcriptionCeiling({
      dims: zeroOutput,
      measuredSeconds: 1.5,
      outputTokenCap: 300,
      rate: RATE,
    });
    // 2s × $0.0006 + 300 × $0 + $0.0001 = $0.0013 → 13 scaled units.
    expect(ceiling).toMatchObject({ ok: true, maximumCredits: 13 });
  });

  test("the LOCKED basis prices the same measured input at its own version's terms", () => {
    const v2 = completeDims({
      audio_input: "0.0012", // the price doubled
      output: "0.00002",
      surcharge_per_request: "0.0001",
    });
    const atV1 = transcriptionCeiling({
      dims: basis,
      measuredSeconds: 2,
      outputTokenCap: 300,
      rate: RATE,
    });
    const atV2 = transcriptionCeiling({
      dims: v2,
      measuredSeconds: 2,
      outputTokenCap: 300,
      rate: RATE,
    });
    expect(atV1).toMatchObject({ ok: true, maximumCredits: 73 });
    // v2: 2×$0.0012 + 300×$0.00002 + $0.0001 = $0.0085 → 85.
    expect(atV2).toMatchObject({ ok: true, maximumCredits: 85 });
  });

  test("the exact conversion rides 06.5's own arithmetic — the same discipline as admission", () => {
    // A rate that forces a fraction: 3 credits per USD (3/1) over $0.0073 → 2.19 → 3.
    const ceiling = transcriptionCeiling({
      dims: basis,
      measuredSeconds: 2,
      outputTokenCap: 300,
      rate: { numerator: 3n, denominator: 1n },
    });
    expect(ceiling).toMatchObject({ ok: true, maximumCredits: 3 });
    if (!ceiling.ok) return;
    expect(ceiling.exactScaledUnits).toEqual({
      numerator: 219n,
      denominator: 100n,
    });
  });
});
