import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  attachments,
  channels,
  directChatRuns,
  intelligenceChannelMappings as mappings,
  conversationEvidenceWithdrawals as withdrawals,
} from "../db/schema";

export async function purgeDeletedConversations(database: Database) {
  return database.transaction(async (tx) => {
    const pending = await tx
      .select({ id: channels.id })
      .from(channels)
      .innerJoin(withdrawals, eq(withdrawals.channelId, channels.id))
      .where(
        and(isNotNull(channels.deletedAt), isNull(withdrawals.processedAt)),
      )
      .orderBy(asc(withdrawals.withdrawnAt), asc(channels.id))
      .limit(100)
      .for("update", { of: channels, skipLocked: true });
    for (const { id } of pending) {
      await tx.delete(attachments).where(eq(attachments.channelId, id));
      await tx.delete(directChatRuns).where(sql`
        ${directChatRuns.threadId} in (
          select ${mappings.threadId} from ${mappings} where ${mappings.channelId} = ${id}
        )
      `);
      await tx
        .update(channels)
        .set({
          title: null,
          opening: null,
          summary: null,
          lastMessage: null,
          lastMessageSourceId: null,
        })
        .where(eq(channels.id, id));
      await tx
        .update(withdrawals)
        .set({ processedAt: sql`now()` })
        .where(eq(withdrawals.channelId, id));
    }
    return pending.length;
  });
}
