import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../src/db/client";
import {
  enterpriseConversations,
  enterpriseModelBudgetReservations,
  enterpriseModelInvocationCapabilities,
  enterprisePrincipals,
  enterpriseRunAttempts,
  enterpriseRunnerEvents,
  enterpriseRunOutbox,
  enterpriseRuns,
  enterpriseTenants,
  users,
} from "../../src/db/schema";
import type {
  StartRunInput,
  TrustedRunAdmission,
} from "../../src/enterprise/contracts";
import { createConversationService } from "../../src/enterprise/conversations/service";
import { createConversationStore } from "../../src/enterprise/conversations/store";
import { ExpertVersionCatalog } from "../../src/enterprise/experts/version-catalog";
import {
  createDrizzleRunnerEventRepository,
  createRunnerEventService,
} from "../../src/enterprise/runs/events";
import { createRunService } from "../../src/enterprise/runs/service";
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

const hasRequiredDatabaseUrls = [
  "ENTERPRISE_TEST_SETUP_DATABASE_URL",
  "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
  "ENTERPRISE_TEST_DATA_DATABASE_URL",
  "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
].every((key) => Boolean(process.env[key]?.trim()));

const integrationTest = hasRequiredDatabaseUrls ? test : test.skip;

function dataUrlWithApplicationName(url: string, applicationName: string) {
  const parsed = new URL(url);
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

function dataFailingRunCeilingReservation(data: DataDatabase) {
  let runId: string | undefined;
  const transaction = data.transaction.bind(data);
  const wrappedData = new Proxy(data, {
    get(target, property, receiver) {
      if (property !== "transaction")
        return Reflect.get(target, property, receiver);
      return (callback: Parameters<DataDatabase["transaction"]>[0]) =>
        transaction((tx) =>
          callback(
            new Proxy(tx, {
              get(txTarget, txProperty, txReceiver) {
                if (txProperty !== "insert")
                  return Reflect.get(txTarget, txProperty, txReceiver);
                return (table: Parameters<typeof tx.insert>[0]) => {
                  const builder = tx.insert(table);
                  if (
                    table !== enterpriseRuns &&
                    table !== enterpriseModelBudgetReservations
                  ) {
                    return builder;
                  }
                  return new Proxy(builder, {
                    get(builderTarget, builderProperty, builderReceiver) {
                      if (builderProperty !== "values")
                        return Reflect.get(
                          builderTarget,
                          builderProperty,
                          builderReceiver,
                        );
                      return (...values: unknown[]) => {
                        if (table === enterpriseModelBudgetReservations)
                          throw new Error(
                            "TEST_RUN_CEILING_RESERVATION_FAILED",
                          );
                        const [insertValues] = values;
                        if (
                          typeof insertValues === "object" &&
                          insertValues !== null &&
                          "id" in insertValues &&
                          typeof insertValues.id === "string"
                        ) {
                          runId = insertValues.id;
                        }
                        const method = Reflect.get(
                          builderTarget,
                          builderProperty,
                          builderTarget,
                        );
                        return Reflect.apply(method, builderTarget, values);
                      };
                    },
                  });
                };
              },
            }) as typeof tx,
          ),
        );
    },
  }) as DataDatabase;
  return { data: wrappedData, runId: () => runId };
}

integrationTest(
  "event_append_rejects_after_run_lock_wait_crosses_request_lease_and_run_budget_is_atomic",
  async () => {
    const prefix = `event-lock-${randomUUID()}`;
    const actorId = `${prefix}-actor`;
    const principalId = `${prefix}-principal`;
    const tenantId = `${prefix}-tenant`;
    const workspaceId = `${prefix}-workspace`;
    const threadId = randomUUID();
    const sourceEventId = `${prefix}-source-event`;
    const appendApplicationName = `${prefix}-append`;
    const databases: Database[] = [];
    let setupDatabase: Database | undefined;
    let directoryDatabase: DirectoryDatabase | undefined;
    let operatorDatabase: OperatorDatabase | undefined;
    let lockDatabase: DataDatabase | undefined;
    let appendDatabase: DataDatabase | undefined;
    const cleanupFailures: unknown[] = [];
    let bodyFailure: unknown;
    let bodyFailed = false;

    try {
      setupDatabase = createDatabase(enterpriseTestDatabaseUrlFrom(), {
        max: 2,
      });
      databases.push(setupDatabase);
      const directoryCandidate = createDatabase(
        enterpriseRuntimeDatabaseUrlFrom("directory"),
        { max: 2 },
      );
      databases.push(directoryCandidate);
      directoryDatabase = await verifyDirectoryDatabase(directoryCandidate);
      const operatorCandidate = createDatabase(
        enterpriseRuntimeDatabaseUrlFrom("operator"),
        { max: 2 },
      );
      databases.push(operatorCandidate);
      operatorDatabase = await verifyOperatorDatabase(operatorCandidate);

      const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data");
      const lockCandidate = createDatabase(dataUrl, { max: 2 });
      databases.push(lockCandidate);
      lockDatabase = await verifyDataDatabase(lockCandidate);
      const appendCandidate = createDatabase(
        dataUrlWithApplicationName(dataUrl, appendApplicationName),
        { max: 2 },
      );
      databases.push(appendCandidate);
      appendDatabase = await verifyDataDatabase(appendCandidate);

      await setupDatabase.insert(users).values({
        id: actorId,
        email: `${actorId}@example.invalid`,
        name: "Synthetic runner event actor",
      });
      await setupDatabase
        .insert(enterprisePrincipals)
        .values({ id: principalId, userId: actorId });
      await provisionDeployment(operatorDatabase, {
        operationId: `${prefix}-provision`,
        operator: principalId,
        tenant: { id: tenantId, name: "Synthetic runner event tenant" },
        workspace: {
          id: workspaceId,
          name: "Synthetic runner event workspace",
        },
        members: [{ principalId, userId: actorId, role: "tenant_admin" }],
        resources: [],
      });

      const authenticated = new WeakMap<
        Request,
        AuthenticatedRequestIdentity
      >();
      const resolver = createScopeResolver(directoryDatabase, {
        authenticate: async (request) => authenticated.get(request) ?? null,
        selectTenant: () => tenantId,
        selectWorkspace: () => workspaceId,
      });
      const request = new Request(
        "https://enterprise.example.invalid/runner-events",
      );
      authenticated.set(request, { actorId, entrypoint: "web" });
      const scope = await resolver.resolve(request);
      const conversations = createConversationService({ data: appendDatabase });
      const seeded = await createConversationStore(appendDatabase).transaction(
        scope,
        (tx) =>
          tx
            .insert(enterpriseConversations)
            .values({
              tenantId,
              workspaceId,
              principalId,
              threadId,
              storageBackend: "platform",
              backendVersion: 1,
              lastSeq: 0,
            })
            .returning(),
      );
      if (!seeded[0]) throw new Error("RUNNER_EVENT_FIXTURE_SEED_FAILED");
      await conversations.getOrCreate(scope, { threadId });
      await conversations.append(scope, {
        threadId,
        clientMessageKey: `${prefix}-message`,
        content: "Synthetic runner event input",
        attachments: [],
      });

      const expertVersions = new ExpertVersionCatalog(appendDatabase);
      const syntheticExpertVersionRef = await expertVersions.putOrGet(scope, {
        schemaVersion: 1,
        agentId: "synthetic-runner-event-bot",
        source: "user_profile",
        agentType: "built_in",
        systemPrompt: "Synthetic runner event expert.",
        behaviorVersion: "openbot-builtin-v1",
      });
      const admitRun = (input: StartRunInput): TrustedRunAdmission => ({
        input,
        agentId: "synthetic-runner-event-bot",
        expertVersionRef: syntheticExpertVersionRef,
        routeRef: "synthetic-runner-event-route",
      });
      const runs = createRunService({
        data: appendDatabase,
        conversations,
        expertVersions,
        modelRouteFor: async () => ({
          routeRef: "synthetic-runner-event-route",
          maximumTokens: 1000,
        }),
        modelCapabilitySecret:
          "test-only-model-capability-secret-000000000000000000000000000000",
        leaseMilliseconds: 10_000,
      });
      await expect(
        runs.start(
          scope,
          admitRun({
            threadId,
            clientMessageKey: `${prefix}-message`,
            attachmentRefs: [],
            entrypoint: "web",
            forwardedProps: {},
          }),
        ),
      ).rejects.toThrow("RUN_OUTPUT_CEILING_REQUIRED");
      const rejectedPersistenceRows = await createConversationStore(
        appendDatabase,
      ).transaction(scope, (tx) =>
        tx
          .select({
            runId: enterpriseRuns.id,
            attemptId: enterpriseRunAttempts.id,
            reservationId: enterpriseModelBudgetReservations.id,
          })
          .from(enterpriseRuns)
          .leftJoin(
            enterpriseRunAttempts,
            and(
              eq(enterpriseRunAttempts.tenantId, enterpriseRuns.tenantId),
              eq(enterpriseRunAttempts.runId, enterpriseRuns.id),
            ),
          )
          .leftJoin(
            enterpriseModelBudgetReservations,
            and(
              eq(
                enterpriseModelBudgetReservations.tenantId,
                enterpriseRuns.tenantId,
              ),
              eq(enterpriseModelBudgetReservations.runId, enterpriseRuns.id),
            ),
          )
          .where(
            and(
              eq(enterpriseRuns.tenantId, tenantId),
              eq(enterpriseRuns.threadId, threadId),
              eq(enterpriseRuns.clientMessageKey, `${prefix}-message`),
            ),
          ),
      );
      expect(rejectedPersistenceRows).toHaveLength(0);
      const failingCeilingData =
        dataFailingRunCeilingReservation(appendDatabase);
      const failingRuns = createRunService({
        data: failingCeilingData.data,
        conversations,
        expertVersions,
        modelRouteFor: async () => ({
          routeRef: "synthetic-runner-event-route",
          maximumTokens: 1000,
        }),
        modelCapabilitySecret:
          "test-only-model-capability-secret-000000000000000000000000000000",
        leaseMilliseconds: 10_000,
      });
      await expect(
        failingRuns.start(
          scope,
          admitRun({
            threadId,
            clientMessageKey: `${prefix}-message`,
            attachmentRefs: [],
            entrypoint: "web",
            forwardedProps: { maxOutputTokens: 37 },
          }),
        ),
      ).rejects.toThrow("TEST_RUN_CEILING_RESERVATION_FAILED");
      const failedRunId = failingCeilingData.runId();
      expect(failedRunId).toBeString();
      if (!failedRunId) throw new Error("TEST_RUN_ID_NOT_CAPTURED");
      const rollbackState = await createConversationStore(
        appendDatabase,
      ).transaction(scope, async (tx) => ({
        runs: await tx
          .select({ id: enterpriseRuns.id })
          .from(enterpriseRuns)
          .where(
            and(
              eq(enterpriseRuns.tenantId, tenantId),
              eq(enterpriseRuns.id, failedRunId),
            ),
          ),
        attempts: await tx
          .select({ id: enterpriseRunAttempts.id })
          .from(enterpriseRunAttempts)
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, tenantId),
              eq(enterpriseRunAttempts.runId, failedRunId),
            ),
          ),
        outbox: await tx
          .select({ id: enterpriseRunOutbox.id })
          .from(enterpriseRunOutbox)
          .where(
            and(
              eq(enterpriseRunOutbox.tenantId, tenantId),
              eq(enterpriseRunOutbox.runId, failedRunId),
            ),
          ),
        ceiling: await tx
          .select({ id: enterpriseModelBudgetReservations.id })
          .from(enterpriseModelBudgetReservations)
          .where(
            and(
              eq(enterpriseModelBudgetReservations.tenantId, tenantId),
              eq(enterpriseModelBudgetReservations.runId, failedRunId),
              eq(enterpriseModelBudgetReservations.isRunCeiling, true),
            ),
          ),
      }));
      expect(rollbackState).toEqual({
        runs: [],
        attempts: [],
        outbox: [],
        ceiling: [],
      });
      const run = await runs.start(
        scope,
        admitRun({
          threadId,
          clientMessageKey: `${prefix}-message`,
          attachmentRefs: [],
          entrypoint: "web",
          forwardedProps: { maxOutputTokens: 37 },
        }),
      );
      const persistedRun = await createConversationStore(
        appendDatabase,
      ).transaction(scope, (tx) =>
        tx
          .select({
            modelRouteMaximumTokens: enterpriseRuns.modelRouteMaximumTokens,
          })
          .from(enterpriseRuns)
          .where(
            and(
              eq(enterpriseRuns.tenantId, tenantId),
              eq(enterpriseRuns.id, run.run_id),
            ),
          ),
      );
      const persistedCeiling = await createConversationStore(
        appendDatabase,
      ).transaction(scope, (tx) =>
        tx
          .select({ tokenLimit: enterpriseModelBudgetReservations.tokenLimit })
          .from(enterpriseModelBudgetReservations)
          .where(
            and(
              eq(enterpriseModelBudgetReservations.tenantId, tenantId),
              eq(enterpriseModelBudgetReservations.runId, run.run_id),
              eq(enterpriseModelBudgetReservations.isRunCeiling, true),
            ),
          ),
      );
      expect(persistedRun[0]?.modelRouteMaximumTokens).toBe(37);
      expect(persistedCeiling[0]?.tokenLimit).toBe(37);
      const lease = await runs.acquireRequestLease(scope, run.run_id);
      const extendedRunLease = new Date(Date.now() + 60_000);
      await createConversationStore(appendDatabase).transaction(scope, (tx) =>
        tx
          .update(enterpriseRuns)
          .set({ leaseExpiresAt: extendedRunLease })
          .where(
            and(
              eq(enterpriseRuns.tenantId, tenantId),
              eq(enterpriseRuns.id, run.run_id),
            ),
          ),
      );
      await createConversationStore(appendDatabase).transaction(scope, (tx) =>
        tx
          .update(enterpriseRunAttempts)
          .set({ leaseExpiresAt: extendedRunLease })
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, tenantId),
              eq(enterpriseRunAttempts.runId, run.run_id),
              eq(enterpriseRunAttempts.id, lease.attemptId),
              eq(enterpriseRunAttempts.generation, lease.generation),
            ),
          ),
      );

      const firstClaim = await runs.issueModelInvocationCapability(scope, {
        runId: run.run_id,
        attemptId: lease.attemptId,
        generation: lease.generation,
        modelRequestId: `${prefix}-settled-claim`,
        maximumTokens: 16,
      });
      await runs.resolveModelInvocationCapability(scope, firstClaim.capability);
      await runs.confirmModelInvocationUsage(scope, firstClaim.capability, 5);
      const unknownClaim = await runs.issueModelInvocationCapability(scope, {
        runId: run.run_id,
        attemptId: lease.attemptId,
        generation: lease.generation,
        modelRequestId: `${prefix}-unknown-claim`,
        maximumTokens: 20,
      });
      await runs.markModelInvocationUnknown(scope, unknownClaim.capability);
      await expect(
        runs.issueModelInvocationCapability(scope, {
          runId: run.run_id,
          attemptId: lease.attemptId,
          generation: lease.generation,
          modelRequestId: `${prefix}-over-unknown`,
          maximumTokens: 13,
        }),
      ).rejects.toMatchObject({ status: 402, code: "MODEL_BUDGET_EXCEEDED" });
      const racingClaims = await Promise.allSettled([
        runs.issueModelInvocationCapability(scope, {
          runId: run.run_id,
          attemptId: lease.attemptId,
          generation: lease.generation,
          modelRequestId: `${prefix}-race-claim-a`,
          maximumTokens: 7,
        }),
        runs.issueModelInvocationCapability(scope, {
          runId: run.run_id,
          attemptId: lease.attemptId,
          generation: lease.generation,
          modelRequestId: `${prefix}-race-claim-b`,
          maximumTokens: 7,
        }),
      ]);
      expect(
        racingClaims.filter((claim) => claim.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        racingClaims.filter((claim) => claim.status === "rejected"),
      ).toHaveLength(1);
      const rejectedRaceClaim = racingClaims.find(
        (claim): claim is PromiseRejectedResult => claim.status === "rejected",
      );
      expect(rejectedRaceClaim?.reason).toMatchObject({
        status: 402,
        code: "MODEL_BUDGET_EXCEEDED",
      });
      const persistedClaims = await createConversationStore(
        appendDatabase,
      ).transaction(scope, (tx) =>
        tx
          .select({
            modelRequestId:
              enterpriseModelInvocationCapabilities.modelRequestId,
            maximumTokens: enterpriseModelInvocationCapabilities.maximumTokens,
            usedTokens: enterpriseModelInvocationCapabilities.usedTokens,
            status: enterpriseModelInvocationCapabilities.status,
          })
          .from(enterpriseModelInvocationCapabilities)
          .where(
            and(
              eq(enterpriseModelInvocationCapabilities.tenantId, tenantId),
              eq(enterpriseModelInvocationCapabilities.runId, run.run_id),
            ),
          ),
      );
      expect(persistedClaims).toHaveLength(3);
      expect(persistedClaims.map((claim) => claim.status).sort()).toEqual([
        "confirmed",
        "reserved",
        "unknown",
      ]);
      const chargedTokens = persistedClaims.reduce(
        (sum, claim) =>
          sum +
          (claim.status === "confirmed"
            ? claim.usedTokens
            : claim.maximumTokens),
        0,
      );
      expect(chargedTokens).toBeLessThanOrEqual(37);
      expect(persistedClaims).toContainEqual(
        expect.objectContaining({
          modelRequestId: `${prefix}-settled-claim`,
          maximumTokens: 16,
          usedTokens: 5,
          status: "confirmed",
        }),
      );
      expect(persistedClaims).toContainEqual(
        expect.objectContaining({
          modelRequestId: `${prefix}-unknown-claim`,
          maximumTokens: 20,
          status: "unknown",
        }),
      );

      const events = createRunnerEventService({
        repository: createDrizzleRunnerEventRepository(appendDatabase),
      });
      let appendPromise: Promise<unknown> | undefined;
      let appendWaitObserved = false;
      await lockDatabase.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        const [holder] = await tx.execute(sql`select pg_backend_pid() as pid`);
        const holderPid = Number(holder?.pid);
        await tx.execute(
          sql`select id from enterprise_runs where tenant_id = ${tenantId} and id = ${run.run_id} for update`,
        );
        appendPromise = events.append(scope, {
          lease,
          sourceEventId,
          schemaVersion: 1,
          event: { type: "TEXT_MESSAGE_START", messageId: `${prefix}-event` },
        });

        const waitDeadline = Date.now() + 10_000;
        while (Date.now() < waitDeadline) {
          const [waiting] = await tx.execute(sql`
            select activity.pid
            from pg_stat_activity as activity
            where activity.application_name = ${appendApplicationName}
              and activity.wait_event_type = 'Lock'
              and ${holderPid} = any(pg_blocking_pids(activity.pid))
          `);
          if (waiting) {
            appendWaitObserved = true;
            expect(Date.now()).toBeLessThan(lease.expiresAt.getTime());
            break;
          }
          await Bun.sleep(50);
        }
        expect(appendWaitObserved).toBe(true);
        const remainingLeaseMilliseconds =
          lease.expiresAt.getTime() - Date.now();
        if (remainingLeaseMilliseconds > 0)
          await Bun.sleep(remainingLeaseMilliseconds + 100);
      });

      if (!appendPromise) throw new Error("RUNNER_EVENT_APPEND_NOT_STARTED");
      await expect(appendPromise).rejects.toThrow("RUN_ATTEMPT_STALE");
      const eventRows = await createConversationStore(
        appendDatabase,
      ).transaction(scope, (tx) =>
        tx
          .select({ id: enterpriseRunnerEvents.id })
          .from(enterpriseRunnerEvents)
          .where(
            and(
              eq(enterpriseRunnerEvents.tenantId, tenantId),
              eq(enterpriseRunnerEvents.runId, run.run_id),
              eq(enterpriseRunnerEvents.sourceEventId, sourceEventId),
            ),
          ),
      );
      expect(eventRows).toHaveLength(0);
    } catch (error) {
      bodyFailed = true;
      bodyFailure = error;
    } finally {
      if (setupDatabase) {
        try {
          await setupDatabase
            .delete(enterpriseTenants)
            .where(like(enterpriseTenants.id, `${prefix}%`));
        } catch (error) {
          cleanupFailures.push(error);
        }
        try {
          await setupDatabase
            .delete(enterprisePrincipals)
            .where(like(enterprisePrincipals.id, `${prefix}%`));
        } catch (error) {
          cleanupFailures.push(error);
        }
        try {
          await setupDatabase.delete(users).where(like(users.id, `${prefix}%`));
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      for (const database of databases.reverse()) {
        try {
          await database.$client.close();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
    }
    if (cleanupFailures.length) {
      throw new AggregateError(
        bodyFailed ? [bodyFailure, ...cleanupFailures] : cleanupFailures,
        "Runner event fixture cleanup failed.",
      );
    }
    if (bodyFailed) throw bodyFailure;
  },
  30_000,
);
