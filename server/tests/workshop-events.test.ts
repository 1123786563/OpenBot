import { describe, expect, test } from "bun:test";
import {
  createEventSink,
  replaySince,
  sseBlock,
  streamEventsResponse,
  translate,
} from "../src/workshop/events";
import { createTurnEventBus } from "../src/workshop/bus";
import type { WorkshopStore } from "../src/workshop/store";
import type { TranslatedEvent } from "../src/codesandbox/gateway";

/** The captured sample shapes (docs/sse-samples.md), as gateway events. */
const SAMPLES: Array<{ family: string; payload: Record<string, unknown> }> = [
  {
    family: "message_chunk",
    payload: {
      type: "message.part.delta",
      properties: { delta: "2+2 等于 4。", field: "text" },
    },
  },
  {
    family: "thought",
    payload: {
      type: "message.part.updated",
      properties: { part: { type: "reasoning", text: "先算加法" } },
    },
  },
  {
    family: "tool_call",
    payload: {
      type: "message.part.updated",
      properties: {
        part: { type: "tool", tool: "bash", state: { status: "running" } },
      },
    },
  },
  {
    family: "progress",
    payload: {
      type: "session.status",
      properties: { status: { type: "busy" } },
    },
  },
  {
    family: "prompt_response",
    payload: { type: "session.idle", properties: { sessionID: "ses_S" } },
  },
];

/** Rows in memory, seqs dense per turn — the store's two duties for this file. */
function fakeStore(rowsByTurn: Map<string, Array<{ seq: number; type: string; payload: Record<string, unknown> }>>) {
  return {
    async appendEvent(input: { turnId: string; type: string; payload: Record<string, unknown> }) {
      const list = rowsByTurn.get(input.turnId) ?? [];
      const row = { seq: list.length + 1, type: input.type, payload: input.payload };
      list.push(row);
      rowsByTurn.set(input.turnId, list);
      return row as never;
    },
    async readEventsSince(turnId: string, seq: number, limit = 500) {
      return (rowsByTurn.get(turnId) ?? []).filter((row) => row.seq > seq).slice(0, limit) as never;
    },
  } as unknown as WorkshopStore;
}

describe("translate (the S1 sample set)", () => {
  test("each captured family translates to its wire shape", () => {
    const chunk = translate(1, "message_chunk", SAMPLES[0]!.payload);
    expect(chunk).toEqual({
      seq: 1,
      type: "message_chunk",
      text: "2+2 等于 4。",
    });

    const thought = translate(2, "thought", SAMPLES[1]!.payload);
    expect(thought.type).toBe("thought");
    if (thought.type === "thought") expect(thought.text).toBe("先算加法");

    const tool = translate(3, "tool_call", SAMPLES[2]!.payload);
    expect(tool.type).toBe("tool_call");
    if (tool.type === "tool_call") {
      expect(tool.tool).toBe("bash");
      expect(tool.arguments).toMatchObject({ status: "running" });
    }

    const progress = translate(4, "progress", SAMPLES[3]!.payload);
    if (progress.type === "progress") expect(progress.label).toBe("busy");

    const done = translate(5, "prompt_response", SAMPLES[4]!.payload);
    expect(done.type).toBe("prompt_response");
  });

  test("an unclassified family becomes unknown, not a throw", () => {
    const event = translate(9, "subagent.spawned", { anything: true });
    expect(event.type).toBe("unknown");
    if (event.type === "unknown") {
      expect(event.raw).toEqual({ anything: true });
    }
    expect(() => translate(10, "future.thing", {})).not.toThrow();
  });
});

describe("the event sink", () => {
  test("persists, pings the bus, and returns the wire shape with the row's seq", async () => {
    const rows = new Map<string, Array<{ seq: number; type: string; payload: Record<string, unknown> }>>();
    const store = fakeStore(rows);
    const bus = createTurnEventBus(null, {
      reader: {
        readEventsSince: async (turnId, seq) =>
          (rows.get(turnId) ?? []).filter((r) => r.seq > seq) as never,
      },
      // No scheduler needed: publish on a degraded bus is a no-op.
      schedule: () => () => undefined,
    });
    const sink = createEventSink(store, bus);

    const first = await sink.append("t1", {
      family: "message_chunk",
      eventId: "e1",
      payload: SAMPLES[0]!.payload,
    } as TranslatedEvent);
    const second = await sink.append("t1", {
      family: "progress",
      eventId: "e2",
      payload: SAMPLES[3]!.payload,
    } as TranslatedEvent);
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);

    // The replay reads exactly what was persisted, in order.
    const replayed = await replaySince(store, "t1", 0);
    expect(replayed.map((event) => event.seq)).toEqual([1, 2]);
    expect(replayed.map((event) => event.type)).toEqual([
      "message_chunk",
      "progress",
    ]);
  });
});

describe("the downstream response", () => {
  test("Last-Event-ID catch-up starts at the next seq, straight from the store", async () => {
    const rows = new Map<string, Array<{ seq: number; type: string; payload: Record<string, unknown> }>>([
      [
        "t1",
        [1, 2, 3].map((seq) => ({
          seq,
          type: "message_chunk",
          payload: { delta: `chunk-${seq}` },
        })),
      ],
    ]);
    const store = fakeStore(rows);
    const bus = createTurnEventBus(null, {
      reader: {
        readEventsSince: async (turnId, seq) =>
          (rows.get(turnId) ?? []).filter((r) => r.seq > seq) as never,
      },
      schedule: () => () => undefined,
    });
    const controller = new AbortController();
    const response = streamEventsResponse({
      bus,
      store,
      turnIds: ["t1"],
      lastEventId: 2,
      keepaliveMs: 60_000,
      stopSignal: controller.signal,
    });
    // The catch-up lands in start(); a beat for it, then abort closes the stream and text()
    // resolves on a bounded body rather than waiting for keepalives that never come.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const text = await response.text();
    expect(text).toContain("id: 3");
    expect(text).not.toContain("id: 1");
    expect(text).not.toContain("id: 2");
  });

  test("seqs are monotonically increasing on the wire", async () => {
    const rows = new Map<string, Array<{ seq: number; type: string; payload: Record<string, unknown> }>>([
      ["t1", [1, 2, 3, 4].map((seq) => ({ seq, type: "progress", payload: {} }))],
    ]);
    const store = fakeStore(rows);
    const bus = createTurnEventBus(null, {
      reader: {
        readEventsSince: async (turnId, seq) =>
          (rows.get(turnId) ?? []).filter((r) => r.seq > seq) as never,
      },
      schedule: () => () => undefined,
    });
    const controller = new AbortController();
    const response = streamEventsResponse({
      bus,
      store,
      turnIds: ["t1"],
      keepaliveMs: 60_000,
      stopSignal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const text = await response.text();
    const seqs = [...text.matchAll(/^id: (\d+)$/gm)].map((match) =>
      Number(match[1]),
    );
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  test("the degraded bus (poll mode) still delivers through the same response", async () => {
    // A live append after the response starts: the poll fallback's reader is the same store,
    // so the subscriber's re-read picks it up even though no bus ping ever fires.
    const rows = new Map<string, Array<{ seq: number; type: string; payload: Record<string, unknown> }>>([
      ["t1", [{ seq: 1, type: "progress", payload: {} }]],
    ]);
    const store = fakeStore(rows);
    const ticks: Array<() => void> = [];
    const bus = createTurnEventBus(null, {
      reader: {
        readEventsSince: async (turnId, seq) =>
          (rows.get(turnId) ?? []).filter((r) => r.seq > seq) as never,
      },
      schedule: (callback) => {
        ticks.push(callback);
        return () => undefined;
      },
      pollIntervalMs: 1,
    });
    const controller = new AbortController();
    const response = streamEventsResponse({
      bus,
      store,
      turnIds: ["t1"],
      keepaliveMs: 60_000,
      stopSignal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const readChunk = async () => {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true }>((resolve) =>
          setTimeout(() => resolve({ done: true }), 100),
        ),
      ]);
      if (!chunk.done) seen += decoder.decode(chunk.value, { stream: true });
    };
    await readChunk(); // catch-up: seq 1
    expect(seen).toContain("id: 1");

    rows.get("t1")!.push({ seq: 2, type: "progress", payload: {} });
    for (const tick of ticks) tick(); // the poll fires
    await new Promise((resolve) => setTimeout(resolve, 20));
    await readChunk();
    expect(seen).toContain("id: 2");
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});

describe("sseBlock", () => {
  test("carries id, event, and the JSON body", () => {
    const bytes = sseBlock({ seq: 43, type: "message_chunk", text: "hi" });
    const text = new TextDecoder().decode(bytes);
    expect(text).toBe(
      `id: 43\nevent: message_chunk\ndata: {"seq":43,"type":"message_chunk","text":"hi"}\n\n`,
    );
  });
});
