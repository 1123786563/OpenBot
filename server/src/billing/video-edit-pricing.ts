import {
  PRICE_DIMENSIONS,
  type PriceDimensionUnknownReason,
  type PriceSnapshotDims,
} from "../gateway/price-snapshot";
import type { ReservationBoundQuantities } from "./reserve-bound";
import {
  resolveVideoTierPrice,
  type VideoGenerationSpec,
  type VideoTierPriceTable,
  videoGenerationSpecOf,
} from "./video-generation-pricing";

/*
 * The video-edit/variant pricing boundary (Bifrost 19.3, #339): the input-video cost
 * folded into the edit ceiling, the input determinability gate, and the SHARED reserve
 * semantics with generation — built directly on 19.1's boundary, not beside it.
 *
 * WHAT AN EDIT BILLS THAT A GENERATION DOES NOT. The input videos the request carries —
 * the clips to edit or remix, billed per INPUT second at the cell's input rate
 * (`video_input`, the dimension 0202 added for exactly this side) — ON TOP of the output
 * clips at the request's tier (`video`, 19.1's own tier table). The two sides are separate
 * dimensions because their prices are separate facts: a provider that charges nothing for
 * inputs records `video_input` as a KNOWN "0" — free with evidence, the ticket's own
 * Resume rule (上游不收输入费用时记为明确 free 并留证据；留空会被判 unknown) — and a
 * blank or unreadable input rate is `unknown`, which never degrades to a zero cost: the
 * verdict refuses with the dimension named (缺输入定价时标记 unknown 并拒绝).
 *
 * THE INPUT MUST BE DETERMINABLE BEFORE DISPATCH. 输入规格不可确定（时长/规格未知）时
 * 判证据不足并拒绝 is the AC's own sentence, and the proof is the request itself: every
 * input entry must state its own duration in whole seconds — a number this server can
 * certify, never a probe of container bytes (a video's duration is not a header field the
 * way an image's dimensions are) and never an estimate. An input with no stated duration,
 * a fractional or zero one, an entry that is not an object, or an edit carrying no inputs
 * at all refuses BEFORE any price is consulted — a duration nobody can name is a ceiling
 * nobody can certify.
 *
 * SHARED SEMANTICS, NOT A SECOND SYSTEM (AC3). The verdict's quantities are the
 * generation shape exactly — `video: seconds × outputCount` — plus the one addition the
 * edit shape carries, `video_input: Σ each input's seconds`. Both price through 06.5's
 * own `computeReservationCeiling` over the same locked basis, both submit through the
 * same 19.1 submit path (17.2's service under it), and both settle through the same 17.6
 * terminal lane: an edit admission and a generation admission differ only in what the
 * spec froze, never in how the hold is priced or the settlement fenced.
 *
 * EDIT AND REMIX ARE THE SAME BILLING SHAPE. Upstream's own vocabulary distinguishes
 * `VideoEditRequest` from `VideoRemixRequest`, and its rate cards can price them apart —
 * but both bill output seconds at a tier plus input seconds at the input rate, so this
 * boundary maps both onto the same quantities and lets the tier table carry any rate
 * difference (a provider whose edit tier differs from its generation tier prices it as
 * its own row). The request type rides the frozen spec for the settlement's own record.
 */

/**
 * The dimensions a video edit bills. `video` per output second (× clip count), `video_input`
 * per input-video second — the two sides 0202 split so free-input is recordable.
 */
export const VIDEO_EDIT_BILLED_DIMENSIONS = ["video", "video_input"] as const;

/** The edit/variant request types this boundary prices — upstream's own two names. */
export const VIDEO_EDIT_REQUEST_TYPES = ["edit", "remix"] as const;

export type VideoEditRequestType = (typeof VIDEO_EDIT_REQUEST_TYPES)[number];

/** One input video's frozen spec: its own stated duration, the only fact the bill needs. */
export type InputVideoSpec = {
  /** The input's duration in whole seconds, as the request stated it. */
  readonly seconds: number;
};

/** The frozen edit spec: the generation side plus the input side's certified durations. */
export type VideoEditSpec = {
  readonly seconds: number;
  readonly size: string | null;
  readonly quality: string | null;
  readonly outputCount: number;
  readonly requestType: VideoEditRequestType;
  /** The input videos billed: every entry the request carried. */
  readonly inputVideos: number;
  /** Each input's own stated duration, in request order — the determinability evidence. */
  readonly inputSpecs: readonly InputVideoSpec[];
};

/** Why an edit request could not be fixed. Closed vocabulary, displayable. */
export type VideoEditSpecIssue =
  | {
      code: "video_spec_indeterminable";
      field: "seconds" | "size" | "quality" | "n";
    }
  | { code: "video_input_spec_indeterminable"; field: "input" };

/** The hard bound on one input video's stated duration — the output guard's own number. */
export const VIDEO_INPUT_MAX_SECONDS = 600;

/** The most input videos one edit may carry; a request above this refuses. */
export const VIDEO_INPUT_MAX_COUNT = 20;

type EditSpecValidation =
  | { ok: true; spec: VideoEditSpec }
  | { ok: false; issue: VideoEditSpecIssue };

/**
 * Fix the edit spec: the generation side (seconds, tier, count — 19.1's own guard, the
 * shared semantics) plus the input side — every input entry stating its own whole-second
 * duration within the guards, at least one input present. Anything indeterminable refuses
 * before a price is read.
 */
export function videoEditSpecOf(
  request: unknown,
  requestType: VideoEditRequestType = "edit",
): EditSpecValidation {
  const base = videoGenerationSpecOf(request);
  if (!base.ok) return base;

  const body = request as { input?: unknown };
  const inputs: unknown[] =
    body.input === undefined || body.input === null
      ? []
      : Array.isArray(body.input)
        ? body.input
        : [body.input];
  if (inputs.length === 0) {
    // An edit with no input videos is not an edit: nothing to transform, nothing to bill
    // the input side on — and no spec anyone could certify.
    return {
      ok: false,
      issue: { code: "video_input_spec_indeterminable", field: "input" },
    };
  }
  if (inputs.length > VIDEO_INPUT_MAX_COUNT) {
    return {
      ok: false,
      issue: { code: "video_input_spec_indeterminable", field: "input" },
    };
  }

  const inputSpecs: InputVideoSpec[] = [];
  for (const entry of inputs) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        ok: false,
        issue: { code: "video_input_spec_indeterminable", field: "input" },
      };
    }
    const seconds = (entry as { seconds?: unknown }).seconds;
    if (
      typeof seconds !== "number" ||
      !Number.isSafeInteger(seconds) ||
      seconds < 1 ||
      seconds > VIDEO_INPUT_MAX_SECONDS
    ) {
      return {
        ok: false,
        issue: { code: "video_input_spec_indeterminable", field: "input" },
      };
    }
    inputSpecs.push({ seconds });
  }

  return {
    ok: true,
    spec: {
      seconds: base.spec.seconds,
      size: base.spec.size,
      quality: base.spec.quality,
      outputCount: base.spec.outputCount,
      requestType,
      inputVideos: inputSpecs.length,
      inputSpecs,
    },
  };
}

/** Why a video edit cannot be enabled. Closed vocabulary, displayable. */
export type VideoEditEnablementIssue =
  | VideoEditSpecIssue
  /** The output tier has no price on the basis — unknown is never a zero cost. */
  | {
      code: "video_tier_price_unknown";
      dimension: "video";
      reason: PriceDimensionUnknownReason;
    }
  /** Inputs are billed and the input rate is unknown (缺输入定价). */
  | {
      code: "video_input_price_unknown";
      dimension: "video_input";
      reason: PriceDimensionUnknownReason;
    };

/** The verdict: enabled carries the quantities; refused carries the reason. */
export type VideoEditEnablement =
  | {
      enabled: true;
      /** True when both sides resolve to exactly "0": free is a price, not a pass. */
      free: boolean;
      /** The frozen edit spec, every input's own stated duration included. */
      spec: VideoEditSpec;
      /**
       * The worst-case per-dimension quantities, in the generation shape plus the input
       * side (shared semantics): `video: seconds × outputCount`, `video_input: Σ inputs`.
       */
      quantities: ReservationBoundQuantities;
      /** The USD per output second the tier resolved to — the basis the hold locks. */
      perSecondUsd: string;
      /** The USD per input second the basis prices — the input side's own locked rate. */
      inputPerSecondUsd: string;
    }
  | { enabled: false; issue: VideoEditEnablementIssue };

/**
 * The video-edit enablement predicate (AC1–AC4): the spec fixed with every input duration
 * determinable, the output tier priced, and the input rate KNOWN — an explicitly free "0"
 * passes (free is a price with the snapshot field as its evidence), an unknown never
 * degrades to a zero cost. The dims handed in are the LOCKED basis's (06.5); this
 * function never reads a price of its own.
 */
export function assessVideoEditEnablement(input: {
  dims: PriceSnapshotDims;
  /** The tier table resolved FOR THE LOCKED BASIS (empty from a v1 snapshot). */
  tierTable: VideoTierPriceTable;
  request: unknown;
  /** The creating request type — edit or remix; both share this boundary's quantities. */
  requestType?: VideoEditRequestType;
}): VideoEditEnablement {
  const spec = videoEditSpecOf(input.request, input.requestType);
  if (!spec.ok) return { enabled: false, issue: spec.issue };

  const tier = resolveVideoTierPrice(input.tierTable, spec.spec);
  if (!tier.ok) {
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

  // An edit always carries inputs, so the input rate is always a billed dimension here:
  // unknown refuses with the dimension named; a known "0" is the input side's explicit
  // free price, recorded on the snapshot as evidence (the Resume rule's own sentence).
  const inputRate = input.dims.video_input;
  if (inputRate.status === "unknown") {
    return {
      enabled: false,
      issue: {
        code: "video_input_price_unknown",
        dimension: "video_input",
        reason: inputRate.reason,
      },
    };
  }

  const free = tier.amount === "0" && inputRate.amount === "0";
  const inputSeconds = spec.spec.inputSpecs.reduce(
    (sum, entry) => sum + entry.seconds,
    0,
  );

  // The certified worst-case quantities, in the generation shape plus the input side
  // (AC3): priced by the same 06.5 conversion over the same locked basis, submitted
  // through the same 19.1 path, settled by the same 17.6 lane.
  const quantities = Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [
      dimension,
      dimension === "video"
        ? spec.spec.seconds * spec.spec.outputCount
        : dimension === "video_input"
          ? inputSeconds
          : 0,
    ]),
  ) as ReservationBoundQuantities;

  return {
    enabled: true,
    free,
    spec: spec.spec,
    quantities,
    perSecondUsd: tier.amount,
    inputPerSecondUsd: inputRate.amount,
  };
}

/**
 * The bridge from the resolved rates to the dimensions the ceiling prices: the output
 * tier's rate rides `video` (19.1's own overlay) and the input rate stays on its own
 * `video_input` slot — the caller hands 06.5's conversion the locked basis with BOTH
 * overlaid at the rates the request actually selected. Nothing else changes, and a
 * tampered dims object still fails the conversion's own checker.
 */
export function videoEditCeilingDims(
  dims: PriceSnapshotDims,
  perSecondUsd: string,
  inputPerSecondUsd: string,
): PriceSnapshotDims {
  return {
    ...dims,
    video: { status: "known", amount: perSecondUsd },
    video_input: { status: "known", amount: inputPerSecondUsd },
  };
}

// The generation spec type is re-exported so callers of the edit boundary spell the
// frozen spec the way the shared settlement does.
export type { VideoGenerationSpec };
