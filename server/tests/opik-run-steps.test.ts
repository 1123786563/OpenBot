// T18-server / Issue #24 — the creator's step-tree read-back surface.
//
// The cases here run the same injected harness as the runs-query suite: management
// checks, an injected binding store and an injected OpikPort whose fake records every
// call and THROWS on write operations. No database, no network. What is under test is
// the seam T18's frontend pinned and this ticket fills: GET /bots/:botId/runs/:runId/steps
// answering the shared wire contract (RunStepsResult) from a real upstream span page,
// with the fail-closed discipline of the detail read it hangs off:
//   1. only a current manager may read; a guessed run id answers RUN_NOT_FOUND and
//      nothing upstream is asked;
//   2. the step projection is mechanical over the recorder families: step_kind and the
//      name prefix decide the kind, T15's vocabulary survives verbatim, content rides
//      only through the T05 projection, and a span outside the recorder families is not
//      a recorded step (it is dropped, never invented);
//   3. T15's A3 holds at the serving boundary: a step not observed as executed never
//      arrives claiming success;
//   4. an unavailable or lying upstream answers with the explainable codes, never a
//      disguised empty timeline.
import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfile } from "../src/agents/profile-types";
import type { RunBinding } from "../src/ai-observability/bindings";
import type { OpikConfig } from "../src/ai-observability/config";
import {
  type BotManagementCheck,
  OBSERVATION_BOT_NOT_FOUND,
} from "../src/ai-observability/context";
import type { ObservationScope } from "../src/ai-observability/contracts";
import type {
  OpikPort,
  OpikPortResult,
  OpikSpanRow,
} from "../src/ai-observability/opik-port";
import { createRunsQueryRoutes } from "../src/ai-observability/routes/runs";
import { resolveObservationScope } from "../src/ai-observability/scope";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";

const owner = { id: "user-owner", role: "user" } as const;
const stranger = { id: "user-stranger", role: "user" } as const;
const EPOCH = 3;

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agent-1",
    name: "Expense Manager",
    title: "Finance",
    roleDescription: "Reviews receipts.",
    avatarSeed: "expense-manager",
    visibility: "private",
    ownerUserId: owner.id,
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    ...overrides,
  } as AgentProfile;
}

function managementCheck(rows: AgentProfile[]): BotManagementCheck {
  return async (actor, botId) => {
    const found = rows.find((row) => row.id === botId) ?? null;
    if (!found) return null;
    if (found.systemOwned || found.deletedAt !== null) return null;
    return found.ownerUserId === actor.id || actor.role === "admin"
      ? found
      : null;
  };
}

function actorVariables(
  actor: AuthenticatedActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

const scopeA = resolveObservationScope({
  actorId: owner.id,
  botId: "agent-1",
  ownership: "owner",
  epoch: EPOCH,
});

function bindingRow(
  scope: ObservationScope,
  overrides: Partial<RunBinding> = {},
): RunBinding {
  return {
    id: "binding-1",
    scopeKey: scope.key,
    actorId: scope.actorId,
    botId: scope.botId,
    runId: "run-1",
    attemptId: "attempt-1",
    traceId: "trace-1",
    opikTraceId: "trace-1",
    locatorWorkspace: "ws",
    locatorProject: "proj",
    capability: "detailed",
    state: "completed",
    expiresAt: new Date("2026-10-23T00:00:00.000Z"),
    deletedAt: null,
    createdAt: new Date("2026-10-15T00:00:00.000Z"),
    updatedAt: new Date("2026-10-15T00:05:00.000Z"),
    ...overrides,
  };
}

/*
 * One upstream span row, shaped exactly as the verified read-back observed it (the OTLP
 * attributes land inside the row's `input` object, `input`/`output` content under their
 * own keys, ids hyphenated UUIDv7s the backend adopted from the overrides).
 */
function spanRow(overrides: Record<string, unknown> = {}): OpikSpanRow {
  return {
    id: "span-1",
    project_id: "proj-1",
    trace_id: "trace-1",
    parent_span_id: null,
    name: "tool:web_search",
    type: "general",
    start_time: "2026-10-16T09:30:08.000Z",
    end_time: "2026-10-16T09:30:09.000Z",
    input: {
      step_kind: "tool",
      tool_call_id: "call-1",
      execution_state: "executed",
      span_state: "completed",
      origin: "builtin",
      input: "the projected call arguments",
    },
    output: { output: "the projected result text" },
    created_at: "2026-10-16T09:30:09.500Z",
    last_updated_at: "2026-10-16T09:30:09.500Z",
    duration: 1000,
    source: "sdk",
    ...overrides,
  } as OpikSpanRow;
}

/** The read-only port fake: records every call, throws on any write operation. */
function fakePort(
  behavior: {
    project?: OpikPortResult<{ id: string } | null>;
    spans?: OpikPortResult<{
      page: number;
      size: number;
      total: number;
      content: readonly OpikSpanRow[];
    }>;
    /** Page answers by call number, for walking the envelope across pages. */
    spansByCall?: () => OpikPortResult<{
      page: number;
      size: number;
      total: number;
      content: readonly OpikSpanRow[];
    }>;
    rows?: OpikSpanRow[];
  } = {},
) {
  const calls: Array<{
    op: string;
    projectId?: string;
    traceId?: string;
    size?: number;
    page?: number;
  }> = [];
  const port: OpikPort = {
    healthCheck: async () => ({ outcome: "ok", value: { healthy: true } }),
    retrieveProject: async () => {
      calls.push({ op: "retrieveProject" });
      return behavior.project ?? { outcome: "ok", value: { id: "proj-1" } };
    },
    listTraces: async () => {
      calls.push({ op: "listTraces" });
      return {
        outcome: "ok",
        value: { page: 1, size: 0, total: 0, content: [] },
      };
    },
    listSpans: async (_scope, input) => {
      calls.push({
        op: "listSpans",
        projectId: input.projectId,
        traceId: input.traceId,
        size: input.size,
        page: input.page,
      });
      if (behavior.spansByCall !== undefined) return behavior.spansByCall();
      if (behavior.spans !== undefined) return behavior.spans;
      const rows = behavior.rows ?? [];
      return {
        outcome: "ok",
        value: {
          page: 1,
          size: rows.length,
          total: rows.length,
          content: rows,
        },
      };
    },
    createTrace: async () => {
      calls.push({ op: "createTrace" });
      throw new Error("the read surface must never write");
    },
    writeSpans: async () => {
      calls.push({ op: "writeSpans" });
      throw new Error("the read surface must never write");
    },
    deleteTraces: async () => {
      throw new Error("the read surface must never write");
    },
    deleteDataset: async () => {
      throw new Error("the read surface must never write");
    },
  };
  return { port, calls };
}

const enabledConfig: OpikConfig = {
  enabled: true,
  baseUrl: "http://opik.test",
  apiKey: "held-for-port-wiring",
  workspaceName: "ws",
  port: 5174,
  otlpHttpPort: 5418,
  otlpGrpcPort: 5417,
};

function appFor(
  setup: {
    rows?: AgentProfile[];
    actor?: typeof owner | typeof stranger;
    bindings?: RunBinding[];
    port?: ReturnType<typeof fakePort>;
    config?: () => OpikConfig;
  } = {},
) {
  const port = setup.port ?? fakePort();
  const app = new Hono<{ Variables: AppVariables }>();
  app.use(
    "*",
    actorVariables((setup.actor ?? owner) as unknown as AuthenticatedActor),
  );
  app.route(
    "/bots/:botId/runs",
    createRunsQueryRoutes({
      canManageBot: managementCheck(setup.rows ?? [profile()]),
      scopeEpoch: async () => EPOCH,
      bindings: {
        latestAttempt: async (scope, runId) =>
          (setup.bindings ?? [bindingRow(scopeA)]).find(
            (row) => row.scopeKey === scope.key && row.runId === runId,
          ) ?? null,
      },
      config: setup.config ?? (() => enabledConfig),
      port: port.port,
    }),
  );
  return { app, port };
}

function steps(
  app: ReturnType<typeof appFor>["app"],
  runId = "run-1",
  botId = "agent-1",
) {
  return app.request(`http://openbot.test/bots/${botId}/runs/${runId}/steps`, {
    method: "GET",
  });
}

/** How many span reads reached the fake port. */
const spanReads = (calls: Array<{ op: string }>) =>
  calls.filter((call) => call.op === "listSpans").length;

describe("steps — acceptance 1 (A5): only current managers may read", () => {
  test("a stranger on a public Bot meets the not-found refusal, and the port is never asked", async () => {
    const { app, port } = appFor({
      rows: [profile({ visibility: "public" })],
      actor: stranger,
    });
    const response = await steps(app);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: OBSERVATION_BOT_NOT_FOUND });
    expect(spanReads(port.calls)).toBe(0);
  });

  test("a guessed run id answers RUN_NOT_FOUND before any upstream call", async () => {
    const { app, port } = appFor({ bindings: [] });
    const response = await steps(app, "run-guessed");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "RUN_NOT_FOUND" });
    expect(port.calls.length).toBe(0);
  });

  test("an unknown Bot is the manage gate's own refusal", async () => {
    const { app } = appFor({ rows: [] });
    const response = await steps(app);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: OBSERVATION_BOT_NOT_FOUND });
  });
});

describe("steps — acceptance 2: the projection is the record's own", () => {
  test("the whole timeline in one page: kinds, nesting locators, vocabulary, content", async () => {
    const { app, port } = appFor({
      port: fakePort({
        rows: [
          spanRow({
            id: "span-model",
            name: "model:gpt-x",
            start_time: "2026-10-16T09:30:05.000Z",
            end_time: "2026-10-16T09:30:08.000Z",
            input: {
              span_state: "completed",
              usage_state: "actual",
              origin: "builtin",
              input: "the prompt",
            },
            output: { output: "the answer" },
          }),
          spanRow(),
          spanRow({
            id: "span-retr",
            parent_span_id: "span-1",
            name: "retrieval",
            start_time: "2026-10-16T09:30:08.100Z",
            end_time: "2026-10-16T09:30:08.900Z",
            input: {
              step_kind: "retrieval",
              retrieval_outcome: "hit",
              fragment_count: 3,
              kb_ids: ["kb-1", "kb-2"],
              span_state: "completed",
              origin: "builtin",
              input: "receipts policy",
            },
          }),
        ],
      }),
    });
    const response = await steps(app);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { steps: unknown[] };
    expect(body.steps).toEqual([
      {
        kind: "model",
        spanId: "span-model",
        parentSpanId: null,
        name: "gpt-x",
        state: "completed",
        startedAt: "2026-10-16T09:30:05.000Z",
        endedAt: "2026-10-16T09:30:08.000Z",
        input: { state: "projected", value: "the prompt" },
        output: { state: "projected", value: "the answer" },
      },
      {
        kind: "tool",
        spanId: "span-1",
        parentSpanId: null,
        name: "web_search",
        state: "completed",
        startedAt: "2026-10-16T09:30:08.000Z",
        endedAt: "2026-10-16T09:30:09.000Z",
        executionState: "executed",
        input: { state: "projected", value: "the projected call arguments" },
        output: { state: "projected", value: "the projected result text" },
      },
      {
        kind: "retrieval",
        spanId: "span-retr",
        parentSpanId: "span-1",
        name: null,
        state: "completed",
        startedAt: "2026-10-16T09:30:08.100Z",
        endedAt: "2026-10-16T09:30:08.900Z",
        input: { state: "projected", value: "receipts policy" },
        retrieval: {
          outcome: "hit",
          fragmentCount: 3,
          kbIds: ["kb-1", "kb-2"],
        },
      },
    ]);
    // The read went to the bound trace in the scope's own project.
    const spanCalls = port.calls.filter((call) => call.op === "listSpans");
    expect(spanCalls.length).toBe(1);
    expect(spanCalls[0]).toMatchObject({
      projectId: "proj-1",
      traceId: "trace-1",
    });
  });

  test("upstream rows arrive newest-first; the wire answers the chronology", async () => {
    const { app } = appFor({
      port: fakePort({
        rows: [
          spanRow({ id: "late", start_time: "2026-10-16T09:31:00.000Z" }),
          spanRow({ id: "early", start_time: "2026-10-16T09:30:00.000Z" }),
        ],
      }),
    });
    const response = await steps(app);
    const body = (await response.json()) as {
      steps: Array<{ spanId: string }>;
    };
    expect(body.steps.map((step) => step.spanId)).toEqual(["early", "late"]);
  });

  test("a span outside the recorder families is not a recorded step", async () => {
    const { app } = appFor({
      port: fakePort({
        rows: [spanRow(), spanRow({ id: "foreign", name: "custom_thing" })],
      }),
    });
    const response = await steps(app);
    const body = (await response.json()) as {
      steps: Array<{ spanId: string }>;
    };
    expect(body.steps.map((step) => step.spanId)).toEqual(["span-1"]);
  });

  test("an empty name is folded into null, never a blank title (L-3)", async () => {
    const { app } = appFor({
      port: fakePort({ rows: [spanRow({ name: "tool:" })] }),
    });
    const response = await steps(app);
    const body = (await response.json()) as {
      steps: Array<{ name: unknown }>;
    };
    expect(body.steps[0].name).toBeNull();
  });

  test("a duplicate span id answers once, not a keyed warning (L-4)", async () => {
    const { app } = appFor({
      port: fakePort({
        rows: [spanRow(), spanRow({ output: undefined })],
      }),
    });
    const response = await steps(app);
    const body = (await response.json()) as {
      steps: Array<{ spanId: string }>;
    };
    expect(body.steps.map((step) => step.spanId)).toEqual(["span-1"]);
  });
});

describe("steps — acceptance 3 (A3): a proposal never arrives as success", () => {
  test("a proposed step whose row claims completed is served unknown", async () => {
    const { app } = appFor({
      port: fakePort({
        rows: [
          spanRow({
            input: {
              step_kind: "tool",
              execution_state: "proposed",
              span_state: "completed",
            },
          }),
        ],
      }),
    });
    const response = await steps(app);
    const body = (await response.json()) as {
      steps: Array<{ state: string; executionState?: string }>;
    };
    expect(body.steps[0].executionState).toBe("proposed");
    expect(body.steps[0].state).toBe("unknown");
  });

  test("an unobserved step that claims completed is served unknown too", async () => {
    const { app } = appFor({
      port: fakePort({
        rows: [
          spanRow({
            input: {
              step_kind: "tool",
              execution_state: "unobserved",
              span_state: "completed",
            },
          }),
        ],
      }),
    });
    const response = await steps(app);
    const body = (await response.json()) as {
      steps: Array<{ state: string }>;
    };
    expect(body.steps[0].state).toBe("unknown");
  });

  test("an executed step keeps its recorded terminal state", async () => {
    const { app } = appFor({
      port: fakePort({
        rows: [
          spanRow({
            input: {
              step_kind: "tool",
              execution_state: "executed",
              span_state: "failed",
            },
          }),
        ],
      }),
    });
    const response = await steps(app);
    const body = (await response.json()) as {
      steps: Array<{ state: string }>;
    };
    expect(body.steps[0].state).toBe("failed");
  });
});

describe("steps — vocabulary and content fail closed", () => {
  test("an unheard terminal state answers unknown; an unheard determination makes no claim", async () => {
    const { app } = appFor({
      port: fakePort({
        rows: [
          spanRow({
            input: {
              step_kind: "tool",
              execution_state: "hallucinated",
              span_state: "exploded",
            },
          }),
        ],
      }),
    });
    const response = await steps(app);
    const body = (await response.json()) as {
      steps: Array<{ state: string; executionState?: unknown }>;
    };
    expect(body.steps[0].state).toBe("unknown");
    expect("executionState" in body.steps[0]).toBe(false);
  });

  test("a retrieval miss and a degraded reason answer in T15's shapes", async () => {
    const { app } = appFor({
      port: fakePort({
        rows: [
          spanRow({
            id: "miss",
            name: "retrieval",
            input: {
              step_kind: "retrieval",
              retrieval_outcome: "miss",
              span_state: "completed",
              input: "the query",
            },
          }),
          spanRow({
            id: "degraded",
            name: "retrieval",
            start_time: "2026-10-16T09:30:08.000Z",
            input: {
              step_kind: "retrieval",
              retrieval_outcome: "degraded",
              degraded_reason: "kb unavailable",
              span_state: "failed",
            },
          }),
        ],
      }),
    });
    const response = await steps(app);
    const body = (await response.json()) as {
      steps: Array<{ retrieval?: { outcome: string } }>;
    };
    expect(body.steps[0].retrieval).toEqual({ outcome: "miss" });
    expect(body.steps[1].retrieval).toEqual({
      outcome: "degraded",
      reason: "kb unavailable",
    });
  });

  test("a hit that cannot say its count makes no retrieval claim, but keeps its row", async () => {
    const { app } = appFor({
      port: fakePort({
        rows: [
          spanRow({
            name: "retrieval",
            input: {
              step_kind: "retrieval",
              retrieval_outcome: "hit",
              span_state: "completed",
            },
          }),
        ],
      }),
    });
    const response = await steps(app);
    const body = (await response.json()) as {
      steps: Array<{ spanId: string; retrieval?: unknown }>;
    };
    expect(body.steps.length).toBe(1);
    expect(body.steps[0].retrieval).toBeUndefined();
  });

  test("a degraded reason the projection refuses makes no claim (T05 on read)", async () => {
    const { app } = appFor({
      port: fakePort({
        rows: [
          spanRow({
            name: "retrieval",
            input: {
              step_kind: "retrieval",
              retrieval_outcome: "degraded",
              degraded_reason: "password postgresql://u:p@h/db",
              span_state: "failed",
            },
          }),
        ],
      }),
    });
    const response = await steps(app);
    const body = (await response.json()) as {
      steps: Array<{ retrieval?: unknown }>;
    };
    expect(body.steps[0].retrieval).toBeUndefined();
  });

  test("content rides the wire only through the projection: a credential dies at the read", async () => {
    const { app } = appFor({
      port: fakePort({
        rows: [
          spanRow({
            input: {
              step_kind: "tool",
              execution_state: "executed",
              span_state: "completed",
              input: "api_key sk-live-abcdefghijklmnopqrst",
            },
          }),
        ],
      }),
    });
    const response = await steps(app);
    const body = (await response.json()) as {
      steps: Array<{ input?: { state: string } }>;
    };
    expect(body.steps[0].input?.state).toBe("omitted");
  });
});

describe("steps — acceptance 4: honest absence, honest failure", () => {
  test("an unreconciled run answers an empty timeline and asks upstream nothing", async () => {
    const { app, port } = appFor({
      bindings: [bindingRow(scopeA, { opikTraceId: null })],
    });
    const response = await steps(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ steps: [] });
    expect(spanReads(port.calls)).toBe(0);
  });

  test("a project the store no longer holds answers an empty timeline", async () => {
    const { app, port } = appFor({
      port: fakePort({ project: { outcome: "ok", value: null } }),
    });
    const response = await steps(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ steps: [] });
    expect(spanReads(port.calls)).toBe(0);
  });

  test("a disabled deployment answers capability_missing", async () => {
    const { app } = appFor({
      config: () => ({ ...enabledConfig, enabled: false }),
    });
    const response = await steps(app);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "capability_missing" });
  });

  test("an unreachable upstream answers its code, never an empty timeline", async () => {
    const { app } = appFor({
      port: fakePort({
        spans: {
          outcome: "unavailable",
          operation: "listSpans",
          code: "OPIK_TIMEOUT",
        },
      }),
    });
    const response = await steps(app);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "OPIK_TIMEOUT" });
  });

  test("an upstream failure answers its code", async () => {
    const { app } = appFor({
      port: fakePort({
        spans: {
          outcome: "upstream_error",
          operation: "listSpans",
          code: "OPIK_UPSTREAM_ERROR",
          status: 500,
        },
      }),
    });
    const response = await steps(app);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "OPIK_UPSTREAM_ERROR" });
  });

  test("a span row without its window is the store failing to answer", async () => {
    const { app } = appFor({
      port: fakePort({
        rows: [spanRow({ start_time: 1234 })],
      }),
    });
    const response = await steps(app);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "OPIK_MALFORMED_RESPONSE" });
  });

  test("a page that never arrives whole keeps asking until the envelope is covered", async () => {
    // Page 1 carries one of two rows; the walk continues to page 2 rather than
    // truncating the timeline.
    let call = 0;
    const rows = [
      spanRow(),
      spanRow({ id: "span-2", start_time: "2026-10-16T09:32:00.000Z" }),
    ];
    const { app, port } = appFor({
      port: fakePort({
        spansByCall: () => {
          call += 1;
          return call === 1
            ? {
                outcome: "ok",
                value: { page: 1, size: 1, total: 2, content: [rows[0]] },
              }
            : {
                outcome: "ok",
                value: { page: 2, size: 1, total: 2, content: [rows[1]] },
              };
        },
      }),
    });
    const response = await steps(app);
    const body = (await response.json()) as {
      steps: Array<{ spanId: string }>;
    };
    expect(body.steps.map((step) => step.spanId)).toEqual(["span-1", "span-2"]);
    expect(call).toBe(2);
    expect(spanReads(port.calls)).toBe(2);
  });

  test("a trace the defensive page ceiling cannot cover is a 502, never a shorter timeline", async () => {
    // Every page arrives whole, but the trace outlasts the defensive walk ceiling:
    // the read refuses (the store failed to answer the whole question) rather than
    // answering 200 with a timeline it silently cut short.
    let call = 0;
    const { app, port } = appFor({
      port: fakePort({
        spansByCall: () => {
          call += 1;
          return {
            outcome: "ok" as const,
            value: {
              page: call,
              size: 100,
              total: 100 * 100 + 1, // one row past the ceiling's reach
              content: Array.from({ length: 100 }, (_, index) =>
                spanRow({ id: `span-${call}-${index}` }),
              ),
            },
          };
        },
      }),
    });
    const response = await steps(app);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "OPIK_MALFORMED_RESPONSE" });
    expect(spanReads(port.calls)).toBe(100);
  });
});

describe("steps — the surface is read-only, never a proxy", () => {
  test("no caller input reaches the port; writes throw loudly", async () => {
    const { app, port } = appFor();
    const response = await steps(app, "run-1");
    expect(response.status).toBe(200);
    const spanCalls = port.calls.filter((call) => call.op === "listSpans");
    expect(spanCalls.length).toBe(1);
    expect(spanCalls[0].traceId).toBe("trace-1");
    expect(
      port.calls.some(
        (call) => call.op === "createTrace" || call.op === "writeSpans",
      ),
    ).toBe(false);
  });
});
