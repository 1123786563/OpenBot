/**
 * The framework Bot's governed observability path (Issue #22 / DAG T16).
 *
 * Everything here rides the one OTel path this deployment already runs: `shared/trace.ts`'s
 * process tracer, W3C continuation and OTLP export. The Opik SDK's own LangChain/LangGraph
 * integration — which auto-uploads traces straight to an Opik instance — is deliberately NOT a
 * dependency of this module, so its auto-capture cannot engage; any future Opik SDK use must
 * enter through this governed path and pin the server's SDK version (`docker/opik/versions.json`,
 * sdk.typescript 2.2.100 at the time of writing).
 *
 * Content honesty: the deployment's projection engine (redaction v5) lives in `server/`, which
 * this module's image does not contain, so this layer records structural facts only — names,
 * kinds, states, token counts — and marks content `omitted/unhandled_free_text` in that policy's
 * vocabulary. Free text is never written into a span here, which is the strictest outcome the
 * policy allows an unasserted recorder.
 *
 * Capability honesty (the issue's second acceptance): `detailed` claims that a model/tool/
 * retrieval parent-child shape has been VERIFIED observable on a real instance. That
 * verification is T37's; until it lands the wiring constant below stays false and every run
 * span this module stamps says `basic`.
 */

import type { RunAgentInput } from "@ag-ui/core";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { DocumentInterface } from "@langchain/core/documents";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { REDACTION_POLICY_VERSION } from "../../shared/ai-observability";

/**
 * Whether the model/tool/retrieval parent-child shape has been verified on a real Opik
 * instance. T37 owns flipping this; until then no span this module emits may claim detailed.
 */
export const FRAMEWORK_STEPS_VERIFIED_ON_REAL_INSTANCE = false;

export type FrameworkCapability = "detailed" | "basic" | "unavailable";

/** What this path actually observed. Same shape the server's verdict reads (T10). */
export type FrameworkCapabilityEvidence = Readonly<{
  /** Runtime-internal model/tool/retrieval steps are verified observable on this path. */
  internalStepsVerified: boolean;
  /** This path actually observed run or AG-UI events. */
  observedEvents: boolean;
}>;

/**
 * The capability verdict, mirroring the server's `resolveRunCapability` rule so the two
 * paths cannot disagree: verified internal instrumentation claims `detailed`, observed
 * run events alone are `basic`, and nothing observed is `unavailable`. Never the reverse —
 * an unobserved internal step is not evidence it did not happen.
 */
export function resolveFrameworkCapability(
  evidence: FrameworkCapabilityEvidence,
): FrameworkCapability {
  if (evidence.internalStepsVerified) return "detailed";
  if (evidence.observedEvents) return "basic";
  return "unavailable";
}

/**
 * The tracer name every span here rides. Resolved per span rather than held at module scope:
 * the API's proxy tracer caches the provider it first bound to, and a held reference would keep
 * answering from a provider a test already shut down. `shared/trace.ts`'s own wrappers resolve
 * at call time for the same reason.
 */
const TRACER_NAME = "openbot.agent-langgraph";

/** The state an ended span claims. Only outcomes the framework actually reported. */
type StepState = "completed" | "failed";

/**
 * Structural deny patterns for names and ids — the credential classes that also survive a
 * charset allowlist. This is a denylist for STRUCTURAL fields only; free text is omitted
 * wholesale further down, so this list is small on purpose and does not pretend to be the
 * server's projection.
 */
const STRUCTURAL_DENY: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
  /\bsk-(?:live|test|proj)-[A-Za-z0-9._-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  // Any URL scheme: names are names, not endpoints, and userinfo credentials ride this shape.
  /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//,
];

/**
 * A name or id safe to put in a span: a short, boring token. Anything else — too long, an
 * unexpected character, a credential shape — collapses to `unnamed`, because a span name or
 * reference field that carries a secret leaks it into every exporter verbatim.
 */
function safeName(value: unknown): string {
  if (typeof value !== "string") return "unnamed";
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return "unnamed";
  if (!/^[\w.:@/ -]+$/.test(trimmed)) return "unnamed";
  if (STRUCTURAL_DENY.some((pattern) => pattern.test(trimmed)))
    return "unnamed";
  return trimmed;
}

/**
 * The error's shape only, never its message or value: an Error contributes its `name`; any
 * other thrown value — string, number, object — is free text of unknown provenance that the
 * name allowlist cannot judge, so it contributes a fixed marker instead and the thrown value
 * itself can never ride the error channel into exported bytes.
 */
function errorNameOf(error: unknown): string {
  if (error instanceof Error) return safeName(error.name);
  return "NonErrorThrow";
}

/** The omission markers every span here carries, in the projection policy's vocabulary. */
function omittedContent(): Record<string, string> {
  return {
    "openbot.content.state": "omitted",
    "openbot.content.reason": "unhandled_free_text",
    "openbot.content.policy": REDACTION_POLICY_VERSION,
  };
}

/** The model id, from whichever pocket the framework put it in. */
function modelIdOf(
  extraParams: Record<string, unknown> | undefined,
  runName: string | undefined,
): string {
  const params = extraParams?.invocation_params as
    | Record<string, unknown>
    | undefined;
  return safeName(params?.model ?? runName ?? "unnamed");
}

/**
 * The usage verdict, with T14's honesty rule: actual only when both token counts were
 * reported by the framework; anything else — absent, half-reported, or not a number — is an
 * explicit `unavailable`, never a silent 0, and no token attribute is written at all.
 */
function usageOf(
  output: LLMResult,
):
  | { state: "actual"; inputTokens: number; outputTokens: number }
  | { state: "unavailable" } {
  const llmOutput = output?.llmOutput as Record<string, unknown> | undefined;
  const whole = (
    input: unknown,
    outputTokens: unknown,
  ):
    | { state: "actual"; inputTokens: number; outputTokens: number }
    | undefined => {
    const inTokens = Number(input);
    const outTokens = Number(outputTokens);
    return Number.isInteger(inTokens) &&
      inTokens >= 0 &&
      Number.isInteger(outTokens) &&
      outTokens >= 0
      ? { state: "actual", inputTokens: inTokens, outputTokens: outTokens }
      : undefined;
  };
  // Anthropic's llmOutput.usage, OpenAI's llmOutput.tokenUsage, LangChain's standard
  // usage_metadata on the returned message — the three shapes this module's providers emit.
  const candidates = [
    whole(
      (llmOutput?.usage as Record<string, unknown> | undefined)?.input_tokens,
      (llmOutput?.usage as Record<string, unknown> | undefined)?.output_tokens,
    ),
    whole(
      (llmOutput?.tokenUsage as Record<string, unknown> | undefined)
        ?.promptTokens,
      (llmOutput?.tokenUsage as Record<string, unknown> | undefined)
        ?.completionTokens,
    ),
    whole(
      (
        output?.generations?.[0]?.[0] as
          | { message?: { usage_metadata?: Record<string, unknown> } }
          | undefined
      )?.message?.usage_metadata?.input_tokens,
      (
        output?.generations?.[0]?.[0] as
          | { message?: { usage_metadata?: Record<string, unknown> } }
          | undefined
      )?.message?.usage_metadata?.output_tokens,
    ),
  ];
  return (
    candidates.find(
      (
        candidate,
      ): candidate is {
        state: "actual";
        inputTokens: number;
        outputTokens: number;
      } => candidate !== undefined,
    ) ?? { state: "unavailable" }
  );
}

/**
 * The framework callback handler that turns LangChain's run lifecycle into the governed span
 * tree. The parent-child relationship is maintained HERE, from the framework's own run ids:
 * each started run opens a span parented on its `parentRunId`'s span (or the ambient span —
 * the AG-UI request's — when the framework names no parent), and each ended run closes it.
 * One handler per run, so the map never outlives the run that built it.
 */
export class GovernedCallbackHandler extends BaseCallbackHandler {
  /** Names the handler in the framework's own callback dispatch. */
  name = "openbot_governed_callbacks";

  /** The framework's run id -> the span this handler opened for it. */
  private readonly spans = new Map<string, Span>();

  private start(
    kind: "model" | "tool" | "retrieval" | "chain",
    name: string,
    runId: string,
    parentRunId: string | undefined,
    extra: Record<string, string> = {},
  ): Span {
    const parent =
      (parentRunId ? this.spans.get(parentRunId) : undefined) ??
      trace.getSpan(context.active());
    const span = trace.getTracer(TRACER_NAME).startSpan(
      `${kind} ${name}`,
      {
        attributes: {
          "openbot.step.kind": kind,
          "openbot.step.name": name,
          ...omittedContent(),
          ...extra,
        },
      },
      parent ? trace.setSpan(context.active(), parent) : undefined,
    );
    this.spans.set(runId, span);
    return span;
  }

  private finish(
    runId: string,
    state: StepState,
    error?: unknown,
    extra: Record<string, string | number> = {},
  ): void {
    const span = this.spans.get(runId);
    if (!span) return; // An end for a run this handler never started is nothing to close.
    if (state === "failed") {
      span.setStatus({ code: SpanStatusCode.ERROR });
      // The error's shape only: its message is free text and can carry anything, including
      // the URL and credentials of the thing that failed.
      span.setAttribute("openbot.error.name", errorNameOf(error));
    }
    span.setAttribute("openbot.span.state", state);
    span.setAttributes(extra);
    span.end();
    this.spans.delete(runId);
  }

  handleChatModelStart(
    _llm: Serialized,
    _messages: unknown[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    // Chat models report through here; the prompts in `messages` are free text and stay out.
    this.start("model", modelIdOf(extraParams, runName), runId, parentRunId);
  }

  handleLLMStart(
    _llm: Serialized,
    _prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    this.start("model", modelIdOf(extraParams, runName), runId, parentRunId);
  }

  handleLLMEnd(output: LLMResult, runId: string): void {
    const usage = usageOf(output);
    this.finish(
      runId,
      "completed",
      undefined,
      usage.state === "actual"
        ? {
            "openbot.model.usage.state": "actual",
            "openbot.model.tokens.input": usage.inputTokens,
            "openbot.model.tokens.output": usage.outputTokens,
          }
        : { "openbot.model.usage.state": "unavailable" },
    );
  }

  handleLLMError(err: unknown, runId: string): void {
    this.finish(runId, "failed", err);
  }

  handleChainStart(
    chain: Serialized,
    _inputs: Record<string, unknown>,
    runId: string,
    _runType?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
    parentRunId?: string,
  ): void {
    this.start(
      "chain",
      safeName(runName ?? chain.id?.at(-1)),
      runId,
      parentRunId,
    );
  }

  handleChainEnd(_outputs: Record<string, unknown>, runId: string): void {
    this.finish(runId, "completed");
  }

  handleChainError(err: unknown, runId: string): void {
    this.finish(runId, "failed", err);
  }

  handleToolStart(
    tool: Serialized,
    _input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
    toolCallId?: string,
  ): void {
    this.start(
      "tool",
      safeName(runName ?? tool.id?.at(-1)),
      runId,
      parentRunId,
      {
        ...(toolCallId ? { "openbot.tool.call_id": safeName(toolCallId) } : {}),
      },
    );
  }

  handleToolEnd(_output: unknown, runId: string): void {
    this.finish(runId, "completed");
  }

  handleToolError(err: unknown, runId: string): void {
    this.finish(runId, "failed", err);
  }

  handleRetrieverStart(
    retriever: Serialized,
    _query: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    name?: string,
  ): void {
    this.start(
      "retrieval",
      safeName(name ?? retriever.id?.at(-1)),
      runId,
      parentRunId,
    );
  }

  handleRetrieverEnd(_documents: DocumentInterface[], runId: string): void {
    this.finish(runId, "completed");
  }

  handleRetrieverError(err: unknown, runId: string): void {
    this.finish(runId, "failed", err);
  }
}

/**
 * One deployment-tool call, as a span. The tools node runs its calls by hand — the framework
 * never sees them, so no framework callback fires — which makes this the tool half of the
 * parent-child shape: the span opens under the ambient (run) span, records the call's name,
 * call id and outcome, and omits the arguments and result like every other content field.
 * The wrapped call's behaviour — return value or thrown error — passes through untouched.
 */
export async function traceDeploymentToolCall<T>(
  name: string,
  toolCallId: string | undefined,
  exec: () => Promise<T>,
): Promise<T> {
  const span = trace
    .getTracer(TRACER_NAME)
    .startSpan(`tool ${safeName(name)}`, {
      attributes: {
        "openbot.step.kind": "tool",
        "openbot.step.name": safeName(name),
        ...(toolCallId ? { "openbot.tool.call_id": safeName(toolCallId) } : {}),
        ...omittedContent(),
      },
    });
  try {
    const result = await exec();
    span.setAttribute("openbot.span.state", "completed");
    return result;
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute("openbot.error.name", errorNameOf(error));
    span.setAttribute("openbot.span.state", "failed");
    throw error;
  } finally {
    span.end();
  }
}

/**
 * One AG-UI run's span — the root the framework's model, tool and retrieval spans hang from.
 *
 * Not the HTTP span `withTraceFetch` opens: that one ends the moment the fetch handler returns
 * its streaming Response, while the run — and every model call inside it — is still executing.
 * The framework callbacks' ambient parent is this span, and it ends on the run's actual outcome,
 * `streamRun`'s verdict, never on the first byte leaving.
 *
 * The capability attribute is the issue's honesty rule made visible: what this path may claim
 * today, computed from the same evidence the verdict reads, stamped where anyone reading the
 * trace can see why it says basic and not detailed.
 */
export function governedRunSpan(
  input: Pick<RunAgentInput, "runId" | "threadId">,
): { span: Span; finish: (state: "completed" | "failed") => void } {
  const span = trace.getTracer(TRACER_NAME).startSpan("ag-ui run", {
    attributes: {
      "openbot.step.kind": "run",
      "openbot.run.id": safeName(input.runId),
      "openbot.run.thread_id": safeName(input.threadId),
      "openbot.run.capability": resolveFrameworkCapability({
        internalStepsVerified: FRAMEWORK_STEPS_VERIFIED_ON_REAL_INSTANCE,
        observedEvents: true,
      }),
      ...omittedContent(),
    },
  });
  return {
    span,
    finish: (state) => {
      if (state === "failed") span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute("openbot.span.state", state);
      span.end();
    },
  };
}
