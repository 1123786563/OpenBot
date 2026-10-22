import { describe, expect, test } from "../../tests/support/bun-test-compat";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import {
  PRICE_DIMENSIONS,
  type PriceDimension,
  type PriceDimState,
  type PriceSnapshotDims,
  assertPriceSnapshotDims,
} from "../src/gateway/price-snapshot";
import {
  SPEECH_DEFAULT_RESPONSE_FORMAT,
  SPEECH_RESPONSE_FORMATS,
  SPEECH_TAIL_REASON_CODES,
  assessSpeechTailConstraint,
  speechTailAvailabilityView,
} from "../src/billing/speech-tail-availability";
import {
  assessAudioPathAvailability,
  audioPathAvailabilityView,
  createAudioPathAdmission,
} from "../src/billing/audio-path-admission";
import { createModelDiscoveryRoutes } from "../src/gateway/model-discovery-routes";

/*
 * Ticket 13.4 (#309) — tail-unconstrainable speech paths stay unenabled, with the reason
 * queryable on the discovery interface and the admin surface, and a forced call refused
 * before any provider is reached.
 *
 *   AC-1  无法约束输出时长或尾部费用的语音路径不可用 — every response format except wav
 *         (the only container this gateway's own meters read) is unconstrainable on BOTH
 *         entrances, and the wire's own default (an absent format = mp3) is refused with it;
 *   AC-2  不可用原因可在发现接口与界面查询 — the availability view, the admin projection
 *         and the discovery route all answer the same reason pair for the same format;
 *   AC-3  强制调用不可用路径时被短路拒绝，供应商调用数为 0 — the admission composition
 *         refuses at the evidence stage, the reserve door is never asked, the dispatch spy
 *         never runs;
 *   AC-4  可约束路径正常执行且结算正确 — wav passes the tail stage and falls through to the
 *         price axis unchanged (today's honest refusal: the empty tier table); the
 *         constrainable path's settlement itself is pinned by the 13.2/13.3 suites this
 *         ticket re-runs as regression.
 */

const RATE_100: ConversionRate = { numerator: 100n, denominator: 1n };

/** A fully-priced vocabulary — every dimension known, video_input included (0202). */
const FULL_AMOUNTS: Record<PriceDimension, string> = {
  input: "0.000001",
  output: "0.000002",
  reasoning: "0.0000003",
  image: "0.01",
  image_output: "0.02",
  audio_input: "0.0001",
  audio_output: "0.0002",
  cache_read: "0.0000001",
  cache_write: "0.0000015",
  video: "0.01",
  video_input: "0.002",
  surcharge_web_search: "0.001",
  surcharge_per_request: "0.01",
  surcharge_tool_call: "0.002",
  surcharge_a2a_call: "0.003",
};

function fullyPricedDims(): PriceSnapshotDims {
  const base = {} as Record<PriceDimension, PriceDimState>;
  for (const dimension of PRICE_DIMENSIONS) {
    base[dimension] = { status: "known", amount: FULL_AMOUNTS[dimension] };
  }
  return assertPriceSnapshotDims(base, "speech-tail fixture");
}

/** The synthesis entrance's certified quantities, as 13.1's own assessor hands them. */
function speechQuantities() {
  return Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [
      dimension,
      dimension === "audio_output"
        ? 60
        : dimension === "surcharge_per_request"
          ? 1
          : 0,
    ]),
  ) as Record<PriceDimension, number>;
}

/** The spies the composition's own seams become in tests — the provider-call proof. */
function spies() {
  const calls = { reserve: 0, dispatch: 0 };
  return {
    calls,
    admission: createAudioPathAdmission({
      reserve: async () => {
        calls.reserve += 1;
        return {
          status: "reserved",
          reservationId: "cr-tail",
          attemptId: "attempt-tail",
          maximumCredits: 42,
          snapshotVersion: 3,
          rateVersion: 1,
        };
      },
      dispatch: async () => {
        calls.dispatch += 1;
        return { ok: true };
      },
    }),
  };
}

function speechAdmissionInput(overrides: Record<string, unknown> = {}) {
  return {
    path: "/v1/audio/speech",
    stream: false,
    model: { provider: "openai", model: "gpt-4o-mini-tts", capability: "speech" },
    quantities: speechQuantities(),
    grantId: "grant-tail",
    payer: { kind: "personal", id: "user-tail" },
    snapshotVersion: 3,
    rateVersion: 1,
    dims: fullyPricedDims(),
    rate: RATE_100,
    idempotencyKey: "idem-tail",
    ...overrides,
  };
}

describe("Bifrost 13.4 (#309): tail-unconstrainable speech paths stay unenabled", () => {
  test("AC1: only wav is constrainable — every other wire format, and the absent default, refuses with both reasons", () => {
    for (const stream of [false, true]) {
      const wav = assessSpeechTailConstraint({ stream, responseFormat: "wav" });
      expect(wav.constrainable).toBe(true);
      if (wav.constrainable) {
        expect(wav.format).toBe("wav");
        expect(wav.meter).toContain("WAV container metadata");
      }
      for (const format of SPEECH_RESPONSE_FORMATS) {
        if (format === "wav") continue;
        const verdict = assessSpeechTailConstraint({ stream, responseFormat: format });
        expect(verdict.constrainable).toBe(false);
        if (!verdict.constrainable) {
          expect(verdict.format).toBe(format);
          expect(verdict.reasons.map((reason) => reason.code)).toEqual([
            ...SPEECH_TAIL_REASON_CODES,
          ]);
          for (const reason of verdict.reasons) {
            expect(reason.detail).toContain(format);
          }
        }
      }
      // The wire's own default: an absent format IS mp3, and mp3 is unconstrainable.
      const absent = assessSpeechTailConstraint({ stream });
      expect(absent.constrainable).toBe(false);
      if (!absent.constrainable) {
        expect(absent.format).toBe(SPEECH_DEFAULT_RESPONSE_FORMAT);
      }
      // A format outside the wire's closed set is refused with itself named — never a pass.
      const alien = assessSpeechTailConstraint({ stream, responseFormat: "ogg" });
      expect(alien.constrainable).toBe(false);
      if (!alien.constrainable) {
        expect(alien.format).toBe("ogg");
        expect(alien.reasons[0].detail).toContain("not even in the wire's closed format set");
      }
    }
  });

  test("AC2: the availability view enables only wav per entrance and carries every unavailable reason", () => {
    const rows = speechTailAvailabilityView();
    expect(rows).toHaveLength(2 * SPEECH_RESPONSE_FORMATS.length);
    for (const stream of [false, true]) {
      const entrance = rows.filter((row) => row.stream === stream);
      // 不出现在可选列表: the enabled projection is exactly the constrainable formats.
      expect(entrance.filter((row) => row.enabled).map((row) => row.format)).toEqual([
        "wav",
      ]);
      for (const row of entrance) {
        expect(row.path).toBe("/v1/audio/speech");
        if (!row.enabled) {
          expect(row.reasons?.map((reason) => reason.code)).toEqual([
            ...SPEECH_TAIL_REASON_CODES,
          ]);
        } else {
          expect(row.reasons).toBeUndefined();
        }
      }
      const defaultRow = entrance.find(
        (row) => row.format === SPEECH_DEFAULT_RESPONSE_FORMAT,
      );
      expect(defaultRow?.defaultFormat).toBe(true);
      expect(defaultRow?.enabled).toBe(false);
    }
    // The admin projection rides the same verdict: synthesis rows carry the per-format
    // tailConstraint, non-synthesis rows do not (transcription bills its input audio).
    const adminRows = audioPathAvailabilityView([
      { ref: "openai/gpt-4o-mini-tts:speech", dims: fullyPricedDims() },
    ]);
    const synthesisRows = adminRows.filter((row) => row.family === "synthesis");
    expect(synthesisRows).toHaveLength(2);
    for (const row of synthesisRows) {
      expect(row.tailConstraint?.map((format) => format.enabled)).toEqual([
        false,
        false,
        false,
        false,
        true,
        false,
      ]);
      const refused = row.tailConstraint?.find(
        (format) => !format.enabled && format.format === "mp3",
      );
      expect(refused?.reasons?.map((reason) => reason.code)).toEqual([
        ...SPEECH_TAIL_REASON_CODES,
      ]);
    }
    for (const row of adminRows.filter((row) => row.family !== "synthesis")) {
      expect(row.tailConstraint).toBeUndefined();
    }
  });

  test("AC2: the discovery interface answers the unavailable reasons beside the model list", async () => {
    const discovery = createModelDiscoveryRoutes(
      {
        authenticate: async () => ({ botId: "bot-tail-1" }),
        botServices: {
          getBotService: async () => ({
            botId: "bot-tail-1",
            displayName: "Tail Bot",
            status: "active",
            capabilities: ["chat"],
          }),
        },
      },
      {
        selectable: () =>
          ({
            listSelectableModels: async () => ({ selectable: [], excluded: [] }),
          }) as never,
        priceSnapshots: () =>
          ({ listLatestPriceSnapshots: async () => [] }) as never,
      },
    );
    const response = await discovery.request("/", {
      headers: { authorization: "Bearer test-secret" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      bot: unknown;
      selectable: unknown;
      excluded: unknown;
      speechPaths: ReturnType<typeof speechTailAvailabilityView>;
    };
    // The additive member carries the same projection the door refuses by — one verdict,
    // every surface. The frozen keys keep their shapes beside it.
    expect(Object.keys(body).sort()).toEqual([
      "bot",
      "excluded",
      "selectable",
      "speechPaths",
    ]);
    expect(body.speechPaths).toEqual(speechTailAvailabilityView());
    const refusedDefault = body.speechPaths.find(
      (row) => row.defaultFormat && !row.enabled,
    );
    expect(refusedDefault?.format).toBe(SPEECH_DEFAULT_RESPONSE_FORMAT);
    expect(refusedDefault?.reasons?.map((reason) => reason.code)).toEqual([
      ...SPEECH_TAIL_REASON_CODES,
    ]);
  });

  test("AC3: a forced call on an unconstrainable path short-circuits — zero reserve, zero dispatch", async () => {
    // The wire default (absent format) is the case every naive caller hits.
    const absentFormat = spies();
    const refusedByDefault = await absentFormat.admission.admit(
      speechAdmissionInput({ responseFormat: undefined }),
    );
    expect(refusedByDefault).toEqual({
      status: "refused",
      stage: "evidence",
      reasonCode: "speech_tail_unconstrainable",
      detail: {
        stream: false,
        responseFormat: "mp3",
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: "generated_amount_undeterminable" }),
          expect.objectContaining({ code: "tail_cost_unenforceable" }),
        ]),
      },
    });
    expect(absentFormat.calls.reserve).toBe(0);
    expect(absentFormat.calls.dispatch).toBe(0);

    // The explicit formats, stream and not — the door refuses them all before the door.
    for (const stream of [false, true]) {
      for (const format of ["mp3", "opus", "aac", "flac", "pcm"]) {
        const spy = spies();
        const outcome = await spy.admission.admit(
          speechAdmissionInput({ stream, responseFormat: format }),
        );
        expect(outcome.status).toBe("refused");
        if (outcome.status === "refused") {
          expect(outcome.stage).toBe("evidence");
          expect(outcome.reasonCode).toBe("speech_tail_unconstrainable");
        }
        expect(spy.calls.reserve).toBe(0);
        expect(spy.calls.dispatch).toBe(0);
      }
    }
  });

  test("AC4: the constrainable format passes the tail stage and meets the price axis unchanged", () => {
    // wav on a fully-priced basis: the tail stage did NOT refuse it — the refusal it
    // meets is the price axis's own honest one (the tier table is empty until the wire
    // grows audio fields), exactly the verdict 14.4 recorded before this ticket.
    for (const stream of [false, true]) {
      const verdict = assessAudioPathAvailability({
        path: "/v1/audio/speech",
        stream,
        dims: fullyPricedDims(),
        responseFormat: "wav",
      });
      expect(verdict.available).toBe(false);
      if (!verdict.available) {
        expect(verdict.reasonCode).toBe("audio_path_unverified");
        expect(
          verdict.missingItems.some(
            (item) =>
              item.code === "no_wire_price_source" &&
              item.detail.includes("tier table is empty"),
          ),
        ).toBe(true);
      }
      // The unconstrainable format on the SAME basis refuses at the tail stage — the two
      // axes are independent, and the tail one is named first.
      const tailRefused = assessAudioPathAvailability({
        path: "/v1/audio/speech",
        stream,
        dims: fullyPricedDims(),
        responseFormat: "flac",
      });
      expect(tailRefused.available).toBe(false);
      if (!tailRefused.available) {
        expect(tailRefused.reasonCode).toBe("speech_tail_unconstrainable");
      }
    }
    // And the transcription entrance is untouched by the tail axis: no response format
    // consulted, its availability is 14.4's own derivation.
    const transcription = assessAudioPathAvailability({
      path: "/v1/audio/transcriptions",
      stream: false,
      dims: fullyPricedDims(),
    });
    expect(transcription.available).toBe(true);
  });
});
