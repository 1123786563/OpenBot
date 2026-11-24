import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  attachments,
  brokeredConnections,
  channels,
  personalMemories,
  personalWorkspaceDefaultBots,
  personalWorkspaces,
  routines,
} from "../db/schema";
import { workspaceConversations } from "./store";
import { workspaceResourceOwner } from "./workspace-principal";

export { workspaceResourceOwner } from "./workspace-principal";

export const exportWorkspaceId = z.uuid().brand<"PersonalWorkspaceId">();
export type ExportTarget = {
  accountId: string;
  workspaceId: z.output<typeof exportWorkspaceId>;
};

const botConfiguration = z.object({ systemPrompt: z.string().optional() });

function workspaceBot(
  database: Pick<Database, "select">,
  target: ExportTarget,
) {
  return database
    .select({
      id: agents.id,
      name: agents.name,
      type: agents.type,
      configuration: agents.configuration,
      title: agentProfiles.title,
      roleDescription: agentProfiles.roleDescription,
    })
    .from(personalWorkspaces)
    .innerJoin(
      personalWorkspaceDefaultBots,
      eq(personalWorkspaceDefaultBots.workspaceId, personalWorkspaces.id),
    )
    .innerJoin(agents, eq(agents.id, personalWorkspaceDefaultBots.agentId))
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .where(
      and(
        eq(personalWorkspaces.id, target.workspaceId),
        eq(personalWorkspaces.ownerId, target.accountId),
        isNull(agentProfiles.deletedAt),
      ),
    );
}

export async function canExportWorkspace(
  database: Database,
  target: ExportTarget,
) {
  const [bot] = await workspaceBot(database, target);
  return bot !== undefined;
}

export function readWorkspaceExport(database: Database, target: ExportTarget) {
  return database.transaction(
    async (tx) => {
      const [bot] = await workspaceBot(tx, target);
      if (!bot) return;

      const owner = workspaceResourceOwner(target.workspaceId);
      const conversations = await workspaceConversations(tx, target).orderBy(
        channels.id,
      );
      const visibleChannels = workspaceConversations(tx, target).as(
        "visible_channels",
      );
      const files = await tx
        .select({
          id: attachments.id,
          conversationId: attachments.channelId,
          name: attachments.name,
          mimeType: attachments.mimeType,
          sizeBytes: attachments.sizeBytes,
          bytes: attachments.bytes,
        })
        .from(attachments)
        .where(
          and(
            inArray(
              attachments.channelId,
              tx.select({ id: visibleChannels.id }).from(visibleChannels),
            ),
            isNotNull(attachments.attachedAt),
          ),
        )
        .orderBy(attachments.id);
      const personalMemory = await tx
        .select({
          id: personalMemories.id,
          content: personalMemories.content,
          provenance: personalMemories.provenance,
          enabled: personalMemories.enabled,
          reviewState: personalMemories.reviewState,
          createdAt: personalMemories.createdAt,
        })
        .from(personalMemories)
        .where(
          and(
            eq(personalMemories.ownerUserId, owner),
            isNull(personalMemories.deletedAt),
          ),
        )
        .orderBy(personalMemories.id);
      const schedules = await tx
        .select({
          id: routines.id,
          botId: routines.agentId,
          conversationId: routines.channelId,
          title: routines.title,
          instruction: routines.instruction,
          cron: routines.cron,
          timezone: routines.timezone,
          enabled: routines.enabled,
        })
        .from(routines)
        .where(
          and(eq(routines.ownerUserId, owner), eq(routines.agentId, bot.id)),
        )
        .orderBy(routines.id);
      const connections = await tx
        .select({
          service: brokeredConnections.provider,
          name: brokeredConnections.app,
          verified: brokeredConnections.verified,
          connectedAt: brokeredConnections.connectedAt,
        })
        .from(brokeredConnections)
        .where(
          and(
            eq(brokeredConnections.holder, "person"),
            eq(brokeredConnections.userId, owner),
          ),
        )
        .orderBy(brokeredConnections.provider, brokeredConnections.app);

      const configuration = botConfiguration.safeParse(bot.configuration);
      const visibleConversations = new Set(conversations.map(({ id }) => id));
      return {
        version: 1,
        workspaceId: target.workspaceId,
        bots: [
          {
            ...bot,
            configuration: configuration.success ? configuration.data : {},
          },
        ],
        conversations,
        attachments: files.map(({ bytes, ...file }) => ({
          ...file,
          contentBase64: Buffer.from(bytes).toString("base64"),
        })),
        personalMemory,
        routines: schedules.map(({ conversationId, ...schedule }) => ({
          ...schedule,
          conversationId: visibleConversations.has(conversationId)
            ? conversationId
            : null,
        })),
        connections,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
