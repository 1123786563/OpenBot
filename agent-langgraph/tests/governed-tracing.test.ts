/**
 * The governed OTel path for the framework Bot (Issue #22 / DAG T16).
 *
 * The framework's callbacks must ride the same tracing every other process in this deployment
 * rides — shared/trace.ts's one provider, W3C continuation and OTLP export — with the
 * parent-child map maintained at the callback layer, content omitted rather than carried
 * unprojected, and a capability verdict that cannot say detailed until a real instance has
 * verified the model/tool/retrieval parent-child shape (T37's job, not this one's).
 *
 * Driven with hand-built callback invocations against a local in-process tracer provider,
 * because the thing worth pinning is what the handler does with what the framework hands it —
 * never a network hop, never `server/` (this module's Docker image does not even contain that
 * directory, so its tests cannot depend on it either).
 */

import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { readFileSync } from "node:fs";
import type { BaseEvent } from "@ag-ui/core";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";
import { DynamicTool } from "@langchain/core/tools";
import {
  FakeListChatModel,
  FakeRetriever,
} from "@langchain/core/utils/testing";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  FRAMEWORK_STEPS_VERIFIED_ON_REAL_INSTANCE,
  GovernedCallbackHandler,
  governedRunSpan,
  resolveFrameworkCapability,
  traceDeploymentToolCall,
} from "../src/governed-tracing";
import { streamRun } from "../src/stream";

/**
 * The canaries a governed egress must not survive. Each is a distinct credential class the
 * deployment's projection denies; planted in prompts, outputs, errors, queries, tool payloads
 * and names, then hunted through every recorded span's name, attributes and events as a whole.
 */
const CANARIES = [
  "sk-live-abcdefghijklmnopqrstuv",
  "Bearer abcdefghijklmnopqrstuv",
  "ghp_abcdefghijklmnopqrstuvwxyz123456",
  "postgres://user:secret@db.example.com/prod",
];

/** Nothing in any span may contain any canary, wherever it was planted. */
function assertNoCanaries(spans: ReadableSpan[]): void {
  for (const span of spans) {
    const whole = JSON.stringify({
      name: span.name,
      attributes: span.attributes,
      events: span.events,
    });
    for (const canary of CANARIES) {
      expect(whole.includes(canary)).toBe(false);
    }
  }
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

const serialized = (name: string) =>
  ({ id: ["test", name], kwargs: {} }) as unknown as Serialized;

const spanOf = (spans: ReadableSpan[], name: string): ReadableSpan => {
  const span = spans.find((candidate) => candidate.name === name);
  if (!span) throw new Error(`no span named ${name}`);
  return span;
};

describe("the capability verdict (Issue #22: unverified is never detailed)", () => {
  test("detailed needs verified internal steps, exactly like the server's verdict", () => {
    expect(
      resolveFrameworkCapability({
        internalStepsVerified: true,
        observedEvents: true,
      }),
    ).toBe("detailed");
    expect(
      resolveFrameworkCapability({
        internalStepsVerified: false,
        observedEvents: true,
      }),
    ).toBe("basic");
    expect(
      resolveFrameworkCapability({
        internalStepsVerified: false,
        observedEvents: false,
      }),
    ).toBe("unavailable");
    // The server's own rule: verified instrumentation claims detailed even before an event
    // lands, because the observation capability is a property of the path, not the traffic.
    expect(
      resolveFrameworkCapability({
        internalStepsVerified: true,
        observedEvents: false,
      }),
    ).toBe("detailed");
  });

  test("the wiring constant is true: T37 verified the shape on a real instance", () => {
    // T37 probe B (2026-10-16, opik-issue4-validation stack): run → chain → model/tool/
    // retrieval parent-child nesting verified over the governed OTLP path; evidence in
    // docs/plans/evidence/2026-10-16-issue4/T37/evidence/b1-framework-rows.json.
    expect(FRAMEWORK_STEPS_VERIFIED_ON_REAL_INSTANCE).toBe(true);
    // The verdict this module stamps on every run span now: detailed, on verified evidence.
    expect(
      resolveFrameworkCapability({
        internalStepsVerified: FRAMEWORK_STEPS_VERIFIED_ON_REAL_INSTANCE,
        observedEvents: true,
      }),
    ).toBe("detailed");
  });
});

describe("the callback handler's span tree", () => {
  test("model, tool and retrieval spans hang off their framework parent runs", async () => {
    const recorder = recordedSpans();
    const handler = new GovernedCallbackHandler();
    try {
      handler.handleChainStart(serialized("graph"), {}, "run-graph");
      handler.handleChatModelStart(
        serialized("chat"),
        [],
        "run-model",
        "run-graph",
        { invocation_params: { model: "gpt-5.5" } },
      );
      handler.handleLLMEnd({ generations: [] } as LLMResult, "run-model");
      handler.handleToolStart(
        serialized("web_search"),
        "{}",
        "run-tool",
        "run-graph",
        [],
        {},
        "web_search",
        "call_1",
      );
      handler.handleToolEnd("result", "run-tool");
      handler.handleRetrieverStart(
        serialized("kb"),
        "query",
        "run-ret",
        "run-graph",
        [],
        {},
        "kb",
      );
      handler.handleRetrieverEnd([], "run-ret");
      handler.handleChainEnd({}, "run-graph");

      const chain = spanOf(recorder.spans, "chain:graph");
      const model = spanOf(recorder.spans, "model:gpt-5.5");
      const tool = spanOf(recorder.spans, "tool:web_search");
      const retrieval = spanOf(recorder.spans, "retrieval");

      // The parent-child relationship is maintained at the callback layer, from the
      // framework's own run ids — the tree the real instance check (T37) will walk.
      expect(model.parentSpanContext?.spanId).toBe(chain.spanContext().spanId);
      expect(tool.parentSpanContext?.spanId).toBe(chain.spanContext().spanId);
      expect(retrieval.parentSpanContext?.spanId).toBe(
        chain.spanContext().spanId,
      );
      expect(chain.parentSpanContext).toBeUndefined();

      expect(model.attributes).toMatchObject({ "openbot.step.kind": "model" });
      expect(tool.attributes).toMatchObject({
        "openbot.step.kind": "tool",
        "openbot.tool.call_id": "call_1",
      });
      expect(retrieval.attributes).toMatchObject({
        "openbot.step.kind": "retrieval",
      });
      // The terminal read key is the server projection's own (R3-06): the row the
      // timeline renders reads `span_state` off the span's attributes — the `openbot.*`
      // spelling had zero consumers anywhere, so every step read as unknown forever.
      for (const span of [chain, model, tool, retrieval]) {
        expect(span.attributes).toMatchObject({
          span_state: "completed",
        });
        expect(span.attributes).not.toHaveProperty("openbot.span.state");
      }
      // A tool step keeps its terminal state only when the projection's OTHER read
      // key says the execution was observed: state stays unknown unless
      // `execution_state` reads "executed" (queries/runs.ts projectStep).
      expect(tool.attributes).toMatchObject({ execution_state: "executed" });
    } finally {
      await recorder.stop();
    }
  });

  test("a parentless run roots on the ambient span, so the request's trace continues", async () => {
    const recorder = recordedSpans();
    const handler = new GovernedCallbackHandler();
    try {
      const tracer = trace.getTracer("test-ambient");
      const ambient = tracer.startSpan("POST /ag-ui");
      context.with(trace.setSpan(context.active(), ambient), () => {
        handler.handleChatModelStart(serialized("chat"), [], "run-model");
      });
      handler.handleLLMEnd({ generations: [] } as LLMResult, "run-model");
      ambient.end();

      const model = spanOf(recorder.spans, "model:unnamed");
      expect(model.parentSpanContext?.spanId).toBe(
        ambient.spanContext().spanId,
      );
    } finally {
      await recorder.stop();
    }
  });

  test("an error ends its span failed with the error's shape, not its message", async () => {
    const recorder = recordedSpans();
    const handler = new GovernedCallbackHandler();
    try {
      handler.handleChainStart(serialized("graph"), {}, "run-graph");
      handler.handleChatModelStart(
        serialized("chat"),
        [],
        "run-model",
        "run-graph",
      );
      handler.handleLLMError(new Error(`boom ${CANARIES[0]}`), "run-model");
      handler.handleChainError(new Error("graph failed"), "run-graph");

      const model = spanOf(recorder.spans, "model:unnamed");
      // The error's shape rides the server recorder's ending vocabulary (R3-06):
      // `ending_kind` names the ending, `ending_code` the shape token — the
      // `openbot.error.name` spelling had zero consumers anywhere.
      expect(model.attributes).toMatchObject({
        span_state: "failed",
        ending_kind: "failed",
        ending_code: "Error",
      });
      expect(model.attributes).not.toHaveProperty("openbot.error.name");
      expect(model.attributes).not.toHaveProperty("openbot.span.state");
      expect(model.status.code).toBe(SpanStatusCode.ERROR);
      expect(model.events).toEqual([]);
    } finally {
      await recorder.stop();
    }
  });

  test("usage is actual only when the framework reported both token counts", async () => {
    const recorder = recordedSpans();
    const handler = new GovernedCallbackHandler();
    try {
      handler.handleChatModelStart(serialized("chat"), [], "a");
      handler.handleLLMEnd(
        {
          generations: [],
          llmOutput: { tokenUsage: { promptTokens: 3, completionTokens: 5 } },
        } as unknown as LLMResult,
        "a",
      );
      handler.handleChatModelStart(serialized("chat"), [], "b");
      handler.handleLLMEnd(
        {
          generations: [
            [
              {
                message: {
                  usage_metadata: { input_tokens: 7, output_tokens: 11 },
                },
              },
            ],
          ],
        } as unknown as LLMResult,
        "b",
      );
      handler.handleChatModelStart(serialized("chat"), [], "c");
      handler.handleLLMEnd({ generations: [] } as LLMResult, "c");

      const spans = recorder.spans.filter((span) =>
        span.name.startsWith("model"),
      );
      // Token vocabulary rides the server recorder's keys (R3-06): `usage_state`,
      // `tokens_input`, `tokens_output` — the `openbot.model.*` spellings had zero
      // consumers anywhere, so honest counts landed where nothing could read them.
      expect(spans[0].attributes).toMatchObject({
        usage_state: "actual",
        tokens_input: 3,
        tokens_output: 5,
      });
      expect(spans[1].attributes).toMatchObject({
        usage_state: "actual",
        tokens_input: 7,
        tokens_output: 11,
      });
      // No report is an explicit unavailable, never a silent 0 (T14's honesty rule).
      expect(spans[2].attributes).toMatchObject({
        usage_state: "unavailable",
      });
      expect(spans[2].attributes).not.toHaveProperty("tokens_input");
    } finally {
      await recorder.stop();
    }
  });

  test("forged non-number token counts are unavailable, never Number()-coerced zeros (R3-09)", async () => {
    // R3-09: `Number(null)`/`Number("")`/`Number([])` are 0 and `Number(true)` is 1,
    // so the old coercion ran null/empty-string/array/boolean forgeries through
    // `Number.isInteger && >= 0` and stamped `state: "actual"` onto counts nobody
    // reported — the exact silent zero the honesty rule forbids. Every shape the
    // framework could hand over that is not a real number must read unavailable.
    const recorder = recordedSpans();
    const handler = new GovernedCallbackHandler();
    try {
      const forgeries: Record<string, unknown>[] = [
        { input_tokens: null, output_tokens: 5 },
        { input_tokens: "", output_tokens: 5 },
        { input_tokens: [], output_tokens: 5 },
        { input_tokens: true, output_tokens: 5 },
        { input_tokens: "12", output_tokens: 5 },
        { input_tokens: 3, output_tokens: null },
        { input_tokens: 3, output_tokens: false },
      ];
      for (const [index, usage] of forgeries.entries()) {
        handler.handleChatModelStart(serialized("chat"), [], `forged-${index}`);
        handler.handleLLMEnd(
          {
            generations: [],
            llmOutput: { usage },
          } as unknown as LLMResult,
          `forged-${index}`,
        );
      }

      const spans = recorder.spans.filter((span) =>
        span.name.startsWith("model"),
      );
      expect(spans.length).toBe(forgeries.length);
      for (const span of spans) {
        expect(span.attributes).toMatchObject({
          usage_state: "unavailable",
        });
        expect(span.attributes).not.toHaveProperty("tokens_input");
        expect(span.attributes).not.toHaveProperty("tokens_output");
      }
    } finally {
      await recorder.stop();
    }
  });

  test("canaries in inputs, outputs, errors and logs cannot reach a span", async () => {
    const recorder = recordedSpans();
    const handler = new GovernedCallbackHandler();
    try {
      handler.handleChainStart(serialized("graph"), {}, "run-graph");
      handler.handleChatModelStart(
        serialized("chat"),
        [],
        "run-model",
        "run-graph",
      );
      handler.handleLLMEnd(
        {
          generations: [[{ text: CANARIES.join(" ") }]],
        } as unknown as LLMResult,
        "run-model",
      );
      handler.handleToolStart(
        serialized("tool"),
        JSON.stringify({ q: CANARIES[1] }),
        "run-tool",
        "run-graph",
      );
      handler.handleToolError(new Error(CANARIES[2]), "run-tool");
      handler.handleRetrieverStart(
        serialized("kb"),
        CANARIES[3],
        "run-ret",
        "run-graph",
      );
      handler.handleRetrieverEnd([], "run-ret");
      handler.handleChainEnd({}, "run-graph");

      expect(recorder.spans.length).toBeGreaterThan(0);
      assertNoCanaries(recorder.spans);
      // The omission is stated, not silent: content this layer refuses to carry says so.
      expect(spanOf(recorder.spans, "model:unnamed").attributes).toMatchObject({
        "openbot.content.state": "omitted",
        "openbot.content.reason": "unhandled_free_text",
      });
    } finally {
      await recorder.stop();
    }
  });

  test("a credential-shaped name is withheld, not passed through as a span name", async () => {
    const recorder = recordedSpans();
    const handler = new GovernedCallbackHandler();
    try {
      handler.handleToolStart(
        serialized("x"),
        "{}",
        "run-tool",
        undefined,
        [],
        {},
        `t:${CANARIES[0]}`,
      );
      handler.handleToolEnd("ok", "run-tool");

      const tool = recorder.spans.find((span) => span.name.startsWith("tool"));
      if (!tool) throw new Error("no tool span");
      expect(tool.name).toBe("tool:unnamed");
      expect(tool.attributes).toMatchObject({ "openbot.step.name": "unnamed" });
      assertNoCanaries(recorder.spans);
    } finally {
      await recorder.stop();
    }
  });

  test("a credential URL inside a longer name is still withheld, not only a whole-name URL (R5-0)", async () => {
    const recorder = recordedSpans();
    const handler = new GovernedCallbackHandler();
    try {
      // The URL does not start the name: the scheme rides mid-string, exactly the
      // shape a step name like "call <endpoint>" produces. The deny is a substring
      // question like every other pattern in the list — the userinfo credentials
      // must not survive because the scheme is not at position 0.
      handler.handleToolStart(
        serialized("x"),
        "{}",
        "run-tool",
        undefined,
        [],
        {},
        `call https://user:secret@db.example.com/api`,
      );
      handler.handleToolEnd("ok", "run-tool");

      const tool = recorder.spans.find((span) => span.name.startsWith("tool"));
      if (!tool) throw new Error("no tool span");
      expect(tool.name).toBe("tool:unnamed");
      expect(tool.attributes).toMatchObject({ "openbot.step.name": "unnamed" });
      assertNoCanaries(recorder.spans);
    } finally {
      await recorder.stop();
    }
  });

  test("a stray end for a run this handler never started records nothing", async () => {
    const recorder = recordedSpans();
    const handler = new GovernedCallbackHandler();
    try {
      handler.handleLLMEnd({ generations: [] } as LLMResult, "never-started");
      expect(recorder.spans).toEqual([]);
    } finally {
      await recorder.stop();
    }
  });
});

describe("the server stepFamily contract, driven by a real @langchain/core graph", () => {
  // Pinned copy of server/src/ai-observability/queries/runs.ts `stepFamily` (R2fix-T1):
  // the projection's naming contract, which reads recorder families off the span name.
  // This module's image and tests cannot depend on server/, so the contract rides here
  // verbatim; the triage round 2 report (R2-00) pins the source line.
  function stepFamily(name: unknown): "tool" | "model" | "retrieval" | null {
    if (typeof name !== "string") return null;
    if (name === "retrieval") return "retrieval";
    if (name === "tool" || name.startsWith("tool:")) return "tool";
    if (name === "model" || name.startsWith("model:")) return "model";
    return null;
  }

  /**
   * Pinned copy of server/src/ai-observability/queries/runs.ts `projectStep`'s state
   * determination (R3-06): the terminal vocabulary reads `span_state` off the span's
   * attributes, and a tool step keeps it only when `execution_state` reads "executed" —
   * anything else fails closed onto "unknown". This module's tests cannot depend on
   * server/, so the contract rides here; the triage round 3 report pins the source line.
   */
  function projectedStepState(
    name: unknown,
    attributes: Record<string, unknown>,
  ): "completed" | "failed" | "canceled" | "unknown" {
    const kind = stepFamily(name);
    if (kind === null) return "unknown";
    const recorded = attributes.span_state;
    const terminal: "completed" | "failed" | "canceled" | "unknown" =
      recorded === "completed" ||
      recorded === "failed" ||
      recorded === "canceled" ||
      recorded === "unknown"
        ? recorded
        : "unknown";
    const determination = attributes.execution_state;
    const executionState =
      determination === "proposed" ||
      determination === "executed" ||
      determination === "unobserved"
        ? determination
        : undefined;
    return kind === "tool" && executionState !== "executed"
      ? "unknown"
      : terminal;
  }

  /** A real graph (real dispatch, no hand-called handlers): model -> tool -> retriever. */
  function realGraph() {
    return RunnableSequence.from([
      new FakeListChatModel({ responses: ["graph says hi"] }),
      RunnableLambda.from((message: unknown) =>
        String((message as { content?: unknown }).content ?? message),
      ),
      new DynamicTool({
        name: "search_tool",
        description: "the graph's tool step",
        func: async () => "ok",
      }),
      new FakeRetriever({
        output: [{ pageContent: "kb hit", metadata: {} }],
      }),
    ]);
  }

  async function driveRealGraph(): Promise<ReturnType<typeof recordedSpans>> {
    const recorder = recordedSpans();
    const handler = new GovernedCallbackHandler();
    const run = governedRunSpan({
      runId: "run_real_graph",
      threadId: "thread_real_graph",
    });
    try {
      await context.with(
        trace.setSpan(context.active(), run.span),
        async () => {
          await realGraph().invoke("hello graph", { callbacks: [handler] });
        },
      );
      run.finish("completed");
    } catch (error) {
      await recorder.stop();
      throw error;
    }
    return recorder;
  }

  test("a real graph's model/tool/retrieval steps survive the server's stepFamily projection", async () => {
    const recorder = await driveRealGraph();
    try {
      // The deployment's steps projection drops any span whose name has no recorder
      // family (projectStep's first line). The framework's model/tool/retrieval steps
      // must project — this is the acceptance the T37 claim rests on.
      const families = recorder.spans.map((span) => stepFamily(span.name));
      expect(families.filter((family) => family === "model").length).toBe(1);
      expect(families.filter((family) => family === "tool")).toEqual(["tool"]);
      expect(families.filter((family) => family === "retrieval")).toEqual([
        "retrieval",
      ]);
    } finally {
      await recorder.stop();
    }
  });

  test("a real graph's steps carry the colon-prefix names and nest run -> chain -> step", async () => {
    const recorder = await driveRealGraph();
    try {
      const run = spanOf(recorder.spans, "ag-ui run");
      const sequence = spanOf(recorder.spans, "chain:RunnableSequence");
      const lambda = spanOf(recorder.spans, "chain:RunnableLambda");
      const model = recorder.spans.find(
        (span) => stepFamily(span.name) === "model",
      );
      const tool = spanOf(recorder.spans, "tool:search_tool");
      const retrieval = spanOf(recorder.spans, "retrieval");

      // Names read the recorder convention the projection parses: `kind:` prefix for
      // model/tool, the bare `retrieval` word (its name rides the attribute).
      expect(model?.name).toMatch(/^model:/);
      expect(tool.name).toBe("tool:search_tool");
      expect(retrieval.name).toBe("retrieval");

      // Parentage rides the framework's own run ids: chain runs nest under their
      // parent chain run (the runtime hands parentRunId at handler position 4),
      // and every step hangs under its chain, which hangs under the run span.
      expect(sequence.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
      expect(lambda.parentSpanContext?.spanId).toBe(
        sequence.spanContext().spanId,
      );
      for (const step of [model, tool, retrieval]) {
        expect(step?.parentSpanContext?.spanId).toBe(
          sequence.spanContext().spanId,
        );
      }
    } finally {
      await recorder.stop();
    }
  });

  test("a real graph's steps project terminal states, not the constant unknown (R3-06)", async () => {
    // The defect R3-06 names: the recorder's `openbot.*` attribute spelling matched
    // nothing the projection reads, so every framework step's terminal state failed
    // closed onto "unknown" no matter how honestly it ended. Under the aligned
    // vocabulary the same real graph must project completed across all three families.
    const recorder = await driveRealGraph();
    try {
      const model = recorder.spans.find(
        (span) => stepFamily(span.name) === "model",
      );
      if (!model) throw new Error("no model span");
      const tool = spanOf(recorder.spans, "tool:search_tool");
      const retrieval = spanOf(recorder.spans, "retrieval");
      for (const step of [model, tool, retrieval]) {
        expect(
          projectedStepState(
            step.name,
            step.attributes as Record<string, unknown>,
          ),
        ).toBe("completed");
      }
    } finally {
      await recorder.stop();
    }
  });

  test("handleChainStart binds the runtime dispatch order, not the d.ts doc order", async () => {
    // @langchain/core's manager re-dispatches handleChainStart as
    // (chain, inputs, runId, parentRunId, tags, metadata, runType, runName, extra)
    // — parentRunId at position 4, runType at 7, runName at 8 (manager.cjs), which is
    // NOT the documented order. Hand-calling in the true runtime order must therefore
    // land the parent link and the run name where the handler keeps them.
    const recorder = recordedSpans();
    const handler = new GovernedCallbackHandler();
    try {
      handler.handleChainStart(
        serialized("outer"),
        { input: true },
        "run-outer",
        undefined, // pos 4: parentRunId — the root chain has none
        [], // pos 5: tags
        {}, // pos 6: metadata
        "chain", // pos 7: runType
        "outer-chain", // pos 8: runName
      );
      handler.handleChainStart(
        serialized("inner"),
        { input: true },
        "run-inner",
        "run-outer", // pos 4: parentRunId — the framework's own parent link
        [],
        {},
        "chain",
        "inner-chain",
      );
      handler.handleChainEnd({}, "run-inner");
      handler.handleChainEnd({}, "run-outer");

      const outer = spanOf(recorder.spans, "chain:outer-chain");
      const inner = spanOf(recorder.spans, "chain:inner-chain");
      // The parent run id rides position 4; bound anywhere else, nesting flattens.
      expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
      // The run name rides position 8; bound anywhere else, the name is the runType.
      expect(outer.attributes).toMatchObject({
        "openbot.step.name": "outer-chain",
      });
    } finally {
      await recorder.stop();
    }
  });
});

describe("the deployment tool wrapper", () => {
  test("the call's result passes through and its span records the outcome", async () => {
    const recorder = recordedSpans();
    try {
      const answer = await traceDeploymentToolCall(
        "web_search",
        "call_1",
        async () => "found it",
      );
      expect(answer).toBe("found it");

      const tool = spanOf(recorder.spans, "tool:web_search");
      expect(tool.attributes).toMatchObject({
        "openbot.step.kind": "tool",
        "openbot.tool.call_id": "call_1",
        span_state: "completed",
        execution_state: "executed",
      });
    } finally {
      await recorder.stop();
    }
  });

  test("a thrown failure marks the span failed and still propagates", async () => {
    const recorder = recordedSpans();
    try {
      await expect(
        traceDeploymentToolCall("web_search", "call_1", async () => {
          throw new Error(`unreachable ${CANARIES[0]}`);
        }),
      ).rejects.toThrow();
      expect(
        spanOf(recorder.spans, "tool:web_search").attributes,
      ).toMatchObject({
        span_state: "failed",
        ending_kind: "failed",
        // The Error's shape (its `name`), never its message or value.
        ending_code: "Error",
        execution_state: "executed",
      });
      assertNoCanaries(recorder.spans);
    } finally {
      await recorder.stop();
    }
  });
});

describe("the run verdict the run span ends on", () => {
  const RUN = { runId: "run_1", threadId: "thread_1" };

  test("a clean run answers completed and a throwing one failed", async () => {
    const sent: BaseEvent[] = [];
    const clean = await streamRun(
      async function* () {},
      RUN,
      (event) => sent.push(event),
    );
    expect(clean).toBe("completed");

    const broken = await streamRun(
      async () => {
        throw new Error("the graph broke");
      },
      RUN,
      (event) => sent.push(event),
    );
    expect(broken).toBe("failed");
    // The wire still gets its protocol ending; the verdict is for the span, not the surface.
    expect(sent.at(-1)?.type).toBe("RUN_ERROR");
  });
});

describe("no ungoverned auto-upload path (Issue #22 acceptance 1)", () => {
  test("the Opik SDK is not a dependency, so its auto-capture cannot engage", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    expect(names.filter((name) => /opik/i.test(name))).toEqual([]);
  });
});
