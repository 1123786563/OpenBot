import {
  PRICE_DIMENSIONS,
  type PriceDimension,
  type PriceDimensionUnknownReason,
  type PriceSnapshotDims,
} from "../gateway/price-snapshot";
import type { ReservationBoundQuantities } from "./reserve-bound";

/*
 * The video-generation pricing boundary (Bifrost 19.1, #337): the spec extraction, the
 * tier price resolution, and the worst-case ceiling conversion for a video generation —
 * the quantity-and-spec dimensions a hold must cover before any video is dispatched.
 *
 * WHAT A VIDEO GENERATION BILLS. Every published video rate card bills per SECOND of
 * output, banded on the resolution (upstream `VideoPricingDimensions`: seconds × size ×
 * clip count — the rate is the per-second price at the request's tier, and every clip is
 * billed for its own seconds). In the closed vocabulary that is exactly the `video`
 * dimension 03.2 reserved for this line: USD per video second. The prompt's tokens are
 * the caller's compose (the image line's own rule), the reservation here is the video
 * dimension's share alone.
 *
 * THE TIER IS THE REQUEST'S, AND IT IS FIXED BEFORE DISPATCH. The request's `seconds`,
 * `size`, `quality` and `n` are copied into a frozen spec at extraction time; everything
 * downstream — the tier price resolved, the ceiling certified, the hold taken, the
 * provider's own generation — stands on that one spec. `seconds` has NO default, unlike
 * the image line's `n`: the wire documents a default image count, but no provider
 * documents one duration, and a duration nobody can name is a ceiling nobody can certify
 * (规格不可确定时拒绝 — the AC's own sentence). A `size`/`quality` left absent is the
 * model's own default tier, a determined spec — a present-but-unreadable one is not.
 *
 * THE PER-TIER PRICE TABLE. Like image generation, the price basis is a TABLE: one exact
 * USD-per-second amount per (resolution, quality) tier, with a wildcard row (null size,
 * null quality) pricing every tier uniformly — the shape a model bills when one rate
 * covers all resolutions. Resolution takes the exact row first, then the wildcard; a
 * tier matching NEITHER is unpriced, and an unpriced tier is never a zero cost.
 *
 * THE V1 WIRE CANNOT FILL THE TABLE — AND THIS MODULE SAYS SO. The gateway's pricing
 * object (core/schemas/models.go `Pricing`, pinned commit) carries no video field at
 * all, so every v1-wire snapshot records `video` as unknown/price_dim_no_source,
 * `videoTierPriceTableFromSnapshot` answers an empty table, and the enablement verdict on
 * today's snapshots is REFUSED with the dimension named — the honest strict-billing
 * answer, not a gap papered over with an estimate. The conversion and resolution
 * machinery below is complete and pinned by fixtures, so the day the wire grows a video
 * field (or a curated cell is priced) the same verdict flips on evidence.
 *
 * THE CEILING, 足额 AND VERSION-LOCKED. The conversion emits one per-dimension quantity —
 * `video: seconds × outputCount`, every other dimension 0 — ready for 06.5's
 * `computeReservationCeiling`, whose arithmetic is exact and rounds up. The dims and
 * rate the caller hands that function are the LOCKED versions (the reservation's 06.5
 * basis: model cell, snapshotVersion, rateVersion), so the hold prices at the basis it
 * locked no matter what syncs land mid-flight — this module never reads a price itself,
 * it only resolves the request's tier against the basis it is GIVEN.
 */

/**
 * The dimensions a video generation bills. `video` per second of output — the
 * vocabulary slot 03.2 reserved for exactly this line.
 */
export const VIDEO_GENERATION_BILLED_DIMENSIONS = [
  "video",
] as const satisfies readonly PriceDimension[];

/** One row of a tier price table: the exact USD per output second at this tier. */
export type VideoTierPrice = {
  /** The tier's resolution (e.g. "1280x720"), or null for a wildcard row. */
  readonly size: string | null;
  /** The tier's quality/帧率档 (e.g. "standard"), or null for a wildcard row. */
  readonly quality: string | null;
  /** Exact USD per output second at this tier — a canonical decimal string. */
  readonly amount: string;
};

/** A model cell's video pricing: one row per tier it prices, wildcards last. */
export type VideoTierPriceTable = readonly VideoTierPrice[];

/**
 * The frozen request spec: the duration, the tier and the clip count, copied from the
 * request before dispatch and never re-derived.
 */
export type VideoGenerationSpec = {
  /** The output's duration in whole seconds — required; no provider default exists. */
  readonly seconds: number;
  /** The tier's resolution, or null when the request left it to the model's default. */
  readonly size: string | null;
  /** The tier's quality档, or null when the request left it to the model's default. */
  readonly quality: string | null;
  /** How many clips the request ordered (the wire's `n`, default 1). */
  readonly outputCount: number;
  /** The creating request type — generation here; 19.3's shapes extend the vocabulary. */
  readonly requestType: "generation";
};

/** Why a spec could not be fixed. Closed vocabulary, displayable. */
export type VideoSpecIssue = {
  code: "video_spec_indeterminable";
  field: "seconds" | "size" | "quality" | "n";
};

/** The hard bound on one request's duration: a spec larger than this cannot be a
 * certified hold (the 32-bit ledger bound shrinks it no further than this guard does). */
export const VIDEO_GENERATION_MAX_SECONDS = 600;

/** The image line's own count guard, shared: a clip count above this refuses. */
export const VIDEO_GENERATION_MAX_OUTPUT_COUNT = 100;

function nonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

/**
 * Fix the spec from a video-generation request: `seconds` a positive whole number within
 * the duration guard (required — the one dimension no provider defaults), `n` a positive
 * whole count within the count guard (default 1, the wire's own documented default), and
 * `size`/`quality` absent (null, the model's own tier) or non-empty strings. Anything
 * else refuses before a price is read.
 */
export function videoGenerationSpecOf(
  request: unknown,
):
  | { ok: true; spec: VideoGenerationSpec }
  | { ok: false; issue: VideoSpecIssue } {
  if (request === null || typeof request !== "object") {
    return {
      ok: false,
      issue: { code: "video_spec_indeterminable", field: "seconds" },
    };
  }
  const body = request as {
    seconds?: unknown;
    size?: unknown;
    quality?: unknown;
    n?: unknown;
  };

  if (
    typeof body.seconds !== "number" ||
    !Number.isSafeInteger(body.seconds) ||
    body.seconds < 1 ||
    body.seconds > VIDEO_GENERATION_MAX_SECONDS
  ) {
    return {
      ok: false,
      issue: { code: "video_spec_indeterminable", field: "seconds" },
    };
  }

  if (
    body.size !== undefined &&
    body.size !== null &&
    !nonEmptyString(body.size)
  ) {
    return {
      ok: false,
      issue: { code: "video_spec_indeterminable", field: "size" },
    };
  }
  if (
    body.quality !== undefined &&
    body.quality !== null &&
    !nonEmptyString(body.quality)
  ) {
    return {
      ok: false,
      issue: { code: "video_spec_indeterminable", field: "quality" },
    };
  }

  let outputCount = 1;
  if (body.n !== undefined) {
    if (
      typeof body.n !== "number" ||
      !Number.isSafeInteger(body.n) ||
      body.n < 1 ||
      body.n > VIDEO_GENERATION_MAX_OUTPUT_COUNT
    ) {
      return {
        ok: false,
        issue: { code: "video_spec_indeterminable", field: "n" },
      };
    }
    outputCount = body.n;
  }

  return {
    ok: true,
    spec: {
      seconds: body.seconds,
      size: nonEmptyString(body.size) ? body.size : null,
      quality: nonEmptyString(body.quality) ? body.quality : null,
      outputCount,
      requestType: "generation",
    },
  };
}

/**
 * Resolve the spec's tier against the table: the exact (size, quality) row first, then
 * the wildcard row that prices every tier uniformly. No match is an unpriced tier —
 * never a zero, never the nearest row's rate.
 */
export function resolveVideoTierPrice(
  table: VideoTierPriceTable,
  spec: Pick<VideoGenerationSpec, "size" | "quality">,
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
 * The tier table a snapshot's dims can fill. One honest source: a KNOWN `video` amount —
 * a basis that prices every output second uniformly, whatever source priced it (a future
 * wire field, a curated cell) — fills exactly the wildcard row. A pure v1 snapshot
 * records `video` unknown (no wire field exists), so the table stays EMPTY: the honest
 * strict-billing refusal, not a gap papered over with an estimate. When the wire grows
 * per-tier video fields, THIS is the one place that changes; the enablement verdict and
 * the settlement flip on evidence rather than on a silent fallback.
 */
export function videoTierPriceTableFromSnapshot(
  dims: PriceSnapshotDims,
): VideoTierPriceTable {
  const perSecond = dims.video;
  if (perSecond.status === "known") {
    return [{ size: null, quality: null, amount: perSecond.amount }];
  }
  return [];
}

/** Why a video generation cannot be enabled. Closed vocabulary, displayable. */
export type VideoGenerationEnablementIssue =
  /** The request's spec could not be fixed before dispatch. */
  | VideoSpecIssue
  /**
   * The requested tier has no price on the basis — unknown is never a zero cost. The
   * dimension and its per-dimension reason ride along: 19.2's availability surface and
   * the refusal the entry answers name exactly what is missing (AC3/AC of 19.2).
   */
  | {
      code: "video_tier_price_unknown";
      dimension: "video";
      reason: PriceDimensionUnknownReason;
    };

/** The verdict: enabled carries the quantities; refused carries the reason. */
export type VideoGenerationEnablement =
  | {
      enabled: true;
      /** True when the resolved rate is exactly "0": free is a price, not a pass. */
      free: boolean;
      /** The worst-case per-dimension quantities, ready for the ceiling conversion. */
      quantities: ReservationBoundQuantities;
      /** The USD per output second the tier resolved to — the basis the hold locks. */
      perSecondUsd: string;
    }
  | { enabled: false; issue: VideoGenerationEnablementIssue };

/**
 * The video-generation enablement predicate (AC2/AC3): the spec fixed, the tier priced.
 * The dims handed in are the LOCKED basis's (06.5); this function never reads a price of
 * its own — the refusal names the dimension it is missing through the dims' own state.
 */
export function assessVideoGenerationEnablement(input: {
  dims: PriceSnapshotDims;
  /** The tier table resolved FOR THE LOCKED BASIS (empty from a v1 snapshot). */
  tierTable: VideoTierPriceTable;
  request: unknown;
}): VideoGenerationEnablement {
  const spec = videoGenerationSpecOf(input.request);
  if (!spec.ok) return { enabled: false, issue: spec.issue };

  const tier = resolveVideoTierPrice(input.tierTable, spec.spec);
  if (!tier.ok) {
    // The dimension's own state names why: no wire source, or an unreadable amount —
    // never "free by silence". An empty table and an unknown dim are the same fact.
    const perSecond = input.dims.video;
    return {
      enabled: false,
      issue: {
        code: "video_tier_price_unknown",
        dimension: "video",
        reason:
          perSecond.status === "unknown"
            ? perSecond.reason
            : "price_dim_no_source",
      },
    };
  }

  const free = tier.amount === "0";

  // The certified worst-case quantities: `seconds × outputCount` video seconds — every
  // clip is billed for its own seconds at the tier's rate. Every other dimension: 0 (a
  // video generation bills no tokens here — the prompt's tokens are the caller's compose).
  const quantities = Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [
      dimension,
      dimension === "video"
        ? spec.spec.seconds * spec.spec.outputCount
        : 0,
    ]),
  ) as ReservationBoundQuantities;

  return {
    enabled: true,
    free,
    quantities,
    perSecondUsd: tier.amount,
  };
}

/**
 * The bridge from the resolved tier rate to the dimension the ceiling prices: the
 * output second's price rides `video` — the vocabulary slot 03.2 reserved for exactly
 * this — so the caller hands 06.5's conversion the locked basis with `video` overlaid at
 * the tier's amount (a per-tier row may price above the dim's own wildcard rate, and the
 * hold locks the TIER's price, the one the request actually selected). THIS overlay and
 * nothing else: every other dimension passes through untouched, and a tampered dims
 * object still fails the conversion's own checker.
 */
export function videoGenerationCeilingDims(
  dims: PriceSnapshotDims,
  perSecondUsd: string,
): PriceSnapshotDims {
  return {
    ...dims,
    video: { status: "known", amount: perSecondUsd },
  };
}
