// F5E1-F1 (medium; FREV R2 §5) — the observation bypass must not ride the billing seam.
//
// The finding: with OPIK enabled and billing off — a legal stock deployment — every
// successful business run produced ZERO observation facts: no binding, no span, and no
// failure count to say so. The only exit for a model-span fact was `meteredModel`, and
// `withUsageMeter` handed the model back untouched when neither a meter nor a gate was
// wired, so the observer index.ts registers was never called at all.
//
// These cases pin the decoupling from both sides:
//
//   a. no billing, observation enabled: an ordinary run still records its governed span
//      (scope + run chain + binding gate; bodies withheld until F5A1's approval exists);
//   b. billing wired: the metered path behaves exactly as before;
//   c. observation disabled: the deployment's own model instance, untouched;
//   d. an observation-only wrapper never gates, meters, or decides a run's outcome;
//   e. a run shape that still cannot be observed is COUNTED and warned, never silent.

import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BaseEvent } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { context, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { PlanModel } from "../src/agents/plan-model";
import { observerRunBindingGateForTests } from "../src/ai-observability/bindings";
import type { OpikObservationWrite } from "../src/ai-observability/health";
import { createModelSpanRecorder } from "../src/ai-observability/model-span";
import type { OpikOtlpSpan, OpikPort } from "../src/ai-observability/opik-port";
import {
  canonicalRemoteEndpoint,
  createRemoteBudgetContractResolver,
  createRemoteRunBudgetGate,
  remoteBudgetCaps,
} from "../src/ai-observability/remote-run";
import {
  type ObservationScope,
  resolveObservationScope,
} from "../src/ai-observability/scope";
import type { AgentFetch } from "../src/channels/stall-guard";
import {
  type BuiltinModelSpanFact,
  buildAgents,
  builtInAgentConfiguration,
  builtinObservationGapForTests,
  meteredModelForTests,
  REMOTE_BUDGET_RECEIPT_EVENT,
  type RemoteBudgetContractCaps,
  type RemoteRunFact,
  remoteRunBudgetGateTimeoutForTests,
  resolveRuntimeAgents,
  runtimeModelForEnvironment,
  setBuiltinModelSpanObserver,
  setBuiltinToolStepObserver,
  setModelUsageGate,
  setModelUsageMeter,
  setRemoteBudgetContractResolver,
  setRemoteRunBudgetGate,
  setRemoteRunObserver,
  standingRoleMessage,
  UnmeterableModelError,
  withUsageMeterForTests,
} from "../src/copilot";
import { loadTenantPackage } from "../src/tenant-package";
import { testEnvironment } from "./support/environment";

const packagePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "examples",
  "fintech",
);

// A stand-in provider credential, assembled rather than literal (the billing suites'
// convention): referenced everywhere, expected to appear nowhere.
const STUB_MODEL_KEY = `synthetic-${"model-key"}`;

const AGENT_ID = "general-assistant";

/** The run's trusted scope, minted exactly as the boot resolver mints it. */
function aScope(botId = AGENT_ID): ObservationScope {
  return resolveObservationScope({
    actorId: "user-1",
    botId,
    ownership: "owner",
    epoch: 1,
  });
}

/** A queue that accepts everything and remembers what was submitted. */
function recordingQueue() {
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
function recordingPort() {
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

/*
 * The production adapter's projection (index.ts's `setBuiltinModelSpanObserver`): the
 * fact's already-captured scope and W3C chain are handed to the REAL recorder as they
 * were, with the binding gate the assembly builds. Bodies are passed through raw — the
 * recorder is where F5A1's approval decides whether they may project.
 */
async function recordLikeProduction(fact: BuiltinModelSpanFact) {
  const queue = recordingQueue();
  const ensured: string[] = [];
  const bindings = observerRunBindingGateForTests();
  const recorder = createModelSpanRecorder({
    healthService: queue.queue,
    bindings: {
      ensure: (scope, chain) => {
        ensured.push(chain.traceId);
        return bindings.ensure(scope, chain);
      },
    },
  });
  recorder.record({
    occurredAt: fact.startedAt,
    endedAt: fact.endedAt,
    provider: fact.provider,
    modelId: fact.modelId,
    ending: fact.ending,
    input: fact.input,
    output: fact.output,
    scope: fact.scope as ObservationScope | undefined,
    ...(fact.trace
      ? {
          trace: {
            traceId: fact.trace.traceId,
            parentSpanId: fact.trace.spanId,
          },
        }
      : {}),
  });
  const { writes, port } = recordingPort();
  for (const write of queue.submitted) await write.perform(port);
  return { submitted: queue.submitted, writes, ensured };
}

type StockRunOptions = {
  /** Whether the deployment wired the observer (OPIK_ENABLED). */
  observe?: boolean;
  /** Whether the assembly threaded the run scope (production always does). */
  threadScope?: boolean;
};

/**
 * One real built-in run on the stock provider dial: LLMock answers text plus a usage
 * block through the runtime's real stream, exactly as the metering suite drives it.
 *
 * `threadScope` passes the scope threading the boot assembly passes (positional, at the
 * end of `resolveRuntimeAgents`); `threadScope: false` is a run the assembly never
 * threaded, which every observer call must survive untouched.
 */
async function runStockRun(options: StockRunOptions = {}) {
  const observe = options.observe ?? true;
  const threadScope = options.threadScope ?? true;
  const environment = {
    ...testEnvironment(),
    OPENAI_API_KEY: STUB_MODEL_KEY,
  };
  const tenantPackage = await loadTenantPackage(packagePath);
  const model = runtimeModelForEnvironment(tenantPackage.model, environment);
  const mockProvider = new LLMock();
  const originalBase = process.env.OPENAI_BASE_URL;
  const facts: BuiltinModelSpanFact[] = [];
  const scope = aScope();
  // A registered provider installs the ambient context manager the fact's W3C capture
  // reads (the trace-chain suite's footing): without one the run span answers a zero
  // trace, which a recorder rightly refuses to bind.
  const tracerProvider = new NodeTracerProvider();
  tracerProvider.register();
  const tracer = trace.getTracer("copilot-observation-decoupling-test");
  const runSpan = tracer.startSpan("the run");
  try {
    process.env.OPENAI_BASE_URL = await mockProvider.start();
    mockProvider.onMessage(
      /Complete the observation fixture request\./,
      { type: "text", content: "Observation fixture completed." },
      {
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
      },
    );
    if (observe) setBuiltinModelSpanObserver((fact) => facts.push(fact));
    const agents = await resolveRuntimeAgents(
      () => [
        {
          id: AGENT_ID,
          name: "General Assistant",
          type: "built_in" as const,
          systemPrompt: "Be helpful.",
        },
      ],
      model,
      async () => STUB_MODEL_KEY,
      undefined, // stallGuard
      undefined, // loadTools
      undefined, // signRun
      undefined, // computerGuidance
      undefined, // loadVendors
      undefined, // selection
      undefined, // agentFetch
      undefined, // handoff
      undefined, // onlyBotId
      undefined, // loadInstructions
      undefined, // initiator
      undefined, // loadAttachment
      undefined, // markAttachmentsSent
      undefined, // acquireLearnedSkills
      undefined, // loadPersonalMemory
      undefined, // governedModel
      { userId: "user-1" }, // attribution
      threadScope
        ? { actorId: "user-1", resolveScope: async () => scope }
        : undefined,
    );
    const agent = agents[AGENT_ID]?.clone();
    if (!agent) throw new Error("Expected General Assistant.");
    agent.addMessage({
      id: "observation-decoupling-request",
      role: "user",
      content: "Complete the observation fixture request.",
    });
    await context.with(trace.setSpan(context.active(), runSpan), () =>
      agent.runAgent(),
    );
    expect(agent.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Observation fixture completed.",
    });
    return {
      facts,
      scope,
      requests: mockProvider.getRequests(),
      runSpanContext: runSpan.spanContext(),
    };
  } finally {
    runSpan.end();
    if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBase;
    await mockProvider.stop();
    await tracerProvider.shutdown();
    trace.disable();
  }
}

describe("observation without billing (F5E1-F1)", () => {
  test("an ordinary stock run records its governed model span with no billing seam wired", async () => {
    // The advertised stock shape: OPIK enabled, no billing, therefore neither a gate
    // nor a meter exists in this process.
    setModelUsageGate(undefined);
    setModelUsageMeter(undefined);
    setBuiltinModelSpanObserver(undefined);
    try {
      const { facts, scope, runSpanContext } = await runStockRun();

      // RED before the fix: `withUsageMeter` returned the model untouched, so the
      // registered observer was never called and this run left zero facts behind.
      expect(facts).toHaveLength(1);
      const fact = facts[0];
      // The provider's own numbers, read off the finish chunk: "actual and positive" is
      // the contract here (exact counts are the mock's business, as in the metering suite).
      expect(fact.ending.kind).toBe("succeeded");
      const ending = fact.ending as {
        inputTokens: number;
        outputTokens: number;
      };
      expect(ending.inputTokens).toBeGreaterThan(0);
      expect(ending.outputTokens).toBeGreaterThan(0);
      // The runtime's own provider id for the openai chat transport.
      expect(fact.provider).toBe("openai.chat");
      // The run's trusted scope and W3C chain were captured at doStream entry (the
      // OCR R2-58 discipline), so the fact can be bound and exported at all.
      expect(fact.scope).toBe(scope);
      expect(fact.trace?.traceId).toBe(runSpanContext.traceId);
      // Bodies reached the FACT (the recorder is the gate, per F5A1).
      expect(fact.input).toContain("Complete the observation fixture request.");
      expect(fact.output).toContain("Observation fixture completed.");

      // …and the governed chain accepts it: binding established before export, the span
      // joins the run's chain, and NO body / policy attribute projects without an
      // approval the production wiring never mints (F5A1's fail-closed posture).
      const recorded = await recordLikeProduction(fact);
      expect(recorded.submitted).toHaveLength(1);
      expect(recorded.writes).toHaveLength(1);
      expect(recorded.ensured).toEqual([runSpanContext.traceId]);
      const span = recorded.writes[0].spans[0];
      expect(span.traceId).toBe(runSpanContext.traceId);
      expect(span.parentSpanId).toBe(runSpanContext.spanId);
      // Attribute values are the T05 projection's safe cells, not raw scalars.
      expect(span.attributes?.ending_kind).toEqual({
        state: "projected",
        value: "succeeded",
      });
      expect(span.attributes?.usage_state).toEqual({
        state: "projected",
        value: "actual",
      });
      expect(span.attributes?.tokens_input).toEqual({
        state: "projected",
        value: ending.inputTokens,
      });
      expect(span.attributes?.tokens_output).toEqual({
        state: "projected",
        value: ending.outputTokens,
      });
      // Bodies reach the recorder but do not project: F5A1's approval is what admits
      // free text, and nothing on the production wiring mints one. The omission is
      // visible in-band — an explicit cell, never a silent absence.
      expect(span.attributes?.input).toEqual({
        state: "omitted",
        reason: "unhandled_free_text",
      });
      expect(span.attributes?.output).toEqual({
        state: "omitted",
        reason: "unhandled_free_text",
      });
      expect(span.attributes).not.toHaveProperty("content_policy_ref");
    } finally {
      setBuiltinModelSpanObserver(undefined);
    }
  });

  test("a run the assembly never threaded stays scope-less, and observation takes nothing down", async () => {
    setModelUsageGate(undefined);
    setModelUsageMeter(undefined);
    setBuiltinModelSpanObserver(undefined);
    try {
      const { facts } = await runStockRun({ threadScope: false });
      // The call is observed; without a scope the recorder's own rule makes it a local
      // no-op (never an invented owner), which is the pre-existing honest behaviour.
      expect(facts).toHaveLength(1);
      expect(facts[0].scope).toBeUndefined();
      expect(facts[0].ending).toMatchObject({ kind: "succeeded" });
    } finally {
      setBuiltinModelSpanObserver(undefined);
    }
  });
});

describe("billing wired, observation unchanged (F5E1-F1 (b))", () => {
  test("the gate is admitted once and the call yields exactly one span", async () => {
    const admitted: string[] = [];
    const metered: number[] = [];
    setBuiltinModelSpanObserver(undefined);
    setModelUsageGate(async () => {
      admitted.push("admit");
      return {
        bounds: {
          input: {
            enforced: "counted" as const,
            maximumTokens: 1_000_000n,
            countInputTokens: () => 42,
          },
          output: {
            enforced: "provider_cap" as const,
            maximumTokens: 8_192n,
          },
        },
        finish: async () => {
          admitted.push("finish");
        },
      };
    });
    setModelUsageMeter((usage) => {
      metered.push(usage.inputTokens);
    });
    try {
      const { facts } = await runStockRun();
      expect(facts).toHaveLength(1);
      expect(facts[0].ending.kind).toBe("succeeded");
      const ending = facts[0].ending as {
        inputTokens: number;
        outputTokens: number;
      };
      expect(ending.inputTokens).toBeGreaterThan(0);
      // The billing path is bit-for-bit the one that shipped: one admission, one
      // settlement, one metered fact — the observation is still a bypass, and it reads
      // the settlement's own committed numbers.
      expect(admitted).toEqual(["admit", "finish"]);
      expect(metered).toEqual([ending.inputTokens]);
    } finally {
      setBuiltinModelSpanObserver(undefined);
      setModelUsageGate(undefined);
      setModelUsageMeter(undefined);
    }
  });
});

describe("observation disabled (F5E1-F1 (c))", () => {
  test("with no observer and no billing the model instance is handed over untouched", () => {
    setBuiltinModelSpanObserver(undefined);
    setModelUsageGate(undefined);
    setModelUsageMeter(undefined);
    const instance = {
      modelId: "GLM-5.3",
      doStream: async () => {
        throw new Error("never called");
      },
    };
    // Identity, not shape: a deployment with observation off and no billing gets the
    // very object it built, so nothing about the pre-fix product path moved.
    expect(withUsageMeterForTests(instance)).toBe(instance);
  });

  test("the observer alone is enough to install the wrapper, which is what the fix adds", () => {
    setModelUsageGate(undefined);
    setModelUsageMeter(undefined);
    setBuiltinModelSpanObserver(() => {});
    const instance = {
      modelId: "GLM-5.3",
      doStream: async () => ({ stream: new ReadableStream() }),
    };
    try {
      const wrapped = withUsageMeterForTests(instance);
      expect(wrapped).not.toBe(instance);
      expect((wrapped as { modelId?: string }).modelId).toBe("GLM-5.3");
    } finally {
      setBuiltinModelSpanObserver(undefined);
    }
  });

  test("a run with observation off leaves every seam alone and produces nothing", async () => {
    setModelUsageGate(undefined);
    setModelUsageMeter(undefined);
    setBuiltinModelSpanObserver(undefined);
    try {
      const { facts, requests } = await runStockRun({ observe: false });
      expect(facts).toEqual([]);
      // The product path is untouched: the provider was called once and answered.
      expect(requests).toHaveLength(1);
    } finally {
      setBuiltinModelSpanObserver(undefined);
    }
  });
});

describe("the observation-only wrapper (F5E1-F1 (d))", () => {
  test("never gates, meters, or decides the run's outcome", async () => {
    const gateCalls: string[] = [];
    const meterCalls: number[] = [];
    const facts: BuiltinModelSpanFact[] = [];
    setBuiltinModelSpanObserver((fact) => facts.push(fact));
    // A gate and a meter wired in the same process: the mode is what decides, not the
    // presence of the seams at call time.
    setModelUsageGate(async () => {
      gateCalls.push("admit");
      return {};
    });
    setModelUsageMeter((usage) => {
      meterCalls.push(usage.outputTokens);
    });
    try {
      const wrapped = meteredModelForTests(
        {
          modelId: "GLM-5.3",
          provider: "openai",
          async doStream() {
            return {
              stream: new ReadableStream<Record<string, unknown>>({
                start(controller) {
                  controller.enqueue({ type: "text-delta", delta: "hello" });
                  controller.enqueue({
                    type: "finish",
                    usage: {
                      inputTokens: { total: 7 },
                      outputTokens: { total: 3 },
                    },
                  });
                  controller.close();
                },
              }),
            };
          },
        },
        undefined,
        { observationOnly: true },
      ) as {
        doStream: (params: unknown) => Promise<{
          stream: ReadableStream<Record<string, unknown>>;
        }>;
      };
      const parts: string[] = [];
      for await (const part of (await wrapped.doStream({ prompt: [] }))
        .stream) {
        parts.push(String((part as { type?: string }).type));
      }
      expect(parts).toEqual(["text-delta", "finish"]);
      expect(gateCalls).toEqual([]);
      expect(meterCalls).toEqual([]);
      expect(facts).toHaveLength(1);
      expect(facts[0].ending).toEqual({
        kind: "succeeded",
        inputTokens: 7,
        outputTokens: 3,
      });
    } finally {
      setBuiltinModelSpanObserver(undefined);
      setModelUsageGate(undefined);
      setModelUsageMeter(undefined);
    }
  });

  test("a malformed usage report never errors the stream it is watching", async () => {
    const facts: BuiltinModelSpanFact[] = [];
    setBuiltinModelSpanObserver((fact) => facts.push(fact));
    setModelUsageGate(undefined);
    setModelUsageMeter(undefined);
    try {
      const wrapped = meteredModelForTests(
        {
          modelId: "GLM-5.3",
          async doStream() {
            return {
              stream: new ReadableStream<Record<string, unknown>>({
                start(controller) {
                  controller.enqueue({ type: "text-delta", delta: "hello" });
                  // A negative token count is not a usage fact; the billing path would
                  // fail this settlement. The observation-only wrapper has no settlement
                  // to fail and must still deliver the person's answer.
                  controller.enqueue({
                    type: "finish",
                    usage: {
                      inputTokens: { total: -1 },
                      outputTokens: { total: 3 },
                    },
                  });
                  controller.close();
                },
              }),
            };
          },
        },
        undefined,
        { observationOnly: true },
      ) as {
        doStream: (params: unknown) => Promise<{
          stream: ReadableStream<Record<string, unknown>>;
        }>;
      };
      const parts: string[] = [];
      for await (const part of (await wrapped.doStream({ prompt: [] }))
        .stream) {
        parts.push(String((part as { type?: string }).type));
      }
      expect(parts).toEqual(["text-delta", "finish"]);
      // Unknown, never a zero-filled number.
      expect(facts).toHaveLength(1);
      expect(facts[0].ending).toEqual({ kind: "usage_missing" });
    } finally {
      setBuiltinModelSpanObserver(undefined);
    }
  });
});

describe("shapes that still cannot be observed are counted, never silent (F5E1-F1 (e))", () => {
  test("a string-form model is passed through AND counted, not refused", async () => {
    setModelUsageGate(undefined);
    setModelUsageMeter(undefined);
    setBuiltinModelSpanObserver(() => {
      // The count is the point; the fact itself is never expected here.
    });
    builtinObservationGapForTests.reset();
    const originalBase = process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    try {
      const configuration = builtInAgentConfiguration(
        {
          id: AGENT_ID,
          name: "General Assistant",
          type: "built_in",
          systemPrompt: "Be helpful.",
        },
        { provider: "anthropic", defaultModel: "claude-sonnet-4-5" },
        STUB_MODEL_KEY,
      ) as { model?: unknown; type?: string };
      // Product continuity: with no billing there is no admission to prove, so the
      // runtime-resolved string form still runs — it just cannot be wrapped, which is
      // what the count says out loud.
      expect(configuration.model).toBe("anthropic/claude-sonnet-4-5");
      expect(configuration.type).toBeUndefined();
      expect(builtinObservationGapForTests.counts().get("string_model")).toBe(
        1,
      );
    } finally {
      setBuiltinModelSpanObserver(undefined);
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
    }
  });

  test("a subscription harness model is counted too, and stays exactly as built", async () => {
    setModelUsageGate(undefined);
    setModelUsageMeter(undefined);
    setBuiltinModelSpanObserver(() => {});
    builtinObservationGapForTests.reset();
    try {
      const planModel = new PlanModel(
        {
          provider: "claude",
          billing: "subscription",
          endpoint: new URL("http://127.0.0.1:9/ag-ui"),
          token: "synthetic-plan-token",
        },
        AGENT_ID,
        { threadId: "observation-decoupling-thread" },
      );
      const configuration = builtInAgentConfiguration(
        {
          id: AGENT_ID,
          name: "General Assistant",
          type: "built_in",
          systemPrompt: "Be helpful.",
        },
        { provider: "anthropic", defaultModel: "claude-sonnet-4-5" },
        STUB_MODEL_KEY,
        [],
        undefined,
        [],
        null,
        planModel,
      ) as { model?: unknown };
      // The wrapper cannot be handed a class instance without dropping its prototype
      // methods (doGenerate), so the plan path stays unwrapped — reported, not hidden.
      expect(configuration.model).toBe(planModel);
      expect(builtinObservationGapForTests.counts().get("plan_model")).toBe(1);
    } finally {
      setBuiltinModelSpanObserver(undefined);
    }
  });

  test("a refused string form under billing is a refusal, not an observation gap", async () => {
    setModelUsageGate(async () => ({}));
    setBuiltinModelSpanObserver(() => {});
    builtinObservationGapForTests.reset();
    const originalBase = process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    try {
      const configuration = builtInAgentConfiguration(
        {
          id: AGENT_ID,
          name: "General Assistant",
          type: "built_in",
          systemPrompt: "Be helpful.",
        },
        { provider: "anthropic", defaultModel: "claude-sonnet-4-5" },
        STUB_MODEL_KEY,
      ) as { type?: string; factory?: () => AsyncGenerator<unknown> };
      expect(configuration.type).toBe("custom");
      await expect(configuration.factory?.().next()).rejects.toBeInstanceOf(
        UnmeterableModelError,
      );
      expect(builtinObservationGapForTests.counts().get("string_model")).toBe(
        undefined,
      );
    } finally {
      setBuiltinModelSpanObserver(undefined);
      setModelUsageGate(undefined);
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
    }
  });
});

// OCR R2 #14 (C3) — the run's own fact array is bounded, not only its tool cells. The cell
// ceiling capped `toolCells` while every protocol fact still landed in `events` unbounded,
// so one hostile or looping endpoint could grow this server's resident memory per run
// without limit. The cap here pins three things at once: the fact array stays at its
// ceiling (never past it), settlement still reads the terminal the endpoint actually sent
// (the outcome is never a casualty of the bound), and the tool cells keep their own,
// independent 128 ceiling while the events ceiling is 256.
describe("remote run facts stay bounded under an event-spamming endpoint (OCR R2 #14)", () => {
  /** The deployment token both ends hold: the endpoint's MAC key and this server's check. */
  const SECRET = `synthetic-${"managed-token"}`;
  /** The policy's approved per-run token ceiling; the caps and the receipt both derive from it. */
  const POLICY_TOKENS = 1_000_000;
  const MAX_MODEL_STEPS = 8;
  const ENDPOINT = "https://cap.test/ag-ui";
  const CAPS = remoteBudgetCaps(
    POLICY_TOKENS,
    MAX_MODEL_STEPS,
  ) as RemoteBudgetContractCaps;
  /** The events ceiling `copilot.ts` holds (REMOTE_EVENTS_CAP); the cells' own is 128. */
  const EVENTS_CAP = 256;
  const CELL_CAP = 128;
  /** Comfortably past both ceilings: enough proposals to fill the cells and the facts. */
  const PROPOSALS = 400;

  /** Let the fire-and-forget settlement and the step emission land before assertions read them. */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

  /** One endpoint receipt, MAC'd the way the budget contract signs it (the dial suite's pin). */
  function receiptEvent(runId: string): BaseEvent {
    const receipt = {
      kind: REMOTE_BUDGET_RECEIPT_EVENT,
      v: 1,
      runId,
      caps: CAPS,
      usage: {
        modelSteps: 1,
        inputTokens: 400,
        outputTokens: 40,
        totalTokens: 440,
      },
      status: "ok" as const,
    };
    const macKey = createHmac("sha256", SECRET)
      .update("openbot-budget-receipt-mac-v1")
      .digest("hex");
    const mac = createHmac("sha256", macKey)
      .update(
        [
          "openbot-budget-receipt",
          "v=1",
          `runId=${runId}`,
          `caps=${CAPS.modelSteps}|${CAPS.inputTokens}|${CAPS.outputTokens}|${CAPS.totalTokens}`,
          "usage=1|400|40|440",
          "status=ok",
        ].join("\n"),
      )
      .digest("hex");
    return {
      type: "CUSTOM",
      name: REMOTE_BUDGET_RECEIPT_EVENT,
      value: { ...receipt, mac },
    } as unknown as BaseEvent;
  }

  /** The budget seams with a recording credit writer (the dial suite's harness shape). */
  function budgetHarness() {
    const marks: { reservationId: string; reason: string }[] = [];
    const creditWriter = {
      async reserveCredits() {
        return { reserved: true as const, reservationId: "reservation-1" };
      },
      async markReservationUnknown(reservationId: string, reason: string) {
        marks.push({ reservationId, reason });
      },
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
        insufficient: () => new Error("credits_exhausted"),
      },
    });
    const resolver = createRemoteBudgetContractResolver({
      endpoints: new Set([canonicalRemoteEndpoint(ENDPOINT) as string]),
      sharedSecret: SECRET,
      maximumTokens: POLICY_TOKENS,
      maxModelSteps: MAX_MODEL_STEPS,
    });
    return { gate, resolver, marks };
  }

  test("facts stop at the ceiling, settle by the endpoint's real terminal, and tool cells keep their own", async () => {
    // THE SCRIPT: a legal run whose endpoint spams business tool proposals far past both
    // ceilings, then reports its receipt and finishes — everything a hostile stream needs
    // to have grown the run's facts without limit before the cap.
    const script: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: "cap-thread",
        runId: "cap-run",
      } as BaseEvent,
    ];
    for (let i = 0; i < PROPOSALS; i++) {
      // START opens the proposal fact (and a cell, under its own ceiling); END only
      // closes the call so the protocol validator lets RUN_FINISHED through — it
      // opens no fact of its own.
      script.push({
        type: EventType.TOOL_CALL_START,
        toolCallId: `spam-${i}`,
        toolCallName: `businessCall${i}`,
      } as unknown as BaseEvent);
      script.push({
        type: EventType.TOOL_CALL_END,
        toolCallId: `spam-${i}`,
      } as unknown as BaseEvent);
    }
    script.push(receiptEvent("cap-run"));
    script.push({
      type: EventType.RUN_FINISHED,
      threadId: "cap-thread",
      runId: "cap-run",
    } as BaseEvent);

    const fetch: AgentFetch = async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of script) {
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

    const facts: RemoteRunFact[] = [];
    const steps: { origin: string }[] = [];
    const { gate, resolver, marks } = budgetHarness();
    const tracerProvider = new NodeTracerProvider();
    tracerProvider.register();

    setRemoteRunObserver((fact) => facts.push(fact));
    setBuiltinToolStepObserver((fact) => {
      if (fact.origin === "remote-agui") steps.push(fact);
    });
    setRemoteRunBudgetGate(gate);
    setRemoteBudgetContractResolver(resolver);
    try {
      const agents = await buildAgents(
        [
          {
            id: "risk",
            name: "Risk",
            type: "remote_ag_ui" as const,
            endpoint: ENDPOINT,
            headers: { "x-openbot-agent-token": SECRET },
            standingMessage: standingRoleMessage({
              id: "risk",
              name: "Risk",
              type: "remote_ag_ui" as const,
              title: "Risk & Compliance",
              roleDescription: "Investigate policies and controls.",
            }),
          },
        ],
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
          actorId: "person-1",
          resolveScope: () =>
            Promise.resolve(
              resolveObservationScope({
                actorId: "person-1",
                botId: "risk",
                ownership: "owner",
                epoch: 1,
              }),
            ),
        },
      );
      const agent = agents.risk;
      if (!agent) throw new Error("buildAgents returned no remote agent");
      agent.threadId = "cap-thread";
      await agent.runAgent({ runId: "cap-run" }, { onEvent: () => {} });
      await flush();
    } finally {
      setRemoteRunObserver(undefined);
      setBuiltinToolStepObserver(undefined);
      setRemoteRunBudgetGate(undefined);
      setRemoteBudgetContractResolver(undefined);
      await tracerProvider.shutdown();
      trace.disable();
    }

    // THE FACT ARRAY IS BOUNDED, exactly at the ceiling and never past it: the protocol
    // facts (first frame, run start) plus 253 proposals fill slots 0..254, and the run's
    // terminal takes the final slot rather than growing past it.
    expect(facts).toHaveLength(1);
    const events = facts[0].events;
    expect(events.length).toBe(EVENTS_CAP);
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("http_first_frame");
    expect(types[1]).toBe("run_started");
    expect(types.filter((type) => type === "tool_proposed")).toHaveLength(
      EVENTS_CAP - 3,
    );
    expect(types[types.length - 1]).toBe("success");

    // SETTLEMENT READ THE TERMINAL, not the truncation: the endpoint finished the run and
    // the hold was marked by that outcome — the fact that the terminal landed past the
    // proposal ceiling changes nothing about what the person is charged against.
    expect(marks).toEqual([
      {
        reservationId: "reservation-1",
        reason: "remote_usage_unreported:succeeded",
      },
    ]);

    // THE TOOL CELLS KEEP THEIR OWN CEILING: 400 proposals still open exactly the 128
    // cells the cell cap allows — the events cap neither lowered nor raised it — and
    // each stayed a proposal the server never executed.
    expect(steps).toHaveLength(CELL_CAP);
  });
});

// OCR final #62 — the budget gate sat in the admission Promise.all bare: the scope
// half of that same Promise.all is raced (resolveObservationScopeBounded, OCR R5-42)
// precisely because an unbounded dependency holds the defer pending forever, but a
// gate that never settles did exactly that — no event, no error, a run pending with
// nothing to release it. The gate now races the same-shaped timeout and a timeout
// FAILS CLOSED: the rejection is the budget refusal's own path (the run errors
// before it dials), on the scope seam's footing.
describe("the remote budget gate is bounded (OCR final #62)", () => {
  /** The deployment token both ends hold; the resolver needs a declared endpoint. */
  const SECRET = `synthetic-${"managed-token"}`;
  const ENDPOINT = "https://gate.test/ag-ui";
  const POLICY_TOKENS = 1_000_000;

  test("a gate that never settles refuses the run within the timeout, fail closed before the dial", async () => {
    // The exact dependency shape the race exists for: a DB-backed hold reservation
    // that hangs forever. The fetch below throws if reached — a refused admission
    // must not dial — so the rejection's message proves which path settled.
    const neverGate = () => new Promise<never>(() => {});
    const resolver = createRemoteBudgetContractResolver({
      endpoints: new Set([canonicalRemoteEndpoint(ENDPOINT) as string]),
      sharedSecret: SECRET,
      maximumTokens: POLICY_TOKENS,
      maxModelSteps: 8,
    });
    const noDial: AgentFetch = async () => {
      throw new Error("no dial may happen after a refused admission");
    };

    setRemoteRunBudgetGate(neverGate);
    setRemoteBudgetContractResolver(resolver);
    remoteRunBudgetGateTimeoutForTests(50);
    try {
      const agents = await buildAgents(
        [
          {
            id: "risk",
            name: "Risk",
            type: "remote_ag_ui" as const,
            endpoint: ENDPOINT,
            headers: { "x-openbot-agent-token": SECRET },
            standingMessage: standingRoleMessage({
              id: "risk",
              name: "Risk",
              type: "remote_ag_ui" as const,
              title: "Risk & Compliance",
              roleDescription: "Investigate policies and controls.",
            }),
          },
        ],
        { provider: "openai", defaultModel: "test" },
        null,
        undefined,
        async () => [],
        undefined,
        undefined,
        undefined,
        undefined,
        noDial,
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
      );
      const agent = agents.risk;
      if (!agent) throw new Error("buildAgents returned no remote agent");
      agent.threadId = "gate-thread";
      const began = Date.now();
      await expect(
        agent.runAgent({ runId: "gate-run" }, { onEvent: () => {} }),
      ).rejects.toThrow("REMOTE_RUN_BUDGET_GATE_TIMEOUT");
      // Settled inside the seam's 50ms window — and by construction inside the
      // default 5s, which is what the bare (un-raced) call never did at all.
      expect(Date.now() - began).toBeLessThan(5_000);
    } finally {
      setRemoteRunBudgetGate(undefined);
      setRemoteBudgetContractResolver(undefined);
      remoteRunBudgetGateTimeoutForTests(5_000);
    }
  });
});
