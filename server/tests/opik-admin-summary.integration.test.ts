// Issue #39 / DAG T33 — behavioral proof of the admin-scope summary against a
// real, dedicated PostgreSQL database, plus the wired routes this ticket mounts.
//
// The acceptance under test, in issue order:
//   1. the scope comes first: two actors over the SAME bot id stay isolated,
//      and nobody but a current manager reaches the aggregate at all;
//   2. bot and time filters shape the answer;
//   3. missing usage and unbound records are explicit, never zeros;
//   4. an Opik failure keeps the true collection state without failing the
//      request — the summary is a bypass query, and it never writes;
//   5. no migration: everything reads the tables T07/T19/T22/T34 already own.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";
import { createRunBindingStore } from "../src/ai-observability/bindings";
import type { OpikConfig } from "../src/ai-observability/config";
import { createOpikHealthService } from "../src/ai-observability/health";
import type { OpikPort, OpikTraceRow } from "../src/ai-observability/opik-port";
import { createAiObservabilityRoutes } from "../src/ai-observability/routes";
import { resolveObservationScope } from "../src/ai-observability/scope";
import { createAgentProfileScopeEpoch } from "../src/ai-observability/wiring";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { agentProfiles, agents } from "../src/db/schema";
import { aiObservationBindings } from "../src/db/schema/ai-observability-bindings";
import {
  aiObservationDatasets,
  aiObservationDatasetVersions,
} from "../src/db/schema/ai-observability-datasets";
import { aiObservationExperiments } from "../src/db/schema/ai-observability-experiments";
import { aiObservationExportJobs } from "../src/db/schema/ai-observability-exports";
import { workItems } from "../src/db/schema/work";
import { opikTestDatabase } from "./support/opik-test-db";

const database = opikTestDatabase({ max: 6 });
const bindings = createRunBindingStore(database);
const epochSource = createAgentProfileScopeEpoch(database);

const run = `t33-${randomUUID()}`;
const actorA = `t33-a-${randomUUID()}`;
const actorB = `t33-b-${randomUUID()}`;
const stranger = `t33-s-${randomUUID()}`;
const botId = `t33-bot-${randomUUID()}`;

function authAs(
  id: string,
  role: "user" | "admin" = "user",
): MiddlewareHandler<{ Variables: AppVariables }> {
  const actor = { id, role } as AuthenticatedActor;
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

/** Both actors may manage the one bot; the stranger may not. */
function canManageBot(
  actor: AgentActor,
  id: string,
): Promise<AgentProfile | null> {
  if (id !== botId) return Promise.resolve(null);
  if (actor.id === actorA || actor.id === actorB || actor.role === "admin") {
    return Promise.resolve({
      id,
      ownerUserId: actorA,
      visibility: "private",
      systemOwned: false,
      deletedAt: null,
    } as AgentProfile);
  }
  return Promise.resolve(null);
}

const enabledConfig: OpikConfig = {
  enabled: true,
  baseUrl: "http://opik.test",
  apiKey: "held-for-port-wiring",
  workspaceName: "openbot",
  port: 5174,
  otlpHttpPort: 5418,
  otlpGrpcPort: 5417,
};

const disabledConfig: OpikConfig = { ...enabledConfig, enabled: false };

function traceRow(
  id: string,
  overrides: Partial<OpikTraceRow> = {},
): OpikTraceRow {
  return {
    id,
    project_id: "proj-1",
    name: `run ${id}`,
    start_time: "2026-10-16T09:00:00.000Z",
    end_time: null,
    status: "COMPLETED",
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    },
    metadata: { duration_ms: 1000 },
    ...overrides,
  } as OpikTraceRow;
}

/**
 * The fake upstream: one window of traces, and write operations that THROW —
 * the summary is a read-only bypass and must never write.
 */
function fakePort(rows: readonly OpikTraceRow[], healthy = true): OpikPort {
  return {
    healthCheck: async () =>
      healthy
        ? { outcome: "ok", value: { healthy: true } }
        : {
            outcome: "unavailable",
            operation: "healthCheck",
            code: "OPIK_TIMEOUT",
          },
    retrieveProject: async () => ({ outcome: "ok", value: { id: "proj-1" } }),
    listTraces: async () => ({
      outcome: "ok",
      value: { total: rows.length, content: [...rows] },
    }),
    createTrace: async () => {
      throw new Error("the summary must not write");
    },
    writeSpans: async () => {
      throw new Error("the summary must not write");
    },
  };
}

function appFor(options: {
  port: OpikPort | null;
  config: () => OpikConfig;
  auth: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const healthService = createOpikHealthService({
    config: options.config,
    port: options.port,
  });
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createAiObservabilityRoutes({
      requireUser: options.auth,
      canManageBot,
      scopeEpoch: async () => 1,
      listBots: async () => [],
      config: options.config,
      port: options.port,
      healthService,
      database,
      bindings,
    }),
  );
  return app;
}

let scopeKeyA = "";
let scopeKeyB = "";

async function seedScope(
  actorId: string,
  ownership: "owner" | "admin",
): Promise<string> {
  const scope = resolveObservationScope({
    actorId,
    botId,
    ownership,
    epoch: 1,
  });
  const key = scope.key;
  await database.insert(aiObservationBindings).values([
    {
      id: `${run}-${actorId}-b1`,
      scopeKey: key,
      actorId,
      botId,
      runId: `${run}-run-1`,
      attemptId: "attempt-1",
      traceId: `otel-${actorId}-1`,
      opikTraceId: `opik-${actorId}-1`,
      locatorWorkspace: "ws",
      locatorProject: "proj",
      capability: "basic",
      state: "completed",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
    {
      id: `${run}-${actorId}-b2`,
      scopeKey: key,
      actorId,
      botId,
      runId: `${run}-run-2`,
      attemptId: "attempt-1",
      traceId: `otel-${actorId}-2`,
      opikTraceId: null,
      locatorWorkspace: "ws",
      locatorProject: "proj",
      capability: "detailed",
      state: "failed",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
    {
      // Outside every window the tests ask about.
      id: `${run}-${actorId}-old`,
      scopeKey: key,
      actorId,
      botId,
      runId: `${run}-run-old`,
      attemptId: "attempt-1",
      traceId: `otel-${actorId}-old`,
      opikTraceId: `opik-${actorId}-old`,
      locatorWorkspace: "ws",
      locatorProject: "proj",
      capability: "unavailable",
      state: "running",
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
    },
  ]);
  // The experiment's pinned dataset version (T19/T22 tables, reused as-is).
  await database.insert(aiObservationDatasets).values({
    id: `${run}-${actorId}-ds`,
    scopeKey: key,
    actorId,
    botId,
    name: `dataset-${actorId}`,
    locatorWorkspace: "ws",
    locatorProject: "proj",
  });
  await database.insert(aiObservationDatasetVersions).values({
    id: `${run}-${actorId}-dv`,
    scopeKey: key,
    datasetId: `${run}-${actorId}-ds`,
    contentHash: "no-hash",
    redactionPolicyVersion: "opik-redaction/test",
    cases: [],
    locatorWorkspace: "ws",
    locatorProject: "proj",
  });
  await database.insert(aiObservationExperiments).values({
    id: `${run}-${actorId}-draft`,
    scopeKey: key,
    actorId,
    botId,
    name: "draft-one",
    datasetVersionId: `${run}-${actorId}-dv`,
    datasetContentHash: "no-hash",
    config: {},
    state: "draft",
  });
  await database.insert(aiObservationExportJobs).values({
    id: `${run}-${actorId}-job1`,
    scopeKey: key,
    actorId,
    botId,
    state: "completed",
    rowLimit: 100,
    redactionPolicyVersion: "opik-redaction/test",
    locatorWorkspace: "ws",
    locatorProject: "proj",
    rowCount: 3,
    settledAt: new Date(),
  });
  return key;
}

beforeAll(async () => {
  scopeKeyA = await seedScope(actorA, "owner");
  scopeKeyB = await seedScope(actorB, "admin");
});

afterEach(async () => {
  // The work-item tickets the export-route test enqueues.
  await database.delete(workItems).where(eq(workItems.kind, "opik.export"));
});

afterAll(async () => {
  // The T22/T19 guards refuse experiment and dataset rows leaving any way but
  // their cleanup paths, and that includes this suite's own teardown: the
  // transaction-local flags are the sanctioned route (experiments first —
  // their foreign key pins the dataset versions underneath).
  await database.$client.begin(async (tx) => {
    await tx`select set_config('ai_observation.experiment_cleanup', 'on', true)`;
    await tx`select set_config('ai_observation.dataset_cleanup', 'on', true)`;
    await tx`DELETE FROM ai_observation_experiments WHERE scope_key IN (${scopeKeyA}, ${scopeKeyB})`;
    await tx`DELETE FROM ai_observation_datasets WHERE scope_key IN (${scopeKeyA}, ${scopeKeyB})`;
  });
  await database.$client`RESET ai_observation.experiment_cleanup`;
  await database.$client`RESET ai_observation.dataset_cleanup`;
  await database
    .delete(aiObservationBindings)
    .where(inArray(aiObservationBindings.scopeKey, [scopeKeyA, scopeKeyB]));
  await database
    .delete(aiObservationExportJobs)
    .where(inArray(aiObservationExportJobs.scopeKey, [scopeKeyA, scopeKeyB]));
});

test("the two scopes over the SAME bot id never see each other's rows", async () => {
  const boundA = `opik-${actorA}-1`;
  const unboundForBoth = `opik-unbound-${randomUUID()}`;
  const port = fakePort([
    traceRow(boundA),
    traceRow(unboundForBoth, { usage: undefined }),
    traceRow(`opik-${actorB}-1`, { usage: undefined, status: "ERROR" }),
  ]);
  const app = appFor({
    port,
    config: () => enabledConfig,
    auth: authAs(actorA),
  });
  const response = await app.request(
    `http://openbot.test/admin/summary?botId=${botId}&timeFrom=2026-01-01T00:00:00.000Z`,
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.bots.length).toBe(1);
  const bot = body.bots[0];
  expect(bot.botId).toBe(botId);
  // Only scope A's two in-window bindings: the old row is filtered by time,
  // and scope B's rows are invisible under the same bot id.
  expect(bot.runs.total).toBe(2);
  expect(bot.runs.byState).toEqual({
    running: 0,
    completed: 1,
    failed: 1,
    canceled: 0,
    interrupted: 0,
    unknown: 0,
  });
  expect(bot.runs.pendingSync).toBe(1);
  expect(bot.runs.capabilities).toEqual({
    basic: 1,
    detailed: 1,
    unavailable: 0,
  });
  // The window holds one trace bound under scope A, one unbound trace, and
  // one trace that belongs to scope B — which under A's key is simply another
  // record this scope never bound.
  expect(bot.runs.unboundUpstream).toBe(2);
  // Missing usage is counted, never zeroed: one row reported, two did not.
  expect(bot.runs.usage).toEqual({
    providerReported: 1,
    unavailable: 2,
  });
  expect(bot.experiments).toEqual({ draft: 1, frozen: 0 });
  expect(bot.exports.byState.completed).toBe(1);
  expect(bot.collection.lastCollectedAt).not.toBe(null);
  expect(body.collection.readiness).toEqual({ ready: true, reason: null });
  // No business content rides along: run ids and trace ids stay behind.
  expect(JSON.stringify(body)).not.toContain("run-1");
  expect(JSON.stringify(body)).not.toContain(boundA);
});

test("the same bot id under scope B answers B's own aggregate", async () => {
  const app = appFor({
    port: fakePort([]),
    config: () => enabledConfig,
    auth: authAs(actorB),
  });
  const response = await app.request(
    `http://openbot.test/admin/summary?botId=${botId}&timeFrom=2026-01-01T00:00:00.000Z`,
  );
  expect(response.status).toBe(200);
  const bot = (await response.json()).bots[0];
  expect(bot.runs.total).toBe(2);
  expect(bot.runs.byState.completed).toBe(1);
  // An empty upstream window is a truthful zero, not a disguise.
  expect(bot.runs.unboundUpstream).toBe(0);
  expect(bot.runs.usage).toEqual({ providerReported: 0, unavailable: 0 });
});

test("a stranger gets the unified not-found and no aggregate", async () => {
  const app = appFor({
    port: fakePort([]),
    config: () => enabledConfig,
    auth: authAs(stranger),
  });
  const response = await app.request(
    `http://openbot.test/admin/summary?botId=${botId}`,
  );
  expect(response.status).toBe(404);
});

test("the time window filters every aggregate the same way", async () => {
  const app = appFor({
    port: fakePort([]),
    config: () => enabledConfig,
    auth: authAs(actorA),
  });
  const response = await app.request(
    `http://openbot.test/admin/summary?botId=${botId}&timeFrom=2019-01-01T00:00:00.000Z&timeTo=2019-12-31T23:59:59.999Z`,
  );
  expect(response.status).toBe(200);
  const bot = (await response.json()).bots[0];
  expect(bot.runs.total).toBe(0);
  expect(bot.experiments).toEqual({ draft: 0, frozen: 0 });
  expect(bot.exports.byState.completed).toBe(0);
  expect(bot.collection.lastCollectedAt).toBe(null);
});

test("an unhealthy Opik keeps the true collection state and fails nobody", async () => {
  const app = appFor({
    port: fakePort([], false),
    config: () => enabledConfig,
    auth: authAs(actorA),
  });
  const response = await app.request(
    `http://openbot.test/admin/summary?botId=${botId}&timeFrom=2026-01-01T00:00:00.000Z`,
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  const bot = body.bots[0];
  // The local authoritative counts still answer…
  expect(bot.runs.total).toBe(2);
  // …the upstream-derived facts are explicitly unknown, never zero…
  expect(bot.runs.unboundUpstream).toBe(null);
  expect(bot.runs.usage).toBe(null);
  // …and the readiness carries the real reason from the T13 vocabulary.
  expect(body.collection.readiness).toEqual({
    ready: false,
    reason: "unreachable",
  });
});

test("a disabled deployment answers capability-level honesty, not an empty page", async () => {
  const app = appFor({
    port: null,
    config: () => disabledConfig,
    auth: authAs(actorA),
  });
  const response = await app.request(
    `http://openbot.test/admin/summary?botId=${botId}&timeFrom=2026-01-01T00:00:00.000Z`,
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.collection.readiness).toEqual({
    ready: false,
    reason: "disabled",
  });
  expect(body.bots[0].runs.unboundUpstream).toBe(null);
  expect(body.bots[0].runs.total).toBe(2);
});

test("the mounted runs query serves the wired scope (T12 leftover)", async () => {
  const app = appFor({
    port: fakePort([traceRow(`opik-${actorA}-1`)]),
    config: () => enabledConfig,
    auth: authAs(actorA),
  });
  const response = await app.request(
    `http://openbot.test/bots/${botId}/runs?limit=10`,
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.runs.length).toBe(1);
  // The bound trace carries its joined capability, and the unreconciled
  // binding keeps the list-level syncing signal honest.
  expect(body.runs[0].capability).toBe("basic");
  expect(body.syncing).toBe(true);
});

test("the mounted export route enqueues a real job row (T34 wiring)", async () => {
  const app = appFor({
    port: null,
    config: () => enabledConfig,
    auth: authAs(actorA),
  });
  const response = await app.request(
    `http://openbot.test/bots/${botId}/exports`,
    {
      method: "POST",
    },
  );
  expect(response.status).toBe(202);
  const { job } = await response.json();
  const stored = await database
    .select()
    .from(aiObservationExportJobs)
    .where(eq(aiObservationExportJobs.id, job.jobId));
  expect(stored.length).toBe(1);
  expect(stored[0].scopeKey).toBe(scopeKeyA);
  const listed = await app.request(`http://openbot.test/bots/${botId}/exports`);
  expect(listed.status).toBe(200);
  expect((await listed.json()).jobs.length).toBe(2);
});

test("the epoch source reads the live profile generation", async () => {
  const agentId = `t33-epoch-${randomUUID()}`;
  await database.insert(agents).values({
    id: agentId,
    name: "Epoch Probe",
    type: "built_in",
    configuration: {},
  });
  await database.insert(agentProfiles).values({
    agentId,
    // The epoch reads the row's generation, not its ownership; no user row
    // needs to exist for that question.
    ownerUserId: null,
    title: "t",
    roleDescription: "t",
    avatarSeed: "t",
    visibility: "private",
  });
  const first = await epochSource(actorA, agentId);
  expect(first).toBeGreaterThan(0);
  await database
    .update(agentProfiles)
    .set({ title: "t2", updatedAt: new Date(Date.now() + 5_000) })
    .where(eq(agentProfiles.agentId, agentId));
  const second = await epochSource(actorA, agentId);
  expect(second).toBeGreaterThan(first);
  // A bot that is not there has no generation; the manage gate already
  // refused the call before this could matter.
  expect(await epochSource(actorA, `nope-${randomUUID()}`)).toBe(0);
  await database.delete(agents).where(eq(agents.id, agentId));
});
