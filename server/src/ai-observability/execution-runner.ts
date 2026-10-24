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
 * outcome after, which is what makes a takeover refuse to invoke twice. It is
 * bounded by the task's cancellation too (FREV-05): a cancel or revocation that
 * settles the execution behind the worker's back aborts the dial it is awaiting,
 * and the case lands as a cancellation — never as a provider error, and never
 * silently.
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
  /**
   * The approved entrance the caller resolved this request through, when one exists
   * (OCR R4-23): the dispatch key that keeps admission and dialing the same fact even
   * when two entrances share a model name. Absent on plain gateway calls.
   */
  entranceId?: string;
  /**
   * The task's cancellation signal (FREV-05): combined with the call's own time bound,
   * whichever fires first. A cancelled task's in-flight dial is interrupted, not left
   * to run to completion against an execution that already settled. Absent on callers
   * with no cancellation source — the pre-FREV-05 contract, bounded by the timeout.
   */
  signal?: AbortSignal;
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
    const startedAt = new Date();
    const base = {
      modelId: modelName,
      scope: context.scope,
      input: `${system}\n\n${user}`,
    };

    // Fail-closed at the projection boundary (OCR R4-21, the judge's AC3 precedent):
    // a prompt, case input or model name the redaction policy withheld is not an
    // empty string to dial with — there is nothing safe to evaluate, and dialing a
    // stripped question still spends money on it. The case settles as the domain
    // refusal BEFORE the billing admission (zero holds, zero provider calls), and
    // the observation carries the same refused ending the admission path does.
    // A truncation is still reviewed text (the judge's ruling) and proceeds — only
    // an omitted envelope, the field withheld outright, refuses (OCR R5-18). The
    // frozen parameters are held to the projected standard (OCR R5-20): a
    // truncated or omitted top-level envelope would dial gateway defaults while
    // the case still costs money — the same stripped-dial judgment — so a
    // non-projected parameters record refuses with the texts.
    if (
      context.config.modelName.state === "omitted" ||
      context.config.prompt.state === "omitted" ||
      context.frozenCase.safeInput.state === "omitted" ||
      context.config.modelParameters.state !== "projected"
    ) {
      report({
        ...base,
        occurredAt: startedAt,
        endedAt: new Date(),
        ending: { kind: "refused", code: "input_unavailable" },
      });
      return { status: "failed", reason: "input_unavailable" };
    }

    // FREV-05: a task already cancelled before the dial refuses in the same class
    // as the projection refusal — zero holds, zero provider calls, and the honest
    // `canceled` observation ending instead of a provider error the call never got
    // the chance to be. The worker's cancel-watch can fire between the case's
    // start and this point; the check is the dial's last look at the signal.
    if (context.signal?.aborted) {
      report({
        ...base,
        occurredAt: startedAt,
        endedAt: new Date(),
        ending: { kind: "canceled" },
      });
      return { status: "failed", reason: "cancelled" };
    }

    const admission = await deps.admit?.({
      executionId: context.executionId,
      experimentId: context.experimentId,
      caseIndex: context.caseIndex,
      modelName,
    });
    if (admission && !admission.allowed) {
      // The admission's own reason rides the span AND the outcome (T25-rev L-1): a
      // credits_exhausted case is never collapsed into a generic budget word whose
      // diagnosis lives only in a log line. `budget_refused` stays the fallback for
      // an admission that refuses without naming why.
      report({
        ...base,
        occurredAt: startedAt,
        endedAt: new Date(),
        ending: {
          kind: "refused",
          code: admission.reason ?? "budget_refused",
        },
      });
      return {
        status: "failed",
        ...(admission.reason === undefined ? {} : { reason: admission.reason }),
      };
    }

    try {
      const answer = await deps.callModel({
        modelName,
        modelParameters: recordOf(context.config.modelParameters),
        system,
        user,
        signal: context.signal,
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
      // FREV-05: an abort from the task's cancellation signal is a cancellation,
      // not a provider failure — the rejection says nothing about why the dial
      // ended, so the signal is asked. The billed layer above still settles it by
      // the thrown-call doctrine (unknown cost, evidence row, hold retained): the
      // provider may have produced billable work before it was stopped.
      if (context.signal?.aborted) {
        report({
          ...base,
          occurredAt: startedAt,
          endedAt: new Date(),
          ending: { kind: "canceled" },
        });
        return { status: "failed", reason: "cancelled" };
      }
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
 * The default per-call gateway budget (OCR m131's pairing constant): the time one
 * case's model call may hold before the runner itself gives up on it. Exported so
 * the production assembly's work-item lease (execution-boot.ts) can be held to a
 * lifetime that provably outlives it.
 */
export const GATEWAY_CALL_TIMEOUT_MS = 60_000;

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

  return async ({ modelName, modelParameters, system, user, signal }) => {
    const settings = gatewaySettings(modelParameters);
    // The call's own time bound and the task's cancellation are one signal
    // (FREV-05): whichever fires first ends the dial, so a cancelled task does
    // not wait out a budget nobody will use. Without a task signal the timeout
    // alone bounds the call, exactly as before.
    const bound = AbortSignal.timeout(
      options.timeoutMs ?? GATEWAY_CALL_TIMEOUT_MS,
    );
    const result = await generateText({
      model: openai().chat(modelName),
      system,
      prompt: user,
      abortSignal:
        signal === undefined ? bound : AbortSignal.any([bound, signal]),
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
  // The frozen configuration projects every leaf through `projectSafeFixture`, so a
  // parameter arrives as a `{state:"projected", value:n}` envelope (R4-26): unwrap
  // one projected layer before the numeric gate. Anything else — an omitted or
  // truncated envelope, a bare non-number — stays undefined, fail-closed: a
  // parameter the freeze did not keep intact is never guessed onto the wire.
  const numeric = (value: unknown) => {
    const unwrapped =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as { state?: unknown }).state === "projected" &&
      "value" in (value as Record<string, unknown>)
        ? (value as { value: unknown }).value
        : value;
    return typeof unwrapped === "number" && Number.isFinite(unwrapped)
      ? unwrapped
      : undefined;
  };
  return {
    temperature: numeric(parameters.temperature),
    maxOutputTokens: numeric(
      parameters.maxOutputTokens ?? parameters.maxTokens,
    ),
    topP: numeric(parameters.topP ?? parameters.top_p),
  };
}
