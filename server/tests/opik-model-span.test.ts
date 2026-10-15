// Issue #20 / DAG T14 — built-in execution model-span recording.
//
// Every case here runs against injected fakes, exactly like the other opik suites: no
// database, no network, no real Opik write and no real provider ever happens here.
//
// The acceptance under test, in issue order:
//   1. a built-in model call's span carries the ACTUAL provider usage; missing usage is
//      an explicit `unavailable` state, never a silent 0.
//   2. the observation is a bypass: no provider re-call, the metered finish and Settlement
//      order is untouched, and one call's usage is counted exactly once.
//   3. a refusal or settlement failure is never recorded as a successful span.
//   4. span input/output reach the write queue only through the T05 redaction projection;
//      a canary planted in the observation cannot survive into a real span instance.
import { describe, expect, test } from "bun:test";
import type { OpikObservationWrite } from "../src/ai-observability/health";
import {
  createModelSpanRecorder,
  type ModelSpanObservation,
} from "../src/ai-observability/model-span";
import type { OpikOtlpSpan, OpikPort } from "../src/ai-observability/opik-port";
import { resolveObservationScope } from "../src/ai-observability/scope";
import {
  type BuiltinModelSpanFact,
  CreditGateError,
  type ModelUsageGateLifecycle,
  meteredModelForTests,
  setBuiltinModelSpanObserver,
  setModelUsageGate,
  setModelUsageMeter,
} from "../src/copilot";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A queue that accepts everything and remembers what was submitted. */
function fakeQueue() {
  const submitted: OpikObservationWrite[] = [];
  return {
    submitted,
    queue: {
      submit(write: OpikObservationWrite) {
        submitted.push(write);
        return "accepted" as const;
      },
    },
  };
}

/** A port fake that records the spans writeSpans received. */
function fakePort() {
  const writes: Array<{
    spans: readonly OpikOtlpSpan[];
  }> = [];
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

/** Records one observation and returns the spans the port would receive. */
async function recordAndCapture(
  observation: ModelSpanObservation,
): Promise<{ writes: ReturnType<typeof fakePort>["writes"] }> {
  const queue = fakeQueue();
  const recorder = createModelSpanRecorder({ healthService: queue.queue });
  recorder.record(observation);
  const port = fakePort();
  for (const write of queue.submitted) await write.perform(port.port);
  return { writes: port.writes };
}

const occurredAt = new Date("2026-10-16T10:00:00.000Z");
const endedAt = new Date("2026-10-16T10:00:02.500Z");

// Assembled, never literal, so a leak has to be matched by content, not grep-ability.
const CANARY_KEY = `sk-live-${"a".repeat(24)}`;
const CANARY_TOKEN = `Bearer ${"B".repeat(24)}`;
const CANARY_GH = `ghp_${"c".repeat(24)}`;

// ---------------------------------------------------------------------------
// The recorder: projection, span build, write-queue entry
// ---------------------------------------------------------------------------

describe("the model span recorder", () => {
  test("a settled call carries the actual provider usage (acceptance 1)", async () => {
    const { writes } = await recordAndCapture({
      occurredAt,
      endedAt,
      provider: "openai",
      modelId: "gpt-test",
      ending: { kind: "succeeded", inputTokens: 120, outputTokens: 80 },
      input: "What is the weather?",
      output: "Sunny.",
      scope: aScope(),
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].spans).toHaveLength(1);
    const span = writes[0].spans[0];
    // Ids and times follow the verified OTLP shapes the port refuses to bend on.
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.startTimeUnixNano).toMatch(/^\d+$/);
    expect(span.endTimeUnixNano).toMatch(/^\d+$/);
    expect(span.name.state).toBe("projected");
    // The usage is the one the settlement committed, copied — never recomputed.
    expect(span.attributes?.tokens_input).toEqual({
      state: "projected",
      value: 120,
    });
    expect(span.attributes?.tokens_output).toEqual({
      state: "projected",
      value: 80,
    });
    expect(span.attributes?.usage_state).toEqual({
      state: "projected",
      value: "actual",
    });
    expect(span.attributes?.span_state).toEqual({
      state: "projected",
      value: "completed",
    });
    // Input/output travel as projected span content.
    expect(span.attributes?.input).toEqual({
      state: "projected",
      value: "What is the weather?",
    });
    expect(span.attributes?.output).toEqual({
      state: "projected",
      value: "Sunny.",
    });
  });

  test("missing usage is an explicit unavailable, never a 0 (acceptance 1)", async () => {
    const { writes } = await recordAndCapture({
      occurredAt,
      endedAt,
      provider: "openai",
      modelId: "gpt-test",
      ending: { kind: "usage_missing" },
      input: "What is the weather?",
      output: "Sunny.",
      scope: aScope(),
    });
    const span = writes[0].spans[0];
    // No token count exists for this call: the keys are ABSENT, not zero-filled —
    // a 0 here would be a usage fact the provider never reported.
    expect(span.attributes?.tokens_input).toBeUndefined();
    expect(span.attributes?.tokens_output).toBeUndefined();
    expect(span.attributes?.usage_state).toEqual({
      state: "projected",
      value: "unavailable",
    });
    // The stream completed for the person, but the cost is explicitly unknown.
    expect(span.attributes?.span_state).toEqual({
      state: "projected",
      value: "unknown",
    });
  });

  test("an admission refusal is a failure-terminal span, never success (acceptance 3)", async () => {
    const { writes } = await recordAndCapture({
      occurredAt,
      endedAt,
      provider: "openai",
      modelId: "gpt-test",
      ending: { kind: "refused", code: "input_over_limit" },
      scope: aScope(),
    });
    const span = writes[0].spans[0];
    expect(span.attributes?.span_state).toEqual({
      state: "projected",
      value: "failed",
    });
    expect(span.attributes?.ending_kind).toEqual({
      state: "projected",
      value: "refused",
    });
    expect(span.attributes?.ending_code).toEqual({
      state: "projected",
      value: "input_over_limit",
    });
    // No usage was ever reported for a call that never reached the provider.
    expect(span.attributes?.tokens_input).toBeUndefined();
    expect(span.attributes?.usage_state).toEqual({
      state: "projected",
      value: "unavailable",
    });
  });

  test("a settlement failure is a failure-terminal span, never success (acceptance 3)", async () => {
    for (const code of ["usage_invalid", "usage_over_bound"]) {
      const { writes } = await recordAndCapture({
        occurredAt,
        endedAt,
        provider: "openai",
        modelId: "gpt-test",
        ending: { kind: "settlement_failed", code },
        scope: aScope(),
      });
      const span = writes[0].spans[0];
      expect(span.attributes?.span_state).toEqual({
        state: "projected",
        value: "failed",
      });
      expect(span.attributes?.ending_kind).toEqual({
        state: "projected",
        value: "settlement_failed",
      });
      expect(span.attributes?.ending_code).toEqual({
        state: "projected",
        value: code,
      });
    }
  });

  test("canaries in input/output cannot survive the projection (acceptance 4)", async () => {
    const { writes } = await recordAndCapture({
      occurredAt,
      endedAt,
      provider: "openai",
      modelId: "gpt-test",
      ending: { kind: "succeeded", inputTokens: 10, outputTokens: 5 },
      input: `Please summarise. ${CANARY_KEY} ${CANARY_TOKEN}`,
      output: `Summary follows. ${CANARY_GH}`,
      scope: aScope(),
    });
    const span = writes[0].spans[0];
    const serialized = JSON.stringify(span);
    expect(serialized).not.toContain(CANARY_KEY);
    expect(serialized).not.toContain(CANARY_TOKEN);
    expect(serialized).not.toContain(CANARY_GH);
    // The deny killed the content wholesale — an omitted marker, not a masked string.
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
    const recorder = createModelSpanRecorder({ healthService: queue.queue });
    recorder.record({
      occurredAt,
      endedAt,
      ending: { kind: "succeeded", inputTokens: 1, outputTokens: 1 },
      scope: aScope(),
    });
    expect(queue.submitted).toHaveLength(1);
    expect(queue.submitted[0].operation).toBe("writeSpans");
    expect(typeof queue.submitted[0].scopeKey).toBe("string");
    expect(queue.submitted[0].scopeKey.length).toBeGreaterThan(0);
  });

  test("an observation without a trusted scope writes nothing upstream", () => {
    const queue = fakeQueue();
    const recorder = createModelSpanRecorder({ healthService: queue.queue });
    // The built-in path today: facts flow, but no trusted scope rides along yet —
    // nothing may reach the port (or pollute the queue counters) until one does.
    recorder.record({
      occurredAt,
      endedAt,
      ending: { kind: "succeeded", inputTokens: 1, outputTokens: 1 },
    });
    expect(queue.submitted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The built-in observation bypass on the metered path
// ---------------------------------------------------------------------------

/** Bounds that admit everything: a counted input far above any fixture, a cap far above. */
function admittingBounds() {
  return {
    input: {
      enforced: "counted" as const,
      maximumTokens: 100_000n,
      countInputTokens: () => 1,
    },
    output: { enforced: "provider_cap" as const, maximumTokens: 100_000n },
  };
}

type WrappedModel = {
  doStream: (params: unknown) => Promise<{
    stream: ReadableStream<Record<string, unknown>>;
  }>;
};

/** An inner model whose stream the test composes chunk by chunk. */
function scriptedModel(parts: Record<string, unknown>[]) {
  const calls: unknown[] = [];
  const model = {
    provider: "openai",
    modelId: "gpt-test",
    async doStream(params: unknown) {
      calls.push(params);
      return {
        stream: new ReadableStream<Record<string, unknown>>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  return { calls, model };
}

function recordingLifecycle(bounds: ModelUsageGateLifecycle["bounds"]) {
  const phases: string[] = [];
  const lifecycle: ModelUsageGateLifecycle = {
    ...(bounds ? { bounds } : {}),
    finish: async () => {
      phases.push("gate-finish");
    },
    fail: async () => {
      phases.push("gate-fail");
    },
  };
  return { phases, lifecycle };
}

async function drain(
  stream: ReadableStream,
): Promise<Record<string, unknown>[]> {
  const reader = stream.getReader();
  const parts: Record<string, unknown>[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value as Record<string, unknown>);
  }
  return parts;
}

const finishPart = (inputTokens?: number, outputTokens?: number) => ({
  type: "finish",
  ...(inputTokens === undefined && outputTokens === undefined
    ? {}
    : {
        usage: {
          inputTokens: { total: inputTokens },
          outputTokens: { total: outputTokens },
        },
      }),
});

describe("the built-in observation bypass (metered path)", () => {
  test("settled usage: one span fact, meter equality, order untouched (acceptance 2)", async () => {
    const { model } = scriptedModel([
      { type: "text-delta", id: "t", delta: "Sunny." },
      finishPart(120, 80),
    ]);
    const order: string[] = [];
    const lifecycle: ModelUsageGateLifecycle = {
      bounds: admittingBounds(),
      finish: async () => {
        order.push("gate-finish");
      },
    };
    const metered: Array<Record<string, unknown>> = [];
    const facts: BuiltinModelSpanFact[] = [];
    try {
      setModelUsageGate(async () => lifecycle);
      setModelUsageMeter((usage) => {
        order.push("meter");
        metered.push({ ...usage });
      });
      setBuiltinModelSpanObserver((fact) => {
        order.push("span");
        facts.push(fact);
      });
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({
        prompt: [{ role: "user", content: "What is the weather?" }],
      });
      await drain(result.stream);
    } finally {
      setModelUsageGate(undefined);
      setModelUsageMeter(undefined);
      setBuiltinModelSpanObserver(undefined);
    }
    // One fact, carrying the exact usage the settlement committed — copied once,
    // never recomputed or summed from the deltas.
    expect(facts).toHaveLength(1);
    expect(facts[0].ending).toEqual({
      kind: "succeeded",
      inputTokens: 120,
      outputTokens: 80,
    });
    expect(metered).toHaveLength(1);
    expect(metered[0]).toMatchObject({ inputTokens: 120, outputTokens: 80 });
    expect(facts[0].eventId).toBe(metered[0].eventId as string);
    // The settlement order is untouched: durable finish first, then the meter,
    // and only then does the observation see anything.
    expect(order).toEqual(["gate-finish", "meter", "span"]);
    // The fact carries the observed input and the accumulated output, read-only.
    expect(facts[0].input).toContain("What is the weather?");
    expect(facts[0].output).toBe("Sunny.");
    expect(facts[0].modelId).toBe("gpt-test");
    expect(facts[0].provider).toBe("openai");
  });

  test("duplicate finish parts still produce exactly one fact and one meter call (acceptance 2)", async () => {
    const { model } = scriptedModel([
      { type: "text-delta", id: "t", delta: "hi" },
      finishPart(10, 5),
      finishPart(10, 5),
    ]);
    const { lifecycle } = recordingLifecycle(admittingBounds());
    const metered: unknown[] = [];
    const facts: BuiltinModelSpanFact[] = [];
    try {
      setModelUsageGate(async () => lifecycle);
      setModelUsageMeter((usage) => metered.push(usage));
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      await drain((await wrapped.doStream({ prompt: [] })).stream);
    } finally {
      setModelUsageGate(undefined);
      setModelUsageMeter(undefined);
      setBuiltinModelSpanObserver(undefined);
    }
    expect(facts).toHaveLength(1);
    expect(metered).toHaveLength(1);
  });

  test("a finish without usage reports an explicit usage_missing fact, not zero (acceptance 1)", async () => {
    const { model } = scriptedModel([
      { type: "text-delta", id: "t", delta: "hi" },
      finishPart(),
    ]);
    const { lifecycle } = recordingLifecycle(admittingBounds());
    const metered: unknown[] = [];
    const facts: BuiltinModelSpanFact[] = [];
    try {
      setModelUsageGate(async () => lifecycle);
      setModelUsageMeter((usage) => metered.push(usage));
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      await drain((await wrapped.doStream({ prompt: [] })).stream);
    } finally {
      setModelUsageGate(undefined);
      setModelUsageMeter(undefined);
      setBuiltinModelSpanObserver(undefined);
    }
    expect(facts).toHaveLength(1);
    expect(facts[0].ending).toEqual({ kind: "usage_missing" });
    // The person's stream completed; no usage fact was ever committed, so the
    // meter stays silent and the span will say unavailable — never 0/0.
    expect(metered).toEqual([]);
  });

  test("a gate refusal is observed as refused, before the provider is called (acceptance 3)", async () => {
    const { calls, model } = scriptedModel([finishPart(1, 1)]);
    const facts: BuiltinModelSpanFact[] = [];
    try {
      setModelUsageGate(async () => {
        throw new CreditGateError();
      });
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      await expect(wrapped.doStream({ prompt: [] })).rejects.toMatchObject({
        name: "CreditGateError",
      });
    } finally {
      setModelUsageGate(undefined);
      setBuiltinModelSpanObserver(undefined);
    }
    expect(calls).toHaveLength(0);
    expect(facts).toHaveLength(1);
    expect(facts[0].ending).toEqual({
      kind: "refused",
      code: "credits_exhausted",
    });
  });

  test("an over-limit bound refusal is observed as refused (acceptance 3)", async () => {
    const { calls, model } = scriptedModel([finishPart(1, 1)]);
    const { lifecycle } = recordingLifecycle({
      input: {
        enforced: "counted",
        maximumTokens: 10n,
        countInputTokens: () => 11,
      },
      output: { enforced: "provider_cap" as const, maximumTokens: 100n },
    });
    const facts: BuiltinModelSpanFact[] = [];
    try {
      setModelUsageGate(async () => lifecycle);
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      await expect(wrapped.doStream({ prompt: [] })).rejects.toMatchObject({
        name: "ModelUsageRefusalError",
        code: "input_over_limit",
      });
    } finally {
      setModelUsageGate(undefined);
      setBuiltinModelSpanObserver(undefined);
    }
    expect(calls).toHaveLength(0);
    expect(facts).toHaveLength(1);
    expect(facts[0].ending).toEqual({
      kind: "refused",
      code: "input_over_limit",
    });
  });

  test("a settlement failure errors the stream and is never a success fact (acceptance 3)", async () => {
    const { model } = scriptedModel([
      { type: "text-delta", id: "t", delta: "hi" },
      finishPart(Number.NaN, 5), // malformed: not a safe integer
    ]);
    const { lifecycle } = recordingLifecycle(admittingBounds());
    const metered: unknown[] = [];
    const facts: BuiltinModelSpanFact[] = [];
    try {
      setModelUsageGate(async () => lifecycle);
      setModelUsageMeter((usage) => metered.push(usage));
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({ prompt: [] });
      let failure: unknown;
      try {
        await drain(result.stream);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        name: "ModelUsageSettlementError",
        code: "usage_invalid",
      });
    } finally {
      setModelUsageGate(undefined);
      setModelUsageMeter(undefined);
      setBuiltinModelSpanObserver(undefined);
    }
    expect(facts).toHaveLength(1);
    expect(facts[0].ending).toEqual({
      kind: "settlement_failed",
      code: "usage_invalid",
    });
    expect(metered).toEqual([]);
  });

  test("an over-bound usage settles as a settlement failure fact (acceptance 3)", async () => {
    const { model } = scriptedModel([
      { type: "text-delta", id: "t", delta: "hi" },
      finishPart(1, 5000),
    ]);
    const { lifecycle } = recordingLifecycle({
      input: {
        enforced: "counted",
        maximumTokens: 100_000n,
        countInputTokens: () => 1,
      },
      output: { enforced: "provider_cap" as const, maximumTokens: 100n },
    });
    const facts: BuiltinModelSpanFact[] = [];
    try {
      setModelUsageGate(async () => lifecycle);
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({ prompt: [] });
      await expect(drain(result.stream)).rejects.toMatchObject({
        code: "usage_over_bound",
      });
    } finally {
      setModelUsageGate(undefined);
      setBuiltinModelSpanObserver(undefined);
    }
    expect(facts).toHaveLength(1);
    expect(facts[0].ending).toEqual({
      kind: "settlement_failed",
      code: "usage_over_bound",
    });
  });

  test("a consumer cancellation is observed as canceled, once", async () => {
    const { model } = scriptedModel([
      { type: "text-delta", id: "t", delta: "hi" },
      finishPart(10, 5),
    ]);
    const { lifecycle } = recordingLifecycle(admittingBounds());
    const facts: BuiltinModelSpanFact[] = [];
    try {
      setModelUsageGate(async () => lifecycle);
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({ prompt: [] });
      const reader = result.stream.getReader();
      await reader.read();
      await reader.cancel("test-done");
    } finally {
      setModelUsageGate(undefined);
      setBuiltinModelSpanObserver(undefined);
    }
    expect(facts).toHaveLength(1);
    expect(facts[0].ending).toEqual({ kind: "canceled" });
  });

  test("a stream that errors mid-flight is observed as failed", async () => {
    const model = {
      provider: "openai",
      modelId: "gpt-test",
      async doStream() {
        return {
          stream: new ReadableStream<Record<string, unknown>>({
            start(controller) {
              controller.error(new Error("provider hung up"));
            },
          }),
        };
      },
    };
    const { lifecycle } = recordingLifecycle(admittingBounds());
    const facts: BuiltinModelSpanFact[] = [];
    try {
      setModelUsageGate(async () => lifecycle);
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({ prompt: [] });
      await expect(drain(result.stream)).rejects.toThrow("provider hung up");
    } finally {
      setModelUsageGate(undefined);
      setBuiltinModelSpanObserver(undefined);
    }
    expect(facts).toHaveLength(1);
    expect(facts[0].ending).toEqual({ kind: "failed", code: "stream_error" });
  });

  test("no observer registered: the metered path behaves exactly as before", async () => {
    const { model } = scriptedModel([
      { type: "text-delta", id: "t", delta: "hi" },
      finishPart(120, 80),
    ]);
    const { phases, lifecycle } = recordingLifecycle(admittingBounds());
    const metered: unknown[] = [];
    try {
      setModelUsageGate(async () => lifecycle);
      setModelUsageMeter((usage) => metered.push(usage));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const parts = await drain(
        (await wrapped.doStream({ prompt: [] })).stream,
      );
      expect(parts.map((part) => part.type)).toEqual(["text-delta", "finish"]);
    } finally {
      setModelUsageGate(undefined);
      setModelUsageMeter(undefined);
    }
    expect(metered).toHaveLength(1);
    expect(phases).toEqual(["gate-finish"]);
  });
});
