import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Hono } from "hono";
import { createLogger } from "../../shared/logger";
import {
  createRequestTracking,
  currentRequestId,
} from "../src/telemetry/request-tracking";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function miniApp(logger = createLogger("test", capture().stream)) {
  const tracking = createRequestTracking({ logger });
  const app = new Hono<{ Variables: { requestId?: string } }>();
  app.use("/api/*", tracking.requestId);
  app.use("/api/*", tracking.accessLog);
  app.get("/api/ping", (c) => c.json({ requestId: currentRequestId() }));
  app.get("/health", (c) => c.json({ status: "ok" }));
  return app;
}

describe("request tracking", () => {
  test("mints a request id, echoes it back, and the handler sees the same one", async () => {
    const response = await miniApp().request("/api/ping");
    const requestId = response.headers.get("x-request-id");
    expect(requestId ?? "").toMatch(UUID);
    expect((await response.json()).requestId).toBe(requestId);
  });

  test("reuses a well-formed inbound x-request-id", async () => {
    const response = await miniApp().request("/api/ping", {
      headers: { "x-request-id": "client-trace-42" },
    });
    expect(response.headers.get("x-request-id")).toBe("client-trace-42");
  });

  test("replaces a malformed inbound id with a minted one", async () => {
    const response = await miniApp().request("/api/ping", {
      headers: { "x-request-id": "bad id with spaces" },
    });
    expect(response.headers.get("x-request-id") ?? "").toMatch(UUID);
  });

  test("the access log line carries method, path, status, duration and request id", async () => {
    const { stream, lines } = capture();
    await miniApp(createLogger("test", stream)).request("/api/ping");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.msg).toBe("request");
    expect(record.method).toBe("GET");
    expect(record.path).toBe("/api/ping");
    expect(record.status).toBe(200);
    expect(record.duration_ms).toBeTypeOf("number");
    expect(record.request_id ?? "").toMatch(UUID);
  });

  test("a throwing handler still leaves its access log line, as Hono's 500", async () => {
    const { stream, lines } = capture();
    const logger = createLogger("test", stream);
    const tracking = createRequestTracking({ logger });
    const app = new Hono<{ Variables: { requestId?: string } }>();
    app.use("/api/*", tracking.requestId);
    app.use("/api/*", tracking.accessLog);
    app.get("/api/boom", () => {
      throw new Error("boom");
    });
    const response = await app.request("/api/boom");
    expect(response.status).toBe(500);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.status).toBe(500);
    expect(record.path).toBe("/api/boom");
  });

  test("probes outside /api are not access-logged", async () => {
    const { stream, lines } = capture();
    await miniApp(createLogger("test", stream)).request("/health");
    expect(lines).toHaveLength(0);
  });

  test("outside a request there is no ambient request id", () => {
    expect(currentRequestId()).toBeUndefined();
  });
});
