// R4-01 — every remote dial this deployment mediates carries the chain of ITS run.
//
// The F7E evidence this suite exists for: 9 dials, 3 joins. The person's runs — executed by
// CopilotKit's Intelligence runner from a Phoenix channel-join callback, where the HTTP
// request's AsyncLocalStorage store does not survive — found no active span at fetch time,
// so the dial carried no `traceparent`, the endpoint rooted its own trace, and the run's
// basic record had no chain to claim. The runs that DID join (the runner's thread-name
// generations, inline in the request handler) were the lucky half, and luck is not the
// acceptance property (A2/A13, #23).
//
// This suite drives the REAL governed dial — `buildAgents` + the budget seams + the AG-UI
// client — against a scripted endpoint in the fetch seam, from BOTH schedulings:
//
//   * DETACHED (a timer hop with no active span — the Phoenix-callback reality): the dial
//     must carry the chain DERIVED from the run's own identity, the parent must be a real
//     span this middleware started, and the record and binding must claim the same trace;
//   * INLINE (an active span, the thread-name path's shape): the dial continues exactly
//     that span, as it did before this fix — no new span is invented.
//
// Both identity paths are covered — the surface-supplied run id and the AG-UI client's own
// derived one — and the whole window is asserted at 100%, dial by dial, because a
// "mostly joined" window is precisely what R4 rejected. The derivation is re-derived
// hand-written here (as `signReceipt` is in the budget suite): this is the pin.

import { createHash, createHmac } from "node:crypto";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { injectTraceHeaders } from "@openbot/shared/trace";
import { context, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { expect, test } from "../../tests/support/e2e-compat";
import type {
  BeginRunBindingInput,
  RunBinding,
} from "../src/ai-observability/bindings";
import type { ObservationScope } from "../src/ai-observability/contracts";
import { runUpstreamIdentity } from "../src/ai-observability/opik-http";
import type {
  OpikOtlpSpan,
  OpikPort,
  OpikRunBindingRef,
} from "../src/ai-observability/opik-port";
import {
  canonicalRemoteEndpoint,
  createRemoteBudgetContractResolver,
  createRemoteRunBudgetGate,
  createRemoteRunRecorder,
  remoteBudgetCaps,
} from "../src/ai-observability/remote-run";
import { resolveObservationScope } from "../src/ai-observability/scope";
import {
  type AgentFetch,
  bindRemoteDialChain,
  buildAgents,
  derivedRemoteRunTraceId,
  REMOTE_BUDGET_RECEIPT_EVENT,
  type RemoteBudgetContractCaps,
  type RemoteRunFact,
  remoteDialChainCounts,
  resolveRemoteDialChain,
  setRemoteBudgetContractResolver,
  setRemoteRunBudgetGate,
  setRemoteRunObserver,
  standingRoleMessage,
} from "../src/copilot";

/** Let the fire-and-forget settlement and recorder work land before assertions read it. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

/** The deployment token both ends hold: the endpoint's MAC key and this server's check. */
const SECRET = "synthetic-managed-token";
/** The policy's approved per-run token ceiling; the hold and the caps both derive from it. */
const POLICY_TOKENS = 1_000_000n;
const MAX_MODEL_STEPS = 8;
const ENDPOINT = "https://risk.test/ag-ui";
const CAPS = remoteBudgetCaps(
  POLICY_TOKENS,
  MAX_MODEL_STEPS,
) as RemoteBudgetContractCaps;

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
  endpoint: ENDPOINT,
  headers: { "x-openbot-agent-token": SECRET },
  standingMessage: standingRoleMessage(riskRow),
});

type Dial = {
  url: string;
  headers: Record<string, string>;
  body: RunAgentInput;
};

/** The R4-01 derivation, re-derived by hand: sha256 over the domain-separated identity. */
function derivedTraceIdOf(botId: string, runId: string): string {
  return createHash("sha256")
    .update(`openbot.remote.run:${botId}:${runId}`)
    .digest("hex")
    .slice(0, 32);
}

/** The W3C coordinates a traceparent names, or null when it names nothing. */
function traceparentOf(
  header: string | undefined,
): { traceId: string; spanId: string } | null {
  if (!header) return null;
  const parts = header.split("-");
  if (parts.length !== 4 || parts[0] !== "00") return null;
  if (!/^[0-9a-f]{32}$/.test(parts[1]) || !/^[0-9a-f]{16}$/.test(parts[2]))
    return null;
  return { traceId: parts[1], spanId: parts[2] };
}

/**
 * A scripted AG-UI endpoint in the fetch seam: no socket, no port, the exact `Response` the
 * transport would have been handed, remembering every dial's headers and body.
 */
function scriptedEndpoint() {
  const dials: Dial[] = [];
  const fetch: AgentFetch = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = JSON.parse(
      typeof init.body === "string" ? init.body : "{}",
    ) as RunAgentInput;
    dials.push({ url: String(url), headers, body });
    const encoder = new TextEncoder();
    const receipt = {
      kind: REMOTE_BUDGET_RECEIPT_EVENT,
      v: 1,
      runId: body.runId,
      caps: CAPS,
      usage: {
        modelSteps: 1,
        inputTokens: 400,
        outputTokens: 40,
        totalTokens: 440,
      },
      status: "ok" as const,
    };
    const mac = createHmac("sha256", SECRET)
      .update(
        [
          "openbot-budget-receipt",
          "v=1",
          `runId=${body.runId}`,
          `caps=${CAPS.modelSteps}|${CAPS.inputTokens}|${CAPS.outputTokens}|${CAPS.totalTokens}`,
          `usage=1|400|40|440`,
          `status=ok`,
        ].join("\n"),
      )
      .digest("hex");
    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: body.threadId,
        runId: body.runId,
      } as BaseEvent,
      {
        type: "CUSTOM",
        name: REMOTE_BUDGET_RECEIPT_EVENT,
        value: { ...receipt, mac },
      } as unknown as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: body.threadId,
        runId: body.runId,
      } as BaseEvent,
    ];
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

/** The real budget seams with the billing writer as a recording stand-in (as the dial suite). */
function budgetHarness() {
  const creditWriter = {
    async reserveCredits() {
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
      insufficient: (input) =>
        new Error(`credits_exhausted: ${input.payerKind}`),
    },
  });
  const resolver = createRemoteBudgetContractResolver({
    endpoints: new Set([canonicalRemoteEndpoint(ENDPOINT) as string]),
    sharedSecret: SECRET,
    maximumTokens: POLICY_TOKENS,
    maxModelSteps: MAX_MODEL_STEPS,
  });
  return { gate, resolver };
}

/** The binding store as an in-memory stand-in, keyed the way the real one is. */
function fakeBindingStore() {
  const begun: BeginRunBindingInput[] = [];
  const finished: { runId: string; state: string }[] = [];
  const rows = new Map<string, RunBinding>();
  return {
    begun,
    finished,
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
      attemptId: string,
      opikTraceId: string,
    ) {
      const row = rows.get(`${scope.key}:${runId}:${attemptId}`);
      if (row) row.opikTraceId = opikTraceId;
      return { binding: row!, adopted: true };
    },
    async finish(
      scope: ObservationScope,
      runId: string,
      attemptId: string,
      state: string,
    ) {
      finished.push({ runId, state });
      return {
        binding: rows.get(`${scope.key}:${runId}:${attemptId}`) ?? null,
        settled: true,
      };
    },
  };
}

/** The verified port as a recording stand-in: every materialization call, answered ok. */
function fakePort() {
  const port = {
    async createTrace(_scope: unknown, input: { traceId: string }) {
      return { outcome: "ok" as const, value: { id: input.traceId } };
    },
    async writeSpans(
      _scope: unknown,
      _input: { spans: OpikOtlpSpan[]; binding?: OpikRunBindingRef },
    ) {
      return { outcome: "ok" as const, value: { accepted: true as const } };
    },
  };
  return { port: port as unknown as OpikPort };
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

async function buildRemoteBot(
  fetch: AgentFetch,
  threadingScope: ObservationScope,
) {
  const harness = budgetHarness();
  setRemoteRunBudgetGate(harness.gate);
  setRemoteBudgetContractResolver(harness.resolver);
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
      {
        actorId: threadingScope.actorId,
        botId: "risk",
        resolveScope: () => Promise.resolve(threadingScope),
      },
    );
  } finally {
    setRemoteRunBudgetGate(undefined);
    setRemoteBudgetContractResolver(undefined);
  }
}

const scope = () =>
  resolveObservationScope({
    actorId: "person-1",
    botId: "risk",
    ownership: "owner",
    epoch: 1,
  });

test("detached scheduling dials under the run's derived chain — every dial, both identity paths", async () => {
  const { fetch, dials } = scriptedEndpoint();
  const facts: RemoteRunFact[] = [];
  const store = fakeBindingStore();
  const { port } = fakePort();
  const recorder = createRemoteRunRecorder({
    bindings: store,
    port: () => port,
  });
  const { spans, stop } = recordedSpans();
  const countsBefore = remoteDialChainCounts();
  setRemoteRunObserver((fact) => {
    facts.push(fact);
    recorder.record(fact);
  });
  try {
    const agents = await buildRemoteBot(fetch, scope());
    const agent = agents.risk;
    if (!agent) throw new Error("buildAgents returned no remote agent");
    agent.threadId = "chain-thread";

    /*
     * DETACHED, on purpose: a timer hop out of a context with no span in it, which is the
     * shape the Intelligence runner's Phoenix callback leaves the run in. If the chain still
     * depended on the ambient store surviving, these dials would carry nothing.
     */
    const surfaceRunIds = ["run-aaa", "run-bbb", "run-ccc"];
    for (const runId of surfaceRunIds) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await agent.runAgent({ runId }, { onEvent: () => {} });
    }
    // The client-derived identity path: no run id given, the AG-UI client generates one
    // (exactly what the runtime's thread-name generations do).
    await new Promise((resolve) => setTimeout(resolve, 1));
    await agent.runAgent({}, { onEvent: () => {} });
    await flush();

    expect(dials).toHaveLength(4);

    // 100% of the dials carry a well-formed traceparent naming the DERIVED trace of THEIR
    // own run — recomputed here from the identity, not read back from the implementation.
    const dialSpans = new Map(
      spans.map((span) => [span.spanContext().spanId, span]),
    );
    for (const dial of dials) {
      const parent = traceparentOf(dial.headers.traceparent);
      expect(parent).not.toBeNull();
      const expected = derivedTraceIdOf("risk", dial.body.runId ?? "");
      expect(parent!.traceId).toBe(expected);
      // The parent names a REAL span this middleware started and exported — never an id
      // nobody owns.
      const span = dialSpans.get(parent!.spanId);
      expect(span).toBeDefined();
      expect(span!.name).toBe("remote run");
      expect(span!.spanContext().traceId).toBe(expected);
    }

    // Every derived run id is one of the surface-supplied ids or a client-derived uuid.
    const dialedRunIds = dials.map((dial) => dial.body.runId ?? "");
    expect(dialedRunIds.slice(0, 3)).toEqual(surfaceRunIds);
    expect(dialedRunIds[3]).not.toBe("");
    expect(dialedRunIds[3]).toMatch(/^[0-9a-f-]{36}$/);

    // The dial span parents under the run-root id the binding derives for that trace, so the
    // exported tree and the governance tree name one root.
    for (const dial of dials) {
      const parent = traceparentOf(dial.headers.traceparent)!;
      const span = dialSpans.get(parent.spanId)!;
      const expected = derivedTraceIdOf("risk", dial.body.runId ?? "");
      expect(span.parentSpanContext?.spanId).toBe(
        runUpstreamIdentity(expected).rootSpanId,
      );
      expect(span.attributes["openbot.bot.id"]).toBe("risk");
      expect(span.attributes["openbot.run.id"]).toBe(dial.body.runId);
      expect(span.attributes["openbot.dial.chain"]).toBe("derived");
    }

    // The record and the binding claim the SAME chain the dial carried — the 6/9 gap closed:
    // a detached run no longer records nothing.
    expect(facts).toHaveLength(4);
    for (const fact of facts) {
      expect(fact.traceId).toBe(derivedTraceIdOf("risk", fact.runId));
    }
    expect(store.begun).toHaveLength(4);
    for (const begun of store.begun) {
      expect(begun.traceId).toBe(derivedTraceIdOf("risk", begun.runId));
    }
    expect(store.finished).toHaveLength(4);

    // The counts make the binding visible: four derived dials, nothing else.
    const counts = remoteDialChainCounts();
    expect(counts.derived - countsBefore.derived).toBe(4);
    expect(counts.ambient - countsBefore.ambient).toBe(0);
    expect(counts.unavailable - countsBefore.unavailable).toBe(0);
  } finally {
    setRemoteRunObserver(undefined);
    await stop();
  }
});

test("inline scheduling keeps dialling under the ambient span — the parent it always had", async () => {
  const { fetch, dials } = scriptedEndpoint();
  const facts: RemoteRunFact[] = [];
  const store = fakeBindingStore();
  const { port } = fakePort();
  const recorder = createRemoteRunRecorder({
    bindings: store,
    port: () => port,
  });
  const { spans, stop } = recordedSpans();
  const countsBefore = remoteDialChainCounts();
  setRemoteRunObserver((fact) => {
    facts.push(fact);
    recorder.record(fact);
  });
  try {
    const agents = await buildRemoteBot(fetch, scope());
    const agent = agents.risk;
    if (!agent) throw new Error("buildAgents returned no remote agent");
    agent.threadId = "ambient-thread";

    const runSpan = trace
      .getTracer("remote-dial-chain-test")
      .startSpan("the request span");
    const chain = runSpan.spanContext();
    await context.with(trace.setSpan(context.active(), runSpan), () =>
      agent.runAgent({ runId: "run-inline" }, { onEvent: () => {} }),
    );
    runSpan.end();
    await flush();

    // The dial continues the ambient span exactly — same trace, same parent, unchanged by
    // this fix — and no `remote run` span was invented for it.
    expect(dials).toHaveLength(1);
    expect(dials[0].headers.traceparent).toBe(
      `00-${chain.traceId}-${chain.spanId}-01`,
    );
    expect(spans.map((span) => span.name)).toEqual(["the request span"]);

    // The record and the binding still claim the ambient chain, as before.
    expect(facts).toHaveLength(1);
    expect(facts[0].traceId).toBe(chain.traceId);
    expect(store.begun[0]).toMatchObject({
      runId: "run-inline",
      traceId: chain.traceId,
    });

    const counts = remoteDialChainCounts();
    expect(counts.ambient - countsBefore.ambient).toBe(1);
    expect(counts.derived - countsBefore.derived).toBe(0);
  } finally {
    setRemoteRunObserver(undefined);
    await stop();
  }
});

test("a mixed window joins at 100% — ambient and derived dials side by side", async () => {
  const { fetch, dials } = scriptedEndpoint();
  const facts: RemoteRunFact[] = [];
  const store = fakeBindingStore();
  const { port } = fakePort();
  const recorder = createRemoteRunRecorder({
    bindings: store,
    port: () => port,
  });
  const { spans, stop } = recordedSpans();
  setRemoteRunObserver((fact) => {
    facts.push(fact);
    recorder.record(fact);
  });
  try {
    const agents = await buildRemoteBot(fetch, scope());
    const agent = agents.risk;
    if (!agent) throw new Error("buildAgents returned no remote agent");
    agent.threadId = "mixed-thread";

    // Two inline runs, each under its own span, and two detached runs — the shape of the F7E
    // window, with the lucky half and the broken half in it together.
    const ambientSpans: string[] = [];
    for (const runId of ["run-in-1", "run-in-2"]) {
      const runSpan = trace
        .getTracer("remote-dial-chain-test")
        .startSpan(`span ${runId}`);
      ambientSpans.push(runSpan.spanContext().spanId);
      await context.with(trace.setSpan(context.active(), runSpan), () =>
        agent.runAgent({ runId }, { onEvent: () => {} }),
      );
      runSpan.end();
    }
    for (const runId of ["run-out-1", "run-out-2"]) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await agent.runAgent({ runId }, { onEvent: () => {} });
    }
    await flush();

    expect(dials).toHaveLength(4);
    const dialSpanIds = new Set(spans.map((span) => span.spanContext().spanId));
    for (const dial of dials) {
      const parent = traceparentOf(dial.headers.traceparent);
      expect(parent).not.toBeNull();
      if (ambientSpans.includes(parent!.spanId)) {
        // The inline half: the ambient parent itself.
        expect(dial.body.runId).toMatch(/^run-in-/);
      } else {
        // The detached half: the derived chain of its own run, parented by a real span.
        expect(dial.body.runId).toMatch(/^run-out-/);
        expect(parent!.traceId).toBe(
          derivedTraceIdOf("risk", dial.body.runId!),
        );
        expect(dialSpanIds.has(parent!.spanId)).toBe(true);
      }
    }
    // Every run recorded, every binding begun — no half of the window is dark.
    expect(facts).toHaveLength(4);
    expect(store.begun).toHaveLength(4);
  } finally {
    setRemoteRunObserver(undefined);
    await stop();
  }
});

test("a run with no identity and no context degrades visibly — no header is invented", () => {
  const countsBefore = remoteDialChainCounts();

  // The decision itself: nothing ambient, nothing to derive from.
  const chain = resolveRemoteDialChain("risk", "");
  expect(chain).toEqual({ origin: "unavailable", traceId: null });

  // The binding: no context is bound, so the production fetch — which reads whatever is
  // active and synthesizes nothing — carries no `traceparent`, exactly as before this fix.
  // The degradation is COUNTED, so a window that produced it reads off the counters rather
  // than being discovered by finding an orphan trace upstream.
  const bound = bindRemoteDialChain(chain, "risk", "");
  expect(bound.context).toBeUndefined();
  expect(injectTraceHeaders({})).toEqual({});
  const counts = remoteDialChainCounts();
  expect(counts.unavailable - countsBefore.unavailable).toBe(1);
});

test("with no tracer provider, a derived dial still names the run's chain", () => {
  trace.disable();
  const chain = resolveRemoteDialChain("risk", "run-untraced");
  expect(chain.origin).toBe("derived");

  /*
   * The provider is gone, so the SDK would hand the dial a no-op span with no ids. The
   * binding must not let the header vanish with it: the context still carries the derived
   * trace, parented under the run-root id the binding store derives — the span of this
   * chain this deployment writes through its own materialization, not the OTEL pipeline.
   */
  const bound = bindRemoteDialChain(chain, "risk", "run-untraced");
  expect(bound.context).toBeDefined();
  const injected = context.with(bound.context!, () => injectTraceHeaders({}));
  const parent = traceparentOf(injected.traceparent);
  expect(parent).not.toBeNull();
  expect(parent!.traceId).toBe(derivedTraceIdOf("risk", "run-untraced"));
  expect(parent!.spanId).toBe(
    runUpstreamIdentity(derivedTraceIdOf("risk", "run-untraced")).rootSpanId,
  );
  bound.close();
});

test("the derivation is idempotent per run and distinct across runs", () => {
  const a = derivedRemoteRunTraceId("risk", "run-same");
  expect(a).toBe(derivedTraceIdOf("risk", "run-same")); // the pinned formula
  expect(a).toBe(derivedRemoteRunTraceId("risk", "run-same")); // retry continues one chain
  expect(a).not.toBe(derivedRemoteRunTraceId("risk", "run-other"));
  expect(a).not.toBe(derivedRemoteRunTraceId("other", "run-same"));
  expect(a).toMatch(/^[0-9a-f]{32}$/);
  expect(a).not.toBe("0".repeat(32));
});
