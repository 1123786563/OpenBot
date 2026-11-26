import { asc, eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  personalWorkspaceAgenticSpaces,
  personalWorkspaceAgentSandboxes,
  personalWorkspaceClosures,
} from "../src/db/schema";
import { agenticStorageLocator } from "../src/personal-saas/closure-cleanup-contract";
import { readIntelligenceInventory } from "../src/personal-saas/intelligence-inventory";

const url = process.env.DATABASE_URL;
if (!url)
  throw new Error(
    "DATABASE_URL must point to the authoritative closure journal",
  );

const database = createDatabase(url);
try {
  const {
    id,
    accountId,
    workspaceId,
    acceptedAt,
    retiredIntelligence,
    storageRecovery,
  } = personalWorkspaceClosures;
  const operations = await database.transaction(
    async (tx) => {
      const closures = await tx
        .select({
          id,
          accountId,
          workspaceId,
          acceptedAt,
          retiredIntelligence,
          storageRecovery,
          binding: personalWorkspaceAgenticSpaces,
          sandboxPhase: personalWorkspaceAgentSandboxes.phase,
        })
        .from(personalWorkspaceClosures)
        .leftJoin(
          personalWorkspaceAgenticSpaces,
          eq(personalWorkspaceAgenticSpaces.workspaceId, workspaceId),
        )
        .leftJoin(
          personalWorkspaceAgentSandboxes,
          eq(personalWorkspaceAgentSandboxes.workspaceId, workspaceId),
        )
        .orderBy(asc(acceptedAt), asc(id));
      const inventory = await readIntelligenceInventory(
        tx,
        closures
          .filter(({ retiredIntelligence }) => retiredIntelligence === null)
          .map(({ accountId }) => accountId),
      );
      const byAccount = Map.groupBy(inventory, ({ accountId }) => accountId);
      return closures.map(
        ({
          retiredIntelligence,
          storageRecovery,
          binding,
          sandboxPhase,
          ...closure
        }) => ({
          ...closure,
          storage:
            storageRecovery ??
            (binding
              ? {
                  kind: "agenticfs",
                  ...agenticStorageLocator.parse(binding),
                  released: sandboxPhase === null || sandboxPhase === "stopped",
                }
              : { kind: retiredIntelligence === null ? "none" : "unknown" }),
          intelligence:
            retiredIntelligence ??
            (byAccount.get(closure.accountId) ?? []).map(
              ({ agentId, threadId, runId }) => ({ agentId, threadId, runId }),
            ),
        }),
      );
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  await Bun.write(Bun.stdout, JSON.stringify({ version: 3, operations }));
} finally {
  await database.$client.close();
}
