import { queryOptions } from "@tanstack/react-query";
import { ClientError, canKeepCachedRead, client } from "@/lib/client";

export type CredentialStatus = {
  id: string;
  kind: "model" | "connector";
  provider: string;
  keyId: string;
  metadata: Record<string, unknown>;
  revokedAt: string | null;
};

export const credentialKeys = {
  all: ["credentials"] as const,
  list: () => [...credentialKeys.all, "list"] as const,
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
