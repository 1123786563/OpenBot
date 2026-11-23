import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  accounts,
  channelMemberships,
  channels,
  directChatRuns,
  intelligenceChannelMappings,
  testCreditAccounts,
  testCreditOperations,
} from "../db/schema";
import {
  type CasdoorBillingProvider,
  createCasdoorBillingIdentity,
} from "./direct-chat-test-credit";
import type { TestCreditLedger } from "./test-credit";

export function createDirectChatCreditRecovery(
  database: Database,
  ledger: TestCreditLedger,
  provider: CasdoorBillingProvider,
) {
  const identityOf = createCasdoorBillingIdentity(database, provider);

  return async () => {
    const runs = await database
      .select({
        threadId: directChatRuns.threadId,
        runId: directChatRuns.id,
        personId: intelligenceChannelMappings.userId,
        operationId: testCreditOperations.id,
        subject: testCreditAccounts.subject,
      })
      .from(directChatRuns)
      .innerJoin(
        intelligenceChannelMappings,
        eq(intelligenceChannelMappings.threadId, directChatRuns.threadId),
      )
      .innerJoin(
        channels,
        eq(channels.id, intelligenceChannelMappings.channelId),
      )
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.userId, intelligenceChannelMappings.userId),
        ),
      )
      .innerJoin(
        accounts,
        and(
          eq(accounts.userId, intelligenceChannelMappings.userId),
          eq(accounts.providerId, provider.providerId),
          eq(accounts.issuer, provider.issuer),
        ),
      )
      .innerJoin(
        testCreditAccounts,
        and(
          eq(testCreditAccounts.issuer, provider.issuer),
          eq(testCreditAccounts.subject, accounts.accountId),
        ),
      )
      .innerJoin(
        testCreditOperations,
        and(
          eq(testCreditOperations.accountId, testCreditAccounts.id),
          eq(testCreditOperations.id, directChatRuns.testCreditOperationId),
        ),
      )
      .where(
        and(
          isNull(channels.deletedAt),
          isNotNull(directChatRuns.testCreditOperationId),
          ne(directChatRuns.status, "completed"),
          isNotNull(testCreditOperations.resultText),
          or(
            eq(testCreditOperations.state, "settled"),
            and(
              eq(testCreditOperations.state, "pending"),
              isNotNull(testCreditOperations.eligibleEvidenceId),
            ),
          ),
        ),
      )
      .orderBy(directChatRuns.startedAt)
      .limit(100);

    for (const run of runs) {
      const identity = await identityOf(run.personId);
      if (identity?.subject !== run.subject) continue;
      const receipt = await ledger.reconcile(identity, run.operationId);
      if (receipt?.state !== "settled" || !receipt.resultText) continue;
      await database
        .update(directChatRuns)
        .set({
          status: "completed",
          assistantMessageId: crypto.randomUUID(),
          reply: receipt.resultText,
        })
        .where(
          and(
            eq(directChatRuns.threadId, run.threadId),
            eq(directChatRuns.id, run.runId),
            eq(directChatRuns.testCreditOperationId, run.operationId),
            ne(directChatRuns.status, "completed"),
          ),
        );
    }
  };
}
