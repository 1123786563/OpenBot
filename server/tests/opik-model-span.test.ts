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
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { context, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { OpikObservationWrite } from "../src/ai-observability/health";
import {
  createModelSpanRecorder,
  type ModelSpanObservation,
} from "../src/ai-observability/model-span";
import type { OpikOtlpSpan, OpikPort } from "../src/ai-observability/opik-port";
import { resolveObservationScope } from "../src/ai-observability/scope";
import {
  appendSpanOutputDeltaForTests,
  type BuiltinModelSpanFact,
  CreditGateError,
  type ModelUsageGateLifecycle,
  meteredModelForTests,
  setBuiltinModelSpanObserver,
  setModelUsageGate,
  setModelUsageMeter,
} from "../src/copilot";
import {
  currentRunObservationScope,
  withRunObservationScope,
} from "../src/observation-run-scope";

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
  test("unusable timestamps degrade to borrowed ones, never to 1970 (OCR m157)", async () => {
    const badDates = await recordAndCapture({
      occurredAt: new Date("not-a-date"),
      endedAt: new Date("not-a-date"),
      provider: "openai",
      modelId: "gpt-test",
      ending: { kind: "succeeded", inputTokens: 1, outputTokens: 1 },
      scope: aScope(),
    });
    const span = badDates.writes[0]?.spans[0];
    expect(span?.startTimeUnixNano).not.toBe("0");
    expect(span?.endTimeUnixNano).not.toBe("0");
    // Zero duration is the honest answer when only one time survives.
    expect(span?.startTimeUnixNano).toBe(span?.endTimeUnixNano);

    // A valid end with an unusable start borrows the end; the order stays sane.
    const borrowed = await recordAndCapture({
      occurredAt: new Date("not-a-date"),
      endedAt,
      provider: "openai",
      modelId: "gpt-test",
      ending: { kind: "succeeded", inputTokens: 1, outputTokens: 1 },
      scope: aScope(),
    });
    const b = borrowed.writes[0]?.spans[0];
    expect(BigInt(b?.startTimeUnixNano ?? "0")).toBe(
      BigInt(b?.endTimeUnixNano ?? "1"),
    );
  });

  test("a provable run chain is joined, a malformed one is never claimed (OCR h6)", async () => {
    const runTraceId = "a".repeat(32);
    const runSpanId = "b".repeat(16);
    const { writes } = await recordAndCapture({
      occurredAt,
      endedAt,
      provider: "openai",
      modelId: "gpt-test",
      ending: { kind: "succeeded", inputTokens: 1, outputTokens: 1 },
      scope: aScope(),
      trace: { traceId: runTraceId, parentSpanId: runSpanId },
    });
    expect(writes).toHaveLength(1);
    const joined = writes[0].spans[0];
    // The span joins the run's trace and parents under the run span: every model
    // call of one run lands in one trace, no orphan per call.
    expect(joined.traceId).toBe(runTraceId);
    expect(joined.parentSpanId).toBe(runSpanId);

    // A context that does not prove its shape is never fully claimed: a malformed
    // trace id adopts nothing (fresh identity, no parent); a valid trace id with a
    // malformed parent adopts the chain but refuses the parent.
    const badTrace = await recordAndCapture({
      occurredAt,
      endedAt,
      ending: { kind: "succeeded", inputTokens: 1, outputTokens: 1 },
      scope: aScope(),
      trace: { traceId: "nothex!", parentSpanId: runSpanId },
    });
    expect(badTrace.writes[0]?.spans[0]?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(badTrace.writes[0]?.spans[0]?.traceId).not.toBe(runTraceId);
    expect(badTrace.writes[0]?.spans[0]?.parentSpanId).toBeUndefined();

    const badParent = await recordAndCapture({
      occurredAt,
      endedAt,
      ending: { kind: "succeeded", inputTokens: 1, outputTokens: 1 },
      scope: aScope(),
      trace: { traceId: runTraceId, parentSpanId: "short" },
    });
    expect(badParent.writes[0]?.spans[0]?.traceId).toBe(runTraceId);
    expect(badParent.writes[0]?.spans[0]?.parentSpanId).toBeUndefined();

    // No context at all: the pre-h6 behavior stands (fresh trace, no parent).
    const absent = await recordAndCapture({
      occurredAt,
      endedAt,
      ending: { kind: "succeeded", inputTokens: 1, outputTokens: 1 },
      scope: aScope(),
    });
    expect(absent.writes[0]?.spans[0]?.parentSpanId).toBeUndefined();
  });

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

  test("a media-bearing prompt is metrics-only: no serialized input, no base64 anywhere (OCR R2-52)", async () => {
    // The defect's shape: an attachment inlined as base64 in a non-text part, big
    // enough to stay pinned from capture through the billing check to settlement.
    // 1MB proves the mechanism; the production figure was ~43MB.
    const attachment = "QUJD".repeat(349_525);
    const { model } = scriptedModel([
      { type: "text-delta", id: "t", delta: "described" },
      finishPart(12, 3),
    ]);
    const facts: BuiltinModelSpanFact[] = [];
    const { lifecycle } = recordingLifecycle(admittingBounds());
    const metered: unknown[] = [];
    try {
      setModelUsageGate(async () => lifecycle);
      setModelUsageMeter((usage) => metered.push(usage));
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({
        prompt: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this image" },
              { type: "image", image: attachment },
            ],
          },
        ],
      });
      await drain(result.stream);
    } finally {
      setModelUsageGate(undefined);
      setModelUsageMeter(undefined);
      setBuiltinModelSpanObserver(undefined);
    }
    // The call itself is untouched: settled usage, meter equality — metrics-only
    // means the USAGE metrics survive, not the observation.
    expect(facts).toHaveLength(1);
    expect(facts[0].ending).toEqual({
      kind: "succeeded",
      inputTokens: 12,
      outputTokens: 3,
    });
    expect(metered).toHaveLength(1);
    // The capture never serialized the prompt: no base64 run exists anywhere in
    // the fact, and the input is the explicit metrics-only null, not a cut.
    expect(facts[0].input).toBeNull();
    expect(JSON.stringify(facts[0])).not.toContain("QUJD");
  });

  test("a file-part prompt is metrics-only too, without serializing the data (OCR R2-52)", async () => {
    const document = "ZGF0YQ==".repeat(100_000);
    const { model } = scriptedModel([finishPart(1, 1)]);
    const facts: BuiltinModelSpanFact[] = [];
    try {
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({
        prompt: [
          {
            role: "user",
            content: [
              { type: "text", text: "summarise" },
              { type: "file", data: document, mediaType: "application/pdf" },
            ],
          },
        ],
      });
      await drain(result.stream);
    } finally {
      setBuiltinModelSpanObserver(undefined);
    }
    expect(facts[0].input).toBeNull();
    expect(JSON.stringify(facts[0])).not.toContain("ZGF0YQ");
  });

  test("a text-only prompt larger than the cap is cut at the cap with an explicit mark (OCR R2-52)", async () => {
    const filler = "x".repeat(50_000);
    const { model } = scriptedModel([
      { type: "text-delta", id: "t", delta: "ok" },
      finishPart(1, 1),
    ]);
    const facts: BuiltinModelSpanFact[] = [];
    try {
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({
        prompt: [
          { role: "system", content: "the first message survives" },
          { role: "user", content: filler },
          { role: "user", content: filler },
        ],
      });
      await drain(result.stream);
    } finally {
      setBuiltinModelSpanObserver(undefined);
    }
    const input = facts[0].input;
    expect(typeof input).toBe("string");
    // The capture-side ceiling: the captured string never exceeds 64Ki characters
    // plus its own mark, however large the prompt was (~100Ki here).
    expect(input!.length).toBeLessThanOrEqual(64 * 1024 + 64);
    expect(input!.length).toBeGreaterThan(60_000);
    // Early messages survive the cut; the cut itself is declared in-band, so a
    // bounded capture can never be read as the whole prompt.
    expect(input).toContain("the first message survives");
    expect(input).toContain("[observation input truncated at capture]");
  });

  test("a small text-only prompt is captured whole, as before (OCR R2-52 non-regression)", async () => {
    const { model } = scriptedModel([finishPart(1, 1)]);
    const facts: BuiltinModelSpanFact[] = [];
    try {
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({
        prompt: [{ role: "user", content: "What is the weather?" }],
      });
      await drain(result.stream);
    } finally {
      setBuiltinModelSpanObserver(undefined);
    }
    expect(facts[0].input).toBe(
      JSON.stringify([{ role: "user", content: "What is the weather?" }]),
    );
  });

  test("a bare-string prompt is captured sliced before serialization, within the ceiling (OCR R5-44)", async () => {
    // The non-array fallback used to JSON.stringify the WHOLE prompt first and
    // slice after — a 40MB custom-provider prompt materialized whole in a
    // transient string, the exact allocation the module's own R2-52 discipline
    // forbids ("sliced BEFORE serialization, no transient allocation ever
    // exceeds the capture"). The only provably-text non-array shape is a bare
    // string: sliced raw, then serialized, then ceiling-checked.
    const { model } = scriptedModel([finishPart(1, 1)]);
    const facts: BuiltinModelSpanFact[] = [];
    try {
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({
        prompt: `head-${"x".repeat(100_000)}-tail-never-kept`,
      });
      await drain(result.stream);
    } finally {
      setBuiltinModelSpanObserver(undefined);
    }
    const input = facts[0].input;
    expect(typeof input).toBe("string");
    expect(input!.length).toBeLessThanOrEqual(64 * 1024 + 64);
    // The head of the RAW text is what was kept — serialized after the slice.
    expect(input).toContain('"head-');
    expect(input).not.toContain("tail-never-kept");
    // The cut is declared in-band: a bounded capture is never read as the whole.
    expect(input).toContain("[observation input truncated at capture]");
  });

  test("a non-array prompt that is not provably text is metrics-only — never serialized (OCR R5-44)", async () => {
    // Whatever a custom provider hands over that is not a message array and
    // not a bare string cannot be proven text-only, so serializing it — the
    // old unbounded fallback — is exactly what the capture discipline forbids.
    // Metrics-only null, like every media-carrying shape in this module.
    const { model } = scriptedModel([finishPart(1, 1)]);
    const facts: BuiltinModelSpanFact[] = [];
    try {
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      await drain(
        (
          await wrapped.doStream({
            prompt: { custom: "shape", attachment: "z".repeat(5_000) },
          })
        ).stream,
      );
      await drain((await wrapped.doStream({ prompt: undefined })).stream);
    } finally {
      setBuiltinModelSpanObserver(undefined);
    }
    expect(facts).toHaveLength(2);
    expect(facts[0].input).toBeNull();
    // The old fallback serialized an absent prompt as the four characters
    // "null" — a string that was never the prompt.
    expect(facts[1].input).toBeNull();
  });

  test("a large successful output is cut at the capture ceiling, not retained whole (OCR R2-53)", async () => {
    const delta = "y".repeat(1_000);
    const { model } = scriptedModel([
      ...Array.from({ length: 10 }, () => ({
        type: "text-delta",
        id: "t",
        delta,
      })),
      finishPart(5, 10_000),
    ]);
    const facts: BuiltinModelSpanFact[] = [];
    try {
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({ prompt: [] });
      await drain(result.stream);
    } finally {
      setBuiltinModelSpanObserver(undefined);
    }
    expect(facts[0].ending).toEqual({
      kind: "succeeded",
      inputTokens: 5,
      outputTokens: 10_000,
    });
    // The settle merge keeps the same 2000-char ceiling the failure path applies
    // to error messages — 10_000 chars of deltas must not be pinned whole.
    expect(facts[0].output!.length).toBe(2_000);
  });

  test("a single over-ceiling delta is cut at the capture ceiling too (OCR R4-33)", async () => {
    // The non-streamed fallback emits the WHOLE completion as one text-delta;
    // the capture-side accumulator cuts it to the remaining capacity at push
    // time (R4-33) instead of pinning it whole until settlement's join.
    const { model } = scriptedModel([
      { type: "text-delta", id: "t", delta: "y".repeat(10_000) },
      finishPart(5, 10_000),
    ]);
    const facts: BuiltinModelSpanFact[] = [];
    try {
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      const result = await wrapped.doStream({ prompt: [] });
      await drain(result.stream);
    } finally {
      setBuiltinModelSpanObserver(undefined);
    }
    expect(facts[0].ending).toEqual({
      kind: "succeeded",
      inputTokens: 5,
      outputTokens: 10_000,
    });
    expect(facts[0].output).toBe("y".repeat(2_000));
  });

  test("the fact carries the scope captured at entry even when settlement lands after teardown (OCR R2-58)", async () => {
    const scope = aScope();
    const { model } = scriptedModel([
      { type: "text-delta", id: "t", delta: "hi" },
      finishPart(2, 1),
    ]);
    const facts: BuiltinModelSpanFact[] = [];
    try {
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      // Only doStream runs inside the run's ambient scope — capture time.
      const streamed = await withRunObservationScope(scope, () =>
        wrapped.doStream({ prompt: [] }),
      );
      // Settlement time: the ambient context is gone; an adapter that re-reads
      // it here reads nothing.
      await drain(streamed.stream);
      expect(currentRunObservationScope()).toBeUndefined();
    } finally {
      setBuiltinModelSpanObserver(undefined);
    }
    expect(facts).toHaveLength(1);
    // The fact carries the scope its doStream entry captured — the exact object
    // the threading established — so a post-teardown settlement still lands.
    expect(facts[0].scope).toBe(scope);
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

  test("a half-reported usage whose reported half is invalid yields exactly ONE span fact (OCR R4-32)", async () => {
    // input=-5 is present-but-negative (invalid), output absent (half-report):
    // settleFail("usage_missing") claims `settled` and reports the fact, then
    // the invalid-usage branch below it still reached failSettlement, which
    // reported a second, contradictory settlement_failed span for the same call
    // — exactly the two-records shape OCR R4-32 pins against.
    const { model } = scriptedModel([
      { type: "text-delta", id: "t", delta: "hi" },
      {
        type: "finish",
        usage: { inputTokens: { total: -5 }, outputTokens: {} },
      },
    ]);
    const facts: BuiltinModelSpanFact[] = [];
    const failReasons: string[] = [];
    const unsettled: string[] = [];
    try {
      setModelUsageGate(async () => ({
        bounds: admittingBounds(),
        fail: async (input) => {
          failReasons.push(input.reason);
        },
        recordUnsettled: async (input) => {
          unsettled.push(input.reason);
        },
      }));
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      // The settlement itself still fails (the teardown discipline is
      // unchanged); what this pin owns is that the observation carries ONE
      // verdict for the call, not two contradictory ones.
      await expect(
        drain((await wrapped.doStream({ prompt: [] })).stream),
      ).rejects.toThrow(/usage_invalid/);
    } finally {
      setModelUsageGate(undefined);
      setBuiltinModelSpanObserver(undefined);
    }
    expect(failReasons).toEqual(["usage_missing"]);
    expect(unsettled).toEqual(["usage_invalid"]);
    expect(facts).toHaveLength(1);
    expect(facts[0].ending).toEqual({ kind: "usage_missing" });
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

  test("the fact carries the ambient W3C context captured at entry (OCR h6)", async () => {
    // A registered provider installs the ambient context manager the capture
    // reads (the same footing the trace-chain suite runs on).
    const provider = new NodeTracerProvider();
    provider.register();
    const { model } = scriptedModel([
      { type: "text-delta", id: "t", delta: "hi" },
      finishPart(1, 1),
    ]);
    const { lifecycle } = recordingLifecycle(admittingBounds());
    const facts: BuiltinModelSpanFact[] = [];
    const tracer = trace.getTracer("opik-model-span-test");
    const runSpan = tracer.startSpan("the run");
    try {
      setModelUsageGate(async () => lifecycle);
      setBuiltinModelSpanObserver((fact) => facts.push(fact));
      const wrapped = meteredModelForTests(model) as WrappedModel;
      // The metered call runs inside the run's ambient context; the fact's trace
      // must be captured HERE (at doStream entry), not at stream teardown.
      await context.with(trace.setSpan(context.active(), runSpan), async () => {
        const result = await wrapped.doStream({ prompt: [] });
        await drain(result.stream);
      });
    } finally {
      runSpan.end();
      setModelUsageGate(undefined);
      setBuiltinModelSpanObserver(undefined);
      await provider.shutdown();
      trace.disable();
    }
    expect(facts).toHaveLength(1);
    expect(facts[0].trace?.traceId).toBe(runSpan.spanContext().traceId);
    expect(facts[0].trace?.spanId).toBe(runSpan.spanContext().spanId);

    // Outside any traced request the fact honestly answers null.
    const bareFacts: BuiltinModelSpanFact[] = [];
    const { model: bareModel } = scriptedModel([finishPart(1, 1)]);
    const { lifecycle: bareLifecycle } = recordingLifecycle(admittingBounds());
    try {
      setModelUsageGate(async () => bareLifecycle);
      setBuiltinModelSpanObserver((fact) => bareFacts.push(fact));
      const wrapped = meteredModelForTests(bareModel) as WrappedModel;
      const result = await wrapped.doStream({ prompt: [] });
      await drain(result.stream);
    } finally {
      setModelUsageGate(undefined);
      setBuiltinModelSpanObserver(undefined);
    }
    expect(bareFacts[0]?.trace).toBeNull();
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

/*
 * OCR R4-33: the accumulator itself, not just its settled join. The capture
 * ceiling is a RETENTION bound — the delta that crosses it is cut to the
 * remaining capacity (the appendToolStepArg discipline) — so a whole
 * non-streamed completion emitted as one text-delta is never pinned alive
 * until settlement. The settled join's own slice makes the same output
 * readable either way; this seam is where the bound itself is provable.
 */
describe("the span-output accumulator's capture ceiling (OCR R4-33)", () => {
  test("a single delta over the ceiling is cut to the ceiling, not retained whole", () => {
    const deltas: string[] = [];
    const length = appendSpanOutputDeltaForTests(deltas, 0, "z".repeat(5_000));
    expect(length).toBe(2_000);
    expect(deltas.join("")).toHaveLength(2_000);
  });

  test("a delta partially into the ceiling is cut to the remaining capacity", () => {
    const deltas: string[] = ["ab"];
    const length = appendSpanOutputDeltaForTests(deltas, 2, "z".repeat(5_000));
    expect(length).toBe(2_000);
    expect(deltas.join("")).toBe(`ab${"z".repeat(1_998)}`);
  });

  test("past the ceiling nothing is retained at all", () => {
    const deltas: string[] = ["z".repeat(2_000)];
    const length = appendSpanOutputDeltaForTests(deltas, 2_000, "overflow");
    expect(length).toBe(2_000);
    expect(deltas).toHaveLength(1);
  });

  test("deltas under the ceiling are kept whole, as before (non-regression)", () => {
    const deltas: string[] = [];
    const length = appendSpanOutputDeltaForTests(deltas, 0, "hello");
    expect(length).toBe(5);
    expect(deltas).toEqual(["hello"]);
  });
});
