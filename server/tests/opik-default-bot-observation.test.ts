// R4-02 — the default system Bot's observation governance face.
//
// The F7E real chain proved the defect end to end: the deployment's default LangGraph Bot
// (risk-analyst, `systemOwned`, `ownerUserId: null`) executed, held billing and wrote traces
// upstream while GET /bots/risk-analyst/runs answered 404 and its binding table stayed empty —
// because every observation seam reused the manage gate, and `canManageAgent` refuses
// `systemOwned` for every role. These cases pin the repaired boundary across the three seams
// that own it, each backed by the production wiring's exact injected shape:
//
//   1. The boundary itself: the wiring's injected check (store read + `canObserveAgent`)
//      admits the administrator and refuses every user — chat rights on the public system
//      Bot grant nothing, exactly as a stranger on someone's public Bot observes nothing.
//   2. The write side: `createBuiltinRunScopeResolver` mints the run's scope for an
//      administrator (so a real execution binds upstream under the Bot's stable data key)
//      and answers null for a user (their run's facts stay local — recording a run nobody
//      authorized to observe is how the system Bot's data would leak through the back door).
//   3. The read side: the runs list/detail/steps faces serve the system Bot's bound runs and
//      the binding's terminal state to the administrator, and answer the unified not-found
//      to a user — indistinguishable from an unknown Bot id, so probing learns nothing.
//
// Non-system Bots are pinned where they always were (agent-profile-policy, opik-runs-query):
// `canObserveAgent` answers exactly what `canManageAgent` answered for a user-owned Bot.
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import { canObserveAgent } from "../src/agents/profile-policy";
import type {
  AgentActor,
  AgentProfile,
} from "../src/agents/profile-types";
import {
  type BotManagementCheck,
  explicitObservationOwnership,
  OBSERVATION_BOT_NOT_FOUND,
  resolveObservationBot,
} from "../src/ai-observability/context";
import type { RunBinding } from "../src/ai-observability/bindings";
import type { OpikConfig } from "../src/ai-observability/config";
import type { ObservationScope } from "../src/ai-observability/contracts";
import type {
  OpikPort,
  OpikTraceRow,
} from "../src/ai-observability/opik-port";
import { createRunsQueryRoutes } from "../src/ai-observability/routes/runs";
import { resourceScopeKey, resolveObservationScope } from "../src/ai-observability/scope";
import { createBuiltinRunScopeResolver } from "../src/ai-observability/wiring";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";

/** The deployment's default LangGraph Bot, as the tenant package provisions it. */
const DEFAULT_BOT_ID = "risk-analyst";

const user: AgentActor = { id: "user-1", role: "user" };
const admin: AgentActor = { id: "user-admin", role: "admin" };

const EPOCH = 7;

function systemBot(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: DEFAULT_BOT_ID,
    name: "Risk Analyst",
    title: "Risk",
    roleDescription: "Reviews fraud signals.",
    avatarSeed: DEFAULT_BOT_ID,
    visibility: "public",
    ownerUserId: null,
    systemOwned: true,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint: "http://langgraph.test/ag-ui",
    hasAuth: false,
    hasCallbackToken: false,
    ...overrides,
  } as AgentProfile;
}

/**
 * The production wiring's exact injected check (server/src/index.ts): the store
 * read plus the observe-level policy, as one seam. Never a second policy copy.
 */
function observeCheck(rows: AgentProfile[]): BotManagementCheck {
  return async (actor, botId) => {
    const found = rows.find((row) => row.id === botId) ?? null;
    return found && canObserveAgent(actor, found) ? found : null;
  };
}

function actorVariables(
  actor: AgentActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", actor as unknown as AuthenticatedActor);
    await next();
  };
}

describe("the injected observation gate", () => {
  test("admits the administrator to the system Bot and refuses every user", async () => {
    const check = observeCheck([systemBot()]);

    expect((await check(admin, DEFAULT_BOT_ID))?.id).toBe(DEFAULT_BOT_ID);
    expect(await check(user, DEFAULT_BOT_ID)).toBeNull();
  });

  test("refuses a deleted system Bot and an unknown id identically", async () => {
    const check = observeCheck([systemBot({ deletedAt: new Date() })]);

    expect(await check(admin, DEFAULT_BOT_ID)).toBeNull();
    expect(await check(admin, "agent-nope")).toBeNull();
  });

  test("answers a user-owned Bot exactly as the manage gate always did", async () => {
    const owned = systemBot({
      id: "agent-owned",
      systemOwned: false,
      ownerUserId: user.id,
      visibility: "public",
    });
    const check = observeCheck([owned]);

    expect((await check(user, "agent-owned"))?.id).toBe("agent-owned");
    expect((await check(admin, "agent-owned"))?.id).toBe("agent-owned");
    expect(
      await check({ id: "user-2", role: "user" }, "agent-owned"),
    ).toBeNull();
  });
});

describe("the scope resolution chain for a system Bot", () => {
  test("resolves the Bot for the administrator and mints under the admin answer", async () => {
    const access = await resolveObservationBot(
      observeCheck([systemBot()]),
      admin,
      DEFAULT_BOT_ID,
    );
    expect(access.ok).toBe(true);

    // A creatorless system Bot has no owner arm: "admin" is the only ownership
    // its observation scope is ever minted under.
    if (!access.ok) throw new Error("the administrator was refused");
    expect(explicitObservationOwnership(admin, access.profile)).toBe("admin");
  });

  test("answers a user the unified not-found, indistinguishable from an unknown id", async () => {
    const denied = await resolveObservationBot(
      observeCheck([systemBot()]),
      user,
      DEFAULT_BOT_ID,
    );
    const unknown = await resolveObservationBot(
      observeCheck([]),
      user,
      "agent-nope",
    );

    expect(denied).toEqual(unknown);
    expect(denied).toEqual({
      ok: false,
      status: 404,
      error: OBSERVATION_BOT_NOT_FOUND,
    });
  });
});

describe("the run-scope resolver on a real system Bot execution", () => {
  const resolverFor = (enabled: boolean) =>
    createBuiltinRunScopeResolver({
      enabled: () => enabled,
      canManageBot: observeCheck([systemBot()]),
      scopeEpoch: async () => EPOCH,
    });

  test("mints the administrator's run scope under the Bot's stable data key", async () => {
    const scope = (await resolverFor(true)(admin, DEFAULT_BOT_ID)) as
      | ObservationScope
      | null;

    expect(scope).not.toBeNull();
    // The scope names the Bot's data range, not the actor: the administrator's
    // run binds to the same key the read face will page over below.
    expect(scope?.key).toBe(resourceScopeKey(DEFAULT_BOT_ID));
    expect(scope?.botId).toBe(DEFAULT_BOT_ID);
  });

  test("keeps a user's system Bot run scope-less — no facts, no bindings", async () => {
    expect(await resolverFor(true)(user, DEFAULT_BOT_ID)).toBeNull();
  });

  test("answers null for every refusal shape: disabled, deleted, unknown", async () => {
    expect(await resolverFor(false)(admin, DEFAULT_BOT_ID)).toBeNull();

    const check = observeCheck([
      systemBot({ deletedAt: new Date() }),
    ]);
    const resolver = createBuiltinRunScopeResolver({
      enabled: () => true,
      canManageBot: check,
      scopeEpoch: async () => EPOCH,
    });
    expect(await resolver(admin, DEFAULT_BOT_ID)).toBeNull();
    expect(await resolver(admin, "agent-nope")).toBeNull();
  });
});

/** The system Bot's administrator scope, exactly as the route seam mints it. */
const adminScope = resolveObservationScope({
  actorId: admin.id,
  botId: DEFAULT_BOT_ID,
  ownership: "admin",
  epoch: EPOCH,
});

/**
 * A binding the write side recorded under the system Bot's data key: reconciled
 * upstream (a trace id exists), locally terminal (`completed`), capability
 * `basic` — the honest verdict for a remote AG-UI run OpenBot mediated but
 * could not see inside.
 */
function boundRun(
  overrides: Partial<RunBinding> = {},
): RunBinding {
  return {
    id: "binding-1",
    scopeKey: adminScope.key,
    actorId: admin.id,
    botId: DEFAULT_BOT_ID,
    runId: "run-1",
    attemptId: "attempt-1",
    traceId: "trace-1",
    opikTraceId: "trace-1",
    locatorWorkspace: "ws",
    locatorProject: "proj",
    capability: "basic",
    state: "completed",
    expiresAt: new Date("2026-11-01T00:00:00.000Z"),
    deletedAt: null,
    createdAt: new Date("2026-10-24T00:00:00.000Z"),
    updatedAt: new Date("2026-10-24T00:05:00.000Z"),
    ...overrides,
  };
}

/**
 * The upstream trace a real deployment answers: NO `status` word (the T37
 * finding), so the list's state must come from the binding's terminal state —
 * the R5-26 discipline — not from a guessed upstream word.
 */
function upstreamTrace(): OpikTraceRow {
  return {
    id: "trace-1",
    usage: null,
    metadata: { run_id: "run-1", attempt_id: "attempt-1" },
  } as OpikTraceRow;
}

/** The read-only port fake: counts reads, refuses every write. */
function fakePort() {
  const calls: Array<{ op: string }> = [];
  const port: OpikPort = {
    healthCheck: async () => ({ outcome: "ok", value: { healthy: true } }),
    retrieveProject: async () => {
      calls.push({ op: "retrieveProject" });
      return { outcome: "ok", value: { id: "proj-1" } };
    },
    listTraces: async (_scope, input) => {
      calls.push({ op: "listTraces" });
      return {
        outcome: "ok",
        value: {
          page: 1,
          size: input.size,
          total: 1,
          content: [upstreamTrace()],
        },
      };
    },
    listSpans: async (_scope, input) => {
      calls.push({ op: "listSpans" });
      return {
        outcome: "ok",
        value: { page: 1, size: input.size, total: 0, content: [] },
      };
    },
    createTrace: async () => {
      throw new Error("the read surface must never write");
    },
    writeSpans: async () => {
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
  actor: AgentActor,
  bindings: RunBinding[],
  port: OpikPort,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", actorVariables(actor));
  app.route(
    "/bots/:botId/runs",
    createRunsQueryRoutes({
      canManageBot: observeCheck([systemBot()]),
      scopeEpoch: async () => EPOCH,
      bindings: {
        latestAttempt: async (scope, runId) =>
          bindings.find(
            (row) => row.scopeKey === scope.key && row.runId === runId,
          ) ?? null,
        capabilitiesByOpikTraceIds: async (_scope, ids) =>
          new Map(
            bindings
              .filter((row) => row.opikTraceId !== null && ids.includes(row.opikTraceId ?? ""))
              .map((row) => [row.opikTraceId ?? "", row.capability]),
          ),
        statesByOpikTraceIds: async (_scope, ids) =>
          new Map(
            bindings
              .filter((row) => row.opikTraceId !== null && ids.includes(row.opikTraceId ?? ""))
              .map((row) => [row.opikTraceId ?? "", row.state]),
          ),
      },
      config: () => enabledConfig,
      port,
      windowSize: 5,
      cacheTtlMs: 0,
    }),
  );
  return app;
}

describe("the system Bot's read face", () => {
  test("serves the bound run, its terminal state and its capability to the administrator", async () => {
    const { port, calls } = fakePort();
    const app = appFor(admin, [boundRun()], port);

    const list = await app.request(
      `http://openbot.test/bots/${DEFAULT_BOT_ID}/runs`,
    );
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.runs).toHaveLength(1);
    // No upstream status word: the state is the binding's terminal answer.
    expect(listed.runs[0].state).toBe("completed");
    expect(listed.runs[0].capability).toBe("basic");

    const detail = await app.request(
      `http://openbot.test/bots/${DEFAULT_BOT_ID}/runs/run-1`,
    );
    expect(detail.status).toBe(200);
    const detailed = await detail.json();
    expect(detailed.run.runId).toBe("run-1");
    expect(detailed.run.state).toBe("completed");
    expect(detailed.run.capability).toBe("basic");
    expect(detailed.upstream.status).toBe("present");

    const steps = await app.request(
      `http://openbot.test/bots/${DEFAULT_BOT_ID}/runs/run-1/steps`,
    );
    expect(steps.status).toBe(200);
    expect((await steps.json()).steps).toEqual([]);

    // The window the administrator read is the Bot's data key — the run scope
    // minted at execution and this read face page over the same address.
    expect(calls.length).toBeGreaterThan(0);
  });

  test("refuses a user with the unified not-found and reads nothing upstream", async () => {
    const { port, calls } = fakePort();
    const app = appFor(user, [boundRun()], port);

    for (const path of ["", "/run-1", "/run-1/steps"]) {
      const response = await app.request(
        `http://openbot.test/bots/${DEFAULT_BOT_ID}/runs${path}`,
      );
      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe(OBSERVATION_BOT_NOT_FOUND);
    }
    expect(calls).toHaveLength(0);
  });

  test("refuses the administrator a run the Bot's binding table never bound", async () => {
    const { port } = fakePort();
    const app = appFor(admin, [boundRun()], port);

    const response = await app.request(
      `http://openbot.test/bots/${DEFAULT_BOT_ID}/runs/run-guessed`,
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("RUN_NOT_FOUND");
  });
});
