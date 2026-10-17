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

/**
 * One uploaded attachment — the wire shape both the upload response's `path` feeds and the
 * send-message body carries (`{name, path, mime_type}`, onyx's MessageAttachment).
 */
export type CraftAttachment = {
  name: string;
  path: string;
  mime_type: string;
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

/** A gated permission is waiting on a decision — revalidate the live approvals list. */
export type CraftApprovalRequestedPacket = {
  type: "approval_requested";
  approval_id: string;
  session_id: string;
  timestamp: string;
};

/** A subagent session was spawned by the turn's `task` tool — seeds the subagent map. */
export type CraftSubagentStartedPacket = {
  type: "subagent_started";
  subagent_session_id: string;
  parent_session_id: string;
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
  | CraftCompactionPacket
  | CraftApprovalRequestedPacket
  | CraftSubagentStartedPacket;

/** What a `webapp-info` read answers with. */
export type CraftWebappInfo = {
  has_webapp: boolean | null;
  /** D11 (#362): the ABSOLUTE preview address — null while the origin is closed or unsandboxed. */
  webapp_url: string | null;
  /** The same address as its own field (the ticket exchange's `origin` target). */
  previewOrigin: string | null;
  /** m-5 (#362): the displayable sentence for WHY no preview address exists. */
  previewOriginClosedReason: string | null;
  /**
   * #367 (D10): which preview this session gets. "legacy" — the app predates
   * the preview origin; `webapp_url` is the OLD same-origin path and the pane
   * iframes it directly (the platform's own cookies authenticate it, no pass).
   * "current" — the absolute preview origin + the ticket exchange. Optional so
   * an older server answer still types.
   */
  webappGeneration?: "legacy" | "current";
  status: string;
  ready: boolean;
};

/**
 * What `POST /sessions/:id/preview-ticket` answers (#360/#362): a single-use,
 * 30-second pass the preview origin redeems — the ticket rides exactly one hop
 * (the entry URL below) and dies in the 302 that follows it.
 */
export type CraftPreviewTicket = {
  ticket: string;
  expiresAt: string;
  /** The absolute preview address to enter with `?ticket=` appended once. */
  origin: string;
};

/**
 * The sandbox lifecycle values the status chip renders — onyx's SandboxStatus enum verbatim
 * (backend db/enums.py). "restoring" is client-owned (the wake fetch's in-flight window) and
 * "terminated" can only arrive from a future sandbox backend; the endpoint itself answers the
 * other four, or null when no sandbox backs the session.
 */
export type CraftSandboxStatus =
  | "provisioning"
  | "running"
  | "sleeping"
  | "restoring"
  | "terminated"
  | "failed";

/** What `GET /sessions/:id/sandbox-status` answers — onyx's SandboxStatusResponse. */
export type CraftSandboxStatusResponse = {
  status: CraftSandboxStatus | null;
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

// ── scheduled tasks (server: craft/scheduled-tasks.ts, onyx interfaces.ts) ──

export type CraftScheduledTaskStatus = "active" | "paused";

export type CraftScheduledTaskRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "awaiting_approval";

export type CraftScheduledTaskTriggerSource = "scheduled" | "manual_run_now";

export type CraftScheduledTaskEditorMode =
  | "interval"
  | "daily_weekly"
  | "advanced";

export type CraftIntervalUnit = "minutes" | "hours" | "days";

/** The three editor payloads, one per `editor_mode` (onyx interfaces.ts verbatim). */
export type CraftIntervalPayload = {
  unit: CraftIntervalUnit;
  every: number;
  /** "HH:MM" — required when unit is "days". */
  time_of_day?: string | null;
};

export type CraftDailyWeeklyPayload = {
  /** "HH:MM". */
  time_of_day: string;
  /** Cron weekday convention (0=Sunday..6=Saturday); empty/omitted means every day. */
  weekdays?: number[];
};

export type CraftAdvancedPayload = {
  cron: string;
};

export type CraftEditorPayload =
  | CraftIntervalPayload
  | CraftDailyWeeklyPayload
  | CraftAdvancedPayload;

/** One row of `GET /scheduled-tasks/:id/runs`, and the `last_run` field everywhere. */
export type CraftScheduledRunSummary = {
  id: string;
  status: CraftScheduledTaskRunStatus;
  trigger_source: CraftScheduledTaskTriggerSource;
  started_at: string;
  finished_at: string | null;
  session_id: string | null;
  summary: string | null;
  skip_reason: string | null;
  error_class: string | null;
};

export type CraftScheduledTaskListItem = {
  id: string;
  name: string;
  human_readable_schedule: string;
  cron_expression: string;
  editor_mode: CraftScheduledTaskEditorMode;
  status: CraftScheduledTaskStatus;
  next_run_at: string | null;
  last_run: CraftScheduledRunSummary | null;
  created_at: string;
  updated_at: string;
};

/** The detail read adds the prompt and the next-3-fires preview. */
export type CraftScheduledTaskDetail = CraftScheduledTaskListItem & {
  prompt: string;
  next_runs: string[];
};

/** The session-view banner's one read (`GET /sessions/:id/scheduled-run-context`). */
export type CraftScheduledRunContext = {
  run_id: string;
  task_id: string;
  task_name: string;
  status: CraftScheduledTaskRunStatus;
  started_at: string;
  finished_at: string | null;
};
