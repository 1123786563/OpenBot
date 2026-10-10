import { and, asc, eq, sql } from "drizzle-orm";
import {
  lockAttachmentChannelsInTransaction,
  markAttachmentsSentInTransaction,
} from "../../channels/attachments";
import { enterpriseConversations } from "../../db/schema/enterprise-conversations";
import {
  mastraMessageIntentAttachments,
  mastraMessageIntents,
} from "../../db/schema/mastra-message-intents";
import type { MastraConversationBinding } from "../../mastra/contracts";
import { tenantStorageKey } from "../../mastra/contracts";
import type { TenantMastraStorage } from "../../mastra/tenant-storage";
import type { DataDatabase } from "../tenancy/connections";
import { assertDataDatabase } from "../tenancy/connections";

const MAX_RECONCILE_BATCH = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReconcileOutcome = {
  scanned: number;
  finalized: number;
  pending: number;
  absent: number;
  mismatch: number;
};

function sameStringArray(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function trustedPrivateResourceId(tenantId: string, principalId: string) {
  return `private:${JSON.stringify([tenantId, principalId])}`;
}

export function createMastraMessageIntentReconciler({
  data,
  mastraStorage,
}: {
  data: DataDatabase;
  mastraStorage: TenantMastraStorage;
}) {
  assertDataDatabase(data);

  async function establishTenantContext(
    tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
    tenantId: string,
    actorId?: string,
    principalId?: string,
  ) {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${tenantId}, true)`,
    );
    if (actorId !== undefined && principalId !== undefined) {
      await tx.execute(
        sql`select set_config('app.user_id', ${actorId}, true), set_config('app.principal_id', ${principalId}, true)`,
      );
    }
  }

  async function advancePendingIntent(
    tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
    tenantId: string,
    threadId: string,
    clientMessageKey: string,
  ) {
    const [advanced] = await tx
      .update(mastraMessageIntents)
      .set({
        updatedAt: sql`GREATEST(
          clock_timestamp(),
          (
            SELECT max(updated_at)
            FROM mastra_message_intents
            WHERE tenant_id = ${tenantId} AND state = 'pending'
          ) + interval '1 microsecond'
        )`,
      })
      .where(
        and(
          eq(mastraMessageIntents.tenantId, tenantId),
          eq(mastraMessageIntents.threadId, threadId),
          eq(mastraMessageIntents.clientMessageKey, clientMessageKey),
          eq(mastraMessageIntents.state, "pending"),
        ),
      )
      .returning({ clientMessageKey: mastraMessageIntents.clientMessageKey });
    return advanced !== undefined;
  }

  return {
    async reconcilePendingForTenant(
      tenantId: string,
      limit: number,
    ): Promise<ReconcileOutcome> {
      if (
        typeof tenantId !== "string" ||
        tenantId.length === 0 ||
        tenantId.length > 200
      ) {
        throw new Error("INVALID_RECONCILIATION_TENANT");
      }
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > MAX_RECONCILE_BATCH
      ) {
        throw new Error("INVALID_RECONCILIATION_LIMIT");
      }

      const candidates = await data.transaction(async (tx) => {
        await establishTenantContext(tx, tenantId);
        return tx
          .select({
            threadId: mastraMessageIntents.threadId,
            clientMessageKey: mastraMessageIntents.clientMessageKey,
          })
          .from(mastraMessageIntents)
          .where(
            and(
              eq(mastraMessageIntents.tenantId, tenantId),
              eq(mastraMessageIntents.state, "pending"),
            ),
          )
          .orderBy(
            asc(mastraMessageIntents.updatedAt),
            asc(mastraMessageIntents.createdAt),
            asc(mastraMessageIntents.threadId),
            asc(mastraMessageIntents.clientMessageKey),
          )
          .limit(limit);
      });

      const outcome: ReconcileOutcome = {
        scanned: 0,
        finalized: 0,
        pending: 0,
        absent: 0,
        mismatch: 0,
      };

      for (const key of candidates) {
        const status = await data.transaction(async (tx) => {
          await establishTenantContext(tx, tenantId);
          const [unlocked] = await tx
            .select()
            .from(mastraMessageIntents)
            .where(
              and(
                eq(mastraMessageIntents.tenantId, tenantId),
                eq(mastraMessageIntents.threadId, key.threadId),
                eq(mastraMessageIntents.clientMessageKey, key.clientMessageKey),
                eq(mastraMessageIntents.state, "pending"),
              ),
            )
            .limit(1);
          if (!unlocked) return null;

          await establishTenantContext(
            tx,
            tenantId,
            unlocked.actorId,
            unlocked.principalId,
          );
          if (
            !Array.isArray(unlocked.attachmentIds) ||
            unlocked.attachmentIds.some(
              (attachmentId) =>
                typeof attachmentId !== "string" ||
                !UUID_PATTERN.test(attachmentId),
            )
          ) {
            return (await advancePendingIntent(
              tx,
              tenantId,
              key.threadId,
              key.clientMessageKey,
            ))
              ? ("mismatch" as const)
              : null;
          }

          await lockAttachmentChannelsInTransaction(
            tx,
            tenantId,
            unlocked.attachmentIds,
          );
          const conversationLockKey = JSON.stringify([
            "conversation",
            tenantId,
            key.threadId,
          ]);
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${conversationLockKey}, 0))`,
          );

          const [conversation] = await tx
            .select()
            .from(enterpriseConversations)
            .where(
              and(
                eq(enterpriseConversations.tenantId, tenantId),
                eq(enterpriseConversations.threadId, key.threadId),
              ),
            )
            .for("update")
            .limit(1);
          const [intent] = await tx
            .select()
            .from(mastraMessageIntents)
            .where(
              and(
                eq(mastraMessageIntents.tenantId, tenantId),
                eq(mastraMessageIntents.threadId, key.threadId),
                eq(mastraMessageIntents.clientMessageKey, key.clientMessageKey),
                eq(mastraMessageIntents.state, "pending"),
              ),
            )
            .for("update")
            .limit(1);
          if (!intent) return null;

          await establishTenantContext(
            tx,
            tenantId,
            intent.actorId,
            intent.principalId,
          );
          const immutableTupleMatches =
            Array.isArray(intent.attachmentIds) &&
            intent.attachmentIds.every(
              (attachmentId) =>
                typeof attachmentId === "string" &&
                UUID_PATTERN.test(attachmentId),
            ) &&
            intent.tenantId === unlocked.tenantId &&
            intent.threadId === unlocked.threadId &&
            intent.clientMessageKey === unlocked.clientMessageKey &&
            intent.messageId === unlocked.messageId &&
            intent.digest === unlocked.digest &&
            intent.reservedSeq === unlocked.reservedSeq &&
            intent.actorId === unlocked.actorId &&
            intent.principalId === unlocked.principalId &&
            intent.backendVersion === unlocked.backendVersion &&
            sameStringArray(intent.attachmentIds, unlocked.attachmentIds);
          if (
            !immutableTupleMatches ||
            !conversation ||
            conversation.storageBackend !== "mastra" ||
            conversation.backendVersion !== intent.backendVersion ||
            conversation.principalId !== intent.principalId
          ) {
            return (await advancePendingIntent(
              tx,
              tenantId,
              key.threadId,
              key.clientMessageKey,
            ))
              ? ("mismatch" as const)
              : null;
          }

          const binding: MastraConversationBinding = {
            tenantId,
            conversationId: conversation.id,
            threadId: conversation.threadId,
            resourceId: trustedPrivateResourceId(tenantId, intent.principalId),
            storageKey: tenantStorageKey(tenantId),
            backend: "mastra",
          };
          const inspection = await mastraStorage.inspectIntentMessage(binding, {
            messageId: intent.messageId,
            digest: intent.digest,
            seq: intent.reservedSeq,
            clientMessageKey: intent.clientMessageKey,
            attachmentIds: intent.attachmentIds,
          });
          if (inspection !== "exact") {
            return (await advancePendingIntent(
              tx,
              tenantId,
              key.threadId,
              key.clientMessageKey,
            ))
              ? inspection
              : null;
          }

          await markAttachmentsSentInTransaction(
            tx,
            { actorId: intent.actorId, threadId: intent.threadId },
            intent.attachmentIds,
          );
          const [finalized] = await tx
            .update(mastraMessageIntents)
            .set({ state: "finalized", updatedAt: new Date() })
            .where(
              and(
                eq(mastraMessageIntents.tenantId, tenantId),
                eq(mastraMessageIntents.threadId, intent.threadId),
                eq(
                  mastraMessageIntents.clientMessageKey,
                  intent.clientMessageKey,
                ),
                eq(mastraMessageIntents.state, "pending"),
              ),
            )
            .returning({
              clientMessageKey: mastraMessageIntents.clientMessageKey,
            });
          if (!finalized) throw new Error("MASTRA_INTENT_RECONCILE_RACE");
          await tx
            .delete(mastraMessageIntentAttachments)
            .where(
              and(
                eq(mastraMessageIntentAttachments.tenantId, tenantId),
                eq(mastraMessageIntentAttachments.threadId, intent.threadId),
                eq(
                  mastraMessageIntentAttachments.clientMessageKey,
                  intent.clientMessageKey,
                ),
              ),
            );
          return "exact" as const;
        });

        if (status === null) continue;
        outcome.scanned += 1;
        if (status === "exact") {
          outcome.finalized += 1;
        } else {
          outcome.pending += 1;
          outcome[status] += 1;
        }
      }

      return outcome;
    },
  };
}
