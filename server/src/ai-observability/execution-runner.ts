/**
 * The production evaluation case runner (Issue #30 / DAG T24, FREV-04).
 *
 * One case is one ADMITTED, ISOLATED model execution. WHERE that execution runs is
 * the seam's business, not this file's: production runs it through the Bot's own
 * public execution entry — the builtin assembly and engine in `execution-seam.ts`
 * (FREV-04) — while the case runner here owns everything around the dial: the frozen
 * facts (the projection refusals, the projection-checked prompt and input), the
 * per-call admission, the step budget, the cancellation classification and the
 * observation. The `EvaluationModelCall` contract is the seam between the two.
 *
 * The execution itself — the thing an evaluated answer comes out of — is the public
 * one: the frozen case input as the user message on a thread that exists nowhere
 * else, the frozen prompt composed by the production assembly, and — when the
 * experiment froze any — exactly the whitelisted tool surface, declared to the model
 * and run through a bounded multi-step loop whose ceiling is production's own (the
 * same 8 the built-in path has run since it gained tools). There is no thread store,
 * no session and no memory handle on this path — the isolation is that the thread
 * exists nowhere else, not that a production conversation was borrowed and hoped to
 * stay empty.
 *
 * Every tool call the loop makes lands in `context.callTool` — the gate (executions.ts),
 * the one interception point the isolation doctrine always named, now on the real
 * execution path instead of beside it. A frozen fixture replays as the tool's answer
 * and therefore shapes the output; a whitelisted write, a whitelisted read with no
 * fixture, and a name the whitelist never listed are refused and counted, and the
 * model gets the refusal as the tool's error — none of them can reach a live tool. A
 * name the model invents (no declared tool answers it) is reported back by the engine
 * and put through that same gate, so the governance count is a count of real attempts
 * rather than an artefact of a path that could not call a tool at all.
 *
 * A model call is money, so the call is bounded in time
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
 *    never happened) observed as a `refused` span. It is asked ONCE, before the
 *    loop: it admits the case's FIRST provider request.
 *  - `stepBudget` is the loop's per-step budget (FREV-R2-01): the same admission
 *    seam applied to every provider request, asked before each step is dialed
 *    and told each step's own usage after it finishes. A case with a tool surface
 *    can cost several calls, and one hold priced for one call cannot bound that
 *    spend; the budget is how the billed layer keeps every step inside its own
 *    admission instead of discovering the overrun at settlement. Since R3-01 the
 *    budget is not a business-whitelist fact: the public engine declares its own
 *    state tools on every request, so a lent budget rides the toolless single
 *    call too; it is absent only on callers with their own single-call admission
 *    (the judge) and on the pre-FREV-R2-01 contract.
 *  - `observe` carries each call through the T14/T15 model-span channel: the
 *    same recorder the built-in path uses, so evaluation calls are observable in
 *    exactly the place production calls are. The observation bypass rules hold —
 *    an observer that throws is swallowed, never a reason a case fails.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, stepCountIs } from "ai";
import type { SafeText, SafeValue } from "../../../shared/ai-observability";
import { countChatInputTokens } from "../billing/input-bound";
import type { EvaluationCaseRunner, EvaluationToolSurface } from "./executions";
import type { ModelSpanObservation } from "./model-span";

/**
 * The model tool-loop cap of the retained controlled dial (`createGatewayModelCall`):
 * the SAME 8 the built-in path has run since it gained tools (`TOOL_STEPS` in
 * copilot.ts). The evaluation CASE's own loop no longer names a ceiling of its own —
 * it runs on the public execution seam, whose ceiling is the production assembly's
 * (`execution-seam.ts`, FREV-04). This constant is what the judge's fallback entrance
 * and the runner-level contracts still run with: a cut at the cap is a real outcome
 * the case reports honestly, never a loop allowed to run until the clock runs out.
 */
export const EVALUATION_TOOL_LOOP_MAX_STEPS = 8;

/**
 * The budget's own word for a request whose conservative input count cannot fit the
 * step's enforced input ceiling (R3-01) — the same refusal word the built-in input
 * bound uses (ADR-0001), so one vocabulary names the same doctrine everywhere.
 */
export const EVALUATION_INPUT_OVER_LIMIT = "input_over_limit";

/**
 * One tool the evaluation model may call, already wired to the gate: `execute` is the
 * runner's own closure over `context.callTool` — the production path's interception
 * point — never a live tool. The name is the frozen identity the experiment pinned;
 * description and parameters are the deployment catalogue's when the tool resolved to
 * one, and an honest generic declaration when it did not.
 */
export type EvaluationCallableTool = Readonly<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Replay the frozen fixture, or reject with the gate's refusal. Never a live call. */
  execute: (args: unknown) => Promise<unknown>;
}>;

/** One controlled model invocation. The production wiring is a chat-completions gateway. */
export type EvaluationModelCall = (input: {
  modelName: string;
  modelParameters: Record<string, unknown>;
  system: string;
  user: string;
  /**
   * The frozen tool surface this case declares (FREV-04). Absent or empty means the
   * case declares no tools at all and is the single controlled call the pre-FREV-04
   * contract describes; present, the engine runs a bounded tool loop over exactly
   * these tools and no others.
   */
  tools?: readonly EvaluationCallableTool[];
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
  /**
   * The per-step budget the billed layer lends an evaluation call (FREV-R2-01).
   * Asked before EVERY provider request the call makes and told each finished
   * step's own usage, so a case never spends several calls under one admission:
   * a step the budget refuses is never dialed, and every step that was dialed is
   * settled against the hold that admitted it. Not a business-whitelist fact
   * (R3-01): the public engine declares its own state tools unconditionally, so
   * a lent budget rides the toolless single call too. Absent on callers with
   * their own single-call admission (the judge) and on the pre-FREV-R2-01
   * contract, where one admission covers the one call.
   */
  stepBudget?: EvaluationStepBudget;
}) => Promise<{
  output: string;
  /** The provider's settled usage; missing means unknown, never zero. */
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Distinct tool names the model proposed that no declared tool answered (FREV-04).
   * The engine reports them rather than dropping them silently: the runner puts each
   * one through the evaluation gate, so an invented tool is a counted refusal on the
   * execution's governance row — the honest accounting the pre-FREV-04 path could
   * never produce because it called no tool at all.
   */
  undeclaredToolCalls?: readonly string[];
  /**
   * The tool-loop step the budget refused BEFORE its provider request (FREV-R2-01),
   * and the budget's own word for it. Its presence means the loop stopped short of a
   * final answer by an admission, not by a provider failure: the runner answers the
   * case as a refusal with that reason, and the steps that did run are settled by the
   * billed layer's own per-step records — never through this answer's usage.
   */
  budgetRefusal?: Readonly<{ step: number; reason?: string }>;
}>;

/** One finished step's own usage, as the provider reported it. */
export type EvaluationStepUsage = Readonly<{
  index: number;
  inputTokens?: number;
  outputTokens?: number;
}>;

/**
 * The per-step budget of one evaluation case's tool loop (FREV-R2-01).
 *
 * A case with a tool surface can cost up to `EVALUATION_TOOL_LOOP_MAX_STEPS` provider
 * calls, and one hold priced for a single call cannot bound that spend. This seam is
 * how the billed layer keeps the loop inside the ONE credit machinery: `admit` is
 * asked before each step — a refusal means the step's request is never sent — and
 * `record` carries each finished step's own usage, which the billed layer settles
 * against that step's reservation. The budget is a seam, not a policy: how a step is
 * admitted (a fresh hold, a case-level allowance) belongs to the implementation.
 */
export type EvaluationStepBudget = Readonly<{
  /**
   * The input ceiling every step's request is counted against before it is dialed
   * (R3-01): the policy's own input maximum, enforced with the approved
   * conservative counter (ADR-0001's counted bound) over the request the engine
   * actually composed — prompt, history, tool results and tool schemas included.
   * A request whose count cannot fit is refused outright, never an estimate that
   * is sent anyway; a provider tokenizer that still disagrees with the calibration
   * surfaces at settlement as `usage_over_token_max`, the after-the-fact floor the
   * counted bound allows. The count is taken BEFORE `admit`, so a request that
   * cannot be sent reserves nothing.
   */
  inputCeiling?: number;
  /**
   * May this step be spent? `maxOutputTokens`, when given, is the ceiling the step's
   * request must carry — the remaining output the step's admission covers — so the
   * provider can never generate past what was held for it.
   */
  admit: (
    stepIndex: number,
  ) => Promise<
    | { allowed: true; maxOutputTokens?: number }
    | { allowed: false; reason?: string }
  >;
  /** The step's own usage, as the provider reported it; missing counts stay unknown. */
  record: (step: EvaluationStepUsage) => void;
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

/**
 * Frozen fixtures are SafeValue trees; the tool loop must see the safe projected
 * value, not the projection envelopes. Omitted leaves become null (never their reason
 * or their withheld value), truncated leaves carry only the reviewed partial value,
 * and every nested envelope is unwrapped recursively. This is projection READING,
 * not a second redaction policy: only bytes the freeze retained can come out.
 */
function fixtureValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fixtureValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.state === "omitted") return null;
    if (
      (record.state === "projected" || record.state === "truncated") &&
      Object.hasOwn(record, "value")
    ) {
      return fixtureValue(record.value);
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [key, fixtureValue(child)]),
    );
  }
  return value;
}

/** The bounded refusal the public engine returns to the model as a tool error. */
class EvaluationToolRefusal extends Error {
  override name = "EvaluationToolRefusal";
  constructor(readonly reason: string) {
    super(`EVALUATION_TOOL_REFUSED: ${reason}`);
  }
}

/**
 * Declare exactly the frozen whitelist as this isolated case's tool surface. The
 * deployment catalogue supplies production descriptions and schemas where it knows a
 * name; an unresolved whitelisted name remains visible under a generic JSON-object
 * schema so the model can make the attempt and the gate can honestly refuse it as a
 * write/no-fixture call. Visibility never authorizes execution: every execute closure
 * still calls the gate, and only a replayed frozen fixture returns.
 */
function callableToolsFor(
  context: Parameters<EvaluationCaseRunner>[0],
): readonly EvaluationCallableTool[] {
  return (context.config.readOnlyTools ?? [])
    .filter((name) => name.state === "projected")
    .map((name) => {
      const surface: EvaluationToolSurface | undefined =
        context.resolveToolSurface?.(name.text);
      return {
        name: name.text,
        description:
          surface?.description ??
          `Frozen evaluation fixture for the ${name.text} tool.`,
        parameters: surface?.parameters ?? {
          type: "object",
          additionalProperties: true,
        },
        execute: async (_args: unknown) => {
          const call = await context.callTool(name.text);
          if (call.outcome === "refused") {
            throw new EvaluationToolRefusal(call.reason);
          }
          return fixtureValue(call.fixture);
        },
      };
    });
}

export function createProductionEvaluationCaseRunner(
  deps: Readonly<{
    callModel: EvaluationModelCall;
    admit?: ExecutionCaseBillingAdmission;
    observe?: EvaluationModelCallObserver;
    /**
     * The per-step budget of a tool loop (FREV-R2-01), lent to the call so every
     * provider request the loop makes is admitted before it is sent and recorded
     * after it finishes. Absent for a runner whose calls are single-shot.
     */
    stepBudget?: EvaluationStepBudget;
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
      const tools = callableToolsFor(context);
      const answer = await deps.callModel({
        modelName,
        modelParameters: recordOf(context.config.modelParameters),
        system,
        user,
        ...(tools.length === 0 ? {} : { tools }),
        ...(deps.stepBudget === undefined
          ? {}
          : { stepBudget: deps.stepBudget }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      // FREV-04: a tool the model invented is a call it made, and the gate is where
      // calls are judged — so every name the engine could not answer goes through it
      // too, and the refusal is counted on the execution's governance row. The gate's
      // own refusals can never fail a case (it answers, it does not throw); the catch
      // only holds the bypass doctrine's line that accounting cannot break a product
      // path.
      for (const unknown of answer.undeclaredToolCalls ?? []) {
        try {
          await context.callTool(unknown);
        } catch {
          // swallowed by contract: a counted refusal is never a case failure
        }
      }
      // FREV-R2-01: the loop stopped because an admission refused the next step
      // BEFORE it was dialed. That is the same refusal class as a case whose first
      // admission said no — the answer's output is a partial loop, not this case's
      // answer, and the steps that did run are settled by the billed layer's own
      // per-step records. The reason rides the span and the outcome verbatim.
      if (answer.budgetRefusal !== undefined) {
        const reason = answer.budgetRefusal.reason ?? "budget_refused";
        report({
          ...base,
          occurredAt: startedAt,
          endedAt: new Date(),
          ending: { kind: "refused", code: reason },
        });
        return { status: "failed", reason };
      }
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
 * The retained controlled gateway dial — a single chat-completions round trip (or the
 * bounded tool loop, `EVALUATION_TOOL_LOOP_MAX_STEPS`) on the OpenAI-compatible
 * gateway, time-bounded so a hung gateway cannot hold a worker's lease slot.
 *
 * It is no longer the evaluation CASE's execution (FREV-04): a case runs through the
 * Bot's own public execution entry — the builtin assembly and engine in
 * `execution-seam.ts` — so what is executed is production's, not a second semantics
 * written beside it. This dial remains for the judge's fallback entrance
 * (`createJudgeEntranceCall`) and for the runner-level contracts and their tests,
 * where a frozen prompt + input are all the call carries.
 *
 * The parameters are the frozen configuration's, with the handful of settings the
 * gateway understands mapped and everything else ignored rather than guessed at.
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

  return async ({
    modelName,
    modelParameters,
    system,
    user,
    tools,
    signal,
    stepBudget,
  }) => {
    const settings = gatewaySettings(modelParameters);
    // The call's own time bound and the task's cancellation are one signal
    // (FREV-05): whichever fires first ends the dial, so a cancelled task does
    // not wait out a budget nobody will use. Without a task signal the timeout
    // alone bounds the call, exactly as before. For a tool loop the same signal
    // bounds every step and the space between them — one budget for the case.
    const bound = AbortSignal.timeout(
      options.timeoutMs ?? GATEWAY_CALL_TIMEOUT_MS,
    );
    const declared = tools !== undefined && tools.length > 0 ? tools : null;
    // FREV-R2-01/R3-01: a case can spend several provider calls — up to
    // EVALUATION_TOOL_LOOP_MAX_STEPS here, and on the public seam even a blank tool
    // surface carries the engine's own state tools — so the budget the billed layer
    // lends is asked BEFORE EVERY request the dial makes, the toolless single call
    // included, and never gated on the business whitelist. Without a budget the
    // call keeps the pre-FREV-R2-01 shape: one admission, the case's total usage
    // settled in one fact.
    const budget = stepBudget;
    const { maxOutputTokens: configuredTokens, ...rest } = settings;
    // What already happened when a later step was refused: their usage is recorded
    // against their own admissions, and their invented tool names still go through
    // the gate — a refused loop must not lose the calls that were really made.
    const finished: {
      readonly text: string;
      readonly toolCalls: readonly { readonly toolName: string }[];
    }[] = [];
    let refusal: Readonly<{ step: number; reason?: string }> | undefined;
    // The step's output ceiling: the frozen configuration's own cap narrowed to what
    // the step's admission covers, so the provider can never generate past the hold.
    const outputCeiling = (admitted: number | undefined) => {
      const caps = [configuredTokens, admitted].filter(
        (one): one is number => one !== undefined,
      );
      return caps.length === 0 ? {} : { maxOutputTokens: Math.min(...caps) };
    };

    const answer = await generateText({
      model: openai().chat(modelName),
      system,
      prompt: user,
      abortSignal:
        signal === undefined ? bound : AbortSignal.any([bound, signal]),
      ...(declared === null
        ? {}
        : {
            tools: Object.fromEntries(
              declared.map((one) => [
                one.name,
                {
                  description: one.description,
                  inputSchema: jsonSchema(one.parameters),
                  execute: (args: unknown) => one.execute(args),
                },
              ]),
            ),
            stopWhen: stepCountIs(EVALUATION_TOOL_LOOP_MAX_STEPS),
          }),
      ...(budget === undefined
        ? {}
        : {
            // Asked before each step's provider request, awaited by the engine:
            // the refused step is never dialed, and the throw is turned into
            // the budgetRefusal answer below rather than a provider failure.
            // R3-01: the request's own input is counted FIRST, with the approved
            // conservative counter (ADR-0001) over exactly what this step will
            // send — the system, the messages the engine composed (history and
            // tool results included) and the declared tool schemas — and a count
            // that cannot fit the step's ceiling refuses BEFORE the step is
            // admitted or dialed: never an estimate that is sent anyway.
            prepareStep: async ({
              stepNumber,
              messages,
            }: {
              stepNumber: number;
              messages: readonly unknown[];
            }) => {
              if (
                budget.inputCeiling !== undefined &&
                countChatInputTokens({
                  system,
                  prompt: messages,
                  ...(declared === null
                    ? {}
                    : {
                        tools: declared.map((one) => ({
                          name: one.name,
                          description: one.description,
                          parameters: one.parameters,
                        })),
                      }),
                }) > budget.inputCeiling
              ) {
                refusal = {
                  step: stepNumber,
                  reason: EVALUATION_INPUT_OVER_LIMIT,
                };
                throw new StepBudgetRefusal();
              }
              const verdict = await budget.admit(stepNumber);
              if (!verdict.allowed) {
                refusal = {
                  step: stepNumber,
                  ...(verdict.reason === undefined
                    ? {}
                    : { reason: verdict.reason }),
                };
                throw new StepBudgetRefusal();
              }
              return outputCeiling(verdict.maxOutputTokens);
            },
            onStepFinish: (step: {
              readonly stepNumber: number;
              readonly text: string;
              readonly toolCalls: readonly {
                readonly toolName: string;
              }[];
              readonly usage: {
                readonly inputTokens?: number;
                readonly outputTokens?: number;
              };
            }) => {
              budget.record({
                index: step.stepNumber,
                inputTokens: step.usage.inputTokens,
                outputTokens: step.usage.outputTokens,
              });
              finished.push({
                text: step.text,
                toolCalls: step.toolCalls,
              });
            },
          }),
      // With a budget the output ceiling is a per-step decision — what that step's
      // admission covers, the policy's own ceiling when the frozen configuration
      // names none (R3-01); without one it is the frozen configuration's, exactly
      // as before, so the unbudgeted wire stays byte-identical.
      ...(budget === undefined
        ? settings
        : { ...rest, ...outputCeiling(undefined) }),
    }).catch((error: unknown) => {
      // A throw that is not the budget's own stop is the provider's failure and stays
      // one — the billed layer's unknown-cost doctrine is unchanged.
      if (refusal === undefined) throw error;
      return null;
    });
    if (answer === null) {
      // The refused step never reached the wire; the steps that did run are this
      // call's whole truth, and the runner answers the case as refused, not failed.
      const undeclared = undeclaredToolCalls(
        { steps: finished },
        declared ?? [],
      );
      return {
        output: finished.at(-1)?.text ?? "",
        ...(undeclared.length === 0 ? {} : { undeclaredToolCalls: undeclared }),
        budgetRefusal: refusal as Readonly<{ step: number; reason?: string }>,
      };
    }
    const undeclared = undeclaredToolCalls(answer, declared ?? []);
    return {
      output: answer.text,
      // A tool loop spends several provider calls; the case is settled against what
      // it actually consumed (the sum of every step), never the last step alone.
      inputTokens: answer.totalUsage.inputTokens ?? undefined,
      outputTokens: answer.totalUsage.outputTokens ?? undefined,
      // Reported for a case with no declared tools too: a model that invents a tool
      // made a call either way, and the gate is what judges it. Only when there is
      // something to report, so the single-call contract stays byte-identical.
      ...(undeclared.length === 0 ? {} : { undeclaredToolCalls: undeclared }),
    };
  };
}

/**
 * The loop's stop signal when the step budget refuses the next request (FREV-R2-01).
 * Thrown from `prepareStep`, which the engine awaits before every provider request, so
 * the refused step never reaches the wire. The gateway answers `budgetRefusal` rather
 * than an error: the steps that DID run were paid for, and their accounting must not
 * be reported as a provider failure.
 */
class StepBudgetRefusal extends Error {
  override name = "StepBudgetRefusal";
}

/**
 * The names the model reached for that the declared surface does not carry. The AI SDK
 * keeps such a call in the step as an unresolved (`dynamic`) tool call rather than
 * failing the step, which is exactly the fact this path needs: the attempt happened,
 * nothing executed it, and the evaluation gate — not the engine — decides what it was.
 */
function undeclaredToolCalls(
  result: {
    readonly steps: readonly {
      readonly toolCalls: readonly { readonly toolName: string }[];
    }[];
  },
  declared: readonly EvaluationCallableTool[],
): readonly string[] {
  const known = new Set(declared.map((one) => one.name));
  const names = new Set<string>();
  for (const step of result.steps) {
    for (const call of step.toolCalls) {
      if (!known.has(call.toolName)) names.add(call.toolName);
    }
  }
  return [...names].sort();
}

/**
 * Numbers the gateway settings vocabulary accepts; everything else is not forwarded.
 * The one vocabulary both dialing paths share: the seam maps it onto the classic
 * configuration's own fields, the retained gateway call writes it onto the wire.
 */
export function gatewaySettings(parameters: Record<string, unknown>) {
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
