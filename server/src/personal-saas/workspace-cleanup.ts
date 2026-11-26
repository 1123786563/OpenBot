import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { botSeat, seatText } from "../computer/computer-key";
import type { Database } from "../db/client";
import {
  agents,
  approvalConversationGrants,
  approvalPreferences,
  approvalRequests,
  approvalRules,
  attachments,
  brokeredAccounts,
  brokeredConnections,
  brokeredIdentities,
  channels,
  computerPageFrame,
  computerSnapshot,
  deliveryBindings,
  deliveryInbox,
  deliveryOutbox,
  personalIntelligenceRuns,
  personalMemories,
  personalSaasAccounts,
  personalSaasSessions,
  personalSupportRequests,
  personalWorkspaceAgenticSpaces,
  personalWorkspaceClosures,
  personalWorkspaceDefaultBots,
  personalWorkspaceIntegrationGrants,
  personalWorkspaces,
  routines,
  users,
  workItems,
} from "../db/schema";
import {
  type AgenticStorageRecovery,
  agenticStorageLocator,
  backupSchedule,
  type CleanupResult,
  type CleanupStep,
  type ClosureCleanup,
  type ClosureStorageRecovery,
  type closureRestoreJournal,
  type closureTombstone,
  onlineCleanupSteps,
} from "./closure-cleanup-contract";
import {
  captureLegacyBotRuns,
  readIntelligenceInventory,
} from "./intelligence-inventory";
import { personalConversationScope, type Transaction } from "./store";
import { workspaceResourceOwner } from "./workspace-principal";

type Tombstone = z.output<typeof closureTombstone>;
type Closure = typeof personalWorkspaceClosures.$inferSelect;

async function purgePostgres(tx: Transaction, closure: Tombstone) {
  const owner = workspaceResourceOwner(closure.workspaceId);
  const owners = [owner, closure.accountId];
  const conversations = personalConversationScope(
    tx,
    eq(personalWorkspaceDefaultBots.workspaceId, closure.workspaceId),
    true,
  ).as("closed_conversations");
  const [bot] = await tx
    .select()
    .from(personalWorkspaceDefaultBots)
    .where(eq(personalWorkspaceDefaultBots.workspaceId, closure.workspaceId));

  await tx
    .delete(channels)
    .where(
      inArray(
        channels.id,
        tx.select({ id: conversations.id }).from(conversations),
      ),
    );
  await tx.delete(attachments).where(eq(attachments.uploadedBy, owner));
  await tx
    .delete(personalMemories)
    .where(inArray(personalMemories.ownerUserId, owners));
  await tx.delete(routines).where(inArray(routines.ownerUserId, owners));
  await tx
    .delete(deliveryInbox)
    .where(inArray(deliveryInbox.ownerUserId, owners));
  await tx
    .delete(deliveryOutbox)
    .where(inArray(deliveryOutbox.ownerUserId, owners));
  await tx
    .delete(deliveryBindings)
    .where(inArray(deliveryBindings.ownerUserId, owners));
  await tx
    .delete(approvalConversationGrants)
    .where(inArray(approvalConversationGrants.ownerUserId, owners));
  await tx
    .delete(approvalRequests)
    .where(inArray(approvalRequests.ownerUserId, owners));
  await tx
    .delete(approvalPreferences)
    .where(inArray(approvalPreferences.ownerUserId, owners));
  await tx
    .delete(approvalRules)
    .where(inArray(approvalRules.ownerUserId, owners));
  await tx
    .delete(personalSupportRequests)
    .where(eq(personalSupportRequests.workspaceId, closure.workspaceId));
  await tx.delete(workItems).where(eq(workItems.accountId, closure.accountId));
  if (bot) {
    const computerId = seatText(botSeat(bot.agentId));
    await tx
      .delete(computerSnapshot)
      .where(eq(computerSnapshot.computerId, computerId));
    await tx
      .delete(computerPageFrame)
      .where(eq(computerPageFrame.computerId, computerId));
    await tx
      .delete(personalWorkspaceDefaultBots)
      .where(eq(personalWorkspaceDefaultBots.workspaceId, closure.workspaceId));
    await tx.delete(agents).where(eq(agents.id, bot.agentId));
  }
  await tx.delete(users).where(eq(users.id, owner));
}

// Provider inventory survives local content cleanup. Once remote verification is
// complete, only the closed principal's bindings and account metadata are removed.
async function detachConnections(tx: Transaction, workspaceId: string) {
  const owner = workspaceResourceOwner(workspaceId);
  await tx.delete(brokeredAccounts).where(eq(brokeredAccounts.userId, owner));
  await tx
    .delete(brokeredIdentities)
    .where(eq(brokeredIdentities.userId, owner));
  await tx
    .delete(brokeredConnections)
    .where(
      and(
        eq(brokeredConnections.userId, owner),
        eq(brokeredConnections.holder, "person"),
      ),
    );
}

export function workspaceCleanup({
  database,
  reconcile,
  now,
  stopped,
  eraseComputer,
  agenticStorage = false,
  eraseThread,
}: {
  database: Database;
  reconcile?: ClosureCleanup;
  now: () => number;
  eraseThread?: (
    accountId: string,
    target: { threadId: string; agentId: string },
  ) => Promise<void>;
  eraseComputer?: (
    workspaceId: string,
    storage?: AgenticStorageRecovery,
  ) => Promise<void>;
  agenticStorage?: boolean;
  stopped?: (workspaceId: string) => Promise<boolean>;
}) {
  const ready = (closure: Closure) =>
    onlineCleanupSteps.every(
      (step) => closure.cleanup[step]?.status === "confirmed",
    );

  async function withClosure(
    id: string,
    action: (tx: Transaction, closure: Closure) => Promise<void>,
  ) {
    await database.transaction(async (tx) => {
      const [closure] = await tx
        .select()
        .from(personalWorkspaceClosures)
        .where(eq(personalWorkspaceClosures.id, id))
        .for("update", { skipLocked: true });
      if (closure) await action(tx, closure);
    });
  }

  async function step(tx: Transaction, closure: Closure, key: CleanupStep) {
    if (closure.cleanup[key]?.status === "confirmed") return;
    const { id, workspaceId, accountId, acceptedAt } = closure;
    const target = { id, workspaceId, accountId, acceptedAt };
    let status: CleanupResult["status"];
    try {
      status = await tx.transaction(async (savepoint) => {
        if (key === "postgres") {
          // Internal services can use the Assistant and conversation IDs to
          // reconcile their copies before those identifiers are discarded.
          if (
            closure.cleanup.internalServices?.status !== "confirmed" ||
            closure.cleanup.indexes?.status !== "confirmed"
          )
            return "unconfirmed";
          await purgePostgres(savepoint, target);
          return "confirmed";
        }
        if (key === "computerVolume") {
          const [binding] = await savepoint
            .select()
            .from(personalWorkspaceAgenticSpaces)
            .where(eq(personalWorkspaceAgenticSpaces.workspaceId, workspaceId));
          const recovery = closure.storageRecovery;
          if (
            recovery?.kind === "unknown" ||
            (recovery?.kind === "agenticfs" && !recovery.released)
          )
            return "unconfirmed";
          const storage = recovery?.kind === "agenticfs" ? recovery : binding;
          if (storage && (!agenticStorage || !eraseComputer))
            return "unconfirmed";
          if (!storage && !recovery && closure.retiredIntelligence !== null)
            return "unconfirmed";
          const releasedStorage =
            recovery?.kind === "agenticfs" ? recovery : undefined;
          if (!releasedStorage && stopped && !(await stopped(workspaceId)))
            return "unconfirmed";
          await eraseComputer?.(workspaceId, releasedStorage);
        }
        if (key === "internalServices") {
          const inventory =
            closure.retiredIntelligence ??
            (await readIntelligenceInventory(savepoint, [accountId]));
          if (eraseThread) {
            const threads = new Map(
              inventory.map(({ threadId, agentId }) => [
                JSON.stringify([threadId, agentId]),
                { threadId, agentId },
              ]),
            );
            for (const thread of threads.values())
              await eraseThread(accountId, thread);
          }
          if (!reconcile) return "unconfirmed";
          return (
            await reconcile(key, {
              ...target,
              intelligence: inventory.map(({ agentId, threadId, runId }) => ({
                agentId,
                threadId,
                runId,
              })),
            })
          ).status;
        }
        if (!reconcile) return "unconfirmed";
        const result = await reconcile(key, target);
        if (key === "connections" && result.status === "confirmed")
          await detachConnections(savepoint, workspaceId);
        return result.status;
      });
    } catch {
      status = key === "connections" ? "unconfirmed" : "retrying";
    }
    await tx
      .update(personalWorkspaceClosures)
      .set({
        // Bind JSON text before casting so Bun SQL stores the JSON value itself.
        cleanup: sql`${JSON.stringify({
          ...closure.cleanup,
          [key]: { status, checkedAt: new Date(now()).toISOString() },
        })}::text::jsonb`,
      })
      .where(eq(personalWorkspaceClosures.id, id));
  }

  return async function sweep() {
    if (!reconcile && !eraseComputer && !eraseThread) return;
    const records = await database
      .select()
      .from(personalWorkspaceClosures)
      .where(
        and(
          // Cleanup holds the closure row across external calls. Let the cutoff
          // worker record both deadline outcomes before taking that lock.
          isNotNull(personalWorkspaceClosures.workCutoff),
          isNotNull(personalWorkspaceClosures.computerCutoff),
          or(
            isNull(personalWorkspaceClosures.backupSchedule),
            sql`(${personalWorkspaceClosures.cleanup}->'connections'->>'status') IS DISTINCT FROM 'confirmed'`,
          ),
        ),
      );
    for (const record of records) {
      await withClosure(record.id, (tx, closure) =>
        step(tx, closure, "connections"),
      );
      const [claimed] = await database
        .select({ key: workItems.key })
        .from(workItems)
        .where(
          and(
            eq(workItems.accountId, record.accountId),
            isNotNull(workItems.claimedBy),
          ),
        )
        .limit(1);
      if (claimed && record.retiredIntelligence === null) continue;
      for (const key of [
        "computerVolume",
        "exports",
        "caches",
        "indexes",
        "internalServices",
        "postgres",
      ] satisfies CleanupStep[]) {
        if (
          key === "computerVolume" &&
          record.cleanup.computerVolume?.status === "confirmed"
        )
          continue;
        await withClosure(record.id, async (tx, closure) => {
          if (
            key === "internalServices" &&
            closure.retiredIntelligence === null &&
            closure.cleanup[key]?.status !== "confirmed"
          )
            await captureLegacyBotRuns(tx, closure.accountId);
          await step(tx, closure, key);
        });
      }
      await withClosure(record.id, async (tx, closure) => {
        if (closure.backupSchedule || !reconcile || !ready(closure)) return;
        try {
          const result = await reconcile("backups", {
            id: closure.id,
            accountId: closure.accountId,
            workspaceId: closure.workspaceId,
            acceptedAt: closure.acceptedAt,
          });
          if (result.status !== "confirmed") return;
          const parsed = backupSchedule.safeParse(result.schedule);
          if (!parsed.success) return;
          await tx
            .update(personalWorkspaceClosures)
            .set({
              backupSchedule: sql`${JSON.stringify(parsed.data)}::text::jsonb`,
            })
            .where(eq(personalWorkspaceClosures.id, closure.id));
        } catch {
          // Keep the schedule pending until the deployment can verify it.
        }
      });
    }
  };
}

export async function reapplyWorkspaceClosures(
  database: Database,
  records: z.output<typeof closureRestoreJournal>,
) {
  await database.transaction(async (tx) => {
    const existing = await tx.select().from(personalWorkspaceClosures);
    const existingById = new Map(existing.map((record) => [record.id, record]));
    const journalIds = new Set(records.map(({ id }) => id));
    const journalByWorkspace = new Map(
      records.map((record) => [record.workspaceId, record]),
    );
    if (
      journalIds.size !== records.length ||
      journalByWorkspace.size !== records.length
    )
      throw new Error(
        "Closure restore journal repeats an operation or workspace",
      );
    if (existing.some(({ id }) => !journalIds.has(id)))
      throw new Error(
        "Closure restore journal omits an operation present in the backup",
      );
    const ordered = records.toSorted(
      (left, right) =>
        left.acceptedAt.getTime() - right.acceptedAt.getTime() ||
        left.id.localeCompare(right.id),
    );
    const locatedSpaces = new Set<string>();
    const locatedPoints = new Set<string>();
    for (const { intelligence, storage, ...record } of ordered) {
      const [owner] = await tx
        .select({ status: personalSaasAccounts.status })
        .from(personalSaasAccounts)
        .where(eq(personalSaasAccounts.id, record.accountId))
        .for("update");
      if (!owner)
        throw new Error(
          "Closure restore is missing an account referenced by the journal",
        );
      const [workspace] = await tx
        .select({ id: personalWorkspaces.id })
        .from(personalWorkspaces)
        .where(eq(personalWorkspaces.ownerId, record.accountId));
      const saved = existingById.get(record.id);
      const activeOperation = workspace && journalByWorkspace.get(workspace.id);
      const retired = !workspace || workspace.id !== record.workspaceId;
      if (
        retired &&
        workspace &&
        saved?.retiredIntelligence == null &&
        (activeOperation?.accountId !== record.accountId ||
          activeOperation.acceptedAt >= record.acceptedAt)
      )
        throw new Error(
          "Closure restore journal does not match the restored workspace",
        );
      const [restoredTarget] = await tx
        .select({ ownerId: personalWorkspaces.ownerId })
        .from(personalWorkspaces)
        .where(eq(personalWorkspaces.id, record.workspaceId));
      if (restoredTarget && restoredTarget.ownerId !== record.accountId)
        throw new Error("Closure restore workspace belongs to another account");
      const [bound] = await tx
        .select()
        .from(personalWorkspaceAgenticSpaces)
        .where(
          eq(personalWorkspaceAgenticSpaces.workspaceId, record.workspaceId),
        );
      const binding = bound && agenticStorageLocator.parse(bound);
      const recovered: ClosureStorageRecovery =
        storage.kind === "unknown" && saved?.storageRecovery
          ? saved.storageRecovery
          : storage.kind === "unknown" && binding
            ? { kind: "agenticfs", ...binding, released: false }
            : storage;
      const savedStorage = saved?.storageRecovery;
      const knownBindings = [
        binding,
        savedStorage?.kind === "agenticfs" ? savedStorage : undefined,
      ];
      if (
        knownBindings.some(
          (known) =>
            known &&
            (recovered.kind !== "agenticfs" ||
              !Bun.deepEquals(
                agenticStorageLocator.parse(known),
                agenticStorageLocator.parse(recovered),
              )),
        ) ||
        (savedStorage?.kind === "none" && recovered.kind !== "none")
      )
        throw new Error(
          "Closure restore conflicts with the known storage binding",
        );
      if (recovered.kind === "agenticfs") {
        const [conflict] = await tx
          .select({ id: personalWorkspaceAgenticSpaces.workspaceId })
          .from(personalWorkspaceAgenticSpaces)
          .where(
            and(
              ne(
                personalWorkspaceAgenticSpaces.workspaceId,
                record.workspaceId,
              ),
              or(
                eq(
                  personalWorkspaceAgenticSpaces.agenticSpaceId,
                  recovered.agenticSpaceId,
                ),
                eq(
                  personalWorkspaceAgenticSpaces.accessPointId,
                  recovered.accessPointId,
                ),
              ),
            ),
          )
          .limit(1);
        if (
          conflict ||
          locatedSpaces.has(recovered.agenticSpaceId) ||
          locatedPoints.has(recovered.accessPointId)
        )
          throw new Error(
            "Closure restore reuses another workspace storage binding",
          );
        locatedSpaces.add(recovered.agenticSpaceId);
        locatedPoints.add(recovered.accessPointId);
      }
      const replay = {
        cleanup: retired
          ? sql`jsonb_build_object('postgres', jsonb_build_object('status', 'confirmed', 'checkedAt', ${record.acceptedAt.toISOString()}::text))`
          : sql`'{}'::jsonb`,
        backupSchedule: null,
        storageRecovery: sql`${JSON.stringify(recovered)}::text::jsonb`,
        ...(retired && {
          retiredIntelligence: sql`${JSON.stringify(intelligence)}::text::jsonb`,
          workCutoff: saved?.workCutoff ?? ("confirmed" as const),
          computerCutoff: saved?.computerCutoff ?? ("confirmed" as const),
        }),
      };
      const [closure] = await tx
        .insert(personalWorkspaceClosures)
        .values({
          ...record,
          ...replay,
          cutoffDeadline: new Date(record.acceptedAt.getTime() + 60_000),
        })
        .onConflictDoUpdate({
          target: personalWorkspaceClosures.id,
          set: replay,
          setWhere: and(
            eq(personalWorkspaceClosures.accountId, record.accountId),
            eq(personalWorkspaceClosures.workspaceId, record.workspaceId),
            eq(personalWorkspaceClosures.acceptedAt, record.acceptedAt),
          ),
        })
        .returning({ id: personalWorkspaceClosures.id });
      if (!closure)
        throw new Error("Closure restore conflicts with the journal");
      // Other snapshots of this account cannot contain this workspace's rows.
      if (retired) continue;
      if (
        owner.status &&
        !owner.status.executionCutoffs?.some(
          (event) =>
            event.reason === "workspace_closed" &&
            event.cutoffAt === record.acceptedAt.getTime(),
        )
      ) {
        const epoch = owner.status.epoch + 1;
        await tx
          .update(personalSaasAccounts)
          .set({
            status: {
              ...owner.status,
              epoch,
              executionCutoffs: [
                ...(owner.status.executionCutoffs ?? []),
                {
                  epoch,
                  reason: "workspace_closed",
                  cutoffAt: record.acceptedAt.getTime(),
                },
              ],
            },
          })
          .where(eq(personalSaasAccounts.id, record.accountId));
      }
      await tx
        .delete(personalSaasSessions)
        .where(eq(personalSaasSessions.accountId, record.accountId));
      await tx
        .delete(personalWorkspaceIntegrationGrants)
        .where(
          eq(
            personalWorkspaceIntegrationGrants.workspaceId,
            record.workspaceId,
          ),
        );
      // The recovery target is offline. Claims restored from its backup
      // cannot belong to a running worker and must never be dispatched.
      await captureLegacyBotRuns(tx, record.accountId);
      for (let offset = 0; offset < intelligence.length; offset += 1_000)
        await tx
          .insert(personalIntelligenceRuns)
          .values(
            intelligence.slice(offset, offset + 1_000).map((locator) => ({
              ...locator,
              accountId: record.accountId,
            })),
          )
          .onConflictDoNothing();
      await tx
        .delete(workItems)
        .where(eq(workItems.accountId, record.accountId));
      await tx
        .update(personalWorkspaceClosures)
        .set({ workCutoff: "confirmed" })
        .where(
          and(
            eq(personalWorkspaceClosures.id, record.id),
            isNull(personalWorkspaceClosures.workCutoff),
          ),
        );
    }
  });
}
