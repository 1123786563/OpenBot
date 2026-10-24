// FREV-02 — the observer-path run-binding gate: no business span exports without
// a local authoritative binding.
//
// The final review's probe drove the production recorder with nothing but a scope
// and watched a business span queue for export (`queued=1, hasBinding=false`).
// This suite pins the closed shape on both halves:
//   1. the recorder side — a gate that cannot establish the binding fails the
//      write closed: nothing reaches the port, and the failure surfaces on the
//      health service's own counters (A10: visible, never silent, never faked);
//   2. the port side — a writeSpans without a binding is refused pre-I/O (the
//      runtime half for callers that bypass the recorder seam entirely).
//
// The gate's store loop (begin-before-export, replay, divergent-chain refusal,
// window settle) runs against the real store in the bindings suites; the fakes
// here are only the queue, the port and the store double.
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import {
  createObserverRunBindingGate,
  observerChainId,
  RunBindingError,
  type RunBindingStore,
} from "../src/ai-observability/bindings";
import type { OpikObservationWrite } from "../src/ai-observability/health";
import { createOpikHealthService } from "../src/ai-observability/health";
import { createModelSpanRecorder } from "../src/ai-observability/model-span";
import type { OpikOtlpSpan, OpikPort } from "../src/ai-observability/opik-port";
import { resolveObservationScope } from "../src/ai-observability/scope";
import { createToolStepRecorder } from "../src/ai-observability/tool-steps";

function aScope() {
  return resolveObservationScope({
    actorId: "user-1",
    botId: "bot-1",
    ownership: "owner",
    epoch: 1,
  });
}

const CHAIN = "0123456789abcdef0123456789abcdef";

/** A store double: every begin/finish call is recorded, answers are scripted. */
function storeDouble(options: { beginThrows?: boolean } = {}) {
  const calls: Array<{ op: "begin" | "finish"; runId: string }> = [];
  const rows = new Map<
    string,
    {
      scopeKey: string;
      runId: string;
      attemptId: string;
      traceId: string;
      locatorWorkspace: string;
      locatorProject: string;
      opikTraceId: string | null;
      state: string;
    }
  >();
  const store = {
    async begin(
      scope: { key: string },
      input: { runId: string; attemptId: string; traceId: string },
    ) {
      calls.push({ op: "begin", runId: input.runId });
      if (options.beginThrows) throw new Error("database is away");
      // The real store replays an existing (scope, run, attempt) row.
      const key = `${scope.key}:${input.runId}:${input.attemptId}`;
      const existing = rows.get(key);
      if (existing) return { binding: existing, replayed: true };
      const row = {
        scopeKey: scope.key,
        runId: input.runId,
        attemptId: input.attemptId,
        traceId: input.traceId,
        locatorWorkspace: "ws",
        locatorProject: "default",
        opikTraceId: null,
        state: "running",
      };
      rows.set(`${scope.key}:${input.runId}:${input.attemptId}`, row);
      return { binding: row, replayed: false };
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
    store: store as unknown as Pick<RunBindingStore, "begin" | "finish">,
  };
}

/** A port fake that records what writeSpans actually received. */
function portDouble() {
  const writes: Array<{
    spans: readonly OpikOtlpSpan[];
    binding: unknown;
  }> = [];
  const port = {
    async healthCheck() {
      return { outcome: "ok" as const, value: { healthy: true as const } };
    },
    async writeSpans(
      _scope: unknown,
      input: { spans: readonly OpikOtlpSpan[]; binding?: unknown },
    ) {
      writes.push({ spans: input.spans, binding: input.binding });
      return { outcome: "ok" as const, value: { accepted: true as const } };
    },
  };
  return { writes, port: port as unknown as OpikPort };
}

describe("the observer binding gate against a failing store (FREV-02)", () => {
  test("a binding that cannot be established exports nothing and counts the failure", async () => {
    const double = storeDouble({ beginThrows: true });
    const gate = createObserverRunBindingGate(double.store);
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
      port: portDouble().port,
    });
    await health.readiness(); // the gate answers, so the write is performed
    const recorder = createModelSpanRecorder({
      healthService: health,
      bindings: gate,
    });
    recorder.record({
      occurredAt: new Date(),
      endedAt: new Date(),
      ending: { kind: "succeeded", inputTokens: 1, outputTokens: 1 },
      scope: aScope(),
      trace: { traceId: CHAIN },
    });
    await health.drain();

    const stats = health.writeStats();
    expect(stats.submitted).toBe(1);
    // The write failed visibly — counted as a failure, never completed, never
    // dropped silently, and never a faked success.
    expect(stats.completed).toBe(0);
    expect(stats.failed.unexpected).toBe(1);
    // And its span never reached the port: zero exports for this run.
    expect(double.calls.filter((call) => call.op === "begin")).toHaveLength(1);
  });

  test("a store that answers exports the span WITH the established binding", async () => {
    const double = storeDouble();
    const gate = createObserverRunBindingGate(double.store);
    const { writes, port } = portDouble();
    const submitted: OpikObservationWrite[] = [];
    const recorder = createModelSpanRecorder({
      healthService: {
        submit(write) {
          submitted.push(write);
          return "accepted";
        },
      },
      bindings: gate,
    });
    recorder.record({
      occurredAt: new Date(),
      endedAt: new Date(),
      ending: { kind: "succeeded", inputTokens: 1, outputTokens: 1 },
      scope: aScope(),
      trace: { traceId: CHAIN },
    });
    for (const write of submitted) await write.perform(port);

    expect(writes).toHaveLength(1);
    // The binding the port received is the one the store persisted: the run's
    // chain, under the builtin identity, ready for the write guard's checks.
    expect(writes[0].binding).toMatchObject({
      runId: `builtin:${CHAIN}`,
      attemptId: `builtin:${CHAIN}`,
      opikTraceId: null,
    });
    // begin happened exactly once for the chain, before the write performed.
    expect(double.calls).toEqual([{ op: "begin", runId: `builtin:${CHAIN}` }]);
  });

  test("a replayed begin answers the same binding without a second row", async () => {
    const double = storeDouble();
    const gate = createObserverRunBindingGate(double.store);
    const scope = aScope();
    const first = await gate.ensure(scope, { traceId: CHAIN });
    const second = await gate.ensure(scope, { traceId: CHAIN });
    expect(second).toEqual(first);
    expect(double.calls).toHaveLength(1);
  });

  test("a divergent chain on the authoritative row refuses — the first claim stands", async () => {
    const double = storeDouble();
    const gate = createObserverRunBindingGate(double.store);
    const scope = aScope();
    // The store's replay answers the EXISTING row (same authoritative triple,
    // a different chain was recorded first).
    double.rows.set(`${scope.key}:builtin:${CHAIN}:builtin:${CHAIN}`, {
      scopeKey: scope.key,
      runId: `builtin:${CHAIN}`,
      attemptId: `builtin:${CHAIN}`,
      traceId: "f".repeat(32),
      locatorWorkspace: "ws",
      locatorProject: "default",
      opikTraceId: null,
      state: "running",
    });
    await expect(gate.ensure(scope, { traceId: CHAIN })).rejects.toThrow(
      RunBindingError,
    );
  });

  test("an observed window settles the chain's binding, once, with the honest state", async () => {
    const double = storeDouble();
    const gate = createObserverRunBindingGate(double.store);
    const scope = aScope();
    await gate.ensure(scope, { traceId: CHAIN });
    gate.settleObservedWindow(scope, { traceId: CHAIN }, "terminal");
    gate.settleObservedWindow(scope, { traceId: CHAIN }, "terminal");
    // First settle wins; a terminal close without an outcome is unknown.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(double.calls).toEqual([
      { op: "begin", runId: `builtin:${CHAIN}` },
      { op: "finish", runId: `builtin:${CHAIN}` },
    ]);
    expect(
      double.rows.get(`${scope.key}:builtin:${CHAIN}:builtin:${CHAIN}`)?.state,
    ).toBe("unknown");

    const interrupted = createObserverRunBindingGate(double.store);
    await interrupted.ensure(scope, { traceId: "e".repeat(32) });
    interrupted.settleObservedWindow(
      scope,
      { traceId: "e".repeat(32) },
      "interrupted",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      double.rows.get(
        `${scope.key}:builtin:${"e".repeat(32)}:builtin:${"e".repeat(32)}`,
      )?.state,
    ).toBe("interrupted");
  });

  test("a malformed chain never reaches the store", async () => {
    const double = storeDouble();
    const gate = createObserverRunBindingGate(double.store);
    await expect(gate.ensure(aScope(), { traceId: "nothex!" })).rejects.toThrow(
      RunBindingError,
    );
    expect(double.calls).toHaveLength(0);
  });

  test("observerChainId admits only the W3C shape", () => {
    expect(observerChainId(CHAIN)).toBe(CHAIN);
    expect(observerChainId(undefined)).toBeNull();
    expect(observerChainId("nothex!")).toBeNull();
    expect(observerChainId("abc")).toBeNull();
  });
});

describe("the recorders hold the gate as a required seam (FREV-02)", () => {
  test("a tool step exports with its runRef when the association is carried", async () => {
    const double = storeDouble();
    const gate = createObserverRunBindingGate(double.store);
    const { writes, port } = portDouble();
    const submitted: OpikObservationWrite[] = [];
    const recorder = createToolStepRecorder({
      healthService: {
        submit(write) {
          submitted.push(write);
          return "accepted";
        },
        countIdLink: () => {},
      },
      bindings: gate,
    });
    recorder.record({
      toolCallId: "call-1",
      endedAt: new Date(),
      proposalObserved: true,
      executionObserved: true,
      receiptObserved: true,
      window: "terminal",
      scope: aScope(),
      trace: {
        traceId: CHAIN,
        runRef: { runId: "run-1", attemptId: "attempt-1" },
      },
    });
    for (const write of submitted) await write.perform(port);
    expect(writes).toHaveLength(1);
    expect(writes[0].binding).toMatchObject({
      runId: "run-1",
      attemptId: "attempt-1",
    });
    expect(double.calls).toEqual([{ op: "begin", runId: "run-1" }]);
  });

  test("a half-carried runRef refuses rather than binding under an overridden id", async () => {
    const double = storeDouble();
    const gate = createObserverRunBindingGate(double.store);
    await expect(
      gate.ensure(aScope(), {
        traceId: CHAIN,
        runRef: { runId: "run-1", attemptId: "  " },
      }),
    ).rejects.toThrow(RunBindingError);
    expect(double.calls).toHaveLength(0);
  });

  test("a chain-less tool observation submits nothing at all", async () => {
    const submitted: OpikObservationWrite[] = [];
    const recorder = createToolStepRecorder({
      healthService: {
        submit(write) {
          submitted.push(write);
          return "accepted";
        },
        countIdLink: () => {},
      },
      bindings: createObserverRunBindingGate(storeDouble().store),
    });
    recorder.record({
      toolCallId: "call-1",
      endedAt: new Date(),
      proposalObserved: true,
      executionObserved: false,
      receiptObserved: false,
      window: "terminal",
      scope: aScope(),
    });
    expect(submitted).toHaveLength(0);
  });
});
