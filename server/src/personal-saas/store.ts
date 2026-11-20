import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Database } from "../db/client";
import { agents } from "../db/schema/core";
import { agentProfiles } from "../db/schema/coworker";
import {
  personalSaasAccounts,
  personalSaasSessions,
  personalWorkspaceDefaultBots,
  personalWorkspaces,
} from "../db/schema/personal-saas";
import { type AccountGrant, accountDecision } from "./account-access";

export const sessionSeconds = 8 * 60 * 60;

function digest(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function liveSession(token: string) {
  return and(
    eq(personalSaasSessions.tokenHash, digest(token)),
    gt(personalSaasSessions.expiresAt, new Date()),
  );
}

export function personalSaasStore(database: Database, now = Date.now) {
  return {
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
        const disabledAt = account?.status?.disablements.at(-1)?.effectiveAt;
        if (
          access.kind === "denied" ||
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
    async provision(grant: AccountGrant, token: string) {
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
          return false;
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
        if (!session) return false;

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
        if (assistant) return true;

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
        return true;
      });
    },
  };
}
