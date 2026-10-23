import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type { Database } from "../../src/db/client";
import { enterprisePrincipals, users } from "../../src/db/schema";
import { enterpriseRuns } from "../../src/db/schema/enterprise-runs";
import type { PlatformScope } from "../../src/enterprise/contracts";
import { createConversationService } from "../../src/enterprise/conversations/service";
import { ExpertVersionCatalog } from "../../src/enterprise/experts/version-catalog";
import { createGovernedModelExecution } from "../../src/enterprise/runs/governed-execution";
import {
  canonicalizeModelRouteSnapshot,
  type ModelRouteSnapshotInput,
} from "../../src/enterprise/runs/model-route-catalog";
import { createRunService } from "../../src/enterprise/runs/service";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";
import { tenantStorageKey } from "../../src/mastra/contracts";
import { createMastraConversationRuntime } from "../../src/mastra/conversation-runtime";
import { createGovernedTurnRunner } from "../../src/mastra/headless";
import { openMuseTaskSchedulingRecordFor } from "../../src/mastra/openmuse-task-entry";
import { createTenantMastraStorage } from "../../src/mastra/tenant-storage";
import {
  createOpenMuseTaskRunner,
  OPENMUSE_TASK_KIND,
} from "../../src/openmuse-tasks/runner";
import {
  createOpenMuseTaskRows,
  createOpenMuseTaskStore,
  type OpenMuseTaskStore,
} from "../../src/openmuse-tasks/store";
import { createWorkQueue } from "../../src/work/queue";
import { createMe03Fixture, type Me03Fixture } from "../support/me03-fixture";

/*
 * ME12 (#484) enterprise suite: the OpenMuse Task queue entry on the shared
 * governed turn, against a REAL disposable database — the me03-style fixture
 * (control plane + per-tenant mastra storage in ONE database, dropped in
 * teardown) with the REAL task store, work queue and Task runner sweep. What
 * only real rows can prove:
 *
 *   1. Normal: a claimed Task runs ONE governed turn through the production
 *      sweep — the row lands succeeded with its evidence and reply, the run
 *      row carries the explicit budget ceiling, and the framed intent
 *      message plus the answer are in the conversation store.
 *   2. Duplicate callback: a second queue item for a settled Task is
 *      skipped by the row's own status authority — no second run row, no
 *      second dial, no duplicated evidence.
 *   3. Revocation: an owner with no enterprise membership refuses at the
 *      directory before anything is admitted — the Task fails honestly, no
 *      run row, no dial, no message in anyone's conversation.
 *   4. Cancel: a cancel requested while the turn runs settles the row
 *      `cancelled` at the turn's safe boundary — the note on the evidence,
 *      the turn itself allowed to finish — the pre-existing contract.
 */

const SECRET =
  "test-only-model-capability-secret-000000000000000000000000000000";
const CEILING = 1024;
const ROUTE: ModelRouteSnapshotInput = {
  agentId: "me12-bot",
  route: {
    model: { provider: "openai", defaultModel: "me01-model" },
    credentialSecretRef: "cred-1",
  },
  nativeBaseUrl: "https://provider.example/v1",
};

const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
const tenantA = `me12-tenant-a-${suffix}`;
const workspaceA = `me12-workspace-a-${suffix}`;
const ownerActor = `me12-actor-owner-${suffix}`;
const ownerPrincipal = `me12-principal-owner-${suffix}`;
const outsiderActor = `me12-actor-outsider-${suffix}`;

let fixture: Me03Fixture;
let admin: Database;
let data: Awaited<ReturnType<Me03Fixture["openData"]>>;
let directory: Awaited<ReturnType<Me03Fixture["openDirectory"]>>;
let storage: ReturnType<typeof createTenantMastraStorage>;
let service: ReturnType<typeof createConversationService>;
let runs: ReturnType<typeof createRunService>;
let scope: PlatformScope;
let threadId: string;
let admittedRoute: ReturnType<typeof canonicalizeModelRouteSnapshot>;
let expertVersions: ExpertVersionCatalog;
let dials: number;

/** OpenAI SSE response built from raw chat-completion chunks. */
const sse = (
  parts: {
    content?: string;
    finish?: string | null;
    usage?: Record<string, number>;
  }[],
): Response => {
  const chunks = parts.map((part, index) => {
    const delta: Record<string, unknown> = {};
    if (index === 0 && part.content !== undefined) delta.role = "assistant";
    if (part.content !== undefined) delta.content = part.content;
    return {
      id: "upstream-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "me01-model",
      choices: part.usage
        ? []
        : [{ index: 0, delta, finish_reason: part.finish ?? null }],
      ...(part.usage ? { usage: part.usage } : {}),
    };
  });
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
};

const TEXT_TURN = () =>
  sse([
    { content: "the task reply" },
    { finish: "stop" },
    { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
  ]);

const scheduleIdentities = new WeakMap<Request, string>();
let scheduleResolver: ReturnType<typeof createScopeResolver> | undefined;
function scheduleResolverFor() {
  scheduleResolver ??= createScopeResolver(directory, {
    data,
    authenticate: async (request) => {
      const actor = scheduleIdentities.get(request);
      return actor ? { actorId: actor, entrypoint: "schedule" } : null;
    },
    selectTenant: () => null,
    selectWorkspace: () => null,
  });
  return scheduleResolver;
}

/**
 * The production-shaped governed Task turn: the REAL record adapter over the
 * fixture database, the REAL directory, the REAL runs service and the REAL
 * conversation runtime — the only stand-in is the upstream dial (the
 * established stub-SSE harness). The conversation thread stands in for the
 * owner's own direct-channel thread the way an onboarded enterprise
 * deployment resolves it (the channel seam is injected in production too).
 */
function governedTaskTurn(options: {
  fetchDelayMs?: number;
  turnTimeoutMs?: number;
}) {
  return createGovernedTurnRunner({
    schedulingRecordFor: openMuseTaskSchedulingRecordFor({
      database: admin,
      channelThreadIdFor: async () => threadId,
    }),
    scopeFor: async ({ ownerUserId, threadId: recordThread }) => {
      const request = new Request("https://me12.invalid/firing");
      scheduleIdentities.set(request, ownerUserId);
      return scheduleResolverFor().resolveForThread(request, recordThread);
    },
    runs,
    conversations: service,
    expertVersionFor: ({ scope: admissionScope, definition }) =>
      expertVersions.putOrGet(admissionScope, definition),
    modelRouteFor: async () => ({
      routeRef: admittedRoute.routeRef,
      maximumTokens: CEILING,
    }),
    governedExecutionFor: ({
      scope: admissionScope,
      routeRef,
      ceiling: runCeiling,
    }) =>
      createGovernedModelExecution({
        scope: admissionScope,
        agentId: "me12-bot",
        routeRef,
        ceiling: runCeiling,
        runs,
        catalog: {
          get: async (_scope, ref) =>
            ref === admittedRoute.routeRef ? admittedRoute : null,
        },
        currentRouteForAgent: async () => ROUTE,
        modelCapabilitySecret: SECRET,
        encryptionKey: Buffer.alloc(32, 7).toString("base64"),
        credentialReader: { readModelSecret: async () => null },
        environment: {
          OPENAI_BASE_URL: "https://provider.example/v1",
          OPENAI_API_KEY: "sk-env-fallback",
        },
        fetch: (async () => {
          dials += 1;
          if (options.fetchDelayMs) {
            await new Promise((resolve) =>
              setTimeout(resolve, options.fetchDelayMs),
            );
          }
          return TEXT_TURN();
        }) as never,
      }),
    surfaceFor: async () => ({
      instructions: ["You are the private OpenMuse Bot."],
      tools: [],
    }),
    runtime: createMastraConversationRuntime({
      conversations: service,
      storage,
      authorizeAttachment: async () => true,
    }),
    leaseRenewMs: 60_000,
    ...(options.turnTimeoutMs ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
  });
}

/**
 * The production Task runner shape: the REAL store, queue and sweep, with
 * the governed turn as the runTurn seam. The task's files/monitor seams stay
 * at their honest refusing defaults (an agent Task touches neither), and the
 * channel seam answers the same thread the record resolves — the sweep's own
 * pre-turn resolution, which the record adapter then re-derives.
 */
function taskRunner(
  options: { fetchDelayMs?: number; turnTimeoutMs?: number } = {},
): {
  runner: ReturnType<typeof createOpenMuseTaskRunner>;
  store: OpenMuseTaskStore;
} {
  const store = createOpenMuseTaskStore({
    rows: createOpenMuseTaskRows(admin),
    queue: createWorkQueue(admin),
  });
  const runner = createOpenMuseTaskRunner({
    queue: createWorkQueue(admin),
    store,
    owner: `me12-worker-${suffix}`,
    actorFor: async (id) => ({ id, role: "user" }),
    channels: {
      direct: async () => ({ threadId }) as never,
    },
    runTurn: governedTaskTurn(options),
  });
  return { runner, store };
}

async function runRowCount() {
  const rows = await admin
    .select({ id: enterpriseRuns.id })
    .from(enterpriseRuns)
    .where(eq(enterpriseRuns.threadId, threadId));
  return rows.length;
}

beforeAll(async () => {
  fixture = await createMe03Fixture();
  admin = fixture.openDatabase(fixture.adminUrl);
  data = await fixture.openData();
  directory = await fixture.openDirectory();

  const provisioner = fixture.provisioner();
  await provisioner.provision({
    tenantId: tenantA,
    storageKey: tenantStorageKey(tenantA),
    roleVersion: 1,
  });

  await admin.insert(users).values([
    {
      id: ownerActor,
      email: `${ownerActor}@example.invalid`,
      name: "ME12 task owner",
    },
    {
      id: outsiderActor,
      email: `${outsiderActor}@example.invalid`,
      name: "ME12 outsider",
    },
  ]);
  await admin
    .insert(enterprisePrincipals)
    .values({ id: ownerPrincipal, userId: ownerActor });
  const operator = await fixture.openOperator();
  const { provisionDeployment } = await import(
    "../../src/enterprise/tenancy/provision"
  );
  await provisionDeployment(operator, {
    operationId: `me12-${suffix}`,
    operator: ownerPrincipal,
    tenant: { id: tenantA, name: "ME12 tenant A" },
    workspace: { id: workspaceA, name: "ME12 workspace A" },
    members: [
      { principalId: ownerPrincipal, userId: ownerActor, role: "tenant_admin" },
    ],
    resources: [],
  });
  const { enterpriseWorkspaceMemberships } = await import(
    "../../src/db/schema/enterprise-tenancy"
  );
  await admin.insert(enterpriseWorkspaceMemberships).values([
    {
      tenantId: tenantA,
      workspaceId: workspaceA,
      principalId: ownerPrincipal,
    },
  ]);

  storage = createTenantMastraStorage(fixture.lookup());
  service = createConversationService({ data, mastraStorage: storage });

  const probe = new Request("https://me12.invalid/probe");
  scheduleIdentities.set(probe, ownerActor);
  scope = (await createScopeResolver(directory, {
    data,
    authenticate: async (request) => {
      const actor = scheduleIdentities.get(request);
      return actor ? { actorId: actor, entrypoint: "schedule" } : null;
    },
    selectTenant: () => tenantA,
    selectWorkspace: () => workspaceA,
  }).resolve(probe)) as PlatformScope;
  const conversation = await service.getOrCreate(scope, {
    title: "ME12 task conversation",
  });
  expect(conversation.storage_backend).toBe("mastra");
  threadId = conversation.thread_id;

  admittedRoute = canonicalizeModelRouteSnapshot(scope.tenantId, ROUTE, SECRET);
  expertVersions = new ExpertVersionCatalog(data);
  runs = createRunService({
    data,
    conversations: service,
    expertVersions,
    modelRouteFor: async () => ({
      routeRef: admittedRoute.routeRef,
      maximumTokens: CEILING,
    }),
    modelCapabilitySecret: SECRET,
  });
  dials = 0;
}, 240_000);

afterAll(async () => {
  const errors: unknown[] = [];
  await storage?.close().catch((error: unknown) => errors.push(error));
  try {
    await fixture?.drop();
  } catch (error: unknown) {
    errors.push(error);
  }
  if (errors.length) {
    throw new AggregateError(errors, "ME12 fixture teardown failed");
  }
});

test("normal: a claimed task runs one governed turn and lands succeeded with its evidence", async () => {
  const dialsBefore = dials;
  const { runner, store } = taskRunner();
  const { task } = await store.create({
    ownerUserId: ownerActor,
    botId: "me12-bot",
    kind: "agent",
    prompt: "Plan my week",
    idempotencyKey: null,
  });
  const report = await runner.sweep();
  expect(report.ran).toHaveLength(1);

  const settled = await store.get(ownerActor, task.id);
  expect(settled?.status).toBe("succeeded");
  const evidence = settled?.evidence as { title: string; excerpt: string }[];
  expect(evidence.map((row) => row.title)).toContain("Your request");
  const work = evidence.find((row) => row.title === "Work completed");
  expect(work?.excerpt).toBe("the task reply");

  // ONE governed run row, carrying the explicit unattended budget ceiling.
  const rows = await admin
    .select({
      status: enterpriseRuns.status,
      maximumTokens: enterpriseRuns.modelRouteMaximumTokens,
    })
    .from(enterpriseRuns)
    .where(eq(enterpriseRuns.threadId, threadId));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("succeeded");
  expect(rows[0]!.maximumTokens).toBe(CEILING);
  expect(dials).toBe(dialsBefore + 1);

  // The framed intent message and the answer are in the conversation store.
  const page = await service.history(scope, {
    threadId,
    beforeSeq: null,
    limit: 50,
  });
  expect(
    page.items.some(
      (item) =>
        item.role === "user" && String(item.content).includes("Plan my week"),
    ),
  ).toBe(true);
  expect(
    page.items.some(
      (item) =>
        item.role === "assistant" &&
        String(item.content).includes("the task reply"),
    ),
  ).toBe(true);
}, 120_000);

test("duplicate: a second queue item for a settled task never runs it twice", async () => {
  const dialsBefore = dials;
  const { runner, store } = taskRunner();
  const { task } = await store.create({
    ownerUserId: ownerActor,
    botId: "me12-bot",
    kind: "agent",
    prompt: "Count my duplicates",
    idempotencyKey: null,
  });
  await runner.sweep();
  const before = await store.get(ownerActor, task.id);
  const beforeEvidence =
    (before?.evidence as unknown[] | undefined)?.length ?? -1;
  const beforeRuns = await runRowCount();

  // The duplicate callback: a fresh queue item for the SAME settled row.
  const duplicateQueue = createWorkQueue(admin);
  await duplicateQueue.offer({
    kind: OPENMUSE_TASK_KIND,
    key: `${task.id}:duplicate`,
    payload: { ownerUserId: ownerActor, taskId: task.id },
  });
  const report = await runner.sweep();
  expect(report.ran).toHaveLength(0);
  expect(report.skipped).toHaveLength(1);

  const after = await store.get(ownerActor, task.id);
  expect((after?.evidence as unknown[] | undefined)?.length).toBe(
    beforeEvidence,
  );
  expect(await runRowCount()).toBe(beforeRuns);
  // Only the first turn dialed; the duplicate callback added none.
  expect(dials).toBe(dialsBefore + 1);
}, 120_000);

test("revoked: an owner outside the enterprise directory refuses before anything is admitted", async () => {
  const dialsBefore = dials;
  const runsBefore = await runRowCount();
  const { runner, store } = taskRunner();
  const { task } = await store.create({
    ownerUserId: outsiderActor,
    botId: "me12-bot",
    kind: "agent",
    prompt: "Should never run",
    idempotencyKey: null,
  });
  const report = await runner.sweep();
  expect(report.skipped).toHaveLength(1);

  const settled = await store.get(outsiderActor, task.id);
  // The task fails HONESTLY with the directory's own refusal — never a
  // fabricated success, never a guessed scope.
  expect(settled?.status).toBe("failed");
  const step = (settled?.steps as { result?: string }[] | undefined)?.at(-1);
  expect(String(step?.result ?? "")).toContain("THREAD_SCOPE_NOT_FOUND");
  // Nothing was admitted and nothing dialed: no run row, no message.
  expect(await runRowCount()).toBe(runsBefore);
  expect(dials).toBe(dialsBefore);
  const page = await service.history(scope, {
    threadId,
    beforeSeq: null,
    limit: 50,
  });
  expect(
    page.items.some((item) =>
      String(item.content).includes("Should never run"),
    ),
  ).toBe(false);
}, 120_000);

test("cancel: a cancel requested while the turn runs settles cancelled at the safe boundary", async () => {
  const { runner, store } = taskRunner({ fetchDelayMs: 400 });
  const { task } = await store.create({
    ownerUserId: ownerActor,
    botId: "me12-bot",
    kind: "agent",
    prompt: "Cancel me at the boundary",
    idempotencyKey: null,
  });
  // The sweep runs its claim; once the turn is in flight, the owner's cancel
  // request lands on the running row (status stays running; the flag waits).
  const dialsAtStart = dials;
  const sweep = runner.sweep();
  for (let waited = 0; dials === dialsAtStart && waited < 40; waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(dials).toBeGreaterThan(dialsAtStart);
  const requested = await store.requestCancel(ownerActor, task.id);
  expect(requested.outcome).toBe("requested");
  const report = await sweep;
  // The turn was allowed to finish; the safe boundary settled the row
  // cancelled with the note on the evidence — never a fabricated success.
  // (The runner reports a boundary-settled claim as a skip: the Task's own
  // work was not allowed to succeed past the cancel.)
  expect(report.ran).toHaveLength(0);
  expect(report.skipped).toHaveLength(1);
  const settled = await store.get(ownerActor, task.id);
  expect(settled?.status).toBe("cancelled");
  const evidence = settled?.evidence as { title: string; excerpt: string }[];
  const note = evidence.find((row) => row.title === "Cancelled");
  expect(note?.excerpt).toContain("Cancelled while running");
}, 120_000);
