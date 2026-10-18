import { afterAll, beforeAll, describe, expect, test } from "../../tests/support/bun-test-compat";

/**
 * The auth module's global localhost fetch patch (server/src/auth/index.ts
 * patchGlobalFetchForLocalhost) must be a faithful fetch for craft's loopback
 * agent-sandbox gateway calls. These tests exercise the three call shapes the
 * craft port broke in the field (remediation-verification.md finding F-A):
 *
 * 1. Framing — a POST with a multi-byte string body (workspace assembly writes
 *    AGENTS.md/plugin templates, which contain CJK text) must not corrupt the
 *    reused keep-alive connection: the NEXT request must still pair with its
 *    own response, not a stale 400 for the leftover bytes.
 * 2. Streaming — a long-lived SSE response (/events) must resolve the fetch
 *    promise at HEADERS and deliver body chunks incrementally, not only after
 *    the stream ends. Craft's PodEventBus is the first long-lived consumer.
 * 3. Abort — init.signal must be honored; a wedged request must reject, or the
 *    turn runner has no inactivity timeout at all.
 *
 * The server side models the agent-sandbox gateway (agent-sandbox/src/proxy.ts)
 * faithfully: Bun.serve, POST /file → arrayBuffer() → 201, POST /session → id,
 * GET /events → text/event-stream held open with keepalives (idleTimeout 0).
 */

// Importing the auth module applies the global fetch patch at module load —
// the same side effect the existing auth-expo-scheme tests already rely on.
await import("../src/auth/index");

/** Server-side record of what the gateway actually saw (ground truth for pairing). */
const seen: Array<{ method: string; path: string; bodyBytes: number | null }> =
  [];
const note = (entry: {
  method: string;
  path: string;
  bodyBytes: number | null;
}) => {
  seen.push(entry);
};

let server: ReturnType<typeof Bun.serve>;
let port: number;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // The real gateway sets idleTimeout 0: an /events response lives as long as
    // its listener does (index.ts:24-27).
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const method = request.method;

      // POST /file: body consumed via arrayBuffer, 201 with a JSON body —
      // the gateway's writeFile verb (proxy.ts:277-298).
      if (url.pathname === "/file" && method === "POST") {
        const body = new Uint8Array(await request.arrayBuffer());
        note({ method, path: url.pathname, bodyBytes: body.byteLength });
        return Response.json(
          { path: url.searchParams.get("path"), size: body.byteLength },
          { status: 201 },
        );
      }

      // POST /session: mint an opencode session id (serve-client.ts ensureSession).
      if (url.pathname === "/session" && method === "POST") {
        const body = await request.text();
        note({ method, path: url.pathname, bodyBytes: body ? body.length : 0 });
        return Response.json({ id: "ses_test_1" }, { status: 201 });
      }

      // GET /events: the SSE stream the PodEventBus subscribes to. Two events
      // with a gap between them, then the stream stays open until the test
      // closes it — proving the client sees events while the stream is live.
      if (url.pathname === "/events" && method === "GET") {
        note({ method, path: url.pathname, bodyBytes: null });
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (payload: unknown) =>
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify(payload)}\n\n`,
                ),
              );
            send({ type: "first" });
            await new Promise((resolve) => setTimeout(resolve, 150));
            send({ type: "second" });
            // Hold the stream open (no terminal chunk) — the bus expects this.
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
          },
        });
      }

      // GET /never: never answers — the abort test's target.
      if (url.pathname === "/never" && method === "GET") {
        note({ method, path: url.pathname, bodyBytes: null });
        return new Promise<Response>(() => undefined);
      }

      return new Response("no such route", { status: 404 });
    },
  });
  port = server.port;
});

afterAll(() => {
  server.stop(true);
});

const base = () => `http://127.0.0.1:${port}`;

describe("patched global fetch on loopback (auth/index.ts)", () => {
  test("multi-byte POST body does not poison the keep-alive connection for the next request", async () => {
    seen.length = 0;
    // Workspace assembly writes CJK-bearing templates (AGENTS.template.md and
    // the plugin templates contain non-ASCII — verified in the source tree).
    const fileContent =
      "# 工作区说明\n\n你好，世界 — managed content with CJK text\n";
    expect(fileContent.length).toBeLessThan(
      new TextEncoder().encode(fileContent).byteLength,
    );

    const write = await fetch(`${base()}/file?path=AGENTS.md`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-openbot-bot-id": "bot-test",
      },
      body: fileContent,
    });
    // The write itself physically succeeds (201 on the wire, per the TCP tap).
    expect(write.status).toBe(201);

    // The very next request on the same connection must pair with ITS OWN
    // response. F-A live failure: this call read a stale 400 (the gateway's
    // answer to the leftover body bytes) and session creation 500'd.
    const create = await Promise.race([
      fetch(`${base()}/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-bot-id": "bot-test",
        },
        body: JSON.stringify({ title: "会话" }),
      }).then((response) => ({ ok: true, status: response.status })),
      new Promise<{ ok: false }>((resolve) =>
        setTimeout(() => resolve({ ok: false }), 3000),
      ),
    ]);
    expect(create).toEqual({ ok: true, status: 201 });

    // Ground truth: the gateway saw both requests, and the file write carried
    // the FULL byte payload (framing intact).
    expect(seen).toEqual([
      {
        method: "POST",
        path: "/file",
        bodyBytes: new TextEncoder().encode(fileContent).byteLength,
      },
      {
        method: "POST",
        path: "/session",
        bodyBytes: JSON.stringify({ title: "会话" }).length,
      },
    ]);
  });

  test("SSE response resolves at headers and streams chunks incrementally", async () => {
    const startedAt = Date.now();
    const response = await fetch(`${base()}/events`, {
      headers: { accept: "text/event-stream", "x-openbot-bot-id": "bot-test" },
    });
    expect(response.ok).toBe(true);
    const headersAt = Date.now() - startedAt;
    // The promise must settle when HEADERS arrive — the /events stream never
    // ends, so a patch that buffers until 'end' can never deliver it.
    expect(headersAt).toBeLessThan(1000);

    // First event must arrive while the stream is still open (the second
    // event follows 150ms later; the stream never terminates).
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let first = "";
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !first.includes("first")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      first += decoder.decode(chunk.value, { stream: true });
    }
    expect(first).toContain("first");
    // First event well before the 150ms second event and the never-ending hold.
    expect(Date.now() - startedAt).toBeLessThan(1000);
    await reader.cancel().catch(() => undefined);
  });

  test("init.signal aborts a wedged request", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const outcome = await Promise.race([
      fetch(`${base()}/never`, {
        headers: { "x-openbot-bot-id": "bot-test" },
        signal: controller.signal,
      }).then(
        () => "resolved",
        (error: unknown) =>
          `rejected: ${error instanceof Error ? error.name : String(error)}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("HUNG"), 1500)),
    ]);
    // An honored signal rejects (AbortError); a HUNG outcome is the F-A
    // "no inactivity timeout" wedge.
    expect(outcome).not.toBe("HUNG");
    expect(outcome).not.toBe("resolved");
    expect(outcome.startsWith("rejected")).toBe(true);
  });
});
