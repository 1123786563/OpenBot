import { eq } from "drizzle-orm";
import { z } from "zod";
import type { TestCreditLedger } from "../billing/test-credit";
import {
  dispatchTestCredit,
  type TestCreditExecutor,
} from "../billing/test-credit-routes";
import type { Database } from "../db/client";
import { personalSaasAccounts } from "../db/schema";

export const botRunCreditQuote = z.object({
  route: z.string().min(1).max(64),
  priceVersion: z.uuid(),
});

export function personalTestCreditExecution(
  database: Database,
  ledger: TestCreditLedger,
  execute: TestCreditExecutor,
) {
  return async ({
    accountId,
    operationId,
    instruction,
    quote,
    checkExecution,
    signal,
  }: {
    accountId: string;
    operationId: string;
    instruction: string;
    quote: z.infer<typeof botRunCreditQuote>;
    checkExecution(): Promise<void>;
    signal: AbortSignal;
  }) => {
    const [identity] = await database
      .select({
        issuer: personalSaasAccounts.issuer,
        subject: personalSaasAccounts.subject,
      })
      .from(personalSaasAccounts)
      .where(eq(personalSaasAccounts.id, accountId));
    if (!identity) return;

    await checkExecution();
    const reservation = await ledger.reserve(identity, {
      operationId,
      ...quote,
    });
    if (reservation.state === "denied" || !reservation.permit) return;
    const result = await dispatchTestCredit({
      ledger,
      execute,
      identity,
      input: {
        operationId,
        permit: reservation.permit,
        messages: [{ role: "user", content: instruction }],
      },
      async maySend() {
        await checkExecution();
        return true;
      },
      signal,
    });
    if (result.state === "completed") return result.text;
  };
}

export type PersonalTestCreditExecution = ReturnType<
  typeof personalTestCreditExecution
>;
