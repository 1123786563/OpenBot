import {
  type BaseEvent,
  EventType,
  type RunErrorEvent,
  type RunFinishedEvent,
  type RunStartedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
} from "@ag-ui/client";
import { markUntrusted } from "../untrusted-content";

/*
 * ME02 (#474) T3: normalize the pinned @mastra/core 1.64.0 AGENT fullStream
 * into the existing AG-UI canonical events.
 *
 * Contracts enforced here (they are the whole point of the module):
 *  - text/tool chunks become TEXT_MESSAGE_* / TOOL_CALL_* events with stable
 *    message and call ids taken from the engine;
 *  - an error never becomes success (exactly one terminal, RUN_ERROR);
 *  - suspension has no success terminal (no RUN_FINISHED, no RUN_ERROR);
 *  - a stream that ends without a terminal is a failure, not a success;
 *  - unknown control chunk semantics REJECT the run instead of being dropped,
 *    while non-control diagnostic chunks sit on an explicit allow-list.
 *
 * The chunk vocabulary below is the ME01-probed inventory, frozen by this
 * suite. Mastra usage fields are deliberately NOT relayed: the governed
 * gateway adapter is the settlement authority.
 */

/**
 * Diagnostic chunks: known, control-relevant, but carrying no canonical event.
 *
 * The remaining engine-defined chunk types of the pinned 1.64.0 vocabulary —
 * `reasoning-start` / `reasoning-delta` / `reasoning-end` /
 * `reasoning-signature`, `redacted-reasoning`, `response-metadata` and `raw`
 * — sit here deliberately: they are model-introspection and provider-metadata
 * carriers whose payloads never gate a branch of this normalizer, so relaying
 * nothing about them cannot alter business control flow (verified against this
 * module's own switch: none of them names a text/tool id, a terminal or an
 * outcome). They are listed explicitly — never silently unknown — so a future
 * chunk type still rejects, and so adding one of these to the control set is a
 * reviewed decision rather than an accident of the default branch.
 */
export const MASTRA_STREAM_CHUNK_ALLOW_LIST: readonly string[] = [
  "step-start",
  "step-finish",
  "abort",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "reasoning-signature",
  "redacted-reasoning",
  "response-metadata",
  "raw",
];

const KNOWN_CHUNK_TYPES: readonly string[] = [
  "start",
  "text-start",
  "text-delta",
  "text-end",
  "tool-call-input-streaming-start",
  "tool-call-delta",
  "tool-call-input-streaming-end",
  "tool-call",
  "tool-call-approval",
  "tool-call-suspended",
  "tool-result",
  "tool-error",
  "finish",
  "error",
  ...MASTRA_STREAM_CHUNK_ALLOW_LIST,
];

export type MastraStreamOutcome =
  | "finished"
  | "suspended"
  | "errored"
  | "aborted"
  | "no-terminal";

export interface NormalizedMastraStream {
  readonly events: BaseEvent[];
  readonly outcome: MastraStreamOutcome;
  /**
   * ME05: the toolCallId the durable approval pause is waiting on, when the
   * outcome is the approval suspension.
   */
  readonly suspendedToolCallId?: string;
}

/**
 * An engine chunk this normalizer cannot explain. The message prefix splits
 * the two ways that happens (R4-15): `MASTRA_STREAM_UNKNOWN_CHUNK` for a
 * chunk outside the pinned vocabulary entirely, `MASTRA_STREAM_MALFORMED_CHUNK`
 * for a known chunk type whose payload or framing is damaged.
 */
export class UnknownMastraChunkError extends Error {}

export interface MastraStreamIdentity {
  readonly threadId: string;
  readonly runId: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * JSON text for an engine payload, with a readable fallback when the payload
 * cannot serialize (cyclic vendor error objects would otherwise throw out of
 * the RUN_ERROR path itself and turn a diagnosable failure into a bare
 * exception with no error text at all). The fallback is caller-chosen so a
 * tool-error payload is not misdiagnosed as a model stream error (R4-15).
 */
function jsonText(value: unknown, fallback = "unserializable payload"): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return fallback;
  }
}

/**
 * One stateful normalization pass over a single engine stream. Feed every
 * chunk through {@link push}; call {@link end} once the engine stream is
 * exhausted. Events are returned per call in canonical order.
 *
 * Batch callers (normalizeMastraChunks, tests) accumulate; a streaming caller
 * passes `{ streaming: true }` so each push hands over its events and the
 * internal buffer is cleared — the streaming path consumes events as they are
 * produced and must not retain the whole run's stream until the end.
 */
export class MastraStreamNormalizer {
  private readonly events: BaseEvent[] = [];
  private outcome: MastraStreamOutcome | null = null;
  private terminalEmitted = false;
  private startEmitted = false;
  private readonly openTextIds = new Set<string>();
  /** Call ids whose TOOL_CALL_START has already been emitted. */
  private readonly announcedToolCalls = new Set<string>();
  /**
   * The streaming lifecycle of an announced call: it sits here between its
   * streaming START and its streaming END — exactly the calls whose
   * TOOL_CALL_START has no TOOL_CALL_END yet. Unlike announcedToolCalls this
   * set is deletable, so a repeated START/END frame is damage to reject, not
   * a second call (R4-18), and the terminal path knows which calls to close
   * (R4-13).
   */
  private readonly openStreamingCalls = new Set<string>();
  /** Call ids whose TOOL_CALL_RESULT frame has already been emitted. */
  private readonly emittedToolResults = new Set<string>();
  /**
   * ME04: whether the terminal-less `suspended` outcome was set by a
   * `tool-calls` step end (the engine's loop wanted to continue) rather than
   * the durable approval pause (`suspended`). A stream that ENDS in that
   * state is a loop cut — the step cap or a truncated loop — and must land
   * as a truthful error terminal, never a silent end that reads as either
   * success or a resumable pause.
   */
  private suspendedByToolCalls = false;
  /**
   * ME05: the call the engine paused for approval on, when the durable
   * approval pause fired. The suspension save binds the continuation to this
   * exact call.
   */
  private approvalPendingToolCallId: string | undefined;
  private readonly streaming: boolean;

  constructor(
    private readonly identity: MastraStreamIdentity,
    options?: { streaming?: boolean },
  ) {
    this.streaming = options?.streaming ?? false;
  }

  push(chunk: unknown): BaseEvent[] {
    // A malformed engine may keep streaming after the terminal; once a
    // terminal exists the adapter must not emit further business events.
    if (this.terminalEmitted) return [];
    const before = this.events.length;
    if (!object(chunk) || typeof chunk.type !== "string") {
      throw new UnknownMastraChunkError(
        `MASTRA_STREAM_UNKNOWN_CHUNK: ${jsonText(chunk).slice(0, 200)}`,
      );
    }
    if (!KNOWN_CHUNK_TYPES.includes(chunk.type)) {
      throw new UnknownMastraChunkError(
        `MASTRA_STREAM_UNKNOWN_CHUNK: ${chunk.type}`,
      );
    }
    const payload = object(chunk.payload) ? chunk.payload : {};
    switch (chunk.type as string) {
      case "start":
        // The engine run header: the canonical RUN_STARTED under the
        // server-issued identity. Emitted eagerly — a run that suspends or
        // is aborted still started.
        this.ensureRunStarted();
        break;
      case "text-start": {
        const id = this.textId(payload);
        if (this.openTextIds.has(id)) {
          // A second START for a message that is still open would emit two
          // TEXT_MESSAGE_START frames under one id — the same broken framing
          // every other symmetry break here rejects.
          throw new UnknownMastraChunkError(
            "MASTRA_STREAM_MALFORMED_CHUNK: duplicate text-start for an open message id",
          );
        }
        this.ensureRunStarted();
        this.openTextIds.add(id);
        const start: TextMessageStartEvent = {
          type: EventType.TEXT_MESSAGE_START,
          messageId: id,
          role: "assistant",
        };
        this.events.push(start);
        break;
      }
      case "text-delta": {
        const id = this.textId(payload);
        if (typeof payload.text !== "string") {
          throw new UnknownMastraChunkError(
            "MASTRA_STREAM_MALFORMED_CHUNK: text-delta without text",
          );
        }
        this.ensureRunStarted();
        if (!this.openTextIds.has(id)) {
          // A delta for a message whose start was never seen: the engine's
          // control framing is damaged, not merely verbose.
          throw new UnknownMastraChunkError(
            "MASTRA_STREAM_MALFORMED_CHUNK: text-delta before text-start",
          );
        }
        const content: TextMessageContentEvent = {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: id,
          delta: payload.text,
        };
        this.events.push(content);
        break;
      }
      case "text-end": {
        const id = this.textId(payload);
        if (!this.openTextIds.delete(id)) {
          // Symmetric with text-delta: an END for a message that never
          // STARTed (or already ended) is damaged engine framing, and
          // emitting it would break the AG-UI event order.
          throw new UnknownMastraChunkError(
            "MASTRA_STREAM_MALFORMED_CHUNK: text-end without open text-start",
          );
        }
        this.ensureRunStarted();
        const end: TextMessageEndEvent = {
          type: EventType.TEXT_MESSAGE_END,
          messageId: id,
        };
        this.events.push(end);
        break;
      }
      case "tool-call-input-streaming-start": {
        const toolCallId = this.toolCallId(payload);
        const toolName = payload.toolName;
        if (typeof toolName !== "string" || !toolName) {
          throw new UnknownMastraChunkError(
            "MASTRA_STREAM_MALFORMED_CHUNK: tool start without name",
          );
        }
        if (
          this.openStreamingCalls.has(toolCallId) ||
          this.announcedToolCalls.has(toolCallId)
        ) {
          // A second START for an announced call — streamed twice, or after
          // the consolidated tool-call already announced it — would emit a
          // duplicate TOOL_CALL_START under one id.
          throw new UnknownMastraChunkError(
            "MASTRA_STREAM_MALFORMED_CHUNK: duplicate streaming start for an already announced call",
          );
        }
        this.ensureRunStarted();
        this.announcedToolCalls.add(toolCallId);
        this.openStreamingCalls.add(toolCallId);
        const start: ToolCallStartEvent = {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: toolName,
        };
        this.events.push(start);
        break;
      }
      case "tool-call-delta": {
        const toolCallId = this.toolCallId(payload);
        if (typeof payload.argsTextDelta !== "string") {
          throw new UnknownMastraChunkError(
            "MASTRA_STREAM_MALFORMED_CHUNK: tool delta without argsTextDelta",
          );
        }
        if (!this.announcedToolCalls.has(toolCallId)) {
          // Args for a call whose streaming START was never seen would emit a
          // TOOL_CALL_ARGS with no TOOL_CALL_START — the same broken framing
          // text-delta refuses.
          throw new UnknownMastraChunkError(
            "MASTRA_STREAM_MALFORMED_CHUNK: tool-call-delta before streaming start",
          );
        }
        this.ensureRunStarted();
        const args: ToolCallArgsEvent = {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: payload.argsTextDelta,
        };
        this.events.push(args);
        break;
      }
      case "tool-call-input-streaming-end": {
        const toolCallId = this.toolCallId(payload);
        // Deleting from the open lifecycle set (not merely checking
        // announcedToolCalls) is what makes a repeated END damage: the first
        // END closed the call, so a second one has no open START behind it.
        if (!this.openStreamingCalls.delete(toolCallId)) {
          throw new UnknownMastraChunkError(
            "MASTRA_STREAM_MALFORMED_CHUNK: tool-call-input-streaming-end before streaming start",
          );
        }
        this.ensureRunStarted();
        const end: ToolCallEndEvent = {
          type: EventType.TOOL_CALL_END,
          toolCallId,
        };
        this.events.push(end);
        break;
      }
      case "tool-call": {
        // The consolidated call. When the streaming events already announced
        // it, this is a duplicate framing (acknowledged, not re-emitted —
        // a second START/ARGS/END for one id would read as a second call);
        // when they did not (non-streaming path), emit the complete trio.
        const toolCallId = this.toolCallId(payload);
        if (this.announcedToolCalls.has(toolCallId)) break;
        if (typeof payload.toolName !== "string" || !payload.toolName) {
          throw new UnknownMastraChunkError(
            "MASTRA_STREAM_MALFORMED_CHUNK: tool-call without name",
          );
        }
        this.announcedToolCalls.add(toolCallId);
        this.ensureRunStarted();
        const start: ToolCallStartEvent = {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: payload.toolName,
        };
        this.events.push(start);
        const args: ToolCallArgsEvent = {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          // jsonText, not bare stringify: cyclic vendor args must degrade to
          // a readable frame, not throw a bare TypeError out of push (R4-12).
          delta: jsonText(payload.args ?? {}),
        };
        this.events.push(args);
        const end: ToolCallEndEvent = {
          type: EventType.TOOL_CALL_END,
          toolCallId,
        };
        this.events.push(end);
        break;
      }
      case "tool-call-approval":
      case "tool-call-suspended": {
        // ME05: the DURABLE approval pause — a requireApproval tool pauses
        // inside the engine's durable toolCallStep BEFORE the granted
        // execute can run. ME06: the frontend pause — a client-declared
        // participation tool called `suspend()` inside its (inert) bridge,
        // the pinned engine's `tool-call-suspended` frame. Both are the
        // terminal-less suspension outcome — never a success, never an
        // error — and both name the exact call the continuation must save.
        const toolCallId = this.toolCallId(payload);
        this.ensureRunStarted();
        this.approvalPendingToolCallId = toolCallId;
        // A real durable pause supersedes an earlier `tool-calls` step end
        // (R4-11): without this reset end() would misread the pause as the
        // ME04 loop cut, terminate it with RUN_ERROR — and the suspension
        // save (gated on outcome "suspended") would be skipped.
        this.suspendedByToolCalls = false;
        if (this.outcome === null) this.outcome = "suspended";
        break;
      }
      case "tool-result": {
        const toolCallId = this.toolCallId(payload);
        if (!this.announcedToolCalls.has(toolCallId)) {
          // A result for a call this stream never announced has no
          // TOOL_CALL_START to attach to: reject, don't fabricate one.
          throw new UnknownMastraChunkError(
            "MASTRA_STREAM_MALFORMED_CHUNK: tool-result before streaming start",
          );
        }
        if (this.emittedToolResults.has(toolCallId)) {
          // A repeated result would emit a second TOOL_CALL_RESULT under the
          // one synthetic id `tool-result-<id>`; the first answer stands.
          break;
        }
        this.emittedToolResults.add(toolCallId);
        this.ensureRunStarted();
        const result: ToolCallResultEvent = {
          type: EventType.TOOL_CALL_RESULT,
          messageId: `tool-result-${toolCallId}`,
          toolCallId,
          role: "tool",
          content: jsonText(payload.result ?? null),
        };
        this.events.push(result);
        break;
      }
      case "tool-error": {
        // The first tool-execution failure path (granted tool execute throw,
        // input validation failure): the run fails with the vendor's tool
        // error text wrapped and diagnosable — never an unknown-chunk reject
        // that would discard the payload wholesale.
        const toolCallId = this.toolCallId(payload);
        // An abort already recorded is not un-recorded by a late tool
        // failure surfaced during teardown (R4-19, same contract as onError).
        if (this.outcome === "aborted") break;
        this.outcome = "errored";
        const cause = object(payload.error) ? payload.error : {};
        const text =
          typeof (cause as { message?: unknown }).message === "string"
            ? (cause as { message: string }).message
            : jsonText(
                payload.error,
                "tool execution error (unserializable payload)",
              );
        this.emitRunError(
          markUntrusted(text, `tool ${toolCallId} execution error`),
        );
        break;
      }
      case "finish":
        this.onFinish(payload);
        break;
      case "error":
        this.onError(payload);
        break;
      default:
        // step-start / step-finish / abort: diagnostics. Their payloads echo
        // provider requests (the whole prompt) and non-authoritative usage —
        // never relayed, never dropped silently: the abort reason is what the
        // outcome records.
        if (chunk.type === "abort") {
          if (this.outcome === null) this.outcome = "aborted";
        }
        break;
    }
    const emitted = this.events.slice(before);
    // Streaming mode: the caller has taken ownership of these events; the
    // buffer only ever holds the current push, so a long run does not retain
    // every delta until the stream ends. Batch mode keeps accumulating for
    // the result getter.
    if (this.streaming) this.events.length = 0;
    return emitted;
  }

  /**
   * Close the stream. A run that never reached a terminal is failed here:
   * the one thing this adapter will not do is let a silent end read as
   * success. Suspension and an engine abort stay terminal-less on purpose —
   * the business lifecycle owns both — EXCEPT the ME04 loop cut: a stream
   * that ends right after a `tool-calls` step (the model wanted another tool
   * round and the engine stopped — the 8-step cap or a truncated loop) is
   * not resumable and not a pause, so it ends as a truthful error terminal
   * that names the reason. Nothing fabricates a completion.
   */
  end(): BaseEvent[] {
    const before = this.events.length;
    if (this.terminalEmitted) return [];
    if (this.outcome === "suspended" && this.suspendedByToolCalls) {
      this.outcome = "errored";
      this.emitRunError(
        "Mastra tool loop ended on a tool-call step without a final answer (model step cap reached or loop truncated); no completion is fabricated.",
      );
    } else if (this.outcome === null) {
      this.outcome = "no-terminal";
      this.emitRunError("Mastra stream ended without a terminal event.");
    }
    const emitted = this.events.slice(before);
    // Streaming mode hands each event over as it is produced — end() does the
    // same for the terminal it may emit here (R4-16), so result.events is
    // empty on EVERY end path in streaming mode, not only the ones that
    // flowed through push.
    if (this.streaming) this.events.length = 0;
    return emitted;
  }

  get result(): NormalizedMastraStream {
    return {
      events: [...this.events],
      outcome: this.outcome ?? "no-terminal",
      // The id is part of the suspension contract: it exists only while the
      // outcome still IS the durable approval pause (R4-20). Once the run
      // errored or finished, no caller may read a suspension out of it — and
      // the ME04 loop cut is a loop cut, not a resumable pause.
      ...(this.outcome === "suspended" &&
      !this.suspendedByToolCalls &&
      this.approvalPendingToolCallId
        ? { suspendedToolCallId: this.approvalPendingToolCallId }
        : {}),
    };
  }

  private onFinish(payload: Record<string, unknown>): void {
    if (this.terminalEmitted) return;
    const reason = this.finishReason(payload);
    switch (reason) {
      case "stop":
      case "length":
        // `length` is the governed maxOutputTokens ceiling truncating a step
        // — a normal terminal on this path, whose business result the runner
        // settles. Not an unknown reason, and never a rejection of the run.
        // But an engine abort already recorded is not un-recorded by a
        // trailing finish: the aborted outcome stands, terminal-less — a
        // stopped run is never settled as a success.
        if (this.outcome === "aborted") break;
        this.emitRunFinished();
        break;
      case "suspended":
      case "tool-calls":
        // No success terminal. `suspended` is the durable approval pause;
        // `tool-calls` is the engine's mid-loop step end once ME04 wires
        // tools — until that slice owns its real semantics it is treated
        // exactly like suspension: terminal-less, never read as success.
        if (this.outcome === null) {
          this.outcome = "suspended";
          this.suspendedByToolCalls = reason === "tool-calls";
        }
        break;
      case "error":
        // Symmetric with stop/length: an abort already recorded stands; a
        // trailing errored finish from teardown must not turn it into an
        // error terminal (R4-19).
        if (this.outcome === "aborted") break;
        this.outcome = "errored";
        this.emitRunError("Mastra stream finished with an error reason.");
        break;
      case "content-filter":
        // Provider policy blocked the step: an error terminal, not a silent
        // end and never a success.
        this.outcome = "errored";
        this.emitRunError(
          "Mastra stream finished with a content-filter reason.",
        );
        break;
      case "tripwire":
        // Engine abort: the run was stopped through the engine signal.
        if (this.outcome === null) this.outcome = "aborted";
        break;
      default:
        throw new UnknownMastraChunkError(
          `MASTRA_STREAM_MALFORMED_CHUNK: finish reason ${String(reason)}`,
        );
    }
  }

  private emitRunFinished(): void {
    this.outcome = "finished";
    this.terminalEmitted = true;
    this.ensureRunStarted();
    this.closeOpenLifecycles();
    // Deliberately no `outcome` field: the product runner owns the
    // business outcome and reads an agent-declared outcome as a cancel.
    const finished: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: this.identity.threadId,
      runId: this.identity.runId,
    };
    this.events.push(finished);
  }

  private onError(payload: Record<string, unknown>): void {
    if (this.terminalEmitted) return;
    // An abort already recorded is not un-recorded by a trailing teardown
    // error: the aborted outcome stays terminal-less by contract (R4-19).
    if (this.outcome === "aborted") return;
    this.outcome = "errored";
    const cause = object(payload.error) ? payload.error : payload;
    const text =
      typeof (cause as { message?: unknown }).message === "string"
        ? (cause as { message: string }).message
        : jsonText(cause);
    // The vendor's error text is outside content: wrapped, not laundered.
    this.emitRunError(markUntrusted(text, "model stream error"));
  }

  private emitRunError(message: string): void {
    this.terminalEmitted = true;
    this.ensureRunStarted();
    this.closeOpenLifecycles();
    const error: RunErrorEvent = {
      type: EventType.RUN_ERROR,
      message,
    };
    this.events.push(error);
  }

  /**
   * Close every lifecycle frame the engine left open before a terminal
   * (R4-13): an open TEXT_MESSAGE_START gets its TEXT_MESSAGE_END, an
   * announced streaming call gets its TOOL_CALL_END. Everywhere else this
   * module REJECTs damaged framing; the terminal path must not become the one
   * place a client is left holding a message that never ends.
   */
  private closeOpenLifecycles(): void {
    for (const id of this.openTextIds) {
      const end: TextMessageEndEvent = {
        type: EventType.TEXT_MESSAGE_END,
        messageId: id,
      };
      this.events.push(end);
    }
    for (const toolCallId of this.openStreamingCalls) {
      const end: ToolCallEndEvent = {
        type: EventType.TOOL_CALL_END,
        toolCallId,
      };
      this.events.push(end);
    }
    this.openTextIds.clear();
    this.openStreamingCalls.clear();
  }

  private ensureRunStarted(): void {
    if (this.startEmitted) return;
    this.startEmitted = true;
    const started: RunStartedEvent = {
      type: EventType.RUN_STARTED,
      threadId: this.identity.threadId,
      runId: this.identity.runId,
    };
    this.events.push(started);
  }

  private textId(payload: Record<string, unknown>): string {
    if (typeof payload.id !== "string" || !payload.id) {
      throw new UnknownMastraChunkError(
        "MASTRA_STREAM_MALFORMED_CHUNK: text chunk without id",
      );
    }
    return payload.id;
  }

  private toolCallId(payload: Record<string, unknown>): string {
    if (typeof payload.toolCallId !== "string" || !payload.toolCallId) {
      throw new UnknownMastraChunkError(
        "MASTRA_STREAM_MALFORMED_CHUNK: tool chunk without toolCallId",
      );
    }
    return payload.toolCallId;
  }

  private finishReason(payload: Record<string, unknown>): string {
    const stepResult = object(payload.stepResult) ? payload.stepResult : {};
    const reason = stepResult.reason;
    if (typeof reason !== "string" || !reason) {
      throw new UnknownMastraChunkError(
        "MASTRA_STREAM_MALFORMED_CHUNK: finish without reason",
      );
    }
    return reason;
  }
}

/** Normalize a complete chunk sequence in one pass. */
export function normalizeMastraChunks(
  chunks: readonly unknown[],
  identity: MastraStreamIdentity,
): NormalizedMastraStream {
  const normalizer = new MastraStreamNormalizer(identity);
  for (const chunk of chunks) normalizer.push(chunk);
  normalizer.end();
  return normalizer.result;
}
