import { useCallback, useEffect, useReducer, useRef } from "react";
import { interruptSession, sendMessage, turnEventsUrl } from "./client";
import type {
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
 */

/** One thing the transcript draws, whatever its source. `streaming` marks a live, still-growing block. */
export type TranscriptItem =
  | { key: string; kind: "user"; text: string }
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

/** Fold one persisted transcript row into zero-or-more display items (user, text, tool, …). */
export function messageToTranscript(message: CraftMessage): TranscriptItem[] {
  const meta = message.message_metadata;
  const key = message.id;
  switch (metaType(meta)) {
    case "user_message": {
      const text = metaText(meta);
      return text ? [{ key, kind: "user", text }] : [];
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

const freshKey = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

type StreamState = { items: TranscriptItem[]; streaming: boolean };

type StreamAction =
  | { type: "reset" }
  | { type: "packet"; packet: CraftStreamPacket }
  | { type: "finish" };

/** Close every still-open streaming block (turn ended, or the block type switched). */
function closeStreams(items: TranscriptItem[]): TranscriptItem[] {
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
function appendChunk(
  state: StreamState,
  kind: "text" | "thinking",
  text: string,
): StreamState {
  const last = state.items[state.items.length - 1];
  if (last && last.kind === kind && last.streaming) {
    return {
      ...state,
      items: [...state.items.slice(0, -1), { ...last, text: last.text + text }],
    };
  }
  let items = state.items;
  if (last && "streaming" in last && last.streaming) {
    items = items.slice(0, -1).concat({ ...last, streaming: false });
  }
  return {
    ...state,
    items: items.concat({ key: freshKey(), kind, text, streaming: true }),
  };
}

function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case "reset":
      return { items: [], streaming: true };
    case "finish":
      return { items: closeStreams(state.items), streaming: false };
    case "packet": {
      const packet = action.packet;
      switch (packet.type) {
        case "agent_message_chunk":
          return appendChunk(state, "text", packet.content.text);
        case "agent_thought_chunk":
          return appendChunk(state, "thinking", packet.content.text);
        case "tool_call_start":
          return {
            ...state,
            items: closeStreams(state.items).concat({
              key: packet.toolCallId,
              kind: "tool",
              toolCallId: packet.toolCallId,
              title: packet.title,
              toolKind: packet.kind,
              status: packet.status,
              rawInput: packet.rawInput,
            }),
          };
        case "tool_call_progress": {
          const base = closeStreams(state.items);
          const index = base.findIndex(
            (item) =>
              item.kind === "tool" && item.toolCallId === packet.toolCallId,
          );
          const nextTool: TranscriptItem & { kind: "tool" } = {
            key: index >= 0 ? base[index].key : freshKey(),
            kind: "tool",
            toolCallId: packet.toolCallId,
            title: packet.title,
            toolKind: packet.kind,
            status: packet.status,
            rawInput: packet.rawInput,
            rawOutput: packet.rawOutput,
            content: packet.content,
          };
          const items =
            index >= 0
              ? base.slice(0, index).concat(nextTool, base.slice(index + 1))
              : base.concat(nextTool);
          return { ...state, items };
        }
        case "agent_plan_update":
          return {
            ...state,
            items: closeStreams(state.items).concat({
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
            items: closeStreams(state.items).concat(
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
          return { items: closeStreams(state.items), streaming: false };
        default:
          return state;
      }
    }
  }
}

/**
 * A session's live turn, as a flat renderable transcript.
 *
 * `streamMessage` sends and attaches; `streamTurnEvents` re-attaches to an already-started turn
 * (the reconnect path). Both reset the live list and drain the SSE into `items`, which the caller
 * renders after the durable history.
 */
export function useBuildStreaming(sessionId: string): {
  items: TranscriptItem[];
  isStreaming: boolean;
  streamMessage(content: string): Promise<void>;
  interruptStreaming(): Promise<void>;
  streamTurnEvents(turnId: string): Promise<void>;
} {
  const [state, dispatch] = useReducer(streamReducer, {
    items: [],
    streaming: false,
  });
  const abortRef = useRef<AbortController | null>(null);

  const streamTurnEvents = useCallback(
    async (turnId: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      dispatch({ type: "reset" });
      try {
        const response = await fetch(turnEventsUrl(sessionId, turnId), {
          credentials: "include",
          signal: controller.signal,
        });
        if (!response.ok) {
          dispatch({ type: "finish" });
          return;
        }
        for await (const packet of processSSEStream(response)) {
          dispatch({ type: "packet", packet });
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
    [sessionId],
  );

  const streamMessage = useCallback(
    async (content: string) => {
      const turn = await sendMessage(sessionId, content);
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

  return {
    items: state.items,
    isStreaming: state.streaming,
    streamMessage,
    interruptStreaming,
    streamTurnEvents,
  };
}
