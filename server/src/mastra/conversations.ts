import type { MastraDBMessage } from "@mastra/core/agent";
import type {
  ConversationService,
  HistoryInput,
  MessageDTO,
  MessagePage,
  PlatformScope,
} from "../enterprise/contracts";
import { assertTrustedScope } from "../enterprise/tenancy/store";
import type { MastraConversationBinding } from "./contracts";
import {
  type OpenBotAnswerBasisPointer,
  parseStoredFullMessage,
} from "./message-parts";
import type { TenantMastraStorage } from "./tenant-storage";

type BoundConversationService = Pick<
  ConversationService,
  "resolveMastraBinding"
> & {
  resolveMastraBinding(
    scope: PlatformScope,
    threadId: string,
  ): Promise<MastraConversationBinding>;
};

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
  /*
   * FIX-OCR3 (O3-H1): the answer-basis projection, read from the row's own stored
   * envelope. Emitted only for rows that carry one, keyed by the ENGINE message id — the
   * id the platform's thread history also answers by, so a browser restoring a transcript
   * can match its rows without knowing this store's row ids. Tolerant here on purpose:
   * this is the display projection, and a row whose envelope cannot be proven shows no
   * basis (the strict corruption answer belongs to the rebuild path, not a status read).
   */
  const basisProjection = basisOfStoredMetadata(metadata);
  return {
    messageId: message.id,
    threadId: message.threadId ?? "",
    seq: typeof seq === "number" ? seq : 0,
    role: message.role === "user" ? "user" : "assistant",
    content,
    attachments,
    createdAt: message.createdAt.toISOString(),
    ...(basisProjection !== undefined
      ? {
          engineMessageId: basisProjection.engineMessageId,
          basis: basisProjection.basis,
        }
      : {}),
  };
}

/** The engine id and basis pointers one stored row's envelope carries, or nothing. */
function basisOfStoredMetadata(metadata: Record<string, unknown>):
  | {
      engineMessageId: string;
      basis: readonly OpenBotAnswerBasisPointer[];
    }
  | undefined {
  if (metadata.openbotParts === undefined) return undefined;
  try {
    const full = parseStoredFullMessage(metadata.openbotParts);
    if (full.answerBasis === undefined) return undefined;
    const engineMessageId =
      full.engineMessageId ??
      (typeof metadata.openbotEngineMessageId === "string"
        ? metadata.openbotEngineMessageId
        : undefined);
    if (engineMessageId === undefined) return undefined;
    return { engineMessageId, basis: full.answerBasis };
  } catch {
    return undefined;
  }
}

export interface MastraConversationRepository {
  resolve(
    scope: PlatformScope,
    threadId: string,
  ): Promise<MastraConversationBinding>;
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
