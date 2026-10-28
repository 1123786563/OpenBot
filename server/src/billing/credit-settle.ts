import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Database } from "../db/client";
import { creditReservations } from "../db/schema/credit-reservations";
import type { ConversionRate } from "../gateway/conversion-rate";
import {
  PRICE_DIMENSIONS,
  type PriceDimension,
} from "../gateway/price-snapshot";
import { RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS } from "./credit-reserve";
import type { CreditServiceVariables } from "./credit-service-auth";
import {
  CreditReservationConflictError,
  createCreditWriter,
} from "./credits-writer";
import {
  attemptIdForReservation,
  reservationIdFromAttemptId,
} from "./reservation-status";
import {
  computeDimensionScaledUnits,
  computeReservationCeiling,
  lockedBasisOfReservation,
  type ReservationBoundQuantities,
  resolveLockedReservationBasis,
} from "./reserve-bound";

/**
 * The Settle protocol surface (Bifrost #260, 06.9; the AC07 "重复结算" half).
 *
 * ONE MESSAGE, ONE CHARGE. A settlement message may be retried any number of times before
 * its acknowledgement is durable — 07.8's outbox, a crash between the charge and the 200 —
 * and every replay must answer the FIRST result without a second charge. The idempotent
 * identity is the RESERVATION itself (the same identity the attempt id is a view of): the
 * request carries no price fields at all, the actual usage is converted through the basis
 * the reservation LOCKED at admission (06.5's `lockedBasisOfReservation` →
 * `resolveLockedReservationBasis`, the only pricing read a settlement may make), and the
 * credit writer's `settleReservation` fences the double settle on the ledger row's derived
 * key `reservation:<id>` — the same reservation settles once; a replay with a different
 * amount is a conflict, never a top-up.
 *
 * WHOSE ACCOUNT. The reservation's own, resolved server-side from the row: request,
 * reservation, settlement, remainder and recovery are fixed to the same payer (parent spec
 * / ADR 0004), so the settle request names NO account — any self-reported account key
 * refuses as `payer_conflict` at the shape boundary, the same discipline reserve (06.4)
 * and status (06.7) keep. Grant expiry at settlement is deliberately NOT revalidated here:
 * 06.10's semantics never needed a clock — admitted work settles against the grants the
 * hold locked (even lapsed ones), and the unused portion of a lapsed grant is dead because
 * the capacity read filters expired grants, not because this surface re-checks anything.
 *
 * EXACT MONEY. `computeReservationCeiling` is reused for the pricing arithmetic itself —
 * pure, BigInt rationals end to end, the same dims/rate parser admission used, so a
 * settlement and its admission can never disagree about what a usage costs. Only the
 * ceiling (a rounded integer) is discarded: the settlement converts the EXACT
 * `exactScaledUnits` into the writer's `CreditAmount`, and the per-account carried
 * remainder completes fractional units later (06.6). No float exists anywhere on this path.
 *
 * WHO CALLS THIS. The deployment's Bifrost admission extension, authenticated by 06.1's
 * service identity; the surface mounts at `POST /settle` inside that guard, composed next
 * to the Reserve and Status endpoints by whoever wires the protocol routes.
 */

/** The closed refusal vocabulary. A new member is a contract change, never a free string. */
export const SETTLE_REFUSAL_REASONS = [
  "request_invalid",
  "payer_conflict",
  "settlement_conflict",
  "price_basis_not_found",
  "price_unknown",
  "charge_exceeds_ledger",
] as const;

export type CreditSettleRefusalReasonCode =
  (typeof SETTLE_REFUSAL_REASONS)[number];

/** One line, shown on every surface, per refusal code — the reserve surface's discipline. */
export const SETTLE_REFUSAL_SENTENCES: Record<
  CreditSettleRefusalReasonCode,
  string
> = {
  request_invalid: "The settle request is not a valid settle request.",
  payer_conflict:
    "The request names a payment account; the account is fixed by the reservation and self-reported accounts are refused.",
  settlement_conflict:
    "The settlement conflicts with the reservation's recorded settlement state.",
  price_basis_not_found:
    "The reservation's locked price basis does not resolve, so the settlement cannot be priced.",
  price_unknown:
    "The locked price basis is not completely known, so the settlement cannot be billed strictly.",
  charge_exceeds_ledger:
    "The priced settlement exceeds the ledger's storage bound, so it cannot be recorded.",
};

/**
 * The usage-evidence kinds a settle message may stand on. A closed set like the reserve
 * path's bound-evidence kinds: the usage numbers must come from a mechanism, not a guess —
 * the provider's own usage report today; 07.10/07.11 name their kinds as they land.
 */
export const SETTLE_USAGE_EVIDENCE_KINDS = [
  /** The provider's final usage report for this attempt (its request/usage id may ride as `reference`). */
  "provider_usage_report",
] as const;

export type SettleUsageEvidenceKind =
  (typeof SETTLE_USAGE_EVIDENCE_KINDS)[number];

/** What the actual usage stands on. `reference` is the display id the ledger row carries. */
export type SettleUsageEvidence = {
  kind: SettleUsageEvidenceKind;
  reference?: string;
};

/** The Settle request contract (the ticket's Produces list, as the wire carries it). */
export type CreditSettleRequest = {
  /** The reservation being settled: exactly one of reservationId / attemptId names it. */
  reservationId?: string;
  attemptId?: string;
  /**
   * The actual billed usage, one quantity per dimension of the closed vocabulary (tokens,
   * seconds, images, requests — the unit is the dimension's own). Priced through the LOCKED
   * basis; never a client-chosen amount of money.
   */
  actualUsage: ReservationBoundQuantities;
  /** What the usage report stands on. */
  evidence: SettleUsageEvidence;
  /** The settling party — an identifier, carried for the trail. */
  settledBy: string;
  /**
   * The caller's retry identity for this message. The deep authority is the reservation
   * itself (one settle per reservation, fenced in the ledger); the key keeps the message's
   * own retry identity explicit for the callers that queue one.
   */
  idempotencyKey: string;
};

/** What a settle answers: the first settlement result, or a refusal that names its reason. */
export type CreditSettleOutcome =
  | {
      status: "settled";
      reservationId: string;
      /** The same attempt identity every response about this reservation carries. */
      attemptId: string;
      /** Whole scaled units (×100) charged: the exact cost plus the carried remainder, floored. */
      chargedCredits: number;
      /** What the grants absorbed of the charge; the hold caps it. */
      appliedCredits: number;
      /** Held capacity handed back unused. */
      releasedCredits: number;
      /** The exact priced cost in scaled units, lowest terms, as strings for the wire. */
      actualCost: { numerator: string; denominator: string };
      /** The fraction of a unit still owed after this settlement, lowest terms, as strings. */
      remainder: { numerator: string; denominator: string };
    }
  | {
      status: "refused";
      reasonCode: CreditSettleRefusalReasonCode;
      /** The refused request's own facts — never another subject's data. */
      detail: Record<string, unknown>;
    };

export type CreditSettleServiceDependencies = {
  database: Database;
  /**
   * The deployment's validated environment rate — the value the lock's rate version 0
   * names. Absent only where no environment rate is configured (then a version-0 lock
   * refuses as `price_basis_not_found`, never falls back to something else).
   */
  environmentRate?: ConversionRate;
};

export type CreditSettleService = {
  /** Validate and settle; every refusal leaves the database exactly as it was. */
  settle(request: unknown): Promise<CreditSettleOutcome>;
};

/** Identifier-shaped string: non-empty, bounded, no leading or trailing whitespace. */
function isIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

/** The reservation id shape the credit writer mints: `cr-` plus 8 random bytes as hex. */
const RESERVATION_ID_PREFIX = "cr-";
const RESERVATION_ID_BODY = /^[0-9a-f]{16}$/;

/** The forbidden field present in a request's own spelling, or null. Presence is the attempt. */
function findForbiddenAccountKeyField(
  source: Record<string, unknown>,
): string | null {
  const forbidden = new Set(
    RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS.map((key) => key.toLowerCase()),
  );
  for (const key of Object.keys(source)) {
    if (forbidden.has(key.toLowerCase())) return key;
  }
  return null;
}

/** Validation's discriminated answer: a valid request, or the refusal that replaces it. */
type RequestValidation =
  | { ok: true; request: CreditSettleRequest }
  | { ok: false; outcome: CreditSettleOutcome };

function refused(
  reasonCode: CreditSettleRefusalReasonCode,
  detail: Record<string, unknown> = {},
): CreditSettleOutcome {
  return { status: "refused", reasonCode, detail };
}

/**
 * Pure shape validation — run BEFORE any database contact, so a malformed request is a
 * refusal with zero reads as well as zero writes. The account-field and evidence-shape
 * checks live here too: both are properties of the request bytes, not of the database.
 */
function validateRequest(input: unknown): RequestValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "body" }),
    };
  }
  const raw = input as Record<string, unknown>;

  // The account is fixed by the reservation (06.4's boundary, settle flavour): any
  // self-reported account key — at the top level or inside the evidence — is the tamper
  // shape, refused rather than silently ignored.
  const foreignField = findForbiddenAccountKeyField(raw);
  if (foreignField !== null) {
    return {
      ok: false,
      outcome: refused("payer_conflict", {
        stage: "request_shape",
        field: foreignField,
      }),
    };
  }

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
  if (
    hasReservationId &&
    (typeof raw.reservationId !== "string" ||
      !raw.reservationId.startsWith(RESERVATION_ID_PREFIX) ||
      !RESERVATION_ID_BODY.test(
        raw.reservationId.slice(RESERVATION_ID_PREFIX.length),
      ))
  ) {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "reservationId" }),
    };
  }
  if (
    hasAttemptId &&
    (typeof raw.attemptId !== "string" ||
      reservationIdFromAttemptId(raw.attemptId) === null)
  ) {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "attemptId" }),
    };
  }

  // The actual usage: every dimension of the closed vocabulary, a non-negative whole
  // count of that dimension's unit. An absent dimension, a fraction or a negative is a
  // defective message — and a key outside the vocabulary proves the caller is billing a
  // dimension this deployment cannot price, which refuses too.
  const usage = raw.actualUsage;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "actualUsage" }),
    };
  }
  const usageRecord = usage as Record<string, unknown>;
  const knownDimensions = new Set<string>(PRICE_DIMENSIONS);
  for (const key of Object.keys(usageRecord)) {
    if (!knownDimensions.has(key)) {
      return {
        ok: false,
        outcome: refused("request_invalid", {
          field: "actualUsage",
          reason: "unknown_dimension",
          dimension: key,
        }),
      };
    }
  }
  const actualUsage: Record<PriceDimension, number> = {} as Record<
    PriceDimension,
    number
  >;
  for (const dimension of PRICE_DIMENSIONS) {
    const quantity = usageRecord[dimension];
    if (
      typeof quantity !== "number" ||
      !Number.isSafeInteger(quantity) ||
      quantity < 0
    ) {
      return {
        ok: false,
        outcome: refused("request_invalid", {
          field: "actualUsage",
          dimension,
        }),
      };
    }
    actualUsage[dimension] = quantity;
  }

  // The evidence: a closed-vocabulary kind, and an optional bounded reference id.
  const evidence = raw.evidence;
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence)
  ) {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "evidence" }),
    };
  }
  const evidenceRecord = evidence as Record<string, unknown>;
  const evidenceForeignField = findForbiddenAccountKeyField(evidenceRecord);
  if (evidenceForeignField !== null) {
    return {
      ok: false,
      outcome: refused("payer_conflict", {
        stage: "request_shape",
        field: `evidence.${evidenceForeignField}`,
      }),
    };
  }
  if (
    !SETTLE_USAGE_EVIDENCE_KINDS.includes(
      evidenceRecord.kind as SettleUsageEvidenceKind,
    )
  ) {
    return {
      ok: false,
      outcome: refused("request_invalid", {
        field: "evidence",
        reason: "kind",
      }),
    };
  }
  if (
    evidenceRecord.reference !== undefined &&
    !isIdentifier(evidenceRecord.reference, 512)
  ) {
    return {
      ok: false,
      outcome: refused("request_invalid", {
        field: "evidence",
        reason: "reference",
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
    request: {
      ...(hasReservationId
        ? { reservationId: raw.reservationId as string }
        : { attemptId: raw.attemptId as string }),
      actualUsage,
      evidence: {
        kind: evidenceRecord.kind as SettleUsageEvidenceKind,
        ...(evidenceRecord.reference !== undefined
          ? { reference: evidenceRecord.reference as string }
          : {}),
      },
      settledBy: raw.settledBy as string,
      idempotencyKey: raw.idempotencyKey as string,
    },
  };
}

/**
 * The Settle service: pure request validation, then the locked-basis resolution, the
 * exact pricing, and the credit writer's own atomic settlement. The writer's transaction
 * is the atomic unit — the pricing reads above it stand on append-only facts (the
 * reservation's lock fields are written once at admission; a version's prices and rate are
 * immutable), so there is no mutable state a concurrent caller could corrupt between them.
 * A refusal never reaches a write; a conflict (`settlement_conflict`) is the writer's own
 * verdict surfaced with its stable kind (06.10): `no_such_reservation`,
 * `reservation_released`, or `settled_with_different_actual` — the closed conflict
 * vocabulary `settle-conflict-grant-expiry.integration.test.ts` pins.
 */
export function createCreditSettleService(
  dependencies: CreditSettleServiceDependencies,
): CreditSettleService {
  const writer = createCreditWriter(dependencies.database);
  return {
    async settle(request: unknown): Promise<CreditSettleOutcome> {
      const validated = validateRequest(request);
      if (!validated.ok) return validated.outcome;
      const { reservationId: namedReservationId, attemptId } =
        validated.request;
      const reservationId =
        namedReservationId ?? reservationIdFromAttemptId(attemptId ?? "");
      if (reservationId === null) {
        // Unreachable behind validation; kept so the flow below never asserts.
        return refused("request_invalid", { field: "attemptId" });
      }

      // The reservation row is the settle's anchor: it names the account (never the
      // request) and carries the pricing basis the settlement must resolve (06.5).
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
      const basis = lockedBasisOfReservation(reservation);
      if (basis === null) {
        // A hold without a lock has no basis anyone may price from — refuse rather than
        // consulting the latest prices (the one wrong answer this ticket exists to fence).
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

      // The exact pricing, through the same pure arithmetic admission used. The ceiling
      // member of the answer is admission's concern; the settlement converts the EXACT
      // scaled cost and lets the writer floor it against the carried remainder.
      const priced = computeReservationCeiling({
        dims: resolved.dims,
        quantities: validated.request.actualUsage,
        rate: resolved.rate,
      });
      if (!priced.ok) {
        const issue = priced.issue;
        switch (issue.code) {
          case "quantity_invalid":
            return refused("request_invalid", {
              field: "actualUsage",
              dimension: issue.dimension,
              stage: "pricing",
            });
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
        }
        // Unreachable while the issue vocabulary above is covered; a loud defect — never
        // a silent fall-through that could settle a cost nobody priced.
        throw new TypeError(
          `credit-settle: unhandled pricing issue ${JSON.stringify(issue)}`,
        );
      }

      // The per-dimension split (20.3): the same dims/quantities/rate the total priced,
      // computed per dimension through the same exact arithmetic — the split the
      // consumption detail separates model fees from surcharge fees on. Derived, never
      // accepted from the caller, so it cannot disagree with the total it splits.
      const split = computeDimensionScaledUnits({
        dims: resolved.dims,
        quantities: validated.request.actualUsage,
        rate: resolved.rate,
      });
      // An all-zero usage (a free settle, a failed job billed at a real zero) splits into
      // no members: an empty breakdown explains nothing the ledger row does not already
      // say, and the writer's own allocation check refuses a breakdown with no rows — so
      // it is omitted, exactly as a split that could not compute is.
      const dimensionBreakdown =
        split.ok && split.members.length > 0 ? split.members : undefined;

      try {
        const settled = await writer.settleReservation({
          reservationId,
          actual: priced.exactScaledUnits,
          title: `settle ${basis.provider}/${basis.model}`,
          requestId: validated.request.evidence.reference ?? null,
          model: basis.model,
          ...(dimensionBreakdown !== undefined ? { dimensionBreakdown } : {}),
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
        };
      } catch (error) {
        if (error instanceof CreditReservationConflictError) {
          // 06.10's conflict contract: the refusal carries the stable kind of the class
          // (no_such_reservation / reservation_released / settled_with_different_actual)
          // so a caller distinguishes the classes without parsing a message — and never
          // silently overwrites the first terminal fact either way.
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

/**
 * The Settle surface, composed next to the Reserve and Status endpoints inside
 * `creditProtocolRoutes`'s guard, so no path here exists without the deployment's billing
 * identity (06.1). A settled request is one 200 carrying the FIRST result; a refusal is
 * one 422 with its reason code. A defect (a half-locked row the table should never have
 * admitted) is deliberately NOT mapped: it throws and answers 500, because settling a
 * defect would be the one wrong answer.
 */
export function creditSettleEndpoints(dependencies: {
  service: CreditSettleService;
}): Hono<{ Variables: CreditServiceVariables }> {
  const app = new Hono<{ Variables: CreditServiceVariables }>();
  app.post("/settle", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        {
          error: SETTLE_REFUSAL_SENTENCES.request_invalid,
          code: "request_invalid",
          detail: { field: "body" },
        },
        422,
      );
    }
    const outcome = await dependencies.service.settle(body);
    if (outcome.status === "refused") {
      return context.json(
        {
          error: SETTLE_REFUSAL_SENTENCES[outcome.reasonCode],
          code: outcome.reasonCode,
          detail: outcome.detail,
        },
        422,
      );
    }
    return context.json(outcome, 200);
  });
  return app;
}
