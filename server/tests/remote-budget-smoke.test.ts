// F7D — the full chain, both halves real (R3-02 close-out).
//
// OpenBot's own dial path — buildAgents → the contract resolver → the credit gate → the
// transport → the receipt check in the delivery middleware — against the REAL
// agent-langgraph process, whose model really streams from a scripted provider. This is the
// smoke the Brief asks for: nothing in this file mocks the contract, the receipt or the wire,
// only the model behind the endpoint (the real provider stays with F7E).
//
// What each case proves, in one line:
//
//   1. an in-budget run is dialled with its contract, delivers, and settles its hold unknown;
//   2. an endpoint that keeps spending is STOPPED BY ITS OWN CONTRACT at the caps OpenBot sent
//      — the model-step cap in the receipt's echo is the resolver's, not the endpoint's own —
//      and the run the person sees names the budget, not a silent success.

import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { BaseEvent } from "@ag-ui/client";
import { z } from "zod";
import { expect, test } from "../../tests/support/e2e-compat";
import {
  createRemoteBudgetContractResolver,
  createRemoteRunBudgetGate,
} from "../src/ai-observability/remote-run";
import {
  buildAgents,
  type RemoteBudgetContract,
  setRemoteBudgetContractResolver,
  setRemoteRunBudgetGate,
  standingRoleMessage,
} from "../src/copilot";

/** The deployment token both ends hold: the dial's credential and the receipt's MAC key. */
const SECRET = "synthetic-managed-token";
const POLICY_TOKENS = 8_000n;
const MAX_MODEL_STEPS = 2;

const riskRow = {
  id: "risk",
  name: "Risk",
  type: "remote_ag_ui" as const,
  title: "Risk & Compliance",
  roleDescription: "Investigate policies and controls.",
};

/** Let the fire-and-forget settlement land before assertions read it. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

type ProviderScript = (body: { messages: unknown[] }) => {
  delta:
    | { role: "assistant"; content: string }
    | {
        role: "assistant";
        tool_calls: {
          index: number;
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }[];
      };
  finish: "stop" | "tool_calls";
  usage: { prompt_tokens: number; completion_tokens: number };
};

/** The scripted provider, plain node:http — the model really streams from it. */
function scriptedProvider(script: ProviderScript) {
  const calls: { max_tokens?: number }[] = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = JSON.parse(raw) as {
        model: string;
        messages: unknown[];
        max_tokens?: number;
      };
      calls.push({ max_tokens: body.max_tokens });
      const answer = script(body);
      const base = {
        id: `chatcmpl-${calls.length}`,
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
      };
      const chunks = [
        {
          ...base,
          choices: [{ index: 0, delta: answer.delta, finish_reason: null }],
        },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: answer.finish }],
        },
        {
          ...base,
          choices: [],
          usage: {
            ...answer.usage,
            total_tokens:
              answer.usage.prompt_tokens + answer.usage.completion_tokens,
          },
        },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
          "data: [DONE]\n\n",
      );
    });
  });
  return {
    calls,
    start: () =>
      new Promise<string>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port =
            typeof address === "object" && address !== null ? address.port : 0;
          resolve(`http://127.0.0.1:${port}/v1`);
        });
      }),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * The real agent-langgraph process, spawned from this repository the way the deployment
 * starts it: its own directory, its own token, a provider pointed at the scripted one.
 */
async function withEndpoint(
  providerUrl: string,
  run: (endpoint: string) => Promise<void>,
): Promise<void> {
  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}/ag-ui`;
  const here = fileURLToPath(new URL(".", import.meta.url));
  const child = spawn(
    process.execPath.includes("bun")
      ? process.execPath
      : (process.env.BUN_PATH ?? "bun"),
    ["--no-env-file", "src/index.ts"],
    {
      cwd: `${here}/../../agent-langgraph`,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        PORT: String(port),
        MANAGED_AGENT_TOKEN: SECRET,
        BOT_PROVIDER: "openai",
        BOT_MODEL: "gpt-4.1-mini",
        OPENAI_API_KEY: "synthetic-provider-key",
        OPENAI_BASE_URL: providerUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const ready = await fetch(`http://127.0.0.1:${port}/health`).then(
        (response) => response.ok,
        () => false,
      );
      if (ready) break;
      if (Date.now() > deadline) {
        throw new Error(
          `endpoint never became ready; stderr: ${stderr.join("")}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await run(endpoint);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });
  }
}

/** The real seams the boot wiring composes, with the ledger as the only stand-in. */
function budgetSeams(endpoint: string) {
  const reservations: { idempotencyKey: string; maximumCents: number }[] = [];
  const marks: { reservationId: string; reason: string }[] = [];
  const gate = createRemoteRunBudgetGate({
    creditWriter: {
      async reserveCredits(input: {
        idempotencyKey: string;
        maximumCents: number;
      }) {
        reservations.push({
          idempotencyKey: input.idempotencyKey,
          maximumCents: input.maximumCents,
        });
        return { reserved: true as const, reservationId: "hold-smoke" };
      },
      async markReservationUnknown(reservationId: string, reason: string) {
        marks.push({ reservationId, reason });
      },
    },
    resolvePayer: () => ({
      externalCustomerId: "customer-1",
      payer: { kind: "personal" as const },
    }),
    maximumCents: 8_000,
    reservationWindowMs: 15 * 60_000,
    idempotencyPrefix: "usage:",
    log: {
      error: () => undefined,
      warn: () => undefined,
    },
    refusals: {
      gateFailure: () => new Error("credit_gate_unavailable"),
      insufficient: () => new Error("credits_exhausted"),
    },
  });
  const resolver = createRemoteBudgetContractResolver({
    endpoints: new Set([endpoint]),
    sharedSecret: SECRET,
    maximumTokens: POLICY_TOKENS,
    maxModelSteps: MAX_MODEL_STEPS,
  });
  return { gate, resolver, reservations, marks };
}

async function buildRemoteBot(
  seams: {
    gate: ReturnType<typeof budgetSeams>["gate"];
    resolver?:
      | ((request: {
          type: "remote_ag_ui" | "remote_mastra";
          endpoint: string;
          agentToken: string | undefined;
        }) => RemoteBudgetContract | undefined)
      | undefined;
  },
  endpoint: string,
) {
  setRemoteRunBudgetGate(seams.gate);
  setRemoteBudgetContractResolver(seams.resolver);
  try {
    return await buildAgents(
      [
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui" as const,
          endpoint,
          headers: { "x-openbot-agent-token": SECRET },
          standingMessage: standingRoleMessage(riskRow),
        },
      ],
      { provider: "openai", defaultModel: "test" },
      null,
      undefined,
      async () => [
        /*
         * A tool this DEPLOYMENT runs (it carries no `execute`, so the wrapper classes it a
         * deployment tool and the endpoint executes it by calling back). Without
         * `AGENT_TOOL_TOKEN` the endpoint's callback is refused, which still feeds the graph
         * a result — the shape a Bot that keeps asking has, and exactly what the step cap has
         * to stop.
         */
        {
          name: "message_bot",
          description: "Hand the work to another Bot.",
          parameters: z.object({ to: z.string() }),
        },
      ],
    );
  } finally {
    setRemoteRunBudgetGate(undefined);
    setRemoteBudgetContractResolver(undefined);
  }
}

test("an in-budget run dials under its contract, delivers, and settles its hold unknown", async () => {
  const provider = scriptedProvider(() => ({
    delta: { role: "assistant", content: "the governed answer" },
    finish: "stop",
    usage: { prompt_tokens: 300, completion_tokens: 30 },
  }));
  const providerUrl = await provider.start();
  // The provider's HTTP server outlives this test without the finally: an
  // assertion failure inside withEndpoint leaves it listening (OCR 终审 #45).
  try {
    await withEndpoint(providerUrl, async (endpoint) => {
      const seams = budgetSeams(endpoint);
      const agents = await buildRemoteBot(seams, endpoint);
      const agent = agents.risk;
      if (!agent) throw new Error("buildAgents returned no remote agent");
      agent.threadId = "smoke-thread";

      const delivered: BaseEvent[] = [];
      await agent.runAgent(
        { runId: "smoke-run" },
        { onEvent: ({ event }) => delivered.push(event) },
      );
      await flush();

      // The run delivered: the person got the answer, and the endpoint's receipt never
      // reached the surface — it is control-plane, checked by the middleware and swallowed.
      expect(delivered.map((event) => event.type)).toContain("RUN_FINISHED");
      expect(delivered.map((event) => event.type)).not.toContain("CUSTOM");

      // The model really streamed from the scripted provider, capped on the provider's
      // side of the call. The cap is the contract's output budget MINUS the projected
      // input the ledger reserves against the shared total (ocrfix-d addaf7b5d):
      // totalTokens 8_000 − projectedInput 2_182 = 5_818 for this fixture's first call.
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]?.max_tokens).toBe(5_818);

      // The hold was taken for this run and settles as an unknown cost, as before — the
      // contract bounds what was spent; it does not price it. The idempotency key carries a
      // server nonce after the bot (OCR R5): a client's reused runId cannot share a hold.
      expect(seams.reservations).toHaveLength(1);
      expect(seams.reservations[0]!.maximumCents).toBe(8_000);
      expect(seams.reservations[0]!.idempotencyKey).toMatch(
        /^usage:remote-run:risk:[0-9a-f-]{36}$/,
      );
      expect(seams.marks).toEqual([
        {
          reservationId: "hold-smoke",
          reason: "remote_usage_unreported:succeeded",
        },
      ]);
    });
  } finally {
    await provider.stop();
  }
}, 30_000);

test("an endpoint that keeps spending is stopped by the contract OpenBot sent it", async () => {
  const provider = scriptedProvider(() => ({
    // The model never stops asking for the deployment tool — the loop the step cap exists for.
    delta: {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `call-${provider.calls.length}`,
          type: "function",
          function: { name: "message_bot", arguments: '{"to":"ops"}' },
        },
      ],
    },
    finish: "tool_calls",
    usage: { prompt_tokens: 300, completion_tokens: 20 },
  }));
  const providerUrl = await provider.start();
  // Same finally shape as above: the loop run's failure path must not leak the
  // provider either (OCR 终审 #45).
  try {
    await withEndpoint(providerUrl, async (endpoint) => {
      const seams = budgetSeams(endpoint);
      const agents = await buildRemoteBot(seams, endpoint);
      const agent = agents.risk;
      if (!agent) throw new Error("buildAgents returned no remote agent");
      agent.threadId = "smoke-loop-thread";

      const delivered: BaseEvent[] = [];
      await agent.runAgent(
        { runId: "smoke-loop-run" },
        { onEvent: ({ event }) => delivered.push(event) },
      );
      await flush();

      // The caps in force are the RESOLVER's — the endpoint enforces what OpenBot sent, and
      // two model calls are all this contract allows.
      expect(provider.calls).toHaveLength(2);

      // The person sees the run stop at its budget, by name, and never a CUSTOM event.
      const error = delivered.find((event) => event.type === "RUN_ERROR");
      expect(error).toBeDefined();
      expect(String((error as { message?: unknown }).message)).toContain(
        "budget",
      );
      expect(delivered.map((event) => event.type)).not.toContain("CUSTOM");

      // A budget stop is still a cost this side cannot price: the hold settles unknown with
      // the run's failure named, and the receipt that got it delivered was checked, not
      // trusted — the same resolver verified its caps echo and MAC first.
      expect(seams.marks).toEqual([
        {
          reservationId: "hold-smoke",
          reason: "remote_usage_unreported:failed",
        },
      ]);
    });
  } finally {
    await provider.stop();
  }
}, 30_000);
