import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import type {
  CraftEditorPayload,
  CraftScheduledRunContext,
  CraftScheduledRunSummary,
  CraftScheduledTaskDetail,
  CraftScheduledTaskEditorMode,
  CraftScheduledTaskListItem,
  CraftScheduledTaskStatus,
} from "./types";

/**
 * The scheduled-task REST surface: the same `/api/craft/**` tree the rest of the feature reads,
 * split into its own module because it is a page's worth of verbs (onyx `v1/tasks/api.ts`) — the
 * transport convention (everything through `client`) is unchanged, only the address book grows.
 *
 * `scheduled-run-context` answers 404 for an ordinary interactive session by contract — the
 * banner's "nothing to show" — so its one reader turns that status into null instead of an error.
 */

const tasksPath = (suffix = "") => `/api/craft/scheduled-tasks${suffix}`;

export function listScheduledTasks(
  signal?: AbortSignal,
): Promise<CraftScheduledTaskListItem[]> {
  return client(tasksPath(), {
    fallback: "The scheduled tasks could not be loaded.",
    signal,
  })
    .then((r) => r.json())
    .then((body: { items: CraftScheduledTaskListItem[] }) => body.items);
}

export function getScheduledTask(
  id: string,
  signal?: AbortSignal,
): Promise<CraftScheduledTaskDetail> {
  return client(tasksPath(`/${encodeURIComponent(id)}`), {
    fallback: "The scheduled task could not be loaded.",
    signal,
  }).then((r) => r.json());
}

export type ScheduledTaskDraft = {
  name: string;
  prompt: string;
  editor_mode: CraftScheduledTaskEditorMode;
  editor_payload: CraftEditorPayload;
  status?: CraftScheduledTaskStatus;
  run_immediately?: boolean;
};

export function createScheduledTask(
  draft: ScheduledTaskDraft,
): Promise<CraftScheduledTaskDetail> {
  return client(tasksPath(), {
    method: "POST",
    body: draft,
    fallback: "The scheduled task could not be created.",
  }).then((r) => r.json());
}

export function updateScheduledTask(
  id: string,
  draft: Partial<ScheduledTaskDraft>,
): Promise<CraftScheduledTaskDetail> {
  return client(tasksPath(`/${encodeURIComponent(id)}`), {
    method: "PUT",
    body: draft,
    fallback: "The scheduled task could not be saved.",
  }).then((r) => r.json());
}

export function deleteScheduledTask(id: string): Promise<void> {
  return client(tasksPath(`/${encodeURIComponent(id)}`), {
    method: "DELETE",
    fallback: "The scheduled task could not be deleted.",
  }).then(() => undefined);
}

/** One-off fire (allowed on paused tasks; never touches the recurrence). */
export function runScheduledTaskNow(
  id: string,
): Promise<{ run_id: string; status: CraftScheduledRunSummary["status"] }> {
  return client(tasksPath(`/${encodeURIComponent(id)}/run-now`), {
    method: "POST",
    fallback: "The task could not be run.",
  }).then((r) => r.json());
}

export function listScheduledTaskRuns(
  id: string,
  signal?: AbortSignal,
): Promise<CraftScheduledRunSummary[]> {
  return client(tasksPath(`/${encodeURIComponent(id)}/runs`), {
    fallback: "The run history could not be loaded.",
    signal,
  })
    .then((r) => r.json())
    .then((body: { items: CraftScheduledRunSummary[] }) => body.items);
}

/**
 * The banner's one read. 404 is the normal answer for an interactive session, so it resolves to
 * null rather than throwing — an error only means the request itself failed.
 */
export async function fetchScheduledRunContext(
  sessionId: string,
  signal?: AbortSignal,
): Promise<CraftScheduledRunContext | null> {
  // tryClient, not client: 404 is a refusal this reader interprets (null), so the
  // status must arrive here rather than turn into client's thrown sentence.
  const response = await tryClient(
    `/api/craft/sessions/${encodeURIComponent(sessionId)}/scheduled-run-context`,
    { fallback: "The scheduled-run context could not be loaded.", signal },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error("The scheduled-run context could not be loaded.");
  }
  return response.json() as Promise<CraftScheduledRunContext>;
}

/** The SSE URL for a session's live scheduled run; the browser (not `client`) reads it. */
export function scheduledRunEventsUrl(sessionId: string): string {
  return `/api/craft/sessions/${encodeURIComponent(sessionId)}/scheduled-run-events`;
}

// ── queries ─────────────────────────────────────────────────────────────────────

export const craftScheduledTaskKeys = {
  all: ["craft", "scheduledTasks"] as const,
  list: () => ["craft", "scheduledTasks", "list"] as const,
  detail: (id: string) => ["craft", "scheduledTasks", "detail", id] as const,
  runs: (id: string) => ["craft", "scheduledTasks", "runs", id] as const,
};

export const scheduledTasksQueryOptions = () =>
  queryOptions({
    queryKey: craftScheduledTaskKeys.list(),
    queryFn: ({ signal }) => listScheduledTasks(signal),
  });

export const scheduledTaskQueryOptions = (id: string) =>
  queryOptions({
    queryKey: craftScheduledTaskKeys.detail(id),
    queryFn: ({ signal }) => getScheduledTask(id, signal),
  });

export const scheduledTaskRunsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: craftScheduledTaskKeys.runs(id),
    queryFn: ({ signal }) => listScheduledTaskRuns(id, signal),
  });

/** In-flight statuses, lowercase wire form (onyx's in-flight set: RUNNING | AWAITING_APPROVAL). */
export function isScheduledRunInFlight(
  context: CraftScheduledRunContext | null | undefined,
): boolean {
  return (
    context?.status === "running" ||
    context?.status === "queued" ||
    context?.status === "awaiting_approval"
  );
}

export const scheduledRunContextKey = (sessionId: string) =>
  ["craft", "scheduledRunContext", sessionId] as const;

/**
 * The banner's poll: watched only while a run is in flight (the queued → running handoff, and a
 * run that resolves without the stream seeing it), otherwise a settled answer is final.
 */
export const scheduledRunContextQueryOptions = (sessionId: string) =>
  queryOptions({
    queryKey: scheduledRunContextKey(sessionId),
    queryFn: ({ signal }) => fetchScheduledRunContext(sessionId, signal),
    retry: false,
    refetchInterval: (query) =>
      isScheduledRunInFlight(query.state.data) ? 5000 : false,
  });
