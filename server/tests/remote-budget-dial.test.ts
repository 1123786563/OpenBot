// F5E1-F2 — the remote dial exists behind a verifiable budget (run f6d).
//
// The finding: `buildAgent` resolved every remote_ag_ui / remote_mastra Bot to
// UnavailableAgent(REMOTE_RUN_BUDGET_UNVERIFIED), so the approved Spec's
// "through OpenBot" LangGraph/remote AG-UI path was structurally unreachable —
// while the safety property behind the refusal (no dial without a budget this
// deployment can verify) is one the fix must KEEP, not remove.
//
// These cases pin the restored dial from all three sides the Brief names:
//
//   a. budget verifiable → the dial happens against a scripted endpoint, the
//      run's W3C chain rides out on `traceparent`, the admission reserves
//      before the endpoint is contacted, and the run leaves a governed basic
//      record — binding begun with the `basic` capability (T10: this path sees
//      events, never endpoint internals), the F5E1-F3 materialization and
//      reconcile landing upstream, and the observed outcome settling the
//      binding;
//   b. budget unverifiable → the refusal is exactly what it was: no gate, no
//      dial, REMOTE_RUN_BUDGET_UNVERIFIED — and a gate that refuses keeps the
//      endpoint uncontacted with the credit refusal surfacing as the run's
//      error, the same way a built-in run surfaces one;
//   c. a torn-down run (F5C1's cancel semantics) settles nothing it did not
//      observe: no terminal event arrived, so the budget holds as an unknown
//      cost and the binding stays running — never a fabricated no-cost release,
//      never an invented ending.

import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { EventType, HttpAgent } from "@ag-ui/client";
import { context, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { expect, spyOn, test } from "../../tests/support/e2e-compat";
import type {
  BeginRunBindingInput,
  RunBinding,
} from "../src/ai-observability/bindings";
import type { ObservationScope } from "../src/ai-observability/contracts";
import type {
  OpikOtlpSpan,
  OpikPort,
  OpikRunBindingRef,
} from "../src/ai-observability/opik-port";
import { createRemoteRunRecorder } from "../src/ai-observability/remote-run";
import { resolveObservationScope } from "../src/ai-observability/scope";
import {
  type AgentFetch,
  buildAgents,
  type RemoteRunAdmission,
  type RemoteRunAdmissionInput,
  type RemoteRunFact,
  setRemoteRunBudgetGate,
  setRemoteRunObserver,
  standingRoleMessage,
} from "../src/copilot";

/** Let the fire-and-forget settlement and recorder work land before assertions read it. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

const riskRow = {
  id: "risk",
  name: "Risk",
  type: "remote_ag_ui" as const,
  title: "Risk & Compliance",
  roleDescription: "Investigate policies and controls.",
};

const remoteAgent = () => ({
  id: "risk",
  name: "Risk",
  type: "remote_ag_ui" as const,
  endpoint: "https://risk.test/ag-ui",
  standingMessage: standingRoleMessage(riskRow),
});

type Dial = {
  url: string;
  headers: Record<string, string>;
  body: RunAgentInput;
};

/**
 * A scripted AG-UI endpoint, in the fetch seam itself: no socket, no port, the exact
 * `Response` the transport would have been handed. The script answers each request with
 * the events it should serve; `never` holds the stream open for the cancel case.
 */
function scriptedEndpoint(
  script: (body: RunAgentInput) => BaseEvent[] | "hold-open",
) {
  const dials: Dial[] = [];
  const fetch: AgentFetch = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = JSON.parse(
      typeof init.body === "string" ? init.body : "{}",
    ) as RunAgentInput;
    dials.push({ url: String(url), headers, body });
    const encoder = new TextEncoder();
    const answer = script(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const serve = (events: BaseEvent[]) => {
          for (const event of events) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          }
        };
        if (answer === "hold-open") {
          // Enough to start the run; the stream then stays open until the caller
          // goes away. A canceled fetch's body ENDS without a terminal event —
          // closed cleanly here, never errored — which is exactly the shape a
          // torn-down remote run leaves this side to observe.
          serve([
            {
              type: EventType.RUN_STARTED,
              threadId: body.threadId,
              runId: body.runId,
            } as BaseEvent,
          ]);
          init.signal?.addEventListener("abort", () => {
            try {
              controller.close();
            } catch {
              // Already closed.
            }
          });
          return;
        }
        serve(answer);
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { fetch, dials };
}

const runEvents = (body: RunAgentInput): BaseEvent[] => [
  {
    type: EventType.RUN_STARTED,
    threadId: body.threadId,
    runId: body.runId,
  } as BaseEvent,
  {
    type: EventType.RUN_FINISHED,
    threadId: body.threadId,
    runId: body.runId,
    result: "governed",
  } as BaseEvent,
];

/** The budget gate as a recording stand-in: what the wiring would answer, captured. */
function recordingGate() {
  const admissions: RemoteRunAdmissionInput[] = [];
  const settled: { outcome: string }[] = [];
  const gate = async (
    input: RemoteRunAdmissionInput,
  ): Promise<RemoteRunAdmission> => {
    admissions.push(input);
    return {
      finish: async ({ outcome }) => {
        settled.push({ outcome });
      },
    };
  };
  return { gate, admissions, settled };
}

/** The binding store as an in-memory stand-in, keyed the way the real one is. */
function fakeBindingStore() {
  const begun: BeginRunBindingInput[] = [];
  const finished: { runId: string; state: string }[] = [];
  const reconciled: { runId: string; opikTraceId: string }[] = [];
  const rows = new Map<string, RunBinding>();
  return {
    begun,
    finished,
    reconciled,
    async begin(scope: ObservationScope, input: BeginRunBindingInput) {
      begun.push(input);
      const key = `${scope.key}:${input.runId}:${input.attemptId}`;
      const existing = rows.get(key);
      if (existing) return { binding: existing, replayed: true };
      const row: RunBinding = {
        id: `binding-${key}`,
        scopeKey: scope.key,
        actorId: scope.actorId,
        botId: scope.botId,
        runId: input.runId,
        attemptId: input.attemptId,
        traceId: input.traceId,
        opikTraceId: null,
        locatorWorkspace: "ws",
        locatorProject: "project",
        capability: input.capability,
        state: "running",
        expiresAt: input.expiresAt,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.set(key, row);
      return { binding: row, replayed: false };
    },
    async reconcile(
      scope: ObservationScope,
      runId: string,
      _attemptId: string,
      opikTraceId: string,
    ) {
      reconciled.push({ runId, opikTraceId });
      const row = rows.get(`${scope.key}:${runId}:${_attemptId}`);
      if (row) row.opikTraceId = opikTraceId;
      return {
        binding: rows.get(`${scope.key}:${runId}:${_attemptId}`)!,
        adopted: true,
      };
    },
    async finish(
      scope: ObservationScope,
      runId: string,
      attemptId: string,
      state: string,
    ) {
      finished.push({ runId, state });
      const row = rows.get(`${scope.key}:${runId}:${attemptId}`);
      if (row) row.state = state as RunBinding["state"];
      return { binding: row ?? null, settled: row !== undefined };
    },
  };
}

/** The verified port as a recording stand-in: every materialization call, answered ok. */
function fakePort() {
  const createdTraces: string[] = [];
  const writtenSpans: OpikOtlpSpan[] = [];
  const port = {
    createTrace: async (_scope: unknown, input: { traceId: string }) => {
      createdTraces.push(input.traceId);
      return { outcome: "ok" as const, value: { id: input.traceId } };
    },
    writeSpans: async (
      _scope: unknown,
      input: { spans: OpikOtlpSpan[]; binding?: OpikRunBindingRef },
    ) => {
      writtenSpans.push(...input.spans);
      return { outcome: "ok" as const, value: { accepted: true as const } };
    },
  };
  return { createdTraces, writtenSpans, port: port as unknown as OpikPort };
}

async function buildRemoteBot(
  gate: Parameters<typeof setRemoteRunBudgetGate>[0],
  fetch: AgentFetch,
  threadingScope?: ObservationScope,
) {
  setRemoteRunBudgetGate(gate);
  try {
    return await buildAgents(
      [remoteAgent()],
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
      threadingScope
        ? {
            actorId: threadingScope.actorId,
            botId: "risk",
            resolveScope: () => Promise.resolve(threadingScope),
          }
        : undefined,
    );
  } finally {
    setRemoteRunBudgetGate(undefined);
  }
}

test("a verifiable budget dials the endpoint, propagates the chain, and records a governed basic run", async () => {
  const { fetch, dials } = scriptedEndpoint(runEvents);
  const { gate, admissions, settled } = recordingGate();
  const scope = resolveObservationScope({
    actorId: "person-1",
    botId: "risk",
    ownership: "owner",
    epoch: 1,
  });
  const facts: RemoteRunFact[] = [];
  const store = fakeBindingStore();
  const { createdTraces, writtenSpans, port } = fakePort();
  const recorder = createRemoteRunRecorder({
    bindings: store,
    port: () => port,
  });

  const tracerProvider = new NodeTracerProvider();
  tracerProvider.register();
  const runSpan = trace
    .getTracer("remote-budget-dial-test")
    .startSpan("the remote run");
  const chain = runSpan.spanContext();

  setRemoteRunObserver((fact) => {
    facts.push(fact);
    recorder.record(fact);
  });
  try {
    const agents = await buildRemoteBot(gate, fetch, scope);
    const agent = agents.risk;
    if (!agent) throw new Error("buildAgents returned no remote agent");
    agent.threadId = "dial-thread";

    await context.with(trace.setSpan(context.active(), runSpan), () =>
      agent.runAgent({ runId: "dial-run" }),
    );
    await flush();

    // The dial happened, once, and carried the run's W3C chain to the endpoint.
    expect(dials).toHaveLength(1);
    expect(dials[0].headers.traceparent).toBe(
      `00-${chain.traceId}-${chain.spanId}-01`,
    );

    // The admission ran BEFORE the endpoint was contacted, over the run's identity.
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).toMatchObject({
      botId: "risk",
      runId: "dial-run",
      threadId: "dial-thread",
      attribution: { userId: "person-1" },
    });
    expect(admissions[0].eventId).toBe("remote-run:risk:dial-run");

    // One fact, on the chain the dial propagated, with what the endpoint actually sent.
    expect(facts).toHaveLength(1);
    const fact = facts[0];
    expect(fact.traceId).toBe(chain.traceId);
    expect(fact.scope).toBe(scope);
    expect(fact.events.map((event) => event.type)).toEqual([
      "http_first_frame",
      "run_started",
      "success",
    ]);

    // The governed basic record: T10's capability, F5E1-F3's materialization, the settle.
    expect(store.begun).toHaveLength(1);
    expect(store.begun[0].capability).toBe("basic");
    expect(store.begun[0]).toMatchObject({
      runId: "dial-run",
      attemptId: "dial-run",
      traceId: chain.traceId,
    });
    expect(createdTraces).toHaveLength(1);
    expect(writtenSpans.map((span) => span.name)).toEqual([
      { state: "projected", text: "run" },
    ]);
    expect(store.reconciled).toHaveLength(1);
    expect(store.reconciled[0]).toMatchObject({ runId: "dial-run" });
    expect(store.finished).toEqual([{ runId: "dial-run", state: "completed" }]);

    // The budget settled from the observed outcome — unknown cost, never a release.
    expect(settled).toEqual([{ outcome: "succeeded" }]);
  } finally {
    setRemoteRunObserver(undefined);
    runSpan.end();
    await tracerProvider.shutdown();
    trace.disable();
  }
});

test("an unverifiable budget keeps the dial closed with the same refusal", async () => {
  const { fetch, dials } = scriptedEndpoint(runEvents);
  const spy = spyOn(HttpAgent.prototype, "run");
  try {
    // No gate wired: the build itself refuses, before tools, transport, or dial.
    const agents = await buildRemoteBot(undefined, fetch);
    expect(agents.risk).toMatchObject({
      reason: "REMOTE_RUN_BUDGET_UNVERIFIED",
    });
    agents.risk.threadId = "closed-thread";
    await expect(agents.risk.runAgent({ runId: "closed-run" })).rejects.toThrow(
      "REMOTE_RUN_BUDGET_UNVERIFIED",
    );

    // A gate that refuses: the endpoint stays uncontacted and the credit refusal is
    // the run's error, the same surface a built-in run surfaces one on.
    const refusing = async () => {
      throw new Error(
        "credits_exhausted: the bound account cannot cover one remote run",
      );
    };
    const built = await buildRemoteBot(refusing, fetch);
    built.risk.threadId = "refused-thread";
    await expect(built.risk.runAgent({ runId: "refused-run" })).rejects.toThrow(
      "credits_exhausted",
    );

    expect(dials).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test("a torn-down run settles as an unknown cost and leaves the binding running", async () => {
  const { fetch, dials } = scriptedEndpoint(() => "hold-open");
  const { gate, settled } = recordingGate();
  const scope = resolveObservationScope({
    actorId: "person-1",
    botId: "risk",
    ownership: "owner",
    epoch: 1,
  });
  const facts: RemoteRunFact[] = [];
  const store = fakeBindingStore();
  const { port } = fakePort();
  const recorder = createRemoteRunRecorder({
    bindings: store,
    port: () => port,
  });

  setRemoteRunObserver((fact) => {
    facts.push(fact);
    recorder.record(fact);
  });
  let agents: Awaited<ReturnType<typeof buildRemoteBot>> | undefined;
  try {
    agents = await buildRemoteBot(gate, fetch, scope);
    const agent = agents.risk;
    agent.threadId = "cancel-thread";
    const finishing = agent.runAgent({ runId: "cancel-run" });

    // Let the run start, then tear it down the way a cancellation does: no terminal
    // event ever arrives from the endpoint.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    agent.abortRun();
    await finishing;
    await flush();

    expect(dials).toHaveLength(1);
    expect(settled).toEqual([{ outcome: "unknown" }]);
    expect(facts).toHaveLength(1);
    expect(facts[0].events.map((event) => event.type)).toEqual([
      "http_first_frame",
      "run_started",
      "disconnected",
    ]);
    // Nothing invented an ending: the binding stays running for the lease sweeper,
    // exactly as the HTTP reporter's no-terminal report does.
    expect(store.finished).toEqual([]);
  } finally {
    setRemoteRunObserver(undefined);
    agents?.risk.abortRun();
  }
});

test("an endpoint-confirmed cancellation settles by its name and still holds as an unknown cost", async () => {
  const { fetch, dials } = scriptedEndpoint((body) => [
    {
      type: EventType.RUN_STARTED,
      threadId: body.threadId,
      runId: body.runId,
    } as BaseEvent,
    {
      // The protocol's own confirmed-cancellation ending, not this side's teardown.
      type: EventType.RUN_FINISHED,
      threadId: body.threadId,
      runId: body.runId,
      outcome: { type: "cancelled" },
    } as unknown as BaseEvent,
  ]);
  const { gate, settled } = recordingGate();
  const facts: RemoteRunFact[] = [];
  setRemoteRunObserver((fact) => facts.push(fact));
  try {
    const agents = await buildRemoteBot(gate, fetch);
    agents.risk.threadId = "cancelled-thread";
    await agents.risk.runAgent({ runId: "cancelled-run" });
    await flush();

    expect(dials).toHaveLength(1);
    // A named ending, not an absent one — and never a success.
    expect(facts[0].events.map((event) => event.type)).toEqual([
      "http_first_frame",
      "run_started",
      "canceled",
    ]);
    // The budget settles by the confirmed name and STILL does not release: the endpoint
    // may have produced work before it stopped, the same doctrine a built-in run's
    // `cancelled` keeps (F5C1).
    expect(settled).toEqual([{ outcome: "canceled" }]);
  } finally {
    setRemoteRunObserver(undefined);
  }
});
