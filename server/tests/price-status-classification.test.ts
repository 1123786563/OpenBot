import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  mapPriceDims,
  PRICE_DIM_UNKNOWN_REASONS,
  type PriceSnapshot,
  type PriceSnapshotDims,
} from "../src/gateway/price-snapshot";
import {
  assertPriceStatusColumns,
  assertPriceStatusColumnsMatchDims,
  classifyPrice,
  classifyPriceDims,
  PRICE_STATUSES,
  PRICE_STATUS_UNKNOWN_REASONS,
  priceStatusColumns,
  type PriceStatusMissingDimension,
} from "../src/gateway/price-status";

/*
 * Bifrost 03.3 — the known/free/unknown price status classification, at the
 * pure seam (no database, no network). The input is one PriceSnapshot's dims
 * map (03.2's closed twelve-dimension vocabulary) and the output is the one
 * classification a model cell carries per snapshot version.
 *
 * What this file pins (AC06): a fully-priced cell with any non-zero amount is
 * `known`; a fully-priced cell whose necessary amounts are all exactly zero is
 * `free` — a PRICE state that still requires authorization, gating and
 * admission, never an access grant; a cell missing any necessary dimension is
 * `unknown` with a fixed reason code and the missing-dimension list, and
 * `unknown` can never be mistaken for a zero cost.
 *
 * Which dimensions are NECESSARY: the ones the gateway's v1 wire can price —
 * input, output, reasoning, image, cache read/write and the two surcharges.
 * The reserved dimensions (image output, audio in/out, video) have no wire
 * field at all in v1, for every model equally; they are a protocol-level gap,
 * not this model's missing price, and do not block known/free until the wire
 * grows their field (each such field arrives with its own migration, per the
 * vocabulary's rule).
 */

const FULLY_PRICED_PAID = {
  id: "openai/gpt-4o",
  pricing: {
    prompt: "0.0000025000",
    completion: "0.0000100000",
    request: "0.0",
    image: "0.0036130000",
    web_search: "0.0250000000",
    internal_reasoning: "0.0001000000",
    input_cache_read: "0.0000012500",
    input_cache_write: "0.0000031250",
  },
};

const FULLY_PRICED_FREE = {
  id: "openai/oss-20b",
  pricing: {
    prompt: "0.0",
    completion: "0.0",
    request: "0.0",
    image: "0.0",
    web_search: "0.0",
    internal_reasoning: "0.0",
    input_cache_read: "0.0",
    input_cache_write: "0.0",
  },
};

/** Only the input dimension is priced; the other seven necessary dims have no source. */
const ONLY_INPUT_PRICED = {
  id: "openai/gpt-4o-mini",
  pricing: { prompt: "0.0000015" },
};

/** The input field is present but is a JSON number — unreadable, not zero. */
const INPUT_UNREADABLE = {
  id: "openai/gpt-4o",
  pricing: {
    prompt: 0.0000025,
    completion: "0.0000100000",
    request: "0.0",
    image: "0.0",
    web_search: "0.0",
    internal_reasoning: "0.0",
    input_cache_read: "0.0",
    input_cache_write: "0.0",
  },
};

/** One unreadable dim (prompt) AND one no-source dim (completion) at once. */
const MIXED_MISSING_KINDS = {
  id: "openai/gpt-4o",
  pricing: {
    prompt: 5,
    request: "0.0",
    image: "0.0",
    web_search: "0.0",
    internal_reasoning: "0.0",
    input_cache_read: "0.0",
    input_cache_write: "0.0",
  },
};

/** Every priced dim is exactly zero, but one necessary dim carries no field at all. */
const ALL_ZERO_BUT_ONE_UNPRICED = {
  id: "openai/gpt-4o",
  pricing: {
    prompt: "0.0",
    completion: "0.0",
    request: "0.0",
    image: "0.0",
    internal_reasoning: "0.0",
    input_cache_read: "0.0",
    input_cache_write: "0.0",
  },
};

function dimsOf(rawEntry: Record<string, unknown>): PriceSnapshotDims {
  return mapPriceDims(rawEntry);
}

function snapshot(
  rawDims: PriceSnapshotDims,
  classification: PriceSnapshot["classification"],
): PriceSnapshot {
  return {
    ref: { provider: "openai", model: "gpt-4o", capability: "chat" },
    snapshotVersion: 3,
    dims: rawDims,
    fetchedAt: "2026-10-17T00:00:00.000Z",
    source: "gateway:/v1/models",
    configVersion: 7,
    rateVersion: 5,
    classification,
  };
}

describe("the classification vocabulary", () => {
  test("the status set is exactly known, free and unknown", () => {
    expect([...PRICE_STATUSES].sort()).toEqual(["free", "known", "unknown"]);
  });

  test("the unknown reason set is fixed and displayable", () => {
    expect([...PRICE_STATUS_UNKNOWN_REASONS]).toEqual([
      "price_status_dims_missing",
      "price_status_dims_unreadable",
    ]);
  });

  test("every status and reason code is a lowercase snake_case word", () => {
    for (const code of [...PRICE_STATUSES, ...PRICE_STATUS_UNKNOWN_REASONS]) {
      expect(code).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe("classifying the three fixture kinds", () => {
  test("a fully-priced cell with a non-zero amount is known", () => {
    expect(classifyPriceDims(dimsOf(FULLY_PRICED_PAID))).toEqual({
      status: "known",
    });
  });

  test("partly-zero pricing is still known — free needs every necessary amount at zero", () => {
    // FULLY_PRICED_PAID already prices `request` at exactly 0 while the rest cost.
    expect(classifyPriceDims(dimsOf(FULLY_PRICED_PAID)).status).toBe("known");
  });

  test("a fully-priced cell whose necessary amounts are all exactly zero is free", () => {
    expect(classifyPriceDims(dimsOf(FULLY_PRICED_FREE))).toEqual({
      status: "free",
    });
  });

  test("reserved dimensions the v1 wire cannot price never block known or free", () => {
    // Both fixtures leave image_output, audio_input, audio_output and video
    // unknown (no wire field) — the classification above is still known/free.
    const dims = dimsOf(FULLY_PRICED_FREE);
    expect(dims.image_output.status).toBe("unknown");
    expect(dims.video.status).toBe("unknown");
    expect(classifyPriceDims(dims).status).toBe("free");
  });

  test("a missing necessary dimension makes the cell unknown with the missing list", () => {
    const classification = classifyPriceDims(dimsOf(ONLY_INPUT_PRICED));
    expect(classification).toEqual({
      status: "unknown",
      reasonCode: "price_status_dims_missing",
      missingDimensions: [
        { dimension: "output", reason: "price_dim_no_source" },
        { dimension: "reasoning", reason: "price_dim_no_source" },
        { dimension: "image", reason: "price_dim_no_source" },
        { dimension: "cache_read", reason: "price_dim_no_source" },
        { dimension: "cache_write", reason: "price_dim_no_source" },
        { dimension: "surcharge_web_search", reason: "price_dim_no_source" },
        {
          dimension: "surcharge_per_request",
          reason: "price_dim_no_source",
        },
      ],
    });
  });

  test("an unreadable necessary price makes the cell unknown with that reason", () => {
    const classification = classifyPriceDims(dimsOf(INPUT_UNREADABLE));
    expect(classification).toEqual({
      status: "unknown",
      reasonCode: "price_status_dims_unreadable",
      missingDimensions: [
        { dimension: "input", reason: "price_dim_unreadable" },
      ],
    });
  });

  test("mixed missing kinds list both dims in vocabulary order; unreadable wins the reason code", () => {
    const classification = classifyPriceDims(dimsOf(MIXED_MISSING_KINDS));
    expect(classification.status).toBe("unknown");
    if (classification.status !== "unknown") throw new Error("unreachable");
    expect(classification.reasonCode).toBe("price_status_dims_unreadable");
    expect(classification.missingDimensions).toEqual([
      { dimension: "input", reason: "price_dim_unreadable" },
      { dimension: "output", reason: "price_dim_no_source" },
    ]);
  });

  test("the missing-dimension list carries only reasons of the closed dimension set", () => {
    for (const fixture of [
      ONLY_INPUT_PRICED,
      INPUT_UNREADABLE,
      MIXED_MISSING_KINDS,
      ALL_ZERO_BUT_ONE_UNPRICED,
    ]) {
      const classification = classifyPriceDims(dimsOf(fixture));
      if (classification.status !== "unknown") throw new Error("unreachable");
      expect(classification.missingDimensions.length).toBeGreaterThan(0);
      for (const missing of classification.missingDimensions) {
        expect(PRICE_DIM_UNKNOWN_REASONS).toContain(missing.reason);
      }
    }
  });
});

describe("unknown is never a zero cost", () => {
  test("all-zero pricing plus one unpriced dim is unknown, not free", () => {
    const classification = classifyPriceDims(dimsOf(ALL_ZERO_BUT_ONE_UNPRICED));
    expect(classification.status).toBe("unknown");
    expect(classification.status).not.toBe("free");
  });

  test("an unknown classification carries reasons, never a cost-bearing field", () => {
    const classification = classifyPriceDims(dimsOf(ONLY_INPUT_PRICED));
    expect(Object.keys(classification).sort()).toEqual([
      "missingDimensions",
      "reasonCode",
      "status",
    ]);
    const serialized = JSON.stringify(classification);
    expect(serialized).not.toContain("amount");
    expect(serialized).not.toContain("cost");
  });

  test("free carries no field that could stand in for authorization or admission", () => {
    const classification = classifyPriceDims(dimsOf(FULLY_PRICED_FREE));
    expect(Object.keys(classification)).toEqual(["status"]);
    // A free PRICE is not an access grant: the classification has nothing a
    // caller could read as "skip the gate" — the gate and admission path
    // (grant, credit gate, provider bounds) still own every invocation.
  });
});

describe("classifyPrice over a full snapshot", () => {
  test("classifies from the snapshot's dims", () => {
    const dims = dimsOf(FULLY_PRICED_FREE);
    const snap = snapshot(dims, { status: "free" });
    expect(classifyPrice(snap)).toEqual({ status: "free" });
  });

  test("re-derives from dims even when the persisted classification field lies", () => {
    const dims = dimsOf(ONLY_INPUT_PRICED);
    const snap = snapshot(dims, { status: "known" });
    expect(classifyPrice(snap)).toEqual({
      status: "unknown",
      reasonCode: "price_status_dims_missing",
      missingDimensions: expect.any(Array),
    });
  });
});

describe("the persisted status columns", () => {
  test("known and free persist as the status alone", () => {
    expect(priceStatusColumns({ status: "known" })).toEqual({
      priceStatus: "known",
      priceStatusReason: null,
      priceStatusMissingDimensions: null,
    });
    expect(priceStatusColumns({ status: "free" })).toEqual({
      priceStatus: "free",
      priceStatusReason: null,
      priceStatusMissingDimensions: null,
    });
  });

  test("unknown persists with its reason code and the missing-dimension list", () => {
    const classification = classifyPriceDims(dimsOf(INPUT_UNREADABLE));
    const columns = priceStatusColumns(classification);
    expect(columns.priceStatus).toBe("unknown");
    expect(columns.priceStatusReason).toBe("price_status_dims_unreadable");
    expect(columns.priceStatusMissingDimensions).toEqual([
      { dimension: "input", reason: "price_dim_unreadable" },
    ]);
  });

  test("stored columns validate against the closed sets", () => {
    expect(
      assertPriceStatusColumns(
        {
          priceStatus: "free",
          priceStatusReason: null,
          priceStatusMissingDimensions: null,
        },
        "test",
      ),
    ).toEqual({
      priceStatus: "free",
      priceStatusReason: null,
      priceStatusMissingDimensions: null,
    });
    const missing: PriceStatusMissingDimension[] = [
      { dimension: "input", reason: "price_dim_unreadable" },
    ];
    expect(
      assertPriceStatusColumns(
        {
          priceStatus: "unknown",
          priceStatusReason: "price_status_dims_unreadable",
          priceStatusMissingDimensions: missing,
        },
        "test",
      ),
    ).toEqual({
      priceStatus: "unknown",
      priceStatusReason: "price_status_dims_unreadable",
      priceStatusMissingDimensions: missing,
    });
  });

  test("a status outside the closed set is a defect, not a classification", () => {
    expect(() =>
      assertPriceStatusColumns(
        {
          priceStatus: "bogus",
          priceStatusReason: null,
          priceStatusMissingDimensions: null,
        },
        "test",
      ),
    ).toThrow(/closed set/);
  });

  test("known or free must not carry unknown details; unknown must carry both", () => {
    expect(() =>
      assertPriceStatusColumns(
        {
          priceStatus: "known",
          priceStatusReason: "price_status_dims_missing",
          priceStatusMissingDimensions: null,
        },
        "test",
      ),
    ).toThrow(/exactly unknown/);
    expect(() =>
      assertPriceStatusColumns(
        {
          priceStatus: "unknown",
          priceStatusReason: null,
          priceStatusMissingDimensions: null,
        },
        "test",
      ),
    ).toThrow(/reason/);
    expect(() =>
      assertPriceStatusColumns(
        {
          priceStatus: "unknown",
          priceStatusReason: "price_status_dims_missing",
          priceStatusMissingDimensions: null,
        },
        "test",
      ),
    ).toThrow(/missing-dimension/);
  });

  test("an empty missing-dimension list is a defect — unknown must name its dimensions", () => {
    expect(() =>
      assertPriceStatusColumns(
        {
          priceStatus: "unknown",
          priceStatusReason: "price_status_dims_missing",
          priceStatusMissingDimensions: [],
        },
        "test",
      ),
    ).toThrow(/empty/);
  });

  test("a missing-dimension entry outside the closed vocabularies is a defect", () => {
    expect(() =>
      assertPriceStatusColumns(
        {
          priceStatus: "unknown",
          priceStatusReason: "price_status_dims_missing",
          priceStatusMissingDimensions: [
            { dimension: "not_a_dim", reason: "price_dim_no_source" },
          ],
        },
        "test",
      ),
    ).toThrow(/dimension/);
    expect(() =>
      assertPriceStatusColumns(
        {
          priceStatus: "unknown",
          priceStatusReason: "price_status_dims_missing",
          priceStatusMissingDimensions: [
            { dimension: "input", reason: "made_up_reason" },
          ],
        },
        "test",
      ),
    ).toThrow(/reason/);
  });

  test("stored columns that disagree with the dims are refused loudly", () => {
    const dims = dimsOf(ONLY_INPUT_PRICED);
    const truthful = priceStatusColumns(classifyPriceDims(dims));
    expect(() =>
      assertPriceStatusColumnsMatchDims(dims, truthful, "test"),
    ).not.toThrow();
    expect(() =>
      assertPriceStatusColumnsMatchDims(
        dims,
        {
          priceStatus: "known",
          priceStatusReason: null,
          priceStatusMissingDimensions: null,
        },
        "test",
      ),
    ).toThrow(/disagree/);
  });
});
