import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, notExists } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import {
  personalWorkspaceIntegrationGrants as grants,
  personalSaasAccounts,
  personalWorkspaceClosures,
  personalWorkspaceDefaultBots,
  personalWorkspaces,
} from "../db/schema/personal-saas";
import {
  assistantBinding,
  assistantInWorkspace,
  assistantTarget,
} from "./workspace-bots";

import { workspaceClosure } from "./workspace-closure-record";
import { latestSuspension } from "./workspace-suspension";

const readAction = "assistant.read";
const issuance = assistantTarget.extend({
  accountId: z.uuid(),
  expiresAt: z.date(),
});
const request = assistantTarget
  .extend({
    credential: z.string().regex(/^[\w-]{43}$/),
    action: z.literal(readAction),
  })
  .strict();

function hash(credential: string) {
  return createHash("sha256").update(credential).digest("hex");
}

export function workspaceIntegrationGrants(database: Database) {
  return {
    // The issuing adapter must supply the authenticated owner's account ID.
    async issueAssistantRead(input: z.input<typeof issuance>) {
      const parsed = issuance.safeParse(input);
      if (!parsed.success || parsed.data.expiresAt.getTime() <= Date.now())
        return;
      const target = parsed.data;
      return database.transaction(async (tx) => {
        const [owner] = await tx
          .select({ id: personalSaasAccounts.id })
          .from(personalSaasAccounts)
          .where(eq(personalSaasAccounts.id, target.accountId))
          .for("share");
        if (
          !owner ||
          (await workspaceClosure(tx, owner.id)) ||
          (await latestSuspension(tx, owner.id))?.action === "pause"
        )
          return;
        const [bot] = await assistantBinding(tx)
          .where(
            and(
              assistantInWorkspace(target),
              eq(personalWorkspaces.ownerId, target.accountId),
            ),
          )
          .for("share");
        if (!bot) return;
        const credential = randomBytes(32).toString("base64url");
        await tx.insert(grants).values({
          credentialHash: hash(credential),
          agentId: bot.id,
          workspaceId: target.workspaceId,
          expiresAt: target.expiresAt,
          action: readAction,
        });
        return { credential };
      });
    },

    async execute(input: unknown) {
      const parsed = request.safeParse(input);
      if (!parsed.success) return;
      const target = parsed.data;
      const [bot] = await assistantBinding(database)
        .innerJoin(
          grants,
          eq(grants.agentId, personalWorkspaceDefaultBots.agentId),
        )
        .where(
          and(
            assistantInWorkspace(target),
            eq(grants.workspaceId, target.workspaceId),
            eq(grants.credentialHash, hash(target.credential)),
            eq(grants.action, target.action),
            gt(grants.expiresAt, new Date()),
            notExists(
              database
                .select({ id: personalWorkspaceClosures.id })
                .from(personalWorkspaceClosures)
                .where(
                  eq(personalWorkspaceClosures.workspaceId, grants.workspaceId),
                ),
            ),
          ),
        );
      return bot;
    },
  };
}
