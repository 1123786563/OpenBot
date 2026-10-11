import { queryOptions } from "@tanstack/react-query";
import {
  getSession,
  listArtifacts,
  listFiles,
  listMessages,
  listSessions,
  webappInfo,
} from "./client";

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
