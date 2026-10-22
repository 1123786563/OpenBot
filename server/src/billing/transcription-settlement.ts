import { eq } from "drizzle-orm";
import { createAuditStore, DEPLOYMENT_INITIATOR } from "../audit";
import type { Database } from "../db/client";
import { creditReservations } from "../db/schema/credit-reservations";
import type { ConversionRate } from "../gateway/conversion-rate";
import { PRICE_DIMENSIONS } from "../gateway/price-snapshot";
import {
  CreditReservationConflictError,
  createCreditWriter,
} from "./credits-writer";
import {
  attemptIdForReservation,
  reservationIdFromAttemptId,
} from "./reservation-status";
import {
  computeReservationCeiling,
  lockedBasisOfReservation,
  type ReservationBoundQuantities,
  type ReservationCeilingIssue,
  resolveLockedReservationBasis,
} from "./reserve-bound";

/**
 * The transcription settlement path (Bifrost 14.2, #311): what a transcription dispatch owes
 * once its result is in — priced on the server's own TRUSTED MEASUREMENT (14.1's meter, the
 * container-stated duration the hold was certified against) cross-checked against the
 * provider's real usage, with a forged client claim able to lower nothing and a conflict
 * nobody can confirm moving the hold to unknown instead of a guess.
 *
 * THREE SOURCES, ONE PRECEDENCE. A transcription carries three statements of its input
 * length, and the ticket's whole point is the order they stand in:
 *
 *   1. The client's DECLARED duration — worth exactly nothing as a price. A declaration
 *      that disagrees with the measurement is REPORTED, never adopted: the settlement
 *      writes a `billing.audio_metadata_mismatch` audit row (the claim, the measurement,
 *      the difference, the source, the trail's own timestamp) and bills on. 篡改元数据不
 *      能降低计费金额, because the claim is not an input to any arithmetic here.
 *   2. The server's MEASUREMENT — the floor. The hold was certified against it (14.1:
 *      unmeasurable is unbillable), and the settlement bills at least it, whole seconds
 *      rounded up.
 *   3. The provider's USAGE — the reality, when it arrives. Usage at or above the
 *      measurement corroborates it (and bills its own larger figure if it reports one);
 *      usage BELOW the measurement is a conflict nobody can confirm — an underreporting
 *      usage, a partial failure, a truncated file are indistinguishable from here — so
 *      the hold moves to unknown (06.8) and keeps its FULL capacity occupied. Never
 *      min(声明, 测量), never min(usage, 测量): the smaller of two claims is the one a
 *      forger would pick, and "cannot confirm" is not a discount.
 *
 * THE PRICE IS THE LOCKED VERSION'S, EXACTLY AS THE HOLD'S WAS. The reservation locked
 * (model cell, snapshotVersion, rateVersion) at admission; the settlement resolves THAT
 * combination and prices the measured seconds on `audio_input`, the usage's output tokens
 * on `output`, and the per-request surcharge — 06.5's own `computeReservationCeiling`
 * arithmetic over the actual quantities, so a hold and its settlement can never disagree
 * about what the same input costs.
 *
 * WHO CALLS THIS. The deployment's transcription settlement stage — the counterpart of
 * the chat path's 06.9 consumer — for a reservation whose locked basis is a transcription
 * cell. The request carries NO price and NO account: the price comes from the lock, the
 * account from the reservation, and the measured seconds from the same server-side meter
 * 14.1 admission ran (re-carried by the trusted stage the way 12.2's image path re-carries
 * its frozen spec).
 */

/** The closed refusal vocabulary — the settle surface's own codes, one seam over. */
export type TranscriptionSettlementRefusalReasonCode =
  | "request_invalid"
  | "settlement_conflict"
  | "price_basis_not_found"
  | "price_unknown"
  | "charge_exceeds_ledger";

/** The result a transcription stands on: real usage, or no reliable result at all. */
export type TranscriptionResult =
  | {
      /** The provider transcribed, and its own usage states what was consumed. */
      outcome: "transcribed";
      usage: {
        /** The provider's own audio-seconds figure for the transcription. */
        audioSeconds: number;
        /** The provider's own output-token count for the transcript. */
        outputTokens: number;
      };
      evidence: { kind: "provider_usage_report"; reference?: string };
    }
  | {
      /**
       * No report anyone may bill from: the stream cut, the response unreadable, the usage
       * absent. The hold settles nothing and moves to unknown (06.8) — full capacity
       * still occupied, recovery's to dispose of.
       */
      outcome: "unknown";
      reason: string;
    };

/** The Settle request contract, as the transcription stage carries it. */
export type TranscriptionSettleRequest = {
  /** The reservation being settled: exactly one of reservationId / attemptId names it. */
  reservationId?: string;
  attemptId?: string;
  /** The output-token cap 14.1 froze before dispatch — what the hold was certified against. */
  requested: { outputTokenCap: number };
  /** The trusted side: the server's own measurement, and the client's claim if it made one. */
  trusted: {
    /** 14.1's measured duration of the request's audio, in seconds (uncertified fraction kept). */
    measuredSeconds: number;
    /** The duration the client declared for the same audio, when it declared one. */
    clientDeclaredSeconds?: number;
  };
  /** What the transcription stood on. */
  result: TranscriptionResult;
  /** The settling party — an identifier, carried for the trail. */
  settledBy: string;
  idempotencyKey: string;
};

export type TranscriptionSettlementOutcome =
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
      /** The billed seconds — ceil of the larger of measurement and usage, 足额. */
      billedSeconds: number;
      /** Whether the client's declaration disagreed with the measurement (audited either way). */
      clientClaimDisagrees: boolean;
    }
  | {
      /** No reliable result, or a usage the measurement cannot confirm: the hold settled
       *  nothing, released nothing, and is marked unknown (06.8) — full capacity still
       *  occupied, recovery's to dispose of. */
      status: "unknown";
      reservationId: string;
      reason: string;
    }
  | {
      status: "refused";
      reasonCode: TranscriptionSettlementRefusalReasonCode;
      detail: Record<string, unknown>;
    };

export type TranscriptionSettlementServiceDependencies = {
  database: Database;
  /** The deployment's validated environment rate — the value lock version 0 names. */
  environmentRate?: ConversionRate;
};

function refused(
  reasonCode: TranscriptionSettlementRefusalReasonCode,
  detail: Record<string, unknown> = {},
): TranscriptionSettlementOutcome {
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

/** The tolerance a claim and a measurement must agree within to count as corroborated —
 * 14.1's own epsilon, reused so one notion of "disagrees" spans admission and settlement. */
const MEASUREMENT_EPSILON = 1e-9;

type RequestValidation =
  | { ok: true; request: TranscriptionSettleRequest; reservationId: string }
  | { ok: false; outcome: TranscriptionSettlementOutcome };

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
  const outputTokenCap = requested.outputTokenCap;
  if (
    typeof outputTokenCap !== "number" ||
    !Number.isSafeInteger(outputTokenCap) ||
    outputTokenCap <= 0
  ) {
    return {
      ok: false,
      outcome: refused("request_invalid", {
        field: "requested.outputTokenCap",
      }),
    };
  }

  const trusted = raw.trusted as Record<string, unknown> | null | undefined;
  if (trusted === null || typeof trusted !== "object") {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "trusted" }),
    };
  }
  const measuredSeconds = trusted.measuredSeconds;
  if (
    typeof measuredSeconds !== "number" ||
    !Number.isFinite(measuredSeconds) ||
    measuredSeconds <= 0
  ) {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "trusted.measuredSeconds" }),
    };
  }
  const clientDeclaredSeconds = trusted.clientDeclaredSeconds;
  if (
    clientDeclaredSeconds !== undefined &&
    (typeof clientDeclaredSeconds !== "number" ||
      !Number.isFinite(clientDeclaredSeconds) ||
      clientDeclaredSeconds < 0)
  ) {
    return {
      ok: false,
      outcome: refused("request_invalid", {
        field: "trusted.clientDeclaredSeconds",
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
  if (result.outcome === "transcribed") {
    const usage = result.usage as Record<string, unknown> | null | undefined;
    if (usage === null || typeof usage !== "object") {
      return {
        ok: false,
        outcome: refused("request_invalid", { field: "result.usage" }),
      };
    }
    const audioSeconds = usage.audioSeconds;
    if (
      typeof audioSeconds !== "number" ||
      !Number.isFinite(audioSeconds) ||
      audioSeconds <= 0
    ) {
      return {
        ok: false,
        outcome: refused("request_invalid", {
          field: "result.usage.audioSeconds",
        }),
      };
    }
    const outputTokens = usage.outputTokens;
    if (
      typeof outputTokens !== "number" ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 0
    ) {
      return {
        ok: false,
        outcome: refused("request_invalid", {
          field: "result.usage.outputTokens",
        }),
      };
    }
    // A transcript longer than the cap the hold was certified against is a defect of the
    // cutoff, never a bill.
    if (outputTokens > outputTokenCap) {
      return {
        ok: false,
        outcome: refused("request_invalid", {
          field: "result.usage.outputTokens",
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
      evidence.kind !== "provider_usage_report" ||
      (evidence.reference !== undefined &&
        !isIdentifier(evidence.reference, 512))
    ) {
      return {
        ok: false,
        outcome: refused("request_invalid", { field: "result.evidence" }),
      };
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
      requested: { outputTokenCap },
      trusted: {
        measuredSeconds,
        ...(clientDeclaredSeconds !== undefined
          ? { clientDeclaredSeconds }
          : {}),
      },
      result: raw.result as TranscriptionResult,
      settledBy: raw.settledBy as string,
      idempotencyKey: raw.idempotencyKey as string,
    },
  };
}

/**
 * The transcription settlement service. Validate, resolve the lock, AUDIT a disagreeing
 * claim, price the trusted measurement (or move the hold to unknown on an unconfirmable
 * conflict), and settle through the credit writer.
 */
export function createTranscriptionSettlementService(
  dependencies: TranscriptionSettlementServiceDependencies,
): { settle(request: unknown): Promise<TranscriptionSettlementOutcome> } {
  const writer = createCreditWriter(dependencies.database);
  const audit = createAuditStore(dependencies.database);
  return {
    async settle(request: unknown): Promise<TranscriptionSettlementOutcome> {
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

      // THE CLAIM AGAINST THE MEASUREMENT, AUDITED. A declaration that disagrees with the
      // measurement is a fact about the request, recorded whether or not anything settles:
      // the difference, the source and the trail's own timestamp, so systematic
      // under-declaration is countable. The claim itself enters no arithmetic below.
      const declared = req.trusted.clientDeclaredSeconds;
      const clientClaimDisagrees =
        declared !== undefined &&
        Math.abs(declared - req.trusted.measuredSeconds) > MEASUREMENT_EPSILON;
      if (clientClaimDisagrees) {
        await audit.insert({
          eventType: "billing.audio_metadata_mismatch",
          targetType: "credit_reservation",
          targetId: reservationId,
          initiator: DEPLOYMENT_INITIATOR,
          payload: {
            capability: "transcription",
            claimedSeconds: declared,
            measuredSeconds: req.trusted.measuredSeconds,
            // Positive = the claim aimed BELOW the measurement: the forgery's direction.
            differenceSeconds:
              Math.round(
                (req.trusted.measuredSeconds - declared) / MEASUREMENT_EPSILON,
              ) * MEASUREMENT_EPSILON,
            source: "client_declared_duration",
          },
        });
      }

      // No readable result: settle nothing, release nothing, mark the hold unknown — its
      // full capacity stays occupied for recovery (06.8).
      if (req.result.outcome === "unknown") {
        await writer.markReservationUnknown(
          reservationId,
          `transcription result unreadable: ${req.result.reason}`,
        );
        return {
          status: "unknown",
          reservationId,
          reason: req.result.reason,
        };
      }

      // THE MEASUREMENT AGAINST THE USAGE. Usage below the measurement is a conflict
      // nobody can confirm — an underreporting usage and a partial failure are
      // indistinguishable from here — so the hold keeps its full capacity as unknown,
      // exactly the AC's sentence: 冲突且无法确认时进入 unknown，保持预留.
      const usageSeconds = req.result.usage.audioSeconds;
      if (usageSeconds < req.trusted.measuredSeconds - MEASUREMENT_EPSILON) {
        const reason =
          "provider usage reports fewer audio seconds than the server measured; cannot confirm";
        await writer.markReservationUnknown(reservationId, reason);
        return { status: "unknown", reservationId, reason };
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

      // The billed seconds: the larger of measurement and usage, rounded UP to whole
      // seconds (足额) — never the smaller, never the claim.
      const usage = req.result.usage;
      const billedSeconds = Math.ceil(
        Math.max(req.trusted.measuredSeconds, usageSeconds),
      );
      const quantities = Object.fromEntries(
        PRICE_DIMENSIONS.map((dimension) => [
          dimension,
          dimension === "audio_input"
            ? billedSeconds
            : dimension === "output"
              ? usage.outputTokens
              : dimension === "surcharge_per_request"
                ? 1
                : 0,
        ]),
      ) as ReservationBoundQuantities;

      const priced = computeReservationCeiling({
        dims: resolved.dims,
        quantities,
        rate: resolved.rate,
      });
      if (!priced.ok) {
        const issue = priced.issue as ReservationCeilingIssue;
        switch (issue.code) {
          case "price_unknown":
            return refused("price_unknown", {
              dimension: issue.dimension,
              reason: issue.reason,
              snapshotVersion: basis.snapshotVersion,
            });
          case "rate_invalid":
            return refused("price_basis_not_found", {
              rateVersion: basis.rateVersion,
              reason: "rate_invalid",
            });
          case "ceiling_exceeds_ledger":
            return refused("charge_exceeds_ledger", {
              snapshotVersion: basis.snapshotVersion,
              rateVersion: basis.rateVersion,
            });
          case "quantity_invalid":
            return refused("request_invalid", {
              field: "result.usage",
              dimension: issue.dimension,
            });
        }
        throw new TypeError(
          `transcription-settlement: unhandled pricing issue ${JSON.stringify(issue)}`,
        );
      }

      try {
        const settled = await writer.settleReservation({
          reservationId,
          actual: priced.exactScaledUnits,
          title: `settle transcription ${basis.provider}/${basis.model}`,
          requestId: req.result.evidence.reference ?? null,
          model: basis.model,
        });
        return {
          status: "settled",
          reservationId,
          attemptId: attemptIdForReservation(reservationId),
          chargedCredits: settled.chargedCents,
          appliedCredits: settled.appliedCents,
          releasedCredits: settled.releasedCents,
          actualCost: {
            numerator: priced.exactScaledUnits.numerator.toString(),
            denominator: priced.exactScaledUnits.denominator.toString(),
          },
          remainder: {
            numerator: settled.remainder.numerator.toString(),
            denominator: settled.remainder.denominator.toString(),
          },
          billedSeconds,
          clientClaimDisagrees,
        };
      } catch (error) {
        if (error instanceof CreditReservationConflictError) {
          // The writer's own stable kinds (no_such_reservation / reservation_released /
          // settled_with_different_actual): a same-actual replay never reaches here — the
          // writer answers the first result as a normal return, carrying the stored charge.
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
