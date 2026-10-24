/**
 * The production evaluation case runner (Issue #30 / DAG T24, FREV-04).
 *
 * One case is one ADMITTED, ISOLATED, TOOL-CAPABLE model execution on the engine shape
 * production runs: the frozen prompt as the system message, the frozen case input as
 * the user message, and — when the experiment froze any — the tool surface (exactly
 * the whitelisted names, nothing else) declared to the model in a bounded multi-step
 * loop (`EVALUATION_TOOL_LOOP_MAX_STEPS`, the same 8 the
 * built-in path has run since it gained tools). The loop's conversation is the case's
 * own: system, input and whatever the engine appended for tool results, held for the
 * case and thrown away with it. There is no thread store, no session and no memory
 * handle on this path — the isolation is that the thread exists nowhere else, not
 * that a production conversation was borrowed and hoped to stay empty.
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
 *    loop: a case is one billed unit, and the engine's steps run under the one
 *    reservation the settlement chain prices the case's total usage against.
 *  - `observe` carries each call through the T14/T15 model-span channel: the
 *    same recorder the built-in path uses, so evaluation calls are observable in
 *    exactly the place production calls are. The observation bypass rules hold —
 *    an observer that throws is swallowed, never a reason a case fails.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, stepCountIs } from "ai";
import type { SafeText, SafeValue } from "../../../shared/ai-observability";
import type { EvaluationCaseRunner, EvaluationToolSurface } from "./executions";
import type { ModelSpanObservation } from "./model-span";

/**
 * The model tool-loop cap for one evaluation case: the SAME 8 the built-in path has
 * run since it gained tools (`TOOL_STEPS` in copilot.ts; `TOOL_LOOP_MAX_STEPS` on the
 * Mastra path). An evaluation case is one bounded execution of the same shape, so its
 * loop is held to the same ceiling — a cut at the cap is a real outcome the case
 * reports honestly, never a loop allowed to run until the clock runs out.
 */
export const EVALUATION_TOOL_LOOP_MAX_STEPS = 8;

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
        signal: context.signal,
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
 * `OPENAI_BASE_URL`) — the same engine, with the same tool-loop ceiling, when the
 * case declares a tool surface (FREV-04). Time-bounded so a hung gateway cannot hold
 * a worker's lease slot; the bound covers the WHOLE tool loop, not each step, so a
 * case still costs at most one gateway budget and the worker lease's arithmetic
 * (execution-boot.ts) keeps its meaning. The parameters are the frozen
 * configuration's, with the handful of settings the gateway understands mapped and
 * everything else ignored rather than guessed at.
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
    const result = await generateText({
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
      ...settings,
    });
    const undeclared = undeclaredToolCalls(result, declared ?? []);
    return {
      output: result.text,
      // A tool loop spends several provider calls; the case is settled against what
      // it actually consumed (the sum of every step), never the last step alone.
      inputTokens: result.totalUsage.inputTokens ?? undefined,
      outputTokens: result.totalUsage.outputTokens ?? undefined,
      // Reported for a case with no declared tools too: a model that invents a tool
      // made a call either way, and the gate is what judges it. Only when there is
      // something to report, so the single-call contract stays byte-identical.
      ...(undeclared.length === 0 ? {} : { undeclaredToolCalls: undeclared }),
    };
  };
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
