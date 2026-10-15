/**
 * The governed egress pinned at the byte level (T16 review M-1/L-1).
 *
 * The API-object tests in governed-tracing.test.ts assert what spans hold in memory; this
 * file asserts what actually leaves the process: shared/trace.ts's real provider
 * (BatchSpanProcessor + OTLPTraceExporter) posting to a local fake OTLP collector, with
 * canaries planted in every content channel — including the non-Error throw the review
 * proved could ride `openbot.error.name` verbatim into exported bytes — and then hunted
 * through the raw POSTed bytes, not the span objects.
 */

import { describe, expect, test } from "bun:test";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import { DiagConsoleLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import { initProcessTracing, shutdownTracing } from "../../shared/trace";
import {
  GovernedCallbackHandler,
  governedRunSpan,
  traceDeploymentToolCall,
} from "../src/governed-tracing";

/**
 * The same credential classes the API-object tests use, plus the shape that exposed M-1:
 * plain free text that passes the structural-name allowlist `[\w.:@/ -]`, so only refusing
 * to carry the thrown value at all can keep it out of the export.
 */
const CANARIES = [
  "sk-live-abcdefghijklmnopqrstuv",
  "Bearer abcdefghijklmnopqrstuv",
  "ghp_abcdefghijklmnopqrstuvwxyz123456",
  "postgres://user:secret@db.example.com/prod",
  "plain-token-shape-secret",
];

describe("the governed egress at the byte level (real provider, fake OTLP collector)", () => {
  test("canaries planted anywhere, including a non-Error throw, never reach the POSTed bytes", async () => {
    const posted: Buffer[] = [];
    const collector = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        posted.push(Buffer.from(await request.arrayBuffer()));
        return new Response(null, { status: 200 });
      },
    });
    initProcessTracing("openbot.agent-langgraph.test", {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${collector.port}/v1/traces`,
    });

    try {
      const handler = new GovernedCallbackHandler();
      const serialized = (name: string) =>
        ({ id: ["test", name], kwargs: {} }) as unknown as Serialized;

      handler.handleChainStart(serialized("graph"), {}, "run-graph");
      handler.handleLLMStart(
        serialized("llm"),
        [CANARIES.join(" ")],
        "run-model",
        "run-graph",
      );
      handler.handleLLMEnd(
        { generations: [[{ text: CANARIES[1] }]] } as unknown as LLMResult,
        "run-model",
      );
      handler.handleToolStart(
        serialized("tool"),
        JSON.stringify({ q: CANARIES[2] }),
        "run-tool",
        "run-graph",
      );
      // The M-1 channel: a thrown non-Error value, through the framework callbacks and
      // through the deployment tool wrapper — in each it must collapse to a typed marker.
      handler.handleToolError(`tool blew up ${CANARIES[4]}`, "run-tool");
      handler.handleRetrieverStart(
        serialized("kb"),
        CANARIES[3],
        "run-ret",
        "run-graph",
      );
      handler.handleRetrieverEnd([], "run-ret");
      handler.handleChainEnd({}, "run-graph");

      let threw = false;
      try {
        await traceDeploymentToolCall("web_search", "call_1", async () => {
          throw `deploy blew up ${CANARIES[4]}`;
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      governedRunSpan({ runId: "run_1", threadId: "thread_1" }).finish(
        "completed",
      );
    } finally {
      await shutdownTracing(); // Flushes the batch processor into the collector.
      collector.stop(true);
      // Leave the diag logger silent for whichever test file runs next.
      diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.NONE);
    }

    expect(posted.length).toBeGreaterThan(0);
    const bytes = Buffer.concat(posted);
    for (const canary of CANARIES) {
      expect(bytes.includes(canary)).toBe(false);
    }
    // The export was real (the run span rode it) and the non-Error throw left its typed
    // marker, never its value.
    expect(bytes.includes("ag-ui run")).toBe(true);
    expect(bytes.includes("NonErrorThrow")).toBe(true);
  });
});
