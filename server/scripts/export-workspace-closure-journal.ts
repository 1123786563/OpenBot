import { asc } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { personalWorkspaceClosures } from "../src/db/schema";
import { readIntelligenceInventory } from "../src/personal-saas/intelligence-inventory";

const url = process.env.DATABASE_URL;
if (!url)
  throw new Error(
    "DATABASE_URL must point to the authoritative closure journal",
  );

const database = createDatabase(url);
try {
  const { id, accountId, workspaceId, acceptedAt } = personalWorkspaceClosures;
  const operations = await database.transaction(
    async (tx) => {
      const closures = await tx
        .select({ id, accountId, workspaceId, acceptedAt })
        .from(personalWorkspaceClosures)
        .orderBy(asc(acceptedAt), asc(id));
      const inventory = await readIntelligenceInventory(
        tx,
        closures.map(({ accountId }) => accountId),
      );
      const byAccount = Map.groupBy(inventory, ({ accountId }) => accountId);
      return closures.map((closure) => ({
        ...closure,
        intelligence: (byAccount.get(closure.accountId) ?? []).map(
          ({ agentId, threadId, runId }) => ({ agentId, threadId, runId }),
        ),
      }));
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  await Bun.write(Bun.stdout, JSON.stringify({ version: 2, operations }));
} finally {
  await database.$client.close();
}
