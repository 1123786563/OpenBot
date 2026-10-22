import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Database } from "../db/client";
import { accessGrants } from "../db/schema";
import { creditReservations } from "../db/schema/credit-reservations";
import type { CreditServiceVariables } from "./credit-service-auth";
import { type PayerRef, payerKey } from "./payer";
import { COMPANY_SCOPE_IDENTITY_FIELDS } from "./personal-key-isolation";

/**
 * The reservation Status query and the attempt identity (Bifrost #258, 06.7).
 *
 * WHY THIS MODULE EXISTS. A reserve can succeed at the ledger and still never be seen: the
 * 201 response is lost between the hold and the caller, and the caller is left holding an
 * idempotency key and a question. Recovery has two doors, and both answer the ORIGINAL
 * reservation without ever creating a second hold. Door one is the reserve replay itself —
 * the same idempotency key answers the original reservation (06.3's writer semantics). Door
 * two is this module's Status query: by reservationId or by attemptId it answers what became
 * of the hold — reserved, settled, released, or unknown — so the caller can decide to settle,
 * release, or keep waiting without admitting the work twice.
 *
 * THE ATTEMPT IDENTITY. An attemptId is minted per reservation as `att-` followed by the
 * reservation id's random body — a pure, total function of the reservation id, which IS the
 * persisted attempt↔reservation mapping the 06.2 plan deferred to this ticket. Because the
 * mapping is a function and not a row, every response about the same reservation carries the
 * SAME attemptId on first issue and on every replay (a lost response recovers an identity,
 * not a new one), and a Status query resolves an attemptId back to its reservation with no
 * extra storage and no addition to the migration chain. The reverse mapping validates the
 * shape and answers null for anything that cannot be a reservation id — an unresolvable
 * attempt id is an `unknown` answer, never a guess.
 *
 * WHAT A QUERY MAY SEE. The status query is scoped by the grant the caller works under: the
 * server reads the grant row and resolves the payment account FROM it (the same server-side
 * resolution the reserve performs — the request names no account and any self-reported
 * account key is refused as `payer_conflict`, 06.4's boundary), then answers only if the
 * reservation belongs to exactly that account. Another account's reservation — and an
 * unknown grant's view of anything — answers `unknown`, the same word as a reservation that
 * does not exist, so an answer never leaks that some other account's hold exists. Visibility
 * is deliberately not admission: a grant revoked after the reserve still answers, because
 * the hold it admitted still occupies credit and its account can still ask what became of it.
 *
 * WHAT A QUERY MAY DO. Nothing. Every statement here is a SELECT; there is no transaction,
 * no lock, no write, and no customer floor — a status answer is assembled entirely from rows
 * that were already on disk. A query that cannot be answered refuses at the shape boundary
 * (`request_invalid`) with zero reads.
 *
 * THE LOCKED VERSIONS. The Status contract carries the reservation's locked price-basis
 * versions. This worktree has no locked-basis persistence yet (06.5's version locking is
 * still in fix), so the versions are answered as null — never a fabricated or re-derived
 * number — and the same fields start carrying the persisted values the moment 06.5 lands.
 *
 * WHO CALLS THIS. The same deployment-trusted Bifrost admission extension that reserves,
 * authenticated by 06.1's service identity: the endpoints here are mounted inside
 * `creditProtocolRoutes`'s guard via `creditProtocolEndpoints`'s optional status slot.
 */

/** The attempt id prefix; the body after it is the reservation id's own random body. */
export const ATTEMPT_ID_PREFIX = "att-";

/** The reservation id shape the credit writer mints: `cr-` plus 8 random bytes as hex. */
const RESERVATION_ID_PREFIX = "cr-";
const RESERVATION_ID_BODY = /^[0-9a-f]{16}$/;

/**
 * The attempt id of a reservation: a bijective view of its reservation id. Every response
 * about the same reservation — first issue, idempotent replay — carries the same value.
 */
export function attemptIdForReservation(reservationId: string): string {
  const body = reservationId.startsWith(RESERVATION_ID_PREFIX)
    ? reservationId.slice(RESERVATION_ID_PREFIX.length)
    : "";
  if (!RESERVATION_ID_BODY.test(body)) {
    // The writer's id format is a delivered contract (credits-writer.ts mints `cr-<16hex>`).
    // A reservation id outside it would silently produce an attempt id no Status query could
    // resolve back — refuse loudly at the mint instead.
    throw new TypeError(
      `attemptIdForReservation: not a writer-minted reservation id: ${reservationId}`,
    );
  }
  return `${ATTEMPT_ID_PREFIX}${body}`;
}

/** The reservation an attempt id names, or null when the shape cannot be one. */
export function reservationIdFromAttemptId(attemptId: string): string | null {
  if (!attemptId.startsWith(ATTEMPT_ID_PREFIX)) return null;
  const body = attemptId.slice(ATTEMPT_ID_PREFIX.length);
  return RESERVATION_ID_BODY.test(body)
    ? `${RESERVATION_ID_PREFIX}${body}`
    : null;
}

/**
 * The Status request contract. The grant is the query's scope; exactly one of reservationId
 * or attemptId names the reservation. No account field exists here on purpose — the account
 * is resolved from the grant, and a self-reported one is the 06.4 tamper shape.
 */
export type ReservationStatusRequest = {
  grantId: string;
  reservationId?: string;
  attemptId?: string;
};

/**
 * What a Status query answers: one of the five closed states. `unknown` covers every case
 * the query may not distinguish — a reservation that does not exist, one that belongs to
 * another account, a grant that scopes nothing — so an answer never leaks existence; in that
 * bare shape NOTHING but `status` rides along. The answered variant can also carry
 * `"unknown"` for a reservation that EXISTS but whose provider result never arrived (06.8):
 * the two unknowns are told apart by the facts they carry — the answered one always names
 * the reservation. The locked versions are null until 06.5's locked-basis persistence
 * integrates.
 */
export type CreditReservationStatusOutcome =
  | {
      status: "reserved" | "unknown" | "settled" | "released";
      attemptId: string;
      reservationId: string;
      maximumCredits: number;
      snapshotVersion: null;
      rateVersion: null;
      /** When the hold was taken. */
      createdAt: string;
      /** When recovery may release an unanswered hold (the reservation's own TTL). */
      expiresAt: string;
      /** When the hold reached its terminal state, if it has. */
      terminalAt: string | null;
      /** When the hold entered the unknown-result state (06.8), if it ever did. */
      unknownAt: string | null;
      /** Why the hold entered the unknown-result state (06.8), if it ever did. */
      unknownReason: string | null;
    }
  | { status: "unknown" };

/**
 * A Status query either answers (a 200 carrying one of the four states) or refuses at the
 * shape boundary (a 422 carrying a reason from the protocol's closed vocabulary). A refusal
 * is not a state: it says the REQUEST was defective, never that a reservation is or is not.
 */
export type ReservationStatusAnswer =
  | { kind: "answered"; outcome: CreditReservationStatusOutcome }
  | {
      kind: "refused";
      reasonCode: "request_invalid" | "payer_conflict";
      detail: Record<string, unknown>;
    };

/**
 * The account-identity fields a status request must never carry (06.4's boundary; 09.3
 * extends it with the company-scope selectors, the elevation twin of an account name).
 */
export const STATUS_FORBIDDEN_ACCOUNT_KEY_FIELDS = [
  "userId",
  "externalCustomerId",
  "payerId",
  "accountId",
  "customerKey",
  "companyId",
  "tenantId",
  ...COMPANY_SCOPE_IDENTITY_FIELDS,
] as const;

/** The forbidden field present in a request's own spelling, or null. Presence is the attempt. */
function findForbiddenAccountKeyField(
  source: Record<string, unknown>,
): string | null {
  const forbidden = new Set(
    STATUS_FORBIDDEN_ACCOUNT_KEY_FIELDS.map((key) => key.toLowerCase()),
  );
  for (const key of Object.keys(source)) {
    if (forbidden.has(key.toLowerCase())) return key;
  }
  return null;
}

function isIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

/** The one displayable sentence per refusal code on this surface. */
const STATUS_REFUSAL_SENTENCES: Record<
  "request_invalid" | "payer_conflict",
  string
> = {
  request_invalid: "The status request is not a valid status request.",
  payer_conflict:
    "The request names a payment account; the account is resolved server-side from the scope grant and self-reported accounts are refused.",
};

/** Validation's discriminated answer: a valid request, or the refusal that replaces it. */
type StatusRequestValidation =
  | { ok: true; request: ReservationStatusRequest }
  | {
      ok: false;
      reasonCode: "request_invalid" | "payer_conflict";
      detail: Record<string, unknown>;
    };

/**
 * Pure shape validation — run BEFORE any database contact, so a malformed request is a
 * refusal with zero reads as well as zero writes.
 */
function validateStatusRequest(input: unknown): StatusRequestValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      reasonCode: "request_invalid",
      detail: { field: "body" },
    };
  }
  const raw = input as Record<string, unknown>;

  const foreignField = findForbiddenAccountKeyField(raw);
  if (foreignField !== null) {
    return {
      ok: false,
      reasonCode: "payer_conflict",
      detail: { stage: "request_shape", field: foreignField },
    };
  }

  if (!isIdentifier(raw.grantId, 512)) {
    return {
      ok: false,
      reasonCode: "request_invalid",
      detail: { field: "grantId" },
    };
  }

  const hasReservationId = raw.reservationId !== undefined;
  const hasAttemptId = raw.attemptId !== undefined;
  if (hasReservationId === hasAttemptId) {
    return {
      ok: false,
      reasonCode: "request_invalid",
      detail: {
        field: "reservationId",
        reason: "exactly_one_of_reservationId_attemptId",
      },
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
      reasonCode: "request_invalid",
      detail: { field: "reservationId" },
    };
  }
  if (
    hasAttemptId &&
    reservationIdFromAttemptId(raw.attemptId as string) === null
  ) {
    return {
      ok: false,
      reasonCode: "request_invalid",
      detail: { field: "attemptId" },
    };
  }

  return {
    ok: true,
    request: {
      grantId: raw.grantId as string,
      ...(hasReservationId
        ? { reservationId: raw.reservationId as string }
        : { attemptId: raw.attemptId as string }),
    },
  };
}

export type ReservationStatusServiceDependencies = {
  database: Database;
};

export type ReservationStatusService = {
  /** Read-only status lookup scoped by the request's grant. Never writes. */
  queryStatus(request: unknown): Promise<ReservationStatusAnswer>;
};

/**
 * The Status service: shape validation, then two plain reads — the scope grant and the
 * reservation — and nothing else. No transaction, because no invariant spans the two reads:
 * the grant's account resolution is derived per read, and a reservation row is immutable in
 * the fields this answer reports except by the writer's own mark-unknown/settle/release
 * transitions, which a status query never races into corruption (it answers whatever
 * committed state it sees). Another account's reservation and an unresolvable scope both
 * answer `unknown`.
 */
export function createReservationStatusService(
  dependencies: ReservationStatusServiceDependencies,
): ReservationStatusService {
  return {
    async queryStatus(request: unknown): Promise<ReservationStatusAnswer> {
      const validated = validateStatusRequest(request);
      if (!validated.ok) {
        return {
          kind: "refused",
          reasonCode: validated.reasonCode,
          detail: validated.detail,
        };
      }
      const { grantId, reservationId: scopedReservationId } = validated.request;
      const reservationId =
        scopedReservationId ??
        reservationIdFromAttemptId(validated.request.attemptId ?? "");
      if (reservationId === null) {
        return { kind: "answered", outcome: { status: "unknown" } };
      }

      // Scope first: the account is resolved from the grant row alone. A grant this server
      // cannot resolve into an account (missing, or a scope with no resolution) scopes
      // nothing, and a scope that sees nothing answers unknown — for anything.
      const [grant] = await dependencies.database
        .select({
          userId: accessGrants.userId,
          scope: accessGrants.scope,
        })
        .from(accessGrants)
        .where(eq(accessGrants.grantId, grantId))
        .limit(1);
      if (grant?.scope !== "model-access") {
        return { kind: "answered", outcome: { status: "unknown" } };
      }
      const resolvedPayer: PayerRef = { kind: "personal", id: grant.userId };
      const accountKey = payerKey(resolvedPayer);

      const [reservation] = await dependencies.database
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.id, reservationId))
        .limit(1);
      if (!reservation || reservation.externalCustomerId !== accountKey) {
        return { kind: "answered", outcome: { status: "unknown" } };
      }

      return {
        kind: "answered",
        outcome: {
          status: reservation.status,
          attemptId: attemptIdForReservation(reservation.id),
          reservationId: reservation.id,
          maximumCredits: reservation.maximum,
          // No locked basis is persisted yet (06.5 pending): null, never a re-derived guess.
          snapshotVersion: null,
          rateVersion: null,
          createdAt: reservation.createdAt.toISOString(),
          expiresAt: reservation.expiresAt.toISOString(),
          // 06.8's entry evidence, when the hold ever went unknown; null otherwise.
          unknownAt: reservation.unknownAt
            ? reservation.unknownAt.toISOString()
            : null,
          unknownReason: reservation.unknownReason,
          terminalAt: reservation.terminalAt
            ? reservation.terminalAt.toISOString()
            : null,
        },
      };
    },
  };
}

/**
 * The Status surface, mounted inside `creditProtocolRoutes`'s guard through
 * `creditProtocolEndpoints`'s status slot, so no path here exists without the deployment's
 * billing identity (06.1). A POST, not a GET: the ids are capability-shaped and belong in a
 * body that access logs do not capture. An answer is one 200 carrying one of the four
 * states; a shape refusal is one 422 with its reason code.
 */
export function reservationStatusEndpoints(dependencies: {
  service: ReservationStatusService;
}): Hono<{ Variables: CreditServiceVariables }> {
  const app = new Hono<{ Variables: CreditServiceVariables }>();
  app.post("/status", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        {
          error: STATUS_REFUSAL_SENTENCES.request_invalid,
          code: "request_invalid",
          detail: { field: "body" },
        },
        422,
      );
    }
    const answer = await dependencies.service.queryStatus(body);
    if (answer.kind === "refused") {
      return context.json(
        {
          error: STATUS_REFUSAL_SENTENCES[answer.reasonCode],
          code: answer.reasonCode,
          detail: answer.detail,
        },
        422,
      );
    }
    return context.json(answer.outcome, 200);
  });
  return app;
}
