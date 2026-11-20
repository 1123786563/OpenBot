import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  gt,
  isNull,
  ne,
  notExists,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "../db/client";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
} from "../db/schema/core";
import { agentProfiles } from "../db/schema/coworker";
import {
  personalSaasAccounts,
  personalSaasSessions,
  personalWorkspaceDefaultBots,
  personalWorkspaces,
} from "../db/schema/personal-saas";

export const sessionSeconds = 8 * 60 * 60;

function digest(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function liveSession(token: string) {
  return and(
    eq(personalSaasSessions.tokenHash, digest(token)),
    gt(personalSaasSessions.expiresAt, new Date()),
  );
}

export function personalConversationScope(
  database: Pick<Database, "select">,
  scope: SQL | undefined,
) {
  const otherAgents = alias(channelAgents, "other_agents");
  return database
    .select({
      id: channels.id,
      title: sql<string>`coalesce(${channels.title}, ${channels.summary}, ${channels.opening}, ${channels.name})`,
      preview: channels.lastMessage,
    })
    .from(personalWorkspaces)
    .innerJoin(
      personalWorkspaceDefaultBots,
      eq(personalWorkspaceDefaultBots.workspaceId, personalWorkspaces.id),
    )
    .innerJoin(
      agentProfiles,
      eq(agentProfiles.agentId, personalWorkspaceDefaultBots.agentId),
    )
    .innerJoin(
      channelAgents,
      eq(channelAgents.agentId, personalWorkspaceDefaultBots.agentId),
    )
    .innerJoin(channels, eq(channels.id, channelAgents.channelId))
    .where(
      and(
        scope,
        isNull(agentProfiles.deletedAt),
        isNull(channels.deletedAt),
        isNull(channels.packageId),
        notExists(
          database
            .select({ id: otherAgents.agentId })
            .from(otherAgents)
            .where(
              and(
                eq(otherAgents.channelId, channels.id),
                ne(otherAgents.agentId, channelAgents.agentId),
              ),
            ),
        ),
        notExists(
          database
            .select({ id: channelMemberships.userId })
            .from(channelMemberships)
            .where(eq(channelMemberships.channelId, channels.id)),
        ),
        notExists(
          database
            .select({ id: intelligenceChannelMappings.threadId })
            .from(intelligenceChannelMappings)
            .where(eq(intelligenceChannelMappings.channelId, channels.id)),
        ),
      ),
    );
}

export function personalSaasStore(database: Database | Transaction) {
  return {
    async signIn(input: {
      issuer: string;
      subject: string;
      email: string;
      encryptedAccessToken: string;
    }) {
      const token = randomBytes(32).toString("base64url");
      await database.transaction(async (tx) => {
        const [account] = await tx
          .insert(personalSaasAccounts)
          .values({
            issuer: input.issuer,
            subject: input.subject,
            email: input.email,
          })
          .onConflictDoUpdate({
            target: [personalSaasAccounts.issuer, personalSaasAccounts.subject],
            set: { email: input.email },
          })
          .returning({ id: personalSaasAccounts.id });
        if (!account) throw new Error("Personal account was not saved");
        await tx.insert(personalSaasSessions).values({
          tokenHash: digest(token),
          accountId: account.id,
          casdoorAccessToken: input.encryptedAccessToken,
          expiresAt: new Date(Date.now() + sessionSeconds * 1000),
        });
      });
      return token;
    },
    async session(token: string) {
      const [session] = await database
        .select({
          accountId: personalSaasAccounts.id,
          issuer: personalSaasAccounts.issuer,
          subject: personalSaasAccounts.subject,
          encryptedAccessToken: personalSaasSessions.casdoorAccessToken,
        })
        .from(personalSaasSessions)
        .innerJoin(
          personalSaasAccounts,
          eq(personalSaasSessions.accountId, personalSaasAccounts.id),
        )
        .where(liveSession(token));
      return session;
    },
    async isSessionLive(token: string) {
      const [session] = await database
        .select({ tokenHash: personalSaasSessions.tokenHash })
        .from(personalSaasSessions)
        .where(liveSession(token));
      return session !== undefined;
    },
    async signOut(token: string) {
      await database
        .delete(personalSaasSessions)
        .where(eq(personalSaasSessions.tokenHash, digest(token)));
    },
    async revokeAllSessions(input: { token: string; accountId: string }) {
      return database.transaction(async (tx) => {
        // Sign-in's account upsert and all-device revocation serialize on this row.
        const [account] = await tx
          .select({ id: personalSaasAccounts.id })
          .from(personalSaasAccounts)
          .where(eq(personalSaasAccounts.id, input.accountId))
          .for("update");
        if (!account) return false;
        const [current] = await tx
          .select({ tokenHash: personalSaasSessions.tokenHash })
          .from(personalSaasSessions)
          .where(
            and(
              eq(personalSaasSessions.accountId, account.id),
              liveSession(input.token),
            ),
          )
          .for("update");
        if (!current) return false;
        await tx
          .delete(personalSaasSessions)
          .where(eq(personalSaasSessions.accountId, account.id));
        return true;
      });
    },
    async workspace(accountId: string) {
      const [workspace] = await database
        .select({
          id: personalWorkspaces.id,
          personalAssistant: {
            id: agents.id,
            name: agents.name,
          },
        })
        .from(personalWorkspaces)
        .innerJoin(
          personalWorkspaceDefaultBots,
          eq(personalWorkspaceDefaultBots.workspaceId, personalWorkspaces.id),
        )
        .innerJoin(agents, eq(personalWorkspaceDefaultBots.agentId, agents.id))
        .where(eq(personalWorkspaces.ownerId, accountId));
      return workspace;
    },
    async recentConversations(accountId: string) {
      return personalConversationScope(
        database,
        eq(personalWorkspaces.ownerId, accountId),
      )
        .orderBy(
          desc(sql`coalesce(${channels.lastMessageAt}, ${channels.createdAt})`),
          desc(channels.id),
        )
        .limit(50);
    },
    async provision(accountId: string) {
      return database.transaction(async (tx) => {
        await tx
          .insert(personalWorkspaces)
          .values({ ownerId: accountId })
          .onConflictDoNothing({ target: personalWorkspaces.ownerId });
        const [workspace] = await tx
          .select({ id: personalWorkspaces.id })
          .from(personalWorkspaces)
          .where(eq(personalWorkspaces.ownerId, accountId))
          .for("update");
        if (!workspace) throw new Error("Personal Workspace was not saved");
        const [assistant] = await tx
          .select({ id: personalWorkspaceDefaultBots.agentId })
          .from(personalWorkspaceDefaultBots)
          .where(eq(personalWorkspaceDefaultBots.workspaceId, workspace.id));
        if (assistant) return;

        const agentId = `agent_${randomUUID()}`;
        await tx.insert(agents).values({
          id: agentId,
          name: "Personal Assistant",
          type: "built_in",
          configuration: {
            systemPrompt: "You are the user's Personal Assistant.",
          },
        });
        // The workspace link owns this Bot. No enterprise or local user is bound to its profile.
        await tx.insert(agentProfiles).values({
          agentId,
          title: "Personal Assistant",
          roleDescription: "Help with personal tasks and questions.",
          avatarSeed: agentId,
          visibility: "private",
        });
        await tx
          .insert(personalWorkspaceDefaultBots)
          .values({ workspaceId: workspace.id, agentId });
      });
    },
  };
}
