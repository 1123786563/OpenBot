import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { interruptSession, sendMessage, turnEventsUrl } from "./client";
import { scheduledRunEventsUrl } from "./scheduled-tasks";
import {
  appendChunkToItems,
  appendSubagentTextChunk,
  appendToolStartToItems,
  closeStreamingItems,
  closeSubagentStreams,
  freshKey,
  recordParentTaskToolCall,
  routeSubagentPacket,
  type SubagentState,
  type SubagentStatus,
  seedSubagent,
  upsertSubagentToolPacket,
  upsertToolProgressToItems,
} from "./streaming-kernel";
import type {
  CraftAttachment,
  CraftMessage,
  CraftStreamPacket,
  CraftToolKind,
  CraftToolOutputBlock,
  CraftToolStatus,
} from "./types";

/**
 * The turn stream, from wire to hooks.
 *
 * `processSSEStream` parses the `event: message` / `data: {…}` frames `GET …/turns/:id/events`
 * emits (keepalive comments pass through as nothing), and `useBuildStreaming` turns a session's
 * live frames into a flat, renderable transcript. The durable truth is the messages endpoint;
 * the two share byte-identical packets, so `messagesToTranscript` and the live reducer produce
 * the same `TranscriptItem` objects and the view renders them with one switch.
 *
 * Subagent routing (onyx parity): the reducer keeps a `Map<ocSessionId, SubagentState>` beside
 * the main items; child-routed events (`_meta.sessionId` + `_meta.parentSessionId`) build the
 * subagent's own transcript, the parent's `task` card (`_meta.subagentSessionId`) updates the
 * subagent's status, and everything else lands in the main transcript. The fold itself lives in
 * `streaming-kernel.ts` (pure, import-free) — see that module for the recorded simplifications.
 */

/** One thing the transcript draws, whatever its source. `streaming` marks a live, still-growing block. */
export type TranscriptItem =
  | {
      key: string;
      kind: "user";
      text: string;
      /** The files this message carried (upload chips → send-message → persisted metadata). */
      attachments?: CraftAttachment[];
    }
  | { key: string; kind: "text"; text: string; streaming?: boolean }
  | { key: string; kind: "thinking"; text: string; streaming?: boolean }
  | {
      key: string;
      kind: "tool";
      toolCallId: string;
      title: string;
      toolKind: CraftToolKind;
      status: CraftToolStatus;
      rawInput?: unknown;
      rawOutput?: unknown;
      content?: CraftToolOutputBlock[];
      /** Present on the parent's `task` card: the subagent this call spawned + its live status. */
      subagentSessionId?: string;
      subagentStatus?: SubagentStatus;
    }
  | { key: string; kind: "plan"; entries: unknown }
  | { key: string; kind: "usage"; usedTokens: number; cost: number | null }
  | { key: string; kind: "compaction"; summary: string | null }
  | { key: string; kind: "error"; message: string };

/** Read a metadata block's `type` string (the packet discriminant the server stamps). */
function metaType(meta: Record<string, unknown>): string {
  return typeof meta.type === "string" ? meta.type : "";
}

function metaText(meta: Record<string, unknown>): string {
  const content = meta.content;
  return typeof content === "object" && content !== null
    ? String((content as { text?: unknown }).text ?? "")
    : "";
}

/** Read a user message's attachments out of its persisted metadata, when it carried any. */
function metaAttachments(
  meta: Record<string, unknown>,
): CraftAttachment[] | undefined {
  if (!Array.isArray(meta.attachments)) return undefined;
  const parsed = meta.attachments.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null,
  );
  const named = parsed.filter(
    (entry) =>
      typeof entry.name === "string" &&
      typeof entry.path === "string" &&
      typeof entry.mime_type === "string",
  );
  return named.length > 0 ? (named as unknown as CraftAttachment[]) : undefined;
}

/**
 * True when a persisted row's routing meta marks it as a subagent's own output (`sessionId` +
 * `parentSessionId`, the same pair the live reducer routes on) — those rows belong to a
 * subagent transcript, so the main transcript skips them and live vs reload agree. (The
 * subagent view itself is live-only; onyx's buildSubagentsFromMessages rebuild is not ported —
 * recorded divergence.)
 */
function isChildRoutedRow(meta: Record<string, unknown>): boolean {
  const inner = meta._meta;
  if (!(inner instanceof Object)) return false;
  const routing = inner as Record<string, unknown>;
  return (
    typeof routing.parentSessionId === "string" &&
    typeof routing.sessionId === "string"
  );
}

/** Fold one persisted transcript row into zero-or-more display items (user, text, tool, …). */
export function messageToTranscript(message: CraftMessage): TranscriptItem[] {
  const meta = message.message_metadata;
  if (isChildRoutedRow(meta)) return [];
  const key = message.id;
  switch (metaType(meta)) {
    case "user_message": {
      const text = metaText(meta);
      const attachments = metaAttachments(meta);
      return text || attachments
        ? [{ key, kind: "user", text, attachments }]
        : [];
    }
    case "agent_message": {
      const text = metaText(meta);
      return text ? [{ key, kind: "text", text }] : [];
    }
    case "agent_thought": {
      const text = metaText(meta);
      return text ? [{ key, kind: "thinking", text }] : [];
    }
    case "tool_call_progress": {
      return [
        {
          key,
          kind: "tool",
          toolCallId: String(meta.toolCallId ?? key),
          title: String(meta.title ?? ""),
          toolKind: (typeof meta.kind === "string"
            ? meta.kind
            : "other") as CraftToolKind,
          status: (typeof meta.status === "string"
            ? meta.status
            : "completed") as CraftToolStatus,
          rawInput: meta.rawInput,
          rawOutput: meta.rawOutput,
          content: Array.isArray(meta.content)
            ? (meta.content as CraftToolOutputBlock[])
            : undefined,
        },
      ];
    }
    case "agent_plan_update":
      return [{ key, kind: "plan", entries: meta.entries }];
    case "context_usage":
      return [
        {
          key,
          kind: "usage",
          usedTokens:
            typeof meta.used_tokens === "number" ? meta.used_tokens : 0,
          cost: typeof meta.cost === "number" ? meta.cost : null,
        },
      ];
    case "compaction":
      return [
        {
          key,
          kind: "compaction",
          summary: typeof meta.summary === "string" ? meta.summary : null,
        },
      ];
    default:
      return [];
  }
}

/** The durable transcript: every row folded, in order. */
export function messagesToTranscript(
  messages: CraftMessage[],
): TranscriptItem[] {
  return messages.flatMap(messageToTranscript);
}

/** Parse one SSE frame; keepalive comments and malformed data both resolve to nothing. */
function parseFrame(frame: string): CraftStreamPacket[] {
  let hasData = false;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) {
      hasData = true;
      dataLines.push(line.slice(5).replace(/^ /, ""));
    } else if (line.startsWith(":")) {
      return []; // keepalive / comment
    }
  }
  if (!hasData || dataLines.length === 0) return [];
  try {
    const parsed = JSON.parse(dataLines.join("\n")) as
      | CraftStreamPacket
      | Record<string, unknown>;
    return typeof (parsed as { type?: unknown }).type === "string"
      ? [parsed as CraftStreamPacket]
      : [];
  } catch {
    return [];
  }
}

/** Lazily decode an SSE body into its typed packets. */
export async function* processSSEStream(
  response: Response,
): AsyncGenerator<CraftStreamPacket> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        yield* parseFrame(frame);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

type StreamState = {
  items: TranscriptItem[];
  streaming: boolean;
  /** The turn's live subagents, keyed by opencode session id (survives turn resets). */
  subagents: Map<string, SubagentState>;
};

type StreamAction =
  | { type: "reset" }
  | { type: "packet"; packet: CraftStreamPacket }
  | { type: "finish" }
  | { type: "clear-subagents" };

/** The `_meta.subagentSessionId` task-card fields for a main-path tool packet, when present. */
function taskMetaFor(
  state: StreamState,
  packet: CraftStreamPacket,
): { sessionId: string; status?: SubagentStatus } | null {
  const meta = "_meta" in packet ? packet._meta : undefined;
  if (!(meta instanceof Object) || typeof meta.subagentSessionId !== "string") {
    return null;
  }
  return {
    sessionId: meta.subagentSessionId,
    status: state.subagents.get(meta.subagentSessionId)?.status,
  };
}

/** The main-transcript fold — every packet type's existing item handling, unchanged. */
function applyMainPacket(
  state: StreamState,
  packet: CraftStreamPacket,
): StreamState {
  switch (packet.type) {
    case "agent_message_chunk":
      return {
        ...state,
        items: appendChunkToItems(state.items, "text", packet.content.text),
      };
    case "agent_thought_chunk":
      return {
        ...state,
        items: appendChunkToItems(state.items, "thinking", packet.content.text),
      };
    case "tool_call_start":
      return {
        ...state,
        items: appendToolStartToItems(
          state.items,
          packet,
          taskMetaFor(state, packet),
        ),
      };
    case "tool_call_progress":
      return {
        ...state,
        items: upsertToolProgressToItems(
          state.items,
          packet,
          taskMetaFor(state, packet),
        ),
      };
    case "agent_plan_update":
      return {
        ...state,
        items: closeStreamingItems(state.items).concat({
          key: freshKey(),
          kind: "plan",
          entries: packet.entries,
        }),
      };
    case "context_usage":
      return {
        ...state,
        items: state.items.concat({
          key: freshKey(),
          kind: "usage",
          usedTokens: packet.used_tokens,
          cost: packet.cost,
        }),
      };
    case "compaction":
      return {
        ...state,
        items: state.items.concat({
          key: freshKey(),
          kind: "compaction",
          summary: packet.summary,
        }),
      };
    case "error":
      return {
        ...state,
        items: closeStreamingItems(state.items).concat(
          packet.message
            ? [
                {
                  key: freshKey(),
                  kind: "error" as const,
                  message: packet.message,
                },
              ]
            : [],
        ),
        streaming: false,
      };
    case "prompt_response":
      return {
        ...state,
        items: closeStreamingItems(state.items),
        streaming: false,
      };
    case "approval_requested":
      // No transcript item — the approvals card renders from the live list,
      // which the hook revalidates when this packet arrives.
      return state;
    default:
      return state;
  }
}

function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case "reset":
      // A new turn clears the main items; subagents belong to the session, not the turn.
      return { items: [], streaming: true, subagents: state.subagents };
    case "clear-subagents":
      return { ...state, subagents: new Map() };
    case "finish":
      return {
        items: closeStreamingItems(state.items),
        streaming: false,
        subagents: closeSubagentStreams(state.subagents),
      };
    case "packet": {
      const packet = action.packet;
      if (packet.type === "subagent_started") {
        return {
          ...state,
          subagents: seedSubagent(state.subagents, packet.subagent_session_id),
        };
      }
      const route = routeSubagentPacket(packet);
      if (route.kind === "child") {
        switch (packet.type) {
          case "agent_message_chunk":
            return {
              ...state,
              subagents: appendSubagentTextChunk(
                state.subagents,
                route.sessionId,
                "text",
                packet.content.text,
              ),
            };
          case "agent_thought_chunk":
            return {
              ...state,
              subagents: appendSubagentTextChunk(
                state.subagents,
                route.sessionId,
                "thinking",
                packet.content.text,
              ),
            };
          case "tool_call_start":
          case "tool_call_progress":
            return {
              ...state,
              subagents: upsertSubagentToolPacket(
                state.subagents,
                route.sessionId,
                packet,
              ),
            };
          default:
            // Child-routed packets outside the three families carry nothing user-visible.
            return state;
        }
      }
      if (route.kind === "parentTask") {
        if (
          packet.type !== "tool_call_start" &&
          packet.type !== "tool_call_progress"
        ) {
          return applyMainPacket(state, packet);
        }
        // The main transcript keeps the task card; the subagent's status updates first so
        // the card renders the completed state in the same pass.
        const subagents = recordParentTaskToolCall(
          state.subagents,
          route.toolCallId,
          route.sessionId,
          packet.status,
        );
        return applyMainPacket({ ...state, subagents }, packet);
      }
      return applyMainPacket(state, packet);
    }
  }
}

/**
 * A session's live turn, as a flat renderable transcript.
 *
 * `streamMessage` sends and attaches; `streamTurnEvents` re-attaches to an already-started turn
 * (the reconnect path); `streamScheduledRunEvents` attaches to a live scheduled run — the same
 * wire, addressed by session instead of turn (onyx `streamScheduledRunEvents`, the banner's
 * simplified `shouldStreamScheduledRun`). All three reset the live list and drain the SSE into
 * `items`, which the caller renders after the durable history.
 */
export function useBuildStreaming(sessionId: string): {
  items: TranscriptItem[];
  isStreaming: boolean;
  /** The session's live subagents, keyed by opencode session id (read-only views read these). */
  subagents: Map<string, SubagentState>;
  streamMessage(
    content: string,
    attachments?: CraftAttachment[],
    /** Fires once the send is durable — after send-message persisted the user row, before the stream. */
    onSent?: () => void | Promise<void>,
  ): Promise<void>;
  interruptStreaming(): Promise<void>;
  streamTurnEvents(turnId: string): Promise<void>;
  streamScheduledRunEvents(): Promise<void>;
} {
  const [state, dispatch] = useReducer(streamReducer, {
    items: [],
    streaming: false,
    subagents: new Map<string, SubagentState>(),
  });
  const abortRef = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();

  /** Open one SSE URL and drain it into the live list — the shape every attach path shares. */
  const runStream = useCallback(
    async (url: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      dispatch({ type: "reset" });
      try {
        const response = await fetch(url, {
          credentials: "include",
          signal: controller.signal,
        });
        if (!response.ok) {
          dispatch({ type: "finish" });
          return;
        }
        for await (const packet of processSSEStream(response)) {
          dispatch({ type: "packet", packet });
          if (packet.type === "approval_requested") {
            // The waiting card renders from the live approvals list; the announce
            // beats the 5s poll so the card appears the moment the agent asks.
            void queryClient.invalidateQueries({
              queryKey: ["craft", "approvals", sessionId],
            });
          }
          if (packet.type === "prompt_response" || packet.type === "error")
            break;
        }
      } catch (error) {
        const aborted =
          error instanceof DOMException && error.name === "AbortError";
        if (!aborted) {
          dispatch({
            type: "packet",
            packet: {
              type: "error",
              message: error instanceof Error ? error.message : String(error),
              timestamp: new Date().toISOString(),
            },
          });
        }
      } finally {
        dispatch({ type: "finish" });
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [sessionId, queryClient],
  );

  const streamTurnEvents = useCallback(
    async (turnId: string) => {
      await runStream(turnEventsUrl(sessionId, turnId));
    },
    [runStream, sessionId],
  );

  const streamScheduledRunEvents = useCallback(async () => {
    await runStream(scheduledRunEventsUrl(sessionId));
  }, [runStream, sessionId]);

  const streamMessage = useCallback(
    async (
      content: string,
      attachments?: CraftAttachment[],
      /** Fires once the send is durable — after send-message persisted the user row, before the stream. */
      onSent?: () => void | Promise<void>,
    ) => {
      const turn = await sendMessage(sessionId, content, attachments);
      await onSent?.();
      await streamTurnEvents(turn.turn_id);
    },
    [sessionId, streamTurnEvents],
  );

  const interruptStreaming = useCallback(async () => {
    abortRef.current?.abort();
    await interruptSession(sessionId).catch(() => undefined);
  }, [sessionId]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  // The subagent map belongs to one session; a session switch clears it (the component
  // stays mounted across route params, so this is the switch's cleanup point — the
  // render-time reset, not an effect, so no stale subagent outlives its session).
  const [subagentsSessionId, setSubagentsSessionId] = useState(sessionId);
  if (subagentsSessionId !== sessionId) {
    setSubagentsSessionId(sessionId);
    dispatch({ type: "clear-subagents" });
  }

  return {
    items: state.items,
    isStreaming: state.streaming,
    subagents: state.subagents,
    streamMessage,
    interruptStreaming,
    streamTurnEvents,
    streamScheduledRunEvents,
  };
}
