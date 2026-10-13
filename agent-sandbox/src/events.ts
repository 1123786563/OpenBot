/**
 * The opencode SSE event vocabulary, frozen from a live capture (opencode 1.18.7).
 *
 * THE CAPTURE IS THE CONTRACT. The five families the plan sketched (message_chunk / thought /
 * tool_call / progress / prompt_response) are a product-side grouping; opencode itself emits
 * `server.*`, `session.*`, `message.*`, `file.*` and a handful of one-offs, and the grouping is
 * done HERE, in one place, so the gateway (B8) and the translator (B9) consume a stable shape
 * even when opencode renames an internal type. docs/sse-samples.md holds the raw evidence.
 *
 * UNKNOWN IS A VALUE, NOT AN ERROR. A stream must survive an event shape nobody has seen — the
 * next opencode release will add types, and a `parseSandboxEvent` that threw would turn "one new
 * event kind" into "the whole process view is down". Unknown events pass through typed as
 * `{ type: "unknown", raw }` and the UI renders nothing for them.
 */

/** Every event type observed in the capture, plus the families we group them into. */
export const SANDBOX_EVENT_TYPES = [
  // message.*
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  // session.*
  "session.updated",
  "session.status",
  "session.diff",
  "session.idle",
  // server.*
  "server.connected",
  "server.heartbeat",
  // file.*
  "file.edited",
  "file.watcher.updated",
  // one-offs seen in the capture
  "plugin.added",
  "catalog.updated",
  "reference.updated",
  "integration.updated",
  // The permission handshake (opencode 1.15.x, onyx-verified shape): not in the
  // workshop capture because no turn asked while it ran, but the craft server's
  // approval routing consumes it — the filter must forward it or an asking turn
  // parks with no egress at all (F-G).
  "permission.asked",
] as const;

export type SandboxEventType = (typeof SANDBOX_EVENT_TYPES)[number];

/** A message part as opencode shapes it; `type` discriminates the interesting ones below. */
export type SandboxMessagePart = {
  id: string;
  messageID: string;
  sessionID: string;
  type: string;
  /** tool parts only: which tool ("bash", "edit", …). */
  tool?: string;
  state?: { status?: string; input?: unknown; raw?: string } & Record<
    string,
    unknown
  >;
  /** text/reasoning parts only: the accumulated body of the part. */
  text?: string;
  time?: number;
};

export type SandboxEvent =
  | {
      type: "message.part.delta";
      id: string;
      sessionID: string;
      messageID: string;
      partID: string;
      field: string;
      delta: string;
    }
  | {
      type: "message.part.updated";
      id: string;
      sessionID: string;
      part: SandboxMessagePart;
    }
  | {
      type: "message.updated";
      id: string;
      sessionID: string;
      role: string;
      time: { created?: number; completed?: number } | null;
    }
  | {
      type: "session.status";
      id: string;
      sessionID: string;
      status: string;
    }
  | {
      type: "session.idle";
      id: string;
      sessionID: string;
    }
  | {
      type: "file.edited";
      id: string;
      file: string;
    }
  /** The remaining known types carry nothing but their identity (heartbeats, noise, …). */
  | {
      type: Exclude<
        SandboxEventType,
        | "message.part.delta"
        | "message.part.updated"
        | "message.updated"
        | "session.status"
        | "session.idle"
        | "file.edited"
      >;
      id: string;
    }
  | { type: "unknown"; raw: unknown };

/** The product-facing families the translator (B9) maps events into. */
export type SandboxEventFamily =
  | "message_chunk"
  | "thought"
  | "tool_call"
  | "progress"
  | "prompt_response"
  | "permission"
  | "other";

/**
 * Which product family an event belongs to. The mapping the capture fixed:
 *
 * - `message.part.delta` with field "text" is a MESSAGE_CHUNK — it carries the literal next
 *   characters of the answer being written.
 * - `message.part.updated` with part.type "reasoning" is a THOUGHT; with part.type "tool" it is
 *   a TOOL_CALL (its `state.status` — pending → running → completed/error — is the tool's own
 *   progress line).
 * - `session.status` busy/idle is PROGRESS at the session grain.
 * - `session.idle` after activity is PROMPT_RESPONSE: the answer the sync endpoint would return
 *   has finished assembling, and a streaming consumer can finalise its view here.
 * - Everything else — heartbeats, diffs, plugin noise, unknown future types — is OTHER.
 */
export function familyOf(event: SandboxEvent): SandboxEventFamily {
  if (event.type === "message.part.delta" && event.field === "text") {
    return "message_chunk";
  }
  if (event.type === "message.part.updated") {
    if (event.part.type === "reasoning") return "thought";
    if (event.part.type === "tool") return "tool_call";
  }
  if (event.type === "session.status") return "progress";
  if (event.type === "session.idle") return "prompt_response";
  // The control plane, not the process view: the server-side turn consumer
  // routes approval/connect_app decisions off permission.asked, so it rides the
  // gateway stream even though no product surface renders it.
  if (event.type === "permission.asked") return "permission";
  return "other";
}

/** One `data:` line off the stream, parsed. Never throws: unparseable input becomes unknown. */
export function parseSandboxEvent(line: string): SandboxEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { type: "unknown", raw: line };
  }
  if (!parsed || typeof parsed !== "object") {
    return { type: "unknown", raw: parsed };
  }
  const event = parsed as {
    id?: unknown;
    type?: unknown;
    properties?: unknown;
  };
  const id = typeof event.id === "string" ? event.id : "";
  const properties =
    event.properties && typeof event.properties === "object"
      ? (event.properties as Record<string, unknown>)
      : {};
  const sessionID =
    typeof properties.sessionID === "string" ? properties.sessionID : "";

  switch (event.type) {
    case "message.part.delta": {
      return {
        type: "message.part.delta",
        id,
        sessionID,
        messageID: str(properties.messageID),
        partID: str(properties.partID),
        field: str(properties.field),
        delta: str(properties.delta),
      };
    }
    case "message.part.updated": {
      return {
        type: "message.part.updated",
        id,
        sessionID,
        part: (properties.part ?? {}) as SandboxMessagePart,
      };
    }
    case "message.updated": {
      const info = properties.info as
        | { role?: unknown; time?: unknown }
        | undefined;
      return {
        type: "message.updated",
        id,
        sessionID,
        role: str(info?.role),
        time: (info?.time ?? null) as {
          created?: number;
          completed?: number;
        } | null,
      };
    }
    case "session.status": {
      const status = properties.status as { type?: unknown } | undefined;
      return {
        type: "session.status",
        id,
        sessionID,
        status: str(status?.type),
      };
    }
    case "session.idle":
      return { type: "session.idle", id, sessionID };
    case "file.edited":
      return { type: "file.edited", id, file: str(properties.file) };
    default: {
      if (
        typeof event.type === "string" &&
        SANDBOX_EVENT_TYPES.includes(event.type as never)
      ) {
        return {
          type: event.type as SandboxEventType,
          id,
        } as SandboxEvent;
      }
      return { type: "unknown", raw: parsed };
    }
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
