// Issue #16 / DAG T10 — run terminal semantics and the basic remote capability seam.
//
// Every case here runs against injected checks and an injected binding store, exactly like
// the T01/T09 suites: no database, no network, no real Opik write ever happens here.
//
// The acceptance under test, in issue order:
//   1. an HTTP first frame never ends a run; a run ends only on actual completion,
//      failure, cancellation or an explicitly unknown outcome.
//   2. success, error, retry, confirmed cancellation, disconnect and unknown endings are
//      distinguished; each attempt reaches at most one terminal outcome.
//   3. a tool proposal is never reported as a tool execution.
//   4. built-in and OpenBot-mediated remote AG-UI executions both carry a trusted
//      Bot/thread/run/attempt association derived from the authenticated context.
//   5. the remote path records only events actually observed, reports `basic` honestly,
//      and never claims invisible internal calls are absent.
import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfile } from "../src/agents/profile-types";
import type {
  BeginRunBindingInput,
  RunBinding,
  RunBindingStore,
} from "../src/ai-observability/bindings";
import {
  type BotManagementCheck,
  OBSERVATION_BOT_NOT_FOUND,
} from "../src/ai-observability/context";
import type { ObservationScope } from "../src/ai-observability/contracts";
import { createBasicRunRoutes } from "../src/ai-observability/routes/basic-run";
import {
  beginRunAttempt,
  type RunAssociation,
  RunLifecycleError,
  type RunObservationEvent,
  resolveRunCapability,
} from "../src/ai-observability/run-lifecycle";
import { scopeKey } from "../src/ai-observability/scope";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";

const owner = { id: "user-owner", role: "user" } as const;
const stranger = { id: "user-stranger", role: "user" } as const;

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

const rejectingUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
) => {
  return context.json({ error: "Authentication required." }, 401);
};

/** Records every begin() and finish(), answering idempotently like the real store's unique key. */
function fakeBindings() {
  const begins: Array<{
    scope: ObservationScope;
    input: BeginRunBindingInput;
  }> = [];
  const finishes: Array<{
    scope: ObservationScope;
    runId: string;
    attemptId: string;
    state: string;
  }> = [];
  const seen = new Set<string>();
  const settled = new Set<string>();
  const bindings: Pick<RunBindingStore, "begin" | "finish"> = {
    async begin(scope, input) {
      begins.push({ scope, input });
      const key = `${scope.key}|${input.runId}|${input.attemptId}`;
      const replayed = seen.has(key);
      seen.add(key);
      return {
        binding: { id: `binding-${seen.size}` } as RunBinding,
        replayed,
      };
    },
    async finish(scope, runId, attemptId, state) {
      finishes.push({ scope, runId, attemptId, state });
      const key = `${scope.key}|${runId}|${attemptId}`;
      const first = !settled.has(key);
      settled.add(key);
      return {
        binding: first ? ({ id: "settled" } as RunBinding) : null,
        settled: first,
      };
    },
  };
  return { begins, finishes, bindings };
}

const EPOCH = 3;

function appFor(
  rows: AgentProfile[],
  overrides: {
    middleware?: MiddlewareHandler<{ Variables: AppVariables }>;
    bindings?: Pick<RunBindingStore, "begin" | "finish">;
    scopeEpoch?: (
      actor: { id: string; role: string },
      botId: string,
    ) => Promise<number>;
  } = {},
) {
  const fake = fakeBindings();
  const app = new Hono<{ Variables: AppVariables }>();
  app.use(
    "*",
    overrides.middleware ??
      actorVariables(owner as unknown as AuthenticatedActor),
  );
  app.route(
    "/bots/:botId/runs",
    createBasicRunRoutes({
      canManageBot: managementCheck(rows),
      scopeEpoch: overrides.scopeEpoch ?? (async () => EPOCH),
      bindings: overrides.bindings ?? fake.bindings,
    }),
  );
  return { app, begins: fake.begins, finishes: fake.finishes };
}

function post(
  app: ReturnType<typeof appFor>["app"],
  body: unknown,
  botId = "agent-1",
) {
  return app.request(`http://openbot.test/bots/${botId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const report = (events: RunObservationEvent[], overrides = {}) => ({
  threadId: "thread-1",
  runId: "run-1",
  attemptId: "attempt-1",
  traceId: "trace-1",
  events,
  ...overrides,
});

function association(overrides: Partial<RunAssociation> = {}): RunAssociation {
  return {
    scopeKey: scopeKey(owner.id, "agent-1", EPOCH),
    botId: "agent-1",
    threadId: "thread-1",
    runId: "run-1",
    attemptId: "attempt-1",
    origin: "remote-agui",
    ...overrides,
  };
}

describe("run attempt lifecycle — acceptance 1: terminal semantics", () => {
  test("an HTTP first frame never terminates the attempt", () => {
    const attempt = beginRunAttempt(association());
    const result = attempt.observe({ type: "http_first_frame" });
    expect(result).toEqual({ accepted: true, terminal: false });
    expect(attempt.record().state).toBe("running");
    expect(attempt.record().outcome).toBeNull();
  });

  test("run_started is an observation, not an outcome", () => {
    const attempt = beginRunAttempt(association());
    expect(attempt.observe({ type: "run_started" }).terminal).toBe(false);
    expect(attempt.record().state).toBe("running");
  });

  test("nothing but an explicit terminal event can end the attempt", () => {
    const attempt = beginRunAttempt(association());
    for (const event of [
      { type: "http_first_frame" },
      { type: "run_started" },
      { type: "tool_proposed", toolCallId: "t1" },
      { type: "tool_executed", toolCallId: "t1" },
      { type: "disconnected" },
    ] as RunObservationEvent[]) {
      expect(attempt.observe(event).terminal).toBe(false);
    }
    expect(attempt.record().state).toBe("running");
  });
});

describe("run attempt lifecycle — acceptance 2: distinguished endings", () => {
  test("success completes the attempt", () => {
    const attempt = beginRunAttempt(association());
    const result = attempt.observe({ type: "success" });
    expect(result).toEqual({
      accepted: true,
      terminal: true,
      outcome: { outcome: "success", state: "completed" },
    });
  });

  test("error fails the attempt", () => {
    const attempt = beginRunAttempt(association());
    expect(attempt.observe({ type: "error" })).toEqual({
      accepted: true,
      terminal: true,
      outcome: { outcome: "error", state: "failed" },
    });
  });

  test("a confirmed cancellation is terminal; a disconnect is not", () => {
    const disconnected = beginRunAttempt(association({ attemptId: "a-d" }));
    expect(disconnected.observe({ type: "disconnected" }).terminal).toBe(false);
    // The run may still be executing in the background — never "canceled" yet.
    expect(disconnected.record().state).toBe("running");

    const canceled = beginRunAttempt(association({ attemptId: "a-c" }));
    expect(canceled.observe({ type: "canceled" })).toEqual({
      accepted: true,
      terminal: true,
      outcome: { outcome: "canceled", state: "canceled" },
    });
  });

  test("an explicit interruption and an explicit unknown are distinct endings", () => {
    const interrupted = beginRunAttempt(association({ attemptId: "a-i" }));
    expect(interrupted.observe({ type: "interrupted" })).toEqual({
      accepted: true,
      terminal: true,
      outcome: { outcome: "interrupted", state: "interrupted" },
    });

    const unknown = beginRunAttempt(association({ attemptId: "a-u" }));
    expect(unknown.observe({ type: "unknown" })).toEqual({
      accepted: true,
      terminal: true,
      outcome: { outcome: "unknown", state: "unknown" },
    });
  });

  test("a duplicate terminal event is rejected and the first outcome stands", () => {
    const attempt = beginRunAttempt(association());
    attempt.observe({ type: "success" });
    expect(attempt.observe({ type: "success" })).toEqual({
      accepted: false,
      reason: "already_terminal",
      outcome: { outcome: "success", state: "completed" },
    });
  });

  test("a divergent terminal event after termination changes nothing", () => {
    const attempt = beginRunAttempt(association());
    attempt.observe({ type: "success" });
    const rejected = attempt.observe({ type: "error" });
    expect(rejected.accepted).toBe(false);
    expect(attempt.record().outcome).toEqual({
      outcome: "success",
      state: "completed",
    });
  });

  test("any straggler event after termination is rejected", () => {
    const attempt = beginRunAttempt(association());
    attempt.observe({ type: "error" });
    expect(attempt.observe({ type: "http_first_frame" }).accepted).toBe(false);
    expect(
      attempt.observe({ type: "tool_executed", toolCallId: "t9" }).accepted,
    ).toBe(false);
  });

  test("a retry ends this attempt as a superseded one and names the next", () => {
    const attempt = beginRunAttempt(association());
    expect(
      attempt.observe({ type: "retry", nextAttemptId: "attempt-2" }),
    ).toEqual({
      accepted: true,
      terminal: true,
      outcome: {
        outcome: "retry",
        state: "interrupted",
        nextAttemptId: "attempt-2",
      },
    });
  });

  test("a retried run is two attempts with separate identities, each terminal once", () => {
    const first = beginRunAttempt(association({ attemptId: "attempt-1" }));
    first.observe({ type: "retry", nextAttemptId: "attempt-2" });
    // A late success for the superseded attempt cannot resurrect or re-close it.
    expect(first.observe({ type: "success" }).accepted).toBe(false);
    expect(first.record().outcome?.outcome).toBe("retry");

    const second = beginRunAttempt(association({ attemptId: "attempt-2" }));
    second.observe({ type: "success" });
    expect(second.record().state).toBe("completed");

    // Two attempts of one run — aggregation counts both once each, not one twice.
    expect(first.record().association.attemptId).not.toBe(
      second.record().association.attemptId,
    );
    expect(first.record().association.runId).toBe(
      second.record().association.runId,
    );
  });
});

describe("run attempt lifecycle — acceptance 3: proposal is not execution", () => {
  test("an unanswered proposal is never an execution", () => {
    const attempt = beginRunAttempt(association());
    attempt.observe({ type: "tool_proposed", toolCallId: "t1" });
    attempt.observe({ type: "success" });
    expect(attempt.record().tools).toEqual({
      proposed: ["t1"],
      executed: [],
      unobserved: ["t1"],
    });
  });

  test("a proposal plus an observed receipt is an execution", () => {
    const attempt = beginRunAttempt(association());
    attempt.observe({ type: "tool_proposed", toolCallId: "t1" });
    attempt.observe({ type: "tool_executed", toolCallId: "t1" });
    attempt.observe({ type: "success" });
    expect(attempt.record().tools).toEqual({
      proposed: ["t1"],
      executed: ["t1"],
      unobserved: [],
    });
  });

  test("a receipt without a proposal still counts as an observed execution", () => {
    // Snapshot-style runtimes publish completed calls without start events.
    const attempt = beginRunAttempt(association());
    attempt.observe({ type: "tool_executed", toolCallId: "t1" });
    expect(attempt.record().tools.executed).toEqual(["t1"]);
    expect(attempt.record().tools.proposed).toEqual([]);
  });
});

describe("run attempt lifecycle — acceptance 4: trusted association shape", () => {
  test("a built-in execution carries the same association shape as a remote one", () => {
    const builtin = beginRunAttempt(association({ origin: "builtin" }));
    builtin.observe({ type: "success" });
    expect(builtin.record()).toMatchObject({
      association: { origin: "builtin", botId: "agent-1" },
      state: "completed",
    });
  });

  test("empty or invalid association references are refused", () => {
    for (const bad of [
      association({ threadId: "" }),
      association({ runId: " " }),
      association({ attemptId: "" }),
      association({ scopeKey: "" }),
      association({ botId: "" }),
      association({ origin: "carrier-pigeon" as RunAssociation["origin"] }),
    ]) {
      expect(() => beginRunAttempt(bad)).toThrow(RunLifecycleError);
    }
  });

  test("invalid observation events are refused", () => {
    const attempt = beginRunAttempt(association());
    expect(() =>
      attempt.observe({ type: "tool_proposed", toolCallId: "" }),
    ).toThrow(RunLifecycleError);
    expect(() => attempt.observe({ type: "retry", nextAttemptId: "" })).toThrow(
      RunLifecycleError,
    );
  });
});

describe("resolveRunCapability — acceptance 5: capability honesty", () => {
  test("verified internal instrumentation is detailed", () => {
    expect(
      resolveRunCapability({
        internalStepsVerified: true,
        observedEvents: true,
      }),
    ).toBe("detailed");
  });

  test("verified instrumentation is a property of the path, not of one report", () => {
    expect(
      resolveRunCapability({
        internalStepsVerified: true,
        observedEvents: false,
      }),
    ).toBe("detailed");
  });

  test("observed AG-UI events without internal instrumentation are basic", () => {
    expect(
      resolveRunCapability({
        internalStepsVerified: false,
        observedEvents: true,
      }),
    ).toBe("basic");
  });

  test("nothing observed and nothing verified is unavailable", () => {
    expect(
      resolveRunCapability({
        internalStepsVerified: false,
        observedEvents: false,
      }),
    ).toBe("unavailable");
  });
});

describe("POST / basic run reporting seam", () => {
  test("an unauthenticated caller is refused before any business logic", async () => {
    const { app, begins } = appFor([profile()], {
      middleware: rejectingUser,
    });
    const response = await post(app, report([{ type: "success" }]));
    expect(response.status).toBe(401);
    expect(begins).toHaveLength(0);
  });

  test("a stranger is refused and the binding store is never asked", async () => {
    const { app, begins } = appFor([profile()], {
      middleware: actorVariables(stranger as unknown as AuthenticatedActor),
    });
    const response = await post(app, report([{ type: "success" }]));
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe(OBSERVATION_BOT_NOT_FOUND);
    expect(begins).toHaveLength(0);
  });

  test("an unknown Bot is refused without leaking existence", async () => {
    const { app, begins } = appFor([], {
      middleware: actorVariables(stranger as unknown as AuthenticatedActor),
    });
    const response = await post(app, report([{ type: "success" }]));
    // Unified not-found semantics: identical to a stranger's answer, so probing
    // ids learns nothing about which Bots exist (parent Spec §7).
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe(OBSERVATION_BOT_NOT_FOUND);
    expect(begins).toHaveLength(0);
  });

  test("a malformed report is refused with 400 and nothing is recorded", async () => {
    const { app, begins } = appFor([profile()]);
    const bads: unknown[] = [
      report([{ type: "success" }], { threadId: "" }),
      report([{ type: "success" }], { runId: undefined }),
      report([{ type: "success" }], { traceId: " " }),
      report([{ type: "success" }], { events: "success" }),
      report([{ type: "finale" }]),
      report([{ type: "tool_executed", toolCallId: "" }]),
      "{not json",
    ];
    for (const bad of bads) {
      const response = await post(app, bad);
      expect(response.status).toBe(400);
    }
    expect(begins).toHaveLength(0);
  });

  test("a full remote report classifies the attempt and begins a trusted binding", async () => {
    const { app, begins } = appFor([profile()]);
    const response = await post(
      app,
      report([
        { type: "http_first_frame" },
        { type: "run_started" },
        { type: "tool_proposed", toolCallId: "t1" },
        { type: "tool_executed", toolCallId: "t1" },
        { type: "success" },
      ]),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      attempt: {
        origin: "remote-agui",
        botId: "agent-1",
        threadId: "thread-1",
        runId: "run-1",
        attemptId: "attempt-1",
        state: "completed",
        outcome: { outcome: "success", state: "completed" },
        observed: { firstFrame: true, started: true, disconnected: false },
        tools: { proposed: ["t1"], executed: ["t1"], unobserved: [] },
      },
      capability: "basic",
      internalSteps: "unobserved",
      rejectedEvents: 0,
      binding: { id: "binding-1", replayed: false },
    });

    // The association the binding received is derived from the authenticated
    // context, never from the report body.
    expect(begins).toHaveLength(1);
    expect(begins[0].scope.key).toBe(scopeKey(owner.id, "agent-1", EPOCH));
    expect(begins[0].scope.botId).toBe("agent-1");
    expect(begins[0].scope.actorId).toBe(owner.id);
    expect(begins[0].input).toMatchObject({
      runId: "run-1",
      attemptId: "attempt-1",
      traceId: "trace-1",
      capability: "basic",
    });
  });

  test("a first-frame-only report leaves the run running at the seam too", async () => {
    const { app } = appFor([profile()]);
    const response = await post(app, report([{ type: "http_first_frame" }]));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.attempt.state).toBe("running");
    expect(body.attempt.outcome).toBeNull();
    expect(body.capability).toBe("basic");
  });

  test("a report with no observed events answers unavailable, not basic", async () => {
    const { app, begins } = appFor([profile()]);
    const response = await post(app, report([]));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.capability).toBe("unavailable");
    expect(body.attempt.state).toBe("running");
    expect(begins[0].input.capability).toBe("unavailable");
  });

  test("a disconnect-only report keeps the run running, never canceled", async () => {
    const { app } = appFor([profile()]);
    const response = await post(app, report([{ type: "disconnected" }]));
    const body = await response.json();
    expect(body.attempt.state).toBe("running");
    expect(body.attempt.outcome).toBeNull();
  });

  test("a confirmed cancellation and an explicit unknown classify differently", async () => {
    const { app } = appFor([profile()]);
    const canceled = await (
      await post(app, report([{ type: "canceled" }], { attemptId: "a-c" }))
    ).json();
    expect(canceled.attempt.outcome).toEqual({
      outcome: "canceled",
      state: "canceled",
    });

    const unknown = await (
      await post(app, report([{ type: "unknown" }], { attemptId: "a-u" }))
    ).json();
    expect(unknown.attempt.outcome).toEqual({
      outcome: "unknown",
      state: "unknown",
    });
  });

  test("a retry report names the next attempt", async () => {
    const { app } = appFor([profile()]);
    const response = await post(
      app,
      report([{ type: "retry", nextAttemptId: "attempt-2" }]),
    );
    const body = await response.json();
    expect(body.attempt.state).toBe("interrupted");
    expect(body.attempt.outcome).toEqual({
      outcome: "retry",
      state: "interrupted",
      nextAttemptId: "attempt-2",
    });
  });

  test("duplicate terminal events in one report are counted, not applied", async () => {
    const { app } = appFor([profile()]);
    const response = await post(
      app,
      report([
        { type: "success" },
        { type: "success" },
        { type: "error" },
        { type: "http_first_frame" },
      ]),
    );
    const body = await response.json();
    expect(body.attempt.state).toBe("completed");
    expect(body.attempt.outcome.outcome).toBe("success");
    expect(body.rejectedEvents).toBe(3);
  });

  test("re-reporting the same attempt replays the binding, not a second one", async () => {
    const { app, begins } = appFor([profile()]);
    await post(app, report([{ type: "http_first_frame" }]));
    const second = await post(app, report([{ type: "http_first_frame" }]));
    const body = await second.json();
    expect(body.binding.replayed).toBe(true);
    expect(begins).toHaveLength(2);
  });

  test("forged association fields in the body cannot steer the binding", async () => {
    const { app, begins } = appFor([profile()]);
    const response = await post(
      app,
      report([{ type: "success" }], {
        actorId: "user-evil",
        botId: "agent-2",
        scopeKey: "wb|forged",
        epoch: 99,
      }),
    );
    expect(response.status).toBe(200);
    expect(begins[0].scope.key).toBe(scopeKey(owner.id, "agent-1", EPOCH));
    expect(begins[0].scope.actorId).toBe(owner.id);
    expect(begins[0].scope.botId).toBe("agent-1");
  });

  test("an ownership epoch the scope seam refuses fails closed", async () => {
    const { app, begins } = appFor([profile()], {
      scopeEpoch: async () => Number.NaN,
    });
    const response = await post(app, report([{ type: "success" }]));
    expect(response.status).toBe(403);
    expect(begins).toHaveLength(0);
  });
});

describe("POST / — the binding terminal state's production writer (G1)", () => {
  test("a terminal report settles the binding onto the observed state", async () => {
    const { app, finishes } = appFor([profile()]);
    const response = await post(
      app,
      report([{ type: "run_started" }, { type: "success" }]),
    );
    expect(response.status).toBe(200);
    expect(finishes).toEqual([
      {
        scope: expect.objectContaining({
          key: scopeKey(owner.id, "agent-1", EPOCH),
        }),
        runId: "run-1",
        attemptId: "attempt-1",
        state: "completed",
      },
    ]);
  });

  test("each terminal outcome maps onto its own binding state", async () => {
    const { app, finishes } = appFor([profile()]);
    await post(app, report([{ type: "error" }], { attemptId: "a-e" }));
    await post(app, report([{ type: "canceled" }], { attemptId: "a-c" }));
    await post(
      app,
      report([{ type: "retry", nextAttemptId: "attempt-2" }], {
        attemptId: "a-r",
      }),
    );
    await post(app, report([{ type: "interrupted" }], { attemptId: "a-i" }));
    await post(app, report([{ type: "unknown" }], { attemptId: "a-u" }));
    expect(finishes.map((finish) => finish.state)).toEqual([
      "failed",
      "canceled",
      "interrupted",
      "interrupted",
      "unknown",
    ]);
  });

  test("a report with no terminal event never settles the binding", async () => {
    const { app, finishes } = appFor([profile()]);
    for (const events of [
      [{ type: "http_first_frame" }],
      [{ type: "run_started" }],
      [{ type: "disconnected" }],
      [
        { type: "tool_proposed", toolCallId: "t1" },
        { type: "tool_executed", toolCallId: "t1" },
      ],
      [],
    ] as RunObservationEvent[][]) {
      const response = await post(app, report(events));
      expect(response.status).toBe(200);
    }
    expect(finishes).toHaveLength(0);
  });

  test("a replayed terminal report still attempts the settle; the store's first-wins decides", async () => {
    const { app, finishes } = appFor([profile()]);
    await post(app, report([{ type: "success" }]));
    const replay = await post(app, report([{ type: "success" }]));
    expect((await replay.json()).binding.replayed).toBe(true);
    // The seam asks twice; the store's conditional write is what keeps the
    // standing outcome (verified against the real store in the integration suite).
    expect(finishes).toHaveLength(2);
    expect(finishes.every((finish) => finish.state === "completed")).toBe(true);
  });
});
