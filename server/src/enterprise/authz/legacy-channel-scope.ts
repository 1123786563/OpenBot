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
  if (
    !isIdentifier(input?.actorId) ||
    !isIdentifier(input?.channelId) ||
    (input.botId !== undefined && !isIdentifier(input.botId))
  ) {
    return false;
  }

  try {
    const membership = database
      .select({ channelId: channelMemberships.channelId })
      .from(channelMemberships)
      .innerJoin(channels, eq(channels.id, channelMemberships.channelId));
    const scopedMembership = input.botId
      ? membership.innerJoin(
          channelAgents,
          and(
            eq(channelAgents.channelId, channelMemberships.channelId),
            eq(channelAgents.agentId, input.botId),
          ),
        )
      : membership;
    const rows = await scopedMembership
      .where(
        and(
          eq(channelMemberships.channelId, input.channelId),
          eq(channelMemberships.userId, input.actorId),
          isNull(channels.deletedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}
