/*
 * The async submit path (Bifrost 17.2, #326): one submit = one full-cap reservation = one
 * job, dispatched only after the hold exists.
 *
 * THE CAP IS THE WHOLE JOB'S WORST CASE. Every entry's certified worst-case quantities are
 * summed per billing dimension and converted through 06.5's own exact arithmetic
 * (`computeReservationCeiling`) — all entries × all spec dimensions, one upward rounding at
 * the end. A dimension the locked basis prices `unknown` refuses the submit (unknown is
 * never a zero cost), and the refusal names the dimension: a submit that cannot be priced
 * completely cannot be capped, so it is not dispatched.
 *
 * THE HOLD PRECEDES THE DISPATCH. The reserve seam is injected (production: 06.2's
 * CreditReserveService); a refused reserve refuses the submit — no job row, no dispatch,
 * provider attempt count zero. The reservation's idempotency key IS the submit's, so the
 * door's own 06.7 semantics answer a replayed reserve with the SAME hold: even two submits
 * racing past the idempotency read converge on one reservation, and only the one whose job
 * row insert wins dispatches.
 *
 * IDENTITY IS FIXED AT CREATION. The job row copies the grant, the resolved payer, the
 * model cell and both locked versions at submit time — the contract members of 17.1's
 * AsyncJob (that ticket remains open; this is the minimal identity face 17.2's own
 * acceptance needs, built so the dedicated ticket adopts the row rather than duplicating
 * it). `providerJobId` is allowed to stay absent when the dispatch answer is lost (17.3's
 * lane): the row records `dispatch_unconfirmed`, the hold stays occupied, and nothing about
 * a missing provider id is read as evidence of no cost.
 *
 * The same request-shape discipline as the credit protocol applies here: account-identity
 * and company-scope fields (06.4 + 09.3) are refused at the boundary — presence is the
 * attempt — because the payer is resolved server-side from the grant, exactly as every
 * other door in the personal-key surface.
 */

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { accessGrants } from "../db/schema";
import { asyncJobs } from "../db/schema/credit-reservations";
import { PRICE_DIMENSIONS, type PriceDimension } from "../gateway/price-snapshot";
import {
  RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS,
  type CreditReserveOutcome,
  type CreditReserveRequest,
} from "./credit-reserve";
import {
  computeReservationCeiling,
  type ReservationBoundQuantities,
} from "./reserve-bound";
import { findCompanyScopeIdentityField } from "./personal-key-isolation";

/** The local job id's prefix — recognisable on sight, like the reservation's `cr-`. */
export const ASYNC_JOB_ID_PREFIX = "aj-";

/** How the submit's own refusals answer — a closed vocabulary, one sentence each. */
export type AsyncSubmitRefusalReasonCode =
  | "request_invalid"
  | "price_unknown"
  | "reserve_refused";

/** Why the dispatch answer is absent, when it is — 17.3 consumes this. */
export type AsyncDispatchOutcome =
  | { kind: "answered"; providerJobId: string }
  | { kind: "lost"; reason: string };

/** One entry's certified worst-case quantities: whole, non-negative, per billing dimension. */
export type AsyncSubmitEntry = {
  readonly quantities: Partial<ReservationBoundQuantities>;
};

/** The submit request's shape — every field is server-verified, none client-trusted. */
export type AsyncSubmitRequest = {
  /** The submit's stable identity, from the caller's own durable request (not a timestamp). */
  readonly submitIdempotencyKey: string;
  readonly grantId: string;
  /** A claim the reserve door verifies against the grant's server-side resolution (06.4). */
  readonly payer: { kind: string; id: string };
  readonly model: {
    provider: string;
    model: string;
    capability: string;
  };
  readonly snapshotVersion: number;
  readonly rateVersion: number;
  readonly entries: readonly AsyncSubmitEntry[];
  readonly expiresAt?: Date | string;
};

/** What a submit answers: the one job (created or already existing), or a refusal. */
export type AsyncSubmitOutcome =
  | {
      status: "submitted";
      /** True when this call created the job; false when a replay answered the existing one. */
      created: boolean;
      jobId: string;
      reservationId: string;
      maximumCredits: number;
      entryCount: number;
      state: "submitted" | "dispatch_unconfirmed";
      providerJobId: string | null;
    }
  | {
      status: "refused";
      reasonCode: AsyncSubmitRefusalReasonCode;
      detail: Record<string, unknown>;
    };

/** The seams the submit path composes — production wires 06.2 and the dispatch client. */
export type AsyncSubmitServiceDependencies = {
  database: Database;
  /** The reserve door: called with the submit's own idempotency key. */
  reserve: (request: CreditReserveRequest) => Promise<CreditReserveOutcome>;
  /** The provider dispatch: called at most once per job, by the submit that created it. */
  dispatch: (input: {
    jobId: string;
    reservationId: string;
  }) => Promise<AsyncDispatchOutcome>;
  /** The locked basis's dims and rate — resolved by the caller from the same versions. */
  resolveBasis: (model: {
    provider: string;
    model: string;
    capability: string;
    snapshotVersion: number;
    rateVersion: number;
  }) => Promise<
    | {
        ok: true;
        dims: Parameters<typeof computeReservationCeiling>[0]["dims"];
        rate: Parameters<typeof computeReservationCeiling>[0]["rate"];
      }
    | { ok: false; reason: "price_basis_not_found"; detail?: Record<string, unknown> }
  >;
  now?: () => Date;
};

/**
 * The full-cap conversion: every entry's quantities summed per dimension, then priced once
 * through 06.5's exact arithmetic with the single upward rounding. Pure — the same entries,
 * dims and rate always certify the same cap, so a re-derived cap agrees with the stored one.
 */
export function computeAsyncSubmitCap(input: {
  entries: readonly AsyncSubmitEntry[];
  dims: Parameters<typeof computeReservationCeiling>[0]["dims"];
  rate: Parameters<typeof computeReservationCeiling>[0]["rate"];
}):
  | { ok: true; maximumCredits: number; totals: ReservationBoundQuantities }
  | { ok: false; code: "request_invalid" | "price_unknown"; detail: Record<string, unknown> } {
  const totals = Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [dimension, 0]),
  ) as Record<PriceDimension, number>;
  for (const [index, entry] of input.entries.entries()) {
    if (entry === null || typeof entry !== "object") {
      return {
        ok: false,
        code: "request_invalid",
        detail: { field: `entries[${index}]` },
      };
    }
    for (const [dimension, quantity] of Object.entries(entry.quantities ?? {})) {
      if (!PRICE_DIMENSIONS.includes(dimension as PriceDimension)) {
        return {
          ok: false,
          code: "request_invalid",
          detail: { field: `entries[${index}].quantities.${dimension}` },
        };
      }
      if (
        typeof quantity !== "number" ||
        !Number.isSafeInteger(quantity) ||
        quantity < 0
      ) {
        return {
          ok: false,
          code: "request_invalid",
          detail: { field: `entries[${index}].quantities.${dimension}` },
        };
      }
      totals[dimension as PriceDimension] += quantity;
    }
  }
  const priced = computeReservationCeiling({
    dims: input.dims,
    quantities: totals,
    rate: input.rate,
  });
  if (!priced.ok) {
    const issue = priced.issue;
    switch (issue.code) {
      case "price_unknown":
        return { ok: false, code: "price_unknown", detail: { dimension: issue.dimension, reason: issue.reason } };
      case "quantity_invalid":
        return { ok: false, code: "request_invalid", detail: { field: `entries.quantities.${issue.dimension}` } };
      case "rate_invalid":
      case "ceiling_exceeds_ledger":
        return { ok: false, code: "price_unknown", detail: { reason: issue.code } };
    }
  }
  return { ok: true, maximumCredits: priced.maximumCredits, totals };
}

function isIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

/**
 * Pure shape validation, the protocol doors' own discipline: closed fields, the payer claim
 * exactly {kind, id}, and the account/company-scope vocabulary refused on presence.
 */
function validateSubmitRequest(
  input: unknown,
): { ok: true; request: AsyncSubmitRequest } | { ok: false; detail: Record<string, unknown> } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, detail: { field: "body" } };
  }
  const raw = input as Record<string, unknown>;
  if (!isIdentifier(raw.submitIdempotencyKey, 512)) {
    return { ok: false, detail: { field: "submitIdempotencyKey" } };
  }
  if (!isIdentifier(raw.grantId, 512)) {
    return { ok: false, detail: { field: "grantId" } };
  }
  const payer = raw.payer as Record<string, unknown> | null | undefined;
  if (
    payer === null ||
    typeof payer !== "object" ||
    typeof payer.kind !== "string" ||
    !isIdentifier(payer.id, 512)
  ) {
    return { ok: false, detail: { field: "payer" } };
  }
  const extraPayerKey = Object.keys(payer).find(
    (key) => key !== "kind" && key !== "id",
  );
  if (extraPayerKey !== undefined) {
    return { ok: false, detail: { field: `payer.${extraPayerKey}` } };
  }
  const forbidden = new Set(
    RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS.map((key) => key.toLowerCase()),
  );
  for (const key of Object.keys(raw)) {
    if (forbidden.has(key.toLowerCase()) || findCompanyScopeIdentityField({ [key]: true })) {
      return { ok: false, detail: { field: key } };
    }
  }
  const model = raw.model as Record<string, unknown> | null | undefined;
  if (
    model === null ||
    typeof model !== "object" ||
    !isIdentifier(model.provider, 512) ||
    !isIdentifier(model.model, 512) ||
    !isIdentifier(model.capability, 64)
  ) {
    return { ok: false, detail: { field: "model" } };
  }
  if (
    !Number.isSafeInteger(raw.snapshotVersion) ||
    (raw.snapshotVersion as number) < 1 ||
    !Number.isSafeInteger(raw.rateVersion) ||
    (raw.rateVersion as number) < 0
  ) {
    return { ok: false, detail: { field: "snapshotVersion" } };
  }
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    return { ok: false, detail: { field: "entries" } };
  }
  return {
    ok: true,
    request: {
      submitIdempotencyKey: raw.submitIdempotencyKey,
      grantId: raw.grantId,
      payer: { kind: payer.kind, id: payer.id },
      model: {
        provider: model.provider,
        model: model.model,
        capability: model.capability,
      },
      snapshotVersion: raw.snapshotVersion as number,
      rateVersion: raw.rateVersion as number,
      entries: raw.entries as AsyncSubmitEntry[],
      ...(raw.expiresAt !== undefined ? { expiresAt: raw.expiresAt as Date | string } : {}),
    },
  };
}

/** The view of a job row the submit answer and a replay both carry. */
type JobRowView = {
  jobId: string;
  reservationId: string;
  maximumCredits: number;
  entryCount: number;
  state: "submitted" | "dispatch_unconfirmed";
  providerJobId: string | null;
};

function viewOf(row: typeof asyncJobs.$inferSelect): JobRowView {
  return {
    jobId: row.jobId,
    reservationId: row.reservationId,
    maximumCredits: row.maximumCredits,
    entryCount: row.entryCount,
    state: row.state,
    providerJobId: row.providerJobId,
  };
}

/**
 * The submit path itself. Order is the contract: idempotency read → cap conversion →
 * reserve → job insert (unique) → dispatch, once, by the row's creator only.
 */
export function createAsyncSubmitService(
  dependencies: AsyncSubmitServiceDependencies,
) {
  const { database, reserve, dispatch, resolveBasis } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  return {
    async submit(input: unknown): Promise<AsyncSubmitOutcome> {
      const validated = validateSubmitRequest(input);
      if (!validated.ok) {
        return {
          status: "refused",
          reasonCode: "request_invalid",
          detail: validated.detail,
        };
      }
      const request = validated.request;

      // 1. The idempotency read: a replayed submit answers the existing job — no second
      //    reservation, no second dispatch, no re-derivation of anything.
      const [existing] = await database
        .select()
        .from(asyncJobs)
        .where(eq(asyncJobs.submitIdempotencyKey, request.submitIdempotencyKey))
        .limit(1);
      if (existing) {
        return { status: "submitted", created: false, ...viewOf(existing) };
      }

      // 2. The full-cap conversion over the locked basis. A basis that cannot be resolved,
      //    or a dimension it prices unknown, refuses the submit before any hold or dispatch.
      const resolvedBasis = await resolveBasis({
        ...request.model,
        snapshotVersion: request.snapshotVersion,
        rateVersion: request.rateVersion,
      });
      if (!resolvedBasis.ok) {
        return {
          status: "refused",
          reasonCode: "price_unknown",
          detail: {
            reason: resolvedBasis.reason,
            ...(resolvedBasis.detail ?? {}),
          },
        };
      }
      const basis = resolvedBasis;
      const cap = computeAsyncSubmitCap({
        entries: request.entries,
        dims: basis.dims,
        rate: basis.rate,
      });
      if (!cap.ok) {
        return { status: "refused", reasonCode: cap.code, detail: cap.detail };
      }

      // 3. The reserve, under the submit's own idempotency key — the door's 06.7 semantics
      //    make a racing replay converge on the same hold. A refusal is the submit's
      //    refusal: no job row, no dispatch.
      const reserved = await reserve({
        grantId: request.grantId,
        payer: request.payer as CreditReserveRequest["payer"],
        model: request.model as CreditReserveRequest["model"],
        snapshotVersion: request.snapshotVersion,
        rateVersion: request.rateVersion,
        maximumCredits: cap.maximumCredits,
        idempotencyKey: request.submitIdempotencyKey,
        // The cap's own evidence: the entries' counts are frozen before dispatch, so the
        // certified totals ARE the enforceable ceiling — the refusal-kind shape (计满即拒，
        // never truncation: an async job that outgrew its certification is refused, not
        // silently narrowed), at the input-side worst count like rerank's admission.
        boundEvidence: [
          {
            kind: "self_enforced_input_refusal",
            maximumTokens: Math.max(
              1,
              cap.totals.input + cap.totals.cache_read + cap.totals.cache_write,
            ),
          },
        ],
        ...(request.expiresAt !== undefined
          ? { expiresAt: new Date(request.expiresAt as string) }
          : {}),
      } satisfies CreditReserveRequest);
      if (reserved.status !== "reserved") {
        return {
          status: "refused",
          reasonCode: "reserve_refused",
          detail: {
            reasonCode: reserved.reasonCode,
            detail: reserved.detail,
          },
        };
      }

      // 4. The payer the job's attribution freezes is the one the door RESOLVED — read
      //    back from the grant, never the request's spelling of it.
      const [grant] = await database
        .select({ userId: accessGrants.userId })
        .from(accessGrants)
        .where(eq(accessGrants.grantId, request.grantId))
        .limit(1);
      if (!grant) {
        return {
          status: "refused",
          reasonCode: "reserve_refused",
          detail: { reasonCode: "grant_invalid" },
        };
      }

      // 5. The job row, under the unique submit key. The loser of a concurrent insert race
      //    reads the winner's row and dispatches nothing.
      const jobId = `${ASYNC_JOB_ID_PREFIX}${randomBytes(16).toString("hex")}`;
      const inserted = await database
        .insert(asyncJobs)
        .values({
          jobId,
          submitIdempotencyKey: request.submitIdempotencyKey,
          grantId: request.grantId,
          payerKind: "personal",
          payerId: grant.userId,
          provider: request.model.provider,
          model: request.model.model,
          capability: request.model.capability,
          snapshotVersion: request.snapshotVersion,
          rateVersion: request.rateVersion,
          reservationId: reserved.reservationId,
          maximumCredits: reserved.maximumCredits,
          entryCount: request.entries.length,
          state: "dispatch_unconfirmed",
        })
        .onConflictDoNothing({
          target: asyncJobs.submitIdempotencyKey,
        })
        .returning();
      if (inserted.length === 0) {
        const [winner] = await database
          .select()
          .from(asyncJobs)
          .where(eq(asyncJobs.submitIdempotencyKey, request.submitIdempotencyKey))
          .limit(1);
        if (winner) {
          return { status: "submitted", created: false, ...viewOf(winner) };
        }
        return {
          status: "refused",
          reasonCode: "reserve_refused",
          detail: { reasonCode: "reservation_conflict" },
        };
      }

      // 6. The dispatch — once, by the creator. The hold already exists, so the provider
      //    may be called; an answer that arrives names the provider job, an answer that
      //    does not leaves the row unconfirmed with the hold occupied (17.3's lane).
      const dispatched = await dispatch({
        jobId,
        reservationId: reserved.reservationId,
      });
      const [final] = await database
        .update(asyncJobs)
        .set(
          dispatched.kind === "answered"
            ? {
                providerJobId: dispatched.providerJobId,
                state: "submitted",
                dispatchedAt: now(),
              }
            : { state: "dispatch_unconfirmed" },
        )
        .where(eq(asyncJobs.jobId, jobId))
        .returning();
      return {
        status: "submitted",
        created: true,
        ...viewOf(final ?? inserted[0]),
      };
    },
  };
}

export type AsyncSubmitService = ReturnType<typeof createAsyncSubmitService>;
