import { createHash } from "node:crypto";
import type { MastraDBMessage } from "@mastra/core/agent";
import type {
  AppendMessageInput,
  ConversationService,
  HistoryInput,
  MessageDTO,
  MessagePage,
  PlatformScope,
} from "../enterprise/contracts";
import { assertTrustedScope } from "../enterprise/tenancy/store";
import type { MastraConversationBinding } from "./contracts";
import type { TenantMastraStorage } from "./tenant-storage";

type BoundConversationService = ConversationService & {
  resolveMastraBinding(
    scope: PlatformScope,
    threadId: string,
  ): Promise<MastraConversationBinding>;
};

const MAX_CONTENT_LENGTH = 1_000_000;

function digest(content: string, attachments: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ content, attachments }))
    .digest("hex");
}

export function messageDTO(message: MastraDBMessage): MessageDTO {
  const metadata = message.content.metadata ?? {};
  const parts = message.content.parts;
  const content = parts
    .filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");
  const attachments = Array.isArray(metadata.openbotAttachments)
    ? metadata.openbotAttachments.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const seq = metadata.openbotSeq;
  return {
    messageId: message.id,
    threadId: message.threadId ?? "",
    seq: typeof seq === "number" ? seq : 0,
    role: message.role === "user" ? "user" : "assistant",
    content,
    attachments,
    createdAt: message.createdAt.toISOString(),
  };
}

export interface MastraConversationRepository {
  resolve(
    scope: PlatformScope,
    threadId: string,
  ): Promise<MastraConversationBinding>;
  append(scope: PlatformScope, input: AppendMessageInput): Promise<MessageDTO>;
  history(scope: PlatformScope, input: HistoryInput): Promise<MessagePage>;
}

export async function readMastraHistory(
  storage: TenantMastraStorage,
  scope: PlatformScope,
  binding: MastraConversationBinding,
  input: HistoryInput,
  listFinalizedIntents?: (input: {
    beforeSeq: number | null;
    limit: number;
  }) => Promise<readonly { messageId: string; seq: number }[]>,
): Promise<MessagePage> {
  if (binding.backend !== "intelligence" && binding.backend !== "mastra")
    throw new Error("MASTRA_BACKEND_NOT_ACTIVE");
  const store = await storage.getStore(scope, binding);
  const memory = await store.getStore("memory");
  if (!memory) throw new Error("MASTRA_MEMORY_STORAGE_UNAVAILABLE");
  if (binding.backend === "mastra") {
    if (!listFinalizedIntents)
      throw new Error("MASTRA_SEQUENCE_INDEX_UNAVAILABLE");
    const rows = await listFinalizedIntents(input);
    const hasMore = rows.length > input.limit;
    const pageRows = rows.slice(0, input.limit).reverse();
    const loaded = await memory.listMessagesById({
      messageIds: pageRows.map((row) => row.messageId),
    });
    const byId = new Map(
      loaded.messages.map((message) => [message.id, message]),
    );
    const items = pageRows.map(({ messageId, seq }) => {
      const message = byId.get(messageId);
      if (
        !message ||
        message.threadId !== binding.threadId ||
        message.resourceId !== binding.resourceId ||
        message.content.metadata?.openbotSeq !== seq
      )
        throw new Error("MASTRA_MESSAGE_INTENT_MISMATCH");
      return { ...messageDTO(message), seq };
    });
    return {
      items,
      nextBeforeSeq: hasMore ? (pageRows[0]?.seq ?? null) : null,
    };
  }
  const result = await memory.listMessages({
    threadId: binding.threadId,
    resourceId: binding.resourceId,
    perPage: false,
    orderBy: { field: "createdAt", direction: "ASC" },
  });
  const ordered = result.messages.sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  const ranked = ordered
    .map((message, index) => ({ message, seq: index + 1 }))
    .filter(({ seq }) => input.beforeSeq === null || seq < input.beforeSeq);
  const hasMore = ranked.length > input.limit;
  const page = ranked.slice(Math.max(0, ranked.length - input.limit));
  return {
    items: page.map(({ message, seq }) => ({ ...messageDTO(message), seq })),
    nextBeforeSeq: hasMore ? (page[0]?.seq ?? null) : null,
  };
}

/** Request-facing operations resolve all tenant/resource identifiers from trusted platform state. */
export function createMastraConversationRepository({
  conversations,
  storage,
}: {
  conversations: BoundConversationService;
  storage: TenantMastraStorage;
}): MastraConversationRepository {
  async function bindingFor(scope: PlatformScope, threadId: string) {
    assertTrustedScope(scope);
    const binding = await conversations.resolveMastraBinding(scope, threadId);
    if (binding.tenantId !== scope.tenantId || binding.threadId !== threadId)
      throw new Error("CONVERSATION_NOT_FOUND");
    return binding;
  }

  return {
    async resolve(scope, threadId) {
      return bindingFor(scope, threadId);
    },

    async append(scope, input) {
      assertTrustedScope(scope);
      if (
        typeof input.threadId !== "string" ||
        !input.threadId ||
        input.threadId.length > 200 ||
        typeof input.clientMessageKey !== "string" ||
        !input.clientMessageKey ||
        input.clientMessageKey.length > 200 ||
        input.clientMessageKey.trim() !== input.clientMessageKey ||
        typeof input.content !== "string" ||
        input.content.length > MAX_CONTENT_LENGTH ||
        !Array.isArray(input.attachments) ||
        input.attachments.length > 32 ||
        input.attachments.some((id) => typeof id !== "string")
      ) {
        throw new Error("INVALID_MESSAGE");
      }
      const binding = await bindingFor(scope, input.threadId);
      if (binding.backend !== "intelligence")
        throw new Error("MASTRA_BACKEND_NOT_ACTIVE");
      const store = await storage.getStore(scope, binding);
      const memory = await store.getStore("memory");
      if (!memory) throw new Error("MASTRA_MEMORY_STORAGE_UNAVAILABLE");
      const normalized = input.content.normalize("NFC").replace(/\r\n?/g, "\n");
      if (!normalized.trim() && input.attachments.length === 0)
        throw new Error("INVALID_MESSAGE");
      const messageDigest = digest(normalized, input.attachments);
      const messageId = createHash("sha256")
        .update(
          `${binding.tenantId}\0${binding.threadId}\0${input.clientMessageKey}`,
        )
        .digest("hex");
      return storage.withConversationLock(scope, binding, async () => {
        const prior = await memory.listMessages({
          threadId: binding.threadId,
          resourceId: binding.resourceId,
          perPage: false,
        });
        const existing = prior.messages.find(
          (message) => message.id === messageId,
        );
        if (existing) {
          if (existing.content.metadata?.openbotDigest !== messageDigest)
            throw Object.assign(
              new Error("Message key was already used with different content."),
              {
                code: "message_conflict",
                status: 409,
              },
            );
          return messageDTO(existing);
        }
        const now = new Date();
        const thread = await memory.getThreadById({
          threadId: binding.threadId,
          resourceId: binding.resourceId,
        });
        if (!thread) {
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
        const seq = prior.messages.length + 1;
        const saved = await memory.saveMessages({
          messages: [
            {
              id: messageId,
              threadId: binding.threadId,
              resourceId: binding.resourceId,
              role: "user",
              type: "text",
              createdAt: now,
              content: {
                format: 2,
                parts: normalized ? [{ type: "text", text: normalized }] : [],
                metadata: {
                  openbotSeq: seq,
                  openbotDigest: messageDigest,
                  openbotClientMessageKey: input.clientMessageKey,
                  openbotAttachments: [...input.attachments],
                },
              },
            },
          ],
        });
        const result = saved.messages[0];
        if (!result) throw new Error("MASTRA_MESSAGE_WRITE_FAILED");
        return messageDTO(result);
      });
    },

    async history(scope, input) {
      assertTrustedScope(scope);
      if (
        input.beforeSeq !== null &&
        (!Number.isSafeInteger(input.beforeSeq) || input.beforeSeq < 1)
      )
        throw new Error("INVALID_CURSOR");
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100
      )
        throw new Error("INVALID_LIMIT");
      const binding = await bindingFor(scope, input.threadId);
      return readMastraHistory(storage, scope, binding, input);
    },
  };
}
