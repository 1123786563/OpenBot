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
  surcharge_web_search: "0.001",
  surcharge_per_request: "0.01",
  surcharge_tool_call: "0.002",
  surcharge_a2a_call: "0.003",
};

/** Build 03.2-shaped dims: every dimension known by default, the overrides applied. */
function dims(
  overrides: Partial<Record<PriceDimension, PriceSnapshotDims[PriceDimension]>> = {},
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
  overrides: Partial<Record<PriceDimension, PriceSnapshotDims[PriceDimension]>> = {},
) {
  return dims(overrides);
}

/** Spies for the door's two seams — the reserve call count and the provider call count. */
function spies(reserveAnswer?: { status: "reserved" | "refused"; [k: string]: unknown }) {
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
      { ref: { provider: "p", model: "ocr-good", capability: "ocr" }, free: false },
    ]);
  });

  test("each capability consults its own billed dimensions, not its neighbour's", () => {
    // An image-priced, embedding-unpriced cell enables nothing for embedding and says so:
    // only the dimensions embedding bills (input, the flat side) are consulted.
    const summary = summarizeCapabilityAvailability({
      snapshots: [
        {
          ref: { provider: "p", model: "m", capability: "embedding" },
          dims: dims({ image: { status: "known", amount: "0.01" }, input: unknown() }),
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
