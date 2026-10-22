import { createHash } from "node:crypto";
import { attachmentIdsIn } from "../channels/attachment-parts";
import { messageDigest } from "../enterprise/conversations/store";
import {
  MAX_CLIENT_MESSAGE_KEY_LENGTH,
  MAX_ENGINE_MESSAGE_ID_LENGTH,
} from "./conversation-runtime";
import {
  fullMessageFromAgUi,
  MastraMessagePartsCorruptError,
  MastraMessagePartsUnsupportedError,
  type OpenBotMessagePart,
  parseStoredFullMessage,
} from "./message-parts";

/*
 * ME13 (#485): inventory and idempotently import legacy Intelligence
 * conversations and their complete messages into the OpenBot conversation
 * store.
 *
 * SOURCE IS READ-ONLY. The `LegacyImportSource` seam exposes exactly the two
 * documented Intelligence READ methods (cursor-paginated `listThreads`, and
 * the per-thread whole-history `getThreadMessages`); no write method exists
 * on the seam, so an import run cannot mutate the source even by accident.
 * Ownership evidence comes from OpenBot's own `enterprise_conversations`
 * rows (threadId + scope columns); a thread with no unique row mapping is
 * QUARANTINED — never guessed into a default tenant or principal.
 *
 * Target writes go ONLY through the ConversationService controlled append
 * seams (the same single-writer intent machinery the live runner uses):
 * imported user rows via `append`, imported assistant/tool/activity rows via
 * `appendEngineMessage`. Every imported row carries a STABLE source identity
 * (`legacy:<sourceMessageId>` as the clientMessageKey), so re-importing the
 * same data resolves to the same intent and message and never duplicates.
 * This file never opens a second writer.
 *
 * The per-thread message read of the documented Intelligence API is
 * UNPAGINATED (one whole-history response), and the source carries
 * NO per-message timestamps — only thread-level createdAt/lastRunAt/
 * updatedAt. Both facts are recorded in every manifest
 * (sourceCapabilityNotes) instead of being papered over: unread pages are
 * never reported as no data, and time fidelity is stated at the fidelity
 * the source actually offers.
 */

export type PlatformScopeLike = import("../enterprise/contracts").PlatformScope;

/** The documented Intelligence thread summary (read shape). */
export interface IntelligenceThreadSummary {
  id: string;
  name?: string | null;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string;
  archived?: boolean;
  agentId?: string;
  createdById?: string;
  organizationId?: string;
}

/** The documented Intelligence message (read shape). */
export interface IntelligenceThreadMessage {
  id: string;
  role: string;
  content?: unknown;
  activityType?: string;
  toolCalls?: readonly { id: string; name: string; args: string }[];
  toolCallId?: string;
}

/**
 * The read-only source seam. Deliberately NOT the Intelligence client: only
 * the two reads an import may perform exist here, so the type system itself
 * carries the AC6 guarantee (no DML/DDL surface to reach for).
 */
export interface LegacyImportSource {
  listThreads(params: {
    userId: string;
    agentId: string;
    includeArchived?: boolean;
    limit?: number;
    cursor?: string | null;
  }): Promise<{
    threads: readonly IntelligenceThreadSummary[];
    nextCursor: string | null;
  }>;
  getThreadMessages(params: {
    threadId: string;
    userId: string;
  }): Promise<{ messages: readonly IntelligenceThreadMessage[] }>;
}

/** One `enterprise_conversations` ownership-evidence row (no content). */
export interface OwnershipRow {
  tenantId: string;
  workspaceId: string;
  principalId: string;
  conversationId: string;
  storageBackend: "platform" | "intelligence" | "mastra";
}

/** OpenBot-side read ports the import planning consumes. All reads. */
export interface LegacyOwnershipPorts {
  /** EVERY conversation row evidencing this threadId, across tenants. */
  conversationRowsForThread(threadId: string): Promise<readonly OwnershipRow[]>;
  actorIdForPrincipal(
    tenantId: string,
    principalId: string,
  ): Promise<string | null>;
  /** The production trusted-scope resolution (membership checked, never assumed). */
  resolveScope(input: {
    actorId: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<PlatformScopeLike>;
  /**
   * Finalized intents NOT carrying the import identity prefix — live-writer
   * rows. Re-importing OUR OWN prior output converges idempotently; a
   * foreign (live) row in the staging target would land BEFORE the imported
   * legacy history in seq order and is refused instead.
   */
  foreignFinalizedIntentCount(
    tenantId: string,
    threadId: string,
  ): Promise<number>;
  finalizedKeyExists(
    tenantId: string,
    threadId: string,
    clientMessageKey: string,
  ): Promise<boolean>;
  existingAttachmentIds(ids: readonly string[]): Promise<Set<string>>;
}

/**
 * The controlled target write surface: exactly the two ConversationService
 * seams, nothing else. The production wiring wraps the live service; tests
 * substitute recorders. There is no third method because there is no second
 * writer.
 */
export interface LegacyImportWriter {
  appendImportedUser(input: {
    scope: PlatformScopeLike;
    threadId: string;
    clientMessageKey: string;
    content: string;
    attachments: readonly string[];
  }): Promise<void>;
  appendImportedEngine(input: {
    scope: PlatformScopeLike;
    threadId: string;
    clientMessageKey: string;
    role: "assistant" | "tool";
    parts: readonly OpenBotMessagePart[];
    engineMessageId: string;
    toolCallId?: string;
  }): Promise<void>;
}

/** One finalized target row as the verify pass re-reads it. */
export interface ImportedTargetRow {
  clientMessageKey: string;
  role: string;
  content: { parts?: unknown; metadata?: Record<string, unknown> | null };
}

export interface LegacyTargetReader {
  /** Finalized rows of one thread in client read order (reservedSeq asc). */
  readFinalizedRows(
    scope: PlatformScopeLike,
    threadId: string,
  ): Promise<readonly ImportedTargetRow[]>;
}

/** Persisted run state (cursor + per-thread progress) for resume. */
export interface CutoverRunStore {
  /** null when no state has been persisted yet. */
  load(): Promise<unknown | null>;
  save(state: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------
// Stable source identity
// ---------------------------------------------------------------------------

export const LEGACY_IMPORT_KEY_PREFIX = "legacy:";
/** ConversationService asserts clientMessageKey at 200 (the shared constant). */
const CLIENT_MESSAGE_KEY_CAP = MAX_CLIENT_MESSAGE_KEY_LENGTH;
const PREFIX_LENGTH = LEGACY_IMPORT_KEY_PREFIX.length;

export function legacyImportClientMessageKey(sourceId: string): string {
  return `${LEGACY_IMPORT_KEY_PREFIX}${sourceId}`;
}

export function legacyImportSourceIdFromKey(
  clientMessageKey: string,
): string | null {
  if (!clientMessageKey.startsWith(LEGACY_IMPORT_KEY_PREFIX)) return null;
  return clientMessageKey.slice(PREFIX_LENGTH);
}

// ---------------------------------------------------------------------------
// Quarantine reasons
// ---------------------------------------------------------------------------

export type ImportSkipReason =
  | "owner_missing"
  | "owner_ambiguous"
  | "owner_unauthorized"
  | "backend_not_staging"
  | "target_not_empty"
  | "source_thread_missing"
  | "source_read_failed"
  | "source_id_missing"
  | "source_id_too_long"
  | "empty_message"
  | "unsupported_shape"
  | "unsupported_role"
  | "attachment_missing"
  | "attachment_unauthorized"
  | "duplicate_source_id";

// ---------------------------------------------------------------------------
// Canonical per-message form + fingerprints (the verify contract)
// ---------------------------------------------------------------------------

/**
 * The sanitized canonical form ONE message's importable content. Both sides
 * of verify derive it — the source from the Intelligence read, the target
 * from the stored row — so a digest comparison is a real comparison of what
 * was preserved (text, attachment ids, tool pairs, order), never a
 * restatement of one side. Message content itself never enters a manifest:
 * only these fingerprints do.
 */
export type CanonicalMessage =
  | { role: "user"; text: string; attachments: readonly string[] }
  | {
      role: "assistant";
      text: string;
      toolCalls: readonly {
        toolCallId: string;
        toolName: string;
        args: string;
      }[];
    }
  | { role: "tool"; text: string; toolCallId: string; isError: boolean }
  | { role: "activity"; activityType: string; payload: unknown };

/** Canonical JSON: keys sorted recursively, arrays in order (message-parts rule). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function canonicalMessageFingerprint(message: CanonicalMessage): string {
  return createHash("sha256").update(canonicalJson(message)).digest("hex");
}

export function threadDigest(fingerprints: readonly string[]): string {
  return createHash("sha256").update(canonicalJson(fingerprints)).digest("hex");
}

function textOfDisplayParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  let text = "";
  for (const part of parts) {
    const candidate = (part as { text?: unknown } | null)?.text;
    if (typeof candidate === "string") text += candidate;
  }
  return text;
}

/**
 * Derive the canonical form from a STORED target row — the mirror of the
 * source-side planning. A user row (written by `append`) carries display
 * text plus stamped attachment ids; an assistant/tool row (written by
 * `appendEngineMessage`) carries the versioned `openbotParts` envelope. An
 * all-activity assistant envelope is the stored asymmetry for activity
 * messages (ME03): it derives the activity canonical form. An envelope that
 * fails to parse is corrupt: throw, never improvise — verify turns that
 * into a block.
 */
export function canonicalFromTargetRow(
  row: ImportedTargetRow,
): CanonicalMessage {
  const metadata = row.content?.metadata ?? {};
  const stored = metadata.openbotParts;
  if (row.role === "user") {
    const attachments = Array.isArray(metadata.openbotAttachments)
      ? (metadata.openbotAttachments as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    return {
      role: "user",
      text: textOfDisplayParts(row.content?.parts),
      attachments,
    };
  }
  if (stored === undefined || stored === null) {
    // A legacy assistant row written before the versioned envelope existed:
    // the display text is the whole fidelity that row ever had.
    return {
      role: "assistant",
      text: textOfDisplayParts(row.content?.parts),
      toolCalls: [],
    };
  }
  const full = parseStoredFullMessage(stored);
  // The ENVELOPE carries the conversational truth: a tool result is stored
  // as an assistant memory row (the ME03 asymmetry), so the branch keys on
  // the envelope role, never the memory row role.
  if (full.role === "tool") {
    const result = full.parts.find((part) => part.kind === "tool-result");
    if (result?.kind !== "tool-result") {
      throw new MastraMessagePartsCorruptError(
        "tool row carries no tool-result part",
      );
    }
    return {
      role: "tool",
      text: result.content,
      toolCallId: result.toolCallId,
      isError: result.isError,
    };
  }
  if (
    full.parts.length > 0 &&
    full.parts.every((part) => part.kind === "activity")
  ) {
    const activity = full.parts.find((part) => part.kind === "activity");
    if (activity?.kind !== "activity") {
      throw new MastraMessagePartsCorruptError(
        "activity envelope carries no activity part",
      );
    }
    return {
      role: "activity",
      activityType: activity.activityType,
      payload: activity.payload,
    };
  }
  const text = full.parts
    .map((part) => (part.kind === "text" ? part.text : ""))
    .join("");
  const toolCalls = full.parts
    .filter((part) => part.kind === "tool-call")
    .map((part) =>
      part.kind === "tool-call"
        ? {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.args,
          }
        : { toolCallId: "", toolName: "", args: "" },
    );
  return { role: "assistant", text, toolCalls };
}

// ---------------------------------------------------------------------------
// Message planning (pure conversion + quarantine classification)
// ---------------------------------------------------------------------------

export interface PlannedUser {
  sourceId: string;
  decision: "user";
  clientMessageKey: string;
  content: string;
  attachments: string[];
  canonical: Extract<CanonicalMessage, { role: "user" }>;
}

export interface PlannedEngine {
  sourceId: string;
  decision: "engine";
  clientMessageKey: string;
  role: "assistant" | "tool";
  parts: readonly OpenBotMessagePart[];
  engineMessageId: string;
  toolCallId?: string;
  canonical: CanonicalMessage;
}

export interface PlannedSkip {
  sourceId: string;
  decision: "skip";
  reason: ImportSkipReason;
}

export type PlannedMessage = PlannedUser | PlannedEngine | PlannedSkip;

export interface PlanOutcome {
  planned: readonly PlannedMessage[];
  importable: number;
  skips: readonly { sourceId: string; reason: ImportSkipReason }[];
}

const USER_SOURCE_ID_CAP = CLIENT_MESSAGE_KEY_CAP - PREFIX_LENGTH;
/** Engine rows also carry the source id as engineMessageId (tighter cap). */
const ENGINE_SOURCE_ID_CAP = Math.min(
  USER_SOURCE_ID_CAP,
  MAX_ENGINE_MESSAGE_ID_LENGTH,
);

function agUiToolCalls(message: IntelligenceThreadMessage) {
  return (message.toolCalls ?? []).map((call) => ({
    id: call.id,
    type: "function" as const,
    function: { name: call.name, arguments: call.args },
  }));
}

function assistantCanonicalOf(full: {
  parts: readonly OpenBotMessagePart[];
}): Extract<CanonicalMessage, { role: "assistant" }> {
  const text = full.parts
    .map((part) => (part.kind === "text" ? part.text : ""))
    .join("");
  const toolCalls = full.parts
    .filter((part) => part.kind === "tool-call")
    .map((part) =>
      part.kind === "tool-call"
        ? {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.args,
          }
        : { toolCallId: "", toolName: "", args: "" },
    );
  return { role: "assistant", text, toolCalls };
}

/**
 * Plan one thread's source messages into import actions and skips. Pure:
 * no I/O, no scope, no writes. Order is the source array order (the
 * documented chronological order); tool call/result pairs survive because
 * adjacent rows keep their positions and the toolCallId rides in both
 * envelopes.
 */
export function planThreadMessages(
  messages: readonly IntelligenceThreadMessage[],
  existingAttachmentIds: ReadonlySet<string>,
): PlanOutcome {
  const planned: PlannedMessage[] = [];
  const skips: { sourceId: string; reason: ImportSkipReason }[] = [];
  const seen = new Set<string>();
  const skip = (sourceId: string, reason: ImportSkipReason): PlannedSkip => {
    skips.push({ sourceId, reason });
    return { sourceId, decision: "skip", reason };
  };
  for (const message of messages) {
    if (typeof message.id !== "string" || message.id.length === 0) {
      planned.push(skip("", "source_id_missing"));
      continue;
    }
    if (seen.has(message.id)) {
      planned.push(skip(message.id, "duplicate_source_id"));
      continue;
    }
    seen.add(message.id);
    if (message.role === "user") {
      let converted: ReturnType<typeof fullMessageFromAgUi>;
      try {
        converted = fullMessageFromAgUi({
          id: message.id,
          role: "user",
          content: message.content,
        } as Parameters<typeof fullMessageFromAgUi>[0]);
      } catch (error) {
        planned.push(
          skip(
            message.id,
            error instanceof MastraMessagePartsUnsupportedError &&
              error.message.includes("MESSAGE_ID_REQUIRED")
              ? "source_id_missing"
              : "unsupported_shape",
          ),
        );
        continue;
      }
      // The append path normalizes the display text exactly this way before
      // storing; the canonical form must be computed from the SAME
      // normalized value or verify would compare different texts.
      const normalized = messageDigest(
        converted.content,
        converted.attachments,
      );
      if (
        normalized.content.length === 0 &&
        converted.attachments.length === 0
      ) {
        planned.push(skip(message.id, "empty_message"));
        continue;
      }
      if (message.id.length > USER_SOURCE_ID_CAP) {
        planned.push(skip(message.id, "source_id_too_long"));
        continue;
      }
      const missing = converted.attachments.filter(
        (id) => !existingAttachmentIds.has(id),
      );
      if (missing.length > 0) {
        planned.push(skip(message.id, "attachment_missing"));
        continue;
      }
      planned.push({
        sourceId: message.id,
        decision: "user",
        clientMessageKey: legacyImportClientMessageKey(message.id),
        content: normalized.content,
        attachments: [...converted.attachments],
        canonical: {
          role: "user",
          text: normalized.content,
          attachments: [...converted.attachments],
        },
      });
      continue;
    }
    if (
      message.role === "assistant" ||
      message.role === "tool" ||
      message.role === "activity"
    ) {
      if (message.id.length > ENGINE_SOURCE_ID_CAP) {
        planned.push(skip(message.id, "source_id_too_long"));
        continue;
      }
      if (message.role === "activity") {
        // Activities ride INSIDE an assistant envelope (the ME03 stored
        // asymmetry): the append surface takes role "assistant" with the
        // activity part, and the rebuild restores the activity shape.
        const activityType =
          typeof message.activityType === "string"
            ? message.activityType
            : typeof message.content === "string"
              ? message.content
              : "activity";
        const parts: readonly OpenBotMessagePart[] = [
          { kind: "activity", activityType, payload: message.content },
        ];
        planned.push({
          sourceId: message.id,
          decision: "engine",
          clientMessageKey: legacyImportClientMessageKey(message.id),
          role: "assistant",
          parts,
          engineMessageId: message.id,
          canonical: {
            role: "activity",
            activityType,
            payload: message.content,
          },
        });
        continue;
      }
      let converted: ReturnType<typeof fullMessageFromAgUi>;
      try {
        converted = fullMessageFromAgUi(
          message.role === "assistant"
            ? ({
                id: message.id,
                role: "assistant",
                content: message.content,
                ...(message.toolCalls !== undefined
                  ? { toolCalls: agUiToolCalls(message) }
                  : {}),
              } as Parameters<typeof fullMessageFromAgUi>[0])
            : ({
                id: message.id,
                role: "tool",
                ...(message.toolCallId !== undefined
                  ? { toolCallId: message.toolCallId }
                  : {}),
                content: message.content,
              } as Parameters<typeof fullMessageFromAgUi>[0]),
        );
      } catch {
        planned.push(skip(message.id, "unsupported_shape"));
        continue;
      }
      if (converted.full.parts.length === 0) {
        planned.push(skip(message.id, "empty_message"));
        continue;
      }
      const canonical: CanonicalMessage =
        message.role === "tool"
          ? {
              role: "tool",
              text: converted.content,
              toolCallId: message.toolCallId ?? "",
              isError: false,
            }
          : assistantCanonicalOf(converted.full);
      planned.push({
        sourceId: message.id,
        decision: "engine",
        clientMessageKey: legacyImportClientMessageKey(message.id),
        role: message.role === "tool" ? "tool" : "assistant",
        parts: converted.full.parts,
        engineMessageId: message.id,
        ...(message.role === "tool" && message.toolCallId !== undefined
          ? { toolCallId: message.toolCallId }
          : {}),
        canonical,
      });
      continue;
    }
    planned.push(skip(message.id, "unsupported_role"));
  }
  const importable = planned.filter(
    (entry) => entry.decision !== "skip",
  ).length;
  return { planned, importable, skips };
}

/** The attachment ids a source message batch references (the port's query list). */
export function attachmentIdsInSourceMessages(
  messages: readonly IntelligenceThreadMessage[],
): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const id of attachmentIdsIn(message.content)) ids.add(id);
  }
  return [...ids];
}

function fingerprintsOf(planned: readonly PlannedMessage[]): string[] {
  return planned
    .filter(
      (entry): entry is PlannedUser | PlannedEngine =>
        entry.decision !== "skip",
    )
    .map((entry) => canonicalMessageFingerprint(entry.canonical));
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

export type OwnershipVerdict =
  | { status: "unique"; owner: OwnershipRow }
  | { status: "missing" }
  | { status: "ambiguous" };

/**
 * The thread→scope mapping is whatever OpenBot's own rows prove — exactly
 * one row. Zero rows or several (the schema permits the same threadId in
 * two tenants) are quarantined: no default tenant or principal is ever
 * guessed.
 */
export function uniqueOwnershipRow(
  rows: readonly OwnershipRow[],
): OwnershipVerdict {
  if (rows.length === 0) return { status: "missing" };
  if (rows.length !== 1) return { status: "ambiguous" };
  return { status: "unique", owner: rows[0] as OwnershipRow };
}

export async function resolveImportScope(
  ports: LegacyOwnershipPorts,
  owner: OwnershipRow,
): Promise<
  { status: "ok"; scope: PlatformScopeLike } | { status: "unauthorized" }
> {
  const actorId = await ports.actorIdForPrincipal(
    owner.tenantId,
    owner.principalId,
  );
  if (!actorId) return { status: "unauthorized" };
  let scope: PlatformScopeLike;
  try {
    // The production resolver, not a synthesized object: membership and
    // workspace eligibility are database facts, and the scope must be a
    // trusted (resolver-issued) scope for the write seams to accept it.
    scope = await ports.resolveScope({
      actorId,
      tenantId: owner.tenantId,
      workspaceId: owner.workspaceId,
    });
  } catch {
    return { status: "unauthorized" };
  }
  // A resolver hit for a DIFFERENT principal in the same tenant (two
  // principals, one user id) is not this thread's owner: quarantine.
  if (
    scope.principalId !== owner.principalId ||
    scope.tenantId !== owner.tenantId
  ) {
    return { status: "unauthorized" };
  }
  return { status: "ok", scope };
}

// ---------------------------------------------------------------------------
// Inventory (cursor pagination + duplicate-page dedupe)
// ---------------------------------------------------------------------------

export type ScanDescriptor =
  | { mode: "scan"; userId: string; agentId: string }
  | { mode: "explicit-thread"; threadId: string };

export interface ThreadInventoryEntry {
  threadId: string;
  ownershipStatus: OwnershipVerdict["status"];
  skipReason?: ImportSkipReason;
  owner?: { tenantId: string; workspaceId: string; principalId: string };
  storageBackend?: string;
}

export interface InventoryOutcome {
  entries: readonly ThreadInventoryEntry[];
  /** The summaries the walk saw (thread-level source timestamps). */
  summaries: ReadonlyMap<string, IntelligenceThreadSummary>;
  pagesRead: number;
  /** null = the whole scan is proven read; otherwise the cursor to resume from. */
  cursor: string | null;
}

async function classifyThread(
  ports: LegacyOwnershipPorts,
  threadId: string,
): Promise<ThreadInventoryEntry> {
  const verdict = uniqueOwnershipRow(
    await ports.conversationRowsForThread(threadId),
  );
  if (verdict.status !== "unique") {
    return {
      threadId,
      ownershipStatus: verdict.status,
      skipReason:
        verdict.status === "missing" ? "owner_missing" : "owner_ambiguous",
    };
  }
  const owner = verdict.owner;
  const ownerRef = {
    tenantId: owner.tenantId,
    workspaceId: owner.workspaceId,
    principalId: owner.principalId,
  };
  if (owner.storageBackend !== "mastra") {
    // The staging target must already be a mastra-backend conversation with
    // no live history: flipping a legacy backend is the write fence's
    // (ME14) decision, not the importer's.
    return {
      threadId,
      ownershipStatus: "unique",
      skipReason: "backend_not_staging",
      owner: ownerRef,
      storageBackend: owner.storageBackend,
    };
  }
  const intents = await ports.foreignFinalizedIntentCount(
    owner.tenantId,
    threadId,
  );
  if (intents > 0) {
    // Existing live rows would land AFTER imported legacy rows in seq
    // order — an inverted timeline. Refuse instead of interleaving.
    return {
      threadId,
      ownershipStatus: "unique",
      skipReason: "target_not_empty",
      owner: ownerRef,
      storageBackend: owner.storageBackend,
    };
  }
  return {
    threadId,
    ownershipStatus: "unique",
    owner: ownerRef,
    storageBackend: owner.storageBackend,
  };
}

/**
 * Walk the source thread inventory. Duplicate THREADS (a replayed page) are
 * deduped by id; a cursor that loops (points at an already-read page) is
 * followed ONE extra time to prove the duplicate read, then the walk stops
 * with the cursor recorded as INCOMPLETE — an unproven page is never
 * reported as no data.
 */
export async function inventoryThreads(input: {
  source: LegacyImportSource;
  ports: LegacyOwnershipPorts;
  scan: ScanDescriptor;
  pageSize?: number;
}): Promise<InventoryOutcome> {
  if (input.scan.mode === "explicit-thread") {
    return {
      entries: [await classifyThread(input.ports, input.scan.threadId)],
      summaries: new Map(),
      pagesRead: 0,
      cursor: null,
    };
  }
  const entries = new Map<string, ThreadInventoryEntry>();
  const summaries = new Map<string, IntelligenceThreadSummary>();
  const visited = new Set<string>();
  // Captured OUTSIDE the closure: the early return above narrows the scan
  // variant in this scope, and the closure must not re-widen it.
  const scanUserId = input.scan.userId;
  const scanAgentId = input.scan.agentId;
  let cursor: string | null = "";
  let pagesRead = 0;
  let incomplete: string | null = null;
  const readPage = async (pageCursor: string) => {
    const page = await input.source.listThreads({
      userId: scanUserId,
      agentId: scanAgentId,
      ...(input.pageSize !== undefined ? { limit: input.pageSize } : {}),
      cursor: pageCursor,
    });
    pagesRead += 1;
    for (const thread of page.threads) {
      summaries.set(thread.id, thread);
      if (!entries.has(thread.id)) {
        entries.set(thread.id, await classifyThread(input.ports, thread.id));
      }
    }
    return page.nextCursor ?? null;
  };
  while (cursor !== null) {
    if (visited.has(cursor)) {
      // Loop: re-read the page once (so the duplicate content is actually
      // observed and deduped), then stop and record the unproven tail.
      await readPage(cursor);
      incomplete = cursor;
      break;
    }
    visited.add(cursor);
    cursor = await readPage(cursor);
  }
  return {
    entries: [...entries.values()],
    summaries,
    pagesRead,
    cursor: incomplete,
  };
}

// ---------------------------------------------------------------------------
// Manifest + persisted run state
// ---------------------------------------------------------------------------

export type CutoverCommand =
  | "inspect"
  | "dry-run"
  | "apply"
  | "verify"
  | "rollback";

export type RunPhase =
  | "in_progress"
  | "inspected"
  | "planned"
  | "staging"
  | "verified"
  | "blocked"
  | "rolled_back";

export interface ThreadSourceInfo {
  messageCount: number | null;
  digest: string | null;
  readComplete: boolean;
  createdAt?: string;
  lastRunAt?: string;
  updatedAt?: string;
}

export interface ThreadManifestEntry {
  threadId: string;
  status:
    | "pending"
    | "importable"
    | "quarantined"
    | "importing"
    | "imported"
    | "verified"
    | "failed";
  reason?: ImportSkipReason;
  ownership: {
    status: OwnershipVerdict["status"];
    tenantId?: string;
    workspaceId?: string;
    principalId?: string;
  };
  storageBackend?: string;
  source: ThreadSourceInfo;
  plan?: {
    importable: number;
    skipped: number;
    skips: readonly { sourceId: string; reason: ImportSkipReason }[];
  };
  apply?: { written: number; alreadyPresent: number; digest: string };
  verify?: { status: "match" | "mismatch" | "failed"; detail?: string };
}

export interface CutoverManifest {
  schemaVersion: 1;
  runId: string;
  command: CutoverCommand;
  phase: RunPhase;
  generatedAt: string;
  scan:
    | {
        mode: "scan";
        userId: string;
        agentId: string;
        pagesRead: number;
        cursor: string | null;
      }
    | { mode: "explicit-thread"; threadId: string };
  totals: {
    threads: number;
    importableMessages: number;
    skippedMessages: number;
    alreadyPresentMessages: number;
    quarantinedThreads: number;
  };
  threads: readonly ThreadManifestEntry[];
  /** Registered source-API capability gaps, stated instead of papered over. */
  sourceCapabilityNotes: readonly string[];
  verify?: { status: "match" | "mismatch" | "failed"; detail?: string };
  rollbackReason?: string;
}

export interface PersistedRunState {
  schemaVersion: 1;
  runId: string;
  command: CutoverCommand;
  phase: RunPhase;
  scan: ScanDescriptor & { pagesRead?: number; cursor?: string | null };
  threads: Record<string, ThreadManifestEntry>;
  authorizedFixture?: string;
  rollbackReason?: string;
  updatedAt: string;
}

export class CutoverStateError extends Error {}

/**
 * The staging-state gate ME14's write fence consumes: a target is only
 * "verified" (fence-eligible) after a verify pass matched every digest, and
 * any blocked/rolled-back state is fence-ineligible. Before that, "absent".
 */
export function stagingStatusOf(
  state: unknown,
): "staging" | "verified" | "blocked" | "rolled_back" | "absent" {
  if (state === null || typeof state !== "object") return "absent";
  const phase = (state as { phase?: unknown }).phase;
  if (
    phase === "staging" ||
    phase === "verified" ||
    phase === "blocked" ||
    phase === "rolled_back"
  ) {
    return phase;
  }
  return "absent";
}

function emptySourceInfo(
  summary?: IntelligenceThreadSummary,
): ThreadSourceInfo {
  return {
    messageCount: null,
    digest: null,
    readComplete: false,
    ...(summary?.createdAt !== undefined
      ? { createdAt: summary.createdAt }
      : {}),
    ...(summary?.lastRunAt !== undefined
      ? { lastRunAt: summary.lastRunAt }
      : {}),
    ...(summary?.updatedAt !== undefined
      ? { updatedAt: summary.updatedAt }
      : {}),
  };
}

function entryFromInventory(entry: ThreadInventoryEntry): ThreadManifestEntry {
  const quarantined = entry.skipReason !== undefined;
  return {
    threadId: entry.threadId,
    status: quarantined ? "quarantined" : "pending",
    ...(entry.skipReason !== undefined ? { reason: entry.skipReason } : {}),
    ownership: { status: entry.ownershipStatus, ...(entry.owner ?? {}) },
    ...(entry.storageBackend !== undefined
      ? { storageBackend: entry.storageBackend }
      : {}),
    source: emptySourceInfo(),
  };
}

function totalsOf(
  threads: readonly ThreadManifestEntry[],
): CutoverManifest["totals"] {
  return {
    threads: threads.length,
    importableMessages: threads.reduce(
      (sum, thread) => sum + (thread.plan?.importable ?? 0),
      0,
    ),
    skippedMessages: threads.reduce(
      (sum, thread) => sum + (thread.plan?.skipped ?? 0),
      0,
    ),
    alreadyPresentMessages: threads.reduce(
      (sum, thread) => sum + (thread.apply?.alreadyPresent ?? 0),
      0,
    ),
    quarantinedThreads: threads.filter(
      (thread) => thread.status === "quarantined",
    ).length,
  };
}

const SOURCE_CAPABILITY_NOTES = [
  "getThreadMessages returns a thread's whole history in one response; the documented source API exposes no per-message pagination cursor, so per-thread reads are all-or-fail and resume granularity is the thread.",
  "ThreadMessage carries no per-message timestamp; only thread-level createdAt/lastRunAt/updatedAt exist, so imported rows are stamped at import time and the source time window is preserved in this manifest only.",
] as const;

async function persist(
  runStore: CutoverRunStore | undefined,
  state: PersistedRunState,
): Promise<void> {
  if (!runStore) return;
  await runStore.save(state);
}

function stateOrDefault(
  request: { runId: string; scan: ScanDescriptor },
  command: CutoverCommand,
): PersistedRunState {
  return {
    schemaVersion: 1,
    runId: request.runId,
    command,
    phase: "in_progress",
    scan: { ...request.scan },
    threads: {},
    updatedAt: new Date().toISOString(),
  };
}

function manifestOf(
  state: PersistedRunState,
  command: CutoverCommand,
  extra?: { verify?: CutoverManifest["verify"]; rollbackReason?: string },
): CutoverManifest {
  const threads = Object.values(state.threads);
  return {
    schemaVersion: 1,
    runId: state.runId,
    command,
    phase: state.phase,
    generatedAt: new Date().toISOString(),
    scan:
      state.scan.mode === "scan"
        ? {
            mode: "scan",
            userId: state.scan.userId,
            agentId: state.scan.agentId,
            pagesRead: state.scan.pagesRead ?? 0,
            cursor: state.scan.cursor ?? null,
          }
        : { mode: "explicit-thread", threadId: state.scan.threadId },
    totals: totalsOf(threads),
    threads,
    sourceCapabilityNotes: SOURCE_CAPABILITY_NOTES,
    ...(extra?.verify !== undefined ? { verify: extra.verify } : {}),
    ...(extra?.rollbackReason !== undefined
      ? { rollbackReason: extra.rollbackReason }
      : {}),
  };
}

async function loadState(
  runStore: CutoverRunStore | undefined,
  request: { runId: string; scan: ScanDescriptor },
  command: CutoverCommand,
): Promise<PersistedRunState> {
  if (!runStore) return stateOrDefault(request, command);
  const loaded = (await runStore.load()) as PersistedRunState | null;
  if (loaded?.schemaVersion !== 1 || loaded.runId !== request.runId) {
    return stateOrDefault(request, command);
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// Read + plan one thread (shared by dry-run, apply and verify)
// ---------------------------------------------------------------------------

interface ThreadReadOutcome {
  scope: PlatformScopeLike | null;
  entry: ThreadManifestEntry;
  planned: readonly PlannedMessage[];
}

async function readAndPlanThread(
  deps: { source: LegacyImportSource; ports: LegacyOwnershipPorts },
  summary: IntelligenceThreadSummary | undefined,
  inventoryEntry: ThreadInventoryEntry,
): Promise<ThreadReadOutcome> {
  const base: ThreadManifestEntry = {
    ...entryFromInventory(inventoryEntry),
    ...(summary !== undefined ? { source: emptySourceInfo(summary) } : {}),
  };
  if (inventoryEntry.skipReason !== undefined || !inventoryEntry.owner) {
    return { scope: null, entry: base, planned: [] };
  }
  const scopeVerdict = await resolveImportScope(deps.ports, {
    tenantId: inventoryEntry.owner.tenantId,
    workspaceId: inventoryEntry.owner.workspaceId,
    principalId: inventoryEntry.owner.principalId,
    conversationId: "",
    storageBackend: "mastra",
  });
  if (scopeVerdict.status !== "ok") {
    return {
      scope: null,
      entry: { ...base, status: "quarantined", reason: "owner_unauthorized" },
      planned: [],
    };
  }
  let messages: readonly IntelligenceThreadMessage[];
  try {
    const read = await deps.source.getThreadMessages({
      threadId: inventoryEntry.threadId,
      userId: scopeVerdict.scope.actorId,
    });
    messages = read.messages;
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    return {
      scope: scopeVerdict.scope,
      entry: {
        ...base,
        status: "quarantined",
        reason: status === 404 ? "source_thread_missing" : "source_read_failed",
      },
      planned: [],
    };
  }
  const existing = await deps.ports.existingAttachmentIds(
    attachmentIdsInSourceMessages(messages),
  );
  const plan = planThreadMessages(messages, existing);
  return {
    scope: scopeVerdict.scope,
    entry: {
      ...base,
      status: "importable",
      source: {
        ...base.source,
        messageCount: messages.length,
        digest: threadDigest(fingerprintsOf(plan.planned)),
        readComplete: true,
      },
      plan: {
        importable: plan.importable,
        skipped: plan.skips.length,
        skips: plan.skips,
      },
    },
    planned: plan.planned,
  };
}

function inventoryEntryOf(
  threadId: string,
  entry: ThreadManifestEntry,
): ThreadInventoryEntry {
  return {
    threadId,
    ownershipStatus: entry.ownership.status,
    ...(entry.reason !== undefined && entry.status === "quarantined"
      ? { skipReason: entry.reason }
      : {}),
    ...(entry.ownership.tenantId !== undefined
      ? {
          owner: {
            tenantId: entry.ownership.tenantId,
            workspaceId: entry.ownership.workspaceId ?? "",
            principalId: entry.ownership.principalId ?? "",
          },
        }
      : {}),
    ...(entry.storageBackend !== undefined
      ? { storageBackend: entry.storageBackend }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface LegacyImporterDeps {
  source: LegacyImportSource;
  ports: LegacyOwnershipPorts;
  writer?: LegacyImportWriter;
  targetReader?: LegacyTargetReader;
  runStore?: CutoverRunStore;
}

export interface CutoverRequest {
  runId: string;
  scan: ScanDescriptor;
  pageSize?: number;
}

/** AC1: inventory + ownership evidence only; messages are not even read. */
export async function runInspect(
  deps: LegacyImporterDeps,
  request: CutoverRequest,
): Promise<CutoverManifest> {
  const state = await loadState(deps.runStore, request, "inspect");
  const inventory = await inventoryThreads({
    source: deps.source,
    ports: deps.ports,
    scan: request.scan,
    ...(request.pageSize !== undefined ? { pageSize: request.pageSize } : {}),
  });
  state.scan.pagesRead = inventory.pagesRead;
  state.scan.cursor = inventory.cursor;
  state.threads = Object.fromEntries(
    inventory.entries.map((entry) => [
      entry.threadId,
      entryFromInventory(entry),
    ]),
  );
  state.phase = "inspected";
  state.updatedAt = new Date().toISOString();
  await persist(deps.runStore, state);
  return manifestOf(state, "inspect");
}

/** AC1: full planning with digests and skip reasons; ZERO target writes. */
export async function runDryRun(
  deps: LegacyImporterDeps,
  request: CutoverRequest,
): Promise<CutoverManifest> {
  const state = await loadState(deps.runStore, request, "dry-run");
  const inventory = await inventoryThreads({
    source: deps.source,
    ports: deps.ports,
    scan: request.scan,
    ...(request.pageSize !== undefined ? { pageSize: request.pageSize } : {}),
  });
  state.scan.pagesRead = inventory.pagesRead;
  state.scan.cursor = inventory.cursor;
  for (const entry of inventory.entries) {
    const outcome = await readAndPlanThread(
      deps,
      inventory.summaries.get(entry.threadId),
      entry,
    );
    state.threads[entry.threadId] = outcome.entry;
  }
  state.phase = "planned";
  state.updatedAt = new Date().toISOString();
  await persist(deps.runStore, state);
  return manifestOf(state, "dry-run");
}

/**
 * AC3 + AC5: perform the import through the controlled writer seams with
 * per-thread progress persisted for resume; finish in the "staging" phase —
 * the verified state (and only that) is what ME14's fence consumes. Refuses
 * to run outside an explicitly authorized fixture environment.
 */
export async function runApply(
  deps: LegacyImporterDeps,
  request: CutoverRequest & {
    authorization: { fixtureId: string };
    environmentFixtureId?: string;
  },
): Promise<CutoverManifest> {
  if (
    !request.authorization.fixtureId ||
    request.environmentFixtureId !== request.authorization.fixtureId
  ) {
    throw new CutoverStateError(
      "APPLY_NOT_AUTHORIZED: apply runs only on an explicitly authorized disposable fixture",
    );
  }
  if (!deps.writer) throw new CutoverStateError("APPLY_REQUIRES_WRITER");
  // Cursor persistence IS the resume contract: an apply that cannot persist
  // its progress would silently lose the interrupted-run guarantees.
  if (!deps.runStore) throw new CutoverStateError("APPLY_REQUIRES_STATE_STORE");
  const state = await loadState(deps.runStore, request, "apply");
  if (state.phase === "rolled_back") {
    throw new CutoverStateError(
      "ROLLED_BACK: the run state was rolled back; start a new run",
    );
  }
  if (state.phase === "verified" && Object.keys(state.threads).length > 0) {
    throw new CutoverStateError(
      "APPLY_STATE_VERIFIED: verify already passed; roll back to re-import",
    );
  }
  state.command = "apply";
  state.authorizedFixture = request.authorization.fixtureId;
  let summaries: ReadonlyMap<string, IntelligenceThreadSummary> = new Map();
  if (Object.keys(state.threads).length === 0) {
    const inventory = await inventoryThreads({
      source: deps.source,
      ports: deps.ports,
      scan: request.scan,
      ...(request.pageSize !== undefined ? { pageSize: request.pageSize } : {}),
    });
    summaries = inventory.summaries;
    state.scan.pagesRead = inventory.pagesRead;
    state.scan.cursor = inventory.cursor;
    state.threads = Object.fromEntries(
      inventory.entries.map((entry) => [
        entry.threadId,
        {
          ...entryFromInventory(entry),
          ...(inventory.summaries.has(entry.threadId)
            ? {
                source: emptySourceInfo(
                  inventory.summaries.get(entry.threadId),
                ),
              }
            : {}),
        },
      ]),
    );
  }
  state.phase = "in_progress";
  state.updatedAt = new Date().toISOString();
  await persist(deps.runStore, state);
  for (const threadId of Object.keys(state.threads)) {
    const entry = state.threads[threadId] as ThreadManifestEntry;
    if (entry.status === "verified") continue;
    // Progress marker BEFORE the first write of this thread: a crash after
    // it leaves an honest "importing" state the resumed run re-plans (the
    // per-message appends converge idempotently via the stable keys).
    state.threads[threadId] = { ...entry, status: "importing" };
    state.updatedAt = new Date().toISOString();
    await persist(deps.runStore, state);
    const outcome = await readAndPlanThread(
      deps,
      summaries.get(threadId),
      inventoryEntryOf(threadId, entry),
    );
    if (outcome.entry.status !== "importable" || outcome.scope === null) {
      state.threads[threadId] = outcome.entry;
      state.updatedAt = new Date().toISOString();
      await persist(deps.runStore, state);
      continue;
    }
    let written = 0;
    let alreadyPresent = 0;
    const extraSkips: { sourceId: string; reason: ImportSkipReason }[] = [];
    try {
      for (const message of outcome.planned) {
        if (message.decision === "skip") continue;
        const finalized = await deps.ports.finalizedKeyExists(
          outcome.scope.tenantId,
          threadId,
          message.clientMessageKey,
        );
        if (finalized) {
          alreadyPresent += 1;
          continue;
        }
        if (message.decision === "user") {
          try {
            await deps.writer.appendImportedUser({
              scope: outcome.scope,
              threadId,
              clientMessageKey: message.clientMessageKey,
              content: message.content,
              attachments: message.attachments,
            });
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            if (text.includes("ATTACHMENT_FORBIDDEN")) {
              extraSkips.push({
                sourceId: message.sourceId,
                reason: "attachment_unauthorized",
              });
              continue;
            }
            throw error;
          }
        } else {
          await deps.writer.appendImportedEngine({
            scope: outcome.scope,
            threadId,
            clientMessageKey: message.clientMessageKey,
            role: message.role,
            parts: message.parts,
            engineMessageId: message.engineMessageId,
            ...(message.toolCallId !== undefined
              ? { toolCallId: message.toolCallId }
              : {}),
          });
        }
        written += 1;
      }
    } catch (error) {
      // Crash mid-thread: persist the honest partial state (including the
      // per-message skips recorded so far), then surface the failure. The
      // resume re-plans the thread; already-written messages re-resolve to
      // their intents instead of duplicating.
      state.threads[threadId] = {
        ...outcome.entry,
        status: "importing",
        plan: {
          importable: outcome.entry.plan?.importable ?? 0,
          skipped: (outcome.entry.plan?.skipped ?? 0) + extraSkips.length,
          skips: [...(outcome.entry.plan?.skips ?? []), ...extraSkips],
        },
      };
      state.updatedAt = new Date().toISOString();
      await persist(deps.runStore, state);
      throw error;
    }
    state.threads[threadId] = {
      ...outcome.entry,
      status: "imported",
      plan: {
        importable: outcome.entry.plan?.importable ?? 0,
        skipped: (outcome.entry.plan?.skipped ?? 0) + extraSkips.length,
        skips: [...(outcome.entry.plan?.skips ?? []), ...extraSkips],
      },
      apply: {
        written,
        alreadyPresent,
        digest: outcome.entry.source.digest ?? "",
      },
    };
    state.updatedAt = new Date().toISOString();
    await persist(deps.runStore, state);
  }
  state.phase = "staging";
  state.updatedAt = new Date().toISOString();
  await persist(deps.runStore, state);
  return manifestOf(state, "apply");
}

/**
 * AC4 + AC5: recompute the source digests and compare them against the
 * stored target rows. Any mismatch (or a non-import row that appeared in a
 * staging thread) BLOCKS: the phase moves to "blocked" and the staging
 * target stays fence-ineligible.
 */
export async function runVerify(
  deps: LegacyImporterDeps,
  request: CutoverRequest,
): Promise<CutoverManifest> {
  if (!deps.runStore) {
    throw new CutoverStateError(
      "VERIFY_REQUIRES_APPLY_STATE: verify gates a prior apply run",
    );
  }
  if (!deps.targetReader)
    throw new CutoverStateError("VERIFY_REQUIRES_TARGET_READER");
  const loaded = (await deps.runStore.load()) as PersistedRunState | null;
  if (loaded?.schemaVersion !== 1) {
    throw new CutoverStateError(
      "VERIFY_REQUIRES_APPLY_STATE: no completed apply state to verify",
    );
  }
  if (loaded.runId !== request.runId) {
    throw new CutoverStateError(
      `VERIFY_RUN_MISMATCH: state belongs to run ${loaded.runId}, not ${request.runId}`,
    );
  }
  if (loaded.phase === "rolled_back") {
    throw new CutoverStateError("ROLLED_BACK: the run state was rolled back");
  }
  if (loaded.command !== "apply") {
    throw new CutoverStateError(
      "VERIFY_REQUIRES_APPLY_STATE: no completed apply state to verify",
    );
  }
  if (
    loaded.phase !== "staging" &&
    loaded.phase !== "blocked" &&
    loaded.phase !== "verified"
  ) {
    throw new CutoverStateError(
      "VERIFY_REQUIRES_APPLY_STATE: the apply run never reached staging",
    );
  }
  const state: PersistedRunState = loaded;
  let mismatches = 0;
  let firstDetail: string | undefined;
  for (const threadId of Object.keys(state.threads)) {
    const entry = state.threads[threadId] as ThreadManifestEntry;
    if (entry.status !== "imported" && entry.status !== "verified") continue;
    const outcome = await readAndPlanThread(
      deps,
      undefined,
      inventoryEntryOf(threadId, entry),
    );
    if (outcome.entry.status !== "importable" || outcome.scope === null) {
      mismatches += 1;
      const detail = outcome.entry.reason ?? "source_unavailable";
      state.threads[threadId] = {
        ...entry,
        verify: { status: "failed", detail },
      };
      if (firstDetail === undefined) firstDetail = `${threadId}: ${detail}`;
      continue;
    }
    const expected = fingerprintsOf(outcome.planned);
    let detail: string | undefined;
    try {
      const rows = await deps.targetReader.readFinalizedRows(
        outcome.scope,
        threadId,
      );
      const importedRows = rows.filter((row) =>
        row.clientMessageKey.startsWith(LEGACY_IMPORT_KEY_PREFIX),
      );
      const foreignRows = rows.length - importedRows.length;
      const actual: string[] = [];
      for (const row of importedRows) {
        actual.push(canonicalMessageFingerprint(canonicalFromTargetRow(row)));
      }
      if (foreignRows > 0) {
        detail = `non_import_rows_present:${foreignRows}`;
      } else if (actual.length !== expected.length) {
        detail = `row_count_mismatch:source=${expected.length},target=${actual.length}`;
      } else {
        for (const [index, fingerprint] of expected.entries()) {
          if (actual[index] !== fingerprint) {
            detail = `digest_mismatch:${importedRows[index]?.clientMessageKey ?? index}`;
            break;
          }
        }
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : "unknown";
      detail = `verify_read_failed:${text.split(":")[0] ?? ""}`;
    }
    if (detail !== undefined) {
      mismatches += 1;
      state.threads[threadId] = {
        ...entry,
        verify: { status: "mismatch", detail },
      };
      if (firstDetail === undefined) firstDetail = `${threadId}: ${detail}`;
    } else {
      state.threads[threadId] = {
        ...entry,
        status: "verified",
        verify: { status: "match" },
      };
    }
  }
  state.phase = mismatches === 0 ? "verified" : "blocked";
  state.updatedAt = new Date().toISOString();
  await deps.runStore.save(state);
  return manifestOf(state, "verify", {
    verify: {
      status: mismatches === 0 ? "match" : "mismatch",
      ...(firstDetail !== undefined ? { detail: firstDetail } : {}),
    },
  });
}

/**
 * AC6: the rollback record. The SOURCE is never touched by anything in this
 * module, and rollback performs no deletions anywhere — the staging target
 * is a disposable fixture, and the state moves to a terminal
 * fence-ineligible "rolled_back".
 */
export async function runRollback(
  deps: LegacyImporterDeps,
  request: CutoverRequest,
  reason: string,
): Promise<CutoverManifest> {
  if (!deps.runStore) throw new CutoverStateError("ROLLBACK_REQUIRES_STATE");
  const loaded = (await deps.runStore.load()) as PersistedRunState | null;
  if (loaded?.schemaVersion !== 1) {
    throw new CutoverStateError(
      "ROLLBACK_REQUIRES_STATE: nothing to roll back",
    );
  }
  if (loaded.runId !== request.runId) {
    throw new CutoverStateError(
      `ROLLBACK_RUN_MISMATCH: state belongs to run ${loaded.runId}, not ${request.runId}`,
    );
  }
  loaded.phase = "rolled_back";
  loaded.rollbackReason = reason;
  loaded.updatedAt = new Date().toISOString();
  await deps.runStore.save(loaded);
  return manifestOf(loaded, "rollback", { rollbackReason: reason });
}
