// Issue #21 / DAG T15 — tool proposals vs real executions and retrieval steps.
//
// Every case here runs against injected fakes, exactly like the other opik suites: no
// database, no network (the one retriever case mocks global fetch) and no real Opik
// write ever happens here.
//
// The acceptance under test, in issue order:
//   1. a tool PROPOSAL, a REAL execute and a MISSING receipt are three separately
//      recorded facts with three distinct display states (proposed/executed/unobserved).
//   2. an execution this deployment never observed (a browser tool the run left
//      unanswered) is never displayed as success.
//   3. retrieval steps are locatable (kb/chunk/doc/source/score per fragment) and
//      canaries in inputs, outputs and error text cannot survive into a real span.
//   4. the step typing reads event/callback semantics only — the classification
//      module imports no framework, public or private.

import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { readFileSync } from "node:fs";
import type { BaseEvent } from "@ag-ui/client";
import { context, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { Observable, Subject } from "rxjs";
import type { OpikObservationWrite } from "../src/ai-observability/health";
import type { OpikOtlpSpan, OpikPort } from "../src/ai-observability/opik-port";
import { resolveObservationScope } from "../src/ai-observability/scope";
import {
  createToolStepRecorder,
  type RetrievalStepObservation,
  type ToolStepObservation,
  toolStepExecutionState,
  toolStepTerminalState,
} from "../src/ai-observability/tool-steps";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import {
  type BuiltinToolStepFact,
  setBuiltinToolStepObserver,
  toolStepObservationForTests,
} from "../src/copilot";
import { createKnowledgeCircuit } from "../src/knowledge/circuit";
import {
  createKnowledgeRetriever,
  setKnowledgeRetrievalObserver,
} from "../src/knowledge/retrieval";
import { withRunObservationScope } from "../src/observation-run-scope";

// ---------------------------------------------------------------------------
// Fakes
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

function aScope() {
  return resolveObservationScope({
    actorId: "user-1",
    botId: "bot-1",
    ownership: "owner",
    epoch: 1,
  });
}

/** Records one tool-step observation and returns the spans the port would receive. */
async function recordAndCapture(
  observation: ToolStepObservation,
): Promise<{ writes: ReturnType<typeof fakePort>["writes"] }> {
  const queue = fakeQueue();
  const recorder = createToolStepRecorder({ healthService: queue.queue });
  recorder.record(observation);
  const port = fakePort();
  for (const write of queue.submitted) await write.perform(port.port);
  return { writes: port.writes };
}

/** Same drain for a retrieval step. */
async function recordRetrievalAndCapture(
  observation: RetrievalStepObservation,
): Promise<{ writes: ReturnType<typeof fakePort>["writes"] }> {
  const queue = fakeQueue();
  const recorder = createToolStepRecorder({ healthService: queue.queue });
  recorder.recordRetrieval(observation);
  const port = fakePort();
  for (const write of queue.submitted) await write.perform(port.port);
  return { writes: port.writes };
}

const startedAt = new Date("2026-10-16T11:00:00.000Z");
const endedAt = new Date("2026-10-16T11:00:01.500Z");

// Assembled, never literal, so a leak has to be matched by content, not grep-ability.
const CANARY_KEY = `sk-live-${"a".repeat(24)}`;
const CANARY_TOKEN = `Bearer ${"B".repeat(24)}`;
const CANARY_GH = `ghp_${"c".repeat(24)}`;

/** A plain structural AG-UI event — exactly the public fields, nothing more. */
const ev = (event: Record<string, unknown>) => event as unknown as BaseEvent;

/** A provider whose only processor hands ended spans to the test. */
function recordedSpansForBypass(): {
  spans: ReadableSpan[];
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
  return {
    spans,
    stop: async () => {
      await provider.shutdown();
      trace.disable();
    },
  };
}

// ---------------------------------------------------------------------------
// The pure determination: step kind, three-way execution state, terminal state
// ---------------------------------------------------------------------------

describe("the three-way execution determination", () => {
  test("a real execute is the only evidence of executed (acceptance 1, A3)", () => {
    expect(
      toolStepExecutionState({
        executionObserved: true,
        receiptObserved: true,
        window: "terminal",
      }),
    ).toBe("executed");
    // A proposal and even a receipt do not impersonate an execution we never ran.
    expect(
      toolStepExecutionState({
        executionObserved: false,
        receiptObserved: true,
        window: "terminal",
      }),
    ).toBe("unobserved");
  });

  test("an interrupted window leaves the step proposed, not unobserved (acceptance 1)", () => {
    expect(
      toolStepExecutionState({
        executionObserved: false,
        receiptObserved: false,
        window: "interrupted",
      }),
    ).toBe("proposed");
  });

  test("a terminal window without a receipt is unobserved (acceptance 1)", () => {
    expect(
      toolStepExecutionState({
        executionObserved: false,
        receiptObserved: false,
        window: "terminal",
      }),
    ).toBe("unobserved");
  });

  test("only an observed successful execution maps to completed (acceptance 2)", () => {
    expect(
      toolStepTerminalState({
        executionObserved: true,
        receiptObserved: true,
        window: "terminal",
        execution: { kind: "succeeded", output: "ok" },
      }),
    ).toBe("completed");
    expect(
      toolStepTerminalState({
        executionObserved: true,
        receiptObserved: true,
        window: "terminal",
        execution: { kind: "failed", output: "boom" },
      }),
    ).toBe("failed");
    expect(
      toolStepTerminalState({
        executionObserved: true,
        receiptObserved: true,
        window: "terminal",
        execution: { kind: "canceled", output: null },
      }),
    ).toBe("canceled");
    // Every non-executed determination — proposed, unobserved, receipt-only —
    // is unknown, never success.
    for (const observation of [
      {
        executionObserved: false,
        receiptObserved: false,
        window: "interrupted",
      },
      { executionObserved: false, receiptObserved: false, window: "terminal" },
      { executionObserved: false, receiptObserved: true, window: "terminal" },
    ]) {
      expect(toolStepTerminalState(observation)).toBe("unknown");
    }
    // An execution observed without its settled outcome is unknown, not success.
    expect(
      toolStepTerminalState({
        executionObserved: true,
        receiptObserved: true,
        window: "terminal",
      }),
    ).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// The tool step recorder: projection, span build, write-queue entry
// ---------------------------------------------------------------------------

describe("the tool step recorder", () => {
  test("unusable timestamps degrade to borrowed ones, never to 1970 (OCR m157)", async () => {
    const badDates = await recordAndCapture({
      toolCallId: "call-bad",
      toolName: "host_read",
      proposedAt: new Date("not-a-date"),
      endedAt: new Date("not-a-date"),
      proposalObserved: true,
      executionObserved: true,
      receiptObserved: true,
      execution: { kind: "succeeded", output: "42" },
      window: "terminal",
      input: "{}",
      output: "42",
      scope: aScope(),
    });
    const span = badDates.writes[0]?.spans[0];
    expect(span?.startTimeUnixNano).not.toBe("0");
    expect(span?.endTimeUnixNano).not.toBe("0");
    expect(span?.startTimeUnixNano).toBe(span?.endTimeUnixNano);

    // A valid end with an unusable start borrows the end: zero duration, sane order.
    const borrowed = await recordAndCapture({
      toolCallId: "call-borrow",
      toolName: "host_read",
      proposedAt: new Date("not-a-date"),
      endedAt,
      proposalObserved: true,
      executionObserved: true,
      receiptObserved: true,
      execution: { kind: "succeeded", output: "42" },
      window: "terminal",
      input: "{}",
      output: "42",
      scope: aScope(),
    });
    const b = borrowed.writes[0]?.spans[0];
    expect(BigInt(b?.startTimeUnixNano ?? "0")).toBe(
      BigInt(b?.endTimeUnixNano ?? "1"),
    );
  });

  test("the three facts are recorded separately and displayed distinctly (acceptance 1)", async () => {
    const executed = await recordAndCapture({
      toolCallId: "call-1",
      toolName: "host_read",
      proposedAt: startedAt,
      endedAt,
      proposalObserved: true,
      executionObserved: true,
      receiptObserved: true,
      execution: { kind: "succeeded", output: "42" },
      window: "terminal",
      input: '{"path":"/etc/hosts"}',
      output: "42",
      scope: aScope(),
    });
    const span = executed.writes[0].spans[0];
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.name).toEqual({ state: "projected", text: "tool:host_read" });
    expect(span.attributes?.step_kind).toEqual({
      state: "projected",
      value: "tool",
    });
    expect(span.attributes?.execution_state).toEqual({
      state: "projected",
      value: "executed",
    });
    // Three separate observed-or-not facts, not one collapsed status.
    expect(span.attributes?.proposal_observed).toEqual({
      state: "projected",
      value: true,
    });
    expect(span.attributes?.execution_observed).toEqual({
      state: "projected",
      value: true,
    });
    expect(span.attributes?.receipt_observed).toEqual({
      state: "projected",
      value: true,
    });
    expect(span.attributes?.span_state).toEqual({
      state: "projected",
      value: "completed",
    });
    expect(span.attributes?.origin).toEqual({
      state: "projected",
      value: "builtin",
    });
    expect(span.attributes?.input).toEqual({
      state: "projected",
      value: '{"path":"/etc/hosts"}',
    });
    expect(span.attributes?.output).toEqual({
      state: "projected",
      value: "42",
    });
  });

  test("an unobserved browser execution is displayed unknown, never success (acceptance 2)", async () => {
    const { writes } = await recordAndCapture({
      toolCallId: "call-b",
      toolName: "computer_click",
      proposedAt: startedAt,
      endedAt,
      proposalObserved: true,
      executionObserved: false,
      receiptObserved: false,
      window: "terminal",
      scope: aScope(),
    });
    const span = writes[0].spans[0];
    expect(span.attributes?.execution_state).toEqual({
      state: "projected",
      value: "unobserved",
    });
    expect(span.attributes?.span_state).toEqual({
      state: "projected",
      value: "unknown",
    });
    // The proposal itself stays visible — recorded, not erased and not promoted.
    expect(span.attributes?.proposal_observed).toEqual({
      state: "projected",
      value: true,
    });
  });

  test("a proposed (interrupted) step is displayed proposed, unknown — not success", async () => {
    const { writes } = await recordAndCapture({
      toolCallId: "call-p",
      toolName: "host_read",
      proposedAt: startedAt,
      endedAt,
      proposalObserved: true,
      executionObserved: false,
      receiptObserved: false,
      window: "interrupted",
      scope: aScope(),
    });
    const span = writes[0].spans[0];
    expect(span.attributes?.execution_state).toEqual({
      state: "projected",
      value: "proposed",
    });
    expect(span.attributes?.span_state).toEqual({
      state: "projected",
      value: "unknown",
    });
  });

  test("a failed execution carries its outcome, and a nameless call still names the span", async () => {
    const { writes } = await recordAndCapture({
      toolCallId: "call-f",
      proposedAt: startedAt,
      endedAt,
      proposalObserved: true,
      executionObserved: true,
      receiptObserved: true,
      execution: { kind: "failed", output: "upstream refused" },
      window: "terminal",
      scope: aScope(),
    });
    const span = writes[0].spans[0];
    expect(span.attributes?.execution_outcome).toEqual({
      state: "projected",
      value: "failed",
    });
    expect(span.attributes?.span_state).toEqual({
      state: "projected",
      value: "failed",
    });
    // No tool name observed: a known-safe literal stands in, never an omission
    // (a withheld name would be refused by the port).
    expect(span.name).toEqual({ state: "projected", text: "tool" });
  });

  test("canaries in input, output and error text cannot survive (acceptance 3)", async () => {
    const { writes } = await recordAndCapture({
      toolCallId: "call-c",
      toolName: "host_read",
      proposedAt: startedAt,
      endedAt,
      proposalObserved: true,
      executionObserved: true,
      receiptObserved: true,
      execution: { kind: "failed", output: `connector failed ${CANARY_GH}` },
      window: "terminal",
      input: `{"q":"${CANARY_KEY}"}`,
      output: `leaked ${CANARY_TOKEN}`,
      scope: aScope(),
    });
    const span = writes[0].spans[0];
    const serialized = JSON.stringify(span);
    expect(serialized).not.toContain(CANARY_KEY);
    expect(serialized).not.toContain(CANARY_TOKEN);
    expect(serialized).not.toContain(CANARY_GH);
    expect(span.attributes?.input).toEqual({
      state: "omitted",
      reason: "credential",
    });
    expect(span.attributes?.output).toEqual({
      state: "omitted",
      reason: "credential",
    });
  });

  test("the span enters ONLY through the T09 write queue, one write per observation", () => {
    const queue = fakeQueue();
    const recorder = createToolStepRecorder({ healthService: queue.queue });
    recorder.record({
      toolCallId: "call-q",
      endedAt,
      proposalObserved: true,
      executionObserved: false,
      receiptObserved: false,
      window: "terminal",
      scope: aScope(),
    });
    expect(queue.submitted).toHaveLength(1);
    expect(queue.submitted[0].operation).toBe("writeSpans");
    expect(queue.submitted[0].scopeKey.length).toBeGreaterThan(0);
  });

  test("an observation without a trusted scope writes nothing upstream", () => {
    const queue = fakeQueue();
    const recorder = createToolStepRecorder({ healthService: queue.queue });
    recorder.record({
      toolCallId: "call-s",
      endedAt,
      proposalObserved: true,
      executionObserved: false,
      receiptObserved: false,
      window: "terminal",
    });
    recorder.recordRetrieval({
      occurredAt: startedAt,
      endedAt,
      query: "anything",
      outcome: { kind: "miss" },
    });
    expect(queue.submitted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The retrieval step recorder
// ---------------------------------------------------------------------------

describe("the retrieval step recorder", () => {
  test("a hit carries locatable fragments (acceptance 3)", async () => {
    const { writes } = await recordRetrievalAndCapture({
      occurredAt: startedAt,
      endedAt,
      query: "vacation policy",
      kbIds: ["kb-1", "kb-2"],
      outcome: {
        kind: "hit",
        fragments: [
          {
            kbId: "kb-1",
            chunkId: "chunk-9",
            docId: "doc-7",
            source: "handbook.md",
            score: 0.91,
          },
          {
            kbId: "kb-2",
            chunkId: "chunk-12",
            docId: "doc-3",
            source: "https://intranet.example/policy",
            score: 0.4,
          },
        ],
      },
      scope: aScope(),
    });
    const span = writes[0].spans[0];
    expect(span.name).toEqual({ state: "projected", text: "retrieval" });
    expect(span.attributes?.step_kind).toEqual({
      state: "projected",
      value: "retrieval",
    });
    expect(span.attributes?.span_state).toEqual({
      state: "projected",
      value: "completed",
    });
    expect(span.attributes?.fragment_count).toEqual({
      state: "projected",
      value: 2,
    });
    expect(span.attributes?.input).toEqual({
      state: "projected",
      value: "vacation policy",
    });
    // G3: the summary's id list lands as a BARE string array — the read contract
    // (T18) reads `kb_ids` as strings, and the port's serializer unwraps only the
    // outermost SafeValue envelope. Per-element envelopes reached the upstream row
    // and blinded the read side's summary (the T37-registered gap).
    expect(span.attributes?.kb_ids).toEqual({
      state: "projected",
      value: ["kb-1", "kb-2"],
    });
    // Each fragment keeps its locators as BARE values (OCR R2-32): the read
    // side and the wire serializer unwrap only the outermost SafeValue envelope,
    // so per-key envelopes landed upstream verbatim and blinded every consumer
    // that reads the locators as plain values — the same mechanism the kb_ids
    // list's T37 G3 fix removed one attribute earlier.
    const fragmentsAttribute = span.attributes?.fragments as
      | { state: string; value: unknown }
      | undefined;
    const fragments = fragmentsAttribute?.value as Array<
      Record<string, unknown>
    >;
    expect(fragments).toHaveLength(2);
    expect(fragments[0]).toEqual({
      kb_id: "kb-1",
      chunk_id: "chunk-9",
      doc_id: "doc-7",
      source: "handbook.md",
      score: 0.91,
    });
    expect(fragments[1]).toEqual({
      kb_id: "kb-2",
      chunk_id: "chunk-12",
      doc_id: "doc-3",
      source: "https://intranet.example/policy",
      score: 0.4,
    });
  });

  test("fragments beyond the cap land truncated and bare, with the truncation promoted to real attributes (OCR R2-32)", async () => {
    // MAX_FRAGMENTS is 64 (the retriever's own top_k ceiling, defensively
    // doubled); 69 fragments force the truncated outer state.
    const many = Array.from({ length: 69 }, (_, i) => ({
      kbId: `kb-${i}`,
      chunkId: `chunk-${i}`,
    }));
    const { writes } = await recordRetrievalAndCapture({
      occurredAt: startedAt,
      endedAt,
      query: "q",
      outcome: { kind: "hit", fragments: many },
      scope: aScope(),
    });
    const span = writes[0].spans[0];
    const fragmentsAttribute = span.attributes?.fragments as
      | { state: string; value: unknown }
      | undefined;
    expect(fragmentsAttribute?.state).toBe("truncated");
    const fragments = fragmentsAttribute?.value as Array<
      Record<string, unknown>
    >;
    expect(fragments).toHaveLength(64);
    expect(fragments[0]).toEqual({ kb_id: "kb-0", chunk_id: "chunk-0" });
    // attribute() reads ONLY safe.value, so the truncated envelope's own
    // originalBytes/dropped never reached the wire; they ride as real span
    // attributes instead of being silently dropped.
    expect(span.attributes?.fragments_dropped).toEqual({
      state: "projected",
      value: 5,
    });
    expect(span.attributes?.fragments_original_bytes).toEqual({
      state: "projected",
      value: -1,
    });
  });

  test("a degraded retrieval is a failed step with its reason; a miss completed", async () => {
    const degraded = await recordRetrievalAndCapture({
      occurredAt: startedAt,
      endedAt,
      query: "q",
      kbIds: ["kb-1"],
      outcome: { kind: "degraded", reason: "circuit-open" },
      scope: aScope(),
    });
    const degradedSpan = degraded.writes[0].spans[0];
    expect(degradedSpan.attributes?.span_state).toEqual({
      state: "projected",
      value: "failed",
    });
    expect(degradedSpan.attributes?.retrieval_outcome).toEqual({
      state: "projected",
      value: "degraded",
    });
    expect(degradedSpan.attributes?.degraded_reason).toEqual({
      state: "projected",
      value: "circuit-open",
    });

    const miss = await recordRetrievalAndCapture({
      occurredAt: startedAt,
      endedAt,
      query: "q",
      kbIds: ["kb-1"],
      outcome: { kind: "miss" },
      scope: aScope(),
    });
    expect(miss.writes[0].spans[0].attributes?.span_state).toEqual({
      state: "projected",
      value: "completed",
    });
    // No fragment exists: the key is ABSENT, never a zero-filled count (the T14
    // explicit-undefined lesson, held for step attributes too).
    expect(miss.writes[0].spans[0].attributes?.fragment_count).toBeUndefined();
    expect(
      degraded.writes[0].spans[0].attributes?.fragment_count,
    ).toBeUndefined();
  });

  test("a canary in the query cannot survive (acceptance 3)", async () => {
    const { writes } = await recordRetrievalAndCapture({
      occurredAt: startedAt,
      endedAt,
      query: `find ${CANARY_KEY}`,
      kbIds: ["kb-1"],
      outcome: { kind: "miss" },
      scope: aScope(),
    });
    const span = writes[0].spans[0];
    expect(JSON.stringify(span)).not.toContain(CANARY_KEY);
    expect(span.attributes?.input).toEqual({
      state: "omitted",
      reason: "credential",
    });
  });

  test("a canary in a kb id withholds the whole list, never a partial one (G3)", async () => {
    const { writes } = await recordRetrievalAndCapture({
      occurredAt: startedAt,
      endedAt,
      query: "q",
      kbIds: ["kb-1", CANARY_KEY],
      outcome: { kind: "hit", fragments: [] },
      scope: aScope(),
    });
    const span = writes[0].spans[0];
    expect(JSON.stringify(span)).not.toContain(CANARY_KEY);
    // A partial list would read as complete: one withheld id withholds the key.
    expect(span.attributes?.kb_ids).toBeUndefined();
    // The rest of the hit summary is untouched.
    expect(span.attributes?.retrieval_outcome).toEqual({
      state: "projected",
      value: "hit",
    });
  });
});

// ---------------------------------------------------------------------------
// The built-in observation bypass: the run's event stream + the execute wrapper
// ---------------------------------------------------------------------------

/**
 * Drives one run's stream through the bypass and returns the facts the observer saw.
 * The events are plain structural shapes with the public AG-UI fields only.
 */
async function runStream(events: BaseEvent[]): Promise<BuiltinToolStepFact[]> {
  const facts: BuiltinToolStepFact[] = [];
  setBuiltinToolStepObserver((fact) => facts.push(fact));
  const subject = new Subject<BaseEvent>();
  const stream = toolStepObservationForTests.observeStream(subject);
  const seen: string[] = [];
  const subscription = stream.subscribe({
    next: (event) => seen.push(event.type),
  });
  try {
    for (const event of events) subject.next(event);
    subject.complete();
    // Let microtasks drain so an execute settled in-flight can land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(events.map((event) => event.type));
    return facts;
  } finally {
    subscription.unsubscribe();
    setBuiltinToolStepObserver(undefined);
  }
}

/**
 * Drives one run's stream whose SOURCE performs the work the runtime would —
 * proposals, then the real execute from inside the run's own context, where the
 * execute correlates with the run's cells (OCR R5-41: executes are per-run).
 */
function sourceRun(
  build: (emit: (event: BaseEvent) => void) => Promise<void>,
): { stream: Observable<BaseEvent>; done: Promise<void> } {
  let doneResolve: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });
  const stream = new Observable<BaseEvent>((subscriber) => {
    void build((event) => subscriber.next(event)).then(() => {
      subscriber.complete();
      doneResolve();
    });
  });
  return { stream, done };
}

describe("the built-in observation bypass", () => {
  test("a proposal that really executes records one executed fact (acceptance 1)", async () => {
    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => facts.push(fact));
    const { stream, done } = sourceRun(async (emit) => {
      emit(
        ev({
          type: "TOOL_CALL_START",
          toolCallId: "c1",
          toolCallName: "host_read",
        }),
      );
      emit(ev({ type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"path":' }));
      emit(
        ev({ type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '"/etc/hosts"}' }),
      );
      emit(ev({ type: "TOOL_CALL_END", toolCallId: "c1" }));
      const value = await toolStepObservationForTests.observeExecution(
        "host_read",
        "c1",
        async () => "42",
      );
      expect(value).toBe("42");
      emit(ev({ type: "RUN_FINISHED", threadId: "t", runId: "r" }));
    });
    const subscription = toolStepObservationForTests
      .observeStream(stream)
      .subscribe();
    try {
      await done;
    } finally {
      subscription.unsubscribe();
      setBuiltinToolStepObserver(undefined);
    }
    expect(facts).toHaveLength(1);
    const fact = facts[0];
    expect(fact.toolCallId).toBe("c1");
    expect(fact.toolName).toBe("host_read");
    expect(fact.proposalObserved).toBe(true);
    expect(fact.executionObserved).toBe(true);
    // The settlement IS the receipt for a server-side execution.
    expect(fact.receiptObserved).toBe(true);
    expect(fact.execution).toEqual({ kind: "succeeded", output: "42" });
    expect(fact.input).toBe('{"path":"/etc/hosts"}');
    expect(fact.output).toBe("42");
    expect(toolStepExecutionState(fact)).toBe("executed");
  });

  test("a large successful execution output is captured at the failure path's cap (OCR R2-53)", async () => {
    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => facts.push(fact));
    try {
      // A string result bigger than the error path's 2000-char precedent.
      // (Fresh toolCallIds: the bypass tombstones settled ids for the whole
      // process, so ids any other test settled would silently record nothing.)
      const kept = await toolStepObservationForTests.observeExecution(
        "host_read",
        "r2-53-cap-str",
        async () => "z".repeat(5_000),
      );
      expect(kept).toHaveLength(5_000); // the product result is untouched
      // An object result whose JSON serialization exceeds the cap.
      await toolStepObservationForTests.observeExecution(
        "host_read",
        "r2-53-cap-obj",
        async () => ({
          blob: "w".repeat(5_000),
        }),
      );
    } finally {
      setBuiltinToolStepObserver(undefined);
    }
    expect(facts).toHaveLength(2);
    // The success path keeps the same bounded capture the failure path already
    // applies to error messages — a 5000-char answer is not pinned whole.
    expect(facts[0].execution).toEqual({
      kind: "succeeded",
      output: "z".repeat(2_000),
    });
    expect(facts[1].execution?.kind).toBe("succeeded");
    expect(facts[1].execution?.output?.length).toBe(2_000);
    expect(facts[1].execution?.output).toMatch(/^\{"blob":"w{1,}/);
  });

  test("tool call arguments stop accumulating at the capture ceiling (OCR R3-37)", async () => {
    // The args stream is the one tool-step payload with no capture bound: every
    // delta was retained whole until settlement, pinning a large call's full
    // arguments for as long as the cell stayed open (an approval wait, for
    // instance). The span-input precedent (OCR R2-52) applies: accumulation
    // stops at 64Ki characters, and the cut is declared in-band.
    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => facts.push(fact));
    const subject = new Subject<BaseEvent>();
    const subscription = toolStepObservationForTests
      .observeStream(subject)
      .subscribe();
    try {
      subject.next(
        ev({
          type: "TOOL_CALL_START",
          toolCallId: "args-cap-1",
          toolCallName: "host_read",
        }),
      );
      subject.next(
        ev({
          type: "TOOL_CALL_ARGS",
          toolCallId: "args-cap-1",
          delta: '{"head": "',
        }),
      );
      // ~205Ki of deltas, far past the ceiling.
      for (let i = 0; i < 200; i++) {
        subject.next(
          ev({
            type: "TOOL_CALL_ARGS",
            toolCallId: "args-cap-1",
            delta: "x".repeat(1_024),
          }),
        );
      }
      subject.next(ev({ type: "RUN_FINISHED", threadId: "t", runId: "r" }));
      subject.complete();
    } finally {
      subscription.unsubscribe();
      setBuiltinToolStepObserver(undefined);
    }
    expect(facts).toHaveLength(1);
    const input = facts[0].input;
    expect(typeof input).toBe("string");
    // The capture-side ceiling: never more than 64Ki characters plus the mark,
    // however large the streamed arguments were (~205Ki here).
    expect(input!.length).toBeLessThanOrEqual(64 * 1024 + 64);
    expect(input!.length).toBeGreaterThan(60_000);
    // Early deltas survive the cut; the cut itself is declared in-band.
    expect(input).toContain('"head": "');
    expect(input).toContain("[observation input truncated at capture]");
  });

  test("the fact carries the scope captured at cell open, even when settlement lands outside the ambient context (OCR R3-39)", async () => {
    // The tool-step cell opens inside the run's ambient observation scope (the
    // same discipline as its trace capture), but the settlement that reports
    // the fact can land at stream teardown — the finalize hook runs OUTSIDE
    // the ambient context. So the fact must carry the scope its open captured,
    // not leave the settlement-path adapter to re-read a gone ambient store
    // (the model-span fact's own OCR R2-58 discipline, now on the tool-step
    // half too).
    const scope = { key: "scope-r3-39" };
    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => facts.push(fact));
    const subject = new Subject<BaseEvent>();
    let subscription: { unsubscribe(): void } | undefined;
    withRunObservationScope(scope, () => {
      subscription = toolStepObservationForTests
        .observeStream(subject)
        .subscribe();
      subject.next(
        ev({
          type: "TOOL_CALL_START",
          toolCallId: "scope-carry-1",
          toolCallName: "host_read",
        }),
      );
    });
    try {
      // Settlement OUTSIDE the ambient context: at this moment the ambient
      // read answers undefined — the fact's carried scope is the only one.
      subject.complete();
    } finally {
      subscription?.unsubscribe();
      setBuiltinToolStepObserver(undefined);
    }
    expect(facts).toHaveLength(1);
    expect(facts[0].scope).toBe(scope);
  });

  test("a run that started scope-less carries no scope — the record stays an honest no-op (OCR R3-39)", async () => {
    const facts = await runStream([
      ev({
        type: "TOOL_CALL_START",
        toolCallId: "scope-less-1",
        toolCallName: "host_read",
      }),
      ev({ type: "RUN_FINISHED", threadId: "t", runId: "r" }),
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0].scope).toBeUndefined();
  });

  test("a browser proposal with no receipt is unobserved, never success (acceptance 2)", async () => {
    const facts = await runStream([
      ev({
        type: "TOOL_CALL_START",
        toolCallId: "b1",
        toolCallName: "computer_click",
      }),
      ev({ type: "TOOL_CALL_END", toolCallId: "b1" }),
      ev({ type: "RUN_FINISHED", threadId: "t", runId: "r" }),
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0].proposalObserved).toBe(true);
    expect(facts[0].executionObserved).toBe(false);
    expect(facts[0].receiptObserved).toBe(false);
    expect(toolStepExecutionState(facts[0])).toBe("unobserved");
    expect(toolStepTerminalState(facts[0])).not.toBe("completed");
  });

  test("a browser-side receipt without our execution never becomes executed (acceptance 2)", async () => {
    const facts = await runStream([
      ev({
        type: "TOOL_CALL_START",
        toolCallId: "b2",
        toolCallName: "computer_click",
      }),
      ev({
        type: "TOOL_CALL_RESULT",
        toolCallId: "b2",
        messageId: "m1",
        content: "clicked",
      }),
      ev({ type: "RUN_FINISHED", threadId: "t", runId: "r" }),
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0].receiptObserved).toBe(true);
    expect(facts[0].executionObserved).toBe(false);
    // A receipt for an execution this deployment never ran is not an execution.
    expect(toolStepExecutionState(facts[0])).toBe("unobserved");
    expect(toolStepTerminalState(facts[0])).toBe("unknown");
  });

  test("an interrupted run leaves the step proposed (acceptance 1)", async () => {
    const facts = await runStream([
      ev({
        type: "TOOL_CALL_START",
        toolCallId: "p1",
        toolCallName: "host_read",
      }),
      ev({
        type: "RUN_FINISHED",
        threadId: "t",
        runId: "r",
        outcome: { type: "interrupt", interrupts: [] },
      }),
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0].window).toBe("interrupted");
    expect(toolStepExecutionState(facts[0])).toBe("proposed");
  });

  test("a run error closes pending proposals unobserved", async () => {
    const facts = await runStream([
      ev({
        type: "TOOL_CALL_START",
        toolCallId: "e1",
        toolCallName: "host_read",
      }),
      ev({ type: "RUN_ERROR", message: "boom", code: "internal" }),
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0].window).toBe("terminal");
    expect(toolStepExecutionState(facts[0])).toBe("unobserved");
  });

  test("a failed execute is a failed fact; an abort is canceled; a suspension stays pending", async () => {
    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => facts.push(fact));
    // The runtime performs each execute inside the run (OCR R5-41 shape).
    const { stream, done } = sourceRun(async (emit) => {
      emit(
        ev({
          type: "TOOL_CALL_START",
          toolCallId: "f1",
          toolCallName: "host_read",
        }),
      );
      await expect(
        toolStepObservationForTests.observeExecution(
          "host_read",
          "f1",
          async () => {
            throw new Error("connector refused");
          },
        ),
      ).rejects.toThrow("connector refused");
      emit(
        ev({
          type: "TOOL_CALL_START",
          toolCallId: "f2",
          toolCallName: "host_read",
        }),
      );
      await expect(
        toolStepObservationForTests.observeExecution(
          "host_read",
          "f2",
          async () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            throw error;
          },
        ),
      ).rejects.toThrow("aborted");
      emit(
        ev({
          type: "TOOL_CALL_START",
          toolCallId: "f3",
          toolCallName: "host_read",
        }),
      );
      await expect(
        toolStepObservationForTests.observeExecution(
          "host_read",
          "f3",
          async () => {
            throw new HeadlessToolSuspension("waiting for approval", {
              kind: "approval",
            });
          },
        ),
      ).rejects.toThrow("waiting for approval");
      // The suspended call is still open; the interrupt outcome settles it proposed.
      emit(
        ev({
          type: "RUN_FINISHED",
          threadId: "t",
          runId: "r",
          outcome: { type: "interrupt", interrupts: [] },
        }),
      );
    });
    const subscription = toolStepObservationForTests
      .observeStream(stream)
      .subscribe();
    try {
      await done;
    } finally {
      subscription.unsubscribe();
      setBuiltinToolStepObserver(undefined);
    }
    expect(facts).toHaveLength(3);
    expect(facts[0].execution).toEqual({
      kind: "failed",
      output: "connector refused",
    });
    expect(toolStepTerminalState(facts[0])).toBe("failed");
    expect(facts[1].execution).toEqual({ kind: "canceled", output: null });
    expect(facts[2].executionObserved).toBe(false);
    expect(toolStepExecutionState(facts[2])).toBe("proposed");
  });

  test("an execution without a toolCallId or without an observer runs bare", async () => {
    // No observer registered at all: the wrapper is transparent.
    const bare = await toolStepObservationForTests.observeExecution(
      "host_read",
      "c1",
      async () => "kept",
    );
    expect(bare).toBe("kept");
    setBuiltinToolStepObserver(() => {
      throw new Error("must not be called");
    });
    try {
      // The runtime passed no toolCallId: nothing to correlate, nothing recorded.
      const uncorrelated = await toolStepObservationForTests.observeExecution(
        "host_read",
        undefined,
        async () => "kept",
      );
      expect(uncorrelated).toBe("kept");
    } finally {
      setBuiltinToolStepObserver(undefined);
    }
  });

  test("no observer registered: the stream passes events through untouched", async () => {
    const subject = new Subject<BaseEvent>();
    const seen: string[] = [];
    const subscription = toolStepObservationForTests
      .observeStream(subject)
      .subscribe({ next: (event) => seen.push(event.type) });
    subject.next(
      ev({ type: "TOOL_CALL_START", toolCallId: "x", toolCallName: "t" }),
    );
    subject.next(ev({ type: "RUN_FINISHED", threadId: "t", runId: "r" }));
    subject.complete();
    subscription.unsubscribe();
    expect(seen).toEqual(["TOOL_CALL_START", "RUN_FINISHED"]);
  });
});

// ---------------------------------------------------------------------------
// The retrieval seam: the retriever reports what it actually retrieved
// ---------------------------------------------------------------------------

describe("the knowledge retrieval observation seam", () => {
  /**
   * A real local upstream: the retriever dials with node:http (no proxy interference),
   * so an ephemeral Bun.serve is the honest fake — no global fetch mock to go stale.
   */
  function kbUpstream(results: unknown[]) {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ results, count: results.length }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    return {
      server,
      config: {
        baseUrl: `http://127.0.0.1:${server.port}`,
        apiKey: "secret",
        timeoutMs: 10_000,
      },
    };
  }

  test("a retrieval reports the sanitized query, the kb list and the fragments", async () => {
    const { server, config } = kbUpstream([
      {
        chunk_id: "chunk-9",
        doc_id: "doc-7",
        content: "the policy",
        score: 0.9,
        source: "handbook.md",
      },
    ]);
    const observations: unknown[] = [];
    setKnowledgeRetrievalObserver((observation) =>
      observations.push(observation),
    );
    const retriever = createKnowledgeRetriever(
      config,
      { kbIds: ["kb1"], topK: 5, timeoutMs: 1500, scoreThreshold: 0 },
      createKnowledgeCircuit(),
    );
    try {
      const outcome = await retriever.retrieve("  vacation   policy ");
      expect(outcome.status).toBe("hit");
      expect(observations).toHaveLength(1);
      const observed = observations[0] as {
        query: string;
        kbIds: readonly string[];
        outcome: { status: string; chunks?: Array<{ chunkId: string }> };
        startedAt: Date;
        endedAt: Date;
      };
      expect(observed.query).toBe("vacation policy");
      expect(observed.kbIds).toEqual(["kb1"]);
      expect(observed.outcome.chunks?.[0].chunkId).toBe("chunk-9");
      expect(observed.endedAt.getTime()).toBeGreaterThanOrEqual(
        observed.startedAt.getTime(),
      );
    } finally {
      setKnowledgeRetrievalObserver(undefined);
      server.stop(true);
    }
  });

  test("an observer that throws never breaks the retrieval", async () => {
    const { server, config } = kbUpstream([]);
    setKnowledgeRetrievalObserver(() => {
      throw new Error("observation must not take the product path down");
    });
    const retriever = createKnowledgeRetriever(
      config,
      { kbIds: ["kb1"], topK: 5, timeoutMs: 1500, scoreThreshold: 0 },
      createKnowledgeCircuit(),
    );
    try {
      const outcome = await retriever.retrieve("anything");
      expect(outcome.status).toBe("miss");
    } finally {
      setKnowledgeRetrievalObserver(undefined);
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// T15 review (a)–(d), folded into this ticket: teardown leak, out-of-order
// double record, the tap error path, and the duplicated kbIds extraction.
// ---------------------------------------------------------------------------

describe("the observation bypass fixes (T15 review)", () => {
  test("(c) a stream error closes pending cells terminal", async () => {
    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => facts.push(fact));
    const subject = new Subject<BaseEvent>();
    const subscription = toolStepObservationForTests
      .observeStream(subject)
      .subscribe({ error: () => undefined });
    try {
      subject.next(
        ev({
          type: "TOOL_CALL_START",
          toolCallId: "err-tap-1",
          toolCallName: "host_read",
        }),
      );
      subject.error(new Error("pipeline broke"));
    } finally {
      subscription.unsubscribe();
      setBuiltinToolStepObserver(undefined);
    }
    expect(facts).toHaveLength(1);
    expect(facts[0].window).toBe("terminal");
    expect(facts[0].executionObserved).toBe(false);
    expect(toolStepExecutionState(facts[0])).toBe("unobserved");
  });

  test("(a) a teardown without a terminal event still retires open cells", async () => {
    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => facts.push(fact));
    const subject = new Subject<BaseEvent>();
    const subscription = toolStepObservationForTests
      .observeStream(subject)
      .subscribe();
    subject.next(
      ev({
        type: "TOOL_CALL_START",
        toolCallId: "teardown-1",
        toolCallName: "host_read",
      }),
    );
    // The consumer walks away mid-run: no complete, no error, just unsubscribe.
    subscription.unsubscribe();
    // Late events on a torn-down stream reach nobody and must not resurrect a cell.
    subject.next(
      ev({ type: "TOOL_CALL_ARGS", toolCallId: "teardown-1", delta: "{}" }),
    );
    setBuiltinToolStepObserver(undefined);
    expect(facts).toHaveLength(1);
    expect(facts[0].toolCallId).toBe("teardown-1");
    expect(facts[0].window).toBe("terminal");
    expect(facts[0].input).toBeNull();
    expect(toolStepExecutionState(facts[0])).toBe("unobserved");
  });

  test("(a) many torn-down streams leave no cells behind (the leak itself)", async () => {
    // The observer MUST be registered: without it the bypass returns the stream
    // untouched (copilot.ts `if (observer === undefined) return stream`) and
    // this loop opens no cells at all — a silent no-op, the fake coverage the
    // T17 review (L-2) caught.
    const torn: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => torn.push(fact));
    try {
      for (let round = 0; round < 50; round += 1) {
        const subject = new Subject<BaseEvent>();
        const subscription = toolStepObservationForTests
          .observeStream(subject)
          .subscribe();
        subject.next(
          ev({
            type: "TOOL_CALL_START",
            toolCallId: `leak-${round}`,
            toolCallName: "host_read",
          }),
        );
        subscription.unsubscribe();
      }
    } finally {
      setBuiltinToolStepObserver(undefined);
    }
    // Every teardown retired its open cell: 50 terminal facts, not a registry
    // that kept them open forever. Without the finalize hook this is 0.
    expect(torn).toHaveLength(50);
    for (const fact of torn) {
      expect(fact.window).toBe("terminal");
      expect(toolStepExecutionState(fact)).toBe("unobserved");
    }
    // OCR R3-40: a proposal-only settlement — the teardown closed the cell
    // with no execution and no receipt — does NOT tombstone the id. The stale
    // cell is retired (never resurrected, never double-settled), but the id is
    // legitimately reopenable: the approval resume replays the SAME toolCallId
    // and its fresh proposal records exactly once, as a proposal.
    const resurrected = await runStream([
      ev({
        type: "TOOL_CALL_START",
        toolCallId: "leak-49",
        toolCallName: "host_read",
      }),
      ev({ type: "RUN_FINISHED", threadId: "t", runId: "r" }),
    ]);
    expect(resurrected).toHaveLength(1);
    expect(resurrected[0]?.proposalObserved).toBe(true);
    expect(resurrected[0]?.executionObserved).toBe(false);
  });

  test("(b) a late proposal for an already-executed call records exactly once", async () => {
    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => facts.push(fact));
    // The runtime proposes, executes inside the run, then the out-of-order
    // proposal event arrives — the tombstone must keep it to one cell.
    const { stream, done } = sourceRun(async (emit) => {
      emit(
        ev({
          type: "TOOL_CALL_START",
          toolCallId: "ooo-1",
          toolCallName: "host_read",
        }),
      );
      await toolStepObservationForTests.observeExecution(
        "host_read",
        "ooo-1",
        async () => "42",
      );
      // The out-of-order window: the proposal event arrives AFTER the execution
      // settled. It must not open a second cell for the same call.
      emit(
        ev({
          type: "TOOL_CALL_START",
          toolCallId: "ooo-1",
          toolCallName: "host_read",
        }),
      );
      emit(ev({ type: "RUN_FINISHED", threadId: "t", runId: "r" }));
    });
    const subscription = toolStepObservationForTests
      .observeStream(stream)
      .subscribe();
    try {
      await done;
    } finally {
      subscription.unsubscribe();
      setBuiltinToolStepObserver(undefined);
    }
    expect(facts).toHaveLength(1);
    expect(facts[0].executionObserved).toBe(true);
    expect(toolStepExecutionState(facts[0])).toBe("executed");
  });

  test("(b) an executed settlement still tombstones: the id records exactly once (OCR R3-40 non-regression)", async () => {
    // The narrowing is one-directional and PER RUN (OCR R5-41): a settlement
    // that carried an execution (or a receipt) keeps the tombstone — an
    // out-of-order late proposal for a finished call must never open a second
    // cell for it within that run. A DIFFERENT run proposing the same provider
    // id records its own fact: the ids are only unique per run.
    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => facts.push(fact));
    const { stream, done } = sourceRun(async (emit) => {
      emit(
        ev({
          type: "TOOL_CALL_START",
          toolCallId: "tombstone-exec-1",
          toolCallName: "host_read",
        }),
      );
      await toolStepObservationForTests.observeExecution(
        "host_read",
        "tombstone-exec-1",
        async () => "42",
      );
      emit(
        ev({
          type: "TOOL_CALL_START",
          toolCallId: "tombstone-exec-1",
          toolCallName: "host_read",
        }),
      );
      emit(ev({ type: "RUN_FINISHED", threadId: "t", runId: "rA" }));
    });
    const subscription = toolStepObservationForTests
      .observeStream(stream)
      .subscribe();
    try {
      await done;
    } finally {
      subscription.unsubscribe();
    }
    // The executed settlement, then the late proposal: still exactly one fact.
    expect(facts).toHaveLength(1);
    expect(facts[0].executionObserved).toBe(true);
    // A fresh run is a fresh registry: the same provider id records there.
    const after = await runStream([
      ev({
        type: "TOOL_CALL_START",
        toolCallId: "tombstone-exec-1",
        toolCallName: "host_read",
      }),
      ev({ type: "RUN_FINISHED", threadId: "t", runId: "rB" }),
    ]);
    expect(after).toHaveLength(1);
    expect(after[0]?.proposalObserved).toBe(true);
    expect(after[0]?.executionObserved).toBe(false);
    setBuiltinToolStepObserver(undefined);
  });

  test("the approval resume replays the SAME toolCallId and its real execution is observed (OCR R3-40)", async () => {
    // The first leg: the call is proposed, the execute suspends on approval,
    // and the inner subscription is torn down without a terminal event — the
    // finalize hook closes the cell. The settlement is proposal-only (nothing
    // executed, nothing received), so it must not tombstone the id.
    const firstLeg: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => firstLeg.push(fact));
    const subject = new Subject<BaseEvent>();
    const subscription = toolStepObservationForTests
      .observeStream(subject)
      .subscribe();
    subject.next(
      ev({
        type: "TOOL_CALL_START",
        toolCallId: "approval-resume-1",
        toolCallName: "host_read",
      }),
    );
    subscription.unsubscribe();
    setBuiltinToolStepObserver(undefined);
    expect(firstLeg).toHaveLength(1);
    expect(firstLeg[0].window).toBe("terminal");
    expect(firstLeg[0].executionObserved).toBe(false);

    // The resume leg: the approval replays the SAME toolCallId through the
    // execute wrapper. Today the tombstone returns a closed dead cell, so the
    // real execution is swallowed — after the fix it is recorded.
    const resumed: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => resumed.push(fact));
    try {
      const value = await toolStepObservationForTests.observeExecution(
        "host_read",
        "approval-resume-1",
        async () => "42",
      );
      expect(value).toBe("42");
    } finally {
      setBuiltinToolStepObserver(undefined);
    }
    expect(resumed).toHaveLength(1);
    expect(resumed[0].proposalObserved).toBe(false);
    expect(resumed[0].executionObserved).toBe(true);
    expect(resumed[0].receiptObserved).toBe(true);
    expect(toolStepExecutionState(resumed[0])).toBe("executed");
  });

  test("an interrupted proposal-only settlement leaves the id reopenable too (OCR R3-40)", async () => {
    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => facts.push(fact));
    const subject = new Subject<BaseEvent>();
    const subscription = toolStepObservationForTests
      .observeStream(subject)
      .subscribe();
    subject.next(
      ev({
        type: "TOOL_CALL_START",
        toolCallId: "interrupt-resume-1",
        toolCallName: "host_read",
      }),
    );
    subject.next(
      ev({
        type: "RUN_FINISHED",
        threadId: "t",
        runId: "r",
        outcome: { type: "interrupt", interrupts: [] },
      }),
    );
    subject.complete();
    subscription.unsubscribe();
    setBuiltinToolStepObserver(undefined);
    expect(facts).toHaveLength(1);
    expect(facts[0].window).toBe("interrupted");

    const resumed: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => resumed.push(fact));
    try {
      await toolStepObservationForTests.observeExecution(
        "host_read",
        "interrupt-resume-1",
        async () => "kept",
      );
    } finally {
      setBuiltinToolStepObserver(undefined);
    }
    expect(resumed).toHaveLength(1);
    expect(toolStepExecutionState(resumed[0])).toBe("executed");
  });

  test("the fact carries the run's trace coordinates captured at open time", async () => {
    const { spans, stop } = recordedSpansForBypass();
    try {
      const facts: BuiltinToolStepFact[] = [];
      setBuiltinToolStepObserver((fact) => facts.push(fact));
      const subject = new Subject<BaseEvent>();
      const subscription = toolStepObservationForTests
        .observeStream(subject)
        .subscribe();
      try {
        const parent = trace.getTracer("test").startSpan("run request");
        await context.with(
          trace.setSpan(context.active(), parent),
          async () => {
            subject.next(
              ev({
                type: "TOOL_CALL_START",
                toolCallId: "trace-1",
                toolCallName: "host_read",
              }),
            );
            subject.next(
              ev({ type: "RUN_FINISHED", threadId: "t", runId: "r" }),
            );
          },
        );
        parent.end();
      } finally {
        subscription.unsubscribe();
        setBuiltinToolStepObserver(undefined);
      }
      expect(facts).toHaveLength(1);
      const parent = spans.find((span) => span.name === "run request");
      expect(parent).toBeDefined();
      expect(facts[0].trace).toEqual({
        traceId: parent?.spanContext().traceId,
        spanId: parent?.spanContext().spanId,
      });
    } finally {
      await stop();
    }
  });

  test("(d) the observer reads the same effective kb list the retrieval used", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          JSON.stringify({
            results: [
              {
                chunk_id: "chunk-1",
                doc_id: "doc-1",
                content: "c",
                score: 0.9,
                source: "s.md",
              },
            ],
            count: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const config = {
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiKey: "secret",
      timeoutMs: 10_000,
    };
    const observations: KnowledgeRetrievalObservation[] = [];
    setKnowledgeRetrievalObserver((observation) =>
      observations.push(observation),
    );
    const options = {
      kbIds: ["configured"],
      topK: 5,
      timeoutMs: 1500,
      scoreThreshold: 0,
    };
    const retriever = createKnowledgeRetriever(
      config,
      options,
      createKnowledgeCircuit(),
    );
    try {
      await retriever.retrieve("q", { kbIds: ["overridden"] });
      await retriever.retrieve("q", { kbIds: [] });
      await retriever.retrieve("q");
      expect(observations.map((observation) => observation.kbIds)).toEqual([
        ["overridden"],
        ["configured"],
        ["configured"],
      ]);
    } finally {
      setKnowledgeRetrievalObserver(undefined);
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance 4: step typing reads event/callback semantics only
// ---------------------------------------------------------------------------

describe("the step typing depends on no framework internals (acceptance 4)", () => {
  test("the classification module imports no framework, public or private", () => {
    const source = readFileSync(
      new URL("../src/ai-observability/tool-steps.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']@ag-ui\//);
    expect(source).not.toMatch(/from\s+["']@copilotkit\//);
    // The determination vocabulary is structural, not a re-export of framework types.
    expect(source).not.toMatch(/from\s+["']@ag-ui\/core/);
  });
});

// ---------------------------------------------------------------------------
// OCR R5-41: per-run cell isolation. The module-level registry used to key
// cells by the bare toolCallId, so two concurrent runs emitting the same id
// (OpenAI-compatible providers have historically handed out per-request
// incrementing ids) shared ONE cell: B's arguments merged into A's captured
// input, B's observation vanished whole, and B's RUN_FINISHED settled A's cell
// early. Each subscription now owns its own registry; executes correlate
// through the run they were performed inside.
// ---------------------------------------------------------------------------

describe("per-run tool-step cell isolation and execute-side discipline (OCR R5-41 + R5-43)", () => {
  test("two concurrent runs sharing a toolCallId keep separate cells (triage repro shape)", async () => {
    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => facts.push(fact));
    const runA = new Subject<BaseEvent>();
    const runB = new Subject<BaseEvent>();
    const subA = toolStepObservationForTests.observeStream(runA).subscribe();
    const subB = toolStepObservationForTests.observeStream(runB).subscribe();
    try {
      // Both runs propose the SAME tool call id, interleaved.
      runA.next(
        ev({
          type: "TOOL_CALL_START",
          toolCallId: "call_0",
          toolCallName: "host_read",
        }),
      );
      runB.next(
        ev({
          type: "TOOL_CALL_START",
          toolCallId: "call_0",
          toolCallName: "host_write",
        }),
      );
      runA.next(
        ev({
          type: "TOOL_CALL_ARGS",
          toolCallId: "call_0",
          delta: '{"path":"/etc/hosts"}',
        }),
      );
      runB.next(
        ev({
          type: "TOOL_CALL_ARGS",
          toolCallId: "call_0",
          delta: '{"to":"bob@example.com"}',
        }),
      );
      // B's run ends first: only B's cell may settle, with only B's facts.
      runB.next(ev({ type: "RUN_FINISHED", threadId: "t", runId: "rB" }));
      runB.complete();
      // A keeps flowing after B ended: its receipt must still land.
      runA.next(ev({ type: "TOOL_CALL_RESULT", toolCallId: "call_0" }));
      runA.next(ev({ type: "RUN_FINISHED", threadId: "t", runId: "rA" }));
      runA.complete();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      subA.unsubscribe();
      subB.unsubscribe();
      setBuiltinToolStepObserver(undefined);
    }
    // One fact per run — B's whole observation is not swallowed by the share.
    expect(facts).toHaveLength(2);
    const a = facts.find((fact) => fact.toolName === "host_read");
    const b = facts.find((fact) => fact.toolName === "host_write");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // B's arguments never merge into A's captured input and vice versa.
    expect(a?.input).toBe('{"path":"/etc/hosts"}');
    expect(b?.input).toBe('{"to":"bob@example.com"}');
    // B's finish settles B's cell, not A's: A's receipt still arrives after.
    expect(a?.receiptObserved).toBe(true);
    expect(b?.receiptObserved).toBe(false);
  });

  test("an execute the run performs settles THAT run's cell, never a concurrent run's", async () => {    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => facts.push(fact));
    // Run A's source stands in for the runtime: it proposes the call, then
    // really executes it from inside the run (where the execute's ambient
    // context is the run's own), then finishes.
    const runA = toolStepObservationForTests.observeStream(
      new Observable<BaseEvent>((subscriber) => {
        subscriber.next(
          ev({
            type: "TOOL_CALL_START",
            toolCallId: "call_0",
            toolCallName: "host_read",
          }),
        );
        void toolStepObservationForTests
          .observeExecution("host_read", "call_0", async () => "42")
          .then(() => {
            subscriber.next(
              ev({ type: "TOOL_CALL_RESULT", toolCallId: "call_0" }),
            );
            subscriber.next(
              ev({ type: "RUN_FINISHED", threadId: "t", runId: "rA" }),
            );
            subscriber.complete();
          });
      }),
    );
    // Run B, concurrent, proposes the SAME id and ends without executing.
    const runB = new Subject<BaseEvent>();
    const subB = toolStepObservationForTests.observeStream(runB).subscribe();
    const subA = runA.subscribe();
    try {
      runB.next(
        ev({
          type: "TOOL_CALL_START",
          toolCallId: "call_0",
          toolCallName: "host_write",
        }),
      );
      runB.next(ev({ type: "RUN_FINISHED", threadId: "t", runId: "rB" }));
      runB.complete();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      subA.unsubscribe();
      subB.unsubscribe();
      setBuiltinToolStepObserver(undefined);
    }
    const a = facts.find((fact) => fact.toolName === "host_read");
    const b = facts.find((fact) => fact.toolName === "host_write");
    // A's real execute lands on A's cell: proposed AND executed.
    expect(a?.proposalObserved).toBe(true);
    expect(a?.executionObserved).toBe(true);
    expect(a?.execution).toEqual({ kind: "succeeded", output: "42" });
    // B's proposal was never executed: A's execute must not settle B's cell.
    expect(b?.toolName).toBe("host_write");
    expect(b?.executionObserved).toBe(false);
  });

  test("the execute side normalizes a non-string tool call id exactly like the stream side (OCR R5-43)", async () => {
    // The key-normalization asymmetry: the stream tap keys cells by
    // String(event.toolCallId) while the execute wrapper used the raw value, so
    // ONE call whose provider id was not a string opened TWO cells — the
    // execute-side one settling alone, its proposal half never correlated.
    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => facts.push(fact));
    const { stream, done } = sourceRun(async (emit) => {
      emit(
        ev({
          type: "TOOL_CALL_START",
          // The provider emitted a numeric id.
          toolCallId: 42,
          toolCallName: "host_read",
        }),
      );
      const value = await toolStepObservationForTests.observeExecution(
        "host_read",
        // The runtime executes with the same numeric id.
        42 as unknown as string,
        async () => "ok",
      );
      expect(value).toBe("ok");
      emit(
        ev({
          type: "TOOL_CALL_RESULT",
          toolCallId: 42,
        }),
      );
      emit(ev({ type: "RUN_FINISHED", threadId: "t", runId: "r" }));
    });
    const subscription = toolStepObservationForTests
      .observeStream(stream)
      .subscribe();
    try {
      await done;
    } finally {
      subscription.unsubscribe();
      setBuiltinToolStepObserver(undefined);
    }
    // One call, one cell, one fact — proposal, execution and receipt merged.
    expect(facts).toHaveLength(1);
    expect(facts[0].toolCallId).toBe("42");
    expect(facts[0].proposalObserved).toBe(true);
    expect(facts[0].executionObserved).toBe(true);
    expect(facts[0].receiptObserved).toBe(true);
  });

  test("a stalled execute-only cell is retired after the max age instead of pinning the registry forever (OCR R5-43)", async () => {
    // An execute outside any observed run opens its cell in the module's bare
    // registry; one whose run() never settles (the hung-provider shape) would
    // otherwise pin that cell — its captured arguments included — forever. The
    // max-age sweep is the bounded backstop.
    const facts: BuiltinToolStepFact[] = [];
    setBuiltinToolStepObserver((fact) => facts.push(fact));
    try {
      void toolStepObservationForTests.observeExecution(
        "host_read",
        "stalled-r543",
        () => new Promise<string>(() => {}),
      );
      // A sweep while the cell is still young must not touch it.
      toolStepObservationForTests.sweepStalledBareCellsForTests(new Date());
      expect(facts).toHaveLength(0);
      // A day later the sweep retires it: one honest fact — a call happened,
      // nothing was observed of it — and the registry stops pinning the cell.
      toolStepObservationForTests.sweepStalledBareCellsForTests(
        new Date(Date.now() + 25 * 60 * 60 * 1000),
      );
      expect(facts).toHaveLength(1);
      expect(facts[0].toolCallId).toBe("stalled-r543");
      expect(facts[0].executionObserved).toBe(false);
      expect(toolStepExecutionState(facts[0])).toBe("unobserved");
      // The retired cell never tombstoned (nothing was observed), so the id
      // records fresh on its next real call.
      const kept = await toolStepObservationForTests.observeExecution(
        "host_read",
        "stalled-r543",
        async () => "ok",
      );
      expect(kept).toBe("ok");
    } finally {
      setBuiltinToolStepObserver(undefined);
    }
    expect(facts).toHaveLength(2);
    expect(facts[1].execution).toEqual({ kind: "succeeded", output: "ok" });
  });
});
