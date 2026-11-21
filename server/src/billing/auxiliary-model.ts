import {
  createManagedModel,
  type ManagedModelResult,
} from "../managed-model-trial";
import type { ModelCallOptions, ModelCompleter } from "../routing/model";

export type AuxiliaryModelSource =
  | "routing"
  | "tool-selection"
  | "approval"
  | "admin";

type Scope = {
  source: AuxiliaryModelSource;
  personId: string;
  conversationId: string;
  botId: string;
  runId: string;
};

type Funding =
  | { kind: "user"; budget?: { id: string; stepId?: string } }
  | { kind: "platform"; budget: { id: string; stepId?: string } };

export type AuxiliaryModelBilling = Scope & {
  step: string;
  funding: Funding;
};

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
    `Auxiliary model call was not dispatched: ${result.state}.`,
  );
}

/**
 * Creates a helper-model completer backed by the same reserve, dispatch and reconciliation contract
 * as direct Test Credit calls. Every call must identify its funding and stable execution scope.
 */
export function createAuxiliaryModelCompleter(config: {
  model: { url: URL; token: string };
  route: string;
}): ModelCompleter {
  const managed = createManagedModel(config.model);
  return async (prompt, _signal, options) => {
    const billing = (options as AuxiliaryModelOptions | undefined)?.billing;
    if (!billing)
      throw new AuxiliaryModelBillingError(
        "Auxiliary model calls require an explicit billing context.",
      );
    if (billing.funding.kind === "platform" && !billing.funding.budget)
      throw new AuxiliaryModelBillingError(
        "Platform-funded auxiliary calls require a bounded platform budget.",
      );
    const budget = billing.funding.budget;
    const result = await managed.complete({
      scope: {
        source: billing.source,
        personId: billing.personId,
        conversationId: billing.conversationId,
        botId: billing.botId,
        runId: billing.runId,
      },
      step: billing.step,
      ...(budget ? { budget } : {}),
      route: config.route,
      messages: messages(prompt),
    });
    return resultText(result);
  };
}
