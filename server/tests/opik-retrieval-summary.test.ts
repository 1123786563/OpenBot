// T37-fix G3 — the retrieval hit summary must be observable on the REAL write and read paths.
//
// The registered gap: the recorder handed `kb_ids` to the deep projection, which wrapped every
// element in a SafeValue envelope; the port's serializer unwraps only the outermost envelope,
// so the upstream row stored envelope shapes (T37 probe A evidence: `kb_ids: [{state:"projected",
// value:"kb-t37-1"}, …]`) while the steps projection reads a bare string array — and the hit
// summary answered absent for every real retrieval step. Fail-closed, honest, and invisible.
//
// This file pins the whole composition, not a mock of it:
//   1. the production recorder (T15) over a trusted scope,
//   2. the real T09 bounded queue behind the real health service,
//   3. the verified port's actual OTLP serialization (injected transport — no network),
//   4. the upstream row shape the backend verifiably answers (each attribute value parsed
//      the way the real read-back observed it),
//   5. the production steps projection (T18-server) over that row.
// No database, no network; the only fakes are the HTTP transport below and the read-side port.
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { join } from "node:path";
import type { RunBinding } from "../src/ai-observability/bindings";
import type { OpikConfig } from "../src/ai-observability/config";
import { createOpikHealthService } from "../src/ai-observability/health";
import type {
  OpikPort,
  OpikSpanRow,
  VerifiedOpikContract,
} from "../src/ai-observability/opik-port";
import { createRunsQueryService } from "../src/ai-observability/queries/runs";
import { resolveObservationScope } from "../src/ai-observability/scope";
import { createToolStepRecorder } from "../src/ai-observability/tool-steps";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

const manifest = (await Bun.file(
  join(
    hereDir,
    "../src/ai-observability/opik-contract/47-manifest.json",
  ),
).json()) as VerifiedOpikContract;

const scope = resolveObservationScope({
  actorId: "user-g3",
  botId: "agent-1",
  ownership: "owner",
  epoch: 1,
});

const config = (): OpikConfig => ({
  enabled: true,
  baseUrl: "http://opik.test",
  apiKey: null,
  workspaceName: "openbot",
  port: 5174,
  otlpHttpPort: 5418,
  otlpGrpcPort: 5417,
});

/**
 * The real port over an injected transport: the request body is captured, so the
 * spans cross the SAME serializer production uses (where the envelope meets the wire).
 */
async function capturingPort() {
  const bodies: Array<{ url: string; body: string }> = [];
  // Rebuild the verified port with the capturing transport — same manifest, same
  // adapter, only the transport injected (no network anywhere).
  const { createOpikHttpPort } = await import(
    "../src/ai-observability/opik-http"
  );
  const capturing = createOpikHttpPort({
    baseUrl: "http://opik.test",
    contract: manifest,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      bodies.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response("", { status: 200 });
    }) as typeof fetch,
  });
  const writes = () => {
    const write = bodies.find((entry) =>
      entry.url.endsWith("/v1/private/otel/v1/traces"),
    );
    if (write === undefined) throw new Error("no span write reached the wire");
    // The verified OTLP JSON envelope: resourceSpans[] → scopeSpans[] → spans[].
    const parsed = JSON.parse(write.body) as {
      resourceSpans: Array<{
        scopeSpans: Array<{ spans: Record<string, unknown>[] }>;
      }>;
    };
    return parsed.resourceSpans[0].scopeSpans[0].spans;
  };
  return { port: capturing, writes };
}

/**
 * The upstream row exactly as the real backend answers it (T37 probe A evidence):
 * every OTLP attribute value lands inside the row's `input` object, a stringValue
 * that parses as JSON stored as that JSON, everything else as its scalar.
 */
function backendRowFromWire(span: Record<string, unknown>): OpikSpanRow {
  const input: Record<string, unknown> = {};
  for (const entry of (span.attributes ?? []) as Array<{
    key: string;
    value: Record<string, unknown>;
  }>) {
    if (entry.key.startsWith("opik.")) continue;
    const raw =
      entry.value.stringValue ??
      entry.value.intValue ??
      entry.value.doubleValue ??
      entry.value.boolValue;
    if (typeof raw !== "string") {
      input[entry.key] = raw;
      continue;
    }
    try {
      input[entry.key] = JSON.parse(raw);
    } catch {
      input[entry.key] = raw;
    }
  }
  const nanosToIso = (value: unknown): string =>
    new Date(Number(BigInt(String(value)) / 1_000_000n)).toISOString();
  return {
    id: String(span.spanId),
    project_id: "proj-g3",
    trace_id: "01a1405b-f832-70cf-b204-f4dd5138700",
    parent_span_id: null,
    name: String(span.name),
    type: "general",
    start_time: nanosToIso(span.startTimeUnixNano),
    end_time: nanosToIso(span.endTimeUnixNano),
    input,
    output: {},
    created_at: nanosToIso(span.endTimeUnixNano),
    last_updated_at: nanosToIso(span.endTimeUnixNano),
    duration: 1_500,
    source: "sdk",
  };
}

function bindingRow(opikTraceId: string): RunBinding {
  return {
    id: "binding-g3",
    scopeKey: scope.key,
    actorId: scope.actorId,
    botId: scope.botId,
    runId: "run-g3",
    attemptId: "attempt-g3",
    traceId: "traceg3traceg3traceg3traceg3traceg3",
    opikTraceId,
    locatorWorkspace: "ws",
    locatorProject: "proj",
    capability: "detailed",
    state: "completed",
    expiresAt: new Date("2026-10-23T00:00:00.000Z"),
    deletedAt: null,
    createdAt: new Date("2026-10-15T00:00:00.000Z"),
    updatedAt: new Date("2026-10-15T00:05:00.000Z"),
  };
}

/** The production read path over one upstream span row. */
async function readSteps(row: OpikSpanRow): Promise<unknown> {
  const readPort: OpikPort = {
    healthCheck: async () => ({ outcome: "ok", value: { healthy: true } }),
    retrieveProject: async () => ({ outcome: "ok", value: { id: "proj-g3" } }),
    listTraces: async () => ({
      outcome: "ok",
      value: { page: 0, size: 10, total: 0, content: [] },
    }),
    listSpans: async () => ({
      outcome: "ok",
      value: { page: 0, size: 10, total: 1, content: [row] },
    }),
    createTrace: async () => {
      throw new Error("read path never writes");
    },
    writeSpans: async () => {
      throw new Error("read path never writes");
    },
    deleteTraces: async () => {
      throw new Error("read path never writes");
    },
    deleteDataset: async () => {
      throw new Error("read path never writes");
    },
  };
  const runs = createRunsQueryService({
    bindings: {
      latestAttempt: async () => bindingRow(row.trace_id),
    },
    config,
    port: readPort,
    cacheTtlMs: 0,
  });
  return runs.steps(scope, "run-g3");
}

describe("the retrieval hit summary on the real write/read composition (G3)", () => {
  test("a recorded hit is observable in the steps projection", async () => {
    const { port, writes } = await capturingPort();
    const healthService = createOpikHealthService({ config, port });
    // The write gate answers only after a probe has succeeded (T09 fail-closed).
    await healthService.readiness();
    const recorder = createToolStepRecorder({ healthService });

    recorder.recordRetrieval({
      occurredAt: new Date("2026-10-16T11:00:00.000Z"),
      endedAt: new Date("2026-10-16T11:00:01.500Z"),
      query: "vacation policy",
      kbIds: ["kb-t37-1", "kb-t37-2"],
      outcome: {
        kind: "hit",
        fragments: [
          {
            kbId: "kb-t37-1",
            chunkId: "c-1",
            docId: "doc-7",
            source: "postmortem.md",
            score: 0.91,
          },
        ],
      },
      scope,
      trace: {
        traceId: "traceg3traceg3traceg3traceg3traceg3",
        parentSpanId: "aabbccddeeff0011",
        opikTraceId: "01a1405b-f832-70cf-b204-f4dd5138700",
      },
    });
    await healthService.drain();

    // The upstream row, shaped as the real backend verifiably answers, through the
    // production steps projection: the summary must be there.
    const wireSpan = writes()[0];
    expect(wireSpan.name).toBe("retrieval");
    const result = (await readSteps(backendRowFromWire(wireSpan))) as {
      steps: Array<{ kind: string; retrieval?: unknown }>;
    };
    const retrieval = result.steps.find((step) => step.kind === "retrieval");
    expect(retrieval).toBeDefined();
    expect(retrieval?.retrieval).toEqual({
      outcome: "hit",
      fragmentCount: 1,
      kbIds: ["kb-t37-1", "kb-t37-2"],
    });
  });

  test("a withheld kb id leaves the summary honestly absent, never partial", async () => {
    const { port, writes } = await capturingPort();
    const healthService = createOpikHealthService({ config, port });
    await healthService.readiness();
    const recorder = createToolStepRecorder({ healthService });

    const canary = `sk-live-${"a".repeat(24)}`;
    recorder.recordRetrieval({
      occurredAt: new Date("2026-10-16T11:00:00.000Z"),
      endedAt: new Date("2026-10-16T11:00:01.500Z"),
      query: "q",
      kbIds: ["kb-1", canary],
      outcome: { kind: "hit", fragments: [] },
      scope,
    });
    await healthService.drain();

    const wireSpan = writes()[0];
    expect(JSON.stringify(wireSpan)).not.toContain(canary);
    const row = backendRowFromWire(wireSpan);
    expect((row.input as Record<string, unknown>).kb_ids).toBeUndefined();
    const result = (await readSteps(row)) as {
      steps: Array<{ kind: string; retrieval?: unknown }>;
    };
    const retrieval = result.steps.find((step) => step.kind === "retrieval");
    // fragment_count is an integer and rides alone; the id list is honestly absent.
    expect(retrieval?.retrieval).toBeUndefined();
  });
});
