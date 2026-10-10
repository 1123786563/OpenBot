/**
 * The SSE forwarder: the server's one door into a Bot's opencode event stream.
 *
 * Upstream is opencode's `GET /event`; downstream is the wrapper's `GET /events`, which differs
 * from it in exactly two ways, both decisions rather than accidents:
 *
 * - KEEPALIVES: a comment line (`: keepalive`) every 15s, so proxies and clients that time out
 *   on read-silence stay attached through the gaps between heartbeats.
 * - THE FAMILY FILTER: only the five product families (message_chunk, thought, tool_call,
 *   progress, prompt_response) pass through, per the live capture in docs/sse-samples.md —
 *   `plugin.added` alone was 15% of a real turn's traffic, and the workshop's process view has
 *   no use for it. Filtering here, at the single choke point, means every consumer downstream
 *   (B8's gateway, B9's translator, F5's stream view) inherits the decision without each
 *   re-implementing it and each getting it slightly differently.
 */
import { familyOf, parseSandboxEvent } from "./events";

/** How often a keepalive comment rides the stream while no event is flowing. */
export const KEEPALIVE_INTERVAL_MS = 15_000;

export type SseForwardOptions = {
  /** Which Bot's upstream to read; the proxy resolves the port before calling. */
  upstreamPort: number;
  /** The fetch to reach it with — injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Keepalive cadence; tests shrink it rather than waiting. */
  keepaliveMs?: number;
  /** The upstream path; opencode serves its event bus at /event. */
  upstreamPath?: string;
  /** Called for every forwarded block — the proxy's activity clock for this Bot. */
  onEvent?: () => void;
  /** Called exactly once when the forwarded stream ends, however it ends. */
  onClose?: () => void;
};

/**
 * The forwarded stream as a `Response` Bun can hand to a client.
 *
 * The upstream connection's lifetime IS the response's lifetime: when the client detaches, the
 * response body cancels, the pipe sees the cancel, and the upstream fetch aborts — no orphaned
 * connection keeps a Bot's runtime alive after its last listener is gone.
 */
export async function forwardEvents(
  options: SseForwardOptions,
): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  const keepaliveMs = options.keepaliveMs ?? KEEPALIVE_INTERVAL_MS;
  let upstream: Response;
  try {
    upstream = await doFetch(
      `http://127.0.0.1:${options.upstreamPort}${options.upstreamPath ?? "/event"}`,
    );
  } catch {
    // A refused connection is an answer, not an exception the caller has to catch: the same
    // 503 shape as a non-ok upstream, so the server side has one refusal path to handle.
    return Response.json(
      { error: "The bot's event stream is not available." },
      { status: 503 },
    );
  }
  if (!upstream.ok || !upstream.body) {
    return Response.json(
      { error: "The bot's event stream is not available." },
      { status: 503 },
    );
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = "";
  let closed = false;
  /** onClose fires exactly once, whichever of the endings gets there first. */
  let closeNotified = false;
  const notifyClose = () => {
    if (closeNotified) return;
    closeNotified = true;
    options.onClose?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const guard = (action: () => void) => {
        if (closed) return;
        try {
          action();
        } catch {
          // The client detached mid-write: the cancel handler closes us out.
        }
      };

      // PUSH, NOT PULL: Bun's serve only demands stream data on its own schedule, and a
      // pull-driven stream went wholly silent in the deployed container (unit tests passed
      // because the reader demanded every byte). The pump pushes whatever arrives the moment
      // it arrives, and the keepalive timer pushes the quiet-signal itself.
      const pump = async (): Promise<void> => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            guard(() => controller.enqueue(encoder.encode(": upstream closed\n\n")));
            closed = true;
            try {
              controller.close();
            } catch {
              // Already closed by cancel: fine.
            }
            notifyClose();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const forwarded = forwardBlock(block);
            if (forwarded) {
              guard(() => controller.enqueue(encoder.encode(forwarded)));
              options.onEvent?.();
            }
          }
        }
      };

      const keepalive = setInterval(() => {
        guard(() => controller.enqueue(encoder.encode(": keepalive\n\n")));
      }, keepaliveMs);

      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        void reader.cancel().catch(() => undefined);
        try {
          controller.close();
        } catch {
          // Already closed: fine.
        }
        notifyClose();
      };

      void pump().catch(() => finish());

      // When the client detaches, cancel fires: stop the pump and the timer, one onClose.
      // The reader.cancel() the pump awaits makes its next read resolve done on its own, but
      // the timer needs the explicit stop either way.
      return () => {
        clearInterval(keepalive);
        void reader.cancel().catch(() => undefined);
      };
    },
    cancel() {
      closed = true;
      void reader.cancel().catch(() => undefined);
      notifyClose();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/**
 * One upstream SSE block, forwarded or dropped.
 *
 * A block is `data: {...}` (opencode sends no event:/id: lines). It passes when its event
 * family is one of the five the product consumes; heartbeats, plugin noise, session metadata
 * and unknown future types are dropped here — the single place that decision lives.
 */
export function forwardBlock(block: string): string | null {
  const dataLine = block
    .split("\n")
    .find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  const payload = dataLine.slice("data:".length).trim();
  if (!payload) return null;
  const event = parseSandboxEvent(payload);
  const family = familyOf(event);
  if (family === "other") return null;
  return `event: ${family}\ndata: ${payload}\n\n`;
}
