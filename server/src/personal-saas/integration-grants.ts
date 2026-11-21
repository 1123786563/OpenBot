import { createHash, randomBytes } from "node:crypto";
import { and, eq, exists, gt } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import {
  personalWorkspaceIntegrationGrants as grants,
  personalWorkspaceDefaultBots,
  personalWorkspaces,
} from "../db/schema/personal-saas";
import { readExecutionAccess } from "./account-access";
import {
  assistantBinding,
  assistantInWorkspace,
  assistantTarget,
} from "./workspace-bots";

const readAction = "assistant.read";
const ownerTarget = assistantTarget.extend({
  accountId: z.uuid(),
});
const issuance = ownerTarget.extend({ expiresAt: z.date() });
const revocation = ownerTarget.extend({
  grantId: z.string().regex(/^[a-f0-9]{64}$/),
});
const request = assistantTarget
  .extend({
    credential: z.string().regex(/^[\w-]{43}$/),
    action: z.literal(readAction),
  })
  .strict();

export function assistantReadGrantId(credential: string) {
  return createHash("sha256").update(credential).digest("hex");
}

export function workspaceIntegrationGrants(
  database: Pick<Database, "transaction" | "delete" | "select">,
  now = Date.now,
) {
  return {
    async issueAssistantRead(input: z.input<typeof issuance>) {
      const parsed = issuance.safeParse(input);
      if (!parsed.success) return;
      const target = parsed.data;
      return database.transaction(async (tx) => {
        const access = await readExecutionAccess(tx, target.accountId, now);
        if (access?.kind !== "active") return;
        const [bot] = await assistantBinding(tx)
          .where(
            and(
              assistantInWorkspace(target),
              eq(personalWorkspaces.ownerId, target.accountId),
            ),
          )
          .for("share");
        const issuedAt = now();
        if (
          !bot ||
          issuedAt >= access.expiresAt ||
          issuedAt >= target.expiresAt.getTime()
        )
          return;

        const credential = randomBytes(32).toString("base64url");
        await tx.insert(grants).values({
          credentialHash: assistantReadGrantId(credential),
          agentId: bot.id,
          workspaceId: target.workspaceId,
          expiresAt: target.expiresAt,
          action: readAction,
        });
        return { credential };
      });
    },

    async revokeAssistantRead(input: z.input<typeof revocation>) {
      const parsed = revocation.safeParse(input);
      if (!parsed.success) return false;
      const target = parsed.data;
      return database.transaction(async (tx) => {
        const access = await readExecutionAccess(tx, target.accountId, now);
        if (access?.kind !== "active") return false;
        const [revoked] = await tx
          .delete(grants)
          .where(
            and(
              eq(grants.workspaceId, target.workspaceId),
              eq(grants.agentId, target.botId),
              eq(grants.credentialHash, target.grantId),
              eq(grants.action, readAction),
              exists(
                assistantBinding(tx).where(
                  and(
                    assistantInWorkspace(target),
                    eq(personalWorkspaces.ownerId, target.accountId),
                  ),
                ),
              ),
            ),
          )
          .returning({ id: grants.credentialHash });
        return Boolean(revoked);
      });
    },

    async execute(input: unknown) {
      const parsed = request.safeParse(input);
      if (!parsed.success) return;
      const target = parsed.data;
      return database.transaction(async (tx) => {
        const credentialHash = assistantReadGrantId(target.credential);
        const credentialBinding = and(
          eq(grants.workspaceId, target.workspaceId),
          eq(grants.agentId, target.botId),
          eq(grants.credentialHash, credentialHash),
          eq(grants.action, target.action),
          gt(grants.expiresAt, new Date(now())),
        );
        const [workspace] = await tx
          .select({
            ownerId: personalWorkspaces.ownerId,
            expiresAt: grants.expiresAt,
          })
          .from(grants)
          .innerJoin(
            personalWorkspaces,
            eq(personalWorkspaces.id, grants.workspaceId),
          )
          .where(credentialBinding);
        if (!workspace) return;
        const access = await readExecutionAccess(tx, workspace.ownerId, now);
        if (access?.kind !== "active") return;
        const [match] = await assistantBinding(tx)
          .innerJoin(
            grants,
            eq(grants.agentId, personalWorkspaceDefaultBots.agentId),
          )
          .where(
            and(
              assistantInWorkspace(target),
              eq(personalWorkspaces.ownerId, workspace.ownerId),
              credentialBinding,
            ),
          );
        if (now() >= Math.min(workspace.expiresAt.getTime(), access.expiresAt))
          return;
        return match;
      });
    },
  };
}
