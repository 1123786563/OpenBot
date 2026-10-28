import type { BaseEvent } from "@ag-ui/core";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { createProducedMessageCollector } from "../src/mastra/conversation-runtime";

/*
 * FIX-OCR3 (O3-H1): the produced-message fold is "exactly what a client reconstructing state
 * from the same event stream would show" — and a live client shows the metadata the START
 * frame carried, which is where the run's answer-basis stamp rides. On BASE the fold kept
 * {id, role, content, toolCalls} only, so the stamp never reached the stored envelope and a
 * refreshed transcript lost every basis row.
 */

const textStartWithBasis = {
  type: "TEXT_MESSAGE_START",
  messageId: "engine-answer-1",
  role: "assistant",
  metadata: {
    openbot: {
      personalMemoryBasis: [{ id: "pref-1", kind: "general-preference" }],
    },
  },
} as unknown as BaseEvent;

describe("the produced-message collector keeps the START frame's metadata (O3-H1)", () => {
  test("a basis-stamped assistant message survives the fold with its metadata", () => {
    const collector = createProducedMessageCollector();
    collector.push(textStartWithBasis);
    collector.push({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "engine-answer-1",
      delta: "the answer",
    } as unknown as BaseEvent);
    collector.push({
      type: "TEXT_MESSAGE_END",
      messageId: "engine-answer-1",
    } as unknown as BaseEvent);
    collector.push({ type: "RUN_FINISHED" } as unknown as BaseEvent);
    const messages = collector.snapshot();
    expect(messages).toHaveLength(1);
    expect((messages[0] as { metadata?: unknown }).metadata).toEqual({
      openbot: {
        personalMemoryBasis: [{ id: "pref-1", kind: "general-preference" }],
      },
    });
  });

  test("a plain START frame keeps the fold's old shape", () => {
    const collector = createProducedMessageCollector();
    collector.push({
      type: "TEXT_MESSAGE_START",
      messageId: "engine-answer-2",
      role: "assistant",
    } as unknown as BaseEvent);
    collector.push({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "engine-answer-2",
      delta: "no stamp",
    } as unknown as BaseEvent);
    collector.push({ type: "RUN_FINISHED" } as unknown as BaseEvent);
    const messages = collector.snapshot();
    expect(messages).toHaveLength(1);
    expect((messages[0] as { metadata?: unknown }).metadata).toBeUndefined();
  });
});
