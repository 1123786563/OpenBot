import { createRequire } from "node:module";
import { getLocalAgents } from "@ag-ui/mastra";
import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
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

export async function probeMastraCompatibility(): Promise<MastraCompatibilityReport> {
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
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
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
  }
}
