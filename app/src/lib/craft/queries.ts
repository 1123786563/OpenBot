import { queryOptions } from "@tanstack/react-query";
import {
  fetchSandboxStatus,
  getSession,
  issuePreviewTicket,
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
      const status = query.state.data?.status;
      if (status === "provisioning") return 2000;
      if (status === "running") return 30_000;
      return false;
    },
  });
