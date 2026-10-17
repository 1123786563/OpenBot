/**
 * shared/trace helpers, self-contained against a local fake OTLP collector (the
 * observability P2 spike's pattern). Ten cases: W3C inbound extraction, outbound
 * injection, self-rooted traces, export through the batch processor, the
 * OPENBOT_TRACES=off switch, endpoint-less operation, the signal-level traces
 * endpoint used verbatim, and the Bun.serve fetch wrapper continuing an inbound
 * trace, self-rooting a headerless one, and recording ERROR when its handler throws.
 * Every case gets its own port and service.name, and shuts the provider down between
 * cases, because the API's global trace slot is process-wide and a shut-down provider
 * records nothing.
 */
import { describe, expect, test } from "bun:test";
import { context, trace } from "@opentelemetry/api";
import {
  currentTraceId,
  extractRequestContext,
  initProcessTracing,
  injectTraceHeaders,
  shutdownTracing,
  withTraceFetch,
} from "../../shared/trace";

const INBOUND_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const INBOUND_PARENT =
  "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

type FakeCollector = {
  port: number;
  path: string;
  posts: () => number;
  bytes: () => number;
  last: () => ArrayBuffer;
  stop: () => void;
};

/** Counts POSTs to the given receive path, the only thing the OTLP exporter sends. */
function startFakeCollector(port: number, path = "/v1/traces"): FakeCollector {
  let posts = 0;
  let bytes = 0;
  let body = new ArrayBuffer(0);
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === path) {
        posts += 1;
        body = await req.arrayBuffer();
        bytes = body.byteLength;
        return new Response(null, { status: 200 });
      }
      return new Response("ok");
    },
  });
  return {
    port,
    path,
    posts: () => posts,
    bytes: () => bytes,
    last: () => body,
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

  test("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is used verbatim, full path included", async () => {
    // The collector listens on a non-default path, and the generic endpoint is set
    // too: only a verbatim signal-level endpoint can land spans on /collector/traces,
    // a path derived from the generic endpoint would POST /v1/traces and count zero.
    const collector = startFakeCollector(14325, "/collector/traces");
    initProcessTracing("trace-test-signal-endpoint", {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://localhost:${collector.port}/collector/traces`,
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${collector.port}`,
    });
    try {
      const span = trace.getTracer("trace-test").startSpan("signal-export");
      span.setAttribute("test.suite", "shared-trace");
      span.end();
      await shutdownTracing();
      const posts = await waitForPosts(collector);
      expect(posts).toBeGreaterThanOrEqual(1);
      expect(collector.bytes()).toBeGreaterThan(0);
    } finally {
      await shutdownTracing();
      collector.stop();
    }
  });
});

/**
 * Every span status code in one OTLP/HTTP export body. The exporter this process
 * runs speaks OTLP/JSON, so the body parses directly: resourceSpans → scopeSpans →
 * spans, and a span's `status.code` of 2 is ERROR.
 */
function exportedStatusCodes(body: ArrayBuffer): number[] {
  const parsed = JSON.parse(new TextDecoder().decode(body)) as {
    resourceSpans?: {
      scopeSpans?: { spans?: { status?: { code?: number } }[] }[];
    }[];
  };
  const codes: number[] = [];
  for (const resourceSpans of parsed.resourceSpans ?? [])
    for (const scopeSpans of resourceSpans.scopeSpans ?? [])
      for (const span of scopeSpans.spans ?? [])
        if (span.status?.code !== undefined) codes.push(span.status.code);
  return codes;
}

describe("shared/trace withTraceFetch", () => {
  test("a traced request runs its handler inside the inbound trace", async () => {
    initProcessTracing("trace-test-fetch-traced", {});
    try {
      let inside: string | undefined;
      const wrapped = withTraceFetch(async () => {
        inside = currentTraceId();
        return Response.json({ ok: true });
      });
      const response = await wrapped(
        new Request("http://openbot.test/api/work", {
          headers: { traceparent: INBOUND_PARENT },
        }),
      );
      expect(response.status).toBe(200);
      expect(inside).toBe(INBOUND_TRACE_ID);
    } finally {
      await shutdownTracing();
    }
  });

  test("a headerless request self-roots a fresh 32-hex trace", async () => {
    initProcessTracing("trace-test-fetch-self-root", {});
    try {
      let inside: string | undefined;
      const wrapped = withTraceFetch(async () => {
        inside = currentTraceId();
        return Response.json({ ok: true });
      });
      const response = await wrapped(
        new Request("http://openbot.test/api/work"),
      );
      expect(response.status).toBe(200);
      expect(inside).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      await shutdownTracing();
    }
  });

  test("a thrown handler records ERROR and the error still propagates", async () => {
    const collector = startFakeCollector(14326);
    initProcessTracing("trace-test-fetch-error", {
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${collector.port}`,
    });
    try {
      const wrapped = withTraceFetch(async () => {
        throw new Error("handler exploded");
      });
      let propagated: unknown;
      await wrapped(new Request("http://openbot.test/api/boom")).catch(
        (error) => {
          propagated = error;
        },
      );
      expect((propagated as Error | undefined)?.message).toBe(
        "handler exploded",
      );
      await shutdownTracing();
      expect(await waitForPosts(collector)).toBeGreaterThanOrEqual(1);
      const codes = exportedStatusCodes(collector.last());
      expect(codes.length).toBeGreaterThanOrEqual(1);
      expect(codes.every((code) => code === 2)).toBe(true);
    } finally {
      await shutdownTracing();
      collector.stop();
    }
  });
});
