import { describe, expect, test } from "bun:test";
import { frameFiring } from "@openbot/shared/routine-firing";
import type { VisibleChatItem } from "../src/components/channels/chat-messages";
import { personBursts } from "../src/components/channels/chat-transcript";

/**
 * Which rows of a transcript belong to a burst of consecutive sends, and how many MESSAGES that
 * burst is — the count a reader is shown on the chip above it. A row is not a message: one send
 * with a file and a caption is two rows, and a routine firing is not a send at all.
 */

const said = (id: string, text = "find my invoices"): VisibleChatItem => ({
  kind: "text",
  id,
  role: "user",
  text,
});
const answered = (id: string): VisibleChatItem => ({
  kind: "text",
  id,
  role: "assistant",
  text: "Gmail isn't connected yet.",
});
const files = (id: string): VisibleChatItem => ({
  kind: "attachments",
  id: `${id}:attachments`,
  attachments: [],
});

describe("personBursts", () => {
  test("consecutive sends are one burst, counted in messages", () => {
    const items = [answered("a0"), said("u1"), said("u2"), answered("a1")];
    const bursts = personBursts(items);
    expect(bursts.get("u1")).toEqual({ position: "start", size: 2 });
    expect(bursts.get("u2")).toEqual({ position: "end", size: 2 });
  });

  test("three or more sends keep their middle rows", () => {
    const items = [said("u1"), said("u2"), said("u3")];
    const bursts = personBursts(items);
    expect(bursts.get("u1")).toEqual({ position: "start", size: 3 });
    expect(bursts.get("u2")).toEqual({ position: "middle", size: 3 });
    expect(bursts.get("u3")).toEqual({ position: "end", size: 3 });
  });

  test("a send apart from the next is a single", () => {
    const items = [said("u1"), answered("a1"), said("u2")];
    const bursts = personBursts(items);
    expect(bursts.get("u1")).toEqual({ position: "single", size: 1 });
    expect(bursts.get("u2")).toEqual({ position: "single", size: 1 });
  });

  test("a captioned file is ONE message, not a burst of two", () => {
    const items = [answered("a0"), files("u1"), said("u1"), answered("a1")];
    const bursts = personBursts(items);
    expect(bursts.get("u1:attachments")).toEqual({
      position: "start",
      size: 1,
    });
    expect(bursts.get("u1")).toEqual({ position: "end", size: 1 });
  });

  test("a burst counts the messages in it, not the rows", () => {
    // Two sends, the second carrying a file: three rows, two messages.
    const items = [said("u1"), files("u2"), said("u2")];
    const bursts = personBursts(items);
    expect(bursts.get("u1")).toEqual({ position: "start", size: 2 });
    expect(bursts.get("u2:attachments")).toEqual({
      position: "middle",
      size: 2,
    });
    expect(bursts.get("u2")).toEqual({ position: "end", size: 2 });
  });

  test("a routine firing between sends ends the burst, rather than joining it", () => {
    const items = [
      said("u1"),
      said("f1", frameFiring("Summarise the support queue.")),
      said("u2"),
    ];
    const bursts = personBursts(items);
    expect(bursts.get("u1")).toEqual({ position: "single", size: 1 });
    expect(bursts.get("f1")).toBeUndefined();
    expect(bursts.get("u2")).toEqual({ position: "single", size: 1 });
  });

  test("the Bot's rows are never part of a burst", () => {
    const items = [said("u1"), answered("a1"), files("u2")];
    const bursts = personBursts(items);
    expect(bursts.get("a1")).toBeUndefined();
    expect(bursts.get("u2:attachments")).toEqual({
      position: "single",
      size: 1,
    });
  });
});
