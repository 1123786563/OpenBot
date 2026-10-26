/**
 * The public execution seam (FREV-04, the R2 close condition).
 *
 * THE DEFECT THIS CLOSES. The evaluation case runner used to dial the gateway with its
 * own `generateText` call — the same SDK, the same eight-step ceiling and the same
 * gateway, but a SECOND execution written beside the Bot's. The final review's R2
 * verdict named exactly that: "same 8 steps, same SDK, same gateway" is implementation
 * shape, not proof that an evaluation case runs with the semantics a production Bot
 * runs with. An evaluated answer is only representative when the thing producing it is
 * the Bot's own assembly and engine.
 *
 * WHAT IS SHARED, AND WHERE. This module drives one case through the production
 * builtin chain, read-only:
 *
 *  - `builtInAgentConfiguration` (copilot.ts) — the assembly production builds EVERY
 *    built-in Bot's run configuration with. The seam calls it with a synthetic,
 *    isolated agent: the frozen prompt is its system prompt, the frozen whitelist is
 *    its granted tools, and nothing else — no standing instructions, no computer, no
 *    connected vendors, no learned skills, no plan model, no governed admission. The
 *    composed prompt (the production guidance included), the tool mapping and the
 *    eight-step loop ceiling therefore come out of the production assembly itself;
 *    this module composes no prompt and defines no second ceiling.
 *  - `BuiltInAgentWithSaneHistory` (@openbot/toolkit/copilotkit/agents) — the exact
 *    class `agentFor` serves every builtin Bot through, whose `run(input)` is the
 *    AG-UI execution entry the CopilotKit runtime calls: streamText, the tool loop,
 *    the AG-UI event protocol, `abortRun()`. Host hooks are inert here (identity
 *    observation; no attachment inlining; no run scope) because a case has no host.
 *
 * WHAT IS DELIBERATELY NOT SHARED — the model INSTANCE. Production injects a
 * different model instance per admission shape (a plan-harness instance, a governed
 * gateway adapter, the transport model wrapped by the workbench billing meter), and
 * the evaluation's admission is its own: the billed layer reserves per case and per
 * step against the experiment's credit machinery (FREV-R2-01, one-credit-machinery —
 * never a second ledger). Riding the transport model would also ride the in-process
 * workbench gate, admitting and metering every case step a second time against a
 * person's balance. So the seam builds the same gateway instance production builds
 * (the deployment dial, `createOpenAI(...).chat(frozenModel)`) and wraps it with the
 * step budget at the SAME enforcement point production uses for its own admission —
 * the model wrapper (production's `meteredModel` is that seam today).
 *
 * WHAT A CASE CANNOT REACH. The isolated thread lives only in this call (`threadId` is
 * minted here and stored nowhere); there is no thread store, no memory, no session, no
 * attachment, no business-data handle on this path. Tools execute ONLY through the
 * gate-wired closures the runner handed over — a frozen fixture replays or the call is
 * refused. The two AG-UI state tools the engine always declares are part of the public
 * surface; they are inert (`{success: true}` echo, no state is persisted anywhere) and
 * never route through the gate, so they are not counted as undeclared calls.
 *
 * ADMISSION, BUDGET AND CANCELLATION (F5C1 / FREV-R2-01) hold unchanged: `stepBudget`
 * is asked before EVERY provider request the engine dials (a refused step is never
 * sent — the inner model is never reached), each finished step's own usage is
 * recorded against the hold that admitted it, the admitted output ceiling narrows
 * the request on the wire, and the task's cancellation reaches the engine's own
 * abort (`abortRun()`), so the runner's existing classification (cancelled vs
 * provider_error) is the same one it always applied. R3-01 closes the two gaps that
 * left: the wrapper is installed for a BLANK tool surface too — the engine's own
 * state tools ride every request, so no business whitelist decides whether a dial is
 * budgeted — and the input the engine actually composed is counted with the approved
 * conservative bound (ADR-0001) BEFORE the dial, refused outright when it cannot fit
 * the policy's input ceiling instead of being sent for the provider to reject.
 *
 * OWNERSHIP. The module belongs to ai-observability (the evaluation assembly's own
 * surface) and references copilot/toolkit read-only — nothing in the production chat
 * path changes for it. The consistency proof is a test, not a comment: the wire a case
 * actually sends is asserted byte-for-byte against the configuration the production
 * assembly function builds for the same frozen inputs (opik-execution-seam.test.ts).
 */
import { randomUUID } from "node:crypto";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { EventType, PROTOCOL_VERSION } from "@ag-ui/client";
import { createOpenAI } from "@ai-sdk/openai";
import type { BuiltInAgentClassicConfig } from "@copilotkit/runtime/v2";
import { BuiltInAgentWithSaneHistory } from "@openbot/toolkit/copilotkit/agents";
import { type GrantedTool, parametersFor } from "@openbot/toolkit/granted-tool";
import { countChatInputTokens } from "../billing/input-bound";
import {
  builtInAgentConfiguration,
  type RegisteredBuiltInAgent,
  type RuntimeModel,
  type WorkbenchGatewayModelDial,
} from "../copilot";
import {
  EVALUATION_INPUT_OVER_LIMIT,
  type EvaluationCallableTool,
  type EvaluationModelCall,
  type EvaluationStepBudget,
  GATEWAY_CALL_TIMEOUT_MS,
  gatewaySettings,
} from "./execution-runner";

/** The synthetic agent id a case is assembled under. Never a production Bot's id. */
export const EVALUATION_SEAM_AGENT_ID = "opik-evaluation-case";

/** Every case thread id starts here; the rest is a fresh uuid, stored nowhere. */
export const EVALUATION_SEAM_THREAD_PREFIX = "opik-evaluation-";

/**
 * The tools the engine declares on EVERY classic run (the CopilotKit runtime installs
 * them unconditionally): the public surface includes them, they execute in-engine and
 * are inert, so they are never reported as undeclared calls and never reach the gate.
 */
export const EVALUATION_SEAM_STATE_TOOL_NAMES = [
  "AGUISendStateSnapshot",
  "AGUISendStateDelta",
] as const;

export type PublicExecutionSeamOptions = Readonly<{
  /** The gateway credential; absent falls to OPENAI_API_KEY (the stock deployment shape). */
  apiKey?: string;
  /** The OpenAI-compatible gateway base URL; absent falls to OPENAI_BASE_URL. */
  baseURL?: string;
  /** The whole case's dial budget (the runner's own bound, not per step). */
  timeoutMs?: number;
}>;

/** One case's assembly inputs — isolated facts only, nothing a production run carries. */
export type SeamCaseAssemblyInput = Readonly<{
  modelName: string;
  /** The frozen prompt, already projection-checked by the runner. */
  system: string;
  /** The gate-wired surface, already mapped by the runner. */
  tools: readonly EvaluationCallableTool[];
  dial: WorkbenchGatewayModelDial;
}>;

/** A fresh isolated thread id: the thread exists for this call and nowhere else. */
export function isolatedEvaluationThreadId(): string {
  return `${EVALUATION_SEAM_THREAD_PREFIX}${randomUUID()}`;
}

const seamAgent = (system: string): RegisteredBuiltInAgent => ({
  id: EVALUATION_SEAM_AGENT_ID,
  name: "OpenBot evaluation case",
  type: "built_in",
  systemPrompt: system,
});

/**
 * The gate-wired surface as the assembly takes it. `parametersFor` is the production
 * adapter (a granted tool is handed to the runtime as a zod schema); `ref` is the grant
 * spelling, carried for the type and unused by the composition; `execute` is the
 * runner's own gate closure, cast to the runtime's declared string-product shape — the
 * value the gate answers with is a frozen fixture, any JSON value.
 */
function grantedToolsFor(
  tools: readonly EvaluationCallableTool[],
): GrantedTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: parametersFor(tool.parameters),
    execute: (args: unknown): Promise<string> =>
      tool.execute(args) as Promise<string>,
    ref: tool.name,
  }));
}

/**
 * The production assembly's own answer for one isolated case. Exported so the
 * consistency test can hold the wire against it; production's function does all the
 * composing — this call supplies isolation (absent memory/computer/vendors/standing)
 * and the frozen facts, never a second composition.
 */
export function evaluationCaseConfiguration(
  input: SeamCaseAssemblyInput,
): ReturnType<typeof builtInAgentConfiguration> {
  return builtInAgentConfiguration(
    seamAgent(input.system),
    {
      provider: "openai",
      defaultModel: input.modelName,
    } satisfies RuntimeModel,
    input.dial.apiKey ?? "",
    grantedToolsFor(input.tools),
    // The whole point of the isolation: every production-per-run input is ABSENT.
    undefined, // computer guidance — a case has no browser
    [], // connected vendors — a case holds no connectors
    undefined, // standing instructions — no person's memory rides a case
    undefined, // plan model — no subscription harness
    undefined, // learned skills — nothing acquired outside the freeze
    undefined, // governed admission — the evaluation bills through its own seam
    undefined, // attribution — no person, no Bot
    input.dial, // the deployment's gateway transport
  );
}

/**
 * The budget's own stop: the refused step's stream fails on first read, so the step's
 * provider request is never dialed and the engine carries the refusal out as its own
 * error part.
 */
class SeamBudgetRefusal extends Error {
  override name = "EvaluationSeamBudgetRefusal";
  constructor(readonly step: number) {
    super("EVALUATION_SEAM_BUDGET_REFUSED");
  }
}

/** The slice of a LanguageModelV3 this seam drives (streaming is the engine's dial). */
type StreamingModel = Readonly<Record<string, unknown>> & {
  doStream: (params: ModelStreamRequest) => Promise<
    Readonly<Record<string, unknown>> & {
      stream: ReadableStream<ModelStreamPart>;
    }
  >;
};

type ModelStreamRequest = Readonly<Record<string, unknown>> & {
  maxOutputTokens?: unknown;
};

type ModelStreamPart = Readonly<Record<string, unknown>> & {
  type?: unknown;
  usage?: {
    inputTokens?: { total?: number };
    outputTokens?: { total?: number };
  };
};

/**
 * The step-budget enforcement point, the same one production uses for its own
 * admission (the metered model wrapper): BEFORE every provider request the engine
 * dials, the request's own input is counted against the step's enforced ceiling and
 * a count that cannot fit is refused without the inner model ever being reached
 * (R3-01 — never an estimate that is sent anyway); the step is then admitted, and a
 * refusal fails the same way; the admitted ceiling narrows `maxOutputTokens` on the
 * request; each finished response's own usage is recorded against the hold that
 * admitted it. The stream itself is re-emitted untouched — settlement is the billed
 * layer's, never this wrapper's.
 */
function stepBudgetedModel(
  inner: StreamingModel,
  budget: EvaluationStepBudget,
  hooks: Readonly<{
    /** Filled just before the wrapper throws, so the seam answers a refusal as one. */
    onRefusal: (refusal: Readonly<{ step: number; reason?: string }>) => void;
  }>,
): StreamingModel {
  let step = 0;
  const refused = (index: number, reason?: string) => {
    hooks.onRefusal({
      step: index,
      ...(reason === undefined ? {} : { reason }),
    });
    // The refused step is never dialed — but the refusal is a stream that fails on
    // first read, not a rejected model promise: the engine's pipeline converts the
    // former into its own error part (the same path a cut provider stream takes),
    // while a thrown rejection is reported unhandled by the runtime before the
    // pipeline's catch reaches it. The seam answers the error part as a refusal.
    const refusal = new SeamBudgetRefusal(index);
    return {
      stream: new ReadableStream<ModelStreamPart>({
        start(controller) {
          controller.error(refusal);
        },
      }),
    };
  };
  return {
    ...inner,
    async doStream(params: ModelStreamRequest) {
      const index = step;
      step += 1;
      // R3-01: the request the engine actually composed — prompt, history, tool
      // results and the engine's own state-tool schemas — is counted with the
      // approved conservative counter (ADR-0001) and refused outright when it
      // cannot fit the policy's input ceiling, BEFORE the step is admitted
      // (nothing is reserved for a request that will never be sent) and before
      // the inner model is reached.
      if (
        budget.inputCeiling !== undefined &&
        countChatInputTokens(params) > budget.inputCeiling
      ) {
        return refused(index, EVALUATION_INPUT_OVER_LIMIT);
      }
      const verdict = await budget.admit(index);
      if (!verdict.allowed) {
        return refused(index, verdict.reason);
      }
      const requested =
        typeof params.maxOutputTokens === "number"
          ? params.maxOutputTokens
          : undefined;
      const caps = [requested, verdict.maxOutputTokens].filter(
        (one): one is number => one !== undefined,
      );
      const request: ModelStreamRequest =
        caps.length === 0
          ? params
          : { ...params, maxOutputTokens: Math.min(...caps) };
      const result = await inner.doStream(request);
      const reader = result.stream.getReader();
      const stream = new ReadableStream<ModelStreamPart>({
        async pull(controller) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (error) {
            reader.releaseLock();
            controller.error(error);
            return;
          }
          if (chunk.done) {
            reader.releaseLock();
            controller.close();
            return;
          }
          const part = chunk.value;
          if (part?.type === "finish") {
            const inputTokens = part.usage?.inputTokens?.total;
            const outputTokens = part.usage?.outputTokens?.total;
            budget.record({
              index,
              ...(inputTokens === undefined ? {} : { inputTokens }),
              ...(outputTokens === undefined ? {} : { outputTokens }),
            });
          }
          controller.enqueue(part);
        },
      });
      return { ...result, stream };
    },
  };
}

/** What one engine run produced: the events it emitted, and how it ended, if it failed. */
type SeamRun = Readonly<{ events: readonly BaseEvent[]; failure?: unknown }>;

/**
 * Drive the engine's observable to completion. Events are kept as they arrive (an
 * aborted or failed run still holds the steps it really took), and the run's own
 * cancellation is wired to the engine's abort — the only stop the public entry has.
 */
function collectRun(
  agent: BuiltInAgentWithSaneHistory,
  input: RunAgentInput,
  stop: AbortSignal,
): Promise<SeamRun> {
  return new Promise<SeamRun>((resolve) => {
    const events: BaseEvent[] = [];
    const abort = () => agent.abortRun();
    stop.addEventListener("abort", abort, { once: true });
    const settle = (run: SeamRun) => {
      stop.removeEventListener("abort", abort);
      resolve(run);
    };
    agent.run(input).subscribe({
      next: (event) => events.push(event),
      error: (failure: unknown) => settle({ events, failure }),
      complete: () => settle({ events }),
    });
    // An `abort` listener never fires for a signal that was already aborted, and a
    // case can reach this point with its bound spent (the runner's own check sits a
    // race window before): ask directly, so no already-aborted case keeps a dial open.
    if (stop.aborted) agent.abortRun();
  });
}

/**
 * The answer the model gave: the text it emitted after its last tool interaction.
 * Text before and across tool calls is the loop's narration, not the case's answer —
 * the same final-step reading `generateText().text` gave the pre-seam runner.
 */
function answerTextOf(events: readonly BaseEvent[]): string {
  let answer: string[] = [];
  for (const event of events) {
    // The protocol's delta event: CONTENT is what the installed runtime emits, CHUNK
    // the older spelling — both are matched so a runtime bump cannot mute an answer.
    if (
      event.type === EventType.TEXT_MESSAGE_CONTENT ||
      event.type === EventType.TEXT_MESSAGE_CHUNK
    ) {
      const delta = (event as { delta?: unknown }).delta;
      if (typeof delta === "string") answer.push(delta);
    } else if (event.type === EventType.TOOL_CALL_RESULT) {
      answer = [];
    }
  }
  return answer.join("");
}

/** Distinct tool names the model reached for that the declared surface does not carry. */
function undeclaredToolCallsFrom(
  events: readonly BaseEvent[],
  declared: readonly EvaluationCallableTool[],
): string[] {
  const known = new Set<string>([
    ...declared.map((one) => one.name),
    ...EVALUATION_SEAM_STATE_TOOL_NAMES,
  ]);
  const names = new Set<string>();
  for (const event of events) {
    if (event.type !== EventType.TOOL_CALL_START) continue;
    const name = (event as { toolCallName?: unknown }).toolCallName;
    if (typeof name === "string" && !known.has(name)) names.add(name);
  }
  return [...names].sort();
}

/** The run's settled usage, summed across its entries; absent counts stay absent. */
function usageOf(terminal: BaseEvent): {
  inputTokens?: number;
  outputTokens?: number;
} {
  const entries =
    (terminal as { usage?: readonly Record<string, unknown>[] }).usage ?? [];
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  for (const entry of entries) {
    if (typeof entry.inputTokens === "number")
      inputTokens = (inputTokens ?? 0) + entry.inputTokens;
    if (typeof entry.outputTokens === "number")
      outputTokens = (outputTokens ?? 0) + entry.outputTokens;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

/**
 * The production evaluation model call, through the public execution seam. The
 * runner's contract (`EvaluationModelCall`) is unchanged on purpose: the budget,
 * cancellation, observation and settlement wiring around it all stay exactly where
 * they were, and only the thing actually executing the case moved onto the Bot's own
 * assembly and engine.
 */
export function createPublicExecutionSeamModelCall(
  options: PublicExecutionSeamOptions = {},
): EvaluationModelCall {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? null;
  const baseURL = options.baseURL ?? process.env.OPENAI_BASE_URL ?? null;

  return async ({
    modelName,
    modelParameters,
    system,
    user,
    tools,
    signal,
    stepBudget,
  }) => {
    const dial: WorkbenchGatewayModelDial = {
      baseURL: baseURL ?? "",
      apiKey,
    };
    const declared = tools ?? [];
    const assembly = evaluationCaseConfiguration({
      modelName,
      system,
      tools: declared,
      dial,
    });
    // The assembly REFUSES a credential-less build the way it refuses a production
    // run (the same fail-closed guard): there is no provider-direct branch behind it.
    if (!("model" in assembly)) {
      throw new Error("EVALUATION_SEAM_MODEL_CREDENTIAL_UNAVAILABLE");
    }
    const classic = assembly as BuiltInAgentClassicConfig;

    // The admission-carrying model on the same deployment dial production builds the
    // Bot's transport model from. Budget enforcement rides the wrapper (production's
    // own point) for EVERY case the billed layer lends a budget to — the blank tool
    // surface included (R3-01): whether a case can multi-step is not a
    // business-whitelist fact, because the engine declares its two AG-UI state tools
    // on every request, and every doStream the engine ever dials must be admitted,
    // input-bounded and output-capped. Filled by the wrapper just before it throws,
    // so a step refusal is answered as a refusal even if the engine wraps the error
    // on its way out.
    let refusal: Readonly<{ step: number; reason?: string }> | undefined;
    const gatewayModel = createOpenAI({
      apiKey: apiKey ?? undefined,
      baseURL: baseURL ?? undefined,
    }).chat(modelName) as unknown as StreamingModel;
    const admitted =
      stepBudget === undefined
        ? gatewayModel
        : stepBudgetedModel(gatewayModel, stepBudget, {
            onRefusal: (refused) => {
              refusal = refused;
            },
          });

    // The frozen parameter vocabulary, in the classic configuration's own fields —
    // the same numbers the pre-seam dial wrote onto the wire.
    const settings = gatewaySettings(modelParameters);
    const { maxOutputTokens, ...rest } = settings;
    const configuration: BuiltInAgentClassicConfig = {
      ...classic,
      model: admitted as unknown as BuiltInAgentClassicConfig["model"],
      ...(rest.temperature === undefined
        ? {}
        : { temperature: rest.temperature }),
      ...(rest.topP === undefined ? {} : { topP: rest.topP }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    };

    const bound = AbortSignal.timeout(
      options.timeoutMs ?? GATEWAY_CALL_TIMEOUT_MS,
    );
    const stop =
      signal === undefined ? bound : AbortSignal.any([bound, signal]);
    const agent = new BuiltInAgentWithSaneHistory(configuration, {
      // A case has no host: no attachment inlining, no stall watching, no run scope.
      observe: (run) => run,
    });
    // The isolated thread: minted here, stored nowhere, carried on nothing but the run.
    const input: RunAgentInput = {
      threadId: isolatedEvaluationThreadId(),
      runId: randomUUID(),
      messages: [{ id: randomUUID(), role: "user", content: user }],
      tools: [],
      context: [],
      protocolVersion: PROTOCOL_VERSION,
    };
    const run = await collectRun(agent, input, stop);

    if (run.failure !== undefined) {
      // A refused step never reached the wire; the steps that DID run are this case's
      // whole truth, and the runner answers the case as refused, not failed.
      if (refusal !== undefined) {
        const undeclared = undeclaredToolCallsFrom(run.events, declared);
        return {
          output: answerTextOf(run.events),
          ...(undeclared.length === 0
            ? {}
            : { undeclaredToolCalls: undeclared }),
          budgetRefusal: refusal,
        };
      }
      throw run.failure;
    }

    // The engine stops silently when aborted (its completion IS the stop): the runner
    // classifies by the task's own signal — a cancellation stays a cancellation, and
    // the seam's own time bound a provider failure — so the signal is all that is said.
    // A stop that races a normal finish is the finish (OCR R5-537): only the task's own
    // cancellation signal turns a stopped run into an aborted one — the seam's bare time
    // bound alone would misfile a case that actually completed.
    if (stop.aborted && signal?.aborted === true) {
      throw new Error("EVALUATION_SEAM_RUN_ABORTED");
    }

    const terminal = run.events.find(
      (event) => event.type === EventType.RUN_FINISHED,
    );
    if (terminal === undefined) {
      // The engine emits a terminal on every non-aborted completion; anything else is
      // an ending nobody can attest, answered as a failure rather than an empty answer.
      throw new Error("EVALUATION_SEAM_NO_TERMINAL");
    }
    const outcome = (terminal as { outcome?: { type?: unknown } }).outcome;
    if (outcome !== undefined && outcome.type !== "success") {
      throw new Error(
        `EVALUATION_SEAM_OUTCOME_${String(outcome.type).toUpperCase()}`,
      );
    }

    const usage = usageOf(terminal);
    const undeclared = undeclaredToolCallsFrom(run.events, declared);
    return {
      output: answerTextOf(run.events),
      ...usage,
      ...(undeclared.length === 0 ? {} : { undeclaredToolCalls: undeclared }),
    };
  };
}

/**
 * Test-only surface for the assembly-consistency proof (the `…ForTests` precedent):
 * the exact assembly function a case is built with, the engine class it is executed
 * on, and the isolated-thread mint — so a test can hold the wire against production's
 * own `builtInAgentConfiguration` output instead of a restatement of it.
 */
export const publicExecutionSeamForTests = {
  assemblyFor: evaluationCaseConfiguration,
  engineClass: BuiltInAgentWithSaneHistory,
  threadId: isolatedEvaluationThreadId,
};
