import { describe, expect, test } from "bun:test";
import { forwardBlock } from "../src/sse";
import { forwardEvents } from "../src/sse";
import { serve } from "bun";

describe("forwardBlock (the family filter)", () => {
  test("a text delta passes labelled message_chunk", () => {
    expect(
      forwardBlock(
        `data: {"id":"e","type":"message.part.delta","properties":{"field":"text","delta":"hi"}}`,
      ),
    ).toBe(
      `event: message_chunk\ndata: {"id":"e","type":"message.part.delta","properties":{"field":"text","delta":"hi"}}\n\n`,
    );
  });

  test("heartbeats and plugin noise are dropped", () => {
    expect(forwardBlock(`data: {"type":"server.heartbeat","properties":{}}`)).toBeNull();
    expect(forwardBlock(`data: {"type":"plugin.added","properties":{"id":"x"}}`)).toBeNull();
  });

  test("non-data blocks and empty payloads are dropped", () => {
    expect(forwardBlock(": comment")).toBeNull();
    expect(forwardBlock("event: x")).toBeNull();
    expect(forwardBlock("data: ")).toBeNull();
  });
});

describe("forwardEvents (the stream)", () => {
  const encoder = new TextEncoder();

  test("forwards families, drops noise, closes when the upstream closes", async () => {
    const upstream = serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        const samples = [
          `data: {"type":"server.heartbeat","properties":{}}\n\n`,
          `data: {"type":"message.part.delta","properties":{"field":"text","delta":"a"}}\n\n`,
          `data: {"type":"plugin.added","properties":{}}\n\n`,
          `data: {"type":"session.idle","properties":{"sessionID":"s"}}\n\n`,
        ];
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(samples.join("")));
            controller.close();
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const port = (upstream as unknown as { port: number }).port;

    const events: string[] = [];
    const response = await forwardEvents({ upstreamPort: port, onEvent: () => events.push("x") });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: message_chunk");
    expect(text).toContain("event: prompt_response");
    expect(text).not.toContain("heartbeat");
    expect(text).not.toContain("plugin.added");
    expect(events).toHaveLength(2); // only the forwarded ones pinged the activity clock
    upstream.stop(true);
  });

  test("a keepalive rides the stream during upstream silence", async () => {
    const upstream = serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        let open = true;
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            // One event, then silence: the keepalive must appear before the test cancels.
            controller.enqueue(
              encoder.encode(
                `data: {"type":"message.part.delta","properties":{"field":"text","delta":"a"}}\n\n`,
              ),
            );
            await new Promise((resolve) => setTimeout(resolve, 250));
            if (open) controller.close();
          },
          cancel() {
            open = false;
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const port = (upstream as unknown as { port: number }).port;

    const response = await forwardEvents({
      upstreamPort: port,
      keepaliveMs: 50,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    // Read until a keepalive shows up (or too many iterations).
    for (let i = 0; i < 20 && !seen.includes(": keepalive"); i += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += decoder.decode(chunk.value, { stream: true });
    }
    expect(seen).toContain(": keepalive");
    await reader.cancel();
    upstream.stop(true);
  });

  test("an unavailable upstream answers 503, not a broken stream", async () => {
    const response = await forwardEvents({ upstreamPort: 1 });
    expect(response.status).toBe(503);
  });
});
