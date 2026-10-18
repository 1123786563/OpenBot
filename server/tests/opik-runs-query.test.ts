// Issue #17 / DAG T11 — the creator's read-only run query surface.
//
// Every case here runs against injected checks, an injected binding store and an
// injected OpikPort, exactly like the T01/T09/T10 suites: no database, no network,
// and the fake port THROWS on write operations, so any accidental write path fails
// loudly instead of silently succeeding.
//
// The acceptance under test, in issue order:
//   1. only a current manager (owner or in-scope admin) may query; public chat
//      access, forged ownership, guessed ids and cross-scope cursors widen nothing.
//   2. list/detail answer the actual state, duration, safe content and version
//      references; missing provider usage is an explicit "unavailable", never 0.
//   3. transfer or revocation makes history, pagination and the cache immediately
//      unreadable: manage flips answer 404, an epoch bump kills outstanding
//      cursors (T06 downstream obligation: 403 OWNERSHIP_REQUIRED) and orphans the
//      cache under the old scope key.
//   4. the surface is not an upstream query proxy: caller query params never reach
//      Opik, and two scopes holding the same resource ids stay isolated.
//   5. an unavailable upstream answers with an explainable error code, never a
//      disguised empty list.
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
import {
  type OpikPort,
  OpikPortError,
  type OpikPortResult,
  type OpikTraceRow,
} from "../src/ai-observability/opik-port";
import {
  createRunsQueryService,
  projectRow,
  RunsQueryError,
  UPSTREAM_RUN_STATUS,
} from "../src/ai-observability/queries/runs";
import { createRunsQueryRoutes } from "../src/ai-observability/routes/runs";
import { resolveObservationScope } from "../src/ai-observability/scope";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";

const owner = { id: "user-owner", role: "user" } as const;
const otherOwner = { id: "user-b", role: "user" } as const;
const admin = { id: "user-admin", role: "admin" } as const;
const stranger = { id: "user-stranger", role: "user" } as const;

const EPOCH = 3;
const WINDOW = 5;

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

/** 管理级 check：与 canManageAgent 同语义，测试里用它替代真实 store。 */
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
const scopeB = resolveObservationScope({
  actorId: otherOwner.id,
  botId: "agent-1",
  ownership: "owner",
  epoch: EPOCH,
});

function bindingRow(
  scope: ObservationScope,
  overrides: Partial<RunBinding> = {},
): RunBinding {
  return {
    id: `binding-${scope.actorId}`,
    scopeKey: scope.key,
    actorId: scope.actorId,
    botId: scope.botId,
    runId: "run-1",
    attemptId: "attempt-1",
    traceId: "trace-1",
    opikTraceId: "trace-1",
    locatorWorkspace: "ws",
    locatorProject: "proj",
    capability: "basic",
    state: "running",
    expiresAt: new Date("2026-10-23T00:00:00.000Z"),
    deletedAt: null,
    createdAt: new Date("2026-10-15T00:00:00.000Z"),
    updatedAt: new Date("2026-10-15T00:05:00.000Z"),
    ...overrides,
  };
}

function traceRow(overrides: Record<string, unknown> = {}): OpikTraceRow {
  return {
    id: "trace-1",
    status: "COMPLETED",
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    metadata: {
      run_id: "run-1",
      attempt_id: "attempt-1",
      deployment_version: "v42",
      prompt_version: "pv-7",
      duration_ms: 21_860,
      // Not on the T05 metadata allowlist: must be dropped outright.
      input: "raw prompt that must not survive projection",
    },
    ...overrides,
  } as OpikTraceRow;
}

const projectedMetadata = {
  run_id: { state: "projected", value: "run-1" },
  attempt_id: { state: "projected", value: "attempt-1" },
  deployment_version: { state: "projected", value: "v42" },
  prompt_version: { state: "projected", value: "pv-7" },
  duration_ms: { state: "projected", value: 21_860 },
};

/** The read-only port fake: records every call, throws on any write operation. */
function fakePort(
  behavior: {
    project?: OpikPortResult<{ id: string } | null>;
    traces?: OpikPortResult<{
      page: number;
      size: number;
      total: number;
      content: readonly OpikTraceRow[];
    }>;
    rows?: OpikTraceRow[];
    /**
     * OCR R3-28: a pre-I/O refusal — requireOperation's CONTRACT_UNVERIFIED /
     * OPERATION_UNSUPPORTED throw before any fetch. The adapter method is
     * async, so the caller sees a rejected promise, never an OpikPortResult.
     */
    refuseProject?: OpikPortError;
  } = {},
) {
  const calls: Array<{ op: string; projectId?: string; size?: number }> = [];
  const port: OpikPort = {
    healthCheck: async () => ({ outcome: "ok", value: { healthy: true } }),
    retrieveProject: async () => {
      calls.push({ op: "retrieveProject" });
      if (behavior.refuseProject) throw behavior.refuseProject;
      return behavior.project ?? { outcome: "ok", value: { id: "proj-1" } };
    },
    listTraces: async (_scope, input) => {
      calls.push({
        op: "listTraces",
        projectId: input.projectId,
        size: input.size,
      });
      const rows = behavior.rows ?? [];
      return (
        behavior.traces ?? {
          outcome: "ok",
          value: {
            page: 1,
            size: input.size,
            total: rows.length,
            content: rows,
          },
        }
      );
    },
    createTrace: async () => {
      calls.push({ op: "createTrace" });
      throw new Error("the read surface must never write");
    },
    writeSpans: async () => {
      calls.push({ op: "writeSpans" });
      throw new Error("the read surface must never write");
    },
    listSpans: async () => {
      calls.push({ op: "listSpans" });
      throw new Error("the runs list never reads spans");
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
    actor?: typeof owner | typeof otherOwner | typeof admin | typeof stranger;
    bindings?: RunBinding[];
    port?: ReturnType<typeof fakePort>;
    config?: () => OpikConfig;
    scopeEpoch?: (
      actor: { id: string; role: string },
      botId: string,
    ) => Promise<number>;
    windowSize?: number;
    cacheTtlMs?: number;
    now?: () => Date;
    /** Issue #18: the row-level capability join, when the wiring provides it. */
    capabilities?: ReadonlyMap<string, string>;
    /** Issue #18: unreconciled bindings this scope holds, for the list-level syncing flag. */
    unreconciled?: number;
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
      scopeEpoch: setup.scopeEpoch ?? (async () => EPOCH),
      bindings: {
        latestAttempt: async (scope, runId) =>
          (setup.bindings ?? [bindingRow(scopeA)]).find(
            (row) => row.scopeKey === scope.key && row.runId === runId,
          ) ?? null,
        capabilitiesByOpikTraceIds: async (_scope, ids) =>
          new Map(
            [...(setup.capabilities ?? new Map())].filter(([id]) =>
              ids.includes(id),
            ),
          ),
        countUnreconciled: async () => setup.unreconciled ?? 0,
      },
      config: setup.config ?? (() => enabledConfig),
      port: port.port,
      windowSize: setup.windowSize ?? WINDOW,
      cacheTtlMs: setup.cacheTtlMs ?? 5,
      now: setup.now,
    }),
  );
  return { app, port };
}

function list(
  app: ReturnType<typeof appFor>["app"],
  query = "",
  botId = "agent-1",
) {
  return app.request(`http://openbot.test/bots/${botId}/runs${query}`, {
    method: "GET",
  });
}

function detail(
  app: ReturnType<typeof appFor>["app"],
  runId = "run-1",
  botId = "agent-1",
) {
  return app.request(`http://openbot.test/bots/${botId}/runs/${runId}`, {
    method: "GET",
  });
}

/** How many read operations reached the fake port. */
const reads = (calls: Array<{ op: string }>) =>
  calls.filter(
    (call) => call.op === "retrieveProject" || call.op === "listTraces",
  ).length;

const fiveRows = ["t1", "t2", "t3", "t4", "t5"].map((id) => traceRow({ id }));

describe("runs query — acceptance 1: only current managers may query", () => {
  test("public chat access grants nothing: a stranger on a public Bot is refused", async () => {
    const { app, port } = appFor({
      rows: [profile({ visibility: "public" })],
      actor: stranger,
    });
    const response = await list(app);
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe(OBSERVATION_BOT_NOT_FOUND);
    expect(reads(port.calls)).toBe(0);
  });

  test("a public Bot's 404 and an unknown Bot's 404 are identical, so probing learns nothing", async () => {
    const { app } = appFor({
      rows: [profile({ visibility: "public" })],
      actor: stranger,
    });
    const existing = await list(app);
    const unknown = await list(app, "", "agent-nope");
    expect(existing.status).toBe(unknown.status);
    expect(await existing.json()).toEqual(await unknown.json());
  });

  test("an in-scope admin may list and read detail", async () => {
    // The scope is per actor (T06), so the admin reads the records bound under
    // their own manager scope — management rights are the gate, the scope key is
    // the record space.
    const adminScope = resolveObservationScope({
      actorId: admin.id,
      botId: "agent-1",
      ownership: "admin",
      epoch: EPOCH,
    });
    const { app } = appFor({
      actor: admin,
      bindings: [bindingRow(adminScope)],
    });
    expect((await list(app)).status).toBe(200);
    expect((await detail(app)).status).toBe(200);
  });

  test("a guessed run id answers 404 and upstream is never asked", async () => {
    const { app, port } = appFor();
    const response = await detail(app, "run-guessed");
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("RUN_NOT_FOUND");
    expect(reads(port.calls)).toBe(0);
  });

  test("two scopes holding the same resource ids stay isolated", async () => {
    // Both scopes own a binding for the SAME run id with different attempt ids;
    // each scope must only ever see its own row. The TTL is the production
    // default: the count of upstream reads this asserts must not race a
    // sub-test wall clock.
    const shared = fakePort();
    const a = appFor({
      bindings: [bindingRow(scopeA, { attemptId: "a-1" })],
      port: shared,
      cacheTtlMs: 5_000,
    });
    const b = appFor({
      actor: otherOwner,
      rows: [profile({ ownerUserId: otherOwner.id })],
      bindings: [bindingRow(scopeB, { attemptId: "b-1" })],
      port: shared,
      cacheTtlMs: 5_000,
    });

    const detailA = await (await detail(a.app)).json();
    expect(detailA.run.attemptId).toBe("a-1");
    const detailB = await (await detail(b.app)).json();
    expect(detailB.run.attemptId).toBe("b-1");

    // And each scope lists through its own scope object: one window per scope,
    // never a shared one.
    await list(a.app);
    await list(b.app);
    const lists = shared.calls.filter((call) => call.op === "listTraces");
    expect(lists).toHaveLength(2);
  });

  test("a scope cannot read the other scope's run even when the row exists", async () => {
    // Only scope B has a binding; scope A's detail of the same run id is not found.
    const { app } = appFor({
      bindings: [bindingRow(scopeB, { attemptId: "b-1" })],
    });
    const response = await detail(app);
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("RUN_NOT_FOUND");
  });
});

describe("runs query — acceptance 3: revocation and transfer are immediate", () => {
  test("losing management makes list, detail and history unreadable at once", async () => {
    const rows = [profile()];
    const { app, port } = appFor({ rows, cacheTtlMs: 5_000 });
    expect((await list(app)).status).toBe(200);
    expect((await detail(app)).status).toBe(200);

    // The transfer: the Bot now belongs to someone else.
    rows[0] = profile({ ownerUserId: otherOwner.id });
    expect((await list(app)).status).toBe(404);
    expect((await detail(app)).status).toBe(404);
    expect((await detail(app, "run-1")).status).toBe(404);
    // The two upstream reads above are the only ones that ever happened.
    expect(reads(port.calls)).toBe(2);
  });

  test("an ownership epoch bump kills outstanding cursors with 403, never a silent page one", async () => {
    const epochs = { current: EPOCH };
    const { app } = appFor({
      scopeEpoch: async () => epochs.current,
      port: fakePort({ rows: fiveRows }),
    });
    const first = await (await list(app, "?limit=2")).json();
    expect(typeof first.pagination.nextCursor).toBe("string");

    epochs.current = EPOCH + 1;
    const response = await list(
      app,
      `?limit=2&cursor=${first.pagination.nextCursor}`,
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("OWNERSHIP_REQUIRED");
  });

  test("an epoch bump orphans the cache under the old scope key", async () => {
    const epochs = { current: EPOCH };
    const clock = { t: 1_000 };
    const { app, port } = appFor({
      scopeEpoch: async () => epochs.current,
      now: () => new Date(clock.t),
    });
    await list(app);
    await list(app); // Within TTL, still the same window: no second fetch.
    expect(reads(port.calls)).toBe(2); // retrieveProject + listTraces

    epochs.current = EPOCH + 1;
    clock.t = 1_001; // Still within TTL — the cache entry must not be reachable.
    await list(app);
    expect(reads(port.calls)).toBe(4);
  });

  test("a cache entry expires after its TTL and refetches", async () => {
    const clock = { t: 1_000 };
    const { app, port } = appFor({ now: () => new Date(clock.t) });
    await list(app);
    await list(app);
    expect(reads(port.calls)).toBe(2);
    clock.t = 1_000 + 6;
    await list(app);
    expect(reads(port.calls)).toBe(4);
  });
});

describe("runs query — capability gate (T09)", () => {
  test("a disabled configuration answers capability_missing and never touches the port", async () => {
    const { app, port } = appFor({
      config: () => ({ ...enabledConfig, enabled: false }),
    });
    for (const response of [await list(app), await detail(app)]) {
      expect(response.status).toBe(503);
      expect((await response.json()).error).toBe("capability_missing");
    }
    expect(reads(port.calls)).toBe(0);
  });

  test("no verified port answers capability_missing", async () => {
    const { app } = appFor({
      config: () => ({ ...enabledConfig, baseUrl: null }),
    });
    const response = await list(app);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("capability_missing");
  });
});

describe("runs query — list pagination contract", () => {
  test("a first page projects every row and reports the servable window", async () => {
    const { app } = appFor({ port: fakePort({ rows: fiveRows }) });
    const response = await list(app, "?limit=2");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0].opikTraceId).toBe("t1");
    expect(body.pagination).toEqual({
      total: 5,
      window: 5,
      offset: 0,
      limit: 2,
      nextCursor: body.pagination.nextCursor,
    });
    expect(body.pagination.nextCursor).toBeString();
  });

  test("a next cursor continues inside the window and ends honestly", async () => {
    const { app } = appFor({ port: fakePort({ rows: fiveRows }) });
    const first = await (await list(app, "?limit=2")).json();
    const second = await (
      await list(app, `?limit=2&cursor=${first.pagination.nextCursor}`)
    ).json();
    expect(
      second.runs.map((run: { opikTraceId: string }) => run.opikTraceId),
    ).toEqual(["t3", "t4"]);
    expect(second.pagination.offset).toBe(2);
    expect(typeof second.pagination.nextCursor).toBe("string");

    const third = await (
      await list(app, `?limit=2&cursor=${second.pagination.nextCursor}`)
    ).json();
    expect(
      third.runs.map((run: { opikTraceId: string }) => run.opikTraceId),
    ).toEqual(["t5"]);
    expect(third.pagination.nextCursor).toBeNull();
  });

  test("a tampered cursor is an authorization failure", async () => {
    const { app } = appFor({ port: fakePort({ rows: fiveRows }) });
    const first = await (await list(app, "?limit=2")).json();
    const cursor: string = first.pagination.nextCursor;
    // The replacement tail is picked so the tamper is never a no-op: in 1 of
    // 4096 processes the cursor's own tail is already "xx", and swapping it for
    // itself would assert on a valid cursor. The expect pins that invariant.
    const tail = cursor.endsWith("xx") ? "xw" : "xx";
    const forged = `${cursor.slice(0, -2)}${tail}`;
    expect(forged).not.toBe(cursor);
    const response = await list(app, `?cursor=${forged}`);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("OWNERSHIP_REQUIRED");
  });

  test("one scope's cursor is refused under another scope", async () => {
    const a = appFor({ port: fakePort({ rows: fiveRows }) });
    const b = appFor({
      actor: otherOwner,
      rows: [profile({ ownerUserId: otherOwner.id })],
      bindings: [bindingRow(scopeB)],
      port: fakePort({ rows: fiveRows }),
    });
    const first = await (await list(a.app, "?limit=2")).json();
    const response = await list(
      b.app,
      `?cursor=${first.pagination.nextCursor}`,
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("OWNERSHIP_REQUIRED");
  });

  test("caller limits never reach upstream: the window size is ours, not the query's", async () => {
    const { app, port } = appFor({ port: fakePort({ rows: fiveRows }) });
    await list(app, "?limit=1");
    const traces = port.calls.filter((call) => call.op === "listTraces");
    expect(traces).toHaveLength(1);
    expect(traces[0].size).toBe(WINDOW);
  });

  test("an unparsable limit is refused with 400", async () => {
    const { app } = appFor({ port: fakePort({ rows: fiveRows }) });
    for (const bad of ["?limit=0", "?limit=-1", "?limit=abc", "?limit=101"]) {
      const response = await list(app, bad);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("RUNS_QUERY_INPUT_INVALID");
    }
  });
});

describe("runs query — acceptance 5: honest empty vs upstream failure", () => {
  test("a verified-absent project is a truthful empty page, and listing is never called", async () => {
    const { app, port } = appFor({
      port: fakePort({ project: { outcome: "ok", value: null } }),
    });
    const response = await list(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runs: [],
      pagination: {
        total: 0,
        window: 0,
        offset: 0,
        limit: 20,
        nextCursor: null,
      },
      syncing: false,
    });
    expect(port.calls.filter((call) => call.op === "listTraces")).toHaveLength(
      0,
    );
  });

  test("an upstream failure answers OPIK_UPSTREAM_ERROR, never a disguised empty list", async () => {
    const { app } = appFor({
      port: fakePort({
        traces: {
          outcome: "upstream_error",
          operation: "listTraces",
          code: "OPIK_UPSTREAM_ERROR",
          status: 500,
        },
      }),
    });
    const response = await list(app);
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe("OPIK_UPSTREAM_ERROR");
  });

  test("a timeout answers OPIK_TIMEOUT, also never an empty list", async () => {
    const { app } = appFor({
      port: fakePort({
        traces: {
          outcome: "unavailable",
          operation: "listTraces",
          code: "OPIK_TIMEOUT",
        },
      }),
    });
    const response = await list(app);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("OPIK_TIMEOUT");
  });

  test("a malformed envelope answers OPIK_MALFORMED_RESPONSE", async () => {
    const { app } = appFor({
      port: fakePort({
        traces: {
          outcome: "malformed",
          operation: "listTraces",
          code: "OPIK_MALFORMED_RESPONSE",
          detail: "field:content",
        },
      }),
    });
    const response = await list(app);
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe("OPIK_MALFORMED_RESPONSE");
  });

  test("ownership drift is surfaced, not retried elsewhere", async () => {
    const { app } = appFor({
      port: fakePort({
        traces: {
          outcome: "ownership_drift",
          operation: "listTraces",
          code: "OPIK_OWNERSHIP_DRIFT",
          reason: "response_project_mismatch",
          scopeKey: scopeA.key,
        },
      }),
    });
    const response = await list(app);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("OPIK_OWNERSHIP_DRIFT");
  });

  test("a pre-I/O contract refusal answers capability_missing, not a code-less 500 (OCR R3-28)", async () => {
    // requireOperation throws OpikPortError BEFORE any I/O when the verified
    // contract is stale or the operation is unsupported. The route must still
    // answer an explainable code — the same mapping the health seam already
    // applies — never an unclassified 500.
    const { app } = appFor({
      port: fakePort({
        refuseProject: new OpikPortError("CONTRACT_UNVERIFIED"),
      }),
    });
    const response = await list(app);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("capability_missing");
  });

  test("the span walk's pre-I/O refusals answer capability_missing too (OCR R3-28)", async () => {
    const refuse = new OpikPortError("OPERATION_UNSUPPORTED");
    const port: OpikPort = {
      healthCheck: async () => ({ outcome: "ok", value: { healthy: true } }),
      retrieveProject: async () => ({ outcome: "ok", value: { id: "proj-1" } }),
      listTraces: async () => ({
        outcome: "ok",
        value: { page: 1, size: 5, total: 0, content: [] },
      }),
      listSpans: async () => {
        throw refuse;
      },
      createTrace: async () => {
        throw new Error("the read surface must never write");
      },
      writeSpans: async () => {
        throw new Error("the read surface must never write");
      },
    };
    const service = createRunsQueryService({
      bindings: {
        latestAttempt: async () => bindingRow(scopeA),
      },
      config: () => enabledConfig,
      port,
    });
    try {
      await service.steps(scopeA, "run-1");
      throw new Error("steps must not answer on a refusing port");
    } catch (error) {
      expect(error).toBeInstanceOf(RunsQueryError);
      expect((error as RunsQueryError).code).toBe("capability_missing");
      expect((error as RunsQueryError).status).toBe(503);
    }
  });
});

describe("runs query — acceptance 2: honest projection of what upstream holds", () => {
  test("a full row projects state, duration, usage, safe content and version references", async () => {
    const { app } = appFor({ port: fakePort({ rows: [traceRow()] }) });
    const body = await (await list(app)).json();
    expect(body.runs[0]).toEqual({
      opikTraceId: "trace-1",
      state: "completed",
      createdAt: "unavailable",
      durationMs: 21_860,
      usage: {
        source: "provider",
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      },
      capability: "unavailable",
      metadata: projectedMetadata,
    });
  });

  test("status maps onto the T10 vocabulary and fails closed to unknown", async () => {
    const rows = [
      traceRow({ id: "s1", status: "COMPLETED" }),
      traceRow({ id: "s2", status: "ERROR" }),
      traceRow({ id: "s3", status: "IN_PROGRESS" }),
      traceRow({ id: "s4", status: "SOMETHING_NEW" }),
      traceRow({ id: "s5", status: undefined }),
    ];
    const { app } = appFor({ port: fakePort({ rows }) });
    const body = await (await list(app, "?limit=5")).json();
    expect(body.runs.map((run: { state: string }) => run.state)).toEqual([
      "completed",
      "failed",
      "running",
      "unknown",
      "unknown",
    ]);
  });

  test("missing provider usage is an explicit unavailable, never zeros", async () => {
    const rows = [
      traceRow({ id: "u1", usage: undefined }),
      traceRow({ id: "u2", usage: null }),
      traceRow({ id: "u3", usage: { prompt_tokens: "10" } }),
      traceRow({ id: "u4", usage: { prompt_tokens: 1, completion_tokens: 2 } }),
    ];
    const { app } = appFor({ port: fakePort({ rows }) });
    const body = await (await list(app, "?limit=4")).json();
    for (const run of body.runs) {
      expect(run.usage).toEqual({ source: "unavailable" });
    }
  });

  test("a missing duration is an explicit unavailable, and a garbage one too", async () => {
    const rows = [
      traceRow({ id: "d1", metadata: { run_id: "run-1" } }),
      traceRow({
        id: "d2",
        metadata: { run_id: "run-1", duration_ms: "soon" },
      }),
    ];
    const { app } = appFor({ port: fakePort({ rows }) });
    const body = await (await list(app, "?limit=2")).json();
    expect(
      body.runs.map((run: { durationMs: unknown }) => run.durationMs),
    ).toEqual(["unavailable", "unavailable"]);
  });

  test("metadata outside the T05 allowlist is dropped outright", async () => {
    const { app } = appFor({
      port: fakePort({
        rows: [
          traceRow({
            metadata: {
              run_id: "run-1",
              input: "raw prompt",
              tool_arguments: '{"secret": true}',
              tokens_input: "not-a-number",
            },
          }),
        ],
      }),
    });
    const body = await (await list(app)).json();
    expect(body.runs[0].metadata).toEqual({
      run_id: { state: "projected", value: "run-1" },
      tokens_input: { state: "projected", value: "not-a-number" },
    });
  });
});

describe("runs query — Issue #18 list fields: time, capability, syncing, filters", () => {
  test("an upstream start time is projected as ISO; missing or garbage is an explicit unavailable", async () => {
    const rows = [
      traceRow({
        id: "t1",
        start_time: "2026-10-16T09:30:00.000Z",
      }),
      traceRow({ id: "t2" }),
      traceRow({ id: "t3", start_time: "not a date" }),
      traceRow({ id: "t4", start_time: 1760616600000 }),
    ];
    const { app } = appFor({ port: fakePort({ rows }) });
    const body = await (await list(app, "?limit=4")).json();
    expect(
      body.runs.map((run: { createdAt: unknown }) => run.createdAt),
    ).toEqual([
      "2026-10-16T09:30:00.000Z",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
  });

  test("row capability is the binding's verdict; an unbound trace is an honest unavailable", async () => {
    const { app } = appFor({
      port: fakePort({ rows: fiveRows }),
      capabilities: new Map([
        ["t1", "detailed"],
        ["t2", "basic"],
      ]),
    });
    const body = await (await list(app, "?limit=5")).json();
    expect(
      body.runs.map((run: { capability: string }) => run.capability),
    ).toEqual([
      "detailed",
      "basic",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
  });

  test("a wiring without the join seam answers capability unavailable, never a guess", async () => {
    // The parallel-stream shape: only latestAttempt is injected. The optional
    // seams must degrade to the honest verdict rather than throwing.
    const port = fakePort({ rows: [traceRow()] });
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", actorVariables(owner as unknown as AuthenticatedActor));
    app.route(
      "/bots/:botId/runs",
      createRunsQueryRoutes({
        canManageBot: managementCheck([profile()]),
        scopeEpoch: async () => EPOCH,
        bindings: {
          latestAttempt: async () => bindingRow(scopeA),
        },
        config: () => enabledConfig,
        port: port.port,
        windowSize: WINDOW,
        cacheTtlMs: 5,
      }),
    );
    const body = await (
      await app.request("http://openbot.test/bots/agent-1/runs")
    ).json();
    expect(body.runs[0].capability).toBe("unavailable");
    expect(body.syncing).toBe(false);
  });

  test("unreconciled bindings turn the list-level syncing flag on, and only that", async () => {
    const { app } = appFor({
      port: fakePort({ rows: fiveRows }),
      unreconciled: 2,
    });
    const body = await (await list(app)).json();
    expect(body.syncing).toBe(true);
    // The rows themselves stay ordinary rows; syncing is a page fact, not a row state.
    expect(
      body.runs.every((run: { state: string }) => run.state !== "syncing"),
    ).toBeTrue();
  });

  test("filter params are named in the contract and refused with 422, never silently ignored", async () => {
    const { app, port } = appFor({ port: fakePort({ rows: fiveRows }) });
    for (const query of [
      "?state=failed",
      "?timeFrom=2026-10-15T00:00:00.000Z",
      "?timeTo=2026-10-16T00:00:00.000Z",
      "?state=completed&timeFrom=2026-10-15T00:00:00.000Z",
    ]) {
      const response = await list(app, query);
      expect(response.status).toBe(422);
      expect((await response.json()).error).toBe(
        "RUNS_QUERY_FILTER_UNSUPPORTED",
      );
    }
    // And nothing reached upstream while refusing.
    expect(reads(port.calls)).toBe(0);
  });

  test("detail's upstream projection carries the binding's capability verdict", async () => {
    const { app } = appFor({
      port: fakePort({ rows: [traceRow()] }),
      bindings: [bindingRow(scopeA, { capability: "detailed" })],
    });
    const body = await (await detail(app)).json();
    expect(body.upstream.capability).toBe("detailed");
  });
});

describe("runs query — detail", () => {
  test("a reconciled run returns local authority facts plus the upstream projection", async () => {
    const { app } = appFor({ port: fakePort({ rows: [traceRow()] }) });
    const response = await detail(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      run: {
        runId: "run-1",
        attemptId: "attempt-1",
        traceId: "trace-1",
        opikTraceId: "trace-1",
        capability: "basic",
        state: "completed",
        createdAt: "2026-10-15T00:00:00.000Z",
        updatedAt: "2026-10-15T00:05:00.000Z",
        expiresAt: "2026-10-23T00:00:00.000Z",
      },
      upstream: {
        status: "present",
        opikTraceId: "trace-1",
        state: "completed",
        createdAt: "unavailable",
        durationMs: 21_860,
        usage: {
          source: "provider",
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
        },
        capability: "basic",
        metadata: projectedMetadata,
      },
    });
  });

  test("an unreconciled binding is explicit, and upstream is not asked", async () => {
    const { app, port } = appFor({
      bindings: [bindingRow(scopeA, { opikTraceId: null })],
      port: fakePort({ rows: [traceRow()] }),
    });
    const response = await detail(app);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.upstream).toEqual({ status: "unreconciled" });
    expect(body.run.state).toBe("running");
    expect(reads(port.calls)).toBe(0);
  });

  test("a trace outside the servable window is explicit, not an error", async () => {
    const { app } = appFor({
      bindings: [bindingRow(scopeA, { opikTraceId: "trace-elsewhere" })],
      port: fakePort({ rows: [traceRow()] }),
    });
    const response = await detail(app);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.upstream).toEqual({ status: "absent" });
  });

  test("detail adopts only a recognizable upstream state word (R5-26)", async () => {
    // R5-26: the present branch adopted summary.state unconditionally, but the
    // T37 real rows answer no `status` field at all — so in real deployments
    // every detail read erased the binding's local terminal state into
    // "unknown", while the absent branch of the SAME run kept binding.state.
    // Unknown is evidence absence, not an observation: only a word the build
    // understands may overwrite the local answer.
    const { app } = appFor({
      bindings: [bindingRow(scopeA, { state: "completed" })],
      port: fakePort({ rows: [traceRow({ status: undefined })] }),
    });
    const body = await (await detail(app)).json();
    expect(body.upstream.status).toBe("present");
    expect(body.run.state).toBe("completed");
    // An unrecognized word is the same evidence absence; the local state stands.
    const unrecognized = appFor({
      bindings: [bindingRow(scopeA, { state: "failed" })],
      port: fakePort({ rows: [traceRow({ status: "PENDING_REVIEW" })] }),
    });
    expect((await (await detail(unrecognized.app)).json()).run.state).toBe(
      "failed",
    );
    // A recognized word still wins — the upstream copy is the closed one.
    const recognized = appFor({
      bindings: [bindingRow(scopeA, { state: "running" })],
      port: fakePort({ rows: [traceRow({ status: "ERROR" })] }),
    });
    expect((await (await detail(recognized.app)).json()).run.state).toBe(
      "failed",
    );
  });

  test("detail after a list reuses the cached window", async () => {
    const { app, port } = appFor({
      port: fakePort({ rows: [traceRow()] }),
      cacheTtlMs: 5_000,
    });
    await list(app);
    await detail(app);
    expect(reads(port.calls)).toBe(2);
  });
});

describe("runs query — acceptance 4: the surface is read-only, never a proxy", () => {
  test("no write operation is ever invoked", async () => {
    const { app, port } = appFor({ port: fakePort({ rows: [traceRow()] }) });
    await list(app);
    await detail(app);
    expect(
      port.calls.filter(
        (call) => call.op === "createTrace" || call.op === "writeSpans",
      ),
    ).toHaveLength(0);
  });
});

describe("runs query — the M1 cache invalidation target", () => {
  test("invalidate() drops the scope's cached window: the next read serves fresh upstream", async () => {
    // The service, not the route: retention calls this seam per deletion (M1c),
    // and the TTL here is long enough that only invalidate() can evict.
    const port = fakePort({ rows: fiveRows });
    const runs = createRunsQueryService({
      bindings: {
        latestAttempt: async () => null,
      },
      config: () => enabledConfig,
      port: port.port,
      windowSize: WINDOW,
      cacheTtlMs: 60_000,
    });

    await runs.list(scopeA, {});
    await runs.list(scopeA, {});
    // The window served from cache: two reads total, one per fetch.
    expect(reads(port.calls)).toBe(2);

    runs.invalidate(scopeA);
    await runs.list(scopeA, {});
    // Evicted by the seam, not by the clock: the read face answers the
    // post-deletion upstream on the very next call.
    expect(reads(port.calls)).toBe(4);
  });

  test("invalidateKey() drops the same entry from the stored scope key alone (the retention seam's wiring target)", async () => {
    // The retention worker's invalidateReads holds a record's scope key, not a
    // scope: this entry point must compute the exact key invalidate() deletes.
    const port = fakePort({ rows: fiveRows });
    const runs = createRunsQueryService({
      bindings: {
        latestAttempt: async () => null,
      },
      config: () => enabledConfig,
      port: port.port,
      windowSize: WINDOW,
      cacheTtlMs: 60_000,
    });

    await runs.list(scopeA, {});
    await runs.list(scopeA, {});
    expect(reads(port.calls)).toBe(2);

    runs.invalidateKey(scopeA.key);
    await runs.list(scopeA, {});
    // The same eviction as invalidate(scopeA), keyed on the stored string.
    expect(reads(port.calls)).toBe(4);
  });
});

describe("the upstream status vocabulary is pinned, unknown the only fallback (R2-33)", () => {
  test("the mapping is one explicit, exported table — the whole claim about which upstream words this build understands", () => {
    expect(UPSTREAM_RUN_STATUS).toEqual({
      COMPLETED: "completed",
      OK: "completed",
      ERROR: "failed",
      IN_PROGRESS: "running",
      RUNNING: "running",
    });
  });

  test("every pinned word maps onto the T10 vocabulary through the projection", () => {
    for (const [word, expected] of Object.entries(UPSTREAM_RUN_STATUS)) {
      expect(projectRow({ id: "trace-1", status: word }).state).toBe(expected);
    }
  });

  test("a word no evidence ever carried stays unknown, never a guess", () => {
    // Round 2 hypothesized ONGOING; the evidence (T37) never carried it — and
    // an unmapped word must not silently become running, failed or completed.
    for (const alien of [
      "ONGOING",
      "INITIATED",
      "PENDING",
      "queued",
      "running ",
      "",
      0,
      null,
      true,
    ]) {
      expect(
        projectRow({ id: "trace-1", status: alien as unknown }).state,
      ).toBe("unknown");
    }
  });

  test("the real evidence row shape — no status field at all — is unknown", () => {
    // docs/plans/evidence/2026-10-16-issue4/T37/evidence/b1-framework-rows.json:
    // the trace rows the real instance returned carry id/start_time/metadata/
    // span_count… and no `status` key — the honest unknown, not a guessed state.
    const evidenceShape = {
      id: "01a145fa-9e48-7454-8879-d3be83a24cba",
      project_id: "0190babc-62a0-71d2-832a-0feffa4676eb",
      start_time: "2026-10-16T18:30:14.856Z",
      metadata: { integration: "openbot.agent-langgraph" },
      span_count: 6,
    };
    expect(projectRow(evidenceShape).state).toBe("unknown");
  });
});
