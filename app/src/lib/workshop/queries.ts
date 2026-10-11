import { queryOptions } from "@tanstack/react-query";
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
