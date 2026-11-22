import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { billingKeys, type BudgetRecord } from "./queries";

/**
 * A new budget. The Credit type is fixed here, when the task starts: a trial task runs on Test
 * Credits, a paid continuation on paid credits, and the two never mix inside one budget.
 */
export type BudgetInput = {
  creditType: "test" | "paid";
  /** In credits, as the person typed it. Sent as whole microcredits. */
  limitCredits: string;
};

const FALLBACK = "Could not set the budget";

const MICROCREDITS_PER_CREDIT = 1_000_000n;

/** A credit amount typed by a person, as whole microcredits. Rejects anything but a positive amount. */
export function microcreditsFromCredits(limitCredits: string) {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(limitCredits.trim());
  if (!match) return undefined;
  const microcredits =
    BigInt(match[1]) * MICROCREDITS_PER_CREDIT +
    BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  return microcredits > 0n ? microcredits.toString() : undefined;
}

export function createBudgetMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: BudgetInput): Promise<BudgetRecord> =>
      (
        await client("/api/billing/budgets", {
          method: "POST",
          body: {
            budgetId: `budget-${crypto.randomUUID()}`,
            creditType: input.creditType,
            limitMicrocredits: microcreditsFromCredits(input.limitCredits),
          },
          fallback: FALLBACK,
        })
      ).json(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: billingKeys.all }),
  });
}

/** A paused step continues on the budget the person confirmed for it. */
export function confirmResumePointMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      operationId: string;
      budgetId: string;
    }): Promise<{ state: "confirmed"; creditType: "test" | "paid" }> =>
      (
        await client(
          `/api/billing/resume-points/${input.operationId}/confirm`,
          {
            method: "POST",
            body: { budgetId: input.budgetId },
            fallback: "Could not continue the step",
          },
        )
      ).json(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: billingKeys.all }),
  });
}
