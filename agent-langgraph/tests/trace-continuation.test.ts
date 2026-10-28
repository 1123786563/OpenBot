/**
 * The live process's `traceparent` continuation, pinned end to end (F9A / F8D-1).
 *
 * F8D's real-stack wave read "the live agent-langgraph process ignores a valid
 * `traceparent` and roots a fresh trace" off an Opik query — and the finding's brief asked
 * for the propagator's registration timing to be fixed. The mechanism, re-established on a
 * pinned Opik 2.2.100 instance, was different: the endpoint's continuation spans were
 * silently DROPPED by the backend (an OTLP span whose parent id cannot be resolved in the
 * receiving project does not land, and the server-side SDK dial span that should have
 * parented them never landed either), so no continuation was ever observable there however
 * correctly it propagated. This suite pins the propagation itself, against the REAL process
 * over real HTTP, the way the finding could not:
 *
 *   * a request with a `traceparent` continues it — same trace id, parent named — both
 *     before and after real runs have flowed through the process (the "live process" of the
 *     finding, not a fresh boot);
 *   * the run's own spans ride the sent trace, not a fresh one;
 *   * a request WITHOUT a `traceparent` roots its own trace — the contrast that makes the
 *     continuation assertions mean something;
 *   * the entry module registers tracing before the framework imports evaluate (the
 *     registration-order half of the fix; see ../src/tracing.ts).
 *
 * The OTLP export is captured by a scripted sink — the exporter's real wire shape, no mock
 * of the propagation machinery — and the model is a scripted OpenAI-compatible SSE server,
 * so the whole run really streams through LangGraph's event machinery.
 */

import { readFileSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";

/** One exported span, the fields this suite reads. */
type ExportedSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
};

const TOKEN = "continuation-test-token";
/** The batch processor's clock, fast enough for the test's flush waits. */
const BSP_DELAY_MS = 300;

/** Collects the child's OTLP exports: the JSON shape the exporter actually sends. */
function otlpSink() {
  const spans: ExportedSpan[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 404 });
      const body = (await request.json()) as {
        resourceSpans?: Array<{
          scopeSpans?: Array<{
            spans?: Array<{
              traceId: string;
              spanId: string;
              parentSpanId?: string;
              name: string;
            }>;
          }>;
        }>;
      };
      for (const rs of body.resourceSpans ?? []) {
        for (const ss of rs.scopeSpans ?? []) {
          for (const span of ss.spans ?? []) {
            spans.push({
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId ?? null,
              name: span.name,
            });
          }
        }
      }
      return new Response(null, { status: 200 });
    },
  });
  return {
    spans,
    url: `http://127.0.0.1:${server.port}/v1/traces`,
    stop: () => server.stop(true),
  };
}

/** A scripted OpenAI-compatible `/v1/chat/completions`: proposes the deployment tool once. */
function scriptedModel() {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const body = (await request.json().catch(() => ({}))) as {
        model?: string;
      };
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-continuation-1",
                    type: "function",
                    function: { name: "report_environment", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ];
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of chunks) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: "chatcmpl-continuation",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: body.model ?? "continuation",
                  choices: chunk.choices,
                })}\n\n`,
              ),
            );
            await Bun.sleep(5);
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    stop: () => server.stop(true),
  };
}

/** Fixed W3C coordinates for one probe: well-formed, never accidentally reused. */
function traceparent(n: number): {
  header: string;
  traceId: string;
  spanId: string;
} {
  const traceId = `5f9a${String(n).padStart(2, "0")}`.padEnd(32, "c0ffee");
  const spanId = `0d1a${String(n).padStart(2, "0")}`.padEnd(16, "beef");
  return { header: `00-${traceId}-${spanId}-01`, traceId, spanId };
}

describe("the live process continues an inbound traceparent (F9A)", () => {
  let sink: ReturnType<typeof otlpSink>;
  let model: ReturnType<typeof scriptedModel>;
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let endpoint = "";
  const stderr: string[] = [];

  /** Waits for spans matching the predicate to have flushed out of the child. */
  async function flushed(
    predicate: (span: ExportedSpan) => boolean,
    ms = 5_000,
  ): Promise<ExportedSpan[]> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = sink.spans.filter(predicate);
      if (hit.length > 0) return hit;
      if (Date.now() > deadline) return hit;
      await Bun.sleep(100);
    }
  }

  beforeAll(async () => {
    sink = otlpSink();
    model = scriptedModel();
    // A free port for the child: bind 0, read it, release it. The window is short and the
    // suite fails loudly if another process grabbed it first.
    const picker = Bun.serve({ port: 0, fetch: () => new Response(null) });
    const port = picker.port;
    picker.stop(true);
    const here = new URL(".", import.meta.url).pathname;
    child = Bun.spawn(["bun", "--no-env-file", "src/index.ts"], {
      cwd: `${here}..`,
      env: {
        PATH: process.env.PATH,
        PORT: String(port),
        MANAGED_AGENT_TOKEN: TOKEN,
        BOT_PROVIDER: "openai",
        BOT_MODEL: "continuation-model",
        OPENAI_API_KEY: "synthetic-provider-key",
        OPENAI_BASE_URL: model.url,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: sink.url,
        OTEL_SERVICE_NAME: "agent-langgraph-continuation-test",
        OTEL_BSP_SCHEDULE_DELAY: String(BSP_DELAY_MS),
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    (async () => {
      if (child?.stderr) {
        for await (const line of child.stderr) stderr.push(String(line));
      }
    })();
    endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    for (;;) {
      const ready = await fetch(`${endpoint}/health`).then(
        (response) => response.ok,
        () => false,
      );
      if (ready) break;
      if (Date.now() > deadline) {
        throw new Error(
          `endpoint never became ready; stderr: ${stderr.join("")}`,
        );
      }
      await Bun.sleep(100);
    }
    // Let the readiness probes' own spans flush out before the assertions read the sink —
    // cosmetic separation only; the probes below dial paths of their own either way.
    await Bun.sleep(BSP_DELAY_MS * 4);
  }, 30_000);

  afterAll(() => {
    child?.kill();
    sink.stop();
    model.stop();
  });

  test("a request with a traceparent is continued — same trace, parent named", async () => {
    const sent = traceparent(1);
    // A path this suite alone dials: the readiness probes own /health, and their spans
    // flush on the processor's own clock — a name of our own keeps the two apart. The
    // endpoint answers 404 for it, and `withTraceFetch` wraps every request the same way.
    const response = await fetch(`${endpoint}/f9a-continuation-probe`, {
      headers: { traceparent: sent.header },
    });
    expect(response.status).toBe(404);
    // A transport-level retry would legitimately serve the probe twice; every served
    // request must CONTINUE the sent chain, and none may root a fresh trace.
    const probes = await flushed(
      (span) => span.name === "GET /f9a-continuation-probe",
    );
    expect(probes.length).toBeGreaterThanOrEqual(1);
    for (const span of probes) {
      expect(span.traceId).toBe(sent.traceId);
      expect(span.parentSpanId).toBe(sent.spanId);
    }
  }, 20_000);

  test("the run's own spans ride the sent trace, and later requests still continue", async () => {
    const run = traceparent(2);
    const runResponse = await fetch(`${endpoint}/ag-ui`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": TOKEN,
        traceparent: run.header,
      },
      body: JSON.stringify({
        threadId: "continuation-thread",
        runId: "run-continuation",
        messages: [
          { id: "m1", role: "user", content: "run the environment report" },
        ],
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    });
    expect(runResponse.ok).toBe(true);
    await runResponse.text();

    const request = await flushed(
      (span) => span.name === "POST /ag-ui" && span.traceId === run.traceId,
    );
    expect(request).toHaveLength(1);
    expect(request[0].parentSpanId).toBe(run.spanId);
    const governed = await flushed(
      (span) => span.name === "ag-ui run" && span.traceId === run.traceId,
    );
    expect(governed.length).toBeGreaterThanOrEqual(1);

    // The "live process" of the finding: a real run has flowed through, and the NEXT
    // inbound traceparent still continues rather than rooting a fresh trace.
    const after = traceparent(3);
    const probe = await fetch(`${endpoint}/f9a-continuation-probe-after`, {
      headers: { traceparent: after.header },
    });
    expect(probe.status).toBe(404);
    const health = await flushed(
      (span) =>
        span.name === "GET /f9a-continuation-probe-after" &&
        span.traceId === after.traceId,
    );
    expect(health.length).toBeGreaterThanOrEqual(1);
    for (const span of health) {
      expect(span.parentSpanId).toBe(after.spanId);
    }
  }, 30_000);

  test("a request without a traceparent roots its own trace — the contrast", async () => {
    const response = await fetch(`${endpoint}/ag-ui`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": TOKEN,
      },
      body: JSON.stringify({
        threadId: "continuation-thread",
        runId: "run-rooted",
        messages: [{ id: "m2", role: "user", content: "again" }],
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    });
    expect(response.ok).toBe(true);
    await response.text();
    const rooted = await flushed(
      (span) => span.name === "POST /ag-ui" && span.parentSpanId === null,
    );
    expect(rooted.length).toBeGreaterThanOrEqual(1);
    // None of the sent probe coordinates leaked into the rooted trace.
    for (const span of rooted) {
      expect(span.traceId).not.toBe(traceparent(1).traceId);
      expect(span.traceId).not.toBe(traceparent(2).traceId);
    }
  }, 20_000);

  test("the entry registers tracing before the framework imports (source-level)", () => {
    const source = readFileSync(
      new URL("../src/index.ts", import.meta.url),
      "utf8",
    );
    // The first import the module evaluates must be the tracing registration — the
    // controlled order; the behavioural tests above prove what it protects.
    const firstImport = source
      .split("\n")
      .find((line) => line.startsWith("import"));
    expect(firstImport).toBe('import "./tracing";');
  });
});
