import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { Database } from "../db/client";
import { expertInstalls } from "../db/schema/marketplace";
import { skills } from "../db/schema/plugins";

/**
 * The receipt side of the marketplace: which expert each person installed, and the Bot it created.
 *
 * Small on purpose — the catalogue is a constant, the skills rows belong to the plugin store, and
 * this is the one table the marketplace owns. Split from the routes so `createApp` keeps receiving
 * stores rather than raw connections, the way every other feature hands its tables in.
 */
export type MarketplaceStore = {
  /** The Bot this person's install of this expert created, or null. */
  installFor(
    ownerUserId: string,
    expertSlug: string,
  ): Promise<{ agentId: string } | null>;
  /** The expert slugs this person has installed, with their Bots. */
  installsFor(
    ownerUserId: string,
  ): Promise<{ expertSlug: string; agentId: string }[]>;
  /**
   * Which of the named catalogue slugs this person can already see installed: their own rows, or
   * the deployment's. Another person's private skill holds the slug but is invisible here by the
   * same rule the skills page reads through, so it is not shown as this person's install.
   */
  visibleSkills(
    ownerUserId: string,
    slugs: string[],
  ): Promise<{ slug: string; ownerUserId: string | null }[]>;
  /** Record an install. A concurrent duplicate is left as it is and reported as not-inserted. */
  insert(input: {
    ownerUserId: string;
    expertSlug: string;
    agentId: string;
  }): Promise<boolean>;
  /** Drop this person's receipt for this expert. */
  remove(ownerUserId: string, expertSlug: string): Promise<void>;
};

export function createMarketplaceStore(database: Database): MarketplaceStore {
  return {
    async installFor(ownerUserId, expertSlug) {
      const [row] = await database
        .select({ agentId: expertInstalls.agentId })
        .from(expertInstalls)
        .where(
          and(
            eq(expertInstalls.ownerUserId, ownerUserId),
            eq(expertInstalls.expertSlug, expertSlug),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async installsFor(ownerUserId) {
      return database
        .select({
          expertSlug: expertInstalls.expertSlug,
          agentId: expertInstalls.agentId,
        })
        .from(expertInstalls)
        .where(eq(expertInstalls.ownerUserId, ownerUserId));
    },

    async visibleSkills(ownerUserId, slugs) {
      if (slugs.length === 0) return [];
      return database
        .select({
          slug: skills.slug,
          ownerUserId: skills.ownerUserId,
        })
        .from(skills)
        .where(
          and(
            inArray(skills.slug, slugs),
            or(eq(skills.ownerUserId, ownerUserId), isNull(skills.ownerUserId)),
          ),
        );
    },

    async insert(input) {
      const rows = await database
        .insert(expertInstalls)
        .values({
          id: crypto.randomUUID(),
          ownerUserId: input.ownerUserId,
          expertSlug: input.expertSlug,
          agentId: input.agentId,
        })
        // A concurrent second press made the receipt first. Its Bot is the answer; this one is a
        // twin with no receipt and is deleted by the caller, which reads the false back. The
        // target pins this method's own contract to (owner, slug) — any other unique violation
        // is a defect and must surface, not masquerade as "already installed".
        .onConflictDoNothing({
          target: [expertInstalls.ownerUserId, expertInstalls.expertSlug],
        })
        .returning({ id: expertInstalls.id });
      return rows.length > 0;
    },

    async remove(ownerUserId, expertSlug) {
      await database
        .delete(expertInstalls)
        .where(
          and(
            eq(expertInstalls.ownerUserId, ownerUserId),
            eq(expertInstalls.expertSlug, expertSlug),
          ),
        );
    },
  };
}
