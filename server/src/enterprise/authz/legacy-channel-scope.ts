import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
} from "../../db/schema/core";

/** Legacy channel scope exists only while the authenticated person remains a member. */
export async function canReadLegacyChannel(
  database: Database,
  input: { actorId: string; channelId: string; botId?: string },
): Promise<boolean> {
  const rows = await database
    .select({ channelId: channelMemberships.channelId })
    .from(channelMemberships)
    .innerJoin(channels, eq(channels.id, channelMemberships.channelId))
    .where(
      and(
        eq(channelMemberships.channelId, input.channelId),
        eq(channelMemberships.userId, input.actorId),
        isNull(channels.deletedAt),
      ),
    )
    .limit(1);
  if (!rows[0]) return false;
  if (!input.botId) return true;
  const visibleBot = await database
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(
      and(
        eq(channelAgents.channelId, input.channelId),
        eq(channelAgents.agentId, input.botId),
      ),
    )
    .limit(1);
  return visibleBot.length > 0;
}
