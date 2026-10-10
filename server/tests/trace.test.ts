/**
 * shared/trace helpers, self-contained against a local fake OTLP collector (the
 * observability P2 spike's pattern). Six cases: W3C inbound extraction, outbound
 * injection, self-rooted traces, export through the batch processor, the
 * OPENBOT_TRACES=off switch, and endpoint-less operation. Every case gets its own
 * port and service.name, and shuts the provider down between cases, because the
 * API's global trace slot is process-wide and a shut-down provider records nothing.
 */
import { describe, expect, test } from "bun:test";
import { context, trace } from "@opentelemetry/api";
import {
  currentTraceId,
  extractRequestContext,
  initProcessTracing,
  injectTraceHeaders,
  shutdownTracing,
} from "../../shared/trace";

const INBOUND_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const INBOUND_PARENT =
  "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

type FakeCollector = {
  port: number;
  posts: () => number;
  bytes: () => number;
  stop: () => void;
};

/** Counts POST /v1/traces, the only thing the OTLP exporter sends. */
function startFakeCollector(port: number): FakeCollector {
  let posts = 0;
  let bytes = 0;
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v1/traces") {
        posts += 1;
        bytes = (await req.arrayBuffer()).byteLength;
        return new Response(null, { status: 200 });
      }
      return new Response("ok");
    },
  });
  return {
    port,
    posts: () => posts,
    bytes: () => bytes,
    stop: () => server.stop(true),
  };
}

/** The batch processor flushes on shutdown; give the in-flight POST a beat to land. */
async function waitForPosts(
  collector: FakeCollector,
  timeoutMs = 3_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (collector.posts() > 0) return collector.posts();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return collector.posts();
}

describe("shared/trace", () => {
  test("an inbound traceparent becomes the active trace id", async () => {
    const collector = startFakeCollector(14319);
    initProcessTracing("trace-test-inbound", {
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${collector.port}`,
    });
    try {
      const request = new Request("http://openbot.test/api/work", {
        headers: { traceparent: INBOUND_PARENT },
      });
      const remote = extractRequestContext(request);
      const span = trace
        .getTracer("trace-test")
        .startSpan("GET /api/work", {}, remote);
      const traceId = context.with(trace.setSpan(remote, span), () =>
        currentTraceId(),
      );
      span.end();
      expect(traceId).toBe(INBOUND_TRACE_ID);
    } finally {
      await shutdownTracing();
      collector.stop();
    }
  });

  test("injectTraceHeaders emits a traceparent of the active trace", async () => {
    const collector = startFakeCollector(14320);
    initProcessTracing("trace-test-inject", {
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${collector.port}`,
    });
    try {
      const span = trace.getTracer("trace-test").startSpan("outbound-call");
      let headers: Record<string, string> = {};
      context.with(trace.setSpan(context.active(), span), () => {
        headers = injectTraceHeaders({});
      });
      const traceId = span.spanContext().traceId;
      span.end();
      expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(headers.traceparent.split("-")[1]).toBe(traceId);
    } finally {
      await shutdownTracing();
      collector.stop();
    }
  });

  test("no inbound headers starts a fresh 32-hex trace", async () => {
    const collector = startFakeCollector(14321);
    initProcessTracing("trace-test-self-root", {
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${collector.port}`,
    });
    try {
      const request = new Request("http://openbot.test/api/work");
      const fresh = extractRequestContext(request);
      const span = trace
        .getTracer("trace-test")
        .startSpan("GET /api/work", {}, fresh);
      const traceId = context.with(trace.setSpan(fresh, span), () =>
        currentTraceId(),
      );
      span.end();
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      await shutdownTracing();
      collector.stop();
    }
  });

  test("ended spans flush to the collector as OTLP bytes", async () => {
    const collector = startFakeCollector(14322);
    initProcessTracing("trace-test-export", {
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${collector.port}`,
    });
    try {
      const span = trace.getTracer("trace-test").startSpan("export-me");
      span.setAttribute("test.suite", "shared-trace");
      span.end();
      // shutdownTracing flushes the BatchSpanProcessor, the same path a
      // graceful process exit takes.
      await shutdownTracing();
      const posts = await waitForPosts(collector);
      expect(posts).toBeGreaterThanOrEqual(1);
      expect(collector.bytes()).toBeGreaterThan(0);
    } finally {
      await shutdownTracing();
      collector.stop();
    }
  });

  test("OPENBOT_TRACES=off keeps the provider unregistered", async () => {
    const collector = startFakeCollector(14323);
    initProcessTracing("trace-test-off", {
      OPENBOT_TRACES: "off",
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${collector.port}`,
    });
    try {
      const span = trace.getTracer("trace-test").startSpan("never-recorded");
      const traceId = context.with(trace.setSpan(context.active(), span), () =>
        currentTraceId(),
      );
      span.end();
      await shutdownTracing();
      // No provider registered: the span context is the invalid placeholder, so
      // no trace id surfaces and nothing is exported.
      expect(traceId).toBeUndefined();
      expect(collector.posts()).toBe(0);
    } finally {
      await shutdownTracing();
      collector.stop();
    }
  });

  test("no endpoint still records spans and never contacts a collector", async () => {
    const collector = startFakeCollector(14324);
    initProcessTracing("trace-test-no-endpoint", {});
    // Idempotent: a second boot call with the same shape must be a no-op, not a
    // second provider.
    initProcessTracing("trace-test-no-endpoint", {});
    try {
      const span = trace.getTracer("trace-test").startSpan("local-only");
      const traceId = context.with(trace.setSpan(context.active(), span), () =>
        currentTraceId(),
      );
      span.end();
      await shutdownTracing();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(collector.posts()).toBe(0);
    } finally {
      await shutdownTracing();
      collector.stop();
    }
  });
});
