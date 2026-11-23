import {
  createManagedModel,
  type ManagedModelResult,
  type ModelOperation,
  managedModelOperationId,
} from "../managed-model-trial";
import type {
  ModelBillingContext,
  ModelCallOptions,
  ModelCompleter,
} from "../routing/model";
import type { TestCreditLedger, VerifiedBillingIdentity } from "./test-credit";
import {
  dispatchTestCredit,
  type TestCreditExecutor,
} from "./test-credit-routes";

export type AuxiliaryModelSource =
  | "routing"
  | "tool-selection"
  | "approval"
  | "admin";

export type AuxiliaryModelBilling = ModelBillingContext;
export type AuxiliaryModelOptions = Omit<ModelCallOptions, "billing"> & {
  billing: AuxiliaryModelBilling;
};

export class AuxiliaryModelBillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuxiliaryModelBillingError";
  }
}

function messages(prompt: string) {
  return [{ role: "user" as const, content: prompt }];
}

function resultText(result: ManagedModelResult): string {
  if (result.state === "completed") return result.text;
  throw new AuxiliaryModelBillingError(
    `Auxiliary model call did not complete: ${result.state}.`,
  );
}

function auxiliaryCompleter(
  complete: (
    input: ModelOperation & { messages: ReturnType<typeof messages> },
    billing: AuxiliaryModelBilling,
    signal: AbortSignal | undefined,
  ) => Promise<ManagedModelResult>,
): ModelCompleter {
  return async (prompt, signal, options) => {
    const billing = options?.billing;
    if (!billing)
      throw new AuxiliaryModelBillingError(
        "Auxiliary model calls require an explicit billing context.",
      );
    if (billing.funding.kind === "platform" && !billing.funding.budget?.id)
      throw new AuxiliaryModelBillingError(
        "Platform-funded auxiliary calls require a bounded platform budget.",
      );
    signal?.throwIfAborted();
    return resultText(
      await complete(
        {
          scope: billing,
          step: billing.step,
          budget: billing.funding.budget,
          messages: messages(prompt),
        },
        billing,
        signal,
      ),
    );
  };
}

export function createAuxiliaryModelCompleter(config: {
  model: { url: URL; token: string };
  route: string;
}): ModelCompleter {
  const managed = createManagedModel(config.model);
  return auxiliaryCompleter((input) =>
    managed.complete({ ...input, route: config.route }),
  );
}

const auditPlatformIdentity = {
  issuer: "openbot:platform",
  subject: "audit-ask",
} satisfies VerifiedBillingIdentity;

export const disabledAuxiliaryModel: ModelCompleter = async () => {
  throw new AuxiliaryModelBillingError(
    "This auxiliary model is unavailable in the Test Credit pilot.",
  );
};

/** First-party pilot calls share the ledger and verified Bifrost executor used by Direct Chat. */
export function createPilotAuxiliaryModel({
  ledger,
  execute,
  identityOf,
  platformBudgetId,
}: {
  ledger: TestCreditLedger;
  execute: TestCreditExecutor;
  identityOf: (
    personId: string,
  ) => Promise<VerifiedBillingIdentity | undefined>;
  platformBudgetId?: string;
}): ModelCompleter {
  return auxiliaryCompleter(async (input, billing, signal) => {
    const identity =
      billing.source === "routing" && billing.funding.kind === "user"
        ? await identityOf(billing.personId)
        : billing.source === "admin" &&
            billing.funding.kind === "platform" &&
            billing.funding.budget.id === platformBudgetId
          ? auditPlatformIdentity
          : undefined;
    if (!identity) return { state: "not_authorized" };

    const resolved = await ledger.resolveQuote({});
    if ("reason" in resolved) return { state: "route_unavailable" };
    signal?.throwIfAborted();
    const operationId = managedModelOperationId(input);
    const held = await ledger.reserve(identity, {
      operationId,
      route: resolved.quote.route,
      priceVersion: resolved.quote.priceVersion,
      applicationId: "openbot",
      creditType: "test",
      resumable: false,
      budgetId: input.budget?.id,
      stepId: input.budget?.stepId,
    });
    if (held.state === "denied") return { state: held.reason };
    if (held.permit) {
      const result = await dispatchTestCredit({
        ledger,
        execute,
        identity,
        input: { operationId, permit: held.permit, messages: input.messages },
      });
      if (result.state === "completed") return result;
      if (result.state === "denied") return { state: result.reason };
      if (result.state === "executor_unavailable")
        return { state: "unavailable" };
    }
    const receipt = await ledger.reconcile(identity, operationId);
    if (receipt?.state === "settled" && receipt.resultText)
      return { state: "completed", text: receipt.resultText };
    return { state: "reconciling" };
  });
}
