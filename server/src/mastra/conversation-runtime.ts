import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import { attachmentUrl } from "../../../shared/attachments";
import { sanitizeSeededHistory } from "@openbot/toolkit/history-sanitize";
import type {
  ConversationService,
  EngineMessageAppendInput,
  HistoryInput,
  MessageDTO,
  MessagePage,
  PlatformScope,
} from "../enterprise/contracts";
import { assertTrustedScope } from "../enterprise/tenancy/store";
import type { MastraConversationBinding } from "./contracts";
import type { ExecutionBinding } from "./execution-contracts";
import {
  agUiMessageFromStoredRow,
  fullMessageFromAgUi,
  MastraMessagePartsUnsupportedError,
} from "./message-parts";
import type { TenantMastraStorage } from "./tenant-storage";

/*
 * ME03 (#475) T4: the server-rebuilt authorized history and the single-writer
 * persistence of one execution's full output.
 *
 * `loadExecutionInput` replaces the client-supplied history with the SAME
 * authorized, finalized, stable-seq history the conversation service serves
 * to the client: the bot reads exactly what a refresh or a page read shows.
 * Client-supplied system/tool history is never authoritative — it is dropped,
 * not merged — and a corrupt or missing row fails the turn explicitly instead
 * of degrading into an empty-history run.
 *
 * `persistExecutionMessages` records the engine's output through the
 * ConversationService single-writer seam — the SAME append/intent/seq
 * machinery the runner uses for the submitted user message before the run
 * (`deps.conversations.append`), with assistant/tool output appended through
 * `appendEngineMessage` after settle. One server-issued idempotency key per
 * engine message (`executionKey:engineMessageId`), so an output retry
 * resolves to the same message intent and appends nothing. Mastra Memory
 * auto-append stays OFF (ME01 evidence) — these memory rows are written BY
 * ConversationService, and every visible message went through exactly one
 * intent.
 */

/** The narrow ConversationService surface the runtime consumes. */
export type MastraWriterConversationService = ConversationService & {
  appendEngineMessage(
    scope: PlatformScope,
    input: EngineMessageAppendInput,
  ): Promise<MessageDTO>;
};

export interface MastraConversationRuntimeDeps {
  /** The ONLY writer for a conversation (single-writer contract, AC3). */
  readonly conversations: MastraWriterConversationService;
  readonly storage: TenantMastraStorage;
  /**
   * Attachment authorization WITHOUT bytes. The production wiring wraps
   * `authorizeAttachmentForSendInTransaction` in one data transaction; the
   * byte-reading loader stays OUT of this runtime entirely, so no reference
   * can reach a model context (or a byte read) before this check passed.
   */
  readonly authorizeAttachment: (
    turn: { actorId: string; threadId: string },
    attachmentId: string,
  ) => Promise<boolean>;
}

/** Hard ceiling on the history one model context may carry. */
const MAX_HISTORY_MESSAGES = 5_000;
const PAGE_SIZE = 100;

/** Attachment scope checked before bytes: the structural denial error. */
export class MastraAttachmentForbiddenError extends Error {
  constructor(attachmentIds: readonly string[]) {
    super(`ATTACHMENT_FORBIDDEN: ${attachmentIds.join(", ")}`);
  }
}

/** The submitted user message is not the newest server-history row. */
export class MastraHistoryMissingSubmittedMessageError extends Error {
  constructor() {
    super("MASTRA_HISTORY_MISSING_SUBMITTED_MESSAGE");
  }
}

/** One verified history row: ledger identity plus its rebuilt full message. */
interface RebuiltRow {
  readonly id: string;
  readonly seq: number;
  readonly rebuilt: ReturnType<typeof agUiMessageFromStoredRow>;
}

/**
 * Read the authorized, finalized history pages (the SAME paginated,
 * principal-authorized read the client refresh uses) and rebuild each row's
 * full AG-UI message, verifying every memory row against the intent-ledger
 * identity. Storage/ledger disagreement is an explicit failure — never an
 * empty page.
 */
async function loadAuthorizedRows(
  deps: MastraConversationRuntimeDeps,
  scope: PlatformScope,
  binding: MastraConversationBinding,
  threadId: string,
): Promise<RebuiltRow[]> {
  const rows: RebuiltRow[] = [];
  let beforeSeq: number | null = null;
  for (;;) {
    const input: HistoryInput = { threadId, beforeSeq, limit: PAGE_SIZE };
    const result: MessagePage = await deps.conversations.history(scope, input);
    if (result.items.length > 0) {
      const memoryRows = await loadMemoryRows(
        deps,
        scope,
        binding,
        result.items,
      );
      for (const item of result.items) {
        const row = memoryRows.get(item.messageId);
        if (!row) {
          // A finalized ledger entry whose storage row is gone is corrupt
          // history: fail, never fall back.
          throw new Error("MASTRA_MESSAGE_INTENT_MISMATCH");
        }
        rows.push(row);
      }
      // The cap is judged immediately after each page lands, not before the
      // next read: the ledger page that crosses the ceiling fails the turn
      // without first paying for another round trip. (A newest-N window that
      // truncates instead of refusing is a product change, deliberately not
      // taken in this fix wave.)
      if (rows.length > MAX_HISTORY_MESSAGES) {
        throw new Error("MASTRA_HISTORY_TOO_LONG");
      }
    }
    if (result.nextBeforeSeq === null) break;
    beforeSeq = result.nextBeforeSeq;
  }
  // history() serves each page newest-first (seq desc) and flips it within
  // the page, walking OLDER with nextBeforeSeq — so plain concatenation is
  // block-disordered ("newest block first, ascending inside it"). Restore the
  // timeline with one global ascending sort; every downstream consumer
  // (newest-user-row matching, attachment authorization, the model context
  // itself) assumes chronological order.
  rows.sort((a, b) => a.seq - b.seq);
  return rows;
}

async function loadMemoryRows(
  deps: MastraConversationRuntimeDeps,
  scope: PlatformScope,
  binding: MastraConversationBinding,
  items: readonly MessageDTO[],
): Promise<Map<string, RebuiltRow>> {
  const byId = new Map<string, RebuiltRow>();
  if (binding.backend === "platform") {
    // The legacy platform backend keeps text + attachment ids only; its DTO
    // IS the full fidelity that backend ever had.
    for (const item of items) {
      byId.set(item.messageId, {
        id: item.messageId,
        seq: item.seq,
        rebuilt: agUiMessageFromStoredRow({
          id: item.messageId,
          role: item.role,
          content: {
            parts: item.content ? [{ type: "text", text: item.content }] : [],
            metadata: { openbotAttachments: [...item.attachments] },
          },
        }),
      });
    }
    return byId;
  }
  const store = await deps.storage.getStore(scope, binding);
  const memory = await store.getStore("memory");
  if (!memory) throw new Error("MASTRA_MEMORY_STORAGE_UNAVAILABLE");
  const loaded = await memory.listMessagesById({
    messageIds: items.map((item) => item.messageId),
  });
  const stored = new Map(
    loaded.messages.map((message) => [message.id, message]),
  );
  for (const item of items) {
    const row = stored.get(item.messageId);
    if (
      !row ||
      row.threadId !== binding.threadId ||
      row.resourceId !== binding.resourceId
    ) {
      throw new Error("MASTRA_MESSAGE_INTENT_MISMATCH");
    }
    const metadata = row.content.metadata ?? {};
    if (metadata.openbotSeq !== undefined && metadata.openbotSeq !== item.seq) {
      throw new Error("MASTRA_MESSAGE_INTENT_MISMATCH");
    }
    byId.set(row.id, {
      id: row.id,
      seq: item.seq,
      rebuilt: agUiMessageFromStoredRow({
        id: row.id,
        role: row.role,
        content: {
          parts: row.content.parts,
          metadata: metadata ?? null,
        },
      }),
    });
  }
  return byId;
}

function attachmentIdsOfMessage(message: Message): readonly string[] {
  const metadata = (message as { metadata?: Record<string, unknown> }).metadata;
  const ids = metadata?.openbotAttachments;
  if (Array.isArray(ids))
    return ids.filter((id): id is string => typeof id === "string");
  return [];
}

/**
 * Check every attachment reference in the rebuilt history BEFORE any bytes
 * could be read. The message being asked about (the last user message)
 * refuses the turn on an unauthorized reference; older history degrades to a
 * text note so one vanished row cannot permanently fail every future turn —
 * the same geometry as `inlineAttachments`.
 */
async function authorizeHistoryAttachments(
  deps: MastraConversationRuntimeDeps,
  scope: PlatformScope,
  threadId: string,
  rows: readonly RebuiltRow[],
): Promise<Message[]> {
  const lastUserIndex = rows.reduce(
    (latest, row, index) =>
      (row.rebuilt.message as { role?: string }).role === "user"
        ? index
        : latest,
    -1,
  );
  const messages: Message[] = [];
  for (const [index, row] of rows.entries()) {
    const message = row.rebuilt.message;
    messages.push(message);
    if ((message as { role?: string }).role !== "user") continue;
    const attachments = [
      ...row.rebuilt.attachments,
      ...attachmentIdsOfMessage(message),
    ];
    if (attachments.length === 0) continue;
    const unauthorized: string[] = [];
    for (const attachmentId of new Set(attachments)) {
      if (
        !(await deps.authorizeAttachment(
          { actorId: scope.actorId, threadId },
          attachmentId,
        ))
      ) {
        unauthorized.push(attachmentId);
      }
    }
    if (unauthorized.length === 0) continue;
    if (index === lastUserIndex) {
      // The message this turn is about: refuse before anything runs —
      // never let a model answer about a file it cannot see.
      throw new MastraAttachmentForbiddenError(unauthorized);
    }
    // Older history degrades instead of failing: strip the unauthorized file
    // parts and say so in text.
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const kept = (content as Record<string, unknown>[]).filter((part) => {
        const source =
          part && typeof part === "object"
            ? (part as { source?: unknown }).source
            : undefined;
        const value =
          source && typeof source === "object"
            ? (source as { value?: unknown }).value
            : undefined;
        return !(
          typeof value === "string" &&
          // Exact compare against the canonical URL, the same shape
          // `attachmentIdFor` extracts with: a suffix match would strip an
          // AUTHORIZED attachment whose id merely ends with an unauthorized
          // one (unauthorized "23" vs authorized "9123").
          unauthorized.some(
            (attachmentId) => value === attachmentUrl(attachmentId),
          )
        );
      });
      kept.push({
        type: "text",
        text: `[attachment unavailable: ${unauthorized.join(", ")}]`,
      });
      messages[messages.length - 1] = {
        ...message,
        content: kept,
      } as Message;
    }
  }
  return messages;
}

function submittedKeyOf(row: RebuiltRow): string | undefined {
  const message = row.rebuilt.message as {
    metadata?: Record<string, unknown>;
  };
  const key = message.metadata?.openbotClientMessageKey;
  return typeof key === "string" ? key : undefined;
}

/**
 * Rebuild the execution input from the server's authorized history.
 *
 * The client-supplied `messages` are consumed for exactly one fact — the id
 * (client message key) of the user message this turn answers — and then
 * dropped wholesale: system and tool history from the wire is never
 * authoritative (ME03 AC6). The runner appends the submitted message through
 * ConversationService BEFORE the run, so it must be the newest USER row of
 * the server history; repaired engine rows may legitimately sit after it, so
 * only the newest user row is compared. Any disagreement — a submitted key
 * the server never recorded, or a forged one — fails the turn instead of
 * running on an improvised transcript.
 */
export async function loadExecutionInput(
  deps: MastraConversationRuntimeDeps,
  scope: PlatformScope,
  input: RunAgentInput,
): Promise<RunAgentInput> {
  assertTrustedScope(scope);
  const threadId = input.threadId;
  if (typeof threadId !== "string" || !threadId.trim()) {
    throw new Error("MASTRA_HISTORY_THREAD_REQUIRED");
  }
  const binding: MastraConversationBinding =
    await deps.conversations.resolveMastraBinding(scope, threadId);
  if (binding.tenantId !== scope.tenantId || binding.threadId !== threadId) {
    // Another principal's thread resolves to nothing here: same denial shape
    // as every other foreign-resource read.
    throw new Error("CONVERSATION_NOT_FOUND");
  }
  if (binding.backend !== "mastra") {
    // The engine path is only defined for the mastra backend: platform (and
    // untagged intelligence) rows carry no openbotClientMessageKey, so the
    // submitted-message check could only fail with a misleading
    // MASTRA_HISTORY_MISSING_SUBMITTED_MESSAGE — and appendEngineMessage
    // would refuse with CONVERSATION_BACKEND_CHANGED only AFTER the model
    // had already burned the budget. Name the real reason, before anything
    // runs.
    throw new Error("MASTRA_ENGINE_BACKEND_UNSUPPORTED");
  }
  const rows = await loadAuthorizedRows(deps, scope, binding, threadId);

  const submitted = (input.messages ?? []).at(-1) as
    | { id?: unknown; role?: unknown }
    | undefined;
  if (
    !submitted ||
    typeof submitted.id !== "string" ||
    submitted.role !== "user"
  ) {
    throw new Error("MASTRA_HISTORY_SUBMITTED_MESSAGE_REQUIRED");
  }
  let newestUserRow: RebuiltRow | undefined;
  for (const row of rows) {
    if ((row.rebuilt.message as { role?: string }).role === "user") {
      newestUserRow = row;
    }
  }
  if (!newestUserRow || submittedKeyOf(newestUserRow) !== submitted.id) {
    throw new MastraHistoryMissingSubmittedMessageError();
  }

  let messages = await authorizeHistoryAttachments(deps, scope, threadId, rows);
  // Activity rows are display/bookkeeping, not model context (the rebuild
  // marks them "the caller filters them"): toModelMessages refuses any role
  // outside user/assistant/system/tool, so one stored activity row would
  // otherwise poison EVERY future turn of the thread with a misleading
  // ME03_MESSAGE_PARTS_UNSUPPORTED.
  messages = messages.filter(
    (message) => (message as { role?: string }).role !== "activity",
  );
  // The established cleanup rules survive the server rebuild: a dangling
  // tool call in stored history must never poison the model call.
  messages = sanitizeSeededHistory(messages);
  return { ...input, messages };
}

/**
 * Transient `appendEngineMessage` failures worth a bounded same-key retry.
 * The service settles finalize races itself (readFinalizedMessage) and
 * answers genuinely-unwritable writes with `message_pending` (503) whose text
 * says to retry the SAME key — the key is what makes the retry idempotent.
 */
function isRetryableAppendFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const status = (error as { status?: unknown } | null)?.status;
  return code === "message_pending" || status === 503;
}

/** Bounded: a caller stuck permanently pending stops after a few tries. */
const APPEND_RETRY_LIMIT = 3;

/**
 * The server-issued idempotency key for one engine output message: the
 * execution's key (a `randomUUID()` value, 36 chars) plus the engine message
 * id, colon-separated. This is THE composition site — the key cap the
 * ConversationService asserts (200) belongs to `clientMessageKey`, so the
 * engine id's share of that budget is derived here and consumed by both
 * sides instead of drifting as a bare literal.
 */
export function engineAppendClientMessageKey(
  executionKey: string,
  engineMessageId: string,
): string {
  return `${executionKey}:${engineMessageId}`;
}

/**
 * The string form of `randomUUID()` (RFC 4122 with hyphens) is always 36
 * chars — a named constant instead of deriving it with a module-load-time
 * `randomUUID()` call, which was an import-time side effect for a value that
 * can never change (R4-4).
 */
const UUID_STRING_LENGTH = 36;
/**
 * The `clientMessageKey` cap ConversationService asserts. Exported so the
 * service's validation consumes this constant instead of a second bare 200 —
 * the two ends of the composed key cannot drift apart (R4-4).
 */
export const MAX_CLIENT_MESSAGE_KEY_LENGTH = 200;
/**
 * Longest `engineMessageId` that still fits the composed
 * {@link engineAppendClientMessageKey} under the service's
 * {@link MAX_CLIENT_MESSAGE_KEY_LENGTH} cap: the cap minus the execution key
 * (36-char UUID) and its separator. Derived at the composition site so a
 * change to either the key format or the cap moves this bound with it; the
 * ConversationService engine-append validation consumes the same constant.
 */
export const MAX_ENGINE_MESSAGE_ID_LENGTH =
  MAX_CLIENT_MESSAGE_KEY_LENGTH - (UUID_STRING_LENGTH + 1);

async function appendEngineMessageWithRetry(
  deps: MastraConversationRuntimeDeps,
  scope: PlatformScope,
  input: EngineMessageAppendInput,
): Promise<MessageDTO> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= APPEND_RETRY_LIMIT; attempt += 1) {
    try {
      return await deps.conversations.appendEngineMessage(scope, input);
    } catch (error) {
      lastError = error;
      if (!isRetryableAppendFailure(error)) throw error;
      // A short backoff: the contended window (a concurrent same-key writer
      // inside the conversation lock) clears in milliseconds.
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * Persist one execution's output messages through the single-writer seam.
 *
 * Every engine message id maps to a stable OpenBot message identity derived
 * from the server-issued key `executionKey:engineMessageId`; the mapping and
 * the full parts land in the stored row's metadata. Idempotent under retry:
 * the same key + identical parts resolve to the same intent and message.
 */
export async function persistExecutionMessages(
  deps: MastraConversationRuntimeDeps,
  binding: ExecutionBinding,
  messages: readonly Message[],
): Promise<void> {
  assertTrustedScope(binding.scope);
  if (typeof binding.threadId !== "string" || !binding.threadId.trim()) {
    throw new Error("MASTRA_BINDING_THREAD_REQUIRED");
  }
  for (const message of messages) {
    const { full } = fullMessageFromAgUi(message);
    if (full.role === "user") {
      // The runner already appended the submitted user message through
      // ConversationService BEFORE the run; an engine batch claiming a user
      // row would double-write it.
      throw new MastraMessagePartsUnsupportedError(
        "MASTRA_PERSIST_USER_ROLE_UNSUPPORTED",
      );
    }
    if (full.parts.length === 0) continue;
    // fullMessageFromAgUi refuses a missing/empty id at the entry
    // (MASTRA_PERSIST_MESSAGE_ID_REQUIRED), so this is a contract
    // re-assertion, not a fallback: a regression here must fail loudly, not
    // mint a malformed `executionKey:` idempotency key.
    const { engineMessageId } = full;
    if (typeof engineMessageId !== "string" || engineMessageId.length === 0) {
      throw new MastraMessagePartsUnsupportedError(
        "MASTRA_PERSIST_MESSAGE_ID_REQUIRED",
      );
    }
    const clientMessageKey = engineAppendClientMessageKey(
      binding.executionKey,
      engineMessageId,
    );
    await appendEngineMessageWithRetry(deps, binding.scope, {
      threadId: binding.threadId,
      clientMessageKey,
      role: full.role === "tool" ? "tool" : "assistant",
      parts: full.parts,
      engineMessageId,
      ...(full.toolCallId !== undefined ? { toolCallId: full.toolCallId } : {}),
    });
  }
}

/**
 * The canonical AG-UI events one execution produced, folded back into the
 * AG-UI messages {@link persistExecutionMessages} stores.
 *
 * ME03 fix-round-1 (production wiring): the engine's answer must reach the
 * conversation store BEFORE the run can complete, so the factory-side wrapper
 * buffers this collector's snapshot at the success terminal and persists it
 * first. The fold is the AG-UI protocol itself — TEXT_MESSAGE and TOOL_CALL
 * frames reassembled by id — so what is persisted is exactly what a client
 * reconstructing state from the same event stream would show.
 */
export function createProducedMessageCollector(): {
  push(event: BaseEvent): void;
  snapshot(): Message[];
} {
  interface Produced {
    message: {
      id: string;
      role: "assistant";
      content: string;
      toolCalls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    };
  }
  const produced = new Map<string, Produced>();
  /**
   * ONE ordered entry list: assistant messages enter at their first frame and
   * tool results enter at their arrival position — right after the assistant
   * turn that hosts their call. Buffering results separately and appending
   * them at the end would persist A1,A2,R1,R2 for a real A1,R1,A2,R2
   * interleaving, and the next turn's rebuild would pair calls against a
   * sequence that never happened.
   */
  const orderedEntries: { message: Message }[] = [];
  const toolResultIds = new Set<string>();
  let lastAssistant: Produced | null = null;
  /**
   * R4-2: whether the last thing the model saw was a tool RESULT. A call
   * arriving after a result is a later causal round even when the model
   * produced no text in between — it must open its own host instead of being
   * folded into the previous (already closed) assistant turn as a concurrent
   * sibling of the call that round answered.
   */
  let lastResultLanded = false;
  const assistantFor = (id: string): Produced => {
    const existing = produced.get(id);
    if (existing) {
      lastAssistant = existing;
      return existing;
    }
    const created: Produced = {
      message: { id, role: "assistant", content: "" },
    };
    produced.set(id, created);
    orderedEntries.push({ message: created.message as Message });
    lastAssistant = created;
    return created;
  };
  /**
   * R4-3: TOOL_CALL_START registers the call here once; every TOOL_CALL_ARGS
   * delta is an O(1) lookup instead of a full orderedEntries scan (args
   * stream as deltas, so long argument payloads previously paid the scan per
   * frame).
   */
  const callsById = new Map<
    string,
    { call: { arguments: string }; message: Produced["message"] }
  >();
  return {
    push(event: BaseEvent) {
      const shape = event as unknown as Record<string, unknown>;
      switch (shape.type) {
        case "TEXT_MESSAGE_START": {
          if (typeof shape.messageId === "string") {
            assistantFor(shape.messageId);
            // Fresh text re-anchors the host: the next call belongs to this
            // new turn, not to whatever came before the last result.
            lastResultLanded = false;
          }
          break;
        }
        case "TEXT_MESSAGE_CONTENT": {
          if (
            typeof shape.messageId === "string" &&
            typeof shape.delta === "string"
          ) {
            assistantFor(shape.messageId).message.content += shape.delta;
          }
          break;
        }
        case "TOOL_CALL_START": {
          if (
            typeof shape.toolCallId !== "string" ||
            typeof shape.toolCallName !== "string"
          )
            break;
          // Calls attach to the assistant turn in flight (the last text
          // frame) — unless a tool result already landed, which makes this
          // call a later round that must open its own host (R4-2); with no
          // host in flight at all it opens one itself, so a call is never
          // silently dropped.
          const host =
            lastAssistant !== null && !lastResultLanded
              ? lastAssistant.message
              : assistantFor(`assistant-call-${shape.toolCallId}`).message;
          host.toolCalls = host.toolCalls ?? [];
          if (host.toolCalls.some((call) => call.id === shape.toolCallId))
            break;
          const call = {
            id: shape.toolCallId,
            type: "function" as const,
            function: { name: shape.toolCallName, arguments: "" },
          };
          host.toolCalls.push(call);
          callsById.set(shape.toolCallId, {
            call: call.function,
            message: host,
          });
          break;
        }
        case "TOOL_CALL_ARGS": {
          if (typeof shape.toolCallId !== "string") break;
          const found = callsById.get(shape.toolCallId) ?? null;
          if (found && typeof shape.delta === "string")
            found.call.arguments += shape.delta;
          break;
        }
        case "TOOL_CALL_END":
          break;
        case "TOOL_CALL_RESULT": {
          if (
            typeof shape.toolCallId !== "string" ||
            typeof shape.messageId !== "string"
          )
            break;
          if (toolResultIds.has(shape.messageId)) break;
          toolResultIds.add(shape.messageId);
          lastResultLanded = true;
          // Enters the ONE ordered sequence at its arrival position: right
          // after the assistant turn hosting the call, ahead of anything the
          // model produced later.
          orderedEntries.push({
            message: {
              id: shape.messageId,
              role: "tool",
              toolCallId: shape.toolCallId,
              content: typeof shape.content === "string" ? shape.content : "",
            } as Message,
          });
          break;
        }
        default:
          // RUN_*/STATE_* and every other control frame carry no message part.
          break;
      }
    },
    snapshot(): Message[] {
      // R4-5: structurally isolate the snapshot from the collector's later
      // state — a late push after the snapshot (a post-terminal frame) or an
      // in-place mutation by the caller must not contaminate what the factory
      // already buffered/persisted. Message volume per run is small, so the
      // clone cost is negligible next to the append it protects.
      return orderedEntries.map((entry) =>
        structuredClone(entry.message),
      ) as Message[];
    },
  };
}

export function createMastraConversationRuntime(
  deps: MastraConversationRuntimeDeps,
): {
  loadExecutionInput(
    scope: PlatformScope,
    input: RunAgentInput,
  ): Promise<RunAgentInput>;
  persistExecutionMessages(
    binding: ExecutionBinding,
    messages: readonly Message[],
  ): Promise<void>;
} {
  return {
    loadExecutionInput: (scope, input) =>
      loadExecutionInput(deps, scope, input),
    persistExecutionMessages: (binding, messages) =>
      persistExecutionMessages(deps, binding, messages),
  };
}

/** The server-side conversation runtime the mastra engine path consumes. */
export type MastraConversationRuntime = ReturnType<
  typeof createMastraConversationRuntime
>;
