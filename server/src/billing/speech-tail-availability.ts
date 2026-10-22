/*
 * The speech tail-constraint judgment (Bifrost 13.4, #309): which speech call modes can
 * have their tail BOUNDED, and which stay unenabled with the reason queryable — because a
 * path whose tail cannot be constrained is a systematic overspend source, and the ticket's
 * own stance is 宁可少开放一个路径，也不开放无法约束尾部的路径 (Q11: cannot limit
 * duration/usage → do not enable).
 *
 * THE JUDGMENT IS PER CALL MODE × RESPONSE FORMAT. Both synthesis entrances (stream and
 * not) bill the produced audio by the SECOND against a caller-attested duration cap; what
 * makes a tail constrainable is whether the SERVER can measure the audio it forwards:
 *
 *   1. 已生成量可确定 — only the WAV container carries duration metadata this gateway's
 *      own meters read (the `fmt ` byte rate against the `data` size: 14.1's
 *      parseWavDurationSeconds reads it whole-file, 13.3's chunkSeconds reads it chunk by
 *      chunk for the interruption tail). mp3, opus, aac, flac and pcm have no server-
 *      trusted duration meter wired here — nothing on this gateway can state how much
 *      audio such a stream produced.
 *   2. 停止计费可强制 — the attested cap is only enforceable against audio the server can
 *      measure: a measurable artifact's duration is checked against the cap (an actual
 *      beyond it is 13.2's defect refusal, never a bill), and a measurable stream is
 *      severed at the cap with the confirmed tail settled once (13.3). An unmeasurable
 *      stream can neither be severed at the cap nor have its tail confirmed, so its tail
 *      cost has no bound the server itself enforces.
 *
 * THE WIRE'S DEFAULT IS THE HONEST TRAP. An absent response_format is mp3 by the wire's
 * own definition (SpeechParameters.ResponseFormat: "Default is mp3"), so the DEFAULT
 * synthesis call is tail-unconstrainable and stays unenabled — the judgment treats an
 * absent format as mp3 rather than as "no format", because the provider does.
 *
 * A JUDGMENT, NOT A CONFIGURATION. The facts this table stands on are structural — which
 * containers the gateway's meters can read is a property of the code, not of a deployment
 * — so the vocabulary is closed here and mirrored in the gateway's governance pre-hook
 * (bifrost/plugins/governance/speechcapability.go), which enforces the same refusal
 * before the provider is ever called. The two faces refuse identically or the pair is a
 * defect; the tests pin both.
 *
 * WHO CALLS THIS. The audio path admission gate (14.4's door) consults the per-request
 * verdict for every synthesis request BEFORE the price axis; the discovery interface
 * (03.11) and the admin availability projection read the view, so the unavailable reason
 * is queryable on every surface that answers what is usable (不可用原因可在发现接口与界面
 * 查询). Pure module: the same format always answers the same verdict.
 */

/** The wire's closed response-format set for /v1/audio/speech (SpeechParameters). */
export const SPEECH_RESPONSE_FORMATS = [
  "mp3",
  "opus",
  "aac",
  "flac",
  "wav",
  "pcm",
] as const;

/** What the wire itself substitutes for an absent response_format. */
export const SPEECH_DEFAULT_RESPONSE_FORMAT = "mp3";

/** The only formats whose audio this gateway's own meters can read. */
export const SPEECH_TAIL_CONSTRAINABLE_FORMATS = ["wav"] as const;

/** Why a format's tail is not constrainable. Closed vocabulary, displayable. */
export type SpeechTailUnavailableReason =
  /** The server has no meter that can state how much audio the format produced. */
  | { code: "generated_amount_undeterminable"; detail: string }
  /** The attested cap cannot stop the billing of audio the server cannot measure. */
  | { code: "tail_cost_unenforceable"; detail: string };

/** The closed reason-code set, for surfaces and tests that pin it. */
export const SPEECH_TAIL_REASON_CODES = [
  "generated_amount_undeterminable",
  "tail_cost_unenforceable",
] as const;

/**
 * The per-request verdict: constrainable carries the meter that measures the tail;
 * unconstrainable carries BOTH reasons, because a format whose generated amount cannot be
 * determined is exactly a format whose tail cost cannot be enforced.
 */
export type SpeechTailVerdict =
  | {
      constrainable: true;
      stream: boolean;
      format: string;
      /** The meter that determines the generated amount and enforces the cap. */
      meter: string;
    }
  | {
      constrainable: false;
      stream: boolean;
      format: string;
      reasons: readonly SpeechTailUnavailableReason[];
    };

/** Normalize the wire's format field: absent or empty is the mp3 default, verbatim else. */
function normalizeResponseFormat(responseFormat: string | undefined): string {
  const trimmed = responseFormat?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return SPEECH_DEFAULT_RESPONSE_FORMAT;
  }
  return trimmed;
}

const WAV_METER =
  "WAV container metadata (fmt byte rate ÷ data size): parseWavDurationSeconds whole-file, chunkSeconds chunk-wise";

/**
 * The tail verdict for one synthesis call mode. Pure — the same format always answers the
 * same verdict, so the admission door, the discovery interface and the admin projection
 * can never disagree about which speech paths are usable.
 */
export function assessSpeechTailConstraint(input: {
  stream: boolean;
  /** The request's wire response_format; absent is the wire's mp3 default. */
  responseFormat?: string;
}): SpeechTailVerdict {
  const format = normalizeResponseFormat(input.responseFormat);
  const constrainable = (SPEECH_TAIL_CONSTRAINABLE_FORMATS as readonly string[]).includes(
    format,
  );
  if (constrainable) {
    return {
      constrainable: true,
      stream: input.stream,
      format,
      meter: WAV_METER,
    };
  }
  const inWireVocabulary = (SPEECH_RESPONSE_FORMATS as readonly string[]).includes(
    format,
  );
  const naming = inWireVocabulary
    ? `no server-readable duration meter exists for ${format} audio on this gateway`
    : `${format} is not even in the wire's closed format set, so no meter could exist`;
  return {
    constrainable: false,
    stream: input.stream,
    format,
    reasons: [
      {
        code: "generated_amount_undeterminable",
        detail: naming,
      },
      {
        code: "tail_cost_unenforceable",
        detail: `the attested duration cap cannot stop the billing of ${format} audio the server cannot measure (sever-at-cap and 13.3's confirmed tail both need the meter)`,
      },
    ],
  };
}

/** One entrance × format row of the availability view every surface reads. */
export type SpeechTailAvailabilityRow = {
  /** The synthesis entrance the row is about. */
  path: "/v1/audio/speech";
  /** The entrance's stream variant — part of its identity, with the path. */
  stream: boolean;
  /** The wire response format this row prices the call mode under. */
  format: string;
  /** True when the wire substitutes this format for an absent response_format. */
  defaultFormat: boolean;
  /** Only constrainable formats are enabled — the selectable list is this flag. */
  enabled: boolean;
  /** Present exactly when not enabled — the one displayable reason pair. */
  reasons?: readonly SpeechTailUnavailableReason[];
};

/**
 * The speech tail availability view: both entrances × the wire's closed format set, only
 * the constrainable formats enabled, every other row carrying its reasons. The projection
 * the discovery interface answers and the admin surface shows — the unavailable reason is
 * a fact about the path, so it is derived here once, never re-worded downstream.
 */
export function speechTailAvailabilityView(): readonly SpeechTailAvailabilityRow[] {
  return [false, true].flatMap((stream) =>
    SPEECH_RESPONSE_FORMATS.map((format) => {
      const verdict = assessSpeechTailConstraint({ stream, responseFormat: format });
      return verdict.constrainable
        ? {
            path: "/v1/audio/speech" as const,
            stream,
            format,
            defaultFormat: format === SPEECH_DEFAULT_RESPONSE_FORMAT,
            enabled: true,
          }
        : {
            path: "/v1/audio/speech" as const,
            stream,
            format,
            defaultFormat: format === SPEECH_DEFAULT_RESPONSE_FORMAT,
            enabled: false,
            reasons: verdict.reasons,
          };
    }),
  );
}
