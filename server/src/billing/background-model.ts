import { createHash } from "node:crypto";
import type { TestCreditLedger, VerifiedBillingIdentity } from "./test-credit";
import {
  dispatchTestCredit,
  type TestCreditExecutor,
} from "./test-credit-routes";

type IdentityOf = (
  personId: string,
) => Promise<VerifiedBillingIdentity | undefined>;
type ModelMessages = Parameters<TestCreditExecutor>[0]["messages"];

export type BackgroundModelScope = {
  kind: "routine" | "task";
  personId: string;
  executionId: string;
  budgetId: string;
};

export function backgroundModelOperationId(
  scope: BackgroundModelScope,
  step: string,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "openbot-background-v1",
        scope.kind,
        scope.personId,
        scope.executionId,
        step,
      ]),
    )
    .digest("hex");
}

export class BackgroundModelWaiting extends Error {
  constructor(
    readonly operationId: string,
    readonly reason: string,
  ) {
    super(
      reason === "reconciling"
        ? "This step is waiting for billing reconciliation."
        : reason === "execution_limit" || reason === "insufficient_credits"
          ? "This step is paused. Review its Credits and confirm to continue."
          : "This step cannot run under its current billing authorization or confirmed price.",
    );
    this.name = "BackgroundModelWaiting";
  }
}

export function createBackgroundModel({
  ledger,
  identityOf,
  execute,
}: {
  ledger: TestCreditLedger;
  identityOf: IdentityOf;
  execute: TestCreditExecutor;
}) {
  async function admission(
    identity: VerifiedBillingIdentity,
    budgetId: string,
  ) {
    const budget = await ledger.budget(identity, budgetId);
    const quote = await ledger.quote();
    if (!budget || !quote) return undefined;
    return { ...quote, ...budget };
  }

  return {
    async canStart(personId: string, budgetId: string) {
      const identity = await identityOf(personId);
      if (!identity) return false;
      const preview = await admission(identity, budgetId);
      const confirmed = await ledger.backgroundModelBudget(identity, budgetId);
      return Boolean(
        preview?.confirmed &&
          preview.state === "active" &&
          confirmed?.modelQuote.route === preview.route &&
          confirmed.modelQuote.priceVersion === preview.priceVersion,
      );
    },

    async complete(
      scope: BackgroundModelScope,
      input: {
        step: string;
        previousSteps?: readonly string[];
        messages: ModelMessages;
        authorize: () => Promise<void>;
      },
    ): Promise<string> {
      const operationId = backgroundModelOperationId(scope, input.step);
      const stop = (reason: string): never => {
        throw new BackgroundModelWaiting(operationId, reason);
      };
      try {
        await input.authorize();
      } catch {
        return stop("not_authorized");
      }
      const identity = await identityOf(scope.personId);
      if (!identity) return stop("not_authorized");

      const receipt = await ledger.reconcile(identity, operationId);
      if (receipt?.state === "settled" && receipt.resultText)
        return receipt.resultText;
      if (receipt?.state === "released" && !receipt.dispatchedAt)
        return stop("route_unavailable");
      if (receipt && receipt.state !== "reserved") return stop("reconciling");

      let budgetId = scope.budgetId;
      for (const step of input.previousSteps ?? []) {
        const previous = await ledger.reconcile(
          identity,
          backgroundModelOperationId(scope, step),
        );
        if (previous?.state !== "settled" || !previous.resultText)
          return stop("reconciling");
        budgetId = previous.budgetId ?? budgetId;
      }

      const original = await ledger.budget(identity, budgetId);
      if (!original) return stop("not_authorized");
      const confirmed = await ledger.backgroundModelBudget(
        identity,
        budgetId,
        operationId,
      );
      const rate = await ledger.quote();
      if (
        !confirmed?.modelQuote ||
        !rate ||
        rate.route !== confirmed.modelQuote.route ||
        rate.priceVersion !== confirmed.modelQuote.priceVersion
      )
        return stop("route_unavailable");

      const held = await ledger.reserve(identity, {
        operationId,
        route: rate.route,
        priceVersion: rate.priceVersion,
        budgetId: original.budgetId,
        creditType: original.creditType,
        applicationId: "openbot",
        stepId: backgroundModelOperationId(scope, ""),
        cumulativeExecution: true,
      });
      if (held.state === "denied") return stop(held.reason);
      if (!held.permit) {
        if (held.operation.state === "settled" && held.operation.resultText)
          return held.operation.resultText;
        return stop("reconciling");
      }

      const authorizeDispatch = async () => {
        await input.authorize();
        const currentIdentity = await identityOf(scope.personId);
        return (
          currentIdentity?.issuer === identity.issuer &&
          currentIdentity.subject === identity.subject
        );
      };
      if (!(await authorizeDispatch().catch(() => false))) {
        await ledger.discardReservation(identity, {
          operationId,
          permit: held.permit,
        });
        return stop("not_authorized");
      }
      const result = await dispatchTestCredit({
        ledger,
        execute,
        identity,
        authorizeDispatch,
        input: { operationId, permit: held.permit, messages: input.messages },
      });
      if (result.state === "completed") return result.text;
      if (result.state === "denied") return stop(result.reason);
      const recovered = await ledger.reconcile(identity, operationId);
      if (recovered?.state === "settled" && recovered.resultText)
        return recovered.resultText;
      return stop("reconciling");
    },
  };
}

export type BackgroundModel = ReturnType<typeof createBackgroundModel>;
