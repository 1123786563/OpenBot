import type { TranscriptItem } from "./streaming";
import type {
  CraftStreamPacket,
  CraftToolCallProgress,
  CraftToolCallStart,
} from "./types";

/**
 * The streaming reducer's pure kernel — the item-level fold helpers plus the subagent `_meta`
 * routing layer, kept free of runtime imports (types only) so the reducer logic is testable
 * anywhere without the React hook or the fetch layer.
 *
 * Subagent routing mirrors onyx `subagentRouting.ts`: one packet lands in exactly one of three
 * lanes — normal (the main transcript), child (a subagent's own transcript, keyed by the
 * `_meta.sessionId` the serve-client translator stamps), or parentTask (the parent's `task` tool
 * card, whose progress carries `_meta.subagentSessionId`). Simplification versus onyx, recorded:
 * a subagent's transcript is one flat `streamItems` list, not onyx's `SubagentTurn[]`; and its
 * completion is inferred from the task tool's terminal status (onyx's markSubagentComplete
 * semantics), with no cross-fade or tab history.
 */

export type SubagentStatus = "running" | "done" | "failed";

/** One live subagent, addressable by its opencode session id (the map key). */
export type SubagentState = {
  /** The child opencode session id — also the read-only view's address. */
  sessionId: string;
  /** The parent's `task` tool call this subagent belongs to; backfilled from the task card. */
  parentToolCallId: string | null;
  status: SubagentStatus;
  /** The subagent's transcript — flat (onyx nests turns; recorded divergence). */
  streamItems: TranscriptItem[];
};

/** Which lane one packet belongs to (onyx's three-way classification). */
export type SubagentRoute =
  | { kind: "normal" }
  | { kind: "child"; sessionId: string }
  | { kind: "parentTask"; sessionId: string; toolCallId: string };

// ---------------------------------------------------------------------------
// Item-level fold helpers — one implementation shared by the main transcript
// and every subagent transcript.
// ---------------------------------------------------------------------------

/** A key for a synthesized item — unique enough for a React list, no meaning beyond identity. */
export const freshKey = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Close every still-open streaming block (turn ended, or the block type switched). */
export function closeStreamingItems(items: TranscriptItem[]): TranscriptItem[] {
  let changed = false;
  const next = items.map((item) => {
    if ("streaming" in item && item.streaming) {
      changed = true;
      return { ...item, streaming: false };
    }
    return item;
  });
  return changed ? next : items;
}

/** Append a message/thought chunk, merging with the open block of its kind. */
export function appendChunkToItems(
  items: TranscriptItem[],
  kind: "text" | "thinking",
  text: string,
): TranscriptItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === kind && last.streaming) {
    return [...items.slice(0, -1), { ...last, text: last.text + text }];
  }
  let base = items;
  if (last && "streaming" in last && last.streaming) {
    base = base.slice(0, -1).concat({ ...last, streaming: false });
  }
  return base.concat({ key: freshKey(), kind, text, streaming: true });
}

/** The `task`-card fields a tool item carries when its progress names a subagent. */
type TaskMeta = { sessionId: string; status?: SubagentStatus };

function withTaskMeta(
  item: Extract<TranscriptItem, { kind: "tool" }>,
  task: TaskMeta | null,
): Extract<TranscriptItem, { kind: "tool" }> {
  if (!task) return item;
  return {
    ...item,
    subagentSessionId: task.sessionId,
    subagentStatus: task.status,
  };
}

/** Append a tool-call start as a new card (the translator emits one start per call id). */
export function appendToolStartToItems(
  items: TranscriptItem[],
  packet: CraftToolCallStart,
  task: TaskMeta | null = null,
): TranscriptItem[] {
  return closeStreamingItems(items).concat(
    withTaskMeta(
      {
        key: packet.toolCallId,
        kind: "tool",
        toolCallId: packet.toolCallId,
        title: packet.title,
        toolKind: packet.kind,
        status: packet.status,
        rawInput: packet.rawInput,
      },
      task,
    ),
  );
}

/** Upsert a tool-call progress: replace the card in place, or append when unseen. */
export function upsertToolProgressToItems(
  items: TranscriptItem[],
  packet: CraftToolCallProgress,
  task: TaskMeta | null = null,
): TranscriptItem[] {
  const base = closeStreamingItems(items);
  const index = base.findIndex(
    (item) => item.kind === "tool" && item.toolCallId === packet.toolCallId,
  );
  const nextTool = withTaskMeta(
    {
      key: index >= 0 ? base[index].key : freshKey(),
      kind: "tool",
      toolCallId: packet.toolCallId,
      title: packet.title,
      toolKind: packet.kind,
      status: packet.status,
      rawInput: packet.rawInput,
      rawOutput: packet.rawOutput,
      content: packet.content,
    },
    task,
  );
  return index >= 0
    ? base.slice(0, index).concat(nextTool, base.slice(index + 1))
    : base.concat(nextTool);
}

// ---------------------------------------------------------------------------
// Subagent routing — which lane a packet belongs to, and the map updates
// each lane drives.
// ---------------------------------------------------------------------------

/**
 * Classify one packet: `_meta.sessionId` + `_meta.parentSessionId` → child; a tool packet
 * carrying `_meta.subagentSessionId` → parentTask; everything else (including packets with no
 * `_meta` at all — the pre-subagent events) → normal.
 */
export function routeSubagentPacket(packet: CraftStreamPacket): SubagentRoute {
  const meta = "_meta" in packet ? packet._meta : undefined;
  if (!(meta instanceof Object)) return { kind: "normal" };

  const parentSessionId =
    typeof meta.parentSessionId === "string" ? meta.parentSessionId : null;
  const sessionId = typeof meta.sessionId === "string" ? meta.sessionId : null;
  if (parentSessionId && sessionId) return { kind: "child", sessionId };

  if (
    (packet.type === "tool_call_start" ||
      packet.type === "tool_call_progress") &&
    typeof meta.subagentSessionId === "string"
  ) {
    return {
      kind: "parentTask",
      sessionId: meta.subagentSessionId,
      toolCallId: packet.toolCallId,
    };
  }
  return { kind: "normal" };
}

function withEntry(
  subagents: Map<string, SubagentState>,
  sessionId: string,
  update: (entry: SubagentState) => SubagentState,
): Map<string, SubagentState> {
  const entry =
    subagents.get(sessionId) ??
    ({
      sessionId,
      parentToolCallId: null,
      status: "running",
      streamItems: [],
    } satisfies SubagentState);
  const next = new Map(subagents);
  next.set(sessionId, update(entry));
  return next;
}

/** A `subagent_started` packet's effect: register the child once, never reset a live entry. */
export function seedSubagent(
  subagents: Map<string, SubagentState>,
  subagentSessionId: string,
): Map<string, SubagentState> {
  if (subagents.has(subagentSessionId)) return subagents;
  return withEntry(subagents, subagentSessionId, (entry) => entry);
}

/**
 * The parent's `task` card update: claims the subagent for the call id (parallel tasks get
 * distinct children — the server's claim already paired them) and infers completion from the
 * card's terminal status (onyx's markSubagentComplete semantics).
 */
export function recordParentTaskToolCall(
  subagents: Map<string, SubagentState>,
  toolCallId: string,
  subagentSessionId: string,
  status: CraftToolCallStart["status"] | CraftToolCallProgress["status"],
): Map<string, SubagentState> {
  return withEntry(subagents, subagentSessionId, (entry) => ({
    ...entry,
    parentToolCallId: entry.parentToolCallId ?? (toolCallId || null),
    status: taskStatusToSubagentStatus(status, entry.status),
  }));
}

function taskStatusToSubagentStatus(
  status: CraftToolCallStart["status"] | CraftToolCallProgress["status"],
  current: SubagentStatus,
): SubagentStatus {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  return current; // pending/in_progress leave the inferred state alone
}

/** Route one text/thought chunk into a subagent's transcript. */
export function appendSubagentTextChunk(
  subagents: Map<string, SubagentState>,
  sessionId: string,
  kind: "text" | "thinking",
  text: string,
): Map<string, SubagentState> {
  if (!text) return subagents;
  return withEntry(subagents, sessionId, (entry) => ({
    ...entry,
    streamItems: appendChunkToItems(entry.streamItems, kind, text),
  }));
}

/** Route one tool packet into a subagent's transcript. */
export function upsertSubagentToolPacket(
  subagents: Map<string, SubagentState>,
  sessionId: string,
  packet: CraftToolCallStart | CraftToolCallProgress,
): Map<string, SubagentState> {
  return withEntry(subagents, sessionId, (entry) => ({
    ...entry,
    streamItems:
      packet.type === "tool_call_start"
        ? appendToolStartToItems(entry.streamItems, packet)
        : upsertToolProgressToItems(entry.streamItems, packet),
  }));
}

/** Settle every subagent's open streaming blocks (the turn ended for them too). */
export function closeSubagentStreams(
  subagents: Map<string, SubagentState>,
): Map<string, SubagentState> {
  let changed = false;
  const next = new Map<string, SubagentState>();
  for (const [id, entry] of subagents) {
    const items = closeStreamingItems(entry.streamItems);
    if (items !== entry.streamItems) {
      changed = true;
      next.set(id, { ...entry, streamItems: items });
    } else {
      next.set(id, entry);
    }
  }
  return changed ? next : subagents;
}
