import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { creditReservations } from "../db/schema/credit-reservations";
import type { ConversionRate } from "../gateway/conversion-rate";
import { PRICE_DIMENSIONS } from "../gateway/price-snapshot";
import {
  CreditReservationConflictError,
  createCreditWriter,
} from "./credits-writer";
import {
  imageGenerationCeilingDims,
  imageTierPriceTableFromSnapshot,
  resolveImageTierPrice,
} from "./image-generation-pricing";
import {
  attemptIdForReservation,
  reservationIdFromAttemptId,
} from "./reservation-status";
import {
  computeReservationCeiling,
  lockedBasisOfReservation,
  type ReservationBoundQuantities,
  resolveLockedReservationBasis,
} from "./reserve-bound";

/**
 * The image-generation settlement path (Bifrost 12.2, #303): what an images dispatch owes
 * once its result is in, computed from what was ACTUALLY generated, priced at the version
 * the hold locked, and shown in the user's consumption detail as the image line it is.
 *
 * ACTUAL, NOT REQUESTED. The reservation held the requested count's worst case (12.1);
 * the settlement prices the PROVIDER-REPORTED count — the images that came back, at the
 * tier the request froze — and the ungenerated share of the hold hands back with the
 * settle (the writer's released side). A partial failure is not a special case to code
 * around: 3 of 4 generated settles 3 and releases the 4th's share, because the provider's
 * own report of 3 IS the evidence the fourth was not billed. A result with NO readable
 * report settles nothing and releases nothing — the hold is marked unknown (06.8) and
 * keeps its FULL capacity occupied for recovery, because an unverifiable outcome is not a
 * zero cost (Q12), and "the balance looks nicer" is not release evidence.
 *
 * THE PRICE IS THE LOCKED VERSION'S. The reservation locked (model cell, snapshotVersion,
 * rateVersion) at admission; the settlement resolves THAT combination and rebuilds the
 * tier table from THAT version's dims — a price sync that minted version 2 mid-flight
 * changes nothing, and a per-image price that moved between hold and settle bills at the
 * hold's terms (the same immutability 06.9's generic settlement stands on; this module
 * composes the same machinery with the one addition the image wire needs: the tier price
 * rides `image_output` through 12.1's overlay, so the locked basis prices it).
 *
 * THE LINE, WRITTEN WITH THE MONEY. The settle carries its line detail into the writer's
 * own transaction (0177): the ledger row, the terminal update and the entry a user reads —
 * the frozen spec, the actual count — land as ONE commit. The MONEY on the line is the
 * ledger row's own credits; the detail row carries the facts that make an image entry an
 * image entry, distinguishable from every other capability's consumption.
 *
 * WHO CALLS THIS. The deployment's image settlement stage — the counterpart of the chat
 * path's 06.9 consumer — for a reservation whose locked basis is an image cell. The
 * request carries NO price and NO account: the price comes from the lock, the account
 * from the reservation, exactly as the protocol's settle surface insists.
 */

/** The closed refusal vocabulary — the settle surface's own codes, one seam over. */
export type ImageSettlementRefusalReasonCode =
  | "request_invalid"
  | "payer_conflict"
  | "settlement_conflict"
  | "price_basis_not_found"
  | "price_unknown"
  | "charge_exceeds_ledger";

/** The result a generation stands on: the provider's own report, or no reliable report. */
export type ImageGenerationResult =
  | {
      /** The provider reported the images it generated and billed. */
      outcome: "generated";
      /** How many images the response carried — never more than the request certified. */
      count: number;
      /** What the count stands on; a closed vocabulary like every evidence seam here. */
      evidence: { kind: "provider_usage_report"; reference?: string };
    }
  | {
      /**
       * No report anyone may bill from: the stream cut, the response unreadable, the
       * count unverifiable. The hold settles nothing and moves to unknown (06.8) — full
       * capacity still occupied, recovery's to dispose of.
       */
      outcome: "unknown";
      reason: string;
    };

/** The Settle request contract, as the image stage carries it. */
export type ImageSettleRequest = {
  /** The reservation being settled: exactly one of reservationId / attemptId names it. */
  reservationId?: string;
  attemptId?: string;
  /** The spec 12.1 froze before dispatch — what the hold was certified against. */
  requested: {
    count: number;
    size: string | null;
    quality: string | null;
    inputImages: number;
  };
  /** What the generation stood on. */
  result: ImageGenerationResult;
  /** The settling party — an identifier, carried for the trail. */
  settledBy: string;
  idempotencyKey: string;
};

/** The image line as surfaces show it: the spec, the counts, and what it cost. */
export type ImageSettlementLine = {
  size: string | null;
  quality: string | null;
  requestedCount: number;
  generatedCount: number;
  /** The locked per-image USD the settlement priced at — an exact decimal string. */
  unitPriceUsd: string;
};

export type ImageSettlementOutcome =
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
      line: ImageSettlementLine;
    }
  | {
      /** No reliable result: the hold settled nothing, released nothing, and is marked
       *  unknown (06.8) — full capacity still occupied, recovery's to dispose of. */
      status: "unknown";
      reservationId: string;
    }
  | {
      status: "refused";
      reasonCode: ImageSettlementRefusalReasonCode;
      detail: Record<string, unknown>;
    };

export type ImageSettlementServiceDependencies = {
  database: Database;
  /** The deployment's validated environment rate — the value lock version 0 names. */
  environmentRate?: ConversionRate;
};

const IMAGE_GENERATION_MAX_COUNT = 100;

function refused(
  reasonCode: ImageSettlementRefusalReasonCode,
  detail: Record<string, unknown> = {},
): ImageSettlementOutcome {
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

type RequestValidation =
  | { ok: true; request: ImageSettleRequest; reservationId: string }
  | { ok: false; outcome: ImageSettlementOutcome };

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
    reservationId =
      typeof raw.attemptId === "string"
        ? reservationIdFromAttemptId(raw.attemptId)
        : null;
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
  const count = requested.count;
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > IMAGE_GENERATION_MAX_COUNT
  ) {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "requested.count" }),
    };
  }
  const sizeOk =
    requested.size === null ||
    (typeof requested.size === "string" &&
      requested.size.length > 0 &&
      requested.size.trim() === requested.size);
  const qualityOk =
    requested.quality === null ||
    (typeof requested.quality === "string" &&
      requested.quality.length > 0 &&
      requested.quality.trim() === requested.quality);
  if (!sizeOk || !qualityOk) {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "requested.spec" }),
    };
  }
  const inputImages = requested.inputImages ?? 0;
  if (
    typeof inputImages !== "number" ||
    !Number.isSafeInteger(inputImages) ||
    inputImages < 0
  ) {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "requested.inputImages" }),
    };
  }

  const result = raw.result as Record<string, unknown> | null | undefined;
  if (result === null || typeof result !== "object") {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "result" }),
    };
  }
  if (result.outcome === "generated") {
    const generated = result.count;
    if (
      typeof generated !== "number" ||
      !Number.isSafeInteger(generated) ||
      generated < 0 ||
      generated > count
    ) {
      return {
        ok: false,
        outcome: refused("request_invalid", {
          field: "result.count",
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
      requested: {
        count,
        size: (requested.size as string | null) ?? null,
        quality: (requested.quality as string | null) ?? null,
        inputImages,
      },
      result: raw.result as ImageGenerationResult,
      settledBy: raw.settledBy as string,
      idempotencyKey: raw.idempotencyKey as string,
    },
  };
}

/**
 * The image settlement service. Validate, resolve the lock, price the ACTUAL at the
 * LOCKED version, and settle through the credit writer with the line detail riding the
 * same transaction; an unreadable result marks the hold unknown and touches nothing else.
 */
export function createImageSettlementService(
  dependencies: ImageSettlementServiceDependencies,
): { settle(request: unknown): Promise<ImageSettlementOutcome> } {
  const writer = createCreditWriter(dependencies.database);
  return {
    async settle(request: unknown): Promise<ImageSettlementOutcome> {
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

      // No readable result: settle nothing, release nothing, mark the hold unknown — its
      // full capacity stays occupied for recovery (06.8), which is the only honest home
      // for a cost nobody can read.
      if (req.result.outcome === "unknown") {
        await writer.markReservationUnknown(
          reservationId,
          `image generation result unreadable: ${req.result.reason}`,
        );
        return { status: "unknown", reservationId };
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

      // The tier price, rebuilt from the LOCKED version's own dims — the same immutable
      // row the admission read, so hold and settlement cannot disagree about the price.
      const tierTable = imageTierPriceTableFromSnapshot(resolved.dims);
      const tier = resolveImageTierPrice(tierTable, req.requested);
      if (!tier.ok) {
        const generated = resolved.dims.image_output;
        return refused("price_unknown", {
          dimension: "image_output",
          reason:
            generated.status === "unknown"
              ? generated.reason
              : "price_dim_no_source",
          snapshotVersion: basis.snapshotVersion,
          stage: "tier_resolution",
        });
      }
      if (
        req.requested.inputImages > 0 &&
        resolved.dims.image.status === "unknown"
      ) {
        return refused("price_unknown", {
          dimension: "image",
          reason: resolved.dims.image.reason,
          snapshotVersion: basis.snapshotVersion,
        });
      }

      // The actual usage: the images that came back, the input images the request
      // carried, and nothing else — every other dimension of the vocabulary at zero.
      const generatedCount = req.result.count;
      const quantities = Object.fromEntries(
        PRICE_DIMENSIONS.map((dimension) => [
          dimension,
          dimension === "image_output"
            ? generatedCount
            : dimension === "image"
              ? req.requested.inputImages
              : 0,
        ]),
      ) as ReservationBoundQuantities;

      const priced = computeReservationCeiling({
        dims: imageGenerationCeilingDims(resolved.dims, tier.amount),
        quantities,
        rate: resolved.rate,
      });
      if (!priced.ok) {
        const issue = priced.issue;
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
              field: "result.count",
              dimension: issue.dimension,
            });
        }
        throw new TypeError(
          `image-settlement: unhandled pricing issue ${JSON.stringify(issue)}`,
        );
      }

      const line: ImageSettlementLine = {
        size: req.requested.size,
        quality: req.requested.quality,
        requestedCount: req.requested.count,
        generatedCount,
        unitPriceUsd: tier.amount,
      };

      try {
        const settled = await writer.settleReservation({
          reservationId,
          actual: priced.exactScaledUnits,
          title: `settle image ${basis.provider}/${basis.model}`,
          requestId: req.result.evidence.reference ?? null,
          model: basis.model,
          lineDetail: {
            capability: "image",
            requestedCount: req.requested.count,
            generatedCount,
            inputImages: req.requested.inputImages,
            size: req.requested.size,
            quality: req.requested.quality,
            unitPriceUsd: tier.amount,
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
            numerator: priced.exactScaledUnits.numerator.toString(),
            denominator: priced.exactScaledUnits.denominator.toString(),
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
          // settled_with_different_actual): a same-actual replay never reaches here —
          // the writer answers the first result as a normal return, carrying the stored
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
