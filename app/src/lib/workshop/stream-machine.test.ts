import { describe, expect, test } from "bun:test";
import { createStreamMachine } from "./stream-machine";

/** One wire frame, as the server's sseBlock writes it: {"seq":N,"type":...}. */
const frame = (seq: number, type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ seq, type, ...extra });

describe("the stream machine", () => {
  test("ingests in order and carries the cursor for reconnect", () => {
    const machine = createStreamMachine();
    expect(machine.ingest(frame(1, "progress", { label: "busy" }))).not.toBeNull();
    expect(machine.ingest(frame(2, "message_chunk", { text: "Hi" }))).not.toBeNull();
    expect(machine.resumeFrom()).toBe(2);
    expect(machine.events.map((event) => event.seq)).toEqual([1, 2]);
  });

  test("a reconnect's replay at or below the cursor never renders twice", () => {
    const machine = createStreamMachine();
    machine.ingest(frame(1, "progress"));
    machine.ingest(frame(2, "message_chunk", { text: "a" }));
    // The server replays 2 (Last-Event-ID races the last delivery), then continues.
    expect(machine.ingest(frame(2, "message_chunk", { text: "a" }))).toBeNull();
    expect(machine.ingest(frame(1, "progress"))).toBeNull();
    const next = machine.ingest(frame(3, "message_chunk", { text: "b" }));
    expect(next?.seq).toBe(3);
    expect(machine.events).toHaveLength(3); // 1, 2, 3 — no duplicate in between
  });

  test("one malformed frame is counted and skipped, never thrown", () => {
    const machine = createStreamMachine();
    machine.ingest(frame(1, "progress"));
    expect(() => machine.ingest("{not json")).not.toThrow();
    expect(machine.ingest("{not json")).toBeNull();
    expect(machine.skippedFrames).toBe(2);
    // The stream lives on: the very next frame lands.
    expect(machine.ingest(frame(2, "prompt_response", { text: "done" }))).not.toBeNull();
    expect(machine.events).toHaveLength(2);
  });

  test("an unknown event type stays an event (unknown), not an error", () => {
    const machine = createStreamMachine();
    const event = machine.ingest(frame(5, "future_kind", { anything: true }));
    expect(event).toMatchObject({ seq: 5, type: "unknown" });
    expect(machine.events[0]?.type).toBe("unknown");
  });

  test("resumeFrom is undefined before any event: the first connect needs no cursor", () => {
    const machine = createStreamMachine();
    expect(machine.resumeFrom()).toBeUndefined();
    machine.ingest(frame(1, "progress"));
    expect(machine.resumeFrom()).toBe(1);
  });
});
