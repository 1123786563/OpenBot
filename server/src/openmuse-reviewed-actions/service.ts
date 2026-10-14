import { randomUUID } from "node:crypto";
import type { OpenMuseGoogleOAuth } from "../openmuse-connectors/google-oauth";
import type { ReviewedActionExecutor } from "./executor";
import {
  payloadHashOf,
  REVIEWED_ACTION_TTL_MS,
  type ReviewedActionKind,
  type ReviewedActionProposal,
  replyBindingOf,
} from "./proposal";

/**
 * R02: a real executor may expose a pre-claim guard the service runs before
 * the atomic claim — the Gmail executor's connection/account check, so a
 * disconnected account (409) or a re-bound one (409/stale) is refused with the
 * row still `awaiting_review` and zero provider dials. The fake has none.
 */
export type ClaimGuardedExecutor = ReviewedActionExecutor & {
  preflight?(proposal: ReviewedActionProposal): Promise<void>;
};

import {
  type AttemptReconciliation,
  OpenMuseOwnerDisabledError,
  type ReviewedActionRows,
  type StoredReviewedAction,
  type StoredReviewedAttempt,
} from "./store";

/**
 * The §6 orchestration: propose, decide (deny / approve→claim→execute→settle),
 * cancel, reconcile. Every status change is the row seam's one
 * `claimTransition` — an atomic compare-and-swap — so two simultaneous
 * approvals produce exactly one executor call, and a repeated decision after
 * settle re-answers the stored record without touching the provider.
 *
 * R04 owns the uncertain tail: an outcome_unknown send is never re-offered
 * (the re-proposal gate blocks the same logical send), and an operator's
 * reconciliation is the only thing that closes it — confirmed_succeeded →
 * succeeded, confirmed_not_sent → failed (the one door back to a fresh
 * proposal), unresolved → still uncertain, warning intact, evidence appended.
 */

export type ReviewedActionProposeInput = {
  kind: ReviewedActionKind;
  payload: unknown;
  accountEmail: string;
  connectionGeneration: number;
  targetId?: string;
  targetVersion?: string;
  attachmentVersionIds?: string[];
};

/** §6: a decision may carry the client's view; a mismatch is 409/stale. */
export type ReviewedActionGuards = {
  payloadHash?: string;
  accountEmail?: string;
  connectionGeneration?: number;
  targetVersion?: string;
  /** R03: the reply target the decision was made in (the payload's binding). */
  threadId?: string;
  replyToMessageId?: string;
};

export type ReconcileOutcome = AttemptReconciliation["outcome"];

/** §6 receipt: attempt id, fingerprint, provider ref, decided/attempted/completed. */
export type ReviewedActionReceipt = {
  attemptId: string;
  fingerprint: string | null;
  providerRef: string | null;
  decidedAt: Date | null;
  attemptedAt: Date | null;
  completedAt: Date | null;
  reconciliation: AttemptReconciliation | null;
};

/**
 * R03: which binding drifted — the stable `staleReason` the 409 body carries
 * so the UI knows what to re-propose against.
 */
export type ReviewedActionStaleReason =
  | "payload"
  | "account"
  | "generation"
  | "target";

export class ReviewedActionStaleError extends Error {
  readonly code = "stale" as const;
  constructor(readonly staleReason: ReviewedActionStaleReason) {
    super("This decision was made against a changed proposal; propose again.");
    this.name = "ReviewedActionStaleError";
  }
}

export class ReviewedActionExpiredError extends Error {
  readonly code = "expired" as const;
  readonly status = "expired" as const;
  constructor() {
    super("This proposal expired; a new proposal is required.");
    this.name = "ReviewedActionExpiredError";
  }
}

export class ReviewedActionConflictError extends Error {
  readonly code = "conflict" as const;
  constructor() {
    super("This reviewed action is executing and not decisionable now.");
    this.name = "ReviewedActionConflictError";
  }
}

/**
 * R04's re-proposal gate: the same logical send (owner + kind + payload
 * hash) may only be proposed again once an uncertain prior reached
 * `confirmed_not_sent`. Anything else that left — uncertain, or already
 * sent — answers 409 with the reason the UI shows.
 */
export class ReviewedActionReproposalError extends Error {
  readonly code = "reproposal_blocked" as const;
  constructor(
    readonly reason: "uncertain" | "already_sent" | "already_proposed",
  ) {
    super(
      reason === "uncertain"
        ? "The prior send of this message is still uncertain; an operator must reconcile it before a fresh proposal."
        : reason === "already_sent"
          ? "This exact message was already sent; proposing it again would send it twice."
          : "An identical proposal is already awaiting review; decide it or let it expire before proposing again.",
    );
    this.name = "ReviewedActionReproposalError";
  }
}

/**
 * The gate above is a read, the insert is the write, and no lock spans both:
 * the partial unique index `openmuse_reviewed_actions_active_send_uq` is what
 * actually serializes two racing proposes, so its refusal (driver code 23505
 * naming the index, possibly wrapped in a query error) IS the gate's own
 * answer and must surface as the 409 the UI shows — not an unhandled 503.
 */
function isActiveSendUniqueViolation(error: unknown): boolean {
  for (
    let cause: unknown = error;
    cause !== undefined && cause !== null;
    cause = (cause as { cause?: unknown }).cause
  ) {
    const named = cause as { code?: unknown; constraint?: unknown };
    if (
      named.code === "23505" &&
      String(named.constraint ?? (cause as Error).message ?? "").includes(
        "openmuse_reviewed_actions_active_send_uq",
      )
    ) {
      return true;
    }
  }
  return false;
}

const TERMINAL_STATUSES: ReadonlySet<StoredReviewedAction["status"]> = new Set([
  "denied",
  "expired",
  "cancelled",
  "succeeded",
  "failed",
  "outcome_unknown",
]);

/**
 * How long a claimed row may sit `executing` before a boot-time sweep reads
 * it as abandoned: the executor's own send deadline is 30s, so five minutes
 * of quiet covers any in-flight execution this process is still running
 * while still catching a row orphaned by yesterday's crash.
 */
export const REVIEWED_EXECUTING_GRACE_MS = 5 * 60 * 1000;

export type OpenMuseReviewedActionService = {
  propose(
    ownerUserId: string,
    input: ReviewedActionProposeInput,
  ): Promise<StoredReviewedAction>;
  list(
    ownerUserId: string,
    limit: number,
  ): Promise<{ actions: StoredReviewedAction[] }>;
  get(ownerUserId: string, id: string): Promise<StoredReviewedAction | null>;
  /** Returns null when the id is not this owner's (a 404, not a 403). */
  decide(
    ownerUserId: string,
    id: string,
    decision: "approve" | "deny",
    guards?: ReviewedActionGuards,
  ): Promise<StoredReviewedAction | null>;
  cancel(ownerUserId: string, id: string): Promise<StoredReviewedAction | null>;
  /**
   * R04: the operator's reconciliation of one uncertain action. The caller
   * is the OPERATOR (an admin the routes proved), recorded as the reviewer —
   * not the owner, whose own seat cannot reconcile. R08: kind-agnostic by
   * design, so the same matrix serves gmail.send and every gcalendar kind,
   * and a confirmed_succeeded may carry the `providerEventId` the operator
   * read back — recorded as the attempt's provider ref (the §6 receipt's
   * provider evidence).
   */
  reconcile(
    reviewer: string,
    id: string,
    input: {
      outcome: ReconcileOutcome;
      evidence: string;
      providerEventId?: string;
    },
  ): Promise<StoredReviewedAction | null>;
  receiptOf(actionId: string): Promise<ReviewedActionReceipt | null>;
  /**
   * Crash recovery (§6): flip `executing` rows whose decision started more
   * than the execution grace ago to `outcome_unknown`, the state reconcile
   * owns. Called at boot — the rows this targets only exist when a process
   * died between the claim and the settle, so the caller that could settle
   * them is gone. Rows this process is executing right now are inside the
   * grace and untouched.
   */
  recoverAbandonedExecutions(): Promise<string[]>;
  /** §9 lifecycle hooks. */
  disableOwner(ownerUserId: string): Promise<void>;
  restoreOwner(ownerUserId: string): Promise<void>;
  /**
   * D08 (§9): the removal seam the deletion manifest's final purge calls —
   * the rows' `hardDeleteActions`, owner-scoped and idempotent.
   */
  hardDelete(ownerUserId: string, ids: string[]): Promise<void>;
  enumerateOwner(
    ownerUserId: string,
  ): Promise<Array<{ kind: "openmuse-reviewed-action"; id: string }>>;
};

export function createOpenMuseReviewedActionService(deps: {
  rows: ReviewedActionRows;
  executor: ClaimGuardedExecutor;
  now?: () => Date;
}): OpenMuseReviewedActionService {
  const { rows, executor } = deps;
  const now = deps.now ?? (() => new Date());
  /*
   * One execution per action id, shared so the loser of a simultaneous claim
   * awaits the winner's settle and both callers answer the same record. A
   * flight absent from this map (another process's execution) leaves the row
   * `executing`: decide/cancel answer 409, and the row is only re-opened by
   * {@link recoverAbandonedExecutions} flipping it to outcome_unknown past
   * the execution grace, which reconcile then closes — it never replays (§6).
   */
  const inFlight = new Map<string, Promise<StoredReviewedAction>>();

  const readOwned = async (ownerUserId: string, id: string) => {
    const action = await rows.getAction(id);
    // Foreign reads are 404s: existence is not disclosed.
    return action && action.ownerUserId === ownerUserId ? action : null;
  };

  const current = async (id: string): Promise<StoredReviewedAction> => {
    const action = await rows.getAction(id);
    if (!action) {
      throw new ReviewedActionConflictError();
    }
    return action;
  };

  const settleExecution = async (
    claimed: StoredReviewedAction,
  ): Promise<StoredReviewedAction> => {
    const attemptId = `openmuse-reviewed-attempt-${randomUUID()}`;
    // The attempt row before the dial: a crash mid-execution leaves the
    // durable attemptId reconciliation works from (§6).
    await rows.insertAttempt({
      attemptId,
      actionId: claimed.id,
      fingerprint: null,
      outcome: null,
      providerRef: null,
      startedAt: now(),
      completedAt: null,
      reconciliation: null,
    });
    const result = await executor.execute(toProposal(claimed));
    const completedAt = now();
    const settled = await rows.claimTransition(
      claimed.id,
      "executing",
      result.outcome,
      {
        completedAt,
        ...(result.providerRef !== undefined
          ? { providerRef: result.providerRef }
          : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      },
    );
    await rows.updateAttempt(attemptId, {
      fingerprint: result.fingerprint,
      outcome: result.outcome,
      ...(result.providerRef !== undefined
        ? { providerRef: result.providerRef }
        : {}),
      completedAt,
    });
    return settled ?? (await current(claimed.id));
  };

  const afterLostClaim = async (id: string): Promise<StoredReviewedAction> => {
    const action = await current(id);
    if (TERMINAL_STATUSES.has(action.status)) return action;
    const flight = inFlight.get(id);
    if (flight) return await flight;
    throw new ReviewedActionConflictError();
  };

  const decide = async (
    ownerUserId: string,
    id: string,
    decision: "approve" | "deny",
    guards?: ReviewedActionGuards,
  ) => {
    if (await rows.ownerDisabled(ownerUserId)) {
      throw new OpenMuseOwnerDisabledError(ownerUserId);
    }
    const action = await readOwned(ownerUserId, id);
    if (!action) return null;
    if (TERMINAL_STATUSES.has(action.status)) return action;
    if (action.status === "executing") return await afterLostClaim(id);

    // §6: changed hash/account/generation/target is 409, zero calls; each
    // refusal names which binding drifted (R03's staleReason).
    if (
      guards?.payloadHash !== undefined &&
      guards.payloadHash !== action.payloadHash
    ) {
      throw new ReviewedActionStaleError("payload");
    }
    if (
      guards?.accountEmail !== undefined &&
      guards.accountEmail !== action.accountEmail
    ) {
      throw new ReviewedActionStaleError("account");
    }
    if (
      guards?.connectionGeneration !== undefined &&
      guards.connectionGeneration !== action.connectionGeneration
    ) {
      throw new ReviewedActionStaleError("generation");
    }
    if (
      guards?.targetVersion !== undefined &&
      guards.targetVersion !== action.targetVersion
    ) {
      throw new ReviewedActionStaleError("target");
    }
    // R03: the reply target binds inside the canonical payload — a decision
    // made in another thread (or against another message) is stale too.
    const binding = replyBindingOf(action.canonicalPayload);
    if (
      guards?.threadId !== undefined &&
      guards.threadId !== binding.threadId
    ) {
      throw new ReviewedActionStaleError("target");
    }
    if (
      guards?.replyToMessageId !== undefined &&
      guards.replyToMessageId !== binding.replyToMessageId
    ) {
      throw new ReviewedActionStaleError("target");
    }

    const at = now();
    // §6: expiry at expiresAt refuses the decision and flips the row.
    if (at.getTime() >= action.expiresAt.getTime()) {
      const flipped = await rows.claimTransition(
        action.id,
        "awaiting_review",
        "expired",
      );
      if (flipped) throw new ReviewedActionExpiredError();
      return await current(action.id);
    }

    if (decision === "deny") {
      return (
        (await rows.claimTransition(action.id, "awaiting_review", "denied", {
          decidedAt: at,
        })) ?? (await current(action.id))
      );
    }

    // R02: the executor's pre-claim guard — its refusals (409/503) leave the
    // row awaiting_review, so a disconnected or re-bound account never claims.
    await executor.preflight?.(toProposal(action));

    // §6 TTL, re-checked with a FRESH clock: a preflight can spend real time
    // (the calendar executors' etag pre-check read waits up to their own
    // 30-second deadline), and a proposal that crossed expiresAt during it
    // must not claim and reach the provider past its review window.
    if (now().getTime() >= action.expiresAt.getTime()) {
      const flipped = await rows.claimTransition(
        action.id,
        "awaiting_review",
        "expired",
      );
      if (flipped) throw new ReviewedActionExpiredError();
      return await current(action.id);
    }

    const claimed = await rows.claimTransition(
      action.id,
      "awaiting_review",
      "executing",
      { decidedAt: at },
    );
    if (!claimed) return await afterLostClaim(id);
    const execution = settleExecution(claimed);
    inFlight.set(id, execution);
    try {
      return await execution;
    } finally {
      inFlight.delete(id);
    }
  };

  return {
    async propose(ownerUserId, input) {
      if (await rows.ownerDisabled(ownerUserId)) {
        throw new OpenMuseOwnerDisabledError(ownerUserId);
      }
      const payloadHash = payloadHashOf(input.payload);
      // R04's re-proposal gate: a prior action for the SAME logical send
      // that is still uncertain — or was already sent — blocks the fresh
      // proposal; only an operator's confirmed_not_sent re-opens it. That
      // is the whole of §6's "never automatically retried" made durable.
      // The gate is a DIRECTED (owner, kind, payloadHash, targetId) query:
      // a newest-N window would let the owner's later proposals push the
      // blocker out and re-send a message whose first attempt is still
      // unresolved, and the target binding is part of the key because a
      // target-bound delete/update names its event first-class — two deletes
      // of different events on one calendar are two logical sends.
      const blocker = await rows.findSettledSameSend(
        ownerUserId,
        input.kind,
        payloadHash,
        input.targetId ?? null,
      );
      if (blocker !== null) {
        throw new ReviewedActionReproposalError(
          blocker.status === "succeeded" ? "already_sent" : "uncertain",
        );
      }
      const createdAt = now();
      const action: StoredReviewedAction = {
        id: `openmuse-reviewed-action-${randomUUID()}`,
        ownerUserId,
        kind: input.kind,
        canonicalPayload: input.payload,
        payloadHash,
        accountEmail: input.accountEmail,
        connectionGeneration: input.connectionGeneration,
        targetId: input.targetId ?? null,
        targetVersion: input.targetVersion ?? null,
        attachmentVersionIds: input.attachmentVersionIds ?? [],
        status: "awaiting_review",
        expiresAt: new Date(createdAt.getTime() + REVIEWED_ACTION_TTL_MS),
        createdAt,
        decidedAt: null,
        completedAt: null,
        providerRef: null,
        error: null,
      };
      try {
        await rows.insertAction(action);
      } catch (error) {
        if (isActiveSendUniqueViolation(error)) {
          /*
           * Round 6 (M37): the index holds awaiting_review twins too, and
           * for those nothing was ever attempted — "uncertain, call an
           * operator" was a double lie (no operator can help, and nothing
           * is uncertain: the owner simply decides the pending proposal, or
           * lets the 30-minute TTL expire). Re-query including awaiting and
           * answer the twin's real state; executing/outcome_unknown keep
           * "uncertain" as before.
           */
          const twin = await rows.findAwaitingSameSend(
            ownerUserId,
            input.kind,
            payloadHash,
            input.targetId ?? null,
          );
          if (twin !== null) {
            throw new ReviewedActionReproposalError("already_proposed");
          }
          throw new ReviewedActionReproposalError("uncertain");
        }
        throw error;
      }
      return action;
    },

    async list(ownerUserId, limit) {
      if (await rows.ownerDisabled(ownerUserId)) {
        throw new OpenMuseOwnerDisabledError(ownerUserId);
      }
      return { actions: await rows.listByOwner(ownerUserId, { limit }) };
    },

    async get(ownerUserId, id) {
      if (await rows.ownerDisabled(ownerUserId)) {
        throw new OpenMuseOwnerDisabledError(ownerUserId);
      }
      return await readOwned(ownerUserId, id);
    },

    decide,

    async cancel(ownerUserId, id) {
      if (await rows.ownerDisabled(ownerUserId)) {
        throw new OpenMuseOwnerDisabledError(ownerUserId);
      }
      const action = await readOwned(ownerUserId, id);
      if (!action) return null;
      // Cancelled from awaiting_review only; a settled row re-answers itself.
      if (TERMINAL_STATUSES.has(action.status)) return action;
      if (action.status === "executing") {
        throw new ReviewedActionConflictError();
      }
      return (
        (await rows.claimTransition(action.id, "awaiting_review", "cancelled", {
          decidedAt: now(),
        })) ?? (await current(action.id))
      );
    },

    async reconcile(reviewer, id, input) {
      // R04 operator scope: the action answers by id, not by owner — the
      // admin reconciling an owner's uncertain send is not that owner, and
      // §9's owner fence never gates an operator repair.
      const action = await rows.getAction(id);
      if (!action) return null;
      // §6: reconciliation is for outcome_unknown only; never a retry.
      if (action.status !== "outcome_unknown") {
        throw new ReviewedActionConflictError();
      }
      let attempt = await rows.latestAttempt(id);
      if (!attempt) {
        /*
         * Round 6 (H8): the crash window between the decide claim (row →
         * executing) and the attempt insert leaves the row flipped to
         * outcome_unknown by boot recovery with NO attempt row — a dead end
         * the old ConflictError wedged permanently: reconcile 409'd, the
         * re-proposal gate blocked the logical send forever, and only a
         * manual DB edit could free it. Backfill a tombstone attempt
         * (recovery-created, no fingerprint) so the operator's
         * reconciliation has a row to record against, exactly as the
         * finding's first remedy asks.
         */
        const backfilled: StoredReviewedAttempt = {
          attemptId: `openmuse-reviewed-attempt-${randomUUID()}`,
          actionId: id,
          fingerprint: null,
          outcome: "outcome_unknown",
          providerRef: null,
          startedAt: action.decidedAt ?? action.createdAt,
          completedAt: null,
          reconciliation: null,
        };
        await rows.insertAttempt(backfilled);
        attempt = backfilled;
      }
      const evidence = sanitizeEvidence(input.evidence);
      // Only an unresolved record leaves the action uncertain, so a prior
      // record can only be unresolved evidence: later evidence appends —
      // NEWEST FIRST, because appending after a saturated prior head would
      // slice the operator's latest evidence away entirely, and the latest
      // evidence is what a reconciliation is for.
      const recorded = attempt.reconciliation
        ? `${evidence} | ${attempt.reconciliation.evidence}`.slice(0, 2000)
        : evidence;
      await rows.updateAttempt(attempt.attemptId, {
        reconciliation: {
          outcome: input.outcome,
          evidence: recorded,
          reviewer,
        },
        // R08: the read-back event id — the operator's provider evidence,
        // recorded on the attempt row so the receipt's provider ref cites
        // what the confirmation was actually read back from.
        ...(input.outcome === "confirmed_succeeded" && input.providerEventId
          ? { providerRef: input.providerEventId }
          : {}),
      });
      if (input.outcome === "unresolved") {
        // Unresolved keeps the warning: the row stays outcome_unknown with
        // its error verbatim, and reconcile stays open for more evidence.
        return await current(id);
      }
      /*
       * Round 6 (M36): the settling transition carries the same bookkeeping
       * the normal execution path (settleExecution) writes — completedAt,
       * and the read-back provider ref on a confirmed success — so the
       * action row and the attempt row agree. Without it, one reconciled
       * action answered providerRef/completedAt null at the top level while
       * its receipt carried values: two ledgers, one truth.
       */
      const settled = await rows.claimTransition(
        id,
        "outcome_unknown",
        input.outcome === "confirmed_succeeded" ? "succeeded" : "failed",
        {
          completedAt: now(),
          ...(input.outcome === "confirmed_succeeded" && input.providerEventId
            ? { providerRef: input.providerEventId }
            : {}),
        },
      );
      return settled ?? (await current(id));
    },

    async receiptOf(actionId) {
      const action = await rows.getAction(actionId);
      if (!action) return null;
      const attempt = await rows.latestAttempt(actionId);
      if (!attempt) return null;
      return {
        attemptId: attempt.attemptId,
        fingerprint: attempt.fingerprint,
        providerRef: attempt.providerRef,
        decidedAt: action.decidedAt,
        attemptedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
        reconciliation: attempt.reconciliation,
      };
    },

    disableOwner: (ownerUserId) => rows.disableOwner(ownerUserId),
    restoreOwner: (ownerUserId) => rows.restoreOwner(ownerUserId),
    hardDelete: (ownerUserId, ids) => rows.hardDeleteActions(ownerUserId, ids),

    async recoverAbandonedExecutions() {
      const cutoff = new Date(now().getTime() - REVIEWED_EXECUTING_GRACE_MS);
      return rows.resetStaleExecuting(cutoff);
    },

    async enumerateOwner(ownerUserId) {
      return (await rows.listIdsByOwner(ownerUserId)).map((id) => ({
        kind: "openmuse-reviewed-action" as const,
        id,
      }));
    },
  };
}

function toProposal(action: StoredReviewedAction): ReviewedActionProposal {
  return {
    id: action.id,
    ownerUserId: action.ownerUserId,
    kind: action.kind,
    payload: action.canonicalPayload,
    accountEmail: action.accountEmail,
    connectionGeneration: action.connectionGeneration,
    targetId: action.targetId,
    targetVersion: action.targetVersion,
    attachmentVersionIds: action.attachmentVersionIds,
  };
}

/*
 * R04/G06: reconciliation evidence is operator free text recorded durably,
 * so anything token-shaped is stripped before it is stored — the same shapes
 * G06's display guard strips (ya29 access grants, 1//0 refresh grants,
 * Bearer prefixes, any base64-ish run of 40+ characters). Ordinary prose
 * words sit far below that ceiling and pass untouched.
 */
const TOKEN_SHAPED: readonly RegExp[] = [
  /ya29\.[A-Za-z0-9._-]+/g,
  /1\/\/0[A-Za-z0-9._-]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /[A-Za-z0-9+/_-]{40,}/g,
];

function sanitizeEvidence(evidence: string): string {
  let out = evidence;
  for (const shape of TOKEN_SHAPED) out = out.replaceAll(shape, "[REDACTED]");
  return out.slice(0, 2000);
}

/**
 * T16 (§6/§7): the document reply's reviewed-action seam — the one export the
 * openmuse-tasks runner consumes for its post-fill reply phase. `propose` is
 * the proposal-creation half: it binds the owner's connected Gmail seat
 * through G01's requireConnection (a disconnected or refresh-required account
 * answers the stable 409 BEFORE any proposal exists — surfaced, never
 * fabricated past), then proposes ONE `gmail.send` whose payload is the
 * carriage's reply binding (R03: threadId/replyToMessageId bind inside the
 * canonical payload) and whose `attachmentVersionIds` is the EXACT derived
 * version the task just filled. `resolve` is the poll half: one cheap
 * single-row read of the proposal's status, with the §6 receipt when the
 * attempt settled — a decision webhook is deliberately NOT invented.
 */
export type DocumentReplyReview = {
  propose(input: {
    ownerUserId: string;
    payload: {
      to: string[];
      subject: string;
      body: string;
      threadId: string;
      replyToMessageId: string;
    };
    attachmentVersionIds: string[];
  }): Promise<{ proposalId: string }>;
  resolve(
    ownerUserId: string,
    proposalId: string,
  ): Promise<{
    status: StoredReviewedAction["status"];
    error: string | null;
    receipt: { attemptId: string; providerRef: string | null } | null;
  }>;
};

/** T16: compose the seam from a real service and G01's connection guard. */
export function createDocumentReplyReview(deps: {
  service: OpenMuseReviewedActionService;
  requireConnection: OpenMuseGoogleOAuth["requireConnection"];
}): DocumentReplyReview {
  const { service, requireConnection } = deps;
  return {
    async propose(input) {
      // The account/generation bind BEFORE the proposal: a 409 here surfaces
      // on the task row pre-proposal, and no proposal row is ever created
      // against a seat the owner cannot send from.
      const connection = await requireConnection(input.ownerUserId, "gmail");
      const action = await service.propose(input.ownerUserId, {
        kind: "gmail.send",
        payload: input.payload,
        accountEmail: connection.accountEmail,
        connectionGeneration: connection.generation,
        attachmentVersionIds: input.attachmentVersionIds,
      });
      return { proposalId: action.id };
    },
    async resolve(ownerUserId, proposalId) {
      const action = await service.get(ownerUserId, proposalId);
      if (action === null)
        return {
          status: "failed",
          error: "The review proposal could not be read.",
          receipt: null,
        };
      const settled =
        action.status === "succeeded" ||
        action.status === "failed" ||
        action.status === "outcome_unknown";
      if (!settled)
        return { status: action.status, error: action.error, receipt: null };
      const receipt = await service.receiptOf(action.id);
      return {
        status: action.status,
        error: action.error,
        receipt:
          receipt === null
            ? null
            : {
                attemptId: receipt.attemptId,
                providerRef: receipt.providerRef,
              },
      };
    },
  };
}
