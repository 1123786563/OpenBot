import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, ne, notExists, sql } from "drizzle-orm";
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
import { type AccountGrant, accountDecision } from "./account-access";

import { latestSuspension } from "./workspace-suspension";

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

export function workspaceConversations(
  database: Database | Transaction,
  target: { accountId: string; workspaceId?: string },
) {
  const otherAgents = alias(channelAgents, "other_agents");
  // A trial conversation belongs to the workspace through its dedicated Assistant.
  // Exclude shared channels and channels with enterprise memberships or threads.
  return database
    .select({
      id: channels.id,
      title: sql<string>`coalesce(${channels.title}, ${channels.summary}, ${channels.opening}, ${channels.name})`,
      preview: channels.lastMessage,
      opening: channels.opening,
      summary: channels.summary,
      createdAt: channels.createdAt,
      lastMessageAt: channels.lastMessageAt,
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
        eq(personalWorkspaces.ownerId, target.accountId),
        target.workspaceId
          ? eq(personalWorkspaces.id, target.workspaceId)
          : undefined,
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

export function personalSaasStore(
  database: Database | Transaction,
  now = Date.now,
) {
  async function withAuthorizedSession<T>(
    grant: AccountGrant,
    token: string,
    operation: (tx: Transaction) => Promise<T>,
  ) {
    const { accountId } = grant;
    return database.transaction(async (tx) => {
      const [account] = await tx
        .select({ status: personalSaasAccounts.status })
        .from(personalSaasAccounts)
        .where(eq(personalSaasAccounts.id, accountId))
        .for("update");
      const access = accountDecision(account?.status ?? null, now());
      if (
        access.kind === "denied" ||
        access.epoch !== grant.epoch ||
        now() >= grant.expiresAt
      )
        return { authorized: false } as const;
      const [session] = await tx
        .select({ tokenHash: personalSaasSessions.tokenHash })
        .from(personalSaasSessions)
        .where(
          and(
            liveSession(token),
            eq(personalSaasSessions.accountId, accountId),
          ),
        )
        .for("update");
      if (!session) return { authorized: false } as const;

      return { authorized: true, result: await operation(tx) } as const;
    });
  }

  return {
    withAuthorizedSession,
    async bindIdentity(input: {
      issuer: string;
      subject: string;
      email: string;
    }) {
      const [account] = await database
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
      return account.id;
    },
    async signIn(input: {
      accountId: string;
      loginStartedAt: number;
      encryptedAccessToken: string;
    }) {
      const token = randomBytes(32).toString("base64url");
      return database.transaction(async (tx) => {
        const [account] = await tx
          .select({ status: personalSaasAccounts.status })
          .from(personalSaasAccounts)
          .where(eq(personalSaasAccounts.id, input.accountId))
          .for("update");
        const access = accountDecision(account?.status ?? null, now());
        const suspension = await latestSuspension(tx, input.accountId);
        const disabledAt = account?.status?.disablements.at(-1)?.effectiveAt;
        if (
          access.kind === "denied" ||
          (suspension &&
            (suspension.action === "pause" ||
              input.loginStartedAt <= suspension.effectiveAt.getTime() ||
              (account?.status?.observedAt ?? 0) <=
                suspension.effectiveAt.getTime())) ||
          (disabledAt !== undefined && input.loginStartedAt <= disabledAt)
        )
          return undefined;

        await tx.insert(personalSaasSessions).values({
          tokenHash: digest(token),
          accountId: input.accountId,
          casdoorAccessToken: input.encryptedAccessToken,
          expiresAt: new Date(Date.now() + sessionSeconds * 1000),
        });
        return token;
      });
    },
    async session(token: string) {
      const [session] = await database
        .select({
          accountId: personalSaasAccounts.id,
          issuer: personalSaasAccounts.issuer,
          subject: personalSaasAccounts.subject,
          status: personalSaasAccounts.status,
          expiresAt: personalSaasSessions.expiresAt,
        })
        .from(personalSaasSessions)
        .innerJoin(
          personalSaasAccounts,
          eq(personalSaasSessions.accountId, personalSaasAccounts.id),
        )
        .where(liveSession(token));
      return session;
    },
    async signOut(token: string) {
      await database
        .delete(personalSaasSessions)
        .where(eq(personalSaasSessions.tokenHash, digest(token)));
    },
    async revokeAllSessions(input: { token: string; accountId: string }) {
      return database.transaction(async (tx) => {
        // Sign-in and all-device revocation serialize on this row.
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
      const rows = await workspaceConversations(database, { accountId })
        .orderBy(
          desc(sql`coalesce(${channels.lastMessageAt}, ${channels.createdAt})`),
          desc(channels.id),
        )
        .limit(50);
      return rows.map(({ id, title, preview }) => ({ id, title, preview }));
    },
    async provision(grant: AccountGrant, token: string) {
      const { accountId } = grant;
      const outcome = await withAuthorizedSession(grant, token, async (tx) => {
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
      return outcome.authorized;
    },
  };
}
