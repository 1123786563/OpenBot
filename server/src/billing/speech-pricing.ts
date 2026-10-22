import type { ConversionRate } from "../gateway/conversion-rate";
import {
  PRICE_DIMENSIONS,
  type PriceDimension,
  type PriceDimensionUnknownReason,
  type PriceSnapshotDims,
} from "../gateway/price-snapshot";
import { CREDIT_SCALE } from "./credits";
import type { ReservationBoundQuantities } from "./reserve-bound";

/*
 * The speech-generation pricing boundary (Bifrost 13.1, #306): the tier price resolution,
 * the two-sided ceiling, and the enablement verdict for the /v1/audio/speech capability —
 * the quantities and the evidence a hold must carry before any audio is synthesized.
 *
 * BOTH SIDES, ALWAYS. Upstream speech pricing bills the INPUT text (per character — some
 * providers per input token) and the OUTPUT audio (per second), with per-voice/-tier
 * differences. A ceiling that prices only the characters misses the audio cost entirely —
 * the resume hint's trap — so a tier row of this table always carries BOTH sides, and a
 * basis that prices only one side of a tier prices nothing: no row, no enablement.
 *
 * THE TIER IS THE REQUEST'S VOICE, FIXED BEFORE DISPATCH. The request's `voice` names the
 * tier; resolution takes the exact row first, then the wildcard row that prices every tier
 * uniformly. A voice neither carries is unpriced — never the nearest voice's rate, never a
 * zero.
 *
 * THE V1 WIRE CANNOT FILL THE TABLE — AND THIS MODULE SAYS SO. The gateway's v1 pricing
 * object (core/schemas/models.go `Pricing`) has no audio field at all: 03.2 records
 * `audio_input`/`audio_output` as unknown on every v1 snapshot, so the table a v1 snapshot
 * fills is EMPTY and the enablement verdict on today's snapshots is REFUSED — the honest
 * strict-billing answer (缺音频维度价格时标记 unknown 并拒绝), not a gap papered over with
 * the token dims' prices or an estimate. When the wire grows audio fields, the constructor
 * below is the one place that changes.
 *
 * THE OUTPUT SIDE NEEDS A CAP THE CALL CAN ENFORCE. Speech synthesis has no
 * provider-enforced duration parameter on the v1 wire, so the cap arrives as EVIDENCE the
 * caller attests: a provider parameter or a local cutoff the stream is actually severed
 * at. No cap, or a non-positive one, refuses the call method (Q11: cannot enforce → not
 * enabled) — the seconds the ceiling prices are the seconds the cap enforces, never a hope.
 *
 * THE INPUT SIDE'S UNIT, STATED HONESTLY. The per-character price is denominated OUTSIDE
 * the closed token vocabulary (`input` is USD per TOKEN — a character price riding it
 * would be a unit lie that undercounts in both directions), so the conversion below is
 * this module's own exact rational arithmetic over characters × the tier's per-character
 * price, seconds × its per-second price, and the per-request surcharge from the LOCKED
 * dims — the same discipline as 06.5's conversion (BigInt rationals end to end, one
 * upward rounding, the ledger's bound), with the vocabulary-side quantity
 * (audio_output = the cap) exported for the reserve record.
 *
 * VERSION-LOCKED BY CONSTRUCTION. The dims and the rate are the CALLER's — the locked
 * basis (model cell, snapshotVersion, rateVersion) a reservation persists — and this
 * module never reads a price of its own: a price sync that lands mid-flight changes
 * nothing about a hold that locked the previous version.
 */

/** One row of a speech tier price table: BOTH sides of the call, for one voice tier. */
export type SpeechTierPrice = {
  /** The tier's voice (e.g. "alloy"), or null for a wildcard row pricing every tier. */
  readonly voiceTier: string | null;
  /** Exact USD per input character at this tier — a canonical decimal string. */
  readonly perInputCharacterUsd: string;
  /** Exact USD per output audio second at this tier — a canonical decimal string. */
  readonly perOutputSecondUsd: string;
};

/** A model cell's speech pricing: one row per tier it prices, wildcards last. */
export type SpeechTierPriceTable = readonly SpeechTierPrice[];

/** The frozen request spec: the complete text, the voice tier, and the duration cap. */
export type SpeechGenerationSpec = {
  readonly inputCharacters: number;
  readonly voiceTier: string | null;
  readonly durationCapSeconds: number;
};

/** Why a speech call cannot be enabled. Closed vocabulary, displayable. */
export type SpeechEnablementIssue =
  /** The requested voice tier has no price on the basis — unknown is never a zero cost. */
  | { code: "speech_tier_price_unknown"; voiceTier: string | null }
  /** The call carries no enforceable output-duration cap (Q11: cannot enforce → not enabled). */
  | { code: "speech_output_duration_uncapped" }
  /** The input is not a string this module can count in full. */
  | { code: "speech_input_uncountable" }
  /** A dimension of the basis is unknown (the per-request surcharge): never a zero cost. */
  | {
      code: "price_unknown";
      dimension: PriceDimension;
      reason: PriceDimensionUnknownReason;
    };

/** The verdict: enabled carries the spec and quantities; refused carries the reason. */
export type SpeechGenerationEnablement =
  | {
      enabled: true;
      /** True when every priced side is exactly "0": free is a price, not a pass. */
      free: boolean;
      /** The frozen spec the hold was certified against. */
      spec: SpeechGenerationSpec;
      /** The resolved tier row — both sides, the basis the hold locks. */
      tier: SpeechTierPrice;
      /** The vocabulary-side quantities for the reserve record (audio_output = the cap). */
      quantities: ReservationBoundQuantities;
    }
  | { enabled: false; issue: SpeechEnablementIssue };

/**
 * The tier table a snapshot's dims can fill: EMPTY, today and by construction. The v1
 * wire's pricing object carries no audio field (neither input nor output side), so 03.2
 * records both audio dimensions unknown on every v1 snapshot and there is nothing per-tier
 * to read. The honesty is code, not a comment: when the wire grows the fields, THIS is
 * the one place that changes, and the enablement verdict flips on evidence.
 */
export function speechTierPriceTableFromSnapshot(
  _dims: PriceSnapshotDims,
): SpeechTierPriceTable {
  void _dims;
  return [];
}

/** Resolve the request's voice tier against the table: exact row first, then wildcard. */
export function resolveSpeechTierPrice(
  table: SpeechTierPriceTable,
  voiceTier: string | null,
): { ok: true; tier: SpeechTierPrice } | { ok: false } {
  const exact = table.find((row) => row.voiceTier === voiceTier);
  if (exact) return { ok: true, tier: exact };
  const wildcard = table.find((row) => row.voiceTier === null);
  if (wildcard) return { ok: true, tier: wildcard };
  return { ok: false };
}

/**
 * The enablement predicate (AC1–AC3): the input countable (a string — its FULL text,
 * counted in UTF-16 code units, which never undercounts a code point), the output duration
 * capped by evidence the caller can enforce, the voice tier priced on BOTH sides, and the
 * per-request surcharge known on the locked dims. The dims handed in are the LOCKED
 * basis's; this function never reads a price of its own.
 */
export function assessSpeechGeneration(input: {
  /** The locked price basis's dims (the surcharge is read here). */
  dims: PriceSnapshotDims;
  /** The tier table resolved FOR THE LOCKED BASIS (empty from a v1 snapshot). */
  tierTable: SpeechTierPriceTable;
  /** The speech request as it will be sent ({ model, input, voice }). */
  request: unknown;
  /** The enforceable output-duration cap in seconds (provider param or local cutoff). */
  durationCapSeconds: number;
}): SpeechGenerationEnablement {
  const request = input.request as
    | { input?: unknown; voice?: unknown }
    | null
    | undefined;
  const text = request?.input;
  if (typeof text !== "string") {
    return { enabled: false, issue: { code: "speech_input_uncountable" } };
  }
  if (
    !Number.isSafeInteger(input.durationCapSeconds) ||
    input.durationCapSeconds <= 0
  ) {
    return {
      enabled: false,
      issue: { code: "speech_output_duration_uncapped" },
    };
  }
  const voice =
    typeof request?.voice === "string" &&
    request.voice.trim() === request.voice &&
    request.voice.length > 0
      ? request.voice
      : null;

  const tier = resolveSpeechTierPrice(input.tierTable, voice);
  if (!tier.ok) {
    return {
      enabled: false,
      issue: { code: "speech_tier_price_unknown", voiceTier: voice },
    };
  }
  if (input.dims.surcharge_per_request.status === "unknown") {
    return {
      enabled: false,
      issue: {
        code: "price_unknown",
        dimension: "surcharge_per_request",
        reason: input.dims.surcharge_per_request.reason,
      },
    };
  }

  const quantities = Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [
      dimension,
      dimension === "audio_output"
        ? input.durationCapSeconds
        : dimension === "surcharge_per_request"
          ? 1
          : 0,
    ]),
  ) as ReservationBoundQuantities;

  const free =
    tier.tier.perInputCharacterUsd === "0" &&
    tier.tier.perOutputSecondUsd === "0" &&
    input.dims.surcharge_per_request.status === "known" &&
    input.dims.surcharge_per_request.amount === "0";

  return {
    enabled: true,
    free,
    spec: {
      inputCharacters: text.length,
      voiceTier: voice,
      durationCapSeconds: input.durationCapSeconds,
    },
    tier: tier.tier,
    quantities,
  };
}

/** Why a ceiling could not be certified: the enablement's own reasons, plus the
 * conversion's two (a non-positive rate, a ceiling past the ledger's bound). */
export type SpeechCeilingIssue =
  | SpeechEnablementIssue
  /** The rate is not a positive exact rational — not an exchange. */
  | { code: "rate_invalid" }
  /** The ceiling exceeds the 32-bit ledger column; no hold could ever settle it. */
  | { code: "ceiling_exceeds_ledger" };

export type SpeechCeiling =
  | {
      ok: true;
      /** The hold ceiling: the smallest whole scaled unit ≥ the exact possible cost. */
      maximumCredits: number;
      /** The exact possible cost in scaled units, lowest terms. */
      exactScaledUnits: { numerator: bigint; denominator: bigint };
    }
  | { ok: false; issue: SpeechCeilingIssue };

const MAX_STORED_UNITS = 2_147_483_647n;
const DECIMAL_SHAPE = /^(\d+)(?:\.(\d+))?$/;

/** One exact amount string → its BigInt rational; null when not an exact decimal.
 * Exported because the settlement (13.2) prices the same tier strings through the same
 * exact-decimal discipline — one reader for one spelling. */
export function parseExactDecimal(amount: string): {
  numerator: bigint;
  denominator: bigint;
} | null {
  const match = DECIMAL_SHAPE.exec(amount);
  if (!match) return null;
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction === "") return { numerator: BigInt(whole), denominator: 1n };
  return {
    numerator: BigInt(whole + fraction),
    denominator: 10n ** BigInt(fraction.length),
  };
}

/**
 * The two-sided speech ceiling (AC1/AC4): characters × the tier's per-character price +
 * the duration cap × the tier's per-second price + the per-request surcharge from the
 * LOCKED dims, × the LOCKED rate, in scaled units, rounded UP once at the end. The dims
 * and rate are the caller's locked basis; a mid-flight price sync changes nothing. Pure,
 * exact in BigInt rationals end to end — no float exists anywhere in the chain.
 */
export function speechGenerationCeiling(input: {
  dims: PriceSnapshotDims;
  tierTable: SpeechTierPriceTable;
  request: unknown;
  durationCapSeconds: number;
  rate: ConversionRate;
}): SpeechCeiling {
  const verdict = assessSpeechGeneration(input);
  if (!verdict.enabled) {
    const issue = verdict.issue;
    return { ok: false, issue };
  }

  const perChar = parseExactDecimal(verdict.tier.perInputCharacterUsd);
  const perSecond = parseExactDecimal(verdict.tier.perOutputSecondUsd);
  const surcharge = input.dims.surcharge_per_request;
  if (surcharge.status === "unknown") {
    return {
      ok: false,
      issue: {
        code: "price_unknown",
        dimension: "surcharge_per_request",
        reason: surcharge.reason,
      },
    };
  }
  const perRequest = parseExactDecimal(surcharge.amount);
  if (perChar === null || perSecond === null || perRequest === null) {
    // Unreachable behind the table's exact-decimal shape; kept so this function never
    // prices a string it could not read exactly.
    return {
      ok: false,
      issue: {
        code: "price_unknown",
        dimension: "audio_output",
        reason: "price_dim_unreadable",
      },
    };
  }
  if (input.rate.numerator <= 0n || input.rate.denominator <= 0n) {
    return { ok: false, issue: { code: "rate_invalid" } };
  }

  // characters × perChar + seconds × perSecond + 1 × perRequest, exact by
  // cross-multiplication over one common denominator.
  const charCost = {
    numerator: BigInt(verdict.spec.inputCharacters) * perChar.numerator,
    denominator: perChar.denominator,
  };
  const secondCost = {
    numerator: BigInt(verdict.spec.durationCapSeconds) * perSecond.numerator,
    denominator: perSecond.denominator,
  };
  const requestCost = perRequest;
  const common =
    charCost.denominator * secondCost.denominator * requestCost.denominator;
  const costNumerator =
    charCost.numerator * secondCost.denominator * requestCost.denominator +
    secondCost.numerator * charCost.denominator * requestCost.denominator +
    requestCost.numerator * charCost.denominator * secondCost.denominator;

  // USD → credits → scaled units, still exact; the one rounding step is upward.
  const scaledNumerator =
    costNumerator * input.rate.numerator * BigInt(CREDIT_SCALE);
  const scaledDenominator = common * input.rate.denominator;
  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
  const divisor =
    scaledNumerator === 0n ? 1n : gcd(scaledNumerator, scaledDenominator);
  const exact = {
    numerator: scaledNumerator / divisor,
    denominator: scaledDenominator / divisor,
  };
  const ceiling =
    exact.numerator === 0n
      ? 0n
      : (exact.numerator + exact.denominator - 1n) / exact.denominator;
  if (ceiling > MAX_STORED_UNITS) {
    return { ok: false, issue: { code: "ceiling_exceeds_ledger" } };
  }
  return { ok: true, maximumCredits: Number(ceiling), exactScaledUnits: exact };
}
