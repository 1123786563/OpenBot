import { randomBytes } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { billingCustomers } from "../db/schema/billing";
import {
  creditAsyncSettlementDetails,
  creditBatchSettlementDetails,
  creditChargeRemainders,
  creditReservationAllocations,
  creditReservations,
  creditSettlementDetails,
  creditSettlementDimensionBreakdown,
  creditSpeechSettlementDetails,
} from "../db/schema/credit-reservations";
import { creditGrants, creditLedger as ledger } from "../db/schema/credits";
import {
  PRICE_DIMENSIONS,
  type PriceDimension,
} from "../gateway/price-snapshot";
import {
  carriedRemainder,
  liveGrants,
  readCapacity,
  type Tx,
} from "./capacity";
import { PRICE_DIMENSIONS, type PriceDimension } from "../gateway/price-snapshot";
import type { ReservationLockedBasis } from "./reserve-bound";
import type { CreditGrantSource } from "./types";

/**
 * The local credit ledger's WRITE side. The deposit (grantCredits) is the only writer
 * `credit_grants` has ever had; the reserve/settle/release trio (reserveCredits,
 * settleReservation, releaseReservation) is the only writer that moves `used` or writes
 * `credit_ledger`, so every invariant about the ledger is decided here, once. The reads live
 * in ./credits.ts and stay untouched.
 *
 * Discipline carried over from the payments module: credits stay integers scaled by
 * `CREDIT_SCALE` (×100) from input to storage — a grant of "23.63 credits" is the integer 2363
 * and never a binary float — timestamps are timestamptz, and failures answer with the billing
 * seam's sentinel codes rather than raw messages.
 *
 * Idempotency: every grant AND every reservation carries an idempotency key, and the unique
 * indexes on `credit_grants.idempotency_key` / `credit_ledger.idempotency_key` are the
 * authorities — the insert-or-nothing against them turns a retry into a read of the row that
 * already exists. A caller with no natural key (an operator pressing the promo button, where
 * two presses MEAN two grants) gets a random one derived here, which keeps the insert
 * always-fresh while holding the columns NOT NULL — that is what lets both indexes be plain
 * unique, so ON CONFLICT can infer them (Postgres cannot infer a partial index without its
 * WHERE spelled in-statement). A settled hold's ledger row carries the derived key
 * `reservation:<id>`, so the ledger's own index fences a double settle.
 *
 * A grant row is born `active` and is never status-flipped afterwards: the read side derives
 * `exhausted`/`expired` from the clock and the balance (credits.ts `deriveGrantStatus`), so the
 * stored `status` is the birth certificate, not a second truth to maintain.
 */

/** One grant row, as the writer answers it: the stored row's facts, ISO times. */
export type CreditGrantResult = {
  id: string;
  externalCustomerId: string;
  source: CreditGrantSource;
  reason: string | null;
  total: number;
  used: number;
  grantedAt: string;
  expiresAt: string;
};

/** A `cg-` grant id: 8 random bytes as hex, the same draw size the payment order ids use. */
function generateGrantId(): string {
  return `cg-${randomBytes(8).toString("hex")}`;
}

/** Largest value a 32-bit PostgreSQL integer column can hold. */
const MAX_STORED_UNITS = 2_147_483_647;
/** Bounds a single rational charge; accumulated remainders may need a larger denominator. */
const MAX_ACTUAL_DENOMINATOR = 10n ** 60n;

/** An exact non-negative rational, in scaled credit units (×100). */
export type CreditAmount = { numerator: bigint; denominator: bigint };

export type CreditReservationState =
  | "reserved"
  | "unknown"
  | "settled"
  | "released";

/** A reservation call that conflicts with the reservation's recorded identity or terminal state. */
export class CreditReservationConflictError extends Error {
  /** Stable, snake_case, matched by the delivery worker's non-retryable set (audit C1). */
  readonly code = "reservation_conflict";
  /**
   * The stable machine-readable kind of the conflict — the discriminator 06.10's settle
   * surface answers with in its refusal `detail`, so a caller distinguishes the classes
   * (`no_such_reservation`, `reservation_released`, `settled_with_different_actual`, …)
   * without parsing a message. Callers that name none get the generic kind.
   */
  readonly conflictKind: string;
  constructor(message: string, conflictKind = "reservation_conflict") {
    super(message);
    this.name = "CreditReservationConflictError";
    this.conflictKind = conflictKind;
  }
}

export type CreditSettlementResult = {
  /** Whole units charged (the exact cost plus the carried remainder, floored). */
  chargedCents: number;
  /** What the grants absorbed of the charge; the hold caps it. */
  appliedCents: number;
  /** Held capacity handed back unused. */
  releasedCents: number;
  /** The fraction of a unit still owed after this settlement, in lowest terms. */
  remainder: CreditAmount;
};

/**
 * One settlement's capability line (12.2): what the consumption entry shows beside the
 * money. The closed union mirrors the settlement-detail tables — the capability
 * vocabulary's member names its own table and its own facts (0179 image, 0181 speech);
 * the CHECKs on those tables are the database's half of these shapes.
 */
export type ImageSettlementLineDetail = {
  capability: "image";
  requestedCount: number;
  generatedCount: number;
  inputImages: number;
  size: string | null;
  quality: string | null;
  unitPriceUsd: string;
};

/**
 * The speech line (13.2): what was actually spoken — the characters in, the seconds out —
 * and the TWO locked tier prices the settlement priced at. `actualSeconds` is the exact
 * decimal string the settlement priced (the artifact's or usage's own statement), never a
 * float that has already been through binary rounding.
 */
export type SpeechSettlementLineDetail = {
  capability: "speech";
  inputCharacters: number;
  cappedSeconds: number;
  actualSeconds: string;
  perInputCharacterUsd: string;
  perOutputSecondUsd: string;
  voiceTier: string | null;
};

/**
 * The async job line (17.6): what the terminal report said the job consumed — the whole
 * per-dimension usage map the provider's terminal carried, priced at the basis the
 * reservation locked. The attribution anchor is the `jobId` (UNIQUE on the detail table):
 * the one key every surface and every audit of an async charge names. `capability` is the
 * job's own (the closed vocabulary async_jobs' CHECK owns) and is NOT the discriminant —
 * an async job may itself be an image or speech job; the `jobId` member is.
 */
export type AsyncSettlementLineDetail = {
  capability:
    | "chat"
    | "embedding"
    | "image"
    | "speech"
    | "transcription"
    | "rerank"
    | "ocr"
    | "realtime"
    | "video"
    | "unknown";
  jobId: string;
  providerJobId: string | null;
  entryCount: number;
  terminalState: "completed" | "failed" | "cancelled";
  actualUsage: Record<PriceDimension, number>;
};

/**
 * One item's member of a batch settlement line (18.2): the item's own attribution — its
 * identity, its model cell (items of one batch may price differently), its terminal
 * state, its real usage and its EXACT rational share of the settlement. The members of
 * one batch line must sum to the settlement's actual cost exactly (the writer asserts it
 * at write time, the write-side invariant the two-level attribution reconciles by).
 */
export type BatchSettlementItemLine = {
  itemId: string;
  customId: string;
  provider: string;
  model: string;
  capability: string;
  terminalState: "completed" | "failed" | "cancelled";
  actualUsage: Record<string, number>;
  exactCost: { numerator: bigint; denominator: bigint };
};

/**
 * The batch settlement's line (18.2): the batch-level facts plus one member per item.
 * Discriminated by its `batchId` — the one key every surface of a batch charge names.
 */
export type BatchSettlementLineDetail = {
  batchId: string;
  providerBatchId: string | null;
  itemCount: number;
  items: BatchSettlementItemLine[];
};

export type SettlementLineDetail =
  | ImageSettlementLineDetail
  | SpeechSettlementLineDetail
  | AsyncSettlementLineDetail
  | BatchSettlementLineDetail;

/**
 * One dimension's share of a settlement (20.3): the exact scaled cost the caller's pricing
 * computed for this dimension (the members of {@link computeDimensionScaledUnits}). The
 * writer validates the members sum to the settlement's `actual` exactly, then allocates
 * the row's whole units — the surcharge group rounds up, the model group carries the
 * floor, and a group's leftover units distribute over its dimensions in the vocabulary's
 * fixed order — so the stored rows sum to the ledger row's credits exactly.
 */
export type SettlementDimensionLine = {
  dimension: PriceDimension;
  numerator: bigint;
  denominator: bigint;
};

/** ceil(p/q) for non-negative rationals — the one rounding the surcharge group takes. */
function ceilRational(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The split's integer allocation (20.3): whole scaled units per dimension summing exactly
 * to `chargedUnits`. Deterministic — the same members and charge always split the same way,
 * so a re-derived split agrees with the stored one.
 */
export function allocateDimensionUnits(
  members: readonly SettlementDimensionLine[],
  chargedUnits: number,
):
  | { ok: true; rows: { dimension: PriceDimension; units: number }[] }
  | { ok: false } {
  const known = new Set<string>(PRICE_DIMENSIONS);
  let modelNumerator = 0n;
  let modelDenominator = 1n;
  let surchargeNumerator = 0n;
  let surchargeDenominator = 1n;
  const seen = new Set<string>();
  for (const member of members) {
    if (
      !known.has(member.dimension) ||
      member.numerator < 0n ||
      member.denominator <= 0n ||
      seen.has(member.dimension)
    ) {
      return { ok: false };
    }
    seen.add(member.dimension);
    // Accumulate into the group's exact rational by cross-multiplication.
    if (member.dimension.startsWith("surcharge_")) {
      surchargeNumerator =
        surchargeNumerator * member.denominator +
        member.numerator * surchargeDenominator;
      surchargeDenominator *= member.denominator;
    } else {
      modelNumerator =
        modelNumerator * member.denominator +
        member.numerator * modelDenominator;
      modelDenominator *= member.denominator;
    }
  }
  const charged = BigInt(chargedUnits);
  // The surcharge group rounds UP (fee-conservative), clipped to the row; the model group
  // carries the rest — both non-negative, their sum exactly the row.
  let surchargeUnits = ceilRational(surchargeNumerator, surchargeDenominator);
  if (surchargeUnits > charged) surchargeUnits = charged;
  const modelUnits = charged - surchargeUnits;

  // Within a group: floor per dimension, then the leftover units distribute in the
  // vocabulary's fixed order — a stable order no caller configuration can change.
  const allocate = (
    group: SettlementDimensionLine[],
    groupUnits: bigint,
  ): { dimension: PriceDimension; units: number }[] => {
    const ordered = PRICE_DIMENSIONS.map((dimension) =>
      group.find((member) => member.dimension === dimension),
    ).filter((member) => member !== undefined) as SettlementDimensionLine[];
    let assigned = 0n;
    const rows = ordered.map((member) => {
      const floor = member.numerator / member.denominator;
      assigned += floor;
      return { dimension: member.dimension, units: Number(floor) };
    });
    let leftover = Number(groupUnits - assigned);
    if (leftover > 0) {
      if (rows.length === 0) return []; // units with no members to place: the caller's defect
      // One unit per dimension in the vocabulary's fixed order, wrapping — bounded by
      // construction (leftover ≤ the member count), fenced so a defect is loud, not a hang.
      let i = 0;
      while (leftover > 0) {
        rows[i % rows.length].units += 1;
        leftover -= 1;
        i += 1;
        if (i > rows.length + leftover + 1) return [];
      }
    }
    return rows;
  };

  const modelGroup = members.filter(
    (m) => !m.dimension.startsWith("surcharge_"),
  );
  const surchargeGroup = members.filter((m) =>
    m.dimension.startsWith("surcharge_"),
  );
  const rows = [
    ...allocate(modelGroup, modelUnits),
    ...allocate(surchargeGroup, surchargeUnits),
  ];
  const total = rows.reduce((sum, row) => sum + row.units, 0);
  if (total !== chargedUnits) return { ok: false };
  return { ok: true, rows };
}

/**
 * One dimension's share of a settlement (20.3): the exact scaled cost the caller's pricing
 * computed for this dimension (the members of {@link computeDimensionScaledUnits}). The
 * writer validates the members sum to the settlement's `actual` exactly, then allocates
 * the row's whole units — the surcharge group rounds up, the model group carries the
 * floor, and a group's leftover units distribute over its dimensions in the vocabulary's
 * fixed order — so the stored rows sum to the ledger row's credits exactly.
 */
export type SettlementDimensionLine = {
  dimension: PriceDimension;
  numerator: bigint;
  denominator: bigint;
};

/** ceil(p/q) for non-negative rationals — the one rounding the surcharge group takes. */
function ceilRational(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The split's integer allocation (20.3): whole scaled units per dimension summing exactly
 * to `chargedUnits`. Deterministic — the same members and charge always split the same way,
 * so a re-derived split agrees with the stored one.
 */
export function allocateDimensionUnits(
  members: readonly SettlementDimensionLine[],
  chargedUnits: number,
): { ok: true; rows: { dimension: PriceDimension; units: number }[] } | { ok: false } {
  const known = new Set<string>(PRICE_DIMENSIONS);
  let modelNumerator = 0n;
  let modelDenominator = 1n;
  let surchargeNumerator = 0n;
  let surchargeDenominator = 1n;
  const seen = new Set<string>();
  for (const member of members) {
    if (
      !known.has(member.dimension) ||
      member.numerator < 0n ||
      member.denominator <= 0n ||
      seen.has(member.dimension)
    ) {
      return { ok: false };
    }
    seen.add(member.dimension);
    // Accumulate into the group's exact rational by cross-multiplication.
    if (member.dimension.startsWith("surcharge_")) {
      surchargeNumerator =
        surchargeNumerator * member.denominator +
        member.numerator * surchargeDenominator;
      surchargeDenominator *= member.denominator;
    } else {
      modelNumerator =
        modelNumerator * member.denominator +
        member.numerator * modelDenominator;
      modelDenominator *= member.denominator;
    }
  }
  const charged = BigInt(chargedUnits);
  // The surcharge group rounds UP (fee-conservative), clipped to the row; the model group
  // carries the rest — both non-negative, their sum exactly the row.
  let surchargeUnits = ceilRational(surchargeNumerator, surchargeDenominator);
  if (surchargeUnits > charged) surchargeUnits = charged;
  const modelUnits = charged - surchargeUnits;

  // Within a group: floor per dimension, then the leftover units distribute in the
  // vocabulary's fixed order — a stable order no caller configuration can change.
  const allocate = (
    group: SettlementDimensionLine[],
    groupUnits: bigint,
  ): { dimension: PriceDimension; units: number }[] => {
    const ordered = PRICE_DIMENSIONS.map((dimension) =>
      group.find((member) => member.dimension === dimension),
    ).filter((member) => member !== undefined) as SettlementDimensionLine[];
    let assigned = 0n;
    const rows = ordered.map((member) => {
      const floor = member.numerator / member.denominator;
      assigned += floor;
      return { dimension: member.dimension, units: Number(floor) };
    });
    let leftover = Number(groupUnits - assigned);
    if (leftover > 0) {
      if (rows.length === 0) return []; // units with no members to place: the caller's defect
      // One unit per dimension in the vocabulary's fixed order, wrapping — bounded by
      // construction (leftover ≤ the member count), fenced so a defect is loud, not a hang.
      let i = 0;
      while (leftover > 0) {
        rows[i % rows.length].units += 1;
        leftover -= 1;
        i += 1;
        if (i > rows.length + leftover + 1) return [];
      }
    }
    return rows;
  };

  const modelGroup = members.filter((m) => !m.dimension.startsWith("surcharge_"));
  const surchargeGroup = members.filter((m) =>
    m.dimension.startsWith("surcharge_"),
  );
  const rows = [
    ...allocate(modelGroup, modelUnits),
    ...allocate(surchargeGroup, surchargeUnits),
  ];
  const total = rows.reduce((sum, row) => sum + row.units, 0);
  if (total !== chargedUnits) return { ok: false };
  return { ok: true, rows };
}

/**
 * One dimension's share of a settlement (20.3): the exact scaled cost the caller's pricing
 * computed for this dimension (the members of {@link computeDimensionScaledUnits}). The
 * writer validates the members sum to the settlement's `actual` exactly, then allocates
 * the row's whole units — the surcharge group rounds up, the model group carries the
 * floor, and a group's leftover units distribute over its dimensions in the vocabulary's
 * fixed order — so the stored rows sum to the ledger row's credits exactly.
 */
export type SettlementDimensionLine = {
  dimension: PriceDimension;
  numerator: bigint;
  denominator: bigint;
};

/** ceil(p/q) for non-negative rationals — the one rounding the surcharge group takes. */
function ceilRational(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The split's integer allocation (20.3): whole scaled units per dimension summing exactly
 * to `chargedUnits`. Deterministic — the same members and charge always split the same way,
 * so a re-derived split agrees with the stored one.
 */
export function allocateDimensionUnits(
  members: readonly SettlementDimensionLine[],
  chargedUnits: number,
): { ok: true; rows: { dimension: PriceDimension; units: number }[] } | { ok: false } {
  const known = new Set<string>(PRICE_DIMENSIONS);
  let modelNumerator = 0n;
  let modelDenominator = 1n;
  let surchargeNumerator = 0n;
  let surchargeDenominator = 1n;
  const seen = new Set<string>();
  for (const member of members) {
    if (
      !known.has(member.dimension) ||
      member.numerator < 0n ||
      member.denominator <= 0n ||
      seen.has(member.dimension)
    ) {
      return { ok: false };
    }
    seen.add(member.dimension);
    // Accumulate into the group's exact rational by cross-multiplication.
    if (member.dimension.startsWith("surcharge_")) {
      surchargeNumerator =
        surchargeNumerator * member.denominator +
        member.numerator * surchargeDenominator;
      surchargeDenominator *= member.denominator;
    } else {
      modelNumerator =
        modelNumerator * member.denominator +
        member.numerator * modelDenominator;
      modelDenominator *= member.denominator;
    }
  }
  const charged = BigInt(chargedUnits);
  // The surcharge group rounds UP (fee-conservative), clipped to the row; the model group
  // carries the rest — both non-negative, their sum exactly the row.
  let surchargeUnits = ceilRational(surchargeNumerator, surchargeDenominator);
  if (surchargeUnits > charged) surchargeUnits = charged;
  const modelUnits = charged - surchargeUnits;

  // Within a group: floor per dimension, then the leftover units distribute in the
  // vocabulary's fixed order — a stable order no caller configuration can change.
  const allocate = (
    group: SettlementDimensionLine[],
    groupUnits: bigint,
  ): { dimension: PriceDimension; units: number }[] => {
    const ordered = PRICE_DIMENSIONS.map((dimension) =>
      group.find((member) => member.dimension === dimension),
    ).filter((member) => member !== undefined) as SettlementDimensionLine[];
    let assigned = 0n;
    const rows = ordered.map((member) => {
      const floor = member.numerator / member.denominator;
      assigned += floor;
      return { dimension: member.dimension, units: Number(floor) };
    });
    let leftover = Number(groupUnits - assigned);
    if (leftover > 0) {
      if (rows.length === 0) return []; // units with no members to place: the caller's defect
      // One unit per dimension in the vocabulary's fixed order, wrapping — bounded by
      // construction (leftover ≤ the member count), fenced so a defect is loud, not a hang.
      let i = 0;
      while (leftover > 0) {
        rows[i % rows.length].units += 1;
        leftover -= 1;
        i += 1;
        if (i > rows.length + leftover + 1) return [];
      }
    }
    return rows;
  };

  const modelGroup = members.filter((m) => !m.dimension.startsWith("surcharge_"));
  const surchargeGroup = members.filter((m) =>
    m.dimension.startsWith("surcharge_"),
  );
  const rows = [
    ...allocate(modelGroup, modelUnits),
    ...allocate(surchargeGroup, surchargeUnits),
  ];
  const total = rows.reduce((sum, row) => sum + row.units, 0);
  if (total !== chargedUnits) return { ok: false };
  return { ok: true, rows };
}

/**
 * One dimension's share of a settlement (20.3): the exact scaled cost the caller's pricing
 * computed for this dimension (the members of {@link computeDimensionScaledUnits}). The
 * writer validates the members sum to the settlement's `actual` exactly, then allocates
 * the row's whole units — the surcharge group rounds up, the model group carries the
 * floor, and a group's leftover units distribute over its dimensions in the vocabulary's
 * fixed order — so the stored rows sum to the ledger row's credits exactly.
 */
export type SettlementDimensionLine = {
  dimension: PriceDimension;
  numerator: bigint;
  denominator: bigint;
};

/** ceil(p/q) for non-negative rationals — the one rounding the surcharge group takes. */
function ceilRational(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The split's integer allocation (20.3): whole scaled units per dimension summing exactly
 * to `chargedUnits`. Deterministic — the same members and charge always split the same way,
 * so a re-derived split agrees with the stored one.
 */
export function allocateDimensionUnits(
  members: readonly SettlementDimensionLine[],
  chargedUnits: number,
): { ok: true; rows: { dimension: PriceDimension; units: number }[] } | { ok: false } {
  const known = new Set<string>(PRICE_DIMENSIONS);
  let modelNumerator = 0n;
  let modelDenominator = 1n;
  let surchargeNumerator = 0n;
  let surchargeDenominator = 1n;
  const seen = new Set<string>();
  for (const member of members) {
    if (
      !known.has(member.dimension) ||
      member.numerator < 0n ||
      member.denominator <= 0n ||
      seen.has(member.dimension)
    ) {
      return { ok: false };
    }
    seen.add(member.dimension);
    // Accumulate into the group's exact rational by cross-multiplication.
    if (member.dimension.startsWith("surcharge_")) {
      surchargeNumerator =
        surchargeNumerator * member.denominator +
        member.numerator * surchargeDenominator;
      surchargeDenominator *= member.denominator;
    } else {
      modelNumerator =
        modelNumerator * member.denominator +
        member.numerator * modelDenominator;
      modelDenominator *= member.denominator;
    }
  }
  const charged = BigInt(chargedUnits);
  // The surcharge group rounds UP (fee-conservative), clipped to the row; the model group
  // carries the rest — both non-negative, their sum exactly the row.
  let surchargeUnits = ceilRational(surchargeNumerator, surchargeDenominator);
  if (surchargeUnits > charged) surchargeUnits = charged;
  const modelUnits = charged - surchargeUnits;

  // Within a group: floor per dimension, then the leftover units distribute in the
  // vocabulary's fixed order — a stable order no caller configuration can change.
  const allocate = (
    group: SettlementDimensionLine[],
    groupUnits: bigint,
  ): { dimension: PriceDimension; units: number }[] => {
    const ordered = PRICE_DIMENSIONS.map((dimension) =>
      group.find((member) => member.dimension === dimension),
    ).filter((member) => member !== undefined) as SettlementDimensionLine[];
    let assigned = 0n;
    const rows = ordered.map((member) => {
      const floor = member.numerator / member.denominator;
      assigned += floor;
      return { dimension: member.dimension, units: Number(floor) };
    });
    let leftover = Number(groupUnits - assigned);
    if (leftover > 0) {
      if (rows.length === 0) return []; // units with no members to place: the caller's defect
      // One unit per dimension in the vocabulary's fixed order, wrapping — bounded by
      // construction (leftover ≤ the member count), fenced so a defect is loud, not a hang.
      let i = 0;
      while (leftover > 0) {
        rows[i % rows.length].units += 1;
        leftover -= 1;
        i += 1;
        if (i > rows.length + leftover + 1) return [];
      }
    }
    return rows;
  };

  const modelGroup = members.filter((m) => !m.dimension.startsWith("surcharge_"));
  const surchargeGroup = members.filter((m) =>
    m.dimension.startsWith("surcharge_"),
  );
  const rows = [
    ...allocate(modelGroup, modelUnits),
    ...allocate(surchargeGroup, surchargeUnits),
  ];
  const total = rows.reduce((sum, row) => sum + row.units, 0);
  if (total !== chargedUnits) return { ok: false };
  return { ok: true, rows };
}

/**
 * One dimension's share of a settlement (20.3): the exact scaled cost the caller's pricing
 * computed for this dimension (the members of {@link computeDimensionScaledUnits}). The
 * writer validates the members sum to the settlement's `actual` exactly, then allocates
 * the row's whole units — the surcharge group rounds up, the model group carries the
 * floor, and a group's leftover units distribute over its dimensions in the vocabulary's
 * fixed order — so the stored rows sum to the ledger row's credits exactly.
 */
export type SettlementDimensionLine = {
  dimension: PriceDimension;
  numerator: bigint;
  denominator: bigint;
};

/** ceil(p/q) for non-negative rationals — the one rounding the surcharge group takes. */
function ceilRational(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The split's integer allocation (20.3): whole scaled units per dimension summing exactly
 * to `chargedUnits`. Deterministic — the same members and charge always split the same way,
 * so a re-derived split agrees with the stored one.
 */
export function allocateDimensionUnits(
  members: readonly SettlementDimensionLine[],
  chargedUnits: number,
): { ok: true; rows: { dimension: PriceDimension; units: number }[] } | { ok: false } {
  const known = new Set<string>(PRICE_DIMENSIONS);
  let modelNumerator = 0n;
  let modelDenominator = 1n;
  let surchargeNumerator = 0n;
  let surchargeDenominator = 1n;
  const seen = new Set<string>();
  for (const member of members) {
    if (
      !known.has(member.dimension) ||
      member.numerator < 0n ||
      member.denominator <= 0n ||
      seen.has(member.dimension)
    ) {
      return { ok: false };
    }
    seen.add(member.dimension);
    // Accumulate into the group's exact rational by cross-multiplication.
    if (member.dimension.startsWith("surcharge_")) {
      surchargeNumerator =
        surchargeNumerator * member.denominator +
        member.numerator * surchargeDenominator;
      surchargeDenominator *= member.denominator;
    } else {
      modelNumerator =
        modelNumerator * member.denominator +
        member.numerator * modelDenominator;
      modelDenominator *= member.denominator;
    }
  }
  const charged = BigInt(chargedUnits);
  // The surcharge group rounds UP (fee-conservative), clipped to the row; the model group
  // carries the rest — both non-negative, their sum exactly the row.
  let surchargeUnits = ceilRational(surchargeNumerator, surchargeDenominator);
  if (surchargeUnits > charged) surchargeUnits = charged;
  const modelUnits = charged - surchargeUnits;

  // Within a group: floor per dimension, then the leftover units distribute in the
  // vocabulary's fixed order — a stable order no caller configuration can change.
  const allocate = (
    group: SettlementDimensionLine[],
    groupUnits: bigint,
  ): { dimension: PriceDimension; units: number }[] => {
    const ordered = PRICE_DIMENSIONS.map((dimension) =>
      group.find((member) => member.dimension === dimension),
    ).filter((member) => member !== undefined) as SettlementDimensionLine[];
    let assigned = 0n;
    const rows = ordered.map((member) => {
      const floor = member.numerator / member.denominator;
      assigned += floor;
      return { dimension: member.dimension, units: Number(floor) };
    });
    let leftover = Number(groupUnits - assigned);
    if (leftover > 0) {
      if (rows.length === 0) return []; // units with no members to place: the caller's defect
      // One unit per dimension in the vocabulary's fixed order, wrapping — bounded by
      // construction (leftover ≤ the member count), fenced so a defect is loud, not a hang.
      let i = 0;
      while (leftover > 0) {
        rows[i % rows.length].units += 1;
        leftover -= 1;
        i += 1;
        if (i > rows.length + leftover + 1) return [];
      }
    }
    return rows;
  };

  const modelGroup = members.filter((m) => !m.dimension.startsWith("surcharge_"));
  const surchargeGroup = members.filter((m) =>
    m.dimension.startsWith("surcharge_"),
  );
  const rows = [
    ...allocate(modelGroup, modelUnits),
    ...allocate(surchargeGroup, surchargeUnits),
  ];
  const total = rows.reduce((sum, row) => sum + row.units, 0);
  if (total !== chargedUnits) return { ok: false };
  return { ok: true, rows };
}

/**
 * One dimension's share of a settlement (20.3): the exact scaled cost the caller's pricing
 * computed for this dimension (the members of {@link computeDimensionScaledUnits}). The
 * writer validates the members sum to the settlement's `actual` exactly, then allocates
 * the row's whole units — the surcharge group rounds up, the model group carries the
 * floor, and a group's leftover units distribute over its dimensions in the vocabulary's
 * fixed order — so the stored rows sum to the ledger row's credits exactly.
 */
export type SettlementDimensionLine = {
  dimension: PriceDimension;
  numerator: bigint;
  denominator: bigint;
};

/** ceil(p/q) for non-negative rationals — the one rounding the surcharge group takes. */
function ceilRational(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The split's integer allocation (20.3): whole scaled units per dimension summing exactly
 * to `chargedUnits`. Deterministic — the same members and charge always split the same way,
 * so a re-derived split agrees with the stored one.
 */
export function allocateDimensionUnits(
  members: readonly SettlementDimensionLine[],
  chargedUnits: number,
): { ok: true; rows: { dimension: PriceDimension; units: number }[] } | { ok: false } {
  const known = new Set<string>(PRICE_DIMENSIONS);
  let modelNumerator = 0n;
  let modelDenominator = 1n;
  let surchargeNumerator = 0n;
  let surchargeDenominator = 1n;
  const seen = new Set<string>();
  for (const member of members) {
    if (
      !known.has(member.dimension) ||
      member.numerator < 0n ||
      member.denominator <= 0n ||
      seen.has(member.dimension)
    ) {
      return { ok: false };
    }
    seen.add(member.dimension);
    // Accumulate into the group's exact rational by cross-multiplication.
    if (member.dimension.startsWith("surcharge_")) {
      surchargeNumerator =
        surchargeNumerator * member.denominator +
        member.numerator * surchargeDenominator;
      surchargeDenominator *= member.denominator;
    } else {
      modelNumerator =
        modelNumerator * member.denominator +
        member.numerator * modelDenominator;
      modelDenominator *= member.denominator;
    }
  }
  const charged = BigInt(chargedUnits);
  // The surcharge group rounds UP (fee-conservative), clipped to the row; the model group
  // carries the rest — both non-negative, their sum exactly the row.
  let surchargeUnits = ceilRational(surchargeNumerator, surchargeDenominator);
  if (surchargeUnits > charged) surchargeUnits = charged;
  const modelUnits = charged - surchargeUnits;

  // Within a group: floor per dimension, then the leftover units distribute in the
  // vocabulary's fixed order — a stable order no caller configuration can change.
  const allocate = (
    group: SettlementDimensionLine[],
    groupUnits: bigint,
  ): { dimension: PriceDimension; units: number }[] => {
    const ordered = PRICE_DIMENSIONS.map((dimension) =>
      group.find((member) => member.dimension === dimension),
    ).filter((member) => member !== undefined) as SettlementDimensionLine[];
    let assigned = 0n;
    const rows = ordered.map((member) => {
      const floor = member.numerator / member.denominator;
      assigned += floor;
      return { dimension: member.dimension, units: Number(floor) };
    });
    let leftover = Number(groupUnits - assigned);
    if (leftover > 0) {
      if (rows.length === 0) return []; // units with no members to place: the caller's defect
      // One unit per dimension in the vocabulary's fixed order, wrapping — bounded by
      // construction (leftover ≤ the member count), fenced so a defect is loud, not a hang.
      let i = 0;
      while (leftover > 0) {
        rows[i % rows.length].units += 1;
        leftover -= 1;
        i += 1;
        if (i > rows.length + leftover + 1) return [];
      }
    }
    return rows;
  };

  const modelGroup = members.filter((m) => !m.dimension.startsWith("surcharge_"));
  const surchargeGroup = members.filter((m) =>
    m.dimension.startsWith("surcharge_"),
  );
  const rows = [
    ...allocate(modelGroup, modelUnits),
    ...allocate(surchargeGroup, surchargeUnits),
  ];
  const total = rows.reduce((sum, row) => sum + row.units, 0);
  if (total !== chargedUnits) return { ok: false };
  return { ok: true, rows };
}

/**
 * One dimension's share of a settlement (20.3): the exact scaled cost the caller's pricing
 * computed for this dimension (the members of {@link computeDimensionScaledUnits}). The
 * writer validates the members sum to the settlement's `actual` exactly, then allocates
 * the row's whole units — the surcharge group rounds up, the model group carries the
 * floor, and a group's leftover units distribute over its dimensions in the vocabulary's
 * fixed order — so the stored rows sum to the ledger row's credits exactly.
 */
export type SettlementDimensionLine = {
  dimension: PriceDimension;
  numerator: bigint;
  denominator: bigint;
};

/** ceil(p/q) for non-negative rationals — the one rounding the surcharge group takes. */
function ceilRational(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The split's integer allocation (20.3): whole scaled units per dimension summing exactly
 * to `chargedUnits`. Deterministic — the same members and charge always split the same way,
 * so a re-derived split agrees with the stored one.
 */
export function allocateDimensionUnits(
  members: readonly SettlementDimensionLine[],
  chargedUnits: number,
): { ok: true; rows: { dimension: PriceDimension; units: number }[] } | { ok: false } {
  const known = new Set<string>(PRICE_DIMENSIONS);
  let modelNumerator = 0n;
  let modelDenominator = 1n;
  let surchargeNumerator = 0n;
  let surchargeDenominator = 1n;
  const seen = new Set<string>();
  for (const member of members) {
    if (
      !known.has(member.dimension) ||
      member.numerator < 0n ||
      member.denominator <= 0n ||
      seen.has(member.dimension)
    ) {
      return { ok: false };
    }
    seen.add(member.dimension);
    // Accumulate into the group's exact rational by cross-multiplication.
    if (member.dimension.startsWith("surcharge_")) {
      surchargeNumerator =
        surchargeNumerator * member.denominator +
        member.numerator * surchargeDenominator;
      surchargeDenominator *= member.denominator;
    } else {
      modelNumerator =
        modelNumerator * member.denominator +
        member.numerator * modelDenominator;
      modelDenominator *= member.denominator;
    }
  }
  const charged = BigInt(chargedUnits);
  // The surcharge group rounds UP (fee-conservative), clipped to the row; the model group
  // carries the rest — both non-negative, their sum exactly the row.
  let surchargeUnits = ceilRational(surchargeNumerator, surchargeDenominator);
  if (surchargeUnits > charged) surchargeUnits = charged;
  const modelUnits = charged - surchargeUnits;

  // Within a group: floor per dimension, then the leftover units distribute in the
  // vocabulary's fixed order — a stable order no caller configuration can change.
  const allocate = (
    group: SettlementDimensionLine[],
    groupUnits: bigint,
  ): { dimension: PriceDimension; units: number }[] => {
    const ordered = PRICE_DIMENSIONS.map((dimension) =>
      group.find((member) => member.dimension === dimension),
    ).filter((member) => member !== undefined) as SettlementDimensionLine[];
    let assigned = 0n;
    const rows = ordered.map((member) => {
      const floor = member.numerator / member.denominator;
      assigned += floor;
      return { dimension: member.dimension, units: Number(floor) };
    });
    let leftover = Number(groupUnits - assigned);
    if (leftover > 0) {
      if (rows.length === 0) return []; // units with no members to place: the caller's defect
      // One unit per dimension in the vocabulary's fixed order, wrapping — bounded by
      // construction (leftover ≤ the member count), fenced so a defect is loud, not a hang.
      let i = 0;
      while (leftover > 0) {
        rows[i % rows.length].units += 1;
        leftover -= 1;
        i += 1;
        if (i > rows.length + leftover + 1) return [];
      }
    }
    return rows;
  };

  const modelGroup = members.filter((m) => !m.dimension.startsWith("surcharge_"));
  const surchargeGroup = members.filter((m) =>
    m.dimension.startsWith("surcharge_"),
  );
  const rows = [
    ...allocate(modelGroup, modelUnits),
    ...allocate(surchargeGroup, surchargeUnits),
  ];
  const total = rows.reduce((sum, row) => sum + row.units, 0);
  if (total !== chargedUnits) return { ok: false };
  return { ok: true, rows };
}

/**
 * One dimension's share of a settlement (20.3): the exact scaled cost the caller's pricing
 * computed for this dimension (the members of {@link computeDimensionScaledUnits}). The
 * writer validates the members sum to the settlement's `actual` exactly, then allocates
 * the row's whole units — the surcharge group rounds up, the model group carries the
 * floor, and a group's leftover units distribute over its dimensions in the vocabulary's
 * fixed order — so the stored rows sum to the ledger row's credits exactly.
 */
export type SettlementDimensionLine = {
  dimension: PriceDimension;
  numerator: bigint;
  denominator: bigint;
};

/** ceil(p/q) for non-negative rationals — the one rounding the surcharge group takes. */
function ceilRational(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The split's integer allocation (20.3): whole scaled units per dimension summing exactly
 * to `chargedUnits`. Deterministic — the same members and charge always split the same way,
 * so a re-derived split agrees with the stored one.
 */
export function allocateDimensionUnits(
  members: readonly SettlementDimensionLine[],
  chargedUnits: number,
): { ok: true; rows: { dimension: PriceDimension; units: number }[] } | { ok: false } {
  const known = new Set<string>(PRICE_DIMENSIONS);
  let modelNumerator = 0n;
  let modelDenominator = 1n;
  let surchargeNumerator = 0n;
  let surchargeDenominator = 1n;
  const seen = new Set<string>();
  for (const member of members) {
    if (
      !known.has(member.dimension) ||
      member.numerator < 0n ||
      member.denominator <= 0n ||
      seen.has(member.dimension)
    ) {
      return { ok: false };
    }
    seen.add(member.dimension);
    // Accumulate into the group's exact rational by cross-multiplication.
    if (member.dimension.startsWith("surcharge_")) {
      surchargeNumerator =
        surchargeNumerator * member.denominator +
        member.numerator * surchargeDenominator;
      surchargeDenominator *= member.denominator;
    } else {
      modelNumerator =
        modelNumerator * member.denominator +
        member.numerator * modelDenominator;
      modelDenominator *= member.denominator;
    }
  }
  const charged = BigInt(chargedUnits);
  // The surcharge group rounds UP (fee-conservative), clipped to the row; the model group
  // carries the rest — both non-negative, their sum exactly the row.
  let surchargeUnits = ceilRational(surchargeNumerator, surchargeDenominator);
  if (surchargeUnits > charged) surchargeUnits = charged;
  const modelUnits = charged - surchargeUnits;

  // Within a group: floor per dimension, then the leftover units distribute in the
  // vocabulary's fixed order — a stable order no caller configuration can change.
  const allocate = (
    group: SettlementDimensionLine[],
    groupUnits: bigint,
  ): { dimension: PriceDimension; units: number }[] => {
    const ordered = PRICE_DIMENSIONS.map((dimension) =>
      group.find((member) => member.dimension === dimension),
    ).filter((member) => member !== undefined) as SettlementDimensionLine[];
    let assigned = 0n;
    const rows = ordered.map((member) => {
      const floor = member.numerator / member.denominator;
      assigned += floor;
      return { dimension: member.dimension, units: Number(floor) };
    });
    let leftover = Number(groupUnits - assigned);
    if (leftover > 0) {
      if (rows.length === 0) return []; // units with no members to place: the caller's defect
      // One unit per dimension in the vocabulary's fixed order, wrapping — bounded by
      // construction (leftover ≤ the member count), fenced so a defect is loud, not a hang.
      let i = 0;
      while (leftover > 0) {
        rows[i % rows.length].units += 1;
        leftover -= 1;
        i += 1;
        if (i > rows.length + leftover + 1) return [];
      }
    }
    return rows;
  };

  const modelGroup = members.filter((m) => !m.dimension.startsWith("surcharge_"));
  const surchargeGroup = members.filter((m) =>
    m.dimension.startsWith("surcharge_"),
  );
  const rows = [
    ...allocate(modelGroup, modelUnits),
    ...allocate(surchargeGroup, surchargeUnits),
  ];
  const total = rows.reduce((sum, row) => sum + row.units, 0);
  if (total !== chargedUnits) return { ok: false };
  return { ok: true, rows };
}

export type CreditWriter = {
  /**
   * Record one deposit. `totalCents` is scaled credit units (×100) already — the caller derived
   * it from the catalog's whole-credit number times `CREDIT_SCALE`; integers end to end.
   *
   * `inserted: false` means a grant with the same `idempotencyKey` already exists — the retry
   * answer, not an error — and carries the existing row so the caller (and its audit trail) can
   * say which one it was.
   */
  grantCredits(input: {
    externalCustomerId: string;
    source: CreditGrantSource;
    /** Scaled units (×100). Must be a whole, non-negative integer. */
    totalCents: number;
    expiresAt: Date;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<{ inserted: boolean; grant: CreditGrantResult }>;

  /**
   * The capacity a new hold could take now: live grant capacity minus every active hold, and one
   * unit while a fractional remainder is owed (the owed fraction keeps counting against capacity).
   */
  availableBalance(externalCustomerId: string): Promise<number>;

  /**
   * Hold `maximumCents` (scaled units, a positive 32-bit integer) across the customer's live
   * grants, earliest expiry first, atomically with respect to every other hold and settlement of
   * the customer. A replay of `idempotencyKey` answers the original reservation; a replay with a
   * different customer or amount throws `CreditReservationConflictError`. A refused hold writes
   * nothing and reports what was available. When `lockedBasis` is given (the credit protocol's
   * reserve path, 06.5), it is persisted with the hold: the pricing basis — cell plus
   * snapshotVersion plus rateVersion — the admission priced, for settlement to resolve exactly.
   */
  reserveCredits(input: {
    externalCustomerId: string;
    idempotencyKey: string;
    maximumCents: number;
    expiresAt: Date;
    lockedBasis?: ReservationLockedBasis;
  }): Promise<
    | { reserved: true; reservationId: string }
    | { reserved: false; availableCents: number }
  >;
  /*
   * Replay semantics: a replay of `idempotencyKey` answers the original reservation only
   * while it is still `reserved`; a replay against a settled or released hold — or with a
   * different customer or amount — throws `CreditReservationConflictError`, because a
   * terminal hold carries no capacity and must never admit work.
   */

  /**
   * Convert a hold into a charge. `actual` is the exact rational cost in scaled units; the
   * customer's carried remainder is added, the whole-unit floor is drawn from the held grants
   * (written once to `credit_ledger`), and the new fraction is persisted. Unused hold is
   * released. Replaying the same actual returns the first result; a different actual, or settling
   * a released hold, throws `CreditReservationConflictError`. Cost above the hold is recorded in
   * the ledger in full but only the held capacity is applied. An `unknown` hold settles too —
   * that IS recovery's settlement (06.8/AC15): the same reservation, the same attempt id, and
   * the entry evidence stays on the row as history.
   */
  settleReservation(input: {
    reservationId: string;
    actual: CreditAmount;
    title: string;
    requestId?: string | null;
    model?: string | null;
    client?: string | null;
    /**
     * The settlement's line detail (12.2): the capability-shaped facts of what was
     * consumed, written in THIS settlement's transaction beside the ledger row — the
     * money, the terminal update and the detail land as one commit. Optional: the
     * generic protocol settlement (06.9) carries none, and only a capability settlement
     * path that can name its line's spec, actual count and locked unit price passes one.
     */
    lineDetail?: SettlementLineDetail;
    /**
     * The settlement's per-dimension split (20.3): each used billing dimension's exact
     * scaled cost, written in THIS settlement's transaction as integer shares of the ledger
     * row — the rows always sum to exactly the row (the write-time invariant), so the
     * consumption view's model/surcharge attribution reconciles with the ledger by
     * construction. Optional: a settlement that cannot name its dimensions writes no split,
     * and the view answers no split for it (never a misleading zero). The exact members
     * must sum to `actual` exactly — a split that names a different total is a defect.
     */
    dimensionBreakdown?: SettlementDimensionLine[];
  }): Promise<CreditSettlementResult>;

  /**
   * Hand a still-`reserved` hold back, unused. Idempotent: releasing a released or settled hold
   * changes nothing (the first terminal result stands). An `unknown` hold is REFUSED: its
   * provider outcome never arrived, so a release is never ordinary — only 08.x's recovery flow
   * or an evidenced admin disposal may move it, through `releaseUnknownReservation`.
   */
  releaseReservation(reservationId: string, reason: string): Promise<void>;

  /**
   * The recovery-only release (06.8): move a result-unconfirmed (`unknown`) hold to `released`
   * once evidence says no cost was produced (08.x's recovery flow, or an evidenced admin
   * disposal). A still-`reserved` hold refuses — this door is never a second ordinary release —
   * and a terminal hold changes nothing (the first terminal result stands). `reason` names the
   * evidence the disposal stands on; the row keeps its `unknownAt`/`unknownReason` history.
   */
  releaseUnknownReservation(
    reservationId: string,
    reason: string,
  ): Promise<void>;

  /**
   * The platform-loss compensation door (Bifrost 08.10): the platform absorbs an `unknown`
   * hold whose cost could not be settled NOR proven absent, handing the held capacity back
   * so the user does not pay for work nobody can price — but the act is NOT a release and
   * never says "no charge": the release reason carries the `platform_compensation:<ref>`
   * marker, the item's own disposal record carries `compensate`, and the command writes the
   * `billing.recovery.compensated` audit event with the absorbed amount. A still-`reserved`
   * hold refuses (this is never a second ordinary release), and a terminal hold changes
   * nothing (the first terminal result stands). The payment account is the reservation's
   * own — compensation moves capacity, never ownership.
   */
  compensateUnknownReservation(
    reservationId: string,
    reason: string,
  ): Promise<void>;

  /**
   * Record that a hold's provider outcome is unknown (06.8, Q12/AC15): a stream error, a
   * missing usage report, a cancellation — anything that is NOT a confirmed no-cost. The hold
   * leaves the plain `reserved` state for `unknown`, keeping its FULL capacity occupied no
   * matter how far the clock advances past `expiresAt`, with the reason and instant recorded
   * for 08.x's recovery. Idempotent: the first reason and instant stand; a hold already
   * settled or released changes nothing (a terminal fact is never reopened).
   */
  markReservationUnknown(reservationId: string, reason: string): Promise<void>;
};

export function createCreditWriter(database: Database): CreditWriter {
  return {
    async grantCredits(input) {
      // Integer discipline enforced at the seam: a fractional or negative amount is a caller's
      // bug, and storing it rounded would silently corrupt the ledger it lands in. The upper
      // bound is the column's: an amount the 32-bit ledger cannot hold is refused here, before
      // the insert strands a paid activation in a permanent retry (audit A6).
      if (
        !Number.isInteger(input.totalCents) ||
        input.totalCents < 0 ||
        input.totalCents > MAX_STORED_UNITS ||
        !Number.isFinite(input.expiresAt.getTime())
      ) {
        throw new TypeError(
          "grantCredits needs a whole non-negative scaled amount that fits the 32-bit credit column, and a real expiry.",
        );
      }

      // The customer floor, the same insert-if-absent the billing store lays under a subscription:
      // a payment activation can be the first thing that ever names this deployment's customer
      // key locally, and the grant's foreign key must not be the thing that discovers that.
      await database
        .insert(billingCustomers)
        .values({ externalId: input.externalCustomerId, name: null })
        .onConflictDoNothing({ target: billingCustomers.externalId });

      // No natural key → a random one: two admin presses are two grants (a decision), and the
      // column stays NOT NULL so the unique index stays inferable by ON CONFLICT.
      const idempotencyKey =
        input.idempotencyKey ?? `auto:${randomBytes(12).toString("hex")}`;

      const rows = await database
        .insert(creditGrants)
        .values({
          id: generateGrantId(),
          externalCustomerId: input.externalCustomerId,
          source: input.source,
          reason: input.reason ?? null,
          total: input.totalCents,
          used: 0,
          expiresAt: input.expiresAt,
          status: "active",
          idempotencyKey,
        })
        .onConflictDoNothing({
          target: creditGrants.idempotencyKey,
        })
        .returning();

      const row = rows[0];
      if (row) return { inserted: true, grant: resultOf(row) };

      // The occurrence already exists. Re-read by the key — the same committed-state answer the
      // paid-fact replay gets in the payment store, never a read that can race with itself.
      const [existing] = await database
        .select()
        .from(creditGrants)
        .where(eq(creditGrants.idempotencyKey, idempotencyKey))
        .limit(1);
      // A conflict with no findable row means the key raced a concurrent insert of a DIFFERENT
      // grant — impossible under the index, but a missing row here would be a silent no-op, so
      // say it loudly instead.
      if (!existing) {
        throw new TypeError(
          "grantCredits: the idempotency key conflicted but no existing grant was found.",
        );
      }
      return { inserted: false, grant: resultOf(existing) };
    },

    async availableBalance(externalCustomerId) {
      return (await readCapacity(database, externalCustomerId)).spendableUnits;
    },

    async reserveCredits(input) {
      if (
        !Number.isInteger(input.maximumCents) ||
        input.maximumCents <= 0 ||
        input.maximumCents > MAX_STORED_UNITS ||
        !Number.isFinite(input.expiresAt.getTime()) ||
        input.expiresAt.getTime() <= Date.now() ||
        input.idempotencyKey.length === 0
      ) {
        throw new TypeError(
          "reserveCredits needs a positive 32-bit scaled amount, a future expiry and a key.",
        );
      }
      const basis = input.lockedBasis;
      if (
        basis !== undefined &&
        (typeof basis.provider !== "string" ||
          basis.provider.length === 0 ||
          typeof basis.model !== "string" ||
          basis.model.length === 0 ||
          typeof basis.capability !== "string" ||
          basis.capability.length === 0 ||
          !Number.isSafeInteger(basis.snapshotVersion) ||
          basis.snapshotVersion < 1 ||
          !Number.isSafeInteger(basis.rateVersion) ||
          basis.rateVersion < 0)
      ) {
        throw new TypeError(
          "reserveCredits needs a complete locked basis: a non-empty cell with a positive snapshot version and a non-negative rate version.",
        );
      }
      await ensureCustomer(database, input.externalCustomerId);

      const at = new Date();
      return database.transaction(async (tx) => {
        await lockCustomer(tx, input.externalCustomerId);

        const [existing] = await tx
          .select()
          .from(creditReservations)
          .where(eq(creditReservations.idempotencyKey, input.idempotencyKey))
          .limit(1);
        if (existing) {
          if (
            existing.externalCustomerId !== input.externalCustomerId ||
            existing.maximum !== input.maximumCents
          ) {
            throw new CreditReservationConflictError(
              "reserveCredits: the idempotency key belongs to a different reservation.",
            );
          }
          if (existing.status !== "reserved") {
            // A terminal hold carries no capacity: answering `reserved` would admit work
            // the gate never priced and settle could never charge — the same refusal
            // settle gives a released hold.
            throw new CreditReservationConflictError(
              `reserveCredits: the reservation for this idempotency key is ${existing.status}.`,
            );
          }
          return { reserved: true as const, reservationId: existing.id };
        }

        const grants = await liveGrants(tx, input.externalCustomerId, at, true);
        const owed = await carriedRemainder(tx, input.externalCustomerId);
        const owedUnit = owed.numerator > 0n ? 1 : 0;
        const free = grants.reduce((sum, grant) => sum + grant.free, 0);
        const available = Math.max(free - owedUnit, 0);
        if (available < input.maximumCents) {
          return { reserved: false as const, availableCents: available };
        }

        const reservationId = `cr-${randomBytes(8).toString("hex")}`;
        await tx.insert(creditReservations).values({
          id: reservationId,
          externalCustomerId: input.externalCustomerId,
          idempotencyKey: input.idempotencyKey,
          maximum: input.maximumCents,
          expiresAt: input.expiresAt,
          ...(basis === undefined
            ? {}
            : {
                provider: basis.provider,
                model: basis.model,
                capability: basis.capability,
                snapshotVersion: basis.snapshotVersion,
                rateVersion: basis.rateVersion,
              }),
        });
        let toHold = input.maximumCents;
        for (const grant of grants) {
          if (toHold === 0) break;
          const amount = Math.min(grant.free, toHold);
          if (amount === 0) continue;
          await tx.insert(creditReservationAllocations).values({
            id: `cra-${randomBytes(8).toString("hex")}`,
            reservationId,
            grantId: grant.id,
            amount,
          });
          toHold -= amount;
        }
        return { reserved: true as const, reservationId };
      });
    },

    async settleReservation(input) {
      const { numerator, denominator } = input.actual;
      if (
        typeof numerator !== "bigint" ||
        typeof denominator !== "bigint" ||
        numerator < 0n ||
        denominator <= 0n ||
        denominator > MAX_ACTUAL_DENOMINATOR
      ) {
        throw new TypeError(
          "settleReservation needs a non-negative rational actual cost with a positive bounded denominator.",
        );
      }
      const actual = reduce(numerator, denominator);

      const [head] = await database
        .select({ customer: creditReservations.externalCustomerId })
        .from(creditReservations)
        .where(eq(creditReservations.id, input.reservationId))
        .limit(1);
      if (!head) {
        throw new CreditReservationConflictError(
          "settleReservation: no such reservation.",
          "no_such_reservation",
        );
      }

      return database.transaction(async (tx) => {
        await lockCustomer(tx, head.customer);
        const [reservation] = await tx
          .select()
          .from(creditReservations)
          .where(eq(creditReservations.id, input.reservationId))
          .limit(1);
        if (!reservation) {
          throw new CreditReservationConflictError(
            "settleReservation: no such reservation.",
            "no_such_reservation",
          );
        }
        if (reservation.status === "released") {
          // 06.10's terminal-state conflict class: the release is a terminal fact, and a
          // settlement arriving after it is refused with its own stable kind — never a
          // silent overwrite of the release, never a charge nobody admitted.
          throw new CreditReservationConflictError(
            "settleReservation: the reservation was already released.",
            "reservation_released",
          );
        }
        if (reservation.status === "settled") {
          if (
            reservation.actualNumerator !== actual.numerator.toString() ||
            reservation.actualDenominator !== actual.denominator.toString()
          ) {
            // 06.10's amount conflict class: the same reservation settles ONCE, at the
            // first actual. A different amount is a conflict with its own stable kind —
            // never a top-up of the recorded settlement.
            throw new CreditReservationConflictError(
              "settleReservation: the reservation was settled with a different actual cost.",
              "settled_with_different_actual",
            );
          }
          return settledResultOf(reservation);
        }

        const owed = await carriedRemainder(tx, reservation.externalCustomerId);
        const total = addAmounts(owed, actual);
        const whole = total.numerator / total.denominator;
        const fraction = reduce(
          total.numerator % total.denominator,
          total.denominator,
        );
        if (whole > BigInt(MAX_STORED_UNITS)) {
          throw new TypeError(
            "settleReservation: the charge exceeds the 32-bit credit storage limit.",
          );
        }
        const charged = Number(whole);

        const allocations = await tx
          .select({
            id: creditReservationAllocations.id,
            grantId: creditReservationAllocations.grantId,
            amount: creditReservationAllocations.amount,
            total: creditGrants.total,
            used: creditGrants.used,
          })
          .from(creditReservationAllocations)
          .innerJoin(
            creditGrants,
            eq(creditGrants.id, creditReservationAllocations.grantId),
          )
          .where(eq(creditReservationAllocations.reservationId, reservation.id))
          .orderBy(
            asc(creditGrants.expiresAt),
            asc(creditGrants.grantedAt),
            asc(creditGrants.id),
          )
          .for("update", { of: creditGrants });

        // A hold keeps its grants even if one lapsed since: the work was admitted while it was live.
        let toApply = Math.min(charged, reservation.maximum);
        let applied = 0;
        for (const allocation of allocations) {
          const remainingGrantCapacity = Math.max(
            allocation.total - allocation.used,
            0,
          );
          const drew = Math.min(
            toApply,
            allocation.amount,
            remainingGrantCapacity,
          );
          if (drew > 0) {
            await tx
              .update(creditGrants)
              .set({ used: sql`${creditGrants.used} + ${drew}` })
              .where(eq(creditGrants.id, allocation.grantId));
            await tx
              .update(creditReservationAllocations)
              .set({ consumed: drew })
              .where(eq(creditReservationAllocations.id, allocation.id));
          }
          applied += drew;
          toApply -= drew;
        }

        const ledgerId = `cl-${randomBytes(8).toString("hex")}`;
        await tx.insert(ledger).values({
          id: ledgerId,
          externalCustomerId: reservation.externalCustomerId,
          grantId: allocations.find((a) => a.amount > 0)?.grantId ?? null,
          title: input.title,
          requestId: input.requestId ?? null,
          idempotencyKey: `reservation:${reservation.id}`,
          credits: charged,
          applied,
          model: input.model ?? null,
          client: input.client ?? null,
        });
        if (input.lineDetail !== undefined) {
          // Same transaction as the ledger row and the terminal update: the detail is the
          // settlement's display half, and a settled charge can never land without the
          // line that names it (the detail tables' one-row-per-reservation uniqueness is
          // the fence). The capability's own member names its own table — and the async
          // member is discriminated by its `jobId`, not its capability (an async job may
          // itself be an image or speech job; the line kind and the model cell are two
          // different facts).
          if ("batchId" in input.lineDetail) {
            // The batch line is N item lines beside ONE ledger row: the members' exact
            // costs must sum to this settlement's actual cost EXACTLY (cross-multiplied,
            // the same discipline the dimension split enforces) — a batch line that names
            // a different total is a defect, never a rounded guess.
            let sumNumerator = 0n;
            let sumDenominator = 1n;
            for (const item of input.lineDetail.items) {
              sumNumerator =
                sumNumerator * item.exactCost.denominator +
                item.exactCost.numerator * sumDenominator;
              sumDenominator = sumDenominator * item.exactCost.denominator;
            }
            if (
              sumNumerator * actual.denominator !==
              actual.numerator * sumDenominator
            ) {
              throw new TypeError(
                "settleReservation: the batch line's item costs sum to a different total than the settlement's actual cost.",
              );
            }
            // NOTE: a PARTIAL settlement's line carries only its BILLABLE members (18.3)
            // — the released items' evidence lives on their outcome rows, not on
            // zero-cost ledger lines — so no item-count equality is asserted here; the
            // exact-sum check above is the money guarantee.
            const batchDetail = input.lineDetail;
            await tx.insert(creditBatchSettlementDetails).values(
              batchDetail.items.map((item) => ({
                itemId: item.itemId,
                batchId: batchDetail.batchId,
                ledgerId,
                provider: item.provider,
                model: item.model,
                capability: item.capability,
                customId: item.customId,
                terminalState: item.terminalState,
                // The raw SQL wrapper is the jsonb driver trap's own workaround (see the
                // async member below): objects must arrive as objects, never strings.
                actualUsage: sql`${item.actualUsage}` as unknown as Record<
                  string,
                  number
                >,
                exactCost: sql`${{
                  numerator: item.exactCost.numerator.toString(),
                  denominator: item.exactCost.denominator.toString(),
                }}` as unknown as { numerator: string; denominator: string },
              })),
            );
          } else if ("jobId" in input.lineDetail) {
            await tx.insert(creditAsyncSettlementDetails).values({
              reservationId: reservation.id,
              ledgerId,
              capability: input.lineDetail.capability,
              jobId: input.lineDetail.jobId,
              providerJobId: input.lineDetail.providerJobId,
              entryCount: input.lineDetail.entryCount,
              terminalState: input.lineDetail.terminalState,
              // The usage goes through a raw SQL wrapper deliberately: the Bun SQL driver
              // encodes parameters jsonb-first, so a JS *string* param would land as a
              // jsonb string scalar the table's shape CHECK refuses — the object itself
              // arrives as the real object the CHECK validated (the price snapshot store's
              // own documented trap).
              actualUsage:
                sql`${input.lineDetail.actualUsage}` as unknown as Record<
                  string,
                  number
                >,
            });
          } else if (input.lineDetail.capability === "image") {
            await tx.insert(creditSettlementDetails).values({
              reservationId: reservation.id,
              ledgerId,
              capability: input.lineDetail.capability,
              requestedCount: input.lineDetail.requestedCount,
              generatedCount: input.lineDetail.generatedCount,
              inputImages: input.lineDetail.inputImages,
              size: input.lineDetail.size,
              quality: input.lineDetail.quality,
              unitPriceUsd: input.lineDetail.unitPriceUsd,
            });
          } else {
            await tx.insert(creditSpeechSettlementDetails).values({
              reservationId: reservation.id,
              ledgerId,
              capability: input.lineDetail.capability,
              inputCharacters: input.lineDetail.inputCharacters,
              cappedSeconds: input.lineDetail.cappedSeconds,
              actualSeconds: input.lineDetail.actualSeconds,
              perInputCharacterUsd: input.lineDetail.perInputCharacterUsd,
              perOutputSecondUsd: input.lineDetail.perOutputSecondUsd,
              voiceTier: input.lineDetail.voiceTier,
            });
          }
        }

        if (input.dimensionBreakdown !== undefined) {
          // The per-dimension split (20.3): validated against THIS settlement's exact
          // total, then allocated to whole units of the ledger row and written in the
          // same transaction — the rows sum to the row they explain, by construction and
          // by assertion, so the view's two-level attribution cannot drift from the
          // ledger. A split that names a different total than the settlement priced is a
          // caller defect and refuses the whole settlement.
          let splitNumerator = 0n;
          let splitDenominator = 1n;
          for (const member of input.dimensionBreakdown) {
            splitNumerator =
              splitNumerator * member.denominator +
              member.numerator * splitDenominator;
            splitDenominator *= member.denominator;
          }
          if (
            splitNumerator * actual.denominator !==
            actual.numerator * splitDenominator
          ) {
            throw new TypeError(
              "settleReservation: the dimension breakdown sums to a different total than the settlement's actual cost.",
            );
          }
          const allocated = allocateDimensionUnits(
            input.dimensionBreakdown,
            charged,
          );
          if (!allocated.ok || allocated.rows.length === 0) {
            throw new TypeError(
              "settleReservation: the dimension breakdown cannot be allocated to this ledger row.",
            );
          }
          await tx
            .insert(creditSettlementDimensionBreakdown)
            .values(
              allocated.rows.map((row) => ({
                ledgerId,
                dimension: row.dimension,
                units: row.units,
              })),
            )
            .onConflictDoNothing();
        }

        const released = reservation.maximum - applied;
        await tx
          .update(creditReservations)
          .set({
            status: "settled",
            actualNumerator: actual.numerator.toString(),
            actualDenominator: actual.denominator.toString(),
            charged,
            applied,
            released,
            remainderNumerator: fraction.numerator.toString(),
            remainderDenominator: fraction.denominator.toString(),
            ledgerId,
            terminalAt: new Date(),
          })
          .where(eq(creditReservations.id, reservation.id));
        await tx
          .insert(creditChargeRemainders)
          .values({
            externalCustomerId: reservation.externalCustomerId,
            numerator: fraction.numerator.toString(),
            denominator: fraction.denominator.toString(),
          })
          .onConflictDoUpdate({
            target: creditChargeRemainders.externalCustomerId,
            set: {
              numerator: fraction.numerator.toString(),
              denominator: fraction.denominator.toString(),
              updatedAt: new Date(),
            },
          });

        return {
          chargedCents: charged,
          appliedCents: applied,
          releasedCents: released,
          remainder: fraction,
        };
      });
    },

    async releaseReservation(reservationId, reason) {
      const [head] = await database
        .select({ customer: creditReservations.externalCustomerId })
        .from(creditReservations)
        .where(eq(creditReservations.id, reservationId))
        .limit(1);
      if (!head) return;
      await database.transaction(async (tx) => {
        await lockCustomer(tx, head.customer);
        const [reservation] = await tx
          .select({
            status: creditReservations.status,
            maximum: creditReservations.maximum,
          })
          .from(creditReservations)
          .where(eq(creditReservations.id, reservationId))
          .limit(1);
        if (reservation?.status === "unknown") {
          // 06.8: an unknown hold is never ordinary-release evidence — the provider may have
          // produced billable work nobody reported. Refuse loudly instead of silently leaving
          // the caller to believe capacity was handed back. The stable kind (06.10's
          // discriminator vocabulary) lets a caller tell this refusal apart from the other
          // conflict classes without parsing a message.
          throw new CreditReservationConflictError(
            "releaseReservation: the reservation's outcome is unknown; only recovery may dispose of it.",
            "reservation_unknown",
          );
        }
        if (reservation?.status !== "reserved") return;
        await tx
          .update(creditReservations)
          .set({
            status: "released",
            applied: 0,
            released: reservation.maximum,
            releaseReason: reason,
            terminalAt: new Date(),
          })
          .where(eq(creditReservations.id, reservationId));
      });
    },

    async releaseUnknownReservation(reservationId, reason) {
      const [head] = await database
        .select({ customer: creditReservations.externalCustomerId })
        .from(creditReservations)
        .where(eq(creditReservations.id, reservationId))
        .limit(1);
      if (!head) return;
      await database.transaction(async (tx) => {
        await lockCustomer(tx, head.customer);
        const [reservation] = await tx
          .select({
            status: creditReservations.status,
            maximum: creditReservations.maximum,
          })
          .from(creditReservations)
          .where(eq(creditReservations.id, reservationId))
          .limit(1);
        if (!reservation) return;
        if (reservation.status === "reserved") {
          // The recovery door is never a second ordinary release: a hold still in the plain
          // reserved state has an ordinary path, and evidence-backed disposal must not
          // bypass it.
          throw new CreditReservationConflictError(
            "releaseUnknownReservation: the reservation is still reserved; use the ordinary release.",
          );
        }
        if (reservation.status !== "unknown") return;
        await tx
          .update(creditReservations)
          .set({
            status: "released",
            applied: 0,
            released: reservation.maximum,
            releaseReason: reason,
            terminalAt: new Date(),
          })
          .where(eq(creditReservations.id, reservationId));
      });
    },

    async compensateUnknownReservation(reservationId, reason) {
      const [head] = await database
        .select({ customer: creditReservations.externalCustomerId })
        .from(creditReservations)
        .where(eq(creditReservations.id, reservationId))
        .limit(1);
      if (!head) return;
      await database.transaction(async (tx) => {
        await lockCustomer(tx, head.customer);
        const [reservation] = await tx
          .select({
            status: creditReservations.status,
            maximum: creditReservations.maximum,
          })
          .from(creditReservations)
          .where(eq(creditReservations.id, reservationId))
          .limit(1);
        if (!reservation) return;
        if (reservation.status === "reserved") {
          // The compensation door is stricter still: a still-plain hold has both ordinary
          // paths (settle or release), and an absorbed loss must never be the first thing
          // that happens to one.
          throw new CreditReservationConflictError(
            "compensateUnknownReservation: the reservation is still reserved; there is nothing to compensate yet.",
          );
        }
        if (reservation.status !== "unknown") return;
        // Mechanically the capacity returns like a release — there is no third terminal
        // state for "the platform paid" on the hold itself — but the reason's marker keeps
        // the two acts distinguishable at the row: a released-by-no-charge and a
        // compensated read differently forever after.
        await tx
          .update(creditReservations)
          .set({
            status: "released",
            applied: 0,
            released: reservation.maximum,
            releaseReason: reason,
            terminalAt: new Date(),
          })
          .where(eq(creditReservations.id, reservationId));
      });
    },

    async markReservationUnknown(reservationId, reason) {
      const [head] = await database
        .select({ customer: creditReservations.externalCustomerId })
        .from(creditReservations)
        .where(eq(creditReservations.id, reservationId))
        .limit(1);
      if (!head) return;
      await database.transaction(async (tx) => {
        await lockCustomer(tx, head.customer);
        const [reservation] = await tx
          .select({ status: creditReservations.status })
          .from(creditReservations)
          .where(eq(creditReservations.id, reservationId))
          .limit(1);
        // Only a plain hold becomes unknown: the first evidence stands, and a terminal
        // fact (settled/released) is never reopened.
        if (reservation?.status !== "reserved") return;
        await tx
          .update(creditReservations)
          .set({
            status: "unknown",
            unknownAt: new Date(),
            unknownReason: reason,
          })
          .where(eq(creditReservations.id, reservationId));
      });
    },
  };
}

async function ensureCustomer(
  db: Pick<Database, "insert">,
  externalId: string,
) {
  await db
    .insert(billingCustomers)
    .values({ externalId, name: null })
    .onConflictDoNothing({ target: billingCustomers.externalId });
}

/** Serialises every hold and settlement of one customer; the carried remainder depends on it. */
async function lockCustomer(tx: Tx, externalId: string) {
  await tx
    .select({ id: billingCustomers.externalId })
    .from(billingCustomers)
    .where(eq(billingCustomers.externalId, externalId))
    .for("update");
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function reduce(numerator: bigint, denominator: bigint): CreditAmount {
  if (numerator === 0n) return { numerator: 0n, denominator: 1n };
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function addAmounts(a: CreditAmount, b: CreditAmount): CreditAmount {
  return reduce(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

function settledResultOf(
  reservation: typeof creditReservations.$inferSelect,
): CreditSettlementResult {
  return {
    chargedCents: reservation.charged ?? 0,
    appliedCents: reservation.applied ?? 0,
    releasedCents: reservation.released ?? 0,
    remainder: {
      numerator: BigInt(reservation.remainderNumerator ?? "0"),
      denominator: BigInt(reservation.remainderDenominator ?? "1"),
    },
  };
}

type GrantRow = typeof creditGrants.$inferSelect;
function resultOf(row: GrantRow): CreditGrantResult {
  return {
    id: row.id,
    externalCustomerId: row.externalCustomerId,
    source: row.source,
    reason: row.reason,
    total: row.total,
    used: row.used,
    grantedAt: row.grantedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
