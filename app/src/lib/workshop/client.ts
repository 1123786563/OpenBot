import { client } from "@/lib/client";

/**
 * The workshop's REST surface, typed for the browser.
 *
 * Every response shape here mirrors what the server's `/api/workshop/**` routes answer with,
 * field for field. The server side is the contract's author; when the two drift, this file is
 * the one that must move. Paths are per-channel because the workshop hangs off a conversation:
 * a channel has at most one workshop session, and every route below addresses it that way.
 */

/** The five turn statuses plus queued, exactly as `workshop_turns.status` holds them. */
export type WorkshopTurnStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/** Who started a turn: a person in the tab, a headless tool call, or a schedule firing. */
export type WorkshopTurnInitiator = "person" | "headless" | "schedule";

/** One turn of the workshop, as the list and the snapshot both carry it. */
export type WorkshopTurn = {
  id: string;
  sessionId: string;
  turnIndex: number;
  status: WorkshopTurnStatus;
  initiator: WorkshopTurnInitiator;
  prompt: string;
  error: string | null;
  /** Copy for display only; metering reads `code_runs` on the server. */
  usage: WorkshopUsage | null;
  startedAt: string;
  finishedAt: string | null;
};

/** The six artifact kinds the indexer sorts a run's outputs into. */
export type WorkshopArtifactType =
  | "csv"
  | "chart"
  | "report"
  | "webapp"
  | "file"
  | "dataset";

/**
 * Whether an artifact travels with a share link. `private` is how a sensitive intermediate file
 * stays out of a shared session; the default inherits the session's own setting.
 */
export type WorkshopArtifactVisibility = "private" | "public";

export type WorkshopArtifact = {
  id: string;
  sessionId: string;
  type: WorkshopArtifactType;
  name: string;
  path: string;
  sizeBytes: number;
  previewUrl: string | null;
  visibility: WorkshopArtifactVisibility;
  createdAt: string;
};

/** One node of the sandbox file tree: a file, or a directory holding more nodes. */
export type WorkshopFileNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  /** Files only: truncated at the server's read cap, so the UI knows it is a preview. */
  truncated?: boolean;
  /** Directories only; absent on files. */
  children?: WorkshopFileNode[];
};

/** Token usage of a turn, the shape the usage card renders. */
export type WorkshopUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Cost in the deployment's currency, when the deployment prices models; absent otherwise. */
  cost?: number;
};

/** The sandbox's readiness for this channel's workshop, as the aggregate reports it. */
export type WorkshopSandboxStatus =
  | { kind: "ready" }
  | { kind: "not_configured"; reason: string }
  | { kind: "busy" };

/** `private`, `unlisted` (token reaches it, not indexed) or `public`. */
export type WorkshopVisibility = "private" | "unlisted" | "public";

/** Whether a share permits downloads or only the preview. */
export type WorkshopShareScope = "preview" | "preview_download";

/** The share state of a session, as the snapshot carries it. Token plaintext is never here. */
export type WorkshopShareState = {
  visibility: WorkshopVisibility;
  scope: WorkshopShareScope;
  shareUrl: string | null;
  shareExpiresAt: string | null;
  shareRevokedAt: string | null;
};

/**
 * Everything one workshop tab renders, in one request.
 *
 * The aggregate exists so the first paint is one round trip: the session, its artifacts, its
 * recent turns, the sandbox's state and the running usage total.
 */
export type WorkshopSnapshot = {
  session: {
    id: string;
    channelId: string;
    botId: string;
    status: "active" | "archived";
    visibility: WorkshopVisibility;
    createdAt: string;
    lastActivityAt: string;
  };
  turns: WorkshopTurn[];
  artifacts: WorkshopArtifact[];
  sandbox: WorkshopSandboxStatus;
  usage: {
    /** Sum across the session's turns; the server computes, the client displays. */
    total: WorkshopUsage;
  };
  share: WorkshopShareState;
};

/** What POST .../turns answers with: the turn exists, its id is how the stream is addressed. */
export type StartTurnResponse = { turnId: string };

/** Whether a cancel landed before the turn settled. */
export type CancelTurnResponse = { cancelled: boolean };

/** What POST .../reset answers with: which session's workspace was wiped. */
export type ResetResponse = { sessionId: string };
/**
 * What creating a share answers with. `token` is the ONLY time the plaintext exists on this
 * side: the server stores a hash, shows it once, and every later read has only `shareUrl`.
 * Callers must render it immediately and never log or cache it.
 */
export type CreateShareResponse = {
  token: string;
  shareUrl: string;
  scope: WorkshopShareScope;
  expiresAt: string | null;
};

/**
 * The five translated event kinds the turn stream carries, plus the catch-all.
 *
 * The server translates the sandbox's raw events into these before persisting them; `unknown`
 * is a translated "could not classify" rather than an error, because a stream must not die on
 * an event shape nobody has seen yet.
 */
export type WorkshopStreamEvent =
  | { seq: number; type: "message_chunk"; text: string }
  | { seq: number; type: "thought"; text: string }
  | { seq: number; type: "tool_call"; tool: string; arguments: unknown }
  | { seq: number; type: "progress"; label: string }
  | { seq: number; type: "prompt_response"; text: string }
  | { seq: number; type: "subagent"; detail: unknown }
  | { seq: number; type: "unknown"; raw: unknown };

const workshopPath = (channelId: string, suffix = "") =>
  `/api/workshop/${encodeURIComponent(channelId)}${suffix}`;

/** The snapshot: one request, the whole tab. */
export function workshopSnapshot(
  channelId: string,
  signal?: AbortSignal,
): Promise<WorkshopSnapshot> {
  return client(workshopPath(channelId), {
    fallback: "The workshop could not be loaded.",
    signal,
  }).then((response) => response.json() as Promise<WorkshopSnapshot>);
}

/** Start a turn. The prompt reaches the orchestrator exactly as typed; the id is for streaming. */
export function startWorkshopTurn(
  channelId: string,
  input: { prompt: string },
  signal?: AbortSignal,
): Promise<StartTurnResponse> {
  return client(workshopPath(channelId, "/turns"), {
    method: "POST",
    body: input,
    fallback: "The turn could not be started.",
    signal,
  }).then((response) => response.json() as Promise<StartTurnResponse>);
}

/** Ask a running turn to stop. Settled turns answer `cancelled: false`, not an error. */
export function cancelWorkshopTurn(
  channelId: string,
  turnId: string,
): Promise<CancelTurnResponse> {
  return client(
    workshopPath(channelId, `/turns/${encodeURIComponent(turnId)}/cancel`),
    {
      method: "POST",
      fallback: "The turn could not be stopped.",
    },
  ).then((response) => response.json() as Promise<CancelTurnResponse>);
}

/**
 * A settled turn's persisted events, straight from the store (no stream): the same wire
 * shape the SSE delivered live, so the view renders history and live identically.
 */
export function fetchWorkshopTurnEvents(
  channelId: string,
  turnId: string,
): Promise<{ turnId: string; events: WorkshopStreamEvent[] }> {
  return client(
    workshopPath(channelId, `/turns/${encodeURIComponent(turnId)}/events`),
    {
      fallback: "The turn's events could not be loaded.",
    },
  ).then(
    (response) =>
      response.json() as Promise<{ turnId: string; events: WorkshopStreamEvent[] }>,
  );
}

/** The file tree at a path; the root when `path` is omitted. */
export function listWorkshopFiles(
  channelId: string,
  path = "",
  signal?: AbortSignal,
): Promise<WorkshopFileNode[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return client(workshopPath(channelId, `/files${query}`), {
    fallback: "The files could not be listed.",
    signal,
  }).then((response) => response.json() as Promise<WorkshopFileNode[]>);
}

/**
 * Upload files into the workspace. multipart rather than JSON, so the browser streams the bytes
 * rather than reading them into strings; the server enforces the limits and its refusal text is
 * what the caller should surface.
 */
export async function uploadWorkshopFiles(
  channelId: string,
  files: File[],
): Promise<{ uploaded: number }> {
  const body = new FormData();
  for (const file of files) body.append("files", file, file.name);
  const response = await fetch(workshopPath(channelId, "/files/upload"), {
    method: "POST",
    credentials: "include",
    body,
  });
  if (!response.ok) {
    const reason = (await response
      .json()
      .catch(() => null)) as { error?: string } | null;
    throw new Error(reason?.error ?? "The upload was refused.");
  }
  return (await response.json()) as { uploaded: number };
}

/** A download URL: single artifact, or a zip when the artifact is a directory. */
export function workshopArtifactDownloadUrl(
  channelId: string,
  artifactId: string,
): string {
  return workshopPath(channelId, `/artifacts/${encodeURIComponent(artifactId)}/download`);
}

/**
 * Open a share. The response carries the token plaintext exactly once — render it now or lose
 * it; the server keeps only the hash and cannot answer this question again.
 */
export function createWorkshopShare(
  channelId: string,
  input: { scope: WorkshopShareScope; expiresInDays?: number },
): Promise<CreateShareResponse> {
  return client(workshopPath(channelId, "/share"), {
    method: "POST",
    body: input,
    fallback: "The share link could not be created.",
  }).then((response) => response.json() as Promise<CreateShareResponse>);
}

/** Close a share. Existing links stop working; the session and its artifacts stay. */
export function revokeWorkshopShare(channelId: string): Promise<void> {
  return client(workshopPath(channelId, "/share"), {
    method: "DELETE",
    fallback: "The share link could not be revoked.",
  }).then(() => undefined);
}

// ── schedules (B16/B17/F10) ────────────────────────────────────────────────────

/** One schedule as the panel lists it: the rule, its clocks, and its boundary. */
export type WorkshopSchedule = {
  id: string;
  prompt: string;
  rrule: string;
  timezone: string | null;
  status: "enabled" | "paused" | "deleted";
  preapproved: { paths: string[]; tools: string[]; maxTurnsPerRun: number } | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
};

/** One firing as the history shows it: planned, settled, or skipped — with its sentence. */
export type WorkshopScheduleRun = {
  id: string;
  scheduleId: string;
  scheduledFor: string;
  turnId: string | null;
  status: "planned" | "running" | "succeeded" | "failed" | "skipped";
  note: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

/** The three modes the compiler accepts, structured — the panel never sends cron text. */
export type ScheduleMode =
  | { kind: "interval"; every: number; unit: "minutes" | "hours" | "days" }
  | { kind: "daily"; time: string; days?: string[] }
  | { kind: "advanced"; cron: string };

/** The schedules answer: the list and the recent runs, one call. */
export type SchedulesResponse = {
  schedules: WorkshopSchedule[];
  runs: WorkshopScheduleRun[];
};

export function listWorkshopSchedules(
  channelId: string,
): Promise<SchedulesResponse> {
  return client(workshopPath(channelId, "/schedules"), {
    fallback: "The schedules could not be loaded.",
  }).then((response) => response.json() as Promise<SchedulesResponse>);
}

export function createWorkshopSchedule(
  channelId: string,
  input: {
    prompt: string;
    mode: ScheduleMode;
    timezone?: string;
    preapproval?: { paths?: string[]; tools?: string[]; maxTurnsPerRun?: number };
  },
): Promise<{ id: string; rrule: string }> {
  return client(workshopPath(channelId, "/schedules"), {
    method: "POST",
    body: input,
    fallback: "The schedule could not be created.",
  }).then((response) => response.json() as Promise<{ id: string; rrule: string }>);
}

export function toggleWorkshopSchedule(
  channelId: string,
  id: string,
  enabled: boolean,
): Promise<{ id: string; status: string }> {
  return client(workshopPath(channelId, `/schedules/${encodeURIComponent(id)}`), {
    method: "PATCH",
    body: { enabled },
    fallback: "The schedule could not be toggled.",
  }).then((response) => response.json() as Promise<{ id: string; status: string }>);
}

export function deleteWorkshopSchedule(
  channelId: string,
  id: string,
): Promise<{ ok: boolean }> {
  return client(workshopPath(channelId, `/schedules/${encodeURIComponent(id)}`), {
    method: "DELETE",
    fallback: "The schedule could not be deleted.",
  }).then((response) => response.json() as Promise<{ ok: boolean }>);
}

/** Wipe the workspace and start the session over. Artifacts and turns are kept as history. */
export function resetWorkshop(channelId: string): Promise<ResetResponse> {
  return client(workshopPath(channelId, "/reset"), {
    method: "POST",
    fallback: "The workspace could not be reset.",
  }).then((response) => response.json() as Promise<ResetResponse>);
}

/**
 * The turn stream's URL, for an EventSource the caller owns.
 *
 * `lastEventId` is the reconnect protocol: EventSource sends it as `Last-Event-ID` and the
 * server answers everything after that seq, so a dropped connection costs no events. The
 * URL is a parameter rather than a hidden constructor here so tests can point it at a stub.
 */
export function workshopEventsUrl(
  channelId: string,
  lastEventId?: number | string,
): string {
  const base = workshopPath(channelId, "/events");
  return lastEventId === undefined
    ? base
    : `${base}?lastEventId=${encodeURIComponent(String(lastEventId))}`;
}

/** Parse one SSE `data` payload off the stream into a typed event; unknown shapes stay events. */
export function parseWorkshopStreamEvent(raw: string): WorkshopStreamEvent {
  const parsed = JSON.parse(raw) as Partial<WorkshopStreamEvent> & {
    seq?: unknown;
    type?: unknown;
  };
  const seq = typeof parsed.seq === "number" ? parsed.seq : -1;
  switch (parsed.type) {
    case "message_chunk":
      return { seq, type: "message_chunk", text: String(parsed.text ?? "") };
    case "thought":
      return { seq, type: "thought", text: String(parsed.text ?? "") };
    case "tool_call":
      return {
        seq,
        type: "tool_call",
        tool: String(parsed.tool ?? ""),
        arguments: (parsed as { arguments?: unknown }).arguments ?? null,
      };
    case "progress":
      return { seq, type: "progress", label: String(parsed.label ?? "") };
    case "prompt_response":
      return {
        seq,
        type: "prompt_response",
        text: String(parsed.text ?? ""),
      };
    case "subagent":
      return { seq, type: "subagent", detail: parsed.detail ?? null };
    default:
      return { seq, type: "unknown", raw: parsed };
  }
}
