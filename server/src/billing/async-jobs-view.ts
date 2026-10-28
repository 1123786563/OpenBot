import { and, desc, eq, like, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  asyncJobCancellations,
  asyncJobs,
  creditReservations,
} from "../db/schema/credit-reservations";

/*
 * The async jobs view (Bifrost 17.8, #332): the read the user page and the administrator's
 * review share — every job with its STATUS in the code table 17.1–17.7's implementation
 * actually holds, the REASON a waiting state waits for, and the AMOUNTS in the ledger's own
 * ×100 integers (the same convention the realtime view keeps).
 *
 * THE CODE TABLE IS DERIVED, NOT INVENTED — each display state names the facts that produce
 * it, so the page and the doors can never disagree about what a job is:
 *
 *   `queued`              the dispatch's answer is outstanding (state=dispatch_unconfirmed):
 *                          the provider may not even hold the job yet; the reason is the
 *                          dispatch lane's own (async_dispatch_answer_lost) and the hold —
 *                          06.8's unknown from the moment the loss was known — still shows
 *                          its FULL cap as the amount awaiting settlement;
 *   `running`             dispatched and answered (state=submitted), hold reserved, no
 *                          terminal yet: the job is at the provider;
 *   `pending-settlement`  the job RAN (dispatch confirmed) and its money's final state is
 *                          outstanding — the hold is 06.8's unknown for a reason the money
 *                          lanes wrote (a cancel whose result is unknown, a tail nobody
 *                          confirmed): full cap still occupied, recovery's to dispose;
 *   `settled`             the terminal report settled (applied is the charge, the rest came
 *                          back with the settle);
 *   `cancelled`           an evidenced cancel released the hold (the provider's own unbilled
 *                          confirmation, 17.7): nothing owed, the receipt is the reason;
 *   `refused`             the submit refused (17.2's codes: price unknown, reserve refused):
 *                          no job row exists, so the LIST never shows it — it is a member of
 *                          the code table because the submit's own answer carries it.
 *
 * ATTRIBUTION IS THE ROW'S, NOT THE KEY'S. The job froze its grant and payer at creation
 * (17.1/17.2); this view reads THOSE columns and never consults the grant's live state —
 * a key that expired or was revoked after the submit changes nothing about whose job (and
 * whose held credit) the row is (Key 到期后任务仍显示原归属账户). The ownership the user
 * read keeps (17.4's visibility rule) is the same fact this view projects.
 *
 * THE ADMIN REVIEW IS A READ. `asyncJobsForReview` answers every payer's rows with the same
 * projection plus the frozen attribution, filtered by the task dimensions (job id, status,
 * payer) — the counterpart of 08.8's read-only anomaly review: settling and releasing stay
 * 08.9's separately authorized actions, and no write method exists on this path.
 */

/** The display code table — the closed set 17.8's surfaces render. */
export type AsyncJobDisplayState =
  | "queued"
  | "running"
  | "pending-settlement"
  | "settled"
  | "refused"
  | "cancelled";

/** The user page's row: identity, status, reason, amounts, frozen attribution. */
export type AsyncJobViewRow = {
  jobId: string;
  providerJobId: string | null;
  model: { provider: string; model: string; capability: string };
  createdAt: string;
  dispatchedAt: string | null;
  status: AsyncJobDisplayState;
  /** Present exactly when the state waits for something — displayable, never a guess. */
  statusReason: string | null;
  attribution: { grantId: string; payerKind: string; payerId: string };
  /** The cap the submit reserved, ×100. */
  maximumCents: number;
  /** The settled charge, ×100 — 0 until the terminal settle lands. */
  settledCents: number;
  /** The amount awaiting settlement or disposal, ×100 — the full cap while held/unknown. */
  pendingCents: number;
};

/** The admin review's row: the user's row plus the money lanes' own current facts. */
export type AsyncJobReviewRow = AsyncJobViewRow & {
  /** The hold's own state, verbatim (reserved/unknown/settled/released). */
  reservationStatus: "reserved" | "unknown" | "settled" | "released";
  /** 17.7's cancellation conclusion, when a cancel was ever asked. */
  cancelConclusion:
    | "released_on_evidence"
    | "hold_kept"
    | "hold_unknown"
    | null;
};

/** The task-dimension filters the admin review accepts — all optional, all exact. */
export type AsyncJobReviewFilter = {
  jobId?: string;
  status?: AsyncJobDisplayState;
  payerId?: string;
};

/** The row limit both reads keep — the anomaly queue's own bound (08.8's 200). */
const ASYNC_JOBS_VIEW_LIMIT = 200;

/**
 * The pure state derivation — the code table as one function, so every surface (the page,
 * the review, the tests) derives the same word from the same facts. `dispatchUnconfirmed`
 * names the job row's own state; `holdStatus` and `unknownReason` the reservation's;
 * `cancelConclusion` 17.7's row, when one exists.
 */
export function asyncJobDisplayStateOf(input: {
  dispatchState: "submitted" | "dispatch_unconfirmed";
  holdStatus: "reserved" | "unknown" | "settled" | "released";
  unknownReason: string | null;
  cancelConclusion:
    | "released_on_evidence"
    | "hold_kept"
    | "hold_unknown"
    | null;
}): { status: AsyncJobDisplayState; statusReason: string | null } {
  if (
    input.cancelConclusion === "released_on_evidence" ||
    input.holdStatus === "released"
  ) {
    return {
      status: "cancelled",
      statusReason:
        input.cancelConclusion === "released_on_evidence"
          ? "released on the provider's unbilled cancellation confirmation"
          : null,
    };
  }
  if (input.holdStatus === "settled") {
    return { status: "settled", statusReason: null };
  }
  if (input.holdStatus === "unknown") {
    if (input.dispatchState === "dispatch_unconfirmed") {
      return {
        status: "queued",
        statusReason: input.unknownReason ?? "dispatch answer outstanding",
      };
    }
    return {
      status: "pending-settlement",
      statusReason: input.unknownReason ?? "outcome unconfirmed",
    };
  }
  if (input.dispatchState === "dispatch_unconfirmed") {
    // The 17.2 lane marks the hold unknown the moment the loss is known, so this pair is
    // the tiny window before that mark — still derived, still the honest word for it.
    return {
      status: "queued",
      statusReason: "dispatch answer outstanding",
    };
  }
  return { status: "running", statusReason: null };
}

/** One raw join row — the facts every projection below stands on. */
type JoinedRow = {
  jobId: string;
  providerJobId: string | null;
  provider: string;
  model: string;
  capability: string;
  createdAt: Date;
  dispatchedAt: Date | null;
  grantId: string;
  payerKind: string;
  payerId: string;
  dispatchState: "submitted" | "dispatch_unconfirmed";
  holdStatus: "reserved" | "unknown" | "settled" | "released";
  maximum: number;
  applied: number | null;
  unknownReason: string | null;
  cancelConclusion:
    | "released_on_evidence"
    | "hold_kept"
    | "hold_unknown"
    | null;
};

function toViewRow(row: JoinedRow): AsyncJobReviewRow {
  const state = asyncJobDisplayStateOf({
    dispatchState: row.dispatchState,
    holdStatus: row.holdStatus,
    unknownReason: row.unknownReason,
    cancelConclusion: row.cancelConclusion,
  });
  const settled = row.holdStatus === "settled" ? (row.applied ?? 0) : 0;
  const pending =
    row.holdStatus === "reserved" || row.holdStatus === "unknown"
      ? row.maximum
      : 0;
  return {
    jobId: row.jobId,
    providerJobId: row.providerJobId,
    model: {
      provider: row.provider,
      model: row.model,
      capability: row.capability,
    },
    createdAt: row.createdAt.toISOString(),
    dispatchedAt: row.dispatchedAt ? row.dispatchedAt.toISOString() : null,
    status: state.status,
    statusReason: state.statusReason,
    attribution: {
      grantId: row.grantId,
      payerKind: row.payerKind,
      payerId: row.payerId,
    },
    maximumCents: row.maximum,
    settledCents: settled,
    pendingCents: pending,
    reservationStatus: row.holdStatus,
    cancelConclusion: row.cancelConclusion,
  };
}

const JOIN = {
  jobId: asyncJobs.jobId,
  providerJobId: asyncJobs.providerJobId,
  provider: asyncJobs.provider,
  model: asyncJobs.model,
  capability: asyncJobs.capability,
  createdAt: asyncJobs.createdAt,
  dispatchedAt: asyncJobs.dispatchedAt,
  grantId: asyncJobs.grantId,
  payerKind: asyncJobs.payerKind,
  payerId: asyncJobs.payerId,
  dispatchState: asyncJobs.state,
  holdStatus: creditReservations.status,
  maximum: creditReservations.maximum,
  applied: creditReservations.applied,
  unknownReason: creditReservations.unknownReason,
  cancelConclusion: asyncJobCancellations.conclusion,
} as const;

export type AsyncJobsViewReader = {
  /** The payer's own jobs, newest first — the user page's one read. */
  asyncJobsForPayer(payer: {
    kind: string;
    id: string;
  }): Promise<AsyncJobViewRow[]>;
  /** Every payer's jobs with the review's filters — the admin read; never writes. */
  asyncJobsForReview(
    filter: AsyncJobReviewFilter,
  ): Promise<AsyncJobReviewRow[]>;
};

export function createAsyncJobsViewService(dependencies: {
  database: Database;
}): AsyncJobsViewReader {
  const { database } = dependencies;
  return {
    async asyncJobsForPayer(payer) {
      const rows: JoinedRow[] = await database
        .select(JOIN)
        .from(asyncJobs)
        .innerJoin(
          creditReservations,
          eq(creditReservations.id, asyncJobs.reservationId),
        )
        .leftJoin(
          asyncJobCancellations,
          eq(asyncJobCancellations.jobId, asyncJobs.jobId),
        )
        .where(
          sql`${asyncJobs.payerKind} = ${payer.kind} and ${asyncJobs.payerId} = ${payer.id}`,
        )
        .orderBy(desc(asyncJobs.createdAt), desc(asyncJobs.jobId))
        .limit(ASYNC_JOBS_VIEW_LIMIT);
      return rows.map((row) => {
        const review = toViewRow(row);
        const {
          reservationStatus: _reservationStatus,
          cancelConclusion: _cancelConclusion,
          ...view
        } = review;
        return view;
      });
    },

    async asyncJobsForReview(filter) {
      // The status filter runs over the DERIVED word, so the admin filters with the same
      // vocabulary the page renders — one derivation, one code table.
      const conditions = [];
      if (filter.jobId !== undefined && filter.jobId.length > 0) {
        conditions.push(like(asyncJobs.jobId, `${filter.jobId}%`));
      }
      if (filter.payerId !== undefined && filter.payerId.length > 0) {
        conditions.push(eq(asyncJobs.payerId, filter.payerId));
      }
      const rows: JoinedRow[] = await database
        .select(JOIN)
        .from(asyncJobs)
        .innerJoin(
          creditReservations,
          eq(creditReservations.id, asyncJobs.reservationId),
        )
        .leftJoin(
          asyncJobCancellations,
          eq(asyncJobCancellations.jobId, asyncJobs.jobId),
        )
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(asyncJobs.createdAt), desc(asyncJobs.jobId))
        .limit(ASYNC_JOBS_VIEW_LIMIT);
      const mapped = rows.map(toViewRow);
      if (filter.status === undefined) return mapped;
      return mapped.filter((row) => row.status === filter.status);
    },
  };
}
