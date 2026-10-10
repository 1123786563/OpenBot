import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

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
        fallback: "The marketplace could not be loaded.",
      });
      return response.json();
    },
  });
}
