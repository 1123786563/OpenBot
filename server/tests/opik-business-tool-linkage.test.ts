// R4-03 — a real business tool call never disappears from governance steps.
//
// The F7E stock evidence: two real `report_environment` call ids in the thread, no
// governance span carrying either — the only tool spans on the chain were the engine's
// state tools, recorded as business-looking steps. The finding refused both halves of
// that shape: a state tool is not a business step, and a real call's PROPOSAL must be
// locatable in the governance record even when the run was scheduled where the ambient
// W3C context does not survive (the Intelligence runner's Phoenix channel-join callback,
// R4-01's diagnosis on the built-in side of the wire).
//
// This suite pins the fix on its three faces:
//
//   1. the built-in half — a surface (client) business tool call, driven through the
//      REAL built-in agent assembly (configuration + sane-history + chain middleware +
//      observation tap) against a scripted OpenAI-compatible stream, keeps its call id
//      in the recorded step, with the execution honestly unobserved and the chain
//      DERIVED from the run's own identity when no ambient context exists, ambient
//      exactly as before when one does;
//   2. the remote half — the endpoint's stream (the LangGraph shape) carries the
//      proposal and, when the surface answered, the receipt; the mediated run records
//      them as its own tool steps (origin `remote-agui`), never claiming an execution
//      this process did not run, and the recorder's binding gate receives the run's
//      own binding identity rather than minting a second row for the same chain;
//   3. the engine's two state tools leave no business step on either path.
//
// No database and no real Opik: the agents, middleware and observation are production
// code, the provider is a scripted loopback SSE stream, and the queue/port/gate are the
// same fakes the T15/T17 suites use. The boot adapter's R4-03 passthrough is pinned by
// a source anchor (the t-final-assembly pattern), because the adapter is the one piece
// of the chain this suite cannot execute without booting the whole server.

import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { runRootSpanId } from "@openbot/shared/run-identity";
import { context, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { firstValueFrom, Observable, toArray } from "rxjs";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import type { ObserverRunBindingGate } from "../src/ai-observability/bindings";
import type { OpikObservationWrite } from "../src/ai-observability/health";
import { runUpstreamIdentity } from "../src/ai-observability/opik-http";
import type { OpikOtlpSpan, OpikPort } from "../src/ai-observability/opik-port";
import {
  canonicalRemoteEndpoint,
  createRemoteBudgetContractResolver,
  createRemoteRunBudgetGate,
  remoteBudgetCaps,
} from "../src/ai-observability/remote-run";
import { resolveObservationScope } from "../src/ai-observability/scope";
import { createToolStepRecorder } from "../src/ai-observability/tool-steps";
import type { AgentFetch } from "../src/channels/stall-guard";
import {
  type BuiltinToolStepFact,
  bindRemoteDialChain,
  buildAgents,
  builtinRunChainCounts,
  derivedBuiltinRunTraceId,
  REMOTE_BUDGET_RECEIPT_EVENT,
  type RegisteredBuiltInAgent,
  resolveRuntimeAgents,
  setBuiltinToolStepObserver,
  setRemoteBudgetContractResolver,
  setRemoteRunBudgetGate,
  standingRoleMessage,
  toolStepObservationForTests,
} from "../src/copilot";

const hereDir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fakes (the T15/T17 shapes)
// ---------------------------------------------------------------------------

/** A queue that accepts everything and remembers what was submitted. */
function fakeQueue() {
  const submitted: OpikObservationWrite[] = [];
  const countedIdLinks: string[] = [];
  return {
    submitted,
    countedIdLinks,
    queue: {
      submit(write: OpikObservationWrite) {
        submitted.push(write);
        return "accepted" as const;
      },
      countIdLink(outcome: "chain_broken" | "divergent" | "error") {
        countedIdLinks.push(outcome);
      },
    },
  };
}

/** A port fake that records the spans writeSpans received. */
function fakePort() {
  const writes: Array<{ spans: readonly OpikOtlpSpan[] }> = [];
  const port = {
    async writeSpans(
      _scope: unknown,
      input: { spans: readonly OpikOtlpSpan[] },
    ) {
      writes.push({ spans: input.spans });
      return { outcome: "ok" as const, value: { accepted: true as const } };
    },
  };
  return { writes, port: port as unknown as OpikPort };
}

/**
 * The observer binding gate as a recording stand-in: `ensure` answers a ref the way the
 * real gate does and remembers every (scope, chain) it was asked — what the R4-03
 * remote contract pins is the chain's RUN IDENTITY, not a minted chain key.
 */
function fakeGate() {
  const asked: Array<{
    scopeKey: string;
    traceId: string;
    runRef?: Readonly<{ runId: string; attemptId: string }>;
  }> = [];
  const gate: Pick<ObserverRunBindingGate, "ensure"> = {
    async ensure(scope, chain) {
      asked.push({
        scopeKey: scope.key,
        traceId: chain.traceId,
        runRef: chain.runRef,
      });
      return {
        scopeKey: scope.key,
        runId: chain.runRef?.runId ?? `builtin:${chain.traceId}`,
        attemptId: chain.runRef?.attemptId ?? `builtin:${chain.traceId}`,
        locatorWorkspace: "ws",
        locatorProject: "project",
        opikTraceId: `opik-${chain.traceId.slice(0, 8)}`,
      };
    },
  };
  return { asked, gate };
}

/** A provider whose only processor hands ended spans to the test. */
function recordedSpans(): { spans: ReadableSpan[]; stop: () => Promise<void> } {
  const spans: ReadableSpan[] = [];
  const provider = new NodeTracerProvider({
    spanProcessors: [
      {
        onStart: () => {},
        onEnd: (span) => {
          spans.push(span);
        },
        shutdown: () => Promise.resolve(),
        forceFlush: () => Promise.resolve(),
      },
    ],
  });
  provider.register();
  return {
    spans,
    stop: async () => {
      await provider.shutdown();
      trace.disable();
    },
  };
}

// ---------------------------------------------------------------------------
// A scripted OpenAI-compatible stream: one dial, one tool call, no execute.
// ---------------------------------------------------------------------------

/** The OpenAI-compatible SSE stub the AI SDK consumes (stream:true, tool_calls finish). */
async function withSseStub<T>(dial: (base: string) => Promise<T>): Promise<T> {
  const server: HttpServer = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void body;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const send = (obj: unknown) =>
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({
        id: "stub-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "stub-model",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_${createHash("sha256").update(body).digest("hex").slice(0, 10)}`,
                  type: "function",
                  function: { name: "report_environment", arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      send({
        id: "stub-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "stub-model",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const previous = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    return await dial(`http://127.0.0.1:${port}/v1`);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previous;
    server.close();
  }
}

const PROBE_AGENT: RegisteredBuiltInAgent = {
  id: "probe-agent",
  name: "Probe",
  type: "built_in",
  systemPrompt: "Be helpful.",
};

const SURFACE_TOOL = {
  name: "report_environment",
  description: "Report the fixed environment status line.",
  parameters: { type: "object" as const, properties: {}, required: [] },
};

/**
 * One built-in run against the scripted provider, through the REAL assembly: the
 * configuration, the sane-history agent, the production chain middleware, and the
 * production tool-step observation tap. `input` reaches `runAgent` exactly the way a
 * person's run does.
 */
async function driveBuiltinRun(
  facts: BuiltinToolStepFact[],
  input: RunAgentInput,
  withHandoff = false,
): Promise<BaseEvent[]> {
  const events: BaseEvent[] = [];
  setBuiltinToolStepObserver((fact) => {
    facts.push(fact);
  });
  try {
    // The PRODUCTION assembly: resolveRuntimeAgents is the exported entry whose
    // withTools attaches the observation tap AND the run-chain middleware — the
    // test attaches nothing itself, so the assertions hold only when the real
    // wiring does.
    const agents = await resolveRuntimeAgents(
      () => [PROBE_AGENT],
      { provider: "openai", defaultModel: "stub-model" },
      async () => "synthetic-model-key",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      withHandoff ? async () => [] : undefined,
    );
    const runtimeAgent = agents[PROBE_AGENT.id];
    if (!runtimeAgent) throw new Error("resolveRuntimeAgents built no agent");
    runtimeAgent.threadId = input.threadId;
    await runtimeAgent.runAgent(input, {
      onEvent: ({ event }) => {
        events.push(event);
      },
    });
    return events;
  } finally {
    setBuiltinToolStepObserver(undefined);
  }
}

// ---------------------------------------------------------------------------
// The built-in half
// ---------------------------------------------------------------------------

describe("R4-03 built-in: a surface business tool call keeps its identity in governance", () => {
  const input = (runId: string): RunAgentInput =>
    ({
      threadId: "probe-thread",
      runId,
      messages: [
        { id: "m1", role: "user", content: "What is the environment status?" },
      ],
      state: {},
      tools: [SURFACE_TOOL],
      context: [],
      forwardedProps: {},
    }) as unknown as RunAgentInput;

  test("the derivation is a pure function of the attempt identity — idempotent, never all-zero", () => {
    const first = derivedBuiltinRunTraceId(PROBE_AGENT.id, "attempt-stable");
    expect(first).toBe(
      derivedBuiltinRunTraceId(PROBE_AGENT.id, "attempt-stable"),
    );
    expect(first).not.toBe(
      derivedBuiltinRunTraceId(PROBE_AGENT.id, "attempt-other"),
    );
    expect(first).not.toBe(
      derivedBuiltinRunTraceId("other-bot", "attempt-stable"),
    );
    expect(/^[0-9a-f]{32}$/.test(first)).toBe(true);
    expect(/^0+$/.test(first)).toBe(false);
  });

  test("a detached run derives its chain — the call id lands, the execution is never claimed", async () => {
    const { spans, stop } = recordedSpans();
    const facts: BuiltinToolStepFact[] = [];
    const countsBefore = builtinRunChainCounts();
    try {
      await withSseStub(async () => {
        // A timer hop with no active span: the Phoenix-callback shape R4-01 named.
        await new Promise((resolve) => setTimeout(resolve, 1));
        const events = await driveBuiltinRun(facts, input("run-detached"));
        expect(events.map((event) => event.type)).toContain("TOOL_CALL_START");
      });
    } finally {
      await stop();
    }
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    // The chain derives from the server-issued attempt id (T-J #2), which the test cannot
    // name from the wire — the pin is the chain's own shape and parent discipline.
    const expectedTrace = fact.trace?.traceId;
    expect(expectedTrace).toMatch(/^[0-9a-f]{32}$/);
    expect(/^0+$/.test(expectedTrace!)).toBe(false);
    expect(fact.toolName).toBe("report_environment");
    expect(fact.proposalObserved).toBe(true);
    // Surface execution: a proposal the model emitted and nothing this process ran.
    expect(fact.executionObserved).toBe(false);
    expect(fact.receiptObserved).toBe(false);
    expect(fact.window).toBe("terminal");
    expect(fact.trace?.traceId).toBe(expectedTrace);
    // The derived context names the binding's own run root — the parent the port
    // completes every span of the chain with, never an invented ambient.
    expect(fact.trace?.spanId).toBe(
      runUpstreamIdentity(expectedTrace!).rootSpanId,
    );
    expect(builtinRunChainCounts().derived).toBe(countsBefore.derived + 1);
    expect(fact.origin).toBeUndefined(); // the built-in path reads as builtin at the recorder
  });

  test("production handoff wrapper derives the chain around the inner run", async () => {
    const { stop } = recordedSpans();
    const facts: BuiltinToolStepFact[] = [];
    const before = builtinRunChainCounts();
    try {
      await withSseStub(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await driveBuiltinRun(facts, input("run-handoff"), true);
      });
    } finally {
      await stop();
    }
    expect(facts).toHaveLength(1);
    // The chain derives from the server-issued attempt id (T-J #2): shape and parent
    // discipline, recomputed only against the observed trace itself.
    const traceId = facts[0]!.trace?.traceId;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(/^0+$/.test(traceId!)).toBe(false);
    expect(facts[0]!.trace).toEqual({
      traceId,
      spanId: runUpstreamIdentity(traceId!).rootSpanId,
    });
    expect(builtinRunChainCounts().derived).toBe(before.derived + 1);
  });

  test("the shared run-root derivation and the binding store's agree — one parent discipline", () => {
    for (const traceId of [
      derivedBuiltinRunTraceId(PROBE_AGENT.id, "contract-pin"),
      "0123456789abcdef0123456789abcdef",
      "ffffffffffffffffffffffffffffffff",
    ]) {
      expect(runRootSpanId(traceId)).toBe(
        runUpstreamIdentity(traceId).rootSpanId,
      );
    }
  });

  test("the anchor post carries the exporter's auth headers; absent headers change nothing", async () => {
    const posts: Array<Record<string, string | string[] | undefined>> = [];
    const server = createHttpServer((req, res) => {
      posts.push({ ...req.headers });
      res.writeHead(200).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/traces`;
    const saved = {
      endpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
      traces: process.env.OPENBOT_TRACES,
    };
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = url;
    process.env.OPENBOT_TRACES = "on";
    try {
      process.env.OTEL_EXPORTER_OTLP_HEADERS =
        "authorization=Bearer anchor-key,x_test=v%202";
      bindRemoteDialChain(
        { origin: "derived", traceId: "0123456789abcdef0123456789abcdef" },
        "risk",
        "run-anchor",
        "attempt-anchor",
      );
      const deadline = Date.now() + 5_000;
      while (posts.length === 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(posts.length).toBe(1);
      expect(posts[0]!.authorization).toBe("Bearer anchor-key");
      // The SDK's own header grammar: comma-separated key=value, percent-decoded.
      expect(posts[0]!.x_test).toBe("v 2");
      expect(posts[0]!["content-type"]).toBe("application/json");

      delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
      posts.length = 0;
      bindRemoteDialChain(
        { origin: "derived", traceId: "fedcba9876543210fedcba9876543210" },
        "risk",
        "run-anchor-bare",
        "attempt-anchor-bare",
      );
      const bareDeadline = Date.now() + 5_000;
      while (posts.length === 0 && Date.now() < bareDeadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(posts.length).toBe(1);
      expect(posts[0]!.authorization).toBeUndefined();
    } finally {
      if (saved.endpoint === undefined)
        delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = saved.endpoint;
      if (saved.headers === undefined)
        delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
      else process.env.OTEL_EXPORTER_OTLP_HEADERS = saved.headers;
      if (saved.traces === undefined) delete process.env.OPENBOT_TRACES;
      else process.env.OPENBOT_TRACES = saved.traces;
      server.close();
    }
  });

  test("re-driving one run id roots each attempt its own chain — the wire runId cannot merge them (T-J #2)", async () => {
    const { spans, stop } = recordedSpans();
    const facts: BuiltinToolStepFact[] = [];
    try {
      await withSseStub(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await driveBuiltinRun(facts, input("run-replay"));
        await new Promise((resolve) => setTimeout(resolve, 1));
        await driveBuiltinRun(facts, input("run-replay"));
        await new Promise((resolve) => setTimeout(resolve, 1));
        await driveBuiltinRun(facts, input("run-fresh"));
      });
    } finally {
      await stop();
    }
    expect(facts).toHaveLength(3);
    const traces = facts.map((fact) => fact.trace?.traceId);
    // Every subscription is its own attempt: the re-driven run id and the fresh run each
    // root a chain of their own — nothing merges, and each chain is a real W3C id.
    for (const traceId of traces) expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(traces).size).toBe(3);
  });

  test("an inline run (an active ambient span) keeps exactly that chain — nothing invented", async () => {
    const { spans, stop } = recordedSpans();
    const facts: BuiltinToolStepFact[] = [];
    const countsBefore = builtinRunChainCounts();
    const tracer = trace.getTracer("probe");
    try {
      await withSseStub(async () => {
        await tracer.startActiveSpan("inline run", async (span) => {
          try {
            await driveBuiltinRun(facts, input("run-inline"));
          } finally {
            span.end();
          }
        });
      });
    } finally {
      await stop();
    }
    expect(facts).toHaveLength(1);
    const inline = spans.find((candidate) => candidate.name === "inline run");
    expect(inline).toBeDefined();
    expect(facts[0]!.trace?.traceId).toBe(inline!.spanContext().traceId);
    expect(facts[0]!.trace?.spanId).toBe(inline!.spanContext().spanId);
    expect(builtinRunChainCounts().ambient).toBe(countsBefore.ambient + 1);
    // Ambient means ambient: no derived chain was minted for this run.
    expect(builtinRunChainCounts().derived).toBe(countsBefore.derived);
  });

  test("the engine's state tools leave no business step — a business tool in the same stream still does", async () => {
    // Driven at the tap level (the state tools are engine events, not provider output):
    // a state-tool proposal with its receipt opens no cell, while a business tool in
    // the same stream still does.
    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => {
      facts.push(fact);
    });
    try {
      const source = new Observable<BaseEvent>((subscriber) => {
        const send = (event: BaseEvent) => subscriber.next(event);
        send({
          type: EventType.RUN_STARTED,
          threadId: "t",
          runId: "r-state",
        } as BaseEvent);
        send({
          type: EventType.TOOL_CALL_START,
          toolCallId: "state-1",
          toolCallName: "AGUISendStateDelta",
        } as BaseEvent);
        send({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "state-1",
          delta: '{"delta":[]}',
        } as BaseEvent);
        send({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "state-1",
          content: '{"success":true}',
        } as BaseEvent);
        send({
          type: EventType.TOOL_CALL_START,
          toolCallId: "biz-1",
          toolCallName: "report_environment",
        } as BaseEvent);
        send({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "biz-1",
          delta: "{}",
        } as BaseEvent);
        send({
          type: EventType.TOOL_CALL_END,
          toolCallId: "biz-1",
        } as BaseEvent);
        send({
          type: EventType.RUN_FINISHED,
          threadId: "t",
          runId: "r-state",
        } as BaseEvent);
        subscriber.complete();
      });
      await firstValueFrom(
        toolStepObservationForTests.observeStream(source).pipe(toArray()),
      );
    } finally {
      setBuiltinToolStepObserver(undefined);
    }
    expect(facts).toHaveLength(1);
    expect(facts[0]!.toolCallId).toBe("biz-1");
    expect(facts[0]!.toolName).toBe("report_environment");
  });
});

// ---------------------------------------------------------------------------
// The remote (endpoint-mediated) half
// ---------------------------------------------------------------------------

const SECRET = "synthetic-managed-token";
const POLICY_TOKENS = 1_000_000n;
const MAX_MODEL_STEPS = 8;
const ENDPOINT = "https://risk.test/ag-ui";
const CAPS = remoteBudgetCaps(POLICY_TOKENS, MAX_MODEL_STEPS) as {
  modelSteps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

const riskRow = {
  id: "risk",
  name: "Risk",
  type: "remote_ag_ui" as const,
  title: "Risk & Compliance",
  roleDescription: "Investigate policies and controls.",
};

const remoteAgentRow = () => ({
  id: "risk",
  name: "Risk",
  type: "remote_ag_ui" as const,
  endpoint: ENDPOINT,
  headers: { "x-openbot-agent-token": SECRET },
  standingMessage: standingRoleMessage(riskRow),
});

/** The receipt both ends speak, MAC'd the way the budget contract signs it. */
function receiptEvent(runId: string): BaseEvent {
  const receipt = {
    kind: REMOTE_BUDGET_RECEIPT_EVENT,
    v: 1,
    runId,
    caps: CAPS,
    usage: {
      modelSteps: 1,
      inputTokens: 400,
      outputTokens: 40,
      totalTokens: 440,
    },
    status: "ok" as const,
  };
  // Purpose-derived key (OCR R5 handoff): HMAC(secret, label), same pin as
  // the other budget suites — the token also travels as the dial's Bearer.
  const macKey = createHmac("sha256", SECRET)
    .update("openbot-budget-receipt-mac-v1")
    .digest("hex");
  const mac = createHmac("sha256", macKey)
    .update(
      [
        "openbot-budget-receipt",
        "v=1",
        `runId=${runId}`,
        `caps=${CAPS.modelSteps}|${CAPS.inputTokens}|${CAPS.outputTokens}|${CAPS.totalTokens}`,
        `usage=1|400|40|440`,
        `status=ok`,
      ].join("\n"),
    )
    .digest("hex");
  return {
    type: "CUSTOM",
    name: REMOTE_BUDGET_RECEIPT_EVENT,
    value: { ...receipt, mac },
  } as unknown as BaseEvent;
}

/**
 * A scripted AG-UI endpoint in the fetch seam whose stream proposes a business tool
 * call, streams its arguments, and — `withReceipt` — answers it from the surface.
 */
function scriptedEndpoint(
  withReceipt: boolean,
  stateToolToo: boolean,
  finishTheRun = true,
) {
  const dials: Array<{ body: RunAgentInput }> = [];
  const fetch: AgentFetch = async (
    _url: unknown,
    init?: { body?: unknown },
  ) => {
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as RunAgentInput;
    dials.push({ body });
    const encoder = new TextEncoder();
    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: body.threadId,
        runId: body.runId,
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call_remote_biz",
        toolCallName: "report_environment",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call_remote_biz",
        delta: '{"scope":"probe',
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call_remote_biz",
        delta: '"}',
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_END,
        toolCallId: "call_remote_biz",
      } as BaseEvent,
    ];
    if (stateToolToo) {
      events.push({
        type: EventType.TOOL_CALL_START,
        toolCallId: "call_remote_state",
        toolCallName: "AGUISendStateDelta",
      } as BaseEvent);
      events.push({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call_remote_state",
        delta: '{"delta":[]}',
      } as BaseEvent);
      events.push({
        type: EventType.TOOL_CALL_END,
        toolCallId: "call_remote_state",
      } as BaseEvent);
      events.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: "msg-tool-state",
        toolCallId: "call_remote_state",
        content: '{"success":true}',
      } as BaseEvent);
    }
    if (withReceipt) {
      // The surface executed the call and answered it — the receipt this server can
      // observe without ever having run the tool.
      events.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: "msg-tool-biz",
        toolCallId: "call_remote_biz",
        content: JSON.stringify({
          status: "f8e isolated stack: all systems nominal",
        }),
      } as BaseEvent);
    }
    events.push(receiptEvent(body.runId ?? "run"));
    if (finishTheRun) {
      events.push({
        type: EventType.RUN_FINISHED,
        threadId: body.threadId,
        runId: body.runId,
      } as BaseEvent);
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { fetch, dials };
}

/** The budget seams with a recording credit writer (the dial suite's harness shape). */
function budgetHarness() {
  const reservedKeys: string[] = [];
  const creditWriter = {
    async reserveCredits(input: { idempotencyKey: string }) {
      reservedKeys.push(input.idempotencyKey);
      return { reserved: true as const, reservationId: "reservation-1" };
    },
    async markReservationUnknown() {},
  };
  const gate = createRemoteRunBudgetGate({
    creditWriter,
    resolvePayer: () => ({
      externalCustomerId: "customer-1",
      payer: { kind: "personal" as const },
    }),
    maximumCents: 5_000,
    reservationWindowMs: 15 * 60_000,
    idempotencyPrefix: "usage:",
    log: { error: () => {}, warn: () => {} },
    refusals: {
      gateFailure: () => {
        const error = new Error("credit_gate_unavailable");
        error.name = "CreditGateFailureError";
        return error;
      },
      insufficient: (input: { payerKind: string }) =>
        new Error(`credits_exhausted: ${input.payerKind}`),
    },
  });
  const resolver = createRemoteBudgetContractResolver({
    endpoints: new Set([canonicalRemoteEndpoint(ENDPOINT) as string]),
    sharedSecret: SECRET,
    maximumTokens: POLICY_TOKENS,
    maxModelSteps: MAX_MODEL_STEPS,
  });
  return { gate, resolver, reservedKeys };
}

async function buildRemoteBot(
  fetch: AgentFetch,
  threadingScope: { actorId: string },
): Promise<{
  agents: Awaited<ReturnType<typeof buildAgents>>;
  reservedKeys: string[];
}> {
  const harness = budgetHarness();
  setRemoteRunBudgetGate(harness.gate);
  setRemoteBudgetContractResolver(harness.resolver);
  try {
    const agents = await buildAgents(
      [remoteAgentRow()],
      { provider: "openai", defaultModel: "test" },
      null,
      undefined,
      async () => [],
      undefined,
      undefined,
      undefined,
      undefined,
      fetch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { userId: "person-1" },
      undefined,
      {
        actorId: threadingScope.actorId,
        resolveScope: () =>
          Promise.resolve(
            resolveObservationScope({
              actorId: "person-1",
              botId: "risk",
              ownership: "owner",
              epoch: 1,
            }),
          ),
      },
    );
    return { agents, reservedKeys: harness.reservedKeys };
  } finally {
    setRemoteRunBudgetGate(undefined);
    setRemoteBudgetContractResolver(undefined);
  }
}

describe("R4-03 remote: the endpoint's business tool calls become governance steps", () => {
  test("a surface-answered call records proposal + receipt, never an execution, under the run's own binding identity", async () => {
    const { fetch } = scriptedEndpoint(true, true);
    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => {
      facts.push(fact);
    });
    const { stop } = recordedSpans();
    let reservedKeys: string[] = [];
    try {
      const built = await buildRemoteBot(fetch, {
        actorId: "person-1",
      });
      reservedKeys = built.reservedKeys;
      const agent = built.agents.risk;
      if (!agent) throw new Error("buildAgents returned no remote agent");
      agent.threadId = "remote-thread";
      await new Promise((resolve) => setTimeout(resolve, 1)); // detached, like the runner's callback
      await agent.runAgent({ runId: "run-remote-1" }, { onEvent: () => {} });
      await new Promise((resolve) => setTimeout(resolve, 50)); // let the settlement land
    } finally {
      setBuiltinToolStepObserver(undefined);
      await stop();
    }

    // Exactly the business call: the state tool in the same stream opened no cell.
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.toolCallId).toBe("call_remote_biz");
    expect(fact.toolName).toBe("report_environment");
    expect(fact.proposalObserved).toBe(true);
    expect(fact.receiptObserved).toBe(true);
    // The honesty rule: this server never ran the tool, so nothing may say it executed.
    expect(fact.executionObserved).toBe(false);
    expect(fact.execution).toBe(null);
    expect(fact.window).toBe("terminal");
    expect(fact.origin).toBe("remote-agui");
    // T-J #2: the attempt is a server nonce, never the wire runId — and it is the SAME
    // nonce the budget admission key carried (same-source).
    expect(fact.runRef?.runId).toBe("run-remote-1");
    expect(fact.runRef?.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fact.runRef?.attemptId).not.toBe("run-remote-1");
    expect(reservedKeys).toContain(
      `usage:remote-run:risk:${fact.runRef!.attemptId}`,
    );
    // The proposal's streamed arguments, joined and bounded — capture, not invention.
    expect(fact.input).toBe('{"scope":"probe"}');
    expect(fact.output).toContain("all systems nominal");
    // The chain is the run's own dial chain — derived from its attempt (R4-01/T-J #2), so
    // the pin is its shape and parent discipline, read back from the observed fact.
    expect(fact.trace?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(/^0+$/.test(fact.trace!.traceId!)).toBe(false);
    expect(fact.trace?.spanId).toBe(
      runUpstreamIdentity(fact.trace!.traceId!).rootSpanId,
    );
  });

  test("a call the run leaves unanswered keeps its proposal — a receipt is never implied", async () => {
    const { fetch } = scriptedEndpoint(false, false, false);
    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => {
      facts.push(fact);
    });
    const { stop } = recordedSpans();
    try {
      const { agents } = await buildRemoteBot(fetch, { actorId: "person-1" });
      const agent = agents.risk;
      if (!agent) throw new Error("buildAgents returned no remote agent");
      agent.threadId = "remote-thread";
      await new Promise((resolve) => setTimeout(resolve, 1));
      await agent.runAgent({ runId: "run-remote-2" }, { onEvent: () => {} });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      setBuiltinToolStepObserver(undefined);
      await stop();
    }
    expect(facts).toHaveLength(1);
    expect(facts[0]!.receiptObserved).toBe(false);
    expect(facts[0]!.output).toBe(null);
    // Still never executed — a proposal is its own fact, not an implied settlement.
    expect(facts[0]!.executionObserved).toBe(false);
  });

  test("runs reusing a client runId each take their own hold — the key carries a server nonce", async () => {
    const { fetch } = scriptedEndpoint(true, false);
    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => {
      facts.push(fact);
    });
    const { stop } = recordedSpans();
    try {
      const { agents, reservedKeys } = await buildRemoteBot(fetch, {
        actorId: "person-1",
      });
      const agent = agents.risk;
      if (!agent) throw new Error("buildAgents returned no remote agent");
      agent.threadId = "remote-thread";
      // The finding's shape: the same client-supplied runId, admission after admission.
      await new Promise((resolve) => setTimeout(resolve, 1));
      await agent.runAgent({ runId: "run-reused" }, { onEvent: () => {} });
      await new Promise((resolve) => setTimeout(resolve, 1));
      await agent.runAgent({ runId: "run-reused" }, { onEvent: () => {} });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(reservedKeys).toHaveLength(2);
      for (const key of reservedKeys) {
        // Server-side nonce after the bot: the client's runId cannot land a second
        // admission on the first one's reservation.
        expect(key).toMatch(/^usage:remote-run:risk:[0-9a-f-]{36}$/);
      }
      expect(reservedKeys[0]).not.toBe(reservedKeys[1]);
    } finally {
      setBuiltinToolStepObserver(undefined);
      await stop();
    }
  });

  /*
   * OCR delta2c T-N#5: a repeated TOOL_CALL_START for a call this run already holds must
   * not wipe the cell the first START began building. Duplicate STARTs under one id are
   * real stream behavior (the mastra seam defends against exactly this), and the
   * endpoint's stream is the only source here — before this fix the second START reset
   * args/argsLength/argsTruncated/receiptObserved/output to their opening values, so an
   * endpoint could strip the governance record of its input capture with one extra event,
   * silently. The builtin registry's own rule is reuse; the remote path now holds it too.
   */
  test("a repeated TOOL_CALL_START keeps the cell it already built — accumulated args and the receipt survive", async () => {
    // One business call, opened twice by the endpoint: args stream in both windows, the
    // surface answers once, the receipt and the terminal land as a legal run.
    const script: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "dup-thread",
        runId: "run-dup",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call_dup",
        toolCallName: "report_environment",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call_dup",
        delta: '{"scope":"first',
      } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "call_dup" } as BaseEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call_dup",
        toolCallName: "report_environment",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call_dup",
        delta: '-window"}',
      } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "call_dup" } as BaseEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "msg-dup",
        toolCallId: "call_dup",
        content: '{"ok":true}',
      } as BaseEvent,
      receiptEvent("run-dup"),
      {
        type: EventType.RUN_FINISHED,
        threadId: "dup-thread",
        runId: "run-dup",
      } as BaseEvent,
    ];
    const fetch: AgentFetch = async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of script) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    };

    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => {
      facts.push(fact);
    });
    const { stop } = recordedSpans();
    const built = await buildRemoteBot(fetch, { actorId: "person-1" });
    try {
      const agent = built.agents.risk;
      if (!agent) throw new Error("buildAgents returned no remote agent");
      agent.threadId = "dup-thread";
      await new Promise((resolve) => setTimeout(resolve, 1)); // detached, like the runner's callback
      await agent.runAgent({ runId: "run-dup" }, { onEvent: () => {} });
      await new Promise((resolve) => setTimeout(resolve, 50)); // let the settlement land
    } finally {
      setBuiltinToolStepObserver(undefined);
      await stop();
    }

    // ONE cell, holding BOTH windows' args and the receipt — the duplicate START
    // neither opened a second step nor reset the first one's capture.
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.toolCallId).toBe("call_dup");
    expect(fact.input).toBe(`{"scope":"first-window"}`);
    expect(fact.receiptObserved).toBe(true);
    expect(fact.output).toBe('{"ok":true}');
    expect(fact.proposalObserved).toBe(true);
    expect(fact.origin).toBe("remote-agui");
  });

  test("the recorder names the origin, links the call id, and binds under the run's identity", async () => {
    const { submitted, queue } = fakeQueue();
    const { writes, port } = fakePort();
    const { asked, gate } = fakeGate();
    const recorder = createToolStepRecorder({
      healthService: queue,
      bindings: gate,
    });
    const scope = resolveObservationScope({
      actorId: "person-1",
      botId: "risk",
      ownership: "owner",
      epoch: 1,
    });
    const traceId = "a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8";
    // The adapter's mapping (mirrored from index.ts's boot wiring, R4-03 additions
    // included): a remote fact carries its run identity and names its origin.
    recorder.record({
      toolCallId: "call_remote_biz",
      toolName: "report_environment",
      proposedAt: new Date("2026-10-25T10:00:00Z"),
      endedAt: new Date("2026-10-25T10:00:02Z"),
      proposalObserved: true,
      executionObserved: false,
      receiptObserved: true,
      execution: null,
      window: "terminal",
      input: '{"scope":"probe"}',
      output: "…",
      scope,
      trace: {
        traceId,
        parentSpanId: runUpstreamIdentity(traceId).rootSpanId,
        runRef: { runId: "run-remote-1", attemptId: "run-remote-1" },
      },
      origin: "remote-agui",
    });
    expect(submitted).toHaveLength(1);
    const write = submitted[0]!;
    const result = await write.perform(port);
    expect(result.outcome).toBe("ok");
    expect(writes).toHaveLength(1);
    const span = writes[0]!.spans[0]!;
    // The linkage the finding demanded: the call id ↔ this governance step.
    expect(
      (span.attributes as Record<string, { value?: unknown }>).tool_call_id
        ?.value,
    ).toBe("call_remote_biz");
    expect(
      (span.attributes as Record<string, { value?: unknown }>).origin?.value,
    ).toBe("remote-agui");
    expect(
      (span.attributes as Record<string, { value?: unknown }>).execution_state
        ?.value,
    ).toBe("unobserved");
    expect(
      (span.attributes as Record<string, { value?: unknown }>).receipt_observed
        ?.value,
    ).toBe(true);
    expect(
      (span.attributes as Record<string, { value?: unknown }>)
        .execution_observed?.value,
    ).toBe(false);
    expect(span.traceId).toBe(traceId);
    // The gate was asked for the RUN's binding identity, not a minted chain key.
    expect(asked).toHaveLength(1);
    expect(asked[0]!.traceId).toBe(traceId);
    expect(asked[0]!.runRef).toEqual({
      runId: "run-remote-1",
      attemptId: "run-remote-1",
    });
  });
});

// ---------------------------------------------------------------------------
// The boot adapter's R4-03 passthrough (source anchor, the t-final pattern)
// ---------------------------------------------------------------------------

describe("R4-03 wiring: the boot adapter carries the remote fact's identity", () => {
  // MOD17 moved the boot adapter verbatim into the M11 public facade.
  const indexSource = readFileSync(
    join(hereDir, "..", "src", "ai-observability", "public.ts"),
    "utf8",
  );

  test("the tool-step adapter passes the fact's runRef and origin through to the recorder", () => {
    // Without the runRef the recorder's binding gate mints a second, chain-keyed row
    // for a remote run whose binding already exists — the cross-row opik-trace index
    // then refuses the write and the step silently vanishes, which is exactly the
    // defect this fix closes. Without the origin the span lies about its path.
    expect(indexSource).toContain(
      "...(fact.runRef ? { runRef: fact.runRef } : {})",
    );
    expect(indexSource).toContain(
      "...(fact.origin ? { origin: fact.origin } : {})",
    );
  });
});
