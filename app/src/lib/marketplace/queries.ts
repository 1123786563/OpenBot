import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { guarded } from "@/lib/enterprise/tenant/queries";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

/**
 * The marketplace catalogue as the server publishes it, with the asking person's install state.
 *
 * The catalogue entries themselves are server constants — the client renders them and never
 * invents them, so what a card shows is what the build reviewed.
 */

/** One expert card. `agentId` names the Bot an install created, for the 去对话 link. */
export type MarketExpert = {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  category: string;
  tags: string[];
  avatar: string;
  skills: string[];
  installed: boolean;
  agentId: string | null;
};

/** One skill card. `mine` separates 可卸载 from merely 已安装 (a workspace row someone else maintains). */
export type MarketSkill = {
  slug: string;
  title: string;
  summary: string;
  icon: string;
  category: string;
  installed: boolean;
  mine: boolean;
};

export type MarketplacePayload = {
  experts: MarketExpert[];
  skills: MarketSkill[];
  categories: {
    experts: string[];
    skills: string[];
    connectors: string[];
  };
};

export const marketplaceKeys = {
  all: ["marketplace"] as const,
  catalogue: () => ["marketplace", "catalogue"] as const,
};

export function marketplaceQueryOptions() {
  return queryOptions({
    queryKey: marketplaceKeys.catalogue(),
    queryFn: async (): Promise<MarketplacePayload> => {
      const response = await client("/api/marketplace", {
        fallbackKey: "marketplace.load",
      });
      return response.json();
    },
  });
}

// ---------------------------------------------------------------------------
// The scoped half (MT094 / Issue #137): the catalog pages read and install through here
// ---------------------------------------------------------------------------

/**
 * The catalogue with the asking scope's install state (MT094 / Issue #137, AC1): the shelf is
 * browsable — the entries themselves are server constants — but what "installed" means is the
 * pair's own answer, keyed under the scope's cache prefix and guarded by the generation, so a
 * switch drops the old scope's shelf wholesale. An install lands in the scope that made it, and
 * the cards' install marks never describe another scope's workspace.
 */
export function scopedMarketplaceQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...marketplaceKeys.catalogue()]
        : [...marketplaceKeys.catalogue(), ":scope-pending"],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<MarketplacePayload>(() => {})
        : async ({ signal }): Promise<MarketplacePayload> =>
            guarded(queryClient, open.userId, async () => {
              const response = await tryClient("/api/marketplace", {
                signal,
                fallbackKey: "marketplace.load",
                ...(open.selection ?? {}),
              });
              if (!response.ok) {
                throw new Error("The marketplace could not be loaded.");
              }
              return (await response.json()) as MarketplacePayload;
            }),
  });
}
