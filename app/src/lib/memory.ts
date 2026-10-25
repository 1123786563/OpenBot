import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { guarded } from "@/lib/enterprise/tenant/queries";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

/** The selection pair a scoped call rides, spread into the client options (MT089). */
type ScopePair = { tenantId?: string; workspaceId?: string };

/**
 * The scope the writes here submit under (MT089 / Issue #132, AC2): an open scope's selection
 * rides the request, and a pending one submits nothing.
 */
function scopePair(scope: ScopedCache | undefined): ScopePair | undefined {
  return scope !== undefined && scope.status === "open"
    ? (scope.selection ?? {})
    : undefined;
}
export type MemoryRecord = {
  id: string;
  content: string;
  provenance: string;
  sourceId: string | null;
  enabled: boolean;
  reviewState: "unreviewed" | "confirmed" | "edited";
  formedBy: "person" | "import" | "bot";
  formedByAgentId: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
  observedAt: string | null;
  updatedAt: string;
};
export type MemorySource = {
  id: string;
  title: string;
  agentId: string;
  toolRef: string;
  enabled: boolean;
  syncStatus: "idle" | "running" | "succeeded" | "error";
  syncError: string | null;
  lastSyncAt: string | null;
};
export type MemorySourceTool = {
  ref: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
/** The person's two pause switches (#392): a set timestamp means paused, null means not. */
export type MemoryPauseControls = {
  learningPausedAt: string | null;
  usagePausedAt: string | null;
};
/** The subject types the sync status surface answers for; the memory rows map onto these (#394). */
export type MemorySyncSubjectType = "preference" | "source_bound";
/**
 * One memory's sync status as the status surface answers it (#384): `indexed` only when the
 * retained digest equals the content, `pending`, `failed` with a retry coming, or
 * `unknown-subject` when the chain holds no such subject.
 */
export type MemorySyncStatus =
  | { state: "indexed"; syncedAt: string | null }
  | { state: "pending"; attempts: number }
  | {
      state: "failed";
      attempts: number;
      lastError: string | null;
      willRetry: true;
    }
  | { state: "unknown-subject" };
export const memoryKeys = {
  all: ["memory"] as const,
  sources: ["memory", "sources"] as const,
  available: (id: string) => ["memory", "available", id] as const,
  pauseControls: ["memory", "pause-controls"] as const,
  /** One batched read for every badge a listing draws (#384, FIX-OCR1 / #376). */
  syncStatuses: ["memory", "sync-statuses"] as const,
};

/** The subjects a batched status read names: the listing's rows, as the chain types them. */
export type MemorySyncSubject = {
  subjectType: MemorySyncSubjectType;
  subjectId: string;
};

/** The key one subject's entry sits under in a batched answer: `${subjectType}:${subjectId}`. */
export const memorySyncStatusKey = ({
  subjectType,
  subjectId,
}: MemorySyncSubject) => `${subjectType}:${subjectId}`;

// ---------------------------------------------------------------------------
// The scoped half (MT089 / Issue #132): the memory pages read and write through here
// ---------------------------------------------------------------------------

/**
 * The memories list, bound to the scope the screen holds (MT089 / Issue #132, AC1): keyed under
 * the scope's own cache prefix (MT083), carrying the selection pair, and answered through the
 * generation guard — so the memories a scope holds are that scope's own answer, and a switch
 * drops the old scope's rows wholesale rather than leaving them beside the new scope's.
 */
export function scopedMemoriesQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...memoryKeys.all]
        : [...memoryKeys.all, ":scope-pending"],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<MemoryRecord[]>(() => {})
        : async ({ signal }): Promise<MemoryRecord[]> =>
            guarded(queryClient, open.userId, async () => {
              const response = await tryClient("/api/memory", {
                signal,
                fallbackKey: "memory.load",
                ...(open.selection ?? {}),
              });
              if (!response.ok) {
                throw new Error("Memories could not be read.");
              }
              const body = (await response.json().catch(() => null)) as {
                memories?: MemoryRecord[];
              } | null;
              if (body === null || !Array.isArray(body.memories)) {
                throw new Error("Memories could not be read.");
              }
              return body.memories;
            }),
  });
}

/** The sources list, bound the same way (MT089 AC1: 来源选择只含当前范围有权内容). */
export function scopedMemorySourcesQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...memoryKeys.sources]
        : [...memoryKeys.sources, ":scope-pending"],
    enabled: open !== null,
    refetchInterval: 15_000,
    queryFn:
      open === null
        ? () => new Promise<MemorySource[]>(() => {})
        : async ({ signal }): Promise<MemorySource[]> =>
            guarded(queryClient, open.userId, async () => {
              const response = await tryClient("/api/memory/sources", {
                signal,
                fallbackKey: "memory.loadSources",
                ...(open.selection ?? {}),
              });
              if (!response.ok) {
                throw new Error("Memory sources could not be read.");
              }
              const body = (await response.json().catch(() => null)) as {
                sources?: MemorySource[];
              } | null;
              if (body === null || !Array.isArray(body.sources)) {
                throw new Error("Memory sources could not be read.");
              }
              return body.sources;
            }),
  });
}

/**
 * The tools a source picker may offer, bound the same way (MT089 AC1): the picker's choices are
 * the server's answer under the scope in force, so a tool of another scope is never offered.
 */
export function scopedAvailableMemorySourcesQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  id: string,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...memoryKeys.available(id)]
        : [...memoryKeys.available(id), ":scope-pending"],
    enabled: open !== null && !!id,
    queryFn:
      open === null
        ? () => new Promise<MemorySourceTool[]>(() => {})
        : async ({ signal }): Promise<MemorySourceTool[]> =>
            guarded(queryClient, open.userId, async () => {
              const response = await tryClient(
                `/api/memory/sources/available/${encodeURIComponent(id)}`,
                {
                  signal,
                  fallbackKey: "memory.loadActions",
                  ...(open.selection ?? {}),
                },
              );
              if (!response.ok) {
                throw new Error("Memory actions could not be read.");
              }
              const body = (await response.json().catch(() => null)) as {
                tools?: MemorySourceTool[];
              } | null;
              if (body === null || !Array.isArray(body.tools)) {
                throw new Error("Memory actions could not be read.");
              }
              return body.tools;
            }),
  });
}
/**
 * What the switches' read answers (#392): the state, or why the rows must grey out. A 404 is
 * the deployment mounting no such face at all; a 400 is the resolver's own "no company or team
 * selected" — the switches are keyed by the selection, so the personal context has none. Both
 * are answers about availability rather than faults, so the screen explains instead of
 * reporting an error.
 */
export type MemoryPauseControlsAnswer =
  | { state: "mounted"; controls: MemoryPauseControls }
  | { state: "unmounted" }
  | { state: "no-company" };

export function scopedPauseControlsQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...memoryKeys.pauseControls]
        : [...memoryKeys.pauseControls, ":scope-pending"],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<MemoryPauseControlsAnswer>(() => {})
        : async ({ signal }): Promise<MemoryPauseControlsAnswer> =>
            guarded(queryClient, open.userId, async () => {
              const response = await tryClient("/api/memory/pause-controls", {
                signal,
                ...(open.selection ?? {}),
              });
              if (response.status === 404) return { state: "unmounted" };
              // The GET has no body of its own, so a 400 here is the scope resolver's
              // TENANT_REQUIRED or WORKSPACE_REQUIRED — the personal context, not a fault.
              if (response.status === 400) return { state: "no-company" };
              if (!response.ok) {
                throw new Error("The pause switches could not be read.");
              }
              const body = (await response.json().catch(() => null)) as {
                pauseControls?: MemoryPauseControls;
              } | null;
              if (body === null || body.pauseControls === undefined) {
                throw new Error("The pause switches could not be read.");
              }
              return { state: "mounted", controls: body.pauseControls };
            }),
  });
}
/**
 * The statuses a whole listing's badges draw from (#384, FIX-OCR1 / #376): the list hands its
 * subjects over once and every row's badge takes its own entry from the shared answer — one
 * request for the page, not one per memory. The status face exists only where the deployment
 * wired the chain, and a subject the chain does not hold answers `unknown-subject`; both mean
 * the same thing to a row, so any answer but 200 is `null` and the rows draw no badge rather
 * than a made-up one — the badges decorate rows the list already drew honestly.
 */
export function scopedMemorySyncStatusesQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  subjects: readonly MemorySyncSubject[],
) {
  const open = scope.status === "open" ? scope : null;
  const keys = subjects.map(memorySyncStatusKey);
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...memoryKeys.syncStatuses, keys]
        : [...memoryKeys.syncStatuses, keys, ":scope-pending"],
    enabled: open !== null && subjects.length > 0,
    queryFn:
      open === null || subjects.length === 0
        ? () => new Promise<Record<string, MemorySyncStatus> | null>(() => {})
        : async ({
            signal,
          }): Promise<Record<string, MemorySyncStatus> | null> =>
            guarded(queryClient, open.userId, async () => {
              const response = await tryClient(
                "/api/memory/hindsight/status/batch",
                {
                  method: "POST",
                  body: { subjects },
                  signal,
                  ...(open.selection ?? {}),
                },
              );
              if (!response.ok) return null;
              const body = (await response.json().catch(() => null)) as {
                statuses?: Record<string, MemorySyncStatus>;
              } | null;
              return body?.statuses ?? null;
            }),
  });
}
export const memoriesQueryOptions = () =>
  queryOptions({
    queryKey: memoryKeys.all,
    queryFn: (): Promise<MemoryRecord[]> =>
      client("/api/memory", "memories", { fallbackKey: "memory.load" }),
  });
export const memorySourcesQueryOptions = () =>
  queryOptions({
    queryKey: memoryKeys.sources,
    queryFn: (): Promise<MemorySource[]> =>
      client("/api/memory/sources", "sources", {
        fallbackKey: "memory.loadSources",
      }),
    refetchInterval: 15_000,
  });
export const availableMemorySourcesQueryOptions = (id: string) =>
  queryOptions({
    queryKey: memoryKeys.available(id),
    enabled: !!id,
    queryFn: (): Promise<MemorySourceTool[]> =>
      client(
        `/api/memory/sources/available/${encodeURIComponent(id)}`,
        "tools",
        { fallbackKey: "memory.loadActions" },
      ),
  });
export const createMemory = (content: string, scope?: ScopePair) =>
  client("/api/memory", {
    method: "POST",
    body: { content },
    fallbackKey: "memory.remember",
    ...(scope ?? {}),
  });
export const updateMemory = (
  id: string,
  input: { content?: string; enabled?: boolean; reviewState?: "confirmed" },
  scope?: ScopePair,
) =>
  client(`/api/memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallbackKey: "memory.update",
    ...(scope ?? {}),
  });
export const deleteMemory = (id: string, scope?: ScopePair) =>
  client(`/api/memory/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallbackKey: "memory.forget",
    ...(scope ?? {}),
  });
export const addMemorySource = (
  input: {
    agentId: string;
    toolRef: string;
    title: string;
    args: Record<string, unknown>;
  },
  scope?: ScopePair,
) =>
  client("/api/memory/sources", {
    method: "POST",
    body: input,
    fallbackKey: "memory.addSource",
    ...(scope ?? {}),
  });
export const memorySourceAction = (
  id: string,
  action: "sync" | "remove" | "enable" | "disable",
  scope?: ScopePair,
) =>
  client(
    `/api/memory/sources/${encodeURIComponent(id)}${action === "sync" ? "/sync" : ""}`,
    {
      method:
        action === "sync" ? "POST" : action === "remove" ? "DELETE" : "PATCH",
      ...(action === "enable" || action === "disable"
        ? { body: { enabled: action === "enable" } }
        : {}),
      fallbackKey: "memory.changeSource",
      ...(scope ?? {}),
    },
  );
/** Turn one of the person's pause switches on or off (#392); the server echoes the new state. */
export const setPauseControls = (
  patch: { learningPaused?: boolean; usagePaused?: boolean },
  scope?: ScopePair,
) =>
  client("/api/memory/pause-controls", {
    method: "POST",
    body: patch,
    fallbackKey: "memory.changePause",
    ...(scope ?? {}),
  });

const settleMemory = (queryClient: QueryClient, scope?: ScopedCache) => () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: memoryKeys.all }),
    ...(scope !== undefined && scope.status === "open"
      ? [
          queryClient.invalidateQueries({
            queryKey: [...scope.prefix, ...memoryKeys.all],
          }),
        ]
      : []),
  ]);
/**
 * Re-read only the switches' own entry: a pause change is not the list's business, so the rows
 * the person is reading stay as they are instead of flashing through a refetch.
 */
const settlePauseControls =
  (queryClient: QueryClient, scope?: ScopedCache) => () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: memoryKeys.pauseControls }),
      ...(scope !== undefined && scope.status === "open"
        ? [
            queryClient.invalidateQueries({
              queryKey: [...scope.prefix, ...memoryKeys.pauseControls],
            }),
          ]
        : []),
    ]);

export const createMemoryMutationOptions = (
  queryClient: QueryClient,
  scope?: ScopedCache,
) =>
  mutationOptions({
    mutationFn: (content: string) => createMemory(content, scopePair(scope)),
    onSettled: settleMemory(queryClient, scope),
  });
export const updateMemoryMutationOptions = (
  queryClient: QueryClient,
  scope?: ScopedCache,
) =>
  mutationOptions({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: { content?: string; enabled?: boolean; reviewState?: "confirmed" };
    }) => updateMemory(id, input, scopePair(scope)),
    onSettled: settleMemory(queryClient, scope),
  });
export const deleteMemoryMutationOptions = (
  queryClient: QueryClient,
  scope?: ScopedCache,
) =>
  mutationOptions({
    mutationFn: (id: string) => deleteMemory(id, scopePair(scope)),
    onSettled: settleMemory(queryClient, scope),
  });

/** Opt a Bot in to reading one of its connected apps' actions as a memory source. */
export const addMemorySourceMutationOptions = (
  queryClient: QueryClient,
  scope?: ScopedCache,
) =>
  mutationOptions({
    mutationFn: (input: Parameters<typeof addMemorySource>[0]) =>
      addMemorySource(input, scopePair(scope)),
    onSuccess: settleMemory(queryClient, scope),
  });

/** Sync, remove, enable or disable one memory source. */
export const memorySourceActionMutationOptions = (
  queryClient: QueryClient,
  scope?: ScopedCache,
) =>
  mutationOptions({
    mutationFn: ({
      sourceId,
      name,
    }: {
      sourceId: string;
      name: "sync" | "remove" | "enable" | "disable";
    }) => memorySourceAction(sourceId, name, scopePair(scope)),
    onSuccess: settleMemory(queryClient, scope),
  });

/** Flip one of the person's two pause switches; the settle re-reads the server's own echo. */
export const setPauseControlsMutationOptions = (
  queryClient: QueryClient,
  scope?: ScopedCache,
) =>
  mutationOptions({
    mutationFn: (patch: { learningPaused?: boolean; usagePaused?: boolean }) =>
      setPauseControls(patch, scopePair(scope)),
    onSettled: settlePauseControls(queryClient, scope),
  });
