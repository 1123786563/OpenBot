import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "../../tests/support/bun-test-compat";
import {
  AUDIO_CAPABILITY_EVIDENCE,
  audioPathsWithEvidenceGaps,
  enableableAudioPaths,
} from "../src/billing/audio-capability-evidence";
import {
  PRICE_DIMENSIONS,
  assertPriceSnapshotDims,
  type PriceDimState,
  type PriceSnapshotDims,
} from "../src/gateway/price-snapshot";
import { TRANSCRIPTION_BILLED_DIMENSIONS } from "../src/billing/transcription-pricing";

/*
 * Bifrost #312 (14.3): the per-path audio capability evidence — enumeration grounded in
 * the gateway's ACTUAL entrances (never presumed from capability names), each path's
 * billing dimensions and boundary enforceability stated with the evidence that proves
 * them, and the paths whose evidence is incomplete staying UNENABLED with their missing
 * items visible, the shape 22.3/22.4 will fold into the conformance report.
 *
 * THE ABSENCE IS EVIDENCE TOO. A processing family that sounds like an audio capability
 * (diarization! separation! enhancement!) is only a path if the gateway routes it: the
 * registry records the absence with its own anchor — diarization is transcriptions'
 * diarized_json response_format, not an entrance — so "枚举覆盖实际入口" means the set the
 * wire carries plus the absences someone checked for, not a shorter list of conveniences.
 *
 * ENABLEABLE IS DERIVED, NEVER ASSERTED. The verdict comes from the same machinery
 * admission uses: a path's billed dimensions known on the basis (14.1's own vocabulary
 * for the recognition path), its meter wired, its tier table fillable — so on the v1
 * wire, where no pricing field prices any audio dimension, NOTHING is enableable, and a
 * basis that does price the recognition dimensions enables exactly the recognition path.
 */

const ROOT = resolve(import.meta.dirname, "../..");

/** The v1-wire basis: every wire dimension priced, every reserved audio slot without a source. */
function v1Dims(): PriceSnapshotDims {
  const amounts: Record<string, string> = {
    input: "0.00000002",
    output: "0.00000003",
    reasoning: "0",
    image: "0.005",
    input_cache_read: "0",
    input_cache_write: "0",
    surcharge_web_search: "0",
    surcharge_per_request: "0.0001",
  };
  const dims = {} as Record<PriceDimension, PriceDimState>;
  for (const dimension of PRICE_DIMENSIONS) {
    dims[dimension] =
      dimension in amounts
        ? { status: "known", amount: amounts[dimension] }
        : { status: "unknown", reason: "price_dim_no_source" };
  }
  return assertPriceSnapshotDims(dims, "audio-evidence v1 fixture");
}

/** The basis that prices the recognition dimensions (a future wire, or a curated cell). */
function audioPricedDims(): PriceSnapshotDims {
  return assertPriceSnapshotDims(
    {
      ...v1Dims(),
      audio_input: { status: "known", amount: "0.0006" },
      audio_output: { status: "known", amount: "0.0006" },
      image_output: { status: "known", amount: "0" },
      video: { status: "known", amount: "0" },
    } as PriceSnapshotDims,
    "audio-evidence priced fixture",
  );
}

// ── AC4: the enumeration covers the actual entrances, and the checked absences ──

test("the registry enumerates the gateway's actual audio routes with their anchors", () => {
  const entrances = AUDIO_CAPABILITY_EVIDENCE.filter((record) => record.exists);
  expect(
    entrances.map(
      (record) => `${record.path}${record.stream ? " (stream)" : ""}`,
    ),
  ).toEqual([
    "/v1/audio/transcriptions",
    "/v1/audio/transcriptions (stream)",
    "/v1/audio/speech",
    "/v1/audio/speech (stream)",
    "/v1/audio/translations",
  ]);
  // Each SERVED entrance carries the anchor naming where the pinned gateway routes it;
  // translations' anchor names its only reference (the passthrough classifier), checked
  // in its own test below.
  for (const record of entrances.filter(
    (entry) => entry.family === "recognition" || entry.family === "synthesis",
  )) {
    expect(record.sourceAnchor).toMatch(
      /core\/providers\/openai\/openai\.go:\d+/,
    );
  }
  // No (path, stream) identity twice: a duplicate row would be an enumeration bug the
  // same way a missing one would.
  const identities = new Set(
    AUDIO_CAPABILITY_EVIDENCE.map(
      (record) => `${record.path}:${record.stream}`,
    ),
  );
  expect(identities.size).toBe(AUDIO_CAPABILITY_EVIDENCE.length);
});

test("translations is recorded as a real-but-unwired path, absences as absences", () => {
  // /v1/audio/translations exists on the OpenAI wire and the gateway bills it ONLY as a
  // passthrough (no dedicated provider method): the record says so with the anchor of
  // its only reference, and its missing items name exactly what a future ticket must
  // wire before it may be enabled.
  const translations = AUDIO_CAPABILITY_EVIDENCE.find(
    (record) => record.path === "/v1/audio/translations",
  );
  expect(translations).toMatchObject({
    exists: true,
    sourceAnchor: "core/providers/openai/passthrough_usage.go:38",
  });
  expect(translations?.missingItems.length).toBeGreaterThan(0);

  // The families someone might PRESUME are audio capabilities are recorded as checked
  // absences: diarization is a response_format of transcriptions, not an entrance.
  const absent = AUDIO_CAPABILITY_EVIDENCE.filter((record) => !record.exists);
  expect(absent.length).toBe(1);
  expect(absent[0].family).toBe("separation-enhancement");
  expect(absent[0].sourceAnchor).toBe("core/schemas/transcriptions.go:23");
  expect(absent[0].missingItems[0].code).toBe("no_gateway_entrypoint");
});

// ── AC1 + AC3: every record's evidence structure is complete and reproducible ──

test("every record carries closed-vocabulary dimensions, boundary evidence, and a runnable verification", () => {
  for (const record of AUDIO_CAPABILITY_EVIDENCE) {
    // Billing dimensions are the closed vocabulary's own names — or, for the units that
    // live outside it (speech's per-character side), named as non-vocabulary units with
    // their versioned home, never smuggled onto a token dimension with the wrong unit.
    for (const dimension of record.billedDimensions) {
      expect(PRICE_DIMENSIONS).toContain(dimension);
    }
    for (const unit of record.nonVocabularyUnits) {
      expect(unit).toMatch(/^[a-z_]+ \(.*\)$/);
    }
    // Boundary evidence states the side, the mechanism, and the verifier — the shape
    // 22.3 reads as the conformance input.
    for (const bound of record.boundaryEvidence) {
      expect(["input", "output"]).toContain(bound.side);
      expect(bound.mechanism.length).toBeGreaterThan(0);
      expect(bound.verifier.length).toBeGreaterThan(0);
    }
    // The verification environment is recorded, and every command it names runs against
    // suite files that exist in this tree — reproducible by re-running, not by trusting.
    expect(["local-deterministic", "provider-real"]).toContain(
      record.verification.environment,
    );
    for (const command of record.verification.commands) {
      const file = command
        .split(" ")
        .find((token) => token.includes("/tests/"));
      expect(file).toBeDefined();
      expect(existsSync(resolve(ROOT, file!))).toBe(true);
    }
  }
});

// ── AC2: unproven paths stay unenabled, with the missing items visible ──

test("on the v1 wire no audio path is enableable — and the gaps are visible", () => {
  expect(enableableAudioPaths(v1Dims())).toEqual([]);

  const gaps = audioPathsWithEvidenceGaps(v1Dims());
  const gapPaths = gaps.map((gap) => gap.path);
  // Every path the registry carries reports its gap on the v1 basis — none silently
  // drops out of the report, and the absence record is not an evidence gap at all.
  expect(gapPaths).toContain("/v1/audio/transcriptions");
  expect(gapPaths).toContain("/v1/audio/speech");
  expect(gapPaths).toContain("/v1/audio/translations");
  expect(gapPaths).not.toContain(expect.stringContaining("separation"));

  const transcriptionGap = gaps.find(
    (gap) => gap.path === "/v1/audio/transcriptions",
  );
  // 14.1's own billed dimensions, in its own order — the gap names them with the
  // per-dimension reasons the basis itself carries.
  expect(transcriptionGap?.missingDimensions).toEqual(
    TRANSCRIPTION_BILLED_DIMENSIONS.filter(
      (dimension) => v1Dims()[dimension].status === "unknown",
    ).map((dimension) => ({
      dimension,
      reason: "price_dim_no_source",
    })),
  );
});

test("a basis that prices the recognition dimensions enables exactly that path", () => {
  const enableable = enableableAudioPaths(audioPricedDims());
  expect(
    enableable.map(
      (record) => `${record.path}${record.stream ? " (stream)" : ""}`,
    ),
  ).toEqual(["/v1/audio/transcriptions", "/v1/audio/transcriptions (stream)"]);
  // Speech stays unenabled even on this basis: its tier table is what a future wire
  // field would fill, and the honest answer today is the empty table (13.1's own
  // constructor), recorded as the missing item — not a presumed rate.
  const speechGap = audioPathsWithEvidenceGaps(audioPricedDims()).find(
    (gap) => gap.path === "/v1/audio/speech",
  );
  expect(speechGap?.missingItems).toEqual([
    {
      code: "no_wire_price_source",
      detail:
        "speech tier table is empty by construction (speechTierPriceTableFromSnapshot)",
    },
  ]);
});
