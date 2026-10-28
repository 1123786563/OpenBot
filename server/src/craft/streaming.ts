/**
 * The turn-streaming pipeline — ported one-for-one from onyx `session/streaming.py`.
 *
 * Hosts the per-turn state container (`BuildStreamingState`), the event-persistence dispatcher
 * (`persistSandboxEvent` / `finalizePersist`), and the SSE wire serializer (`eventToSse`).
 * These are the behavior contract: the SSE stream and the `craft_messages.message_metadata`
 * rows carry byte-identical packets, so reload/replay reads one source with no translation.
 *
 * Not ported: the approval/connect-app announce merge (onyx's BLPOP poller threads) and the
 * subagent SSE entry point (phase 2 — kept on the roadmap, see docs).
 */

import type { CraftMessageType } from "../db/schema/craft";
import {
  type ApprovalRequestedPacket,
  type BuildPacket,
  type CompactionPacket,
  type ContextUsagePacket,
  isBuildPacket,
} from "./events/packets";
import {
  isActivityTimeout,
  isAgentMessageChunk,
  isAgentPlanUpdate,
  isAgentThoughtChunk,
  isCurrentModeUpdate,
  isKeepalive,
  isPromptResponse,
  isSandboxError,
  isToolCallProgress,
  isToolCallStart,
  type SandboxEvent,
} from "./events/types";
import type { CraftStore } from "./store";

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// BuildStreamingState
// ---------------------------------------------------------------------------

/**
 * Container for accumulating state during sandbox-event streaming: accumulates chunks and
 * tracks pending tool calls until completion. One instance per turn.
 */
export class BuildStreamingState {
  constructor(readonly turnIndex: number) {}

  private messageChunks: string[] = [];
  private thoughtChunks: string[] = [];

  /** For upserting agent_plan_update — track the row id so we update in place. */
  planMessageId: string | null = null;

  /** The turn's latest context-usage packet, persisted once at finalize. */
  latestContextUsage: Json | null = null;

  private lastChunkType: "message" | "thought" | null = null;
  private lastChunkRoutingMeta: Json | null = null;

  addMessageChunk(text: string, routingMeta: Json | null = null): void {
    this.messageChunks.push(text);
    this.lastChunkType = "message";
    this.lastChunkRoutingMeta = routingMeta ? { ...routingMeta } : null;
  }

  addThoughtChunk(text: string, routingMeta: Json | null = null): void {
    this.thoughtChunks.push(text);
    this.lastChunkType = "thought";
    this.lastChunkRoutingMeta = routingMeta ? { ...routingMeta } : null;
  }

  restoreMessageChunks(text: string): void {
    this.messageChunks.unshift(text);
  }

  restoreThoughtChunks(text: string): void {
    this.thoughtChunks.unshift(text);
  }

  /** A synthetic agent_message packet from the accumulated text, or null when empty. */
  finalizeMessageChunks(routingMeta: Json | null = null): Json | null {
    if (this.messageChunks.length === 0) return null;
    const fullText = this.messageChunks.join("");
    const result: Json = {
      type: "agent_message",
      content: { type: "text", text: fullText },
      sessionUpdate: "agent_message",
    };
    const chunkRoutingMeta = routingMeta ?? this.lastChunkRoutingMeta;
    if (chunkRoutingMeta) result._meta = { ...chunkRoutingMeta };
    this.messageChunks = [];
    return result;
  }

  /** A synthetic agent_thought packet from the accumulated text, or null when empty. */
  finalizeThoughtChunks(routingMeta: Json | null = null): Json | null {
    if (this.thoughtChunks.length === 0) return null;
    const fullText = this.thoughtChunks.join("");
    const result: Json = {
      type: "agent_thought",
      content: { type: "text", text: fullText },
      sessionUpdate: "agent_thought",
    };
    const chunkRoutingMeta = routingMeta ?? this.lastChunkRoutingMeta;
    if (chunkRoutingMeta) result._meta = { ...chunkRoutingMeta };
    this.thoughtChunks = [];
    return result;
  }

  /**
   * Whether pending chunks should flush before a new packet: when the packet type changes from
   * message/thought chunks to something else (or to the other chunk type), or when routing
   * changes between parent and subagent chunks.
   */
  shouldFinalizeChunks(
    newPacketType: string,
    routingMeta: Json | null = null,
  ): boolean {
    if (this.lastChunkType === null) return false;
    if (!routingMetaEquals(this.lastChunkRoutingMeta, routingMeta)) return true;
    if (
      this.lastChunkType === "message" &&
      newPacketType !== "agent_message_chunk"
    ) {
      return true;
    }
    if (
      this.lastChunkType === "thought" &&
      newPacketType !== "agent_thought_chunk"
    ) {
      return true;
    }
    return false;
  }

  clearLastChunkType(): void {
    this.lastChunkType = null;
    this.lastChunkRoutingMeta = null;
  }
}

function routingMetaEquals(a: Json | null, b: Json | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => a[key] === b[key]);
}

// ---------------------------------------------------------------------------
// SSE wire serialization — the single seam every downstream shares.
// ---------------------------------------------------------------------------

/** SSE comment line: pushes bytes so idle-timeout killers don't tear down a quiet stream. */
export const SSE_KEEPALIVE = ": keepalive\n\n";

function nowIso(): string {
  return new Date().toISOString();
}

/** The SSE `type` string for a sandbox event (onyx's `_get_event_type`). */
export function getEventType(event: SandboxEvent | BuildPacket): string {
  if (isBuildPacket(event)) return event.type;
  if (isKeepalive(event)) return "unknown";
  if (isAgentMessageChunk(event)) return "agent_message_chunk";
  if (isAgentThoughtChunk(event)) return "agent_thought_chunk";
  if (isToolCallStart(event)) return "tool_call_start";
  if (isToolCallProgress(event)) return "tool_call_progress";
  if (isAgentPlanUpdate(event)) return "agent_plan_update";
  if (isCurrentModeUpdate(event)) return "current_mode_update";
  if (isPromptResponse(event)) return "prompt_response";
  if (isSandboxError(event)) return "error";
  return "unknown";
}

/** Strip the non-wire marker fields before serialization (activityTimeout is executor-only,
 * packetKind is this module's internal discriminant — the wire's `type` says the same thing). */
function wireFields(event: SandboxEvent | BuildPacket): Json {
  if (isKeepalive(event)) return {};
  const { ...rest } = event as unknown as Json;
  if (isActivityTimeout(event)) delete rest.activityTimeout;
  delete rest.packetKind;
  return rest;
}

/**
 * Translate one event to its SSE wire form. Keepalives become the SSE comment; every other
 * event is a typed `event: message` record. Identical bytes from the live stream, the
 * persisted rows, and the replay path — the contract this file exists to hold.
 */
export function eventToSse(event: SandboxEvent | BuildPacket): string {
  if (isKeepalive(event)) return SSE_KEEPALIVE;
  const data: Json = {
    ...wireFields(event),
    type: getEventType(event),
    timestamp: nowIso(),
  };
  return `event: message\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
// Persistence dispatch — persistSandboxEvent / finalizePersist
// ---------------------------------------------------------------------------

/** Extract text from an event content structure. */
function extractTextFromContent(content: unknown): string {
  if (content === null || content === undefined) return "";
  // The array test MUST come first: an array is an Object too, so the block branch
  // below would swallow [{type:"text"}] and answer "" for it.
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block instanceof Object &&
        (block as Json).type === "text" &&
        typeof (block as Json).text === "string"
          ? ((block as Json).text as string)
          : "",
      )
      .join("");
  }
  if (content instanceof Object) {
    const json = content as Json;
    if (json.type === "text")
      return typeof json.text === "string" ? json.text : "";
    return "";
  }
  return "";
}

/** Routing meta an event carries (or null) — the subagent tags persisted rows carry. */
function routingMetaFromEvent(event: SandboxEvent | BuildPacket): Json | null {
  if (isBuildPacket(event) || isKeepalive(event)) return null;
  const meta = event._meta;
  if (!(meta instanceof Object)) return null;
  const routing: Json = {};
  const sessionId = meta.sessionId;
  const parentSessionId = meta.parentSessionId;
  if (typeof sessionId === "string" && sessionId) routing.sessionId = sessionId;
  if (typeof parentSessionId === "string" && parentSessionId)
    routing.parentSessionId = parentSessionId;
  return Object.keys(routing).length > 0 ? routing : null;
}

/** Flush pending message/thought chunks to the DB (called on type change and at end of stream). */
async function savePendingChunks(
  store: CraftStore,
  sessionId: string,
  state: BuildStreamingState,
  routingMeta?: Json | null,
): Promise<void> {
  const messagePacket = state.finalizeMessageChunks(routingMeta);
  const thoughtPacket = state.finalizeThoughtChunks(routingMeta);
  let messageSaved = false;
  try {
    if (messagePacket) {
      await store.createMessage({
        sessionId,
        type: "assistant" as CraftMessageType,
        turnIndex: state.turnIndex,
        messageMetadata: messagePacket,
      });
      messageSaved = true;
    }
    if (thoughtPacket) {
      await store.createMessage({
        sessionId,
        type: "assistant",
        turnIndex: state.turnIndex,
        messageMetadata: thoughtPacket,
      });
    }
  } catch (error) {
    // The write failed, not the stream: put back only the packet that did not land.
    // If thought persistence fails after message persistence, restoring both would
    // duplicate the already committed message on the next flush.
    const textOf = (packet: Json): string => {
      const content = (packet as { content?: unknown }).content;
      return content instanceof Object &&
        typeof (content as { text?: unknown }).text === "string"
        ? (content as { text: string }).text
        : "";
    };
    if (messagePacket && !messageSaved)
      state.restoreMessageChunks(textOf(messagePacket));
    if (thoughtPacket) state.restoreThoughtChunks(textOf(thoughtPacket));
    throw error;
  }
  state.clearLastChunkType();
}

/**
 * Apply persistence side effects for a single sandbox event. Synchronous and free of SSE /
 * logging concerns so the headless path (future) reuses it byte-for-byte against the same
 * BuildStreamingState the interactive path uses.
 *
 * Behavior (onyx parity, the落库 rules):
 * - SSEKeepalive: no-op (handled by callers).
 * - ContextUsage: captured, persisted once at finalize — BEFORE shouldFinalizeChunks, so it
 *   never fragments in-progress streaming text.
 * - agent_message_chunk / agent_thought_chunk: accumulated; flushed when a non-chunk event (or
 *   a routing change) arrives, and at end of stream.
 * - tool_call_start: no-op (only completed tool calls persist).
 * - tool_call_progress: TodoWrite saves every progress update; other tools save only on
 *   completed/failed. A completed Task sub-agent call also emits a synthetic agent_message
 *   carrying the task output (with `<task_metadata>` stripped).
 * - agent_plan_update: upserted (only the latest plan per turn).
 * - current_mode_update / prompt_response / error / unrecognized: not persisted (turn failures
 *   are recorded by the executor as user-visible error rows).
 */
export async function persistSandboxEvent(
  store: CraftStore,
  sessionId: string,
  state: BuildStreamingState,
  sandboxEvent: SandboxEvent | BuildPacket,
  routingMeta: Json | null = null,
): Promise<void> {
  if (isKeepalive(sandboxEvent)) return;

  // Must return BEFORE shouldFinalizeChunks — routing it through would fragment
  // the in-progress streaming text. Captured here, persisted once at finalize.
  if (isBuildPacket(sandboxEvent) && sandboxEvent.type === "context_usage") {
    const packet = sandboxEvent as ContextUsagePacket;
    state.latestContextUsage = {
      type: packet.type,
      used_tokens: packet.used_tokens,
      cost: packet.cost,
      timestamp: packet.timestamp,
    };
    return;
  }

  // Flush any pending chunks if the event type changed.
  const eventType = getEventType(sandboxEvent);
  const eventRoutingMeta = routingMetaFromEvent(sandboxEvent) ?? routingMeta;
  if (state.shouldFinalizeChunks(eventType, eventRoutingMeta)) {
    await savePendingChunks(store, sessionId, state);
  }

  if (isBuildPacket(sandboxEvent)) {
    if (sandboxEvent.type === "approval_requested") {
      const packet = sandboxEvent as ApprovalRequestedPacket;
      await store.createMessage({
        sessionId,
        type: "assistant",
        turnIndex: state.turnIndex,
        messageMetadata: {
          type: packet.type,
          approval_id: packet.approval_id,
          session_id: packet.session_id,
          timestamp: packet.timestamp,
        },
      });
    }
    if (sandboxEvent.type === "compaction") {
      const packet = sandboxEvent as CompactionPacket;
      await store.createMessage({
        sessionId,
        type: "assistant",
        turnIndex: state.turnIndex,
        messageMetadata: {
          type: packet.type,
          summary: packet.summary,
          timestamp: packet.timestamp,
        },
      });
    }
    return;
  }

  if (isAgentMessageChunk(sandboxEvent)) {
    const text = extractTextFromContent(sandboxEvent.content);
    if (text) state.addMessageChunk(text, eventRoutingMeta);
    return;
  }

  if (isAgentThoughtChunk(sandboxEvent)) {
    const text = extractTextFromContent(sandboxEvent.content);
    if (text) state.addThoughtChunk(text, eventRoutingMeta);
    return;
  }

  if (isToolCallStart(sandboxEvent)) {
    // Stream-only; persistence happens on terminal (completed/failed) progress.
    return;
  }

  if (isToolCallProgress(sandboxEvent)) {
    const eventData = {
      sessionUpdate: sandboxEvent.sessionUpdate,
      toolCallId: sandboxEvent.toolCallId,
      title: sandboxEvent.title,
      kind: sandboxEvent.kind,
      status: sandboxEvent.status,
      ...(sandboxEvent.rawInput !== undefined
        ? { rawInput: sandboxEvent.rawInput }
        : {}),
      ...(sandboxEvent.rawOutput !== undefined
        ? { rawOutput: sandboxEvent.rawOutput }
        : {}),
      ...(sandboxEvent.content !== undefined
        ? { content: sandboxEvent.content }
        : {}),
      ...(sandboxEvent._meta !== undefined
        ? { _meta: sandboxEvent._meta }
        : {}),
      type: "tool_call_progress",
      timestamp: nowIso(),
    } as Json;

    const toolName = (eventData.title ?? "").toString().toLowerCase();
    const isTodoWrite = toolName === "updating todos"; // title map: todowrite/todo_write

    const rawInput =
      sandboxEvent.rawInput instanceof Object
        ? (sandboxEvent.rawInput as Json)
        : {};
    const isTaskTool =
      (sandboxEvent._meta instanceof Object &&
        (sandboxEvent._meta as Json).toolName === "task") ||
      rawInput.subagent_type !== undefined ||
      rawInput.subagentType !== undefined;

    if (
      isTodoWrite ||
      sandboxEvent.status === "completed" ||
      sandboxEvent.status === "failed"
    ) {
      await store.createMessage({
        sessionId,
        type: "assistant",
        turnIndex: state.turnIndex,
        messageMetadata: eventData,
      });
    }

    if (isTaskTool && sandboxEvent.status === "completed") {
      const rawOutput =
        sandboxEvent.rawOutput instanceof Object
          ? (sandboxEvent.rawOutput as Json)
          : {};
      let taskOutput = rawOutput.output;
      if (typeof taskOutput === "string" && taskOutput) {
        const metadataIndex = taskOutput.indexOf("<task_metadata>");
        if (metadataIndex >= 0) {
          taskOutput = taskOutput.slice(0, metadataIndex).trim();
        }
        if (taskOutput) {
          await store.createMessage({
            sessionId,
            type: "assistant",
            turnIndex: state.turnIndex,
            messageMetadata: {
              type: "agent_message",
              content: { type: "text", text: taskOutput },
              source: "task_output",
              timestamp: nowIso(),
            },
          });
        }
      }
    }
    return;
  }

  if (isAgentPlanUpdate(sandboxEvent)) {
    const eventData = {
      ...(sandboxEvent.sessionUpdate !== undefined
        ? { sessionUpdate: sandboxEvent.sessionUpdate }
        : {}),
      entries: sandboxEvent.entries,
      ...(sandboxEvent._meta !== undefined
        ? { _meta: sandboxEvent._meta }
        : {}),
      type: "agent_plan_update",
      timestamp: nowIso(),
    } as Json;
    const planMessage = await store.upsertAgentPlan({
      sessionId,
      turnIndex: state.turnIndex,
      planMetadata: eventData,
      existingPlanId: state.planMessageId,
    });
    state.planMessageId = planMessage.id;
    return;
  }

  // CurrentModeUpdate, PromptResponse, SandboxError, and unrecognized packets are
  // not persisted (parity with onyx's interactive path).
}

/** End-of-stream persistence: flush pending chunks, then one context-usage row per turn. */
export async function finalizePersist(
  store: CraftStore,
  sessionId: string,
  state: BuildStreamingState,
  // Optional, not defaulted: an omitted meta means "whatever the chunks remembered",
  // while an explicit null means "persist without routing". A hard default here would
  // override the chunk state's own last-seen routing meta.
  routingMeta?: Json | null,
): Promise<void> {
  await savePendingChunks(store, sessionId, state, routingMeta);

  // One context-usage row per turn seeds the input-bar ring on reload.
  if (state.latestContextUsage !== null) {
    await store.createMessage({
      sessionId,
      type: "assistant",
      turnIndex: state.turnIndex,
      messageMetadata: state.latestContextUsage,
    });
    state.latestContextUsage = null;
  }
}
