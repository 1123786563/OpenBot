import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { Database } from "../../src/db/client";
import { enterprisePrincipals, users } from "../../src/db/schema";
import {
  enterpriseModelInvocationCapabilities,
  enterpriseRuns,
} from "../../src/db/schema/enterprise-runs";
import { enterpriseMemberships } from "../../src/db/schema/enterprise-tenancy";
import type { PlatformScope } from "../../src/enterprise/contracts";
import { createConversationService } from "../../src/enterprise/conversations/service";
import { messageDigest } from "../../src/enterprise/conversations/store";
import { ExpertVersionCatalog } from "../../src/enterprise/experts/version-catalog";
import { createGovernedModelExecution } from "../../src/enterprise/runs/governed-execution";
import {
  canonicalizeModelRouteSnapshot,
  type ModelRouteSnapshotInput,
} from "../../src/enterprise/runs/model-route-catalog";
import { createRunService } from "../../src/enterprise/runs/service";
import { createRunStore } from "../../src/enterprise/runs/store";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";
import { createMastraContinuationStore } from "../../src/mastra/continuation-store";
import { tenantStorageKey } from "../../src/mastra/contracts";
import { createMastraConversationRuntime } from "../../src/mastra/conversation-runtime";
import {
  createGenerationCurrentGate,
  createGovernedTurnRunner,
  GOVERNED_HEADLESS_REFUSALS,
  type GovernedHeadlessRefusal,
  governedFiringIntentKey,
} from "../../src/mastra/headless";
import { createTenantMastraStorage } from "../../src/mastra/tenant-storage";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { createMe03Fixture, type Me03Fixture } from "../support/me03-fixture";

/*
 * ME09 (#481) enterprise suite: the governed ROUTINE firing against a REAL
 * database — the disposable me03-style fixture (control plane + per-tenant
 * mastra storage in ONE database, dropped in teardown; the dev DATABASE_URL
 * is never consulted). The suites drive the SAME services production drives:
 * the real runs service (admission, request lease, capability minting,
 * settlement), the real ConversationService (single-writer intent append and
 * the history a client refresh reads), the real continuation store (the
 * durable suspension ledger), and the real governed carrier around a stubbed
 * upstream dial.
 *
 * The ticket's observable outcomes, on real rows: manual and scheduled
 * firings each write back into the ORIGINAL conversation exactly once; a
 * queue redelivery converges on the SAME advance intent (one budget
 * reservation, one charge, no second run row); a missing budget refuses by
 * name before any admission; a revoked member is blocked before anything
 * runs; a participation wait parks the run ACTIVE with its continuation
 * saved; and the settlement ledger carries the run's confirmed usage.
 */

const SECRET =
  "test-only-model-capability-secret-000000000000000000000000000000";
const CEILING = 1024;
const ROUTE: ModelRouteSnapshotInput = {
  agentId: "me09-bot",
  route: {
    model: { provider: "openai", defaultModel: "me01-model" },
    credentialSecretRef: "cred-1",
  },
  nativeBaseUrl: "https://provider.example/v1",
};

const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
const tenantA = `me09-tenant-a-${suffix}`;
const workspaceA = `me09-workspace-a-${suffix}`;
const ownerActor = `me09-actor-owner-${suffix}`;
const ownerPrincipal = `me09-principal-owner-${suffix}`;

let fixture: Me03Fixture;
let admin: Database;
let data: Awaited<ReturnType<Me03Fixture["openData"]>>;
let directory: Awaited<ReturnType<Me03Fixture["openDirectory"]>>;
let storage: ReturnType<typeof createTenantMastraStorage>;
let service: ReturnType<typeof createConversationService>;
let runs: ReturnType<typeof createRunService>;
let runStore: ReturnType<typeof createRunStore>;
let continuationStore: ReturnType<typeof createMastraContinuationStore>;
let scope: PlatformScope;
let threadId: string;
let admittedRoute: ReturnType<typeof canonicalizeModelRouteSnapshot>;
let expertVersions: ExpertVersionCatalog;

/** OpenAI SSE response built from raw chat-completion chunks. */
const sse = (
  parts: {
    toolCall?: {
      id: string;
      name: string;
      args: string;
    };
    content?: string;
    finish?: string | null;
    usage?: Record<string, number>;
  }[],
): Response => {
  const chunks = parts.map((part, index) => {
    const delta: Record<string, unknown> = {};
    if (index === 0 && part.content !== undefined) delta.role = "assistant";
    if (part.toolCall) {
      delta.tool_calls = [
        {
          index: 0,
          id: part.toolCall.id,
          type: "function",
          function: {
            name: part.toolCall.name,
            arguments: part.toolCall.args,
          },
        },
      ];
    }
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
    { content: "the nightly answer" },
    { finish: "stop" },
    { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
  ]);

const _grantedEchoTool = (executions: unknown[]): GrantedTool => ({
  name: "echo_tool",
  description: "Echo the value back.",
  parameters: z.object({ value: z.string() }),
  execute: async (args) => {
    executions.push(args);
    return "echoed:hi";
  },
  ref: "server/echo_tool",
});

const ROUTINE_ID = "routine_me09";
const recordFor = (thread: string) => ({
  agentId: "me09-bot",
  threadId: thread,
  instruction: "Summarize yesterday.",
  enabled: true,
});

/*
 * The schedule-entrypoint scope resolver: identity per Request through the
 * WeakMap, entrypoint "schedule", and NO tenant/workspace selection — the
 * conversation row for the thread decides them, the same directory-rebuild
 * contract production runs.
 */
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

/** The scope resolver variant that SELECTS the fixture's tenant/workspace (for the first conversation). */
function selectingResolver() {
  return createScopeResolver(directory, {
    data,
    authenticate: async (request) => {
      const actor = scheduleIdentities.get(request);
      return actor ? { actorId: actor, entrypoint: "schedule" } : null;
    },
    selectTenant: () => tenantA,
    selectWorkspace: () => workspaceA,
  });
}

async function runRowFor(clientMessageKey: string) {
  const [row] = await admin
    .select()
    .from(enterpriseRuns)
    .where(eq(enterpriseRuns.clientMessageKey, clientMessageKey))
    .limit(1);
  return row ?? null;
}

async function capabilityRowsFor(runId: string) {
  return admin
    .select({ status: enterpriseModelInvocationCapabilities.status })
    .from(enterpriseModelInvocationCapabilities)
    .where(eq(enterpriseModelInvocationCapabilities.runId, runId));
}

interface RunnerFixture {
  runner: ReturnType<typeof createGovernedTurnRunner>;
  dialCount: () => number;
}

/**
 * The governed headless turn over the REAL services. `fetchFor` dials the
 * stubbed upstream; every other dependency is the production instance.
 */
async function buildRunner(options: {
  threadId: string;
  fetchFor?: () => Promise<Response>;
  granted?: GrantedTool[];
  frontendTools?: readonly {
    name: string;
    description: string;
    parameters?: unknown;
  }[];
  suspensionRef?: { current: unknown };
}): Promise<RunnerFixture> {
  let dials = 0;
  const runner = createGovernedTurnRunner({
    // The scheduling-record authority semantics are covered by the unit
    // suite; here it stands in for the store read, pinned to the test's
    // thread.
    schedulingRecordFor: async () => recordFor(options.threadId),
    scopeFor: async ({ ownerUserId }) => {
      // The production shape: a fresh Request bound to the record's owner,
      // resolved by the schedule-entrypoint resolver against the real
      // directory; the conversation row decides tenant/workspace/principal.
      const request = new Request("https://me09.invalid/firing");
      scheduleIdentities.set(request, ownerUserId);
      return scheduleResolverFor().resolveForThread(request, options.threadId);
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
        agentId: "me09-bot",
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
          return (
            options.fetchFor ? options.fetchFor() : Promise.resolve(TEXT_TURN())
          ) as Promise<Response>;
        }) as never,
      }),
    surfaceFor: async (input) => ({
      instructions: ["You are the nightly summarizer Bot."],
      tools: options.granted ?? [],
      ...(options.frontendTools
        ? { frontendTools: options.frontendTools }
        : {}),
      ...(options.frontendTools
        ? {
            continuations: {
              onSuspension: async (fact) => {
                // The production save: the suspension's continuation lands on
                // the REAL ledger against THIS run's binding, before the
                // waiting state can publish.
                const ref = await continuationStore.saveContinuation(
                  input.binding,
                  {
                    schemaVersion: 1,
                    engine: "mastra",
                    kind: fact.kind,
                    packageFingerprint: continuationStore.currentFingerprint(),
                    toolCallId: fact.toolCallId,
                    toolName: fact.toolName,
                    argsDigest: fact.argsDigest,
                    snapshotRef: `suspended:${input.binding.executionKey}:${fact.toolCallId}`,
                  },
                );
                if (options.suspensionRef) options.suspensionRef.current = ref;
              },
            },
          }
        : {}),
    }),
    runtime: createMastraConversationRuntime({
      conversations: service,
      storage,
      authorizeAttachment: async () => true,
    }),
    leaseRenewMs: 60_000,
  });
  return { runner, dialCount: () => dials };
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

  await admin.insert(users).values({
    id: ownerActor,
    email: `${ownerActor}@example.invalid`,
    name: "ME09 routine owner",
  });
  await admin
    .insert(enterprisePrincipals)
    .values({ id: ownerPrincipal, userId: ownerActor });
  const operator = await fixture.openOperator();
  const { provisionDeployment } = await import(
    "../../src/enterprise/tenancy/provision"
  );
  await provisionDeployment(operator, {
    operationId: `me09-${suffix}`,
    operator: ownerPrincipal,
    tenant: { id: tenantA, name: "ME09 tenant A" },
    workspace: { id: workspaceA, name: "ME09 workspace A" },
    members: [
      { principalId: ownerPrincipal, userId: ownerActor, role: "tenant_admin" },
    ],
    resources: [],
  });
  // MT005: the workspace-membership row is the server-side team eligibility
  // fact the scope resolver checks; provisioning owns the tenant membership,
  // the workspace row is inserted directly (status defaults to active).
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

  // The first scope selects the fixture's tenant/workspace; the conversation
  // is created under it, and every LATER scope re-resolves through the
  // thread (the schedule resolver's own path — asserted below).
  const probe = new Request("https://me09.invalid/probe");
  scheduleIdentities.set(probe, ownerActor);
  scope = await selectingResolver().resolve(probe);
  const conversation = await service.getOrCreate(scope, {
    title: "ME09 routine conversation",
  });
  expect(conversation.storage_backend).toBe("mastra");
  threadId = conversation.thread_id;

  // The thread-backed resolution works: the schedule resolver finds this
  // owner's conversation row and re-issues the scope from the directory.
  const resolved = await scheduleResolverFor().resolveForThread(
    probe,
    threadId,
  );
  expect(resolved.principalId).toBe(scope.principalId);
  expect(resolved.tenantId).toBe(scope.tenantId);
  expect(resolved.entrypoint).toBe("schedule");

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
  runStore = createRunStore(data);
  continuationStore = createMastraContinuationStore({
    database: admin,
    secret: "me09-integration-secret",
  });
}, 240_000);

afterAll(async () => {
  const errors: unknown[] = [];
  await storage?.close().catch((error: unknown) => errors.push(error));
  try {
    await fixture?.drop();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) {
    throw new AggregateError(errors, "ME09 fixture teardown failed");
  }
});

test("scheduled_and_manual_firings_write_back_once_and_a_redelivery_never_double_charges", async () => {
  // 1. The SCHEDULED firing: the firing id is the sweep's offer key; the
  // intent key derives from (routine, firing) — the same formula production
  // runs.
  const scheduled = await buildRunner({ threadId });
  const scheduledFiring = "routine_me09:2026-10-22T09:30Z";
  const scheduledKey = governedFiringIntentKey(ROUTINE_ID, scheduledFiring);
  const scheduledReply = await scheduled.runner({
    ownerUserId: ownerActor,
    routineId: ROUTINE_ID,
    agentId: "me09-bot",
    threadId,
    instruction: "Summarize yesterday.",
    runId: scheduledFiring,
  });
  expect(scheduledReply.replyText).toBe("the nightly answer");

  // The write-back is in the ORIGINAL conversation, on the read a refresh
  // uses: the framed firing message and the assistant answer, newest last.
  const page = await service.history(scope, {
    threadId,
    beforeSeq: null,
    limit: 50,
  });
  const roles = page.items.map((item) => item.role);
  expect(roles[roles.length - 2]).toBe("user");
  expect(roles[roles.length - 1]).toBe("assistant");
  const runRow = await runRowFor(scheduledKey);
  expect(runRow?.status).toBe("succeeded");
  expect(runRow?.principalId).toBe(scope.principalId);

  // Settlement evidence: the run's capability mintings are CONFIRMED usage.
  const capabilities = await capabilityRowsFor(runRow!.id);
  expect(capabilities.length).toBeGreaterThan(0);
  expect(capabilities.every((row) => row.status === "confirmed")).toBe(true);

  // 2. The REDELIVERY of the same firing: converges on the SAME intent.
  const redelivered = await buildRunner({ threadId });
  let refusal: GovernedHeadlessRefusal | undefined;
  try {
    await redelivered.runner({
      ownerUserId: ownerActor,
      routineId: ROUTINE_ID,
      agentId: "me09-bot",
      threadId,
      instruction: "Summarize yesterday.",
      runId: scheduledFiring,
    });
  } catch (error) {
    refusal = error as GovernedHeadlessRefusal;
  }
  expect(refusal?.code).toBe(GOVERNED_HEADLESS_REFUSALS.intentAlreadyAdvanced);
  expect(redelivered.dialCount()).toBe(0);
  // Exactly ONE budget reservation for the intent — the old run was never
  // charged twice by the queue retry.
  const reservations = await runStore.countBudgetReservations(
    scope,
    scheduledKey,
  );
  expect(reservations).toBe(1);
  // And still exactly ONE run row for the intent.
  const rerun = await runRowFor(scheduledKey);
  expect(rerun?.id).toBe(runRow!.id);

  // 3. The MANUAL firing: its own intent, same conversation, writes back too.
  const manual = await buildRunner({ threadId });
  const manualReply = await manual.runner({
    ownerUserId: ownerActor,
    routineId: ROUTINE_ID,
    agentId: "me09-bot",
    threadId,
    instruction: "Summarize yesterday.",
  });
  expect(manualReply.replyText).toBe("the nightly answer");
  const manualPage = await service.history(scope, {
    threadId,
    beforeSeq: null,
    limit: 50,
  });
  // Two more rows landed: the manual firing's framed message and answer.
  expect(manualPage.items.length).toBe(page.items.length + 2);
}, 180_000);

test("a_revoked_member_is_blocked_before_anything_is_admitted", async () => {
  const blocked = await service.getOrCreate(scope, { title: "revoked" });
  const h = await buildRunner({ threadId: blocked.thread_id });
  // Revoke the owner's membership NOW: the directory re-issues no scope.
  await admin
    .update(enterpriseMemberships)
    .set({ status: "suspended" })
    .where(eq(enterpriseMemberships.principalId, ownerPrincipal));
  try {
    let thrown: unknown;
    try {
      await h.runner({
        ownerUserId: ownerActor,
        routineId: ROUTINE_ID,
        agentId: "me09-bot",
        threadId: blocked.thread_id,
        instruction: "Summarize yesterday.",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    // The blocking refusal is the directory's own sentence — a real error,
    // not a silent skip — and nothing was admitted for the firing.
    expect(h.dialCount()).toBe(0);
    const rows = await admin
      .select({ id: enterpriseRuns.id })
      .from(enterpriseRuns)
      .where(eq(enterpriseRuns.threadId, blocked.thread_id));
    expect(rows).toHaveLength(0);
  } finally {
    // Restore for the fixture's remaining life.
    await admin
      .update(enterpriseMemberships)
      .set({ status: "active" })
      .where(eq(enterpriseMemberships.principalId, ownerPrincipal));
  }
}, 120_000);

test("a_participation_wait_parks_the_run_active_with_its_continuation_saved", async () => {
  const wait = await service.getOrCreate(scope, { title: "wait" });
  const waitThread = wait.thread_id;
  const suspensionRef: { current: unknown } = { current: undefined };
  const h = await buildRunner({
    threadId: waitThread,
    fetchFor: () =>
      Promise.resolve(
        sse([
          {
            toolCall: {
              id: "call_wait_1",
              name: "computer_navigate",
              args: '{"url":"https://example.com"}',
            },
          },
          { finish: "tool_calls" },
          {
            usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
          },
        ]),
      ),
    frontendTools: [
      {
        name: "computer_navigate",
        description: "Open a web page on your own computer.",
        parameters: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
      },
    ],
    suspensionRef,
  });
  let thrown: unknown;
  try {
    await h.runner({
      ownerUserId: ownerActor,
      routineId: ROUTINE_ID,
      agentId: "me09-bot",
      threadId: waitThread,
      instruction: "Open the page.",
    });
  } catch (error) {
    thrown = error;
  }
  // The waiting outcome is the shared suspension vocabulary — never a
  // success, never a vendor error.
  expect(thrown).toBeInstanceOf(HeadlessToolSuspension);
  expect((thrown as HeadlessToolSuspension).waiting.kind).toBe("frontend_tool");
  // The run is PARKED ACTIVE (suspended), not settled failed: a later
  // decision re-activates its lease through the runs service.
  const rows = await admin
    .select()
    .from(enterpriseRuns)
    .where(eq(enterpriseRuns.threadId, waitThread));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("suspended");
  // The continuation exists on the REAL ledger, waiting for its decision.
  expect(suspensionRef.current).toBeTruthy();
  const ref = suspensionRef.current as { continuationId: string };
  const record = await continuationStore.getContinuation(
    scope,
    ref.continuationId,
  );
  expect(record?.status).toBe("waiting");
  expect(record?.payload.kind).toBe("frontend_tool");
  expect(record?.binding.botId).toBe("me09-bot");
}, 180_000);

test("the_composed_generation_gate_answers_from_the_real_runs_service", async () => {
  const gate = await service.getOrCreate(scope, { title: "gate" });
  const gateThread = gate.thread_id;
  // Admit a run the way the governed turn does, through the REAL service.
  const key = `routine-adv:${ROUTINE_ID}:gate-probe`;
  await service.append(scope, {
    threadId: gateThread,
    clientMessageKey: key,
    content: "gate probe",
    attachments: [],
  });
  const expertVersionRef = await expertVersions.putOrGet(scope, {
    schemaVersion: 1,
    agentId: "me09-bot",
    source: "tenant_package",
    agentType: "built_in",
    systemPrompt: "Gate probe bot.",
    behaviorVersion: "openbot-routine-v1",
  });
  const run = await runs.start(scope, {
    input: {
      threadId: gateThread,
      clientMessageKey: key,
      messageDigest: messageDigest("gate probe", []).digest,
      attachmentRefs: [],
      entrypoint: scope.entrypoint,
      forwardedProps: { maxOutputTokens: CEILING },
    },
    agentId: "me09-bot",
    expertVersionRef,
    routeRef: admittedRoute.routeRef,
  });
  const lease = await runs.acquireRequestLease(scope, run.run_id);
  const gateProbe = createGenerationCurrentGate(runs);
  // CURRENT: the bound attempt is the run's active one.
  expect(
    await gateProbe({
      scope,
      runId: run.run_id,
      attemptId: lease.attemptId,
      generation: lease.generation,
    }),
  ).toBe(true);
  // STOPPED: the generation moves; the continuation's gate refuses.
  await runs.stop(scope, {
    runId: run.run_id,
    reason: "user_requested",
    attemptId: lease.attemptId,
    generation: lease.generation,
  });
  expect(
    await gateProbe({
      scope,
      runId: run.run_id,
      attemptId: lease.attemptId,
      generation: lease.generation,
    }),
  ).toBe(false);
}, 180_000);
