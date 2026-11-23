import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { accounts } from "../db/schema";
import type { ManagedModelResult } from "../managed-model-trial";
import type { TestCreditLedger, VerifiedBillingIdentity } from "./test-credit";
import {
  dispatchTestCredit,
  type TestCreditExecutor,
} from "./test-credit-routes";

export const testCreditConfirmation = z.strictObject({
  route: z.string().min(1).max(64),
  priceVersion: z.uuid(),
});

export type CasdoorBillingProvider = { issuer: string; providerId: string };

/** Resolve a server-authenticated Person through Better Auth's verified OIDC account link. */
export function createCasdoorBillingIdentity(
  database: Database,
  provider: CasdoorBillingProvider,
) {
  return async (
    personId: string,
  ): Promise<VerifiedBillingIdentity | undefined> => {
    const linked = await database
      .select({ subject: accounts.accountId })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, personId),
          eq(accounts.providerId, provider.providerId),
          eq(accounts.issuer, provider.issuer),
        ),
      )
      .limit(2);
    const [account] = linked;
    if (linked.length === 1 && account?.subject)
      return { issuer: provider.issuer, subject: account.subject };
  };
}

type Receipt = Awaited<ReturnType<TestCreditLedger["receipt"]>>;
type ChatCreditResult = ManagedModelResult & { operation?: Receipt };

function recovered(receipt: Receipt): ChatCreditResult {
  if (receipt?.state === "settled" && receipt.resultText)
    return { state: "completed", text: receipt.resultText, operation: receipt };
  if (receipt?.state === "settled" || receipt?.state === "released")
    return { state: receipt.state, operation: receipt };
  return { state: receipt ? "reconciling" : "unavailable", operation: receipt };
}

export function createDirectChatTestCredit(
  database: Database,
  {
    ledger,
    casdoor,
    execute,
  }: {
    ledger: TestCreditLedger;
    casdoor: CasdoorBillingProvider;
    execute: TestCreditExecutor;
  },
) {
  const identityOf = createCasdoorBillingIdentity(database, casdoor);
  return {
    async quote(personId: string) {
      const identity = await identityOf(personId);
      if (identity && (await ledger.accountOf(identity))) return ledger.quote();
    },
    async reconcile(id: string, personId: string) {
      const identity = await identityOf(personId);
      return identity
        ? recovered(await ledger.reconcile(identity, id))
        : undefined;
    },
    async complete(input: {
      id: string;
      personId: string;
      confirmation: z.infer<typeof testCreditConfirmation>;
      messages: Parameters<TestCreditExecutor>[0]["messages"];
    }): Promise<ChatCreditResult> {
      const identity = await identityOf(input.personId);
      if (!identity) return { state: "not_authorized" };
      const quote = await ledger.quote();
      if (
        quote?.route !== input.confirmation.route ||
        quote.priceVersion !== input.confirmation.priceVersion
      )
        return { state: "route_unavailable" };

      const held = await ledger.reserve(identity, {
        operationId: input.id,
        ...input.confirmation,
        creditType: "test",
        applicationId: "openbot",
        resumable: false,
      });
      if (held.state === "denied") return { state: held.reason };

      try {
        if (!held.permit)
          return recovered(await ledger.reconcile(identity, input.id));

        const result = await dispatchTestCredit({
          ledger,
          execute,
          identity,
          input: {
            operationId: input.id,
            permit: held.permit,
            messages: input.messages,
          },
        });
        if (result.state === "denied")
          return {
            state: result.reason,
            operation: await ledger
              .receipt(identity, input.id)
              .catch(() => undefined),
          };
        if (result.state === "completed") return result;
        if (result.state === "executor_unavailable")
          return { state: "unavailable" };
        return recovered(await ledger.reconcile(identity, input.id));
      } catch {
        // A reservation exists and a failed write may have committed. Replay must
        // use this operation ID until its outcome is known.
        return { state: "reconciling" };
      }
    },
  };
}

export type DirectChatTestCredit = ReturnType<
  typeof createDirectChatTestCredit
>;
export type DirectChatTestCreditDependencies = Parameters<
  typeof createDirectChatTestCredit
>[1];
