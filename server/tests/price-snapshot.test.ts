import { describe, expect, test } from "bun:test";
import {
  canonicalPriceAmount,
  GATEWAY_PRICE_SNAPSHOT_SOURCE,
  mapPriceDims,
  PRICE_DIMENSIONS,
  PRICE_DIMENSION_UNITS,
  PRICE_DIM_UNKNOWN_REASONS,
  type PriceSnapshotDims,
} from "../src/gateway/price-snapshot";
import { GATEWAY_CATALOG_SOURCE } from "../src/gateway/catalog";

/*
 * Bifrost 03.2 — the price mapping, at the pure seam (no database, no
 * network). The input is one catalog entry's `raw_entry` — the exact bytes
 * the gateway sent on `GET /v1/models` (03.1 kept them verbatim) — and the
 * output is the full dimension map a snapshot stores.
 *
 * What this file pins: every billing dimension of the closed vocabulary is
 * present in every mapped dims object — a dimension the gateway's manifest
 * does not price arrives as `unknown` *with the reason it is unknown*, never
 * as 0 and never missing; an amount is an exact decimal string carried
 * through untouched (canonicalized, never parsed through a float); and an
 * explicit zero stays a *known* zero, distinct from unknown, so 03.3 can
 * tell "free" from "unpriced".
 */

/**
 * A raw `/v1/models` entry with the full pricing object the gateway's wire
 * schema defines (core/schemas/models.go `Pricing`): eight decimal *string*
 * fields, each riding on the JSON key its Go field name spells out —
 * reasoning's is `internal_reasoning`. These magnitudes are shaped like
 * `formatCost` output (`%.10f`) but carry more fraction digits than any float
 * could round-trip — the mapping must not care.
 */
const FULLY_PRICED_ENTRY = {
  id: "openai/gpt-4o",
  supported_methods: ["chat"],
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

function known(amount: string) {
  return { status: "known", amount };
}
function unknown(reason: string) {
  return { status: "unknown", reason };
}

describe("the closed dimension vocabulary", () => {
  test("covers input, output, reasoning, image, audio, cache, video and surcharges", () => {
    expect([...PRICE_DIMENSIONS].sort()).toEqual(
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
      ].sort(),
    );
  });

  test("every dimension names the unit its amount is denominated in", () => {
    for (const dimension of PRICE_DIMENSIONS) {
      expect(PRICE_DIMENSION_UNITS[dimension].length).toBeGreaterThan(0);
    }
  });

  test("the unknown reasons are a fixed, displayable closed set", () => {
    expect([...PRICE_DIM_UNKNOWN_REASONS].sort()).toEqual(
      ["price_dim_no_source", "price_dim_unreadable"].sort(),
    );
  });

  test("the snapshot source is the catalog's own fixed source constant", () => {
    expect(GATEWAY_PRICE_SNAPSHOT_SOURCE).toBe(GATEWAY_CATALOG_SOURCE);
  });
});

describe("mapping a fully priced datasheet entry", () => {
  test("every dimension the manifest prices is known, at the exact mapped amount", () => {
    const dims = mapPriceDims(FULLY_PRICED_ENTRY);
    expect(dims.input).toEqual(known("0.0000025"));
    expect(dims.output).toEqual(known("0.00001"));
    expect(dims.reasoning).toEqual(known("0.0001"));
    expect(dims.image).toEqual(known("0.003613"));
    expect(dims.cache_read).toEqual(known("0.00000125"));
    expect(dims.cache_write).toEqual(known("0.000003125"));
    expect(dims.surcharge_web_search).toEqual(known("0.025"));
    // An explicit zero upstream is a *known* zero — free is a price, not the
    // absence of one.
    expect(dims.surcharge_per_request).toEqual(known("0"));
  });

  test("dimensions the manifest does not price are unknown, never 0", () => {
    const dims = mapPriceDims(FULLY_PRICED_ENTRY);
    // The wire `Pricing` object carries no image-output, audio or video
    // fields; the datasheet's rates for them never reached this manifest.
    expect(dims.image_output).toEqual(unknown("price_dim_no_source"));
    expect(dims.audio_input).toEqual(unknown("price_dim_no_source"));
    expect(dims.audio_output).toEqual(unknown("price_dim_no_source"));
    expect(dims.video).toEqual(unknown("price_dim_no_source"));
  });

  test("the mapped dims object carries every dimension of the vocabulary — none missing", () => {
    const dims = mapPriceDims(FULLY_PRICED_ENTRY);
    expect(Object.keys(dims).sort()).toEqual([...PRICE_DIMENSIONS].sort());
  });
});

describe("mapping entries the gateway priced incompletely", () => {
  test("a missing pricing object leaves every dimension unknown with the no-source reason", () => {
    const dims = mapPriceDims({ id: "openai/gpt-4o" });
    for (const dimension of PRICE_DIMENSIONS) {
      expect(dims[dimension]).toEqual(unknown("price_dim_no_source"));
    }
  });

  test("a partially priced entry maps what is there and leaves the rest unknown", () => {
    const dims = mapPriceDims({
      id: "cohere/embed-english",
      pricing: { prompt: "0.0001000000" },
    });
    expect(dims.input).toEqual(known("0.0001"));
    expect(dims.output).toEqual(unknown("price_dim_no_source"));
    expect(dims.cache_read).toEqual(unknown("price_dim_no_source"));
  });

  test("a value that is not an exact decimal string is unreadable, not zero and not guessed", () => {
    const dims = mapPriceDims({
      id: "openai/gpt-4o",
      pricing: {
        prompt: "not-a-price",
        completion: 0.5, // a JSON number already went through float parsing
        request: "1e-5", // exponent spelling
        image: "-0.5", // a negative price is not a price
      },
    });
    expect(dims.input).toEqual(unknown("price_dim_unreadable"));
    expect(dims.output).toEqual(unknown("price_dim_unreadable"));
    expect(dims.surcharge_per_request).toEqual(unknown("price_dim_unreadable"));
    expect(dims.image).toEqual(unknown("price_dim_unreadable"));
    // The dims the entry said nothing about stay no-source, not unreadable.
    expect(dims.cache_read).toEqual(unknown("price_dim_no_source"));
  });

  test("an unreadable dimension can never be mistaken for free: its amount key does not exist", () => {
    const dims: PriceSnapshotDims = mapPriceDims({
      id: "openai/gpt-4o",
      pricing: { prompt: "oops" },
    });
    expect(dims.input).not.toHaveProperty("amount");
    expect(dims.input.status).toBe("unknown");
  });
});

describe("exact decimal amounts", () => {
  test("a tiny unit price passes through canonicalization without losing a digit", () => {
    const dims = mapPriceDims({
      id: "openai/gpt-4o",
      pricing: { prompt: "0.000000000123456789" },
    });
    expect(dims.input).toEqual(known("0.000000000123456789"));
  });

  test("canonicalization is exact decimal surgery, never float arithmetic", () => {
    expect(canonicalPriceAmount("1.500")).toEqual({ ok: true, amount: "1.5" });
    expect(canonicalPriceAmount("0.000")).toEqual({ ok: true, amount: "0" });
    expect(canonicalPriceAmount("30.0000000000")).toEqual({
      ok: true,
      amount: "30",
    });
    expect(canonicalPriceAmount("0.0000015000")).toEqual({
      ok: true,
      amount: "0.0000015",
    });
    expect(canonicalPriceAmount("0")).toEqual({ ok: true, amount: "0" });
    expect(canonicalPriceAmount("42")).toEqual({ ok: true, amount: "42" });
  });

  test("values that could not be read exactly are refused, not coerced", () => {
    for (const value of ["", " 1", "+1", "-1", "1e-5", "0x10", "1.2.3", NaN, null, undefined, {}]) {
      expect(canonicalPriceAmount(value)).toEqual({ ok: false });
    }
  });

  test("spelling differences of one value canonicalize to the same amount, so a re-sync sees no change", () => {
    const first = mapPriceDims({
      id: "openai/gpt-4o",
      pricing: { prompt: "0.0000025000" },
    });
    const second = mapPriceDims({
      id: "openai/gpt-4o",
      pricing: { prompt: "0.0000025" },
    });
    expect(first.input).toEqual(second.input);
  });
});
