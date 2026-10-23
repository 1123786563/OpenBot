import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type { RunAssertion } from "../../src/agents/callback-token";
import { createHandoffDesk, HANDOFF_KIND } from "../../src/agents/handoff";
import { createHandoffRunner } from "../../src/agents/handoff-runner";
import { handoffTool } from "../../src/agents/handoff-tool";
import { createAgentProfileStore } from "../../src/agents/profile-store";
import { createApprovalStore } from "../../src/approvals/store";
import { createAuditStore } from "../../src/audit";
import { HeadlessToolSuspension } from "../../src/computer/headless-tools";
import type { Database } from "../../src/db/client";
import {
  agentProfiles,
  agents,
  enterprisePrincipals,
  pluginGrants,
  users,
  workItems,
} from "../../src/db/schema";
import { enterpriseRuns } from "../../src/db/schema/enterprise-runs";
import {
  enterpriseMemberships,
  enterpriseWorkspaceMemberships,
} from "../../src/db/schema/enterprise-tenancy";
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
import {
  createGovernedHandoffDelivery,
  createGovernedHandoffRecordResolver,
  HandoffTargetWaitingError,
  handoffSchedulingRecordFor,
} from "../../src/mastra/handoff-delivery";
import {
  createGovernedTurnRunner,
  governedFiringIntentKey,
} from "../../src/mastra/headless";
import { createTenantMastraStorage } from "../../src/mastra/tenant-storage";
import type { GrantedTool } from "../../src/plugins/tools";
import { createPrivateShareCheck } from "../../src/proactive/private-share";
import { createWorkQueue } from "../../src/work/queue";
import { createMe03Fixture, type Me03Fixture } from "../support/me03-fixture";

/*
 * ME11 (#483) enterprise suite: a Bot-to-Bot hop on the governed headless
 * turn, against a REAL disposable database — the me03-style fixture (control
 * plane + per-tenant mastra storage in ONE database, dropped in teardown).
 * What only real rows can prove:
 *
 *   1. A NORMAL handoff through the production runner: the desk offer, the
 *      governed delivery running the ADDRESSED Bot on real runs-service rows
 *      and a real scratch conversation, the answer relaying back through the
 *      asking Bot's own governed turn in the asking conversation — and a
 *      redelivery of the same hop converging on the first advance (one run
 *      row, one scratch conversation, no second dial).
 *   2. CROSS-COMPANY: a hop whose actor holds no membership in the asking
 *      conversation's tenant refuses from the directory before anything is
 *      admitted — the same global user cannot run across companies.
 *   3. REVOCATION: deleting the owner's membership between offer and
 *      delivery refuses the hop; nothing dials, nothing is admitted.
 *   4. WAITING: an approval wait parks the addressed Bot's run durably and
 *      the delivery reports WAITING — never a relayed answer.
 *   5. RESULT-READ PERMISSION: the scratch conversation is scoped to the
 *      owner's principal; a principal from the other company reads nothing.
 *   6. The DESK's own guarantees, unchanged on the migrated path: depth cap,
 *      revoked grant, deleted target — and a private-share denial sends
 *      nothing.
 */

const SECRET =
  "test-only-model-capability-secret-000000000000000000000000000000";
const CEILING = 1024;
const ROUTE: ModelRouteSnapshotInput = {
  agentId: "me11-addressed",
  route: {
    model: { provider: "openai", defaultModel: "me01-model" },
    credentialSecretRef: "cred-1",
  },
  nativeBaseUrl: "https://provider.example/v1",
};
const ADDRESSED_BOT = "me11-addressed";
const ASKING_BOT = "me11-asking";

const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
const tenantA = `me11-tenant-a-${suffix}`;
const workspaceA = `me11-workspace-a-${suffix}`;
const tenantB = `me11-tenant-b-${suffix}`;
const workspaceB = `me11-workspace-b-${suffix}`;
const ownerActor = `me11-actor-owner-${suffix}`;
const ownerPrincipal = `me11-principal-owner-${suffix}`;
const otherActor = `me11-actor-other-${suffix}`;
const otherPrincipal = `me11-principal-other-${suffix}`;

let fixture: Me03Fixture;
let admin: Database;
let data: Awaited<ReturnType<Me03Fixture["openData"]>>;
let directory: Awaited<ReturnType<Me03Fixture["openDirectory"]>>;
let storage: ReturnType<typeof createTenantMastraStorage>;
let service: ReturnType<typeof createConversationService>;
let runs: ReturnType<typeof createRunService>;
let expertVersions: ExpertVersionCatalog;
let scopeA: PlatformScope;
let scopeB: PlatformScope;
let threadA: string;
let threadB: string;
let admittedRoute: ReturnType<typeof canonicalizeModelRouteSnapshot>;
let queue: ReturnType<typeof createWorkQueue>;

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

/** The trusted directory resolver the governed hop record signs its scope from. */
const realScopeFor = async (input: {
  ownerUserId: string;
  threadId: string;
}): Promise<PlatformScope> => {
  const request = new Request("https://me11.invalid/hop");
  scheduleIdentities.set(request, input.ownerUserId);
  return scheduleResolverFor().resolveForThread(request, input.threadId);
};

/** OpenAI SSE response built from raw chat-completion chunks. */
const sse = (
  parts: {
    content?: string;
    toolCall?: { id: string; name: string; args: string };
    finish?: string | null;
    usage?: Record<string, number>;
  }[],
): Response => {
  const chunks = parts.map((part, index) => {
    const delta: Record<string, unknown> = {};
    if (index === 0 && (part.content !== undefined || part.toolCall)) {
      delta.role = "assistant";
    }
    if (part.toolCall) {
      delta.tool_calls = [
        {
          index: 0,
          id: part.toolCall.id,
          type: "function",
          function: { name: part.toolCall.name, arguments: part.toolCall.args },
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

const ANSWER_TURN = () =>
  sse([
    { content: "the addressed Bot's answer" },
    { finish: "stop" },
    { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
  ]);

const RELAY_TURN = () =>
  sse([
    { content: "the outcome, in the asking Bot's voice" },
    { finish: "stop" },
    { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ]);

interface DeliveryFixture {
  delivery: ReturnType<typeof createGovernedHandoffDelivery>;
  dialCount: () => number;
}

function buildDelivery(options: {
  fetchFor: () => Response;
  granted?: GrantedTool[];
}): DeliveryFixture {
  const resolver = createGovernedHandoffRecordResolver({
    database: admin,
    scopeFor: realScopeFor,
    conversations: service,
  });
  let dials = 0;
  const turn = createGovernedTurnRunner({
    schedulingRecordFor: handoffSchedulingRecordFor(resolver),
    scopeFor: realScopeFor,
    runs,
    conversations: service,
    expertVersionFor: ({ scope, definition }) =>
      expertVersions.putOrGet(scope, definition),
    modelRouteFor: async () => ({
      routeRef: admittedRoute.routeRef,
      maximumTokens: CEILING,
    }),
    governedExecutionFor: ({ scope, routeRef, ceiling }) =>
      createGovernedModelExecution({
        scope,
        agentId: ADDRESSED_BOT,
        routeRef,
        ceiling,
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
          return options.fetchFor();
        }) as never,
      }),
    surfaceFor: async (input) => ({
      instructions: ["You are the addressed Bot."],
      tools: options.granted ?? [],
      // The engine snapshot's durable home, the way the production surface
      // composes it — an approval wait parks against THIS run's binding.
      continuations: {
        storage: await (async () => {
          if (!input.binding.threadId) return undefined;
          const mastraBinding = await service.resolveMastraBinding(
            scopeA,
            input.binding.threadId,
          );
          return storage.getStore(scopeA, mastraBinding);
        })(),
        durableToolNames: [],
        onSuspension: async () => undefined,
      },
    }),
    runtime: createMastraConversationRuntime({
      conversations: service,
      storage,
      authorizeAttachment: async () => true,
    }),
  });
  return {
    delivery: createGovernedHandoffDelivery({ turn, resolver }),
    dialCount: () => dials,
  };
}

const deliver = (
  hop: DeliveryFixture,
  work: Record<string, unknown>,
  key: string,
) =>
  hop.delivery.deliver({
    work: work as never,
    message: "the attributed message the runner composed",
    assertion: "the signed assertion",
    claim: { key, owner: "me11-runner" },
  });

const forwardWork = (over: Record<string, unknown> = {}) => ({
  fromBotId: ASKING_BOT,
  toBotId: ADDRESSED_BOT,
  actorId: ownerActor,
  threadId: threadA,
  runId: `run-${randomUUID().slice(0, 8)}`,
  depth: 1,
  task: "summarise the quarterly numbers",
  toName: "Addressed",
  fromName: "Asker",
  initiator: { kind: "handoff", id: ASKING_BOT, origin: { kind: "person" } },
  ...over,
});

async function offerHop(key: string, work: Record<string, unknown>) {
  const offered = await queue.offer({
    kind: HANDOFF_KIND,
    key,
    payload: work,
  });
  expect(offered).toBe("queued");
}

async function hopRow(key: string) {
  const [row] = await admin
    .select({ payload: workItems.payload, finishedAt: workItems.finishedAt })
    .from(workItems)
    .where(and(eq(workItems.kind, HANDOFF_KIND), eq(workItems.key, key)))
    .limit(1);
  return row ?? null;
}

async function runRowFor(clientMessageKey: string) {
  const [row] = await admin
    .select()
    .from(enterpriseRuns)
    .where(eq(enterpriseRuns.clientMessageKey, clientMessageKey))
    .limit(1);
  return row ?? null;
}

async function historyFor(scope: PlatformScope, threadId: string) {
  const page = await service.history(scope, {
    threadId,
    beforeSeq: null,
    limit: 100,
  });
  return page.items;
}

beforeAll(async () => {
  fixture = await createMe03Fixture();
  admin = fixture.openDatabase(fixture.adminUrl);
  data = await fixture.openData();
  directory = await fixture.openDirectory();
  queue = createWorkQueue(admin);

  const provisioner = fixture.provisioner();
  for (const tenantId of [tenantA, tenantB]) {
    await provisioner.provision({
      tenantId,
      storageKey: tenantStorageKey(tenantId),
      roleVersion: 1,
    });
  }

  await admin.insert(users).values([
    {
      id: ownerActor,
      email: `${ownerActor}@example.invalid`,
      name: "ME11 owner",
    },
    {
      id: otherActor,
      email: `${otherActor}@example.invalid`,
      name: "ME11 other company",
    },
  ]);
  await admin.insert(enterprisePrincipals).values([
    { id: ownerPrincipal, userId: ownerActor },
    { id: otherPrincipal, userId: otherActor },
  ]);
  const operator = await fixture.openOperator();
  const { provisionDeployment } = await import(
    "../../src/enterprise/tenancy/provision"
  );
  await provisionDeployment(operator, {
    operationId: `me11-${suffix}`,
    operator: ownerPrincipal,
    tenant: { id: tenantA, name: "ME11 tenant A" },
    workspace: { id: workspaceA, name: "ME11 workspace A" },
    members: [
      { principalId: ownerPrincipal, userId: ownerActor, role: "tenant_admin" },
    ],
    resources: [],
  });
  await provisionDeployment(operator, {
    operationId: `me11b-${suffix}`,
    operator: otherPrincipal,
    tenant: { id: tenantB, name: "ME11 tenant B" },
    workspace: { id: workspaceB, name: "ME11 workspace B" },
    members: [
      { principalId: otherPrincipal, userId: otherActor, role: "tenant_admin" },
    ],
    resources: [],
  });
  // provisionDeployment seeds enterprise_memberships (tenant_admin) for each
  // member list. The MT005 team-eligibility rows are seeded here: one active
  // workspace membership per principal, which the scope resolver demands.
  await admin.insert(enterpriseWorkspaceMemberships).values([
    { tenantId: tenantA, workspaceId: workspaceA, principalId: ownerPrincipal },
    { tenantId: tenantB, workspaceId: workspaceB, principalId: otherPrincipal },
  ]);

  storage = createTenantMastraStorage(fixture.lookup());
  service = createConversationService({ data, mastraStorage: storage });

  const probeA = new Request("https://me11.invalid/probe-a");
  scheduleIdentities.set(probeA, ownerActor);
  scopeA = await selectingResolver().resolve(probeA);
  const conversationA = await service.getOrCreate(scopeA, {
    title: "ME11 asking conversation",
  });
  expect(conversationA.storage_backend).toBe("mastra");
  threadA = conversationA.thread_id;

  const resolverB = createScopeResolver(directory, {
    data,
    authenticate: async (request) => {
      const actor = scheduleIdentities.get(request);
      return actor ? { actorId: actor, entrypoint: "schedule" } : null;
    },
    selectTenant: () => tenantB,
    selectWorkspace: () => workspaceB,
  });
  const probeB = new Request("https://me11.invalid/probe-b");
  scheduleIdentities.set(probeB, otherActor);
  scopeB = await resolverB.resolve(probeB);
  const conversationB = await service.getOrCreate(scopeB, {
    title: "ME11 other company conversation",
  });
  threadB = conversationB.thread_id;

  admittedRoute = canonicalizeModelRouteSnapshot(
    scopeA.tenantId,
    ROUTE,
    SECRET,
  );
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
    throw new AggregateError(errors, "ME11 fixture teardown failed");
  }
});

test("AC3/AC6: a normal handoff through the production runner, and a converging redelivery", async () => {
  const forward = buildDelivery({ fetchFor: ANSWER_TURN });
  const relay = buildDelivery({ fetchFor: RELAY_TURN });
  const work = forwardWork();
  const hopKey = `hop:me11-${randomUUID().slice(0, 8)}`;
  await offerHop(hopKey, work);

  // The PRODUCTION runner: queue claim, retry ledger, relay enqueueing —
  // with the governed delivery behind it.
  const runner = createHandoffRunner({
    queue,
    owner: "me11-runner",
    sign: () => "",
    auditStore: createAuditStore(admin),
    renewEveryMs: 60_000,
    delivery: {
      deliver: async (input) =>
        input.work.answerIn
          ? relay.delivery.deliver(input)
          : forward.delivery.deliver(input),
    },
  });
  const report = await runner.sweep();
  expect(report.delivered).toEqual([ADDRESSED_BOT]);

  // The addressed Bot's turn: ONE run row under the hop's stable intent, on
  // real runs-service rows, with the scratch conversation mapped on the row.
  const intentKey = governedFiringIntentKey(`handoff:${hopKey}`, hopKey);
  const runRow = await runRowFor(intentKey);
  expect(runRow?.status).toBe("succeeded");
  // AC4: the sub-call's EXPLICIT budget on its own admission — the same
  // server-side ceiling every governed headless entry shares, the payer the
  // admitted scope's own principal. One budget reservation per hop.
  expect(runRow?.modelRouteMaximumTokens).toBe(CEILING);
  expect(runRow?.principalId).toBe(ownerPrincipal);
  const row = await hopRow(hopKey);
  const scratchThreadId = (row?.payload as { scratchThreadId?: string })
    ?.scratchThreadId;
  expect(scratchThreadId).toBeTruthy();
  expect(runRow?.threadId).toBe(scratchThreadId);
  const scratchMessages = await historyFor(scopeA, scratchThreadId!);
  expect(
    scratchMessages.some(
      (item) =>
        item.role === "user" &&
        String(item.content).includes("summarise the quarterly numbers"),
    ),
  ).toBe(true);
  expect(
    scratchMessages.some(
      (item) =>
        item.role === "assistant" &&
        item.content === "the addressed Bot's answer",
    ),
  ).toBe(true);

  // The relay hop is queued by the runner and delivered on the next sweep:
  // the asking Bot's governed turn lands the outcome in the conversation the
  // person is actually watching.
  const relayReport = await runner.sweep();
  expect(relayReport.delivered).toEqual([ASKING_BOT]);
  const relayMessages = await historyFor(scopeA, threadA);
  expect(
    relayMessages.some(
      (item) =>
        item.role === "assistant" &&
        item.content === "the outcome, in the asking Bot's voice",
    ),
  ).toBe(true);

  // A redelivery of the SAME hop — a lease that flapped, a reaper that kept
  // the key — converges on the first advance: the finished row refuses the
  // record, and nothing dials or runs twice.
  const dialsBefore = forward.dialCount() + relay.dialCount();
  let refusal: Error | undefined;
  try {
    await deliver(forward, work, hopKey);
  } catch (cause) {
    refusal = cause as Error;
  }
  expect(refusal?.message).toContain("HANDOFF_HOP_NOT_ADVANCEABLE");
  expect(forward.dialCount() + relay.dialCount()).toBe(dialsBefore);
  expect((await runRowFor(intentKey))?.id).toBe(runRow!.id);

  // The other convergence branch: the row NOT finished (a lease that flapped
  // before the finish could land) but the advance intent already claimed —
  // the runs-ledger pre-check refuses the redelivery before any
  // conversation is resolved, which is the branch a reaper-era duplicate
  // delivery meets.
  await admin
    .update(workItems)
    .set({ finishedAt: null })
    .where(and(eq(workItems.kind, HANDOFF_KIND), eq(workItems.key, hopKey)));
  let flapRefusal: Error | undefined;
  try {
    await deliver(forward, work, hopKey);
  } catch (cause) {
    flapRefusal = cause as Error;
  }
  expect(flapRefusal?.message).toContain("HANDOFF_HOP_NOT_ADVANCEABLE");
  expect(forward.dialCount() + relay.dialCount()).toBe(dialsBefore);
  expect((await runRowFor(intentKey))?.id).toBe(runRow!.id);
}, 180_000);

test("AC6: a cross-company hop refuses from the directory before anything is admitted", async () => {
  // Two companies, one deployment: a hop row that claims the OTHER company's
  // actor against THIS company's conversation is not an authorization. The
  // record resolver's scope signing throws from the directory's own answer —
  // before the turn, before a dial, before a run, before a conversation.
  const hop = buildDelivery({ fetchFor: ANSWER_TURN });
  const work = forwardWork({ actorId: otherActor });
  const hopKey = `hop:me11-cross-${randomUUID().slice(0, 8)}`;
  await offerHop(hopKey, work);
  let error: Error | undefined;
  try {
    await deliver(hop, work, hopKey);
  } catch (cause) {
    error = cause as Error;
  }
  expect(error).toBeInstanceOf(Error);
  expect(hop.dialCount()).toBe(0);
  const intentKey = governedFiringIntentKey(`handoff:${hopKey}`, hopKey);
  expect(await runRowFor(intentKey)).toBeNull();
  // The hop row was not decorated with a scratch conversation either.
  const row = await hopRow(hopKey);
  const crossPayload = row?.payload as { scratchThreadId?: string } | undefined;
  expect(
    crossPayload ? crossPayload.scratchThreadId : undefined,
  ).toBeUndefined();
}, 180_000);

test("AC6: a revoked member's queued hop refuses instead of running", async () => {
  const hop = buildDelivery({ fetchFor: ANSWER_TURN });
  const work = forwardWork();
  const hopKey = `hop:me11-revoked-${randomUUID().slice(0, 8)}`;
  await offerHop(hopKey, work);
  // Revoked between offer and delivery: the membership is no longer active,
  // so the directory refuses to sign a scope and the hop never runs. The
  // membership is SUSPENDED rather than deleted because the control plane
  // cascades a deleted member's conversations away with the row — and this
  // test is about the member's authority, not their data's disposal.
  await admin
    .update(enterpriseMemberships)
    .set({ status: "suspended" })
    .where(eq(enterpriseMemberships.principalId, ownerPrincipal));
  try {
    let error: Error | undefined;
    try {
      await deliver(hop, work, hopKey);
    } catch (cause) {
      error = cause as Error;
    }
    expect(error).toBeInstanceOf(Error);
    expect(hop.dialCount()).toBe(0);
    const intentKey = governedFiringIntentKey(`handoff:${hopKey}`, hopKey);
    expect(await runRowFor(intentKey)).toBeNull();
    // The hop row was not decorated with a scratch conversation either.
    const row = await hopRow(hopKey);
    const revokedPayload = row?.payload as
      | { scratchThreadId?: string }
      | undefined;
    expect(
      revokedPayload ? revokedPayload.scratchThreadId : undefined,
    ).toBeUndefined();
  } finally {
    // Restore the membership: the rest of the suite needs the owner live.
    await admin
      .update(enterpriseMemberships)
      .set({ status: "active" })
      .where(eq(enterpriseMemberships.principalId, ownerPrincipal));
  }
}, 180_000);

test("AC5: a waiting target parks durably and the delivery reports waiting, never answered", async () => {
  const gatedTool: GrantedTool = {
    name: "echo_tool",
    description: "Does the gated thing.",
    parameters: z.object({ value: z.string() }),
    ref: "server/echo_tool",
    execute: async () => {
      throw new HeadlessToolSuspension(
        "This action is waiting for your approval.",
        { kind: "approval", approvalId: "approval-me11" },
      );
    },
  };
  const askThenAnswer = () => {
    let call = 0;
    return () => {
      call += 1;
      return call === 1
        ? sse([
            {
              toolCall: {
                id: "call_me11_1",
                name: "echo_tool",
                args: '{"value":"gate"}',
              },
            },
            { finish: "tool_calls" },
            {
              usage: {
                prompt_tokens: 5,
                completion_tokens: 0,
                total_tokens: 5,
              },
            },
          ])
        : sse([
            { content: "the addressed Bot's answer" },
            { finish: "stop" },
            {
              usage: {
                prompt_tokens: 2,
                completion_tokens: 1,
                total_tokens: 3,
              },
            },
          ]);
    };
  };
  const hop = buildDelivery({
    fetchFor: askThenAnswer(),
    granted: [gatedTool],
  });
  const work = forwardWork();
  const hopKey = `hop:me11-wait-${randomUUID().slice(0, 8)}`;
  await offerHop(hopKey, work);
  let error: Error | undefined;
  try {
    await deliver(hop, work, hopKey);
  } catch (cause) {
    error = cause as Error;
  }
  expect(error).toBeInstanceOf(HandoffTargetWaitingError);
  expect(error?.message).toContain("waiting");
  // The run is parked on real rows: waiting_approval, and the second dial
  // never happened.
  const intentKey = governedFiringIntentKey(`handoff:${hopKey}`, hopKey);
  const runRow = await runRowFor(intentKey);
  expect(runRow?.status).toBe("waiting_approval");
  expect(hop.dialCount()).toBe(1);
  // Nothing was relayed as an answer: the produced answer does not exist.
  const row = await hopRow(hopKey);
  const scratchThreadId = (row?.payload as { scratchThreadId?: string })
    ?.scratchThreadId;
  expect(scratchThreadId).toBeTruthy();
  const messages = await historyFor(scopeA, scratchThreadId!);
  expect(
    messages.some(
      (item) => item.role === "assistant" && String(item.content).length > 0,
    ),
  ).toBe(false);
}, 180_000);

test("AC6: the scratch conversation is principal-scoped — the other company reads nothing", async () => {
  const hop = buildDelivery({ fetchFor: ANSWER_TURN });
  const work = forwardWork();
  const hopKey = `hop:me11-read-${randomUUID().slice(0, 8)}`;
  await offerHop(hopKey, work);
  await deliver(hop, work, hopKey);
  const row = await hopRow(hopKey);
  const scratchThreadId = (row?.payload as { scratchThreadId?: string })
    ?.scratchThreadId;
  expect(scratchThreadId).toBeTruthy();
  // The owner reads the result through their own scope.
  const own = await historyFor(scopeA, scratchThreadId!);
  expect(own.length).toBeGreaterThan(0);
  // A principal from the OTHER company cannot read it: the conversation is
  // not theirs, whatever the thread id they hold.
  let denied = false;
  try {
    await historyFor(scopeB, scratchThreadId!);
  } catch {
    denied = true;
  }
  expect(denied).toBe(true);
  // And the other company's own conversation is untouched by any of this.
  const otherMessages = await historyFor(scopeB, threadB);
  expect(
    otherMessages.some((item) => item.content === "the addressed Bot's answer"),
  ).toBe(false);
}, 180_000);

test("AC1/AC2/AC6: the desk's refusals bind unchanged — depth, revoked grant, deleted target, private share", async () => {
  const ASKER = `me11-desk-asker-${suffix}`;
  const TARGET = `me11-desk-target-${suffix}`;
  for (const [id, name] of [
    [ASKER, "Desk Asker"],
    [TARGET, "Desk Target"],
  ] as const) {
    await admin
      .insert(agents)
      .values({ id, name, type: "built_in", configuration: {} })
      .onConflictDoNothing();
    await admin
      .insert(agentProfiles)
      .values({
        agentId: id,
        name,
        title: "",
        roleDescription: "",
        avatarSeed: id,
        visibility: "public",
      })
      .onConflictDoNothing();
  }
  const profiles = createAgentProfileStore(admin);
  const desk = createHandoffDesk({
    queue,
    profiles,
    actorFor: async (id: string) => ({ id, role: "user" as const }),
    mayAddress: async (fromBotId, toBotId) => {
      const rows = await admin
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .where(eq(pluginGrants.agentId, fromBotId));
      return rows.some((row) => row.ref === toBotId);
    },
    auditStore: createAuditStore(admin),
    caps: { maxDepth: 2, maxPerRun: 3 },
  });
  const from = (depth: number): RunAssertion => ({
    botId: ASKER,
    actorId: ownerActor,
    runId: `run-desk-${randomUUID().slice(0, 8)}`,
    threadId: threadA,
    depth,
  });
  const hopsFor = async (botId: string) =>
    (
      await admin
        .select({ payload: workItems.payload })
        .from(workItems)
        .where(
          sql`${workItems.kind} = ${HANDOFF_KIND} and ${workItems.payload}->>'fromBotId' = ${botId}`,
        )
    ).length;

  // Depth cap: a chain at the deployment's depth is refused as a sentence,
  // and nothing is queued — Mastra's own sub-agent rules replace nothing.
  const atCap = await desk.send({
    from: from(2),
    target: "Desk Target",
    envelope: { task: "go deeper" },
  });
  expect(atCap.ok).toBe(false);
  if (!atCap.ok) expect(atCap.refusal).toContain("deep");
  expect(await hopsFor(ASKER)).toBe(0);

  // A deleted target is refused by name — the roster the asking person may
  // see is the authority, and a deleted Bot is not on it.
  await admin
    .insert(pluginGrants)
    .values({ kind: "bot", ref: TARGET, agentId: ASKER, grantedBy: "test" })
    .onConflictDoNothing();
  await admin
    .update(agentProfiles)
    .set({ deletedAt: new Date() })
    .where(eq(agentProfiles.agentId, TARGET));
  const deleted = await desk.send({
    from: from(0),
    target: "Desk Target",
    envelope: { task: "hello" },
  });
  expect(deleted.ok).toBe(false);
  if (!deleted.ok) expect(deleted.refusal).toContain("no Bot called");
  await admin
    .update(agentProfiles)
    .set({ deletedAt: null })
    .where(eq(agentProfiles.agentId, TARGET));

  // A revoked grant is refused at the next hop, read per hop and never held.
  const granted = await desk.send({
    from: from(1),
    target: "Desk Target",
    envelope: { task: "first hop" },
  });
  expect(granted).toMatchObject({ ok: true, to: TARGET });
  await admin.delete(pluginGrants).where(eq(pluginGrants.agentId, ASKER));
  const revoked = await desk.send({
    from: from(1),
    target: "Desk Target",
    envelope: { task: "second hop, different task" },
  });
  expect(revoked.ok).toBe(false);
  if (!revoked.ok) expect(revoked.refusal).toContain("not been given");

  // A handoff to ANOTHER person's Bot carries the owner's private work to
  // them, so the private-share check holds the send: the REAL check over the
  // real approvals store, with no rule and no continuation, denies — and
  // nothing is queued while it waits or after a no.
  const gate = {
    check: createPrivateShareCheck({ approvals: createApprovalStore(admin) }),
    audienceFor: async () => ({
      kind: "handoff" as const,
      id: otherActor,
      recipientUserIds: [otherActor],
      label: "Desk Target",
    }),
  };
  const tool = handoffTool({
    desk,
    from: from(1),
    hasSomebodyToAsk: true,
    maxDepth: 2,
    maxPerRun: 3,
    privateShare: gate,
  });
  expect(tool).not.toBeNull();
  const held = await tool!.execute({
    bot: "Desk Target",
    task: "the owner's private numbers",
  });
  expect(held).toContain("was not sent");
  expect(await hopsFor(ASKER)).toBe(1);
}, 180_000);
