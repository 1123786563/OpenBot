import type { WorkshopStreamEvent } from "./client";
import { parseWorkshopStreamEvent } from "./client";

/**
 * The stream's decision core, extracted from the hook so its three rules are testable without
 * a React renderer (the app's test convention is plain `bun test`, no DOM).
 *
 * The rules, once each:
 * - INGEST ONLY NEW SEQ: anything at or below the cursor is a replay the reconnect asked for
 *   and already has; it must not render twice.
 * - ONE BAD FRAME NEVER STOPS THE STREAM: `parseWorkshopStreamEvent` throws on malformed JSON
 *   and the machine records the skip, not the throw.
 * - THE CURSOR DRIVES RECONNECT: `resumeFrom` is what the next URL carries as Last-Event-ID.
 */
export type StreamMachine = {
  /** The events rendered so far, in seq order. */
  events: WorkshopStreamEvent[];
  /** The highest seq ingested; what a reconnect resumes from. */
  resumeFrom(): number | undefined;
  /** Frames the stream dropped because they would not parse. */
  skippedFrames: number;
  /** One `onmessage` data payload: parsed, deduped, ingested — or counted as skipped. */
  ingest(raw: string): WorkshopStreamEvent | null;
};

export function createStreamMachine(): StreamMachine {
  let events: WorkshopStreamEvent[] = [];
  let cursor = 0;
  let skipped = 0;

  return {
    get events() {
      return events;
    },
    get skippedFrames() {
      return skipped;
    },
    resumeFrom() {
      return cursor > 0 ? cursor : undefined;
    },
    ingest(raw) {
      let event: WorkshopStreamEvent;
      try {
        event = parseWorkshopStreamEvent(raw);
      } catch {
        // Malformed JSON is one lost frame, not a dead stream: count and keep listening.
        skipped += 1;
        return null;
      }
      if (event.seq <= 0 || event.seq <= cursor) return null; // Unusable or a replay.
      cursor = event.seq;
      events = [...events, event];
      return event;
    },
  };
}
