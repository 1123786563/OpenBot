import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { invalidatePluginsInScope } from "@/lib/plugins/mutations";
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

/**
 * The catalog surface's settle at BOTH roots (MT094 / Issue #137): the unscoped marketplace
 * tree and — when a scope is in force — this scope's own prefix, beside the plugins surface's
 * identical pair (the install lands in both surfaces, so both refresh in both homes).
 */
export function invalidateMarketplaceInScope(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return Promise.all([
    invalidateMarketplace(queryClient),
    ...(scope !== undefined && scope.status === "open"
      ? [
          queryClient.invalidateQueries({
            queryKey: [...scope.prefix, ...marketplaceKeys.all],
          }),
        ]
      : []),
    invalidatePluginsInScope(queryClient, scope),
  ]);
}

/** The selection pair a scoped catalog write rides (MT094 / Issue #137, AC1). */
function pairOf(scope?: ScopedCache) {
  return scope !== undefined && scope.status === "open"
    ? (scope.selection ?? {})
    : undefined;
}

/*
 * Every install and uninstall submits under the scope in force (MT094 / Issue #137, AC1 —
 * 安装动作提交当前范围): the pair rides the write, and the settle refreshes both surfaces at
 * both roots, so the card's install mark and the plugins page drop or gain the row at once in
 * the scope that wrote it (AC4 — 卸载或停用后界面立即反映).
 */
export function installExpertMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (slug: string): Promise<{ agentId: string }> => {
      const response = await client(
        `/api/marketplace/experts/${encodeURIComponent(slug)}/install`,
        {
          method: "POST",
          body: {},
          fallbackKey: "marketplace.install",
          ...(pairOf(scope) ?? {}),
        },
      );
      return response.json();
    },
    onSettled: async () => {
      await invalidateMarketplaceInScope(queryClient, scope);
    },
  });
}

export function uninstallExpertMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (slug: string) => {
      await client(
        `/api/marketplace/experts/${encodeURIComponent(slug)}/install`,
        {
          method: "DELETE",
          fallbackKey: "marketplace.uninstall",
          ...(pairOf(scope) ?? {}),
        },
      );
    },
    onSettled: async () => {
      await invalidateMarketplaceInScope(queryClient, scope);
    },
  });
}

export function installMarketSkillMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (slug: string) => {
      await client(
        `/api/marketplace/skills/${encodeURIComponent(slug)}/install`,
        {
          method: "POST",
          body: {},
          fallbackKey: "marketplace.install",
          ...(pairOf(scope) ?? {}),
        },
      );
    },
    onSettled: async () => {
      await invalidateMarketplaceInScope(queryClient, scope);
    },
  });
}

export function uninstallMarketSkillMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (slug: string) => {
      await client(
        `/api/marketplace/skills/${encodeURIComponent(slug)}/install`,
        {
          method: "DELETE",
          fallbackKey: "marketplace.uninstall",
          ...(pairOf(scope) ?? {}),
        },
      );
    },
    onSettled: async () => {
      await invalidateMarketplaceInScope(queryClient, scope);
    },
  });
}
