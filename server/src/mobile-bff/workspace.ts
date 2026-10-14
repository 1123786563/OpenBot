import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { AgentChannel, ChannelStore } from "../channels/routes";

/**
 * The cold-start answer the mobile roster screen needs: who am I, which Bots
 * can I open, which conversations do I already have.
 *
 * A read seam rather than a route handler so the assembly owns the parallelism
 * (all three reads are independent) and a test owns the shape without a
 * server in the way.
 */
export type MobileBffWorkspaceReader = {
  read(actor: AgentActor): Promise<{
    user: { id: string; role: AgentActor["role"] };
    agents: WorkspaceAgent[];
    channels: WorkspaceChannel[];
    /**
     * Where the archived partition's walk stopped, when it stopped at the five-page cap with
     * more behind it. Null once the partition is fully read. The follow-up endpoint that
     * accepts it is future work; exposing the position now keeps the truncation observable
     * instead of silent.
     */
    archivedNextCursor: string | null;
  }>;
};

/** The roster subset the mobile UI renders. Never the full AgentProfile: fields like `hasAuth` or `ownerUserId` are administration answers a phone has no screen for. */
export type WorkspaceAgent = {
  id: string;
  name: string;
  title: string;
  avatarSeed: string;
  visibility: "public" | "private";
};

/** The conversation-list subset. The full channel DTO carries read markers and summaries the roster already re-derives. */
export type WorkspaceChannel = {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  lastMessageAt: string | null;
  /** When this conversation was filed away, or null for one on the desk. Serialised ISO-8601 like lastMessageAt. */
  archivedAt: string | null;
};

export function createMobileBffWorkspace(deps: {
  agentProfileStore?: AgentProfileStore;
  channelStore?: ChannelStore;
}): MobileBffWorkspaceReader {
  return {
    async read(actor) {
      // Independent reads, one round trip: the caller's cold start is three
      // sequential fetches today, and the joins here are all in-memory. The
      // archived partition is a fourth independent read, because a roster that
      // cannot show the filing cabinet cannot reopen what is in it — and it
      // follows nextCursor page by page, because dropping the cursor made
      // everything past the first 100 archived conversations unreachable from
      // this endpoint.
      const readArchived = async (): Promise<{
        channels: AgentChannel[];
        nextCursor: string | null;
      }> => {
        if (!deps.channelStore) return { channels: [], nextCursor: null };
        const channels: AgentChannel[] = [];
        let cursor: string | undefined;
        /*
         * ponytail: capped at ARCHIVED_COLD_START_MAX_PAGES pages of
         * ARCHIVED_COLD_START_PAGE rows (500 archived conversations) so one
         * cold-start response stays bounded. Past the cap the leftover cursor
         * is handed back as archivedNextCursor, so the truncation is
         * observable (a follow-up endpoint that accepts it is future work),
         * not silent. Retune alongside the channels listing's own
         * MAX_CHANNEL_PAGE (200) — the two page sizes are neighbours, not
         * strangers.
         */
        const ARCHIVED_COLD_START_PAGE = 100;
        const ARCHIVED_COLD_START_MAX_PAGES = 5;
        for (let page = 0; page < ARCHIVED_COLD_START_MAX_PAGES; page++) {
          const result = await deps.channelStore.list(actor, {
            limit: ARCHIVED_COLD_START_PAGE,
            archived: true,
            ...(cursor !== undefined ? { cursor } : {}),
          });
          channels.push(...result.channels);
          if (!result.nextCursor) return { channels, nextCursor: null };
          cursor = result.nextCursor;
        }
        return { channels, nextCursor: cursor ?? null };
      };
      const [agents, page, archived] = await Promise.all([
        deps.agentProfileStore
          ? deps.agentProfileStore.list(actor)
          : Promise.resolve([]),
        deps.channelStore
          ? deps.channelStore.list(actor, { limit: 100 })
          : Promise.resolve({ channels: [], nextCursor: null }),
        readArchived(),
      ]);
      return {
        user: { id: actor.id, role: actor.role },
        archivedNextCursor: archived.nextCursor,
        agents: agents
          .filter((agent) => !agent.hidden && agent.deletedAt === null)
          .map((agent) => ({
            id: agent.id,
            name: agent.name,
            title: agent.title,
            avatarSeed: agent.avatarSeed,
            visibility: agent.visibility,
          })),
        // The active listing first, the archived partition after it: one array,
        // two partitions, told apart by `archivedAt`.
        channels: [...page.channels, ...archived.channels].map((channel) => ({
          id: channel.id,
          name: channel.name,
          agentIds: [...channel.agentIds],
          threadId: channel.threadId,
          lastMessageAt:
            channel.lastMessageAt instanceof Date
              ? channel.lastMessageAt.toISOString()
              : (channel.lastMessageAt ?? null),
          archivedAt:
            channel.archivedAt instanceof Date
              ? channel.archivedAt.toISOString()
              : null,
        })),
      };
    },
  };
}
