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
import { enterpriseRuns } from "../../src/db/schema/enterprise-runs";
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
import { createScopeResolver } from "../../src/enterprise/tenancy/store";
import { resumeMastraContinuation } from "../../src/mastra/approvals";
import { createMastraContinuationStore } from "../../src/mastra/continuation-store";
import { tenantStorageKey } from "../../src/mastra/contracts";
import { createMastraConversationRuntime } from "../../src/mastra/conversation-runtime";
import type {
  ClaimedContinuation,
  ResumeDecision,
} from "../../src/mastra/execution-contracts";
import {
  assertResumeBindingCurrent,
  createGenerationCurrentGate,
  createGovernedTurnRunner,
  GOVERNED_HEADLESS_REFUSALS,
  GovernedHeadlessRefusal,
  governedFiringIntentKey,
  settleResumedRun,
} from "../../src/mastra/headless";
import { createMastraResumeDriver } from "../../src/mastra/resume-driver";
import { createTenantMastraStorage } from "../../src/mastra/tenant-storage";
import { argsDigestFor, createMastraTools } from "../../src/mastra/tools";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { createMe03Fixture, type Me03Fixture } from "../support/me03-fixture";

/*
 * ME10 (#482) enterprise suite: the background entries on the shared
 * governed turn, against a REAL disposable database — the me03-style fixture
 * (control plane + per-tenant mastra storage in ONE database, dropped in
 * teardown). What only real rows can prove:
 *
 *   1. F4 — the durable approval parking, END TO END on the governed turn:
 *      an approval wait raised inside a granted execute parks the ENGINE,
 *      the ME05 ledger row is saved against THIS run's binding BEFORE the
 *      waiting state publishes, the run settles waiting_approval with its
 *      lease released — and the person's later decision resumes THE EXACT
 *      parked continuation through the six-gate orchestrator + the
 *      run-lease re-activation, the tool executes once in-engine, and the
 *      run settles succeeded with confirmed usage.
 *   2. AC6 — a delivery-shaped redelivery converges on the SAME advance
 *      intent on real rows: one run row, one budget reservation, no second
 *      dial, the duplicate named.
 *   3. F6 — a suspension past its reactivation window is disposed exactly
 *      once (named failure), while a suspension still inside the window
 *      stays waiting.
 */

const SECRET =
  "test-only-model-capability-secret-000000000000000000000000000000";
const CEILING = 1024;
const ROUTE: ModelRouteSnapshotInput = {
  agentId: "me10-bot",
  route: {
    model: { provider: "openai", defaultModel: "me01-model" },
    credentialSecretRef: "cred-1",
  },
  nativeBaseUrl: "https://provider.example/v1",
};

const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
const tenantA = `me10-tenant-a-${suffix}`;
const workspaceA = `me10-workspace-a-${suffix}`;
const ownerActor = `me10-actor-owner-${suffix}`;
const ownerPrincipal = `me10-principal-owner-${suffix}`;

let fixture: Me03Fixture;
let admin: Database;
let data: Awaited<ReturnType<Me03Fixture["openData"]>>;
let directory: Awaited<ReturnType<Me03Fixture["openDirectory"]>>;
let storage: ReturnType<typeof createTenantMastraStorage>;
let service: ReturnType<typeof createConversationService>;
let runs: ReturnType<typeof createRunService>;
let continuationStore: ReturnType<typeof createMastraContinuationStore>;
let scope: PlatformScope;
let threadId: string;
let admittedRoute: ReturnType<typeof canonicalizeModelRouteSnapshot>;
let expertVersions: ExpertVersionCatalog;

/** OpenAI SSE response built from raw chat-completion chunks. */
const sse = (
  parts: {
    toolCall?: { id: string; name: string; args: string };
    content?: string;
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

/** Dial 1 asks for the gated call; dial 2 answers after the tool result. */
const ASK_THEN_ANSWER = () => {
  let call = 0;
  return () => {
    call += 1;
    return call === 1
      ? sse([
          {
            toolCall: {
              id: "call_me10_1",
              name: "echo_tool",
              args: '{"value":"hi"}',
            },
          },
          { finish: "tool_calls" },
          {
            usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
          },
        ])
      : sse([
          { content: "continued after the decision" },
          { finish: "stop" },
          {
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          },
        ]);
  };
};

const TEXT_TURN = () =>
  sse([
    { content: "the delivery answer" },
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

/** The tenant-restricted engine storage for one binding (the resume's snapshot home). */
async function storageForBinding(binding: { threadId?: string | null }) {
  if (!binding.threadId) return undefined;
  const mastraBinding = await service.resolveMastraBinding(
    scope,
    binding.threadId,
  );
  return storage.getStore(scope, mastraBinding);
}

interface RunnerFixture {
  runner: ReturnType<typeof createGovernedTurnRunner>;
  dialCount: () => number;
  savedRefs: { continuationId: string; revision: number }[];
}

async function buildRunner(options: {
  threadId: string;
  fetchFor: () => Promise<Response>;
  granted?: GrantedTool[];
}): Promise<RunnerFixture> {
  let dials = 0;
  const savedRefs: { continuationId: string; revision: number }[] = [];
  const runner = createGovernedTurnRunner({
    // The record adapter semantics are the unit suite's; here it stands in
    // for the entry's own durable row, pinned to the test's thread.
    schedulingRecordFor: async () => ({
      agentId: "me10-bot",
      threadId: options.threadId,
      instruction: "the unframed entry instruction",
      enabled: true,
      frame: "none",
    }),
    scopeFor: async ({ ownerUserId }) => {
      const request = new Request("https://me10.invalid/firing");
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
        agentId: "me10-bot",
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
          return options.fetchFor();
        }) as never,
      }),
    surfaceFor: async (input) => ({
      instructions: ["You are the entry Bot."],
      tools: options.granted ?? [],
      continuations: {
        // The engine snapshot's durable home: the resume stack reads the
        // SAME storage the park wrote (the cross-stack F4 premise).
        storage: await storageForBinding(input.binding),
        durableToolNames: [],
        onSuspension: async (fact) => {
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
            fact.operationId,
          );
          savedRefs.push(ref);
        },
      },
    }),
    runtime: createMastraConversationRuntime({
      conversations: service,
      storage,
      authorizeAttachment: async () => true,
    }),
    leaseRenewMs: 60_000,
  });
  return { runner, dialCount: () => dials, savedRefs };
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
    name: "ME10 entry owner",
  });
  await admin
    .insert(enterprisePrincipals)
    .values({ id: ownerPrincipal, userId: ownerActor });
  const operator = await fixture.openOperator();
  const { provisionDeployment } = await import(
    "../../src/enterprise/tenancy/provision"
  );
  await provisionDeployment(operator, {
    operationId: `me10-${suffix}`,
    operator: ownerPrincipal,
    tenant: { id: tenantA, name: "ME10 tenant A" },
    workspace: { id: workspaceA, name: "ME10 workspace A" },
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

  const probe = new Request("https://me10.invalid/probe");
  scheduleIdentities.set(probe, ownerActor);
  scope = await selectingResolver().resolve(probe);
  const conversation = await service.getOrCreate(scope, {
    title: "ME10 entry conversation",
  });
  expect(conversation.storage_backend).toBe("mastra");
  threadId = conversation.thread_id;

  const resolved = await scheduleResolverFor().resolveForThread(
    probe,
    threadId,
  );
  expect(resolved.principalId).toBe(scope.principalId);

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
  continuationStore = createMastraContinuationStore({
    database: admin,
    secret: "me10-integration-secret",
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
    throw new AggregateError(errors, "ME10 fixture teardown failed");
  }
});

test("F4: an approval wait parks durably and the decision resumes the exact continuation", async () => {
  // The gated granted call: execute #1 raises the approvals gate's wait
  // (nothing has executed); the resumed run's execute #2 does the thing.
  let executes = 0;
  const askTool: GrantedTool = {
    name: "echo_tool",
    description: "Does the gated thing.",
    parameters: z.object({ value: z.string() }),
    ref: "server/echo_tool",
    execute: async () => {
      executes += 1;
      if (executes === 1) {
        throw new HeadlessToolSuspension(
          "This action is waiting for your approval.",
          { kind: "approval", approvalId: "approval-it-1" },
        );
      }
      return "did the thing";
    },
  };

  const parked = await buildRunner({
    threadId,
    fetchFor: ASK_THEN_ANSWER(),
    granted: [askTool],
  });
  const firingId = "approval-firing-1";
  const intentKey = governedFiringIntentKey("entry_approval", firingId);
  let suspension: HeadlessToolSuspension | undefined;
  try {
    await parked.runner({
      ownerUserId: ownerActor,
      routineId: "entry_approval",
      agentId: "me10-bot",
      threadId,
      instruction: "the unframed entry instruction",
      runId: firingId,
    });
  } catch (error) {
    if (error instanceof HeadlessToolSuspension) suspension = error;
  }
  // The turn is terminal-less: a waiting outcome, never a success.
  expect(suspension).toBeDefined();
  expect(suspension?.waiting.kind).toBe("approval");

  // The run parked waiting_approval on REAL rows, and the ME05 ledger holds
  // the exact continuation saved against THIS run's binding.
  const runRow = await runRowFor(intentKey);
  expect(runRow?.status).toBe("waiting_approval");
  expect(parked.savedRefs).toHaveLength(1);
  const savedRef = parked.savedRefs[0]!;
  const record = await continuationStore.getContinuation(
    scope,
    savedRef.continuationId,
  );
  expect(record?.status).toBe("waiting");
  expect(record?.payload).toMatchObject({
    kind: "approval",
    toolCallId: "call_me10_1",
    toolName: "echo_tool",
    argsDigest: argsDigestFor({ value: "hi" }),
  });
  expect(record?.binding.runId).toBe(runRow!.id);
  // Nothing executed: no external effect, no answer persisted.
  expect(executes).toBe(1);
  const pageBefore = await service.history(scope, {
    threadId,
    beforeSeq: null,
    limit: 50,
  });
  expect(pageBefore.items.some((item) => item.role === "assistant")).toBe(
    false,
  );

  // THE RESUME. The governed resume driver, assembled the way production
  // assembles it (index.ts): re-activate the run's lease, re-bind the
  // resumed loop to the run's OWN route and ceiling, drive, settle under
  // the SAME lease.
  const reactivated = await runs.reactivateSuspensionLease(scope, runRow!.id);
  assertResumeBindingCurrent(reactivated, record!.binding);
  let lease = reactivated.lease;
  // The settlement gate's carrier is the DRIVE's OWN carrier, surfaced the
  // way the production wrapper surfaces it (fix-round-1): the drive dials
  // through it and `settleResumedRun` answers to that same usage ledger.
  // Drive through the REAL orchestrator (resumeMastraContinuation): the
  // six gates (identity, generation, fingerprint, decision/argument
  // compatibility, grant), the CAS claim, the receipt ordering, and the
  // engine resume against the stored snapshot.
  const decision: ResumeDecision = {
    kind: "approved",
    approvalId: "approval-it-1",
    argsDigest: record!.payload.argsDigest,
  };
  let driveCarrier: ReturnType<typeof createGovernedModelExecution> | null =
    null;
  // ONE shared upstream script for the whole resumed drive: the resume
  // replays the parked step from the snapshot (the tool re-executes from
  // the decision), so the FIRST resumed dial is the post-tool answer.
  const resumedUpstream = () =>
    sse([
      { content: "continued after the decision" },
      { finish: "stop" },
      { usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    ]);
  const inner = createMastraResumeDriver({
    storageFor: (binding) => storageForBinding(binding),
    loopFor: (claim: ClaimedContinuation) => {
      const loopCarrier = createGovernedModelExecution({
        // The CALLER'S trusted scope — the re-derived binding scope is not a
        // runs-service authority (the ME10 driver-scope fix in production).
        scope,
        agentId: claim.binding.botId,
        routeRef: reactivated.modelRouteRef,
        ceiling: reactivated.maximumTokens,
        // ME10: the ledger starts where the park left off.
        alreadySettledTokens: reactivated.settledTokens,
        runs,
        catalog: {
          get: async (_s, ref) =>
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
        fetch: resumedUpstream as never,
      });
      loopCarrier.bind({
        runId: claim.binding.runId,
        attemptId: claim.binding.attemptId,
        generation: claim.binding.generation,
      });
      // The production wrapper's surface-back: the drive's own carrier is
      // what the settlement gate answers to.
      driveCarrier = loopCarrier;
      const tools = createMastraTools(
        [
          {
            name: "echo_tool",
            description: "Does the gated thing.",
            parameters: z.object({ value: z.string() }),
            ref: "server/echo_tool",
            execute: async () => {
              executes += 1;
              return "did the thing";
            },
          },
        ],
        {
          approvalBinding: {
            runId: claim.binding.runId,
            threadId: claim.binding.threadId ?? "",
          },
          leaseCurrent: async () => {
            try {
              // The CALLER'S trusted scope: the re-derived binding scope is
              // not a runs-service authority (ME10's driver-scope fix).
              lease = await runs.renewRequestLease(scope, lease);
              return true;
            } catch (error) {
              console.error(
                "RENEW FAILED:",
                (error as Error).name,
                (error as Error).message,
              );
              return false;
            }
          },
        },
      );
      return {
        model: loopCarrier.governedModel.model,
        // ME10: the run's OWN admitted ceiling rides every resumed dial.
        maxOutputTokens: reactivated.maximumTokens,
        tools,
        instructions: ["You are the entry Bot."],
        maxSteps: 8,
      };
    },
  });
  const driven = await resumeMastraContinuation(
    {
      store: continuationStore,
      // The re-verification gates, wired exactly the way production wires
      // them (index.ts): the composed generation gate over the REAL runs
      // service; the grant gate answers from this suite's own grant (the
      // plugin ledger is not part of this fixture).
      generationCurrent: createGenerationCurrentGate(runs),
      toolGrantCurrent: async () => true,
      driver: inner,
    },
    {
      scope,
      ref: record!.ref,
      decision,
    },
  );
  // The orchestrator's result kind IS the drive outcome (resumed /
  // declined / re_suspended / reused_receipt / pending_unknown).
  const outcome = typeof driven === "string" ? driven : driven.kind;
  expect(outcome).toBe("resumed");

  // The settlement gate: the resumed drive's usage settles the run
  // SUCCEEDED under the re-activated lease — the same gate the headless
  // turn's finish path applies.
  await settleResumedRun(runs, {
    scope,
    lease,
    carrier: driveCarrier,
    outcome: "resumed",
  });
  const settledRow = await admin
    .select({ status: enterpriseRuns.status })
    .from(enterpriseRuns)
    .where(eq(enterpriseRuns.id, runRow!.id))
    .limit(1);
  expect(settledRow[0]?.status).toBe("succeeded");
  // The approved call executed exactly once, IN the resumed engine.
  expect(executes).toBe(2);
  // Visible results: the drive's produced answer rides the ENTRY callback
  // (the approvals request's saved result, the channel activity and the
  // delivery notification the approval sweep drives). The conversation-store
  // write-back for the RESUMED segment is a declared boundary of this
  // ticket (the resume driver returns produced facts, not a message
  // stream; the park turn's own messages are persisted as before) — see the
  // ME10 report's boundary register.
  void service;
}, 120_000);

test("AC6: a delivery-shaped redelivery converges on the same advance intent", async () => {
  const deliveryRunner = await buildRunner({
    threadId,
    fetchFor: TEXT_TURN,
  });
  const inboxId = `inbox-${randomUUID().slice(0, 8)}`;
  const intentKey = governedFiringIntentKey(`delivery:${inboxId}`, inboxId);
  const first = await deliveryRunner.runner({
    ownerUserId: ownerActor,
    routineId: `delivery:${inboxId}`,
    agentId: "me10-bot",
    threadId,
    instruction: "the person's own message",
    runId: inboxId,
  });
  expect(first.replyText).toBe("the delivery answer");

  // The redelivery: same inbox identity, the runs service refuses, and the
  // refusal is the named convergence.
  const redelivery = await buildRunner({
    threadId,
    fetchFor: TEXT_TURN,
  });
  let refusal: GovernedHeadlessRefusal | undefined;
  try {
    await redelivery.runner({
      ownerUserId: ownerActor,
      routineId: `delivery:${inboxId}`,
      agentId: "me10-bot",
      threadId,
      instruction: "the person's own message",
      runId: inboxId,
    });
  } catch (error) {
    if (error instanceof GovernedHeadlessRefusal) refusal = error;
  }
  expect(refusal?.code).toBe(GOVERNED_HEADLESS_REFUSALS.intentAlreadyAdvanced);
  expect(redelivery.dialCount()).toBe(0);

  // Real rows: ONE run, ONE budget reservation, and the unframed message.
  const runRows = await admin
    .select({ id: enterpriseRuns.id, status: enterpriseRuns.status })
    .from(enterpriseRuns)
    .where(eq(enterpriseRuns.clientMessageKey, intentKey));
  expect(runRows).toHaveLength(1);
  expect(runRows[0]!.status).toBe("succeeded");
  const page = await service.history(scope, {
    threadId,
    beforeSeq: null,
    limit: 50,
  });
  // The appended message is the RECORD's instruction (the record is the
  // authority; the caller's copy is a claim): the production delivery
  // adapter returns the inbox row's own text, unframed.
  expect(
    page.items.some(
      (item) =>
        item.role === "user" &&
        item.content === "the unframed entry instruction",
    ),
  ).toBe(true);
}, 120_000);

test("F6: a suspension past its window is disposed once; a live one stays waiting", async () => {
  // One active run per thread — each parked run gets its own conversation.
  const parkRun = async (label: string) => {
    const conversation = await service.getOrCreate(scope, {
      title: `ME10 f6 ${label}`,
    });
    const f6ThreadId = conversation.thread_id;
    const expertRef = await expertVersions.putOrGet(scope, {
      schemaVersion: 1,
      agentId: "me10-bot",
      source: "tenant_package",
      agentType: "built_in",
      systemPrompt: "the f6 park bot",
      behaviorVersion: "openbot-entry-f6-v1",
    });
    // The submitted-intent message first (the same single-writer order the
    // governed turn runs): the admission verifies it as the newest user row.
    const intentKey = governedFiringIntentKey("entry_f6", label);
    const content = `the f6 park ${label}`;
    await service.append(scope, {
      threadId: f6ThreadId,
      clientMessageKey: intentKey,
      content,
      attachments: [],
    });
    const started = await runs.start(scope, {
      input: {
        threadId: f6ThreadId,
        clientMessageKey: intentKey,
        messageDigest: messageDigest(content, []).digest,
        attachmentRefs: [],
        entrypoint: "schedule",
        forwardedProps: { maxOutputTokens: CEILING },
      },
      agentId: "me10-bot",
      expertVersionRef: expertRef,
      routeRef: admittedRoute.routeRef,
    });
    const lease = await runs.acquireRequestLease(scope, started.run_id);
    const marked = await runs.markRunSuspended(scope, {
      lease,
      status: "waiting_approval",
    });
    expect(marked).toBe(true);
    await runs.releaseRequestLease(scope, lease);
    return started.run_id;
  };
  const deadRun = await parkRun(`dead-${randomUUID().slice(0, 8)}`);
  const liveRun = await parkRun(`live-${randomUUID().slice(0, 8)}`);
  await admin
    .update(enterpriseRuns)
    .set({ createdAt: new Date(Date.now() - 20 * 60_000) })
    .where(eq(enterpriseRuns.id, deadRun));

  const disposed = await runs.disposeUnresumableSuspensions(scope);
  expect(disposed).toBeGreaterThanOrEqual(1);

  const [deadRow] = await admin
    .select({
      status: enterpriseRuns.status,
      errorCode: enterpriseRuns.errorCode,
    })
    .from(enterpriseRuns)
    .where(eq(enterpriseRuns.id, deadRun))
    .limit(1);
  expect(deadRow?.status).toBe("failed");
  expect(deadRow?.errorCode).toBe("SUSPENSION_WINDOW_EXPIRED");
  const [liveRow] = await admin
    .select({ status: enterpriseRuns.status })
    .from(enterpriseRuns)
    .where(eq(enterpriseRuns.id, liveRun))
    .limit(1);
  expect(liveRow?.status).toBe("waiting_approval");

  // Dispose-once: the already-settled dead run is not re-counted.
  const again = await runs.disposeUnresumableSuspensions(scope);
  expect(again).toBe(0);
}, 120_000);
