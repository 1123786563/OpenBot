import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
import { guarded } from "@/lib/enterprise/tenant/queries";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  listWorkshopFiles,
  type WorkshopFileNode,
  type WorkshopSnapshot,
  workshopSnapshot,
} from "./client";

/**
 * Query keys for the workshop, one root so invalidation is one call.
 *
 * `snapshot(channelId)` is invalidated after a turn settles or a share changes; `files` carries
 * the path because the tree view fetches lazily per directory.
 */
export const workshopKeys = {
  all: ["workshop"] as const,
  snapshot: (channelId: string) => ["workshop", "snapshot", channelId] as const,
  files: (channelId: string, path: string) =>
    ["workshop", "files", channelId, path] as const,
};

/** The aggregate the whole tab renders; one request, cached under the channel. */
export function workshopSnapshotQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: workshopKeys.snapshot(channelId),
    queryFn: ({ signal }): Promise<WorkshopSnapshot> =>
      workshopSnapshot(channelId, signal),
  });
}

/**
 * One directory of the file tree. `path` is the node the caller expanded, or the root's empty
 * string; the query key carries it so two expanded directories are two cache entries.
 */
export function workshopFilesQueryOptions(channelId: string, path = "") {
  return queryOptions({
    queryKey: workshopKeys.files(channelId, path),
    queryFn: ({ signal }): Promise<WorkshopFileNode[]> =>
      listWorkshopFiles(channelId, path, signal),
  });
}

// ---------------------------------------------------------------------------
// The scoped half (MT091 / Issue #134): the workshop tab reads and writes through here
// ---------------------------------------------------------------------------

/**
 * What a cross-scope channel id reads as (MT091 / Issue #134, AC1): the server's 404 is the
 * canonical no-leak answer — a workshop of another company is indistinguishable from one that
 * never existed — and this typed error is the panel's one way to render that answer as an
 * explicit refusal state instead of a dead tab.
 */
export class WorkshopUnavailableError extends Error {
  constructor() {
    super("This workshop is not available.");
    this.name = "WorkshopUnavailableError";
  }
}

/** The selection pair a scoped workshop call rides, spread into the client options (MT091). */
export type WorkshopScopePair = { tenantId?: string; workspaceId?: string };

/**
 * The scope the workshop writes here submit under (MT091 / Issue #134, AC3): an open scope's
 * selection rides the request, and a pending one submits nothing.
 */
export function workshopScopePair(
  scope: ScopedCache | undefined,
): WorkshopScopePair | undefined {
  return scope !== undefined && scope.status === "open"
    ? (scope.selection ?? {})
    : undefined;
}

/**
 * The aggregate, bound to the scope the tab holds (MT091 AC1): keyed under the scope's own
 * cache prefix (MT083), carrying the selection pair, answered through the generation guard —
 * the workshop a scope sees is that scope's own answer, and a switch drops the old scope's
 * snapshot wholesale rather than leaving it beside the new scope's. A cross-scope channel id
 * answers 404 and reads as {@link WorkshopUnavailableError}.
 */
export function scopedWorkshopSnapshotQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  channelId: string,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...workshopKeys.snapshot(channelId)]
        : [...workshopKeys.snapshot(channelId), ":scope-pending"],
    enabled: open !== null,
    retry: false,
    queryFn:
      open === null
        ? () => new Promise<WorkshopSnapshot>(() => {})
        : async ({ signal }): Promise<WorkshopSnapshot> =>
            guarded(queryClient, open.userId, async () => {
              const response = await tryClient(
                `/api/workshop/${encodeURIComponent(channelId)}`,
                {
                  signal,
                  fallbackKey: "workshop.load",
                  ...(open.selection ?? {}),
                },
              );
              if (!response.ok) {
                if (response.status === 404)
                  throw new WorkshopUnavailableError();
                throw new Error("The workshop could not be loaded.");
              }
              return (await response.json()) as WorkshopSnapshot;
            }),
  });
}

/** One directory of the file tree, bound to the scope (MT091 AC1). */
export function scopedWorkshopFilesQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  channelId: string,
  path = "",
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...workshopKeys.files(channelId, path)]
        : [...workshopKeys.files(channelId, path), ":scope-pending"],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<WorkshopFileNode[]>(() => {})
        : async ({ signal }): Promise<WorkshopFileNode[]> =>
            guarded(queryClient, open.userId, () =>
              listWorkshopFiles(
                channelId,
                path,
                signal,
                workshopScopePair(scope),
              ),
            ),
  });
}

/**
 * Invalidate the workshop tree at BOTH roots (MT091): the unscoped one the legacy assembly
 * still writes and this scope's own prefix — the immediate reflection a revocation (AC2) or
 * an uninstall-shaped write (the share close, a schedule change) owes the tab that just made
 * it.
 */
export function invalidateWorkshopInScope(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  void queryClient.invalidateQueries({ queryKey: workshopKeys.all });
  if (scope !== undefined && scope.status === "open") {
    void queryClient.invalidateQueries({
      queryKey: [...scope.prefix, ...workshopKeys.all],
    });
  }
}
