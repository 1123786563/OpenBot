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
// "mostly joined" window is precisely what R4 rejected. Since r8fix-e (T-J #2) the chain is
// derived from the SERVER-ISSUED attempt id, not the wire runId: the production pins assert
// distinctness and same-source consistency across dial/anchors/fact/binding, and the
// derivation formula stays re-derived hand-written (as `signReceipt` is in the budget suite).

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
  type RemoteRunRecordInput,
  remoteBudgetCaps,
} from "../src/ai-observability/remote-run";
import { nanos } from "../src/ai-observability/span-support";
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

/** The R4-01 derivation, re-derived by hand: sha256 over the domain-separated ATTEMPT id. */
function derivedTraceIdOf(botId: string, attemptId: string): string {
  return createHash("sha256")
    .update(`openbot.remote.run:${botId}:${attemptId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * The F9A dial-span derivation, re-derived by hand the same way: the dial span's OWN id,
 * deterministic per attempt, so a re-dial names the same span instead of minting a new one.
 */
function derivedDialSpanIdOf(botId: string, attemptId: string): string {
  return createHash("sha256")
    .update(`openbot.remote.run.dial:${botId}:${attemptId}`)
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
    headers: Record<string, string | string[] | undefined>;
    serviceName: string | undefined;
    spans: Array<{
      traceId: string;
      spanId: string;
      parentSpanId?: string;
      name: string;
      startTimeUnixNano?: string;
      endTimeUnixNano?: string;
      runIdAttribute: string | undefined;
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
          resource?: {
            attributes?: Array<{ key: string; value?: { stringValue?: string } }>;
          };
          scopeSpans?: Array<{
            spans?: Array<{
              traceId: string;
              spanId: string;
              parentSpanId?: string;
              name: string;
              startTimeUnixNano?: string;
              endTimeUnixNano?: string;
              attributes?: Array<{
                key: string;
                value?: { stringValue?: string };
              }>;
            }>;
          }>;
        }>;
      };
      posted.push({
        headers: request.headers,
        serviceName: (body.resourceSpans ?? []).flatMap((rs) =>
          (rs.resource?.attributes ?? []).map(
            (attribute) => attribute.value?.stringValue,
          ),
        )[0],
        spans: (body.resourceSpans ?? []).flatMap((rs) =>
          (rs.scopeSpans ?? []).flatMap((ss) => ss.spans ?? []),
        ).map((span) => ({
          ...span,
          runIdAttribute: span.attributes?.find(
            (attribute) => attribute.key === "openbot.run.id",
          )?.value?.stringValue,
        })),
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
    // The receipt reports the BUDGET CONTRACT's run id — exactly what the real endpoint
    // does (agent-langgraph readBudgetContract → the receipt's echo) — so the MAC covers
    // the id the contract carried, not the wire's top-level spelling of it.
    const budgetRunId =
      (
        body.forwardedProps as
          | { openbotBudget?: { runId?: string } }
          | undefined
      )?.openbotBudget?.runId ?? body.runId;
    const receipt = {
      kind: REMOTE_BUDGET_RECEIPT_EVENT,
      v: 1,
      runId: budgetRunId,
      caps: CAPS,
      usage: {
        modelSteps: 1,
        inputTokens: 400,
        outputTokens: 40,
        totalTokens: 440,
      },
      status: "ok" as const,
    };
    // Purpose-derived key (OCR R5 handoff): HMAC(secret, label), same pin as the
    // other budget suites — the raw token also travels as the Bearer credential.
    const macKey = createHmac("sha256", SECRET)
      .update("openbot-budget-receipt-mac-v1")
      .digest("hex");
    const mac = createHmac("sha256", macKey)
      .update(
        [
          "openbot-budget-receipt",
          "v=1",
          `runId=${budgetRunId}`,
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
  const reconciles: { runId: string; attemptId: string; opikTraceId: string }[] =
    [];
  const rows = new Map<string, RunBinding>();
  return {
    begun,
    /** The upstream id one attempt's binding was reconciled to — runs share run ids. */
    reconciledByAttempt: (attemptId: string) =>
      reconciles.find((entry) => entry.attemptId === attemptId)?.opikTraceId ??
      null,
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
      reconciles.push({ runId, attemptId, opikTraceId });
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
    // Eight anchors open at bind, the same eight closed at finalize (L-H: the run's
    // close re-posts its two spans with the window's end).
    await flushedAnchors(sink, 16);

    expect(dials).toHaveLength(4);

    // 100% of the dials carry a well-formed traceparent. The chain is now derived from the
    // SERVER-ISSUED attempt id (T-J #2), which the wire cannot name, so the pin is the
    // contract itself: four attempts name four DISTINCT traces, and each dial's dial-span
    // and trace agree with the attempt's observed fact below.
    for (const dial of dials) {
      const parent = traceparentOf(dial.headers.traceparent);
      expect(parent).not.toBeNull();
    }
    const dialedTraceIds = dials.map(
      (dial) => traceparentOf(dial.headers.traceparent)!.traceId,
    );
    expect(new Set(dialedTraceIds).size).toBe(dials.length);

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
    // Two per dial at bind, the same two again at close (L-H).
    expect(anchorSpans).toHaveLength(16);
    const dialSpanIdByTrace = new Map(
      dials.map((dial) => {
        const parent = traceparentOf(dial.headers.traceparent)!;
        return [parent.traceId, parent.spanId];
      }),
    );
    for (const traceId of dialedTraceIds) {
      const root = anchorSpans.find(
        (span) =>
          span.traceId === traceId &&
          span.spanId === runUpstreamIdentity(traceId).rootSpanId,
      );
      expect(root).toBeDefined();
      expect(root!.name).toBe("run");
      expect(root!.parentSpanId).toBeUndefined();
      // The dial anchor's span id IS the dial's traceparent parent: the one span the
      // endpoint's continuation names.
      const dialAnchor = anchorSpans.find(
        (span) =>
          span.traceId === traceId &&
          span.spanId === dialSpanIdByTrace.get(traceId),
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
     * with the attempt-deterministic id and a real window — the dial's traceparent span id,
     * re-read through the attempt's own fact.
     */
    expect(facts).toHaveLength(4);
    for (const fact of facts) {
      expect(fact.traceId).not.toBeNull();
      expect(dialedTraceIds).toContain(fact.traceId);
      expect(fact.dial).not.toBeNull();
      expect(fact.dial!.spanId).toBe(dialSpanIdByTrace.get(fact.traceId!));
      expect(fact.dial!.startedAt.getTime()).toBeLessThanOrEqual(
        fact.dial!.endedAt.getTime(),
      );
    }
    // One attempt = one nonce: the four runs' attempts are distinct, run ids aside.
    expect(new Set(facts.map((fact) => fact.attemptId)).size).toBe(4);
    expect(store.begun).toHaveLength(4);
    for (const begun of store.begun) {
      const fact = facts.find(
        (candidate) => candidate.attemptId === begun.attemptId,
      );
      expect(fact).toBeDefined();
      expect(begun.traceId).toBe(fact!.traceId);
    }
    expect(store.finished).toHaveLength(4);

    /*
     * THE SAME-SOURCE PIN (F8D-1's "binding.opik_trace_id ≠ 拨号派生 id" as it actually
     * decomposed): the binding's upstream trace, the materialized dial span and the dial's
     * derived chain are ONE derivation — `runUpstreamIdentity(traceId)` — and the attempt's
     * fact, binding and reconcile all name the same attempt id. The F8D evidence compared
     * the binding's opik UUID against the dial's W3C hex and read a divergence; the two id
     * domains are bridged by exactly this derivation, and these assertions refuse any
     * second one.
     */
    for (const fact of facts) {
      const traceId = fact.traceId!;
      const identity = runUpstreamIdentity(traceId);
      const reconciled = store.reconciledByAttempt(fact.attemptId);
      expect(reconciled).toBe(identity.opikTraceId);
      const created = createdTraces.find(
        (trace) => trace.traceId === identity.opikTraceId,
      );
      expect(created).toBeDefined();
      const dialWrite = writtenSpans.find((write) =>
        write.spans.some((span) => span.spanId === fact.dial!.spanId),
      );
      expect(dialWrite).toBeDefined();
      expect(dialWrite!.binding?.opikTraceId).toBe(identity.opikTraceId);
      const dialSpan = dialWrite!.spans.find(
        (span) => span.spanId === fact.dial!.spanId,
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
    const derivedChains: { traceId: string; spanId: string }[] = [];
    for (const dial of dials) {
      const parent = traceparentOf(dial.headers.traceparent);
      expect(parent).not.toBeNull();
      if (ambientSpans.includes(parent!.spanId)) {
        // The inline half: the ambient parent itself.
        expect(dial.body.runId).toMatch(/^run-in-/);
      } else {
        // The detached half: the chain of its own attempt, parented by its own
        // attempt-deterministic dial span (F9A) — distinct per attempt (T-J #2), and
        // re-asserted below through the attempt's observed fact.
        expect(dial.body.runId).toMatch(/^run-out-/);
        derivedChains.push(parent!);
      }
    }
    expect(derivedChains).toHaveLength(2);
    expect(derivedChains[0]!.traceId).not.toBe(derivedChains[1]!.traceId);
    // Every run recorded, every binding begun — no half of the window is dark — and each
    // detached fact names its attempt's own chain.
    expect(facts).toHaveLength(4);
    expect(store.begun).toHaveLength(4);
    for (const chain of derivedChains) {
      const fact = facts.find(
        (candidate) =>
          candidate.traceId === chain.traceId &&
          candidate.dial?.spanId === chain.spanId,
      );
      expect(fact).toBeDefined();
    }
  } finally {
    setRemoteRunObserver(undefined);
    await stop();
  }
});

/*
 * OCR delta T-J #2 (r8fix-e): the wire runId is INPUT, and two independent runs that reuse
 * one runId must not merge into one trace tree — the same threat model the budget gate
 * already answers with a server-side nonce (each subscription its own admission). The
 * derivation domain is therefore the SERVER-ISSUED attempt identity: two attempts of one
 * run root separate chains, each complete on its own, while a re-dial of ONE attempt
 * re-derives that attempt's chain (the nonce is stable per attempt).
 */
test("two runs reusing one wire runId root separate chains — one attempt's re-dial keeps its own", async () => {
  // The pure pin: the attempt identity, not the wire runId, separates chains.
  const chainA = resolveRemoteDialChain("risk", "run-dup", "attempt-aaa");
  const chainB = resolveRemoteDialChain("risk", "run-dup", "attempt-bbb");
  expect(chainA.origin).toBe("derived");
  expect(chainB.origin).toBe("derived");
  expect(chainA.traceId).not.toBe(chainB.traceId);
  // A re-dial of the SAME attempt re-derives the same chain — real re-dial idempotency.
  expect(resolveRemoteDialChain("risk", "run-dup", "attempt-aaa").traceId).toBe(
    chainA.traceId,
  );
  expect(chainA.traceId).toMatch(/^[0-9a-f]{32}$/);

  // End to end: two subscriptions reusing one runId dial, record and bind SEPARATE chains.
  const { fetch, dials } = scriptedEndpoint();
  const facts: RemoteRunFact[] = [];
  const store = fakeBindingStore();
  const { port } = fakePort();
  const recorder = createRemoteRunRecorder({
    bindings: store,
    port: () => port,
  });
  const { stop } = recordedSpans();
  const sink = anchorSink();
  await sink.ready();
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
    agent.threadId = "dup-thread";
    await agent.runAgent({ runId: "run-dup" }, { onEvent: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 1));
    await agent.runAgent({ runId: "run-dup" }, { onEvent: () => {} });
    await flush();
    await flushedAnchors(sink, 4);

    expect(dials).toHaveLength(2);
    const dialChains = dials.map((dial) =>
      traceparentOf(dial.headers.traceparent),
    );
    for (const parent of dialChains) expect(parent).not.toBeNull();
    // The reused runId does not merge the runs: two chains, each its own.
    expect(dialChains[0]!.traceId).not.toBe(dialChains[1]!.traceId);

    // Each run's whole window — anchors, fact, dial span, binding — names ITS OWN chain.
    expect(facts).toHaveLength(2);
    expect(store.begun).toHaveLength(2);
    const anchorSpans = sink.posted.flatMap((post) => post.spans);
    for (const fact of facts) {
      expect(fact.traceId).not.toBeNull();
      const parent = dialChains.find(
        (candidate) => candidate!.traceId === fact.traceId,
      );
      expect(parent).toBeDefined();
      expect(parent!.spanId).toBe(fact.dial!.spanId);
      expect(fact.dial!.startedAt.getTime()).toBeLessThanOrEqual(
        fact.dial!.endedAt.getTime(),
      );
      const root = runUpstreamIdentity(fact.traceId!).rootSpanId;
      const rootAnchor = anchorSpans.find(
        (span) => span.traceId === fact.traceId && span.spanId === root,
      );
      const dialAnchor = anchorSpans.find(
        (span) =>
          span.traceId === fact.traceId && span.spanId === fact.dial!.spanId,
      );
      expect(rootAnchor).toBeDefined();
      expect(dialAnchor).toBeDefined();
      expect(dialAnchor!.parentSpanId).toBe(root);
    }
    // The bindings are two rows — one per attempt — same run, distinct attempts and chains.
    const begunTraceIds = store.begun.map((begun) => begun.traceId);
    expect(new Set(begunTraceIds).size).toBe(2);
    expect(begunTraceIds).toContain(facts[0]!.traceId);
    expect(begunTraceIds).toContain(facts[1]!.traceId);
    expect(store.begun[0]!.attemptId).not.toBe(store.begun[1]!.attemptId);
  } finally {
    setRemoteRunObserver(undefined);
    if (envBefore === undefined)
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = envBefore;
    sink.stop();
    await stop();
  }
});

/*
 * OCR delta2c T-N#3: the budget contract's run id and the receipt check's expectation
 * must be ONE id seen the same way on both sides. The governed run normalizes the wire
 * runId once (the :4909 typeof+trim discipline); the receipt is checked against that
 * value, but the contract the dial carried used to hold the RAW wire value — so a run id
 * with surrounding whitespace, echoed back honestly by the endpoint, failed
 * `value.runId !== expected.runId` and the run was torn down with
 * REMOTE_RUN_BUDGET_CONTRACT_VIOLATION before its answer landed. A client whose only
 * fault was padding its own run id lost every run, loudly, pointing the blame at the
 * endpoint.
 */
test("a wire runId with surrounding whitespace runs to completion — the contract and the receipt check share one id", async () => {
  const { fetch } = scriptedEndpoint();
  const facts: RemoteRunFact[] = [];
  const store = fakeBindingStore();
  const { port } = fakePort();
  const recorder = createRemoteRunRecorder({ bindings: store, port: () => port });
  const { stop } = recordedSpans();
  const events: BaseEvent[] = [];
  setRemoteRunObserver((fact) => {
    facts.push(fact);
    recorder.record(fact);
  });
  try {
    const agents = await buildRemoteBot(fetch, scope());
    const agent = agents.risk;
    if (!agent) throw new Error("buildAgents returned no remote agent");
    agent.threadId = "padded-thread";
    await agent.runAgent(
      { runId: "  padded-run  " },
      { onEvent: ({ event }) => events.push(event) },
    );
    await flush();

    // The run reached its terminal: no contract violation tore the stream down.
    expect(
      events.filter((event) => event.type === EventType.RUN_FINISHED),
    ).toHaveLength(1);
    // The governed record holds the normalized id — display and gate input, trimmed.
    expect(facts).toHaveLength(1);
    expect(facts[0]!.runId).toBe("padded-run");
    expect(store.begun[0]).toMatchObject({ runId: "padded-run" });
  } finally {
    setRemoteRunObserver(undefined);
    await stop();
  }
});

/*
 * OCR delta2 L-H: the anchor pair a derived dial posts is not a pair of forever-open
 * spans. The bind post carries startTime only — the OTel SDK cannot close what it never
 * started, and no later batch ever re-sends these chosen ids — so before this fix every
 * derived dial left two permanently open spans in the default project. The run's
 * finalize posts the SAME two spans again, now carrying the dial window's end.
 */
test("the anchors opened at bind are closed at finalize — same ids, the window's end carried", async () => {
  const { fetch } = scriptedEndpoint();
  const facts: RemoteRunFact[] = [];
  const store = fakeBindingStore();
  const { port } = fakePort();
  const recorder = createRemoteRunRecorder({ bindings: store, port: () => port });
  const { stop } = recordedSpans();
  const sink = anchorSink();
  await sink.ready();
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
    agent.threadId = "close-thread";
    await new Promise((resolve) => setTimeout(resolve, 1)); // detached: the chain derives
    await agent.runAgent({ runId: "run-close" }, { onEvent: () => {} });
    await flush();
    // Two anchors at bind, the same two at close — four span bodies in all.
    await flushedAnchors(sink, 4);

    expect(facts).toHaveLength(1);
    const traceId = facts[0]!.traceId!;
    const root = runUpstreamIdentity(traceId).rootSpanId;
    const dialSpanId = facts[0]!.dial!.spanId;
    const anchorSpans = sink.posted.flatMap((post) => post.spans);
    expect(anchorSpans).toHaveLength(4);
    for (const spanId of [root, dialSpanId]) {
      const lives = anchorSpans.filter((span) => span.spanId === spanId);
      expect(lives).toHaveLength(2);
      const open = lives.find((span) => span.endTimeUnixNano === undefined);
      const closed = lives.find((span) => span.endTimeUnixNano !== undefined);
      expect(open).toBeDefined();
      expect(closed).toBeDefined();
      // Same span re-sent, not a new one: same trace, same name, same parent discipline.
      expect(closed!.traceId).toBe(traceId);
      expect(closed!.name).toBe(open!.name);
      expect(closed!.parentSpanId).toBe(open!.parentSpanId);
      // The close is a real close: at or after the start (compared as BigInt in
      // plain JS — the runner's numeric matchers take numbers only).
      expect(
        BigInt(closed!.endTimeUnixNano!) >= BigInt(closed!.startTimeUnixNano!),
      ).toBe(true);
    }
  } finally {
    setRemoteRunObserver(undefined);
    if (envBefore === undefined)
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = envBefore;
    sink.stop();
    await stop();
  }
});

/*
 * OCR delta2b T-M#3 + delta2c T-N#4-sub: the anchor post must speak the exporter's own
 * dialect, or the anchors never land. Three pins in one post: the signal-level auth
 * headers the installed exporter reads (OTEL_EXPORTER_OTLP_TRACES_HEADERS, falling back
 * to OTEL_EXPORTER_OTLP_HEADERS exactly as the SDK does — before this fix the anchor post
 * read only the generic var, so a traces-authenticated collector refused the anchors and
 * the endpoint's continuation tree was silently dropped); the service name the SERVER
 * process registers (initProcessTracing("server") — one name for the whole trace tree,
 * where "openbot-server" split the run's spans across two services); and a bounded
 * openbot.run.id attribute (the wire runId is unbounded input; 256 is the same clamp
 * discipline tool call ids hold).
 */
test("the anchor post speaks the exporter's own dialect — traces-level headers, the server's service name, a bounded run id", async () => {
  const { fetch } = scriptedEndpoint();
  const store = fakeBindingStore();
  const { port } = fakePort();
  const recorder = createRemoteRunRecorder({ bindings: store, port: () => port });
  const { stop } = recordedSpans();
  const sink = anchorSink();
  await sink.ready();
  const envBefore = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const tracesHeadersBefore = process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
  const headersBefore = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = sink.url;
  setRemoteRunObserver((fact) => recorder.record(fact));
  try {
    const agents = await buildRemoteBot(fetch, scope());
    const agent = agents.risk;
    if (!agent) throw new Error("buildAgents returned no remote agent");
    agent.threadId = "dialect-thread";
    const longRunId = `r`.repeat(300);

    // Signal-level headers alone: the deployment the exporter itself would authorize.
    process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS =
      "authorization=Bearer traces-secret";
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    await new Promise((resolve) => setTimeout(resolve, 1));
    await agent.runAgent({ runId: longRunId }, { onEvent: () => {} });
    await flush();
    await flushedAnchors(sink, 2);

    const firstPost = sink.posted[0]!;
    expect(firstPost.headers.authorization).toBe("Bearer traces-secret");
    expect(firstPost.serviceName).toBe("server");
    for (const span of firstPost.spans) {
      expect(span.runIdAttribute).toBe("r".repeat(256));
    }

    // The generic var alone still authorizes — the exporter's own fallback rule.
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer generic-secret";
    await new Promise((resolve) => setTimeout(resolve, 1));
    await agent.runAgent({ runId: "run-dialect-2" }, { onEvent: () => {} });
    await flush();
    await flushedAnchors(sink, 6);

    expect(
      sink.posted.some(
        (post) => post.headers.authorization === "Bearer generic-secret",
      ),
    ).toBe(true);
  } finally {
    setRemoteRunObserver(undefined);
    if (envBefore === undefined)
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = envBefore;
    if (tracesHeadersBefore === undefined)
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = tracesHeadersBefore;
    if (headersBefore === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = headersBefore;
    sink.stop();
    await stop();
  }
});

test("a run with no identity and no context degrades visibly — no header is invented", () => {
  const countsBefore = remoteDialChainCounts();

  // The decision itself: nothing ambient, nothing to derive from (the wire runId still
  // GATES the chain — the attempt nonce alone does not rescue an identity-less run).
  const chain = resolveRemoteDialChain("risk", "", "attempt-noid");
  expect(chain).toEqual({ origin: "unavailable", traceId: null });

  // The binding: no context is bound, so the production fetch — which reads whatever is
  // active and synthesizes nothing — carries no `traceparent`, exactly as before this fix.
  // The degradation is COUNTED, so a window that produced it reads off the counters rather
  // than being discovered by finding an orphan trace upstream.
  const bound = bindRemoteDialChain(chain, "risk", "", "attempt-noid");
  expect(bound.context).toBeUndefined();
  expect(bound.dial).toBeNull();
  expect(injectTraceHeaders({})).toEqual({});
  const counts = remoteDialChainCounts();
  expect(counts.unavailable - countsBefore.unavailable).toBe(1);
});

test("with no tracer provider, a derived dial still names the run's chain", () => {
  trace.disable();
  const chain = resolveRemoteDialChain(
    "risk",
    "run-untraced",
    "attempt-untraced",
  );
  expect(chain.origin).toBe("derived");

  /*
   * The provider is gone — and F9A made the dial span independent of one: the context is a
   * non-recording span with the attempt's DERIVED trace and DETERMINISTIC dial span id, so
   * the header cannot vanish with the pipeline (the F8A belt for a no-op SDK span, now the
   * design itself). Nothing anchors and nothing exports; the header still names the chain.
   */
  const bound = bindRemoteDialChain(
    chain,
    "risk",
    "run-untraced",
    "attempt-untraced",
  );
  expect(bound.context).toBeDefined();
  const injected = context.with(bound.context!, () => injectTraceHeaders({}));
  const parent = traceparentOf(injected.traceparent);
  expect(parent).not.toBeNull();
  expect(parent!.traceId).toBe(derivedTraceIdOf("risk", "attempt-untraced"));
  expect(parent!.spanId).toBe(derivedDialSpanIdOf("risk", "attempt-untraced"));
  bound.close();
});

test("the derivation is idempotent per attempt and distinct across attempts", () => {
  const a = derivedRemoteRunTraceId("risk", "attempt-same");
  expect(a).toBe(derivedTraceIdOf("risk", "attempt-same")); // the pinned formula
  expect(a).toBe(derivedRemoteRunTraceId("risk", "attempt-same")); // a re-dial continues one chain
  expect(a).not.toBe(derivedRemoteRunTraceId("risk", "attempt-other"));
  expect(a).not.toBe(derivedRemoteRunTraceId("other", "attempt-same"));
  expect(a).toMatch(/^[0-9a-f]{32}$/);
  expect(a).not.toBe("0".repeat(32));

  // The dial span's own id (F9A): same discipline, span-id shape — a re-dial of one attempt
  // re-derives the SAME span, and no two attempts share one.
  const d = derivedRemoteRunDialSpanId("risk", "attempt-same");
  expect(d).toBe(derivedDialSpanIdOf("risk", "attempt-same"));
  expect(d).toBe(derivedRemoteRunDialSpanId("risk", "attempt-same"));
  expect(d).not.toBe(derivedRemoteRunDialSpanId("risk", "attempt-other"));
  expect(d).not.toBe(derivedRemoteRunDialSpanId("other", "attempt-same"));
  expect(d).toMatch(/^[0-9a-f]{16}$/);
  expect(d).not.toBe("0".repeat(16));
  // And the two derivations of one attempt stay distinct from each other.
  expect(d).not.toBe(derivedTraceIdOf("risk", "attempt-same").slice(0, 16));
});

/*
 * The governed recorder's own window, driven fact by fact (OCR R5's HIGH): the dial span's
 * export is anchored on a materialization this process CONFIRMED, and a terminal run closes
 * its upstream root with the window the fact observed — the same discipline the builtin gate's
 * settle keeps (R3-03), which the remote path previously had no equivalent of at all.
 */

/** A port whose createTrace is refused upstream: the materialization cannot be confirmed. */
function refusingTracePort() {
  const writtenSpans: Array<{
    spans: OpikOtlpSpan[];
    binding?: OpikRunBindingRef;
  }> = [];
  const port = {
    async createTrace() {
      return {
        outcome: "upstream_error" as const,
        code: "OPIK_UPSTREAM_ERROR",
      };
    },
    async writeSpans(
      _scope: unknown,
      input: { spans: OpikOtlpSpan[]; binding?: OpikRunBindingRef },
    ) {
      writtenSpans.push({ spans: input.spans, binding: input.binding });
      return { outcome: "ok" as const, value: { accepted: true as const } };
    },
  };
  return { port: port as unknown as OpikPort, writtenSpans };
}

/** Waits until `probe` answers true, or fails the window's 5s budget. */
async function until(probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("condition not reached in window");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function aDerivedFact(runId: string): RemoteRunRecordInput {
  return {
    scope: scope(),
    botId: "risk",
    threadId: "thread-governed",
    runId,
    attemptId: `${runId}-attempt`,
    traceId: derivedTraceIdOf("risk", runId),
    dial: {
      spanId: derivedDialSpanIdOf("risk", runId),
      startedAt: new Date("2026-10-26T10:00:00.000Z"),
      endedAt: new Date("2026-10-26T10:00:02.000Z"),
    },
    events: [{ type: "success" }],
    endedAt: new Date("2026-10-26T10:00:03.000Z"),
  };
}

test("a materialization that failed keeps the dial span unexported — nothing is written to an unconfirmed upstream", async () => {
  const store = fakeBindingStore();
  const { port, writtenSpans } = refusingTracePort();
  const recorder = createRemoteRunRecorder({ bindings: store, port: () => port });

  recorder.record(aDerivedFact("run-unconfirmed"));
  await until(() => store.finished.length === 1);

  // The local record is complete exactly as the settlement-divergence docblock promises:
  // begun and finished, the materialization failure logged and swallowed.
  expect(store.begun).toHaveLength(1);
  expect(store.finished).toEqual([{ runId: "run-unconfirmed", state: "completed" }]);
  expect(store.reconciledByAttempt("run-unconfirmed-attempt")).toBeNull();

  // But nothing exported: the binding names no upstream trace, so there is no tree to
  // parent a dial span under — writing one would be exactly the unattributed write the
  // guard's own comment claims to exclude.
  expect(writtenSpans).toHaveLength(0);
});

test("a terminal remote run closes its upstream root with the observed window", async () => {
  const store = fakeBindingStore();
  const { port, createdTraces, writtenSpans } = fakePort();
  const recorder = createRemoteRunRecorder({ bindings: store, port: () => port });

  const fact = aDerivedFact("run-closed");
  recorder.record(fact);
  await until(
    () =>
      writtenSpans.filter((write) =>
        write.spans.some((span) => span.attributes !== undefined),
      ).length > 0,
  );

  const identity = runUpstreamIdentity(fact.traceId);
  expect(createdTraces.map((trace) => trace.traceId)).toEqual([
    identity.opikTraceId,
  ]);

  // The root the materialization wrote open is closed again with the run's own window:
  // the dial's observed start, the fact's terminal end, the local state word riding as
  // structured data — the builtin path's closeRunRoot discipline, on the remote path.
  const rootClose = writtenSpans.find((write) =>
    write.spans.some(
      (span) =>
        span.spanId === identity.rootSpanId &&
        span.attributes !== undefined &&
        span.endTimeUnixNano !== undefined,
    ),
  );
  expect(rootClose).toBeDefined();
  const closed = rootClose!.spans.find((span) => span.spanId === identity.rootSpanId)!;
  expect(closed.endTimeUnixNano).toBe(nanos(fact.endedAt));
  expect(closed.startTimeUnixNano).toBe(nanos(fact.dial!.startedAt));
  expect(
    (closed.attributes as Record<string, unknown>)["span_state"],
  ).toMatchObject({ state: "projected", value: "completed" });
  expect(rootClose!.binding?.opikTraceId).toBe(identity.opikTraceId);

  // And the dial span is exported too — under the SAME confirmed upstream identity.
  const dialWrite = writtenSpans.find((write) =>
    write.spans.some((span) => span.spanId === fact.dial!.spanId),
  );
  expect(dialWrite).toBeDefined();
  expect(dialWrite!.binding?.opikTraceId).toBe(identity.opikTraceId);
});
