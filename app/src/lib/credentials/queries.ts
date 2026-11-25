import { queryOptions } from "@tanstack/react-query";
import { ClientError, canKeepCachedRead, client } from "@/lib/client";

/** The kinds the vault holds, matching the server's `credential_kind`. */
export type CredentialKind =
  | "model"
  | "connector"
  | "agent"
  | "mcp"
  | "mcp_oauth_client"
  | "mcp_user_token";

export type CredentialStatus = {
  id: string;
  kind: CredentialKind;
  provider: string;
  keyId: string;
  metadata: Record<string, unknown>;
  revokedAt: string | null;
};

export const credentialKeys = {
  all: ["credentials"] as const,
  list: () => [...credentialKeys.all, "list"] as const,
  usage: (credentialId: string) =>
    [...credentialKeys.all, "usage", credentialId] as const,
};

export function credentialListQueryOptions() {
  return queryOptions({
    queryKey: credentialKeys.list(),
    retry: (failures, error) => failures < 1 && canKeepCachedRead(error),
    queryFn: async ({
      client: cache,
      queryKey,
    }): Promise<CredentialStatus[]> => {
      try {
        return await client("/api/admin/credentials", "credentials", {
          fallback: "Could not load credentials",
        });
      } catch (error) {
        if (error instanceof ClientError && !canKeepCachedRead(error))
          cache.setQueryData(queryKey, []);
        throw error;
      }
    },
  });
}

/** The kinds the vault holds, as a screen names them. Anything new reads by the kind it stores. */
const KIND_LABELS: Record<CredentialKind, string> = {
  model: "Model",
  connector: "Connector",
  agent: "Bot key",
  mcp: "MCP server token",
  mcp_oauth_client: "OAuth client",
  mcp_user_token: "Personal app token",
};

export function credentialKindLabel(kind: string): string {
  // A kind this build does not know (a newer server) reads as the stored value rather than blank.
  return KIND_LABELS[kind as CredentialKind] ?? kind;
}

/**
 * What points at a credential, read before it is revoked: the apps, people and Bots that hold it.
 *
 * The server answers from the rows that keep the credential's id, so an unreferenced credential
 * comes back empty rather than as a guess about what a credential of its kind is usually for.
 */
export type CredentialUsage = {
  /** The apps, connections, links and goals that hold it, already in words. */
  features: string[];
  /** The Bots that hold it, by their own key or through an app's grant. */
  bots: { id: string; name: string }[];
};

/**
 * What a failed usage read says when the server sent no sentence of its own. Exported because the
 * page shows the same sentence for a failure that sent nothing at all, so one read has one sentence.
 * `entry` is the page's own word: a key in the Personal edition, a credential in Team.
 */
export const credentialUseFallback = (entry: string) =>
  `Couldn’t check what uses this ${entry}.`;

/** `staleTime: 0`: what holds a key changes, and the answer is for this moment. */
export function credentialUsageQueryOptions(
  credentialId: string,
  entry: string,
) {
  return queryOptions({
    queryKey: credentialKeys.usage(credentialId),
    staleTime: 0,
    // A credential that is gone stays gone: retrying a 404 only delays saying so.
    retry: (failures, error) =>
      failures < 1 &&
      canKeepCachedRead(error) &&
      !(error instanceof ClientError && error.status === 404),
    queryFn: ({ signal }): Promise<CredentialUsage> =>
      client<CredentialUsage>(
        `/api/admin/credentials/${encodeURIComponent(credentialId)}/usage`,
        "usage",
        { fallback: credentialUseFallback(entry), signal },
      ),
  });
}
