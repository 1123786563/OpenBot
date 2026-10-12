import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { loadCraftConfig } from "../src/craft/config";
import {
  approvalRequestedPacket,
  type BuildPacket,
  isBuildPacket,
} from "../src/craft/events/packets";
import {
  isAgentMessageChunk,
  isAgentThoughtChunk,
  isPromptResponse,
  isSandboxError,
  isToolCallProgress,
  isToolCallStart,
  type SandboxEvent,
  TURN_ERROR_CODE_SESSION,
  TURN_ERROR_CODE_TIMEOUT,
  TURN_ERROR_CODE_TRANSPORT,
} from "../src/craft/events/types";
import {
  SubscriberQueue,
  type PodEventBus,
  type PodSubscription,
} from "../src/craft/opencode/event-bus";
import {
  OpencodeServeClient,
  type FetchMessage,
  translateOpencodeEvent,
  TurnState,
} from "../src/craft/opencode/serve-client";

/**
 * translateOpencodeEvent — the pure opencode /event → sandbox-event translator. Port of onyx
 * `tests/unit/onyx/server/features/craft/sandbox/test_translate_opencode_event.py` (the wire
 * contract lock): canned /event payloads in, generator-drained sandbox events out, with the
 * correlation state carried across calls the way the bus reader threads it.
 *
 * Plus the three turn error-code sentinels: -1 from translation (session.error), -2/-3 from the
 * transport loops in OpencodeServeClient (driven against a fake bus at the seam — the real
 * SubscriberQueue, a stub /event bus, and a stubbed fetch).
 */

const SESS = "ses_test123";

type RawEvent = Record<string, unknown>;

function state(): TurnState {
  return new TurnState(SESS);
}

/** State pre-populated as if the assistant message.updated already arrived (onyx _assistant_state). */
function assistantState(): TurnState {
  const s = state();
  s.assistantMessageIds.add("msg_assistant");
  return s;
}

function drain(
  raw: RawEvent,
  turnState: TurnState,
  options: Parameters<typeof translateOpencodeEvent>[2] = {},
): Array<SandboxEvent | BuildPacket> {
  return [...translateOpencodeEvent(raw, turnState, options)];
}

/** Dict-backed fetch_message stub recording every call (onyx _fetch_from). */
function fetchFrom(
  responses: Record<string, RawEvent | null>,
): { fetch: FetchMessage; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchMessage = (messageId) => {
    calls.push(messageId);
    return responses[messageId] ?? null;
  };
  return { fetch, calls };
}

function deltaEvent(
  messageId: string,
  partId = "p1",
  delta = "x",
  sessionID = SESS,
): RawEvent {
  return {
    type: "message.part.delta",
    properties: { sessionID, messageID: messageId, partID: partId, field: "text", delta },
  };
}

function partUpdated(part: RawEvent, sessionID = SESS): RawEvent {
  return { type: "message.part.updated", properties: { sessionID, part } };
}

function toolEvent(
  callId: string,
  tool: string,
  status: unknown,
  stateExtra: RawEvent = {},
): RawEvent {
  return partUpdated({
    id: `prt_${callId}`,
    type: "tool",
    tool,
    callID: callId,
    state: { status, ...stateExtra },
  });
}

// ───────────────────────────── text deltas ─────────────────────────────

describe("translateOpencodeEvent — text deltas", () => {
  test("text delta on a known assistant message yields agent_message_chunk and accumulates", () => {
    const s = assistantState();
    const out = drain(deltaEvent("msg_assistant", "p1", "hello"), s);
    expect(out).toHaveLength(1);
    expect(isAgentMessageChunk(out[0])).toBe(true);
    expect(out[0]).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    });
    expect(s.localText.get("p1")).toBe("hello");

    for (const part of ["foo", " bar", " baz"]) {
      drain(deltaEvent("msg_assistant", "p1", part), s);
    }
    expect(s.localText.get("p1")).toBe("hellofoo bar baz");
  });

  test("a delta on a reasoning part routes to agent_thought_chunk (field is always 'text')", () => {
    const s = assistantState();
    s.partTypes.set("p1", "reasoning");
    const out = drain(deltaEvent("msg_assistant", "p1", "thinking..."), s);
    expect(out).toHaveLength(1);
    expect(isAgentThoughtChunk(out[0])).toBe(true);
    expect(out[0]).toMatchObject({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking..." },
    });
  });

  test("empty reasoning delta is ignored (nothing yielded, nothing accumulated)", () => {
    const s = assistantState();
    s.partTypes.set("p1", "reasoning");
    const out = drain(deltaEvent("msg_assistant", "p1", ""), s);
    expect(out).toEqual([]);
    expect(s.localText.has("p1")).toBe(false);
  });

  test("part.updated records the part type so later deltas route on it", () => {
    const s = assistantState();
    drain(
      partUpdated({
        id: "p_reason",
        messageID: "msg_assistant",
        type: "reasoning",
        text: "",
      }),
      s,
    );
    expect(s.partTypes.get("p_reason")).toBe("reasoning");
    const out = drain(deltaEvent("msg_assistant", "p_reason", "weighing options"), s);
    expect(out).toHaveLength(1);
    expect(isAgentThoughtChunk(out[0])).toBe(true);
  });

  test("step-boundary and unknown-field deltas yield nothing", () => {
    const s = assistantState();
    s.partTypes.set("p_step", "step-start");
    expect(drain(deltaEvent("msg_assistant", "p_step", "step boundary"), s)).toEqual([]);
    expect(
      drain(
        {
          type: "message.part.delta",
          properties: {
            sessionID: SESS,
            messageID: "msg_assistant",
            partID: "p1",
            field: "tool_call",
            delta: "ignored",
          },
        },
        s,
      ),
    ).toEqual([]);
  });

  test("a multi-assistant-message turn (tool call + follow-up answer) tracks both ids", () => {
    const s = state();
    const msgUpdated = (id: string) => ({
      type: "message.updated",
      properties: {
        info: { id, sessionID: SESS, role: "assistant", time: { completed: null } },
      },
    });
    drain(msgUpdated("msg_A"), s);
    drain(msgUpdated("msg_B"), s);
    expect(s.assistantMessageIds.has("msg_A")).toBe(true);
    expect(s.assistantMessageIds.has("msg_B")).toBe(true);

    drain(
      partUpdated({ id: "p_answer", messageID: "msg_B", type: "text", text: "" }),
      s,
    );
    const out = drain(deltaEvent("msg_B", "p_answer", "Yuhong"), s);
    expect(out).toHaveLength(1);
    expect(isAgentMessageChunk(out[0])).toBe(true);
    expect(out[0]).toMatchObject({ content: { text: "Yuhong" } });
  });
});

// ───────────────────── assistant-role filtering + hydrate ─────────────────────

describe("translateOpencodeEvent — role filtering and REST hydrate", () => {
  test("deltas before the assistant message id is known are dropped (user prompt never leaks)", () => {
    const s = state();
    expect(drain(deltaEvent("msg_unknown"), s)).toEqual([]);
    expect(s.localText.size).toBe(0);
  });

  test("deltas for a user message are dropped even after an assistant id is known", () => {
    const s = state();
    s.assistantMessageIds.add("msg_assistant");
    expect(drain(deltaEvent("msg_user", "p_user", "user text"), s)).toEqual([]);
    expect(s.localText.size).toBe(0);
  });

  test("part.updated text for a user message is filtered", () => {
    const s = state();
    s.assistantMessageIds.add("msg_assistant");
    expect(
      drain(partUpdated({ id: "p_user", messageID: "msg_user", type: "text", text: "user echo" }), s),
    ).toEqual([]);
  });

  test("delta for unknown message hydrates as assistant: emitted, cached, fetched once", () => {
    const s = state();
    const { fetch, calls } = fetchFrom({
      msg_new: {
        info: { id: "msg_new", role: "assistant" },
        parts: [{ id: "p1", type: "text" }],
      },
    });
    const out1 = drain(deltaEvent("msg_new", "p1", "hi "), s, { fetchMessage: fetch });
    const out2 = drain(deltaEvent("msg_new", "p1", "there"), s, { fetchMessage: fetch });
    expect(out1).toHaveLength(1);
    expect(isAgentMessageChunk(out1[0])).toBe(true);
    expect(out2).toHaveLength(1);
    expect(isAgentMessageChunk(out2[0])).toBe(true);
    expect(s.assistantMessageIds.has("msg_new")).toBe(true);
    expect(s.partTypes.get("p1")).toBe("text");
    expect(calls).toEqual(["msg_new"]);
  });

  test("delta for unknown message hydrates as user: dropped, cached negatively, fetched once", () => {
    const s = state();
    const { fetch, calls } = fetchFrom({
      msg_user: { info: { id: "msg_user", role: "user" }, parts: [] },
    });
    expect(drain(deltaEvent("msg_user"), s, { fetchMessage: fetch })).toEqual([]);
    expect(drain(deltaEvent("msg_user"), s, { fetchMessage: fetch })).toEqual([]);
    expect(s.assistantMessageIds.has("msg_user")).toBe(false);
    expect(s.userMessageIds.has("msg_user")).toBe(true);
    expect(calls).toEqual(["msg_user"]);
  });

  test("failed / malformed / unknown-role hydrates cache negatively (no retry storm)", () => {
    for (const [messageId, body] of [
      ["msg_broken", null],
      ["msg_malformed", { parts: [] }],
      ["msg_system", { info: { role: "system" }, parts: [] }],
    ] as const) {
      const s = state();
      const { fetch, calls } = fetchFrom({ [messageId]: body as RawEvent | null });
      drain(deltaEvent(messageId), s, { fetchMessage: fetch });
      drain(deltaEvent(messageId), s, { fetchMessage: fetch });
      expect(calls).toEqual([messageId]);
      expect(s.userMessageIds.has(messageId)).toBe(true);
    }
  });

  test("no fetch callback still caches the id as non-assistant (subagent fanout path)", () => {
    const s = state();
    drain(deltaEvent("msg_no_fetch"), s);
    drain(deltaEvent("msg_no_fetch"), s);
    expect(s.userMessageIds.has("msg_no_fetch")).toBe(true);
  });

  test("events for an unrelated session are dropped", () => {
    const s = assistantState();
    expect(drain(deltaEvent("msg_assistant", "p1", "hello", "ses_OTHER"), s)).toEqual([]);
    expect(s.localText.size).toBe(0);
  });
});

// ───────────────────────── turn terminators ─────────────────────────

describe("translateOpencodeEvent — turn terminators", () => {
  const promptResponse = (raw: RawEvent, s: TurnState) =>
    drain(raw, s).filter(isPromptResponse);

  test("message.updated alone never terminates (completed or in-progress, any role)", () => {
    const s = state();
    expect(
      drain(
        {
          type: "message.updated",
          properties: {
            info: { sessionID: SESS, role: "assistant", time: { completed: 1779000000000 }, finish: "stop" },
          },
        },
        s,
      ).filter(isPromptResponse),
    ).toEqual([]);
    expect(
      drain(
        {
          type: "message.updated",
          properties: { info: { sessionID: SESS, role: "assistant", time: { completed: null } } },
        },
        s,
      ).filter(isPromptResponse),
    ).toEqual([]);
    expect(
      drain(
        {
          type: "message.updated",
          properties: { info: { sessionID: SESS, role: "user", time: { completed: 1779000000000 } } },
        },
        s,
      ).filter(isPromptResponse),
    ).toEqual([]);
  });

  test("session.idle yields exactly one PromptResponse; later backstops are no-ops", () => {
    const s = state();
    const out1 = promptResponse({ type: "session.idle", properties: { sessionID: SESS } }, s);
    expect(out1).toHaveLength(1);
    expect(out1[0]).toMatchObject({ stopReason: "end_turn" });

    const out2 = drain(
      { type: "session.status", properties: { sessionID: SESS, status: { type: "idle" } } },
      s,
    );
    expect(out2).toEqual([]);
    expect(promptResponse({ type: "session.idle", properties: { sessionID: SESS } }, s)).toEqual([]);
  });

  test("session.idle without an explicit sessionID still terminates", () => {
    const s = state();
    const out = promptResponse({ type: "session.idle", properties: {} }, s);
    expect(out).toHaveLength(1);
  });

  test("session.status idle-object is a terminator; non-idle statuses are no-ops", () => {
    const idle = state();
    expect(
      promptResponse(
        { type: "session.status", properties: { sessionID: SESS, status: { type: "idle" } } },
        idle,
      ),
    ).toHaveLength(1);
    const busy = state();
    expect(
      drain(
        { type: "session.status", properties: { sessionID: SESS, status: { type: "busy" } } },
        busy,
      ),
    ).toEqual([]);
  });

  test("finish=stop maps to end_turn; max_tokens passes through", () => {
    const stop = state();
    drain(
      {
        type: "message.updated",
        properties: { info: { sessionID: SESS, role: "assistant", finish: "stop" } },
      },
      stop,
    );
    const outStop = drain({ type: "session.idle", properties: { sessionID: SESS } }, stop);
    expect(outStop).toHaveLength(1);
    expect(outStop[0]).toMatchObject({ stopReason: "end_turn" });

    const max = state();
    drain(
      {
        type: "message.updated",
        properties: { info: { sessionID: SESS, role: "assistant", finish: "max_tokens" } },
      },
      max,
    );
    const outMax = drain({ type: "session.idle", properties: { sessionID: SESS } }, max);
    expect(outMax).toHaveLength(1);
    expect(outMax[0]).toMatchObject({ stopReason: "max_tokens" });
  });
});

// ───────────────────────── errors ─────────────────────────

describe("translateOpencodeEvent — error envelope (code -1)", () => {
  const sessionError = (message: string) => ({
    type: "session.error",
    properties: {
      sessionID: SESS,
      error: { name: "UnknownError", data: { message } },
    },
  });

  test("session.error emits exactly one Error event with code -1 and the nested message", () => {
    const s = state();
    const out = drain(sessionError("Model not found."), s);
    expect(out).toHaveLength(1);
    expect(isSandboxError(out[0])).toBe(true);
    expect(out[0]).toMatchObject({
      code: TURN_ERROR_CODE_SESSION,
      message: "Model not found.",
    });
  });

  test("duplicate session.error is silenced after the first (terminator dedup)", () => {
    const s = state();
    expect(drain(sessionError("first"), s)).toHaveLength(1);
    expect(drain(sessionError("second"), s)).toEqual([]);
  });

  test("message.updated carrying an error terminates the turn with the Error event", () => {
    const s = state();
    const out = drain(
      {
        type: "message.updated",
        properties: {
          info: {
            sessionID: SESS,
            role: "assistant",
            time: { completed: 1779000000000 },
            error: { name: "UnknownError", data: { message: "Model not found." } },
          },
        },
      },
      s,
    );
    const errors = out.filter(isSandboxError);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: TURN_ERROR_CODE_SESSION, message: "Model not found." });
  });

  test("an aborted message terminates as cancelled, not as a turn failure", () => {
    const s = state();
    const out = drain(
      {
        type: "message.updated",
        properties: {
          info: {
            sessionID: SESS,
            role: "assistant",
            time: { completed: 1779000000000 },
            error: { name: "MessageAbortedError", data: { message: "Aborted" } },
          },
        },
      },
      s,
    );
    expect(out).toHaveLength(1);
    expect(isPromptResponse(out[0])).toBe(true);
    expect(out[0]).toMatchObject({ stopReason: "cancelled" });
  });
});

// ───────────────────────── gap-fill reconciliation ─────────────────────────

describe("translateOpencodeEvent — part.updated gap-fill", () => {
  const textPart = (id: string, text: string) =>
    partUpdated({ id, messageID: "msg_assistant", type: "text", text });

  test("server text longer than the local accumulator emits the missing tail", () => {
    const s = assistantState();
    s.localText.set("p1", "Hello, ");
    const out = drain(textPart("p1", "Hello, world!"), s);
    expect(out).toHaveLength(1);
    expect(isAgentMessageChunk(out[0])).toBe(true);
    expect(out[0]).toMatchObject({ content: { text: "world!" } });
    expect(s.localText.get("p1")).toBe("Hello, world!");
  });

  test("matching text is a no-op", () => {
    const s = assistantState();
    s.localText.set("p1", "all set");
    expect(drain(textPart("p1", "all set"), s)).toEqual([]);
  });

  test("a freshly created empty part is a no-op", () => {
    const s = assistantState();
    expect(drain(textPart("p_new", ""), s)).toEqual([]);
  });

  test("server-side rewind keeps the longer local accumulator", () => {
    const s = assistantState();
    s.localText.set("p1", "long string we already yielded");
    expect(drain(textPart("p1", "short"), s)).toEqual([]);
    expect(s.localText.get("p1")).toBe("long string we already yielded");
  });
});

// ───────────────────────── tool calls ─────────────────────────

describe("translateOpencodeEvent — tool calls", () => {
  test("first sighting of a pending call emits ToolCallStart only", () => {
    const s = state();
    const out = drain(toolEvent("c1", "bash", "pending"), s);
    expect(out).toHaveLength(1);
    expect(isToolCallStart(out[0])).toBe(true);
    expect(out[0]).toMatchObject({
      toolCallId: "c1",
      kind: "execute",
      title: "Running command",
      status: "pending",
      _meta: { toolName: "bash" },
    });
  });

  test("first sighting already running emits start then progress (in_progress)", () => {
    const s = state();
    const out = drain(
      toolEvent("c1", "bash", "running", { input: { command: "ls" } }),
      s,
    );
    expect(out).toHaveLength(2);
    expect(isToolCallStart(out[0])).toBe(true);
    expect(isToolCallProgress(out[1])).toBe(true);
    expect(out[1]).toMatchObject({ status: "in_progress" });
  });

  test("subsequent updates emit progress only, with wrapped raw output", () => {
    const s = state();
    drain(toolEvent("c1", "bash", "pending"), s);
    const out = drain(
      toolEvent("c1", "bash", "completed", {
        input: { command: "ls" },
        output: "file1\nfile2\n",
      }),
      s,
    );
    expect(out).toHaveLength(1);
    expect(isToolCallProgress(out[0])).toBe(true);
    expect(out[0]).toMatchObject({
      status: "completed",
      rawInput: { command: "ls" },
      rawOutput: { output: "file1\nfile2\n" },
    });
  });

  test("edit tool synthesizes a diff content block through translation", () => {
    const s = state();
    s.seenToolCalls.add("c_edit");
    const out = drain(
      partUpdated({
        id: "prt_edit",
        type: "tool",
        tool: "edit",
        callID: "c_edit",
        state: {
          status: "completed",
          input: { filePath: "/a.txt", oldString: "x", newString: "y" },
          output: "Edit applied successfully.",
        },
      }),
      s,
    );
    expect(out).toHaveLength(1);
    expect(isToolCallProgress(out[0])).toBe(true);
    const progress = out[0] as { content?: Array<Record<string, unknown>> };
    expect(progress.content).toHaveLength(1);
    expect(progress.content?.[0]).toMatchObject({
      type: "diff",
      path: "/a.txt",
      oldText: "x",
      newText: "y",
    });
  });

  test("completed with exit != 0 maps to failed (subsequent update and first sighting)", () => {
    const s = state();
    drain(toolEvent("c1", "bash", "pending"), s);
    const out = drain(
      toolEvent("c1", "bash", "completed", {
        input: { command: "sudo do-thing" },
        output: "permission denied",
        metadata: { exit: 1 },
      }),
      s,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      status: "failed",
      rawOutput: { output: "permission denied", metadata: { exit: 1 } },
    });

    const s2 = state();
    const dual = drain(
      toolEvent("c1", "bash", "completed", {
        input: { command: "false" },
        output: "",
        metadata: { exit: 1 },
      }),
      s2,
    );
    expect(dual).toHaveLength(2);
    expect(isToolCallStart(dual[0])).toBe(true);
    expect(isToolCallProgress(dual[1])).toBe(true);
    expect(dual[1]).toMatchObject({ status: "failed" });
  });

  test("completed with exit 0 stays completed; error state maps to failed with the error text", () => {
    const s = state();
    drain(toolEvent("c1", "bash", "pending"), s);
    const ok = drain(
      toolEvent("c1", "bash", "completed", {
        input: { command: "ls" },
        output: "file1\nfile2\n",
        metadata: { exit: 0 },
      }),
      s,
    );
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ status: "completed" });

    const s2 = state();
    drain(toolEvent("c2", "bash", "pending"), s2);
    const failed = drain(toolEvent("c2", "bash", "error", { error: "sudo: a password is required" }), s2);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      status: "failed",
      rawOutput: { output: "sudo: a password is required" },
    });
  });

  test("status mapping: running→in_progress, error/cancelled→failed, unknown→pending", () => {
    const cases: Array<[unknown, string]> = [
      ["pending", "pending"],
      ["running", "in_progress"],
      ["in_progress", "in_progress"],
      ["completed", "completed"],
      ["failed", "failed"],
      ["error", "failed"],
      ["cancelled", "failed"],
      ["garbage", "pending"],
      [null, "pending"],
      [42, "pending"],
    ];
    for (const [opencodeStatus, expected] of cases) {
      const s = state();
      const out = drain(
        toolEvent(`c_${String(opencodeStatus)}`, "bash", opencodeStatus, {
          input: { command: "ls" },
        }),
        s,
      );
      // Non-pending first sighting → start + progress; assert the progress status.
      const progress = out[out.length - 1];
      expect(
        (progress as { status?: string }).status,
        `status ${String(opencodeStatus)} → ${expected}`,
      ).toBe(expected);
    }
  });

  test("tool kind mapping (bash/read/edit/write/grep/glob/webfetch/websearch/task/unknown)", () => {
    const cases: Array<[string, string]> = [
      ["bash", "execute"],
      ["read", "read"],
      ["edit", "edit"],
      ["write", "edit"],
      ["grep", "search"],
      ["glob", "search"],
      ["webfetch", "fetch"],
      ["websearch", "search"],
      ["task", "other"],
      ["unknown_tool", "other"],
    ];
    for (const [tool, expectedKind] of cases) {
      const s = state();
      const out = drain(toolEvent(`c_${tool}`, tool, "pending"), s);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ kind: expectedKind });
    }
  });
});

// ───────────────────── context usage / compaction ─────────────────────

describe("translateOpencodeEvent — context usage and compaction", () => {
  const TOKENS = {
    input: 100,
    output: 20,
    reasoning: 5,
    cache: { read: 30, write: 10 },
  };

  const msgUpdated = (extra: RawEvent) => ({
    type: "message.updated",
    properties: { info: { role: "assistant", id: "m1", sessionID: SESS, ...extra } },
  });

  test("message.updated with tokens emits one context_usage packet (sum incl. cache)", () => {
    const s = state();
    const out = drain(msgUpdated({ tokens: TOKENS, cost: 0.4 }), s);
    const usage = out.filter(
      (event) => isBuildPacket(event) && (event as { type?: string }).type === "context_usage",
    );
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ used_tokens: 165, cost: 0.4 });
  });

  test("zero tokens or missing tokens emit no usage; summary messages suppress usage", () => {
    const zero = state();
    expect(
      drain(
        msgUpdated({ tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
        zero,
      ),
    ).toEqual([]);
    const none = state();
    expect(drain(msgUpdated({}), none)).toEqual([]);

    const summary = state();
    const out = drain(msgUpdated({ tokens: TOKENS, summary: true }), summary);
    expect(out).toEqual([]);
    expect(summary.summaryMessageIds.has("m1")).toBe(true);
  });

  test("summary text deltas are suppressed", () => {
    const s = state();
    s.assistantMessageIds.add("sum1");
    s.summaryMessageIds.add("sum1");
    expect(
      drain(
        {
          type: "message.part.delta",
          properties: {
            sessionID: SESS,
            messageID: "sum1",
            partID: "p1",
            field: "text",
            delta: "This is the summary",
          },
        },
        s,
      ),
    ).toEqual([]);
  });

  test("session.compacted emits a compaction packet with the fetched summary text", () => {
    const s = state();
    s.summaryMessageIds.add("sum1");
    const { fetch } = fetchFrom({
      sum1: {
        info: { role: "assistant" },
        parts: [{ type: "text", text: "Recap" }],
      },
    });
    const out = drain(
      { type: "session.compacted", properties: { sessionID: SESS } },
      s,
      { fetchMessage: fetch },
    );
    const markers = out.filter(
      (event) => isBuildPacket(event) && (event as { type?: string }).type === "compaction",
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ summary: "Recap" });
  });
});

// ───────────────── informational / malformed inputs ─────────────────

describe("translateOpencodeEvent — informational and malformed events", () => {
  test("informational event types yield nothing", () => {
    for (const etype of [
      "server.connected",
      "server.heartbeat",
      "session.created",
      "session.next.agent.switched",
      "session.next.model.switched",
      "session.diff",
      "session.updated",
      "permission.replied",
      "completely.unknown.event",
    ]) {
      const s = state();
      expect(drain({ type: etype, properties: { sessionID: SESS } }, s), etype).toEqual([]);
    }
  });

  test("missing type / missing properties are ignored", () => {
    const s = state();
    expect(drain({ properties: {} }, s)).toEqual([]);
    expect(drain({ type: "message.updated" }, s)).toEqual([]);
  });
});

// ───────────────── subagent routing (parent/child _meta) ─────────────────

describe("translateOpencodeEvent — subagent routing", () => {
  const PARENT = "ses_PARENT";
  const CHILD = "ses_CHILD";
  const parentResolver = (id: string) => (id === CHILD ? PARENT : null);

  function childToolEvent(): RawEvent {
    return {
      type: "message.part.updated",
      properties: {
        sessionID: CHILD,
        part: {
          type: "tool",
          tool: "bash",
          callID: "toolu_x",
          state: {
            status: "completed",
            input: { command: "echo hi", description: "d" },
            output: "hi\n",
            metadata: { exit: 0 },
          },
          id: "prt_x",
          sessionID: CHILD,
          messageID: "msg_x",
        },
      },
    };
  }

  test("session.created for our child emits a subagent_started packet", () => {
    const s = new TurnState(PARENT);
    const out = drain(
      { type: "session.created", properties: { info: { id: CHILD, parentID: PARENT } } },
      s,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "subagent_started",
      subagent_session_id: CHILD,
      parent_session_id: PARENT,
    });
  });

  test("session.created for another parent is ignored", () => {
    const s = new TurnState(PARENT);
    expect(
      drain(
        { type: "session.created", properties: { info: { id: CHILD, parentID: "ses_OTHER" } } },
        s,
      ),
    ).toEqual([]);
  });

  test("descendant tool events are forwarded tagged with sessionId + parentSessionId", () => {
    const s = new TurnState(PARENT);
    const out = drain(childToolEvent(), s, { parentResolver });
    expect(out).toHaveLength(2);
    expect(isToolCallStart(out[0])).toBe(true);
    expect(isToolCallProgress(out[1])).toBe(true);
    for (const event of out) {
      const meta = (event as { _meta?: Record<string, unknown> })._meta;
      expect(meta).toMatchObject({
        sessionId: CHILD,
        parentSessionId: PARENT,
        toolName: "bash",
      });
    }
  });

  test("descendant text deltas stream tagged (hydration via fetchMessageBySession)", () => {
    const s = new TurnState(PARENT);
    const out = drain(
      {
        type: "message.part.delta",
        properties: {
          sessionID: CHILD,
          messageID: "msg_child",
          partID: "p_child_text",
          field: "text",
          delta: "child response",
        },
      },
      s,
      {
        parentResolver,
        fetchMessageBySession: (sessionId, messageId) => ({
          info: { id: messageId, sessionID: sessionId, role: "assistant" },
          parts: [{ id: "p_child_text", type: "text" }],
        }),
      },
    );
    expect(out).toHaveLength(1);
    expect(isAgentMessageChunk(out[0])).toBe(true);
    expect(out[0]).toMatchObject({
      content: { text: "child response" },
      _meta: { sessionId: CHILD, parentSessionId: PARENT },
    });
  });

  test("a child finish does not leak into the parent terminator", () => {
    const s = new TurnState(PARENT);
    drain(
      {
        type: "message.updated",
        properties: {
          sessionID: CHILD,
          info: { id: "msg_child", sessionID: CHILD, role: "assistant", finish: "max_tokens" },
        },
      },
      s,
      { parentResolver },
    );
    const out = drain({ type: "session.idle", properties: { sessionID: PARENT } }, s);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ stopReason: "end_turn" });
  });

  test("unrelated-session tool events drop without a parent resolver", () => {
    const s = new TurnState(PARENT);
    expect(drain(childToolEvent(), s)).toEqual([]);
    expect(drain(childToolEvent(), s, { parentResolver: () => null })).toEqual([]);
  });

  test("the parent's task tool event is tagged with its spawned subagent session", () => {
    const s = new TurnState(PARENT);
    const out = drain(
      {
        type: "message.part.updated",
        properties: {
          sessionID: PARENT,
          part: {
            type: "tool",
            tool: "task",
            callID: "toolu_t",
            state: {
              status: "completed",
              input: { description: "explore", prompt: "Explore the auth code", subagent_type: "general" },
            },
            id: "prt_t",
            sessionID: PARENT,
            messageID: "msg_t",
          },
        },
      },
      s,
      { childrenResolver: (parent) => (parent === PARENT ? [CHILD] : []) },
    );
    expect(out.length).toBeGreaterThanOrEqual(1);
    for (const event of out) {
      const meta = (event as { _meta?: Record<string, unknown> })._meta;
      expect(meta).toMatchObject({ subagentSessionId: CHILD, toolName: "task" });
    }
  });

  test("a non-task parent tool event is not tagged even with a children resolver", () => {
    const s = new TurnState(PARENT);
    const out = drain(
      {
        type: "message.part.updated",
        properties: {
          sessionID: PARENT,
          part: {
            type: "tool",
            tool: "bash",
            callID: "toolu_b",
            state: { status: "completed", input: { command: "ls" } },
            id: "prt_b",
            sessionID: PARENT,
            messageID: "msg_b",
          },
        },
      },
      s,
      { childrenResolver: () => [CHILD] },
    );
    expect(out.length).toBeGreaterThanOrEqual(1);
    for (const event of out) {
      const meta = (event as { _meta?: Record<string, unknown> })._meta;
      expect(meta?.subagentSessionId).toBeUndefined();
      expect(meta).toMatchObject({ toolName: "bash" });
    }
  });
});

// ───────────────── transport error codes -2 / -3 ─────────────────

/**
 * The transport-level sentinels live in OpencodeServeClient's bus loops, not the pure
 * translator. Driven at the seam: a stub PodEventBus (real SubscriberQueue) + stubbed fetch,
 * so only the network boundary is faked.
 */
function fakeBus(overrides: { closed?: boolean; streamReady?: boolean } = {}): PodEventBus {
  return {
    streamReady: overrides.streamReady ?? false,
    isClosed: () => overrides.closed ?? false,
    subscribe: (sessionId: string): PodSubscription => ({
      sessionId,
      queue: new SubscriberQueue(100),
    }),
    unsubscribe: () => undefined,
    parentOf: () => null,
    listChildren: () => [],
  } as unknown as PodEventBus;
}

describe("OpencodeServeClient — transport error codes", () => {
  const config = loadCraftConfig({});
  const okFetch = async () => new Response("{}", { status: 200 });

  test("a closed event bus yields the transport error (code -3) before the prompt", async () => {
    const client = new OpencodeServeClient({
      baseUrl: "http://opencode.test",
      config,
      eventBus: fakeBus({ closed: true }),
      fetchImpl: okFetch,
    });
    const events: Array<SandboxEvent | BuildPacket> = [];
    for await (const event of client.sendMessage("ses_x", "hello", {
      directory: "/workspace/sessions/cs-x",
    })) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(isSandboxError(events[0])).toBe(true);
    expect(events[0]).toMatchObject({
      code: TURN_ERROR_CODE_TRANSPORT,
      message: "event bus closed before /event stream became ready",
    });
  });

  test("inactivity expiry yields the activity-timeout error (code -2, recoverable)", async () => {
    const client = new OpencodeServeClient({
      baseUrl: "http://opencode.test",
      config,
      eventBus: fakeBus({ streamReady: true }),
      fetchImpl: okFetch,
    });
    const events: Array<SandboxEvent | BuildPacket> = [];
    for await (const event of client.sendMessage("ses_x", "hello", {
      directory: "/workspace/sessions/cs-x",
      timeoutMs: 1, // expire on the first idle window
    })) {
      events.push(event);
    }
    const errors = events.filter(isSandboxError);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: TURN_ERROR_CODE_TIMEOUT,
      message: "Timeout waiting for activity",
    });
  });
});
