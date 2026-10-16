/**
 * The production evaluation case runner (Issue #30 / DAG T24).
 *
 * One case is one CONTROLLED model call: the frozen prompt as the system message,
 * the frozen case input as the user message, the frozen model and its parameters —
 * no tools are declared, because the frozen configuration pins tool NAMES and
 * fixtures, not schemas, and a schema the experiment never froze is not something
 * an evaluation may invent. A model call is money, so the call is bounded in time
 * and its outcome is durable before anything else happens: the worker marks the
 * case in its write-ahead row before invoking this runner and lands the observed
 * outcome after, which is what makes a takeover refuse to invoke twice.
 *
 * Two seams, both interfaces rather than implementations:
 *  - `admit` is the per-call billing admission — T25's seam. This ticket wires
 *    nothing behind it; a refused admission is an honestly failed case (the call
 *    never happened) observed as a `refused` span.
 *  - `observe` carries each call through the T14/T15 model-span channel: the
 *    same recorder the built-in path uses, so evaluation calls are observable in
 *    exactly the place production calls are. The observation bypass rules hold —
 *    an observer that throws is swallowed, never a reason a case fails.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import type { SafeText, SafeValue } from "../../../shared/ai-observability";
import type { EvaluationCaseRunner } from "./executions";
import type { ModelSpanObservation } from "./model-span";

/** One controlled model invocation. The production wiring is a chat-completions gateway. */
export type EvaluationModelCall = (input: {
  modelName: string;
  modelParameters: Record<string, unknown>;
  system: string;
  user: string;
}) => Promise<{
  output: string;
  /** The provider's settled usage; missing means unknown, never zero. */
  inputTokens?: number;
  outputTokens?: number;
}>;

/**
 * The per-call billing admission (T25's seam — interface only in this ticket). The
 * execution-start precheck already runs in `createExperimentExecutionService`;
 * this is the finer question: may THIS call be spent. Refusal is fail-closed —
 * the model is never invoked.
 */
export type ExecutionCaseBillingAdmission = (input: {
  executionId: string;
  experimentId: string;
  caseIndex: number;
  modelName: string;
}) => Promise<{ allowed: true } | { allowed: false; reason?: string }>;

/** One model call's observation, through the same channel the built-in path uses. */
export type EvaluationModelCallObserver = (
  observation: ModelSpanObservation,
) => void;

/** The frozen fields arrive as projection envelopes; the call needs the values. */
export const textOf = (safe: SafeText): string =>
  "text" in safe ? safe.text : "";

const recordOf = (safe: SafeValue): Record<string, unknown> =>
  safe.state === "projected" &&
  safe.value !== null &&
  typeof safe.value === "object" &&
  !Array.isArray(safe.value)
    ? (safe.value as Record<string, unknown>)
    : {};

export function createProductionEvaluationCaseRunner(
  deps: Readonly<{
    callModel: EvaluationModelCall;
    admit?: ExecutionCaseBillingAdmission;
    observe?: EvaluationModelCallObserver;
  }>,
): EvaluationCaseRunner {
  // The bypass rule, inherited from T14: observability never fails the product path.
  const report = (observation: ModelSpanObservation) => {
    try {
      deps.observe?.(observation);
    } catch {
      // swallowed by contract
    }
  };

  return async (context) => {
    const modelName = textOf(context.config.modelName);
    const system = textOf(context.config.prompt);
    const user = textOf(context.frozenCase.safeInput);
    const input = `${system}\n\n${user}`;
    const startedAt = new Date();
    const base = {
      modelId: modelName,
      scope: context.scope,
      input,
    };

    const admission = await deps.admit?.({
      executionId: context.executionId,
      experimentId: context.experimentId,
      caseIndex: context.caseIndex,
      modelName,
    });
    if (admission && !admission.allowed) {
      report({
        ...base,
        occurredAt: startedAt,
        endedAt: new Date(),
        ending: { kind: "refused", code: "budget_refused" },
      });
      // The refusal's diagnosis rides the span observation and the settle's error
      // code; the T28 outcome shape has no case-level reason field.
      return { status: "failed" };
    }

    try {
      const answer = await deps.callModel({
        modelName,
        modelParameters: recordOf(context.config.modelParameters),
        system,
        user,
      });
      const knownUsage =
        answer.inputTokens !== undefined && answer.outputTokens !== undefined;
      report({
        ...base,
        occurredAt: startedAt,
        endedAt: new Date(),
        output: answer.output,
        ending: knownUsage
          ? {
              kind: "succeeded",
              inputTokens: answer.inputTokens as number,
              outputTokens: answer.outputTokens as number,
            }
          : // A call without a usage report is unknown-cost, not free (T14's rule).
            { kind: "usage_missing" },
      });
      return {
        status: "completed",
        output: answer.output,
        ...(knownUsage
          ? {
              usage: {
                inputTokens: answer.inputTokens,
                outputTokens: answer.outputTokens,
              },
            }
          : {}),
      };
    } catch {
      report({
        ...base,
        occurredAt: startedAt,
        endedAt: new Date(),
        ending: { kind: "failed", code: "provider_error" },
      });
      // The bounded error text is gone with the detail field it lived in; the span
      // observation keeps the `provider_error` diagnosis.
      return { status: "failed" };
    }
  };
}

/**
 * The production model call: one chat-completions round trip on the OpenAI-compatible
 * gateway, the same deployment shape the runtime's built-in path dials (a named
 * `OPENAI_BASE_URL`). Time-bounded so a hung gateway cannot hold a worker's lease
 * slot; the parameters are the frozen configuration's, with the handful of settings
 * the gateway understands mapped and everything else ignored rather than guessed at.
 */
export function createGatewayModelCall(
  options: Readonly<{
    apiKey?: string;
    baseURL?: string;
    timeoutMs?: number;
  }> = {},
): EvaluationModelCall {
  // Lazily built: deployments that never execute an evaluation never pay for it.
  let client: ReturnType<typeof createOpenAI> | null = null;
  const openai = () => {
    client ??= createOpenAI({
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: options.baseURL ?? process.env.OPENAI_BASE_URL,
    });
    return client;
  };

  return async ({ modelName, modelParameters, system, user }) => {
    const settings = gatewaySettings(modelParameters);
    const result = await generateText({
      model: openai().chat(modelName),
      system,
      prompt: user,
      abortSignal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      ...settings,
    });
    return {
      output: result.text,
      inputTokens: result.usage.inputTokens ?? undefined,
      outputTokens: result.usage.outputTokens ?? undefined,
    };
  };
}

/** Numbers the gateway settings vocabulary accepts; everything else is not forwarded. */
function gatewaySettings(parameters: Record<string, unknown>) {
  const numeric = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  return {
    temperature: numeric(parameters.temperature),
    maxOutputTokens: numeric(
      parameters.maxOutputTokens ?? parameters.maxTokens,
    ),
    topP: numeric(parameters.topP ?? parameters.top_p),
  };
}
