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
 * retrieval parent-child shape has been VERIFIED observable on a real instance. T37 verified
 * it on 2026-10-16 against the `opik-issue4-validation` stack (Opik 2.2.100): run span → chain
 * → model/tool/retrieval all landed with correct parent-child nesting over the governed OTLP
 * path, with capability markers, honest usage and zero canaries — evidence in
 * `docs/plans/evidence/2026-10-16-issue4/T37/evidence/b1-framework-rows.json` (probe
 * `T37/probe/b-framework.ts`, ALL PASS). The wiring constant below is therefore true and
 * every run span this module stamps claims `detailed`.
 *
 * R2fix-T1 (round-2 triage R2-00/R2-01/R2-11) tightened the path AFTER that verification:
 * span names now follow the server projection's parse convention — `model:`/`tool:` colon
 * prefixes, the bare word `retrieval` — instead of the space join T37's rows recorded, and
 * `handleChainStart` binds the runtime dispatch order (parentRunId at position 4, runType at
 * 7, runName at 8; @langchain/core manager.cjs, not the d.ts doc order). The steps survive
 * the server's stepFamily projection and nest run → chain → step on a REAL @langchain/core
 * graph — pinned RED→GREEN by the regression in `tests/governed-tracing.test.ts`, the
 * in-process basis for the constant's validity going forward. The T37 instance evidence
 * predates the rename (its rows carry the old names; the probe's name assertions are
 * correspondingly stale until a live re-run), while its parent-child shape over the real
 * OTLP path is unaffected by the parameter-order fix that restores exactly that nesting.
 *
 * R3fix-U4 (round-3 triage R3-06/R3-09) aligned the ATTRIBUTE vocabulary with the server's:
 * the state/token/error keys are now the ones the server's own recorders write and its
 * projection actually reads (`span_state`, `execution_state`, `usage_state`, `tokens_input`/
 * `tokens_output`, `ending_kind`/`ending_code`) instead of the `openbot.*` spellings that
 * had zero consumers anywhere — so framework steps' terminal states, usage verdicts and
 * error shapes finally surface in the run timeline. Like the rename above, this re-dates
 * the T37 rows' attribute keys (the parent-child shape claim is untouched); a live re-run
 * of the probe is the coordinator's call.
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
 * instance. T37 verified it on 2026-10-16 (see the module head for the evidence pointer);
 * R2fix-T1's real-graph regression (tests/governed-tracing.test.ts) re-pins the naming and
 * nesting in-process after the round-2 fixes; a future path change must re-verify before
 * flipping this back.
 */
export const FRAMEWORK_STEPS_VERIFIED_ON_REAL_INSTANCE = true;

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

/** The step families this handler opens spans for — the server projection's kinds. */
type StepKind = "model" | "tool" | "retrieval" | "chain";

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
  // Any URL scheme, anywhere in the name (R5-0: the `^` anchor used to let a URL that did
  // not START the name — "call https://user:pass@host/api" — ride through, while every other
  // pattern here is an unanchored substring match). Names are names, not endpoints, and
  // userinfo credentials ride this shape wherever it sits in the string.
  /[a-zA-Z][a-zA-Z0-9+.-]*:\/\//,
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
    // typeof first (R3-09): `Number(null)`/`Number("")`/`Number([])` are 0 and
    // `Number(true)` is 1, so a bare coercion stamped `actual` onto counts nobody
    // reported — the silent zero this function's honesty rule forbids. Only a real
    // number may claim actual; any other type is missing, whatever it coerces to.
    if (typeof input !== "number" || typeof outputTokens !== "number") {
      return undefined;
    }
    return Number.isInteger(input) &&
      input >= 0 &&
      Number.isInteger(outputTokens) &&
      outputTokens >= 0
      ? { state: "actual", inputTokens: input, outputTokens }
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

  /** The framework's run id -> the span this handler opened for it, with its family. */
  private readonly spans = new Map<string, { span: Span; kind: StepKind }>();

  private start(
    kind: StepKind,
    name: string,
    runId: string,
    parentRunId: string | undefined,
    extra: Record<string, string> = {},
  ): Span {
    const parentEntry = parentRunId ? this.spans.get(parentRunId) : undefined;
    const parent = parentEntry?.span ?? trace.getSpan(context.active());
    // The span name is the projection's parse target (server stepFamily): `model:`/
    // `tool:` colon prefixes, and the bare word `retrieval` — the retriever's own
    // name rides `openbot.step.name` below. Any other spelling (e.g. a space join)
    // silently drops the step from the timeline.
    const spanName = kind === "retrieval" ? kind : `${kind}:${name}`;
    const span = trace.getTracer(TRACER_NAME).startSpan(
      spanName,
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
    this.spans.set(runId, { span, kind });
    return span;
  }

  private finish(
    runId: string,
    state: StepState,
    error?: unknown,
    extra: Record<string, string | number> = {},
  ): void {
    const entry = this.spans.get(runId);
    if (!entry) return; // An end for a run this handler never started is nothing to close.
    const { span, kind } = entry;
    if (state === "failed") {
      span.setStatus({ code: SpanStatusCode.ERROR });
      // The error's shape only — its message is free text and can carry anything, including
      // the URL and credentials of the thing that failed — named in the server recorder's
      // ending vocabulary (R3-06): the kind says failed, the code carries the shape token.
      span.setAttributes({
        ending_kind: "failed",
        ending_code: errorNameOf(error),
      });
    }
    // The terminal state rides the key the server projection reads (R3-06) — a row's
    // `span_state` attribute is the only spelling `projectStep` consults; any other
    // spelling is silently dropped and the step renders unknown forever.
    span.setAttribute("span_state", state);
    // A tool step keeps its terminal state only when the projection's execution read
    // key says the execution was observed. The framework's own end/error callbacks are
    // exactly that observation: the tool ran in-process, however it settled.
    if (kind === "tool") span.setAttribute("execution_state", "executed");
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
            // The server recorder's usage keys (R3-06): `usage_state` plus the two
            // token counts — the `openbot.model.*` spellings had zero consumers.
            usage_state: "actual",
            tokens_input: usage.inputTokens,
            tokens_output: usage.outputTokens,
          }
        : { usage_state: "unavailable" },
    );
  }

  handleLLMError(err: unknown, runId: string): void {
    this.finish(runId, "failed", err);
  }

  // Parameter order is the RUNTIME dispatch order, not the d.ts doc order: the
  // framework's callback manager re-dispatches handleChainStart as
  // (chain, inputs, runId, this._parentRunId, tags, metadata, runType, runName,
  // extra) — parentRunId at position 4, runType at 7, runName at 8 (see
  // @langchain/core dist/callbacks/manager.cjs handleChainStart). Bound per the
  // docs instead, the parent link is dropped (every chain span falls back to the
  // ambient) and the name degrades to the runType ("chain chain").
  handleChainStart(
    chain: Serialized,
    _inputs: Record<string, unknown>,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    _runType?: string,
    runName?: string,
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
    .startSpan(`tool:${safeName(name)}`, {
      attributes: {
        "openbot.step.kind": "tool",
        "openbot.step.name": safeName(name),
        ...(toolCallId ? { "openbot.tool.call_id": safeName(toolCallId) } : {}),
        ...omittedContent(),
      },
    });
  try {
    // The tool span is ACTIVE while the call runs, so an outbound dial inside it
    // (the deployment tool calling back through the server, Issue #23/T17)
    // injects this span as the next hop's parent — the chain's tool receipt.
    const result = await context.with(
      trace.setSpan(context.active(), span),
      () => exec(),
    );
    // The wrapper ran the call by hand, so the execution WAS observed by this module —
    // the projection's execution read key, in the server recorder's spelling (R3-06).
    span.setAttribute("execution_state", "executed");
    span.setAttribute("span_state", "completed");
    return result;
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    // The error's shape only, in the server recorder's ending vocabulary (R3-06).
    span.setAttributes({
      ending_kind: "failed",
      ending_code: errorNameOf(error),
    });
    span.setAttribute("execution_state", "executed");
    span.setAttribute("span_state", "failed");
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
      // The projection's terminal read key (R3-06); the run span itself is not a
      // stepFamily row, but the vocabulary it speaks stays the server's.
      span.setAttribute("span_state", state);
      span.end();
    },
  };
}
