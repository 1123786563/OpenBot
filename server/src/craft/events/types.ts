/**
 * The typed events the craft layer emits and consumes — the ACP subset, inlined.
 *
 * onyx re-exports these from the `agent-client-protocol` package behind a wrapper
 * (`sandbox/event_schema.py`, see their docs/craft/drop-acp-layer.md); here they are inlined
 * outright because that is the end-state the wrapper was keeping open. The wire shapes are
 * preserved field-for-field (camelCase, `_meta` routing key, `sessionUpdate` discriminants,
 * the tool `kind` category field) so the frontend contract and the persistence contract (the
 * same packets land in `craft_messages.message_metadata` byte-identically) both hold without
 * translation.
 *
 * Discrimination mirrors the Python isinstance chains the port replaces: guard functions in
 * this file, driven by the wire fields themselves — `sessionUpdate` for stream events,
 * `stopReason` for the terminator, `code`+`message` for errors, and the class identity for
 * keepalives. No synthetic tag fields exist, so serialization stays byte-parity with onyx.
 */

/**
 * Onyx-synthesized `Error.code` sentinels for turn-terminating failures. Negative so they
 * never collide with opencode / JSON-RPC error codes.
 */
export const TURN_ERROR_CODE_SESSION = -1; // opencode reported an error during the turn
export const TURN_ERROR_CODE_TIMEOUT = -2;
export const TURN_ERROR_CODE_TRANSPORT = -3;

/**
 * Marker yielded when no real sandbox events arrive within the keepalive window. A class (not a
 * plain object) so `instanceof` checks in the streaming pipeline work uniformly, exactly like
 * onyx's SSEKeepalive dataclass.
 */
export class SSEKeepalive {
  readonly keepalive = true as const;
}

export type TextContent = { type: "text"; text: string };

export type AgentMessageChunk = {
  sessionUpdate: "agent_message_chunk";
  content: TextContent;
  /** ACP extensibility field; carries routing (sessionId/parentSessionId) for subagent events. */
  _meta?: Record<string, unknown>;
};

export type AgentThoughtChunk = {
  sessionUpdate: "agent_thought_chunk";
  content: TextContent;
  _meta?: Record<string, unknown>;
};

export type AgentPlanUpdate = {
  sessionUpdate?: string;
  entries: unknown;
  _meta?: Record<string, unknown>;
};

export type CurrentModeUpdate = {
  sessionUpdate?: string;
  currentMode: unknown;
  _meta?: Record<string, unknown>;
};

export type PromptResponse = {
  stopReason: "end_turn" | "max_tokens" | "refusal" | "cancelled" | string;
  _meta?: Record<string, unknown>;
};

export type SandboxError = {
  code: number;
  message: string;
  _meta?: Record<string, unknown>;
};

/**
 * A step produced no output within the inactivity window — recoverable by re-prompting, unlike
 * a hard absolute/budget timeout. The distinction is carried by the type, not `code` (which it
 * shares with the hard timeout). Serialized on the wire as a plain `error` event; the extra
 * `activityTimeout` marker is consumed by the executor and never persisted.
 */
export type ActivityTimeoutError = SandboxError & {
  activityTimeout: true;
};

export function activityTimeoutError(message: string): ActivityTimeoutError {
  return {
    activityTimeout: true,
    code: TURN_ERROR_CODE_TIMEOUT,
    message,
  };
}

export function isActivityTimeout(
  event: unknown,
): event is ActivityTimeoutError {
  return (
    event !== null &&
    typeof event === "object" &&
    "activityTimeout" in event &&
    (event as ActivityTimeoutError).activityTimeout === true
  );
}

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** The common shape of tool-call events; `sessionUpdate` distinguishes start from progress. */
export type ToolCallBase = {
  toolCallId: string;
  title: string;
  /** Tool category, wire field ("execute" | "read" | …) — NOT a TS discriminant. */
  kind: "execute" | "read" | "edit" | "search" | "fetch" | "other";
  status: ToolCallStatus;
  rawInput?: unknown;
  rawOutput?: { output?: unknown; metadata?: unknown } & Record<
    string,
    unknown
  >;
  content?: Array<
    | { type: "diff"; path: string; oldText: string; newText: string }
    | {
        type: "content";
        content: { type: string; text?: string } & Record<string, unknown>;
      }
  >;
  /** Carries the raw opencode tool name so the frontend resolves a precise title. */
  _meta?: Record<string, unknown>;
};

export type ToolCallStart = ToolCallBase & {
  sessionUpdate: "tool_call";
};

export type ToolCallProgress = ToolCallBase & {
  sessionUpdate: "tool_call_update";
};

export type ToolCallEvent = ToolCallStart | ToolCallProgress;

/** The ACP event union; custom packets (context_usage, …) join in events/packets.ts. */
export type SandboxEvent =
  | AgentMessageChunk
  | AgentThoughtChunk
  | ToolCallStart
  | ToolCallProgress
  | AgentPlanUpdate
  | CurrentModeUpdate
  | PromptResponse
  | SandboxError
  | SSEKeepalive;

// ── Guards: the wire fields themselves discriminate (the isinstance chains) ──

/** A non-null object — the only shape a wire field can be read (or `in`) off safely. */
function isRecord(event: unknown): event is Record<string, unknown> {
  return typeof event === "object" && event !== null;
}

export function isKeepalive(event: unknown): event is SSEKeepalive {
  return event instanceof SSEKeepalive;
}

export function isAgentMessageChunk(
  event: unknown,
): event is AgentMessageChunk {
  return (
    isRecord(event) &&
    !(event instanceof SSEKeepalive) &&
    event.sessionUpdate === "agent_message_chunk"
  );
}

export function isAgentThoughtChunk(
  event: unknown,
): event is AgentThoughtChunk {
  return (
    isRecord(event) &&
    !(event instanceof SSEKeepalive) &&
    event.sessionUpdate === "agent_thought_chunk"
  );
}

export function isToolCallStart(event: unknown): event is ToolCallStart {
  return (
    isRecord(event) &&
    !(event instanceof SSEKeepalive) &&
    event.sessionUpdate === "tool_call"
  );
}

export function isToolCallProgress(event: unknown): event is ToolCallProgress {
  return (
    isRecord(event) &&
    !(event instanceof SSEKeepalive) &&
    event.sessionUpdate === "tool_call_update"
  );
}

export function isAgentPlanUpdate(event: unknown): event is AgentPlanUpdate {
  // Arrays own an inherited `entries` method, so the bare `in` test would call every
  // array an update; only a real record with the key qualifies.
  return (
    isRecord(event) &&
    !Array.isArray(event) &&
    !(event instanceof SSEKeepalive) &&
    "entries" in event
  );
}

export function isCurrentModeUpdate(
  event: unknown,
): event is CurrentModeUpdate {
  return (
    isRecord(event) &&
    !(event instanceof SSEKeepalive) &&
    "currentMode" in event
  );
}

export function isPromptResponse(event: unknown): event is PromptResponse {
  return (
    isRecord(event) &&
    !(event instanceof SSEKeepalive) &&
    "stopReason" in event &&
    !("code" in event)
  );
}

export function isSandboxError(event: unknown): event is SandboxError {
  return (
    isRecord(event) &&
    !(event instanceof SSEKeepalive) &&
    "code" in event &&
    "message" in event
  );
}
