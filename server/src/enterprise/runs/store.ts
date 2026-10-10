import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseConversations,
  enterpriseMessages,
} from "../../db/schema/enterprise-conversations";
import {
  enterpriseModelBudgetReservations,
  enterpriseRunAttempts,
  enterpriseRunOutbox,
  enterpriseRuns,
} from "../../db/schema/enterprise-runs";
import type { PlatformScope, RunDTO, StartRunInput } from "../contracts";
import { createConversationStore } from "../conversations/store";
import type { DataDatabase } from "../tenancy/connections";
import { assertTrustedScope } from "../tenancy/store";

type Transaction = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];
type RunRow = typeof enterpriseRuns.$inferSelect;

export async function hasActiveAttemptLease(
  tx: Transaction,
  scope: PlatformScope,
  input: { runId: string; attemptId: string; generation: number },
): Promise<boolean> {
  const [active] = await tx
    .select({ id: enterpriseRunAttempts.id })
    .from(enterpriseRuns)
    .innerJoin(
      enterpriseRunAttempts,
      and(
        eq(enterpriseRunAttempts.tenantId, enterpriseRuns.tenantId),
        eq(enterpriseRunAttempts.runId, enterpriseRuns.id),
      ),
    )
    .where(
      and(
        eq(enterpriseRuns.tenantId, scope.tenantId),
        eq(enterpriseRuns.workspaceId, scope.workspaceId),
        eq(enterpriseRuns.principalId, scope.principalId),
        eq(enterpriseRuns.id, input.runId),
        sql`${enterpriseRuns.status} in ('queued', 'running', 'waiting_approval', 'suspended')`,
        eq(enterpriseRuns.attemptGeneration, input.generation),
        sql`${enterpriseRuns.leaseExpiresAt} > now()`,
        eq(enterpriseRunAttempts.id, input.attemptId),
        eq(enterpriseRunAttempts.generation, input.generation),
        eq(enterpriseRunAttempts.status, "active"),
        sql`${enterpriseRunAttempts.leaseExpiresAt} > now()`,
      ),
    )
    .limit(1);
  return Boolean(active);
}

export class RunDomainError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message = code) {
    super(message);
    this.name = "RunDomainError";
    this.code = code;
    this.status = status;
  }
}

export function toRunDTO(row: RunRow): RunDTO {
  return {
    run_id: row.id,
    thread_id: row.threadId,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    ...(row.finishedAt
      ? { finished_at: row.finishedAt.toISOString() }
      : { finished_at: null }),
    ...(row.errorCode ? { error_code: row.errorCode } : {}),
  };
}

export async function createRunInTransaction(
  tx: Transaction,
  scope: PlatformScope,
  input: StartRunInput,
  expertVersionRef: string,
  modelRouteRef: string,
  modelRouteMaximumTokens: number,
  leaseMs: number,
): Promise<{
  run: RunDTO;
  runId: string;
  attemptId: string;
  generation: number;
  leaseExpiresAt: Date;
}> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["enterprise-run-start", scope.tenantId, input.threadId])}, 0))`,
  );
  const [conversation] = await tx
    .select({ storageBackend: enterpriseConversations.storageBackend })
    .from(enterpriseConversations)
    .where(
      and(
        eq(enterpriseConversations.tenantId, scope.tenantId),
        eq(enterpriseConversations.workspaceId, scope.workspaceId),
        eq(enterpriseConversations.principalId, scope.principalId),
        eq(enterpriseConversations.threadId, input.threadId),
      ),
    )
    .limit(1);
  if (conversation?.storageBackend !== "platform") {
    throw new RunDomainError(
      "CONVERSATION_FORBIDDEN",
      404,
      "Conversation was not found.",
    );
  }
  const [message] = await tx
    .select({
      id: enterpriseMessages.id,
      attachments: enterpriseMessages.attachments,
    })
    .from(enterpriseMessages)
    .where(
      and(
        eq(enterpriseMessages.tenantId, scope.tenantId),
        eq(enterpriseMessages.threadId, input.threadId),
        eq(enterpriseMessages.clientMessageKey, input.clientMessageKey),
      ),
    )
    .limit(1);
  if (!message)
    throw new RunDomainError(
      "RUN_INPUT_NOT_FOUND",
      404,
      "The submitted message was not found.",
    );
  if (
    JSON.stringify(message.attachments) !== JSON.stringify(input.attachmentRefs)
  ) {
    throw new RunDomainError(
      "RUN_ATTACHMENT_CONFLICT",
      409,
      "Run attachment references do not match the submitted message.",
    );
  }
  const [priorSubmission] = await tx
    .select({ id: enterpriseRuns.id })
    .from(enterpriseRuns)
    .where(
      and(
        eq(enterpriseRuns.tenantId, scope.tenantId),
        eq(enterpriseRuns.threadId, input.threadId),
        eq(enterpriseRuns.clientMessageKey, input.clientMessageKey),
      ),
    )
    .limit(1);
  if (priorSubmission) {
    throw new RunDomainError(
      "RUN_IDEMPOTENCY_CONFLICT",
      409,
      "This submitted message already has a run.",
    );
  }
  const [existing] = await tx
    .select()
    .from(enterpriseRuns)
    .where(
      and(
        eq(enterpriseRuns.tenantId, scope.tenantId),
        eq(enterpriseRuns.threadId, input.threadId),
        sql`${enterpriseRuns.status} in ('queued', 'running', 'waiting_approval', 'suspended')`,
      ),
    )
    .limit(1);
  if (existing)
    throw new RunDomainError(
      "ACTIVE_RUN_CONFLICT",
      409,
      "This conversation already has an active run.",
    );

  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const runId = randomUUID();
  const attemptId = randomUUID();
  const generation = 1;
  const [row] = await tx
    .insert(enterpriseRuns)
    .values({
      id: runId,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      principalId: scope.principalId,
      threadId: input.threadId,
      clientMessageKey: input.clientMessageKey,
      expertVersionRef,
      modelRouteRef,
      modelRouteMaximumTokens,
      status: "queued",
      attemptGeneration: generation,
      leaseExpiresAt,
    })
    .returning();
  if (!row) throw new Error("RUN_CREATE_FAILED");
  await tx.insert(enterpriseRunAttempts).values({
    id: attemptId,
    tenantId: scope.tenantId,
    runId,
    generation,
    fencingToken: generation,
    leaseExpiresAt,
  });
  await tx.insert(enterpriseRunOutbox).values({
    tenantId: scope.tenantId,
    runId,
    eventType: "run.start",
    payload: { runId, threadId: input.threadId, attemptId, generation },
  });
  return { run: toRunDTO(row), runId, attemptId, generation, leaseExpiresAt };
}

export function createRunStore(data: DataDatabase) {
  const scopeStore = createConversationStore(data);
  return {
    transaction<T>(
      scope: PlatformScope,
      operation: (tx: Transaction) => Promise<T>,
    ) {
      assertTrustedScope(scope);
      return scopeStore.transaction(scope, operation);
    },
    async get(scope: PlatformScope, runId: string): Promise<RunDTO> {
      const [row] = await this.transaction(scope, (tx) =>
        tx
          .select()
          .from(enterpriseRuns)
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.workspaceId, scope.workspaceId),
              eq(enterpriseRuns.principalId, scope.principalId),
              eq(enterpriseRuns.id, runId),
            ),
          )
          .limit(1),
      );
      if (!row)
        throw new RunDomainError("RUN_NOT_FOUND", 404, "Run was not found.");
      return toRunDTO(row);
    },
    async cancel(
      scope: PlatformScope,
      runId: string,
      errorCode = "CANCELLED",
    ): Promise<RunDTO> {
      return this.transaction(scope, async (tx) => {
        const [row] = await tx
          .select()
          .from(enterpriseRuns)
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.workspaceId, scope.workspaceId),
              eq(enterpriseRuns.principalId, scope.principalId),
              eq(enterpriseRuns.id, runId),
            ),
          )
          .for("update")
          .limit(1);
        if (!row)
          throw new RunDomainError("RUN_NOT_FOUND", 404, "Run was not found.");
        if (["succeeded", "failed", "cancelled"].includes(row.status))
          return toRunDTO(row);
        const now = new Date();
        const [updated] = await tx
          .update(enterpriseRuns)
          .set({
            status: "cancelled",
            errorCode,
            finishedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.id, runId),
              eq(enterpriseRuns.attemptGeneration, row.attemptGeneration),
              sql`${enterpriseRuns.status} in ('queued', 'running', 'waiting_approval', 'suspended')`,
            ),
          )
          .returning();
        if (!updated)
          throw new RunDomainError(
            "RUN_STATE_CONFLICT",
            409,
            "Run state changed concurrently.",
          );
        await tx
          .update(enterpriseRunAttempts)
          .set({ status: "cancelled", finishedAt: now })
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, scope.tenantId),
              eq(enterpriseRunAttempts.runId, runId),
              eq(enterpriseRunAttempts.generation, row.attemptGeneration),
              eq(enterpriseRunAttempts.status, "active"),
            ),
          );
        await tx.insert(enterpriseRunOutbox).values({
          tenantId: scope.tenantId,
          runId,
          eventType: "run.cancel",
          payload: { runId, generation: row.attemptGeneration },
        });
        return toRunDTO(updated);
      });
    },
    async currentAttempt(scope: PlatformScope, runId: string) {
      const [row] = await this.transaction(scope, (tx) =>
        tx
          .select()
          .from(enterpriseRunAttempts)
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, scope.tenantId),
              eq(enterpriseRunAttempts.runId, runId),
              eq(enterpriseRunAttempts.status, "active"),
            ),
          )
          .limit(1),
      );
      if (!row) throw new RunDomainError("RUN_ATTEMPT_NOT_FOUND", 404);
      return {
        attemptId: row.id,
        turnId: row.turnId,
        generation: row.generation,
        fencingToken: row.fencingToken,
        leaseExpiresAt: row.leaseExpiresAt,
      };
    },
    async expireLease(scope: PlatformScope, runId: string, now = new Date()) {
      return this.transaction(scope, async (tx) => {
        const [run] = await tx
          .select()
          .from(enterpriseRuns)
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.id, runId),
            ),
          )
          .for("update")
          .limit(1);
        if (
          !run ||
          !["queued", "running", "waiting_approval", "suspended"].includes(
            run.status,
          )
        )
          throw new RunDomainError("RUN_NOT_ACTIVE", 409);
        if (run.leaseExpiresAt > now)
          throw new RunDomainError("RUN_LEASE_ACTIVE", 409);
        const [oldAttempt] = await tx
          .update(enterpriseRunAttempts)
          .set({ status: "expired", finishedAt: now })
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, scope.tenantId),
              eq(enterpriseRunAttempts.runId, runId),
              eq(enterpriseRunAttempts.generation, run.attemptGeneration),
              eq(enterpriseRunAttempts.status, "active"),
            ),
          )
          .returning();
        if (!oldAttempt) throw new RunDomainError("RUN_ATTEMPT_STALE", 409);
        const generation = run.attemptGeneration + 1;
        const leaseExpiresAt = new Date(now.getTime() + 30_000);
        const [updated] = await tx
          .update(enterpriseRuns)
          .set({
            attemptGeneration: generation,
            leaseExpiresAt,
            updatedAt: now,
          })
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.id, runId),
              eq(enterpriseRuns.attemptGeneration, run.attemptGeneration),
            ),
          )
          .returning();
        if (!updated) throw new RunDomainError("RUN_FENCED", 409);
        const [attempt] = await tx
          .insert(enterpriseRunAttempts)
          .values({
            tenantId: scope.tenantId,
            runId,
            generation,
            fencingToken: generation,
            leaseExpiresAt,
          })
          .returning();
        if (!attempt) throw new Error("RUN_ATTEMPT_CREATE_FAILED");
        await tx.insert(enterpriseRunOutbox).values({
          tenantId: scope.tenantId,
          runId,
          eventType: "run.lease_expired",
          payload: { runId, generation },
        });
        return {
          attemptId: attempt.id,
          turnId: attempt.turnId,
          generation,
          fencingToken: attempt.fencingToken,
          leaseExpiresAt,
        };
      });
    },
    async transitionTerminal(
      scope: PlatformScope,
      input: {
        runId: string;
        attemptId: string;
        generation: number;
        status: "succeeded" | "failed";
        errorCode?: string;
      },
    ): Promise<boolean> {
      return this.transaction(scope, async (tx) => {
        const [run] = await tx
          .select({ attemptGeneration: enterpriseRuns.attemptGeneration })
          .from(enterpriseRuns)
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.workspaceId, scope.workspaceId),
              eq(enterpriseRuns.principalId, scope.principalId),
              eq(enterpriseRuns.id, input.runId),
            ),
          )
          .for("update")
          .limit(1);
        if (!run || run.attemptGeneration !== input.generation) return false;
        const [attempt] = await tx
          .select({ id: enterpriseRunAttempts.id })
          .from(enterpriseRunAttempts)
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, scope.tenantId),
              eq(enterpriseRunAttempts.runId, input.runId),
              eq(enterpriseRunAttempts.id, input.attemptId),
              eq(enterpriseRunAttempts.generation, input.generation),
              eq(enterpriseRunAttempts.status, "active"),
              sql`${enterpriseRunAttempts.leaseExpiresAt} > now()`,
            ),
          )
          .for("update")
          .limit(1);
        if (!attempt) return false;
        const [updated] = await tx
          .update(enterpriseRuns)
          .set({
            status: input.status,
            errorCode: input.errorCode ?? null,
            finishedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.id, input.runId),
              eq(enterpriseRuns.attemptGeneration, input.generation),
              sql`${enterpriseRuns.leaseExpiresAt} > now()`,
              sql`${enterpriseRuns.status} in ('queued', 'running', 'waiting_approval', 'suspended')`,
              sql`exists (
                select 1 from enterprise_run_attempts active_attempt
                where active_attempt.tenant_id = ${scope.tenantId}
                  and active_attempt.run_id = ${input.runId}
                  and active_attempt.id = ${input.attemptId}
                  and active_attempt.generation = ${input.generation}
                  and active_attempt.status = 'active'
                  and active_attempt.lease_expires_at > now()
              )`,
            ),
          )
          .returning();
        if (!updated) return false;
        const [completedAttempt] = await tx
          .update(enterpriseRunAttempts)
          .set({ status: "completed", finishedAt: sql`now()` })
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, scope.tenantId),
              eq(enterpriseRunAttempts.id, input.attemptId),
              eq(enterpriseRunAttempts.status, "active"),
              sql`${enterpriseRunAttempts.leaseExpiresAt} > now()`,
            ),
          )
          .returning({ id: enterpriseRunAttempts.id });
        if (!completedAttempt)
          throw new RunDomainError(
            "RUN_ATTEMPT_TERMINAL_RACE",
            409,
            "Run attempt changed while terminal state was being committed.",
          );
        await tx.insert(enterpriseRunOutbox).values({
          tenantId: scope.tenantId,
          runId: input.runId,
          eventType: `run.${input.status}`,
          payload: { runId: input.runId, generation: input.generation },
        });
        return true;
      });
    },
    async countBudgetReservations(
      scope: PlatformScope,
      clientMessageKey: string,
    ): Promise<number> {
      return this.transaction(scope, async (tx) => {
        const [row] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(enterpriseModelBudgetReservations)
          .innerJoin(
            enterpriseRuns,
            and(
              eq(
                enterpriseRuns.tenantId,
                enterpriseModelBudgetReservations.tenantId,
              ),
              eq(enterpriseRuns.id, enterpriseModelBudgetReservations.runId),
            ),
          )
          .where(
            and(
              eq(enterpriseModelBudgetReservations.tenantId, scope.tenantId),
              eq(enterpriseRuns.clientMessageKey, clientMessageKey),
            ),
          );
        return row?.count ?? 0;
      });
    },
    async countOutboxEvents(
      scope: PlatformScope,
      runId: string,
      eventType: string,
    ): Promise<number> {
      return this.transaction(scope, async (tx) => {
        const [row] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(enterpriseRunOutbox)
          .where(
            and(
              eq(enterpriseRunOutbox.tenantId, scope.tenantId),
              eq(enterpriseRunOutbox.runId, runId),
              eq(enterpriseRunOutbox.eventType, eventType),
            ),
          );
        return row?.count ?? 0;
      });
    },
  };
}
