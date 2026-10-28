/**
 * Hindsight 13 (#390): the durable revocation ledger's port and status vocabulary.
 *
 * This module is deliberately a leaf — the recall seams import only the recorder interface and
 * the status shape from here, so wiring the ledger into `forgetGenericPreference`,
 * `forgetSourceBoundMemory` and `forgetDerivedJudgment` cannot create an import cycle with the
 * revocation service that owns the source-revocation flow, the deletion retries and the replay.
 *
 * The statuses are the ticket's third acceptance clause made into types: what the person is
 * told FIRST is that the memory stopped being used (and when), and the remote copy cleanup is
 * reported separately and honestly — `outstanding` counts documents whose deletion the service
 * has not confirmed, and NOTHING in this vocabulary may claim all controlled copies are
 * cleared. That completion evidence is a later ticket's (#14); a 2xx/404 on one document is
 * the only "confirmed" this ledger ever records.
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { hindsightRevocations } from "../db/schema/hindsight-revocations";

/** The bank kinds a revoked document may live in; the retry drain re-mints these. */
export type RevocationBankKind = "user" | "team" | "source" | "bot";

/** What one blocked document looked like when it was blocked. */
export interface RevocationBlockInput {
  tenantId: string;
  principalId: string;
  kind: "memory" | "source" | "bot";
  subjectType?: "preference" | "source_bound" | "derived_judgment" | null;
  targetId: string;
  documentId: string;
  bankId: string;
  bankKind: RevocationBankKind;
  blockedAt: Date;
}

/**
 * What the recall seams hand the ledger around one forget: the block itself (recorded in the
 * same persistence step as the authority-row tombstone), then the remote deletion's outcome
 * once it answered or failed.
 */
export interface PersonalMemoryRevocationRecorder {
  recordBlock(input: RevocationBlockInput): Promise<void>;
  noteDeletionOutcome(input: {
    tenantId: string;
    documentId: string;
    attemptedAt: Date;
    confirmed: boolean;
    error: string | null;
  }): Promise<void>;
}

/** Honest wording for the person: stopped now; remote cleanup is tracked, completion not claimed. */
export const STOPPED_USING_SUMMARY =
  "This memory stopped being used immediately. Cleanup of copies held outside OpenBot is tracked separately; completion is not claimed here.";

/** What a forget answers: the immediate block first, the remote cleanup second. */
export type MemoryRevocationStatus = {
  /** The instant the durable block took effect — what the person is told first. */
  stoppedUsingAt: Date;
  /**
   * The remote copy cleanup. `outstanding` counts documents whose deletion the service has not
   * confirmed; it is never reported as "cleared" — that evidence is not this seam's to claim.
   */
  remoteDeletion: { attempted: boolean; outstanding: number };
  /** Fixed honest wording (STOPPED_USING_SUMMARY); pinned so no caller rewords it into a claim. */
  summary: typeof STOPPED_USING_SUMMARY;
};

/** What a source/bot revocation answers: the same honesty, plus what the block covered. */
export type AuthorizationRevocationStatus = MemoryRevocationStatus & {
  blocked: { sourceBoundMemories: number; derivedJudgments: number };
};

/**
 * The SQL-backed ledger. One row per blocked document (unique per tenant + document), so a
 * re-forget or a replay updates the existing row instead of stacking a second record, and the
 * retry drain has exactly the documents the block named.
 */
export function createDrizzleRevocationLedger(
  database: Database,
  options: { now?: () => Date } = {},
): PersonalMemoryRevocationRecorder & {
  /** Insert-or-refresh ledger rows in bulk; the source-revocation flow writes its whole block set in one step. */
  recordBlocks(inputs: readonly RevocationBlockInput[]): Promise<void>;
} {
  const now = options.now ?? (() => new Date());
  // A module-level closure, not a `this` method: this module's contract is to hand the
  // recorder around, and a destructured `recordBlock` must keep working.
  async function recordBlocks(inputs: readonly RevocationBlockInput[]) {
      if (!inputs.length) return;
      const at = now();
      // One write for the whole block set: the drain's contract is "exactly the documents
      // the block named", so a mid-set failure must leave none of it behind.
      await database.transaction(async (tx) => {
        for (const input of inputs) {
          await tx
            .insert(hindsightRevocations)
            .values({
              tenantId: input.tenantId,
              id: randomUUID(),
              principalId: input.principalId,
              kind: input.kind,
              subjectType: input.subjectType ?? null,
              targetId: input.targetId,
              documentId: input.documentId,
              bankId: input.bankId,
              bankKind: input.bankKind,
              blockedAt: input.blockedAt,
              deletionState: "pending",
              createdAt: at,
              updatedAt: at,
            })
            .onConflictDoUpdate({
              target: [
                hindsightRevocations.tenantId,
                hindsightRevocations.documentId,
              ],
              set: {
                kind: input.kind,
                subjectType: input.subjectType ?? null,
                targetId: input.targetId,
                bankId: input.bankId,
                bankKind: input.bankKind,
                blockedAt: input.blockedAt,
                // A re-block of a document whose deletion already confirmed keeps that
                // confirmation — the service did delete it once; only the block is refreshed.
                deletionState: sql`case when ${hindsightRevocations.deletionState} = 'confirmed' then 'confirmed' else 'pending' end`,
                // A re-block that regresses failed/pending must not carry the previous
                // round's error and stamp into its fresh "pending" state.
                deletionError: sql`case when ${hindsightRevocations.deletionState} = 'confirmed' then ${hindsightRevocations.deletionError} else null end`,
                deletionAttemptedAt: sql`case when ${hindsightRevocations.deletionState} = 'confirmed' then ${hindsightRevocations.deletionAttemptedAt} else null end`,
                updatedAt: at,
              },
            });
        }
      });
    }
    return {
      async recordBlock(input) {
        await recordBlocks([input]);
      },
      recordBlocks,
      async noteDeletionOutcome(input) {
      await database
        .update(hindsightRevocations)
        .set({
          deletionState: input.confirmed ? "confirmed" : "failed",
          deletionAttemptedAt: input.attemptedAt,
          deletionError: input.error,
          updatedAt: now(),
        })
        .where(
          and(
            eq(hindsightRevocations.tenantId, input.tenantId),
            eq(hindsightRevocations.documentId, input.documentId),
          ),
        );
    },
  };
}
