import type { PriceDimension, PriceSnapshotDims } from "../gateway/price-snapshot";
import type { ModelRef } from "../gateway/catalog";
import { modelRefKey } from "../gateway/catalog";
import { VIDEO_GENERATION_BILLED_DIMENSIONS } from "./video-generation-pricing";
import { VIDEO_EDIT_BILLED_DIMENSIONS } from "./video-edit-pricing";

/*
 * The video spec availability summary (Bifrost 19.2, #338): the read that answers, for
 * each video-capability model cell and each calling METHOD the video line wires, whether
 * the deployment's latest price bases enable that spec — and when they do not, exactly
 * which dimension each cell is missing (未定价视频规格不可选择、不可用且原因指向缺失维度).
 *
 * THE VERDICT IS THE CELL'S OWN, PER METHOD — never a family switch. Availability is
 * precise to model + spec + calling method (the Resume hint's own sentence): a cell whose
 * basis prices the generation dimensions answers enabled for generation while its sibling
 * cell — same provider, same capability, unpriced basis — answers price_unknown, and one
 * darkens neither the other nor the family. The method rows consult the billed-dimension
 * sets the line's own assessors price admissions against (generation's is 19.1's; the
 * edit/remix rows join with 19.3's mapping, each carrying its own dimensions), so the
 * summary and the submit gate can never disagree about what is usable.
 *
 * THREE STATES, THREE DIFFERENT ADMINISTRATOR ANSWERS. `enabled`/`free` (every billed
 * dimension known — free when they are all priced exactly zero, a price, never a gap),
 * `price_unknown` (a basis exists and refuses: re-price the named dimensions), and cells
 * with no snapshot at all simply do not appear — the summary answers over the bases that
 * exist, the unmapped state being the group-11 summary's own word for a capability with
 * no cell anywhere. `unknown` is never rendered free (unknown 不显示为免费): the free and
 * unknown states are different words with different reasons on every surface this feeds.
 *
 * THE GATE IS THE OTHER HALF. This read makes unpriced specs unselectable; the forced
 * call is refused by the submit path's own enablement stage (19.1's predicate wired
 * first), which never reaches the reserve door or the provider — 供应商派发数为 0 and no
 * hold forms, so no ledger row can land (拒绝不产生任何账务写入). The gate's refusal
 * carries the same dimension+reason this summary lists, so the surface and the door say
 * the same sentence.
 *
 * PURE ON ITS INPUT. The same snapshots always answer the same summary — the discovery
 * surface, the selection UI and any future reader consume one function and can never
 * disagree about what is usable. The snapshots handed in are the LATEST per cell, the
 * same read the group-11 summary consumes.
 */

/** The calling methods the video line wires. Each member's billed set is its own. */
export const VIDEO_SPEC_METHODS = ["generation", "edit", "remix"] as const;

export type VideoSpecMethod = (typeof VIDEO_SPEC_METHODS)[number];

/**
 * Each method's own billed dimensions — the sets its assessor prices admissions against.
 * 19.3's edit/remix rows price the input side too (`video_input`, 0202's own slot): a cell
 * that prices generation may still refuse edit until the input rate lands — the method
 * granularity the Resume hint demands, never a family switch. The registry is the one
 * place a new method's set is named.
 */
export const VIDEO_METHOD_BILLED_DIMENSIONS: Record<
  VideoSpecMethod,
  readonly PriceDimension[]
> = {
  generation: VIDEO_GENERATION_BILLED_DIMENSIONS,
  edit: VIDEO_EDIT_BILLED_DIMENSIONS,
  remix: VIDEO_EDIT_BILLED_DIMENSIONS,
};

/** Why a video spec method is not available. Closed vocabulary, displayable. */
export type VideoSpecUnavailableReason = "video_spec_price_unknown";

/** One method's verdict on one cell's latest basis. */
export type VideoSpecMethodAvailability =
  | {
      method: VideoSpecMethod;
      state: "enabled" | "free";
      /** True when every billed dimension is priced exactly "0" — a price, not a gap. */
      free: boolean;
    }
  | {
      method: VideoSpecMethod;
      state: "price_unknown";
      reasonCode: VideoSpecUnavailableReason;
      /**
       * The missing dimensions with their per-dimension reasons — the administrator's
       * re-pricing worklist and the refusal's own sentence, never a guess.
       */
      missingDimensions: {
        dimension: PriceDimension;
        reasonCode: string;
      }[];
    };

/** One video cell's availability: the ref and each wired method's verdict. */
export type VideoSpecCellAvailability = {
  ref: ModelRef;
  methods: VideoSpecMethodAvailability[];
};

/** The video capability's spec-availability summary — the discovery/UI read. */
export type VideoSpecAvailability = {
  capability: "video";
  cells: VideoSpecCellAvailability[];
};

function methodAvailability(
  method: VideoSpecMethod,
  dims: PriceSnapshotDims,
): VideoSpecMethodAvailability {
  const billed = VIDEO_METHOD_BILLED_DIMENSIONS[method];
  const missing: { dimension: PriceDimension; reasonCode: string }[] = [];
  for (const dimension of billed) {
    const state = dims[dimension];
    if (state.status === "unknown") {
      missing.push({ dimension, reasonCode: state.reason });
    }
  }
  if (missing.length > 0) {
    return {
      method,
      state: "price_unknown",
      reasonCode: "video_spec_price_unknown",
      missingDimensions: missing,
    };
  }
  const free = billed.every(
    (dimension) =>
      dims[dimension].status === "known" && dims[dimension].amount === "0",
  );
  return { method, state: free ? "free" : "enabled", free };
}

/**
 * The summary: each video-capability cell's latest snapshot, judged per method against
 * that method's own billed dimensions. Pure — the same input always answers the same
 * output, so every surface reading it shows the same words the submit gate enforces.
 */
export function summarizeVideoSpecAvailability(input: {
  /** Each cell's LATEST price snapshot (the same read the group-11 summary consumes). */
  snapshots: { ref: ModelRef; dims: PriceSnapshotDims }[];
}): VideoSpecAvailability {
  const cells = input.snapshots
    .filter((snapshot) => snapshot.ref.capability === "video")
    .map((snapshot) => ({
      ref: snapshot.ref,
      methods: VIDEO_SPEC_METHODS.map((method) =>
        methodAvailability(method, snapshot.dims),
      ),
    }))
    .sort((a, b) => modelRefKey(a.ref).localeCompare(modelRefKey(b.ref)));
  return { capability: "video", cells };
}
