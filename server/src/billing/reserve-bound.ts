/**
 * The hold-ceiling conversion and the pricing-basis version lock (Bifrost 06.5, AC12).
 *
 * TWO DELIVERABLES, ONE DISCIPLINE. First, a PURE conversion that turns a price basis, a set
 * of per-dimension maximum quantities and a conversion rate into the hold ceiling in scaled
 * credit units (×100, the ledger's `CREDIT_SCALE`): the ceiling covers EVERY dimension of the
 * closed billing vocabulary — never only input/output — and it rounds 足额, UP: it is the
 * smallest whole unit that is ≥ the exact possible cost, so a request admitted against it can
 * never cost more than was held. Rounding down anywhere in that chain is a systematic
 * overspend (each admitted request could spend a fraction of a unit more than its hold), which
 * is why the exact rational travels beside the ceiling and the direction is asserted against
 * it, not assumed.
 *
 * Second, the VERSION LOCK. A reservation persists the pricing basis it was admitted against —
 * the model cell, the `snapshotVersion` and the `rateVersion` — and settlement resolves THAT
 * recorded combination through {@link resolveLockedReservationBasis}, never whatever is newest.
 * This module deliberately has no read of the current price or the current rate: after a price
 * sync mints version 2 and an administrator saves a new rate, a hold admitted against version 1
 * of each still prices, still settles and still releases at version 1's exact terms, because a
 * version's value is immutable (03.2's append-only snapshots, 01.4's append-only rate
 * history). A settlement that priced a hold with prices or a rate that changed mid-flight
 * would bill money nobody agreed to.
 *
 * EXACT ARITHMETIC, END TO END. Prices are exact decimal strings, quantities whole numbers,
 * the rate an exact rational: the cost is summed, converted and scaled in BigInt rationals,
 * and only the final ceiling is an integer. No float exists anywhere in the chain, and nothing
 * is read through `Number` except the one integer the ledger stores.
 *
 * WHO CALLS THIS. The deployment's admission side computes the hold ceiling with
 * {@link computeReservationCeiling} before sending a Reserve request (its `maximumCredits` is
 * this function's answer); the Reserve write (06.2/06.3) persists the basis with the hold;
 * the settlement side (06.9) resolves the lock with {@link resolveLockedReservationBasis} and
 * prices the actual usage with the exact basis it gets back. The conservative token estimate
 * (ADR 0001, input-bound.ts) is nobody's input here: it can reject a request, never prove a
 * cost ceiling, and the per-dimension quantities this module consumes must come from
 * enforceable bound evidence, not from an estimate.
 */

import type { Database } from "../db/client";
import { MODEL_CAPABILITIES, type ModelCapability } from "../gateway/catalog";
import type { ConversionRate } from "../gateway/conversion-rate";
import { createConversionRateStore } from "../gateway/conversion-rate-store";
import {
  assertPriceSnapshotDims,
  canonicalPriceAmount,
  createEnterpriseGatewayPriceSnapshotStore,
  PRICE_DIMENSIONS,
  type PriceDimension,
  type PriceDimensionUnknownReason,
  type PriceSnapshotDims,
} from "../gateway/price-snapshot";
import { CREDIT_SCALE } from "./credits";

/**
 * The per-dimension maximum quantities a request's enforceable bound evidence certifies: for
 * every dimension of the closed vocabulary, the largest count of that dimension's units the
 * request can possibly consume. Every key is required — the shape itself enforces "all
 * dimensions, not only input/output" — and a request whose priced dimensions have no certified
 * maximum cannot construct one, which is the admission question, not this module's.
 */
export type ReservationBoundQuantities = {
  readonly [D in PriceDimension]: number;
};

/** Why a ceiling could not be certified. Fixed codes; safe to show on any surface. */
export type ReservationCeilingIssue =
  /** A quantity is not a non-negative whole number, or a dimension's quantity is absent. */
  | { code: "quantity_invalid"; dimension: PriceDimension }
  /** A dimension of the basis is unknown (or its amount unreadable): unknown is never a zero cost. */
  | {
      code: "price_unknown";
      dimension: PriceDimension;
      reason: PriceDimensionUnknownReason;
    }
  /** The rate is not a positive exact rational — not an exchange. */
  | { code: "rate_invalid" }
  /** The ceiling exceeds the 32-bit ledger column; no hold could ever settle it. */
  | { code: "ceiling_exceeds_ledger" };

/** What the conversion answers: a certified ceiling, or the refusal that names its reason. */
export type ReservationCeiling =
  | {
      ok: true;
      /**
       * The hold ceiling: the smallest whole scaled unit (×100) that is ≥ the exact possible
       * cost — 足额, never rounded down. Zero means the true possible cost is exactly zero
       * (an explicitly free basis); the Reserve contract still requires a positive hold, so
       * the caller decides its policy for free calls.
       */
      maximumCredits: number;
      /** The exact possible cost in scaled units, in lowest terms — the ceiling's floor target. */
      exactScaledUnits: { numerator: bigint; denominator: bigint };
    }
  | { ok: false; issue: ReservationCeilingIssue };

/** Largest value the ledger's 32-bit integer columns can hold, in stored units. */
const MAX_STORED_UNITS = 2_147_483_647n;

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

/** Reduce an exact rational to lowest terms; zero is carried as 0/1. */
function reduce(
  numerator: bigint,
  denominator: bigint,
): {
  numerator: bigint;
  denominator: bigint;
} {
  if (numerator === 0n) return { numerator: 0n, denominator: 1n };
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

/** One exact amount string → its BigInt rational; null when the string is not an exact decimal. */
function parseExactDecimal(amount: string): {
  numerator: bigint;
  denominator: bigint;
} | null {
  const canonical = canonicalPriceAmount(amount);
  if (!canonical.ok) return null;
  const dot = canonical.amount.indexOf(".");
  if (dot === -1) {
    return { numerator: BigInt(canonical.amount), denominator: 1n };
  }
  const digits = canonical.amount.replace(".", "");
  return {
    numerator: BigInt(digits),
    denominator: 10n ** BigInt(canonical.amount.length - dot - 1),
  };
}

/**
 * The hold-ceiling conversion. Pure: no database, no network, no clock — the same basis,
 * quantities and rate always certify the same ceiling, so every surface that recomputes it
 * agrees. The dims are re-validated through 03.2's own checker (a tampered basis is a thrown
 * defect, never a guessed price); a dimension priced `unknown` refuses — unknown is never a
 * zero cost — and the refusal names the dimension and its own reason. Quantities are
 * re-validated per dimension: whole, non-negative, present. The arithmetic is exact in BigInt
 * rationals, and the single rounding step is the LAST one: the ceiling of the exact scaled
 * cost, upward.
 */
export function computeReservationCeiling(input: {
  /** The locked price basis's dims — every dimension known (or explicitly free at "0"). */
  dims: PriceSnapshotDims;
  /** The enforceable per-dimension maximum quantities the request certifies. */
  quantities: ReservationBoundQuantities;
  /** The locked USD→credits conversion rate. */
  rate: ConversionRate;
}): ReservationCeiling {
  const { dims, quantities, rate } = input;
  if (rate.numerator <= 0n || rate.denominator <= 0n) {
    return { ok: false, issue: { code: "rate_invalid" } };
  }
  // A tampered dims object is a defect, not data: 03.2's checker throws rather than letting a
  // guessed price certify a hold.
  assertPriceSnapshotDims(dims, "The reserve-bound ceiling basis");

  let costNumerator = 0n;
  let costDenominator = 1n;
  for (const dimension of PRICE_DIMENSIONS) {
    const quantity = quantities[dimension];
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      return { ok: false, issue: { code: "quantity_invalid", dimension } };
    }
    const state = dims[dimension];
    if (state.status === "unknown") {
      return {
        ok: false,
        issue: { code: "price_unknown", dimension, reason: state.reason },
      };
    }
    const amount = parseExactDecimal(state.amount);
    if (amount === null) {
      // Unreachable behind the checker above; kept so this function never prices a string it
      // could not read exactly, whatever a future caller hands it.
      return {
        ok: false,
        issue: {
          code: "price_unknown",
          dimension,
          reason: "price_dim_unreadable",
        },
      };
    }
    // quantity × amount, accumulated into the running exact sum by cross-multiplication.
    costNumerator =
      costNumerator * amount.denominator +
      BigInt(quantity) * amount.numerator * costDenominator;
    costDenominator = costDenominator * amount.denominator;
  }

  // USD → credits → scaled units, still exact: cost × rate × CREDIT_SCALE.
  const scaledNumerator = costNumerator * rate.numerator * BigInt(CREDIT_SCALE);
  const scaledDenominator = costDenominator * rate.denominator;
  const exact = reduce(scaledNumerator, scaledDenominator);

  // The one rounding step, and it is upward: the least whole unit that is ≥ the exact cost.
  const ceiling =
    exact.numerator === 0n
      ? 0n
      : (exact.numerator + exact.denominator - 1n) / exact.denominator;
  if (ceiling > MAX_STORED_UNITS) {
    return { ok: false, issue: { code: "ceiling_exceeds_ledger" } };
  }
  return { ok: true, maximumCredits: Number(ceiling), exactScaledUnits: exact };
}

/**
 * One dimension's exact scaled cost (20.3): the per-dimension member of what
 * {@link computeReservationCeiling} sums — the same quantity × price × rate × CREDIT_SCALE
 * arithmetic, computed per dimension and left exact (no rounding here; the settlement's
 * single rounding is allocated when the split is written). Only dimensions with a positive
 * quantity are members: a dimension the call did not use accounts for none of the cost.
 */
export type DimensionScaledUnit = {
  readonly dimension: PriceDimension;
  readonly numerator: bigint;
  readonly denominator: bigint;
};

/**
 * The per-dimension exact scaled costs of one priced usage — the settlement's split input.
 * Pure, and derived through the same parse/validate discipline as the ceiling: an unknown
 * dimension or unreadable price refuses rather than guessing, and the members' exact sum is
 * the total the ceiling function computes (the caller's `exactScaledUnits`), by the same
 * accumulation order.
 */
export function computeDimensionScaledUnits(input: {
  dims: PriceSnapshotDims;
  quantities: ReservationBoundQuantities;
  rate: ConversionRate;
}):
  | { ok: true; members: DimensionScaledUnit[] }
  | { ok: false; issue: ReservationCeilingIssue } {
  const { dims, quantities, rate } = input;
  if (rate.numerator <= 0n || rate.denominator <= 0n) {
    return { ok: false, issue: { code: "rate_invalid" } };
  }
  assertPriceSnapshotDims(dims, "The settlement dimension split basis");
  const members: DimensionScaledUnit[] = [];
  for (const dimension of PRICE_DIMENSIONS) {
    const quantity = quantities[dimension];
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      return { ok: false, issue: { code: "quantity_invalid", dimension } };
    }
    if (quantity === 0) continue;
    const state = dims[dimension];
    if (state.status === "unknown") {
      return {
        ok: false,
        issue: { code: "price_unknown", dimension, reason: state.reason },
      };
    }
    const amount = parseExactDecimal(state.amount);
    if (amount === null) {
      return {
        ok: false,
        issue: {
          code: "price_unknown",
          dimension,
          reason: "price_dim_unreadable",
        },
      };
    }
    // quantity × price (USD) × rate × CREDIT_SCALE, exact.
    const numerator =
      BigInt(quantity) *
      amount.numerator *
      rate.numerator *
      BigInt(CREDIT_SCALE);
    const denominator = amount.denominator * rate.denominator;
    const exact = reduce(numerator, denominator);
    members.push({
      dimension,
      numerator: exact.numerator,
      denominator: exact.denominator,
    });
  }
  return { ok: true, members };
}

/**
 * The pricing basis a reservation locked at admission: the model cell plus the two versions.
 * Complete by construction — a lock names all five fields or none; the reservation table's
 * CHECK enforces the same completeness on the row.
 */
export type ReservationLockedBasis = {
  provider: string;
  model: string;
  capability: ModelCapability;
  /** The price snapshot version the hold was admitted against (≥ 1). */
  snapshotVersion: number;
  /** The conversion-rate version the hold was admitted against (0 = the environment rate). */
  rateVersion: number;
};

/** The lock fields as the reservation row stores them (nullable: a pre-06.5 row carries none). */
export type ReservationRowLockFields = {
  provider: string | null;
  model: string | null;
  capability: string | null;
  snapshotVersion: number | null;
  rateVersion: number | null;
};

/**
 * The speech quantities a hold froze at admission (Bifrost 13.2, #307): what 13.1's
 * admission certified, persisted WITH the pricing lock so settlement can corroborate the
 * character side — the side the price vocabulary has no slot for (13.1's own unit-honesty).
 * The two tier prices ride along so the settle surface re-carries the exact certified pair.
 */
export type ReservationSpeechSpec = {
  inputCharacters: number;
  voiceTier: string | null;
  durationCapSeconds: number;
  perInputCharacterUsd: string;
  perOutputSecondUsd: string;
};

/** The speech spec as the reservation row stores it (nullable: a non-speech row carries none). */
export type ReservationRowSpeechSpecFields = {
  specInputCharacters: number | null;
  specVoiceTier: string | null;
  specDurationCapSeconds: number | null;
  specPerInputCharacterUsd: string | null;
  specPerOutputSecondUsd: string | null;
};

/**
 * Read the frozen speech spec off a reservation row. All five absent → null (a non-speech
 * hold, or a row from before the spec columns existed); the character side can only be
 * corroborated against a spec that was actually frozen. Present → the certified spec,
 * shape-proved the same way the row's own completeness CHECK is — a half-spec or a
 * spec outside its shapes is a defect this reader refuses to launder into a price.
 */
export function speechSpecOfReservation(
  row: ReservationRowSpeechSpecFields,
): ReservationSpeechSpec | null {
  const { specInputCharacters: chars, specDurationCapSeconds: cap } = row;
  if (
    chars === null &&
    row.specPerInputCharacterUsd === null &&
    row.specPerOutputSecondUsd === null &&
    cap === null
  ) {
    return null;
  }
  if (
    chars === null ||
    row.specPerInputCharacterUsd === null ||
    row.specPerOutputSecondUsd === null ||
    cap === null
  ) {
    throw new TypeError(
      "speechSpecOfReservation: the reservation row carries a half speech spec; the table's completeness CHECK refuses to write such rows.",
    );
  }
  if (
    !Number.isSafeInteger(chars) ||
    chars < 0 ||
    !Number.isSafeInteger(cap) ||
    cap < 1 ||
    !/^\d+(\.\d+)?$/.test(row.specPerInputCharacterUsd) ||
    !/^\d+(\.\d+)?$/.test(row.specPerOutputSecondUsd)
  ) {
    throw new TypeError(
      "speechSpecOfReservation: the reservation row carries a speech spec outside its shapes.",
    );
  }
  return {
    inputCharacters: chars,
    voiceTier: row.specVoiceTier,
    durationCapSeconds: cap,
    perInputCharacterUsd: row.specPerInputCharacterUsd,
    perOutputSecondUsd: row.specPerOutputSecondUsd,
  };
}

/**
 * Read the lock off a reservation row. All five fields absent → null (a pre-06.5 reservation,
 * or a hold written by a caller outside the credit protocol). All five present → the locked
 * basis, with the cell's capability re-proved against the closed vocabulary and the versions
 * re-proved whole, exactly as the row's own CHECK demands. A HALF-lock is a defect: the
 * database refuses the row and this reader refuses to guess what the missing half was.
 */
export function lockedBasisOfReservation(
  row: ReservationRowLockFields,
): ReservationLockedBasis | null {
  if (
    row.provider === null &&
    row.model === null &&
    row.capability === null &&
    row.snapshotVersion === null &&
    row.rateVersion === null
  ) {
    return null;
  }
  if (
    row.provider === null ||
    row.model === null ||
    row.capability === null ||
    row.snapshotVersion === null ||
    row.rateVersion === null
  ) {
    throw new TypeError(
      "lockedBasisOfReservation: the reservation row carries a half-lock (some basis fields present, others null); the table's NULL-safe completeness CHECK refuses to write such rows (proven at the database level in reserve-version-locking.integration.test.ts), so a row like this was stored while the earlier porous CHECK was live — either way it is not a basis anyone can price from.",
    );
  }
  if (
    !MODEL_CAPABILITIES.includes(row.capability as ModelCapability) ||
    !Number.isSafeInteger(row.snapshotVersion) ||
    row.snapshotVersion < 1 ||
    !Number.isSafeInteger(row.rateVersion) ||
    row.rateVersion < 0 ||
    row.provider === "" ||
    row.model === ""
  ) {
    throw new TypeError(
      "lockedBasisOfReservation: the reservation row carries a lock outside the closed basis vocabulary.",
    );
  }
  return {
    provider: row.provider,
    model: row.model,
    capability: row.capability as ModelCapability,
    snapshotVersion: row.snapshotVersion,
    rateVersion: row.rateVersion,
  };
}

/**
 * What the settlement-side resolution answers: the exact basis the lock names, or a fixed
 * reason it could not be resolved. Never a neighbor's value, never a newer one.
 */
export type LockedBasisResolution =
  | {
      resolved: true;
      dims: PriceSnapshotDims;
      rate: ConversionRate;
      snapshotVersion: number;
      rateVersion: number;
    }
  | {
      resolved: false;
      reason: "snapshot_not_found" | "rate_not_found" | "rate_not_configured";
    };

/**
 * Resolve one locked basis to the exact prices and rate it names — the read the settlement
 * path (06.9) is built on, and the ONLY pricing read a settlement may make. The snapshot comes
 * from the versioned, append-only price history by (cell, snapshotVersion); the rate from the
 * append-only rate history by version number, with version 0 resolving to the deployment's
 * environment rate when one is configured. Nothing here consults the current price basis or
 * the current rate: a basis that changed after admission is exactly the thing this lock exists
 * to refuse.
 *
 * A version nobody recorded resolves as not found (or, for version 0 with no environment rate,
 * as not configured) — loudly, because a hold that cannot price itself must fail its
 * settlement, not guess.
 */
export async function resolveLockedReservationBasis(
  deps: {
    database: Database;
    /** The deployment's validated environment rate — the value version 0 names. */
    environmentRate?: ConversionRate;
  },
  basis: ReservationLockedBasis,
): Promise<LockedBasisResolution> {
  const snapshot = await createEnterpriseGatewayPriceSnapshotStore(
    deps.database,
  ).priceSnapshot(
    {
      provider: basis.provider,
      model: basis.model,
      capability: basis.capability,
    },
    basis.snapshotVersion,
  );
  if (snapshot === undefined) {
    return { resolved: false, reason: "snapshot_not_found" };
  }
  const lockedRate = await createConversionRateStore(deps).readRateVersion(
    basis.rateVersion,
  );
  if (!lockedRate.found) {
    return {
      resolved: false,
      reason:
        lockedRate.reason === "not_configured"
          ? "rate_not_configured"
          : "rate_not_found",
    };
  }
  return {
    resolved: true,
    dims: snapshot.dims,
    rate: {
      numerator: lockedRate.numerator,
      denominator: lockedRate.denominator,
    },
    snapshotVersion: basis.snapshotVersion,
    rateVersion: basis.rateVersion,
  };
}
