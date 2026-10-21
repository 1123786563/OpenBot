import {
  PRICE_DIMENSIONS,
  type PriceDimension,
  type PriceDimensionUnknownReason,
  type PriceSnapshotDims,
} from "../gateway/price-snapshot";
import type { ReservationBoundQuantities } from "./reserve-bound";

/*
 * The image-generation pricing boundary (Bifrost 12.1, #302): the spec extraction, the
 * tier price resolution, and the ceiling conversion for /v1/images/generations — the
 * quantity-and-spec dimensions a hold must cover before any image is generated.
 *
 * WHAT AN IMAGE GENERATION BILLS. Generated images — `count` of them, each at the price
 * of the SIZE × QUALITY tier the request selected — plus, when the request carries input
 * images (the edits shape 12.3 prices fully), those at the per-input-image price. In the
 * closed vocabulary: `image_output` per generated image, `image` per input image. The
 * tokens of the prompt are input tokens and a generation request's prompt is counted by
 * the caller through the ordinary chat/embedding counter — the RESERVATION here is the
 * image dimensions' share; admission composes both before any dispatch.
 *
 * THE TIER IS THE REQUEST'S, AND IT IS FIXED BEFORE DISPATCH. The request's `n`, `size`
 * and `quality` are copied into a frozen spec at extraction time: everything downstream
 * — the tier price resolved, the ceiling certified, the hold taken, the supplier's own
 * generation — stands on that one spec. A request whose count or spec cannot be
 * certified (an `n` that is not a positive whole number, a `size`/`quality` that is not
 * a string) is refused BEFORE any price is consulted: a spec nobody can name is a
 * ceiling nobody can certify, and "规格不可确定时拒绝" is the AC's own sentence.
 *
 * THE PER-TIER PRICE TABLE. Image generation is the one capability whose per-unit price
 * varies by request parameters — the Resume hint's trap is pricing every tier at one
 * fixed per-image rate. The price basis here is therefore a TABLE: one exact USD amount
 * per (size, quality) tier, with a wildcard row (null size, null quality) pricing every
 * tier uniformly — the shape upstream carries when a model bills one rate for all
 * sizes. Resolution takes the exact (size, quality) row first, then the wildcard; a
 * request whose tier matches NEITHER is unpriced, and an unpriced tier is never a zero
 * cost (AC2).
 *
 * THE V1 WIRE CANNOT FILL THE TABLE — AND THIS MODULE SAYS SO. The gateway's v1 pricing
 * object (core/schemas/models.go `Pricing`, verified at the pinned commit) has exactly
 * one image field, the per-INPUT-image price; there is no field for a generated image's
 * price, let alone per-tier prices. That is why 03.2 reserved `image_output` with this
 * ticket's number on it: every v1-wire snapshot carries `image_output` as
 * unknown/price_dim_no_source, `imageTierPriceTableFromSnapshot` answers an empty table,
 * and the enablement verdict on today's snapshots is REFUSED — the honest strict-billing
 * answer, not a gap to paper over with the input-image price or an estimate. The
 * conversion and resolution machinery below are complete and pinned by fixtures, so the
 * day the wire grows per-tier fields the mapping fills the table and the same verdict
 * flips on evidence.
 *
 * THE CEILING, 足额 AND VERSION-LOCKED. The conversion emits per-dimension quantities —
 * `image_output: count`, `image: inputImageCount`, every other dimension 0 — ready for
 * 06.5's `computeReservationCeiling`, whose arithmetic is exact and rounds up. The dims
 * and rate the caller hands that function are the LOCKED versions (the reservation's
 * 06.5 basis: model cell, snapshotVersion, rateVersion), so the hold prices at the basis
 * it locked no matter what syncs land mid-flight — this module never reads a price
 * itself, it only resolves the request's tier against the basis it is GIVEN.
 */

/**
 * The dimensions an image generation can bill. `image_output` per generated image,
 * `image` per input image (the edits shape; pure generation carries none).
 */
export const IMAGE_GENERATION_BILLED_DIMENSIONS = [
  "image_output",
  "image",
] as const satisfies readonly PriceDimension[];

/** One row of a tier price table: the exact USD per generated image at this tier. */
export type ImageTierPrice = {
  /** The tier's size (e.g. "1024x1024"), or null for a wildcard row. */
  readonly size: string | null;
  /** The tier's quality (e.g. "hd"), or null for a wildcard row. */
  readonly quality: string | null;
  /** Exact USD per generated image at this tier — a canonical decimal string. */
  readonly amount: string;
};

/** A model cell's generated-image pricing: one row per tier it prices, wildcards last. */
export type ImageTierPriceTable = readonly ImageTierPrice[];

/**
 * The frozen request spec: the count and the tier, copied from the request before
 * dispatch and never re-derived. `inputImages` counts the request's input image entries
 * (the edits shape — 0 for /v1/images/generations, which carries none).
 */
export type ImageGenerationSpec = {
  readonly count: number;
  readonly size: string | null;
  readonly quality: string | null;
  readonly inputImages: number;
};

/** Why a spec could not be fixed. Closed vocabulary, displayable. */
export type ImageSpecIssue = {
  code: "image_spec_indeterminable";
  field: "n" | "size" | "quality" | "image";
};

/** The hard ceiling on one request's image count: a spec larger than this cannot be a
 * certified hold (the 32-bit ledger bound shrinks it no further than this guard does). */
export const IMAGE_GENERATION_MAX_COUNT = 100;

function nonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

/**
 * Fix the spec from an images request (AC3): `n` defaults to 1 — the wire's own
 * documented default, a determined count, not a guess — and must otherwise be a positive
 * whole number within the count cap; `size` and `quality` are absent (null, the model's
 * own default) or non-empty strings; input image entries, when the request carries any,
 * are counted exactly. Anything else refuses before a price is read.
 */
export function imageGenerationSpecOf(
  request: unknown,
):
  | { ok: true; spec: ImageGenerationSpec }
  | { ok: false; issue: ImageSpecIssue } {
  if (request === null || typeof request !== "object") {
    return {
      ok: false,
      issue: { code: "image_spec_indeterminable", field: "n" },
    };
  }
  const body = request as {
    n?: unknown;
    size?: unknown;
    quality?: unknown;
    image?: unknown;
  };

  let count = 1;
  if (body.n !== undefined) {
    if (
      typeof body.n !== "number" ||
      !Number.isSafeInteger(body.n) ||
      body.n < 1 ||
      body.n > IMAGE_GENERATION_MAX_COUNT
    ) {
      return {
        ok: false,
        issue: { code: "image_spec_indeterminable", field: "n" },
      };
    }
    count = body.n;
  }

  if (
    body.size !== undefined &&
    body.size !== null &&
    !nonEmptyString(body.size)
  ) {
    return {
      ok: false,
      issue: { code: "image_spec_indeterminable", field: "size" },
    };
  }
  if (
    body.quality !== undefined &&
    body.quality !== null &&
    !nonEmptyString(body.quality)
  ) {
    return {
      ok: false,
      issue: { code: "image_spec_indeterminable", field: "quality" },
    };
  }

  let inputImages = 0;
  if (body.image !== undefined && body.image !== null) {
    if (typeof body.image === "string") inputImages = 1;
    else if (Array.isArray(body.image)) inputImages = body.image.length;
    else {
      return {
        ok: false,
        issue: { code: "image_spec_indeterminable", field: "image" },
      };
    }
  }

  return {
    ok: true,
    spec: {
      count,
      size: nonEmptyString(body.size) ? body.size : null,
      quality: nonEmptyString(body.quality) ? body.quality : null,
      inputImages,
    },
  };
}

/**
 * Resolve the spec's tier against the table: the exact (size, quality) row first, then
 * the wildcard row that prices every tier uniformly. No match is an unpriced tier —
 * never a zero, never the nearest row's price.
 */
export function resolveImageTierPrice(
  table: ImageTierPriceTable,
  spec: Pick<ImageGenerationSpec, "size" | "quality">,
): { ok: true; amount: string } | { ok: false } {
  const exact = table.find(
    (row) => row.size === spec.size && row.quality === spec.quality,
  );
  if (exact) return { ok: true, amount: exact.amount };
  const wildcard = table.find(
    (row) => row.size === null && row.quality === null,
  );
  if (wildcard) return { ok: true, amount: wildcard.amount };
  return { ok: false };
}

/**
 * The tier table a snapshot's dims can fill. Two honest sources, in the order the wire grew
 * them:
 *
 * 1. A KNOWN `image_output` amount — a basis that prices every generated image uniformly,
 *    whatever source priced it (a future wire field, a curated cell) — fills exactly the
 *    wildcard row: one rate for all sizes and qualities, the shape the tier vocabulary
 *    built the wildcard for (12.2's settlement reads this path, so the price a hold locked
 *    is the price its settlement rebuilds from the same immutable version).
 * 2. The v1 wire's pricing object — which has no generated-image field (only the
 *    per-INPUT-image `pricing.image`), so a pure v1 snapshot records `image_output`
 *    unknown and the table stays EMPTY: the honest strict-billing refusal, not a gap
 *    papered over with the input-image price or an estimate.
 *
 * When the wire grows per-tier fields, THIS is the one place that changes; the enablement
 * verdict and the settlement flip on evidence rather than on a silent fallback.
 */
export function imageTierPriceTableFromSnapshot(
  dims: PriceSnapshotDims,
): ImageTierPriceTable {
  const generated = dims.image_output;
  if (generated.status === "known") {
    return [{ size: null, quality: null, amount: generated.amount }];
  }
  return [];
}

/** Why an image generation cannot be enabled. Closed vocabulary, displayable. */
export type ImageGenerationEnablementIssue =
  /** The request's spec could not be fixed before dispatch. */
  | ImageSpecIssue
  /** The requested tier has no price on the basis — unknown is never a zero cost. */
  | { code: "image_tier_price_unknown" }
  /** Input images are billed and the input-image price is unknown. */
  | {
      code: "image_input_price_unknown";
      reason: PriceDimensionUnknownReason;
    };

/** The verdict: enabled carries the quantities; refused carries the reason. */
export type ImageGenerationEnablement =
  | {
      enabled: true;
      /** True when the resolved prices are exactly "0": free is a price, not a pass. */
      free: boolean;
      /** The worst-case per-dimension quantities, ready for the ceiling conversion. */
      quantities: ReservationBoundQuantities;
      /** The USD per generated image the tier resolved to — the basis the hold locks. */
      perImageUsd: string;
    }
  | { enabled: false; issue: ImageGenerationEnablementIssue };

/**
 * The image-generation enablement predicate (AC2/AC3): the spec fixed, the tier priced,
 * and — when input images ride along — the input-image price known. The dims handed in
 * are the LOCKED basis's (06.5); this function never reads a price of its own.
 */
export function assessImageGenerationEnablement(input: {
  dims: PriceSnapshotDims;
  /** The tier table resolved FOR THE LOCKED BASIS (empty from a v1 snapshot). */
  tierTable: ImageTierPriceTable;
  request: unknown;
}): ImageGenerationEnablement {
  const spec = imageGenerationSpecOf(input.request);
  if (!spec.ok) return { enabled: false, issue: spec.issue };

  const tier = resolveImageTierPrice(input.tierTable, spec.spec);
  if (!tier.ok) {
    return { enabled: false, issue: { code: "image_tier_price_unknown" } };
  }

  if (spec.spec.inputImages > 0) {
    const inputImage = input.dims.image;
    if (inputImage.status === "unknown") {
      return {
        enabled: false,
        issue: { code: "image_input_price_unknown", reason: inputImage.reason },
      };
    }
  }

  const free =
    tier.amount === "0" &&
    (spec.spec.inputImages === 0 ||
      (input.dims.image.status === "known" && input.dims.image.amount === "0"));

  // The certified worst-case quantities: `count` generated images at the tier price and
  // the request's input images — the count × per-image worst case the AC names, as
  // quantities for 06.5's exact conversion. Every other dimension: 0 (an image
  // generation bills no tokens here — the prompt's tokens are the caller's compose).
  const quantities = Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [
      dimension,
      dimension === "image_output"
        ? spec.spec.count
        : dimension === "image"
          ? spec.spec.inputImages
          : 0,
    ]),
  ) as ReservationBoundQuantities;

  return {
    enabled: true,
    free,
    quantities,
    perImageUsd: tier.amount,
  };
}

/**
 * The bridge from the resolved tier price to the dimension the ceiling prices: the
 * generated image's price rides `image_output` — the vocabulary slot 03.2 reserved for
 * exactly this — so the caller hands 06.5's conversion the locked basis with
 * `image_output` overlaid at the tier's amount. THIS overlay and nothing else: every
 * other dimension passes through untouched, and a tampered dims object still fails the
 * conversion's own checker.
 */
export function imageGenerationCeilingDims(
  dims: PriceSnapshotDims,
  perImageUsd: string,
): PriceSnapshotDims {
  return {
    ...dims,
    image_output: { status: "known", amount: perImageUsd },
  };
}
