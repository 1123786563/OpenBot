/**
 * Cross-service W3C propagation closure, the agent side (Issue #23 / DAG T17).
 *
 * The chain under test is the one the deployment actually runs: the server dials
 * this process with a `traceparent` (createAgentFetch), `withTraceFetch`
 * continues it, the run span rides it, and a deployment tool's call BACK through
 * the server carries the tool span as its parent — the same trace id at every
 * hop, so one run's segments are joinable end to end and a hop that fell out of
 * the chain is detectable by exactly that comparison.
 *
 * Real loopback HTTP both hops and the real shared/trace helpers: no mocks of the
 * propagation machinery, because the thing under test IS the machinery's wiring.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { context, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  currentTraceContext,
  injectTraceHeaders,
  withTraceFetch,
} from "../../shared/trace";
import {
  governedRunSpan,
  traceDeploymentToolCall,
} from "../src/governed-tracing";

const spans: ReadableSpan[] = [];
let stopProvider: (() => Promise<void>) | undefined;

beforeAll(() => {
  const provider = new NodeTracerProvider({
    spanProcessors: [
      {
        onStart: () => {},
        onEnd: (span) => {
          spans.push(span);
        },
        shutdown: () => Promise.resolve(),
        forceFlush: () => Promise.resolve(),
      },
    ],
  });
  provider.register();
  stopProvider = async () => {
    await provider.shutdown();
    trace.disable();
  };
});

afterAll(async () => {
  await stopProvider?.();
});

/** Parses `00-<traceId>-<spanId>-01` into its coordinates. */
function parseTraceparent(
  header: string | null,
): { traceId: string; spanId: string } | null {
  if (header === null) return null;
  const parts = header.split("-");
  if (parts.length !== 4) return null;
  return { traceId: parts[1], spanId: parts[2] };
}

describe("the cross-service chain closes (server → agent → tool receipt)", () => {
  test("the tool's call back through the server carries the chain", async () => {
    // Hop 3's receiver: the deployment's tool endpoint, capturing the context it
    // was handed instead of trusting the caller's word for it.
    let receipt: { traceId: string; spanId: string } | null = null;
    const toolEndpoint = Bun.serve({
      port: 0,
      fetch: (request) => {
        receipt = parseTraceparent(request.headers.get("traceparent"));
        return Response.json({ ok: true });
      },
    });

    // Hop 2's receiver: this process's /ag-ui entry, wrapped exactly as it ships.
    let agentSide: { traceId: string; spanId: string } | undefined;
    const agent = Bun.serve({
      port: 0,
      fetch: withTraceFetch(async () => {
        agentSide = currentTraceContext();
        const governedRun = governedRunSpan({
          runId: "run-chain",
          threadId: "thread-chain",
        });
        // The deployment tool loop's shape: the call runs INSIDE the tool span,
        // and its outbound dial injects the active context (index.ts callTool).
        const answer = await traceDeploymentToolCall(
          "deploy_probe",
          "call-chain",
          async () => {
            const response = await fetch(
              `http://127.0.0.1:${toolEndpoint.port}/api/agent-tools/call`,
              {
                method: "POST",
                headers: injectTraceHeaders({
                  "content-type": "application/json",
                  "x-openbot-agent-token": "test-token",
                }),
                body: JSON.stringify({
                  name: "deploy_probe",
                  args: {},
                  run: "run-chain",
                }),
              },
            );
            governedRun.finish("completed");
            return `status ${response.status}`;
          },
        );
        return new Response(answer);
      }),
    });

    try {
      // Hop 1: the server's outbound dial (createAgentFetch's injection).
      const serverRun = trace.getTracer("test.server").startSpan("server run");
      await context.with(
        trace.setSpan(context.active(), serverRun),
        async () => {
          const response = await fetch(`http://127.0.0.1:${agent.port}/ag-ui`, {
            method: "POST",
            headers: injectTraceHeaders({ "content-type": "application/json" }),
            body: JSON.stringify({}),
          });
          expect(response.status).toBe(200);
        },
      );
      serverRun.end();

      const serverTrace = serverRun.spanContext().traceId;
      // The agent continued the server's trace, not a fresh one.
      expect(agentSide?.traceId).toBe(serverTrace);
      // The tool receipt continued it too, parented on the tool span.
      expect(receipt).not.toBeNull();
      expect(receipt?.traceId).toBe(serverTrace);
      const toolSpan = spans.find((span) => span.name === "tool:deploy_probe");
      expect(toolSpan).toBeDefined();
      expect(receipt?.spanId).toBe(toolSpan?.spanContext().spanId);
      // And the run span itself rode the same trace.
      const runSpan = spans.find((span) => span.name === "ag-ui run");
      expect(runSpan?.spanContext().traceId).toBe(serverTrace);
    } finally {
      agent.stop(true);
      toolEndpoint.stop(true);
    }
  });

  test("a dial without the injection falls out of the chain — detectably", async () => {
    let receipt: { traceId: string; spanId: string } | null = null;
    const toolEndpoint = Bun.serve({
      port: 0,
      fetch: (request) => {
        receipt = parseTraceparent(request.headers.get("traceparent"));
        return Response.json({ ok: true });
      },
    });
    const agent = Bun.serve({
      port: 0,
      fetch: withTraceFetch(async () => {
        const governedRun = governedRunSpan({
          runId: "run-broken",
          threadId: "thread-broken",
        });
        const answer = await traceDeploymentToolCall(
          "deploy_probe",
          "call-broken",
          async () => {
            // The regression this pins: a bare fetch, no context carried.
            const response = await fetch(
              `http://127.0.0.1:${toolEndpoint.port}/api/agent-tools/call`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-openbot-agent-token": "test-token",
                },
                body: "{}",
              },
            );
            governedRun.finish("completed");
            return `status ${response.status}`;
          },
        );
        return new Response(answer);
      }),
    });

    try {
      const serverRun = trace.getTracer("test.server").startSpan("server run");
      await context.with(
        trace.setSpan(context.active(), serverRun),
        async () => {
          const response = await fetch(`http://127.0.0.1:${agent.port}/ag-ui`, {
            method: "POST",
            headers: injectTraceHeaders({ "content-type": "application/json" }),
            body: JSON.stringify({}),
          });
          expect(response.status).toBe(200);
        },
      );
      serverRun.end();

      // The receipt carries NO traceparent: nothing links this hop to the run,
      // which is precisely the difference the chain check detects upstream.
      expect(receipt).toBeNull();
    } finally {
      agent.stop(true);
      toolEndpoint.stop(true);
    }
  });

  test("the shipped tool dial is wired through the injection (source-level)", () => {
    const source = readFileSync(
      new URL("../src/index.ts", import.meta.url),
      "utf8",
    );
    // callTool's own fetch must build its headers through injectTraceHeaders —
    // the behavioral tests above prove the mechanism; this pins that the shipped
    // dial actually uses it.
    const callToolBody = source.slice(
      source.indexOf("async function callTool"),
      source.indexOf("function runAssertionOf"),
    );
    expect(callToolBody).toContain("injectTraceHeaders");
  });
});
