import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client";
import {
  type OpenMuseReviewedActionRow,
  type OpenMuseReviewedAttemptRow,
  openmuseReviewedActions,
  openmuseReviewedAttempts,
} from "../db/schema/openmuse";
import { OpenMuseOwnerDisabledError } from "../openmuse-connectors/google-oauth";
import { openmuseAccountDeletions } from "../openmuse-deletion/store";
import type { ReviewedActionKind } from "./proposal";

/**
 * The reviewed-action store: the §6 statuses, the two stored row shapes, the
 * row seam the service runs on (drizzle in a deployment, arrays in tests) and
 * the ONE compare-and-swap primitive every legal transition funnels through —
 * `claimTransition` is a real `UPDATE ... WHERE status = $from` over the
 * drizzle rows, and the in-memory rows honor the same atomicity, so the tests
 * prove the store rather than simulate it.
 */

export type ReviewedActionStatus =
  | "awaiting_review"
  | "denied"
  | "expired"
  | "cancelled"
  | "executing"
  | "succeeded"
  | "failed"
  | "outcome_unknown";

export type StoredReviewedAction = {
  id: string;
  ownerUserId: string;
  kind: ReviewedActionKind;
  canonicalPayload: unknown;
  payloadHash: string;
  accountEmail: string;
  connectionGeneration: number;
  targetId: string | null;
  targetVersion: string | null;
  attachmentVersionIds: string[];
  status: ReviewedActionStatus;
  expiresAt: Date;
  createdAt: Date;
  decidedAt: Date | null;
  completedAt: Date | null;
  providerRef: string | null;
  error: string | null;
};

/** §6 human reconciliation, recorded on the attempt it reconciles. */
export type AttemptReconciliation = {
  outcome: "confirmed_succeeded" | "confirmed_not_sent" | "unresolved";
  evidence: string;
  reviewer: string;
};

export type StoredReviewedAttempt = {
  attemptId: string;
  actionId: string;
  fingerprint: string | null;
  outcome: "succeeded" | "failed" | "outcome_unknown" | null;
  providerRef: string | null;
  startedAt: Date;
  completedAt: Date | null;
  reconciliation: AttemptReconciliation | null;
};

/** The claim/settle write alongside a CAS transition, both timestamps explicit. */
export type ClaimPatch = {
  decidedAt?: Date;
  completedAt?: Date;
  providerRef?: string;
  error?: string;
};

export type ReviewedActionRows = {
  insertAction(action: StoredReviewedAction): Promise<void>;
  getAction(id: string): Promise<StoredReviewedAction | null>;
  listByOwner(
    ownerUserId: string,
    page: { limit: number; before?: { createdAt: Date; id: string } },
  ): Promise<StoredReviewedAction[]>;
  /**
   * R04's re-proposal gate, as a DIRECTED query: the owner's newest prior of
   * this exact (kind, payloadHash, targetId) that is still uncertain — or
   * was already sent, or is executing — whatever else the owner has proposed
   * since. The gate must not depend on the owner's history staying short
   * enough to fit a newest-first window. The target binding is part of the
   * key because target-bound kinds (gcalendar.update/delete) carry only the
   * calendar in their payload: without the target, every delete on one
   * calendar hashes identically and a second legitimate delete is 409'd as
   * "already sent" forever.
   */
  findSettledSameSend(
    ownerUserId: string,
    kind: ReviewedActionKind,
    payloadHash: string,
    targetId: string | null,
  ): Promise<StoredReviewedAction | null>;
  /**
   * Round 6 (M37): the awaiting_review twin of the same directed key — what
   * the 23505 fallback re-queries to tell "an identical proposal is already
   * pending" (the owner decides it) from "a prior send is uncertain" (an
   * operator reconciles it). Same key discipline as
   * {@link findSettledSameSend}: target rides the key, newest first.
   */
  findAwaitingSameSend(
    ownerUserId: string,
    kind: ReviewedActionKind,
    payloadHash: string,
    targetId: string | null,
  ): Promise<StoredReviewedAction | null>;
  /**
   * Crash recovery (§6): flip every `executing` row whose decision started
   * before the cutoff to `outcome_unknown` — the state reconcile owns — so a
   * process that died between claim and settle cannot leave the row
   * undecidable forever. Returns the recovered ids.
   */
  resetStaleExecuting(cutoff: Date): Promise<string[]>;
  /**
   * The §6 atomic claim: flips `from` → `to` only when the row still reads
   * `from`, returning the updated row or null for a lost race.
   */
  claimTransition(
    id: string,
    from: ReviewedActionStatus,
    to: ReviewedActionStatus,
    patch?: ClaimPatch,
  ): Promise<StoredReviewedAction | null>;
  insertAttempt(attempt: StoredReviewedAttempt): Promise<void>;
  latestAttempt(actionId: string): Promise<StoredReviewedAttempt | null>;
  updateAttempt(
    attemptId: string,
    patch: {
      fingerprint?: string;
      outcome?: StoredReviewedAttempt["outcome"];
      providerRef?: string | null;
      completedAt?: Date;
      reconciliation?: AttemptReconciliation;
    },
  ): Promise<StoredReviewedAttempt | null>;
  ownerDisabled(ownerUserId: string): Promise<boolean>;
  disableOwner(ownerUserId: string): Promise<void>;
  restoreOwner(ownerUserId: string): Promise<void>;
  listIdsByOwner(ownerUserId: string): Promise<string[]>;
  /**
   * D02 (§9 work shutdown): the owner-scoped bulk awaiting_review →
   * cancelled transition a deleted owner's pending write work lands through.
   * One guarded write — `WHERE status = 'awaiting_review'` — so executing
   * rows are UNTOUCHED: their uncertain outcome stays for R04's
   * reconciliation, never fabricated away.
   */
  cancelAwaiting(ownerUserId: string): Promise<string[]>;
  /**
   * D08 (§9): hard-delete the owner's rows for the manifest's ids — attempts
   * ride the action row's cascade, so one statement per batch is atomic.
   * Owner-scoped: a foreign id deletes nothing; a repeat (the idempotent
   * re-cleanup) deletes nothing either.
   */
  hardDeleteActions(ownerUserId: string, ids: string[]): Promise<void>;
};

/*
 * The owner's reviewed-action surface is turned off (§9 disable); rows
 * survive. THE ONE identity is google-oauth's own class (re-exported here so
 * this module's historic import path keeps working): a second same-named
 * class would fall through every 403 instanceof branch that checks the
 * connectors-raised one, and the two could not be told apart in logs.
 */
export { OpenMuseOwnerDisabledError };

// ── drizzle rows ────────────────────────────────────────────────────────────

/**
 * The deployment's rows. Untested directly (the house convention: unit tests
 * fake the row seam) — the migration and the service tests over the fake pin
 * the same contract, `claimTransition`'s WHERE clause included.
 */
export function createOpenMuseReviewedActionRows(
  database: Database,
): ReviewedActionRows {
  return {
    async insertAction(action) {
      await database.insert(openmuseReviewedActions).values({
        id: action.id,
        ownerUserId: action.ownerUserId,
        kind: action.kind,
        canonicalPayload: action.canonicalPayload,
        payloadHash: action.payloadHash,
        accountEmail: action.accountEmail,
        connectionGeneration: action.connectionGeneration,
        targetId: action.targetId,
        targetVersion: action.targetVersion,
        attachmentVersionIds: action.attachmentVersionIds,
        status: action.status,
        expiresAt: action.expiresAt,
        createdAt: action.createdAt,
        decidedAt: action.decidedAt,
        completedAt: action.completedAt,
        providerRef: action.providerRef,
        error: action.error,
      });
    },
    async getAction(id) {
      const [row] = await database
        .select()
        .from(openmuseReviewedActions)
        .where(eq(openmuseReviewedActions.id, id))
        .limit(1);
      return row ? rowToAction(row) : null;
    },
    async listByOwner(ownerUserId, { limit, before }) {
      // drizzle's or() answers SQL | undefined (an empty or() is nothing);
      // the array takes both, and and() skips the undefined entries.
      const conditions: Array<SQL | undefined> = [
        eq(openmuseReviewedActions.ownerUserId, ownerUserId),
      ];
      if (before) {
        // The full keyset in SQL, the tasks store's own fixed shape: a strict
        // createdAt-only comparison drops same-millisecond rows the in-memory
        // order says are reachable — the id tiebreak must ride the WHERE too.
        conditions.push(
          or(
            lt(openmuseReviewedActions.createdAt, before.createdAt),
            and(
              eq(openmuseReviewedActions.createdAt, before.createdAt),
              lt(openmuseReviewedActions.id, before.id),
            ),
          ),
        );
      }
      const rows = await database
        .select()
        .from(openmuseReviewedActions)
        .where(and(...conditions))
        .orderBy(
          desc(openmuseReviewedActions.createdAt),
          desc(openmuseReviewedActions.id),
        )
        .limit(limit);
      return rows.map(rowToAction);
    },
    async findSettledSameSend(ownerUserId, kind, payloadHash, targetId) {
      const [row] = await database
        .select()
        .from(openmuseReviewedActions)
        .where(
          and(
            eq(openmuseReviewedActions.ownerUserId, ownerUserId),
            eq(openmuseReviewedActions.kind, kind),
            eq(openmuseReviewedActions.payloadHash, payloadHash),
            // The target binding keys the gate with the payload hash: null
            // matches null (the payload-bound kinds), an id matches itself.
            targetId === null
              ? isNull(openmuseReviewedActions.targetId)
              : eq(openmuseReviewedActions.targetId, targetId),
            inArray(openmuseReviewedActions.status, [
              "executing",
              "outcome_unknown",
              "succeeded",
            ]),
          ),
        )
        .orderBy(desc(openmuseReviewedActions.createdAt))
        .limit(1);
      return row ? rowToAction(row) : null;
    },
    async findAwaitingSameSend(ownerUserId, kind, payloadHash, targetId) {
      const [row] = await database
        .select()
        .from(openmuseReviewedActions)
        .where(
          and(
            eq(openmuseReviewedActions.ownerUserId, ownerUserId),
            eq(openmuseReviewedActions.kind, kind),
            eq(openmuseReviewedActions.payloadHash, payloadHash),
            targetId === null
              ? isNull(openmuseReviewedActions.targetId)
              : eq(openmuseReviewedActions.targetId, targetId),
            eq(openmuseReviewedActions.status, "awaiting_review"),
          ),
        )
        .orderBy(desc(openmuseReviewedActions.createdAt))
        .limit(1);
      return row ? rowToAction(row) : null;
    },
    async resetStaleExecuting(cutoff) {
      const rows = await database
        .update(openmuseReviewedActions)
        .set({
          status: "outcome_unknown",
          error:
            "The executing attempt was abandoned by a restart; whether it was applied is unknown.",
        })
        .where(
          and(
            eq(openmuseReviewedActions.status, "executing"),
            lt(openmuseReviewedActions.decidedAt, cutoff),
          ),
        )
        .returning({ id: openmuseReviewedActions.id });
      return rows.map((row) => row.id);
    },
    async claimTransition(id, from, to, patch) {
      const [row] = await database
        .update(openmuseReviewedActions)
        .set({
          status: to,
          ...(patch?.decidedAt !== undefined
            ? { decidedAt: patch.decidedAt }
            : {}),
          ...(patch?.completedAt !== undefined
            ? { completedAt: patch.completedAt }
            : {}),
          ...(patch?.providerRef !== undefined
            ? { providerRef: patch.providerRef }
            : {}),
          ...(patch?.error !== undefined ? { error: patch.error } : {}),
        })
        .where(
          and(
            eq(openmuseReviewedActions.id, id),
            eq(openmuseReviewedActions.status, from),
          ),
        )
        .returning();
      return row ? rowToAction(row) : null;
    },
    async insertAttempt(attempt) {
      await database.insert(openmuseReviewedAttempts).values(attempt);
    },
    async latestAttempt(actionId) {
      const [row] = await database
        .select()
        .from(openmuseReviewedAttempts)
        .where(eq(openmuseReviewedAttempts.actionId, actionId))
        .orderBy(desc(openmuseReviewedAttempts.startedAt))
        .limit(1);
      return row ? rowToAttempt(row) : null;
    },
    async updateAttempt(attemptId, patch) {
      const [row] = await database
        .update(openmuseReviewedAttempts)
        .set(patch)
        .where(eq(openmuseReviewedAttempts.attemptId, attemptId))
        .returning();
      return row ? rowToAttempt(row) : null;
    },
    /*
     * D01's marker table IS the deleted-owner fence, read directly the way
     * the connectors store and the personal store read it (round 6 M38): the
     * stub that always answered false disarmed the service-level fence
     * entirely — propose/decide/list/get and the activity lister — leaving
     * only the /api/mobile fence middleware, which the T16 background
     * runner path (createDocumentReplyReview.propose) never crosses.
     * Phase-aware like every other reader: a restored marker re-admits.
     */
    async ownerDisabled(ownerUserId) {
      const rows = await database
        .select({ userId: openmuseAccountDeletions.userId })
        .from(openmuseAccountDeletions)
        .where(
          and(
            eq(openmuseAccountDeletions.userId, ownerUserId),
            eq(openmuseAccountDeletions.phase, "fenced"),
          ),
        );
      return rows.length > 0;
    },
    async disableOwner() {},
    async restoreOwner() {},
    async listIdsByOwner(ownerUserId) {
      const rows = await database
        .select({ id: openmuseReviewedActions.id })
        .from(openmuseReviewedActions)
        .where(eq(openmuseReviewedActions.ownerUserId, ownerUserId));
      return rows.map((row) => row.id);
    },
    async hardDeleteActions(ownerUserId, ids) {
      if (ids.length === 0) return;
      await database
        .delete(openmuseReviewedActions)
        .where(
          and(
            eq(openmuseReviewedActions.ownerUserId, ownerUserId),
            inArray(openmuseReviewedActions.id, ids),
          ),
        );
    },
    async cancelAwaiting(ownerUserId) {
      // One guarded write: awaiting_review only, exactly the §6 cancel the
      // owner's own cancel() lands — executing stays for reconciliation.
      const rows = await database
        .update(openmuseReviewedActions)
        .set({ status: "cancelled", decidedAt: sql`now()` })
        .where(
          and(
            eq(openmuseReviewedActions.ownerUserId, ownerUserId),
            eq(openmuseReviewedActions.status, "awaiting_review"),
          ),
        )
        .returning({ id: openmuseReviewedActions.id });
      return rows.map((row) => row.id);
    },
  };
}

/**
 * V01's ONE store addition (noted in its checkpoint): the Activity feed's
 * reviewed-action read — this owner's `awaiting_review` and `outcome_unknown`
 * rows, newest first with the same (createdAt,id) cursor as `listByOwner`.
 * The status filter lives in the query, not after it, so an owner's settled
 * history cannot crowd live rows off a page. Read-only over the same rows
 * the service owns, behind the same §9 fence (`rows.ownerDisabled`, so D01's
 * marker gates it without another seam).
 */
export function createOpenMuseActivityReviewedLister(deps: {
  database: Database;
  rows: ReviewedActionRows;
}) {
  return async function listReviewedForActivity(
    ownerUserId: string,
    page: { limit: number; before?: { createdAt: Date; id: string } },
  ): Promise<StoredReviewedAction[]> {
    if (await deps.rows.ownerDisabled(ownerUserId)) {
      throw new OpenMuseOwnerDisabledError(ownerUserId);
    }
    const conditions: Array<SQL | undefined> = [
      eq(openmuseReviewedActions.ownerUserId, ownerUserId),
      inArray(openmuseReviewedActions.status, [
        "awaiting_review",
        "outcome_unknown",
      ]),
    ];
    if (page.before) {
      // The same (createdAt, id) keyset the order walks: createdAt alone
      // would drop the same-millisecond rows whose id sorts below the
      // cursor's before the memory filter ever sees them.
      conditions.push(
        or(
          lt(openmuseReviewedActions.createdAt, page.before.createdAt),
          and(
            eq(openmuseReviewedActions.createdAt, page.before.createdAt),
            lt(openmuseReviewedActions.id, page.before.id),
          ),
        ),
      );
    }
    const rows = await deps.database
      .select()
      .from(openmuseReviewedActions)
      .where(and(...conditions))
      .orderBy(
        desc(openmuseReviewedActions.createdAt),
        desc(openmuseReviewedActions.id),
      )
      .limit(page.limit);
    return rows.map(rowToAction);
  };
}

function rowToAction(row: OpenMuseReviewedActionRow): StoredReviewedAction {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    kind: row.kind,
    canonicalPayload: row.canonicalPayload,
    payloadHash: row.payloadHash,
    accountEmail: row.accountEmail,
    connectionGeneration: row.connectionGeneration,
    targetId: row.targetId,
    targetVersion: row.targetVersion,
    attachmentVersionIds: row.attachmentVersionIds ?? [],
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    completedAt: row.completedAt,
    providerRef: row.providerRef,
    error: row.error,
  };
}

function rowToAttempt(row: OpenMuseReviewedAttemptRow): StoredReviewedAttempt {
  return {
    attemptId: row.attemptId,
    actionId: row.actionId,
    fingerprint: row.fingerprint,
    outcome: row.outcome,
    providerRef: row.providerRef,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    reconciliation: row.reconciliation ?? null,
  };
}
