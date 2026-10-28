// R3-03 — the builtin run's REAL terminal state and lifetime, end to end.
//
// The final review's finding: the builtin run's close was settled only by the
// tool-step fact's window, so every terminal landed as `unknown` (and a run
// with no tools waited out its lease the same way), while RUN_FINISHED success
// and RUN_ERROR were perfectly distinguishable at the public event face — the
// difference was simply dropped at the fact boundary. The root materialized at
// the first business fact's clock with no end, and the list projected only the
// upstream row's status, which a real deployment's trace rows do not carry.
//
// This suite pins the fix on its four faces:
//   1. the event face — the run's own lifecycle fact (start observation, the
//      observed ending in the protocol's own words, first-ending-wins);
//   2. the gate — the observed start is what materializes, the observed ending
//      settles the binding's real state and closes the run root upstream;
//   3. the query face — list and detail name the settled state and the run's
//      real times, over the production adapter against a scripted upstream;
//   4. the wiring — the boot adapter settles runs from the run fact, never
//      from a tool-step window again.
//
// The five lifecycle regressions the close condition names — no-tool success,
// tool-then-success/failure, confirmed cancel, disconnect, retry — run through
// faces 2 and 3 together. Store doubles and scripted ports, exactly like the
// observer-binding suite; the real store's loop is proven in the bindings
// suites (statesByOpikTraceIds included there).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BaseEvent } from "@ag-ui/client";
import { context, trace } from "@opentelemetry/api";
import {
  NodeTracerProvider,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { Subject } from "rxjs";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import type { RunBinding } from "../src/ai-observability/bindings";
import {
  createObserverRunBindingGate,
  type ObserverRunEnding,
  type RunBindingStore,
} from "../src/ai-observability/bindings";
import type { ObservationScope } from "../src/ai-observability/contracts";
import { createOpikHealthService } from "../src/ai-observability/health";
import { createModelSpanRecorder } from "../src/ai-observability/model-span";
import {
  createOpikHttpPort,
  runUpstreamIdentity,
} from "../src/ai-observability/opik-http";
import type { VerifiedOpikContract } from "../src/ai-observability/opik-port";
import { createRunsQueryService } from "../src/ai-observability/queries/runs";
import {
  resolveObservationScope,
  resolveStorageLocator,
} from "../src/ai-observability/scope";
import { createToolStepRecorder } from "../src/ai-observability/tool-steps";
import {
  type BuiltinRunLifecycleFact,
  runLifecycleObservationForTests,
  setBuiltinRunLifecycleObserver,
} from "../src/copilot";
import { withRunObservationScope } from "../src/observation-run-scope";

const manifest = (await Bun.file(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../src/ai-observability/opik-contract/47-manifest.json",
  ),
).json()) as VerifiedOpikContract;

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

function aScope(actor = "user-1"): ObservationScope {
  return resolveObservationScope({
    actorId: actor,
    botId: "bot-1",
    ownership: "owner",
    epoch: 1,
  });
}

/** A plain structural AG-UI event — exactly the public fields, nothing more. */
const ev = (event: Record<string, unknown>): BaseEvent =>
  event as unknown as BaseEvent;

// ---------------------------------------------------------------------------
// Fakes: the store double (begin/finish/reconcile) and the port double
// ---------------------------------------------------------------------------

type DoubleRow = {
  scopeKey: string;
  runId: string;
  attemptId: string;
  traceId: string;
  locatorWorkspace: string;
  locatorProject: string;
  opikTraceId: string | null;
  state: string;
};

function storeDouble() {
  const calls: Array<{ op: string; runId: string }> = [];
  const rows = new Map<string, DoubleRow>();
  const store = {
    async begin(
      scope: ObservationScope,
      input: { runId: string; attemptId: string; traceId: string },
    ) {
      calls.push({ op: "begin", runId: input.runId });
      const key = `${scope.key}:${input.runId}:${input.attemptId}`;
      const existing = rows.get(key);
      if (existing) return { binding: existing, replayed: true };
      const locator = resolveStorageLocator(scope);
      const row: DoubleRow = {
        scopeKey: scope.key,
        runId: input.runId,
        attemptId: input.attemptId,
        traceId: input.traceId,
        locatorWorkspace: locator.workspace,
        locatorProject: locator.project,
        opikTraceId: null,
        state: "running",
      };
      rows.set(key, row);
      return { binding: row, replayed: false };
    },
    async reconcile(
      scope: { key: string },
      runId: string,
      attemptId: string,
      opikTraceId: string,
    ) {
      calls.push({ op: "reconcile", runId });
      const row = rows.get(`${scope.key}:${runId}:${attemptId}`);
      if (!row) throw new Error("reconcile without a begun row");
      if (row.opikTraceId !== null) return { binding: row, adopted: false };
      row.opikTraceId = opikTraceId;
      return { binding: row, adopted: true };
    },
    async finish(
      scope: { key: string },
      runId: string,
      attemptId: string,
      state: string,
    ) {
      calls.push({ op: "finish", runId });
      const row = rows.get(`${scope.key}:${runId}:${attemptId}`);
      if (row && row.state === "running") row.state = state;
      return { binding: row ?? null, settled: row?.state === state };
    },
  };
  return {
    calls,
    rows,
    store: store as unknown as Pick<
      RunBindingStore,
      "begin" | "finish" | "reconcile"
    >,
  };
}

function portDouble(
  options: { writeSpans?: unknown; failWritesAfter?: number } = {},
) {
  const created: Array<{
    traceId: string;
    startTime: Date;
    binding: unknown;
  }> = [];
  const writes: Array<{ spans: readonly unknown[]; binding: unknown }> = [];
  const port = {
    async healthCheck() {
      return { outcome: "ok" as const, value: { healthy: true as const } };
    },
    async createTrace(
      _scope: unknown,
      input: { traceId: string; startTime: Date; binding?: unknown },
    ) {
      created.push({
        traceId: input.traceId,
        startTime: input.startTime,
        binding: input.binding,
      });
      return { outcome: "ok" as const, value: { traceId: input.traceId } };
    },
    async writeSpans(
      _scope: unknown,
      input: { spans: readonly unknown[]; binding?: unknown },
    ) {
      writes.push({ spans: input.spans, binding: input.binding });
      if (
        options.failWritesAfter !== undefined &&
        writes.length > options.failWritesAfter
      ) {
        return {
          outcome: "unavailable" as const,
          operation: "writeSpans" as const,
          code: "OPIK_TIMEOUT" as const,
        };
      }
      return (
        options.writeSpans ?? {
          outcome: "ok" as const,
          value: { accepted: true as const },
        }
      );
    },
  };
  return { created, writes, port };
}

const CHAIN = "0123456789abcdef0123456789abcdef";

/** Drain the gate's fire-and-forget settle chain: every await is a microtask,
 * so one macrotask boundary empties the queue. */
const settleDrained = () => new Promise((resolve) => setTimeout(resolve, 10));

// ---------------------------------------------------------------------------
// Face 1: the event fact
// ---------------------------------------------------------------------------

/** A registered provider whose span exposes a VALID W3C context — the
 * tool-step suite's own recordedSpansForBypass pattern, trimmed to what this
 * file needs (the observation bypass reads currentTraceContext, which is
 * undefined without a real provider's recording span; the FIRST registration
 * also installs the async context manager `context.with` runs on). */
function recordedSpan(): {
  span: ReadableSpan;
  stop: () => Promise<void>;
} {
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
  const span = trace.getTracer("test").startSpan("run request");
  return {
    span,
    stop: async () => {
      trace.disable();
      await provider.shutdown();
    },
  };
}

describe("the event face observes the run's own lifecycle (R3-03)", () => {
  test("the first event is the run's start observation: scope and trace captured, no terminal", () => {
    const facts: BuiltinRunLifecycleFact[] = [];
    setBuiltinRunLifecycleObserver((fact) => facts.push(fact));
    const scope = aScope();
    const request = recordedSpan();
    try {
      const subject = new Subject<BaseEvent>();
      const subscription = runLifecycleObservationForTests
        .observeStream(subject)
        .subscribe();
      try {
        withRunObservationScope(scope, () =>
          context.with(trace.setSpan(context.active(), request.span), () => {
            subject.next(
              ev({ type: "RUN_STARTED", threadId: "t", runId: "r-1" }),
            );
          }),
        );
        expect(facts).toHaveLength(1);
        expect(facts[0].terminal).toBeNull();
        expect(facts[0].scope).toBe(scope);
        expect(facts[0].trace).toEqual({
          traceId: request.span.spanContext().traceId,
          spanId: request.span.spanContext().spanId,
        });
        expect(facts[0].startedAt).toBeInstanceOf(Date);
      } finally {
        subscription.unsubscribe();
      }
    } finally {
      setBuiltinRunLifecycleObserver(undefined);
      void request.stop();
    }
  });

  test("RUN_FINISHED without an outcome is success — the protocol's own rule", () => {
    const facts: BuiltinRunLifecycleFact[] = [];
    setBuiltinRunLifecycleObserver((fact) => facts.push(fact));
    try {
      const subject = new Subject<BaseEvent>();
      const subscription = runLifecycleObservationForTests
        .observeStream(subject)
        .subscribe();
      try {
        withRunObservationScope(aScope(), () => {
          subject.next(ev({ type: "TEXT_MESSAGE_START", messageId: "m" }));
          subject.next(
            ev({ type: "RUN_FINISHED", threadId: "t", runId: "r-1" }),
          );
        });
        subject.complete();
        expect(
          facts.map((fact) =>
            fact.terminal === null ? "start" : fact.terminal.ending,
          ),
        ).toEqual(["start", "success"]);
      } finally {
        subscription.unsubscribe();
      }
    } finally {
      setBuiltinRunLifecycleObserver(undefined);
    }
  });

  test("the protocol's other endings are named, never defaulted", () => {
    const cases: Array<{
      outcome?: { type: string };
      type: string;
      expected: ObserverRunEnding;
    }> = [
      {
        type: "RUN_FINISHED",
        outcome: { type: "interrupt" },
        expected: "interrupted",
      },
      {
        type: "RUN_FINISHED",
        outcome: { type: "cancelled" },
        expected: "canceled",
      },
      { type: "RUN_ERROR", expected: "error" },
    ];
    for (const one of cases) {
      const facts: BuiltinRunLifecycleFact[] = [];
      setBuiltinRunLifecycleObserver((fact) => facts.push(fact));
      try {
        const subject = new Subject<BaseEvent>();
        const subscription = runLifecycleObservationForTests
          .observeStream(subject)
          .subscribe();
        try {
          withRunObservationScope(aScope(), () => {
            subject.next(
              ev(
                one.type === "RUN_FINISHED"
                  ? {
                      type: one.type,
                      threadId: "t",
                      runId: "r-1",
                      outcome: one.outcome,
                    }
                  : { type: one.type, message: "provider refused" },
              ),
            );
          });
          subject.complete();
        } finally {
          subscription.unsubscribe();
        }
        expect(facts[facts.length - 1].terminal?.ending).toBe(one.expected);
      } finally {
        setBuiltinRunLifecycleObserver(undefined);
      }
    }
  });

  test("a stream that errors without a terminal event is a failure, not an unconfirmed window", () => {
    const facts: BuiltinRunLifecycleFact[] = [];
    setBuiltinRunLifecycleObserver((fact) => facts.push(fact));
    try {
      const subject = new Subject<BaseEvent>();
      const subscription = runLifecycleObservationForTests
        .observeStream(subject)
        .subscribe({ error: () => {} }); // the error must propagate, uncounted
      try {
        withRunObservationScope(aScope(), () => {
          subject.next(
            ev({ type: "RUN_STARTED", threadId: "t", runId: "r-1" }),
          );
        });
        subject.error(new Error("transport broke"));
        expect(
          facts.map((fact) =>
            fact.terminal === null ? "start" : fact.terminal.ending,
          ),
        ).toEqual(["start", "error"]);
      } finally {
        subscription.unsubscribe();
      }
    } finally {
      setBuiltinRunLifecycleObserver(undefined);
    }
  });

  test("a teardown with nothing terminal is disconnected — the unconfirmable window", () => {
    const facts: BuiltinRunLifecycleFact[] = [];
    setBuiltinRunLifecycleObserver((fact) => facts.push(fact));
    try {
      const subject = new Subject<BaseEvent>();
      const subscription = runLifecycleObservationForTests
        .observeStream(subject)
        .subscribe();
      withRunObservationScope(aScope(), () => {
        subject.next(ev({ type: "RUN_STARTED", threadId: "t", runId: "r-1" }));
      });
      subscription.unsubscribe();
      expect(
        facts.map((fact) =>
          fact.terminal === null ? "start" : fact.terminal.ending,
        ),
      ).toEqual(["start", "disconnected"]);
    } finally {
      setBuiltinRunLifecycleObserver(undefined);
    }
  });

  test("the first observed ending wins — a straggler after the run ended changes nothing", () => {
    const facts: BuiltinRunLifecycleFact[] = [];
    setBuiltinRunLifecycleObserver((fact) => facts.push(fact));
    try {
      const subject = new Subject<BaseEvent>();
      const subscription = runLifecycleObservationForTests
        .observeStream(subject)
        .subscribe();
      try {
        withRunObservationScope(aScope(), () => {
          subject.next(
            ev({ type: "RUN_STARTED", threadId: "t", runId: "r-1" }),
          );
          subject.next(
            ev({ type: "RUN_FINISHED", threadId: "t", runId: "r-1" }),
          );
          // The straggler: an error event after the finish, then the teardown.
          subject.next(ev({ type: "RUN_ERROR", message: "late" }));
        });
        subject.complete();
        expect(
          facts.map((fact) =>
            fact.terminal === null ? "start" : fact.terminal.ending,
          ),
        ).toEqual(["start", "success"]);
      } finally {
        subscription.unsubscribe();
      }
    } finally {
      setBuiltinRunLifecycleObserver(undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Face 2: the gate settles the observed ending and the run's times
// ---------------------------------------------------------------------------

describe("the observer gate settles the run's observed ending (R3-03)", () => {
  test("the observed start is what materializes the trace and root, not the first-fact clock", async () => {
    const double = storeDouble();
    const { created, writes, port } = portDouble();
    const gate = createObserverRunBindingGate(double.store, {
      port: () => port,
      now: () => new Date("2026-10-25T12:00:00.000Z"), // the clock is WRONG on purpose
    });
    const scope = aScope();
    const startedAt = new Date("2026-10-25T11:00:00.000Z");
    gate.noteObservedRunStart(scope, { traceId: CHAIN }, startedAt);

    await gate.ensure(scope, { traceId: CHAIN });

    expect(created).toHaveLength(1);
    expect(created[0].startTime.getTime()).toBe(startedAt.getTime());
    const root = writes[0].spans[0] as { startTimeUnixNano: string };
    expect(root.startTimeUnixNano).toBe(
      (BigInt(startedAt.getTime()) * 1_000_000n).toString(),
    );
  });

  test("a named ending settles the binding's real state and closes the run root with the observed window", async () => {
    const double = storeDouble();
    const { created, writes, port } = portDouble();
    const gate = createObserverRunBindingGate(double.store, {
      port: () => port,
    });
    const scope = aScope();
    const identity = runUpstreamIdentity(CHAIN);
    const startedAt = new Date("2026-10-25T11:00:00.000Z");
    const endedAt = new Date("2026-10-25T11:00:04.000Z");

    // The business fact mid-run establishes the binding and materializes.
    await gate.ensure(scope, { traceId: CHAIN });
    // Then the run's own terminal arrives.
    gate.settleObservedRun(
      scope,
      { traceId: CHAIN },
      {
        startedAt,
        ending: "success",
        endedAt,
      },
    );
    await settleDrained();

    expect(
      double.rows.get(`${scope.key}:builtin:${CHAIN}:builtin:${CHAIN}`)?.state,
    ).toBe("completed");
    expect(double.calls.at(-1)).toEqual({
      op: "finish",
      runId: `builtin:${CHAIN}`,
    });

    // The root close: the same deterministic ids, the observed window, and
    // the settled state riding as the step vocabulary's own word.
    expect(created).toHaveLength(1); // the materialization, not a second trace
    const close = writes.at(-1);
    expect(close).toBeDefined();
    const root = close.spans[0] as {
      traceId: string;
      spanId: string;
      startTimeUnixNano: string;
      endTimeUnixNano: string;
      attributes: Record<string, unknown>;
      opik: { traceId: string; spanId: string };
    };
    expect(root.traceId).toBe(CHAIN);
    expect(root.spanId).toBe(identity.rootSpanId);
    expect(root.startTimeUnixNano).toBe(
      (BigInt(startedAt.getTime()) * 1_000_000n).toString(),
    );
    expect(root.endTimeUnixNano).toBe(
      (BigInt(endedAt.getTime()) * 1_000_000n).toString(),
    );
    expect(root.attributes.span_state).toEqual({
      state: "projected",
      value: "completed",
    });
    expect(root.opik).toEqual({
      traceId: identity.opikTraceId,
      spanId: identity.rootOpikSpanId,
    });
    expect(close.binding).toMatchObject({
      opikTraceId: identity.opikTraceId,
    });
  });

  test("a disconnected window settles unknown — the only honest unknown", async () => {
    const double = storeDouble();
    const { port } = portDouble();
    const gate = createObserverRunBindingGate(double.store, {
      port: () => port,
    });
    const scope = aScope();
    await gate.ensure(scope, { traceId: CHAIN });
    gate.settleObservedRun(
      scope,
      { traceId: CHAIN },
      {
        startedAt: new Date(),
        ending: "disconnected",
        endedAt: new Date(),
      },
    );
    await settleDrained();
    expect(
      double.rows.get(`${scope.key}:builtin:${CHAIN}:builtin:${CHAIN}`)?.state,
    ).toBe("unknown");
  });

  test("a run with no business fact at all still materializes and settles — the no-tool success", async () => {
    const double = storeDouble();
    const { created, writes, port } = portDouble();
    const gate = createObserverRunBindingGate(double.store, {
      port: () => port,
    });
    const scope = aScope();
    const startedAt = new Date("2026-10-25T11:00:00.000Z");
    const endedAt = new Date("2026-10-25T11:00:02.000Z");
    // No ensure from any recorder — the run's own facts are the only ones.
    gate.settleObservedRun(
      scope,
      { traceId: CHAIN },
      {
        startedAt,
        ending: "success",
        endedAt,
      },
    );
    await settleDrained();

    expect(created).toHaveLength(1); // materialized at settle, once
    expect(created[0].startTime.getTime()).toBe(startedAt.getTime());
    expect(
      double.rows.get(`${scope.key}:builtin:${CHAIN}:builtin:${CHAIN}`)?.state,
    ).toBe("completed");
    // The open root first, then the close: the close is the LAST write.
    const root = writes.at(-1)?.spans[0] as {
      startTimeUnixNano: string;
      endTimeUnixNano: string;
    };
    expect(root.startTimeUnixNano).toBe(
      (BigInt(startedAt.getTime()) * 1_000_000n).toString(),
    );
    expect(root.endTimeUnixNano).toBe(
      (BigInt(endedAt.getTime()) * 1_000_000n).toString(),
    );
  });

  test("the tool-step window settle no longer competes: the first settle wins either way", async () => {
    const double = storeDouble();
    const { port } = portDouble();
    const gate = createObserverRunBindingGate(double.store, {
      port: () => port,
    });
    const scope = aScope();
    await gate.ensure(scope, { traceId: CHAIN });
    // A late window close (a stalled bare execute, say) after the run's own
    // terminal: nothing it says may rewrite the standing outcome.
    gate.settleObservedRun(
      scope,
      { traceId: CHAIN },
      {
        startedAt: new Date(),
        ending: "canceled",
        endedAt: new Date(),
      },
    );
    await settleDrained();
    gate.settleObservedWindow(scope, { traceId: CHAIN }, "terminal");
    await settleDrained();
    expect(
      double.rows.get(`${scope.key}:builtin:${CHAIN}:builtin:${CHAIN}`)?.state,
    ).toBe("canceled");
    // And the reverse order holds too: the window settled first keeps
    // unknown, the later named ending cannot upgrade it (first settle wins).
    const second = "f".repeat(32);
    await gate.ensure(scope, { traceId: second });
    gate.settleObservedWindow(scope, { traceId: second }, "terminal");
    await settleDrained();
    gate.settleObservedRun(
      scope,
      { traceId: second },
      {
        startedAt: new Date(),
        ending: "success",
        endedAt: new Date(),
      },
    );
    await settleDrained();
    expect(
      double.rows.get(`${scope.key}:builtin:${second}:builtin:${second}`)
        ?.state,
    ).toBe("unknown");
  });

  test("a root close that fails leaves the settled binding standing", async () => {
    const double = storeDouble();
    // The materialization's own root write succeeds (write #1); only the
    // CLOSE (write #2) fails — the close is the half that must degrade.
    const { port } = portDouble({ failWritesAfter: 1 });
    const gate = createObserverRunBindingGate(double.store, {
      port: () => port,
    });
    const scope = aScope();
    await gate.ensure(scope, { traceId: CHAIN });
    gate.settleObservedRun(
      scope,
      { traceId: CHAIN },
      {
        startedAt: new Date(),
        ending: "error",
        endedAt: new Date(),
      },
    );
    await settleDrained();
    // The local authority landed; the root stays open upstream, honestly.
    expect(
      double.rows.get(`${scope.key}:builtin:${CHAIN}:builtin:${CHAIN}`)?.state,
    ).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Face 3: the query face over a scripted upstream, through the production adapter
// ---------------------------------------------------------------------------

/**
 * A scripted Opik over the verified HTTP surface (the observer-binding suite's
 * own scriptedOpik, with span rows UPSERTED by id — the real backend's answer
 * to a re-written span — so a root closed after its open write is one row).
 */
function scriptedOpik() {
  const traceRows: Array<Record<string, unknown>> = [];
  const spanRows = new Map<string, Record<string, unknown>>();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as never) : {};
    if (url.endsWith("/health-check")) {
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/v1/private/projects/retrieve")) {
      return json(200, { id: "proj-f7c", name: body.name });
    }
    if (url === "http://opik.test/api/v1/private/traces" && method === "POST") {
      traceRows.push({ id: body.id, start_time: body.start_time });
      return new Response(null, { status: 201 });
    }
    if (url.endsWith("/v1/private/otel/v1/traces") && method === "POST") {
      const spans = body.resourceSpans[0].scopeSpans[0].spans as Array<{
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        name: string;
        startTimeUnixNano: string;
        endTimeUnixNano?: string;
        attributes?: Array<{ key: string; value: { stringValue?: string } }>;
      }>;
      const attribute = (span: (typeof spans)[number], key: string) =>
        span.attributes?.find((entry) => entry.key === key)?.value?.stringValue;
      for (const span of spans) {
        const id = attribute(span, "opik.span_id") ?? `derived-${span.spanId}`;
        spanRows.set(id, {
          id,
          trace_id:
            attribute(span, "opik.trace_id") ?? `derived-${span.traceId}`,
          parent_span_id:
            attribute(span, "opik.parent_span_id") ??
            (span.parentSpanId !== undefined
              ? `derived-${span.parentSpanId}`
              : null),
          name: span.name,
          start_time: span.startTimeUnixNano,
          end_time: span.endTimeUnixNano ?? span.startTimeUnixNano,
          input: Object.fromEntries(
            (span.attributes ?? [])
              .filter((entry) => !entry.key.startsWith("opik."))
              .map((entry) => [entry.key, entry.value.stringValue]),
          ),
        });
      }
      return new Response(null, { status: 200 });
    }
    if (url.startsWith("http://opik.test/api/v1/private/traces?")) {
      return json(200, {
        page: 1,
        size: 100,
        total: traceRows.length,
        content: traceRows,
      });
    }
    if (url.startsWith("http://opik.test/api/v1/private/spans?")) {
      const traceId = new URL(url).searchParams.get("trace_id") as string;
      const ofTrace = [...spanRows.values()].filter(
        (row) => row.trace_id === traceId,
      );
      return json(200, {
        page: 1,
        size: 100,
        total: ofTrace.length,
        content: ofTrace,
      });
    }
    return new Response(null, { status: 500 });
  };
  const port = createOpikHttpPort({
    baseUrl: "http://opik.test/api",
    contract: manifest,
    fetch: transport,
  });
  return { port, traceRows, spanRows };
}

describe("a builtin run is lifecycle-correct end to end (R3-03)", () => {
  type Ending = ObserverRunEnding;
  const runOne = async (options: {
    ending: Ending;
    withToolFact: boolean;
    chain?: string;
    scope?: ObservationScope;
  }) => {
    const chain = options.chain ?? CHAIN;
    const scope = options.scope ?? aScope();
    const { port, traceRows, spanRows } = scriptedOpik();
    const double = storeDouble();
    const gate = createObserverRunBindingGate(double.store, {
      port: () => port,
    });
    const health = createOpikHealthService({
      config: () => ({
        enabled: true,
        baseUrl: "http://opik.test",
        apiKey: null,
        workspaceName: "openbot",
        port: 5174,
        otlpHttpPort: 5418,
        otlpGrpcPort: 5417,
      }),
      port,
    });
    await health.readiness();
    const steps = createToolStepRecorder({
      healthService: health,
      bindings: gate,
    });
    const models = createModelSpanRecorder({
      healthService: health,
      bindings: gate,
    });

    const startedAt = new Date("2026-10-25T11:00:00.000Z");
    const endedAt = new Date("2026-10-25T11:00:05.000Z");
    // The start observation rides ahead of the first business fact.
    gate.noteObservedRunStart(scope, { traceId: chain }, startedAt);
    if (options.withToolFact) {
      steps.record({
        toolCallId: "call-1",
        toolName: "report_environment",
        endedAt: new Date("2026-10-25T11:00:02.000Z"),
        proposalObserved: true,
        executionObserved: true,
        receiptObserved: true,
        execution: { kind: "succeeded", output: "environment reported" },
        window: "terminal",
        scope,
        trace: { traceId: chain, parentSpanId: "bc1752c6f4dc" },
      });
      // A model fact too, so the run is a real mixed one.
      models.record({
        occurredAt: new Date("2026-10-25T11:00:00.500Z"),
        endedAt: new Date("2026-10-25T11:00:01.500Z"),
        ending: { kind: "succeeded", inputTokens: 2051, outputTokens: 32 },
        scope,
        trace: { traceId: chain },
      });
      await health.drain();
    }
    gate.settleObservedRun(
      scope,
      { traceId: chain },
      {
        startedAt,
        ending: options.ending,
        endedAt,
      },
    );
    await settleDrained();

    // The read face, with the binding seams fed by the very rows the gate
    // wrote — statesByOpikTraceIds included, the list's new lifecycle join.
    const bindingOf = (row: DoubleRow): RunBinding => ({
      id: `${row.runId}:id`,
      scopeKey: row.scopeKey,
      actorId: "user-1",
      botId: "bot-1",
      runId: row.runId,
      attemptId: row.attemptId,
      traceId: row.traceId,
      opikTraceId: row.opikTraceId,
      locatorWorkspace: row.locatorWorkspace,
      locatorProject: row.locatorProject,
      capability: "detailed",
      state: row.state as RunBinding["state"],
      expiresAt: new Date(Date.now() + 60_000),
      deletedAt: null,
      createdAt: startedAt,
      updatedAt: endedAt,
    });
    const runs = createRunsQueryService({
      bindings: {
        latestAttempt: async (queryScope, runId) => {
          const row = [...double.rows.values()].find(
            (candidate) =>
              candidate.scopeKey === queryScope.key &&
              candidate.runId === runId,
          );
          return row ? bindingOf(row) : null;
        },
        capabilitiesByOpikTraceIds: async (queryScope, ids) => {
          const held = [...double.rows.values()].find(
            (row) =>
              row.scopeKey === queryScope.key &&
              row.opikTraceId !== null &&
              ids.includes(row.opikTraceId),
          );
          return held?.opikTraceId !== undefined
            ? new Map([[held.opikTraceId, "detailed" as const]])
            : new Map();
        },
        statesByOpikTraceIds: async (queryScope, ids) => {
          const states = new Map<string, RunBinding["state"]>();
          for (const row of double.rows.values()) {
            if (
              row.scopeKey === queryScope.key &&
              row.opikTraceId !== null &&
              ids.includes(row.opikTraceId)
            ) {
              states.set(row.opikTraceId, row.state as RunBinding["state"]);
            }
          }
          return states;
        },
        countUnreconciled: async (queryScope) =>
          [...double.rows.values()].filter(
            (row) =>
              row.scopeKey === queryScope.key && row.opikTraceId === null,
          ).length,
      },
      config: () => ({
        enabled: true,
        baseUrl: "http://opik.test",
        apiKey: null,
        workspaceName: "openbot",
        port: 5174,
        otlpHttpPort: 5418,
        otlpGrpcPort: 5417,
      }),
      port,
    });
    return { runs, scope, chain, traceRows, spanRows, startedAt, endedAt };
  };

  test("no-tool success: list and detail name completed, the root carries the run's real times", async () => {
    const { runs, scope, chain, spanRows, startedAt, endedAt } = await runOne({
      ending: "success",
      withToolFact: false,
    });
    const identity = runUpstreamIdentity(chain);
    const listed = await runs.list(scope, { limit: 10 });
    expect(listed.runs).toHaveLength(1);
    expect(listed.runs[0].state).toBe("completed"); // not unknown, not running
    // The trace row's start is the RUN's start — the materialization clock
    // never appears, even though materialization happened at settle time.
    expect(listed.runs[0].createdAt).toBe(startedAt.toISOString());

    const detail = await runs.detail(scope, `builtin:${chain}`);
    expect(detail.run.state).toBe("completed");
    expect(detail.upstream).toMatchObject({ status: "present" });

    // The root: one row, closed at the observed terminal, carrying the state.
    const root = spanRows.get(identity.rootOpikSpanId);
    expect(root).toBeDefined();
    expect(root?.start_time).toBe(
      (BigInt(startedAt.getTime()) * 1_000_000n).toString(),
    );
    expect(root?.end_time).toBe(
      (BigInt(endedAt.getTime()) * 1_000_000n).toString(),
    );
    expect(
      (root?.input as Record<string, unknown> | undefined)?.span_state,
    ).toBe("completed");
  });

  test("tool-then-success and tool-then-failure settle their named states", async () => {
    const good = await runOne({ ending: "success", withToolFact: true });
    const goodList = await good.runs.list(good.scope, { limit: 10 });
    expect(goodList.runs[0].state).toBe("completed");
    expect(
      (await good.runs.detail(good.scope, `builtin:${good.chain}`)).run.state,
    ).toBe("completed");

    const bad = await runOne({
      ending: "error",
      withToolFact: true,
      chain: "1".repeat(32),
    });
    const badList = await bad.runs.list(bad.scope, { limit: 10 });
    expect(badList.runs[0].state).toBe("failed");
    expect(
      (await bad.runs.detail(bad.scope, `builtin:${bad.chain}`)).run.state,
    ).toBe("failed");
    const badIdentity = runUpstreamIdentity(bad.chain);
    const badRoot = bad.spanRows.get(badIdentity.rootOpikSpanId);
    expect(badRoot).toBeDefined();
    expect(
      (badRoot?.input as Record<string, unknown> | undefined)?.span_state,
    ).toBe("failed");
  });

  test("a confirmed cancel settles canceled; a disconnect settles unknown — honestly kept", async () => {
    const canceled = await runOne({
      ending: "canceled",
      withToolFact: true,
      chain: "2".repeat(32),
    });
    expect(
      (await canceled.runs.list(canceled.scope, { limit: 10 })).runs[0].state,
    ).toBe("canceled");

    const disconnected = await runOne({
      ending: "disconnected",
      withToolFact: true,
      chain: "3".repeat(32),
    });
    expect(
      (await disconnected.runs.list(disconnected.scope, { limit: 10 })).runs[0]
        .state,
    ).toBe("unknown");
    expect(
      (
        await disconnected.runs.detail(
          disconnected.scope,
          `builtin:${disconnected.chain}`,
        )
      ).run.state,
    ).toBe("unknown");
  });

  test("a retried run is a separate chain: the interrupted attempt and the completed one are both readable", async () => {
    // The first attempt ends interrupted (the approval wait), the retry is a
    // NEW chain with its own lifecycle — never a second outcome on one row.
    const first = await runOne({
      ending: "interrupted",
      withToolFact: false,
      chain: "4".repeat(32),
    });
    const second = await runOne({
      ending: "success",
      withToolFact: false,
      chain: "5".repeat(32),
      scope: aScope("user-1"),
    });
    expect(
      (await first.runs.detail(first.scope, `builtin:${first.chain}`)).run
        .state,
    ).toBe("interrupted");
    expect(
      (await second.runs.detail(second.scope, `builtin:${second.chain}`)).run
        .state,
    ).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Face 4: the boot wiring
// ---------------------------------------------------------------------------

describe("the boot wiring hands the run's lifecycle to the gate (R3-03)", () => {
  const indexSource = readFileSync(
    join(hereDir, "..", "src", "assembly", "runtime.ts"),
    "utf8",
  );
  // MOD17 moved the fact adapters into the M11 public facade; the captured-
  // scope budget below is asserted where those adapters now live.
  const publicSource = readFileSync(
    join(hereDir, "..", "src", "ai-observability", "public.ts"),
    "utf8",
  );
  const copilotSource = readFileSync(
    join(hereDir, "..", "src", "copilot.ts"),
    "utf8",
  );

  test("the built-in agent's observe chain carries the lifecycle tap beside the tool-step one", () => {
    // The composition point: every built-in Bot's run stream passes through
    // observeModelConnection(observeBuiltinRunLifecycle(observeBuiltinToolSteps))
    // — the same seam the tool-step bypass rides, so a run that emits any
    // event is a run whose lifecycle is observed.
    expect(copilotSource).toMatch(
      /observeModelConnection\(\s*observeBuiltinRunLifecycle\(observeBuiltinToolSteps\(run\)\),\s*\)/,
    );
  });

  test("the tool-step adapter records steps only — no window settles a run anymore", () => {
    // The pre-fix defect, verbatim: the tool fact's window was the one
    // run-close signal, so RUN_FINISHED success and RUN_ERROR landed as
    // unknown. The adapter must not call the window settle at all.
    expect(indexSource).not.toMatch(/settleObservedWindow/);
  });

  test("the run-lifecycle adapter is registered and settles from the run's own fact", () => {
    expect(indexSource).toMatch(/setBuiltinRunLifecycleObserver\(\(fact\)/);
    expect(indexSource).toMatch(/noteObservedRunStart/);
    expect(indexSource).toMatch(/settleObservedRun/);
    // The run fact's scope is read the same captured way, never the ambient
    // store (the t-final M1 budget on currentRunObservationScope stays 0).
    expect(
      publicSource.match(/scope: fact\.scope as ObservationScope/g)?.length,
    ).toBe(2);
    expect(
      publicSource.match(/currentRunObservationScope\(\)/g)?.length ?? 0,
    ).toBe(0);
  });
});
