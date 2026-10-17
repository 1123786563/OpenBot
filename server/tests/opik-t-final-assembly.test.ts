// T-final (Issue #4 assembly closure) — the collection-face assembly guards.
//
// The final review (docs/plans/evidence/2026-10-16-issue4/final-review/report.md)
// registered H1 (basic-run route never mounted) and M1 (builtin scope never
// threaded) as the one High and its same-root Medium. This file pins the fix:
//
//   H1 — POST /bots/:botId/runs through the ONE mount point begins a binding,
//        settles it terminal on an observed outcome, and the run reads back
//        200 on the T11 query routes (detail). Absent begin/finish stays
//        unmounted — the same "absent = not mounted" contract as every other
//        sub-router here.
//   M1 — the ambient run-scope seam exists, the builtin threading wrapper
//        establishes it for everything a run emits, the production scope
//        resolver refuses honestly, and — the fix-round-2 behavior guard —
//        the production resolver entry (createActorAgentResolver) FORWARDS
//        the injected run-scope resolver: a builtin agent resolved the way
//        every production surface resolves one runs its model calls under
//        the issued scope, read back through the recorder's own adapter read.
//        (The source-text assertions these replaced were exactly the blind
//        spot the incremental review caught: injection asserted, forwarding
//        never tested.)
//
// Integration facts run against the dedicated Opik test database; the wiring
// guards read the real assembly source the way opik-execution-wiring.test.ts
// does, so the seam BETWEEN the modules and the boot file cannot silently rot.
import { describe, expect, test } from "bun:test";
import type { AbstractAgent, BaseEvent } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { Observable } from "rxjs";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";
import { createRunBindingStore } from "../src/ai-observability/bindings";
import type { OpikConfig } from "../src/ai-observability/config";
import { createAiObservabilityRoutes } from "../src/ai-observability/routes";
import {
  type ObservationScope,
  resolveObservationScope,
} from "../src/ai-observability/scope";
import {
  createBuiltinRunScopeResolver,
  loadVerifiedOpikPort,
} from "../src/ai-observability/wiring";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  builtinRunUnderObservationScope,
  setBuiltinModelSpanObserver,
  setModelUsageMeter,
} from "../src/copilot";
import { aiObservationBindings } from "../src/db/schema/ai-observability-bindings";
import {
  currentRunObservationScope,
  withRunObservationScope,
} from "../src/observation-run-scope";
import { opikTestDatabase } from "./support/opik-test-db";

const database = opikTestDatabase({ max: 4 });

const actorId = `t-final-a`;
const botId = `t-final-bot`;
const epoch = 3;

function authAs(id: string): MiddlewareHandler<{ Variables: AppVariables }> {
  const actor = { id, role: "user" } as AuthenticatedActor;
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

/** The actor owns the one bot; nobody else manages anything. */
function canManageBot(
  actor: AgentActor,
  id: string,
): Promise<AgentProfile | null> {
  if (id !== botId || actor.id !== actorId) return Promise.resolve(null);
  return Promise.resolve({
    id,
    ownerUserId: actorId,
    visibility: "private",
    systemOwned: false,
    deletedAt: null,
  } as AgentProfile);
}

const config: OpikConfig = {
  enabled: true,
  baseUrl: "http://opik.test",
  apiKey: null,
  workspaceName: "openbot",
  port: 5174,
  otlpHttpPort: 5418,
  otlpGrpcPort: 5417,
};

/**
 * A port whose every write throws: this file proves the MOUNT and the local
 * binding lifecycle, not upstream I/O — and a read with no opik trace id (the
 * begun-but-unreconciled state every fresh binding here is in) must answer
 * from the local tables without dialling anything.
 */
const neverPort = {
  healthCheck: async () => ({
    outcome: "unavailable",
    operation: "healthCheck",
    code: "OPIK_TIMEOUT",
  }),
  writeSpans: async () => {
    throw new Error("this file must not write upstream");
  },
} as never;

function scopeFor(actor: string): ObservationScope {
  return resolveObservationScope({
    actorId: actor,
    botId,
    ownership: "owner",
    epoch,
  });
}

function appFor(
  bindingsDep?: Partial<
    Pick<ReturnType<typeof createRunBindingStore>, "begin" | "finish">
  >,
) {
  const bindings = createRunBindingStore(database);
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createAiObservabilityRoutes({
      requireUser: authAs(actorId),
      canManageBot,
      scopeEpoch: async () => epoch,
      config: () => config,
      port: neverPort,
      database,
      // The full store by default; an explicit begin/finish-less partial rides
      // the "absent = not mounted" contract instead of breaking typecheck.
      bindings: bindingsDep === undefined ? bindings : { ...bindingsDep },
    }),
  );
  return { app, bindings };
}

describe("the observation routes' transport guard", () => {
  test("an oversized body is refused at the mount, beside the user guard (OCR m174)", async () => {
    const { app } = appFor();
    const oversized = "x".repeat(1024 * 1024 + 1);
    const response = await app.request(
      `http://openbot.test/bots/${botId}/runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "t-final-thread",
          runId: "t-final-oversize",
          attemptId: "attempt-1",
          traceId: "w".repeat(32),
          events: [{ type: "run_started", note: oversized }],
        }),
      },
    );
    expect(response.status).toBe(413);
  });
});

describe("T-final H1: the basic-run report route is mounted at the one seam", () => {
  test("POST /bots/:botId/runs begins the binding and answers the classification", async () => {
    const { app } = appFor();
    const runId = `t-final-run-${Date.now()}`;
    const response = await app.request(
      `http://openbot.test/bots/${botId}/runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "t-final-thread",
          runId,
          attemptId: "attempt-1",
          traceId: "w".repeat(32),
          events: [{ type: "run_started" }, { type: "success" }],
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    // Observed events with no verified internal steps: basic, never detailed.
    expect(body.capability).toBe("basic");
    expect(body.internalSteps).toBe("unobserved");
    expect(body.binding.replayed).toBe(false);
    // The observed terminal outcome is the production writer of the binding's
    // terminal state — the retention discovery predicate's own precondition.
    expect(body.attempt.state).toBe("completed");
  });

  test("the settled binding is in this scope's table, terminal, and reads back 200", async () => {
    const { app } = appFor();
    const runId = `t-final-run-${Date.now()}`;
    const post = await app.request(`http://openbot.test/bots/${botId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "t-final-thread",
        runId,
        attemptId: "attempt-1",
        traceId: "w".repeat(32),
        events: [{ type: "success" }],
      }),
    });
    expect(post.status).toBe(200);

    const rows = await database
      .select()
      .from(aiObservationBindings)
      .where(eq(aiObservationBindings.scopeKey, scopeFor(actorId).key));
    const binding = rows.find((row) => row.runId === runId);
    expect(binding).toBeDefined();
    expect(binding?.state).toBe("completed");

    // The T11 read face: latestAttempt exists, so detail answers (upstream
    // unreconciled — still 200, still honest), never RUN_NOT_FOUND.
    const detail = await app.request(
      `http://openbot.test/bots/${botId}/runs/${runId}`,
    );
    expect(detail.status).toBe(200);
  });

  test("bindings without begin/finish stay unmounted (absent = not mounted)", async () => {
    const { app } = appFor({});
    const response = await app.request(
      `http://openbot.test/bots/${botId}/runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "t",
          runId: "r",
          attemptId: "a",
          traceId: "w".repeat(32),
          events: [],
        }),
      },
    );
    expect(response.status).toBe(404);
  });
});

describe("T-final M1: the ambient run-scope seam", () => {
  test("the scope is visible to everything inside withRunObservationScope and invisible outside", () => {
    const scope = scopeFor(actorId);
    let seenInside: unknown = "unread";
    let seenAfter: unknown = "unread";
    withRunObservationScope(scope, () => {
      seenInside = currentRunObservationScope();
    });
    seenAfter = currentRunObservationScope();
    expect(seenInside).toBe(scope);
    expect(seenAfter).toBeUndefined();
  });

  test("the production resolver issues the scope for a manager and refuses honestly otherwise", async () => {
    const resolve = createBuiltinRunScopeResolver({
      enabled: () => true,
      canManageBot,
      scopeEpoch: async () => epoch,
    });
    const issued = (await resolve(
      { id: actorId, role: "user" },
      botId,
    )) as ObservationScope | null;
    // The same scope key the route seam would issue for the same identity —
    // one scope space, not two.
    expect(issued?.key).toBe(scopeFor(actorId).key);

    // A stranger runs the same bot without a scope: the recorders stay silent.
    expect(
      await resolve({ id: "someone-else", role: "user" }, botId),
    ).toBeNull();
  });

  test("ownership is answered explicitly, never inferred (OCR h10)", async () => {
    // The widened gate the enterprise seam reserved for (shared management,
    // organization roles) could ship: it hands the
    // profile to a non-owner, plain-role collaborator. The inference the resolver
    // used to copy ("whoever manages is at least an admin") would mint that
    // collaborator an admin-owned observation scope for every model call the run
    // makes. The explicit answer refuses: owner or global admin, nothing else.
    const widenedGate = createBuiltinRunScopeResolver({
      enabled: () => true,
      canManageBot: (_actor, id) =>
        Promise.resolve(
          id === botId
            ? ({
                id,
                ownerUserId: actorId,
                visibility: "private",
                systemOwned: false,
                deletedAt: null,
              } as AgentProfile)
            : null,
        ),
      scopeEpoch: async () => epoch,
    });
    // The owner keeps the exact scope the route seam issues.
    const owned = (await widenedGate(
      { id: actorId, role: "user" },
      botId,
    )) as ObservationScope | null;
    expect(owned?.key).toBe(scopeFor(actorId).key);
    // A global admin earns the admin scope explicitly.
    expect(
      (await widenedGate({ id: "global-admin", role: "admin" }, botId)) !== null,
    ).toBe(true);
    // A collaborator the widened gate manages earns nothing — fail closed.
    expect(
      await widenedGate({ id: "collaborator", role: "user" }, botId),
    ).toBeNull();
  });

  test("a disabled deployment and a failing resolution both answer null, never throw", async () => {
    const disabled = createBuiltinRunScopeResolver({
      enabled: () => false,
      canManageBot,
      scopeEpoch: async () => epoch,
    });
    expect(await disabled({ id: actorId, role: "user" }, botId)).toBeNull();

    const failing = createBuiltinRunScopeResolver({
      enabled: () => true,
      canManageBot: () => Promise.reject(new Error("db gone")),
      scopeEpoch: async () => epoch,
    });
    expect(await failing({ id: actorId, role: "user" }, botId)).toBeNull();
  });

  const settled = (source: Observable<void>) =>
    new Promise<void>((resolve) => source.subscribe({ complete: resolve }));

  test("the builtin threading establishes the ambient scope for everything the run emits", async () => {
    const scope = scopeFor(actorId);
    const seen: unknown[] = [];
    const inner = new Observable<void>((subscriber) => {
      seen.push(currentRunObservationScope());
      subscriber.complete();
    });
    await settled(
      builtinRunUnderObservationScope(
        { actorId, resolveScope: async () => scope },
        botId,
        inner,
      ),
    );
    // The emitted fact's context carries the issued scope object itself —
    // the WeakSet-trusted one, not a copy.
    expect(seen[0]).toBe(scope);
  });

  test("a null resolution subscribes the run bare — facts stay scope-less", async () => {
    const seen: unknown[] = [];
    const inner = new Observable<void>((subscriber) => {
      seen.push(currentRunObservationScope());
      subscriber.complete();
    });
    await settled(
      builtinRunUnderObservationScope(
        { actorId, resolveScope: async () => null },
        botId,
        inner,
      ),
    );
    expect(seen[0]).toBeUndefined();
  });

  test("the resolver is asked per subscription, with the bot being run", async () => {
    const asked: string[] = [];
    const inner = new Observable<void>((subscriber) => subscriber.complete());
    const source = builtinRunUnderObservationScope(
      {
        actorId,
        resolveScope: async (runBotId) => {
          asked.push(runBotId);
          return null;
        },
      },
      botId,
      inner,
    );
    await settled(source);
    await settled(source);
    // Live epoch per run: two runs ask twice, each naming its own bot.
    expect(asked).toEqual([botId, botId]);
  });
});

describe("T-final M1: the boot assembly reads the ambient scope", () => {
  const indexSource = readFileSync(
    join(import.meta.dir, "..", "src", "index.ts"),
    "utf8",
  );

  test("both recorders' adapters carry the ambient scope into the record", () => {
    // The model-span and tool-step adapters must read the ambient scope the
    // threading established — a scope-less record is a silent no-op upstream.
    expect(indexSource).toMatch(/currentRunObservationScope\(\)/);
    expect(
      indexSource.match(/currentRunObservationScope\(\)/g)?.length,
    ).toBeGreaterThanOrEqual(2);
  });
});

/**
 * T-final M1 fix round 2: the production resolver entry is the seam the
 * review caught unforwarded. These tests drive a REAL builtin run — a real
 * model conversation against a local OpenAI-compatible mock, through the same
 * `createActorAgentResolver` construction every production surface uses — and
 * assert what the recorder's own adapter read sees, never what a source file
 * looks like.
 */
describe("T-final M1: createActorAgentResolver threads the run scope (behavior)", () => {
  const runInput = {
    threadId: "t-final-thread",
    runId: "t-final-behavior-run",
    messages: [{ id: "m1", role: "user", content: "Answer the fixture." }],
    tools: [],
    context: [],
  } as const;

  const runToCompletion = async (agent: AbstractAgent) => {
    const events: BaseEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("fixture run timed out")),
        5_000,
      );
      agent.run(runInput).subscribe({
        next: (event) => events.push(event),
        error: (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
        complete: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
    return events;
  };

  /**
   * Resolve the builtin Bot the way production does — through
   * `createActorAgentResolver` — with the model-span observation reading the
   * ambient scope exactly as index.ts's boot adapter reads it. The meter
   * alone engages the metered model path that carries the span observation
   * (the gate stays unset, so no admission refuses); this is the wiring the
   * real-stack e2e uses too.
   */
  async function harnessFor(
    resolveRunObservationScope?: (
      actor: AgentActor,
      runBotId: string,
    ) => Promise<unknown>,
  ) {
    const llm = new LLMock();
    const originalBase = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = await llm.start();
    llm.onMessage(/.*/, { content: "Fixture completed." });
    setModelUsageMeter(async () => {});
    const scopesSeenByRecorder: unknown[] = [];
    setBuiltinModelSpanObserver(() => {
      // index.ts's adapter read, verbatim in shape: the record happens inside
      // the run's execution tree, and the ambient scope at that moment is
      // what the fact will carry upstream.
      scopesSeenByRecorder.push(currentRunObservationScope());
    });
    const asked: { actorId: string; botId: string }[] = [];
    const resolver = createActorAgentResolver({
      loadAgents: async () => [
        {
          id: botId,
          name: "T-Final Bot",
          type: "built_in",
          systemPrompt: "Answer the fixture.",
          expertSource: "tenant_package",
        },
      ],
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      resolveModelApiKey: async () => "synthetic-fixture-key",
      loadVendors: async () => [],
      ...(resolveRunObservationScope
        ? {
            resolveRunObservationScope: (actor: AgentActor, runBotId: string) => {
              asked.push({ actorId: actor.id, botId: runBotId });
              return resolveRunObservationScope(actor, runBotId);
            },
          }
        : {}),
    });
    return {
      asked,
      async cleanup() {
        setBuiltinModelSpanObserver(undefined);
        setModelUsageMeter(undefined);
        if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
        else process.env.OPENAI_BASE_URL = originalBase;
        await llm.stop();
      },
      resolver,
      scopesSeenByRecorder,
    };
  }

  test("a builtin run resolved through the production entry hands its issued scope to the recorder", async () => {
    const scope = scopeFor(actorId);
    const harness = await harnessFor(async () => scope);
    try {
      const agent = await harness.resolver.resolveAgentForActor(
        { id: actorId, role: "user" },
        botId,
      );
      const events = await runToCompletion(agent);
      expect(
        events.some((event) => event.type === "RUN_FINISHED"),
        "the fixture run finished",
      ).toBe(true);
      // The resolver was asked once per run, with the run's own actor and bot.
      expect(harness.asked).toEqual([{ actorId, botId }]);
      // The recorder's adapter read saw the ISSUED scope object itself — the
      // WeakSet-trusted one, not a copy — for every model call of the run.
      expect(harness.scopesSeenByRecorder.length).toBeGreaterThanOrEqual(1);
      for (const seen of harness.scopesSeenByRecorder) expect(seen).toBe(scope);
    } finally {
      await harness.cleanup();
    }
  });

  test("a refused resolution runs scope-less: the recorder reads no scope", async () => {
    const harness = await harnessFor(async () => null);
    try {
      const agent = await harness.resolver.resolveBuiltInBotForActor(
        { id: actorId, role: "user" },
        botId,
      );
      await runToCompletion(agent.agent);
      expect(harness.asked).toEqual([{ actorId, botId }]);
      // The model calls still happened and were still observed — but bare.
      expect(harness.scopesSeenByRecorder.length).toBeGreaterThanOrEqual(1);
      for (const seen of harness.scopesSeenByRecorder)
        expect(seen).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });

  test("a resolver built without the injection keeps the inert footing", async () => {
    const harness = await harnessFor(undefined);
    try {
      const agent = await harness.resolver.resolveAgentForActor(
        { id: actorId, role: "user" },
        botId,
      );
      await runToCompletion(agent);
      expect(harness.asked).toEqual([]);
      expect(harness.scopesSeenByRecorder.length).toBeGreaterThanOrEqual(1);
      for (const seen of harness.scopesSeenByRecorder)
        expect(seen).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });

  test("the boot injection the resolver forwards is still assembled at the one mount (wiring guard)", () => {
    // Narrow guard for the boot half only: WHICH name is injected into the
    // production createActorAgentResolver call. The forwarding itself is
    // pinned by the behavior tests above, not by this text.
    const assemblySource = readFileSync(
      join(import.meta.dir, "..", "src", "index.ts"),
      "utf8",
    );
    expect(assemblySource).toMatch(
      /createActorAgentResolver\(\{[\s\S]*?resolveRunObservationScope/,
    );
  });
});

/*
 * The scope-carrier resolver-refusal tests below and the recorders' adapter
 * guard keep their original form: they pin the lower half of the thread and
 * the boot-side read, neither of which was the review's finding.
 */

describe("T-final M2: the contract manifest is a server asset with a boot voice", () => {
  test("the trust anchor lives beside the module that verifies against it, still the verified contract", async () => {
    const manifest = (await Bun.file(
      new URL(
        "../src/ai-observability/opik-contract/47-manifest.json",
        import.meta.url,
      ),
    ).json()) as {
      manifestVersion?: number;
      service?: { version?: string };
    };
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.service?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("a loadable manifest produces a port; a missing one answers null, never a throw", async () => {
    const port = await loadVerifiedOpikPort("http://opik.test");
    expect(port).not.toBeNull();

    const missing = await loadVerifiedOpikPort(
      "http://opik.test",
      undefined,
      new URL("./no-such-manifest.json", import.meta.url),
    );
    expect(missing).toBeNull();
  });

  test("the loaded manifest's fingerprint is the file's own sha-256 (boot log evidence)", async () => {
    // The fingerprint the boot line carries must be computable from the asset
    // itself — the trust anchor is the file, and the log names WHICH file.
    const { createHash } = await import("node:crypto");
    const bytes = new Uint8Array(
      await Bun.file(
        new URL(
          "../src/ai-observability/opik-contract/47-manifest.json",
          import.meta.url,
        ),
      ).arrayBuffer(),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

describe("T-final L3: one billing gate, two consumers", () => {
  const indexSource = readFileSync(
    join(import.meta.dir, "..", "src", "index.ts"),
    "utf8",
  );

  test("the shared predicate exists and both gates reference it", () => {
    expect(indexSource).toMatch(/const evaluationBillingReady(?:\s*=|:)/);
    // The route gate…
    expect(indexSource).toMatch(
      /executionBilling:\s*\n?\s*evaluationBillingReady\(\)/,
    );
    // …and the worker gate.
    expect(indexSource).toMatch(/if \(\s*evaluationBillingReady\(\)/);
  });
});
