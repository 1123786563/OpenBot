import type {
  PriceDimension,
  PriceDimensionUnknownReason,
  PriceSnapshotDims,
} from "../gateway/price-snapshot";
import type { ConversionRate } from "../gateway/conversion-rate";
import {
  computeReservationCeiling,
  type ReservationBoundQuantities,
  type ReservationCeilingIssue,
} from "./reserve-bound";

/*
 * The transcription input-metering boundary (Bifrost 14.1, #310): the server-trusted
 * duration measurement, the output cap, and the hold conversion for the
 * /v1/audio/transcriptions capability — the reliable input length a reservation may stand
 * on, and the refusal when no reliable length exists.
 *
 * THE DURATION IS MEASURED, NOT BELIEVED. The audio the request carries states its own
 * length in its container metadata — a WAV's `fmt ` chunk names the byte rate, its `data`
 * chunk names the payload size, and data ÷ rate IS the duration — so the server parses the
 * bytes it was handed and prices THAT. A client-declared duration is cross-checked and
 * reported when it disagrees, but it can neither lower the hold (claiming 1s over 2s of
 * audio) nor substitute for a measurement (no readable container → the request refuses:
 * unmeasurable is unbillable, and a client's say-so is not a meter).
 *
 * THE OUTPUT SIDE NEEDS A CAP THE CALL CAN ENFORCE. Transcription output is text whose
 * token count the v1 wire cannot cap (no max_tokens on /v1/audio/transcriptions), so the
 * cap arrives as EVIDENCE the caller attests — a provider parameter or a local bound the
 * booked transcript is actually held to. No cap, or a non-positive one, refuses the call
 * method (Q11: cannot enforce → not enabled).
 *
 * THE DIMENSIONS ARE THE VOCABULARY'S OWN. Unlike speech (13.1, whose per-CHARACTER input
 * price has no slot in the closed token vocabulary), transcription's two sides ride real
 * dimensions exactly: input audio seconds on `audio_input`, output text tokens on
 * `output`, plus the per-request surcharge. The conversion is therefore 06.5's own
 * `computeReservationCeiling` — the same exact arithmetic admission uses — with the
 * measured seconds (rounded UP to whole seconds, 足额) and the attested token cap as the
 * certified quantities. A v1 snapshot leaves `audio_input` unknown (no wire field), and
 * the verdict refuses with the dimension and its reason: unknown is never a zero cost.
 */

/** The result of measuring what the request actually carries. */
export type AudioDurationMeasurement = {
  /**
   * The duration the container's own metadata states, in seconds — the number a hold may
   * stand on. Null when the bytes are not a container this server can read: an
   * unmeasurable input is exactly the refusal the AC names.
   */
  readonly measuredSeconds: number | null;
  /** True when the client also declared a duration and it disagreed with the measurement. */
  readonly clientClaimDisagrees: boolean;
};

/**
 * Read one WAV container's duration from its own metadata: the `fmt ` chunk's byte rate
 * against the `data` chunk's payload size. Exact rational arithmetic on integers, so the
 * same bytes always measure the same duration. Anything else — empty bytes, a truncated
 * header, a non-RIFF payload, a missing fmt/data pair — is null: this parser answers
 * "what the container itself states", never a guess about bytes it could not read.
 */
export function parseWavDurationSeconds(bytes: Uint8Array): number | null {
  const view = safeView(bytes);
  if (view === null) return null;
  if (bytes.length < 12) return null;
  if (tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") return null;

  // Walk the chunks: one 4-byte id + one little-endian 4-byte size ahead of each body.
  let offset = 12;
  let byteRate: number | null = null;
  let dataSize: number | null = null;
  while (offset + 8 <= bytes.length) {
    const id = tag(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= bytes.length) {
      byteRate = view.getUint32(body + 8, true); // sampleRate × channels × bits/8
    } else if (id === "data") {
      // The header's own size word is the truth about the payload, even when the bytes
      // handed in were truncated: the container SAYS how long its audio is.
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (byteRate === null || dataSize === null || byteRate <= 0) return null;
  return dataSize / byteRate;
}

/** A DataView over the bytes, or null when the buffer cannot back one. */
function safeView(bytes: Uint8Array): DataView | null {
  if (bytes.byteLength < bytes.length) return null;
  try {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch {
    return null;
  }
}

/** Four ASCII bytes at an offset, or "" when they are not all present. */
function tag(bytes: Uint8Array, offset: number): string {
  if (offset + 4 > bytes.length) return "";
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

/**
 * The trusted measurement (AC2): parse the container, price its own stated length, and
 * cross-check the client's claim. The measured value is the answer either way — a claim
 * that disagrees is REPORTED (so the trail shows the attempt), never adopted, and a claim
 * that agrees changes nothing. No claim at all is fine: the measurement never needed one.
 */
export function measureAudioDurationSeconds(input: {
  bytes: Uint8Array;
  /** The duration the client declared for the same audio, when it declared one. */
  clientClaimedSeconds?: number;
}): AudioDurationMeasurement {
  const measuredSeconds = parseWavDurationSeconds(input.bytes);
  // A claim that exists disagrees unless the measurement corroborates it exactly — an
  // unmeasurable input corroborates nothing, so a claim over unreadable bytes is flagged
  // as the unchecked say-so it is.
  const clientClaimDisagrees =
    input.clientClaimedSeconds !== undefined &&
    (measuredSeconds === null ||
      Math.abs(input.clientClaimedSeconds - measuredSeconds) > 1e-9);
  return { measuredSeconds, clientClaimDisagrees };
}

/** The frozen transcription spec: the measured input and the attested output cap. */
export type TranscriptionSpec = {
  /** The measured input duration, certified in whole seconds (rounded up). */
  readonly inputSeconds: number;
  /** The enforceable output-token cap the caller attested. */
  readonly outputTokenCap: number;
};

/** Why a transcription call cannot be enabled. Closed vocabulary, displayable. */
export type TranscriptionEnablementIssue =
  /** The audio's duration could not be measured — unmeasurable is unbillable. */
  | { code: "transcription_input_unmeasurable" }
  /** No enforceable output-token cap (Q11: cannot enforce → not enabled). */
  | { code: "transcription_output_uncapped" }
  /** A billed dimension's price is unknown on the basis — never a zero cost. */
  | {
      code: "price_unknown";
      dimension: PriceDimension;
      reason: PriceDimensionUnknownReason;
    };

/** The verdict: enabled carries the spec and quantities; refused carries the reason. */
export type TranscriptionEnablement =
  | {
      enabled: true;
      /** True when every billed dimension prices at exactly "0": free is a price. */
      free: boolean;
      /** The frozen spec the hold was certified against. */
      spec: TranscriptionSpec;
      /** The per-dimension quantities, ready for 06.5's conversion. */
      quantities: ReservationBoundQuantities;
    }
  | { enabled: false; issue: TranscriptionEnablementIssue };

/** The dimensions a transcription call bills, from the closed vocabulary. */
export const TRANSCRIPTION_BILLED_DIMENSIONS = [
  "audio_input",
  "output",
  "surcharge_per_request",
] as const satisfies readonly PriceDimension[];

/**
 * The enablement predicate (AC1–AC4): the input MEASURED (a real duration from the
 * container, certified in whole seconds rounded up — the smallest whole-second count that
 * covers the measured length), the output capped by evidence the caller attests, and every
 * billed dimension priced on the locked basis. The dims handed in are the LOCKED basis's;
 * this function never reads a price of its own.
 */
export function assessTranscription(input: {
  dims: PriceSnapshotDims;
  /** The trusted measurement's duration in seconds, or null when unmeasurable. */
  measuredSeconds: number | null;
  /** The enforceable output-token cap (provider param or local bound). */
  outputTokenCap: number;
}): TranscriptionEnablement {
  if (
    input.measuredSeconds === null ||
    !Number.isFinite(input.measuredSeconds) ||
    input.measuredSeconds <= 0
  ) {
    return { enabled: false, issue: { code: "transcription_input_unmeasurable" } };
  }
  if (
    !Number.isSafeInteger(input.outputTokenCap) ||
    input.outputTokenCap <= 0
  ) {
    return { enabled: false, issue: { code: "transcription_output_uncapped" } };
  }
  for (const dimension of TRANSCRIPTION_BILLED_DIMENSIONS) {
    const state = input.dims[dimension];
    if (state.status === "unknown") {
      return {
        enabled: false,
        issue: {
          code: "price_unknown",
          dimension,
          reason: state.reason,
        },
      };
    }
  }

  const inputSeconds = Math.ceil(input.measuredSeconds);
  const free = TRANSCRIPTION_BILLED_DIMENSIONS.every(
    (dimension) =>
      input.dims[dimension].status === "known" &&
      input.dims[dimension].amount === "0",
  );
  const quantities = Object.fromEntries(
    (
      [
        "input",
        "output",
        "reasoning",
        "image",
        "image_output",
        "audio_input",
        "audio_output",
        "cache_read",
        "cache_write",
        "video",
        "surcharge_web_search",
        "surcharge_per_request",
      ] as const
    ).map((dimension) => [
      dimension,
      dimension === "audio_input"
        ? inputSeconds
        : dimension === "output"
          ? input.outputTokenCap
          : dimension === "surcharge_per_request"
            ? 1
            : 0,
    ]),
  ) as ReservationBoundQuantities;

  return {
    enabled: true,
    free,
    spec: { inputSeconds, outputTokenCap: input.outputTokenCap },
    quantities,
  };
}

/**
 * The hold ceiling (AC1): the measured seconds and the attested cap priced through 06.5's
 * own exact conversion over the LOCKED basis — the same arithmetic admission used, so a
 * hold and everything downstream can never disagree about what the same input costs. A
 * mid-flight price sync changes nothing: the dims and rate are the caller's locked
 * versions.
 */
export function transcriptionCeiling(input: {
  dims: PriceSnapshotDims;
  measuredSeconds: number | null;
  outputTokenCap: number;
  rate: ConversionRate;
}):
  | {
      ok: true;
      maximumCredits: number;
      exactScaledUnits: { numerator: bigint; denominator: bigint };
    }
  | { ok: false; issue: TranscriptionEnablementIssue | ReservationCeilingIssue } {
  const verdict = assessTranscription(input);
  if (!verdict.enabled) {
    return { ok: false, issue: verdict.issue };
  }
  const priced = computeReservationCeiling({
    dims: input.dims,
    quantities: verdict.quantities,
    rate: input.rate,
  });
  return priced;
}
