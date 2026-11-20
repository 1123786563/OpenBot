import { and, eq, exists, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { agents } from "../db/schema/core";
import { agentProfiles } from "../db/schema/coworker";
import {
  personalWorkspaceDefaultBots,
  personalWorkspaces,
} from "../db/schema/personal-saas";

export const assistantTarget = z.object({
  workspaceId: z.uuid().brand<"PersonalWorkspaceId">(),
  botId: z.string().min(1).max(128).brand<"BotId">(),
});

export const assistantName = z.string().trim().min(1).max(120);

export const assistantSummary = { id: agents.id, name: agents.name };

export function assistantBinding(database: Pick<Database, "select">) {
  return database
    .select(assistantSummary)
    .from(agents)
    .innerJoin(
      personalWorkspaceDefaultBots,
      eq(agents.id, personalWorkspaceDefaultBots.agentId),
    )
    .innerJoin(
      personalWorkspaces,
      eq(personalWorkspaces.id, personalWorkspaceDefaultBots.workspaceId),
    )
    .innerJoin(
      agentProfiles,
      eq(agentProfiles.agentId, personalWorkspaceDefaultBots.agentId),
    );
}

export function assistantInWorkspace(target: z.output<typeof assistantTarget>) {
  return and(
    eq(personalWorkspaces.id, target.workspaceId),
    eq(personalWorkspaceDefaultBots.agentId, target.botId),
    isNull(agentProfiles.deletedAt),
  );
}

function ownedAssistant(
  database: Pick<Database, "select">,
  accountId: string,
  target: z.output<typeof assistantTarget>,
) {
  return exists(
    assistantBinding(database).where(
      and(
        assistantInWorkspace(target),
        eq(personalWorkspaces.ownerId, accountId),
      ),
    ),
  );
}

export function workspaceBots(database: Pick<Database, "select" | "update">) {
  return {
    async get({
      accountId,
      ...target
    }: { accountId: string } & z.input<typeof assistantTarget>) {
      const parsed = assistantTarget.safeParse(target);
      if (!parsed.success || !z.uuid().safeParse(accountId).success) return;
      const [bot] = await database
        .select(assistantSummary)
        .from(agents)
        .where(
          and(
            eq(agents.id, parsed.data.botId),
            ownedAssistant(database, accountId, parsed.data),
          ),
        );
      return bot;
    },
    async rename({
      accountId,
      name,
      ...target
    }: { accountId: string; name: string } & z.input<typeof assistantTarget>) {
      const parsed = assistantTarget.safeParse(target);
      const nextName = assistantName.safeParse(name);
      if (
        !parsed.success ||
        !nextName.success ||
        !z.uuid().safeParse(accountId).success
      )
        return;
      const [bot] = await database
        .update(agents)
        .set({ name: nextName.data, updatedAt: new Date() })
        .where(
          and(
            eq(agents.id, parsed.data.botId),
            ownedAssistant(database, accountId, parsed.data),
          ),
        )
        .returning(assistantSummary);
      return bot;
    },
  };
}
