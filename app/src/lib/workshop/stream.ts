import { useEffect, useRef, useState } from "react";
import { workshopEventsUrl, type WorkshopStreamEvent } from "./client";
import { createStreamMachine } from "./stream-machine";

/**
 * The workshop stream, consumed: an EventSource that survives drops, replays, and bad data.
 *
 * THREE RULES (plan v2.2, hard discipline):
 *
 * 1. RECONNECT WITH Last-Event-ID. EventSource retries on its own; the URL we re-open carries
 *    the last seq we rendered, and the server answers everything after it — a dropped
 *    connection costs latency, never events.
 * 2. DEDUPE BY SEQ. A reconnect races the last delivered events; anything at or below the
 *    highest seq we have is a duplicate and is dropped, so the view never stutters.
 * 3. ONE BAD MESSAGE NEVER KILLS THE STREAM. `parseWorkshopStreamEvent` throws SyntaxError on
 *    malformed JSON; the catch skips that message and keeps the stream — a corrupt frame from
 *    a proxy or a mid-deploy version skew is one lost event, not a dead view.
 *
 * The hook ends when `active` turns false (the turn settled) — no zombie connections.
 */
export function useWorkshopStream(input: {
  channelId: string;
  /** Whether to hold the stream open: the turn is running or expected to run. */
  active: boolean;
  /** Injection for tests: the EventSource constructor, pointed at a controllable stream. */
  sourceFactory?: typeof EventSource;
}): {
  events: WorkshopStreamEvent[];
  connected: boolean;
} {
  const { channelId, active } = input;
  const EventSourceConstructor = input.sourceFactory ?? EventSource;
  const [events, setEvents] = useState<WorkshopStreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  /**
   * The machine owns the three rules (dedupe, survive-bad-frame, resume cursor); the hook owns
   * only the connection lifecycle. One brain, tested without a renderer.
   */
  const machineRef = useRef(createStreamMachine());

  useEffect(() => {
    if (!active) {
      setConnected(false);
      return;
    }
    const machine = machineRef.current;
    let closed = false;
    let source: EventSource | null = null;

    const open = () => {
      if (closed) return;
      source = new EventSourceConstructor(
        workshopEventsUrl(channelId, machine.resumeFrom()),
      );
      source.onopen = () => {
        if (!closed) setConnected(true);
      };
      source.onerror = () => {
        // EventSource retries on its own with the SAME url; ours must carry a fresh
        // Last-Event-ID, so close and reopen with the cursor we have. The 3s delay is the
        // backoff — fast enough to feel live, slow enough to let a restarting server breathe.
        setConnected(false);
        source?.close();
        if (!closed) {
          retry = setTimeout(open, RECONNECT_DELAY_MS) as unknown as number;
        }
      };
      source.onmessage = (message: MessageEvent<string>) => {
        // The machine swallows the malformed frame (counts it, keeps going): the try/catch
        // lives there, once, where every rule of the stream lives.
        if (machine.ingest(message.data)) {
          setEvents(machine.events);
        }
      };
    };

    let retry: number | undefined;
    open();
    return () => {
      closed = true;
      if (retry !== undefined) clearTimeout(retry);
      source?.close();
      setConnected(false);
    };
  }, [channelId, active, EventSourceConstructor]);

  // A fresh turn run resets the cursor and the view: seqs are turn-scoped on the server.
  useEffect(() => {
    if (!active) {
      machineRef.current = createStreamMachine();
      setEvents([]);
    }
  }, [active]);

  return { events, connected };
}

/** The reconnect backoff: fast enough to feel live, slow enough for a restarting server. */
export const RECONNECT_DELAY_MS = 3_000;
