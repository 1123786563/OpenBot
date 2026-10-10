import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../src/db/client";
import {
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
import type { PlatformScope } from "../../src/enterprise/contracts";
import { createConversationService } from "../../src/enterprise/conversations/service";
import { createModelBudgetService } from "../../src/enterprise/models/budget";
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
  const conversation = await conversations.getOrCreate(scope, {});
  threadId = conversation.thread_id;
  await conversations.append(scope, {
    threadId,
    clientMessageKey: `${prefix}-client-message`,
    content: "synthetic run input",
    attachments: [],
  });
  runs = createRunService({
    data,
    conversations,
    modelRouteFor: async () => ({
      expertVersionRef: "synthetic-expert-v1",
      routeRef: "synthetic-model-route",
      maximumTokens: 1000,
    }),
    configuredBudgetTokens: () => 2000,
    modelCapabilitySecret:
      "test-only-model-capability-secret-000000000000000000000000000000",
  });
  runStore = createRunStore(data);
});

async function createRunInput(label: string) {
  const conversation = await conversations.getOrCreate(scope, {});
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
  };
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
  };
  const starts = await Promise.allSettled([
    runs.start(scope, input),
    runs.start(scope, input),
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
  await expect(runs.start(scope, input)).rejects.toMatchObject({
    status: 409,
    code: "RUN_IDEMPOTENCY_CONFLICT",
  });
});

test("budget reservation is idempotent, rejects changed input, and confirms exact usage", async () => {
  const input = await createRunInput("budget-idempotency");
  const run = await runs.start(scope, input);
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

test("model invocation claims enforce an independent cumulative ceiling per run", async () => {
  const first = await runs.start(
    scope,
    await createRunInput("invocation-budget-one"),
  );
  const second = await runs.start(
    scope,
    await createRunInput("invocation-budget-two"),
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

test("each run owns its immutable configured ceiling", async () => {
  const first = await runs.start(
    scope,
    await createRunInput("budget-boundary-one"),
  );
  const second = await runs.start(
    scope,
    await createRunInput("budget-boundary-two"),
  );
  await runs.cancel(scope, { runId: first.run_id, reason: "user_requested" });
  const admitted = await runs.start(
    scope,
    await createRunInput("budget-boundary-after-cancel"),
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
  const run = await runs.start(scope, await createRunInput("cancel-race"));
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
    await createRunInput("terminal-expired-before-sweeper"),
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
    await createRunInput("capability-db-time-lease"),
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
    await createRunInput("capability-db-time-expiry"),
  );
  const attempt = await runStore.currentAttempt(scope, run.run_id);
  const capability = await runs.issueModelInvocationCapability(scope, {
    runId: run.run_id,
    attemptId: attempt.attemptId,
    generation: attempt.generation,
    modelRequestId: `${prefix}-db-time-expiry-request`,
    maximumTokens: 100,
  });
  await setupDb().transaction(async (tx) => {
    await tx
      .update(enterpriseModelInvocationCapabilities)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(
        and(
          eq(enterpriseModelInvocationCapabilities.tenantId, scope.tenantId),
          eq(
            enterpriseModelInvocationCapabilities.modelRequestId,
            `${prefix}-db-time-expiry-request`,
          ),
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

test("concurrent outbox dispatchers receive disjoint live start claims", async () => {
  const outbox = createRunOutbox(dataDatabase!);
  const run = await runs.start(
    scope,
    await createRunInput("outbox-disjoint-claims"),
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
    await createRunInput("outbox-reclaimed-stale-ack"),
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
    await createRunInput("outbox-stable-retry"),
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
