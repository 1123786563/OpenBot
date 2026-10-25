import type { Message } from "@ag-ui/client";
import { attachmentUrl } from "../../../shared/attachments";
import { attachmentIdsIn } from "../channels/attachment-parts";

/*
 * ME03 (#475) T4: the versioned full-parts representation of one message.
 *
 * The display projection (MessageDTO.content — plain text plus attachment ids)
 * is NOT the model history. This module owns the conversion between the AG-UI
 * message the engine/runtime speaks and the versioned representation stored in
 * `content.metadata.openbotParts` alongside the existing seq/digest/key/
 * attachments metadata the ConversationService single-writer path already
 * stamps. Reading a conversation back (refresh, pagination, reconnect) and
 * building the model context are two separate projections of the same stored
 * parts — this file is the shared contract for both.
 *
 * Pure module: no storage, no authorization, no I/O. Corruption is a thrown
 * MASTRA_MESSAGE_PARTS_CORRUPT, never a silent repair — a message whose parts
 * cannot be proven must fail the turn explicitly (ME03 AC5).
 */

export const OPENBOT_MESSAGE_PARTS_SCHEMA_VERSION = 1;

/** Corrupt or unprovable full parts: the caller must fail, never improvise. */
export class MastraMessagePartsCorruptError extends Error {
  constructor(detail: string) {
    super(`MASTRA_MESSAGE_PARTS_CORRUPT: ${detail}`);
  }
}

/** A wire role this slice refuses to persist or rebuild (never silently drop). */
export class MastraMessagePartsUnsupportedError extends Error {}

/**
 * One stored part. `kind` discriminates; every variant carries only JSON data
 * (no functions, no bytes, no provider artefacts) so the representation is
 * safe to persist and to replay across processes.
 */
export type OpenBotMessagePart =
  | { kind: "text"; text: string }
  | { kind: "attachment"; attachmentId: string }
  | {
      kind: "tool-call";
      toolCallId: string;
      toolName: string;
      args: string;
    }
  | {
      kind: "tool-result";
      toolCallId: string;
      content: string;
      isError: boolean;
    }
  | { kind: "activity"; activityType: string; payload: unknown };

/**
 * The versioned full message stored under `content.metadata.openbotParts`.
 *
 * `role` is the conversational truth of the row (a tool result is role "tool"
 * even though the legacy display DTO projects non-user rows as assistant),
 * `engineMessageId` records the engine message id -> stable OpenBot message
 * identity mapping, and `toolCallId` answers which call a role-"tool" row
 * belongs to.
 */
export interface OpenBotFullMessage {
  readonly schemaVersion: 1;
  readonly role: "user" | "assistant" | "tool" | "activity";
  readonly parts: readonly OpenBotMessagePart[];
  readonly engineMessageId?: string;
  readonly toolCallId?: string;
  /**
   * FIX-OCR3 (O3-H1, FIX-W14's replay half): the {id, kind} pointers the run's
   * answer cited, stamped on the assistant message's AG-UI metadata by the engine
   * wrapper and carried HERE so the basis survives the store — a refresh rebuilds
   * history from these rows, and a basis only the live event stream carried was a
   * basis the person lost the moment they reloaded. Assistant envelopes only.
   */
  readonly answerBasis?: readonly OpenBotAnswerBasisPointer[];
}

/** Which half of the person's memory an answer drew on — the server's own vocabulary. */
export type OpenBotAnswerBasisKind =
  | "general-preference"
  | "source-bound"
  | "derived-judgment";

/** One record an answer cited: the id the evidence seam expands, and which half it came from. */
export type OpenBotAnswerBasisPointer = {
  id: string;
  kind: OpenBotAnswerBasisKind;
};

const ANSWER_BASIS_KINDS: readonly OpenBotAnswerBasisKind[] = [
  "general-preference",
  "source-bound",
  "derived-judgment",
];

/**
 * The basis pointers of one AG-UI message's metadata, or undefined when it carries none.
 *
 * Tolerant on the way IN: `openbot` is a shared metadata namespace other writers may use, so
 * a shape that is not this stamp reads as "no basis" rather than corrupting the persistence
 * of a message that happens to carry foreign metadata. Strict on the way OUT of storage
 * (`parseStoredFullMessage`): the envelope is this module's own representation, and an
 * answerBasis it cannot prove is corrupt.
 */
export function answerBasisOfAgUiMetadata(
  metadata: unknown,
): readonly OpenBotAnswerBasisPointer[] | undefined {
  if (!isRecord(metadata)) return undefined;
  const openbot = metadata.openbot;
  if (!isRecord(openbot)) return undefined;
  const raw = openbot.personalMemoryBasis;
  if (!Array.isArray(raw)) return undefined;
  const pointers: OpenBotAnswerBasisPointer[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return undefined;
    const { id, kind } = entry;
    if (typeof id !== "string" || id.length === 0) return undefined;
    if (!ANSWER_BASIS_KINDS.includes(kind as OpenBotAnswerBasisKind))
      return undefined;
    pointers.push({ id, kind: kind as OpenBotAnswerBasisKind });
  }
  return pointers.length > 0 ? pointers : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new MastraMessagePartsCorruptError(`${what} must be a string`);
  }
  return value;
}

/** Strict parse of a stored full message. Anything unprovable is corrupt. */
/** The stored basis pointers, proven or corrupt — never silently half-read (O3-H1). */
function parseStoredAnswerBasis(
  value: unknown,
): readonly OpenBotAnswerBasisPointer[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new MastraMessagePartsCorruptError(
      "answerBasis must be a non-empty array",
    );
  }
  return value.map((entry): OpenBotAnswerBasisPointer => {
    if (!isRecord(entry)) {
      throw new MastraMessagePartsCorruptError(
        "answerBasis entry is not an object",
      );
    }
    const { id, kind } = entry;
    if (typeof id !== "string" || id.length === 0) {
      throw new MastraMessagePartsCorruptError(
        "answerBasis entry id must be a string",
      );
    }
    if (!ANSWER_BASIS_KINDS.includes(kind as OpenBotAnswerBasisKind)) {
      throw new MastraMessagePartsCorruptError(
        `answerBasis entry kind is unknown: ${String(kind)}`,
      );
    }
    return { id, kind: kind as OpenBotAnswerBasisKind };
  });
}

export function parseStoredFullMessage(value: unknown): OpenBotFullMessage {
  if (!isRecord(value)) {
    throw new MastraMessagePartsCorruptError("parts envelope is not an object");
  }
  if (value.schemaVersion !== OPENBOT_MESSAGE_PARTS_SCHEMA_VERSION) {
    throw new MastraMessagePartsCorruptError(
      `schemaVersion must be ${OPENBOT_MESSAGE_PARTS_SCHEMA_VERSION}`,
    );
  }
  const role = value.role;
  if (
    role !== "user" &&
    role !== "assistant" &&
    role !== "tool" &&
    role !== "activity"
  ) {
    throw new MastraMessagePartsCorruptError("role is not a stored role");
  }
  if (!Array.isArray(value.parts)) {
    throw new MastraMessagePartsCorruptError("parts must be an array");
  }
  const parts = value.parts.map((part): OpenBotMessagePart => {
    if (!isRecord(part)) {
      throw new MastraMessagePartsCorruptError("part is not an object");
    }
    switch (part.kind) {
      case "text":
        return { kind: "text", text: assertString(part.text, "text part") };
      case "attachment":
        return {
          kind: "attachment",
          attachmentId: assertString(part.attachmentId, "attachment part id"),
        };
      case "tool-call":
        return {
          kind: "tool-call",
          toolCallId: assertString(part.toolCallId, "tool-call id"),
          toolName: assertString(part.toolName, "tool-call name"),
          args: assertString(part.args, "tool-call args"),
        };
      case "tool-result": {
        // R4-9: only absence means "not an error". A stored non-boolean
        // (`"true"`, `1` — writer regression or hand repair) must not fold
        // silently into a SUCCESSFUL result: anything unprovable is corrupt.
        if (part.isError !== undefined && typeof part.isError !== "boolean") {
          throw new MastraMessagePartsCorruptError(
            "tool-result isError must be a boolean",
          );
        }
        return {
          kind: "tool-result",
          toolCallId: assertString(part.toolCallId, "tool-result id"),
          content: assertString(part.content, "tool-result content"),
          isError: part.isError === true,
        };
      }
      case "activity":
        return {
          kind: "activity",
          activityType: assertString(part.activityType, "activity type"),
          payload: part.payload,
        };
      default:
        throw new MastraMessagePartsCorruptError("unknown part kind");
    }
  });
  const full: OpenBotFullMessage = {
    schemaVersion: 1,
    role,
    parts,
    ...(typeof value.engineMessageId === "string"
      ? { engineMessageId: value.engineMessageId }
      : {}),
    ...(typeof value.toolCallId === "string"
      ? { toolCallId: value.toolCallId }
      : {}),
    ...(value.answerBasis !== undefined
      ? { answerBasis: parseStoredAnswerBasis(value.answerBasis) }
      : {}),
  };
  if (role === "tool" && full.toolCallId === undefined) {
    throw new MastraMessagePartsCorruptError("tool row carries no toolCallId");
  }
  return full;
}

/**
 * Canonical JSON: object keys sorted recursively, arrays in order.
 *
 * Fix-round-1 (M2): the digest input used to be `JSON.stringify(full)`,
 * whose object key order is insertion order — two structurally identical
 * envelopes built by different code paths (or a serialized/stored round
 * trip) could hash differently and turn an idempotent retry into a false
 * `message_conflict`. Sorting the keys makes the digest a function of the
 * VALUE alone.
 */
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
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The stable digest input for one persisted message: the FULL parts (not the
 * display projection), in sorted-key canonical JSON so the digest depends
 * only on the stored value, never on key order.
 */
export function fullMessageDigestInput(full: OpenBotFullMessage): string {
  return canonicalJson(full);
}

interface AgUiShape {
  id: string;
  role: string;
  content?: unknown;
  toolCalls?: unknown;
  toolCallId?: unknown;
  error?: unknown;
  /** The protocol-level metadata channel; the basis stamp rides it (O3-H1). */
  metadata?: unknown;
}

/**
 * Convert one AG-UI message into the stored full representation plus its
 * display projection (text) and the attachment ids it references.
 *
 * `attachmentIdsIn` is THE id contract: a part is an OpenBot attachment when
 * it carries an `/api/attachments/<id>` URL source, regardless of the part
 * type the composer declared. The stored `attachment` parts keep the id only;
 * bytes are resolved later by the authorized inline pass, never here.
 */
export function fullMessageFromAgUi(message: Message): {
  full: OpenBotFullMessage;
  content: string;
  attachments: string[];
} {
  const shape = message as unknown as AgUiShape;
  const engineMessageId = shape.id;
  if (typeof engineMessageId !== "string" || engineMessageId.length === 0) {
    throw new MastraMessagePartsUnsupportedError(
      "MASTRA_PERSIST_MESSAGE_ID_REQUIRED",
    );
  }
  if (shape.role === "user") {
    const parts: OpenBotMessagePart[] = [];
    let text = "";
    const attachments = attachmentIdsIn(shape.content);
    if (typeof shape.content === "string") {
      if (shape.content.length > 0) {
        parts.push({ kind: "text", text: shape.content });
        text = shape.content;
      }
    } else if (Array.isArray(shape.content)) {
      for (const part of shape.content as Record<string, unknown>[]) {
        if (!isRecord(part)) {
          throw new MastraMessagePartsCorruptError(
            "user part is not an object",
          );
        }
        if (part.type === "text" && typeof part.text === "string") {
          if (part.text.length > 0) {
            parts.push({ kind: "text", text: part.text });
            text += part.text;
          }
          continue;
        }
        // Attachment parts are already modeled by the schema and collected
        // through `attachmentIdsIn` below (the id contract reads the source
        // URL, not the declared type). Fix-round-1 (M1): every OTHER part
        // shape a wire client may grow is refused with its own named error —
        // never silently `continue`d, which would store a message whose
        // persisted parts prove less than what the person sent.
        if (attachmentIdsIn([part]).length === 0) {
          throw new MastraMessagePartsUnsupportedError(
            `MASTRA_PERSIST_USER_PART_UNSUPPORTED: ${String(part.type)}`,
          );
        }
      }
      for (const attachmentId of attachments) {
        parts.push({ kind: "attachment", attachmentId });
      }
    } else {
      throw new MastraMessagePartsUnsupportedError(
        "MASTRA_PERSIST_USER_CONTENT_UNSUPPORTED",
      );
    }
    return {
      full: { schemaVersion: 1, role: "user", parts, engineMessageId },
      content: text,
      attachments,
    };
  }
  if (shape.role === "assistant") {
    const parts: OpenBotMessagePart[] = [];
    let text = "";
    if (typeof shape.content === "string" && shape.content.length > 0) {
      parts.push({ kind: "text", text: shape.content });
      text = shape.content;
    } else if (Array.isArray(shape.content)) {
      // AG-UI allows assistant content as a parts array. Only text parts are
      // modelable here: anything else would be silently dropped, storing a
      // message that proves less than what the engine said — refuse with a
      // named error instead (the user branch's M1 contract, symmetric).
      for (const part of shape.content as Record<string, unknown>[]) {
        if (isRecord(part) && part.type === "text") {
          const chunk = assertString(part.text, "assistant text part");
          if (chunk.length > 0) {
            parts.push({ kind: "text", text: chunk });
            text += chunk;
          }
          continue;
        }
        throw new MastraMessagePartsUnsupportedError(
          `MASTRA_PERSIST_ASSISTANT_PART_UNSUPPORTED: ${String(
            isRecord(part) ? part.type : typeof part,
          )}`,
        );
      }
    } else if (
      typeof shape.content !== "string" &&
      shape.content !== undefined &&
      shape.content !== null
    ) {
      // Not a string (empty included), not a parts array: nothing this
      // slice can prove.
      throw new MastraMessagePartsUnsupportedError(
        "MASTRA_PERSIST_ASSISTANT_CONTENT_UNSUPPORTED",
      );
    }
    if (shape.toolCalls !== undefined) {
      if (!Array.isArray(shape.toolCalls)) {
        throw new MastraMessagePartsCorruptError("toolCalls must be an array");
      }
      for (const call of shape.toolCalls as Record<string, unknown>[]) {
        if (!isRecord(call) || !isRecord(call.function)) {
          throw new MastraMessagePartsCorruptError("tool call shape");
        }
        const toolCallId = assertString(call.id, "tool call id");
        const toolName = assertString(call.function.name, "tool call name");
        const args = assertString(call.function.arguments, "tool call args");
        parts.push({ kind: "tool-call", toolCallId, toolName, args });
      }
    }
    // O3-H1: the basis stamp the engine wrapper put on this assistant message rides the
    // stored envelope, so the replay half of "live and replayed agree" has something to
    // rebuild from. Foreign metadata shapes read as no basis (the tolerant reader above).
    const answerBasis = answerBasisOfAgUiMetadata(shape.metadata);
    return {
      full: {
        schemaVersion: 1,
        role: "assistant",
        parts,
        engineMessageId,
        ...(answerBasis !== undefined ? { answerBasis } : {}),
      },
      content: text,
      attachments: [],
    };
  }
  if (shape.role === "tool") {
    const toolCallId = assertString(shape.toolCallId, "tool message call id");
    const isError = shape.error !== undefined && shape.error !== null;
    const parts: OpenBotMessagePart[] = [];
    let text = "";
    if (typeof shape.content === "string") {
      // R4-6: an empty string is still a real result. Storing it is what
      // keeps its call from dangling — a part-less envelope is skipped by
      // persistExecutionMessages, and the next rebuild would then strip the
      // call entirely (the model forgets the tool ever ran). The pairing
      // contract keys on toolCallId, not on content.
      text = shape.content;
      parts.push({ kind: "tool-result", toolCallId, content: text, isError });
    } else if (Array.isArray(shape.content)) {
      for (const part of shape.content as Record<string, unknown>[]) {
        if (isRecord(part) && part.type === "text") {
          const chunk = assertString(part.text, "tool result text part");
          text += chunk;
          continue;
        }
        // Only text parts are modelable tool-result content: anything else
        // would be silently dropped from the stored envelope — refuse with
        // the tool branch's own named error, symmetric with user/assistant.
        throw new MastraMessagePartsUnsupportedError(
          `MASTRA_PERSIST_TOOL_PART_UNSUPPORTED: ${String(
            isRecord(part) ? part.type : typeof part,
          )}`,
        );
      }
      // Unconditional after the join, empty string included (R4-6): an empty
      // array content still answers its call once, with nothing to say.
      parts.push({ kind: "tool-result", toolCallId, content: text, isError });
    } else {
      // Neither string nor array: nothing this slice can prove — the same
      // refusal shape as the user/assistant branches, never a silent
      // part-less envelope (R4-6).
      throw new MastraMessagePartsUnsupportedError(
        "MASTRA_PERSIST_TOOL_CONTENT_UNSUPPORTED",
      );
    }
    return {
      full: {
        schemaVersion: 1,
        role: "tool",
        parts,
        engineMessageId,
        toolCallId,
      },
      content: text,
      attachments: [],
    };
  }
  if (shape.role === "activity") {
    const parts: OpenBotMessagePart[] = [
      {
        kind: "activity",
        activityType:
          typeof shape.content === "string" ? shape.content : "activity",
        payload: shape.content,
      },
    ];
    return {
      full: { schemaVersion: 1, role: "activity", parts, engineMessageId },
      content: "",
      attachments: [],
    };
  }
  // system/developer history is server-composed truth, never engine output;
  // anything else the wire may grow is refused rather than guessed into store.
  throw new MastraMessagePartsUnsupportedError(
    `MASTRA_PERSIST_ROLE_UNSUPPORTED: ${String(shape.role)}`,
  );
}

/** A rebuilt AG-UI message plus the attachment ids its content references. */
export interface RebuiltMessage {
  readonly message: Message;
  readonly attachments: readonly string[];
}

/**
 * Rebuild one AG-UI message from a stored memory row.
 *
 * `storedParts` is `content.metadata.openbotParts` when the row carries the
 * ME03 representation; legacy text-only rows (written by the pre-ME03 append)
 * are rebuilt from their text parts plus `metadata.openbotAttachments`, which
 * is exactly the fidelity they were written with. A stored envelope that
 * fails to parse is corrupt: throw, never fall back to a projection.
 */
/**
 * The AG-UI file part for one stored attachment id. The mime type is a
 * placeholder: the attachment's real type lives in attachment storage, and
 * the downstream authorized resolve picks the modality from the STORED mime —
 * this declared value never takes effect (R4-1).
 */
function filePartFor(attachmentId: string): Record<string, unknown> {
  return {
    type: "file",
    mimeType: "application/octet-stream",
    source: { type: "url", value: attachmentUrl(attachmentId) },
  };
}

/**
 * Wire content for a rebuilt message: the joined text, or the text plus its
 * file parts as an array. Shared by the stored user branch and the legacy
 * branch so neither grows a nested ternary (R4-22).
 */
function contentWithFileParts(
  text: string,
  fileParts: readonly Record<string, unknown>[],
): string | Record<string, unknown>[] {
  if (fileParts.length === 0) return text;
  const parts: Record<string, unknown>[] = [];
  if (text.length > 0) parts.push({ type: "text", text });
  parts.push(...fileParts);
  return parts;
}

/**
 * The activity-shaped rebuilt message: the stored activityType/payload are
 * restored, not erased behind a hardcoded placeholder (R4-7). Activity rows
 * carry no model context; the caller filters them by role.
 */
function activityMessageOf(
  id: string,
  part: Extract<OpenBotMessagePart, { kind: "activity" }>,
): Message {
  return {
    id,
    role: "activity",
    content: part.activityType,
    payload: part.payload,
  } as unknown as Message;
}

export function agUiMessageFromStoredRow(row: {
  id: string;
  role: string;
  content?: {
    parts?: unknown;
    metadata?: Record<string, unknown> | null;
  };
}): RebuiltMessage {
  const metadata = row.content?.metadata ?? {};
  const stored = metadata.openbotParts;
  if (stored !== undefined) {
    const full = parseStoredFullMessage(stored);
    // The memory-level role union has no "tool": a tool result is stored as
    // an assistant memory row whose envelope carries the conversational role
    // (and the answered call id). Any other row/envelope disagreement is
    // corrupt.
    const roleConsistent =
      full.role === row.role ||
      full.role === "activity" ||
      (full.role === "tool" && row.role === "assistant");
    if (!roleConsistent) {
      throw new MastraMessagePartsCorruptError(
        `stored role ${full.role} does not match row role ${row.role}`,
      );
    }
    let text = "";
    const attachments: string[] = [];
    const fileParts: Record<string, unknown>[] = [];
    const toolCalls: Record<string, unknown>[] = [];
    let toolResult: {
      content: string;
      toolCallId: string;
      isError: boolean;
    } | null = null;
    let activityPart: Extract<OpenBotMessagePart, { kind: "activity" }> | null =
      null;
    for (const part of full.parts) {
      switch (part.kind) {
        case "text":
          text += part.text;
          break;
        case "attachment":
          attachments.push(part.attachmentId);
          fileParts.push(filePartFor(part.attachmentId));
          break;
        case "tool-call":
          toolCalls.push({
            id: part.toolCallId,
            type: "function",
            function: { name: part.toolName, arguments: part.args },
          });
          break;
        case "tool-result":
          toolResult = {
            content: part.content,
            toolCallId: part.toolCallId,
            isError: part.isError,
          };
          break;
        case "activity":
          activityPart = part;
          break;
      }
    }
    // An assistant envelope whose every part is activity is an activity
    // message written under the assistant row role (the storage asymmetry):
    // rebuilding it as a content-"" assistant would slip an empty assistant
    // turn past the caller's role-based activity filter and into the model
    // context (R4-7). Rebuild it AS activity so the filter applies.
    if (
      full.parts.length > 0 &&
      full.parts.every((part) => part.kind === "activity") &&
      activityPart !== null
    ) {
      return {
        message: activityMessageOf(
          full.engineMessageId ?? row.id,
          activityPart,
        ),
        attachments: [],
      };
    }
    if (full.role === "user") {
      const content = contentWithFileParts(text, fileParts);
      return {
        message: {
          id: full.engineMessageId ?? row.id,
          role: "user",
          content,
          metadata: storedMetadataOf(metadata),
        } as Message,
        attachments,
      };
    }
    if (full.role === "assistant") {
      const rebuilt = {
        id: full.engineMessageId ?? row.id,
        role: "assistant",
        content: text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        // O3-H1: the basis the answer carried live is restored, not re-derived — the
        // replayed transcript and the event store agree on what the answer used. This is
        // the one metadata an engine-output rebuild carries (see storedMetadataOf).
        ...(full.answerBasis !== undefined
          ? {
              metadata: {
                openbot: { personalMemoryBasis: [...full.answerBasis] },
              },
            }
          : {}),
      } as Message;
      return { message: rebuilt, attachments: [] };
    }
    if (full.role === "tool") {
      // parseStoredFullMessage refuses a tool envelope without a toolCallId,
      // so this narrowing is a contract re-assertion, not a fallback: a
      // regression must fail loudly instead of rebuilding a call-less tool
      // message.
      const toolCallId = full.toolCallId;
      if (toolCallId === undefined) {
        throw new MastraMessagePartsCorruptError(
          "tool row carries no toolCallId",
        );
      }
      const rebuilt = {
        id: full.engineMessageId ?? row.id,
        role: "tool",
        toolCallId,
        content: toolResult?.content ?? text,
        ...(toolResult?.isError ? { error: "tool execution failed" } : {}),
      } as Message;
      return { message: rebuilt, attachments: [] };
    }
    if (activityPart !== null) {
      // activity rows carry no model context; the caller filters them.
      return {
        message: activityMessageOf(
          full.engineMessageId ?? row.id,
          activityPart,
        ),
        attachments: [],
      };
    }
    throw new MastraMessagePartsCorruptError(
      "activity envelope carries no activity part",
    );
  }
  // Legacy row: text parts plus the stamped attachment ids are the whole
  // truth. Legacy rows are user rows only (the pre-ME03 append wrote no
  // engine output); anything else is projected as assistant, which is what
  // the display DTO always showed for them.
  const parts = row.content?.parts;
  // R4-8: computed here only — the stored branch above never reads it, so
  // every ME03 row skips the scan it used to pay up front.
  const textParts = Array.isArray(parts)
    ? parts
        .filter(
          (part): part is { type: "text"; text: string } =>
            isRecord(part) &&
            part.type === "text" &&
            typeof (part as { text?: unknown }).text === "string",
        )
        .map((part) => part.text)
    : [];
  const legacyText = textParts.join("");
  const legacyAttachments = Array.isArray(metadata.openbotAttachments)
    ? metadata.openbotAttachments.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const role = row.role === "user" ? "user" : "assistant";
  // Legacy attachment parts are user content only; an assistant projection
  // keeps the plain text it always showed.
  const content = contentWithFileParts(
    legacyText,
    role === "user" ? legacyAttachments.map(filePartFor) : [],
  );
  return {
    message: {
      id: row.id,
      role,
      content,
      metadata: storedMetadataOf(metadata),
    } as Message,
    attachments: legacyAttachments,
  };
}

/**
 * The stored identity metadata a rebuilt message keeps on the wire surface:
 * the client message key the row was appended under (so a rebuilt history can
 * be matched against the submitted message) and, for user rows, the engine
 * message id. Only the user branch (and the legacy branch) attach this
 * metadata: the assistant/tool rebuilds carry no metadata object because
 * their engine message id IS the rebuilt message's `id` (R4-10 — consumers
 * must not expect `metadata.openbotEngineMessageId` on engine output rows).
 * Nothing else leaks from storage metadata. The one exception rides the envelope, not
 * this projection: an assistant rebuild's basis pointers (O3-H1 above) — server-composed,
 * carried in openbotParts, never assembled from row-level metadata here.
 */
function storedMetadataOf(
  metadata: Record<string, unknown>,
): Record<string, string> | undefined {
  const kept: Record<string, string> = {};
  if (typeof metadata.openbotClientMessageKey === "string") {
    kept.openbotClientMessageKey = metadata.openbotClientMessageKey;
  }
  if (typeof metadata.openbotEngineMessageId === "string") {
    kept.openbotEngineMessageId = metadata.openbotEngineMessageId;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}
