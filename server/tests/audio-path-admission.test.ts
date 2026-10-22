import { describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  assessAudioPathAvailability,
  createAudioPathAdmission,
} from "../src/billing/audio-path-admission";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import {
  assertPriceSnapshotDims,
  PRICE_DIMENSIONS,
  type PriceDimension,
  type PriceDimState,
  type PriceSnapshotDims,
} from "../src/gateway/price-snapshot";

/*
 * Bifrost #313 (14.4): the unverified audio path stays uncallable — the admission gate
 * 14.3's evidence registry wires in BEFORE any reserve call and any provider dispatch.
 *
 * WHAT THE ACs DEMAND OF THESE TESTS:
 *   未验证音频路径不可调用，供应商调用数为 0 — the passthrough-only translations path
 *     refuses at the evidence stage; the reserve door is never asked and the provider
 *     dispatch spy records ZERO calls (the structural proof, in the composition's own
 *     seam);
 *   拒绝原因指向缺失的具体证据项 — the refusal's detail carries the registry's own
 *     missing-item CODES (no_input_meter_wired / no_admission_wiring /
 *     no_wire_price_source), not a generic failure;
 *   拒绝不产生任何账务写入 — the reserve spy answers 0 calls on every refusal, and the
 *     gate itself writes nothing (its only seams are the injected spies);
 *   补齐证据后路径可启用，无需改动其他能力 — a record whose gaps are closed (the
 *     transcription entrance: structurally complete, priced basis) admits through the
 *     door and dispatches, while the SAME basis keeps every other record's verdict
 *     exactly as it was; flipping one dimension's price flips only the paths that bill
 *     it.
 *
 * The bases are 03.2-shaped fixture dims (the transcriptions record bills audio_input,
 * output and surcharge_per_request; the speech record is honestly unenableable — its tier
 * table is empty by construction until the wire grows audio fields).
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
    "audio-path-admission fixture",
  );
}

function unknown(
  reason:
    | "price_dim_no_source"
    | "price_dim_unreadable" = "price_dim_no_source",
): PriceDimState {
  return { status: "unknown", reason };
}

/** The spies the composition's own seams become in tests. */
function spies() {
  const calls = {
    reserve: 0,
    dispatch: 0,
    reserveRequests: [] as unknown[],
    dispatchInputs: [] as unknown[],
  };
  return {
    calls,
    admission: createAudioPathAdmission({
      reserve: async (request: unknown) => {
        calls.reserve += 1;
        calls.reserveRequests.push(request);
        return {
          status: "reserved",
          reservationId: "cr-test",
          attemptId: "attempt-test",
          maximumCredits: 42,
          snapshotVersion: 3,
          rateVersion: 1,
        };
      },
      dispatch: async (input: unknown) => {
        calls.dispatch += 1;
        calls.dispatchInputs.push(input);
        return { ok: true };
      },
    }),
  };
}

/** The transcription entrance's certified quantities, as 14.1's own assessor hands them. */
function transcriptionQuantities() {
  return Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [
      dimension,
      dimension === "audio_input"
        ? 30
        : dimension === "output"
          ? 2000
          : dimension === "surcharge_per_request"
            ? 1
            : 0,
    ]),
  ) as Record<PriceDimension, number>;
}

function admissionInput(overrides: Record<string, unknown> = {}) {
  return {
    path: "/v1/audio/transcriptions",
    stream: false,
    model: { provider: "openai", model: "whisper-1", capability: "transcription" },
    quantities: transcriptionQuantities(),
    grantId: "grant-1",
    payer: { kind: "personal", id: "user-1" },
    snapshotVersion: 3,
    rateVersion: 1,
    dims: dims(),
    rate: RATE_100,
    idempotencyKey: "idem-1",
    ...overrides,
  };
}

describe("Bifrost 14.4 (#313): unverified paths refuse at the evidence stage", () => {
  test("the passthrough-only translations path is not callable — zero reserve, zero dispatch", async () => {
    const { admission, calls } = spies();
    const outcome = await admission.admit(
      admissionInput({ path: "/v1/audio/translations", stream: false }),
    );
    expect(outcome).toEqual({
      status: "refused",
      stage: "evidence",
      reasonCode: "audio_path_unverified",
      detail: {
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
    });
    expect(calls.reserve).toBe(0);
    expect(calls.dispatch).toBe(0);
  });

  test("the refusal names the SPECIFIC missing evidence item codes, not a generic failure", () => {
    const verdict = assessAudioPathAvailability({
      path: "/v1/audio/translations",
      stream: false,
      dims: dims(),
    });
    expect(verdict.available).toBe(false);
    if (verdict.available) return;
    expect(verdict.reasonCode).toBe("audio_path_unverified");
    const codes = verdict.missingItems.map((item) => item.code).sort();
    expect(codes).toEqual([
      "no_admission_wiring",
      "no_input_meter_wired",
      "no_wire_price_source",
    ]);
    for (const item of verdict.missingItems) {
      expect(item.detail.length).toBeGreaterThan(0);
    }
  });

  test("a family that is not an entrance refuses as such — separation/enhancement and the unknown alike", async () => {
    const { admission, calls } = spies();
    const separation = await admission.admit(
      admissionInput({ path: "audio/separation-enhancement", stream: false }),
    );
    expect(separation).toEqual({
      status: "refused",
      stage: "evidence",
      reasonCode: "audio_path_not_an_entrance",
      detail: { missingItems: [] },
    });
    const unknownPath = await admission.admit(
      admissionInput({ path: "/v1/audio/denoise", stream: false }),
    );
    expect(unknownPath).toEqual({
      status: "refused",
      stage: "evidence",
      reasonCode: "audio_path_not_an_entrance",
      detail: { missingItems: [] },
    });
    expect(calls.reserve).toBe(0);
    expect(calls.dispatch).toBe(0);
  });

  test("a basis that leaves a billed dimension unknown refuses at the enablement stage, naming it", async () => {
    const { admission, calls } = spies();
    const outcome = await admission.admit(
      admissionInput({ dims: dims({ audio_input: unknown() }) }),
    );
    expect(outcome).toEqual({
      status: "refused",
      stage: "enablement",
      reasonCode: "price_unknown",
      detail: {
        dimensions: [{ dimension: "audio_input", reason: "price_dim_no_source" }],
      },
    });
    expect(calls.reserve).toBe(0);
    expect(calls.dispatch).toBe(0);
  });
});

describe("Bifrost 14.4 (#313): evidence completed enables the path, and only it", () => {
  test("the transcriptions entrance (structurally complete, priced basis) admits and dispatches once", async () => {
    const { admission, calls } = spies();
    const outcome = await admission.admit(admissionInput());
    expect(outcome.status).toBe("admitted");
    if (outcome.status !== "admitted") return;
    expect(outcome.path).toBe("/v1/audio/transcriptions");
    expect(outcome.family).toBe("recognition");
    expect(outcome.stream).toBe(false);
    expect(calls.reserve).toBe(1);
    expect(calls.dispatch).toBe(1);
    // 30s × $0.0001 + 2000 × $0.0000002 + 1 × $0.0001 = $0.0035 → ×10000 = 35 units exactly.
    expect(calls.reserveRequests[0]).toMatchObject({ maximumCredits: 35 });
    expect(calls.dispatchInputs[0]).toMatchObject({
      path: "/v1/audio/transcriptions",
      stream: false,
      reservationId: "cr-test",
    });
  });

  test("flipping one dimension's price flips only the paths that bill it", () => {
    // audio_input unknown: transcriptions (bills it) refuses; the speech path's verdict
    // and the translations verdict are unchanged by the same basis — no capability's
    // verdict moves because another's evidence closed.
    const withoutAudioInput = dims({ audio_input: unknown() });
    const withAudioInput = dims();
    const transcriptionBefore = assessAudioPathAvailability({
      path: "/v1/audio/transcriptions",
      stream: false,
      dims: withoutAudioInput,
    });
    const transcriptionAfter = assessAudioPathAvailability({
      path: "/v1/audio/transcriptions",
      stream: false,
      dims: withAudioInput,
    });
    expect(transcriptionBefore.available).toBe(false);
    expect(transcriptionAfter.available).toBe(true);
    for (const dimsBasis of [withoutAudioInput, withAudioInput]) {
      const translations = assessAudioPathAvailability({
        path: "/v1/audio/translations",
        stream: false,
        dims: dimsBasis,
      });
      expect(translations.available).toBe(false);
      const speech = assessAudioPathAvailability({
        path: "/v1/audio/speech",
        stream: false,
        dims: dimsBasis,
      });
      // The synthesis record is honestly unenableable: its tier table is empty by
      // construction until the wire grows audio fields — the refusal names that.
      expect(speech.available).toBe(false);
      if (!speech.available) {
        expect(speech.reasonCode).toBe("audio_path_unverified");
        expect(
          speech.missingItems.some(
            (item) =>
              item.code === "no_wire_price_source" &&
              item.detail.includes("tier table is empty"),
          ),
        ).toBe(true);
      }
    }
  });

  test("a free basis refuses with the zero-ceiling code — free is the caller's policy, never a silent pass", async () => {
    const { admission, calls } = spies();
    const freeDims = dims(
      Object.fromEntries(
        PRICE_DIMENSIONS.map((dimension) => [
          dimension,
          { status: "known", amount: "0" },
        ]),
      ) as Partial<Record<PriceDimension, PriceDimState>>,
    );
    const outcome = await admission.admit(admissionInput({ dims: freeDims }));
    expect(outcome).toEqual({
      status: "refused",
      stage: "ceiling",
      reasonCode: "free_basis_zero_ceiling",
      detail: { path: "/v1/audio/transcriptions", stream: false },
    });
    expect(calls.reserve).toBe(0);
    expect(calls.dispatch).toBe(0);
  });

  test("a refused reserve passes the door's own reason through — and dispatches nothing", async () => {
    const calls = { reserve: 0, dispatch: 0 };
    const admission = createAudioPathAdmission({
      reserve: async () => {
        calls.reserve += 1;
        return {
          status: "refused",
          reasonCode: "insufficient_credits",
          detail: { balance: 1 },
        };
      },
      dispatch: async () => {
        calls.dispatch += 1;
        return { ok: true };
      },
    });
    const outcome = await admission.admit(admissionInput());
    expect(outcome).toEqual({
      status: "refused",
      stage: "reserve",
      reasonCode: "insufficient_credits",
      detail: { balance: 1 },
    });
    expect(calls.reserve).toBe(1);
    expect(calls.dispatch).toBe(0);
  });
});
