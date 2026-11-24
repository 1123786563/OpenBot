import type { WhatIfVocabulary } from "@openbot/shared/what-if";
import { queryOptions } from "@tanstack/react-query";
import { ClientError, client } from "@/lib/client";

export const whatIfKeys = {
  all: ["what-if"] as const,
  vocabulary: ["what-if", "vocabulary"] as const,
};

export function isWhatIfAccessDenied(error: unknown): boolean {
  return (
    error instanceof ClientError &&
    (error.status === 401 || error.status === 403)
  );
}

/**
 * What an action may name on this OpenBot: its Bots and their owners, its people and groups, and its
 * apps with their tools. The only values an action's chips hold, and the only ones the model may pick.
 */
export function whatIfVocabularyQueryOptions() {
  return queryOptions({
    queryKey: whatIfKeys.vocabulary,
    retry: (failures, error) => failures < 1 && !isWhatIfAccessDenied(error),
    queryFn: async ({
      client: cache,
      queryKey,
      signal,
    }): Promise<WhatIfVocabulary | null> => {
      try {
        const response = await client("/api/admin/what-if/vocabulary", {
          fallback: "Couldn't load this OpenBot's Bots and apps",
          signal,
        });
        return response.json();
      } catch (error) {
        if (isWhatIfAccessDenied(error)) cache.setQueryData(queryKey, null);
        throw error;
      }
    },
  });
}
