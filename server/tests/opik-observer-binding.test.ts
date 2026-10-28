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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunBinding } from "../src/ai-observability/bindings";
import { createOpikHttpPort } from "../src/ai-observability/opik-http";
import { runUpstreamIdentity } from "../src/ai-observability/opik-http";
import type { VerifiedOpikContract } from "../src/ai-observability/opik-port";
import { createRunsQueryService } from "../src/ai-observability/queries/runs";

const manifest = (await Bun.file(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../src/ai-observability/opik-contract/47-manifest.json",
  ),
).json()) as VerifiedOpikContract;
import type { OpikObservationWrite } from "../src/ai-observability/health";
import { createOpikHealthService } from "../src/ai-observability/health";
import { createModelSpanRecorder } from "../src/ai-observability/model-span";
import type { ObservationScope } from "../src/ai-observability/contracts";
import type { OpikOtlpSpan, OpikPort } from "../src/ai-observability/opik-port";
import {
  resolveObservationScope,
  resolveStorageLocator,
} from "../src/ai-observability/scope";
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
      scope: ObservationScope,
      input: { runId: string; attemptId: string; traceId: string },
    ) {
      calls.push({ op: "begin", runId: input.runId });
      if (options.beginThrows) throw new Error("database is away");
      // The real store replays an existing (scope, run, attempt) row.
      const key = `${scope.key}:${input.runId}:${input.attemptId}`;
      const existing = rows.get(key);
      if (existing) return { binding: existing, replayed: true };
      // The real begin copies the locator out of the trusted scope; the
      // end-to-end read-back drives the PRODUCTION adapter, whose write guard
      // cross-checks exactly these fields.
      const locator = resolveStorageLocator(scope);
      const row = {
        scopeKey: scope.key,
        runId: input.runId,
        attemptId: input.attemptId,
        traceId: input.traceId,
        locatorWorkspace: locator.workspace,
        locatorProject: locator.project,
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

/*
 * ---------------------------------------------------------------------------
 * F5E1-F3 — the gate's materialization half: establish the binding AND the
 * run's upstream objects, in that order, before any span of the chain exports.
 * ---------------------------------------------------------------------------
 */

/** A store double that can also record reconciles (the mapping write). */
function materializingStoreDouble() {
  const base = storeDouble();
  const calls: Array<{ op: "reconcile"; runId: string; opikTraceId: string }> =
    [];
  const store = {
    ...base.store,
    async reconcile(
      scope: { key: string },
      runId: string,
      attemptId: string,
      opikTraceId: string,
    ) {
      calls.push({ op: "reconcile", runId, opikTraceId });
      const key = `${scope.key}:${runId}:${attemptId}`;
      const row = base.rows.get(key);
      if (!row) throw new RunBindingError("BINDING_NOT_FOUND", 404);
      if (row.opikTraceId !== null) return { binding: row, adopted: false };
      row.opikTraceId = opikTraceId;
      return { binding: row, adopted: true };
    },
  };
  return {
    calls: base.calls,
    reconciles: calls,
    rows: base.rows,
    store: store as unknown as Pick<
      RunBindingStore,
      "begin" | "finish" | "reconcile"
    >,
  };
}

/** A port double that scripts createTrace/writeSpans answers and records both. */
function materializingPortDouble(options: { createTrace?: unknown } = {}) {
  const created: Array<{ traceId: string; binding: unknown }> = [];
  const writes: Array<{ spans: readonly OpikOtlpSpan[]; binding: unknown }> =
    [];
  const port = {
    async healthCheck() {
      return { outcome: "ok" as const, value: { healthy: true as const } };
    },
    async createTrace(
      _scope: unknown,
      input: { traceId: string; binding?: unknown },
    ) {
      created.push({ traceId: input.traceId, binding: input.binding });
      return (
        options.createTrace ?? {
          outcome: "ok" as const,
          value: { traceId: input.traceId },
        }
      );
    },
    async writeSpans(
      _scope: unknown,
      input: { spans: readonly OpikOtlpSpan[]; binding?: unknown },
    ) {
      writes.push({ spans: input.spans, binding: input.binding });
      return { outcome: "ok" as const, value: { accepted: true as const } };
    },
  };
  return { created, writes, port: port as unknown as OpikPort };
}

describe("the gate materializes the run's upstream objects (F5E1-F3)", () => {
  test("ensure creates the derived trace, writes the run root, and reconciles the mapping", async () => {
    const double = materializingStoreDouble();
    const { created, writes, port } = materializingPortDouble();
    const identity = runUpstreamIdentity(CHAIN);
    const gate = createObserverRunBindingGate(double.store, {
      port: () => port,
    });
    const scope = aScope();

    const ref = await gate.ensure(scope, { traceId: CHAIN });

    // The upstream trace id is the chain's DERIVED identity, and the binding the
    // creation was asked under is the row's own ref (opikTraceId still null).
    expect(created).toEqual([
      {
        traceId: identity.opikTraceId,
        binding: expect.objectContaining({ opikTraceId: null }),
      },
    ]);
    // The root span: the chain as its OTel trace, no parent, an open window, and
    // explicit overrides naming the derived trace and root ids.
    expect(writes).toHaveLength(1);
    const root = writes[0].spans[0] as (typeof writes)[0]["spans"][number] & {
      opik: { traceId: string; spanId: string };
    };
    expect(root.traceId).toBe(CHAIN);
    expect(root.spanId).toBe(identity.rootSpanId);
    expect(root.parentSpanId).toBeUndefined();
    expect(root.endTimeUnixNano).toBeUndefined();
    expect(root.opik).toEqual({
      traceId: identity.opikTraceId,
      spanId: identity.rootOpikSpanId,
    });
    // The binding the root write carried names the trace it lands under.
    expect(writes[0].binding).toMatchObject({
      opikTraceId: identity.opikTraceId,
    });
    // The authoritative mapping: one reconcile, the derived id, persisted on the
    // row, and the ref the gate answers carries it.
    expect(double.reconciles).toEqual([
      {
        op: "reconcile",
        runId: `builtin:${CHAIN}`,
        opikTraceId: identity.opikTraceId,
      },
    ]);
    expect(
      double.rows.get(`${scope.key}:builtin:${CHAIN}:builtin:${CHAIN}`)
        ?.opikTraceId,
    ).toBe(identity.opikTraceId);
    expect(ref.opikTraceId).toBe(identity.opikTraceId);
  });

  test("a replayed chain materializes exactly once — the ref keeps the recorded identity", async () => {
    const double = materializingStoreDouble();
    const { created, port } = materializingPortDouble();
    const gate = createObserverRunBindingGate(double.store, {
      port: () => port,
    });
    const scope = aScope();
    const first = await gate.ensure(scope, { traceId: CHAIN });
    const second = await gate.ensure(scope, { traceId: CHAIN });
    expect(second).toEqual(first);
    expect(created).toHaveLength(1);
    expect(double.reconciles).toHaveLength(1);
  });

  test("a create that cannot be observed fails the export closed — no span, no mapping", async () => {
    const double = materializingStoreDouble();
    const { writes, port } = materializingPortDouble({
      createTrace: {
        outcome: "unavailable",
        operation: "createTrace",
        code: "OPIK_TIMEOUT",
      },
    });
    const gate = createObserverRunBindingGate(double.store, {
      port: () => port,
    });
    const scope = aScope();
    await expect(gate.ensure(scope, { traceId: CHAIN })).rejects.toThrow(
      new RunBindingError("BINDING_UPSTREAM_UNAVAILABLE", 503),
    );
    // Nothing was exported and nothing was claimed: the binding stays
    // unreconciled and the row's next fact retries the whole materialization.
    expect(writes).toHaveLength(0);
    expect(double.reconciles).toHaveLength(0);
    expect(
      double.rows.get(`${scope.key}:builtin:${CHAIN}:builtin:${CHAIN}`)
        ?.opikTraceId,
    ).toBeNull();
  });

  test("the recorder path fails the write closed when materialization fails, and the counters see it", async () => {
    const double = materializingStoreDouble();
    const { port } = materializingPortDouble({
      createTrace: {
        outcome: "unavailable",
        operation: "createTrace",
        code: "OPIK_TIMEOUT",
      },
    });
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
      port: port as unknown as Parameters<
        typeof createOpikHealthService
      >[0]["port"],
    });
    await health.readiness();
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
    // The span never completed: materialization is part of the export, and its
    // failure fails the write — counted, never a partial export.
    expect(stats.completed).toBe(0);
    expect(stats.failed.unexpected).toBe(1);
  });

  test("a gate without a port keeps its binding-only shape (the test seam, unchanged)", async () => {
    const double = materializingStoreDouble();
    const gate = createObserverRunBindingGate(double.store);
    const ref = await gate.ensure(aScope(), { traceId: CHAIN });
    expect(ref.opikTraceId).toBeNull();
    expect(double.reconciles).toHaveLength(0);
  });

  test("a binding whose row already records an upstream id skips materialization", async () => {
    const double = materializingStoreDouble();
    const { created, port } = materializingPortDouble();
    const scope = aScope();
    const identity = runUpstreamIdentity(CHAIN);
    double.rows.set(`${scope.key}:builtin:${CHAIN}:builtin:${CHAIN}`, {
      scopeKey: scope.key,
      runId: `builtin:${CHAIN}`,
      attemptId: `builtin:${CHAIN}`,
      traceId: CHAIN,
      locatorWorkspace: "ws",
      locatorProject: "default",
      opikTraceId: identity.opikTraceId,
      state: "running",
    });
    const gate = createObserverRunBindingGate(double.store, {
      port: () => port,
    });
    const ref = await gate.ensure(scope, { traceId: CHAIN });
    expect(ref.opikTraceId).toBe(identity.opikTraceId);
    expect(created).toHaveLength(0);
  });

  test("the observed-window settle reconciles too when the chain had no span yet", async () => {
    const double = materializingStoreDouble();
    const { created, port } = materializingPortDouble();
    const identity = runUpstreamIdentity(CHAIN);
    const gate = createObserverRunBindingGate(double.store, {
      port: () => port,
    });
    const scope = aScope();
    gate.settleObservedWindow(scope, { traceId: CHAIN }, "terminal");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(created).toHaveLength(1);
    expect(
      double.rows.get(`${scope.key}:builtin:${CHAIN}:builtin:${CHAIN}`)?.state,
    ).toBe("unknown");
    expect(
      double.rows.get(`${scope.key}:builtin:${CHAIN}:builtin:${CHAIN}`)
        ?.opikTraceId,
    ).toBe(identity.opikTraceId);
  });
});

/*
 * ---------------------------------------------------------------------------
 * F5E1-F3 — the read-back half: a run materialized and exported through the
 * production gate/recorders, over the PRODUCTION adapter against a scripted
 * transport that adopts the explicit-id semantics the verified contract
 * documents, is LISTABLE, locatable in detail, and its step timeline carries
 * the true parent-child.
 * ---------------------------------------------------------------------------
 */

describe("a materialized run is locatable end to end (F5E1-F3)", () => {
  /**
   * A scripted Opik over the verified HTTP surface: trace rows come from the
   * REST create, span rows from the OTLP write (the mapper's explicit path
   * adopts the `opik.*` attributes verbatim, exactly as reference/
   * opik-contract.md documents), and the two listings answer over the same
   * rows the query face reads. The adapter is the production one — the ids the
   * assertions see are the ones the wire actually carried.
   */
  function scriptedOpik() {
    const traceRows: Array<Record<string, unknown>> = [];
    const spanRows: Array<Record<string, unknown>> = [];
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
        // Echo the asked-for name: the adapter drift-checks the answer against
        // the locator, and a scripted mismatch would suspend the scope's writes.
        return json(200, { id: "proj-f6b", name: body.name });
      }
      if (
        url === "http://opik.test/api/v1/private/traces" &&
        method === "POST"
      ) {
        traceRows.push({ id: body.id });
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
          span.attributes?.find((entry) => entry.key === key)?.value
            ?.stringValue;
        for (const span of spans) {
          spanRows.push({
            id: attribute(span, "opik.span_id") ?? `derived-${span.spanId}`,
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
        const ofTrace = spanRows.filter((row) => row.trace_id === traceId);
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

  test("list names the run, detail is present, and steps carry the root parentage", async () => {
    const { port, traceRows, spanRows } = scriptedOpik();
    const double = materializingStoreDouble();
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
    const models = createModelSpanRecorder({
      healthService: health,
      bindings: gate,
    });
    const steps = createToolStepRecorder({
      healthService: health,
      bindings: gate,
    });
    const scope = aScope();
    const identity = runUpstreamIdentity(CHAIN);

    models.record({
      occurredAt: new Date("2026-10-25T00:00:00.000Z"),
      endedAt: new Date("2026-10-25T00:00:01.000Z"),
      ending: { kind: "succeeded", inputTokens: 2051, outputTokens: 32 },
      scope,
      trace: { traceId: CHAIN },
    });
    steps.record({
      toolCallId: "call-1",
      toolName: "report_environment",
      endedAt: new Date("2026-10-25T00:00:02.000Z"),
      proposalObserved: true,
      executionObserved: false,
      receiptObserved: false,
      window: "terminal",
      scope,
      // The ambient parent the facts captured — the very span id the F5E1
      // evidence watched dangling (`…bc1752c6f4dc`): upstream it must not dangle.
      trace: { traceId: CHAIN, parentSpanId: "bc1752c6f4dc" },
    });
    await health.drain();
    // Both business writes completed through the production queue; the run's
    // materialization (trace + root span + reconcile) rode inside the first
    // one's perform, before its span reached the port.
    expect(health.writeStats().completed).toBe(2);

    // The read face over the same upstream, through the production query
    // service, with the binding seams fed by the very rows the gate wrote.
    const runs = createRunsQueryService({
      bindings: {
        latestAttempt: async (queryScope, runId) => {
          const row = double.rows.get(`${queryScope.key}:${runId}:${runId}`);
          if (!row) return null;
          return {
            id: row.runId,
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
            state: row.state as "running",
            expiresAt: new Date(Date.now() + 60_000),
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          } satisfies RunBinding;
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

    // LIST: the run is there — the trace row the gate materialized — joined to
    // the binding's capability, with no "still syncing" residue left over.
    const listed = await runs.list(scope, { limit: 10 });
    expect(listed.runs).toHaveLength(1);
    expect(listed.runs[0].opikTraceId).toBe(identity.opikTraceId);
    expect(listed.runs[0].capability).toBe("detailed");
    expect(listed.syncing).toBe(false);
    // One upstream trace row — the run's own, not one per span.
    expect(traceRows).toEqual([{ id: identity.opikTraceId }]);

    // DETAIL: reconciled and present — never the pre-fix "unreconciled".
    const runId = `builtin:${CHAIN}`;
    const detail = await runs.detail(scope, runId);
    expect(detail.run.opikTraceId).toBe(identity.opikTraceId);
    expect(detail.upstream).toMatchObject({
      status: "present",
      opikTraceId: identity.opikTraceId,
    });

    // STEPS: the model and tool spans are there, each parented at the run
    // root's UPSTREAM id — the parent the materialization actually wrote, so
    // the ambient hex the facts captured no longer dangles. The root itself is
    // under its own id and outside the step families.
    const timeline = await runs.steps(scope, runId);
    expect(timeline.steps.map((step) => step.kind)).toEqual(["model", "tool"]);
    expect(new Set(timeline.steps.map((step) => step.parentSpanId))).toEqual(
      new Set([identity.rootOpikSpanId]),
    );
    expect(spanRows).toHaveLength(3); // the run root + the two business spans
    expect(spanRows.some((row) => row.id === identity.rootOpikSpanId)).toBe(
      true,
    );
  });
});
