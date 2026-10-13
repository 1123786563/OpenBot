import { describe, expect, test } from "bun:test";
import {
  appendSubagentTextChunk,
  closeSubagentStreams,
  recordParentTaskToolCall,
  routeSubagentPacket,
  type SubagentRoute,
  type SubagentState,
  seedSubagent,
  upsertSubagentToolPacket,
} from "../../app/src/lib/craft/streaming-kernel";
import type {
  CraftStreamPacket,
  CraftToolCallProgress,
  CraftToolCallStart,
} from "../../app/src/lib/craft/types";

/**
 * The streaming reducer's `_meta` routing, driven as the pure functions the hook's reducer is a
 * thin wrapper over. The kernel module is import-free (types only), so these run from the server
 * suite without the app's fetch/React graph — the contract under test is the classification
 * (normal / child / parentTask) and the Map<ocSessionId, SubagentState> it drives.
 */

function chunk(
  text: string,
  _meta?: Record<string, unknown>,
): CraftStreamPacket {
  return {
    type: "agent_message_chunk",
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    timestamp: "2026-01-01T00:00:00.000Z",
    ...(_meta ? { _meta } : {}),
  };
}

function taskProgress(
  toolCallId: string,
  status: "in_progress" | "completed" | "failed",
  subagentSessionId: string,
): CraftStreamPacket {
  return {
    type: "tool_call_progress",
    sessionUpdate: "tool_call_update",
    toolCallId,
    title: "Running task",
    kind: "other",
    status,
    _meta: { toolName: "task", subagentSessionId },
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function toolStart(
  toolCallId: string,
  _meta?: Record<string, unknown>,
): CraftToolCallStart {
  return {
    type: "tool_call_start",
    sessionUpdate: "tool_call",
    toolCallId,
    title: "Running command",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "ls" },
    ...(_meta ? { _meta } : {}),
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function childToolProgress(toolCallId: string): CraftToolCallProgress {
  return {
    type: "tool_call_progress",
    sessionUpdate: "tool_call_update",
    toolCallId,
    title: "Running command",
    kind: "execute",
    status: "completed",
    rawOutput: { output: "file-a\nfile-b" },
    _meta: { sessionId: "oc-child", parentSessionId: "oc-parent" },
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// routeSubagentPacket — the three-way classification (onyx subagentRouting.ts)
// ---------------------------------------------------------------------------

describe("routeSubagentPacket", () => {
  test("events without _meta (the pre-subagent world) route normal", () => {
    expect(routeSubagentPacket(chunk("hi"))).toEqual({ kind: "normal" });
    expect(routeSubagentPacket(toolStart("t1"))).toEqual({ kind: "normal" });
  });

  test("_meta without routing keys routes normal (old events never crash)", () => {
    expect(routeSubagentPacket(chunk("hi", { toolName: "bash" }))).toEqual({
      kind: "normal",
    });
    // A sessionId alone is not a child — the parent pair must both be present.
    expect(routeSubagentPacket(chunk("hi", { sessionId: "oc-child" }))).toEqual(
      { kind: "normal" },
    );
  });

  test("sessionId + parentSessionId routes child", () => {
    const route: SubagentRoute = routeSubagentPacket(
      chunk("hi", { sessionId: "oc-child", parentSessionId: "oc-parent" }),
    );
    expect(route).toEqual({ kind: "child", sessionId: "oc-child" });
  });

  test("a tool packet carrying subagentSessionId routes parentTask", () => {
    const route: SubagentRoute = routeSubagentPacket(
      taskProgress("call-1", "in_progress", "oc-child"),
    );
    expect(route).toEqual({
      kind: "parentTask",
      sessionId: "oc-child",
      toolCallId: "call-1",
    });
  });

  test("subagentSessionId on a non-tool packet routes normal", () => {
    expect(
      routeSubagentPacket(chunk("hi", { subagentSessionId: "oc-child" })),
    ).toEqual({ kind: "normal" });
  });
});

// ---------------------------------------------------------------------------
// The subagent map: seed, transcript growth, completion inference
// ---------------------------------------------------------------------------

describe("subagent map", () => {
  test("seedSubagent registers a running entry once and never resets it", () => {
    let map = seedSubagent(new Map(), "oc-child");
    expect(map.get("oc-child")).toEqual({
      sessionId: "oc-child",
      parentToolCallId: null,
      status: "running",
      streamItems: [],
    });
    map = appendSubagentTextChunk(map, "oc-child", "text", "partial");
    map = seedSubagent(map, "oc-child"); // a duplicate announce must not wipe progress
    expect(map.get("oc-child")?.streamItems).toHaveLength(1);
  });

  test("child text chunks merge into one streaming block, thinking separates", () => {
    let map = seedSubagent(new Map(), "oc-child");
    map = appendSubagentTextChunk(map, "oc-child", "text", "work");
    map = appendSubagentTextChunk(map, "oc-child", "text", "ing");
    // While the text block is the open one, it is still streaming.
    expect(map.get("oc-child")?.streamItems).toHaveLength(1);
    expect(map.get("oc-child")?.streamItems[0]).toMatchObject({
      kind: "text",
      text: "working",
      streaming: true,
    });
    // A thinking chunk settles the text block and opens its own.
    map = appendSubagentTextChunk(map, "oc-child", "thinking", "hmm");
    const items = map.get("oc-child")?.streamItems ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "text",
      text: "working",
      streaming: false,
    });
    expect(items[1]).toMatchObject({
      kind: "thinking",
      text: "hmm",
      streaming: true,
    });
  });

  test("a child event that arrives before its announce still lands (entry auto-created)", () => {
    let map = new Map<string, SubagentState>();
    map = appendSubagentTextChunk(map, "oc-child", "text", "early");
    expect(map.get("oc-child")?.streamItems[0]).toMatchObject({
      kind: "text",
      text: "early",
    });
  });

  test("child tool packets append then update in place", () => {
    let map = seedSubagent(new Map(), "oc-child");
    map = upsertSubagentToolPacket(
      map,
      "oc-child",
      toolStart("t1", {
        sessionId: "oc-child",
        parentSessionId: "oc-parent",
      }),
    );
    map = upsertSubagentToolPacket(map, "oc-child", childToolProgress("t1"));
    const items = map.get("oc-child")?.streamItems ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "tool",
      key: "t1",
      status: "completed",
      rawOutput: { output: "file-a\nfile-b" },
    });
  });

  test("the task card claims its subagent and infers completion (onyx markSubagentComplete)", () => {
    let map = seedSubagent(new Map(), "oc-child");
    map = recordParentTaskToolCall(map, "call-1", "oc-child", "in_progress");
    expect(map.get("oc-child")).toMatchObject({
      parentToolCallId: "call-1",
      status: "running",
    });
    map = recordParentTaskToolCall(map, "call-1", "oc-child", "completed");
    expect(map.get("oc-child")?.status).toBe("done");
    // A late non-terminal progress after completion does not un-complete the subagent.
    map = recordParentTaskToolCall(map, "call-1", "oc-child", "in_progress");
    expect(map.get("oc-child")?.status).toBe("done");
  });

  test("a failed task card fails its subagent", () => {
    let map = seedSubagent(new Map(), "oc-child");
    map = recordParentTaskToolCall(map, "call-1", "oc-child", "failed");
    expect(map.get("oc-child")?.status).toBe("failed");
  });

  test("parallel tasks keep distinct children (claim by call id)", () => {
    let map = seedSubagent(new Map(), "oc-a");
    map = seedSubagent(map, "oc-b");
    map = recordParentTaskToolCall(map, "call-1", "oc-a", "in_progress");
    map = recordParentTaskToolCall(map, "call-2", "oc-b", "in_progress");
    map = recordParentTaskToolCall(map, "call-1", "oc-a", "completed");
    expect(map.get("oc-a")?.status).toBe("done");
    expect(map.get("oc-b")?.status).toBe("running");
    expect(map.get("oc-b")?.parentToolCallId).toBe("call-2");
  });

  test("closeSubagentStreams settles every open streaming block", () => {
    let map = seedSubagent(new Map(), "oc-child");
    map = appendSubagentTextChunk(map, "oc-child", "text", "tail");
    expect(map.get("oc-child")?.streamItems[0]).toMatchObject({
      kind: "text",
      streaming: true,
    });
    map = closeSubagentStreams(map);
    expect(map.get("oc-child")?.streamItems[0]).toMatchObject({
      kind: "text",
      streaming: false,
    });
  });
});

// ---------------------------------------------------------------------------
// One turn's end-to-end packet sequence, folded by hand the way the reducer
// wires the kernel calls together.
// ---------------------------------------------------------------------------

describe("a full subagent lifecycle", () => {
  test("announce → child stream → parent task card → completion", () => {
    let map = new Map<string, SubagentState>();
    // 1. subagent_started packet
    map = seedSubagent(map, "oc-child");
    // 2. child text + thinking + tool
    map = appendSubagentTextChunk(map, "oc-child", "text", "investigating");
    map = appendSubagentTextChunk(map, "oc-child", "thinking", "plan");
    map = upsertSubagentToolPacket(
      map,
      "oc-child",
      toolStart("t1", {
        sessionId: "oc-child",
        parentSessionId: "oc-parent",
      }),
    );
    // 3. parent task card claims the child, then completes it
    map = recordParentTaskToolCall(map, "call-1", "oc-child", "in_progress");
    map = recordParentTaskToolCall(map, "call-1", "oc-child", "completed");
    // 4. turn ends
    map = closeSubagentStreams(map);

    const subagent = map.get("oc-child");
    expect(subagent).toBeDefined();
    expect(subagent?.status).toBe("done");
    expect(subagent?.parentToolCallId).toBe("call-1");
    expect(subagent?.streamItems.map((item) => item.kind)).toEqual([
      "text",
      "thinking",
      "tool",
    ]);
    expect(
      subagent?.streamItems.every(
        (item) => !("streaming" in item && item.streaming),
      ),
    ).toBe(true);
  });
});
