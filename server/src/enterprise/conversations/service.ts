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
import type {
  AppendMessageInput,
  ConversationDTO,
  ConversationInput,
  ConversationService,
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
}: {
  data: DataDatabase;
}): ConversationService & {
  list(scope: PlatformScope): Promise<ConversationDTO[]>;
} {
  assertDataDatabase(data);
  const store = createConversationStore(data);
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
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            threadId,
            title: input.title ?? null,
            storageBackend: "platform",
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
          throw new Error("LEGACY_HISTORY_READ_ONLY");
        }
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
          throw new Error("LEGACY_HISTORY_READ_ONLY");
        }
        const conversation = await authorizedConversation(
          tx,
          scope,
          input.threadId,
        );
        if (conversation.storageBackend !== "platform")
          throw new Error("LEGACY_HISTORY_READ_ONLY");
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
  };
}
