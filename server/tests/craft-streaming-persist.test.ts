import { describe, expect, test } from "bun:test";
import {
  compactionPacket,
  contextUsagePacket,
} from "../src/craft/events/packets";
import { SSEKeepalive } from "../src/craft/events/types";
import {
  BuildStreamingState,
  finalizePersist,
  persistSandboxEvent,
} from "../src/craft/streaming";
import type { CraftMessageRow, CraftStore } from "../src/craft/store";

/**
 * What persistSandboxEvent actually writes — port of onyx
 * `tests/external_dependency_unit/craft/test_streaming_persistence.py` (the persistence gating)
 * and `session/test_streaming_state.py` (chunk flush / finalize semantics), driven directly
 * against an in-memory store the way those suites stub create_message.
 *
 * The落库 rules under contract: message/thought chunks accumulate and flush on type/routing
 * change and at finalize; tool_call_start never persists; tool_call_progress persists only on
 * completed/failed — except TodoWrite (title "Updating todos", the translator's title for
 * todowrite), which persists every update; a completed Task sub-agent call additionally emits a
 * synthetic agent_message with `<task_metadata>` stripped; agent_plan_update upserts one row per
 * turn; context_usage is captured per event and persisted exactly once at finalize.
 */

type RecordedRow = {
  id: string;
  sessionId: string;
  type: string;
  turnIndex: number;
  messageMetadata: Record<string, unknown>;
};

function fakeStore() {
  const rows = new Map<string, RecordedRow>();
  const planUpserts: Array<Record<string, unknown>> = [];
  let nextId = 0;
  const mint = (
    sessionId: string,
    type: string,
    turnIndex: number,
    messageMetadata: Record<string, unknown>,
  ): RecordedRow => {
    const row = {
      id: `cm-${nextId++}`,
      sessionId,
      type,
      turnIndex,
      messageMetadata,
    };
    rows.set(row.id, row);
    return row;
  };
  const store: CraftStore = {
    async createMessage(input) {
      return mint(
        input.sessionId,
        input.type,
        input.turnIndex,
        input.messageMetadata,
      ) as unknown as CraftMessageRow;
    },
    async updateMessage(messageId, messageMetadata) {
      const row = rows.get(messageId);
      if (!row) return undefined;
      row.messageMetadata = messageMetadata;
      return row as unknown as CraftMessageRow;
    },
    async upsertAgentPlan(input) {
      planUpserts.push(input);
      if (input.existingPlanId) {
        const existing = rows.get(input.existingPlanId);
        if (existing) {
          existing.messageMetadata = input.planMetadata;
          return existing as unknown as CraftMessageRow;
        }
      }
      const found = [...rows.values()].find(
        (row) =>
          row.sessionId === input.sessionId &&
          row.turnIndex === input.turnIndex &&
          row.messageMetadata.type === "agent_plan_update",
      );
      if (found) {
        found.messageMetadata = input.planMetadata;
        return found as unknown as CraftMessageRow;
      }
      return mint(
        input.sessionId,
        "assistant",
        input.turnIndex,
        input.planMetadata,
      ) as unknown as CraftMessageRow;
    },
  } as unknown as CraftStore;
  /** Insertion-ordered rows — the transcript order assertions read this. */
  return { store, rows: () => [...rows.values()], planUpserts };
}

const SESSION = "cs-sess";

const textChunk = (text: string, meta?: Record<string, unknown>) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
  ...(meta ? { _meta: meta } : {}),
});

const thoughtChunk = (text: string, meta?: Record<string, unknown>) => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
  ...(meta ? { _meta: meta } : {}),
});

const toolProgress = (
  toolCallId: string,
  title: string,
  status: string,
  extra: Record<string, unknown> = {},
) => ({
  sessionUpdate: "tool_call_update",
  toolCallId,
  title,
  kind: "other",
  status,
  ...extra,
});

const toolStart = (toolCallId: string, title: string) => ({
  sessionUpdate: "tool_call",
  toolCallId,
  title,
  kind: "other",
  status: "pending",
});

async function drive(
  events: Array<Record<string, unknown> | SSEKeepalive>,
  turnIndex = 0,
) {
  const harness = fakeStore();
  const state = new BuildStreamingState(turnIndex);
  for (const event of events) {
    await persistSandboxEvent(
      harness.store,
      SESSION,
      state,
      event as Parameters<typeof persistSandboxEvent>[3],
    );
  }
  return { harness, state };
}

// ───────────────────────── chunk flush ─────────────────────────

describe("persistSandboxEvent — chunk flush", () => {
  test("two bursts split by a completed tool → agent_message row, tool row, agent_message row", async () => {
    const { harness } = await drive([
      textChunk("Thinking"),
      textChunk(" about it..."),
      toolProgress("call_1", "Running command", "completed"),
      textChunk("Done"),
      textChunk(" with tool."),
      { stopReason: "end_turn" },
    ]);
    const rows = harness.rows().filter((row) => row.sessionId === SESSION);
    expect(rows).toHaveLength(3);
    expect(rows[0].messageMetadata).toMatchObject({
      type: "agent_message",
      content: { text: "Thinking about it..." },
    });
    expect(rows[1].messageMetadata).toMatchObject({
      type: "tool_call_progress",
      status: "completed",
      toolCallId: "call_1",
    });
    expect(rows[2].messageMetadata).toMatchObject({
      type: "agent_message",
      content: { text: "Done with tool." },
    });
  });

  test("thought chunks collapse into one agent_thought row and no agent_message row", async () => {
    const { harness } = await drive([
      thoughtChunk("Hmm, "),
      thoughtChunk("let me "),
      thoughtChunk("think."),
      { stopReason: "end_turn" },
    ]);
    const metadata = harness.rows().map((row) => row.messageMetadata);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toMatchObject({
      type: "agent_thought",
      content: { text: "Hmm, let me think." },
    });
  });

  test("finalize on clean stream end flushes pending chunks as one row", async () => {
    const harness = fakeStore();
    const state = new BuildStreamingState(0);
    await persistSandboxEvent(
      harness.store,
      SESSION,
      state,
      textChunk("part one. "),
    );
    await persistSandboxEvent(
      harness.store,
      SESSION,
      state,
      textChunk("part two."),
    );
    expect(harness.rows()).toHaveLength(0); // nothing mid-stream
    await finalizePersist(harness.store, SESSION, state);
    expect(harness.rows()).toHaveLength(1);
    expect(harness.rows()[0].messageMetadata).toMatchObject({
      type: "agent_message",
      content: { text: "part one. part two." },
    });
  });

  test("a routing-meta change splits bursts (parent vs subagent chunks)", async () => {
    const childMeta = { sessionId: "oc-child", parentSessionId: "oc-parent" };
    const { harness } = await drive([
      textChunk("parent text "),
      textChunk("more"),
      textChunk("child text", childMeta),
      { stopReason: "end_turn" },
    ]);
    const messages = harness
      .rows()
      .filter((row) => row.messageMetadata.type === "agent_message");
    expect(messages).toHaveLength(2);
    expect(messages[0].messageMetadata).toMatchObject({
      content: { text: "parent text more" },
    });
    expect(messages[0].messageMetadata._meta).toBeUndefined();
    expect(messages[1].messageMetadata).toMatchObject({
      content: { text: "child text" },
      _meta: childMeta,
    });
  });

  test("keepalives persist nothing; a type change flushes pending chunks even to a non-persisted type", async () => {
    const harness = fakeStore();
    const state = new BuildStreamingState(0);
    await persistSandboxEvent(
      harness.store,
      SESSION,
      state,
      textChunk("streaming"),
    );
    // Keepalive: complete no-op — chunks stay pending.
    await persistSandboxEvent(
      harness.store,
      SESSION,
      state,
      new SSEKeepalive(),
    );
    expect(harness.rows()).toHaveLength(0);
    // current_mode_update is not persisted itself, but it IS a type change, so the
    // pending burst flushes first (onyx parity — documented "subtle" in craft-risks §3.4).
    await persistSandboxEvent(harness.store, SESSION, state, {
      currentMode: { name: "default" },
    });
    expect(harness.rows()).toHaveLength(1);
    expect(harness.rows()[0].messageMetadata).toMatchObject({
      type: "agent_message",
      content: { text: "streaming" },
    });
    await finalizePersist(harness.store, SESSION, state);
    expect(harness.rows()).toHaveLength(1);
  });
});

// ───────────────────────── tool persistence gating ─────────────────────────

describe("persistSandboxEvent — tool persistence gating", () => {
  test("tool_call_start is stream-only: never persisted", async () => {
    const { harness } = await drive([
      toolStart("tc-1", "Running command"),
      { stopReason: "end_turn" },
    ]);
    expect(harness.rows()).toHaveLength(0);
  });

  test("completed tool progress persists one row", async () => {
    const { harness } = await drive([
      toolProgress("tc-1", "Running command", "completed", {
        rawInput: { command: "ls" },
        rawOutput: { output: "file1" },
      }),
      { stopReason: "end_turn" },
    ]);
    const rows = harness
      .rows()
      .filter((row) => row.messageMetadata.type === "tool_call_progress");
    expect(rows).toHaveLength(1);
    expect(rows[0].messageMetadata).toMatchObject({
      toolCallId: "tc-1",
      status: "completed",
      rawInput: { command: "ls" },
    });
  });

  test("failed tool progress persists one row (failed calls survive reload)", async () => {
    const { harness } = await drive([
      toolProgress("tc-1", "Running command", "failed", {
        rawOutput: { output: "ls: cannot access '/x': No such file" },
      }),
      { stopReason: "end_turn" },
    ]);
    const rows = harness
      .rows()
      .filter((row) => row.messageMetadata.type === "tool_call_progress");
    expect(rows).toHaveLength(1);
    expect(rows[0].messageMetadata).toMatchObject({
      toolCallId: "tc-1",
      status: "failed",
    });
  });

  test("in-progress tool progress does not persist — except TodoWrite", async () => {
    const { harness } = await drive([
      toolProgress("tc-1", "Running command", "in_progress"),
      { stopReason: "end_turn" },
    ]);
    expect(
      harness
        .rows()
        .filter((row) => row.messageMetadata.type === "tool_call_progress"),
    ).toEqual([]);
  });

  test("TodoWrite (title 'Updating todos') persists every progress update", async () => {
    const { harness } = await drive([
      toolProgress("tw-1", "Updating todos", "in_progress"),
      toolProgress("tw-1", "Updating todos", "in_progress"),
      toolProgress("tw-1", "Updating todos", "completed"),
      { stopReason: "end_turn" },
    ]);
    const rows = harness
      .rows()
      .filter(
        (row) =>
          row.messageMetadata.type === "tool_call_progress" &&
          row.messageMetadata.title === "Updating todos",
      );
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.messageMetadata.status)).toEqual([
      "in_progress",
      "in_progress",
      "completed",
    ]);
  });
});

// ───────────────────── task_output synthesis ─────────────────────

describe("persistSandboxEvent — task_output synthesis", () => {
  const taskCompleted = (output: string) =>
    toolProgress("task-1", "Running task", "completed", {
      rawInput: { subagent_type: "research" },
      rawOutput: { output },
      _meta: { toolName: "task" },
    });

  test("a completed Task call emits the tool row AND a synthetic agent_message (metadata stripped)", async () => {
    const taskOutputText = "Sub-agent completed analysis: 3 files changed.";
    const { harness } = await drive([
      taskCompleted(`${taskOutputText}<task_metadata>internal</task_metadata>`),
      { stopReason: "end_turn" },
    ]);
    const toolRows = harness
      .rows()
      .filter(
        (row) =>
          row.messageMetadata.type === "tool_call_progress" &&
          row.messageMetadata.title === "Running task",
      );
    expect(toolRows).toHaveLength(1);

    const synth = harness
      .rows()
      .filter(
        (row) =>
          row.messageMetadata.type === "agent_message" &&
          row.messageMetadata.source === "task_output",
      );
    expect(synth).toHaveLength(1);
    expect(synth[0].messageMetadata).toMatchObject({
      content: { text: taskOutputText },
    });
  });

  test("no output or output that strips to empty emits no synthetic row", async () => {
    const noOutput = await drive([
      toolProgress("task-2", "Running task", "completed", {
        rawInput: { subagent_type: "research" },
        _meta: { toolName: "task" },
      }),
      { stopReason: "end_turn" },
    ]);
    expect(
      noOutput.harness
        .rows()
        .filter((row) => row.messageMetadata.source === "task_output"),
    ).toEqual([]);

    const onlyMetadata = await drive([
      taskCompleted("<task_metadata>internal</task_metadata>"),
      { stopReason: "end_turn" },
    ]);
    expect(
      onlyMetadata.harness
        .rows()
        .filter((row) => row.messageMetadata.source === "task_output"),
    ).toEqual([]);
  });

  test("a non-task tool never emits a synthetic row even with output", async () => {
    const { harness } = await drive([
      toolProgress("tc-9", "Running command", "completed", {
        rawOutput: { output: "plain command output" },
      }),
      { stopReason: "end_turn" },
    ]);
    expect(
      harness
        .rows()
        .filter((row) => row.messageMetadata.source === "task_output"),
    ).toEqual([]);
  });
});

// ───────────────────────── plan upsert ─────────────────────────

describe("persistSandboxEvent — agent_plan_update upsert", () => {
  test("two updates in one turn → one row, latest entries", async () => {
    const { harness } = await drive([
      {
        sessionUpdate: "agent_plan_update",
        entries: [{ id: "1", status: "pending", content: "Step 1" }],
      },
      {
        sessionUpdate: "agent_plan_update",
        entries: [
          { id: "1", status: "completed", content: "Step 1" },
          { id: "2", status: "in_progress", content: "Step 2" },
        ],
      },
      { stopReason: "end_turn" },
    ]);
    const plans = harness
      .rows()
      .filter((row) => row.messageMetadata.type === "agent_plan_update");
    expect(plans).toHaveLength(1);
    expect(plans[0].messageMetadata.entries).toEqual([
      { id: "1", status: "completed", content: "Step 1" },
      { id: "2", status: "in_progress", content: "Step 2" },
    ]);
    // Both updates flowed through the upsert path; the second carried the row
    // id minted by the first (update-in-place, not a fresh insert).
    expect(harness.planUpserts).toHaveLength(2);
    expect(harness.planUpserts[0].existingPlanId ?? null).toBeNull();
    expect(harness.planUpserts[1].existingPlanId).toBe(plans[0].id);
  });

  test("plans in different turns land in different rows (turn-indexed)", async () => {
    const harness = fakeStore();
    const turn0 = new BuildStreamingState(0);
    const turn1 = new BuildStreamingState(1);
    await persistSandboxEvent(harness.store, SESSION, turn0, {
      sessionUpdate: "agent_plan_update",
      entries: [{ id: "1", status: "pending", content: "A" }],
    });
    await persistSandboxEvent(harness.store, SESSION, turn1, {
      sessionUpdate: "agent_plan_update",
      entries: [{ id: "1", status: "completed", content: "A" }],
    });
    const plans = harness
      .rows()
      .filter((row) => row.messageMetadata.type === "agent_plan_update");
    expect(plans).toHaveLength(2);
    expect(plans.map((row) => row.turnIndex)).toEqual([0, 1]);
  });
});

// ─────────────────── context_usage / compaction ───────────────────

describe("persistSandboxEvent — context_usage and compaction", () => {
  test("usage is captured (not persisted per event), never fragments text; finalize writes one row", async () => {
    const harness = fakeStore();
    const state = new BuildStreamingState(0);
    await persistSandboxEvent(
      harness.store,
      SESSION,
      state,
      textChunk("hello "),
    );
    await persistSandboxEvent(
      harness.store,
      SESSION,
      state,
      contextUsagePacket(100, 0.5),
    );
    await persistSandboxEvent(
      harness.store,
      SESSION,
      state,
      textChunk("world"),
    );
    await finalizePersist(harness.store, SESSION, state);

    const types = harness.rows().map((row) => row.messageMetadata.type);
    expect(types).toEqual(["agent_message", "context_usage"]);
    expect(harness.rows()[0].messageMetadata).toMatchObject({
      content: { text: "hello world" },
    });
    expect(harness.rows()[1].messageMetadata).toMatchObject({
      used_tokens: 100,
      cost: 0.5,
    });

    // A second finalize (the executor's except path) must not re-write the usage row.
    await finalizePersist(harness.store, SESSION, state);
    expect(harness.rows().map((row) => row.messageMetadata.type)).toEqual([
      "agent_message",
      "context_usage",
    ]);
  });

  test("the latest usage packet in a turn is the one persisted", async () => {
    const harness = fakeStore();
    const state = new BuildStreamingState(0);
    await persistSandboxEvent(
      harness.store,
      SESSION,
      state,
      contextUsagePacket(100, null),
    );
    await persistSandboxEvent(
      harness.store,
      SESSION,
      state,
      contextUsagePacket(250, 0.75),
    );
    await finalizePersist(harness.store, SESSION, state);
    const usage = harness
      .rows()
      .filter((row) => row.messageMetadata.type === "context_usage");
    expect(usage).toHaveLength(1);
    expect(usage[0].messageMetadata).toMatchObject({
      used_tokens: 250,
      cost: 0.75,
    });
  });

  test("a turn with no usage writes no usage row at finalize", async () => {
    const { harness } = await drive([
      textChunk("only text"),
      { stopReason: "end_turn" },
    ]);
    expect(
      harness
        .rows()
        .filter((row) => row.messageMetadata.type === "context_usage"),
    ).toEqual([]);
  });

  test("compaction flushes pending text first, then persists the marker row", async () => {
    const harness = fakeStore();
    const state = new BuildStreamingState(0);
    await persistSandboxEvent(
      harness.store,
      SESSION,
      state,
      textChunk("hello "),
    );
    await persistSandboxEvent(
      harness.store,
      SESSION,
      state,
      contextUsagePacket(100, null),
    );
    await persistSandboxEvent(
      harness.store,
      SESSION,
      state,
      textChunk("world"),
    );
    await persistSandboxEvent(
      harness.store,
      SESSION,
      state,
      compactionPacket("recap"),
    );
    await finalizePersist(harness.store, SESSION, state);

    const types = harness.rows().map((row) => row.messageMetadata.type);
    expect(types).toEqual(["agent_message", "compaction", "context_usage"]);
    expect(harness.rows()[0].messageMetadata).toMatchObject({
      content: { text: "hello world" },
    });
    expect(harness.rows()[1].messageMetadata).toMatchObject({
      summary: "recap",
    });
    expect(harness.rows()[2].messageMetadata).toMatchObject({
      used_tokens: 100,
    });
  });
});

// ───────────────────── non-persisted packet families ─────────────────────

describe("persistSandboxEvent — packets that never persist", () => {
  test("prompt_response, error, and current_mode_update write nothing", async () => {
    const { harness } = await drive([
      { stopReason: "end_turn" },
      { code: -1, message: "boom" },
      { currentMode: { name: "default" } },
    ]);
    expect(harness.rows()).toHaveLength(0);
  });
});
