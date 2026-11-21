import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { purgeDeletedConversations } from "../channels/deletion-cleanup";
import type { Database } from "../db/client";
import {
  channels,
  opikEvaluations as evaluations,
  opikEvaluationGrants as grants,
  personalMemories as memories,
  hindsightMemoryProjections as projections,
  recorderRecordings as recordings,
  conversationEvidenceWithdrawals as withdrawals,
} from "../db/schema";
import { withdrawLearningEvidence } from "../learning/evidence";
import {
  createHindsight,
  type Hindsight,
  type HindsightConfig,
} from "../memory/hindsight";
import type { OpikConfig } from "../opik/client";
import {
  deleteEvaluationCopy,
  matchesEvaluationDestination,
} from "../opik/evaluation-cleanup";
import { purgeRecording } from "../recorder/openbot-recordings";

// Both databases must be quiesced for cutover. The authority is the surviving
// deletion ledger, and the restored database and dependencies are still private.
export async function replayIntelligenceDeletions({
  authority,
  restored,
  hindsight: hindsightConfig,
  opik,
}: {
  authority: Database;
  restored: Database;
  hindsight?: HindsightConfig;
  opik?: OpikConfig;
}) {
  const journal = await authority.transaction(
    async (tx) => ({
      conversations: await tx
        .select({
          id: withdrawals.channelId,
          at: withdrawals.withdrawnAt,
        })
        .from(withdrawals),
      recordings: await tx
        .select({
          id: recordings.id,
          owner: recordings.userId,
          at: recordings.deletedAt,
        })
        .from(recordings)
        .where(isNotNull(recordings.deletedAt)),
      memories: await tx
        .select({
          id: memories.id,
          owner: memories.ownerUserId,
          at: memories.deletedAt,
        })
        .from(memories)
        .where(isNotNull(memories.deletedAt)),
      documents: await tx
        .select({
          id: projections.memoryId,
          owner: projections.ownerUserId,
          memoryMissing: isNull(memories.id),
          firstDeletedAt: projections.firstDeletedAt,
        })
        .from(projections)
        .leftJoin(memories, eq(projections.memoryId, memories.id))
        .where(or(isNull(memories.id), isNotNull(memories.deletedAt))),
      grants: await tx
        .select({
          id: grants.id,
          at: grants.revokedAt,
        })
        .from(grants)
        .where(isNotNull(grants.revokedAt)),
      traces: await tx
        .select({
          id: evaluations.id,
          target: evaluations.target,
          workspace: evaluations.workspace,
          project: evaluations.project,
        })
        .from(evaluations)
        .innerJoin(grants, eq(evaluations.requestId, grants.id))
        .where(and(eq(evaluations.kind, "real"), isNotNull(grants.revokedAt))),
    }),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

  const hindsight: Hindsight | undefined =
    hindsightConfig &&
    createHindsight({ database: restored, ...hindsightConfig });
  if (journal.documents.length && !hindsight)
    throw new Error("Restore requires a Hindsight destination");
  if (
    journal.traces.some(
      (trace) => !opik || !matchesEvaluationDestination(opik, trace),
    )
  ) {
    throw new Error("Restore requires the recorded Opik cleanup destination");
  }

  const replayedAt = new Date();
  // A cascade can remove the Memory row while leaving its durable projection locator.
  const withdrawnMemories = [
    ...journal.memories,
    ...journal.documents
      .filter(({ memoryMissing }) => memoryMissing)
      .map(({ id, owner, firstDeletedAt }) => ({
        id,
        owner,
        at: firstDeletedAt ?? replayedAt,
      })),
  ];

  await restored.transaction(async (tx) => {
    for (const { id, at } of journal.conversations) {
      const [channel] = await tx
        .update(channels)
        .set({ deletedAt: at })
        .where(and(eq(channels.id, id), isNull(channels.deletedAt)))
        .returning({ id: channels.id });
      if (channel)
        await withdrawLearningEvidence(
          tx,
          null,
          { kind: "conversation", id },
          true,
        );
      await tx
        .insert(withdrawals)
        .values({ channelId: id, withdrawnAt: at })
        .onConflictDoNothing();
    }
    for (const { id, owner, at } of journal.recordings) {
      if (!at) continue;
      const [row] = await tx
        .select({ id: recordings.id })
        .from(recordings)
        .where(
          and(
            eq(recordings.id, id),
            eq(recordings.userId, owner),
            isNull(recordings.deletedAt),
          ),
        )
        .for("update");
      if (row) await purgeRecording(tx, id, owner, at);
    }
    for (const { id, owner, at } of withdrawnMemories) {
      if (!at) continue;
      await tx
        .update(memories)
        .set({
          deletedAt: at,
          enabled: false,
          content: "",
          version: crypto.randomUUID(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(memories.id, id),
            eq(memories.ownerUserId, owner),
            isNull(memories.deletedAt),
          ),
        );
    }
    for (const { id, at } of journal.grants) {
      if (!at) continue;
      await tx
        .update(grants)
        .set({ revokedAt: at })
        .where(and(eq(grants.id, id), isNull(grants.revokedAt)));
    }
  });

  while ((await purgeDeletedConversations(restored)) > 0) {}
  if (hindsight) {
    for (const { id, owner } of journal.documents) {
      await hindsight.deleteDocument(owner, id);
      await restored
        .insert(projections)
        .values({
          memoryId: id,
          ownerUserId: owner,
          cleanupCompletedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: projections.memoryId,
          set: { projectedVersion: null, cleanupCompletedAt: new Date() },
        });
    }
  }
  if (opik) {
    for (const { id } of journal.traces) {
      await deleteEvaluationCopy(opik, id);
      await restored
        .update(evaluations)
        .set({ cleanupCompletedAt: new Date() })
        .where(eq(evaluations.id, id));
    }
  }
  return {
    conversations: journal.conversations.length,
    recordings: journal.recordings.length,
    memories: withdrawnMemories.length,
    grants: journal.grants.length,
    documents: journal.documents.length,
    traces: journal.traces.length,
  };
}
