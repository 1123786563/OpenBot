import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { invalidatePlugins } from "@/lib/plugins/mutations";
import { marketplaceKeys } from "./queries";

/**
 * Marketplace installs.
 *
 * EVERY WRITE REFETCHES BOTH SIDES, because an install is visible in two places: the marketplace's
 * own cards, and the surface the thing lands on — the skills page for a skill, the agents roster
 * for an expert Bot. The expert writes go further still: they grant skills, which the plugins
 * screens read, so `invalidatePlugins` runs beside the marketplace refetch. `onSettled`, not
 * `onSuccess`, for the reason `plugins/mutations.ts` states once for its own writes: none of these
 * endpoints is atomic, and a refusal is not evidence that nothing changed.
 */

export function invalidateMarketplace(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: marketplaceKeys.all });
}

export function installExpertMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (slug: string): Promise<{ agentId: string }> => {
      const response = await client(
        `/api/marketplace/experts/${encodeURIComponent(slug)}/install`,
        { method: "POST", body: {}, fallbackKey: "marketplace.install" },
      );
      return response.json();
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: marketplaceKeys.all,
      });
      invalidatePlugins(queryClient);
    },
  });
}

export function uninstallExpertMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (slug: string) => {
      await client(
        `/api/marketplace/experts/${encodeURIComponent(slug)}/install`,
        { method: "DELETE", fallbackKey: "marketplace.uninstall" },
      );
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: marketplaceKeys.all,
      });
      invalidatePlugins(queryClient);
    },
  });
}

export function installMarketSkillMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (slug: string) => {
      await client(
        `/api/marketplace/skills/${encodeURIComponent(slug)}/install`,
        { method: "POST", body: {}, fallbackKey: "marketplace.install" },
      );
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: marketplaceKeys.all,
      });
      invalidatePlugins(queryClient);
    },
  });
}

export function uninstallMarketSkillMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (slug: string) => {
      await client(
        `/api/marketplace/skills/${encodeURIComponent(slug)}/install`,
        { method: "DELETE", fallbackKey: "marketplace.uninstall" },
      );
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: marketplaceKeys.all,
      });
      invalidatePlugins(queryClient);
    },
  });
}
