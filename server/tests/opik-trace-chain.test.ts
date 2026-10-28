// Issue #23 / DAG T17 — cross-service W3C propagation closure.
//
// The chain under test, in issue order:
//   1. closure — a span the server starts, the traceparent the outbound dial
//      carries, the context the receiving side extracts and the tool spans the
//      observation path records all name ONE trace id, parented end to end;
//   2. broken-link detection — a segment that fell out of the chain (a request
//      that carried no traceparent, a context that rooted fresh) answers a
//      DIFFERENT trace id, which is exactly what the id-link store's chain
//      check refuses;
//   3. the governed step spans — an observation that carries the run's trace
//      context writes its span under that trace (never a fresh random one),
//      parents under the ambient span, adopts explicit upstream ids only when
//      they are honestly known, and records the id link only after the
//      upstream write actually landed.
//
// No database and no real Opik: the W3C helpers are real, the queue and port
// are the same fakes the T15 suite uses, and HTTP is a real loopback serve.

import { context, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  currentTraceContext,
  extractRequestContext,
  injectTraceHeaders,
  withTraceFetch,
} from "../../shared/trace";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  observerBindingRefForTests,
  observerRunBindingGateForTests,
} from "../src/ai-observability/bindings";
import type { OpikObservationWrite } from "../src/ai-observability/health";
import {
  runUpstreamIdentity,
  spanUpstreamId,
} from "../src/ai-observability/opik-http";
import type { OpikOtlpSpan, OpikPort } from "../src/ai-observability/opik-port";
import { resolveObservationScope } from "../src/ai-observability/scope";
import {
  createToolStepRecorder,
  type ToolStepObservation,
} from "../src/ai-observability/tool-steps";

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

function aScope() {
  return resolveObservationScope({
    actorId: "user-1",
    botId: "bot-1",
    ownership: "owner",
    epoch: 1,
  });
}

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

function okPort() {
  const writes: Array<{ spans: readonly OpikOtlpSpan[] }> = [];
  return {
    writes,
    port: {
      async writeSpans(
        _scope: unknown,
        input: { spans: readonly OpikOtlpSpan[] },
      ) {
        writes.push({ spans: input.spans });
        return { outcome: "ok" as const, value: { accepted: true as const } };
      },
    } as unknown as OpikPort,
  };
}

function failedPort() {
  return {
    async writeSpans() {
      return {
        outcome: "upstream_error" as const,
        operation: "writeSpans" as const,
        code: "OPIK_UPSTREAM_ERROR" as const,
        status: 500,
      };
    },
  } as unknown as OpikPort;
}

const endedAt = new Date("2026-10-16T11:00:01.500Z");

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const PARENT_SPAN_ID = "0123456789abcdef";
const OPIK_TRACE_ID = "0192f0c0-a2b1-7c3d-8e4f-5a6b7c8d9e0f";

/** The observation a governed tool step would carry with the run's context. */
function aToolObservation(
  overrides: Partial<ToolStepObservation> = {},
): ToolStepObservation {
  return {
    toolCallId: "call-1",
    toolName: "host_read",
    endedAt,
    proposalObserved: true,
    executionObserved: true,
    receiptObserved: true,
    execution: { kind: "succeeded", output: "42" },
    window: "terminal",
    scope: aScope(),
    trace: {
      traceId: TRACE_ID,
      parentSpanId: PARENT_SPAN_ID,
      opikTraceId: OPIK_TRACE_ID,
      runRef: { runId: "run-1", attemptId: "attempt-1" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Closure: server span → traceparent → extracted context → child spans
// ---------------------------------------------------------------------------

describe("the W3C chain closes across services", () => {
  test("a child of the extracted context names the same trace and parent", async () => {
    const { spans, stop } = recordedSpans();
    try {
      const server = trace.getTracer("test.server").startSpan("server run");
      await context.with(trace.setSpan(context.active(), server), async () => {
        // What createAgentFetch puts on the wire (agents/endpoint.ts).
        const headers = injectTraceHeaders({});
        // What withTraceFetch / extractRequestContext reads back.
        const remote = extractRequestContext({
          headers: new Headers(headers),
        });
        const agent = trace
          .getTracer("test.agent")
          .startSpan("agent run", {}, remote);
        const agentContext = trace.setSpan(remote, agent);
        await context.with(agentContext, async () => {
          const toolHeaders = injectTraceHeaders({});
          const toolRemote = extractRequestContext({
            headers: new Headers(toolHeaders),
          });
          trace.getTracer("test.tool").startSpan("tool", {}, toolRemote).end();
        });
        agent.end();
      });
      server.end();

      const byName = new Map(spans.map((span) => [span.name, span]));
      const serverRun = byName.get("server run");
      const agentRun = byName.get("agent run");
      const tool = byName.get("tool");
      expect(serverRun).toBeDefined();
      expect(agentRun).toBeDefined();
      expect(tool).toBeDefined();
      // One trace end to end.
      expect(agentRun?.spanContext().traceId).toBe(
        serverRun?.spanContext().traceId,
      );
      expect(tool?.spanContext().traceId).toBe(
        serverRun?.spanContext().traceId,
      );
      // Parented end to end: agent under server, tool under agent (SDK 2.x carries
      // the parent as a SpanContext on the readable span).
      expect(agentRun?.parentSpanContext?.spanId).toBe(
        serverRun?.spanContext().spanId,
      );
      expect(tool?.parentSpanContext?.spanId).toBe(
        agentRun?.spanContext().spanId,
      );
    } finally {
      await stop();
    }
  });

  test("withTraceFetch continues the inbound traceparent over real HTTP", async () => {
    const { spans, stop } = recordedSpans();
    let sawTraceId: string | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: withTraceFetch(async () => {
        // The receiving side's ambient context — what a run span or a governed
        // step span would be parented on.
        sawTraceId = currentTraceContext()?.traceId;
        return new Response("ok");
      }),
    });
    try {
      const outbound = trace.getTracer("test.server").startSpan("server run");
      await context.with(
        trace.setSpan(context.active(), outbound),
        async () => {
          const response = await fetch(
            `http://127.0.0.1:${server.port}/ag-ui`,
            {
              method: "POST",
              headers: injectTraceHeaders({
                "content-type": "application/json",
              }),
            },
          );
          expect(response.status).toBe(200);
        },
      );
      outbound.end();

      const serverRun = spans.find((span) => span.name === "server run");
      expect(serverRun).toBeDefined();
      expect(sawTraceId).toBe(serverRun?.spanContext().traceId);
      // The receiving side's own span joined the same trace.
      const received = spans.find((span) => span.name === "POST /ag-ui");
      expect(received?.spanContext().traceId).toBe(
        serverRun?.spanContext().traceId,
      );
    } finally {
      server.stop(true);
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Broken-link detection: a segment outside the chain is a different trace
// ---------------------------------------------------------------------------

describe("a broken link is detectable", () => {
  test("a request without traceparent roots a fresh trace, not a continuation", async () => {
    const { stop } = recordedSpans();
    const chained = trace.getTracer("test").startSpan("chained run");
    chained.end();
    let rootedTraceId: string | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: withTraceFetch(async () => {
        rootedTraceId = currentTraceContext()?.traceId;
        return new Response("ok");
      }),
    });
    try {
      // No context.with, no traceparent: the dial that fell out of the chain.
      const response = await fetch(`http://127.0.0.1:${server.port}/ag-ui`, {
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(rootedTraceId).toBeDefined();
      // Different trace ids IS the detection: the segment cannot be linked to
      // the run, and the id-link store's chain check refuses exactly this.
      expect(rootedTraceId).not.toBe(chained.spanContext().traceId);
    } finally {
      server.stop(true);
      await stop();
    }
  });

  test("injectTraceHeaders outside a span carries no traceparent at all", () => {
    const headers = injectTraceHeaders({});
    expect(headers.traceparent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. The governed step spans ride the chain
// ---------------------------------------------------------------------------

describe("a step observation with the run's trace context", () => {
  test("writes its span under that trace, parented under the ambient span", async () => {
    const queue = fakeQueue();
    const recorder = createToolStepRecorder({
      healthService: queue.queue,
      bindings: observerRunBindingGateForTests(),
    });
    recorder.record(aToolObservation());
    const port = okPort();
    for (const write of queue.submitted) await write.perform(port.port);

    expect(port.writes).toHaveLength(1);
    const span = port.writes[0].spans[0];
    expect(span.traceId).toBe(TRACE_ID);
    expect(span.parentSpanId).toBe(PARENT_SPAN_ID);
  });

  test("without a trace context nothing exports — no chain, no binding (FREV-02)", async () => {
    const queue = fakeQueue();
    const recorder = createToolStepRecorder({
      healthService: queue.queue,
      bindings: observerRunBindingGateForTests(),
    });
    recorder.record(aToolObservation({ trace: undefined }));
    const port = okPort();
    for (const write of queue.submitted) await write.perform(port.port);

    // The old fresh-root fallback was the unattributable write the final
    // review's probe drove; since FREV-02 a chain-less observation submits
    // nothing at all.
    expect(port.writes).toHaveLength(0);
  });

  test("a malformed trace id is not adopted — and cannot bind, so nothing exports (FREV-02)", async () => {
    const queue = fakeQueue();
    const recorder = createToolStepRecorder({
      healthService: queue.queue,
      bindings: observerRunBindingGateForTests(),
    });
    recorder.record(
      aToolObservation({
        trace: {
          traceId: "not-hex-at-all",
          parentSpanId: "also not hex",
          opikTraceId: "not-a-uuid",
        },
      }),
    );
    const port = okPort();
    for (const write of queue.submitted) await write.perform(port.port);

    expect(port.writes).toHaveLength(0);
  });

  test("adopts explicit upstream ids only when honestly known, and links after the write lands", async () => {
    const queue = fakeQueue();
    const links: unknown[] = [];
    const recorder = createToolStepRecorder({
      healthService: queue.queue,
      bindings: observerRunBindingGateForTests(),
      idLinks: {
        link: async (_scope, input) => {
          links.push(input);
          return { linked: true as const, replayed: false as const };
        },
      },
    });
    recorder.record(aToolObservation());
    const port = okPort();
    for (const write of queue.submitted) await write.perform(port.port);

    const span = port.writes[0].spans[0];
    // The explicit-id strategy: the upstream span id is one WE minted as a
    // UUIDv7 and the backend adopts verbatim — the only id a link may claim.
    expect(span.opik?.traceId).toBe(OPIK_TRACE_ID);
    expect(span.opik?.spanId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      local: { kind: "tool_step", id: "call-1" },
      upstream: { kind: "span", id: span.opik?.spanId },
      runRef: { runId: "run-1", attemptId: "attempt-1" },
      observedTraceId: TRACE_ID,
    });
  });

  test("no override but the chain derives to the binding's trace: the link names the id the port completes with", async () => {
    const queue = fakeQueue();
    const links: unknown[] = [];
    // The production wiring shape: the observation carries no opikTraceId and
    // the binding holds the upstream trace the materialization derived from the
    // chain — the id the port's completion (opik-http) adopts for this span.
    const recorder = createToolStepRecorder({
      healthService: queue.queue,
      bindings: {
        ensure: async (scope) =>
          observerBindingRefForTests(scope, {
            opikTraceId: runUpstreamIdentity(TRACE_ID).opikTraceId,
          }),
      },
      idLinks: {
        link: async (_scope, input) => {
          links.push(input);
          return { linked: true as const, replayed: false as const };
        },
      },
    });
    recorder.record(
      aToolObservation({
        trace: { traceId: TRACE_ID, parentSpanId: PARENT_SPAN_ID },
      }),
    );
    const port = okPort();
    for (const write of queue.submitted) await write.perform(port.port);

    // No explicit override on the span — the port completes it with the derived
    // id, and the link claims exactly that id, never a second one.
    const span = port.writes[0].spans[0];
    expect(span.opik).toBeUndefined();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      local: { kind: "tool_step", id: "call-1" },
      upstream: { kind: "span", id: spanUpstreamId(TRACE_ID, span.spanId) },
      observedTraceId: TRACE_ID,
    });
  });

  test("a binding naming another upstream trace derives nowhere — no link", async () => {
    const queue = fakeQueue();
    const links: unknown[] = [];
    const recorder = createToolStepRecorder({
      healthService: queue.queue,
      bindings: {
        ensure: async (scope) =>
          observerBindingRefForTests(scope, { opikTraceId: OPIK_TRACE_ID }),
      },
      idLinks: {
        link: async (_scope, input) => {
          links.push(input);
          return { linked: true as const, replayed: false as const };
        },
      },
    });
    recorder.record(
      aToolObservation({
        trace: { traceId: TRACE_ID, parentSpanId: PARENT_SPAN_ID },
      }),
    );
    const port = okPort();
    for (const write of queue.submitted) await write.perform(port.port);

    // The forged binding names an upstream trace this chain does not derive to;
    // the span write stands, but nothing may claim an id for it.
    expect(port.writes).toHaveLength(1);
    expect(links).toHaveLength(0);
  });

  test("a failed upstream write records no link", async () => {
    const queue = fakeQueue();
    const links: unknown[] = [];
    const recorder = createToolStepRecorder({
      healthService: queue.queue,
      bindings: observerRunBindingGateForTests(),
      idLinks: {
        link: async (_scope, input) => {
          links.push(input);
          return { linked: true as const, replayed: false as const };
        },
      },
    });
    recorder.record(aToolObservation());
    const port = failedPort();
    for (const write of queue.submitted) await write.perform(port);

    expect(links).toHaveLength(0);
  });

  test("a chain_broken verdict never fails the span write it follows", async () => {
    const queue = fakeQueue();
    const recorder = createToolStepRecorder({
      healthService: queue.queue,
      bindings: observerRunBindingGateForTests(),
      idLinks: {
        link: async () => ({
          linked: false as const,
          reason: "chain_broken" as const,
        }),
      },
    });
    recorder.record(aToolObservation());
    const port = okPort();
    let settled: unknown;
    for (const write of queue.submitted)
      settled = await write.perform(port.port);
    // The upstream write's own outcome is what the queue counts; the detection
    // verdict is an observation, never a product failure.
    expect(settled).toMatchObject({ outcome: "ok" });
    expect(port.writes).toHaveLength(1);
  });

  test("refused verdicts are counted on the governed channel, never silent (T17 review M-1)", async () => {
    const queue = fakeQueue();
    const verdicts = [
      { linked: false as const, reason: "chain_broken" as const },
      { linked: false as const, reason: "divergent" as const },
    ];
    const recorder = createToolStepRecorder({
      healthService: queue.queue,
      bindings: observerRunBindingGateForTests(),
      idLinks: {
        link: async () => verdicts.shift(),
      },
    });
    recorder.record(aToolObservation({ toolCallId: "call-count-1" }));
    recorder.record(aToolObservation({ toolCallId: "call-count-2" }));
    const port = okPort();
    for (const write of queue.submitted) await write.perform(port.port);
    // Both refusals landed on the counter, in order, and neither failed the span.
    expect(queue.countedIdLinks).toEqual(["chain_broken", "divergent"]);
    expect(port.writes).toHaveLength(2);
  });

  test("a link store that throws is contained, never a product failure", async () => {
    const queue = fakeQueue();
    const recorder = createToolStepRecorder({
      healthService: queue.queue,
      bindings: observerRunBindingGateForTests(),
      idLinks: {
        link: async () => {
          throw new Error("database went away");
        },
      },
    });
    recorder.record(aToolObservation());
    const port = okPort();
    let settled: unknown;
    for (const write of queue.submitted)
      settled = await write.perform(port.port);
    expect(settled).toMatchObject({ outcome: "ok" });
    expect(queue.countedIdLinks).toEqual(["error"]);
  });

  test("no idLinks dependency means no link, and the span is unchanged", async () => {
    const queue = fakeQueue();
    const recorder = createToolStepRecorder({
      healthService: queue.queue,
      bindings: observerRunBindingGateForTests(),
    });
    recorder.record(aToolObservation());
    const port = okPort();
    for (const write of queue.submitted) await write.perform(port.port);
    expect(port.writes[0].spans[0].opik?.traceId).toBe(OPIK_TRACE_ID);
  });
});
