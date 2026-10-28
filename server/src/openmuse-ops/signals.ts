import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  openmuseGoogleConnections,
  openmuseReviewedActions,
  openmuseReviewedAttempts,
} from "../db/schema/openmuse";
import { workItems } from "../db/schema/work";
import { OpenMUSE_REFRESH_FAILED_MESSAGE } from "../openmuse-connectors/google-oauth";
import {
  type OpenMuseDeletionCleanupView,
  sanitizeLastError,
} from "../openmuse-deletion/retention";
import { OPENMUSE_TASK_MAX_ATTEMPTS } from "../openmuse-tasks/capacity";
import { OPENMUSE_TASK_KIND } from "../openmuse-tasks/store";

/*
 * O05 (contracts §10, issue #92): the operator's health signals — one PURE
 * aggregation over the four failure seams the feature tickets already own.
 * Nothing here decides, writes or re-sanitizes a store's own truth; each
 * reader is injectable (drizzle in a deployment, data in tests) and each
 * signal cites the seam its row came from, so an operator reading the answer
 * can trace every row to the module that recorded it. A reader that is not
 * wired — or one that fails — is itself a visible signal kind, never an
 * omission: visibility includes the gaps.
 */

/** §10's stuck-Task triggers: runnable queued past 5 minutes, or an expired lease unrecovered past 1. */
export const OPENMUSE_QUEUED_RUNNABLE_MS = 5 * 60_000;
export const OPENMUSE_LEASE_UNRECOVERED_MS = 60_000;

export type OpenMuseOpsSignalKind =
  | "connector_refresh_failure"
  | "stuck_task"
  | "uncertain_reviewed_action"
  | "cleanup_retry"
  | "missing_seam";

/**
 * One §10 signal row. `id` is the SOURCE ROW's own identifier — a connection
 * id, a Task id, an attempt id, a manifest resource id — never a token, an
 * alias or a byte-store key; `source` cites the seam; any free text in
 * `detail` passes D09/G06's display guard before it is exposed.
 */
export type OpenMuseOpsSignal = {
  kind: OpenMuseOpsSignalKind;
  id: string;
  source: string;
  detail: string;
  /** §10 stuck Task: the queue reason the operator reads. */
  reason?: "queued-runnable" | "claimed-no-lease" | "expired-lease";
  /** §10 uncertain Reviewed action: the reconciliation status. */
  reconciliation?:
    | "pending"
    | "confirmed_succeeded"
    | "confirmed_not_sent"
    | "unresolved";
  /** §10 cleanup retry: the resource kind. */
  resource?: string;
  at: string | null;
};

/** G04's refresh_required rows as the connectors store holds them. */
export type OpenMuseOpsConnectorFailureRow = {
  id: string;
  provider: string;
  lastError: string | null;
};

/**
 * The queue's openmuse-task rows with their lease columns, read raw so the
 * threshold decision stays in the pure aggregation (work/queue.ts owns the
 * lease semantics; this only observes them).
 */
export type OpenMuseOpsTaskQueueRow = {
  key: string;
  taskId: string | null;
  runAt: Date;
  claimedBy: string | null;
  leaseUntil: Date | null;
  finishedAt: Date | null;
  /**
   * Round 6 (M34): the row's handed-out count and last failure. A row whose
   * attempts reached the claim's cap is a TERMINAL state awaiting reap, not
   * a stuck task — the filter needs to tell them apart.
   */
  attempts: number;
  lastError: string | null;
};

/** R04's outcome_unknown actions with their latest attempt, as the operator reads them. */
export type OpenMuseOpsUncertainActionRow = {
  actionId: string;
  ownerUserId: string;
  createdAt: Date;
  attempt: {
    attemptId: string;
    reconciliation:
      | "confirmed_succeeded"
      | "confirmed_not_sent"
      | "unresolved"
      | null;
  } | null;
};

/** The four seams, each optional: an absent one answers a missing-seam row. */
export type OpenMuseOpsSignalDeps = {
  now?: () => Date;
  /** Past this, a runnable-but-unclaimed Task is stuck (§10; default 5 min). */
  queuedRunnableMs?: number;
  /** Past this, an expired lease nobody recovered is stuck (§10; default 1 min). */
  leaseUnrecoveredMs?: number;
  refreshRequired?: () => Promise<OpenMuseOpsConnectorFailureRow[]>;
  taskQueue?: () => Promise<OpenMuseOpsTaskQueueRow[]>;
  uncertainReviewed?: () => Promise<OpenMuseOpsUncertainActionRow[]>;
  /** D09's cleanup view, consumed as-is — the retryable rows are its unresolved state. */
  cleanupView?: () => Promise<OpenMuseDeletionCleanupView>;
};

const SEAM_SOURCES = {
  connections: "openmuse-connectors/store (G04 refresh_required)",
  tasks: "work/queue + openmuse-tasks/store (§10 stuck Task)",
  reviewed: "openmuse-reviewed-actions/store (R04 outcome_unknown)",
  deletion: "openmuse-deletion/retention (D09 retryable_error)",
} as const;

/** The gap row's source string, exactly as the failure-handling contract spells it. */
function missingSeam(module: string): string {
  return `missing-seam (${module})`;
}

/**
 * The pure aggregation: one read of every wired seam, one signal per §10 row.
 * A reader that is absent or failing answers its own missing_seam row IN
 * PLACE — the operator sees which of the four surfaces the deployment cannot
 * currently back, in the order the contract lists them.
 */
export function createOpenMuseOpsSignals(
  deps: OpenMuseOpsSignalDeps,
): () => Promise<{ signals: OpenMuseOpsSignal[] }> {
  const now = deps.now ?? (() => new Date());
  const queuedRunnableMs = deps.queuedRunnableMs ?? OPENMUSE_QUEUED_RUNNABLE_MS;
  const leaseUnrecoveredMs =
    deps.leaseUnrecoveredMs ?? OPENMUSE_LEASE_UNRECOVERED_MS;
  return async () => {
    // Each seam answers its own slice; a failure is itself a signal, never
    // an omission. The reads are independent, so they run concurrently and
    // the slices concatenate in the contract's fixed seam order.
    const collect = async (
      module: string,
      read: (() => Promise<OpenMuseOpsSignal[]>) | undefined,
    ): Promise<OpenMuseOpsSignal[]> => {
      if (read === undefined) {
        return [
          {
            kind: "missing_seam",
            id: "",
            source: missingSeam(module),
            detail: "This seam is not wired; its rows are not observable here.",
            at: null,
          },
        ];
      }
      try {
        return await read();
      } catch (error) {
        // The reason rides along through G06's display guard (truncated by it):
        // a DB outage, a bad migration and a code bug must not read as the same
        // one-line mystery — this surface is admin-gated, and its purpose is
        // diagnosability — while a message that quotes the credential it failed
        // on is replaced wholesale, never shown to an operator.
        const reason =
          sanitizeLastError(
            error instanceof Error ? error.message : String(error),
          ) ?? "unprintable failure";
        return [
          {
            kind: "missing_seam",
            id: "",
            source: missingSeam(module),
            detail: `This seam failed to answer: ${reason}`,
            at: null,
          },
        ];
      }
    };

    const refreshRequired = deps.refreshRequired;
    const taskQueue = deps.taskQueue;
    const uncertainReviewed = deps.uncertainReviewed;
    const cleanupView = deps.cleanupView;
    const slices = await Promise.all([
      collect(
        "openmuse-connectors",
        refreshRequired &&
          (async () =>
            (await refreshRequired()).map((row) => ({
              kind: "connector_refresh_failure" as const,
              id: row.id,
              source: SEAM_SOURCES.connections,
              // The provider names the connection that cannot refresh — the
              // operator's one-glance answer to "whose seat is stale". G04
              // persists only fixed sentences below it; the display guard
              // runs anyway, so a future writer cannot leak a token here.
              detail: `${row.provider}: ${
                sanitizeLastError(row.lastError) ??
                OpenMUSE_REFRESH_FAILED_MESSAGE
              }`,
              at: null,
            }))),
      ),
      collect(
        "work/queue + openmuse-tasks",
        taskQueue &&
          (async () => {
            const at = now();
            return (await taskQueue())
              .filter((row) => {
                if (row.finishedAt !== null) return false;
                /*
                 * Round 6 (M34): a row whose attempts reached the claim's cap
                 * is DONE-WITH, not stuck — the claim never hands it out
                 * again and only the retention reap removes it, so reporting
                 * it as queued-runnable (for up to the reap window) is noise
                 * that buries the genuinely wedged rows and tells the
                 * operator to wait for a worker that will never come.
                 */
                if (row.attempts >= OPENMUSE_TASK_MAX_ATTEMPTS) return false;
                if (row.claimedBy === null)
                  return at.getTime() - row.runAt.getTime() > queuedRunnableMs;
                // Claimed but carrying no lease is the most suspicious wedge
                // there is (a writer bug or migration leftover) — reported,
                // never dropped: this module's contract is that a reader's
                // own failure is itself a signal.
                if (row.leaseUntil === null) return true;
                return (
                  row.leaseUntil !== null &&
                  at.getTime() - row.leaseUntil.getTime() > leaseUnrecoveredMs
                );
              })
              .map((row) => ({
                kind: "stuck_task" as const,
                id: row.taskId ?? row.key,
                source: SEAM_SOURCES.tasks,
                detail:
                  row.claimedBy === null
                    ? `runnable in the queue for over ${Math.round(queuedRunnableMs / 60_000)} minutes without a worker claim`
                    : row.leaseUntil === null
                      ? `claimed by a worker that never held a lease`
                      : `lease expired over ${Math.round(leaseUnrecoveredMs / 1000)} seconds ago without recovery`,
                reason:
                  row.claimedBy === null
                    ? ("queued-runnable" as const)
                    : row.leaseUntil === null
                      ? ("claimed-no-lease" as const)
                      : ("expired-lease" as const),
                at: null,
              }));
          }),
      ),
      collect(
        "openmuse-reviewed-actions",
        uncertainReviewed &&
          (async () =>
            (await uncertainReviewed()).map((row) => {
              const reconciliation =
                row.attempt?.reconciliation === undefined ||
                row.attempt?.reconciliation === null
                  ? ("pending" as const)
                  : row.attempt.reconciliation;
              return {
                kind: "uncertain_reviewed_action" as const,
                id: row.attempt?.attemptId ?? row.actionId,
                source: SEAM_SOURCES.reviewed,
                // The owner names whose uncertain send this is — the
                // operator's actionable fact, behind requireAdmin.
                detail: `owner ${row.ownerUserId}: reconciliation: ${reconciliation}`,
                reconciliation,
                at: row.createdAt.toISOString(),
              };
            })),
      ),
      collect(
        "openmuse-deletion",
        cleanupView &&
          (async () => {
            const view = await cleanupView();
            return view.markers.flatMap((marker) =>
              marker.unresolved
                .filter((row) => row.state === "retryable_error")
                .map((row) => ({
                  kind: "cleanup_retry" as const,
                  id: row.id,
                  source: SEAM_SOURCES.deletion,
                  // The view already sanitizes; the guard runs again so this
                  // surface cannot be the one a raw reason escapes through.
                  detail:
                    sanitizeLastError(row.lastError ?? null) ??
                    "retry pending (no recorded reason)",
                  resource: row.kind,
                  at: row.at,
                })),
            );
          }),
      ),
    ]);
    return { signals: slices.flat() };
  };
}

/*
 * The deployment's readers, built ONLY from already-exported seams: the
 * schema tables the stores themselves run on, and D09's cleanup view. No
 * feature module is edited for this — the four status queries O05 needs are
 * cross-owner listings no store exposes, and schema-level reads are the same
 * rows the stores' own drizzle seam selects.
 */
export function createOpenMuseOpsSignalReaders(deps: {
  database: Database;
  cleanupView: () => Promise<OpenMuseDeletionCleanupView>;
}): {
  refreshRequired: () => Promise<OpenMuseOpsConnectorFailureRow[]>;
  taskQueue: () => Promise<OpenMuseOpsTaskQueueRow[]>;
  uncertainReviewed: () => Promise<OpenMuseOpsUncertainActionRow[]>;
  cleanupView: () => Promise<OpenMuseDeletionCleanupView>;
} {
  return {
    async refreshRequired() {
      return deps.database
        .select({
          id: openmuseGoogleConnections.id,
          provider: openmuseGoogleConnections.provider,
          lastError: openmuseGoogleConnections.lastError,
        })
        .from(openmuseGoogleConnections)
        .where(eq(openmuseGoogleConnections.status, "refresh_required"));
    },
    async taskQueue() {
      const rows = await deps.database
        .select({
          key: workItems.key,
          payload: workItems.payload,
          runAt: workItems.runAt,
          claimedBy: workItems.claimedBy,
          leaseUntil: workItems.leaseUntil,
          finishedAt: workItems.finishedAt,
          attempts: workItems.attempts,
          lastError: workItems.lastError,
        })
        .from(workItems)
        .where(
          // finishedAt IS NULL is not a threshold or lease judgement — it is
          // the population bound — so it belongs in the query: settled rows
          // never become signals, and pushing the predicate down keeps the
          // reap window's already-finished payloads off the wire.
          and(
            eq(workItems.kind, OPENMUSE_TASK_KIND),
            isNull(workItems.finishedAt),
          ),
        );
      // Resume/retry/answer re-offer under a fresh key with the taskId in
      // the payload, so the payload is the address that is always right.
      return rows.map((row) => ({
        key: row.key,
        taskId:
          typeof row.payload?.taskId === "string" ? row.payload.taskId : null,
        runAt: row.runAt,
        claimedBy: row.claimedBy,
        leaseUntil: row.leaseUntil,
        finishedAt: row.finishedAt,
        attempts: row.attempts,
        lastError: row.lastError,
      }));
    },
    async uncertainReviewed() {
      // §6 truth is the ACTION's status (a reconciled-confirmed attempt row
      // keeps outcome_unknown while its action has settled), so the actions
      // lead and each row carries its own latest attempt.
      const actions = await deps.database
        .select({
          id: openmuseReviewedActions.id,
          ownerUserId: openmuseReviewedActions.ownerUserId,
          createdAt: openmuseReviewedActions.createdAt,
        })
        .from(openmuseReviewedActions)
        .where(eq(openmuseReviewedActions.status, "outcome_unknown"));
      if (actions.length === 0) return [];
      const attempts = await deps.database
        .select()
        .from(openmuseReviewedAttempts)
        .where(
          inArray(
            openmuseReviewedAttempts.actionId,
            actions.map((action) => action.id),
          ),
        )
        // The attempt id is the tiebreak: two attempts sharing a startedAt
        // instant must name the same "latest" across query plans and
        // restarts, or the operator's answer drifts between reads.
        .orderBy(
          desc(openmuseReviewedAttempts.startedAt),
          desc(openmuseReviewedAttempts.attemptId),
        );
      const latest = new Map<string, (typeof attempts)[number]>();
      for (const attempt of attempts)
        if (!latest.has(attempt.actionId))
          latest.set(attempt.actionId, attempt);
      return actions.map((action) => {
        const attempt = latest.get(action.id);
        return {
          actionId: action.id,
          ownerUserId: action.ownerUserId,
          createdAt: action.createdAt,
          attempt: attempt
            ? {
                attemptId: attempt.attemptId,
                reconciliation: attempt.reconciliation?.outcome ?? null,
              }
            : null,
        };
      });
    },
    cleanupView: deps.cleanupView,
  };
}
