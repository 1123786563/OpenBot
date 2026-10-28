import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Database } from "../db/client";
import { billingCustomers } from "../db/schema/billing";
import { creditReservations } from "../db/schema/credit-reservations";
import { RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS } from "./credit-reserve";
import type { CreditServiceVariables } from "./credit-service-auth";
import {
  CreditReservationConflictError,
  createCreditWriter,
} from "./credits-writer";
import { attemptIdForReservation } from "./reservation-status";

/**
 * The Release protocol surface (Bifrost #262, 06.11; the AC15 "确认未计费" half).
 *
 * RELEASE IS A CLAIM THAT MUST CARRY ITS PROOF. Handing a hold back erases the one
 * thing strict billing stands on — the occupied capacity — so the request must carry
 * verifiable no-charge evidence ({ reservationId, reason, noChargeEvidence }), and a
 * message whose evidence is missing, malformed, or outside the closed no-charge
 * vocabulary refuses. The vocabulary is the same one the internal failure path
 * answers to (usage-evidence.ts's CONFIRMED_NO_COST_REASONS): the provider refused
 * before producing anything, admission refused before the provider was called, or
 * the provider reported a finish with zero usage. What is deliberately NOT a member —
 * because none of it proves no cost was produced — is everything 06.8 exists for:
 * a client disconnect, a stream error, a cancellation, a timeout, a missing usage
 * report. Those go through markReservationUnknown and stay occupied for recovery
 * (08.x); they can never dress a guess up as a confirmed no-cost here.
 *
 * WHAT THIS DOOR OPENS, AND WHAT IT NEVER OPENS. A plain `reserved` hold releases
 * (the writer's transactional release — the same terminal write every release face
 * goes through). A hold whose outcome is `unknown` refuses with the stable kind
 * `reservation_unknown`: the provider may have produced billable work nobody
 * reported, so only 08.x's recovery flow or an evidenced admin disposal may move it,
 * through `releaseUnknownReservation`. A `settled` hold refuses with
 * `reservation_settled`: a charge exists, and a release arriving after a settlement
 * cannot stand — answering "released" would misreport exactly once. A hold that does
 * not exist refuses with `no_such_reservation` — never a silent success for a name
 * nobody issued. A `released` hold answers the FIRST terminal result: the release is
 * idempotent, and a replay changes nothing (the writer's own terminal-state
 * discipline, surfaced as 200-with-the-same-answer).
 *
 * WHOSE ACCOUNT. The reservation's own, resolved server-side from the row: the
 * request names no account, and any self-reported account key — top level or inside
 * the evidence — refuses as `payer_conflict` at the shape boundary, the same
 * discipline reserve (06.4), settle (06.9) and status (06.7) keep.
 *
 * ONE TERMINAL WRITE, RACE-FREE. The service runs ONE transaction that takes the
 * reservation's customer lock FIRST — the same lock, in the same order, every settle
 * and release of that customer takes — then reads the row and calls the credit writer
 * constructed OVER the same transaction handle (the reserve path's SAVEPOINT
 * composition): a concurrent settle either commits before the lock is granted (the
 * release's read sees `settled` and refuses with `reservation_settled`) or waits
 * until the release commits (and then refuses itself with `reservation_released`).
 * There is no window in which a hold both releases and settles, no window in which
 * the service reads `reserved` but the writer's transactional re-read finds something
 * else, and no lock-order cycle between the two paths.
 *
 * WHO CALLS THIS. The deployment's Bifrost admission extension, authenticated by
 * 06.1's service identity; the surface mounts at `POST /release` inside that guard,
 * composed next to the Reserve, Status and Settle endpoints by whoever wires the
 * protocol routes.
 */

/** The closed refusal vocabulary. A new member is a contract change, never a free string. */
export const RELEASE_REFUSAL_REASONS = [
  "request_invalid",
  "payer_conflict",
  "release_conflict",
] as const;

export type CreditReleaseRefusalReasonCode =
  (typeof RELEASE_REFUSAL_REASONS)[number];

/** One line, shown on every surface, per refusal code — the settle surface's discipline. */
export const RELEASE_REFUSAL_SENTENCES: Record<
  CreditReleaseRefusalReasonCode,
  string
> = {
  request_invalid: "The release request is not a valid release request.",
  payer_conflict:
    "The request names a payment account; the account is fixed by the reservation and self-reported accounts are refused.",
  release_conflict:
    "The release conflicts with the reservation's recorded state.",
};

/**
 * The no-charge evidence kinds a release message may stand on. The closed set IS the
 * internal path's confirmed-no-cost vocabulary (usage-evidence.ts — one truth, two
 * faces; `release-semantics.integration.test.ts` pins the correspondence so the two
 * cannot drift). A client disconnect, a stream error, a cancellation, a timeout and
 * a missing usage report are deliberately absent: none of them proves no cost was
 * produced, and each is 06.8's unknown path, never a release.
 */
export const RELEASE_NO_CHARGE_EVIDENCE_KINDS = [
  /** The provider refused before producing anything. */
  "provider_error",
  /** Admission refused before the provider was called. */
  "bound_refused",
  /** The provider reported a finish with zero usage. */
  "no_usage",
] as const;

export type ReleaseNoChargeEvidenceKind =
  (typeof RELEASE_NO_CHARGE_EVIDENCE_KINDS)[number];

/** What the no-charge claim stands on. `reference` is the verifiable trail id. */
export type ReleaseNoChargeEvidence = {
  kind: ReleaseNoChargeEvidenceKind;
  reference?: string;
};

/** The Release request contract (the ticket's Produces list, as the wire carries it). */
export type CreditReleaseRequest = {
  /** The reservation being handed back, unused. */
  reservationId: string;
  /** Why the hold is being released — the trail text the reservation row carries. */
  reason: string;
  /** The verifiable no-charge proof; a release without one refuses. */
  noChargeEvidence: ReleaseNoChargeEvidence;
};

/** What a release answers: the terminal result, or a refusal that names its reason. */
export type CreditReleaseOutcome =
  | {
      status: "released";
      reservationId: string;
      /** The same attempt identity every response about this reservation carries. */
      attemptId: string;
      /** Held capacity handed back unused (the hold's whole ceiling, applied 0). */
      releasedCredits: number;
    }
  | {
      status: "refused";
      reasonCode: CreditReleaseRefusalReasonCode;
      /** The refused request's own facts — never another subject's data. */
      detail: Record<string, unknown>;
    };

export type CreditReleaseServiceDependencies = {
  database: Database;
};

export type CreditReleaseService = {
  /** Validate and release; every refusal leaves the database exactly as it was. */
  release(request: unknown): Promise<CreditReleaseOutcome>;
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
  // Case- and separator-insensitive: `external_customer_id` is the same account field as
  // `externalCustomerId`, and presence is the attempt under either spelling.
  const normalize = (key: string) => key.toLowerCase().replace(/[_-]/g, "");
  const forbidden = new Set(
    RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS.map(normalize),
  );
  for (const key of Object.keys(source)) {
    if (forbidden.has(normalize(key))) return key;
  }
  return null;
}

/** Validation's discriminated answer: a valid request, or the refusal that replaces it. */
type RequestValidation =
  | { ok: true; request: CreditReleaseRequest }
  | { ok: false; outcome: CreditReleaseOutcome };

function refused(
  reasonCode: CreditReleaseRefusalReasonCode,
  detail: Record<string, unknown> = {},
): CreditReleaseOutcome {
  return { status: "refused", reasonCode, detail };
}

/**
 * Pure shape validation — run BEFORE any database contact, so a malformed request is
 * a refusal with zero reads as well as zero writes. The account-field and
 * evidence-shape checks live here too: both are properties of the request bytes, not
 * of the database.
 */
function validateRequest(input: unknown): RequestValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "body" }),
    };
  }
  const raw = input as Record<string, unknown>;

  // The account is fixed by the reservation (06.4's boundary, release flavour): any
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

  if (
    typeof raw.reservationId !== "string" ||
    !raw.reservationId.startsWith(RESERVATION_ID_PREFIX) ||
    !RESERVATION_ID_BODY.test(
      raw.reservationId.slice(RESERVATION_ID_PREFIX.length),
    )
  ) {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "reservationId" }),
    };
  }
  if (!isIdentifier(raw.reason, 512)) {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "reason" }),
    };
  }

  // The no-charge evidence: a closed-vocabulary kind, and an optional bounded
  // reference id. This is the gate the ticket exists for — a release with no
  // evidence, an unknown kind, or one of the non-evidence shapes (a disconnect, a
  // stream error, a timeout) refuses before any read, let alone any write.
  const evidence = raw.noChargeEvidence;
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence)
  ) {
    return {
      ok: false,
      outcome: refused("request_invalid", { field: "noChargeEvidence" }),
    };
  }
  const evidenceRecord = evidence as Record<string, unknown>;
  const evidenceForeignField = findForbiddenAccountKeyField(evidenceRecord);
  if (evidenceForeignField !== null) {
    return {
      ok: false,
      outcome: refused("payer_conflict", {
        stage: "request_shape",
        field: `noChargeEvidence.${evidenceForeignField}`,
      }),
    };
  }
  if (
    !RELEASE_NO_CHARGE_EVIDENCE_KINDS.includes(
      evidenceRecord.kind as ReleaseNoChargeEvidenceKind,
    )
  ) {
    return {
      ok: false,
      outcome: refused("request_invalid", {
        field: "noChargeEvidence",
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
        field: "noChargeEvidence",
        reason: "reference",
      }),
    };
  }

  return {
    ok: true,
    request: {
      reservationId: raw.reservationId,
      reason: raw.reason,
      noChargeEvidence: {
        kind: evidenceRecord.kind as ReleaseNoChargeEvidenceKind,
        ...(evidenceRecord.reference !== undefined
          ? { reference: evidenceRecord.reference as string }
          : {}),
      },
    },
  };
}

/**
 * The Release service: pure request validation, then ONE transaction that anchors on
 * the reservation row (FOR UPDATE) and — only for a plain reserved hold — hands the
 * write to the credit writer composed over the same transaction. The verdicts above
 * the write (no such reservation / unknown / settled / already released) are the
 * release face's own contract: each answers with its stable kind, and none of them
 * writes. A defect that would somehow pass a non-reserved status into the writer's
 * path is impossible by construction here (the status was read under the row lock in
 * this transaction); a writer conflict is still surfaced with its stable kind rather
 * than swallowed, because swallowing it would be the one wrong answer.
 */
export function createCreditReleaseService(
  dependencies: CreditReleaseServiceDependencies,
): CreditReleaseService {
  return {
    async release(request: unknown): Promise<CreditReleaseOutcome> {
      const validated = validateRequest(request);
      if (!validated.ok) return validated.outcome;
      const { reservationId } = validated.request;

      return dependencies.database.transaction(async (tx) => {
        // The row's owner, unlocked: the id only names the account whose turn this is.
        const [head] = await tx
          .select({ customer: creditReservations.externalCustomerId })
          .from(creditReservations)
          .where(eq(creditReservations.id, reservationId))
          .limit(1);
        if (!head) {
          return refused("release_conflict", {
            kind: "no_such_reservation",
            reason: "no such reservation",
          });
        }
        // The customer lock, BEFORE any verdict — the same lock, in the same order,
        // every settle and release of this customer takes (the writer's own
        // discipline). A concurrent settlement either commits before this lock is
        // granted (the re-read below sees its terminal fact) or waits behind this
        // release; taking the reservation row lock first instead would order the two
        // paths' locks inconsistently and could deadlock the pair.
        await tx
          .select({ id: billingCustomers.externalId })
          .from(billingCustomers)
          .where(eq(billingCustomers.externalId, head.customer))
          .for("update");
        const [reservation] = await tx
          .select({
            status: creditReservations.status,
            maximum: creditReservations.maximum,
            released: creditReservations.released,
          })
          .from(creditReservations)
          .where(eq(creditReservations.id, reservationId))
          .limit(1);
        if (!reservation) {
          // The row vanished between the two reads (a cascaded customer delete — the
          // account columns are immutable, so nothing else can move it). Never answer
          // "released" for a name that no longer resolves.
          return refused("release_conflict", {
            kind: "no_such_reservation",
            reason: "no such reservation",
          });
        }
        if (reservation.status === "unknown") {
          // 06.8: an unknown hold's provider outcome never arrived, so the provider may
          // have produced billable work nobody reported. This door never opens for it —
          // only recovery (08.x) disposes of an unknown hold, through
          // releaseUnknownReservation, on evidence of its own.
          return refused("release_conflict", {
            kind: "reservation_unknown",
            reason:
              "the reservation's outcome is unknown; only recovery may dispose of it",
          });
        }
        if (reservation.status === "settled") {
          // A charge exists: the first terminal fact stands, and a release arriving
          // after a settlement is refused, never a retroactive "released" that would
          // misreport the money already taken.
          return refused("release_conflict", {
            kind: "reservation_settled",
            reason: "the reservation was already settled",
          });
        }
        if (reservation.status === "released") {
          // Idempotent replay: the FIRST terminal result stands, byte for byte.
          return {
            status: "released" as const,
            reservationId,
            attemptId: attemptIdForReservation(reservationId),
            releasedCredits: reservation.released ?? reservation.maximum,
          };
        }

        // Plain reserved: the writer performs its own transactional release on THIS
        // connection (SAVEPOINT inside this transaction — the reserve path's
        // composition), so the terminal write and the verdicts above share one commit.
        const writer = createCreditWriter(tx as unknown as Database);
        try {
          await writer.releaseReservation(
            reservationId,
            validated.request.reason,
          );
        } catch (error) {
          if (error instanceof CreditReservationConflictError) {
            return refused("release_conflict", {
              kind: error.conflictKind,
              reason: error.message,
            });
          }
          throw error;
        }
        return {
          status: "released" as const,
          reservationId,
          attemptId: attemptIdForReservation(reservationId),
          releasedCredits: reservation.maximum,
        };
      });
    },
  };
}

/**
 * The Release surface, composed inside `creditProtocolRoutes`'s `endpoints` slot next
 * to the Reserve, Status and Settle endpoints, so no path here exists without the
 * deployment's billing identity (06.1). A released request is one 200 carrying the
 * terminal result (the first result, on every replay); a refusal is one 422 with its
 * reason code. A defect is deliberately NOT mapped: it throws and answers 500,
 * because releasing on a defect would be the one wrong answer.
 */
export function creditReleaseEndpoints(dependencies: {
  service: CreditReleaseService;
}): Hono<{ Variables: CreditServiceVariables }> {
  const app = new Hono<{ Variables: CreditServiceVariables }>();
  app.post("/release", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        {
          error: RELEASE_REFUSAL_SENTENCES.request_invalid,
          code: "request_invalid",
          detail: { field: "body" },
        },
        422,
      );
    }
    const outcome = await dependencies.service.release(body);
    if (outcome.status === "refused") {
      return context.json(
        {
          error: RELEASE_REFUSAL_SENTENCES[outcome.reasonCode],
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
