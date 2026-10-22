/**
 * Hindsight 13 (#390): source revocation as one durable block, the deletion retries behind it,
 * and the replay that re-applies blocks after a backup restore.
 *
 * The person-facing forgets live in their own seams (preference-recall, scoped-recall,
 * judgment-review); since this ticket each records its block into the revocation ledger and
 * answers the honest status ("stopped being used now; remote cleanup separate, never claimed
 * complete"). What those seams could not express is the OTHER half of the spec's sentence —
 * revoking a SOURCE (or a Bot's memory authorization) blocks not one row but the whole set
 * that authorization fed, INCLUDING the derived judgments built on it, and it must hold even
 * if the grant is later re-enabled. That composite act is this module:
 *
 *   - `revokeAuthorizationTarget` collects every live source-bound row of the target plus the
 *     transitive closure of judgments citing them (a judgment citing a judgment counts), and
 *     lands ONE transaction: grant disabled, every collected row tombstoned the way the
 *     forget seams tombstone (content cleared, disabled, deleted_at), one ledger row per
 *     blocked document. Only after that commit do the remote document deletions go out —
 *     OpenBot blocks first, deletes second, and a Hindsight outage delays only the cleanup.
 *   - `retryOutstandingDeletions` is the "再重试删除" half: it walks unfinished ledger rows
 *     oldest-first and re-issues the deletes, confirming on 2xx or 404. A confirmation is a
 *     per-document service answer and nothing more; "all controlled copies cleared" stays
 *     outside this ticket's claims (the deletion-evidence track owns it).
 *   - `replayRevocations` is the backup-restore gate: re-applying the ledger re-tombstones
 *     anything a restored backup resurrected (rows, grants, and the rows a re-blocked
 *     authorization covers), idempotently, so recall does not re-open on restored state.
 *
 * Why the tombstones and not just the grant flag: read-time authorization checks answer
 * "unauthorized right now", which a re-enabled grant would flip back. A revocation is the
 * person's destructive decision about that content; the authority rows themselves carry it,
 * which is what keeps web, channel, scheduled-job and SQL-degradation entries (all of which
 * enter through this domain's seams) and the sync queue's background retries from ever
 * resurrecting the blocked bytes — the queue re-loads the row and finds nothing to send.
 */

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Database } from "../db/client";
import { genericPersonalPreferences } from "../db/schema/hindsight-preferences";
import {
  derivedJudgmentCandidates,
  derivedJudgmentEvidence,
} from "../db/schema/hindsight-judgments";
import { hindsightRevocations } from "../db/schema/hindsight-revocations";
import {
  hindsightMemoryGrants,
  sourceBoundMemories,
} from "../db/schema/hindsight-source-bound";
import type { PlatformScope } from "../enterprise/contracts";
import {
  backgroundTaskBankScope,
  botBankFor,
  type HindsightBankGrant,
  mintBankScopeAssertion,
  resolveHindsightBankScope,
  sourceBankFor,
} from "./bank-scope";
import { judgmentBankGrantFor } from "./judgment-review";
import type { PreferenceRecallServiceConfig } from "./preference-recall";
import {
  type AuthorizationRevocationStatus,
  type RevocationBankKind,
  type RevocationBlockInput,
  STOPPED_USING_SUMMARY,
} from "./revocation-ledger";

/** How long one minted assertion stays valid; the retry drain mints fresh per delete. */
const ASSERTION_TTL_MS = 60_000;
/** The pinned deployment is single-tenant on the service side; the segment is a constant. */
const HINDSIGHT_TENANT_SEGMENT = "default";
/** One retry pass touches at most this many unfinished deletions, oldest first. */
const RETRY_BATCH = 100;

/** What one authorization revocation collected and blocked. */
type BlockedSet = {
  boundRows: (typeof sourceBoundMemories.$inferSelect)[];
  judgmentRows: (typeof derivedJudgmentCandidates.$inferSelect)[];
  ledgerRows: RevocationBlockInput[];
};

export function createRevocationService(
  database: Database,
  config: PreferenceRecallServiceConfig,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  const doFetch =
    config.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));

  async function hindsightDelete(
    identity: { tenantId: string; principalId: string },
    bank: HindsightBankGrant,
    documentId: string,
  ): Promise<{ attempted: boolean; confirmed: boolean; error: string | null }> {
    const token = mintBankScopeAssertion(
      backgroundTaskBankScope(identity, bank),
      {
        secret: config.assertionSecret,
        ttlMs: ASSERTION_TTL_MS,
        now: now(),
      },
    );
    try {
      const response = await doFetch(
        `${config.apiUrl}/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${bank.id}/documents/${encodeURIComponent(documentId)}`,
        {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.serviceApiKey}`,
            "x-openbot-bank-scope": token,
          },
          signal: AbortSignal.timeout(config.requestTimeoutMs ?? 5000),
        },
      );
      // A document the service no longer knows is as deleted as one it just removed.
      const confirmed = response.ok || response.status === 404;
      return {
        attempted: true,
        confirmed,
        error: confirmed ? null : `service answered ${response.status}`,
      };
    } catch (error) {
      return {
        attempted: false,
        confirmed: false,
        error:
          error instanceof Error
            ? error.message
            : "service could not be reached",
      };
    }
  }

  async function noteOutcome(
    tenantId: string,
    documentId: string,
    outcome: { attempted: boolean; confirmed: boolean; error: string | null },
  ): Promise<void> {
    await database
      .update(hindsightRevocations)
      .set({
        deletionState: outcome.confirmed ? "confirmed" : "failed",
        deletionAttemptedAt: now(),
        deletionError: outcome.error,
        updatedAt: now(),
      })
      .where(
        and(
          eq(hindsightRevocations.tenantId, tenantId),
          eq(hindsightRevocations.documentId, documentId),
        ),
      );
  }

  /**
   * The tombstone every forget seam writes: content cleared, disabled, deleted — no later
   * recall (index hit or SQL read) can resurrect the bytes. Spelled per table inside the
   * block transaction below.
   */
  const tombstoneSet = {
    enabled: false as const,
    content: "",
    syncedContentDigest: null,
    syncedAt: null,
  };

  const bankOfBoundRow = (
    row: typeof sourceBoundMemories.$inferSelect,
  ): HindsightBankGrant =>
    row.restriction === "source"
      ? { id: sourceBankFor(row.sourceId ?? ""), kind: "source" }
      : { id: botBankFor(row.agentId ?? ""), kind: "bot" };

  /**
   * Collect the live source-bound rows one authorization target feeds, plus the transitive
   * closure of live judgments citing them (judgments citing judgments included) — the exact
   * set "原始事实及相关派生判断" names.
   */
  async function collectBlockedSet(
    tenantId: string,
    principalId: string,
    kind: "source" | "bot",
    targetId: string,
  ): Promise<BlockedSet> {
    const boundRows = await database
      .select()
      .from(sourceBoundMemories)
      .where(
        and(
          eq(sourceBoundMemories.tenantId, tenantId),
          eq(sourceBoundMemories.principalId, principalId),
          eq(sourceBoundMemories.restriction, kind),
          kind === "source"
            ? eq(sourceBoundMemories.sourceId, targetId)
            : eq(sourceBoundMemories.agentId, targetId),
          isNull(sourceBoundMemories.deletedAt),
        ),
      );
    const judgmentRows: (typeof derivedJudgmentCandidates.$inferSelect)[] = [];
    const blockedIds = new Set(boundRows.map((row) => row.id));
    const blockedJudgments = new Set<string>();
    const processed = new Set<string>();
    // Fixpoint expansion: a blocked row kills the judgments citing it; those judgments are
    // rows too, so judgments citing THEM die as well — rule 4's 停用, transitively. Dead
    // candidates are marked processed, not blocked: their own citations cannot resurrect.
    for (;;) {
      const frontier = [...blockedIds, ...blockedJudgments];
      const edges = frontier.length
        ? await database
            .select({
              judgmentId: derivedJudgmentEvidence.judgmentId,
            })
            .from(derivedJudgmentEvidence)
            .where(
              and(
                eq(derivedJudgmentEvidence.tenantId, tenantId),
                inArray(derivedJudgmentEvidence.evidenceId, frontier),
              ),
            )
        : [];
      const candidateIds = [
        ...new Set(edges.map((edge) => edge.judgmentId)),
      ].filter((id) => !processed.has(id));
      if (!candidateIds.length) break;
      for (const id of candidateIds) processed.add(id);
      const rows = await database
        .select()
        .from(derivedJudgmentCandidates)
        .where(
          and(
            eq(derivedJudgmentCandidates.tenantId, tenantId),
            eq(derivedJudgmentCandidates.principalId, principalId),
            inArray(derivedJudgmentCandidates.id, candidateIds),
            isNull(derivedJudgmentCandidates.deletedAt),
          ),
        );
      for (const row of rows) blockedJudgments.add(row.id);
      judgmentRows.push(...rows);
    }
    return { boundRows, judgmentRows, ledgerRows: [] };
  }

  /**
   * Land the block: one transaction that disables the grant, tombstones every collected row,
   * and writes one ledger row per blocked document. Idempotent by construction — re-running
   * it finds no live rows and only refreshes ledger rows — which is exactly what replay needs.
   */
  async function applyAuthorizationBlock(
    identity: { tenantId: string; principalId: string },
    kind: "source" | "bot",
    targetId: string,
    blockedAt: Date,
  ): Promise<BlockedSet> {
    const { boundRows, judgmentRows } = await collectBlockedSet(
      identity.tenantId,
      identity.principalId,
      kind,
      targetId,
    );
    const ledgerRows: RevocationBlockInput[] = [
      ...boundRows.map((row) => ({
        tenantId: identity.tenantId,
        principalId: identity.principalId,
        kind,
        subjectType: null,
        targetId,
        documentId: row.hindsightDocumentId,
        bankId: bankOfBoundRow(row).id,
        bankKind: bankOfBoundRow(row).kind,
        blockedAt,
      })),
      ...judgmentRows.map((row) => {
        const bank = judgmentBankGrantFor(row);
        return {
          tenantId: identity.tenantId,
          principalId: identity.principalId,
          kind,
          subjectType: null,
          targetId,
          documentId: row.hindsightDocumentId,
          bankId: bank.id,
          bankKind: bank.kind,
          blockedAt,
        };
      }),
    ];
    await database.transaction(async (tx) => {
      await tx
        .update(hindsightMemoryGrants)
        .set({ enabled: false, updatedAt: blockedAt })
        .where(
          and(
            eq(hindsightMemoryGrants.tenantId, identity.tenantId),
            eq(hindsightMemoryGrants.principalId, identity.principalId),
            eq(hindsightMemoryGrants.kind, kind),
            eq(hindsightMemoryGrants.targetId, targetId),
          ),
        );
      for (const row of boundRows) {
        await tx
          .update(sourceBoundMemories)
          .set({ ...tombstoneSet, deletedAt: blockedAt, updatedAt: blockedAt })
          .where(
            and(
              eq(sourceBoundMemories.tenantId, row.tenantId),
              eq(sourceBoundMemories.id, row.id),
            ),
          );
      }
      for (const row of judgmentRows) {
        await tx
          .update(derivedJudgmentCandidates)
          .set({ ...tombstoneSet, deletedAt: blockedAt, updatedAt: blockedAt })
          .where(
            and(
              eq(derivedJudgmentCandidates.tenantId, row.tenantId),
              eq(derivedJudgmentCandidates.id, row.id),
            ),
          );
      }
      for (const input of ledgerRows) {
        await tx
          .insert(hindsightRevocations)
          .values({
            tenantId: input.tenantId,
            id: randomUUID(),
            principalId: input.principalId,
            kind: input.kind,
            subjectType: null,
            targetId: input.targetId,
            documentId: input.documentId,
            bankId: input.bankId,
            bankKind: input.bankKind,
            blockedAt: input.blockedAt,
            deletionState: "pending",
            createdAt: blockedAt,
            updatedAt: blockedAt,
          })
          .onConflictDoUpdate({
            target: [
              hindsightRevocations.tenantId,
              hindsightRevocations.documentId,
            ],
            set: { blockedAt, updatedAt: blockedAt },
          });
      }
    });
    return { boundRows, judgmentRows, ledgerRows };
  }

  return {
    /**
     * Revoke one authorization target (a connected source, or a Bot's memory authorization):
     * the composite destructive act. The block — grant off, every fed row and every dependent
     * judgment tombstoned, the ledger written — lands in one transaction BEFORE any remote
     * deletion is initiated; the deletes then go out per document, best-effort, with their
     * outcomes recorded for the retry drain. The answer tells the person the truth in two
     * parts: stopped being used at `stoppedUsingAt`, and a remote cleanup that still has
     * `outstanding` documents unconfirmed — never a claim that copies are cleared.
     */
    async revokeAuthorizationTarget(
      scope: PlatformScope,
      target: { kind: "source" | "bot"; targetId: string },
    ): Promise<AuthorizationRevocationStatus> {
      const identity = resolveHindsightBankScope(scope);
      const stoppedUsingAt = now();
      const blocked = await applyAuthorizationBlock(
        identity,
        target.kind,
        target.targetId,
        stoppedUsingAt,
      );
      let attempted = false;
      let outstanding = 0;
      for (const input of blocked.ledgerRows) {
        const outcome = await hindsightDelete(
          identity,
          { id: input.bankId, kind: input.bankKind as RevocationBankKind },
          input.documentId,
        );
        attempted = attempted || outcome.attempted;
        if (!outcome.confirmed) outstanding++;
        await noteOutcome(
          input.tenantId,
          input.documentId,
          outcome,
        );
      }
      return {
        stoppedUsingAt,
        blocked: {
          sourceBoundMemories: blocked.boundRows.length,
          derivedJudgments: blocked.judgmentRows.length,
        },
        remoteDeletion: { attempted, outstanding },
        summary: STOPPED_USING_SUMMARY,
      };
    },

    /**
     * The deletion retry drain: unfinished ledger rows, oldest first, one delete each. A
     * Hindsight outage leaves them pending/failed — the block itself never waited on them.
     * Confirmed (2xx or 404) rows drop out of the drain; the rest stay for the next pass.
     */
    async retryOutstandingDeletions(
      input: { tenantId?: string; limit?: number } = {},
    ): Promise<{
      considered: number;
      confirmed: number;
      stillOutstanding: number;
    }> {
      const limit = input.limit ?? RETRY_BATCH;
      const pending = await database
        .select()
        .from(hindsightRevocations)
        .where(
          and(
            ne(hindsightRevocations.deletionState, "confirmed"),
            input.tenantId
              ? eq(hindsightRevocations.tenantId, input.tenantId)
              : undefined,
          ),
        )
        .orderBy(asc(hindsightRevocations.blockedAt))
        .limit(limit);
      let confirmed = 0;
      let stillOutstanding = 0;
      for (const row of pending) {
        const outcome = await hindsightDelete(
          { tenantId: row.tenantId, principalId: row.principalId },
          { id: row.bankId, kind: row.bankKind as RevocationBankKind },
          row.documentId,
        );
        if (outcome.confirmed) confirmed++;
        else stillOutstanding++;
        await noteOutcome(row.tenantId, row.documentId, outcome);
      }
      return { considered: pending.length, confirmed, stillOutstanding };
    },

    /**
     * Re-apply the ledger's blocks after a backup restore — the gate that keeps a restored
     * copy from re-opening recall. Memory-kind rows re-tombstone their subject row if the
     * restore resurrected it; source/bot-kind rows re-run the composite block (grant off,
     * fed rows and dependent judgments tombstoned, new documents the restore introduced
     * added to the ledger). Idempotent: an unchanged database re-applies nothing.
     */
    async replayRevocations(
      input: { tenantId?: string } = {},
    ): Promise<{
      memoryRows: number;
      reappliedMemoryBlocks: number;
      authorizationTargets: number;
      reappliedAuthorizationBlocks: number;
    }> {
      const tenantFilter = input.tenantId
        ? eq(hindsightRevocations.tenantId, input.tenantId)
        : undefined;
      const memoryRows = await database
        .select()
        .from(hindsightRevocations)
        .where(and(eq(hindsightRevocations.kind, "memory"), tenantFilter));
      let reappliedMemoryBlocks = 0;
      for (const row of memoryRows) {
        const subjectType = row.subjectType;
        if (subjectType === "preference") {
          const [found] = await database
            .select({ deletedAt: genericPersonalPreferences.deletedAt })
            .from(genericPersonalPreferences)
            .where(
              and(
                eq(genericPersonalPreferences.tenantId, row.tenantId),
                eq(genericPersonalPreferences.id, row.targetId),
              ),
            )
            .limit(1);
          if (found && found.deletedAt === null) {
            await database
              .update(genericPersonalPreferences)
              .set({
                enabled: false,
                deletedAt: row.blockedAt,
                content: "",
                syncedContentDigest: null,
                syncedAt: null,
                updatedAt: now(),
              })
              .where(
                and(
                  eq(genericPersonalPreferences.tenantId, row.tenantId),
                  eq(genericPersonalPreferences.id, row.targetId),
                ),
              );
            reappliedMemoryBlocks++;
          }
          continue;
        }
        if (subjectType === "source_bound") {
          const [found] = await database
            .select({ deletedAt: sourceBoundMemories.deletedAt })
            .from(sourceBoundMemories)
            .where(
              and(
                eq(sourceBoundMemories.tenantId, row.tenantId),
                eq(sourceBoundMemories.id, row.targetId),
              ),
            )
            .limit(1);
          if (found && found.deletedAt === null) {
            await database
              .update(sourceBoundMemories)
              .set({
                enabled: false,
                deletedAt: row.blockedAt,
                content: "",
                syncedContentDigest: null,
                syncedAt: null,
                updatedAt: now(),
              })
              .where(
                and(
                  eq(sourceBoundMemories.tenantId, row.tenantId),
                  eq(sourceBoundMemories.id, row.targetId),
                ),
              );
            reappliedMemoryBlocks++;
          }
          continue;
        }
        if (subjectType === "derived_judgment") {
          const [found] = await database
            .select({ deletedAt: derivedJudgmentCandidates.deletedAt })
            .from(derivedJudgmentCandidates)
            .where(
              and(
                eq(derivedJudgmentCandidates.tenantId, row.tenantId),
                eq(derivedJudgmentCandidates.id, row.targetId),
              ),
            )
            .limit(1);
          if (found && found.deletedAt === null) {
            await database
              .update(derivedJudgmentCandidates)
              .set({
                enabled: false,
                deletedAt: row.blockedAt,
                content: "",
                syncedContentDigest: null,
                syncedAt: null,
                updatedAt: now(),
              })
              .where(
                and(
                  eq(derivedJudgmentCandidates.tenantId, row.tenantId),
                  eq(derivedJudgmentCandidates.id, row.targetId),
                ),
              );
            reappliedMemoryBlocks++;
          }
        }
      }
      const authorizationRows = await database
        .selectDistinct({
          tenantId: hindsightRevocations.tenantId,
          principalId: hindsightRevocations.principalId,
          kind: hindsightRevocations.kind,
          targetId: hindsightRevocations.targetId,
        })
        .from(hindsightRevocations)
        .where(
          and(ne(hindsightRevocations.kind, "memory"), tenantFilter),
        );
      let reappliedAuthorizationBlocks = 0;
      for (const target of authorizationRows) {
        const blocked = await applyAuthorizationBlock(
          {
            tenantId: target.tenantId,
            principalId: target.principalId,
          },
          target.kind as "source" | "bot",
          target.targetId,
          now(),
        );
        if (blocked.boundRows.length || blocked.judgmentRows.length) {
          reappliedAuthorizationBlocks++;
        }
      }
      return {
        memoryRows: memoryRows.length,
        reappliedMemoryBlocks,
        authorizationTargets: authorizationRows.length,
        reappliedAuthorizationBlocks,
      };
    },
  };
}

export type RevocationService = ReturnType<typeof createRevocationService>;
