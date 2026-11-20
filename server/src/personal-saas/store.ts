import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  personalSaasAccounts,
  personalSaasAssistants,
  personalSaasSessions,
  personalWorkspaces,
} from "../db/schema/personal-saas";

export const sessionSeconds = 8 * 60 * 60;

function digest(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function personalSaasStore(database: Database) {
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
        .where(
          and(
            eq(personalSaasSessions.tokenHash, digest(token)),
            gt(personalSaasSessions.expiresAt, new Date()),
          ),
        );
      return session;
    },
    async signOut(token: string) {
      await database
        .delete(personalSaasSessions)
        .where(eq(personalSaasSessions.tokenHash, digest(token)));
    },
    async workspace(accountId: string) {
      const [workspace] = await database
        .select({
          id: personalWorkspaces.id,
          personalAssistant: {
            id: personalSaasAssistants.id,
            name: personalSaasAssistants.name,
          },
        })
        .from(personalWorkspaces)
        .innerJoin(
          personalSaasAssistants,
          eq(personalSaasAssistants.workspaceId, personalWorkspaces.id),
        )
        .where(eq(personalWorkspaces.ownerId, accountId));
      return workspace;
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
          .where(eq(personalWorkspaces.ownerId, accountId));
        if (!workspace) throw new Error("Personal Workspace was not saved");
        await tx
          .insert(personalSaasAssistants)
          .values({ workspaceId: workspace.id })
          .onConflictDoNothing({ target: personalSaasAssistants.workspaceId });
      });
    },
  };
}
