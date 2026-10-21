import type { PriceDimension, PriceSnapshotDims } from "../gateway/price-snapshot";
import { TRANSCRIPTION_BILLED_DIMENSIONS } from "./transcription-pricing";
import { speechTierPriceTableFromSnapshot } from "./speech-pricing";

/*
 * The per-path audio capability evidence (Bifrost 14.3, #312): one record per audio
 * processing path the gateway actually carries — plus the absences someone checked for —
 * stating the path's billing dimensions, the boundary evidence that makes them
 * enforceable, and the verification that proves it re-runnable. Paths whose evidence is
 * incomplete stay UNENABLED with their missing items visible; the enableable projection
 * is DERIVED from the same machinery admission uses (14.1's own dimension vocabulary,
 * 13.1's own tier-table constructor), never asserted — the conformance input 22.3/22.4
 * fold into the family report.
 *
 * THE ENUMERATION IS GROUNDED IN ROUTES, NOT NAMES. The four entrances below are the
 * gateway's own route tables (each record's source anchor names where the pinned commit
 * serves it): /v1/audio/transcriptions and /v1/audio/speech, each with a stream variant
 * — and /v1/audio/translations, which exists on the OpenAI wire but is only a
 * PASSTHROUGH billing reference in this gateway (no dedicated provider method): a real
 * path, recorded as real, with the missing items that keep it unenabled named exactly.
 * Diarization is not an entrance at all — it is transcriptions' diarized_json
 * response_format — so the separation/enhancement family appears once, as a checked
 * absence with its own anchor, which is what "枚举覆盖实际入口，不以能力名称推定" means:
 * the registry answers what the wire carries AND what someone verified it does not.
 *
 * UNITS OUTSIDE THE VOCABULARY, STATED AS SUCH. Speech's per-character input side has no
 * slot in the closed token vocabulary (13.1's own unit-honesty: a character price riding
 * the per-token `input` would be a unit lie), so the speech record carries it as a
 * NON-vocabulary unit with its versioned home — the frozen spec and the settlement line
 * — instead of pretending a token dimension prices it.
 *
 * WHO CALLS THIS. 22.3/22.4's conformance aggregation reads the records; the admin
 * surface that shows which audio paths are usable reads the enableable projection and
 * the gap report. Pure module: the same basis always answers the same verdicts.
 */

/** Why a path's evidence is incomplete. Closed vocabulary, displayable. */
export type AudioPathMissingItem =
  /** The basis carries no price source for a dimension the path bills. */
  | { code: "no_wire_price_source"; detail: string }
  /** The path has no dedicated meter wired on this gateway. */
  | { code: "no_input_meter_wired"; detail: string }
  /** The path has no admission wiring at all — it cannot be admitted, so it stays off. */
  | { code: "no_admission_wiring"; detail: string }
  /** The family is not an entrance on this gateway at all. */
  | { code: "no_gateway_entrypoint"; detail: string };

/** One side of a path's cost, with the mechanism that enforces its bound. */
export type AudioBoundaryEvidence = {
  side: "input" | "output";
  mechanism: string;
  verifier: string;
};

/** How a path's evidence is verified — the environment and the re-runnable commands. */
export type AudioPathVerification = {
  environment: "local-deterministic" | "provider-real";
  commands: readonly string[];
};

/** One audio path's evidence record — the shape 22.3/22.4 consume. */
export type AudioCapabilityEvidenceRecord = {
  /** The gateway route this path serves, or the wire name for a passthrough-only path. */
  path: string;
  /** The processing family, for grouping in the conformance report. */
  family: "recognition" | "synthesis" | "translation" | "separation-enhancement";
  /** The route's stream variant flag (the entrance's identity, with the path). */
  stream: boolean;
  /** False for a family someone checked for that is NOT an entrance on this gateway. */
  exists: boolean;
  /** Where the pinned gateway serves (or references) this path — the enumeration's evidence. */
  sourceAnchor: string;
  /** The closed-vocabulary dimensions this path bills. */
  billedDimensions: readonly PriceDimension[];
  /** Units this path bills that live OUTSIDE the vocabulary, with their versioned home. */
  nonVocabularyUnits: readonly string[];
  /** The mechanisms that enforce the billed sides' bounds, and what verifies them. */
  boundaryEvidence: readonly AudioBoundaryEvidence[];
  /** The recorded verification — environment plus re-runnable commands. */
  verification: AudioPathVerification;
  /** Request-shape variants that share this path's billing (its one meter prices them all). */
  variants: readonly string[];
  /** Evidence gaps that hold the path unenabled regardless of any single basis. */
  missingItems: readonly AudioPathMissingItem[];
};

/**
 * The audio processing paths, enumerated from the pinned gateway's routes. The
 * recognition variants (response formats, timestamp granularities, diarization) are ONE
 * path's variants — they share the entrance, the meter, and the billing dimensions —
 * which is itself the evidence claim: no variant bills a dimension the meter does not
 * read.
 */
export const AUDIO_CAPABILITY_EVIDENCE: readonly AudioCapabilityEvidenceRecord[] = [
  {
    path: "/v1/audio/transcriptions",
    family: "recognition",
    stream: false,
    exists: true,
    sourceAnchor: "core/providers/openai/openai.go:3157",
    billedDimensions: TRANSCRIPTION_BILLED_DIMENSIONS,
    nonVocabularyUnits: [],
    boundaryEvidence: [
      {
        side: "input",
        mechanism:
          "server-trusted container duration (WAV fmt/data metadata), certified in whole seconds rounded up",
        verifier: "14.1 parseWavDurationSeconds / measureAudioDurationSeconds",
      },
      {
        side: "output",
        mechanism: "attested output-token cap the booked transcript is held to",
        verifier: "14.1 assessTranscription (transcription_output_uncapped refusal)",
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: [
        "bun test server/tests/transcription-pricing.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/transcription-tamper.integration.test.ts",
      ],
    },
    variants: [
      "response_format: json | verbose_json | text | srt | vtt | diarized_json",
      "timestamp_granularities: word, segment (verbose_json)",
      "language / prompt hints",
    ],
    missingItems: [],
  },
  {
    path: "/v1/audio/transcriptions",
    family: "recognition",
    stream: true,
    exists: true,
    sourceAnchor: "core/providers/openai/openai.go:3442",
    billedDimensions: TRANSCRIPTION_BILLED_DIMENSIONS,
    nonVocabularyUnits: [],
    boundaryEvidence: [
      {
        side: "input",
        mechanism:
          "server-trusted container duration (WAV fmt/data metadata), certified in whole seconds rounded up",
        verifier: "14.1 parseWavDurationSeconds / measureAudioDurationSeconds",
      },
      {
        side: "output",
        mechanism: "attested output-token cap the booked transcript is held to",
        verifier: "14.1 assessTranscription (transcription_output_uncapped refusal)",
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: [
        "bun test server/tests/transcription-pricing.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/transcription-tamper.integration.test.ts",
      ],
    },
    variants: ["the streaming transcription chunks of the same formats"],
    missingItems: [],
  },
  {
    path: "/v1/audio/speech",
    family: "synthesis",
    stream: false,
    exists: true,
    sourceAnchor: "core/providers/openai/openai.go:2724",
    billedDimensions: ["audio_output", "surcharge_per_request"],
    nonVocabularyUnits: [
      "input_characters (per-tier, versioned by the frozen spec and the 0181 settlement line)",
    ],
    boundaryEvidence: [
      {
        side: "input",
        mechanism: "the complete text counted in full, frozen in the spec before dispatch",
        verifier: "13.1 assessSpeechGeneration (speech_input_uncountable refusal)",
      },
      {
        side: "output",
        mechanism: "duration cap the caller attests and the stream is severed at",
        verifier: "13.1 assessSpeechGeneration (speech_output_duration_uncapped refusal)",
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: [
        "bun test server/tests/speech-pricing.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/speech-settlement.integration.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/speech-interruption.integration.test.ts",
      ],
    },
    variants: ["voice tiers (per-voice price rows, wildcard fallback)"],
    missingItems: [],
  },
  {
    path: "/v1/audio/speech",
    family: "synthesis",
    stream: true,
    exists: true,
    sourceAnchor: "core/providers/openai/openai.go:2870",
    billedDimensions: ["audio_output", "surcharge_per_request"],
    nonVocabularyUnits: [
      "input_characters (per-tier, versioned by the frozen spec and the 0181 settlement line)",
    ],
    boundaryEvidence: [
      {
        side: "input",
        mechanism: "the complete text counted in full, frozen in the spec before dispatch",
        verifier: "13.1 assessSpeechGeneration (speech_input_uncountable refusal)",
      },
      {
        side: "output",
        mechanism:
          "duration cap the caller attests and the stream is severed at; an interruption settles the confirmed buffer tail once (13.3)",
        verifier: "13.1 assessSpeechGeneration; 13.3 settleInterruptedSpeech",
      },
    ],
    verification: {
      environment: "local-deterministic",
      commands: [
        "bun test server/tests/speech-pricing.test.ts",
        "TEST_DATABASE_URL=<test-db> bun test server/tests/speech-interruption.integration.test.ts",
      ],
    },
    variants: ["the streaming synthesis chunks of the same voice tiers"],
    missingItems: [],
  },
  {
    path: "/v1/audio/translations",
    family: "translation",
    stream: false,
    exists: true,
    // The only place the pinned gateway names this path: the passthrough billing
    // classifier. No dedicated provider method serves it; nothing meters its input.
    sourceAnchor: "core/providers/openai/passthrough_usage.go:38",
    billedDimensions: ["audio_input", "output", "surcharge_per_request"],
    nonVocabularyUnits: [],
    boundaryEvidence: [],
    verification: {
      environment: "local-deterministic",
      commands: [
        "bun test server/tests/audio-capability-evidence.test.ts",
      ],
    },
    variants: [],
    missingItems: [
      {
        code: "no_input_meter_wired",
        detail:
          "14.1's duration meter is wired to the transcription path only; no server-trusted measurement exists for this route",
      },
      {
        code: "no_admission_wiring",
        detail:
          "the gateway carries this path as a passthrough billing reference only (no dedicated provider method); no Reserve/Settle wiring exists to admit it",
      },
      {
        code: "no_wire_price_source",
        detail:
          "the v1 pricing object carries no audio_input field, and no curated basis prices a translation cell",
      },
    ],
  },
  {
    path: "audio/separation-enhancement",
    family: "separation-enhancement",
    stream: false,
    exists: false,
    // Diarization — the family's nearest neighbor — is transcriptions' diarized_json
    // response_format, not an entrance; no separation/enhancement route exists at all.
    sourceAnchor: "core/schemas/transcriptions.go:23",
    billedDimensions: [],
    nonVocabularyUnits: [],
    boundaryEvidence: [],
    verification: {
      environment: "local-deterministic",
      commands: [
        "bun test server/tests/audio-capability-evidence.test.ts",
      ],
    },
    variants: [],
    missingItems: [
      {
        code: "no_gateway_entrypoint",
        detail:
          "no separation/enhancement route exists in the gateway; diarization is transcriptions' diarized_json response_format, not an entrance",
      },
    ],
  },
] as const;

/** One path's basis-dependent gap: the dimensions the basis cannot price, in order. */
export type AudioPathEvidenceGap = {
  path: string;
  /** The record's own structural gaps (meter/admission/entrypoint), if any. */
  missingItems: readonly AudioPathMissingItem[];
  /** The billed dimensions THIS basis leaves unknown, each with its own reason. */
  missingDimensions: readonly { dimension: PriceDimension; reason: string }[];
};

function basisUnknownDimensions(
  record: AudioCapabilityEvidenceRecord,
  dims: PriceSnapshotDims,
): { dimension: PriceDimension; reason: string }[] {
  return record.billedDimensions
    .filter((dimension) => dims[dimension].status === "unknown")
    .map((dimension) => ({
      dimension,
      reason: dims[dimension].status === "unknown" ? dims[dimension].reason : "",
    }));
}

/**
 * The paths whose evidence is complete against ONE basis. The verdict is derived the way
 * admission derives it: the record's structural gaps empty (its meter wired, its
 * entrance real) AND every dimension it bills KNOWN on the basis — an explicitly free
 * "0" is a price — AND, for synthesis, a fillable tier table (13.1's own constructor;
 * empty today, honestly). Unknown never degrades to a zero cost, here either.
 */
export function enableableAudioPaths(
  dims: PriceSnapshotDims,
): readonly AudioCapabilityEvidenceRecord[] {
  return AUDIO_CAPABILITY_EVIDENCE.filter((record) => {
    if (!record.exists) return false;
    if (record.missingItems.length > 0) return false;
    if (record.family === "synthesis") {
      // The tier table is the synthesis path's own price basis: empty by construction
      // until the wire grows audio fields, and an empty table enables nothing (13.1).
      if (speechTierPriceTableFromSnapshot(dims).length === 0) return false;
      if (dims.surcharge_per_request.status === "unknown") return false;
      return true;
    }
    return basisUnknownDimensions(record, dims).length === 0;
  });
}

/**
 * The gap report: every REAL path (absences are not gaps — they are answers) with the
 * items and dimensions that hold it unenabled against this basis. The report never
 * silently drops a path: what is not in the enableable projection is here, named.
 */
export function audioPathsWithEvidenceGaps(
  dims: PriceSnapshotDims,
): readonly AudioPathEvidenceGap[] {
  const enableable = new Set(enableableAudioPaths(dims));
  return AUDIO_CAPABILITY_EVIDENCE.filter(
    (record) => record.exists && !enableable.has(record),
  ).map((record) => {
    const structural = [...record.missingItems];
    if (record.family === "synthesis") {
      if (speechTierPriceTableFromSnapshot(dims).length === 0) {
        return {
          path: record.path,
          missingItems: [
            {
              code: "no_wire_price_source" as const,
              detail:
                "speech tier table is empty by construction (speechTierPriceTableFromSnapshot)",
            },
          ],
          missingDimensions: basisUnknownDimensions(record, dims),
        };
      }
      return {
        path: record.path,
        missingItems: structural,
        missingDimensions: basisUnknownDimensions(record, dims),
      };
    }
    return {
      path: record.path,
      missingItems: structural,
      missingDimensions: basisUnknownDimensions(record, dims),
    };
  });
}
