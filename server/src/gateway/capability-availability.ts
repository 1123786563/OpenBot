import type { PriceDimension, PriceSnapshotDims } from "./price-snapshot";
import { modelRefKey, type ModelRef } from "./catalog";
import { EMBEDDING_BILLED_DIMENSIONS } from "../billing/embedding-pricing";
import { RERANK_BILLED_DIMENSIONS } from "../billing/rerank-pricing";
import { OCR_BILLED_DIMENSIONS } from "../billing/ocr-pricing";

/*
 * The three-capability availability summary (Bifrost 11.6, #301): one read that answers,
 * for each of the group-11 capabilities — Embedding, Rerank, OCR — whether the deployment's
 * latest price bases ENABLE it, and when they do not, exactly which dimension each cell is
 * missing (三类能力的启用状态与原因可在发现接口查询).
 *
 * THE AVAILABILITY QUESTION IS THE CAPABILITY'S OWN. Each capability bills its own closed
 * dimension set — the very sets its own assessor prices admissions against — so the summary
 * consults those sets directly and never invents a per-capability predicate: a cell is
 * AVAILABLE when every dimension its capability bills is KNOWN on that cell's latest
 * snapshot, FREE-AVAILABLE when they are all known and priced exactly zero, and UNAVAILABLE
 * with the missing dimensions and their reasons when any is unknown. Unknown is never a
 * zero cost and never renders as free (unknown 不显示为免费): the free and unknown states
 * are different words with different reasons, on every surface this feeds.
 *
 * NO CELL IS AN ISLAND DECISION. A capability with no cell at all is `unmapped` — no basis
 * has ever been synced for it — which is a different answer than a cell whose basis turned
 * unknown: the administrator action differs (sync prices vs re-price the dimension). A
 * capability with at least one available cell answers `enabled`, with the free cell count
 * riding along; a capability whose every cell is unknown answers `price_unknown` with every
 * cell's missing dimensions.
 *
 * PURE ON ITS INPUT. The same snapshots always answer the same summary — the admin surface,
 * the discovery interface and any future reader consume one function and can never disagree
 * about what is usable. The snapshots handed in are the LATEST per cell, the same read the
 * audio path projection (#313) consumes.
 */

/** Each group-11 capability's own billed dimensions — the sets its assessor prices by. */
export const CAPABILITY_BILLED_DIMENSIONS: Record<
  "embedding" | "rerank" | "ocr",
  readonly PriceDimension[]
> = {
  embedding: EMBEDDING_BILLED_DIMENSIONS,
  rerank: RERANK_BILLED_DIMENSIONS,
  ocr: OCR_BILLED_DIMENSIONS,
};

/** The closed capability set this summary answers, in display order. */
export const SUMMARIZED_CAPABILITIES = ["embedding", "rerank", "ocr"] as const;

export type SummarizedCapability = (typeof SUMMARIZED_CAPABILITIES)[number];

/**
 * Why a capability is not available. Closed vocabulary, displayable — and deliberately
 * distinct from every cell state: `unmapped` is "no basis exists", `price_unknown` is "a
 * basis exists and refuses", the admission door's own refusals never appear here (this is
 * the basis-level summary, not a request verdict).
 */
export type CapabilityUnavailableReason =
  | "capability_unmapped"
  | "capability_price_unknown";

/** One cell's basis verdict against its capability's billed dimensions. */
type CellAvailability = {
  ref: ModelRef;
  free: boolean;
  missing: { dimension: PriceDimension; reason: string }[];
};

/** One capability's summary: the state, the reason when unavailable, the cells that back it. */
export type CapabilityAvailability = {
  capability: SummarizedCapability;
  state: "enabled" | "free" | "unmapped" | "price_unknown";
  /** Present exactly when the state is not enabled/free — the one displayable reason. */
  reasonCode?: CapabilityUnavailableReason;
  /** Available cells (enabled/free), each with its free flag; empty when unavailable. */
  cells: { ref: ModelRef; free: boolean }[];
  /**
   * When unavailable for a priced-basis reason: every cell's missing dimensions with their
   * per-dimension reasons — the administrator's re-pricing worklist, never a guess.
   */
  missingDimensions?: { ref: ModelRef; dimension: PriceDimension; reasonCode: string }[];
};

/** One cell's basis against the capability's billed dimensions: available, or the missing list. */
function cellAvailability(
  ref: ModelRef,
  dims: PriceSnapshotDims,
  billed: readonly PriceDimension[],
): CellAvailability {
  const missing: { dimension: PriceDimension; reason: string }[] = [];
  for (const dimension of billed) {
    const state = dims[dimension];
    if (state.status === "unknown") {
      missing.push({ dimension, reason: state.reason });
    }
  }
  const free =
    missing.length === 0 &&
    billed.every(
      (dimension) =>
        dims[dimension].status === "known" && dims[dimension].amount === "0",
    );
  return { ref, free, missing };
}

/**
 * The summary: for each of the three capabilities, the latest-snapshot availability over
 * that capability's own billed dimensions. Pure — the same input always answers the same
 * output, so every surface reading it shows the same words.
 */
export function summarizeCapabilityAvailability(input: {
  /** Each cell's LATEST price snapshot (the same read the audio projection consumes). */
  snapshots: { ref: ModelRef; dims: PriceSnapshotDims }[];
}): CapabilityAvailability[] {
  const byRef = new Map(input.snapshots.map((s) => [modelRefKey(s.ref), s]));

  return SUMMARIZED_CAPABILITIES.map((capability) => {
    const billed = CAPABILITY_BILLED_DIMENSIONS[capability];
    const cells = [...byRef.values()]
      .filter((snapshot) => snapshot.ref.capability === capability)
      .map((snapshot) => cellAvailability(snapshot.ref, snapshot.dims, billed))
      .sort((a, b) => modelRefKey(a.ref).localeCompare(modelRefKey(b.ref)));
    if (cells.length === 0) {
      return {
        capability,
        state: "unmapped" as const,
        reasonCode: "capability_unmapped" as const,
        cells: [],
      };
    }
    const available = cells.filter((cell) => cell.missing.length === 0);
    if (available.length > 0) {
      const allFree = available.every((cell) => cell.free);
      return {
        capability,
        state: allFree ? ("free" as const) : ("enabled" as const),
        cells: available.map((cell) => ({ ref: cell.ref, free: cell.free })),
      };
    }
    return {
      capability,
      state: "price_unknown" as const,
      reasonCode: "capability_price_unknown" as const,
      cells: [],
      missingDimensions: cells.flatMap((cell) =>
        cell.missing.map((entry) => ({ ref: cell.ref, dimension: entry.dimension, reasonCode: entry.reason })),
      ),
    };
  });
}
