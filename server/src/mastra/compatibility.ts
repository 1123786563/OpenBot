import { createRequire } from "node:module";
import { getLocalAgents } from "@ag-ui/mastra";
import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { createTool } from "@mastra/core/tools";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { MastraServer } from "@mastra/hono";
import { Memory } from "@mastra/memory";
import { PostgresStore } from "@mastra/pg";
import { Hono } from "hono";
import { lastValueFrom, toArray } from "rxjs";
import { z } from "zod";

export type MastraCompatibilityReport = {
  packageVersions: Record<string, string>;
  agentStream: {
    textMessageChunk: boolean;
    text: string;
    runFinished: boolean;
    runError: boolean;
    downstreamCanonicalEvent: "TEXT_MESSAGE_CONTENT";
    normalizationOwner: "Task 6";
  };
  /**
   * ME01: an in-process tool loop through a counting controlled
   * LanguageModelV3 — the tool must execute exactly once and the second model
   * step must answer from its result.
   */
  agentToolLoop: {
    toolCallOnce: boolean;
    finalAnswerFromResult: boolean;
    controlledModelSteps: number;
    providerRequests: number;
  };
  /**
   * ME01: sanitized chunk-shape inventory of the tool-loop fullStream, plus
   * the declared LanguageModel specification version. Cross-process agent
   * suspend/resume is proven behaviorally by
   * server/tests/mastra-agent-resume-process.test.ts (listSuspendedRuns →
   * resumeStream on PostgresStore-backed snapshots); the probe pins the API
   * surface the migration builds on.
   */
  agentExecution: {
    fullStreamChunkTypes: string[];
    languageModelVersion: string;
    probeError?: string;
    suspendResumeApiSurface: {
      listSuspendedRuns: boolean;
      resumeStream: boolean;
      approveToolCall: boolean;
    };
  };
  workflowSuspendResume: {
    suspended: boolean;
    resumedOutput: string | null;
  };
  honoMount: { status: number };
  storageConstructor: { memory: boolean; postgresStore: boolean };
  runtime: {
    bun: string;
    node: string;
    declaredBun: string | null;
  };
};

const require = createRequire(import.meta.url);

function packageVersion(name: string): string {
  return require(`${name}/package.json`).version;
}

/**
 * The SSE envelope both scripted providers answer with. One copy rather than
 * two: a frame-format change (or a usage field) edited in one handler and not
 * the other would make the two probes silently diverge.
 */
const sseResponse = (chunks: unknown[]): Response =>
  new Response(
    `${chunks
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

export async function probeMastraCompatibility(): Promise<MastraCompatibilityReport> {
  let toolProvider: ReturnType<typeof Bun.serve> | undefined;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model?: string };
      const response = {
        id: "chatcmpl-compatibility",
        object: "chat.completion",
        created: 1,
        model: body.model ?? "compatibility-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "mastra-loopback-ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      const chunks = [
        {
          ...response,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "mastra-loopback-ok" },
              finish_reason: null,
            },
          ],
        },
        {
          ...response,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ];
      return sseResponse(chunks);
    },
  });

  let postgresStore: PostgresStore | undefined;
  try {
    const model = createOpenAI({
      apiKey: "synthetic-key",
      baseURL: `${provider.url}v1`,
    }).chat("compatibility-model");
    const agent = new Agent({
      id: "compatibility-agent",
      name: "Compatibility Agent",
      instructions: "Reply with the short answer requested by the user.",
      model,
      memory: new Memory(),
    });
    const agents: Record<string, Agent> = { compatibility: agent };
    const mastra = new Mastra({
      agents,
      storage: new InMemoryStore(),
    });
    // Bun installs the bridge and server peer with separate copies of the same
    // locked core package; its private class fields make those otherwise
    // equivalent Mastra types nominally incompatible.
    const bridgeMastra = mastra as unknown as Parameters<
      typeof getLocalAgents
    >[0]["mastra"];
    const aguiAgent = getLocalAgents({
      mastra: bridgeMastra,
      resourceId: "compatibility-resource",
    }).compatibility;
    const events = await lastValueFrom(
      aguiAgent
        .run({
          threadId: crypto.randomUUID(),
          runId: crypto.randomUUID(),
          messages: [
            {
              id: crypto.randomUUID(),
              role: "user",
              content: "Say the test phrase.",
            },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        })
        .pipe(toArray()),
    );

    const workflowStep = createStep({
      id: "compatibility-approval",
      inputSchema: z.object({}),
      outputSchema: z.object({ answer: z.string() }),
      suspendSchema: z.object({ question: z.string() }),
      resumeSchema: z.object({ answer: z.string() }),
      execute: async ({ suspend, resumeData }) => {
        if (!resumeData) {
          await suspend({ question: "approval required" });
          return { answer: "" };
        }
        return { answer: resumeData.answer };
      },
    });
    const workflow = createWorkflow({
      id: "mastra-compatibility-workflow",
      inputSchema: z.object({}),
      outputSchema: z.object({ answer: z.string() }),
    })
      .then(workflowStep)
      .commit();
    new Mastra({
      workflows: { compatibility: workflow },
      storage: new InMemoryStore(),
    });
    const workflowRun = await workflow.createRun();
    const suspendedRun = await workflowRun.start({ inputData: {} });
    const resumedRun =
      suspendedRun.status === "suspended"
        ? await workflowRun.resume({
            step: workflowStep,
            resumeData: { answer: "approved-value" },
          })
        : suspendedRun;

    const app = new Hono();
    const honoMastra = new Mastra({ storage: new InMemoryStore() });
    const honoServer = new MastraServer({ app, mastra: honoMastra });
    await honoServer.init();
    const agentsResponse = await app.request("/api/agents");

    const memory = new Memory();
    postgresStore = new PostgresStore({
      id: "compatibility-probe",
      connectionString: "postgresql://probe:probe@127.0.0.1:1/probe",
      disableInit: true,
    });
    await postgresStore.close();

    // ME01 execution probe: one scripted provider turn requesting the tool,
    // one answering from its result. Every model step must pass through the
    // counting controlled LanguageModelV3 wrapper.
    let toolLoop: MastraCompatibilityReport["agentToolLoop"] = {
      toolCallOnce: false,
      finalAnswerFromResult: false,
      controlledModelSteps: 0,
      providerRequests: 0,
    };
    let execution: MastraCompatibilityReport["agentExecution"] = {
      fullStreamChunkTypes: [],
      languageModelVersion: "unknown",
      probeError: undefined,
      suspendResumeApiSurface: {
        listSuspendedRuns: false,
        resumeStream: false,
        approveToolCall: false,
      },
    };
    try {
      let toolLoopTurn = 0;
      let toolLoopExecutions = 0;
      let toolLoopToolValue = "";
      toolProvider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as { model?: string };
          const turn = toolLoopTurn++;
          const id = `chatcmpl-compatibility-tool-${turn}`;
          const chunks =
            turn === 0
              ? [
                  {
                    id,
                    object: "chat.completion.chunk",
                    created: 1,
                    model: body.model ?? "compatibility-model",
                    choices: [
                      {
                        index: 0,
                        delta: {
                          role: "assistant",
                          tool_calls: [
                            {
                              index: 0,
                              id: "call-compatibility-1",
                              type: "function",
                              function: {
                                name: "compatibility_echo",
                                arguments: "",
                              },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  },
                  {
                    id,
                    object: "chat.completion.chunk",
                    created: 1,
                    model: body.model ?? "compatibility-model",
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: 0,
                              function: { arguments: '{"value":"probe"}' },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  },
                  {
                    id,
                    object: "chat.completion.chunk",
                    created: 1,
                    model: body.model ?? "compatibility-model",
                    choices: [
                      { index: 0, delta: {}, finish_reason: "tool_calls" },
                    ],
                  },
                ]
              : [
                  {
                    id,
                    object: "chat.completion.chunk",
                    created: 1,
                    model: body.model ?? "compatibility-model",
                    choices: [
                      {
                        index: 0,
                        delta: {
                          role: "assistant",
                          content: `probe-answer:${toolLoopToolValue}`,
                        },
                        finish_reason: null,
                      },
                    ],
                  },
                  {
                    id,
                    object: "chat.completion.chunk",
                    created: 1,
                    model: body.model ?? "compatibility-model",
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  },
                ];
          return sseResponse(chunks);
        },
      });
      const toolBaseModel = createOpenAI({
        apiKey: "synthetic-key",
        baseURL: `${toolProvider.url}v1`,
      }).chat("compatibility-model");
      let controlledModelSteps = 0;
      const controlledModel = new Proxy(toolBaseModel, {
        get(target, property, receiver) {
          if (property === "doStream") {
            return (options: unknown) => {
              controlledModelSteps += 1;
              return target.doStream(options as never);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const echoTool = createTool({
        id: "compatibility_echo",
        description: "Echo the given value.",
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ echo: z.string() }),
        execute: async (input) => {
          toolLoopExecutions += 1;
          toolLoopToolValue = (input as { value: string }).value;
          return { echo: toolLoopToolValue };
        },
      });
      const toolAgent = new Agent({
        id: "compatibility-tool-agent",
        name: "Compatibility Tool Agent",
        instructions: "Echo with the tool, then answer from its result.",
        model: controlledModel as never,
        tools: { compatibility_echo: echoTool },
      });
      const toolOutput = await toolAgent.stream(
        [{ role: "user", content: "Echo probe with the tool, then answer." }],
        { runId: "compatibility-tool-loop" },
      );
      const toolReader = toolOutput.fullStream.getReader();
      const chunkTypes: string[] = [];
      // The answer text accumulates from the stream traversal itself: a
      // second `.text` read after the fullStream was consumed is the fragile
      // dependency this probe used to carry (OCR fix wave 3, R3-5) — if it
      // threw, measured facts already in hand (toolCallOnce, step counts)
      // were lost with it.
      let loopText = "";
      for (;;) {
        const next = await toolReader.read();
        if (next.done) break;
        const chunk = next.value as {
          type?: string;
          payload?: { text?: unknown };
        };
        chunkTypes.push(String(chunk.type ?? "unknown"));
        if (
          chunk.type === "text-delta" &&
          typeof chunk.payload?.text === "string"
        ) {
          loopText += chunk.payload.text;
        }
      }
      // Assigned immediately after the stream drained: every field here is
      // already measured, so none depends on the (now unused) `.text` read.
      toolLoop = {
        toolCallOnce: toolLoopExecutions === 1,
        finalAnswerFromResult: loopText.includes("probe-answer:probe"),
        controlledModelSteps,
        providerRequests: toolLoopTurn,
      };
      execution = {
        fullStreamChunkTypes: [...new Set(chunkTypes)],
        languageModelVersion: String(
          (toolBaseModel as unknown as { specificationVersion?: string })
            .specificationVersion ?? "unknown",
        ),
        suspendResumeApiSurface: {
          listSuspendedRuns:
            typeof (toolAgent as unknown as { listSuspendedRuns?: unknown })
              .listSuspendedRuns === "function",
          resumeStream:
            typeof (toolAgent as unknown as { resumeStream?: unknown })
              .resumeStream === "function",
          approveToolCall:
            typeof (toolAgent as unknown as { approveToolCall?: unknown })
              .approveToolCall === "function",
        },
      };
    } catch (probeError) {
      // Leave the defaults in place: a failed execution probe surfaces as the
      // report's false fields rather than breaking the whole compatibility
      // report the other tests consume — but it must stay diagnosable and
      // must never read as "verified incompatible".
      // biome-ignore lint/suspicious/noConsole: stable-code operational log
      console.warn({
        error: "mastra_execution_probe_failed",
        detail:
          probeError instanceof Error ? probeError.message : String(probeError),
      });
      execution.probeError =
        probeError instanceof Error ? probeError.message : String(probeError);
    }

    let declaredBun: string | null = null;
    try {
      declaredBun = require("../../../package.json").packageManager ?? null;
    } catch {
      declaredBun = null;
    }

    return {
      packageVersions: {
        "@mastra/core": packageVersion("@mastra/core"),
        "@mastra/client-js": packageVersion("@mastra/client-js"),
        "@mastra/memory": packageVersion("@mastra/memory"),
        "@mastra/pg": packageVersion("@mastra/pg"),
        "@mastra/hono": packageVersion("@mastra/hono"),
        "@ag-ui/mastra": packageVersion("@ag-ui/mastra"),
        ai: packageVersion("ai"),
        "@ai-sdk/openai": packageVersion("@ai-sdk/openai"),
        hono: packageVersion("hono"),
      },
      agentStream: {
        textMessageChunk: events.some(
          (event) =>
            event.type === "TEXT_MESSAGE_CHUNK" &&
            "delta" in event &&
            Boolean(event.delta),
        ),
        text: events
          .filter(
            (event) => "delta" in event && typeof event.delta === "string",
          )
          .map((event) => event.delta)
          .join(""),
        runFinished: events.some((event) => event.type === "RUN_FINISHED"),
        runError: events.some((event) => event.type === "RUN_ERROR"),
        downstreamCanonicalEvent: "TEXT_MESSAGE_CONTENT",
        normalizationOwner: "Task 6",
      },
      agentToolLoop: toolLoop,
      agentExecution: execution,
      workflowSuspendResume: {
        suspended: suspendedRun.status === "suspended",
        resumedOutput:
          resumedRun.status === "success" ? resumedRun.result.answer : null,
      },
      honoMount: { status: agentsResponse.status },
      storageConstructor: {
        memory: memory instanceof Memory,
        postgresStore: postgresStore instanceof PostgresStore,
      },
      runtime: {
        bun: Bun.version,
        node: process.version,
        declaredBun,
      },
    };
  } finally {
    await postgresStore?.close();
    await provider.stop(true);
    await toolProvider?.stop(true);
  }
}
