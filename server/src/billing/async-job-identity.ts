import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { asyncJobs } from "../db/schema/credit-reservations";

/*
 * The async job's durable identity (Bifrost 17.1, #325): the read side of the row 17.2's
 * submit path already writes, plus the one write this ticket owns — attaching a provider
 * job id that arrives late.
 *
 * ONE ROW, ADOPTED — NOT A SECOND TABLE. 0188's `async_jobs` was built with exactly this
 * ticket's contract members (the submit path's own header says so: the columns are 17.1's
 * AsyncJob, and the dedicated ticket adopts the row rather than growing a parallel one).
 * What was missing was the identity's OWN surface: the reads a status query, a recovery
 * sweep or a terminal-state lookup performs, and the transition for the answer the
 * provider never gave in time. Both live here; nothing here re-derives or rewrites the
 * attribution facts the row froze at creation.
 *
 * THE MAPPING IS TWO-DIRECTIONAL WITH THE LOCAL SIDE AS THE ANCHOR. `providerJobId` is a
 * nullable column behind a partial unique index: local `aj-` identity is primary, the
 * provider's id is a fact ABOUT the job that may be absent (the dispatch answer was lost —
 * 17.3's lane) without the job, its attribution or its hold being any less real. The
 * provider-side record (framework/jobaccounting's TableProviderJob) keeps its own id
 * DERIVED — `ProviderJobID(kind, provider, providerJobID)` — never random, so the two
 * sides cannot drift: whichever side learns the pair second can always recompute the
 * other's key. identity_test.go pins that derivation and the re-drive that must not
 * re-attribute an existing job.
 *
 * ATTRIBUTION IS FROZEN, AND THIS MODULE KEEPS IT THAT WAY. The row's grant, resolved
 * payer, model cell and both locked versions are written once by the submit path; every
 * function here reads them verbatim and no function here updates them. A session that
 * ends, a key that expires, a grant that is revoked, a caller that changes — none of these
 * are inputs to identity, so none can move it: the tests pin this by mutating every one of
 * those surroundings and reading the same facts back.
 *
 * THE LATE ANSWER IS THE ONLY WRITE. When a recovery scan (17.3 / 08.x) learns the
 * provider's job id for a dispatch whose answer was lost, {@link attachAsyncJobProviderId}
 * moves the row `dispatch_unconfirmed → submitted` under the table's own shape CHECK (a
 * submitted row carries the provider id AND a dispatch time). The attach refuses to
 * overwrite: a row that already holds a DIFFERENT provider job id is a conflict surfaced,
 * never re-pointed — the mapping is stable once known, which is the whole point of an
 * identity row.
 */

/** The dispatch-state half of the row's CHECK vocabulary (the money half lives on the reservation). */
export type AsyncJobDispatchState = "submitted" | "dispatch_unconfirmed";

/**
 * The 17.1 contract, read verbatim off the row: the local identity, the attribution frozen
 * at creation, the provider mapping (nullable — absence is a state, not an error), and the
 * reservation/version facts a recovery read needs to re-price or re-settle the job.
 */
export type AsyncJobView = {
  readonly jobId: string;
  readonly submitIdempotencyKey: string;
  readonly grantId: string;
  readonly payer: { readonly kind: string; readonly id: string };
  readonly model: {
    readonly provider: string;
    readonly model: string;
    readonly capability: string;
  };
  readonly providerJobId: string | null;
  readonly reservationId: string;
  readonly snapshotVersion: number;
  readonly rateVersion: number;
  readonly maximumCredits: number;
  readonly entryCount: number;
  readonly state: AsyncJobDispatchState;
  readonly createdAt: Date;
  readonly dispatchedAt: Date | null;
};

/**
 * The row's own view builder — shared by every read this module and its consumers answer
 * from, so two surfaces can never disagree about what a job row says (17.3's sweep reuses
 * it for the unconfirmed walk).
 */
export function asyncJobViewOf(
  row: typeof asyncJobs.$inferSelect,
): AsyncJobView {
  return {
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
  };
}

/** The job a local id names, or undefined when no such job exists. */
export async function readAsyncJob(
  database: Database,
  jobId: string,
): Promise<AsyncJobView | undefined> {
  const [row] = await database
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.jobId, jobId))
    .limit(1);
  return row === undefined ? undefined : asyncJobViewOf(row);
}

/**
 * The job a provider job id names — the reverse half of the mapping, the read a
 * terminal-state query performs. Undefined when no job holds the id yet: an absent mapping
 * is "not known", never an error and never a job that exists without cost.
 */
export async function readAsyncJobByProviderJobId(
  database: Database,
  providerJobId: string,
): Promise<AsyncJobView | undefined> {
  const [row] = await database
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.providerJobId, providerJobId))
    .limit(1);
  return row === undefined ? undefined : asyncJobViewOf(row);
}

/**
 * A grant's jobs, oldest first — the recovery sweep's own read (17.3 walks a grant's
 * unconfirmed dispatches; 17.4's status reads walk the same order).
 */
export async function listAsyncJobsByGrant(
  database: Database,
  grantId: string,
): Promise<AsyncJobView[]> {
  const rows = await database
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.grantId, grantId))
    .orderBy(asc(asyncJobs.createdAt), asc(asyncJobs.jobId));
  return rows.map(asyncJobViewOf);
}

/** Why an attach refused. Closed vocabulary, one sentence each. */
export type AsyncJobAttachRefusalReason =
  /** No job carries this local id — the attach is for a job that was never created. */
  | "job_not_found"
  /** The row already holds a different provider job id; a known mapping never moves. */
  | "provider_job_id_conflict"
  /** Another job already holds this provider job id (the unique index's own answer). */
  | "provider_job_id_in_use";

/** What an attach answers: the row after the transition, or the refusal that names why. */
export type AsyncJobAttachOutcome =
  | { status: "attached"; job: AsyncJobView; alreadyKnown: boolean }
  | {
      status: "refused";
      reasonCode: AsyncJobAttachRefusalReason;
      detail: Record<string, unknown>;
    };

/**
 * Record the provider's job id for a dispatch whose answer was lost — the write the
 * recovery scan hands its finding to. Idempotent: attaching the id the row already holds
 * answers `attached` with `alreadyKnown` and writes nothing. Any OTHER id on a row that
 * already knows one refuses: the mapping is an identity fact, and identities do not move.
 * On the happy path the row flips `dispatch_unconfirmed → submitted` with its dispatch
 * time, satisfying the table's shape CHECK in the same statement.
 */
export async function attachAsyncJobProviderId(
  database: Database,
  input: { jobId: string; providerJobId: string; now?: () => Date },
): Promise<AsyncJobAttachOutcome> {
  const now = input.now ?? (() => new Date());
  const [row] = await database
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.jobId, input.jobId))
    .limit(1);
  if (row === undefined) {
    return {
      status: "refused",
      reasonCode: "job_not_found",
      detail: { jobId: input.jobId },
    };
  }
  if (row.providerJobId === input.providerJobId) {
    return { status: "attached", job: asyncJobViewOf(row), alreadyKnown: true };
  }
  if (row.providerJobId !== null) {
    return {
      status: "refused",
      reasonCode: "provider_job_id_conflict",
      detail: {
        jobId: input.jobId,
        heldProviderJobId: row.providerJobId,
      },
    };
  }
  // The unique partial index is the last guard: a concurrent attach of the same provider
  // id to another job makes this update throw, which is the caller's conflict to handle —
  // refusing quietly here would race the very guard the database owns.
  const [updated] = await database
    .update(asyncJobs)
    .set({
      providerJobId: input.providerJobId,
      state: "submitted",
      dispatchedAt: now(),
    })
    .where(
      and(eq(asyncJobs.jobId, input.jobId), isNull(asyncJobs.providerJobId)),
    )
    .returning();
  if (updated === undefined) {
    // The row changed between the read and the guarded update — re-read and answer by
    // what now holds; never a second write on top of another writer's fact.
    const [current] = await database
      .select()
      .from(asyncJobs)
      .where(eq(asyncJobs.jobId, input.jobId))
      .limit(1);
    if (
      current !== undefined &&
      current.providerJobId === input.providerJobId
    ) {
      return {
        status: "attached",
        job: asyncJobViewOf(current),
        alreadyKnown: false,
      };
    }
    return {
      status: "refused",
      reasonCode: "provider_job_id_conflict",
      detail: { jobId: input.jobId },
    };
  }
  return {
    status: "attached",
    job: asyncJobViewOf(updated),
    alreadyKnown: false,
  };
}
