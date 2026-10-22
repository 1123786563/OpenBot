/**
 * The workshop's SSE downstream: translate, persist, fan out, replay.
 *
 * THREE RULES THIS FILE ENFORCES (plan §3.5.4):
 *
 * 1. PERSIST BEFORE PUBLISH. An event is a `workshop_turn_events` row first — the seq it
 *    carries comes from that insert — and only then a bus ping. Redis carries a reminder, never
 *    the payload; a lost ping costs one poll's latency and can never lose an event.
 * 2. THE DATABASE IS THE REPLAY SOURCE. `Last-Event-ID` catch-up reads `seq > N` straight from
 *    the store and never touches the bus, so replay works with Redis degraded, absent, or on
 *    fire — and two replicas holding the same rows answer identically.
 * 3. THE WIRE CARRIES THE FIVE FAMILIES. The sandbox's native types were labelled at the
 *    wrapper (S2); `translate` maps them to the front-end's `WorkshopStreamEvent` shape, and
 *    unknown shapes stay events (`unknown`), because a stream must survive an event nobody
 *    has seen before.
 */
import type { TranslatedEvent } from "../codesandbox/types";
import type { TurnEventBus } from "./bus";
import type { WorkshopStore } from "./store";

/** What the front-end's parseWorkshopStreamEvent expects (F1's WorkshopStreamEvent). */
export type WorkshopStreamEvent =
  | { seq: number; type: "message_chunk"; text: string }
  | { seq: number; type: "thought"; text: string }
  | { seq: number; type: "tool_call"; tool: string; arguments: unknown }
  | { seq: number; type: "progress"; label: string }
  | { seq: number; type: "prompt_response"; text: string }
  | { seq: number; type: "subagent"; detail: unknown }
  | { seq: number; type: "unknown"; raw: unknown };

/**
 * One gateway event, plus its turn-scoped seq, as the wire carries it.
 */
export type SeqencedStreamEvent = WorkshopStreamEvent & { seq: number };

/** The opencode event's properties, whether the payload nests them or carries them flat. */
const propertiesOf = (
  payload: Record<string, unknown>,
): Record<string, unknown> => {
  const nested = payload["properties"];
  if (nested !== null && typeof nested === "object") {
    return nested as Record<string, unknown>;
  }
  return payload;
};

const textOf = (payload: Record<string, unknown>): string => {
  const properties = propertiesOf(payload);
  const delta = properties["delta"];
  if (typeof delta === "string") return delta;
  const part = properties["part"] as { text?: unknown } | undefined;
  if (typeof part?.text === "string") return part.text;
  return "";
};

const labelOf = (payload: Record<string, unknown>): string => {
  const properties = propertiesOf(payload);
  const status = properties["status"] as { type?: unknown } | undefined;
  if (typeof status?.type === "string") return status.type;
  return "working";
};

/**
 * A persisted event → the wire shape. `seq` is already assigned by the insert; the mapping is
 * pure, so the replay path and the live path render identically.
 */
export function translate(
  seq: number,
  family: string,
  payload: Record<string, unknown>,
): WorkshopStreamEvent {
  switch (family) {
    case "message_chunk":
      return { seq, type: "message_chunk", text: textOf(payload) };
    case "thought":
      return { seq, type: "thought", text: textOf(payload) };
    case "tool_call": {
      const part = propertiesOf(payload)["part"] as
        | { tool?: unknown; state?: unknown }
        | undefined;
      return {
        seq,
        type: "tool_call",
        tool: typeof part?.tool === "string" ? part.tool : "",
        arguments: part?.state ?? null,
      };
    }
    case "progress":
      return { seq, type: "progress", label: labelOf(payload) };
    case "prompt_response":
      return { seq, type: "prompt_response", text: textOf(payload) };
    case "subagent":
      return { seq, type: "subagent", detail: payload };
    default:
      // Everything else — including events no one has classified yet — stays an event.
      return { seq, type: "unknown", raw: payload };
  }
}

/** The replay read the `Last-Event-ID` header names, as wire events. */
export async function replaySince(
  store: WorkshopStore,
  turnId: string,
  lastEventId: number,
  limit = 500,
): Promise<SeqencedStreamEvent[]> {
  const rows = await store.readEventsSince(turnId, lastEventId, limit);
  return rows.map((row) => translate(row.seq, row.type, row.payload));
}

export type WorkshopEventSink = {
  /** Persist one gateway event under its turn and ping the bus. Returns the wire shape. */
  append(turnId: string, event: TranslatedEvent): Promise<SeqencedStreamEvent>;
};

export function createEventSink(
  store: WorkshopStore,
  bus: TurnEventBus,
): WorkshopEventSink {
  return {
    async append(turnId, event) {
      const row = await store.appendEvent({
        turnId,
        type: event.family,
        payload: event.payload,
      });
      // Persisted, seq in hand: the ping can only ever be a reminder now.
      await bus.publish(turnId, row.seq);
      return translate(row.seq, event.family, event.payload);
    },
  };
}

const encoder = new TextEncoder();

/** One wire event as an SSE block; `id:` carries the seq the browser reconnects with. */
export function sseBlock(event: SeqencedStreamEvent): Uint8Array {
  return encoder.encode(
    `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

/**
 * The downstream response: catch-up from `Last-Event-ID` (database only), then live events
 * through the bus (or the bus's own poll fallback — degraded mode is slower, never lossy).
 *
 * The caller hands over the turn ids to follow and how to stop; this builds the body Bun
 * streams to the client. Every subscriber's connection is independent: its catch-up starts
 * from its own header, so a tab that reconnected at seq 42 and a fresh tab at 0 both get
 * exactly what they asked for.
 */
export type StreamEventsInput = {
  bus: TurnEventBus;
  store: WorkshopStore;
  turnIds: string[];
  lastEventId?: number;
  keepaliveMs?: number;
  /** Closed when the client detaches; stops keepalives, subscriptions, and the stream. */
  stopSignal?: AbortSignal;
};

/** The SSE headers every consumer sends, in one place. */
export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
};

export function streamEventsResponse(input: StreamEventsInput): Response {
  return new Response(eventsStreamBody(input), {
    status: 200,
    headers: SSE_HEADERS,
  });
}

/** The stream alone, for callers that stream through Hono's context.body instead. */
export function eventsStreamBody(
  input: StreamEventsInput,
): ReadableStream<Uint8Array> {
  const { bus, store, turnIds } = input;
  const keepaliveMs = input.keepaliveMs ?? 15_000;
  const perTurnLastSeq = new Map<string, number>(
    turnIds.map((id) => [id, input.lastEventId ?? 0]),
  );

  const stream: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    // start() returns synchronously: Bun's serve flushes what a stream's start leaves behind,
    // and an async start left even the keepalives undelivered until some later pull that a
    // quiet SSE client never issues. Everything below is fire-and-forget on purpose — the
    // stopSignal is what ends it, and every enqueue is guarded against the closed stream.
    start(controller) {
      let live = true;
      const guard = (bytes: Uint8Array) => {
        if (!live) return;
        try {
          controller.enqueue(bytes);
        } catch {
          // The client is gone; the abort handler closes us out.
        }
      };

      void (async () => {
        // Catch-up first, per turn, from the database.
        for (const turnId of turnIds) {
          const since = perTurnLastSeq.get(turnId) ?? 0;
          const events = await replaySince(store, turnId, since).catch(
            () => [],
          );
          for (const event of events) {
            perTurnLastSeq.set(turnId, event.seq);
            guard(sseBlock(event));
          }
        }

        // Then live: every bus ping re-reads the turn's rows past the last seq we sent — the
        // same dedup the bus holds internally, applied per subscriber so two turns on one
        // connection never interleave their seq spaces.
        const stopperPromises = turnIds.map((turnId) =>
          bus.subscribe(turnId, async () => {
            if (!live) return;
            const since = perTurnLastSeq.get(turnId) ?? 0;
            const events = await replaySince(store, turnId, since, 100).catch(
              () => [],
            );
            for (const event of events) {
              perTurnLastSeq.set(turnId, event.seq);
              guard(sseBlock(event));
            }
          }),
        );

        const keepalive = setInterval(() => {
          guard(encoder.encode(": keepalive\n\n"));
        }, keepaliveMs);

        const shutdown = () => {
          if (!live) return;
          live = false;
          clearInterval(keepalive);
          void (async () => {
            for (const stopPromise of stopperPromises) {
              const stop = await stopPromise.catch(() => undefined);
              stop?.();
            }
            try {
              controller.close();
            } catch {
              // Already closed by the client dropping: fine.
            }
          })();
        };

        if (input.stopSignal) {
          if (input.stopSignal.aborted) shutdown();
          else input.stopSignal.addEventListener("abort", shutdown);
        }
      })();
    },
  });

  return stream;
}
