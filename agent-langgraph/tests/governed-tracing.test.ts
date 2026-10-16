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

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { BaseEvent } from "@ag-ui/core";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  FRAMEWORK_STEPS_VERIFIED_ON_REAL_INSTANCE,
  GovernedCallbackHandler,
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

      const chain = spanOf(recorder.spans, "chain graph");
      const model = spanOf(recorder.spans, "model gpt-5.5");
      const tool = spanOf(recorder.spans, "tool web_search");
      const retrieval = spanOf(recorder.spans, "retrieval kb");

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
      for (const span of [chain, model, tool, retrieval]) {
        expect(span.attributes).toMatchObject({
          "openbot.span.state": "completed",
        });
      }
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

      const model = spanOf(recorder.spans, "model unnamed");
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

      const model = spanOf(recorder.spans, "model unnamed");
      expect(model.attributes).toMatchObject({
        "openbot.span.state": "failed",
        "openbot.error.name": "Error",
      });
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
      expect(spans[0].attributes).toMatchObject({
        "openbot.model.usage.state": "actual",
        "openbot.model.tokens.input": 3,
        "openbot.model.tokens.output": 5,
      });
      expect(spans[1].attributes).toMatchObject({
        "openbot.model.usage.state": "actual",
        "openbot.model.tokens.input": 7,
        "openbot.model.tokens.output": 11,
      });
      // No report is an explicit unavailable, never a silent 0 (T14's honesty rule).
      expect(spans[2].attributes).toMatchObject({
        "openbot.model.usage.state": "unavailable",
      });
      expect(spans[2].attributes).not.toHaveProperty(
        "openbot.model.tokens.input",
      );
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
      expect(spanOf(recorder.spans, "model unnamed").attributes).toMatchObject({
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
      expect(tool.name).toBe("tool unnamed");
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

      const tool = spanOf(recorder.spans, "tool web_search");
      expect(tool.attributes).toMatchObject({
        "openbot.step.kind": "tool",
        "openbot.tool.call_id": "call_1",
        "openbot.span.state": "completed",
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
        spanOf(recorder.spans, "tool web_search").attributes,
      ).toMatchObject({
        "openbot.span.state": "failed",
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
