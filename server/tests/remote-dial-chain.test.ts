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
import http from "node:http";
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
  derivedRemoteRunDialSpanId,
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

/**
 * The F9A dial-span derivation, re-derived by hand the same way: the dial span's OWN id,
 * deterministic per run, so a re-dial names the same span instead of minting a new one.
 */
function derivedDialSpanIdOf(botId: string, runId: string): string {
  return createHash("sha256")
    .update(`openbot.remote.run.dial:${botId}:${runId}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * The OTLP anchor sink (F9A): the raw channel a derived chain's root and dial spans ride,
 * captured the way the real collector would receive them — an HTTP endpoint parsing the
 * OTLP/JSON body, no mock of the posting code. A raw node:http listener, the same
 * `scriptedProvider` shape the budget smoke suite dials, because this suite runs on the
 * Node target where Bun.serve is only a compatibility shim.
 */
function anchorSink() {
  const posted: Array<{
    spans: Array<{
      traceId: string;
      spanId: string;
      parentSpanId?: string;
      name: string;
    }>;
  }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        resourceSpans?: Array<{
          scopeSpans?: Array<{
            spans?: Array<{
              traceId: string;
              spanId: string;
              parentSpanId?: string;
              name: string;
            }>;
          }>;
        }>;
      };
      posted.push({
        spans: (body.resourceSpans ?? []).flatMap((rs) =>
          (rs.scopeSpans ?? []).flatMap((ss) => ss.spans ?? []),
        ),
      });
      response.writeHead(200).end();
    });
  });
  const listening = new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  server.unref();
  return {
    posted,
    /** Resolves once the listener is bound; `url` is only meaningful after this. */
    ready: () => listening,
    get url() {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      return `http://127.0.0.1:${port}/v1/traces`;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Waits until the sink has collected at least `count` spans. */
async function flushedAnchors(
  sink: ReturnType<typeof anchorSink>,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (sink.posted.reduce((sum, post) => sum + post.spans.length, 0) >= count)
      return;
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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
  const reconciles: { runId: string; opikTraceId: string }[] = [];
  const rows = new Map<string, RunBinding>();
  return {
    begun,
    /** The upstream id each run's binding was reconciled to, by run id. */
    reconciledByRun: (runId: string) =>
      reconciles.find((entry) => entry.runId === runId)?.opikTraceId ?? null,
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
      reconciles.push({ runId, opikTraceId });
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
  const createdTraces: Array<{ traceId: string; binding?: OpikRunBindingRef }> =
    [];
  const writtenSpans: Array<{
    spans: OpikOtlpSpan[];
    binding?: OpikRunBindingRef;
  }> = [];
  const port = {
    async createTrace(
      _scope: unknown,
      input: {
        traceId: string;
        binding?: OpikRunBindingRef;
      },
    ) {
      createdTraces.push({ traceId: input.traceId, binding: input.binding });
      return { outcome: "ok" as const, value: { id: input.traceId } };
    },
    async writeSpans(
      _scope: unknown,
      input: { spans: OpikOtlpSpan[]; binding?: OpikRunBindingRef },
    ) {
      writtenSpans.push({ spans: input.spans, binding: input.binding });
      return { outcome: "ok" as const, value: { accepted: true as const } };
    },
  };
  return {
    port: port as unknown as OpikPort,
    createdTraces,
    writtenSpans,
  };
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
  const { port, createdTraces, writtenSpans } = fakePort();
  const recorder = createRemoteRunRecorder({
    bindings: store,
    port: () => port,
  });
  const { spans, stop } = recordedSpans();
  const sink = anchorSink();
  await sink.ready();
  const countsBefore = remoteDialChainCounts();
  // The anchors ride the deployment's OTLP endpoint; pointing it at the suite's sink is how
  // the raw channel is captured the way the real collector receives it.
  const envBefore = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = sink.url;
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
    await flushedAnchors(sink, 8);

    expect(dials).toHaveLength(4);

    // 100% of the dials carry a well-formed traceparent naming the DERIVED trace of THEIR
    // own run and the run's DETERMINISTIC dial span — both recomputed here from the
    // identity, not read back from the implementation.
    for (const dial of dials) {
      const parent = traceparentOf(dial.headers.traceparent);
      expect(parent).not.toBeNull();
      expect(parent!.traceId).toBe(
        derivedTraceIdOf("risk", dial.body.runId ?? ""),
      );
      expect(parent!.spanId).toBe(
        derivedDialSpanIdOf("risk", dial.body.runId ?? ""),
      );
    }

    // Every derived run id is one of the surface-supplied ids or a client-derived uuid.
    const dialedRunIds = dials.map((dial) => dial.body.runId ?? "");
    expect(dialedRunIds.slice(0, 3)).toEqual(surfaceRunIds);
    expect(dialedRunIds[3]).not.toBe("");
    expect(dialedRunIds[3]).toMatch(/^[0-9a-f-]{36}$/);

    /*
     * The two anchors every derived dial posts (F9A): the chain ROOT under the run-root id
     * the binding derives, and the DIAL SPAN parented at it — the two W3C spans the
     * endpoint's continuation tree resolves against, without which Opik 2.2.100 silently
     * drops the whole chain (the F8D-1 mechanism). Asserted per dial, in the order the
     * spans appear in the post: root first, then the dial that names it.
     */
    const anchorSpans = sink.posted.flatMap((post) => post.spans);
    expect(anchorSpans).toHaveLength(8);
    for (const dial of dials) {
      const runId = dial.body.runId ?? "";
      const traceId = derivedTraceIdOf("risk", runId);
      const root = anchorSpans.find(
        (span) =>
          span.traceId === traceId &&
          span.spanId === runUpstreamIdentity(traceId).rootSpanId,
      );
      expect(root).toBeDefined();
      expect(root!.name).toBe("run");
      expect(root!.parentSpanId).toBeUndefined();
      const dialAnchor = anchorSpans.find(
        (span) =>
          span.traceId === traceId &&
          span.spanId === derivedDialSpanIdOf("risk", runId),
      );
      expect(dialAnchor).toBeDefined();
      expect(dialAnchor!.name).toBe("remote run");
      expect(dialAnchor!.parentSpanId).toBe(
        runUpstreamIdentity(traceId).rootSpanId,
      );
    }

    // The SDK no longer starts a span for the dial: the generic pipeline carries nothing of
    // this chain (its export would be dropped by the backend's parent rule anyway).
    expect(spans.filter((span) => span.name === "remote run")).toHaveLength(0);

    /*
     * The record and the binding claim the SAME chain the dial carried — the 6/9 gap closed:
     * a detached run no longer records nothing. And the fact carries the dial span (F9A),
     * with the deterministic id and a real window.
     */
    expect(facts).toHaveLength(4);
    for (const fact of facts) {
      expect(fact.traceId).toBe(derivedTraceIdOf("risk", fact.runId));
      expect(fact.dial).not.toBeNull();
      expect(fact.dial!.spanId).toBe(derivedDialSpanIdOf("risk", fact.runId));
      expect(fact.dial!.startedAt.getTime()).toBeLessThanOrEqual(
        fact.dial!.endedAt.getTime(),
      );
    }
    expect(store.begun).toHaveLength(4);
    for (const begun of store.begun) {
      expect(begun.traceId).toBe(derivedTraceIdOf("risk", begun.runId));
    }
    expect(store.finished).toHaveLength(4);

    /*
     * THE SAME-SOURCE PIN (F8D-1's "binding.opik_trace_id ≠ 拨号派生 id" as it actually
     * decomposed): the binding's upstream trace, the materialized dial span and the dial's
     * derived chain are ONE derivation — `runUpstreamIdentity(derivedTraceId)`, recomputed
     * by hand here. The F8D evidence compared the binding's opik UUID against the dial's
     * W3C hex and read a divergence; the two id domains are bridged by exactly this
     * derivation, and these assertions refuse any second one.
     */
    for (const runId of dialedRunIds) {
      const traceId = derivedTraceIdOf("risk", runId);
      const identity = runUpstreamIdentity(traceId);
      const reconciled = store.reconciledByRun(runId);
      expect(reconciled).toBe(identity.opikTraceId);
      const created = createdTraces.find(
        (trace) => trace.traceId === identity.opikTraceId,
      );
      expect(created).toBeDefined();
      const dialWrite = writtenSpans.find((write) =>
        write.spans.some(
          (span) => span.spanId === derivedDialSpanIdOf("risk", runId),
        ),
      );
      expect(dialWrite).toBeDefined();
      expect(dialWrite!.binding?.opikTraceId).toBe(identity.opikTraceId);
      const dialSpan = dialWrite!.spans.find(
        (span) => span.spanId === derivedDialSpanIdOf("risk", runId),
      )!;
      expect(dialSpan.traceId).toBe(traceId);
      expect(dialSpan.name).toEqual({ state: "projected", text: "remote run" });
      expect(dialSpan.parentSpanId).toBe(identity.rootSpanId);
    }

    // The counts make the binding visible: four derived dials, nothing else.
    const counts = remoteDialChainCounts();
    expect(counts.derived - countsBefore.derived).toBe(4);
    expect(counts.ambient - countsBefore.ambient).toBe(0);
    expect(counts.unavailable - countsBefore.unavailable).toBe(0);
  } finally {
    setRemoteRunObserver(undefined);
    if (envBefore === undefined)
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = envBefore;
    sink.stop();
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

    // The record and the binding still claim the ambient chain, as before — and the fact
    // carries NO dial span: the ambient pipeline already owns the dial's parent, so the
    // governed record keeps exactly the shape it had (F9A scopes the dial span to derived
    // chains, where no ambient parent exists to resolve).
    expect(facts).toHaveLength(1);
    expect(facts[0].traceId).toBe(chain.traceId);
    expect(facts[0].dial).toBeNull();
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
  // The SDK starts no span for a dial anymore (F9A), so this window's provider only has to
  // exist for the ambient runs' spans — nothing of it is read here.
  const { stop } = recordedSpans();
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
    for (const dial of dials) {
      const parent = traceparentOf(dial.headers.traceparent);
      expect(parent).not.toBeNull();
      if (ambientSpans.includes(parent!.spanId)) {
        // The inline half: the ambient parent itself.
        expect(dial.body.runId).toMatch(/^run-in-/);
      } else {
        // The detached half: the derived chain of its own run, parented by its own
        // deterministic dial span (F9A) — every dial, whichever half of the window it
        // came from.
        expect(dial.body.runId).toMatch(/^run-out-/);
        expect(parent!.traceId).toBe(
          derivedTraceIdOf("risk", dial.body.runId!),
        );
        expect(parent!.spanId).toBe(
          derivedDialSpanIdOf("risk", dial.body.runId!),
        );
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
  expect(bound.dial).toBeNull();
  expect(injectTraceHeaders({})).toEqual({});
  const counts = remoteDialChainCounts();
  expect(counts.unavailable - countsBefore.unavailable).toBe(1);
});

test("with no tracer provider, a derived dial still names the run's chain", () => {
  trace.disable();
  const chain = resolveRemoteDialChain("risk", "run-untraced");
  expect(chain.origin).toBe("derived");

  /*
   * The provider is gone — and F9A made the dial span independent of one: the context is a
   * non-recording span with the run's DERIVED trace and DETERMINISTIC dial span id, so the
   * header cannot vanish with the pipeline (the F8A belt for a no-op SDK span, now the
   * design itself). Nothing anchors and nothing exports; the header still names the chain.
   */
  const bound = bindRemoteDialChain(chain, "risk", "run-untraced");
  expect(bound.context).toBeDefined();
  const injected = context.with(bound.context!, () => injectTraceHeaders({}));
  const parent = traceparentOf(injected.traceparent);
  expect(parent).not.toBeNull();
  expect(parent!.traceId).toBe(derivedTraceIdOf("risk", "run-untraced"));
  expect(parent!.spanId).toBe(derivedDialSpanIdOf("risk", "run-untraced"));
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

  // The dial span's own id (F9A): same discipline, span-id shape — a re-dial re-derives the
  // SAME span, and no two runs share one.
  const d = derivedRemoteRunDialSpanId("risk", "run-same");
  expect(d).toBe(derivedDialSpanIdOf("risk", "run-same"));
  expect(d).toBe(derivedRemoteRunDialSpanId("risk", "run-same"));
  expect(d).not.toBe(derivedRemoteRunDialSpanId("risk", "run-other"));
  expect(d).not.toBe(derivedRemoteRunDialSpanId("other", "run-same"));
  expect(d).toMatch(/^[0-9a-f]{16}$/);
  expect(d).not.toBe("0".repeat(16));
  // And the two derivations of one run stay distinct from each other.
  expect(d).not.toBe(derivedTraceIdOf("risk", "run-same").slice(0, 16));
});
