import {
  type QueryClient,
  type QueryFunction,
  queryOptions,
} from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { guarded } from "@/lib/enterprise/tenant/queries";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
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

/**
 * The selection pair a scoped scheduled-task call rides (MT091 / Issue #134, AC3 — 调度动作提交
 * 当前范围), spread into the client options; the shape is the craft client's own.
 */
export type CraftScopePair = { tenantId?: string; workspaceId?: string };

export function listScheduledTasks(
  signal?: AbortSignal,
  scope?: CraftScopePair,
): Promise<CraftScheduledTaskListItem[]> {
  return client(tasksPath(), {
    fallback: "The scheduled tasks could not be loaded.",
    signal,
    ...(scope ?? {}),
  })
    .then((r) => r.json())
    .then((body: { items: CraftScheduledTaskListItem[] }) => body.items);
}

export function getScheduledTask(
  id: string,
  signal?: AbortSignal,
  scope?: CraftScopePair,
): Promise<CraftScheduledTaskDetail> {
  return client(tasksPath(`/${encodeURIComponent(id)}`), {
    fallback: "The scheduled task could not be loaded.",
    signal,
    ...(scope ?? {}),
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
  scope?: CraftScopePair,
): Promise<CraftScheduledTaskDetail> {
  return client(tasksPath(), {
    method: "POST",
    body: draft,
    fallback: "The scheduled task could not be created.",
    ...(scope ?? {}),
  }).then((r) => r.json());
}

export function updateScheduledTask(
  id: string,
  draft: Partial<ScheduledTaskDraft>,
  scope?: CraftScopePair,
): Promise<CraftScheduledTaskDetail> {
  return client(tasksPath(`/${encodeURIComponent(id)}`), {
    method: "PUT",
    body: draft,
    fallback: "The scheduled task could not be saved.",
    ...(scope ?? {}),
  }).then((r) => r.json());
}

export function deleteScheduledTask(
  id: string,
  scope?: CraftScopePair,
): Promise<void> {
  return client(tasksPath(`/${encodeURIComponent(id)}`), {
    method: "DELETE",
    fallback: "The scheduled task could not be deleted.",
    ...(scope ?? {}),
  }).then(() => undefined);
}

/** One-off fire (allowed on paused tasks; never touches the recurrence). */
export function runScheduledTaskNow(
  id: string,
  scope?: CraftScopePair,
): Promise<{ run_id: string; status: CraftScheduledRunSummary["status"] }> {
  return client(tasksPath(`/${encodeURIComponent(id)}/run-now`), {
    method: "POST",
    fallback: "The task could not be run.",
    ...(scope ?? {}),
  }).then((r) => r.json());
}

export function listScheduledTaskRuns(
  id: string,
  signal?: AbortSignal,
  scope?: CraftScopePair,
): Promise<CraftScheduledRunSummary[]> {
  return client(tasksPath(`/${encodeURIComponent(id)}/runs`), {
    fallback: "The run history could not be loaded.",
    signal,
    ...(scope ?? {}),
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
  scope?: CraftScopePair,
): Promise<CraftScheduledRunContext | null> {
  // tryClient, not client: 404 is a refusal this reader interprets (null), so the
  // status must arrive here rather than turn into client's thrown sentence.
  const response = await tryClient(
    `/api/craft/sessions/${encodeURIComponent(sessionId)}/scheduled-run-context`,
    {
      fallback: "The scheduled-run context could not be loaded.",
      signal,
      ...(scope ?? {}),
    },
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
      isScheduledRunInFlight(
        query.state.data as CraftScheduledRunContext | null | undefined,
      )
        ? 5000
        : false,
  });

// ---------------------------------------------------------------------------
// The scoped half (MT091 / Issue #134): the scheduled-tasks page reads and writes through here
// ---------------------------------------------------------------------------

/**
 * The tasks roster, bound to the scope the screen holds (MT091 AC1/AC3): the list is the
 * server's answer under the selection in force, and every write the page submits rides the
 * same pair.
 */
export function scopedScheduledTasksQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...craftScheduledTaskKeys.list()]
        : [...craftScheduledTaskKeys.list(), ":scope-pending"],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<CraftScheduledTaskListItem[]>(() => {})
        : async ({ signal }): Promise<CraftScheduledTaskListItem[]> =>
            guarded(queryClient, open.userId, () =>
              listScheduledTasks(signal, open.selection ?? {}),
            ),
  });
}

/** One task's detail (the editor's load), bound to the scope. */
export function scopedScheduledTaskQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  id: string,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...craftScheduledTaskKeys.detail(id)]
        : [...craftScheduledTaskKeys.detail(id), ":scope-pending"],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<CraftScheduledTaskDetail>(() => {})
        : async ({ signal }): Promise<CraftScheduledTaskDetail> =>
            guarded(queryClient, open.userId, () =>
              getScheduledTask(id, signal, open.selection ?? {}),
            ),
  });
}

/** The run history, bound to the scope. */
export function scopedScheduledTaskRunsQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  id: string,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...craftScheduledTaskKeys.runs(id)]
        : [...craftScheduledTaskKeys.runs(id), ":scope-pending"],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<CraftScheduledRunSummary[]>(() => {})
        : async ({ signal }): Promise<CraftScheduledRunSummary[]> =>
            guarded(queryClient, open.userId, () =>
              listScheduledTaskRuns(id, signal, open.selection ?? {}),
            ),
  });
}

/**
 * The banner's poll, bound to the scope with its own discipline kept verbatim: watched only
 * while a run is in flight, 404 resolves to null, retry off.
 */
export function scopedScheduledRunContextQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  sessionId: string,
) {
  const open = scope.status === "open" ? scope : null;
  // Same discipline as the sandbox poll in queries.ts: the cadence callback reads the answer,
  // so the queryFn is typed up front for both branches.
  const queryFn: QueryFunction<CraftScheduledRunContext | null> =
    open === null
      ? () => new Promise<CraftScheduledRunContext | null>(() => {})
      : ({ signal }) =>
          guarded(queryClient, open.userId, () =>
            fetchScheduledRunContext(sessionId, signal, open.selection ?? {}),
          );
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...scheduledRunContextKey(sessionId)]
        : [...scheduledRunContextKey(sessionId), ":scope-pending"],
    enabled: open !== null,
    retry: false,
    refetchInterval: (query) =>
      isScheduledRunInFlight(query.state.data) ? 5000 : false,
    queryFn,
  });
}
