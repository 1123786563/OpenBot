import { createHash, randomUUID } from "node:crypto";
import type { MastraDBMessage } from "@mastra/core/agent";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  authorizeAttachmentForSendInTransaction,
  lockAttachmentChannelsInTransaction,
  markAttachmentsSentInTransaction,
} from "../../channels/attachments";
import {
  channelMemberships,
  channels,
  intelligenceChannelMappings,
} from "../../db/schema/core";
import {
  enterpriseConversations,
  enterpriseMessageParts,
  enterpriseMessages,
} from "../../db/schema/enterprise-conversations";
import {
  enterpriseResourceGrants,
  enterpriseResources,
} from "../../db/schema/enterprise-tenancy";
import {
  mastraMessageIntentAttachments,
  mastraMessageIntents,
} from "../../db/schema/mastra-message-intents";
import { tenantStorageKey } from "../../mastra/contracts";
import {
  MAX_CLIENT_MESSAGE_KEY_LENGTH,
  MAX_ENGINE_MESSAGE_ID_LENGTH,
} from "../../mastra/conversation-runtime";
import {
  messageDTO as mastraMessageDTO,
  readMastraHistory,
} from "../../mastra/conversations";
import type { OpenBotFullMessage } from "../../mastra/message-parts";
import {
  fullMessageDigestInput,
  parseStoredFullMessage,
} from "../../mastra/message-parts";
import type { TenantMastraStorage } from "../../mastra/tenant-storage";
import type {
  AppendMessageInput,
  ConversationDTO,
  ConversationInput,
  ConversationService,
  EngineMessageAppendInput,
  HistoryInput,
  MessageDTO,
  MessagePage,
  PlatformScope,
  StorageBackend,
} from "../contracts";
import type { DataDatabase } from "../tenancy/connections";
import { assertDataDatabase } from "../tenancy/connections";
import { assertTrustedScope } from "../tenancy/store";
import {
  conversationDto,
  createConversationStore,
  messageDigest,
  newThreadId,
} from "./store";

const MAX_PAGE_SIZE = 100;
const MAX_CONTENT_LENGTH = 1_000_000;
type ConversationTransaction = Parameters<
  Parameters<DataDatabase["transaction"]>[0]
>[0];

function assertInputString(
  value: unknown,
  name: string,
  max: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value.trim() !== value
  ) {
    throw new Error(`INVALID_${name.toUpperCase()}`);
  }
}

function messageDto(row: typeof enterpriseMessages.$inferSelect): MessageDTO {
  return {
    messageId: row.id,
    threadId: row.threadId,
    seq: row.seq,
    role: row.role as MessageDTO["role"],
    content: row.content,
    attachments: row.attachments,
    createdAt: row.createdAt.toISOString(),
  };
}

function mastraMessageId(tenantId: string, threadId: string, key: string) {
  return createHash("sha256")
    .update(`${tenantId}\0${threadId}\0${key}`)
    .digest("hex");
}

function mastraPrivateResourceId(tenantId: string, principalId: string) {
  return `private:${JSON.stringify([tenantId, principalId])}`;
}

async function currentLegacyMapping(
  tx: ConversationTransaction,
  scope: PlatformScope,
  threadId: string,
) {
  const [mapping] = await tx
    .select({
      actorId: intelligenceChannelMappings.userId,
      channelId: intelligenceChannelMappings.channelId,
      threadId: intelligenceChannelMappings.threadId,
      createdAt: intelligenceChannelMappings.createdAt,
      updatedAt: intelligenceChannelMappings.updatedAt,
      liveChannelId: channels.id,
      channelDeletedAt: channels.deletedAt,
      memberId: channelMemberships.userId,
    })
    .from(intelligenceChannelMappings)
    .leftJoin(channels, eq(channels.id, intelligenceChannelMappings.channelId))
    .leftJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channels.id),
        eq(channelMemberships.userId, scope.actorId),
      ),
    )
    .where(eq(intelligenceChannelMappings.threadId, threadId))
    .limit(1);
  return mapping ?? null;
}

async function acquireSharedLock(
  tx: ConversationTransaction,
  key: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
  );
}

async function assertEnterpriseChannelRead(
  tx: ConversationTransaction,
  scope: PlatformScope,
  channelId: string,
): Promise<void> {
  const resourceKey = JSON.stringify([
    "enterprise",
    "resource",
    scope.tenantId,
    channelId,
  ]);
  await acquireSharedLock(tx, resourceKey);
  const [resource] = await tx
    .select({ id: enterpriseResources.id })
    .from(enterpriseResources)
    .innerJoin(
      enterpriseResourceGrants,
      and(
        eq(enterpriseResourceGrants.tenantId, enterpriseResources.tenantId),
        eq(enterpriseResourceGrants.resourceId, enterpriseResources.id),
        eq(enterpriseResourceGrants.principalId, scope.principalId),
        eq(enterpriseResourceGrants.action, "read"),
      ),
    )
    .where(
      and(
        eq(enterpriseResources.tenantId, scope.tenantId),
        eq(enterpriseResources.workspaceId, scope.workspaceId),
        eq(enterpriseResources.id, channelId),
        eq(enterpriseResources.kind, "channel"),
        eq(enterpriseResources.status, "active"),
      ),
    )
    .limit(1);
  if (!resource) throw new Error("CHANNEL_FORBIDDEN");
}

async function authorizedLegacyMapping(
  tx: ConversationTransaction,
  scope: PlatformScope,
  threadId: string,
  initial: Awaited<ReturnType<typeof currentLegacyMapping>>,
) {
  if (!initial) return null;
  if (initial.actorId !== scope.actorId)
    throw new Error("CONVERSATION_NOT_FOUND");

  const channelId = initial.channelId;
  await assertEnterpriseChannelRead(tx, scope, channelId);
  await acquireSharedLock(tx, JSON.stringify(["legacy", "channel", channelId]));

  const current = await currentLegacyMapping(tx, scope, threadId);
  if (
    !current ||
    current.channelId !== channelId ||
    current.actorId !== scope.actorId
  ) {
    throw new Error("CONVERSATION_NOT_FOUND");
  }
  assertLegacyChannelAccess(current);
  return current;
}

async function authorizedLegacyList(
  tx: ConversationTransaction,
  scope: PlatformScope,
) {
  const candidates = await tx
    .select({
      threadId: intelligenceChannelMappings.threadId,
      channelId: intelligenceChannelMappings.channelId,
      title: channels.name,
      createdAt: intelligenceChannelMappings.createdAt,
      updatedAt: intelligenceChannelMappings.updatedAt,
    })
    .from(intelligenceChannelMappings)
    .innerJoin(
      channels,
      and(
        eq(channels.id, intelligenceChannelMappings.channelId),
        sql`${channels.deletedAt} is null`,
      ),
    )
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, intelligenceChannelMappings.channelId),
        eq(channelMemberships.userId, scope.actorId),
      ),
    )
    .innerJoin(
      enterpriseResources,
      and(
        eq(enterpriseResources.tenantId, scope.tenantId),
        eq(enterpriseResources.workspaceId, scope.workspaceId),
        eq(enterpriseResources.id, intelligenceChannelMappings.channelId),
        eq(enterpriseResources.kind, "channel"),
        eq(enterpriseResources.status, "active"),
      ),
    )
    .innerJoin(
      enterpriseResourceGrants,
      and(
        eq(enterpriseResourceGrants.tenantId, enterpriseResources.tenantId),
        eq(enterpriseResourceGrants.resourceId, enterpriseResources.id),
        eq(enterpriseResourceGrants.principalId, scope.principalId),
        eq(enterpriseResourceGrants.action, "read"),
      ),
    )
    .where(
      and(
        eq(intelligenceChannelMappings.userId, scope.actorId),
        eq(enterpriseResourceGrants.tenantId, scope.tenantId),
      ),
    )
    .orderBy(desc(intelligenceChannelMappings.updatedAt))
    .limit(100);
  if (candidates.length === 0) return [];

  const channelIds = [
    ...new Set(candidates.map((row) => row.channelId)),
  ].sort();
  for (const channelId of channelIds) {
    await acquireSharedLock(
      tx,
      JSON.stringify(["enterprise", "resource", scope.tenantId, channelId]),
    );
  }
  const resources = await tx
    .select({ id: enterpriseResources.id })
    .from(enterpriseResources)
    .innerJoin(
      enterpriseResourceGrants,
      and(
        eq(enterpriseResourceGrants.tenantId, enterpriseResources.tenantId),
        eq(enterpriseResourceGrants.resourceId, enterpriseResources.id),
        eq(enterpriseResourceGrants.principalId, scope.principalId),
        eq(enterpriseResourceGrants.action, "read"),
      ),
    )
    .where(
      and(
        eq(enterpriseResources.tenantId, scope.tenantId),
        eq(enterpriseResources.workspaceId, scope.workspaceId),
        inArray(enterpriseResources.id, channelIds),
        eq(enterpriseResources.kind, "channel"),
        eq(enterpriseResources.status, "active"),
      ),
    );
  const allowedResourceIds = new Set(resources.map((row) => row.id));
  const allowedChannelIds = channelIds.filter((id) =>
    allowedResourceIds.has(id),
  );
  if (allowedChannelIds.length === 0) return [];

  for (const channelId of allowedChannelIds) {
    await acquireSharedLock(
      tx,
      JSON.stringify(["legacy", "channel", channelId]),
    );
  }
  const candidatesByThread = new Map(
    candidates.map((row) => [row.threadId, row.channelId]),
  );
  const currentRows = await tx
    .select({
      threadId: intelligenceChannelMappings.threadId,
      channelId: intelligenceChannelMappings.channelId,
      title: channels.name,
      createdAt: intelligenceChannelMappings.createdAt,
      updatedAt: intelligenceChannelMappings.updatedAt,
    })
    .from(intelligenceChannelMappings)
    .innerJoin(
      channels,
      and(
        eq(channels.id, intelligenceChannelMappings.channelId),
        sql`${channels.deletedAt} is null`,
      ),
    )
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, intelligenceChannelMappings.channelId),
        eq(channelMemberships.userId, scope.actorId),
      ),
    )
    .where(
      and(
        eq(intelligenceChannelMappings.userId, scope.actorId),
        inArray(
          intelligenceChannelMappings.threadId,
          candidates.map((row) => row.threadId),
        ),
        inArray(intelligenceChannelMappings.channelId, allowedChannelIds),
      ),
    );

  return currentRows.filter(
    (row) => candidatesByThread.get(row.threadId) === row.channelId,
  );
}

function assertLegacyChannelAccess(mapping: {
  liveChannelId: string | null;
  channelDeletedAt: Date | null;
  memberId: string | null;
}) {
  if (!mapping.liveChannelId || mapping.channelDeletedAt || !mapping.memberId)
    throw new Error("CHANNEL_FORBIDDEN");
}

async function authorizedConversation(
  tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
  scope: PlatformScope,
  threadId: string,
) {
  const [row] = await tx
    .select()
    .from(enterpriseConversations)
    .where(
      and(
        eq(enterpriseConversations.tenantId, scope.tenantId),
        eq(enterpriseConversations.threadId, threadId),
      ),
    )
    .limit(1);
  if (
    !row ||
    row.principalId !== scope.principalId ||
    row.workspaceId !== scope.workspaceId
  ) {
    throw new Error("CONVERSATION_NOT_FOUND");
  }
  return row;
}

export function createConversationService({
  data,
  mastraStorage,
}: {
  data: DataDatabase;
  mastraStorage?: TenantMastraStorage;
}): ConversationService & {
  list(scope: PlatformScope): Promise<ConversationDTO[]>;
  appendEngineMessage(
    scope: PlatformScope,
    input: EngineMessageAppendInput,
  ): Promise<MessageDTO>;
} {
  assertDataDatabase(data);
  const store = createConversationStore(data);
  /**
   * OCR fix wave 2 (R2-5): the ONE finalized-intent validation/assembly
   * shared by the convergence re-read (`readFinalizedMessage`) and the write
   * transaction's `finalized` branch — tenant store → listMessagesById →
   * digest/seq triple check → mastraMessageDTO + reservedSeq. Fix-round-1
   * (I1) was itself an instance of this duplication drifting, so any future
   * rule change lands here once. Returns null on any mismatch (never a
   * guess); each caller maps null to its own contract (null vs
   * MASTRA_MESSAGE_INTENT_MISMATCH).
   */
  const finalizedMessageOrNull = async (
    scope: PlatformScope,
    conversation: typeof enterpriseConversations.$inferSelect,
    intent: typeof mastraMessageIntents.$inferSelect,
    messageId: string,
    digest: string,
  ): Promise<MessageDTO | null> => {
    if (!mastraStorage) return null;
    const storeForRead = await mastraStorage.getStore(scope, {
      tenantId: scope.tenantId,
      conversationId: conversation.id,
      threadId: conversation.threadId,
      resourceId: mastraPrivateResourceId(scope.tenantId, scope.principalId),
      storageKey: tenantStorageKey(scope.tenantId),
      backend: "mastra",
    });
    const memoryForRead = await storeForRead.getStore("memory");
    if (!memoryForRead) throw new Error("MASTRA_MEMORY_STORAGE_UNAVAILABLE");
    const found = await memoryForRead.listMessagesById({
      messageIds: [messageId],
    });
    const priorMessage = found?.messages[0];
    if (
      !priorMessage ||
      priorMessage.content.metadata?.openbotDigest !== digest ||
      priorMessage.content.metadata?.openbotSeq !== intent.reservedSeq
    )
      return null;
    return { ...mastraMessageDTO(priorMessage), seq: intent.reservedSeq };
  };
  /**
   * Fix-round-1 (I1): the converging re-read for a same-key append that
   * wrote its memory row but lost the finalize race. A concurrent caller
   * with the same key can commit the intent's `finalized` state in the
   * window between this caller's `withConversationLock` write and its own
   * conditional finalize UPDATE — that UPDATE then matches zero rows and
   * used to surface as a spurious `message_pending` 503 even though the
   * message IS in the store and the intent IS closed. This re-inspects the
   * ledger and the stored row after the lock and returns the exact success
   * shape the winner returns — or null (never a guess), leaving the original
   * failure to the caller.
   */
  const readFinalizedMessage = async (
    scope: PlatformScope,
    threadId: string,
    clientMessageKey: string,
    messageId: string,
    digest: string,
  ): Promise<MessageDTO | null> => {
    if (!mastraStorage) return null;
    try {
      return await store.transaction(scope, async (tx) => {
        const conversation = await authorizedConversation(tx, scope, threadId);
        if (conversation.storageBackend !== "mastra") return null;
        const [intent] = await tx
          .select()
          .from(mastraMessageIntents)
          .where(
            and(
              eq(mastraMessageIntents.tenantId, scope.tenantId),
              eq(mastraMessageIntents.threadId, threadId),
              eq(mastraMessageIntents.clientMessageKey, clientMessageKey),
            ),
          )
          .limit(1);
        if (
          intent?.state !== "finalized" ||
          intent.digest !== digest ||
          intent.messageId !== messageId
        )
          return null;
        return await finalizedMessageOrNull(
          scope,
          conversation,
          intent,
          messageId,
          digest,
        );
      });
    } catch (cause) {
      // The convergence probe failing silently would leave only the downstream
      // message_pending 503 visible — exactly the failure this path exists to
      // prevent, with no trace of whether the probe itself ever ran. Log in
      // the file's structured shape, then keep the `null` contract.
      // biome-ignore lint/suspicious/noConsole: stable-code operational log
      console.error({
        error: "MASTRA_FINALIZED_READ_FAILED",
        context: {
          operation: "readFinalizedMessage.converge",
          tenantId: scope.tenantId,
          threadId,
        },
        cause:
          cause instanceof Error
            ? ((cause as { code?: unknown }).code ?? cause.constructor.name)
            : typeof cause,
      });
      return null;
    }
  };
  /**
   * The single-writer intent lifecycle shared by the user append and the
   * engine append. Both paths were ~250 lines of near-verbatim duplication
   * (prepare transaction: lock → intent dedup/409 → seq reservation → intent
   * insert; write transaction: lock → intent re-read → finalized re-read →
   * withConversationLock → saveMessages → conditional finalize UPDATE), and
   * every lifecycle fix had to be hand-applied to each copy — the divergence
   * risk this extraction removes. The callers supply only the genuine
   * differences: which transactions run the legacy read-only guard, whether
   * the attachment side effects run at all, and how the memory row is built.
   */
  const appendViaIntentLifecycle = async (args: {
    scope: PlatformScope;
    threadId: string;
    clientMessageKey: string;
    messageId: string;
    digest: string;
    attachmentIds: readonly string[];
    legacyGuardInPrepare: boolean;
    legacyGuardInWrite: boolean;
    attachmentSideEffects: boolean;
    buildMemoryMessage: (
      binding: {
        tenantId: string;
        conversationId: string;
        threadId: string;
        resourceId: string;
        storageKey: string;
        backend: "mastra";
      },
      reservedSeq: number,
    ) => MastraDBMessage;
  }): Promise<MessageDTO> => {
    const {
      scope,
      threadId,
      clientMessageKey,
      messageId,
      digest,
      attachmentIds,
    } = args;
    if (!mastraStorage) throw new Error("MASTRA_STORAGE_UNAVAILABLE");
    const prepared = await store.transaction(scope, async (tx) => {
      if (args.legacyGuardInPrepare) {
        const initialLegacy = await currentLegacyMapping(tx, scope, threadId);
        if (await authorizedLegacyMapping(tx, scope, threadId, initialLegacy))
          throw new Error("LEGACY_HISTORY_READ_ONLY");
      }
      const conversation = await authorizedConversation(tx, scope, threadId);
      if (conversation.storageBackend !== "mastra")
        throw new Error("CONVERSATION_BACKEND_CHANGED");
      if (args.attachmentSideEffects) {
        await lockAttachmentChannelsInTransaction(
          tx,
          scope.tenantId,
          attachmentIds,
        );
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["conversation", scope.tenantId, threadId])}, 0))`,
      );
      if (args.attachmentSideEffects) {
        for (const id of attachmentIds) {
          if (
            !(await authorizeAttachmentForSendInTransaction(
              tx,
              { actorId: scope.actorId, threadId },
              id,
            ))
          )
            throw new Error("ATTACHMENT_FORBIDDEN");
        }
      }
      const [prior] = await tx
        .select()
        .from(mastraMessageIntents)
        .where(
          and(
            eq(mastraMessageIntents.tenantId, scope.tenantId),
            eq(mastraMessageIntents.threadId, threadId),
            eq(mastraMessageIntents.clientMessageKey, clientMessageKey),
          ),
        )
        .limit(1);
      if (prior) {
        if (prior.digest !== digest)
          throw Object.assign(
            new Error("Message key was already used with different content."),
            { code: "message_conflict", status: 409 },
          );
        if (
          prior.messageId !== messageId ||
          prior.principalId !== scope.principalId ||
          prior.actorId !== scope.actorId
        )
          throw new Error("MASTRA_INTENT_SCOPE_MISMATCH");
        return prior;
      }
      const [reserved] = await tx
        .update(enterpriseConversations)
        .set({
          lastSeq: sql`${enterpriseConversations.lastSeq} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(enterpriseConversations.tenantId, scope.tenantId),
            eq(enterpriseConversations.threadId, threadId),
            eq(enterpriseConversations.storageBackend, "mastra"),
            eq(
              enterpriseConversations.backendVersion,
              conversation.backendVersion,
            ),
          ),
        )
        .returning({ seq: enterpriseConversations.lastSeq });
      if (!reserved) throw new Error("CONVERSATION_BACKEND_CHANGED");
      const [intent] = await tx
        .insert(mastraMessageIntents)
        .values({
          tenantId: scope.tenantId,
          threadId,
          clientMessageKey,
          messageId,
          digest,
          reservedSeq: reserved.seq,
          actorId: scope.actorId,
          principalId: scope.principalId,
          backendVersion: conversation.backendVersion,
          attachmentIds: [...attachmentIds],
          state: "pending",
        })
        .returning();
      if (!intent) throw new Error("MASTRA_INTENT_PREPARE_FAILED");
      if (args.attachmentSideEffects && attachmentIds.length) {
        await tx.insert(mastraMessageIntentAttachments).values(
          attachmentIds.map((attachmentId) => ({
            tenantId: scope.tenantId,
            threadId,
            clientMessageKey,
            attachmentId,
          })),
        );
      }
      return intent;
    });

    let writeConfirmed = false;
    let writeAttempted = false;
    try {
      return await store.transaction(scope, async (tx) => {
        if (args.legacyGuardInWrite) {
          const initialLegacy = await currentLegacyMapping(tx, scope, threadId);
          if (await authorizedLegacyMapping(tx, scope, threadId, initialLegacy))
            throw new Error("LEGACY_HISTORY_READ_ONLY");
        }
        const conversation = await authorizedConversation(tx, scope, threadId);
        if (
          conversation.storageBackend !== "mastra" ||
          conversation.backendVersion !== prepared.backendVersion
        )
          throw new Error("CONVERSATION_BACKEND_CHANGED");
        if (args.attachmentSideEffects) {
          await lockAttachmentChannelsInTransaction(
            tx,
            scope.tenantId,
            attachmentIds,
          );
        }
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["conversation", scope.tenantId, threadId])}, 0))`,
        );
        const [intent] = await tx
          .select()
          .from(mastraMessageIntents)
          .where(
            and(
              eq(mastraMessageIntents.tenantId, scope.tenantId),
              eq(mastraMessageIntents.threadId, threadId),
              eq(mastraMessageIntents.clientMessageKey, clientMessageKey),
            ),
          )
          .limit(1);
        if (
          !intent ||
          intent.digest !== digest ||
          intent.messageId !== messageId
        )
          throw new Error("MASTRA_INTENT_NOT_FOUND");
        if (intent.state === "finalized") {
          const finalized = await finalizedMessageOrNull(
            scope,
            conversation,
            intent,
            messageId,
            digest,
          );
          if (!finalized) throw new Error("MASTRA_MESSAGE_INTENT_MISMATCH");
          return finalized;
        }
        if (args.attachmentSideEffects) {
          for (const id of attachmentIds) {
            if (
              !(await authorizeAttachmentForSendInTransaction(
                tx,
                { actorId: scope.actorId, threadId },
                id,
              ))
            )
              throw new Error("ATTACHMENT_FORBIDDEN");
          }
        }
        const binding = {
          tenantId: scope.tenantId,
          conversationId: conversation.id,
          threadId: conversation.threadId,
          resourceId: mastraPrivateResourceId(
            scope.tenantId,
            scope.principalId,
          ),
          storageKey: tenantStorageKey(scope.tenantId),
          backend: "mastra" as const,
        };
        const mastraStore = await mastraStorage.getStore(scope, binding);
        const memory = await mastraStore.getStore("memory");
        if (!memory) throw new Error("MASTRA_MEMORY_STORAGE_UNAVAILABLE");
        const result = await mastraStorage.withConversationLock(
          scope,
          binding,
          async () => {
            const existing = await memory.listMessagesById({
              messageIds: [messageId],
            });
            let accepted = existing.messages[0];
            if (accepted) {
              const metadata = accepted.content.metadata ?? {};
              if (
                accepted.threadId !== binding.threadId ||
                accepted.resourceId !== binding.resourceId ||
                metadata.openbotDigest !== digest ||
                metadata.openbotSeq !== intent.reservedSeq
              )
                throw new Error("MASTRA_MESSAGE_ID_CONFLICT");
            } else {
              const thread = await memory.getThreadById({
                threadId: binding.threadId,
                resourceId: binding.resourceId,
              });
              if (!thread) {
                const now = new Date();
                await memory.saveThread({
                  thread: {
                    id: binding.threadId,
                    resourceId: binding.resourceId,
                    title: "Conversation",
                    createdAt: now,
                    updatedAt: now,
                  },
                });
              }
              writeAttempted = true;
              const saved = await memory.saveMessages({
                messages: [
                  args.buildMemoryMessage(binding, intent.reservedSeq),
                ],
              });
              accepted = saved.messages[0];
              if (!accepted) throw new Error("MASTRA_MESSAGE_WRITE_FAILED");
              const metadata = accepted.content.metadata ?? {};
              if (
                metadata.openbotDigest !== digest ||
                metadata.openbotSeq !== intent.reservedSeq
              )
                throw new Error("MASTRA_MESSAGE_WRITE_UNCONFIRMED");
            }
            writeConfirmed = true;
            return accepted;
          },
        );
        if (args.attachmentSideEffects) {
          await markAttachmentsSentInTransaction(
            tx,
            { actorId: scope.actorId, threadId },
            attachmentIds,
          );
        }
        const [finalized] = await tx
          .update(mastraMessageIntents)
          .set({ state: "finalized", updatedAt: new Date() })
          .where(
            and(
              eq(mastraMessageIntents.tenantId, scope.tenantId),
              eq(mastraMessageIntents.threadId, threadId),
              eq(mastraMessageIntents.clientMessageKey, clientMessageKey),
              eq(mastraMessageIntents.state, "pending"),
              // ME14 (#486) write fence: the intent finalizes only against
              // the conversation row's CURRENT backend_version. The
              // transaction's earlier version re-read can be stale when a
              // cutover switch commits mid-transaction (the advisory lock
              // serializes whole writers, but this transaction may have
              // passed its check before the switch took the lock), so the
              // fence's last word is the database's own comparison here: an
              // intent prepared against an older writer generation never
              // lands after the switch.
              sql`${mastraMessageIntents.backendVersion} = (select ${enterpriseConversations.backendVersion} from ${enterpriseConversations} where ${enterpriseConversations.tenantId} = ${scope.tenantId} and ${enterpriseConversations.threadId} = ${threadId})`,
            ),
          )
          .returning({
            clientMessageKey: mastraMessageIntents.clientMessageKey,
          });
        if (!finalized) throw new Error("MASTRA_INTENT_FINALIZE_FAILED");
        if (args.attachmentSideEffects) {
          await tx
            .delete(mastraMessageIntentAttachments)
            .where(
              and(
                eq(mastraMessageIntentAttachments.tenantId, scope.tenantId),
                eq(mastraMessageIntentAttachments.threadId, threadId),
                eq(
                  mastraMessageIntentAttachments.clientMessageKey,
                  clientMessageKey,
                ),
              ),
            );
        }
        return { ...mastraMessageDTO(result), seq: intent.reservedSeq };
      });
    } catch (error) {
      if (
        (writeConfirmed || writeAttempted) &&
        error instanceof Error &&
        error.message === "MASTRA_INTENT_FINALIZE_FAILED"
      ) {
        // Fix-round-1 (I1): a concurrent same-key caller finalized the
        // intent between this caller's memory write and its own finalize
        // UPDATE. Converge on the winner's committed state — the same
        // success shape — instead of a false `message_pending` 503.
        const converged = await readFinalizedMessage(
          scope,
          threadId,
          clientMessageKey,
          messageId,
          digest,
        );
        if (converged) return converged;
      }
      if (writeConfirmed || writeAttempted) {
        throw Object.assign(
          new Error(
            "Mastra accepted this message, but platform finalization is pending; retry the same key.",
          ),
          { code: "message_pending", status: 503, cause: error },
        );
      }
      throw error;
    }
  };
  return {
    async list(scope): Promise<ConversationDTO[]> {
      assertTrustedScope(scope);
      return store.transaction(scope, async (tx) => {
        const platformRows = await tx
          .select()
          .from(enterpriseConversations)
          .where(
            and(
              eq(enterpriseConversations.tenantId, scope.tenantId),
              eq(enterpriseConversations.workspaceId, scope.workspaceId),
              eq(enterpriseConversations.principalId, scope.principalId),
            ),
          )
          .orderBy(desc(enterpriseConversations.updatedAt))
          .limit(100);
        const legacyRows = await authorizedLegacyList(tx, scope);
        const items = [
          ...platformRows.map(conversationDto),
          ...legacyRows.map((row) => ({
            conversation_id: `legacy:${row.threadId}`,
            thread_id: row.threadId,
            title: row.title,
            storage_backend: "intelligence" as const,
            created_at: row.createdAt.toISOString(),
            updated_at: row.updatedAt.toISOString(),
            last_message_seq: 0,
          })),
        ];
        return items
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          .slice(0, 100);
      });
    },
    async getOrCreate(
      scope,
      input: ConversationInput,
    ): Promise<ConversationDTO> {
      assertTrustedScope(scope);
      if (input.threadId !== undefined)
        assertInputString(input.threadId, "thread_id", 200);
      if (
        input.title !== undefined &&
        input.title !== null &&
        (typeof input.title !== "string" || input.title.length > 500)
      )
        throw new Error("INVALID_TITLE");
      const suppliedThreadId = input.threadId !== undefined;
      const threadId = input.threadId ?? newThreadId();
      const conversationId = randomUUID();
      // Probe Mastra storage availability before opening the conversation
      // transaction: the advisory locks held by store.transaction must not
      // span external storage I/O. Only the create path (generated thread id)
      // needs Mastra storage — supplied thread ids never reach creation.
      if (!suppliedThreadId) {
        if (!mastraStorage) {
          throw Object.assign(new Error("MASTRA_STORAGE_UNAVAILABLE"), {
            code: "MASTRA_STORAGE_UNAVAILABLE",
            status: 503,
          });
        }
        try {
          await mastraStorage.getStore(scope, {
            tenantId: scope.tenantId,
            conversationId,
            threadId,
            resourceId: mastraPrivateResourceId(
              scope.tenantId,
              scope.principalId,
            ),
            storageKey: tenantStorageKey(scope.tenantId),
            backend: "mastra",
          });
        } catch (cause) {
          // biome-ignore lint/suspicious/noConsole: stable-code operational log
          console.error({
            error: "MASTRA_STORAGE_PROBE_FAILED",
            context: {
              operation: "getOrCreate",
              tenantId: scope.tenantId,
            },
            cause:
              cause instanceof Error
                ? ((cause as { code?: unknown }).code ?? cause.constructor.name)
                : typeof cause,
          });
          throw Object.assign(new Error("MASTRA_STORAGE_UNAVAILABLE"), {
            code: "MASTRA_STORAGE_UNAVAILABLE",
            status: 503,
            cause,
          });
        }
      }
      return store.transaction(scope, async (tx) => {
        const initialLegacy = await currentLegacyMapping(tx, scope, threadId);
        const legacy = await authorizedLegacyMapping(
          tx,
          scope,
          threadId,
          initialLegacy,
        );
        if (legacy) {
          return {
            conversation_id: `legacy:${threadId}`,
            thread_id: threadId,
            title: null,
            storage_backend: "intelligence",
            created_at: legacy.createdAt.toISOString(),
            updated_at: legacy.updatedAt.toISOString(),
            last_message_seq: 0,
          };
        }
        const [existing] = await tx
          .select()
          .from(enterpriseConversations)
          .where(
            and(
              eq(enterpriseConversations.tenantId, scope.tenantId),
              eq(enterpriseConversations.threadId, threadId),
            ),
          )
          .limit(1);
        if (existing) {
          if (
            existing.principalId !== scope.principalId ||
            existing.workspaceId !== scope.workspaceId
          )
            throw new Error("CONVERSATION_NOT_FOUND");
          return conversationDto(existing);
        }
        if (suppliedThreadId) throw new Error("CONVERSATION_NOT_FOUND");
        const [created] = await tx
          .insert(enterpriseConversations)
          .values({
            id: conversationId,
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            threadId,
            title: input.title ?? null,
            storageBackend: "mastra",
          })
          .onConflictDoNothing({
            target: [
              enterpriseConversations.tenantId,
              enterpriseConversations.threadId,
            ],
          })
          .returning();
        if (created) return conversationDto(created);
        const [raced] = await tx
          .select()
          .from(enterpriseConversations)
          .where(
            and(
              eq(enterpriseConversations.tenantId, scope.tenantId),
              eq(enterpriseConversations.threadId, threadId),
            ),
          )
          .limit(1);
        if (
          !raced ||
          raced.principalId !== scope.principalId ||
          raced.workspaceId !== scope.workspaceId
        )
          throw new Error("CONVERSATION_NOT_FOUND");
        return conversationDto(raced);
      });
    },

    async append(scope, input: AppendMessageInput): Promise<MessageDTO> {
      assertTrustedScope(scope);
      assertInputString(input.threadId, "thread_id", 200);
      assertInputString(input.clientMessageKey, "client_message_key", 200);
      if (
        typeof input.content !== "string" ||
        input.content.length > MAX_CONTENT_LENGTH ||
        !Array.isArray(input.attachments) ||
        input.attachments.length > 32 ||
        input.attachments.some((id) => typeof id !== "string")
      )
        throw new Error("INVALID_MESSAGE");
      const { content, digest } = messageDigest(
        input.content,
        input.attachments,
      );
      if (content.trim().length === 0 && input.attachments.length === 0)
        throw new Error("INVALID_MESSAGE");
      const [persistedConversation] = await store.transaction(
        scope,
        async (tx) => {
          const initialLegacy = await currentLegacyMapping(
            tx,
            scope,
            input.threadId,
          );
          const legacy = await authorizedLegacyMapping(
            tx,
            scope,
            input.threadId,
            initialLegacy,
          );
          if (legacy) throw new Error("LEGACY_HISTORY_READ_ONLY");
          return [await authorizedConversation(tx, scope, input.threadId)];
        },
      );
      if (persistedConversation.storageBackend === "mastra") {
        const attachmentIds = [...input.attachments];
        const messageId = mastraMessageId(
          scope.tenantId,
          input.threadId,
          input.clientMessageKey,
        );
        return appendViaIntentLifecycle({
          scope,
          threadId: input.threadId,
          clientMessageKey: input.clientMessageKey,
          messageId,
          digest,
          attachmentIds,
          // The user path runs the legacy read-only guard in its own
          // pre-transaction above and again in the write transaction; the
          // prepare transaction keeps its original shape.
          legacyGuardInPrepare: false,
          legacyGuardInWrite: true,
          attachmentSideEffects: true,
          buildMemoryMessage: (binding, reservedSeq) => ({
            id: messageId,
            threadId: binding.threadId,
            resourceId: binding.resourceId,
            role: "user",
            type: "text",
            createdAt: new Date(),
            content: {
              format: 2,
              parts: content ? [{ type: "text", text: content }] : [],
              metadata: {
                openbotSeq: reservedSeq,
                openbotDigest: digest,
                openbotClientMessageKey: input.clientMessageKey,
                openbotAttachments: attachmentIds,
              },
            },
          }),
        });
      }
      return store.transaction(scope, async (tx) => {
        const initialLegacy = await currentLegacyMapping(
          tx,
          scope,
          input.threadId,
        );
        const legacy = await authorizedLegacyMapping(
          tx,
          scope,
          input.threadId,
          initialLegacy,
        );
        if (legacy) throw new Error("LEGACY_HISTORY_READ_ONLY");
        const conversation = await authorizedConversation(
          tx,
          scope,
          input.threadId,
        );
        if (conversation.storageBackend !== "platform")
          throw new Error("LEGACY_HISTORY_READ_ONLY");
        await lockAttachmentChannelsInTransaction(
          tx,
          scope.tenantId,
          input.attachments,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["conversation", scope.tenantId, input.threadId])}, 0))`,
        );
        for (const id of input.attachments) {
          const authorized = await authorizeAttachmentForSendInTransaction(
            tx,
            { actorId: scope.actorId, threadId: input.threadId },
            id,
          );
          if (!authorized) throw new Error("ATTACHMENT_FORBIDDEN");
        }
        const [existing] = await tx
          .select()
          .from(enterpriseMessages)
          .where(
            and(
              eq(enterpriseMessages.tenantId, scope.tenantId),
              eq(enterpriseMessages.threadId, input.threadId),
              eq(enterpriseMessages.clientMessageKey, input.clientMessageKey),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.digest !== digest)
            throw Object.assign(
              new Error("Message key was already used with different content."),
              { code: "message_conflict", status: 409 },
            );
          return messageDto(existing);
        }
        const [sequence] = await tx
          .update(enterpriseConversations)
          .set({
            lastSeq: sql`${enterpriseConversations.lastSeq} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(enterpriseConversations.tenantId, scope.tenantId),
              eq(enterpriseConversations.threadId, input.threadId),
            ),
          )
          .returning({ lastSeq: enterpriseConversations.lastSeq });
        if (!sequence) throw new Error("CONVERSATION_NOT_FOUND");
        const [saved] = await tx
          .insert(enterpriseMessages)
          .values({
            tenantId: scope.tenantId,
            threadId: input.threadId,
            seq: sequence.lastSeq,
            clientMessageKey: input.clientMessageKey,
            digest,
            role: "user",
            content,
            attachments: [...input.attachments],
          })
          .returning();
        await tx.insert(enterpriseMessageParts).values([
          ...(content
            ? [
                {
                  tenantId: scope.tenantId,
                  messageId: saved.id,
                  ordinal: 0,
                  kind: "text" as const,
                  data: { text: content },
                },
              ]
            : []),
          ...input.attachments.map((attachmentId, index) => ({
            tenantId: scope.tenantId,
            messageId: saved.id,
            ordinal: (content ? 1 : 0) + index,
            kind: "attachment" as const,
            attachmentId,
            data: {},
          })),
        ]);
        await markAttachmentsSentInTransaction(
          tx,
          { actorId: scope.actorId, threadId: input.threadId },
          input.attachments,
        );
        return messageDto(saved);
      });
    },

    /**
     * ME03: append one ENGINE OUTPUT message (assistant/tool) to a
     * mastra-backend conversation through the same single-writer intent
     * machinery the user append uses.
     *
     * The caller-supplied `clientMessageKey` must be a server-issued
     * idempotency key (execution key + engine message id), so an output
     * retry that replays identical full parts resolves to the SAME intent
     * and never appends a second row. The digest covers the full versioned
     * parts — not the display projection — so any different content on a
     * replayed key conflicts loudly instead of silently replacing history.
     * No attachments are accepted here: engine output references no staged
     * files, so the attachment lock/stamp phases of the user append are
     * absent by construction.
     */
    async appendEngineMessage(
      scope: PlatformScope,
      input: EngineMessageAppendInput,
    ): Promise<MessageDTO> {
      assertTrustedScope(scope);
      assertInputString(input.threadId, "thread_id", 200);
      // The engine append composes keys with the runtime
      // (engineAppendClientMessageKey), so this side consumes the runtime's
      // shared constant instead of a second bare 200 (R4-4).
      assertInputString(
        input.clientMessageKey,
        "client_message_key",
        MAX_CLIENT_MESSAGE_KEY_LENGTH,
      );
      if (input.role !== "assistant" && input.role !== "tool")
        throw new Error("INVALID_MESSAGE");
      if (
        typeof input.engineMessageId !== "string" ||
        input.engineMessageId.length === 0 ||
        // clientMessageKey is capped at 200 and composed by
        // engineAppendClientMessageKey() as
        // `${executionKey}:${engineMessageId}`; MAX_ENGINE_MESSAGE_ID_LENGTH
        // is the engine id's exact share of that budget, derived at the
        // composition site so the two ends cannot drift: 164..200 would
        // otherwise pass here and then always fail the key assertion below
        // with a misleading INVALID_CLIENT_MESSAGE_KEY.
        input.engineMessageId.length > MAX_ENGINE_MESSAGE_ID_LENGTH
      )
        throw new Error("INVALID_MESSAGE");
      if (
        input.toolCallId !== undefined &&
        (typeof input.toolCallId !== "string" ||
          input.toolCallId.length === 0 ||
          input.toolCallId.length > 200)
      )
        throw new Error("INVALID_MESSAGE");
      if (input.role === "tool" && input.toolCallId === undefined)
        throw new Error("INVALID_MESSAGE");
      if (!Array.isArray(input.parts) || input.parts.length === 0)
        throw new Error("INVALID_MESSAGE");
      if (input.answerBasis !== undefined && input.role !== "assistant")
        throw new Error("INVALID_MESSAGE");
      const full: OpenBotFullMessage = {
        schemaVersion: 1,
        role: input.role,
        parts: [...input.parts],
        engineMessageId: input.engineMessageId,
        ...(input.toolCallId !== undefined
          ? { toolCallId: input.toolCallId }
          : {}),
        // O3-H1: the basis rides the envelope the digest proves, so the
        // idempotency comparison below covers it too.
        ...(input.answerBasis !== undefined
          ? { answerBasis: [...input.answerBasis] }
          : {}),
      };
      // Only envelopes that parse back exactly are provable: compare the
      // canonical form of the re-parsed envelope against the input. The
      // parser silently DROPS a non-string engineMessageId/toolCallId, so a
      // mere re-parse is not equality — a dropped field is a different
      // value, and writing it would corrupt the thread's provability.
      const reparsed = parseStoredFullMessage(JSON.parse(JSON.stringify(full)));
      if (fullMessageDigestInput(reparsed) !== fullMessageDigestInput(full))
        throw new Error("INVALID_MESSAGE");
      const digest = createHash("sha256")
        .update(fullMessageDigestInput(full))
        .digest("hex");
      const messageId = mastraMessageId(
        scope.tenantId,
        input.threadId,
        input.clientMessageKey,
      );
      return appendViaIntentLifecycle({
        scope,
        threadId: input.threadId,
        clientMessageKey: input.clientMessageKey,
        messageId,
        digest,
        // Engine output references no staged files: no attachment locks,
        // authorization, sent-marking, or intent-attachment rows.
        attachmentIds: [],
        // The engine path mirrors the user paths' invariant: the legacy
        // read-only guard is evaluated inside the transaction that writes
        // (the prepare-side check alone leaves the prepare→write window
        // uncovered, and a legacy-mapping authorization does not flip
        // storageBackend, so the backend/version re-check cannot stand in).
        legacyGuardInPrepare: false,
        legacyGuardInWrite: true,
        attachmentSideEffects: false,
        buildMemoryMessage: (binding, reservedSeq) => {
          const displayParts = full.parts
            .filter(
              (part): part is Extract<typeof part, { kind: "text" }> =>
                part.kind === "text",
            )
            .map((part) => ({ type: "text" as const, text: part.text }));
          return {
            id: messageId,
            threadId: binding.threadId,
            resourceId: binding.resourceId,
            // The memory-level role union has no "tool": a tool result is
            // stored as an assistant memory row whose versioned envelope
            // (openbotParts.role = "tool") carries the conversational truth
            // the rebuild reads.
            role: "assistant",
            type: "text",
            createdAt: new Date(),
            content: {
              format: 2,
              parts: displayParts,
              metadata: {
                openbotSeq: reservedSeq,
                openbotDigest: digest,
                openbotClientMessageKey: input.clientMessageKey,
                openbotAttachments: [],
                openbotParts: full,
                openbotEngineMessageId: input.engineMessageId,
                ...(input.toolCallId !== undefined
                  ? { openbotToolCallId: input.toolCallId }
                  : {}),
              },
            },
          };
        },
      });
    },

    async history(scope, input: HistoryInput): Promise<MessagePage> {
      assertTrustedScope(scope);
      assertInputString(input.threadId, "thread_id", 200);
      if (
        input.beforeSeq !== null &&
        (!Number.isSafeInteger(input.beforeSeq) || input.beforeSeq < 1)
      )
        throw new Error("INVALID_CURSOR");
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_PAGE_SIZE
      )
        throw new Error("INVALID_LIMIT");
      return store.transaction(scope, async (tx) => {
        const initialLegacy = await currentLegacyMapping(
          tx,
          scope,
          input.threadId,
        );
        const legacy = await authorizedLegacyMapping(
          tx,
          scope,
          input.threadId,
          initialLegacy,
        );
        if (legacy) {
          if (!mastraStorage) throw new Error("LEGACY_HISTORY_READ_ONLY");
          return readMastraHistory(
            mastraStorage,
            scope,
            {
              tenantId: scope.tenantId,
              conversationId: `legacy:${input.threadId}`,
              threadId: input.threadId,
              resourceId: `channel:${legacy.channelId}`,
              storageKey: tenantStorageKey(scope.tenantId),
              backend: "intelligence",
            },
            input,
          );
        }
        const conversation = await authorizedConversation(
          tx,
          scope,
          input.threadId,
        );
        if (
          conversation.storageBackend === "intelligence" ||
          conversation.storageBackend === "mastra"
        ) {
          if (!mastraStorage) throw new Error("LEGACY_HISTORY_READ_ONLY");
          const backend = conversation.storageBackend;
          const resourceId =
            backend === "mastra"
              ? mastraPrivateResourceId(scope.tenantId, scope.principalId)
              : `private:${conversation.id}`;
          return readMastraHistory(
            mastraStorage,
            scope,
            {
              tenantId: scope.tenantId,
              conversationId: conversation.id,
              threadId: conversation.threadId,
              resourceId,
              storageKey: tenantStorageKey(scope.tenantId),
              backend,
            },
            input,
            backend === "mastra"
              ? async ({ beforeSeq, limit }) => {
                  const rows = await tx
                    .select({
                      messageId: mastraMessageIntents.messageId,
                      seq: mastraMessageIntents.reservedSeq,
                    })
                    .from(mastraMessageIntents)
                    .where(
                      and(
                        eq(mastraMessageIntents.tenantId, scope.tenantId),
                        eq(mastraMessageIntents.threadId, input.threadId),
                        eq(mastraMessageIntents.state, "finalized"),
                        beforeSeq === null
                          ? sql`true`
                          : lt(mastraMessageIntents.reservedSeq, beforeSeq),
                      ),
                    )
                    .orderBy(desc(mastraMessageIntents.reservedSeq))
                    .limit(limit + 1);
                  return rows;
                }
              : undefined,
          );
        }
        const predicate = and(
          eq(enterpriseMessages.tenantId, scope.tenantId),
          eq(enterpriseMessages.threadId, input.threadId),
          input.beforeSeq === null
            ? sql`true`
            : lt(enterpriseMessages.seq, input.beforeSeq),
        );
        const rows = await tx
          .select()
          .from(enterpriseMessages)
          .where(predicate)
          .orderBy(desc(enterpriseMessages.seq))
          .limit(input.limit + 1);
        const hasMore = rows.length > input.limit;
        const pageRows = rows.slice(0, input.limit).reverse();
        return {
          items: pageRows.map(messageDto),
          nextBeforeSeq: hasMore ? (pageRows[0]?.seq ?? null) : null,
        };
      });
    },

    async resolveBackend(scope, threadId): Promise<StorageBackend> {
      assertTrustedScope(scope);
      assertInputString(threadId, "thread_id", 200);
      return store.transaction(scope, async (tx) => {
        const initialLegacy = await currentLegacyMapping(tx, scope, threadId);
        const legacy = await authorizedLegacyMapping(
          tx,
          scope,
          threadId,
          initialLegacy,
        );
        if (legacy) {
          return "intelligence";
        }
        const conversation = await authorizedConversation(tx, scope, threadId);
        return conversation.storageBackend;
      });
    },

    async resolveMastraBinding(scope, threadId) {
      assertTrustedScope(scope);
      assertInputString(threadId, "thread_id", 200);
      return store.transaction(scope, async (tx) => {
        const initialLegacy = await currentLegacyMapping(tx, scope, threadId);
        const legacy = await authorizedLegacyMapping(
          tx,
          scope,
          threadId,
          initialLegacy,
        );
        if (legacy) {
          return {
            tenantId: scope.tenantId,
            conversationId: `legacy:${threadId}`,
            threadId,
            resourceId: `channel:${legacy.channelId}`,
            storageKey: tenantStorageKey(scope.tenantId),
            backend: "intelligence" as const,
          };
        }
        const conversation = await authorizedConversation(tx, scope, threadId);
        return {
          tenantId: scope.tenantId,
          conversationId: conversation.id,
          threadId: conversation.threadId,
          resourceId:
            conversation.storageBackend === "mastra"
              ? mastraPrivateResourceId(scope.tenantId, scope.principalId)
              : `private:${conversation.id}`,
          storageKey: tenantStorageKey(scope.tenantId),
          backend: conversation.storageBackend,
        };
      });
    },
  };
}
