/**
 * The craft feature's wire types, typed for the browser.
 *
 * These mirror the server's `/api/craft/**` contract field-for-field. The server is the author of
 * the contract; when the two drift, this file moves. Field names are the snake_case the API
 * answers with (`session-routes.ts` builds the session shape, `streaming.ts` builds the packet
 * shape), not a translation of it — a packet that lands in `craft_messages.message_metadata` is
 * byte-identical to the one the SSE delivered live, so the transcript renders history and live
 * with the same objects.
 */

/** One session as `GET /sessions` / `GET /sessions/:id` answer — `sessionResponse`'s shape. */
export type CraftSession = {
  id: string;
  user_id: string;
  name: string | null;
  status: "initializing" | "active" | "idle" | "failed";
  created_at: string;
  last_activity_at: string;
  nextjs_port: number | null;
  sharing_scope: "private" | "public_org";
  origin: string;
  agent_provider: string | null;
  agent_model: string | null;
  opencode_session_id: string | null;
  skills_stale: boolean;
};

/** One transcript row as `GET /sessions/:id/messages` answers. */
export type CraftMessage = {
  id: string;
  session_id: string;
  turn_index: number;
  type: string;
  message_metadata: Record<string, unknown>;
  created_at: string;
};

/** The six gallery kinds `artifactTypeFor` classifies a produced file into. */
export type CraftArtifactType =
  | "csv"
  | "chart"
  | "report"
  | "webapp"
  | "file"
  | "dataset";

/** One node of a craft session's file tree (`GET /files`), or an artifact gallery row. */
export type CraftFileEntry = {
  path: string;
  name: string;
  kind: "file" | "dir";
  sizeBytes: number;
  updatedAt: string;
};

export type CraftArtifactEntry = CraftFileEntry & {
  type: CraftArtifactType;
};

/** The tool category field — a wire value, not a TS discriminant. */
export type CraftToolKind =
  | "execute"
  | "read"
  | "edit"
  | "search"
  | "fetch"
  | "other";

export type CraftToolStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

export type CraftTextContent = { type: "text"; text: string };

export type CraftDiffBlock = {
  type: "diff";
  path: string;
  oldText: string;
  newText: string;
};

export type CraftToolOutputBlock =
  | CraftDiffBlock
  | { type: "content"; content: unknown };

export type CraftAgentMessageChunk = {
  type: "agent_message_chunk";
  sessionUpdate: "agent_message_chunk";
  content: CraftTextContent;
  timestamp: string;
  _meta?: Record<string, unknown>;
};

export type CraftAgentThoughtChunk = {
  type: "agent_thought_chunk";
  sessionUpdate: "agent_thought_chunk";
  content: CraftTextContent;
  timestamp: string;
  _meta?: Record<string, unknown>;
};

export type CraftToolCallStart = {
  type: "tool_call_start";
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind: CraftToolKind;
  status: "pending" | "in_progress";
  rawInput?: unknown;
  _meta?: Record<string, unknown>;
  timestamp: string;
};

export type CraftToolCallProgress = {
  type: "tool_call_progress";
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  title: string;
  kind: CraftToolKind;
  status: "completed" | "failed";
  rawInput?: unknown;
  rawOutput?: { output?: unknown; metadata?: unknown } & Record<
    string,
    unknown
  >;
  content?: CraftToolOutputBlock[];
  _meta?: Record<string, unknown>;
  timestamp: string;
};

export type CraftAgentPlanUpdate = {
  type: "agent_plan_update";
  entries: unknown;
  timestamp: string;
};

export type CraftPromptResponse = {
  type: "prompt_response";
  stopReason: string;
  timestamp: string;
};

export type CraftErrorPacket = {
  type: "error";
  message: string;
  timestamp: string;
};

export type CraftContextUsagePacket = {
  type: "context_usage";
  used_tokens: number;
  cost: number | null;
  timestamp: string;
};

export type CraftCompactionPacket = {
  type: "compaction";
  summary: string | null;
  timestamp: string;
};

/** One frame the turn SSE can deliver (`event: message` data payload). */
export type CraftStreamPacket =
  | CraftAgentMessageChunk
  | CraftAgentThoughtChunk
  | CraftToolCallStart
  | CraftToolCallProgress
  | CraftAgentPlanUpdate
  | CraftPromptResponse
  | CraftErrorPacket
  | CraftContextUsagePacket
  | CraftCompactionPacket;

/** What a `webapp-info` read answers with. */
export type CraftWebappInfo = {
  has_webapp: boolean | null;
  webapp_url: string | null;
  status: string;
  ready: boolean;
};

/** A pending approval the session is waiting on, as the live read returns it. */
export type CraftApproval = {
  id: string;
  status: string;
  decision: string | null;
  created_at: string;
  action: {
    bot_id: string;
    tool_ref: string;
    effect: string;
    scope: string;
    args: unknown;
  };
};
