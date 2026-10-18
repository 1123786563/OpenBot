import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { serve } from "../../tests/support/bun-compat";
import { forwardBlock, forwardEvents } from "../src/sse";

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
    expect(
      forwardBlock(`data: {"type":"server.heartbeat","properties":{}}`),
    ).toBeNull();
    expect(
      forwardBlock(`data: {"type":"plugin.added","properties":{"id":"x"}}`),
    ).toBeNull();
  });

  test("non-data blocks and empty payloads are dropped", () => {
    expect(forwardBlock(": comment")).toBeNull();
    expect(forwardBlock("event: x")).toBeNull();
    expect(forwardBlock("data: ")).toBeNull();
  });

  test("permission.asked passes labelled permission (F-G: the ask must reach the server bus)", () => {
    // The craft turn consumer routes connect_app/gated asks off this very event;
    // a filter that drops it parks the opencode turn with no egress at all —
    // no card, no timeout decline (remediation-verification §0.3).
    const block =
      `data: {"id":"p1","type":"permission.asked","properties":{"sessionID":"ses_1","id":"perm_1",` +
      `"permission":"connect_app","patterns":[],"metadata":{"external_app_id":7,"reason":"Need Slack"}}}`;
    expect(forwardBlock(block)).toBe(`event: permission\n${block}\n\n`);
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
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const port = (upstream as unknown as { port: number }).port;

    const events: string[] = [];
    const response = await forwardEvents({
      upstreamPort: port,
      onEvent: () => events.push("x"),
    });
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
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
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

  test("upstreamQuery rides the upstream URL (the directory scope, F-G)", async () => {
    // opencode scopes /event per ?directory= — a craft session's events only
    // publish on the scoped stream. The forwarder must carry the caller's
    // query through, or every directory-scoped consumer reads the default
    // instance's bus and sees nothing.
    const requests: string[] = [];
    const upstream = serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const url = new URL(request.url);
        requests.push(`${url.pathname}${url.search}`);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const port = (upstream as unknown as { port: number }).port;
    const response = await forwardEvents({
      upstreamPort: port,
      upstreamQuery: "?directory=cs-scoped-1",
      fetchImpl: (async (input: unknown) =>
        fetch(input as RequestInfo)) as never,
    });
    await response.body!.cancel();
    expect(requests).toEqual(["/event?directory=cs-scoped-1"]);
    upstream.stop(true);
  });

  test("without upstreamQuery the URL stays bare (default instance)", async () => {
    const requests: string[] = [];
    const upstream = serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const url = new URL(request.url);
        requests.push(`${url.pathname}${url.search}`);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.close();
            },
          }),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });
    const port = (upstream as unknown as { port: number }).port;
    const response = await forwardEvents({ upstreamPort: port });
    await response.body!.cancel();
    expect(requests).toEqual(["/event"]);
    upstream.stop(true);
  });

  test("a refused connection (fetch rejects) answers the same 503 JSON", async () => {
    // The connect itself throwing — port closed, socket refused — is an answer, not an
    // exception the proxy has to catch: one refusal shape for every way upstream is absent.
    const response = await forwardEvents({
      upstreamPort: 4400,
      fetchImpl: (() =>
        Promise.reject(new Error("connect ECONNREFUSED"))) as never,
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("not available");
  });

  test("onClose fires exactly once when the stream tears down", async () => {
    const upstream = serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: {"type":"message.part.delta","properties":{"field":"text","delta":"a"}}\n\n`,
              ),
            );
            // Then nothing: the test cancels the downstream and expects onClose.
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const port = (upstream as unknown as { port: number }).port;
    let closed = 0;
    const response = await forwardEvents({
      upstreamPort: port,
      onClose: () => {
        closed += 1;
      },
    });
    await response.body!.cancel();
    expect(closed).toBe(1);
    upstream.stop(true);
  });
});
