import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { asyncJobs } from "../db/schema/credit-reservations";
import {
  type AsyncJobAttachRefusalReason,
  type AsyncJobView,
  attachAsyncJobProviderId,
  readAsyncJob,
} from "./async-job-identity";
import { createCreditWriter } from "./credits-writer";

/*
 * The lost-dispatch recovery lane (Bifrost 17.3, #327): a dispatch whose answer never came
 * back is UNKNOWN, not failed — the remote job may well be running.
 *
 * WHY THIS MODULE EXISTS. 17.2's submit path dispatches exactly once, and the answer can be
 * lost between the provider and the 201 — a timeout, a dropped connection, a restart. The
 * one wrong default is "answer lost = submit failed = release the hold": the provider may
 * already be running the job (Q26/AC16), so releasing would bill a real execution for free
 * and re-submitting would create a SECOND one. The submit path already writes the honest
 * row — `dispatch_unconfirmed`, provider job id absent, hold fully occupied, reservation
 * moved to 06.8's `unknown` the moment the loss is known — and this module is what happens
 * next: the sweep that walks the unconfirmed rows, the provider query under the submit's
 * OWN stable identity, and the attach of the provider job id that comes back.
 *
 * THE STABLE IDENTITY IS THE SUBMIT KEY. The provider is asked "does a job exist for this
 * submission identity" — the same key the submit converged on (17.2's UNIQUE) — never a
 * re-derived or a client-supplied one. A job found that way carries the pair
 * (local aj- identity, provider job id) 17.1's attach then freezes; the mapping's anchor
 * stays the local side, exactly as the identity row documents.
 *
 * WHAT RECOVERY MAY NOT DO. It never releases (an unanswered query is not "no cost"
 * evidence — Q12), never settles (a terminal state arrives by the terminal lane, 17.5),
 * and never re-dispatches (a second provider attempt is exactly the double job AC07
 * forbids; a new attempt needs a new submit with a new key, 07.5's discipline). A query
 * the provider cannot answer leaves every fact exactly as it was: the row unconfirmed,
 * the reservation `unknown`, the FULL cap still occupied — and the sweep will ask again.
 */

/** What the provider lookup answered: the job exists (with its id), or no evidence either way. */
export type AsyncProviderJobLookup =
  | { status: "found"; providerJobId: string }
  | { status: "not_found"; reason: string };

/** Why a recovery refused. The attach's own vocabulary, one seam over. */
export type AsyncJobRecoveryRefusalReason = AsyncJobAttachRefusalReason;

/** What a recovery attempt answers: the row after the attempt, or the refusal that names why. */
export type AsyncDispatchRecoveryOutcome =
  /** The provider job id is now the row's mapping (or already was — idempotent). */
  | { status: "recovered"; job: AsyncJobView; alreadyKnown: boolean }
  /** The provider holds no evidence: the row stays unconfirmed and the hold stays occupied. */
  | { status: "still_unknown"; job: AsyncJobView; reason: string }
  /** The row is not in the lost state at all — a `submitted` row is not recovery's subject. */
  | { status: "not_unconfirmed"; job: AsyncJobView }
  | {
      status: "refused";
      reasonCode: AsyncJobRecoveryRefusalReason;
      detail: Record<string, unknown>;
    };

export type AsyncJobRecoveryServiceDependencies = {
  database: Database;
  /**
   * The provider query under the submit's stable identity — production wires the gateway
   * client (19.x); the answer is evidence, never a guess.
   */
  findProviderJob: (query: {
    provider: string;
    model: string;
    submitIdempotencyKey: string;
  }) => Promise<AsyncProviderJobLookup>;
  /** The 06.8 unknown mark; defaults to the credit writer's own transition. */
  markUnknown?: (reservationId: string, reason: string) => Promise<void>;
};

/**
 * The unconfirmed walk, oldest first — the sweep's own read (every grant's dispatches whose
 * answers never arrived, in the same order 17.4's status reads walk a grant's jobs).
 */
export async function listUnconfirmedAsyncJobs(
  database: Database,
  limit = 100,
): Promise<AsyncJobView[]> {
  const rows = await database
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.state, "dispatch_unconfirmed"))
    .orderBy(asc(asyncJobs.createdAt), asc(asyncJobs.jobId))
    .limit(limit);
  return rows.map((row) => ({
    jobId: row.jobId,
    submitIdempotencyKey: row.submitIdempotencyKey,
    grantId: row.grantId,
    payer: { kind: row.payerKind, id: row.payerId },
    model: {
      provider: row.provider,
      model: row.model,
      capability: row.capability,
    },
    providerJobId: row.providerJobId,
    reservationId: row.reservationId,
    snapshotVersion: row.snapshotVersion,
    rateVersion: row.rateVersion,
    maximumCredits: row.maximumCredits,
    entryCount: row.entryCount,
    state: row.state,
    createdAt: row.createdAt,
    dispatchedAt: row.dispatchedAt,
  }));
}

/**
 * The recovery attempt for one lost dispatch. Idempotent by construction: the unknown mark
 * only ever fires on a still-`reserved` hold (a terminal fact is never reopened), the
 * provider query is a read, and the attach answers `alreadyKnown` for a mapping it already
 * wrote. A refusal (the attach's own vocabulary) surfaces the conflict instead of silently
 * re-pointing anything.
 */
export function createAsyncDispatchRecoveryService(
  dependencies: AsyncJobRecoveryServiceDependencies,
) {
  const { database, findProviderJob } = dependencies;
  const markUnknown =
    dependencies.markUnknown ??
    createCreditWriter(database).markReservationUnknown;

  return {
    async recoverLostDispatch(
      jobId: string,
    ): Promise<AsyncDispatchRecoveryOutcome> {
      const view = await readAsyncJob(database, jobId);
      if (view === undefined) {
        return {
          status: "refused",
          reasonCode: "job_not_found",
          detail: { jobId },
        };
      }
      if (
        view.state !== "dispatch_unconfirmed" ||
        view.providerJobId !== null
      ) {
        return { status: "not_unconfirmed", job: view };
      }

      // The hold is unknown before anything else happens: a crash between this and the
      // query below must still leave the reservation in the lane the 08.1 scan walks.
      // Terminal holds are the writer's own no-op — the first terminal fact stands.
      await markUnknown(view.reservationId, "async_dispatch_answer_lost");

      const lookup = await findProviderJob({
        provider: view.model.provider,
        model: view.model.model,
        submitIdempotencyKey: view.submitIdempotencyKey,
      });
      if (lookup.status === "not_found") {
        return {
          status: "still_unknown",
          job: view,
          reason: lookup.reason,
        };
      }

      let attached: Awaited<ReturnType<typeof attachAsyncJobProviderId>>;
      try {
        attached = await attachAsyncJobProviderId(database, {
          jobId,
          providerJobId: lookup.providerJobId,
        });
      } catch (error) {
        if (isProviderJobIdTaken(error)) {
          return {
            status: "refused",
            reasonCode: "provider_job_id_in_use",
            detail: { jobId, providerJobId: lookup.providerJobId },
          };
        }
        throw error;
      }
      if (attached.status === "refused") {
        return {
          status: "refused",
          reasonCode: attached.reasonCode,
          detail: attached.detail,
        };
      }
      return {
        status: "recovered",
        job: attached.job,
        alreadyKnown: attached.alreadyKnown,
      };
    },
  };
}

/**
 * The unique index's own answer, translated: the attach deliberately lets a concurrent
 * same-provider-id insert throw (its comment names this caller), and the sweep answers the
 * throw as the refusal it is — another job holds the provider id. Anything else rethrows;
 * an unexpected database failure is never a "recovered" verdict.
 */
function isProviderJobIdTaken(error: unknown): boolean {
  // Drizzle wraps driver errors (DrizzleQueryError.cause), so the walk looks through
  // causes until it finds the driver's own shape or runs out. The SQLSTATE lives in
  // `errno` on Bun's PostgresError and in `code` on node-postgres — either names it.
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 && current !== null && current !== undefined;
    depth += 1
  ) {
    if (typeof current === "object" && current !== null) {
      const candidate = current as {
        code?: unknown;
        errno?: unknown;
        constraint?: unknown;
      };
      const sqlstate =
        candidate.code === "23505" || candidate.errno === "23505";
      if (
        sqlstate &&
        candidate.constraint === "async_jobs_provider_job_id_idx"
      ) {
        return true;
      }
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

export type AsyncDispatchRecoveryService = ReturnType<
  typeof createAsyncDispatchRecoveryService
>;
