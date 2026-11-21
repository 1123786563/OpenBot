import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  personalIntelligenceRuns,
  personalWorkspaceDefaultBots,
  personalWorkspaces,
  workItems,
} from "../db/schema";
import { readExecutionAccess } from "./account-access";
import { PERSONAL_BOT_WORK } from "./quotas";
import type { Transaction } from "./store";

export function trackIntelligenceRuns(
  database: Database,
  now: () => number,
  run: TurnRunner,
): TurnRunner {
  return async (turn) => {
    const { ownerUserId: accountId, agentId, threadId } = turn;
    const runId = turn.runId ?? crypto.randomUUID();
    await database.transaction(async (tx) => {
      const access = await readExecutionAccess(tx, accountId, now);
      if (access?.kind !== "active" || turn.signal?.aborted)
        throw new Error("Workspace execution is unavailable");
      await tx
        .insert(personalIntelligenceRuns)
        .values({ accountId, agentId, threadId, runId })
        .onConflictDoNothing();
    });
    return run({ ...turn, runId });
  };
}

export function readIntelligenceInventory(
  database: Pick<Database, "select">,
  accountIds: string[],
) {
  const { accountId, agentId, threadId, runId } = personalIntelligenceRuns;
  return database
    .select({ accountId, agentId, threadId, runId })
    .from(personalIntelligenceRuns)
    .where(inArray(accountId, accountIds))
    .orderBy(asc(threadId), asc(runId), asc(agentId));
}

export async function captureLegacyBotRuns(tx: Transaction, accountId: string) {
  await tx
    .insert(personalIntelligenceRuns)
    .select(
      tx
        .select({
          accountId: personalWorkspaces.ownerId,
          threadId: workItems.key,
          runId: workItems.key,
          agentId: personalWorkspaceDefaultBots.agentId,
        })
        .from(workItems)
        .innerJoin(
          personalWorkspaces,
          eq(personalWorkspaces.ownerId, workItems.accountId),
        )
        .innerJoin(
          personalWorkspaceDefaultBots,
          eq(personalWorkspaceDefaultBots.workspaceId, personalWorkspaces.id),
        )
        .where(
          and(
            eq(workItems.accountId, accountId),
            eq(workItems.kind, PERSONAL_BOT_WORK),
          ),
        ),
    )
    .onConflictDoNothing();
}
