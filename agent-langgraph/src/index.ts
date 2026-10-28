/*
 * F9A / F8D-1: the tracing registration must run BEFORE the framework and provider modules
 * below evaluate — the OpenTelemetry API's global slots (provider, context manager, W3C
 * propagator) refuse a second registration, so the first module to touch them wins for the
 * process's whole life. Keeping this import first is the controlled initialisation order;
 * see ./tracing.ts for the mechanism and the history.
 */
import "./tracing";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { ChatAnthropic } from "@langchain/anthropic";
import {
  type AIMessage,
  type BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { context, trace } from "@opentelemetry/api";
import { serve } from "bun";
import { hasManagedAgentToken } from "../../shared/agent-authorisation";
import { listenPort } from "../../shared/listen-port";
import {
  apiKeyOrPlaceholder,
  baseUrlVariableFor,
  botSettings,
  keyIsRequired,
  keyVariableFor,
  requiresResponsesApi,
} from "../../shared/model-providers";
import { injectTraceHeaders, withTraceFetch } from "../../shared/trace";
import {
  type BudgetContract,
  BudgetContractInvalidError,
  budgetReceiptEvent,
  RunBudgetLedger,
  readBudgetContract,
} from "./budget";
import {
  GovernedCallbackHandler,
  governedRunSpan,
  traceDeploymentToolCall,
} from "./governed-tracing";
import { toLangChainMessages } from "./history";
import { readReasoningEffort } from "./model-options";
import { streamRun } from "./stream";
import { toolAnswer } from "./tool-answer";

/**
 * The same Bot, on a framework.
 *
 * `agent-bot` is a proof of concept written against a model SDK; this process uses framework integrations while
 * keeping the same AG-UI endpoint contract.
 *
 * A Bot is a registry row pointing at an AG-UI endpoint, so adding a framework does not require
 * server changes.
 *
 * The model API stops being ours. `agent-bot` speaks `/v1/chat/completions` by hand, which is why
 * gpt-5.6 costs it a rewritten streaming loop: those models reject function tools on that endpoint
 * unless reasoning is turned off, and turning reasoning off on a Bot that has to decide when to ask
 * a person for help is the wrong trade. Here it is `useResponsesApi`, one line, because the
 * migration belongs to the people who maintain the integration.
 *
 * The tool loop still runs on the client, exactly as it does in `agent-bot`: a Bot's actions happen
 * on a browser the person is watching, and the surface remains the place that executes those tools.
 * The graph provides model orchestration without changing that contract.
 */

const resolvedPort = listenPort(process.env.PORT, 4201);
if (!resolvedPort.ok) {
  console.error(resolvedPort.reason);
  process.exit(1);
}
const PORT = resolvedPort.port;
// Coalesced to "" rather than left optional: the guard below refuses to start without it, and a
// plain `string` keeps that fact usable from closures (narrowing does not cross a function body).
const MANAGED_AGENT_TOKEN = process.env.MANAGED_AGENT_TOKEN?.trim() ?? "";
if (MANAGED_AGENT_TOKEN === "") {
  console.error(
    "MANAGED_AGENT_TOKEN is not set. This process holds a model credential and will not start without a token for OpenBot's server.",
  );
  process.exit(1);
}

/**
 * Which model drives this Bot, and from whom.
 *
 * The framework integration owns provider-specific HTTP and streaming details. The proof-of-concept Bot
 * speaks one provider's HTTP API
 * directly, so changing provider there means rewriting its streaming loop and its message
 * translation. Here it is a name and a key, because the integrations already exist and are
 * maintained by the people whose API it is.
 *
 * Each provider reads its own key. A deployment that only runs Anthropic never needs an OpenAI key,
 * which is the point of making this configurable rather than assuming one vendor.
 *
 * The default comes from `shared/model-providers.json` — this Bot's `bots.agent-langgraph` row —
 * so the two shipped Bots stay comparable out of the box and every language in the box reads the
 * same decision. Which variable each provider's key and endpoint arrive in is read from the same
 * file's provider rows rather than repeated here.
 *
 * Blank is OpenAI, the reading every other consumer of `BOT_PROVIDER` gives it: the desktop writes
 * an empty provider when switching back to OpenAI, and the server reads empty as OpenAI. An unset
 * environment falls through to the spec row, and when that says openai — as it does today — the
 * two readings are the same. Padded and differently-cased names are the same provider, because a
 * value typed into a setup window arrives with a space on it more often than not. A name nobody
 * has heard of is kept, so the check below can put it in its message. The lookup order is
 * environment over spec file over provider default; see `botSettings`.
 */
const { provider: PROVIDER, model: MODEL } = botSettings("agent-langgraph");
/**
 * OpenAI only. Its newer models require the Responses API, which the integration handles.
 *
 * Inferred from the model rather than left to a separate switch. `gpt-5.6-*` rejects function tools
 * on `/v1/chat/completions`, so a deployment that set `BOT_MODEL` to one and did not also know about
 * this flag got a Bot that started, looked healthy, and failed on its first tool call. The switch is
 * still honoured, so a model the registry has not heard of can be told to use it.
 */
const NEEDS_RESPONSES_API = requiresResponsesApi(MODEL);
const USE_RESPONSES_API =
  process.env.BOT_RESPONSES_API === "true" || NEEDS_RESPONSES_API;
/**
 * Read from the provider registry rather than spelled out here three times, under the names the
 * API server already reads. Sharing the names is the point: one line moves the built-in agents and
 * this Bot together, and a deployment cannot end up with half of itself pointed somewhere else.
 *
 * Unset, this is that provider's own public endpoint. Set, it means any endpoint speaking that API:
 * a gateway in front of several providers, a proxy, or a model on hardware you control. The
 * integration owns the HTTP, so this is a base URL rather than another provider branch, and
 * `BOT_MODEL` is sent verbatim because an endpoint names its own catalogue.
 *
 * Only the provider this Bot was configured for is read, and each branch of `buildModel` below
 * ever took its own and no other, so nothing that used to be visible has changed.
 */
const baseUrlVariable = baseUrlVariableFor(PROVIDER);
const BASE_URL = baseUrlVariable
  ? process.env[baseUrlVariable]?.trim() || undefined
  : undefined;

/**
 * OpenAI only, and Responses API only: how hard this Bot is allowed to think.
 *
 * Checked here rather than sent onward and forgotten. An effort the API does not have is dropped
 * somewhere down the stack, and a Bot that starts, looks healthy and then thinks for as long as it
 * likes is a worse outcome than one that refuses to start and says why.
 */
const { effort: REASONING_EFFORT, problem: REASONING_PROBLEM } =
  readReasoningEffort(process.env.BOT_REASONING_EFFORT);
if (REASONING_PROBLEM) {
  console.error(REASONING_PROBLEM);
  process.exit(1);
}
/*
 * The two ways this setting would reach an API with nowhere to put it.
 *
 * Anthropic and Google express thinking budgets differently, and on `/v1/chat/completions` the
 * field does not exist at all. Refusing is the same call the issue makes about invalid values:
 * configuration that goes nowhere is worse than configuration that is absent, because the Bot looks
 * configured either way. Both messages name the variable that would make it work.
 */
if (REASONING_EFFORT && PROVIDER !== "openai") {
  console.error(
    `BOT_REASONING_EFFORT is OpenAI's setting, and BOT_PROVIDER=${PROVIDER}. Unset it, or set BOT_PROVIDER=openai.`,
  );
  process.exit(1);
}
if (REASONING_EFFORT && !USE_RESPONSES_API) {
  console.error(
    `BOT_REASONING_EFFORT needs the Responses API, and BOT_MODEL=${MODEL} is not being run on it. Use a model that requires it, or set BOT_RESPONSES_API=true.`,
  );
  process.exit(1);
}

/**
 * The key this provider needs, checked at startup rather than on the first run.
 *
 * Refusing to start matches the computer-token posture:
 * a missing key should fail in front of whoever is deploying, not as a conversation that errors in
 * front of somebody trying to use it.
 */
const keyVariable = keyVariableFor(PROVIDER);
if (!keyVariable) {
  console.error(
    `BOT_PROVIDER=${PROVIDER} is not one this Bot knows. Use openai, anthropic or google.`,
  );
  process.exit(1);
}
const API_KEY = process.env[keyVariable]?.trim();
// Unless an endpoint was named to answer instead: see `keyIsRequired`.
if (!API_KEY && keyIsRequired(PROVIDER, BASE_URL)) {
  console.error(
    `${keyVariable} is not set, and BOT_PROVIDER=${PROVIDER} needs it. This Bot cannot answer without a model.`,
  );
  process.exit(1);
}

/**
 * Every tool comes from the caller. This service publishes none of its own, on purpose.
 *
 * Same rule as `agent-bot`: a new capability on the front end needs no change here.
 */
function toBoundTools(input: RunAgentInput) {
  if (!input.tools?.length) return [];
  return input.tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  }));
}

/**
 * The chat model, from whichever provider this deployment chose.
 *
 * Every one of these binds tools the same way and streams the same way, which is exactly why the
 * rest of this file does not know which one it got.
 *
 * `maxOutputTokens` is the run's remaining output budget (R3-02), clamped to the model's
 * output ceiling before the provider enforces it: each provider's
 * own knob for "stop after this many completion tokens" (`maxTokens` on OpenAI and Anthropic,
 * `maxOutputTokens` on Google). Absent means an unbudgeted run — a caller that sent no contract —
 * and the provider's own default applies, exactly as before the contract existed.
 */
// Conservative ceilings for configured models; unknown models and compatible gateways use
// 8,192 until their output limit is confirmed. A smaller cap still fits the budget contract.
const MODEL_OUTPUT_CEILINGS: Record<string, number> = {
  "claude-sonnet-4-5": 64_000,
  "gemini-2.5-flash": 65_536,
  "gpt-4.1": 32_768,
  "gpt-4.1-mini": 32_768,
};
const UNKNOWN_MODEL_OUTPUT_CEILING = 8_192;

function buildModel(maxOutputTokens?: number) {
  const cappedOutputTokens =
    maxOutputTokens === undefined
      ? undefined
      : Math.min(
          maxOutputTokens,
          MODEL_OUTPUT_CEILINGS[MODEL] ?? UNKNOWN_MODEL_OUTPUT_CEILING,
        );
  if (PROVIDER === "anthropic") {
    return new ChatAnthropic({
      model: MODEL,
      apiKey: apiKeyOrPlaceholder(API_KEY),
      streaming: true,
      ...(BASE_URL ? { anthropicApiUrl: BASE_URL } : {}),
      ...(cappedOutputTokens === undefined
        ? {}
        : { maxTokens: cappedOutputTokens }),
    });
  }
  if (PROVIDER === "google") {
    return new ChatGoogleGenerativeAI({
      model: MODEL,
      apiKey: apiKeyOrPlaceholder(API_KEY),
      streaming: true,
      ...(BASE_URL ? { baseUrl: BASE_URL } : {}),
      ...(cappedOutputTokens === undefined
        ? {}
        : { maxOutputTokens: cappedOutputTokens }),
    });
  }
  return new ChatOpenAI({
    model: MODEL,
    apiKey: apiKeyOrPlaceholder(API_KEY),
    streaming: true,
    ...(BASE_URL ? { configuration: { baseURL: BASE_URL } } : {}),
    ...(USE_RESPONSES_API ? { useResponsesApi: true } : {}),
    ...(cappedOutputTokens === undefined
      ? {}
      : { maxTokens: cappedOutputTokens }),
    /*
     * `reasoning.effort`, not the `reasoningEffort` convenience field: the integration deprecated
     * the latter in favour of merging it into this object, and one of them is the one that survives.
     */
    ...(REASONING_EFFORT ? { reasoning: { effort: REASONING_EFFORT } } : {}),
  });
}

/**
 * Where this Bot runs a tool.
 *
 * Not the vendor: this deployment. A Bot that called an MCP server directly would be a Bot that
 * walked around the grant, the policy and the audit row, and those are the product. So the loop runs
 * here, in this process, and every call it makes goes back through the deployment that granted it.
 */
const TOOL_URL =
  // Numeric, never `localhost`: it resolves to `::1` under Node and `127.0.0.1` under bun, so a
  // name here reaches a different interface depending on what started the process.
  process.env.OPENBOT_TOOL_URL ?? "http://127.0.0.1:3001/api/agent-tools/call";
const TOOL_TOKEN = process.env.AGENT_TOOL_TOKEN ?? "";

async function callTool(
  run: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!TOOL_TOKEN) {
    return "Refused. This Bot has no credential for calling tools back through its deployment.";
  }
  if (!run) {
    /*
     * No statement from the deployment about whose run this is, so there is nothing to act on behalf
     * of. Reported as a result rather than thrown: the run continues and says what it could not do.
     */
    return "Refused. This run carried no signed statement of which Bot and person it is for.";
  }
  try {
    /*
     * The chain's next hop (Issue #23/T17): the tool call dials back into this
     * deployment carrying the W3C context of the span it runs under — the tool
     * span when one is active, the run's otherwise — so the server-side
     * execution continues the same trace instead of rooting a fresh one.
     */
    const response = await fetch(TOOL_URL, {
      method: "POST",
      headers: injectTraceHeaders({
        "content-type": "application/json",
        "x-openbot-agent-token": TOOL_TOKEN,
      }),
      /*
       * The deployment's own statement, handed straight back.
       *
       * The Bot and the actor used to be sent from here, which meant this process asserted who it was
       * acting for. It is not in a position to know, and anything holding the token could claim
       * anything, so the deployment says it and this only carries the note.
       */
      body: JSON.stringify({ name, args, run }),
    });
    return await toolAnswer(response);
  } catch (error) {
    // Reported to the model as a result rather than thrown: the run continues and says what broke.
    return `That tool could not be called: ${
      error instanceof Error ? error.message : "unknown error"
    }`;
  }
}

/**
 * The deployment's signed statement of what this run is.
 *
 * Opaque here on purpose: this process cannot read it and has no reason to. It carries it back when it
 * calls a tool, and the deployment that signed it is the only thing that can open it.
 */
function runAssertionOf(input: RunAgentInput): string {
  const props = input.forwardedProps as { openbotRun?: unknown } | undefined;
  return typeof props?.openbotRun === "string" ? props.openbotRun : "";
}

/**
 * The tools this deployment runs, as opposed to the ones the surface draws.
 *
 * Both arrive in the same list and no naming rule separates them, so the deployment names its own.
 * Absent, nothing is treated as the deployment's: a Bot that guessed wrong would either apologise for
 * a component it did show, or quietly report a governed tool as drawn without ever calling it. The
 * first is embarrassing and the second is a lie about governance, so an unmarked run does neither.
 */
function deploymentToolsOf(input: RunAgentInput): Set<string> {
  const props = input.forwardedProps as
    | { openbotDeploymentTools?: unknown }
    | undefined;
  const names = props?.openbotDeploymentTools;
  return new Set(
    Array.isArray(names)
      ? names.filter((name) => typeof name === "string")
      : [],
  );
}

/** Did the model reach for something the surface owns rather than something this deployment runs? */
function callsTheSurface(
  calls: { name: string }[],
  ours: Set<string>,
): boolean {
  return calls.some((call) => !ours.has(call.name));
}

/**
 * The graph, with the tool loop where it belongs.
 *
 * The loop used to run in the browser: this emitted a call, ended the run, and waited for a surface
 * to execute it and start another. That made a watching browser a requirement for a Bot to do
 * anything, which rules out an embed, a schedule, and anything unattended.
 *
 * Now it answers, calls what it needs, reads the results and answers again, which is what a harness
 * is for. `recursionLimit` bounds a model that would otherwise call tools in a circle.
 */
function buildGraph(input: RunAgentInput, budget: RunBudgetLedger | null) {
  const run = runAssertionOf(input);

  const tools = toBoundTools(input);
  const ours = deploymentToolsOf(input);

  /*
   * THE MODEL NODE IS WHERE THE BUDGET IS ENFORCED (R3-02), because it is the only seat in this
   * process where the loop can still decide not to spend: the cap is checked before the call,
   * the call is sized by what remains, and the provider's own reported usage is accounted
   * immediately afterwards — the three halves the ledger's docblock promises. The model is built
   * per step so its output cap is THIS step's remaining budget rather than the run's opening one.
   */
  const answer = async (state: { messages: BaseMessage[] }) => {
    const cap = budget?.beginModelStep(state.messages);
    const model = buildModel(cap);
    const bound = tools.length > 0 ? model.bindTools(tools) : model;
    const message = (await bound.invoke(state.messages)) as AIMessage;
    budget?.recordModelCall(message);
    return { messages: [message] };
  };

  return new StateGraph(MessagesAnnotation)
    .addNode("answer", answer)
    .addNode("tools", async (state) => {
      const last = state.messages.at(-1) as AIMessage;
      const results = await Promise.all(
        /*
         * Only this deployment's own tools. A component is drawn by the surface, and a decision is
         * answered there by a person, so neither is executed here and neither gets a result invented
         * here. The run ends instead, and the surface starts the next one carrying what it produced.
         */
        (last.tool_calls ?? [])
          .filter((call) => ours.has(call.name))
          .map(async (call) => {
            // The governed tool span: the deployment's tools run here by hand, so no framework
            // callback fires for them and this is the tool half of the parent-child shape.
            const text = await traceDeploymentToolCall(call.name, call.id, () =>
              callTool(
                run,
                call.name,
                (call.args ?? {}) as Record<string, unknown>,
              ),
            );
            return new ToolMessage({
              content: text,
              tool_call_id: call.id ?? call.name,
              name: call.name,
            });
          }),
      );
      return { messages: results };
    })
    .addEdge(START, "answer")
    .addConditionalEdges("answer", (state) => {
      const last = state.messages.at(-1) as AIMessage | undefined;
      const calls = last?.tool_calls ?? [];
      if (calls.length === 0) return END;
      /*
       * A call the surface owns ends the run.
       *
       * This is how a tool that lives in the browser is supposed to work: the Bot asks for it, the
       * run finishes, the surface draws it or puts the question to a person, and the surface begins
       * the next run with the answer in hand. Running the loop through it here instead invents a
       * result: the Bot apologises for a chart the person is looking at, and an approval card that
       * has already been answered on its behalf sits waiting for a click that can never land.
       *
       * A turn that asks for both kinds at once ends too, and the model asks again for what it still
       * has no answer to. That is the rarer case and the safe way round: the alternative runs a
       * governed tool whose result nobody is waiting for.
       */
      if (callsTheSurface(calls, ours)) return END;
      return "tools";
    })
    .addEdge("tools", "answer")
    .compile();
}

async function runAgent(input: RunAgentInput): Promise<Response> {
  const encoder = new EventEncoder();
  /*
   * The run's budget contract (R3-02), read before anything else: a caller that sent caps this
   * process cannot read gets no run at all, because the alternative is running it unbounded while
   * its caller believes otherwise. A contract that is absent is a caller that did not ask — see
   * `readBudgetContract`.
   */
  let contract: BudgetContract | null = null;
  let contractProblem: string | null = null;
  try {
    contract = readBudgetContract(input);
  } catch (error) {
    contractProblem =
      error instanceof BudgetContractInvalidError
        ? error.message
        : "The budget contract could not be read.";
  }
  const budget = contract === null ? null : new RunBudgetLedger(contract);
  const receipt = () =>
    budget === null ? null : budgetReceiptEvent(budget, MANAGED_AGENT_TOKEN);
  /*
   * The run's governed span tree, opened before the stream so the framework's model, tool and
   * retrieval spans hang from it through the ambient context. One handler per run: its run-id →
   * span map must never outlive the run that built it. The span's capability attribute is
   * `detailed` since T37 verified the internal step shape on a real instance
   * (docs/plans/evidence/2026-10-16-issue4/T37/evidence/b1-framework-rows.json).
   */
  const callbacks = new GovernedCallbackHandler();
  const governedRun = governedRunSpan(input);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const utf8 = new TextEncoder();
      const send = (event: BaseEvent) =>
        controller.enqueue(utf8.encode(encoder.encodeSSE(event)));

      send({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);

      // The graph is built and its event stream opened inside `streamRun`, so a failure doing either
      // is reported as RUN_ERROR through the same path as a failure mid-stream. The run span ends on
      // `streamRun`'s verdict — the actual outcome, not the moment bytes started leaving.
      let outcome: "completed" | "failed";
      try {
        if (contractProblem !== null) {
          // A refused contract still speaks the protocol: the run fails by name, so its caller
          // sees WHY rather than a stream that simply stops.
          send({
            type: "RUN_ERROR",
            message: `budget_contract_invalid: ${contractProblem}`,
          } as BaseEvent);
          outcome = "failed";
        } else {
          outcome = await context.with(
            trace.setSpan(context.active(), governedRun.span),
            () =>
              streamRun(
                async () =>
                  buildGraph(input, budget).streamEvents(
                    { messages: toLangChainMessages(input, PROVIDER) },
                    {
                      version: "v2",
                      callbacks: [callbacks],
                      // Sized from the contract so the budget's own stop fires before this
                      // framework ceiling would; an unbudgeted run keeps LangGraph's default.
                      ...(budget
                        ? { recursionLimit: budget.recursionLimit() }
                        : {}),
                    },
                  ),
                input,
                send,
                receipt,
              ),
          );
        }
      } catch (error) {
        governedRun.finish("failed");
        throw error;
      }
      governedRun.finish(outcome);

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": encoder.getContentType(),
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

// Trace context propagation and, when a collector is configured, trace export — the same one
// provider every other process in this deployment rides (shared/trace.ts). Registered by the
// first import above (./tracing.ts, F9A), before any framework module could claim the
// OpenTelemetry globals; the listener below starts only after it.

serve({
  port: PORT,
  idleTimeout: 120,
  // Wrapped so an inbound `traceparent` continues the deployment's trace rather than rooting a
  // fresh one, and so the run's spans carry the request's trace id out with them.
  fetch: withTraceFetch(async (request) => {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        provider: PROVIDER,
        model: MODEL,
        framework: "langgraph",
        responsesApi: USE_RESPONSES_API,
      });
    }

    if (url.pathname === "/ag-ui" && request.method === "POST") {
      if (!hasManagedAgentToken(request, MANAGED_AGENT_TOKEN)) {
        return Response.json({ error: "Unauthorized." }, { status: 401 });
      }
      const input = (await request.json()) as RunAgentInput;
      return runAgent(input);
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  }),
});

console.info(`agent-langgraph listening on http://127.0.0.1:${PORT}/ag-ui`);
