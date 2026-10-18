/**
 * The server's outbound calls carry the active trace, the observability P2 wiring
 * under real HTTP: a local fake agent answers `createAgentFetch`, a fake computer
 * answers `createComputerTransport`, a fake supervisor answers
 * `createDockerSupervisorProvider`, and each records the headers its request
 * actually carried. With a span active, the request's `traceparent` must name that
 * span's trace; with nothing active, nothing may be added — the W3C propagator
 * injects nothing without a valid span, and this file pins that choice.
 *
 * `connection-test.ts` needs no case of its own: it dials through the same
 * `guardedFetch` this file already exercises, so the endpoint.ts wiring covers it.
 *
 * Every case gets its own service.name and shuts the provider down in its finally,
 * because the API's global trace slot is process-wide and a shut-down provider
 * records nothing — the shared/trace test suite's pattern, reused here.
 */
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { trace } from "@opentelemetry/api";
import { createAgentFetch } from "../src/agents/endpoint";
import { createComputerTransport } from "../src/computer/client";
import { createDockerSupervisorProvider } from "../src/computer/supervisor";
import {
  initProcessTracing,
  shutdownTracing,
} from "../../shared/trace";

/** The headers one POST carried, and the port it was received on. */
type RecordingServer = {
  port: number;
  headers: () => Record<string, string>;
  posts: () => number;
  stop: () => void;
};

/** Answer every POST with a minimal AG-UI-shaped stream, remembering its headers. */
function startRecordingAgent(): RecordingServer {
  let received: Record<string, string> = {};
  let posts = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "POST") {
        posts += 1;
        received = Object.fromEntries(req.headers.entries());
        // An agent asks for SSE; the computer's JSON calls do not. Answer each in
        // the shape its caller can read.
        if (req.headers.get("accept")?.includes("text/event-stream")) {
          return new Response(
            'event: RUN_STARTED\ndata: {"type":"RUN_STARTED"}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return Response.json({ ok: true });
      }
      received = Object.fromEntries(req.headers.entries());
      return Response.json({ ok: true });
    },
  });
  return {
    port: server.port,
    headers: () => received,
    posts: () => posts,
    stop: () => server.stop(true),
  };
}

/** The trace id carried by a W3C traceparent, or undefined when there is none. */
function traceIdOf(traceparent: string | undefined): string | undefined {
  if (!traceparent) return undefined;
  const parts = traceparent.split("-");
  return parts.length === 4 && /^00$/.test(parts[0]) ? parts[1] : undefined;
}

describe("outbound traceparent injection", () => {
  test("an agent POST inside an active span carries that span's trace", async () => {
    const agent = startRecordingAgent();
    initProcessTracing("trace-outbound-agent", { OPENBOT_TRACES: "" });
    try {
      const guarded = createAgentFetch({ allowPrivateHosts: true });
      let spanTraceId = "";
      await trace.getTracer("trace-outbound-agent").startActiveSpan(
        "agent run",
        async (span) => {
          spanTraceId = span.spanContext().traceId;
          const response = await guarded(
            `http://127.0.0.1:${agent.port}/ag-ui`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "text/event-stream",
              },
              body: JSON.stringify({
                threadId: "thread-1",
                runId: "run-1",
                messages: [],
                forwardedProps: {},
              }),
            },
          );
          await response.text();
          span.end();
        },
      );

      expect(agent.posts()).toBe(1);
      const carried = traceIdOf(agent.headers().traceparent);
      expect(carried).toBeDefined();
      expect(carried).toBe(spanTraceId);
    } finally {
      await shutdownTracing();
      agent.stop();
    }
  });

  test("a computer call inside an active span carries that span's trace", async () => {
    const computer = startRecordingAgent();
    initProcessTracing("trace-outbound-computer", { OPENBOT_TRACES: "" });
    try {
      const transport = createComputerTransport({ allowPrivateHosts: true });
      let spanTraceId = "";
      await trace.getTracer("trace-outbound-computer").startActiveSpan(
        "computer call",
        async (span) => {
          spanTraceId = span.spanContext().traceId;
          const answer = await transport.post(
            `http://127.0.0.1:${computer.port}`,
            "bot-1",
            "/snapshot",
            {},
          );
          expect(answer).toEqual({ ok: true });
          span.end();
        },
      );

      expect(computer.posts()).toBe(1);
      const carried = traceIdOf(computer.headers().traceparent);
      expect(carried).toBeDefined();
      expect(carried).toBe(spanTraceId);
    } finally {
      await shutdownTracing();
      computer.stop();
    }
  });

  test("a supervisor call inside an active span carries that span's trace", async () => {
    const supervisor = startRecordingAgent();
    initProcessTracing("trace-outbound-supervisor", { OPENBOT_TRACES: "" });
    try {
      const provider = createDockerSupervisorProvider({
        baseUrl: `http://127.0.0.1:${supervisor.port}`,
      });
      let spanTraceId = "";
      await trace.getTracer("trace-outbound-supervisor").startActiveSpan(
        "supervisor call",
        async (span) => {
          spanTraceId = span.spanContext().traceId;
          await provider.status("bot-1");
          span.end();
        },
      );

      expect(supervisor.posts()).toBe(0); // status lists, a GET, not a POST
      const carried = traceIdOf(supervisor.headers().traceparent);
      expect(carried).toBeDefined();
      expect(carried).toBe(spanTraceId);
    } finally {
      await shutdownTracing();
      supervisor.stop();
    }
  });

  test("without an active span, an agent POST carries no traceparent", async () => {
    const agent = startRecordingAgent();
    // No initProcessTracing here on purpose — and every earlier case shut its
    // provider down, so this process currently has no global trace slot at all.
    // The propagator injects nothing into that, and the header must stay absent
    // rather than gain a self-rooted value.
    try {
      const guarded = createAgentFetch({ allowPrivateHosts: true });
      const response = await guarded(
        `http://127.0.0.1:${agent.port}/ag-ui`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify({ forwardedProps: {} }),
        },
      );
      await response.text();

      expect(agent.posts()).toBe(1);
      expect(agent.headers().traceparent).toBeUndefined();
    } finally {
      agent.stop();
    }
  });
});
