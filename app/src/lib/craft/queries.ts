import {
  type QueryClient,
  type QueryFunction,
  queryOptions,
} from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
import { guarded } from "@/lib/enterprise/tenant/queries";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  type CraftScopePair,
  fetchSandboxStatus,
  getSession,
  issuePreviewTicket,
  listArtifacts,
  listFiles,
  listMessages,
  listSessions,
  webappInfo,
} from "./client";
import type {
  CraftArtifactEntry,
  CraftFileEntry,
  CraftMessage,
  CraftSandboxStatusResponse,
  CraftSession,
  CraftWebappInfo,
} from "./types";

/**
 * Query keys + options for the craft feature, one root so invalidation is one call.
 *
 * The list is invalidated after a create/rename/delete; a session's messages are invalidated when
 * a turn settles (the SSE read and the persisted rows are byte-identical, so the durable list is
 * the refresh target). Files carry their path because the tree fetches lazily per directory.
 */
export const craftKeys = {
  all: ["craft"] as const,
  list: () => ["craft", "sessions"] as const,
  session: (id: string) => ["craft", "session", id] as const,
  messages: (id: string) => ["craft", "messages", id] as const,
  artifacts: (id: string) => ["craft", "artifacts", id] as const,
  files: (id: string, path: string) => ["craft", "files", id, path] as const,
  webapp: (id: string) => ["craft", "webapp", id] as const,
  sandboxStatus: (id: string) => ["craft", "sandboxStatus", id] as const,
};

export const craftSessionsQueryOptions = () =>
  queryOptions({
    queryKey: craftKeys.list(),
    queryFn: ({ signal }) => listSessions(signal),
  });

export const craftSessionQueryOptions = (id: string) =>
  queryOptions({
    queryKey: craftKeys.session(id),
    queryFn: ({ signal }) => getSession(id, signal),
  });

export const craftMessagesQueryOptions = (id: string) =>
  queryOptions({
    queryKey: craftKeys.messages(id),
    queryFn: ({ signal }) => listMessages(id, signal),
  });

export const craftArtifactsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: craftKeys.artifacts(id),
    queryFn: ({ signal }) => listArtifacts(id, signal),
  });

export const craftFilesQueryOptions = (id: string, path = "") =>
  queryOptions({
    queryKey: craftKeys.files(id, path),
    queryFn: ({ signal }) => listFiles(id, path, signal),
  });

export const craftWebappQueryOptions = (id: string) =>
  queryOptions({
    queryKey: craftKeys.webapp(id),
    queryFn: ({ signal }) => webappInfo(id, signal),
  });

/**
 * The preview-entry hop (#362): exchange for a pass, then navigate `origin` +
 * `?ticket=` ONCE. A mutation (not a query) on purpose — a ticket is single-use,
 * so it must never be cached, retried on focus, or refetched on remount by a
 * query observer; the pane calls it exactly when it is about to point the
 * iframe at the preview origin.
 */
export const craftPreviewTicketMutationOptions = (id: string) => ({
  mutationKey: [...craftKeys.webapp(id), "preview-ticket"] as const,
  mutationFn: () => issuePreviewTicket(id),
});

/**
 * The status chip's poll. The cadence is a function of the answer (onyx's reconciler): a
 * provisioning sandbox is watched at 2s, a running one at 30s, and a settled one — sleeping,
 * terminated, failed — is not watched at all; the wake path re-fetches it explicitly.
 */
export const craftSandboxStatusQueryOptions = (id: string) =>
  queryOptions({
    queryKey: craftKeys.sandboxStatus(id),
    queryFn: ({ signal }) => fetchSandboxStatus(id, signal),
    refetchInterval: (query) => {
      const status = (
        query.state.data as CraftSandboxStatusResponse | undefined
      )?.status;
      if (status === "provisioning") return 2000;
      if (status === "running") return 30_000;
      return false;
    },
  });

// ---------------------------------------------------------------------------
// The scoped half (MT091 / Issue #134): the craft pages read and write through here
// ---------------------------------------------------------------------------

/** The selection pair a scoped craft call rides — the client module's own shape, re-exported. */
export type { CraftScopePair } from "./client";

/**
 * The scope the craft writes here submit under (MT091 / Issue #134, AC3): an open scope's
 * selection rides the request, and a pending one submits nothing.
 */
export function craftScopePair(
  scope: ScopedCache | undefined,
): CraftScopePair | undefined {
  return scope !== undefined && scope.status === "open"
    ? (scope.selection ?? {})
    : undefined;
}

/**
 * What a cross-scope session id reads as (MT091 / Issue #134, AC1): the server's 404 is the
 * canonical no-leak answer — a session of another company is indistinguishable from one that
 * never existed — and this typed error is the page's one way to render that answer as an
 * explicit refusal state instead of a blank pane.
 */
export class CraftSessionUnavailableError extends Error {
  constructor() {
    super("This craft session is not available.");
    this.name = "CraftSessionUnavailableError";
  }
}

/** The pending-scope key suffix every scoped craft read parks under while the user resolves. */
const SCOPE_PENDING = ":scope-pending";

/**
 * The sessions roster, bound to the scope the screen holds (MT091 AC1): keyed under the scope's
 * own cache prefix (MT083), carrying the selection pair, and answered through the generation
 * guard — the sessions a scope sees are that scope's own answer, and a switch drops the old
 * scope's roster wholesale rather than leaving it beside the new scope's.
 */
export function scopedCraftSessionsQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...craftKeys.list()]
        : [...craftKeys.list(), SCOPE_PENDING],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<Awaited<ReturnType<typeof listSessions>>>(() => {})
        : async ({ signal }): Promise<CraftSession[]> =>
            guarded(queryClient, open.userId, () =>
              listSessions(signal, craftScopePair(scope)),
            ),
  });
}

/**
 * One session's detail, bound the same way (MT091 AC1): a cross-scope id answers 404 and reads
 * as {@link CraftSessionUnavailableError} — the invisible semantic, not a blank pane.
 */
export function scopedCraftSessionQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  id: string,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...craftKeys.session(id)]
        : [...craftKeys.session(id), SCOPE_PENDING],
    enabled: open !== null,
    retry: false,
    queryFn:
      open === null
        ? () => new Promise<Awaited<ReturnType<typeof getSession>>>(() => {})
        : async ({ signal }): Promise<CraftSession> =>
            guarded(queryClient, open.userId, async () => {
              const response = await tryClient(
                `/api/craft/sessions/${encodeURIComponent(id)}`,
                {
                  signal,
                  fallbackKey: "craft.loadSession",
                  ...(open.selection ?? {}),
                },
              );
              if (!response.ok) {
                if (response.status === 404)
                  throw new CraftSessionUnavailableError();
                throw new Error("The craft session could not be loaded.");
              }
              return (await response.json()) as CraftSession;
            }),
  });
}

/** The persisted message history, bound to the scope (MT091 AC1). */
export function scopedCraftMessagesQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  id: string,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...craftKeys.messages(id)]
        : [...craftKeys.messages(id), SCOPE_PENDING],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<Awaited<ReturnType<typeof listMessages>>>(() => {})
        : async ({ signal }): Promise<CraftMessage[]> =>
            guarded(queryClient, open.userId, () =>
              listMessages(id, signal, craftScopePair(scope)),
            ),
  });
}

/** The artifacts shelf, bound to the scope (MT091 AC1: 产物面只反映当前范围). */
export function scopedCraftArtifactsQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  id: string,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...craftKeys.artifacts(id)]
        : [...craftKeys.artifacts(id), SCOPE_PENDING],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<Awaited<ReturnType<typeof listArtifacts>>>(() => {})
        : async ({ signal }): Promise<CraftArtifactEntry[]> =>
            guarded(queryClient, open.userId, () =>
              listArtifacts(id, signal, craftScopePair(scope)),
            ),
  });
}

/** One directory of the file tree, bound to the scope (MT091 AC1). */
export function scopedCraftFilesQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  id: string,
  path = "",
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...craftKeys.files(id, path)]
        : [...craftKeys.files(id, path), SCOPE_PENDING],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<Awaited<ReturnType<typeof listFiles>>>(() => {})
        : async ({ signal }): Promise<CraftFileEntry[]> =>
            guarded(queryClient, open.userId, () =>
              listFiles(id, path, signal, craftScopePair(scope)),
            ),
  });
}

/** The webapp inspection, bound to the scope (MT091 AC2: the preview's own facts are scoped). */
export function scopedCraftWebappQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  id: string,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...craftKeys.webapp(id)]
        : [...craftKeys.webapp(id), SCOPE_PENDING],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<Awaited<ReturnType<typeof webappInfo>>>(() => {})
        : async ({ signal }): Promise<CraftWebappInfo> =>
            guarded(queryClient, open.userId, () =>
              webappInfo(id, signal, craftScopePair(scope)),
            ),
  });
}

/**
 * The sandbox poll, bound to the scope (MT091 AC1) with the poll's own cadence kept verbatim:
 * provisioning watched at 2s, running at 30s, settled not at all.
 */
export function scopedCraftSandboxStatusQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  id: string,
) {
  const open = scope.status === "open" ? scope : null;
  /*
   * The cadence callback reads the answer, so the queryFn is typed up front (a ternary of two
   * function literals does not carry the type through `queryOptions` inference when a callback
   * parameter depends on it) — both branches produce the same declared shape.
   */
  const queryFn: QueryFunction<CraftSandboxStatusResponse> =
    open === null
      ? () => new Promise<CraftSandboxStatusResponse>(() => {})
      : ({ signal }) =>
          guarded(queryClient, open.userId, () =>
            fetchSandboxStatus(id, signal, craftScopePair(scope)),
          );
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...craftKeys.sandboxStatus(id)]
        : [...craftKeys.sandboxStatus(id), SCOPE_PENDING],
    enabled: open !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "provisioning") return 2000;
      if (status === "running") return 30_000;
      return false;
    },
    queryFn,
  });
}

/**
 * The preview-pass exchange, bound to the scope (MT091 AC2): the single-use pass is an
 * authorization issuance, so the mint submits under the scope in force — a scope that cannot
 * see the session is a scope the pass is not issued to.
 */
export function scopedCraftPreviewTicketMutationOptions(
  scope: ScopedCache,
  id: string,
) {
  return {
    mutationKey: [
      ...craftKeys.webapp(id),
      "preview-ticket",
    ] as const,
    mutationFn: () =>
      issuePreviewTicket(id, craftScopePair(scope)),
  };
}

/**
 * Invalidate the craft tree at BOTH roots (MT091): the unscoped one the legacy assembly still
 * writes and this scope's own prefix, so a write this scope just made cannot leave the other
 * root holding the previous answer.
 */
export function invalidateCraftInScope(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  void queryClient.invalidateQueries({ queryKey: craftKeys.all });
  if (scope !== undefined && scope.status === "open") {
    void queryClient.invalidateQueries({
      queryKey: [...scope.prefix, ...craftKeys.all],
    });
  }
}
