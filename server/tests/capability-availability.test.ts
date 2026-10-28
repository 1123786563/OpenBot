import { describe, expect, test } from "../../tests/support/bun-test-compat";
import type { ConversionRate } from "../src/gateway/conversion-rate";
import {
  PRICE_DIMENSIONS,
  type PriceDimension,
  type PriceSnapshotDims,
} from "../src/gateway/price-snapshot";
import {
  createOcrAdmission,
  type OcrAdmissionDependencies,
} from "../src/billing/ocr-admission";
import { summarizeCapabilityAvailability } from "../src/gateway/capability-availability";
import { summarizeVideoSpecAvailability } from "../src/billing/video-spec-availability";
import { createVideoSubmitService } from "../src/billing/video-submit";
import { videoTierPriceTableFromSnapshot } from "../src/billing/video-generation-pricing";

/*
 * Ticket 11.6 (#301) — unknown OCR prices are never executed as free, and the free/unknown
 * distinction is visible on every surface that answers capability availability.
 *
 *   AC-1  价格未知的 OCR 请求被拒绝，供应商调用数为 0 — the admission door refuses an
 *         unknown basis at the enablement stage: the reserve door is never called (no hold,
 *         no ledger — 无账务写入), and the dispatch spy is never called either (供应商调用
 *         数为 0);
 *   AC-2  明确免费的 OCR 可执行 — a basis whose every billed dimension is priced exactly
 *         zero dispatches, hold-free, under the caller's own authorization gates;
 *   AC-3  free 与 unknown 展示不同 — the availability summary answers them as different
 *         states with different words, and a MISSING dimension is never a free one;
 *   AC-4  三类能力的启用状态与原因可查询 — the summary answers embedding/rerank/ocr each
 *         against its own billed dimensions, with the missing-dimension worklist when a
 *         basis refuses.
 */

const RATE: ConversionRate = { numerator: 100n, denominator: 1n };

/** A fully-priced vocabulary — the same shape 11.5's own tests certify against. */
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

/** Build 03.2-shaped dims: every dimension known by default, the overrides applied. */
function dims(
  overrides: Partial<
    Record<PriceDimension, PriceSnapshotDims[PriceDimension]>
  > = {},
): PriceSnapshotDims {
  const base = {} as Record<PriceDimension, PriceSnapshotDims[PriceDimension]>;
  for (const dimension of PRICE_DIMENSIONS) {
    base[dimension] = { status: "known", amount: FULL_AMOUNTS[dimension] };
  }
  for (const [dimension, state] of Object.entries(overrides)) {
    if (state !== undefined) {
      base[dimension as PriceDimension] = state;
    }
  }
  return base;
}

/** The unknown state a basis with no source for a dimension carries. */
function unknown(): PriceSnapshotDims[PriceDimension] {
  return { status: "unknown", reason: "price_dim_no_source" };
}

/** The three dimensions an OCR call bills, all known — the priced-base fixture. */
function ocrPriced(
  overrides: Partial<
    Record<PriceDimension, PriceSnapshotDims[PriceDimension]>
  > = {},
) {
  return dims(overrides);
}

/** Spies for the door's two seams — the reserve call count and the provider call count. */
function spies(reserveAnswer?: {
  status: "reserved" | "refused";
  [k: string]: unknown;
}) {
  const calls = { reserve: 0, dispatch: 0, freeDispatches: 0 };
  const lastReserve: { request: unknown } = { request: undefined };
  const dependencies: OcrAdmissionDependencies = {
    reserve: async (request: unknown) => {
      calls.reserve++;
      lastReserve.request = request;
      if (reserveAnswer) return reserveAnswer;
      return {
        status: "reserved",
        reservationId: "cr-ocr-1",
        attemptId: "att-ocr-1",
        maximumCredits: 500,
        snapshotVersion: 4,
        rateVersion: 2,
      };
    },
    dispatch: async (input: { free: boolean }) => {
      calls.dispatch++;
      if (input.free) calls.freeDispatches++;
      return { ok: true };
    },
  };
  return { calls, lastReserve, dependencies };
}

const MODEL = {
  provider: "prov-ocr",
  model: "model-ocr",
  capability: "ocr",
} as const;

const DOCUMENT_REQUEST = {
  model: MODEL.model,
  document: { type: "document_url", document_url: "https://example.test/doc" },
  params: { pages: [1, 2, 3] },
};

function admissionInput(overrides: Record<string, unknown> = {}) {
  return {
    request: DOCUMENT_REQUEST,
    grantId: "grant-ocr-1",
    payer: { kind: "personal", id: "user-ocr-1" },
    model: MODEL,
    snapshotVersion: 4,
    rateVersion: 2,
    dims: ocrPriced(),
    rate: RATE,
    outputTokenCap: 20000,
    idempotencyKey: "idem-ocr-1",
    ...overrides,
  };
}

describe("Bifrost 11.6 (#301): the OCR entry refuses unknown prices (AC1)", () => {
  test("an unknown output price refuses — no reserve call, no provider call, no money", async () => {
    const { calls, dependencies } = spies();
    const entry = createOcrAdmission(dependencies);
    const outcome = await entry.admit(
      admissionInput({ dims: ocrPriced({ output: unknown() }) }),
    );
    expect(outcome).toEqual({
      status: "refused",
      stage: "enablement",
      reasonCode: "price_unknown",
      detail: { dimension: "output", reason: "price_dim_no_source" },
    });
    // 供应商调用数为 0 且无账务写入: neither seam was ever touched.
    expect(calls.reserve).toBe(0);
    expect(calls.dispatch).toBe(0);
  });

  test("every billed dimension is checked — unknown flat or image side refuses the same way", async () => {
    const { calls, dependencies } = spies();
    const entry = createOcrAdmission(dependencies);
    for (const dimension of ["surcharge_per_request", "image"] as const) {
      const outcome = await entry.admit(
        admissionInput({ dims: ocrPriced({ [dimension]: unknown() }) }),
      );
      expect(outcome.status).toBe("refused");
      if (outcome.status === "refused") {
        expect(outcome.stage).toBe("enablement");
        expect(outcome.reasonCode).toBe("price_unknown");
      }
    }
    expect(calls.reserve).toBe(0);
    expect(calls.dispatch).toBe(0);
  });

  test("the input-bound refusals never reach the door either — pages unpinned, cap absent", async () => {
    const { calls, dependencies } = spies();
    const entry = createOcrAdmission(dependencies);
    const unpinned = await entry.admit(
      admissionInput({
        request: {
          ...DOCUMENT_REQUEST,
          params: {},
        },
      }),
    );
    expect(unpinned).toEqual({
      status: "refused",
      stage: "enablement",
      reasonCode: "ocr_pages_indeterminable",
      detail: { shape: "pages_not_pinned" },
    });
    const uncapped = await entry.admit(admissionInput({ outputTokenCap: 0 }));
    expect(uncapped).toEqual({
      status: "refused",
      stage: "enablement",
      reasonCode: "ocr_output_uncapped",
      detail: {},
    });
    expect(calls.reserve).toBe(0);
    expect(calls.dispatch).toBe(0);
  });

  test("the door's own refusals pass through — and dispatch nothing", async () => {
    const { calls, dependencies } = spies({
      status: "refused",
      reasonCode: "insufficient_credits",
      detail: { availableCredits: 1 },
    });
    const entry = createOcrAdmission(dependencies);
    const outcome = await entry.admit(admissionInput());
    expect(outcome).toEqual({
      status: "refused",
      stage: "reserve",
      reasonCode: "insufficient_credits",
      detail: { availableCredits: 1 },
    });
    expect(calls.reserve).toBe(1);
    expect(calls.dispatch).toBe(0);
  });
});

describe("Bifrost 11.6 (#301): explicit free executes; free is never a missing dimension (AC2)", () => {
  test("a basis pricing every billed dimension exactly zero dispatches hold-free", async () => {
    const { calls, dependencies } = spies();
    const entry = createOcrAdmission(dependencies);
    const outcome = await entry.admit(
      admissionInput({
        dims: ocrPriced({
          surcharge_per_request: { status: "known", amount: "0" },
          image: { status: "known", amount: "0" },
          output: { status: "known", amount: "0" },
        }),
      }),
    );
    expect(outcome.status).toBe("free");
    // Free dispatches once, without a hold — and the reserve door is never asked.
    expect(calls.dispatch).toBe(1);
    expect(calls.freeDispatches).toBe(1);
    expect(calls.reserve).toBe(0);
  });

  test("free comes only from the basis's own zero prices — a missing dimension is unknown, never free", async () => {
    const { calls, dependencies } = spies();
    const entry = createOcrAdmission(dependencies);
    // Two dimensions zero, one unknown: the absence refuses, it does not average to free.
    const outcome = await entry.admit(
      admissionInput({
        dims: ocrPriced({
          surcharge_per_request: { status: "known", amount: "0" },
          image: { status: "known", amount: "0" },
          output: unknown(),
        }),
      }),
    );
    expect(outcome.status).toBe("refused");
    expect(calls.dispatch).toBe(0);
  });

  test("a priced basis reserves then dispatches — the door's contract, the hold's ceiling", async () => {
    const { calls, lastReserve, dependencies } = spies();
    const entry = createOcrAdmission(dependencies);
    const outcome = await entry.admit(admissionInput());
    expect(outcome.status).toBe("admitted");
    if (outcome.status !== "admitted") return;
    expect(outcome.reservationId).toBe("cr-ocr-1");
    expect(outcome.attemptId).toBe("att-ocr-1");
    expect(calls.reserve).toBe(1);
    expect(calls.dispatch).toBe(1);
    expect(calls.freeDispatches).toBe(0);

    const request = lastReserve.request as {
      model: { capability: string };
      boundEvidence: { kind: string; maximumTokens: number }[];
      maximumCredits: number;
      idempotencyKey: string;
    };
    expect(request.model.capability).toBe("ocr");
    expect(request.boundEvidence).toEqual([
      { kind: "provider_max_tokens", maximumTokens: 20000 },
      { kind: "self_enforced_input_refusal", maximumTokens: 3 },
    ]);
    expect(request.maximumCredits).toBeGreaterThan(0);
    expect(request.idempotencyKey).toBe("idem-ocr-1");
  });
});

describe("Bifrost 11.6 (#301): the three-capability availability summary (AC3, AC4)", () => {
  test("free and unknown answer as different states with different words — never conflated", () => {
    const summary = summarizeCapabilityAvailability({
      snapshots: [
        {
          ref: { provider: "p", model: "m-free", capability: "ocr" },
          dims: ocrPriced({
            surcharge_per_request: { status: "known", amount: "0" },
            image: { status: "known", amount: "0" },
            output: { status: "known", amount: "0" },
          }),
        },
        {
          ref: { provider: "p", model: "m-unknown", capability: "embedding" },
          dims: dims({ input: unknown() }),
        },
      ],
    });
    const ocr = summary.find((entry) => entry.capability === "ocr");
    const embedding = summary.find((entry) => entry.capability === "embedding");
    expect(ocr?.state).toBe("free");
    expect(ocr?.reasonCode).toBeUndefined();
    expect(embedding?.state).toBe("price_unknown");
    expect(embedding?.reasonCode).toBe("capability_price_unknown");
    // The two states are different words with different reasons — the display contract.
    expect(ocr?.state).not.toBe(embedding?.state);
    expect(embedding?.missingDimensions).toEqual([
      {
        ref: { provider: "p", model: "m-unknown", capability: "embedding" },
        dimension: "input",
        reasonCode: "price_dim_no_source",
      },
    ]);
    // Rerank has no cell at all: unmapped is a different answer than unknown.
    const rerank = summary.find((entry) => entry.capability === "rerank");
    expect(rerank?.state).toBe("unmapped");
    expect(rerank?.reasonCode).toBe("capability_unmapped");
    expect(rerank?.missingDimensions).toBeUndefined();
  });

  test("one available cell enables the capability; the unknown cell stays named", () => {
    const summary = summarizeCapabilityAvailability({
      snapshots: [
        {
          ref: { provider: "p", model: "ocr-broken", capability: "ocr" },
          dims: ocrPriced({ output: unknown() }),
        },
        {
          ref: { provider: "p", model: "ocr-good", capability: "ocr" },
          dims: ocrPriced(),
        },
      ],
    });
    const ocr = summary.find((entry) => entry.capability === "ocr");
    expect(ocr?.state).toBe("enabled");
    expect(ocr?.cells).toEqual([
      {
        ref: { provider: "p", model: "ocr-good", capability: "ocr" },
        free: false,
      },
    ]);
  });

  test("each capability consults its own billed dimensions, not its neighbour's", () => {
    // An image-priced, embedding-unpriced cell enables nothing for embedding and says so:
    // only the dimensions embedding bills (input, the flat side) are consulted.
    const summary = summarizeCapabilityAvailability({
      snapshots: [
        {
          ref: { provider: "p", model: "m", capability: "embedding" },
          dims: dims({
            image: { status: "known", amount: "0.01" },
            input: unknown(),
          }),
        },
      ],
    });
    const embedding = summary.find((entry) => entry.capability === "embedding");
    expect(embedding?.state).toBe("price_unknown");
    expect(embedding?.missingDimensions?.map((m) => m.dimension)).toEqual([
      "input",
    ]);
  });
});

/*
 * Ticket 19.2 (#338) — an unpriced video spec is not selectable, not callable, and says
 * exactly which dimension it is missing; a re-priced basis flips the same verdict on.
 *
 *   AC-1  未定价的视频规格不可选择、不可调用，供应商派发数为 0 — the availability
 *         summary answers price_unknown per cell/method (not a family switch), and the
 *         forced call refuses at the enablement stage: the submit service (reserve door,
 *         job row, dispatch — the whole money seam) is never called;
 *   AC-2  不可用原因指向缺失的具体维度 — the refusal and the summary both name `video`
 *         with its own per-dimension reason;
 *   AC-3  拒绝不产生任何账务写入 — no reserve call forms a hold, so no ledger row can
 *         land (the door's own zero-write guarantee is the reserve suite's contract; the
 *         proof here is the door never being reached);
 *   AC-4  补齐定价后该规格可启用 — the same pure reads on the re-priced basis answer
 *         enabled/free, and the same submit gate then admits the identical request.
 */
describe("Bifrost 19.2 (#338): unpriced video specs are unavailable, and say why", () => {
  const videoRef = {
    provider: "p",
    model: "veo-cell",
    capability: "video",
  } as const;

  function submitGateSpy(dims: PriceSnapshotDims) {
    let submitCalls = 0;
    const service = createVideoSubmitService({
      resolveBasis: async () => ({ ok: true as const, dims, rate: RATE }),
      asyncSubmit: async () => {
        submitCalls += 1;
        return { status: "submitted" as const, jobId: "aj-v" };
      },
      tierTableFor: async (basis) => videoTierPriceTableFromSnapshot(basis),
    });
    return {
      submitCalls: () => submitCalls,
      call: (request: unknown) =>
        service.submitVideo({
          submitIdempotencyKey: "video-19-2",
          grantId: "grant-1",
          payer: { kind: "personal", id: "user-1" },
          model: { provider: "p", model: "veo-cell", capability: "video" },
          snapshotVersion: 1,
          rateVersion: 0,
          request,
        }),
    };
  }

  test("a video cell whose basis prices `video` is available; the unpriced cell is price_unknown with the dimension named (AC1/AC2)", () => {
    const summary = summarizeVideoSpecAvailability({
      snapshots: [
        { ref: videoRef, dims: dims() },
        {
          ref: { provider: "p", model: "veo-unpriced", capability: "video" },
          dims: dims({ video: unknown() }),
        },
      ],
    });
    expect(summary.capability).toBe("video");
    const priced = summary.cells.find((cell) => cell.ref.model === "veo-cell");
    expect(priced?.methods.find((m) => m.method === "generation")).toEqual({
      method: "generation",
      state: "enabled",
      free: false,
    });
    const unpriced = summary.cells.find(
      (cell) => cell.ref.model === "veo-unpriced",
    );
    expect(unpriced?.methods.find((m) => m.method === "generation")).toEqual({
      method: "generation",
      state: "price_unknown",
      reasonCode: "video_spec_price_unknown",
      missingDimensions: [
        { dimension: "video", reasonCode: "price_dim_no_source" },
      ],
    });
  });

  test("availability is per model + method, never a family switch — the same model's unpriced cell does not darken its priced sibling (Resume hint)", () => {
    const summary = summarizeVideoSpecAvailability({
      snapshots: [
        { ref: videoRef, dims: dims() },
        {
          ref: { provider: "p", model: "veo-unpriced", capability: "video" },
          dims: dims({ video: unknown() }),
        },
      ],
    });
    // The priced cell stays selectable while its sibling refuses: same provider, same
    // capability, different basis — the verdict is the cell's own, never the family's.
    expect(
      summary.cells.find((c) => c.ref.model === "veo-cell")?.methods[0].state,
    ).toBe("enabled");
    expect(
      summary.cells.find((c) => c.ref.model === "veo-unpriced")?.methods[0]
        .state,
    ).toBe("price_unknown");
  });

  test("a cell with no snapshot at all is unmapped — a different answer than an unknown basis", () => {
    const summary = summarizeVideoSpecAvailability({
      snapshots: [{ ref: videoRef, dims: dims() }],
    });
    const listed = summary.cells.map((cell) => cell.ref.model);
    expect(listed).toEqual(["veo-cell"]);
  });

  test("a free basis answers free — a price of zero, never a missing dimension", () => {
    const summary = summarizeVideoSpecAvailability({
      snapshots: [
        {
          ref: videoRef,
          dims: dims({ video: { status: "known", amount: "0" } }),
        },
      ],
    });
    expect(
      summary.cells[0].methods.find((m) => m.method === "generation"),
    ).toEqual({ method: "generation", state: "free", free: true });
  });

  test("forcing a call on an unpriced spec refuses at the enablement stage — the whole submit seam uncalled, dispatch 0 (AC1/AC3)", async () => {
    const gate = submitGateSpy(dims({ video: unknown() }));
    const outcome = await gate.call({ seconds: 8, size: "1280x720" });
    expect(outcome).toEqual({
      status: "refused",
      stage: "enablement",
      reasonCode: "video_tier_price_unknown",
      detail: {
        code: "video_tier_price_unknown",
        dimension: "video",
        reason: "price_dim_no_source",
      },
    });
    expect(gate.submitCalls()).toBe(0);
  });

  test("re-pricing the basis flips the same verdict and the same gate on (AC4)", async () => {
    // Before: unpriced. After the administrator prices `video` on a new snapshot version,
    // the identical request is admitted — no other change, no other capability touched.
    const refused = await submitGateSpy(dims({ video: unknown() })).call({
      seconds: 8,
      size: "1280x720",
    });
    expect(refused.status).toBe("refused");
    const admitted = await submitGateSpy(
      dims({ video: { status: "known", amount: "0.01" } }),
    ).call({ seconds: 8, size: "1280x720" });
    expect(admitted.status).toBe("submitted");
  });
});
