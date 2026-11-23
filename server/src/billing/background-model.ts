import { createHash } from "node:crypto";
import type { CoordinationToolSpec } from "./coordination-model-call";
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
  personId: string;
  executionId: string;
  budgetId: string;
} & (
  | { kind: "routine" | "task" }
  | { kind: "delegation" | "subagent"; botId: string; parentRunId: string }
);

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
    readonly awaitingGatewayEvidence = false,
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

  async function completeTurn(
    scope: BackgroundModelScope,
    input: {
      step: string;
      previousSteps?: readonly string[];
      messages: ModelMessages;
      authorize: () => Promise<void>;
      coordinationTools?: readonly CoordinationToolSpec[];
    },
  ) {
    const operationId = backgroundModelOperationId(scope, input.step);
    const stop = (reason: string, awaitingGatewayEvidence = false): never => {
      throw new BackgroundModelWaiting(
        operationId,
        reason,
        awaitingGatewayEvidence,
      );
    };
    try {
      await input.authorize();
    } catch {
      return stop("not_authorized");
    }
    const identity = await identityOf(scope.personId);
    if (!identity) return stop("not_authorized");

    const answer = (receipt: Awaited<ReturnType<typeof ledger.reconcile>>) =>
      receipt?.state === "settled" &&
      receipt.budgetId &&
      (receipt.resultText || receipt.resultCalls)
        ? {
            text: receipt.resultText,
            calls: receipt.resultCalls,
            budgetId: receipt.budgetId,
          }
        : undefined;
    const receipt = await ledger.reconcile(identity, operationId);
    const replay = answer(receipt);
    if (replay) return replay;
    if (receipt?.state === "released" && !receipt.dispatchedAt)
      return stop("route_unavailable");
    if (receipt?.state === "settled" || receipt?.state === "released")
      return stop("reconciling");
    if (receipt?.state === "pending") return stop("reconciling", true);

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
      "botId" in scope ? undefined : operationId,
    );
    const rate = await ledger.quote();
    if (
      !confirmed?.modelQuote ||
      !rate ||
      rate.route !== confirmed.modelQuote.route ||
      rate.priceVersion !== confirmed.modelQuote.priceVersion
    )
      return stop("route_unavailable");

    const tools = rate.tools ? input.coordinationTools : undefined;
    const held = await ledger.reserve(identity, {
      operationId,
      route: rate.route,
      priceVersion: rate.priceVersion,
      budgetId: original.budgetId,
      creditType: original.creditType,
      applicationId: "openbot",
      stepId: backgroundModelOperationId(scope, ""),
      cumulativeExecution: true,
      ...(tools?.length
        ? { coordinationToolNames: tools.map(({ name }) => name) }
        : {}),
      ...("botId" in scope
        ? {
            child: { kind: scope.kind, botId: scope.botId },
            parentRunId: scope.parentRunId,
          }
        : {}),
    });
    if (held.state === "denied") return stop(held.reason);
    if (!held.permit) {
      const raced = answer(held.operation);
      if (raced) return raced;
      return stop("reconciling", held.operation.state === "pending");
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
      coordinationTools: tools?.filter(({ name }) =>
        held.operation.coordinationToolNames?.includes(name),
      ),
      input: { operationId, permit: held.permit, messages: input.messages },
    });
    if (result.state === "denied") return stop(result.reason);
    const terminal = "operation" in result ? result.operation : undefined;
    const continuing =
      terminal ?? (await ledger.reconcile(identity, operationId));
    const recovered = answer(continuing);
    if (recovered) return recovered;
    return stop("reconciling", continuing?.state === "pending");
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

    async offersCoordination() {
      return Boolean((await ledger.quote())?.tools);
    },

    completeTurn,
    async complete(
      scope: BackgroundModelScope,
      input: Omit<Parameters<typeof completeTurn>[1], "coordinationTools">,
    ): Promise<string> {
      const result = await completeTurn(scope, input);
      if (result.text) return result.text;
      throw new BackgroundModelWaiting(
        backgroundModelOperationId(scope, input.step),
        "reconciling",
      );
    },
  };
}

export type BackgroundModel = ReturnType<typeof createBackgroundModel>;
