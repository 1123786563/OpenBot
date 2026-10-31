/*
 * ME02 (#474) T2: one execution instance per call/subscription.
 *
 * Builds the Mastra Agent per request — never cached across runs, so two
 * users on one logical Bot share no instructions, tools, model wiring or
 * history. The ONLY model is the injected governed collaborator; Memory is
 * deliberately absent (ME01 evidence: attaching Memory triggers hidden model
 * calls outside any budget), and retry/fallback are off on the model path
 * (`modelSettings.maxRetries: 0`) because a retry would mint a fresh
 * capability against the same run ceiling and a 402 is terminal by contract.
 * There is no auto title/summary/embedding anywhere on this path.
 */

import type { BaseEvent, Message, RunErrorEvent } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { defer, from, type Observable } from "rxjs";
import { continuationOperationId } from "./continuation-store";
import type { ExecutionRequest } from "./execution-contracts";
import { createFrontendBridgeTools } from "./frontend-tools";
import { buildInstructions } from "./instructions";
import { MastraStreamNormalizer } from "./stream-events";
import {
  argsDigestFor,
  createMastraLearnedTools,
  createMastraTools,
} from "./tools";

/**
 * The model tool-loop cap: the SAME 8 the legacy built-in path has run since
 * it gained tools (`TOOL_STEPS` in copilot.ts). A loop cut at the cap is a
 * real outcome — stream-events ends it with a truthful non-success terminal,
 * never a fabricated complete answer. Exported for the resume driver, which
 * rebuilds the loop with the SAME cap.
 */
export const TOOL_LOOP_MAX_STEPS = 8;

/** An execution refused before the model ran. */
export class MastraExecutionRefusal extends Error {}

interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/**
 * The relayed input becomes the model history.
 *
 * ME03: user/assistant text passes through, and the trusted role comes
 * exclusively from the server-composed instructions — client-supplied system
 * messages are ignored (the client can never override the trusted role), and
 * client-supplied tool history is not reconstructed here. Attachment file
 * parts degrade to text references (authorized attachments must be runnable;
 * bytes inline in a later slice); anything else beyond plain text is refused
 * rather than silently dropped.
 */
function toModelMessages(messages: readonly Message[]): ModelMessage[] {
  const converted: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      // Client-supplied system/tool history is ignored (the trusted role is
      // server-composed), and any other role the wire protocol may grow is
      // refused rather than silently mapped into the model history.
      if (message.role === "system" || message.role === "tool") continue;
      throw new MastraExecutionRefusal(
        "ME03_MESSAGE_PARTS_UNSUPPORTED: this execution slice carries plain user/assistant text only.",
      );
    }
    const text = textContent(message);
    if (text === null) {
      throw new MastraExecutionRefusal(
        "ME03_MESSAGE_PARTS_UNSUPPORTED: this execution slice carries plain text only.",
      );
    }
    if (text.length === 0) continue;
    converted.push({ role: message.role, content: text });
  }
  if (converted.length === 0) {
    // A history where nothing survived the relay (system/tool-only input, or
    // every message empty) refuses instead of streaming an empty model
    // history — the engine's behavior there is undefined, and this module
    // refuses rather than guesses.
    throw new MastraExecutionRefusal(
      "ME03_MESSAGE_PARTS_UNSUPPORTED: no user/assistant text survived relay; refusing an empty model history.",
    );
  }
  return converted;
}

function textContent(message: Message): string | null {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    const parts: string[] = [];
    for (const part of message.content as {
      type?: unknown;
      text?: unknown;
      source?: unknown;
    }[]) {
      if (part?.type === "text" && typeof part.text === "string") {
        parts.push(part.text);
        continue;
      }
      if (part?.type === "file") {
        // An authorized attachment degrades to a text reference — the same
        // geometry as the runtime's unauthorized-attachment degrade — so an
        // AUTHORIZED state is runnable (the revoked state already was, which
        // had the safety semantics inverted). Inlining the bytes is a later
        // slice's work.
        parts.push(`[attachment: ${attachmentReferenceOf(part)}]`);
        continue;
      }
      return null;
    }
    return parts.join("");
  }
  return null;
}

/** The attachment URL a file part's source carries, when it carries one. */
function attachmentReferenceOf(part: { source?: unknown }): string {
  const source =
    part && typeof part === "object"
      ? (part as { source?: { value?: unknown } }).source
      : undefined;
  const value =
    source && typeof source === "object"
      ? (source as { value?: unknown }).value
      : undefined;
  return typeof value === "string" ? value : "unresolved";
}

/** A granted tool, wrapped so execution stays inside the granted executor. */
const MASTRA_BOOKKEEPING_KEYS = ["mastra"];

/**
 * Only plain JSON-shaped objects are copied. Class instances (the abort
 * signal, streams, headers) are passed through by reference: an AbortSignal
 * copied key-by-key would come out a bare `{}` and the provider dial would
 * lose its only stop wire.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Strip the Mastra loop's own request bookkeeping (`providerOptions`, e.g.
 * `{ mastra: { createdAt } }` on prompt messages and parts) before the call
 * reaches the governed gateway adapter, whose wire contract fail-closes on
 * any provider options.
 *
 * Deliberately narrow: only metadata whose keys are entirely the framework's
 * own is removed. Anything else is left in place, so an unexpected
 * providerOptions payload still fails closed inside the adapter instead of
 * being laundered through here. Nothing is ever ADDED to the call.
 */
function stripMastraRequestBookkeeping<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      stripMastraRequestBookkeeping(entry),
    ) as unknown as T;
  }
  if (isPlainObject(value)) {
    const record = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if (
        key === "providerOptions" &&
        child &&
        typeof child === "object" &&
        !Array.isArray(child) &&
        Object.keys(child as Record<string, unknown>).every((name) =>
          MASTRA_BOOKKEEPING_KEYS.includes(name),
        )
      ) {
        continue;
      }
      cleaned[key] = stripMastraRequestBookkeeping(child);
    }
    return cleaned as unknown as T;
  }
  return value;
}

/**
 * The model the Mastra loop dials: the governed collaborator's model, seen
 * through the bookkeeping strip above. A full-forward Proxy — same shape as
 * the ME01 probe wrapper — so every surface the model actually implements
 * (doGenerate included) passes through untouched; only `doStream` is
 * intercepted to strip the loop's own request bookkeeping. This wrapper
 * delegates every call and adds no dial of its own. Exported for the resume
 * driver, which rebuilds the SAME loop shape (the resumed step must strip the
 * engine's own bookkeeping exactly as the original run did).
 */
export function mastraLoopModel(inner: unknown): unknown {
  const source = inner as Record<string | symbol, unknown>;
  return new Proxy(source, {
    get(target, property, receiver) {
      if (property === "doStream") {
        return (options: unknown) =>
          (target.doStream as (options: unknown) => unknown)(
            stripMastraRequestBookkeeping(options),
          );
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/**
 * The typed RUN_ERROR frame for a continuation save failure (the re-review
 * leftover: built as the concrete AG-UI event, the way stream-events.ts
 * constructs its terminals — never an `as unknown as` cast).
 */
function saveFailedRunError(detail: string): RunErrorEvent {
  return {
    type: EventType.RUN_ERROR,
    message: `MASTRA_CONTINUATION_SAVE_FAILED: ${detail}; the run failed instead of publishing a waiting state nothing could resume.`,
  };
}

/**
 * ME06: the suspension KIND a pending call saves as — `frontend_tool` when
 * the suspended name is one of this run's client-declared participation
 * tools, `approval` for everything else (the ME05 semantics, untouched).
 */
function suspensionKindOf(
  toolName: string,
  frontendTools: readonly { readonly name: string }[] | undefined,
): "approval" | "frontend_tool" {
  return (frontendTools ?? []).some(
    (definition) => definition.name === toolName,
  )
    ? "frontend_tool"
    : "approval";
}

function buildAgent(request: ExecutionRequest): {
  agent: Agent;
  durable: Mastra | undefined;
} {
  // ME04: granted tools wrap through the controlled wrapper — per-call
  // instances, guard wired to THIS run's abort signal, mount-time refusals
  // for reserved/colliding names. Every execute still flows through the
  // granted grant→policy→credential→audit path. The optional operation
  // observer rides the same guard (R3-3: the real-engine identity probe).
  const tools = createMastraTools(request.tools, {
    signal: request.signal,
    // ME05: the durable approval pause, mounted at tool construction — the
    // engine's authoritative per-tool approval option. Opt-in stays per
    // server-assembled name list, never per client field; the pause point is
    // the engine's durable toolCallStep, before the granted execute can run.
    ...(request.continuations?.durableToolNames?.length
      ? { requireApprovalFor: request.continuations.durableToolNames }
      : {}),
    // ME09: the unattended surface's live-lease probe (absent on the browser
    // path — the transport owns that stop wire).
    ...(request.leaseCurrent ? { leaseCurrent: request.leaseCurrent } : {}),
    // ME10 (F4): the unattended run's approval binding (absent on the
    // browser path) — approval asks park the engine durably against THIS run.
    ...(request.approvalBinding
      ? { approvalBinding: request.approvalBinding }
      : {}),
    ...(request.onToolOperation
      ? { onOperation: request.onToolOperation }
      : {}),
  });
  // ME08: the outer run's validated learned-skill invocation mounts through
  // the SAME controlled wrapper shape — original reserved names, the same
  // stop-wire guard and operation identity, execute via the invocation's
  // own (SDK-owned) read. A grant can never have taken either name
  // (createMastraTools refuses reserved names), and the learned wrapper
  // refuses anything outside the reserved pair.
  const learned =
    request.learnedSkills && request.learnedSkills.tools.length > 0
      ? createMastraLearnedTools(request.learnedSkills, {
          signal: request.signal,
          grantedNames: Object.keys(tools),
          ...(request.onToolOperation
            ? { onOperation: request.onToolOperation }
            : {}),
        })
      : {};
  // ME06: the client-declared participation tools mount as inert bridges —
  // a call suspends the engine for real client participation; the server
  // never executes them. Granted names win a collision (a bridge can never
  // shadow a server-executed tool).
  const bridges = createFrontendBridgeTools(request.frontendTools ?? [], {
    grantedNames: Object.keys(tools),
  });
  const agent = new Agent({
    id: `openbot-${request.binding.botId}`,
    name: request.binding.botId,
    instructions: buildInstructions(
      request.instructions,
      request.trailingInstructions,
      // ME07: the rendered personal-memory block composes after the tail —
      // the legacy injection position (head of the message list) — and is
      // already worded by the #395 renderer, never re-authored here.
      request.personalMemoryContext,
    ),
    model: mastraLoopModel(request.governedModel.model) as never,
    ...(Object.keys(tools).length > 0 ||
    Object.keys(learned).length > 0 ||
    Object.keys(bridges).length > 0
      ? { tools: { ...tools, ...learned, ...bridges } }
      : {}),
  });
  // ME05: with tenant-restricted engine storage wired, the engine's
  // suspension snapshot persists (the ME01-proven durable surface). Without
  // it the suspension stays in-process — exactly the pre-ME05 behavior.
  if (!request.continuations?.storage) return { agent, durable: undefined };
  const durable = new Mastra({
    agents: { [`openbot-${request.binding.botId}`]: agent },
    storage: request.continuations.storage as never,
  });
  return { agent, durable };
}

async function* runAndNormalize(
  request: ExecutionRequest,
): AsyncGenerator<BaseEvent> {
  request.signal.throwIfAborted();
  // buildAgent registered the durable stack (when wired): the Mastra instance
  // owns the storage the suspension snapshot persists into (ME01 surface).
  // `durable` is held for the WHOLE stream (dropped only after this generator
  // returns) — the ME01-proven assembly keeps the instance alive in its stack,
  // and the snapshot registration rides the instance's storage wiring, so the
  // reference must outlive every suspension save below, never be collected
  // mid-stream (OCR fix wave 3, R3-9).
  const { agent, durable } = buildAgent(request);
  const output = await agent.stream(
    toModelMessages(request.input.messages) as never,
    {
      runId: request.binding.executionKey,
      abortSignal: request.signal,
      modelSettings: {
        // The admitted run ceiling, set by the server. The gateway adapter
        // narrows every step's request to what remains of it.
        maxOutputTokens: request.governedModel.maxOutputTokens,
        // A retry mints a fresh capability against the same run ceiling, and a
        // 402 budget refusal is terminal by contract: no SDK retry loop.
        maxRetries: 0,
      },
      // The existing tool-loop cap (legacy TOOL_STEPS = 8). A cut here is a
      // truthful terminal, never a fabricated completion.
      maxSteps: TOOL_LOOP_MAX_STEPS,
    },
  );
  // Streaming: events are consumed as produced; the normalizer must not
  // retain the whole run's event list until the end (see MastraStreamNormalizer).
  const normalizer = new MastraStreamNormalizer(
    {
      // Identity comes from the server-minted binding thread (verified by
      // loadExecutionInput and used by persistence); the relayed input
      // .threadId is only a fallback for ME02-era bindings — no gate ties it
      // to the binding, so it must never outrank the server-issued value in
      // the events clients see.
      threadId: request.binding.threadId ?? request.input.threadId,
      runId: request.binding.runId,
    },
    { streaming: true },
  );
  // ME05: what the stream announced, so a durable suspension names the exact
  // pending call — the same call frames clients saw, digested server-side.
  const announced = new Map<string, { toolName: string; argsText: string }>();
  const resultsSeen = new Set<string>();
  const observe = (event: BaseEvent): void => {
    const shape = event as unknown as Record<string, unknown>;
    if (shape.type === "TOOL_CALL_START") {
      if (
        typeof shape.toolCallId === "string" &&
        typeof shape.toolCallName === "string"
      ) {
        announced.set(shape.toolCallId, {
          toolName: shape.toolCallName,
          argsText: "",
        });
      }
      return;
    }
    if (shape.type === "TOOL_CALL_ARGS") {
      if (
        typeof shape.toolCallId === "string" &&
        typeof shape.delta === "string"
      ) {
        const call = announced.get(shape.toolCallId);
        if (call) call.argsText += shape.delta;
      }
      return;
    }
    if (shape.type === "TOOL_CALL_RESULT") {
      if (typeof shape.toolCallId === "string")
        resultsSeen.add(shape.toolCallId);
    }
  };
  const reader = output.fullStream.getReader();
  const emit = function* (events: readonly BaseEvent[]): Generator<BaseEvent> {
    for (const event of events) {
      observe(event);
      yield event;
    }
  };
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      yield* emit(normalizer.push(next.value));
    }
    yield* emit(normalizer.end());
    // ME05 lifecycle: a durable approval pause ends the stream terminal-less,
    // and the continuation MUST exist before that end can be read as a
    // waiting state downstream. Save first; a save failure converts the
    // silent end into a named error — never publish recoverable without
    // recovery data. (A loop cut already errored inside `end`.)
    if (normalizer.result.outcome === "suspended" && request.continuations) {
      // The approval pause names its call; only when the engine stayed
      // implicit does the single result-less announced call stand in — and
      // only when it is unambiguous (OCR fix wave 3, R3-10: several parallel
      // pendings are a refusal to guess, and a named call the stream never
      // announced is engine drift — both are save failures, never a silent
      // skip that publishes a waiting state nothing could resume).
      const suspendedId = normalizer.result.suspendedToolCallId;
      let pending: readonly [string, { toolName: string; argsText: string }];
      if (suspendedId) {
        const named = announced.get(suspendedId);
        if (!named) {
          yield saveFailedRunError(
            "the suspension named a tool call the stream never announced",
          );
          return;
        }
        pending = [suspendedId, named];
      } else {
        const resultLess = [...announced.entries()].filter(
          ([toolCallId]) => !resultsSeen.has(toolCallId),
        );
        // Exactly one candidate or nothing: zero pendings and several
        // parallel pendings are the same refusal to guess.
        const only = resultLess.length === 1 ? resultLess[0] : undefined;
        if (!only) {
          yield saveFailedRunError(
            "the suspension ended terminal-less but no single pending tool call could be identified",
          );
          return;
        }
        pending = only;
      }
      const [toolCallId, call] = pending;
      let args: unknown;
      try {
        args = call.argsText ? (JSON.parse(call.argsText) as unknown) : {};
      } catch {
        // Digesting the raw text would mint an argsDigest the approval side
        // (canonicalJson of the PARSED arguments) can never reproduce — the
        // suspension would sit waiting, permanently locked out of a
        // legitimate approval. Unparsable arguments are a save failure.
        yield saveFailedRunError(
          "the suspension's tool arguments could not be parsed",
        );
        return;
      }
      const argsDigest = argsDigestFor(args);
      try {
        await request.continuations.onSuspension({
          // ME06: the suspension KIND follows the mounted tool surface — a
          // client-declared participation tool saves the frontend_tool
          // continuation the client's tool_result resumes; everything else
          // keeps the ME05 approval semantics on the same ledger.
          kind: suspensionKindOf(call.toolName, request.frontendTools),
          toolCallId,
          toolName: call.toolName,
          argsDigest,
          // The wrapper's operation only exists at execute time; the
          // suspension is pre-execute, so the durable derived identity
          // (the SAME formula the store applies) is the operation here.
          operationId: continuationOperationId(
            request.binding.executionKey,
            toolCallId,
            argsDigest,
          ),
          snapshotRef: `suspended:${request.binding.executionKey}:${toolCallId}`,
        });
      } catch (cause) {
        yield saveFailedRunError(
          `the suspension's recovery data could not be saved (${
            cause instanceof Error ? cause.message : String(cause)
          })`,
        );
      }
    }
  } finally {
    // The durable stack reference must reach here alive (see above): touching
    // it in the finally pins the binding to the end of the frame, so the
    // snapshot registration cannot be collected out from under a suspension
    // that saved earlier in the stream.
    void durable;
    // Early termination (unsubscribe's return(), or a push that rejected) must
    // also stop the engine stream: an unclosed fullStream keeps the model loop
    // dialling — burning governed budget — until the abort signal happens to
    // arrive. Cancel first (a no-op or rejection on a finished/errored stream),
    // then release the lock.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Run one execution: a cold observable that starts the engine only when
 * subscribed and stops with it. The signal is checked before the model runs
 * and handed to the engine for the whole stream, so a stop or a transport
 * teardown reaches the provider dial.
 */
export function runMastraExecution(
  request: ExecutionRequest,
): Observable<BaseEvent> {
  return defer(() => from(runAndNormalize(request)));
}
