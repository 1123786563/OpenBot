/**
 * HTTP client for `opencode serve` inside the sandbox — the only transport craft uses to drive
 * in-sandbox agent turns. Ported one-for-one from onyx `serve_client.py`.
 *
 * The load-bearing part is `translateOpencodeEvent`: a pure function turning one opencode
 * `/event` payload into zero-or-more sandbox events, with delta/updated reconciliation
 * (gap-fill), part-type routing, the exactly-once terminator, assistant-role filtering, and
 * subagent `_meta` routing. Every branch mirrors the Python original; behavioral parity is the
 * product.
 *
 * HTTP layer: fetch, with every endpoint carrying `?directory=` — opencode-serve scopes its
 * session store per-directory through that parameter, and omitting it silently lands the call
 * on the default instance (the subtlest bug in the original; every request here passes it).
 */

import type { CraftConfig } from "../config";
import {
  compactionPacket,
  contextUsagePacket,
  isBuildPacket,
  type CompactionPacket,
  type ContextUsagePacket,
  type SubagentStartedPacket,
} from "../events/packets";
import {
  SSEKeepalive,
  TURN_ERROR_CODE_SESSION,
  TURN_ERROR_CODE_TIMEOUT,
  TURN_ERROR_CODE_TRANSPORT,
  activityTimeoutError,
  isActivityTimeout,
  isPromptResponse,
  isSandboxError,
  type AgentMessageChunk,
  type AgentThoughtChunk,
  type PromptResponse,
  type SandboxError,
  type SandboxEvent,
  type ToolCallProgress,
  type ToolCallStart,
  type ToolCallStatus,
} from "../events/types";
import {
  POD_EVENT_BUS_CLOSED,
  type PodEventBus,
  type PodSubscription,
} from "./event-bus";

/** A session-relative file to include in an opencode prompt. */
export type PromptAttachment = {
  name: string;
  path: string;
  mimeType: string;
};

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Tool-name mapping. Mirrors the frontend's NAME_MAP / TOOL_KIND_MAP so the
// translator emits the same {kind, title} the existing UI expects.
// ---------------------------------------------------------------------------

const TOOL_KIND: Record<string, ToolCallStart["kind"]> = {
  bash: "execute",
  read: "read",
  write: "edit",
  edit: "edit",
  patch: "edit",
  apply_patch: "edit",
  applypatch: "edit",
  glob: "search",
  grep: "search",
  list: "search",
  task: "other",
  todowrite: "other",
  todo_write: "other",
  webfetch: "fetch",
  websearch: "search",
  // opencode 1.15.x additions:
  lsp: "other",
  skill: "other",
  question: "other",
  invalid: "other",
};

const TOOL_TITLE: Record<string, string> = {
  bash: "Running command",
  read: "Reading",
  write: "Writing",
  edit: "Editing",
  patch: "Editing",
  apply_patch: "Applying patch",
  applypatch: "Applying patch",
  glob: "Searching files",
  grep: "Searching content",
  list: "Listing",
  task: "Running task",
  todowrite: "Updating todos",
  todo_write: "Updating todos",
  webfetch: "Fetching web content",
  websearch: "Searching web",
  // opencode 1.15.x additions:
  lsp: "Checking code",
  skill: "Running skill",
  question: "Asking",
  invalid: "Validating",
};

const toolKind = (tool: string): ToolCallStart["kind"] =>
  TOOL_KIND[tool] ?? "other";

const toolTitle = (tool: string): string => TOOL_TITLE[tool] ?? "Running tool";

// opencode's tool status values → ToolCallStatus literal.
// opencode emits: "pending", "running", "completed", "error". "running" → "in_progress".
const TOOL_STATUS_MAP: Record<string, ToolCallStatus> = {
  pending: "pending",
  running: "in_progress",
  in_progress: "in_progress",
  completed: "completed",
  failed: "failed",
  error: "failed",
  cancelled: "failed",
};

function toolStatus(opencodeStatus: unknown): ToolCallStatus {
  if (typeof opencodeStatus !== "string") return "pending";
  return TOOL_STATUS_MAP[opencodeStatus] ?? "pending";
}

// ---------------------------------------------------------------------------
// Tool-call `content[]` synthesis — opencode emits state.{input,output,metadata},
// the consumer reads a content array; build the expected shape from the
// empirical field names locked in onyx's test report.
// ---------------------------------------------------------------------------

function synthesizeToolContent(
  tool: string,
  state: Json,
): ToolCallStart["content"] | undefined {
  const inp = (state.input ?? {}) as Json;

  // Edit tool: oldString/newString → {type: diff, oldText, newText, path}
  if (tool === "edit" || tool === "patch") {
    const filePath =
      (inp.filePath as string) ||
      (inp.file_path as string) ||
      (inp.path as string) ||
      "";
    const old =
      (inp.oldString as string) ||
      (inp.oldText as string) ||
      (inp.old_string as string) ||
      "";
    const newText =
      (inp.newString as string) ||
      (inp.newText as string) ||
      (inp.new_string as string) ||
      "";
    if (filePath || old || newText) {
      return [{ type: "diff", path: filePath, oldText: old, newText }];
    }
    return undefined;
  }

  // Read tool: state.output is a line-numbered string; the frontend strips numbering.
  if (tool === "read") {
    const out = state.output;
    if (typeof out === "string") {
      return [{ type: "content", content: { type: "text", text: out } }];
    }
    return undefined;
  }

  return undefined;
}

function wrapRawOutput(state: Json): ToolCallStart["rawOutput"] | undefined {
  let out: unknown = state.output;
  if (out === null || out === undefined) {
    const err = state.error;
    if (typeof err === "string" && err) out = err;
    else return undefined;
  }
  if (typeof out === "string") {
    const wrapped: Record<string, unknown> = { output: out };
    const metadata = state.metadata;
    if (metadata !== undefined && metadata !== null) wrapped.metadata = metadata;
    return wrapped as ToolCallStart["rawOutput"];
  }
  if (typeof out === "object") return out as ToolCallStart["rawOutput"];
  return { output: String(out) };
}

// ---------------------------------------------------------------------------
// Per-turn state. Threaded through the reader so translation is correlation-
// aware (idempotent ToolCallStart, terminator de-dup, gap-fill accumulators).
// ---------------------------------------------------------------------------

export class TurnState {
  readonly sessionId: string;
  /** ToolCallStart is emitted only on the FIRST sighting of a callID. */
  seenToolCalls = new Set<string>();
  /** PromptResponse is yielded at most once per turn; backstop signals are no-ops after. */
  terminatorYielded = false;
  /**
   * Per-text-partID accumulator: how much of each part we already yielded. Gap-fills when a
   * `message.part.updated` reveals more text than we delivered (after an /event reconnect).
   */
  localText = new Map<string, string>();
  /** MessageIDs of every assistant message in this turn; others are filtered. */
  assistantMessageIds = new Set<string>();
  /** partID → "text" | "reasoning" | "tool" | … (the delta routes on this). */
  partTypes = new Map<string, string>();
  /** MessageIDs ruled out as assistant (user role, malformed, failed fetch) — cached. */
  userMessageIds = new Set<string>();
  /** `task` callID → claimed child session (parallel tasks get distinct children). */
  taskChildByCall = new Map<string, string>();
  /** Descendant sessions get their own caches; ids don't cross sessions. */
  childStates = new Map<string, TurnState>();
  /** Last LLM finish reason on any assistant message.updated; only the terminator consumes it. */
  lastFinish: string | null = null;
  /** Summary (compaction) message ids seen from BOTH message.updated and hydration. */
  summaryMessageIds = new Set<string>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }
}

/** Merge routing metadata into an event's `_meta` in place (merge, never overwrite). */
function mergeFieldMeta(
  event: Exclude<SandboxEvent, SSEKeepalive>,
  extra: Record<string, unknown>,
): void {
  const existing = event._meta;
  event._meta = {
    ...(typeof existing === "object" && existing !== null ? existing : {}),
    ...extra,
  };
}

function stateForSession(state: TurnState, sessionId: string): TurnState {
  if (sessionId === state.sessionId) return state;
  let child = state.childStates.get(sessionId);
  if (!child) {
    child = new TurnState(sessionId);
    state.childStates.set(sessionId, child);
  }
  return child;
}

/** REST-fetch a message, populate caches, return role (or null). Negative results cached. */
function hydrateMessage(
  state: TurnState,
  messageId: string,
  fetchMessage: FetchMessage | null,
): string | null {
  if (fetchMessage === null) {
    state.userMessageIds.add(messageId);
    return null;
  }
  const body = fetchMessage(messageId);
  if (!body) {
    state.userMessageIds.add(messageId);
    return null;
  }
  const info = body.info;
  if (!(info instanceof Object)) {
    state.userMessageIds.add(messageId);
    return null;
  }
  const role = (info as Json).role;
  if (role === "assistant") {
    state.assistantMessageIds.add(messageId);
    if ((info as Json).summary === true) state.summaryMessageIds.add(messageId);
  } else {
    state.userMessageIds.add(messageId);
    if (role !== "user") return null;
  }
  const parts = body.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!(part instanceof Object)) continue;
      const partId = (part as Json).id;
      const partType = (part as Json).type;
      if (typeof partId === "string" && typeof partType === "string") {
        state.partTypes.set(partId, partType);
      }
    }
  }
  return typeof role === "string" ? role : null;
}

/** True if messageId is a known assistant message, hydrating once if needed. */
function isAssistantMessage(
  state: TurnState,
  messageId: unknown,
  fetchMessage: FetchMessage | null,
): boolean {
  if (typeof messageId !== "string") return false;
  if (state.assistantMessageIds.has(messageId)) return true;
  if (state.userMessageIds.has(messageId)) return false;
  return hydrateMessage(state, messageId, fetchMessage) === "assistant";
}

const isSummaryMessage = (state: TurnState, messageId: unknown): boolean =>
  typeof messageId === "string" && state.summaryMessageIds.has(messageId);

/** Routing meta an event carries (or null): the subagent tags the frontend routes on. */
export function routingMetaOf(
  event: SandboxEvent,
): Record<string, unknown> | null {
  if (event instanceof SSEKeepalive) return null;
  const meta = event._meta;
  if (!(meta instanceof Object)) return null;
  const routing: Record<string, unknown> = {};
  const sessionId = meta.sessionId;
  const parentSessionId = meta.parentSessionId;
  if (typeof sessionId === "string" && sessionId) routing.sessionId = sessionId;
  if (typeof parentSessionId === "string" && parentSessionId)
    routing.parentSessionId = parentSessionId;
  return Object.keys(routing).length > 0 ? routing : null;
}

export type FetchMessage = (messageId: string) => Json | null;

/** Emit a text delta routed by the PART's type (delta events carry only the part id). */
function* emitTextDelta(
  props: Json,
  state: TurnState,
  fetchMessage: FetchMessage | null,
): Generator<SandboxEvent> {
  const fieldName = props.field;
  const delta = props.delta;
  const partId = props.partID;
  const messageId = props.messageID;
  if (typeof delta !== "string" || typeof partId !== "string") return;
  if (!delta) return;
  // Assistant-only filter. Deltas race ~300ms ahead of message.updated;
  // isAssistantMessage hydrates via REST when the role is unknown.
  if (!isAssistantMessage(state, messageId, fetchMessage)) return;
  if (typeof messageId === "string" && state.summaryMessageIds.has(messageId))
    return;
  if (fieldName !== "text") {
    // Non-text fields (tool input streaming, future extensions): no mapping yet, drop.
    return;
  }
  // Route by the PART'S TYPE (the delta's `field` is always "text" — the part
  // attribute being updated). Reasoning content lives on type=reasoning parts.
  const partType = state.partTypes.get(partId) ?? "text";
  if (partType === "reasoning") {
    state.localText.set(partId, (state.localText.get(partId) ?? "") + delta);
    yield {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: delta },
    } satisfies AgentThoughtChunk;
  } else if (partType === "text") {
    state.localText.set(partId, (state.localText.get(partId) ?? "") + delta);
    yield {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: delta },
    } satisfies AgentMessageChunk;
  }
  // Other part types (step-start, step-finish, tool, ...) carry no user-visible text.
}

function contextUsageFromInfo(info: Json): ContextUsagePacket | null {
  if (info.summary === true) return null;
  const tokens = info.tokens;
  if (!(tokens instanceof Object)) return null;
  const t = tokens as Json;
  const cache = t.cache instanceof Object ? (t.cache as Json) : {};

  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

  const used =
    num(t.input) +
    num(t.output) +
    num(t.reasoning) +
    num(cache.read) +
    num(cache.write);
  if (used <= 0) return null;
  const cost = info.cost;
  return contextUsagePacket(
    used,
    typeof cost === "number" && Number.isFinite(cost) ? cost : null,
  );
}

function fetchSummaryText(
  state: TurnState,
  fetchMessage: FetchMessage | null,
): string | null {
  if (fetchMessage === null || state.summaryMessageIds.size === 0) return null;
  const texts: string[] = [];
  for (const messageId of state.summaryMessageIds) {
    const body = fetchMessage(messageId);
    if (!(body instanceof Object)) continue;
    const parts = body.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const json = part instanceof Object ? (part as Json) : null;
      if (
        json &&
        json.type === "text" &&
        typeof json.text === "string" &&
        json.text
      ) {
        texts.push(json.text);
      }
    }
  }
  return texts.length > 0 ? texts.join("\n\n") : null;
}

/** True if `sessionId` descends from `ancestorId` via the child→parent chain; cycle-safe. */
function isDescendantOf(
  sessionId: string,
  ancestorId: string,
  parentResolver: ParentResolver | null,
): boolean {
  if (parentResolver === null) return false;
  const seen = new Set<string>([sessionId]);
  let parent = parentResolver(sessionId);
  while (parent !== null && !seen.has(parent)) {
    if (parent === ancestorId) return true;
    seen.add(parent);
    parent = parentResolver(parent);
  }
  return false;
}

export type ParentResolver = (sessionId: string) => string | null;
export type ChildrenResolver = (sessionId: string) => string[];

/** Shared gap-fill: emit the tail of `part.text` we haven't yielded as deltas. */
function* reconcilePartText(
  part: Json,
  state: TurnState,
  build: (text: string) => AgentMessageChunk | AgentThoughtChunk,
): Generator<SandboxEvent> {
  const partId = part.id;
  if (typeof partId !== "string") return;
  const expected = part.text;
  if (typeof expected !== "string") return;
  const local = state.localText.get(partId) ?? "";
  if (expected.length > local.length) {
    const tail = expected.slice(local.length);
    state.localText.set(partId, expected);
    if (tail) yield build(tail);
  }
  // Server-side rewind (expected < local): trust the longer local accumulator —
  // it has already been streamed (onyx logs a warning here; output parity kept).
}

function* reconcileTextPart(
  part: Json,
  state: TurnState,
): Generator<SandboxEvent> {
  yield* reconcilePartText(part, state, (text) => ({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  }));
}

function* reconcileReasoningPart(
  part: Json,
  state: TurnState,
): Generator<SandboxEvent> {
  yield* reconcilePartText(part, state, (text) => ({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
  }));
}

/** Emit ToolCallStart (first sighting) and/or ToolCallProgress for a tool part update. */
function* emitToolEvents(part: Json, state: TurnState): Generator<SandboxEvent> {
  const callId = part.callID;
  const tool = part.tool;
  if (typeof callId !== "string" || typeof tool !== "string") return;

  const partState = (part.state ?? {}) as Json;
  if (!(partState instanceof Object)) return;

  const rawStatus = partState.status;
  let status = toolStatus(rawStatus);
  if (status === "completed") {
    const metadata = partState.metadata;
    const exitCode =
      metadata instanceof Object ? (metadata as Json).exit : undefined;
    if (typeof exitCode === "number" && exitCode !== 0) status = "failed";
  }
  const rawInput = partState.input ?? undefined;
  const rawOutput = wrapRawOutput(partState);
  const content = synthesizeToolContent(tool, partState);

  const common = {
    toolCallId: callId,
    title: toolTitle(tool),
    kind: toolKind(tool),
    status,
    // _meta is ACP's extensibility field: carry the raw tool name so the
    // frontend resolves a precise title for kind="other" tools.
    _meta: { toolName: tool } as Record<string, unknown>,
    ...(rawInput !== undefined ? { rawInput } : {}),
    ...(rawOutput !== undefined ? { rawOutput } : {}),
    ...(content !== undefined ? { content } : {}),
  };

  if (!state.seenToolCalls.has(callId)) {
    state.seenToolCalls.add(callId);
    yield { sessionUpdate: "tool_call", ...common } satisfies ToolCallStart;
    // First sighting may already carry non-pending state — follow with progress
    // so the consumer sees both lifecycle stages.
    if (rawStatus !== "pending") {
      yield {
        sessionUpdate: "tool_call_update",
        ...common,
      } satisfies ToolCallProgress;
    }
  } else {
    yield { sessionUpdate: "tool_call_update", ...common } satisfies ToolCallProgress;
  }
}

/** Yield PromptResponse (or Error) exactly once per turn; later calls are no-ops. */
function* emitTerminator(
  state: TurnState,
  error: Json | null = null,
  finish: unknown = null,
): Generator<SandboxEvent> {
  if (state.terminatorYielded) return;
  state.terminatorYielded = true;

  if (error) {
    // An aborted message is a cancellation (user interrupt), not a turn failure.
    if (error.name === "MessageAbortedError") {
      yield { stopReason: "cancelled" } satisfies PromptResponse;
      return;
    }
    let message = "";
    const data = error.data;
    if (data instanceof Object) {
      const inner = (data as Json).message;
      if (typeof inner === "string") message = inner;
    }
    if (!message) {
      message =
        typeof error.name === "string" && error.name ? error.name : "session error";
    }
    yield { code: TURN_ERROR_CODE_SESSION, message } satisfies SandboxError;
    return;
  }

  let stopReason = "end_turn";
  if (typeof finish === "string" && finish.length > 0) {
    if (
      finish === "max_tokens" ||
      finish === "max_turn_requests" ||
      finish === "refusal" ||
      finish === "cancelled"
    ) {
      stopReason = finish;
    } else {
      // opencode's "stop" maps to the schema's "end_turn"; unknown values keep it.
      stopReason = "end_turn";
    }
  }
  yield { stopReason } satisfies PromptResponse;
}

/**
 * Convert one opencode `/event` payload into zero-or-more sandbox events.
 *
 * Pure over `raw` (mutates `state`). All field access defensive against unexpected shapes.
 * `parentResolver` (child→parent) recognizes descendant-subagent events — their tool events
 * are forwarded tagged with routing metadata instead of dropped. `childrenResolver`
 * (parent→children) tags the parent's `task` tool event with the subagent it spawned.
 */
export function* translateOpencodeEvent(
  raw: Json,
  state: TurnState,
  options: {
    fetchMessage?: FetchMessage | null;
    parentResolver?: ParentResolver | null;
    childrenResolver?: ChildrenResolver | null;
    fetchMessageBySession?: ((sessionId: string, messageId: string) => Json | null) | null;
  } = {},
): Generator<SandboxEvent | SubagentStartedPacket | ContextUsagePacket | CompactionPacket> {
  const fetchMessage = options.fetchMessage ?? null;
  const parentResolver = options.parentResolver ?? null;
  const childrenResolver = options.childrenResolver ?? null;
  const fetchMessageBySession = options.fetchMessageBySession ?? null;

  const eventType = raw.type;
  if (typeof eventType !== "string") return;

  const props = (raw.properties ?? {}) as Json;
  if (!(props instanceof Object)) return;

  // Our session's events must match by sessionID — some nest it under
  // properties.info.sessionID, others carry properties.sessionID; check both.
  let sessionId = props.sessionID;
  if (sessionId === undefined || sessionId === null) {
    const info = props.info;
    if (info instanceof Object) sessionId = (info as Json).sessionID;
  }

  if (eventType === "session.created") {
    const info = props.info;
    if (!(info instanceof Object)) return;
    const childId = (info as Json).id;
    const parentId = (info as Json).parentID;
    if (
      typeof childId === "string" &&
      typeof parentId === "string" &&
      parentId === state.sessionId
    ) {
      yield subagentPacket(childId, parentId);
    }
    return;
  }

  if (typeof sessionId === "string" && sessionId !== state.sessionId) {
    // Event from another session: forward descendant text/thought/tool events
    // tagged so the frontend routes them to the live subagent.
    if (!isDescendantOf(sessionId, state.sessionId, parentResolver)) {
      return; // unrelated session — drop
    }

    const childMeta: Record<string, unknown> = {
      sessionId,
      parentSessionId: state.sessionId,
    };
    const childState = stateForSession(state, sessionId);

    if (eventType === "message.updated") {
      const info = props.info;
      if (!(info instanceof Object)) return;
      if ((info as Json).role !== "assistant") return;
      const messageId = (info as Json).id;
      if (typeof messageId === "string") {
        childState.assistantMessageIds.add(messageId);
      }
      return;
    }

    const childFetchMessage: FetchMessage | null =
      fetchMessageBySession !== null
        ? (messageId) => fetchMessageBySession(sessionId, messageId)
        : null;

    if (eventType === "message.part.delta") {
      for (const event of emitTextDelta(props, childState, childFetchMessage)) {
        if (!(event instanceof SSEKeepalive)) mergeFieldMeta(event, childMeta);
        yield event;
      }
      return;
    }

    if (eventType !== "message.part.updated") return;

    const part = (props.part ?? {}) as Json;
    if (!(part instanceof Object)) return;

    const partType = part.type;
    const partIdForState = part.id;
    if (typeof partIdForState === "string" && typeof partType === "string") {
      childState.partTypes.set(partIdForState, partType);
    }

    let events: Generator<SandboxEvent>;
    if (partType === "reasoning") {
      if (!isAssistantMessage(childState, part.messageID, childFetchMessage)) return;
      events = reconcileReasoningPart(part, childState);
    } else if (partType === "text") {
      if (!isAssistantMessage(childState, part.messageID, childFetchMessage)) return;
      events = reconcileTextPart(part, childState);
    } else if (partType === "tool") {
      events = emitToolEvents(part, childState);
    } else {
      return;
    }

    for (const event of events) {
      if (!(event instanceof SSEKeepalive)) mergeFieldMeta(event, childMeta);
      yield event;
    }
    return;
  }

  // ── streaming text deltas ────────────────────────────────────────────
  if (eventType === "message.part.delta") {
    yield* emitTextDelta(props, state, fetchMessage);
    return;
  }

  // ── part lifecycle (tool calls + gap-fill anchors for text parts) ──
  if (eventType === "message.part.updated") {
    const part = (props.part ?? {}) as Json;
    if (!(part instanceof Object)) return;
    const partType = part.type;

    // Record the part's type so later `message.part.delta` events route
    // correctly (deltas carry only the part id, not its type).
    const partIdForState = part.id;
    if (typeof partIdForState === "string" && typeof partType === "string") {
      state.partTypes.set(partIdForState, partType);
    }

    if (partType === "reasoning") {
      if (!isAssistantMessage(state, part.messageID, fetchMessage)) return;
      if (isSummaryMessage(state, part.messageID)) return;
      yield* reconcileReasoningPart(part, state);
      return;
    }

    if (partType === "text") {
      if (!isAssistantMessage(state, part.messageID, fetchMessage)) return;
      if (isSummaryMessage(state, part.messageID)) return;
      yield* reconcileTextPart(part, state);
      return;
    }

    if (partType === "tool") {
      // Tag the parent's `task` tool event with the subagent session it
      // spawned so the frontend links the call to its child stream.
      let subagentSessionId: string | null = null;
      if (part.tool === "task" && childrenResolver !== null) {
        // Each task callID claims the most-recent not-yet-claimed child.
        const callId = part.callID;
        if (typeof callId === "string" && state.taskChildByCall.has(callId)) {
          subagentSessionId = state.taskChildByCall.get(callId) ?? null;
        } else {
          const claimed = new Set(state.taskChildByCall.values());
          const unclaimed = childrenResolver(state.sessionId).filter(
            (child) => !claimed.has(child),
          );
          if (unclaimed.length > 0) {
            subagentSessionId = unclaimed[unclaimed.length - 1];
            if (typeof callId === "string") {
              state.taskChildByCall.set(callId, subagentSessionId);
            }
          }
        }
      }
      for (const event of emitToolEvents(part, state)) {
        if (
          subagentSessionId !== null &&
          !(event instanceof SSEKeepalive)
        ) {
          mergeFieldMeta(event, { subagentSessionId });
        }
        yield event;
      }
      return;
    }

    // Reasoning parts stream via message.part.delta with field=reasoning;
    // their updated lifecycle is ignored.
    return;
  }

  // ── role caching + error termination ─────────────────────────────────
  // NOT a turn terminator: opencode emits time.completed on EVERY step's
  // assistant message. The end-of-turn signal is session.status:idle below.
  if (eventType === "message.updated") {
    const info = props.info;
    if (!(info instanceof Object)) return;
    const json = info as Json;
    if (json.role !== "assistant") return;
    const messageId = json.id;
    if (typeof messageId === "string") {
      state.assistantMessageIds.add(messageId);
      if (json.summary === true) state.summaryMessageIds.add(messageId);
    }
    const finish = json.finish;
    if (typeof finish === "string") state.lastFinish = finish;
    const usage = contextUsageFromInfo(json);
    if (usage !== null) yield usage;
    // A message error DOES kill the turn — surface it.
    const err = json.error;
    if (err instanceof Object && err !== null) {
      yield* emitTerminator(state, err as Json, finish);
    }
    return;
  }

  // ── turn terminators ─────────────────────────────────────────────────
  // Mirrors opencode's CLI (cmd/run.ts): session.status.status is
  // {type: "idle"|"busy"|…} — match on status.type, not the outer string.
  if (eventType === "session.idle") {
    yield* emitTerminator(state, null, state.lastFinish);
    return;
  }
  if (eventType === "session.status") {
    const status = props.status;
    if (status instanceof Object && (status as Json).type === "idle") {
      yield* emitTerminator(state, null, state.lastFinish);
    }
    return;
  }

  // ── error envelope ───────────────────────────────────────────────────
  if (eventType === "session.error") {
    const err = props.error;
    if (err instanceof Object && err !== null) {
      yield* emitTerminator(state, err as Json);
    }
    return;
  }

  if (eventType === "session.compacted") {
    yield compactionPacket(fetchSummaryText(state, fetchMessage));
    return;
  }

  // Everything else (server.heartbeat, session.diff, session.updated,
  // session.next.*.switched, …) is informational — ignored.
}

function subagentPacket(childId: string, parentId: string): SubagentStartedPacket {
  return {
    packetKind: "subagent_started",
    type: "subagent_started",
    subagent_session_id: childId,
    parent_session_id: parentId,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// OpencodeServeClient — fetch-based HTTP over the agent-sandbox gateway.
// ---------------------------------------------------------------------------

export class OpencodeHttpError extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${op} failed with HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "OpencodeHttpError";
  }
}

export type OpencodeServeClientOptions = {
  baseUrl: string;
  config: CraftConfig;
  /** Token the agent-sandbox gateway authenticates (x-sandbox-token shape). */
  token?: string | null;
  /** Which Bot's sandbox every request targets (x-openbot-bot-id shape). */
  botId?: string | null;
  eventBus?: PodEventBus | null;
  fetchImpl?: typeof fetch;
};

/** Cold-pod retry tunables — short window, total worst-case ~1.5s (onyx parity). */
const COLD_POD_RETRIES = 3;
const COLD_POD_BASE_DELAY_MS = 250;

export class OpencodeServeClient {
  private readonly base: string;
  private readonly config: CraftConfig;
  private readonly token: string | null;
  private readonly botId: string | null;
  private readonly bus: PodEventBus | null;
  private readonly doFetch: typeof fetch;

  constructor(options: OpencodeServeClientOptions) {
    this.base = options.baseUrl.replace(/\/$/, "");
    this.config = options.config;
    this.token = options.token ?? null;
    this.botId = options.botId ?? null;
    this.bus = options.eventBus ?? null;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.token) headers["x-sandbox-token"] = this.token;
    if (this.botId) headers["x-openbot-bot-id"] = this.botId;
    return headers;
  }

  /**
   * One unary request with cold-pod retry. A connection-refused (the sandbox is up but
   * opencode-serve hasn't bound its port yet) proves the server never saw the request, so the
   * retry can never duplicate side effects — always retried. "server disconnected before a
   * response" is retried only when `idempotent` (a half-handled POST could leak an orphan
   * opencode session otherwise). HTTP error responses are never retried — they are
   * application-level signals.
   */
  private async request(
    method: string,
    path: string,
    options: {
      body?: unknown;
      idempotent?: boolean;
      query?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ): Promise<Response> {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const init: RequestInit = {
      method,
      headers: this.buildHeaders(
        options.body === undefined ? undefined : { "content-type": "application/json" },
      ),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(
        (options.timeoutMs ?? this.config.opencodeServeRequestTimeoutSeconds * 1000),
      ),
    };

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.doFetch(url.toString(), init);
      } catch (error) {
        const retryable =
          isColdPodError(error) ||
          (options.idempotent === true && isPrematureClose(error));
        if (!retryable || attempt >= COLD_POD_RETRIES) throw error;
        await sleep(COLD_POD_BASE_DELAY_MS * (attempt + 1));
      }
    }
  }

  /** GET /doc status, or null on transport error — readiness probes distinguish 401 from not-listening. */
  async healthCheckStatus(): Promise<number | null> {
    try {
      const response = await this.doFetch(`${this.base}/doc`, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(
          this.config.opencodeServeConnectTimeoutSeconds * 1000,
        ),
      });
      return response.status;
    } catch {
      return null;
    }
  }

  async healthCheck(): Promise<boolean> {
    return (await this.healthCheckStatus()) === 200;
  }

  /**
   * Return a valid opencode session id; idempotent across callers. A missing id is minted; a
   * persisted-but-404 id is re-minted (the caller persists it back). Non-404 lookup failures
   * raise — masking a runtime outage as "create a new session" would orphan history.
   *
   * `directory` anchors the opencode Instance: opencode-serve scopes its session store
   * per-directory via `?directory=` on every route; the body field is silently ignored.
   */
  async ensureSession(
    opencodeSessionId: string | null,
    options: { directory: string; title?: string },
  ): Promise<string> {
    const query = { directory: options.directory };
    if (opencodeSessionId) {
      // GET is idempotent — safe to retry on premature close too.
      const response = await this.request(
        "GET",
        `/session/${encodeURIComponent(opencodeSessionId)}`,
        { idempotent: true, query },
      );
      if (response.status === 200) return opencodeSessionId;
      if (response.status !== 404) {
        throw new OpencodeHttpError(
          "session lookup",
          response.status,
          await response.text().catch(() => ""),
        );
      }
      // 404 → fall through and create.
    }

    // POST /session is NOT idempotent — opencode mints a new id per request;
    // only connection-refused (server never saw it) is retried.
    const response = await this.request("POST", "/session", {
      query,
      body: options.title ? { title: options.title } : {},
    });
    if (!response.ok) {
      throw new OpencodeHttpError(
        "session create",
        response.status,
        await response.text().catch(() => ""),
      );
    }
    const data = (await response.json().catch(() => ({}))) as Json;
    const newId = data.id;
    if (typeof newId !== "string" || !newId) {
      throw new Error("opencode /session returned no id");
    }
    return newId;
  }

  /** Best-effort delete; product deletion is owned by the craft_sessions row. */
  async deleteSession(
    opencodeSessionId: string,
    options: { directory: string },
  ): Promise<boolean> {
    let response: Response;
    try {
      response = await this.request(
        "DELETE",
        `/session/${encodeURIComponent(opencodeSessionId)}`,
        { idempotent: true, query: { directory: options.directory } },
      );
    } catch {
      return false;
    }
    return [200, 204, 404].includes(response.status);
  }

  /** Dispose the directory-scoped runtime so opencode reloads managed files. */
  async disposeInstance(options: { directory: string }): Promise<void> {
    const response = await this.request("POST", "/instance/dispose", {
      idempotent: true,
      query: { directory: options.directory },
    });
    if (!response.ok) {
      throw new OpencodeHttpError(
        "instance dispose",
        response.status,
        await response.text().catch(() => ""),
      );
    }
  }

  /** Snapshot the assistant message accumulator; post-terminator reconnect fallback. */
  async listMessages(
    opencodeSessionId: string,
    options: { directory: string },
  ): Promise<Json[]> {
    const response = await this.request(
      "GET",
      `/session/${encodeURIComponent(opencodeSessionId)}/message`,
      { idempotent: true, query: { directory: options.directory } },
    );
    if (!response.ok) {
      throw new OpencodeHttpError(
        "session messages",
        response.status,
        await response.text().catch(() => ""),
      );
    }
    const data = await response.json().catch(() => null);
    return Array.isArray(data) ? (data as Json[]) : [];
  }

  /** Best-effort abort of the in-flight prompt; abort is idempotent upstream. */
  async abort(
    opencodeSessionId: string,
    options: { directory: string },
  ): Promise<void> {
    try {
      await this.doFetch(
        `${this.base}/session/${encodeURIComponent(opencodeSessionId)}/abort?directory=${encodeURIComponent(options.directory)}`,
        {
          method: "POST",
          headers: this.buildHeaders({ "content-type": "application/json" }),
          body: "{}",
          signal: AbortSignal.timeout(
            this.config.opencodeServeRequestTimeoutSeconds * 1000,
          ),
        },
      );
    } catch {
      // Best-effort by contract.
    }
  }

  /** GET one message; null on any failure (never throws — hydration is advisory). */
  async getMessage(
    opencodeSessionId: string,
    messageId: string,
    options: { directory: string },
  ): Promise<Json | null> {
    let response: Response;
    try {
      response = await this.request(
        "GET",
        `/session/${encodeURIComponent(opencodeSessionId)}/message/${encodeURIComponent(messageId)}`,
        { idempotent: true, query: { directory: options.directory } },
      );
    } catch {
      return null;
    }
    if (response.status !== 200) return null;
    const body = await response.json().catch(() => null);
    return body instanceof Object && body !== null ? (body as Json) : null;
  }

  /** POST /session/{id}/prompt_async. Model override only when both halves are set. */
  private async postPromptAsync(
    opencodeSessionId: string,
    message: string,
    modelProvider: string | null,
    modelId: string | null,
    options: {
      attachments?: PromptAttachment[];
      directory: string;
    },
  ): Promise<void> {
    const parts: Array<Record<string, string>> = [{ type: "text", text: message }];
    for (const attachment of options.attachments ?? []) {
      parts.push({
        type: "file",
        mime: attachment.mimeType,
        filename: attachment.name,
        url: fileUri(options.directory, attachment.path),
      });
    }
    const body: Record<string, unknown> = { parts };
    if (modelProvider && modelId) {
      body.model = { providerID: modelProvider, modelID: modelId };
    }
    const response = await this.request(
      "POST",
      `/session/${encodeURIComponent(opencodeSessionId)}/prompt_async`,
      { body, query: { directory: options.directory } },
    );
    if (!response.ok) {
      throw new OpencodeHttpError(
        "prompt_async",
        response.status,
        await response.text().catch(() => ""),
      );
    }
  }

  /**
   * Stream one turn of sandbox events via the shared per-pod bus.
   *
   * Teardown semantics: when the caller drops the generator (return/break/throw), the finally
   * block aborts the posted prompt unless `shouldAbortOnTeardown` says a successor owns the
   * session. `timeoutMs` is renewed by scoped activity; `absoluteTimeoutMs` stays fixed.
   * Either timeout aborts and yields an Error.
   */
  async *sendMessage(
    opencodeSessionId: string,
    message: string,
    options: {
      directory: string;
      modelProvider?: string | null;
      modelId?: string | null;
      attachments?: PromptAttachment[];
      timeoutMs?: number;
      absoluteTimeoutMs?: number | null;
      shouldInterrupt?: (() => boolean) | null;
      shouldAbortOnTeardown?: (() => boolean) | null;
    },
  ): AsyncGenerator<SandboxEvent | ContextUsagePacket | SubagentStartedPacket | CompactionPacket> {
    if (this.bus === null) {
      throw new Error(
        "OpencodeServeClient.sendMessage requires eventBus; construct the client with one",
      );
    }
    const config = this.config;
    const timeoutMs =
      options.timeoutMs ?? config.opencodePromptInactivityTimeoutSeconds * 1000;
    const turnStartedAt = Date.now();
    let promptPosted = false;

    const sub = this.bus.subscribe(opencodeSessionId);
    try {
      // Wait until the bus reader has /event open, else we'd POST prompt_async and
      // miss the turn's first events. Absorbs reconnect windows within the budget.
      const readinessTimeoutMs = options.absoluteTimeoutMs
        ? Math.min(timeoutMs, options.absoluteTimeoutMs)
        : timeoutMs;
      const ready = yield* this.waitForEventStreamReady(sub, {
        timeoutMs: readinessTimeoutMs,
        turnStartedAt,
        shouldInterrupt: options.shouldInterrupt ?? null,
      });
      if (!ready) return;

      try {
        await this.postPromptAsync(
          opencodeSessionId,
          message,
          options.modelProvider ?? null,
          options.modelId ?? null,
          {
            attachments: options.attachments,
            directory: options.directory,
          },
        );
        promptPosted = true;
      } catch (error) {
        if (error instanceof OpencodeHttpError) {
          yield {
            code: error.status,
            message: error.body.slice(0, 200),
          } satisfies SandboxError;
          return;
        }
        yield {
          code: TURN_ERROR_CODE_TRANSPORT,
          message: `prompt_async failed: ${String(error)}`,
        } satisfies SandboxError;
        return;
      }

      yield* this.consumeFromBus(sub, {
        timeoutMs,
        opencodeSessionId,
        state: new TurnState(opencodeSessionId),
        directory: options.directory,
        absoluteDeadlineMs:
          options.absoluteTimeoutMs != null
            ? turnStartedAt + options.absoluteTimeoutMs
            : null,
        shouldInterrupt: options.shouldInterrupt ?? null,
      });
    } finally {
      // Teardown: abort the posted prompt unless a successor owns the session
      // (a runner that lost turn ownership must not abort its successor's turn).
      const shouldAbort =
        !options.shouldAbortOnTeardown || options.shouldAbortOnTeardown();
      if (promptPosted && shouldAbort) {
        await this.abort(opencodeSessionId, { directory: options.directory });
      }
      this.bus.unsubscribe(sub);
    }
  }

  private async *waitForEventStreamReady(
    sub: PodSubscription,
    options: {
      timeoutMs: number;
      turnStartedAt: number;
      shouldInterrupt: (() => boolean) | null;
    },
  ): AsyncGenerator<SandboxEvent, boolean> {
    if (this.bus === null) {
      yield {
        code: TURN_ERROR_CODE_TRANSPORT,
        message: "opencode /event bus is unavailable",
      } satisfies SandboxError;
      return false;
    }
    let lastKeepaliveAt = Date.now();
    let lastInterruptCheckAt = lastKeepaliveAt;

    for (;;) {
      if (this.bus.isClosed()) {
        yield {
          code: TURN_ERROR_CODE_TRANSPORT,
          message: "event bus closed before /event stream became ready",
        } satisfies SandboxError;
        return false;
      }
      if (this.bus.streamReady) return true;

      const now = Date.now();
      if (options.shouldInterrupt && now - lastInterruptCheckAt >= 1000) {
        lastInterruptCheckAt = now;
        if (options.shouldInterrupt()) {
          yield { stopReason: "cancelled" } satisfies PromptResponse;
          return false;
        }
      }

      const remainingMs = options.timeoutMs - (now - options.turnStartedAt);
      if (remainingMs <= 0) {
        yield {
          code: TURN_ERROR_CODE_TRANSPORT,
          message: "opencode /event stream did not become ready",
        } satisfies SandboxError;
        return false;
      }

      const waitMs = Math.min(remainingMs, 1000);
      const raw = await sub.queue.shift({ timeoutMs: waitMs });
      if (raw === undefined) {
        if (Date.now() - lastKeepaliveAt >= this.config.sseKeepaliveIntervalSeconds * 1000) {
          yield new SSEKeepalive();
          lastKeepaliveAt = Date.now();
        }
        continue;
      }
      if (raw === POD_EVENT_BUS_CLOSED) {
        yield {
          code: TURN_ERROR_CODE_TRANSPORT,
          message: "event bus closed before /event stream became ready",
        } satisfies SandboxError;
        return false;
      }
      // Pre-prompt events belong to prior activity on this opencode session —
      // not translated. Loop re-checks readiness, timeout, and bus closure.
    }
  }

  private async *consumeFromBus(
    sub: PodSubscription,
    options: {
      timeoutMs: number;
      opencodeSessionId: string;
      state: TurnState;
      directory: string;
      absoluteDeadlineMs: number | null;
      shouldInterrupt: (() => boolean) | null;
    },
  ): AsyncGenerator<SandboxEvent | ContextUsagePacket | SubagentStartedPacket | CompactionPacket> {
    const { state, directory } = options;
    const bus = this.bus;
    const translateOne = (raw: Json) =>
      translateOpencodeEvent(raw, state, {
        fetchMessage: null,
        parentResolver: bus ? (id) => bus.parentOf(id) : null,
        childrenResolver: bus ? (id) => bus.listChildren(id) : null,
        fetchMessageBySession: null,
      });

    let terminatedLocally = false;
    let lastActivityAt = Date.now();
    let lastKeepaliveAt = lastActivityAt;
    let lastInterruptCheckAt = lastActivityAt;

    for (;;) {
      const now = Date.now();
      if (options.shouldInterrupt && now - lastInterruptCheckAt >= 1000) {
        lastInterruptCheckAt = now;
        if (options.shouldInterrupt()) {
          await this.abort(options.opencodeSessionId, { directory });
          yield { stopReason: "cancelled" } satisfies PromptResponse;
          return;
        }
      }

      const inactivityRemainingMs = options.timeoutMs - (now - lastActivityAt);
      const absoluteRemainingMs =
        options.absoluteDeadlineMs !== null
          ? options.absoluteDeadlineMs - now
          : Number.POSITIVE_INFINITY;
      const remainingMs = Math.min(inactivityRemainingMs, absoluteRemainingMs);
      if (remainingMs <= 0) {
        await this.abort(options.opencodeSessionId, { directory });
        if (absoluteRemainingMs <= 0) {
          yield {
            code: TURN_ERROR_CODE_TIMEOUT,
            message: "Turn exceeded maximum duration",
          } satisfies SandboxError;
        } else {
          yield activityTimeoutError("Timeout waiting for activity");
        }
        return;
      }

      const raw = await sub.queue.shift({
        timeoutMs: Math.min(remainingMs, 1000),
      });
      if (raw === undefined) {
        if (Date.now() - lastKeepaliveAt >= this.config.sseKeepaliveIntervalSeconds * 1000) {
          yield new SSEKeepalive();
          lastKeepaliveAt = Date.now();
        }
        continue;
      }
      if (raw === POD_EVENT_BUS_CLOSED) {
        if (!terminatedLocally) {
          yield {
            code: TURN_ERROR_CODE_TRANSPORT,
            message: "event bus closed before terminator",
          } satisfies SandboxError;
        }
        return;
      }

      // server.connected is a bus-internal readiness marker.
      if (raw.type === "server.connected") continue;

      lastActivityAt = Date.now();

      for (const sandboxEvent of translateOne(raw)) {
        const isError = !isBuildPacket(sandboxEvent) && isSandboxError(sandboxEvent);
        const isTerminator =
          (!isBuildPacket(sandboxEvent) && isPromptResponse(sandboxEvent)) ||
          (isError && !isActivityTimeout(sandboxEvent));
        if (isTerminator) {
          terminatedLocally = true;
        }
        yield sandboxEvent;
      }

      // permission.asked: auto-allow in phase 1 (no approvals / connect_app flow
      // here) — opencode.json's permission block pre-approves the known categories;
      // an unexpected one is answered "once" so the turn never wedges on it.
      if (raw.type === "permission.asked") {
        const props = (raw.properties ?? {}) as Json;
        const permissionId = props.id;
        if (typeof permissionId === "string") {
          await this.answerPermission(options.opencodeSessionId, permissionId, {
            allow: true,
            directory,
          });
        }
      }

      if (terminatedLocally) return;
    }
  }

  /** Resolve a pending opencode permission: allow ("once") runs the tool; deny ("reject") surfaces it. */
  async answerPermission(
    sessionId: string,
    permissionId: string,
    options: { allow: boolean; directory: string },
  ): Promise<boolean> {
    try {
      const response = await this.doFetch(
        `${this.base}/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}?directory=${encodeURIComponent(options.directory)}`,
        {
          method: "POST",
          headers: this.buildHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ response: options.allow ? "once" : "reject" }),
          signal: AbortSignal.timeout(
            this.config.opencodeServeRequestTimeoutSeconds * 1000,
          ),
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}

/** `file://` URI for an attachment, rooted at the session directory (onyx's PurePosixPath.as_uri). */
function fileUri(directory: string, path: string): string {
  const clean = `/${directory.replace(/^\/+/, "")}/${path.replace(/^\/+/, "")}`;
  return `file://${encodeURI(clean)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Connection-refused equivalents: the request provably never reached the server. */
function isColdPodError(error: unknown): boolean {
  if (error instanceof Error) {
    // Bun fetch raises TypeError on connect failures (ECONNREFUSED et al).
    const name = error.name;
    if (name === "TypeError" || name === "ConnectError") return true;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH";
  }
  return false;
}

/** "Server disconnected without sending a response" — retryable only for idempotent calls. */
function isPrematureClose(error: unknown): boolean {
  return (
    error instanceof Error && /closed|truncated|reset|premature|abort/i.test(error.message)
  );
}

export { TurnState as OpencodeTurnState };
