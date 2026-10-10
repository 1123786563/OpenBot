import type { AgentActor } from "../agents/profile-types";
import type { AgentProfileStore } from "../agents/profile-store";
import type { ChannelStore } from "../channels/routes";

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
};

export function createMobileBffWorkspace(deps: {
  agentProfileStore?: AgentProfileStore;
  channelStore?: ChannelStore;
}): MobileBffWorkspaceReader {
  return {
    async read(actor) {
      // Independent reads, one round trip: the caller's cold start is three
      // sequential fetches today, and the joins here are all in-memory.
      const [agents, page] = await Promise.all([
        deps.agentProfileStore
          ? deps.agentProfileStore.list(actor)
          : Promise.resolve([]),
        deps.channelStore
          ? deps.channelStore.list(actor, { limit: 100 })
          : Promise.resolve({ channels: [], nextCursor: null }),
      ]);
      return {
        user: { id: actor.id, role: actor.role },
        agents: agents
          .filter((agent) => !agent.hidden && agent.deletedAt === null)
          .map((agent) => ({
            id: agent.id,
            name: agent.name,
            title: agent.title,
            avatarSeed: agent.avatarSeed,
            visibility: agent.visibility,
          })),
        channels: page.channels.map((channel) => ({
          id: channel.id,
          name: channel.name,
          agentIds: [...channel.agentIds],
          threadId: channel.threadId,
          lastMessageAt:
            channel.lastMessageAt instanceof Date
              ? channel.lastMessageAt.toISOString()
              : (channel.lastMessageAt ?? null),
        })),
      };
    },
  };
}
