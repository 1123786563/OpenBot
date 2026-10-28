import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { creditReservations } from "../db/schema/credit-reservations";
import type { ConversionRate } from "../gateway/conversion-rate";
import { CREDIT_SCALE } from "./credits";
import {
  CreditReservationConflictError,
  createCreditWriter,
} from "./credits-writer";
import {
  attemptIdForReservation,
  reservationIdFromAttemptId,
} from "./reservation-status";
import {
  lockedBasisOfReservation,
  resolveLockedReservationBasis,
  speechSpecOfReservation,
} from "./reserve-bound";
import { parseExactDecimal } from "./speech-pricing";
import { parseWavDurationSeconds } from "./transcription-pricing";

/**
 * The speech-generation settlement path (Bifrost 13.2, #307): what a synthesis dispatch owes
 * once its result is in, computed from what was ACTUALLY spoken — the characters the request
 * carried and the seconds of audio the result evidences — priced at the version the hold
 * locked, and shown in the user's consumption detail as the speech line it is.
 *
 * ACTUAL, NOT CAPPED. The reservation held the duration cap's worst case (13.1); the
 * settlement prices the seconds the result stands on — the provider's own usage figure, or
 * the produced audio's container stating its own duration (the same measured-not-believed
 * evidence 14.1's meter reads) — and the unsynthesized share of the hold hands back with
 * the settle. A cap of 60 over an artifact of 25 seconds settles 25 and releases the rest;
 * an actual beyond the cap is not a bill but a defect, and refuses. A result with NO
 * readable evidence settles nothing and releases nothing — the hold is marked unknown
 * (06.8) and keeps its FULL capacity occupied, because an unverifiable outcome is not a
 * zero cost, and 估算 is exactly what the ticket forbids.
 *
 * THE PRICE IS THE LOCKED VERSION'S. The reservation locked (model cell, snapshotVersion,
 * rateVersion) at admission; the settlement resolves THAT combination for the rate and the
 * surcharge, and cross-checks the tier the settle surface re-carries against the locked
 * dims where the vocabulary can speak: `audio_output` is the per-output-SECOND slot 03.2
 * reserved for exactly this capability, so a basis that prices speech seconds MUST carry
 * them there, and the settlement refuses a tier whose per-second price the lock cannot
 * corroborate. The per-CHARACTER side has no vocabulary slot (13.1's own unit-honesty: a
 * character price riding the per-token `input` would be a unit lie) — its versioned home
 * is the frozen spec the hold was certified against and the line row this settlement
 * writes (0181), which is why the tier travels with the settle request the same way the
 * frozen `requested` spec does in 12.2's image path.
 *
 * EXACT, END TO END. Characters × the per-character price + seconds × the per-second
 * price + the per-request surcharge from the LOCKED dims, × the LOCKED rate, in scaled
 * units, in BigInt rationals with the one rounding step upward — the same discipline as
 * 13.1's ceiling, priced over the actual quantities instead.
 *
 * WHO CALLS THIS. The deployment's speech settlement stage — the counterpart of the chat
 * path's 06.9 consumer — for a reservation whose locked basis is a speech cell. The
 * request carries NO price of its own that the lock can check and NO account: the rate and
 * the surcharge come from the lock, the account from the reservation.
 */

/** The closed refusal vocabulary — the settle surface's own codes, one seam over. */
export type SpeechSettlementRefusalReasonCode =
  | "request_invalid"
  | "settlement_conflict"
  | "price_basis_not_found"
  | "price_unknown"
  | "charge_exceeds_ledger";

/**
 * The result a synthesis stands on: evidenced seconds, or no reliable evidence at all.
 * The seconds are an EXACT DECIMAL STRING — the provider usage figure or the artifact
 * container's own statement (data size ÷ byte rate), never a float that has already been
 * through binary rounding.
 */
export type SpeechGenerationResult =
  | {
      /** The synthesis produced audio, and something verifiable states how long it is. */
      outcome: "synthesized";
      /** The actual billed seconds — an exact decimal string (e.g. "25.5"). */
      actualSeconds: string;
      /** What the seconds stand on; a closed vocabulary like every evidence seam here.
       * A provider usage report is billable only with a traceable reference (13.2's
       * tightened rule); artifact metadata is billable only when THIS server can
       * re-measure the carried containers to the claimed seconds. */
      evidence:
        | { kind: "provider_usage_report"; reference?: string }
        | {
            kind: "artifact_metadata";
            reference?: string;
            /** Each carried WAV container's own header — the one artifact's container
             * header, or the interrupted buffer's chunk headers — what the server
             * re-measures with the same parser 14.1's meter reads. */
            metadata?: { container: "wav"; bytesBase64: string[] };
          };
    }
  | {
      /**
       * No evidence anyone may bill from: the stream cut, the artifact unreadable, the
       * usage absent. The hold settles nothing and moves to unknown (06.8) — full
       * capacity still occupied, recovery's to dispose of. Per the ticket's own rule, the
       * input characters are never used to ESTIMATE the output duration in this state.
       */
      outcome: "unknown";
      reason: string;
    };

/** The Settle request contract, as the speech stage carries it. */
export type SpeechSettleRequest = {
  /** The reservation being settled: exactly one of reservationId / attemptId names it. */
  reservationId?: string;
  attemptId?: string;
  /** The spec 13.1 froze before dispatch — what the hold was certified against. */
  requested: {
    inputCharacters: number;
    voiceTier: string | null;
    durationCapSeconds: number;
  };
  /** The locked tier the admission certified — both sides, exact decimal strings. */
  priced: {
    perInputCharacterUsd: string;
    perOutputSecondUsd: string;
  };
  /** What the synthesis stood on. */
  result: SpeechGenerationResult;
  /** The settling party — an identifier, carried for the trail. */
  settledBy: string;
  idempotencyKey: string;
};

/** The speech line as surfaces show it: the chars, the seconds, and what it cost. */
export type SpeechSettlementLine = {
  inputCharacters: number;
  voiceTier: string | null;
  /** The cap the hold was certified against — the released share is the difference. */
  cappedSeconds: number;
  /** The actual billed seconds, the exact decimal the settlement priced. */
  actualSeconds: string;
  perInputCharacterUsd: string;
  perOutputSecondUsd: string;
};

export type SpeechSettlementOutcome =
  | {
      status: "settled";
      reservationId: string;
      attemptId: string;
      chargedCredits: number;
      appliedCredits: number;
      releasedCredits: number;
      /** The exact priced cost in scaled units, lowest terms, as strings for the wire. */
      actualCost: { numerator: string; denominator: string };
      remainder: { numerator: string; denominator: string };
      /** The line this settlement wrote beside its ledger row. */
      line: SpeechSettlementLine;
    }
  | {
      /** No reliable result: the hold settled nothing, released nothing, and is marked
       *  unknown (06.8) — full capacity still occupied, recovery's to dispose of. */
      status: "unknown";
      reservationId: string;
    }
  | {
      status: "refused";
      reasonCode: SpeechSettlementRefusalReasonCode;
      detail: Record<string, unknown>;
    };

export type SpeechSettlementServiceDependencies = {
  database: Database;
  /** The deployment's validated environment rate — the value lock version 0 names. */
  environmentRate?: ConversionRate;
};

const MAX_STORED_UNITS = 2_147_483_647n;

function refused(
  reasonCode: SpeechSettlementRefusalReasonCode,
  detail: Record<string, unknown> = {},
): SpeechSettlementOutcome {
  return { status: "refused", reasonCode, detail };
}

function isIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

/** The exact-decimal shape every price and seconds string on this surface must carry. */
const EXACT_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** One exact decimal string → its BigInt rational; null when not exact. */
function exactDecimal(amount: string): {
  numerator: bigint;
  denominator: bigint;
} | null {
  const match = EXACT_DECIMAL.exec(amount);
  if (!match) return null;
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction === "") return { numerator: BigInt(match[1]), denominator: 1n };
  return {
    numerator: BigInt(match[1] + fraction),
    denominator: 10n ** BigInt(fraction.length),
  };
}

type RequestValidation =
  | { ok: true; request: SpeechSettleRequest; reservationId: string }
  | { ok: false; outcome: SpeechSettlementOutcome };

/** Pure shape validation — before any database contact, a malformed request reads nothing. */
function validateRequest(input: unknown): RequestValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "body" }),
    };
  }
  const raw = input as Record<string, unknown>;

  const hasReservationId = raw.reservationId !== undefined;
  const hasAttemptId = raw.attemptId !== undefined;
  if (hasReservationId === hasAttemptId) {
    return {
      ok: false,
      outcome: refused("request_invalid", {
        field: "reservationId",
        reason: "exactly_one_of_reservationId_attemptId",
      }),
    };
  }
  let reservationId: string | null = null;
  if (hasReservationId) {
    reservationId = raw.reservationId as string;
    if (!isIdentifier(reservationId, 512)) {
      return {
        ok: false,
        outcome: refused("request_invalid", { field: "reservationId" }),
      };
    }
  } else {
    reservationId = reservationIdFromAttemptId(raw.attemptId as string);
    if (reservationId === null) {
      return {
        ok: false,
        outcome: refused("request_invalid", { field: "attemptId" }),
      };
    }
  }

  const requested = raw.requested as Record<string, unknown> | null | undefined;
  if (requested === null || typeof requested !== "object") {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "requested" }),
    };
  }
  const inputCharacters = requested.inputCharacters;
  if (
    typeof inputCharacters !== "number" ||
    !Number.isSafeInteger(inputCharacters) ||
    inputCharacters < 0
  ) {
    return {
      ok: false,
      outcome: refused("request_invalid", {
        field: "requested.inputCharacters",
      }),
    };
  }
  const voiceTier =
    requested.voiceTier === null || requested.voiceTier === undefined
      ? null
      : requested.voiceTier;
  if (voiceTier !== null && !isIdentifier(voiceTier, 128)) {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "requested.voiceTier" }),
    };
  }
  const durationCapSeconds = requested.durationCapSeconds;
  if (
    typeof durationCapSeconds !== "number" ||
    !Number.isSafeInteger(durationCapSeconds) ||
    durationCapSeconds <= 0
  ) {
    return {
      ok: false,
      outcome: refused("request_invalid", {
        field: "requested.durationCapSeconds",
      }),
    };
  }

  const priced = raw.priced as Record<string, unknown> | null | undefined;
  if (priced === null || typeof priced !== "object") {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "priced" }),
    };
  }
  const perInputCharacterUsd = priced.perInputCharacterUsd;
  const perOutputSecondUsd = priced.perOutputSecondUsd;
  if (
    typeof perInputCharacterUsd !== "string" ||
    exactDecimal(perInputCharacterUsd) === null
  ) {
    return {
      ok: false,
      outcome: refused("request_invalid", {
        field: "priced.perInputCharacterUsd",
        reason: "not_an_exact_decimal",
      }),
    };
  }
  if (
    typeof perOutputSecondUsd !== "string" ||
    exactDecimal(perOutputSecondUsd) === null
  ) {
    return {
      ok: false,
      outcome: refused("request_invalid", {
        field: "priced.perOutputSecondUsd",
        reason: "not_an_exact_decimal",
      }),
    };
  }

  const result = raw.result as Record<string, unknown> | null | undefined;
  if (result === null || typeof result !== "object") {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "result" }),
    };
  }
  if (result.outcome === "synthesized") {
    const actualSeconds = result.actualSeconds;
    const seconds =
      typeof actualSeconds === "string" ? exactDecimal(actualSeconds) : null;
    if (seconds === null || seconds.numerator === 0n) {
      return {
        ok: false,
        outcome: refused("request_invalid", {
          field: "result.actualSeconds",
          reason: "must_be_a_positive_exact_decimal",
        }),
      };
    }
    // The actual can never exceed the cap the hold was certified against — a synthesis
    // longer than its enforceable cap is a defect of the cutoff, never a bill.
    if (seconds.numerator > BigInt(durationCapSeconds) * seconds.denominator) {
      return {
        ok: false,
        outcome: refused("request_invalid", {
          field: "result.actualSeconds",
          reason: "actual_exceeds_certified_spec",
        }),
      };
    }
    const evidence = result.evidence as
      | Record<string, unknown>
      | null
      | undefined;
    if (
      evidence === null ||
      typeof evidence !== "object" ||
      (evidence.kind !== "provider_usage_report" &&
        evidence.kind !== "artifact_metadata") ||
      (evidence.reference !== undefined &&
        !isIdentifier(evidence.reference, 512))
    ) {
      return {
        ok: false,
        outcome: refused("request_invalid", { field: "result.evidence" }),
      };
    }
    // Shape only — the BILLABILITY of artifact metadata (does it measure, does it agree)
    // is the service's evidence rule below; a shape-invalid metadata blob is a malformed
    // request, not absent evidence.
    const metadata = evidence.metadata as Record<string, unknown> | undefined;
    if (evidence.kind === "artifact_metadata" && metadata !== undefined) {
      const containers = metadata.bytesBase64 as unknown;
      const validShape =
        metadata.container === "wav" &&
        Array.isArray(containers) &&
        containers.length >= 1 &&
        containers.length <= 64 &&
        containers.every(
          (container) =>
            typeof container === "string" &&
            container.length >= 1 &&
            container.length <= 8192,
        );
      if (!validShape) {
        return {
          ok: false,
          outcome: refused("request_invalid", {
            field: "result.evidence",
            reason: "artifact_metadata_shape",
          }),
        };
      }
    }
  } else if (result.outcome === "unknown") {
    if (typeof result.reason !== "string" || result.reason.trim() === "") {
      return {
        ok: false,
        outcome: refused("request_invalid", { field: "result.reason" }),
      };
    }
  } else {
    return {
      ok: false,
      outcome: refused("request_invalid", {
        field: "result.outcome",
        reason: "closed_vocabulary",
      }),
    };
  }

  if (!isIdentifier(raw.settledBy, 512)) {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "settledBy" }),
    };
  }
  if (!isIdentifier(raw.idempotencyKey, 512)) {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "idempotencyKey" }),
    };
  }

  return {
    ok: true,
    reservationId,
    request: {
      ...(hasReservationId
        ? { reservationId: raw.reservationId as string }
        : { attemptId: raw.attemptId as string }),
      requested: { inputCharacters, voiceTier, durationCapSeconds },
      priced: { perInputCharacterUsd, perOutputSecondUsd },
      result: raw.result as SpeechGenerationResult,
      settledBy: raw.settledBy as string,
      idempotencyKey: raw.idempotencyKey as string,
    },
  };
}

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

/**
 * Σ of every carried container's own stated duration — each read by the same whole-file
 * meter 14.1 uses, so a carried artifact (one container header) or an interrupted
 * buffer's chunk headers re-measure exactly the statements they were measured from.
 * Null when anything is absent or unreadable: the sum is only as good as every container
 * in it. PCM containers' sizes are byte-rate multiples, so every honest header measures
 * to an exact double and the sum stays exact with it.
 */
function measuredWavContainersSeconds(
  containersBase64: readonly string[],
): number | null {
  let total = 0;
  for (const base64 of containersBase64) {
    const measured = parseWavDurationSeconds(Buffer.from(base64, "base64"));
    if (measured === null) return null;
    total += measured;
  }
  return total;
}

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

/**
 * The speech settlement service. Validate, resolve the lock, corroborate the tier where
 * the locked dims can speak, price the ACTUAL at the LOCKED version, and settle through
 * the credit writer with the speech line riding the same transaction; an unreadable
 * result marks the hold unknown and touches nothing else.
 */
export function createSpeechSettlementService(
  dependencies: SpeechSettlementServiceDependencies,
): { settle(request: unknown): Promise<SpeechSettlementOutcome> } {
  const writer = createCreditWriter(dependencies.database);
  return {
    async settle(request: unknown): Promise<SpeechSettlementOutcome> {
      const validated = validateRequest(request);
      if (!validated.ok) return validated.outcome;
      const { request: req, reservationId } = validated;

      const [reservation] = await dependencies.database
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.id, reservationId))
        .limit(1);
      if (!reservation) {
        return refused("settlement_conflict", {
          kind: "no_such_reservation",
          reason: "no such reservation",
        });
      }

      // No readable evidence: settle nothing, release nothing, mark the hold unknown — its
      // full capacity stays occupied for recovery (06.8). The input characters are never
      // an estimate of the output duration (the ticket's own forbidden shortcut).
      if (req.result.outcome === "unknown") {
        await writer.markReservationUnknown(
          reservationId,
          `speech synthesis result unreadable: ${req.result.reason}`,
        );
        return { status: "unknown", reservationId };
      }

      // The character side must be corroborated by the spec the hold froze (13.2): what
      // 13.1's admission certified — the characters, the tier, the cap and the
      // per-character price — is what the settle surface must re-carry exactly. A settle
      // naming other quantities is not the work this hold was priced for: refused, never
      // adopted, never rewritten to the caller's numbers (same semantics as the
      // per-second corroboration against the lock below).
      const spec = speechSpecOfReservation(reservation);
      if (spec === null) {
        return refused("price_basis_not_found", {
          stage: "speech_spec_not_locked",
        });
      }
      const carriedPerChar = parseExactDecimal(req.priced.perInputCharacterUsd);
      const frozenPerChar = parseExactDecimal(spec.perInputCharacterUsd);
      if (
        req.requested.inputCharacters !== spec.inputCharacters ||
        req.requested.voiceTier !== spec.voiceTier ||
        req.requested.durationCapSeconds !== spec.durationCapSeconds ||
        carriedPerChar === null ||
        frozenPerChar === null ||
        carriedPerChar.numerator * frozenPerChar.denominator !==
          frozenPerChar.numerator * carriedPerChar.denominator
      ) {
        return refused("price_basis_not_found", {
          stage: "spec_not_corroborated",
          frozen: {
            inputCharacters: spec.inputCharacters,
            voiceTier: spec.voiceTier,
            durationCapSeconds: spec.durationCapSeconds,
            perInputCharacterUsd: spec.perInputCharacterUsd,
          },
          carried: {
            inputCharacters: req.requested.inputCharacters,
            voiceTier: req.requested.voiceTier,
            durationCapSeconds: req.requested.durationCapSeconds,
            perInputCharacterUsd: req.priced.perInputCharacterUsd,
          },
        });
      }

      const basis = lockedBasisOfReservation(reservation);
      if (basis === null) {
        return refused("price_basis_not_found", {
          stage: "reservation_lock_missing",
        });
      }
      const resolved = await resolveLockedReservationBasis(
        {
          database: dependencies.database,
          ...(dependencies.environmentRate !== undefined
            ? { environmentRate: dependencies.environmentRate }
            : {}),
        },
        basis,
      );
      if (!resolved.resolved) {
        return refused("price_basis_not_found", {
          snapshotVersion: basis.snapshotVersion,
          rateVersion: basis.rateVersion,
          reason: resolved.reason,
        });
      }

      // The evidence rules (13.2's tightened AC2): a provider usage report is evidence
      // only with a reference someone can trace, and artifact metadata is evidence only
      // when THIS server re-measures the artifact's container to the claimed seconds —
      // the same parser 14.1's meter reads, never a belief in a label. Neither satisfied:
      // no evidence anyone may bill from, the hold goes unknown (06.8). A measurement
      // that DISAGREES with the claim is not absent evidence but a conflict: refused,
      // never rewritten to the measured number. The input characters are never an
      // estimate of the duration — that substitution stays the forbidden shortcut.
      if (req.result.evidence.kind === "provider_usage_report") {
        const reference = req.result.evidence.reference;
        if (reference === undefined || reference.trim() === "") {
          await writer.markReservationUnknown(
            reservationId,
            "speech synthesis evidence unusable: provider usage report without a reference",
          );
          return { status: "unknown", reservationId };
        }
      } else {
        const metadata = req.result.evidence.metadata;
        const measuredSeconds = metadata
          ? measuredWavContainersSeconds(metadata.bytesBase64)
          : null;
        if (measuredSeconds === null) {
          await writer.markReservationUnknown(
            reservationId,
            "speech synthesis evidence unusable: artifact metadata states no readable duration",
          );
          return { status: "unknown", reservationId };
        }
        const claimed = exactDecimal(req.result.actualSeconds);
        if (claimed === null) {
          // Unreachable behind the request validation; kept so the comparison below
          // never divides a number it could not read exactly.
          return refused("request_invalid", { field: "result.actualSeconds" });
        }
        // Exact for every honest report: both sides are the correctly-rounded double of
        // the SAME rational when the durations are equal, and a measurable duration's
        // lowest terms always fit the safe-integer guard (byteRate ≤ 2^32). A claimed
        // decimal too wide for the guard cannot be any container's measurement anyway.
        const measuredMatches =
          Number.isSafeInteger(Number(claimed.numerator)) &&
          Number.isSafeInteger(Number(claimed.denominator)) &&
          measuredSeconds ===
            Number(claimed.numerator) / Number(claimed.denominator);
        if (!measuredMatches) {
          return refused("settlement_conflict", {
            stage: "artifact_duration_mismatch",
            measuredSeconds: String(measuredSeconds),
            carriedSeconds: req.result.actualSeconds,
          });
        }
      }

      // The seconds side must be corroborated by the lock: `audio_output` is the
      // vocabulary's own per-output-second slot for this capability, so the locked basis
      // that admitted the call carries the per-second price there — and a tier whose
      // price the lock cannot confirm is not the price this settlement bills.
      const lockedPerSecond = resolved.dims.audio_output;
      if (lockedPerSecond.status === "unknown") {
        return refused("price_unknown", {
          dimension: "audio_output",
          reason: lockedPerSecond.reason,
          snapshotVersion: basis.snapshotVersion,
          stage: "tier_corroboration",
        });
      }
      const tierPerSecond = parseExactDecimal(req.priced.perOutputSecondUsd);
      const lockedPerSecondExact = parseExactDecimal(lockedPerSecond.amount);
      if (
        tierPerSecond === null ||
        lockedPerSecondExact === null ||
        tierPerSecond.numerator * lockedPerSecondExact.denominator !==
          lockedPerSecondExact.numerator * tierPerSecond.denominator
      ) {
        return refused("price_basis_not_found", {
          stage: "tier_not_corroborated",
          dimension: "audio_output",
          lockedAmount:
            lockedPerSecond.status === "known" ? lockedPerSecond.amount : null,
          carriedAmount: req.priced.perOutputSecondUsd,
        });
      }

      // The surcharge rides the locked dims, exactly as the ceiling priced it.
      const surcharge = resolved.dims.surcharge_per_request;
      if (surcharge.status === "unknown") {
        return refused("price_unknown", {
          dimension: "surcharge_per_request",
          reason: surcharge.reason,
          snapshotVersion: basis.snapshotVersion,
        });
      }
      const perChar = parseExactDecimal(req.priced.perInputCharacterUsd);
      const perSecond = tierPerSecond;
      const perRequest = parseExactDecimal(surcharge.amount);
      if (perChar === null || perSecond === null || perRequest === null) {
        return refused("price_unknown", {
          dimension: "audio_output",
          reason: "price_dim_unreadable",
          snapshotVersion: basis.snapshotVersion,
        });
      }
      if (resolved.rate.numerator <= 0n || resolved.rate.denominator <= 0n) {
        return refused("price_basis_not_found", {
          rateVersion: basis.rateVersion,
          reason: "rate_invalid",
        });
      }

      // The actual usage, priced exactly: characters × perChar + seconds × perSecond +
      // 1 × perRequest, over one common denominator, × the locked rate × the ledger's
      // scale — BigInt rationals end to end, one upward rounding at the charge.
      const seconds = exactDecimal(req.result.actualSeconds);
      if (seconds === null) {
        // Unreachable behind the request validation; kept so the pricing below never
        // divides by a string it could not read exactly.
        return refused("request_invalid", { field: "result.actualSeconds" });
      }
      const charCost = {
        numerator: BigInt(req.requested.inputCharacters) * perChar.numerator,
        denominator: perChar.denominator,
      };
      const secondCost = {
        numerator: seconds.numerator * perSecond.numerator,
        denominator: seconds.denominator * perSecond.denominator,
      };
      const requestCost = perRequest;
      const common =
        charCost.denominator * secondCost.denominator * requestCost.denominator;
      const costNumerator =
        charCost.numerator * secondCost.denominator * requestCost.denominator +
        secondCost.numerator * charCost.denominator * requestCost.denominator +
        requestCost.numerator * charCost.denominator * secondCost.denominator;
      const scaledNumerator =
        costNumerator * resolved.rate.numerator * BigInt(CREDIT_SCALE);
      const scaledDenominator = common * resolved.rate.denominator;
      const exact = reduce(scaledNumerator, scaledDenominator);
      const chargeCeiling =
        exact.numerator === 0n
          ? 0n
          : (exact.numerator + exact.denominator - 1n) / exact.denominator;
      if (chargeCeiling > MAX_STORED_UNITS) {
        return refused("charge_exceeds_ledger", {
          snapshotVersion: basis.snapshotVersion,
          rateVersion: basis.rateVersion,
        });
      }

      const line: SpeechSettlementLine = {
        inputCharacters: req.requested.inputCharacters,
        voiceTier: req.requested.voiceTier,
        cappedSeconds: req.requested.durationCapSeconds,
        actualSeconds: req.result.actualSeconds,
        perInputCharacterUsd: req.priced.perInputCharacterUsd,
        perOutputSecondUsd: req.priced.perOutputSecondUsd,
      };

      try {
        const settled = await writer.settleReservation({
          reservationId,
          actual: exact,
          title: `settle speech ${basis.provider}/${basis.model}`,
          requestId: req.result.evidence.reference ?? null,
          model: basis.model,
          lineDetail: {
            capability: "speech",
            inputCharacters: req.requested.inputCharacters,
            cappedSeconds: req.requested.durationCapSeconds,
            actualSeconds: req.result.actualSeconds,
            perInputCharacterUsd: req.priced.perInputCharacterUsd,
            perOutputSecondUsd: req.priced.perOutputSecondUsd,
            voiceTier: req.requested.voiceTier,
          },
        });
        return {
          status: "settled",
          reservationId,
          attemptId: attemptIdForReservation(reservationId),
          chargedCredits: settled.chargedCents,
          appliedCredits: settled.appliedCents,
          releasedCredits: settled.releasedCents,
          actualCost: {
            numerator: exact.numerator.toString(),
            denominator: exact.denominator.toString(),
          },
          remainder: {
            numerator: settled.remainder.numerator.toString(),
            denominator: settled.remainder.denominator.toString(),
          },
          line,
        };
      } catch (error) {
        if (error instanceof CreditReservationConflictError) {
          // The writer's own stable kinds (no_such_reservation / reservation_released /
          // settled_with_different_actual): a same-actual replay never reaches here — the
          // writer answers the first result as a normal return, carrying the stored
          // charge, and the line above is the same one the first settlement wrote.
          return refused("settlement_conflict", {
            kind: error.conflictKind,
            reason: error.message,
          });
        }
        throw error;
      }
    },
  };
}
