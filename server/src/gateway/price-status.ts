/**
 * The known/free/unknown price status classification (Bifrost 03.3, AC06/Q11).
 *
 * ONE CELL, ONE STATUS, PER SNAPSHOT VERSION. A snapshot's dims map (03.2) says, for every
 * billing dimension of the closed vocabulary, either an exact known amount or unknown-with-
 * its-reason. This module folds that map into the one status a model cell carries: `known`
 * when every necessary dimension is priced with some non-zero amount, `free` when every
 * necessary dimension is priced at exactly zero, `unknown` when any necessary dimension
 * lacks a usable price. The classification is a pure function of the dims — the same dims
 * always classify the same way — and it is persisted next to the dims under the same
 * `snapshot_version`, so a version's classification is as immutable as its price basis and a
 * new version classifies from its own dims, never inheriting the previous version's status.
 *
 * WHICH DIMENSIONS ARE NECESSARY. The ones the gateway's v1 wire can price: input, output,
 * reasoning, image, cache read/write and the two surcharges (`WIRE_PRICED_DIMENSIONS`, from
 * 03.2's vocabulary module). The reserved dimensions — image output, audio in/out, video —
 * have no wire field at all in v1, for every model equally; they are a protocol-level gap,
 * not one model's missing price, and do not block known/free until the wire grows their
 * field (which arrives with its own migration, per the vocabulary's rule). What can never
 * happen is a reserved dimension's gap being excused for ONE model and not another: the
 * necessary set is fixed by the wire schema, not per row.
 *
 * UNKNOWN IS NEVER A ZERO COST. The gateway's own missing-price paths compute zero cost
 * (Q11); strict billing must not inherit that. An `unknown` classification carries a fixed
 * `reasonCode` and the missing-dimension list — each entry naming the dimension and the
 * per-dimension reason (`price_dim_no_source`, `price_dim_unreadable`) — and it carries no
 * amount, no cost and no field a caller could read as "callable for free". The rejection
 * paths (03.8's capability filter, 06.2's reserve re-verification) read exactly these fields
 * to say WHY a model cannot be enabled.
 *
 * FREE IS A PRICE, NOT AN ADMISSION. A `free` classification says the upstream evidence
 * prices every necessary dimension at exactly zero. It says nothing about access: the model
 * access grant, the credit gate and the admission path still own every invocation (AC06;
 * ADR 0003). The classification object deliberately carries no flag, grant or bypass — the
 * shape itself makes "free ⇒ no gate" unrepresentable.
 */
import type { PriceSnapshot } from "./price-snapshot";
import {
  type PriceDimension,
  PRICE_DIM_UNKNOWN_REASONS,
  PRICE_DIMENSIONS,
  type PriceDimensionUnknownReason,
  type PriceSnapshotDims,
  WIRE_PRICED_DIMENSIONS,
} from "./price-snapshot";

/** The closed status set. A new member is a contract change, never a free-text value. */
export const PRICE_STATUSES = ["known", "free", "unknown"] as const;

export type PriceStatus = (typeof PRICE_STATUSES)[number];

/**
 * Why a cell is unknown, at the classification level. One fixed code per failure shape:
 * a dimension with no usable price source, or a dimension whose price is present but not
 * an exact non-negative decimal string. Both are safe to show on any screen.
 */
export type PriceStatusUnknownReason =
  /** At least one necessary dimension has no price source on this snapshot. */
  | "price_status_dims_missing"
  /** At least one necessary dimension's price is present but unreadable. */
  | "price_status_dims_unreadable";

export const PRICE_STATUS_UNKNOWN_REASONS = [
  "price_status_dims_missing",
  "price_status_dims_unreadable",
] as const satisfies readonly PriceStatusUnknownReason[];

/** One necessary dimension the classification found unpriced, with the reason it is unpriced. */
export type PriceStatusMissingDimension = {
  dimension: PriceDimension;
  reason: PriceDimensionUnknownReason;
};

/**
 * The classification itself. `known` and `free` carry nothing but the status — no amount, no
 * grant, no bypass; `unknown` carries exactly its reason code and the missing-dimension list,
 * so a rejection can always answer "which dimensions, and why".
 */
export type PriceClassification =
  | { status: "known" }
  | { status: "free" }
  | {
      status: "unknown";
      reasonCode: PriceStatusUnknownReason;
      missingDimensions: readonly PriceStatusMissingDimension[];
    };

/**
 * Classify one dims map. Pure: no database, no network, no clock. Unknown wins over
 * everything — a cell with nine priced dimensions and one unpriced one is unknown, never
 * "known except", because a call would use all of its dimensions, priced or not. When both
 * failure shapes are present the `unreadable` code wins: a present-but-broken price is the
 * sharper defect, and the missing list still names every affected dimension with its own
 * per-dimension reason.
 */
export function classifyPriceDims(
  dims: PriceSnapshotDims,
): PriceClassification {
  const missingDimensions: PriceStatusMissingDimension[] = [];
  let allZero = true;
  for (const dimension of WIRE_PRICED_DIMENSIONS) {
    const state = dims[dimension];
    if (state.status === "unknown") {
      missingDimensions.push({ dimension, reason: state.reason });
      continue;
    }
    if (state.amount !== "0") {
      allZero = false;
    }
  }
  if (missingDimensions.length > 0) {
    const unreadable = missingDimensions.some(
      (missing) => missing.reason === "price_dim_unreadable",
    );
    return {
      status: "unknown",
      reasonCode: unreadable
        ? "price_status_dims_unreadable"
        : "price_status_dims_missing",
      missingDimensions,
    };
  }
  return { status: allZero ? "free" : "known" };
}

/**
 * Classify one snapshot — the seam 03.8's capability filter, 06.2's reserve re-verification
 * and 07.6's bound evidence consume. The answer is always re-derived from the snapshot's
 * dims, never copied from the persisted classification column: a stored status that disagrees
 * with its own dims is a defect, and this function is the independent half that exposes it.
 */
export function classifyPrice(snapshot: PriceSnapshot): PriceClassification {
  return classifyPriceDims(snapshot.dims);
}

/** The columns a snapshot row persists beside the dims, one per classification shape. */
export type PersistedPriceStatus = {
  priceStatus: PriceStatus;
  priceStatusReason: PriceStatusUnknownReason | null;
  priceStatusMissingDimensions: readonly PriceStatusMissingDimension[] | null;
};

/**
 * Map a classification to its persisted columns. Pure; the store writes exactly these, so
 * the database always holds the classification the dims classify to.
 */
export function priceStatusColumns(
  classification: PriceClassification,
): PersistedPriceStatus {
  if (classification.status === "unknown") {
    return {
      priceStatus: classification.status,
      priceStatusReason: classification.reasonCode,
      priceStatusMissingDimensions: classification.missingDimensions,
    };
  }
  return {
    priceStatus: classification.status,
    priceStatusReason: null,
    priceStatusMissingDimensions: null,
  };
}

/**
 * Re-validate the persisted status columns against the closed vocabularies — the application's
 * half of the database CHECKs (0134), applied on read so a tampered or divergent row fails
 * loudly instead of pricing anything. A status outside the set, a non-unknown row carrying
 * unknown details, an unknown row missing either detail, or a missing-dimension entry outside
 * the dimension or reason vocabularies is a defect, not data.
 */
export function assertPriceStatusColumns(
  value: {
    priceStatus: unknown;
    priceStatusReason: unknown;
    priceStatusMissingDimensions: unknown;
  },
  where: string,
): PersistedPriceStatus {
  const { priceStatus, priceStatusReason, priceStatusMissingDimensions } =
    value;
  if (
    typeof priceStatus !== "string" ||
    !PRICE_STATUSES.includes(priceStatus as PriceStatus)
  ) {
    throw new TypeError(
      `${where}: price status ${JSON.stringify(priceStatus)} is outside the closed set (${PRICE_STATUSES.join(", ")}).`,
    );
  }
  const status = priceStatus as PriceStatus;
  if (status !== "unknown") {
    if (priceStatusReason !== null || priceStatusMissingDimensions !== null) {
      throw new TypeError(
        `${where}: a price status that is not exactly unknown carries no reason and no missing-dimension list.`,
      );
    }
    return {
      priceStatus: status,
      priceStatusReason: null,
      priceStatusMissingDimensions: null,
    };
  }
  if (
    typeof priceStatusReason !== "string" ||
    !PRICE_STATUS_UNKNOWN_REASONS.includes(
      priceStatusReason as PriceStatusUnknownReason,
    )
  ) {
    throw new TypeError(
      `${where}: an unknown price status carries no fixed reason (${PRICE_STATUS_UNKNOWN_REASONS.join(", ")}).`,
    );
  }
  if (!Array.isArray(priceStatusMissingDimensions)) {
    throw new TypeError(
      `${where}: an unknown price status carries no missing-dimension list.`,
    );
  }
  if (priceStatusMissingDimensions.length === 0) {
    throw new TypeError(
      `${where}: an unknown price status carries an empty missing-dimension list, which cannot answer which dimensions are missing.`,
    );
  }
  const missingDimensions: PriceStatusMissingDimension[] = [];
  for (const entry of priceStatusMissingDimensions) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(
        `${where}: the missing-dimension list carries an entry that is not an object.`,
      );
    }
    const { dimension, reason } = entry as Record<string, unknown>;
    if (
      typeof dimension !== "string" ||
      !PRICE_DIMENSIONS.includes(dimension as PriceDimension)
    ) {
      throw new TypeError(
        `${where}: the missing-dimension list carries dimension ${JSON.stringify(dimension)}, which is outside the closed vocabulary.`,
      );
    }
    if (
      typeof reason !== "string" ||
      !PRICE_DIM_UNKNOWN_REASONS.includes(reason as PriceDimensionUnknownReason)
    ) {
      throw new TypeError(
        `${where}: the missing-dimension list carries reason ${JSON.stringify(reason)}, which is outside the fixed dimension reasons (${PRICE_DIM_UNKNOWN_REASONS.join(", ")}).`,
      );
    }
    missingDimensions.push({
      dimension: dimension as PriceDimension,
      reason: reason as PriceDimensionUnknownReason,
    });
  }
  return {
    priceStatus: "unknown",
    priceStatusReason: priceStatusReason as PriceStatusUnknownReason,
    priceStatusMissingDimensions: missingDimensions,
  };
}

/**
 * The tamper check the read path runs: the persisted columns must be exactly what the row's
 * own dims classify to. The database CHECK (0134) enforces the same rule on every write, so a
 * disagreement here means the stored row was written by something that bypassed both — fail
 * loudly, never price from it.
 */
export function assertPriceStatusColumnsMatchDims(
  dims: PriceSnapshotDims,
  columns: PersistedPriceStatus,
  where: string,
): void {
  const expected = priceStatusColumns(classifyPriceDims(dims));
  if (
    expected.priceStatus !== columns.priceStatus ||
    expected.priceStatusReason !== columns.priceStatusReason ||
    JSON.stringify(expected.priceStatusMissingDimensions) !==
      JSON.stringify(columns.priceStatusMissingDimensions)
  ) {
    throw new TypeError(
      `${where}: the stored price status columns disagree with the row's own dims (stored ${columns.priceStatus}, dims classify ${expected.priceStatus}).`,
    );
  }
}
