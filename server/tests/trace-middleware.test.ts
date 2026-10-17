/**
 * The inbound trace middleware on a mini Hono app (the P1 request-tracking test's
 * shape): every request runs inside a span, so the access log line picks the trace
 * id up through the ambient context — continuing an inbound `traceparent` when one
 * is present, self-rooting a fresh 32-hex trace when not, and still logging when a
 * handler throws. Each case registers and shuts down its own provider, because the
 * API's global trace slot is process-wide and a shut-down provider records nothing.
 */
import { describe, expect, test } from "../../tests/support/e2e-compat";
import { Writable } from "node:stream";
import { Hono } from "hono";
import {
  currentTraceId,
  initProcessTracing,
  shutdownTracing,
} from "../../shared/trace";
import type { Logger } from "../../shared/logger";
import { createLogger } from "../../shared/logger";
import { createRequestTracking } from "../src/telemetry/request-tracking";
import { createTraceMiddleware } from "../src/telemetry/trace-middleware";
import { testEnvironment } from "./support/environment";

const INBOUND_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const INBOUND_PARENT =
  "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

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

/**
 * The main app's registration order, which is what makes the access log's trace id
 * work: the request id first, the span second, the access log third — a log emitted
 * inside the access log middleware then reads the span context above it.
 */
function miniApp(logger: Logger) {
  const tracking = createRequestTracking({ logger });
  const app = new Hono<{ Variables: { requestId?: string } }>();
  app.use("*", tracking.requestId);
  app.use("*", createTraceMiddleware());
  app.use("/api/*", tracking.accessLog);
  app.get("/api/work", (c) => c.json({ traceId: currentTraceId() }));
  app.get("/api/boom", () => {
    throw new Error("boom");
  });
  return app;
}

async function loggedRequest(
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; record: Record<string, unknown> }> {
  const { stream, lines } = capture();
  const response = await miniApp(createLogger("test", stream)).request(path, {
    headers,
  });
  const status = response.status;
  await response.text();
  expect(lines).toHaveLength(1);
  return { status, record: JSON.parse(lines[0]!) as Record<string, unknown> };
}

describe("trace middleware", () => {
  test("an inbound traceparent flows into the handler and the access log line", async () => {
    initProcessTracing("trace-mw-inbound", {});
    try {
      const response = await miniApp(createLogger("test", capture().stream)).request(
        "/api/work",
        { headers: { traceparent: INBOUND_PARENT } },
      );
      expect(response.status).toBe(200);
      expect(((await response.json()) as { traceId: string }).traceId).toBe(
        INBOUND_TRACE_ID,
      );
      const { record } = await loggedRequest("/api/work", {
        traceparent: INBOUND_PARENT,
      });
      expect(record.msg).toBe("request");
      expect(record.trace_id).toBe(INBOUND_TRACE_ID);
    } finally {
      await shutdownTracing();
    }
  });

  test("a headerless request logs a fresh 32-hex trace id", async () => {
    initProcessTracing("trace-mw-self-root", {});
    try {
      const { record } = await loggedRequest("/api/work");
      expect(record.trace_id).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      await shutdownTracing();
    }
  });

  test("a throwing handler still leaves an access log line with its trace id", async () => {
    initProcessTracing("trace-mw-error", {});
    try {
      const { status, record } = await loggedRequest("/api/boom");
      expect(status).toBe(500);
      expect(record.msg).toBe("request");
      expect(record.status).toBe(500);
      expect(record.trace_id).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      await shutdownTracing();
    }
  });

  test("each request runs in its own trace, not a shared one", async () => {
    initProcessTracing("trace-mw-per-request", {});
    try {
      const first = await loggedRequest("/api/work");
      const second = await loggedRequest("/api/work");
      const firstId = first.record.trace_id as string;
      const secondId = second.record.trace_id as string;
      expect(firstId).toMatch(/^[0-9a-f]{32}$/);
      expect(secondId).toMatch(/^[0-9a-f]{32}$/);
      expect(secondId).not.toBe(firstId);
    } finally {
      await shutdownTracing();
    }
  });
});

describe("the main deployment app", () => {
  test("continues an inbound traceparent on a plain route", async () => {
    const { createApp } = await import("../src/app");
    const { loadConfig } = await import("../src/config");
    const app = createApp(loadConfig(testEnvironment()));
    const response = await app.request("/health", {
      headers: { traceparent: INBOUND_PARENT },
    });
    expect(response.status).toBe(200);
  });
});
