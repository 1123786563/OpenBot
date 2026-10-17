import { afterAll, beforeAll, expect, test } from "../../../tests/support/e2e-compat";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../src/db/client";
import {
  enterpriseConversations,
  enterpriseMemberships,
  enterpriseModelBudgetReservations,
  enterpriseModelInvocationCapabilities,
  enterprisePrincipals,
  enterpriseRunAttempts,
  enterpriseRunOutbox,
  enterpriseRuns,
  enterpriseSecurityEvents,
  enterpriseTenants,
  enterpriseWorkspaces,
  users,
} from "../../src/db/schema";
import type {
  PlatformScope,
  StartRunInput,
  TrustedRunAdmission,
} from "../../src/enterprise/contracts";
import { createConversationService } from "../../src/enterprise/conversations/service";
import { createConversationStore } from "../../src/enterprise/conversations/store";
import { ExpertVersionCatalog } from "../../src/enterprise/experts/version-catalog";
import {
  createModelBudgetService,
  reserveModelBudgetInTransaction,
  runCeilingIdempotencyKey,
} from "../../src/enterprise/models/budget";
import { createModelInvocationCapabilityService } from "../../src/enterprise/runs/model-capability";
import { createRunOutbox } from "../../src/enterprise/runs/outbox";
import { createRunService } from "../../src/enterprise/runs/service";
import { createRunStore } from "../../src/enterprise/runs/store";
import type {
  DataDatabase,
  DirectoryDatabase,
  OperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import { provisionDeployment } from "../../src/enterprise/tenancy/provision";
import {
  type AuthenticatedRequestIdentity,
  createScopeResolver,
} from "../../src/enterprise/tenancy/store";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

const prefix = `runs-t04-${randomUUID()}`;
const actorId = `${prefix}-actor`;
const principalId = `${prefix}-principal`;
const tenantId = `${prefix}-tenant`;
const workspaceId = `${prefix}-workspace`;
let setupDatabase: Database | undefined;
let directoryDatabase: DirectoryDatabase | undefined;
let dataDatabase: DataDatabase | undefined;
let operatorDatabase: OperatorDatabase | undefined;
let scope: PlatformScope;
let threadId: string;
let conversations: ReturnType<typeof createConversationService>;
let runs: ReturnType<typeof createRunService>;
let runStore: ReturnType<typeof createRunStore>;

function setupDb() {
  setupDatabase ??= createDatabase(enterpriseTestDatabaseUrlFrom(), { max: 4 });
  return setupDatabase;
}

function openRuntimeDatabase(role: "directory"): Promise<DirectoryDatabase>;
function openRuntimeDatabase(role: "data"): Promise<DataDatabase>;
function openRuntimeDatabase(role: "operator"): Promise<OperatorDatabase>;
async function openRuntimeDatabase(role: "directory" | "data" | "operator") {
  const url = enterpriseRuntimeDatabaseUrlFrom(role);
  const database = createDatabase(url, { max: 3 });
  try {
    if (role === "directory") return await verifyDirectoryDatabase(database);
    if (role === "data") return await verifyDataDatabase(database);
    return await verifyOperatorDatabase(database);
  } catch (error) {
    await database.$client.close();
    throw error;
  }
}

beforeAll(async () => {
  const setup = setupDb();
  const directory = await openRuntimeDatabase("directory");
  const data = await openRuntimeDatabase("data");
  const operator = await openRuntimeDatabase("operator");
  directoryDatabase = directory;
  dataDatabase = data;
  operatorDatabase = operator;
  await setup.insert(users).values({
    id: actorId,
    email: `${actorId}@example.invalid`,
    name: "Synthetic run actor",
  });
  await setup
    .insert(enterprisePrincipals)
    .values({ id: principalId, userId: actorId });
  await provisionDeployment(operator, {
    operationId: `${prefix}-provision`,
    operator: principalId,
    tenant: { id: tenantId, name: "Synthetic run tenant" },
    workspace: { id: workspaceId, name: "Synthetic run workspace" },
    members: [{ principalId, userId: actorId, role: "tenant_admin" }],
    resources: [],
  });

  const authenticated = new WeakMap<Request, AuthenticatedRequestIdentity>();
  const resolver = createScopeResolver(directory, {
    authenticate: async (request) => authenticated.get(request) ?? null,
    selectTenant: () => tenantId,
    selectWorkspace: () => workspaceId,
  });
  const request = new Request("https://enterprise.example.invalid/runs");
  authenticated.set(request, { actorId, entrypoint: "web" });
  scope = await resolver.resolve(request);

  conversations = createConversationService({ data });
  threadId = randomUUID();
  await seedPlatformConversation(threadId);
  const conversation = await conversations.getOrCreate(scope, { threadId });
  threadId = conversation.thread_id;
  await conversations.append(scope, {
    threadId,
    clientMessageKey: `${prefix}-client-message`,
    content: "synthetic run input",
    attachments: [],
  });
  const expertVersions = new ExpertVersionCatalog(data);
  syntheticExpertVersionRef = await expertVersions.putOrGet(scope, {
    schemaVersion: 1,
    agentId: syntheticExpertAgentId,
    source: "user_profile",
    agentType: "built_in",
    systemPrompt: "Synthetic run admission expert.",
    behaviorVersion: "openbot-builtin-v1",
  });
  runs = createRunService({
    data,
    conversations,
    expertVersions,
    modelRouteFor: async () => ({
      routeRef: syntheticRouteRef,
      maximumTokens: 1000,
    }),
    configuredBudgetTokens: () => 2000,
    modelCapabilitySecret:
      "test-only-model-capability-secret-000000000000000000000000000000",
  });
  runStore = createRunStore(data);
});

async function createRunInput(label: string, maximumTokens = 2000) {
  const runThreadId = randomUUID();
  await seedPlatformConversation(runThreadId);
  const conversation = await conversations.getOrCreate(scope, {
    threadId: runThreadId,
  });
  const clientMessageKey = `${prefix}-${label}-message`;
  await conversations.append(scope, {
    threadId: conversation.thread_id,
    clientMessageKey,
    content: `synthetic run input ${label}`,
    attachments: [],
  });
  return {
    threadId: conversation.thread_id,
    clientMessageKey,
    attachmentRefs: [],
    entrypoint: "web" as const,
    forwardedProps: { maxOutputTokens: maximumTokens },
  };
}

const syntheticExpertAgentId = "synthetic-run-bot";
const syntheticRouteRef = "synthetic-model-route";
let syntheticExpertVersionRef: TrustedRunAdmission["expertVersionRef"];
const admit = (input: StartRunInput): TrustedRunAdmission => ({
  input,
  agentId: syntheticExpertAgentId,
  expertVersionRef: syntheticExpertVersionRef,
  routeRef: syntheticRouteRef,
});
async function admittedRunInput(
  label: string,
  maximumTokens = 2000,
): Promise<TrustedRunAdmission> {
  return admit(await createRunInput(label, maximumTokens));
}

async function seedPlatformConversation(seedThreadId: string) {
  const [seededConversation] = await createConversationStore(
    dataDatabase!,
  ).transaction(scope, (tx) =>
    tx
      .insert(enterpriseConversations)
      .values({
        tenantId,
        workspaceId,
        principalId,
        threadId: seedThreadId,
        storageBackend: "platform",
        backendVersion: 1,
        lastSeq: 0,
      })
      .returning(),
  );
  if (!seededConversation) throw new Error("RUN_PLATFORM_FIXTURE_SEED_FAILED");
}

afterAll(async () => {
  const failures: unknown[] = [];
  try {
    if (setupDatabase) {
      await setupDatabase
        .delete(enterpriseSecurityEvents)
        .where(like(enterpriseSecurityEvents.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseMemberships)
        .where(like(enterpriseMemberships.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseWorkspaces)
        .where(like(enterpriseWorkspaces.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterprisePrincipals)
        .where(like(enterprisePrincipals.id, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseTenants)
        .where(like(enterpriseTenants.id, `${prefix}%`));
      await setupDatabase.delete(users).where(like(users.id, `${prefix}%`));
    }
  } catch (error) {
    failures.push(error);
  }
  for (const database of [
    operatorDatabase,
    dataDatabase,
    directoryDatabase,
    setupDatabase,
  ]) {
    try {
      await database?.$client.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Run fixture cleanup failed.");
});

test("concurrent_starts_reserve_once_and_fence_old_attempts", async () => {
  const input = {
    threadId,
    clientMessageKey: `${prefix}-client-message`,
    attachmentRefs: [],
    entrypoint: "web" as const,
    forwardedProps: { maxOutputTokens: 2000 },
  };
  const starts = await Promise.allSettled([
    runs.start(scope, admit(input)),
    runs.start(scope, admit(input)),
  ]);
  const accepted = starts.filter((result) => result.status === "fulfilled");
  const rejected = starts.filter((result) => result.status === "rejected");
  expect(accepted).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
    status: 409,
  });

  const run = (
    accepted[0] as PromiseFulfilledResult<
      Awaited<ReturnType<typeof runs.start>>
    >
  ).value;
  expect(
    await runStore.countBudgetReservations(scope, input.clientMessageKey),
  ).toBe(1);
  expect(await runStore.countOutboxEvents(scope, run.run_id, "run.start")).toBe(
    1,
  );
  const originalAttempt = await runStore.currentAttempt(scope, run.run_id);
  const replacementAttempt = await runStore.expireLease(
    scope,
    run.run_id,
    new Date(Date.now() + 60_000),
  );
  expect(replacementAttempt.generation).toBeGreaterThan(
    originalAttempt.generation,
  );
  await expect(
    runStore.transitionTerminal(scope, {
      runId: run.run_id,
      attemptId: originalAttempt.attemptId,
      generation: originalAttempt.generation,
      status: "succeeded",
    }),
  ).resolves.toBe(false);
  await expect(runs.get(scope, run.run_id)).resolves.toMatchObject({
    status: "queued",
  });
  await runs.cancel(scope, { runId: run.run_id, reason: "user_requested" });
  await expect(runs.start(scope, admit(input))).rejects.toMatchObject({
    status: 409,
    code: "RUN_IDEMPOTENCY_CONFLICT",
  });
});

test("active thread lookup returns replacement attempt and fences stale stop", async () => {
  const input = await createRunInput("active-thread-lookup-replacement");
  let runId: string | undefined;
  try {
    const run = await runs.start(scope, admit(input));
    runId = run.run_id;
    const originalAttempt = await runStore.currentAttempt(scope, run.run_id);

    await expect(
      runs.getActiveForThread(scope, input.threadId),
    ).resolves.toMatchObject({
      run: { run_id: run.run_id, thread_id: input.threadId, status: "queued" },
      attemptId: originalAttempt.attemptId,
      generation: originalAttempt.generation,
    });

    await expect(
      runs.getActiveForThread(scope, randomUUID()),
    ).resolves.toBeNull();

    const otherActor = `${prefix}-active-lookup-other-actor`;
    const otherPrincipal = `${prefix}-active-lookup-other-principal`;
    await setupDb()
      .insert(users)
      .values({
        id: otherActor,
        email: `${otherActor}@example.invalid`,
        name: "Synthetic active lookup actor",
      });
    await setupDb()
      .insert(enterprisePrincipals)
      .values({ id: otherPrincipal, userId: otherActor });
    await setupDb().insert(enterpriseMemberships).values({
      tenantId,
      principalId: otherPrincipal,
      role: "member",
    });
    const otherPrincipalScope = await createScopeResolver(directoryDatabase!, {
      authenticate: async () => ({ actorId: otherActor, entrypoint: "web" }),
      selectTenant: () => tenantId,
      selectWorkspace: () => workspaceId,
    }).resolve(new Request("https://enterprise.example.invalid/runs"));
    await expect(
      runs.getActiveForThread(otherPrincipalScope, input.threadId),
    ).resolves.toBeNull();

    const replacementAttempt = await runStore.expireLease(
      scope,
      run.run_id,
      new Date(Date.now() + 60_000),
    );
    await expect(
      runs.getActiveForThread(scope, input.threadId),
    ).resolves.toMatchObject({
      run: { run_id: run.run_id, thread_id: input.threadId, status: "queued" },
      attemptId: replacementAttempt.attemptId,
      generation: replacementAttempt.generation,
    });

    await expect(
      runs.stop(scope, {
        runId: run.run_id,
        attemptId: originalAttempt.attemptId,
        generation: originalAttempt.generation,
        reason: "user_requested",
      }),
    ).rejects.toMatchObject({ code: "RUN_ATTEMPT_STALE" });
    await expect(runs.get(scope, run.run_id)).resolves.toMatchObject({
      status: "queued",
    });

    const expiredAt = new Date(Date.now() - 60_000);
    const expiredAttemptRows = await runStore.transaction(scope, (tx) =>
      tx
        .update(enterpriseRunAttempts)
        .set({ leaseExpiresAt: expiredAt })
        .where(
          and(
            eq(enterpriseRunAttempts.tenantId, scope.tenantId),
            eq(enterpriseRunAttempts.runId, run.run_id),
            eq(enterpriseRunAttempts.id, replacementAttempt.attemptId),
            eq(enterpriseRunAttempts.generation, replacementAttempt.generation),
          ),
        )
        .returning({ id: enterpriseRunAttempts.id }),
    );
    expect(expiredAttemptRows).toHaveLength(1);
    await expect(
      runs.getActiveForThread(scope, input.threadId),
    ).resolves.toBeNull();

    const restoredLeaseAt = new Date(Date.now() + 60_000);
    const restoredAttemptRows = await runStore.transaction(scope, (tx) =>
      tx
        .update(enterpriseRunAttempts)
        .set({ leaseExpiresAt: restoredLeaseAt })
        .where(
          and(
            eq(enterpriseRunAttempts.tenantId, scope.tenantId),
            eq(enterpriseRunAttempts.runId, run.run_id),
            eq(enterpriseRunAttempts.id, replacementAttempt.attemptId),
            eq(enterpriseRunAttempts.generation, replacementAttempt.generation),
          ),
        )
        .returning({ id: enterpriseRunAttempts.id }),
    );
    expect(restoredAttemptRows).toHaveLength(1);
    await expect(
      runs.getActiveForThread(scope, input.threadId),
    ).resolves.toMatchObject({
      run: { run_id: run.run_id, thread_id: input.threadId, status: "queued" },
      attemptId: replacementAttempt.attemptId,
      generation: replacementAttempt.generation,
    });

    const expiredRunRows = await runStore.transaction(scope, (tx) =>
      tx
        .update(enterpriseRuns)
        .set({ leaseExpiresAt: expiredAt })
        .where(
          and(
            eq(enterpriseRuns.tenantId, scope.tenantId),
            eq(enterpriseRuns.id, run.run_id),
            eq(enterpriseRuns.attemptGeneration, replacementAttempt.generation),
            sql`exists (
              select 1
              from ${enterpriseRunAttempts}
              where ${enterpriseRunAttempts.tenantId} = ${scope.tenantId}
                and ${enterpriseRunAttempts.runId} = ${run.run_id}
                and ${enterpriseRunAttempts.id} = ${replacementAttempt.attemptId}
                and ${enterpriseRunAttempts.generation} = ${replacementAttempt.generation}
            )`,
          ),
        )
        .returning({ id: enterpriseRuns.id }),
    );
    expect(expiredRunRows).toHaveLength(1);
    await expect(
      runs.getActiveForThread(scope, input.threadId),
    ).resolves.toBeNull();

    await runs.cancel(scope, {
      runId: run.run_id,
      reason: "user_requested",
    });
    runId = undefined;
    await expect(
      runs.getActiveForThread(scope, input.threadId),
    ).resolves.toBeNull();
  } finally {
    if (runId) {
      await runs.cancel(scope, {
        runId,
        reason: "user_requested",
      });
    }
  }
});

test("run lease access requires exact owner and renewal uses configured duration", async () => {
  const runInput = await createRunInput("lease-owner-duration");
  const run = await runs.start(scope, admit(runInput));
  const originalAttempt = await runStore.currentAttempt(scope, run.run_id);
  const otherPrincipal = `${prefix}-lease-other-principal`;
  const otherActor = `${prefix}-lease-other-actor`;
  const otherWorkspace = `${prefix}-lease-other-workspace`;
  await setupDb()
    .insert(users)
    .values({
      id: otherActor,
      email: `${otherActor}@example.invalid`,
      name: "Synthetic other lease actor",
    });
  await setupDb()
    .insert(enterprisePrincipals)
    .values({ id: otherPrincipal, userId: otherActor });
  await setupDb().insert(enterpriseMemberships).values({
    tenantId,
    principalId: otherPrincipal,
    role: "member",
  });
  await setupDb().insert(enterpriseWorkspaces).values({
    tenantId,
    id: otherWorkspace,
    name: "Synthetic other lease workspace",
  });
  const otherPrincipalScope = await createScopeResolver(directoryDatabase!, {
    authenticate: async () => ({ actorId: otherActor, entrypoint: "web" }),
    selectTenant: () => tenantId,
    selectWorkspace: () => workspaceId,
  }).resolve(new Request("https://enterprise.example.invalid/runs"));
  const otherWorkspaceScope = await createScopeResolver(directoryDatabase!, {
    authenticate: async () => ({ actorId, entrypoint: "web" }),
    selectTenant: () => tenantId,
    selectWorkspace: () => otherWorkspace,
  }).resolve(new Request("https://enterprise.example.invalid/runs"));

  const snapshot = async () => {
    const [storedRun] = await setupDb()
      .select()
      .from(enterpriseRuns)
      .where(eq(enterpriseRuns.id, run.run_id));
    const [storedAttempt] = await setupDb()
      .select()
      .from(enterpriseRunAttempts)
      .where(eq(enterpriseRunAttempts.id, originalAttempt.attemptId));
    return {
      generation: storedRun?.attemptGeneration,
      status: storedRun?.status,
      runLease: storedRun?.leaseExpiresAt?.toISOString(),
      attemptStatus: storedAttempt?.status,
      attemptLease: storedAttempt?.leaseExpiresAt?.toISOString(),
    };
  };

  const before = await snapshot();
  for (const foreignScope of [otherPrincipalScope, otherWorkspaceScope]) {
    await expect(
      runStore.currentAttempt(foreignScope, run.run_id),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      runStore.expireLease(
        foreignScope,
        run.run_id,
        new Date(Date.now() + 60_000),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(before);
  }

  const configuredRuns = createRunService({
    data: dataDatabase!,
    conversations,
    expertVersions: new ExpertVersionCatalog(dataDatabase!),
    modelRouteFor: async () => ({
      routeRef: syntheticRouteRef,
      maximumTokens: 1000,
    }),
    configuredBudgetTokens: () => 2000,
    modelCapabilitySecret:
      "test-only-model-capability-secret-000000000000000000000000000000",
    leaseMilliseconds: 90_000,
  });
  const durationRunInput = await createRunInput("lease-configured-duration");
  const startBefore = Date.now();
  const durationRun = await configuredRuns.start(
    scope,
    admit(durationRunInput),
  );
  const startAfter = Date.now();
  const durationRunRow = await setupDb()
    .select()
    .from(enterpriseRuns)
    .where(eq(enterpriseRuns.id, durationRun.run_id));
  const durationAttempt = await createRunStore(dataDatabase!).currentAttempt(
    scope,
    durationRun.run_id,
  );
  const renewalNow = new Date(Date.now() + 120_000);
  const renewed = await createRunStore(dataDatabase!, {
    leaseMilliseconds: 90_000,
  }).expireLease(scope, durationRun.run_id, renewalNow);
  const renewedRunRow = await setupDb()
    .select()
    .from(enterpriseRuns)
    .where(eq(enterpriseRuns.id, durationRun.run_id));
  expect(durationRunRow[0]?.leaseExpiresAt.getTime()).toBe(
    durationAttempt.leaseExpiresAt.getTime(),
  );
  for (const initialLeaseExpiry of [
    durationRunRow[0]?.leaseExpiresAt.getTime(),
    durationAttempt.leaseExpiresAt.getTime(),
  ]) {
    expect(initialLeaseExpiry).toBeGreaterThanOrEqual(startBefore + 90_000);
    expect(initialLeaseExpiry).toBeLessThanOrEqual(startAfter + 90_000);
  }
  expect(renewed.leaseExpiresAt.getTime()).toBe(renewalNow.getTime() + 90_000);
  expect(renewedRunRow[0]?.leaseExpiresAt.getTime()).toBe(
    renewalNow.getTime() + 90_000,
  );
  await runs.cancel(scope, { runId: run.run_id, reason: "user_requested" });
  await configuredRuns.cancel(scope, {
    runId: durationRun.run_id,
    reason: "user_requested",
  });
});

test("budget reservation is idempotent, rejects changed input, and confirms exact usage", async () => {
  const input = await createRunInput("budget-idempotency");
  const run = await runs.start(scope, admit(input));
  const reservation = await runs.reserveModelBudget(scope, {
    runId: run.run_id,
    modelRouteRef: "synthetic-model-route",
    maximumTokens: 1000,
  });
  const replay = await runs.reserveModelBudget(scope, {
    runId: run.run_id,
    modelRouteRef: "synthetic-model-route",
    maximumTokens: 1000,
  });
  expect(replay).toEqual(reservation);
  const budget = createModelBudgetService({
    data: dataDatabase!,
    configuredLimitTokens: () => 2000,
  });
  await expect(
    runs.reserveModelBudget(scope, {
      runId: run.run_id,
      modelRouteRef: "synthetic-model-route",
      maximumTokens: 999,
    }),
  ).rejects.toMatchObject({ status: 409, code: "BUDGET_IDEMPOTENCY_CONFLICT" });
  await budget.confirm(scope, reservation.reservationId, 1000);
  await expect(
    budget.confirm(scope, reservation.reservationId, 1000),
  ).resolves.toBeUndefined();
  await expect(
    budget.confirm(scope, reservation.reservationId, 1001),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    budget.release(scope, reservation.reservationId),
  ).rejects.toMatchObject({ status: 409 });
  await runs.cancel(scope, { runId: run.run_id, reason: "user_requested" });
});

test("Run creation and capability issue share a canonical configured ceiling", async () => {
  const run = await runs.start(
    scope,
    await admittedRunInput("canonical-ceiling"),
  );
  expect(runCeilingIdempotencyKey(run.run_id)).toBe(
    `run-ceiling:${run.run_id}`,
  );
  const [ceiling] = await dataDatabase!.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
    );
    return tx
      .select({
        idempotencyKey: enterpriseModelBudgetReservations.idempotencyKey,
        tokenLimit: enterpriseModelBudgetReservations.tokenLimit,
      })
      .from(enterpriseModelBudgetReservations)
      .where(
        and(
          eq(enterpriseModelBudgetReservations.tenantId, scope.tenantId),
          eq(enterpriseModelBudgetReservations.runId, run.run_id),
          eq(enterpriseModelBudgetReservations.isRunCeiling, true),
        ),
      );
  });
  expect(ceiling?.idempotencyKey).toBe(runCeilingIdempotencyKey(run.run_id));
  expect(ceiling?.tokenLimit).toBe(2000);
  const [persistedRun] = await dataDatabase!.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
    );
    return tx
      .select({
        modelRouteMaximumTokens: enterpriseRuns.modelRouteMaximumTokens,
      })
      .from(enterpriseRuns)
      .where(
        and(
          eq(enterpriseRuns.tenantId, scope.tenantId),
          eq(enterpriseRuns.id, run.run_id),
        ),
      );
  });
  expect(persistedRun?.modelRouteMaximumTokens).toBe(1000);
  await expect(
    dataDatabase!.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
      );
      return reserveModelBudgetInTransaction(
        tx,
        scope,
        {
          runId: run.run_id,
          modelRouteRef: "synthetic-model-route",
          maximumTokens: 2000,
        },
        {
          runCeiling: true,
          idempotencyKey: `custom:${run.run_id}`,
          configuredLimitTokens: 2000,
        },
      );
    }),
  ).rejects.toMatchObject({
    status: 409,
    code: "RUN_BUDGET_CEILING_KEY_INVALID",
  });
  await expect(
    dataDatabase!.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
      );
      return reserveModelBudgetInTransaction(
        tx,
        scope,
        {
          runId: run.run_id,
          modelRouteRef: "synthetic-model-route",
          maximumTokens: 2001,
        },
        {
          runCeiling: true,
          idempotencyKey: runCeilingIdempotencyKey(run.run_id),
          configuredLimitTokens: 2000,
        },
      );
    }),
  ).rejects.toMatchObject({ status: 400, code: "RUN_BUDGET_LIMIT_EXCEEDED" });
  const attempt = await runStore.currentAttempt(scope, run.run_id);
  await expect(
    runs.issueModelInvocationCapability(scope, {
      runId: run.run_id,
      attemptId: attempt.attemptId,
      generation: attempt.generation,
      modelRequestId: `${prefix}-canonical-ceiling`,
      maximumTokens: 1000,
    }),
  ).resolves.toMatchObject({ maximum_tokens: 1000 });
  await runs.cancel(scope, { runId: run.run_id, reason: "user_requested" });
});

test("budget reservation idempotency and mutations require exact owner scope", async () => {
  const run = await runs.start(
    scope,
    await admittedRunInput("budget-owner-scope"),
  );
  const reservation = await runs.reserveModelBudget(scope, {
    runId: run.run_id,
    modelRouteRef: "synthetic-model-route",
    maximumTokens: 100,
  });
  const otherPrincipal = `${prefix}-other-principal`;
  const otherActor = `${prefix}-other-actor`;
  const otherWorkspace = `${prefix}-other-workspace`;
  await setupDb()
    .insert(users)
    .values({
      id: otherActor,
      email: `${otherActor}@example.invalid`,
      name: "Synthetic other run actor",
    });
  await setupDb()
    .insert(enterprisePrincipals)
    .values({ id: otherPrincipal, userId: otherActor });
  await setupDb().insert(enterpriseMemberships).values({
    tenantId,
    principalId: otherPrincipal,
    role: "member",
  });
  await setupDb().insert(enterpriseWorkspaces).values({
    tenantId,
    id: otherWorkspace,
    name: "Synthetic other workspace",
  });
  const otherScopes = createScopeResolver(directoryDatabase!, {
    authenticate: async () => ({ actorId: otherActor, entrypoint: "web" }),
    selectTenant: () => tenantId,
    selectWorkspace: () => workspaceId,
  });
  const otherPrincipalScope = await otherScopes.resolve(
    new Request("https://enterprise.example.invalid/runs"),
  );
  const otherWorkspaceScopes = createScopeResolver(directoryDatabase!, {
    authenticate: async () => ({ actorId, entrypoint: "web" }),
    selectTenant: () => tenantId,
    selectWorkspace: () => otherWorkspace,
  });
  const otherWorkspaceScope = await otherWorkspaceScopes.resolve(
    new Request("https://enterprise.example.invalid/runs"),
  );

  for (const foreignScope of [otherPrincipalScope, otherWorkspaceScope]) {
    await expect(
      runs.reserveModelBudget(foreignScope, {
        runId: run.run_id,
        modelRouteRef: "synthetic-model-route",
        maximumTokens: 100,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      budgetService().confirm(foreignScope, reservation.reservationId, 1),
    ).rejects.toMatchObject({
      status: 404,
      code: "BUDGET_RESERVATION_NOT_FOUND",
    });
    await expect(
      budgetService().release(foreignScope, reservation.reservationId),
    ).rejects.toMatchObject({
      status: 404,
      code: "BUDGET_RESERVATION_NOT_FOUND",
    });
  }
  const [stored] = await dataDatabase!.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
    );
    return tx
      .select()
      .from(enterpriseModelBudgetReservations)
      .where(
        and(
          eq(enterpriseModelBudgetReservations.tenantId, scope.tenantId),
          eq(enterpriseModelBudgetReservations.id, reservation.reservationId),
        ),
      );
  });
  expect(stored?.status).toBe("reserved");
  await runs.cancel(scope, { runId: run.run_id, reason: "user_requested" });
});

function budgetService() {
  return createModelBudgetService({
    data: dataDatabase!,
    configuredLimitTokens: () => 2000,
  });
}

test("wrong capability service secret rejects without consuming the issued capability", async () => {
  const run = await runs.start(
    scope,
    await admittedRunInput("wrong-capability-secret"),
  );
  const attempt = await runStore.currentAttempt(scope, run.run_id);
  const issued = await runs.issueModelInvocationCapability(scope, {
    runId: run.run_id,
    attemptId: attempt.attemptId,
    generation: attempt.generation,
    modelRequestId: `${prefix}-wrong-secret-request`,
    maximumTokens: 100,
  });
  const wrongSecret = createModelInvocationCapabilityService({
    data: dataDatabase!,
    secret: "different-test-only-model-capability-secret-0000000000000000",
  });

  await expect(
    wrongSecret.resolve(scope, issued.capability),
  ).rejects.toMatchObject({
    status: 401,
    code: "MODEL_CAPABILITY_INVALID",
  });
  await expect(
    runs.resolveModelInvocationCapability(scope, issued.capability),
  ).resolves.toMatchObject({
    runId: run.run_id,
    attemptId: attempt.attemptId,
    generation: attempt.generation,
    modelRequestId: `${prefix}-wrong-secret-request`,
    maximumTokens: 100,
  });
  await expect(
    runs.resolveModelInvocationCapability(scope, issued.capability),
  ).rejects.toMatchObject({ status: 409 });
});

test("model invocation claims enforce an independent cumulative ceiling per run", async () => {
  const first = await runs.start(
    scope,
    await admittedRunInput("invocation-budget-one"),
  );
  const second = await runs.start(
    scope,
    await admittedRunInput("invocation-budget-two"),
  );
  const firstAttempt = await runStore.currentAttempt(scope, first.run_id);

  const issue = (
    runId: string,
    attemptId: string,
    generation: number,
    modelRequestId: string,
    maximumTokens: number,
  ) =>
    runs.issueModelInvocationCapability(scope, {
      runId,
      attemptId,
      generation,
      modelRequestId,
      maximumTokens,
    });

  const initial = await issue(
    first.run_id,
    firstAttempt.attemptId,
    firstAttempt.generation,
    `${prefix}-request-1`,
    1000,
  );
  expect(initial.capability).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  expect(initial.model_request_id).toBe(`${prefix}-request-1`);
  expect(initial.maximum_tokens).toBe(1000);
  await expect(
    runs.confirmModelInvocationUsage(scope, initial.capability, 1),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    runs.resolveModelInvocationCapability(scope, initial.capability),
  ).resolves.toMatchObject({
    tenantId: scope.tenantId,
    runId: first.run_id,
    attemptId: firstAttempt.attemptId,
    generation: firstAttempt.generation,
    modelRouteRef: "synthetic-model-route",
    modelRequestId: `${prefix}-request-1`,
    maximumTokens: 1000,
  });
  await expect(
    runs.resolveModelInvocationCapability(scope, initial.capability),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    runs.releaseModelInvocation(scope, initial.capability),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    runs.resolveModelInvocationCapability(scope, `${initial.capability}x`),
  ).rejects.toMatchObject({ status: 401 });

  const storedCapability = await dataDatabase!.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
    );
    return tx
      .select()
      .from(enterpriseModelInvocationCapabilities)
      .where(
        and(
          eq(enterpriseModelInvocationCapabilities.tenantId, scope.tenantId),
          eq(enterpriseModelInvocationCapabilities.runId, first.run_id),
        ),
      );
  });
  expect(storedCapability).toHaveLength(1);
  expect(storedCapability[0]?.capabilityDigest).toBe(
    createHash("sha256").update(initial.capability).digest("hex"),
  );
  expect(JSON.stringify(storedCapability)).not.toContain(initial.capability);
  expect(JSON.stringify(await runs.get(scope, first.run_id))).not.toContain(
    initial.capability,
  );

  await expect(
    issue(
      first.run_id,
      firstAttempt.attemptId,
      firstAttempt.generation,
      `${prefix}-request-route-over`,
      1001,
    ),
  ).rejects.toMatchObject({ status: 402, code: "MODEL_ROUTE_BUDGET_EXCEEDED" });
  const exactInFlight = await issue(
    first.run_id,
    firstAttempt.attemptId,
    firstAttempt.generation,
    `${prefix}-request-in-flight-exact`,
    1000,
  );
  await expect(
    issue(
      first.run_id,
      firstAttempt.attemptId,
      firstAttempt.generation,
      `${prefix}-request-in-flight-over`,
      1,
    ),
  ).rejects.toMatchObject({ status: 402, code: "MODEL_BUDGET_EXCEEDED" });
  await runs.releaseModelInvocation(scope, exactInFlight.capability);

  const replay = await issue(
    first.run_id,
    firstAttempt.attemptId,
    firstAttempt.generation,
    `${prefix}-request-1`,
    1000,
  );
  expect(replay).toEqual(initial);
  await expect(
    issue(
      first.run_id,
      firstAttempt.attemptId,
      firstAttempt.generation,
      `${prefix}-request-1`,
      999,
    ),
  ).rejects.toMatchObject({ status: 409 });

  await runs.confirmModelInvocationUsage(scope, initial.capability, 1000);
  await expect(
    runs.confirmModelInvocationUsage(scope, initial.capability, 1000),
  ).resolves.toBeUndefined();
  await expect(
    runs.confirmModelInvocationUsage(scope, initial.capability, 999),
  ).rejects.toMatchObject({ status: 409 });
  const secondAttempt = await runStore.currentAttempt(scope, second.run_id);
  const independent = await issue(
    second.run_id,
    secondAttempt.attemptId,
    secondAttempt.generation,
    `${prefix}-request-3`,
    1000,
  );
  expect(independent.maximum_tokens).toBe(1000);
  await expect(
    runs.resolveModelInvocationCapability(scope, independent.capability),
  ).resolves.toMatchObject({ modelRequestId: `${prefix}-request-3` });
  await expect(
    runs.resolveModelInvocationCapability(scope, independent.capability),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    runs.releaseModelInvocation(scope, independent.capability),
  ).rejects.toMatchObject({ status: 409 });
  await runs.confirmModelInvocationUsage(scope, independent.capability, 400);
  await expect(
    runs.confirmModelInvocationUsage(scope, independent.capability, 400),
  ).resolves.toBeUndefined();
  await expect(
    runs.confirmModelInvocationUsage(scope, independent.capability, 401),
  ).rejects.toMatchObject({ status: 409 });

  const unknownAfterConsume = await issue(
    second.run_id,
    secondAttempt.attemptId,
    secondAttempt.generation,
    `${prefix}-request-3-unknown`,
    1000,
  );
  await runs.resolveModelInvocationCapability(
    scope,
    unknownAfterConsume.capability,
  );
  await runs.markModelInvocationUnknown(scope, unknownAfterConsume.capability);
  await expect(
    runs.releaseModelInvocation(scope, unknownAfterConsume.capability),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    runs.confirmModelInvocationUsage(scope, unknownAfterConsume.capability, 1),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    issue(
      second.run_id,
      secondAttempt.attemptId,
      secondAttempt.generation,
      `${prefix}-request-3-over-after-consume`,
      601,
    ),
  ).rejects.toMatchObject({ status: 402, code: "MODEL_BUDGET_EXCEEDED" });

  const independentAfterSafeRelease = await issue(
    second.run_id,
    secondAttempt.attemptId,
    secondAttempt.generation,
    `${prefix}-request-3b`,
    600,
  );
  expect(independentAfterSafeRelease.maximum_tokens).toBe(600);

  const thirdAttempt = await runStore.expireLease(
    scope,
    first.run_id,
    new Date(Date.now() + 60_000),
  );
  const retry = await issue(
    first.run_id,
    thirdAttempt.attemptId,
    thirdAttempt.generation,
    `${prefix}-request-4`,
    1000,
  );
  expect(retry.maximum_tokens).toBe(1000);
  await runs.markModelInvocationUnknown(scope, retry.capability);
  await expect(
    runs.releaseModelInvocation(scope, retry.capability),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    issue(
      first.run_id,
      thirdAttempt.attemptId,
      thirdAttempt.generation,
      `${prefix}-request-5`,
      1,
    ),
  ).rejects.toMatchObject({ status: 402, code: "MODEL_BUDGET_EXCEEDED" });

  await runs.cancel(scope, { runId: first.run_id, reason: "user_requested" });
  await runs.cancel(scope, { runId: second.run_id, reason: "user_requested" });
  await expect(
    runs.resolveModelInvocationCapability(
      scope,
      independentAfterSafeRelease.capability,
    ),
  ).rejects.toMatchObject({ status: 409 });
});

test("data role cannot forge a model capability by replacing its digest", async () => {
  const run = await runs.start(
    scope,
    await admittedRunInput("capability-forged-digest"),
  );
  const attempt = await runStore.currentAttempt(scope, run.run_id);
  const modelRequestId = `${prefix}-forged-digest-request`;
  const issued = await runs.issueModelInvocationCapability(scope, {
    runId: run.run_id,
    attemptId: attempt.attemptId,
    generation: attempt.generation,
    modelRequestId,
    maximumTokens: 100,
  });
  const forgedCapability = "A".repeat(43);
  const forgedDigest = createHash("sha256")
    .update(forgedCapability)
    .digest("hex");
  const extendedExpiry = new Date(Date.now() + 60 * 60_000);

  await dataDatabase!.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
    );
    await tx
      .update(enterpriseModelInvocationCapabilities)
      .set({ capabilityDigest: forgedDigest, expiresAt: extendedExpiry })
      .where(
        and(
          eq(enterpriseModelInvocationCapabilities.tenantId, scope.tenantId),
          eq(enterpriseModelInvocationCapabilities.runId, run.run_id),
          eq(
            enterpriseModelInvocationCapabilities.modelRequestId,
            modelRequestId,
          ),
        ),
      );
  });

  expect(issued.capability).not.toBe(forgedCapability);
  await expect(
    runs.resolveModelInvocationCapability(scope, forgedCapability),
  ).rejects.toMatchObject({
    status: 401,
    code: "MODEL_CAPABILITY_INVALID",
  });

  const [stored] = await dataDatabase!.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
    );
    return tx
      .select({
        capabilityDigest:
          enterpriseModelInvocationCapabilities.capabilityDigest,
        expiresAt: enterpriseModelInvocationCapabilities.expiresAt,
        status: enterpriseModelInvocationCapabilities.status,
      })
      .from(enterpriseModelInvocationCapabilities)
      .where(
        and(
          eq(enterpriseModelInvocationCapabilities.tenantId, scope.tenantId),
          eq(enterpriseModelInvocationCapabilities.runId, run.run_id),
          eq(
            enterpriseModelInvocationCapabilities.modelRequestId,
            modelRequestId,
          ),
        ),
      );
  });
  expect(stored).toEqual({
    capabilityDigest: forgedDigest,
    expiresAt: extendedExpiry,
    status: "reserved",
  });

  const forgeForOperation = async (operation: string) => {
    const operationRun = await runs.start(
      scope,
      await admittedRunInput(`capability-forged-${operation}`),
    );
    const operationAttempt = await runStore.currentAttempt(
      scope,
      operationRun.run_id,
    );
    const operationRequestId = `${prefix}-forged-${operation}-request`;
    const operationCapability = await runs.issueModelInvocationCapability(
      scope,
      {
        runId: operationRun.run_id,
        attemptId: operationAttempt.attemptId,
        generation: operationAttempt.generation,
        modelRequestId: operationRequestId,
        maximumTokens: 100,
      },
    );
    return { operationCapability, operationRequestId, operationRun };
  };

  const replaceDigest = async (runId: string, requestId: string) => {
    const token = createHash("sha256").update(requestId).digest("base64url");
    const expectedDigest = createHash("sha256").update(token).digest("hex");
    const updatedRows = await dataDatabase!.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
      );
      return tx
        .update(enterpriseModelInvocationCapabilities)
        .set({ capabilityDigest: expectedDigest })
        .where(
          and(
            eq(enterpriseModelInvocationCapabilities.tenantId, scope.tenantId),
            eq(enterpriseModelInvocationCapabilities.runId, runId),
            eq(enterpriseModelInvocationCapabilities.modelRequestId, requestId),
          ),
        )
        .returning({
          capabilityDigest:
            enterpriseModelInvocationCapabilities.capabilityDigest,
        });
    });
    expect(updatedRows).toHaveLength(1);
    expect(updatedRows[0]?.capabilityDigest).toBe(expectedDigest);
    return token;
  };

  const releaseFixture = await forgeForOperation("release");
  const releaseToken = await replaceDigest(
    releaseFixture.operationRun.run_id,
    releaseFixture.operationRequestId,
  );
  await expect(
    runs.releaseModelInvocation(scope, releaseToken),
  ).rejects.toMatchObject({
    status: 401,
    code: "MODEL_CAPABILITY_INVALID",
  });

  const markUnknownFixture = await forgeForOperation("mark-unknown");
  const unknownToken = await replaceDigest(
    markUnknownFixture.operationRun.run_id,
    markUnknownFixture.operationRequestId,
  );
  await expect(
    runs.markModelInvocationUnknown(scope, unknownToken),
  ).rejects.toMatchObject({
    status: 401,
    code: "MODEL_CAPABILITY_INVALID",
  });

  const confirmFixture = await forgeForOperation("confirm-usage");
  await runs.resolveModelInvocationCapability(
    scope,
    confirmFixture.operationCapability.capability,
  );
  const confirmToken = await replaceDigest(
    confirmFixture.operationRun.run_id,
    confirmFixture.operationRequestId,
  );
  await expect(
    runs.confirmModelInvocationUsage(scope, confirmToken, 12),
  ).rejects.toMatchObject({
    status: 401,
    code: "MODEL_CAPABILITY_INVALID",
  });

  const readOperationRow = async (runId: string, requestId: string) => {
    const [row] = await dataDatabase!.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
      );
      return tx
        .select({
          status: enterpriseModelInvocationCapabilities.status,
          usedTokens: enterpriseModelInvocationCapabilities.usedTokens,
        })
        .from(enterpriseModelInvocationCapabilities)
        .where(
          and(
            eq(enterpriseModelInvocationCapabilities.tenantId, scope.tenantId),
            eq(enterpriseModelInvocationCapabilities.runId, runId),
            eq(enterpriseModelInvocationCapabilities.modelRequestId, requestId),
          ),
        );
    });
    return row;
  };
  expect(
    await readOperationRow(
      releaseFixture.operationRun.run_id,
      releaseFixture.operationRequestId,
    ),
  ).toMatchObject({ status: "reserved", usedTokens: 0 });
  expect(
    await readOperationRow(
      markUnknownFixture.operationRun.run_id,
      markUnknownFixture.operationRequestId,
    ),
  ).toMatchObject({ status: "reserved", usedTokens: 0 });
  expect(
    await readOperationRow(
      confirmFixture.operationRun.run_id,
      confirmFixture.operationRequestId,
    ),
  ).toMatchObject({ status: "consumed", usedTokens: 0 });
});

test("capability renewal racing old-token resolve uses Run-before-capability locks", async () => {
  const run = await runs.start(
    scope,
    await admittedRunInput("capability-renewal-resolve-lock-order"),
  );
  const attempt = await runStore.currentAttempt(scope, run.run_id);
  const modelRequestId = `${prefix}-lock-order-request`;
  const request = {
    runId: run.run_id,
    attemptId: attempt.attemptId,
    generation: attempt.generation,
    modelRequestId,
    maximumTokens: 100,
  };
  const original = await runs.issueModelInvocationCapability(scope, request);
  await setupDb().transaction(async (tx) => {
    await tx
      .update(enterpriseModelInvocationCapabilities)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(
        and(
          eq(enterpriseModelInvocationCapabilities.tenantId, scope.tenantId),
          eq(enterpriseModelInvocationCapabilities.runId, run.run_id),
          eq(
            enterpriseModelInvocationCapabilities.modelRequestId,
            modelRequestId,
          ),
        ),
      );
    const activeUntil = new Date(Date.now() + 120_000);
    await tx
      .update(enterpriseRuns)
      .set({ leaseExpiresAt: activeUntil })
      .where(
        and(
          eq(enterpriseRuns.tenantId, scope.tenantId),
          eq(enterpriseRuns.workspaceId, scope.workspaceId),
          eq(enterpriseRuns.principalId, scope.principalId),
          eq(enterpriseRuns.id, run.run_id),
        ),
      );
    await tx
      .update(enterpriseRunAttempts)
      .set({ leaseExpiresAt: activeUntil })
      .where(
        and(
          eq(enterpriseRunAttempts.tenantId, scope.tenantId),
          eq(enterpriseRunAttempts.id, attempt.attemptId),
          eq(enterpriseRunAttempts.runId, run.run_id),
        ),
      );
  });

  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let signalLock!: (pid: number) => void;
  const runLockReady = new Promise<number>((resolve) => {
    signalLock = resolve;
  });
  const holder = setupDb().transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: enterpriseRuns.id })
      .from(enterpriseRuns)
      .where(
        and(
          eq(enterpriseRuns.tenantId, scope.tenantId),
          eq(enterpriseRuns.workspaceId, scope.workspaceId),
          eq(enterpriseRuns.principalId, scope.principalId),
          eq(enterpriseRuns.id, run.run_id),
        ),
      )
      .for("update")
      .limit(1);
    if (!locked) throw new Error("LOCK_ORDER_FIXTURE_RUN_MISSING");
    const [backend] = (await tx.execute(
      sql`SELECT pg_backend_pid()::int AS pid`,
    )) as unknown as Array<{ pid: number }>;
    if (!backend) throw new Error("LOCK_ORDER_FIXTURE_BACKEND_MISSING");
    signalLock(backend.pid);
    await gate;
  });
  const blockerPid = await runLockReady;
  let renewal:
    | Promise<Awaited<ReturnType<typeof runs.issueModelInvocationCapability>>>
    | undefined;
  let oldResolve:
    | Promise<Awaited<ReturnType<typeof runs.resolveModelInvocationCapability>>>
    | undefined;
  let setupFailure: unknown;
  try {
    const renewalStartedAt = Date.now();
    renewal = runs.issueModelInvocationCapability(scope, request);
    await waitForRunLockWaiters(
      blockerPid,
      1,
      "renewal waiting on Run row",
      renewalStartedAt + 800,
    );
    oldResolve = runs.resolveModelInvocationCapability(
      scope,
      original.capability,
    );
    await waitForRunLockWaiters(
      blockerPid,
      2,
      "renewal and old-token resolve waiting on Run row",
      renewalStartedAt + 1_750,
    );
  } catch (error) {
    setupFailure = error;
  } finally {
    releaseGate();
  }
  const outcomes = await Promise.allSettled(
    [renewal, oldResolve].filter(
      (promise): promise is NonNullable<typeof promise> =>
        promise !== undefined,
    ),
  );
  await holder;
  if (setupFailure) {
    const sqlStates = outcomes.map((outcome) =>
      outcome.status === "rejected"
        ? postgresSqlState(outcome.reason)
        : undefined,
    );
    throw new Error(
      `${String(setupFailure)}; operation SQLSTATEs=${JSON.stringify(sqlStates)}`,
    );
  }
  expect(outcomes).toHaveLength(2);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected")
      expect(postgresSqlState(outcome.reason)).not.toBe("40P01");
  }
  const renewalOutcome = outcomes[0];
  const oldResolveOutcome = outcomes[1];
  expect(renewalOutcome?.status).toBe("fulfilled");
  if (renewalOutcome?.status !== "fulfilled") return;
  expect(oldResolveOutcome?.status).toBe("rejected");
  if (oldResolveOutcome?.status !== "rejected") return;
  expect(oldResolveOutcome.reason).toMatchObject({ status: 401 });
  await expect(
    runs.resolveModelInvocationCapability(
      scope,
      renewalOutcome.value.capability,
    ),
  ).resolves.toMatchObject({ modelRequestId });
  await expect(
    runs.resolveModelInvocationCapability(
      scope,
      renewalOutcome.value.capability,
    ),
  ).rejects.toMatchObject({ status: 409 });
});

async function waitForRunLockWaiters(
  blockerPid: number,
  expected: number,
  description: string,
  deadline: number,
): Promise<void> {
  let waiting: Array<{
    pid: number;
    usename: string;
    wait_event_type: string | null;
    wait_event: string | null;
    query: string;
  }> = [];
  do {
    waiting = (await setupDb().execute(sql`
      WITH RECURSIVE run_waiters AS (
        SELECT activity.pid,
          activity.usename,
          activity.wait_event_type,
          activity.wait_event,
          activity.query,
          pg_blocking_pids(activity.pid) AS blockers
        FROM pg_stat_activity AS activity
        WHERE activity.datname = current_database()
          AND activity.pid <> pg_backend_pid()
          AND activity.wait_event_type = 'Lock'
          AND activity.query ILIKE '%enterprise_runs%'
          AND activity.query NOT ILIKE '%pg_stat_activity%'
      ), blocker_chain(waiter_pid, blocker_pid) AS (
        SELECT run_waiters.pid, unnest(run_waiters.blockers)
        FROM run_waiters
        UNION
        SELECT blocker_chain.waiter_pid,
          unnest(pg_blocking_pids(blocker_chain.blocker_pid))
        FROM blocker_chain
        WHERE blocker_chain.blocker_pid <> pg_backend_pid()
      )
      SELECT DISTINCT run_waiters.pid::int AS pid,
        run_waiters.usename,
        run_waiters.wait_event_type,
        run_waiters.wait_event,
        left(run_waiters.query, 180) AS query
      FROM run_waiters
      JOIN blocker_chain ON blocker_chain.waiter_pid = run_waiters.pid
      WHERE blocker_chain.blocker_pid = ${blockerPid}
    `)) as unknown as typeof waiting;
    if (waiting.length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  const activeSessions = (await setupDb().execute(sql`
    SELECT activity.pid::int AS pid,
      activity.usename,
      activity.state,
      activity.wait_event_type,
      activity.wait_event,
      pg_blocking_pids(activity.pid) AS blockers,
      left(activity.query, 240) AS query
    FROM pg_stat_activity AS activity
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  `)) as unknown as Array<Record<string, unknown>>;
  throw new Error(
    `LOCK_ORDER_ACTIVITY_TIMEOUT at ${new Date().toISOString()}: ${description}; expected ${expected}, observed ${waiting.length}; blocked=${JSON.stringify(waiting)}; data sessions=${JSON.stringify(activeSessions)}.`,
  );
}

function postgresSqlState(error: unknown): string | undefined {
  let cursor: unknown = error;
  const seen = new Set<object>();
  while (cursor && typeof cursor === "object" && !seen.has(cursor)) {
    seen.add(cursor);
    const candidate = cursor as {
      code?: unknown;
      errno?: unknown;
      sqlState?: unknown;
      sqlstate?: unknown;
      cause?: unknown;
    };
    for (const value of [
      candidate.errno,
      candidate.sqlState,
      candidate.sqlstate,
      candidate.code,
    ]) {
      if (typeof value === "string" && /^[0-9A-Z]{5}$/.test(value))
        return value;
    }
    cursor = candidate.cause;
  }
  return undefined;
}

test("expired reserved capability retries renew the same claim; uncertain claims stay charged", async () => {
  const [capabilityPrivileges] = (await setupDb().execute(sql`
    SELECT has_table_privilege('ob_ent_data', 'public.enterprise_model_invocation_capabilities', 'UPDATE') AS table_update,
      has_column_privilege('ob_ent_data', 'public.enterprise_model_invocation_capabilities', 'capability_digest', 'UPDATE') AS digest_update,
      has_column_privilege('ob_ent_data', 'public.enterprise_model_invocation_capabilities', 'expires_at', 'UPDATE') AS expiry_update,
      has_column_privilege('ob_ent_data', 'public.enterprise_model_invocation_capabilities', 'used_tokens', 'UPDATE') AS used_update,
      has_column_privilege('ob_ent_data', 'public.enterprise_model_invocation_capabilities', 'status', 'UPDATE') AS status_update,
      has_column_privilege('ob_ent_data', 'public.enterprise_model_invocation_capabilities', 'updated_at', 'UPDATE') AS updated_update,
      has_column_privilege('ob_ent_data', 'public.enterprise_model_invocation_capabilities', 'capability_nonce', 'UPDATE') AS nonce_update,
      has_column_privilege('ob_ent_data', 'public.enterprise_model_invocation_capabilities', 'maximum_tokens', 'UPDATE') AS maximum_update,
      has_column_privilege('ob_ent_data', 'public.enterprise_model_invocation_capabilities', 'tenant_id', 'UPDATE') AS tenant_update,
      has_column_privilege('ob_ent_data', 'public.enterprise_model_invocation_capabilities', 'workspace_id', 'UPDATE') AS workspace_update,
      has_column_privilege('ob_ent_data', 'public.enterprise_model_invocation_capabilities', 'principal_id', 'UPDATE') AS principal_update,
      has_column_privilege('ob_ent_data', 'public.enterprise_model_invocation_capabilities', 'run_id', 'UPDATE') AS run_update,
      has_column_privilege('ob_ent_data', 'public.enterprise_model_invocation_capabilities', 'attempt_id', 'UPDATE') AS attempt_update,
      has_column_privilege('ob_ent_data', 'public.enterprise_model_invocation_capabilities', 'generation', 'UPDATE') AS generation_update,
      has_column_privilege('ob_ent_data', 'public.enterprise_model_invocation_capabilities', 'model_route_ref', 'UPDATE') AS route_update,
      has_column_privilege('ob_ent_data', 'public.enterprise_model_invocation_capabilities', 'model_request_id', 'UPDATE') AS request_update,
      has_column_privilege('ob_ent_data', 'public.enterprise_model_invocation_capabilities', 'created_at', 'UPDATE') AS created_update
  `)) as unknown as Array<Record<string, boolean>>;
  expect(capabilityPrivileges).toEqual({
    table_update: false,
    digest_update: true,
    expiry_update: true,
    used_update: true,
    status_update: true,
    updated_update: true,
    nonce_update: false,
    maximum_update: false,
    tenant_update: false,
    workspace_update: false,
    principal_update: false,
    run_update: false,
    attempt_update: false,
    generation_update: false,
    route_update: false,
    request_update: false,
    created_update: false,
  });
  const run = await runs.start(
    scope,
    await admittedRunInput("capability-expiry-retry"),
  );
  const attempt = await runStore.currentAttempt(scope, run.run_id);
  const requestId = `${prefix}-expired-reserved-request`;
  const original = await runs.issueModelInvocationCapability(scope, {
    runId: run.run_id,
    attemptId: attempt.attemptId,
    generation: attempt.generation,
    modelRequestId: requestId,
    maximumTokens: 100,
  });
  const [originalRow] = await setupDb().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(enterpriseModelInvocationCapabilities)
      .where(
        and(
          eq(enterpriseModelInvocationCapabilities.tenantId, scope.tenantId),
          eq(enterpriseModelInvocationCapabilities.runId, run.run_id),
          eq(enterpriseModelInvocationCapabilities.modelRequestId, requestId),
        ),
      );
    await tx
      .update(enterpriseModelInvocationCapabilities)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(enterpriseModelInvocationCapabilities.id, row!.id));
    const activeUntil = new Date(Date.now() + 120_000);
    await tx
      .update(enterpriseRuns)
      .set({ leaseExpiresAt: activeUntil })
      .where(
        and(
          eq(enterpriseRuns.tenantId, scope.tenantId),
          eq(enterpriseRuns.id, run.run_id),
        ),
      );
    await tx
      .update(enterpriseRunAttempts)
      .set({ leaseExpiresAt: activeUntil })
      .where(
        and(
          eq(enterpriseRunAttempts.tenantId, scope.tenantId),
          eq(enterpriseRunAttempts.id, attempt.attemptId),
        ),
      );
    return [row!];
  });
  const renewed = await runs.issueModelInvocationCapability(scope, {
    runId: run.run_id,
    attemptId: attempt.attemptId,
    generation: attempt.generation,
    modelRequestId: requestId,
    maximumTokens: 100,
  });
  expect(renewed.capability).not.toBe(original.capability);
  expect(Date.parse(renewed.expires_at)).toBeGreaterThan(Date.now());
  const [renewedRow] = await setupDb().transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
    );
    return tx
      .select()
      .from(enterpriseModelInvocationCapabilities)
      .where(
        and(
          eq(enterpriseModelInvocationCapabilities.tenantId, scope.tenantId),
          eq(enterpriseModelInvocationCapabilities.runId, run.run_id),
          eq(enterpriseModelInvocationCapabilities.modelRequestId, requestId),
        ),
      );
  });
  expect(renewedRow).toMatchObject({
    id: originalRow?.id,
    attemptId: attempt.attemptId,
    generation: attempt.generation,
    modelRequestId: requestId,
    maximumTokens: 100,
    status: "reserved",
  });
  expect(renewedRow?.expiresAt.getTime()).toBeGreaterThan(
    originalRow!.expiresAt.getTime(),
  );
  await expect(
    runs.resolveModelInvocationCapability(scope, renewed.capability),
  ).resolves.toMatchObject({ modelRequestId: requestId });
  await expect(
    runs.resolveModelInvocationCapability(scope, original.capability),
  ).rejects.toMatchObject({ status: 401 });
  await setCapabilityExpired(run.run_id, requestId);
  await expect(
    runs.issueModelInvocationCapability(scope, {
      runId: run.run_id,
      attemptId: attempt.attemptId,
      generation: attempt.generation,
      modelRequestId: requestId,
      maximumTokens: 100,
    }),
  ).rejects.toMatchObject({ status: 410, code: "MODEL_CAPABILITY_EXPIRED" });

  const uncertain = await runs.issueModelInvocationCapability(scope, {
    runId: run.run_id,
    attemptId: attempt.attemptId,
    generation: attempt.generation,
    modelRequestId: `${prefix}-expired-unknown-request`,
    maximumTokens: 100,
  });
  await runs.resolveModelInvocationCapability(scope, uncertain.capability);
  await runs.markModelInvocationUnknown(scope, uncertain.capability);
  await setCapabilityExpired(run.run_id, `${prefix}-expired-unknown-request`);
  await expect(
    runs.issueModelInvocationCapability(scope, {
      runId: run.run_id,
      attemptId: attempt.attemptId,
      generation: attempt.generation,
      modelRequestId: `${prefix}-expired-unknown-request`,
      maximumTokens: 100,
    }),
  ).rejects.toMatchObject({ status: 410, code: "MODEL_CAPABILITY_EXPIRED" });
  await expect(
    runs.issueModelInvocationCapability(scope, {
      runId: run.run_id,
      attemptId: attempt.attemptId,
      generation: attempt.generation,
      modelRequestId: `${prefix}-unknown-expiry-fill`,
      maximumTokens: 1000,
    }),
  ).resolves.toMatchObject({ maximum_tokens: 1000 });
  await expect(
    runs.issueModelInvocationCapability(scope, {
      runId: run.run_id,
      attemptId: attempt.attemptId,
      generation: attempt.generation,
      modelRequestId: `${prefix}-after-unknown-expiry`,
      maximumTokens: 801,
    }),
  ).rejects.toMatchObject({ status: 402, code: "MODEL_BUDGET_EXCEEDED" });
  await runs.cancel(scope, { runId: run.run_id, reason: "user_requested" });
});

async function setCapabilityExpired(runId: string, modelRequestId: string) {
  await setupDb().transaction(async (tx) => {
    await tx
      .update(enterpriseModelInvocationCapabilities)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(
        and(
          eq(enterpriseModelInvocationCapabilities.tenantId, scope.tenantId),
          eq(enterpriseModelInvocationCapabilities.runId, runId),
          eq(
            enterpriseModelInvocationCapabilities.modelRequestId,
            modelRequestId,
          ),
        ),
      );
  });
}

test("budget reservations and capabilities cumulatively consume one Run ceiling", async () => {
  const run = await runs.start(
    scope,
    await admittedRunInput("mixed-budget-admission"),
  );
  const reservation = await runs.reserveModelBudget(scope, {
    runId: run.run_id,
    modelRouteRef: "synthetic-model-route",
    maximumTokens: 1000,
  });
  const attempt = await runStore.currentAttempt(scope, run.run_id);
  const capability = await runs.issueModelInvocationCapability(scope, {
    runId: run.run_id,
    attemptId: attempt.attemptId,
    generation: attempt.generation,
    modelRequestId: `${prefix}-mixed-admission-capability`,
    maximumTokens: 1000,
  });
  expect(reservation.tokenLimit + capability.maximum_tokens).toBe(2000);
  await expect(
    budgetService().reserveModelBudget(
      scope,
      {
        runId: run.run_id,
        modelRouteRef: "synthetic-model-route",
        maximumTokens: 1,
      },
      { idempotencyKey: `${prefix}-mixed-admission-over` },
    ),
  ).rejects.toMatchObject({ status: 402, code: "MODEL_BUDGET_EXCEEDED" });
  await runs.cancel(scope, { runId: run.run_id, reason: "user_requested" });
});

test("each run owns its immutable configured ceiling", async () => {
  const first = await runs.start(
    scope,
    await admittedRunInput("budget-boundary-one"),
  );
  const second = await runs.start(
    scope,
    await admittedRunInput("budget-boundary-two"),
  );
  await runs.cancel(scope, { runId: first.run_id, reason: "user_requested" });
  const admitted = await runs.start(
    scope,
    await admittedRunInput("budget-boundary-after-cancel"),
  );
  expect(admitted.status).toBe("queued");
  const ceilings = await dataDatabase!.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true)`,
    );
    return tx
      .select({
        runId: enterpriseModelBudgetReservations.runId,
        tokenLimit: enterpriseModelBudgetReservations.tokenLimit,
      })
      .from(enterpriseModelBudgetReservations)
      .where(
        and(
          eq(enterpriseModelBudgetReservations.tenantId, scope.tenantId),
          eq(enterpriseModelBudgetReservations.isRunCeiling, true),
        ),
      );
  });
  expect(
    ceilings
      .filter((row) =>
        [first.run_id, second.run_id, admitted.run_id].includes(row.runId),
      )
      .sort((left, right) => left.runId.localeCompare(right.runId)),
  ).toEqual(
    [
      { runId: first.run_id, tokenLimit: 2000 },
      { runId: second.run_id, tokenLimit: 2000 },
      { runId: admitted.run_id, tokenLimit: 2000 },
    ].sort((left, right) => left.runId.localeCompare(right.runId)),
  );
  await runs.cancel(scope, { runId: second.run_id, reason: "user_requested" });
  await runs.cancel(scope, {
    runId: admitted.run_id,
    reason: "user_requested",
  });
});

test("cancellation and a successful stale callback cannot both win", async () => {
  const run = await runs.start(scope, await admittedRunInput("cancel-race"));
  const attempt = await runStore.currentAttempt(scope, run.run_id);
  const results = await Promise.all([
    runs.cancel(scope, { runId: run.run_id, reason: "user_requested" }),
    runStore.transitionTerminal(scope, {
      runId: run.run_id,
      attemptId: attempt.attemptId,
      generation: attempt.generation,
      status: "succeeded",
    }),
  ]);
  const final = await runs.get(scope, run.run_id);
  expect(["cancelled", "succeeded"]).toContain(final.status);
  if (final.status === "cancelled") expect(results[1]).toBe(false);
  else expect(results[1]).toBe(true);
});

test("an expired attempt cannot commit terminal state before lease sweeping", async () => {
  const run = await runs.start(
    scope,
    await admittedRunInput("terminal-expired-before-sweeper"),
  );
  const attempt = await runStore.currentAttempt(scope, run.run_id);
  const expiredAt = new Date(Date.now() - 60_000);
  await runStore.transaction(scope, async (tx) => {
    await tx
      .update(enterpriseRuns)
      .set({ leaseExpiresAt: expiredAt })
      .where(
        and(
          eq(enterpriseRuns.tenantId, scope.tenantId),
          eq(enterpriseRuns.id, run.run_id),
        ),
      );
    await tx
      .update(enterpriseRunAttempts)
      .set({ leaseExpiresAt: expiredAt })
      .where(
        and(
          eq(enterpriseRunAttempts.tenantId, scope.tenantId),
          eq(enterpriseRunAttempts.id, attempt.attemptId),
        ),
      );
  });

  await expect(
    runStore.transitionTerminal(scope, {
      runId: run.run_id,
      attemptId: attempt.attemptId,
      generation: attempt.generation,
      status: "succeeded",
    }),
  ).resolves.toBe(false);
  await expect(runs.get(scope, run.run_id)).resolves.toMatchObject({
    status: "queued",
  });
});

test("model capability consumption checks lease expiry using database time", async () => {
  const run = await runs.start(
    scope,
    await admittedRunInput("capability-db-time-lease"),
  );
  const attempt = await runStore.currentAttempt(scope, run.run_id);
  const capability = await runs.issueModelInvocationCapability(scope, {
    runId: run.run_id,
    attemptId: attempt.attemptId,
    generation: attempt.generation,
    modelRequestId: `${prefix}-db-time-lease-request`,
    maximumTokens: 100,
  });
  const expiredAt = new Date(Date.now() - 60_000);
  await runStore.transaction(scope, async (tx) => {
    await tx
      .update(enterpriseRuns)
      .set({ leaseExpiresAt: expiredAt })
      .where(
        and(
          eq(enterpriseRuns.tenantId, scope.tenantId),
          eq(enterpriseRuns.id, run.run_id),
        ),
      );
    await tx
      .update(enterpriseRunAttempts)
      .set({ leaseExpiresAt: expiredAt })
      .where(
        and(
          eq(enterpriseRunAttempts.tenantId, scope.tenantId),
          eq(enterpriseRunAttempts.id, attempt.attemptId),
        ),
      );
  });

  const realNow = Date.now;
  const RealDate = Date;
  class ApplicationClockBehindDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(realNow() - 10 * 60_000);
      else if (args.length === 1) super(args[0] as string | number);
      else
        super(
          ...(args as [
            number,
            number,
            number?,
            number?,
            number?,
            number?,
            number?,
          ]),
        );
    }

    static now() {
      return realNow() - 10 * 60_000;
    }
  }
  try {
    globalThis.Date = ApplicationClockBehindDate as DateConstructor;
    await expect(
      runs.resolveModelInvocationCapability(scope, capability.capability),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    globalThis.Date = RealDate;
  }
});

test("model capability consumption checks capability expiry using database time", async () => {
  const run = await runs.start(
    scope,
    await admittedRunInput("capability-db-time-expiry"),
  );
  const attempt = await runStore.currentAttempt(scope, run.run_id);
  const realNow = Date.now;
  const RealDate = Date;
  class ApplicationClockBehindDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(realNow() - 10 * 60_000);
      else if (args.length === 1) super(args[0] as string | number);
      else
        super(
          ...(args as [
            number,
            number,
            number?,
            number?,
            number?,
            number?,
            number?,
          ]),
        );
    }

    static now() {
      return realNow() - 10 * 60_000;
    }
  }
  let capability: Awaited<
    ReturnType<typeof runs.issueModelInvocationCapability>
  >;
  try {
    globalThis.Date = ApplicationClockBehindDate as DateConstructor;
    capability = await runs.issueModelInvocationCapability(scope, {
      runId: run.run_id,
      attemptId: attempt.attemptId,
      generation: attempt.generation,
      modelRequestId: `${prefix}-db-time-expiry-request`,
      maximumTokens: 100,
    });
  } finally {
    globalThis.Date = RealDate;
  }
  expect(Date.parse(capability.expires_at)).toBeLessThanOrEqual(realNow());

  try {
    globalThis.Date = ApplicationClockBehindDate as DateConstructor;
    await expect(
      runs.resolveModelInvocationCapability(scope, capability.capability),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    globalThis.Date = RealDate;
  }
});

test("model capability consumption accepts application clock ahead of database time", async () => {
  const run = await runs.start(
    scope,
    await admittedRunInput("capability-app-time-ahead"),
  );
  const attempt = await runStore.currentAttempt(scope, run.run_id);
  const capability = await runs.issueModelInvocationCapability(scope, {
    runId: run.run_id,
    attemptId: attempt.attemptId,
    generation: attempt.generation,
    modelRequestId: `${prefix}-app-time-ahead-request`,
    maximumTokens: 100,
  });

  const realNow = Date.now;
  const RealDate = Date;
  class ApplicationClockAheadDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(realNow() + 10 * 60_000);
      else if (args.length === 1) super(args[0] as string | number);
      else
        super(
          ...(args as [
            number,
            number,
            number?,
            number?,
            number?,
            number?,
            number?,
          ]),
        );
    }

    static now() {
      return realNow() + 10 * 60_000;
    }
  }
  try {
    globalThis.Date = ApplicationClockAheadDate as DateConstructor;
    await expect(
      runs.resolveModelInvocationCapability(scope, capability.capability),
    ).resolves.toMatchObject({
      runId: run.run_id,
      attemptId: attempt.attemptId,
      generation: attempt.generation,
      modelRequestId: `${prefix}-app-time-ahead-request`,
      maximumTokens: 100,
    });
  } finally {
    globalThis.Date = RealDate;
  }

  const [stored] = await setupDb()
    .select({ status: enterpriseModelInvocationCapabilities.status })
    .from(enterpriseModelInvocationCapabilities)
    .where(
      and(
        eq(enterpriseModelInvocationCapabilities.tenantId, scope.tenantId),
        eq(
          enterpriseModelInvocationCapabilities.modelRequestId,
          `${prefix}-app-time-ahead-request`,
        ),
      ),
    );
  expect(stored?.status).toBe("consumed");
});

test("concurrent outbox dispatchers receive disjoint live start claims", async () => {
  const outbox = createRunOutbox(dataDatabase!);
  const run = await runs.start(
    scope,
    await admittedRunInput("outbox-disjoint-claims"),
  );
  const [first, second] = await Promise.all([
    outbox.claimPending(scope, {
      ownerId: `${prefix}-dispatcher-a`,
      batchSize: 500,
      leaseMilliseconds: 30_000,
    }),
    outbox.claimPending(scope, {
      ownerId: `${prefix}-dispatcher-b`,
      batchSize: 500,
      leaseMilliseconds: 30_000,
    }),
  ]);
  const firstIds = first.map((claim) => claim.message.id);
  const secondIds = second.map((claim) => claim.message.id);
  expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
  const targetStartEvents = await runStore.transaction(scope, (tx) =>
    tx
      .select({ id: enterpriseRunOutbox.id })
      .from(enterpriseRunOutbox)
      .where(
        and(
          eq(enterpriseRunOutbox.tenantId, scope.tenantId),
          eq(enterpriseRunOutbox.runId, run.run_id),
          eq(enterpriseRunOutbox.eventType, "run.start"),
        ),
      ),
  );
  expect(targetStartEvents).toHaveLength(1);
  expect(
    [...firstIds, ...secondIds].filter((id) => id === targetStartEvents[0]?.id),
  ).toHaveLength(1);
});

test("expired outbox claims reject stale acknowledgements after reclamation", async () => {
  const outbox = createRunOutbox(dataDatabase!);
  const run = await runs.start(
    scope,
    await admittedRunInput("outbox-reclaimed-stale-ack"),
  );
  const ownerA = `${prefix}-dispatcher-old`;
  const ownerB = `${prefix}-dispatcher-new`;
  const oldClaims = await outbox.claimPending(scope, {
    ownerId: ownerA,
    batchSize: 500,
    leaseMilliseconds: 100,
  });
  const startEventId = oldClaims.find(
    (claim) =>
      claim.message.runId === run.run_id &&
      claim.message.eventType === "run.start",
  )?.message.id;
  expect(startEventId).toBeDefined();
  const oldClaim = oldClaims.find((claim) => claim.message.id === startEventId);
  expect(oldClaim).toBeDefined();

  await new Promise((resolve) => setTimeout(resolve, 150));
  const newClaims = await outbox.claimPending(scope, {
    ownerId: ownerB,
    batchSize: 500,
    leaseMilliseconds: 30_000,
  });
  const newClaim = newClaims.find((claim) => claim.message.id === startEventId);
  expect(newClaim).toBeDefined();
  await expect(
    outbox.acknowledge(scope, {
      eventId: startEventId!,
      claimId: oldClaim!.claimId,
      ownerId: oldClaim!.ownerId,
    }),
  ).resolves.toBe(false);
  await expect(
    outbox.acknowledge(scope, {
      eventId: startEventId!,
      claimId: newClaim!.claimId,
      ownerId: newClaim!.ownerId,
    }),
  ).resolves.toBe(true);
});

test("failed outbox publish retries after expiry with the same stable event ID", async () => {
  const outbox = createRunOutbox(dataDatabase!);
  const run = await runs.start(
    scope,
    await admittedRunInput("outbox-stable-retry"),
  );
  const ownerB = `${prefix}-retry-owner-b`;
  const targetEvent = await runStore.transaction(scope, (tx) =>
    tx
      .select({ id: enterpriseRunOutbox.id })
      .from(enterpriseRunOutbox)
      .where(
        and(
          eq(enterpriseRunOutbox.tenantId, scope.tenantId),
          eq(enterpriseRunOutbox.runId, run.run_id),
          eq(enterpriseRunOutbox.eventType, "run.start"),
        ),
      ),
  );
  expect(targetEvent).toHaveLength(1);
  const failedMessageId = targetEvent[0]!.id;
  const visitedMessageIds: string[] = [];
  const failedPublishCount = await outbox.publishPending(
    scope,
    async (message) => {
      visitedMessageIds.push(message.id);
      throw new Error("synthetic publisher failure");
    },
    { batchSize: 500, leaseMilliseconds: 100 },
  );
  expect(visitedMessageIds).toContain(failedMessageId);
  expect(failedPublishCount).toBe(0);
  await expect(
    runStore.transaction(scope, (tx) =>
      tx
        .select({ deliveredAt: enterpriseRunOutbox.deliveredAt })
        .from(enterpriseRunOutbox)
        .where(
          and(
            eq(enterpriseRunOutbox.tenantId, scope.tenantId),
            eq(enterpriseRunOutbox.id, failedMessageId),
          ),
        ),
    ),
  ).resolves.toEqual([{ deliveredAt: null }]);

  await new Promise((resolve) => setTimeout(resolve, 150));
  const retryClaims = await outbox.claimPending(scope, {
    ownerId: ownerB,
    batchSize: 500,
    leaseMilliseconds: 30_000,
  });
  const retriedMessage = retryClaims.find(
    (claim) =>
      claim.message.runId === run.run_id &&
      claim.message.eventType === "run.start",
  )?.message;

  expect(retriedMessage?.id).toBe(failedMessageId);
});
