import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseConversations,
  enterpriseMessages,
} from "../../db/schema/enterprise-conversations";
import {
  enterpriseModelBudgetReservations,
  enterpriseModelInvocationCapabilities,
  enterpriseRunAttempts,
  enterpriseRunOutbox,
  enterpriseRuns,
} from "../../db/schema/enterprise-runs";
import { mastraMessageIntents } from "../../db/schema/mastra-message-intents";
import type {
  PlatformScope,
  RunDTO,
  RunFailureCode,
  RunnerRequestLease,
  StartRunInput,
} from "../contracts";
import { createConversationStore } from "../conversations/store";
import type { DataDatabase } from "../tenancy/connections";
import { assertTrustedScope } from "../tenancy/store";

type Transaction = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];
type RunRow = typeof enterpriseRuns.$inferSelect;

/** The complete fixed taxonomy of admitted leased Run failure codes. */
const RUN_FAILURE_CODES = [
  "MODEL_EXECUTION_UNAVAILABLE",
  "MODEL_EXECUTION_FAILED",
  "MODEL_SETTLEMENT_FAILED",
  "MODEL_BUDGET_EXCEEDED",
] as const satisfies readonly RunFailureCode[];

/**
 * Runtime membership check for the fixed failure taxonomy. Every leased
 * failure transition — service validator and store guard — admits only these
 * literals; arbitrary strings are rejected before any write.
 */
export function isAdmittedRunFailureCode(
  errorCode: unknown,
): errorCode is RunFailureCode {
  return (
    typeof errorCode === "string" &&
    (RUN_FAILURE_CODES as readonly string[]).includes(errorCode)
  );
}

export function isCurrentRunLeaseSnapshot(
  lease: RunnerRequestLease,
  ownerToken: string | null,
  ownerExpiresAt: Date | null,
  now = new Date(),
): boolean {
  return (
    ownerToken === lease.ownerToken &&
    ownerExpiresAt instanceof Date &&
    ownerExpiresAt.getTime() === lease.expiresAt.getTime() &&
    ownerExpiresAt > now
  );
}

export function runFailureRunLeaseFence(
  scope: PlatformScope,
  lease: RunnerRequestLease,
  errorCode: RunFailureCode,
) {
  return sql`exists (
    select 1 from ${enterpriseRuns}
    where ${enterpriseRuns.tenantId} = ${scope.tenantId}
      and ${enterpriseRuns.workspaceId} = ${scope.workspaceId}
      and ${enterpriseRuns.principalId} = ${scope.principalId}
      and ${enterpriseRuns.id} = ${lease.runId}
      and ${enterpriseRuns.attemptGeneration} = ${lease.generation}
      and ${enterpriseRuns.status} = ${"failed"}
      and ${enterpriseRuns.errorCode} = ${errorCode}
      and ${enterpriseRuns.leaseExpiresAt} > clock_timestamp()
  )`;
}

export function runSuccessRunLeaseFence(
  scope: PlatformScope,
  lease: RunnerRequestLease,
) {
  return sql`exists (
    select 1 from ${enterpriseRuns}
    where ${enterpriseRuns.tenantId} = ${scope.tenantId}
      and ${enterpriseRuns.workspaceId} = ${scope.workspaceId}
      and ${enterpriseRuns.principalId} = ${scope.principalId}
      and ${enterpriseRuns.id} = ${lease.runId}
      and ${enterpriseRuns.attemptGeneration} = ${lease.generation}
      and ${enterpriseRuns.status} = ${"succeeded"}
      and ${enterpriseRuns.errorCode} is null
      and ${enterpriseRuns.leaseExpiresAt} > clock_timestamp()
  )`;
}

// Kept exported for the runner-scope admission tests; production renewal
// paths fence through the transactional predicates instead.
export function isRunnerRequestLeaseCurrent(
  current: RunnerRequestLease,
  expected: Pick<
    RunnerRequestLease,
    "runId" | "attemptId" | "generation" | "ownerToken"
  >,
  now = new Date(),
): boolean {
  return (
    current.runId === expected.runId &&
    current.attemptId === expected.attemptId &&
    current.generation === expected.generation &&
    current.ownerToken === expected.ownerToken &&
    current.expiresAt > now
  );
}

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

/**
 * The hard ceiling on how long a single run may stay alive through lease
 * renewals; matches the upper bound accepted for leaseMilliseconds.
 */
const MAXIMUM_RUN_DURATION_MILLISECONDS = 900_000;

export function validateMastraRunIntent(
  intent:
    | {
        tenantId: string;
        threadId: string;
        clientMessageKey: string;
        digest: string;
        actorId: string;
        principalId: string;
        backendVersion: number;
        attachmentIds: readonly string[];
        state: string;
      }
    | undefined,
  expected: {
    tenantId: string;
    threadId: string;
    clientMessageKey: string;
    digest: string;
    actorId: string;
    principalId: string;
    backendVersion: number;
    attachmentIds: readonly string[];
  },
): void {
  if (
    intent?.state !== "finalized" ||
    intent.tenantId !== expected.tenantId ||
    intent.threadId !== expected.threadId ||
    intent.clientMessageKey !== expected.clientMessageKey ||
    intent.digest !== expected.digest ||
    intent.actorId !== expected.actorId ||
    intent.principalId !== expected.principalId ||
    intent.backendVersion !== expected.backendVersion ||
    JSON.stringify(intent.attachmentIds) !==
      JSON.stringify(expected.attachmentIds)
  ) {
    throw new RunDomainError("RUN_INPUT_NOT_FINALIZED", 409);
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

type ActiveRunLookupRow = {
  run: RunRow;
  attemptId: string;
  attemptGeneration: number;
  attemptStatus: string;
  attemptLeaseExpiresAt: Date;
};

const activeRunStatuses = new Set([
  "queued",
  "running",
  "waiting_approval",
  "suspended",
]);

export function resolveActiveRunLookup(
  scope: PlatformScope,
  threadId: string,
  rows: readonly ActiveRunLookupRow[],
  now = new Date(),
): { run: RunDTO; attemptId: string; generation: number } | null {
  const eligible = rows.filter(
    ({
      run,
      attemptId,
      attemptGeneration,
      attemptStatus,
      attemptLeaseExpiresAt,
    }) =>
      run.tenantId === scope.tenantId &&
      run.workspaceId === scope.workspaceId &&
      run.principalId === scope.principalId &&
      run.threadId === threadId &&
      activeRunStatuses.has(run.status) &&
      run.leaseExpiresAt > now &&
      Boolean(attemptId) &&
      attemptStatus === "active" &&
      attemptGeneration === run.attemptGeneration &&
      attemptLeaseExpiresAt > now,
  );
  if (eligible.length > 1)
    throw new RunDomainError("RUN_ACTIVE_AMBIGUOUS", 409);
  const [match] = eligible;
  return match
    ? {
        run: toRunDTO(match.run),
        attemptId: match.attemptId,
        generation: match.attemptGeneration,
      }
    : null;
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
    .select({
      storageBackend: enterpriseConversations.storageBackend,
      backendVersion: enterpriseConversations.backendVersion,
    })
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
  if (
    !conversation ||
    !["platform", "mastra"].includes(conversation.storageBackend)
  ) {
    throw new RunDomainError(
      "CONVERSATION_FORBIDDEN",
      404,
      "Conversation was not found.",
    );
  }
  if (conversation.storageBackend === "platform") {
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
      JSON.stringify(message.attachments) !==
      JSON.stringify(input.attachmentRefs)
    ) {
      throw new RunDomainError(
        "RUN_ATTACHMENT_CONFLICT",
        409,
        "Run attachment references do not match the submitted message.",
      );
    }
  } else {
    const [intent] = await tx
      .select()
      .from(mastraMessageIntents)
      .where(
        and(
          eq(mastraMessageIntents.tenantId, scope.tenantId),
          eq(mastraMessageIntents.threadId, input.threadId),
          eq(mastraMessageIntents.clientMessageKey, input.clientMessageKey),
        ),
      )
      .limit(1);
    if (!input.messageDigest) {
      throw new RunDomainError("RUN_INPUT_NOT_FINALIZED", 409);
    }
    validateMastraRunIntent(intent, {
      tenantId: scope.tenantId,
      threadId: input.threadId,
      clientMessageKey: input.clientMessageKey,
      digest: input.messageDigest,
      actorId: scope.actorId,
      principalId: scope.principalId,
      backendVersion: conversation.backendVersion,
      attachmentIds: input.attachmentRefs,
    });
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
  const now = new Date();
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
  if (existing) {
    if (existing.leaseExpiresAt.getTime() > now.getTime())
      throw new RunDomainError(
        "ACTIVE_RUN_CONFLICT",
        409,
        "This conversation already has an active run.",
      );
    // An active-status row whose lease expired belongs to a crashed or
    // abandoned process: terminalize it truthfully (cancelled with timeout
    // semantics — its events can no longer settle) in this same
    // transaction, then reclaim the thread for the new run.
    await tx
      .update(enterpriseRuns)
      .set({
        status: "cancelled",
        errorCode: "CANCELLED_TIMEOUT",
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(enterpriseRuns.tenantId, scope.tenantId),
          eq(enterpriseRuns.id, existing.id),
          eq(enterpriseRuns.attemptGeneration, existing.attemptGeneration),
          sql`${enterpriseRuns.status} in ('queued', 'running', 'waiting_approval', 'suspended')`,
        ),
      );
    await tx
      .update(enterpriseRunAttempts)
      .set({ status: "cancelled", finishedAt: now })
      .where(
        and(
          eq(enterpriseRunAttempts.tenantId, scope.tenantId),
          eq(enterpriseRunAttempts.runId, existing.id),
          eq(enterpriseRunAttempts.generation, existing.attemptGeneration),
          eq(enterpriseRunAttempts.status, "active"),
        ),
      );
    await tx.insert(enterpriseRunOutbox).values({
      tenantId: scope.tenantId,
      runId: existing.id,
      eventType: "run.cancel",
      payload: { runId: existing.id, generation: existing.attemptGeneration },
    });
  }
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

export function createRunStore(
  data: DataDatabase,
  options: { leaseMilliseconds?: number } = {},
) {
  const leaseMilliseconds = options.leaseMilliseconds ?? 30_000;
  if (
    !Number.isSafeInteger(leaseMilliseconds) ||
    leaseMilliseconds < 1_000 ||
    leaseMilliseconds > 900_000
  ) {
    throw new RangeError("RUN_LEASE_DURATION_INVALID");
  }
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
    async getActiveForThread(scope: PlatformScope, threadId: string) {
      assertTrustedScope(scope);
      if (
        typeof threadId !== "string" ||
        !threadId.trim() ||
        threadId.length > 200
      ) {
        throw new RunDomainError("INVALID_THREAD_ID", 400);
      }
      const rows = await this.transaction(scope, (tx) =>
        tx
          .select({
            run: enterpriseRuns,
            attemptId: enterpriseRunAttempts.id,
            attemptGeneration: enterpriseRunAttempts.generation,
            attemptStatus: enterpriseRunAttempts.status,
            attemptLeaseExpiresAt: enterpriseRunAttempts.leaseExpiresAt,
          })
          .from(enterpriseRuns)
          .innerJoin(
            enterpriseRunAttempts,
            and(
              eq(enterpriseRunAttempts.tenantId, enterpriseRuns.tenantId),
              eq(enterpriseRunAttempts.runId, enterpriseRuns.id),
              eq(
                enterpriseRunAttempts.generation,
                enterpriseRuns.attemptGeneration,
              ),
            ),
          )
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.workspaceId, scope.workspaceId),
              eq(enterpriseRuns.principalId, scope.principalId),
              eq(enterpriseRuns.threadId, threadId),
              sql`${enterpriseRuns.status} in ('queued', 'running', 'waiting_approval', 'suspended')`,
              sql`${enterpriseRuns.leaseExpiresAt} > now()`,
              eq(enterpriseRunAttempts.status, "active"),
              sql`${enterpriseRunAttempts.leaseExpiresAt} > now()`,
            ),
          )
          .limit(2),
      );
      return resolveActiveRunLookup(scope, threadId, rows);
    },
    async cancel(
      scope: PlatformScope,
      runId: string,
      errorCode = "CANCELLED",
      expectedAttempt?: { attemptId: string; generation: number },
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
        if (
          expectedAttempt &&
          row.attemptGeneration !== expectedAttempt.generation
        ) {
          throw new RunDomainError("RUN_ATTEMPT_STALE", 409);
        }
        if (expectedAttempt) {
          const [attempt] = await tx
            .select({ id: enterpriseRunAttempts.id })
            .from(enterpriseRunAttempts)
            .where(
              and(
                eq(enterpriseRunAttempts.tenantId, scope.tenantId),
                eq(enterpriseRunAttempts.runId, runId),
                eq(enterpriseRunAttempts.id, expectedAttempt.attemptId),
                eq(
                  enterpriseRunAttempts.generation,
                  expectedAttempt.generation,
                ),
                eq(enterpriseRunAttempts.status, "active"),
              ),
            )
            .for("update")
            .limit(1);
          if (!attempt) throw new RunDomainError("RUN_ATTEMPT_STALE", 409);
        }
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
    async acquireRequestLease(
      scope: PlatformScope,
      runId: string,
    ): Promise<RunnerRequestLease> {
      assertTrustedScope(scope);
      if (typeof runId !== "string" || !runId.trim())
        throw new RunDomainError("INVALID_RUN_ID", 400);
      return this.transaction(scope, async (tx) => {
        const [run] = await tx
          .select()
          .from(enterpriseRuns)
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.workspaceId, scope.workspaceId),
              eq(enterpriseRuns.principalId, scope.principalId),
              eq(enterpriseRuns.id, runId),
              sql`${enterpriseRuns.status} in ('queued', 'running', 'waiting_approval', 'suspended')`,
              sql`${enterpriseRuns.leaseExpiresAt} > now()`,
            ),
          )
          .for("update")
          .limit(1);
        if (!run) throw new RunDomainError("RUN_NOT_ACTIVE", 409);
        const [attempt] = await tx
          .select()
          .from(enterpriseRunAttempts)
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, scope.tenantId),
              eq(enterpriseRunAttempts.runId, runId),
              eq(enterpriseRunAttempts.generation, run.attemptGeneration),
              eq(enterpriseRunAttempts.status, "active"),
              sql`${enterpriseRunAttempts.leaseExpiresAt} > now()`,
            ),
          )
          .for("update")
          .limit(1);
        if (!attempt) throw new RunDomainError("RUN_ATTEMPT_STALE", 409);
        if (
          attempt.requestOwnerToken &&
          attempt.requestOwnerExpiresAt &&
          attempt.requestOwnerExpiresAt > new Date()
        ) {
          throw new RunDomainError("RUN_REQUEST_LEASE_HELD", 409);
        }
        const ownerToken = randomUUID();
        const now = new Date();
        const expiresAt = new Date(
          Math.min(
            now.getTime() + leaseMilliseconds,
            run.leaseExpiresAt.getTime(),
          ),
        );
        if (expiresAt <= now)
          throw new RunDomainError("RUN_LEASE_EXPIRED", 409);
        const [claimed] = await tx
          .update(enterpriseRunAttempts)
          .set({
            requestOwnerToken: ownerToken,
            requestOwnerExpiresAt: expiresAt,
          })
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, scope.tenantId),
              eq(enterpriseRunAttempts.runId, runId),
              eq(enterpriseRunAttempts.id, attempt.id),
              eq(enterpriseRunAttempts.generation, run.attemptGeneration),
              eq(enterpriseRunAttempts.status, "active"),
              sql`(${enterpriseRunAttempts.requestOwnerToken} is null or ${enterpriseRunAttempts.requestOwnerExpiresAt} <= ${now})`,
            ),
          )
          .returning();
        if (!claimed) throw new RunDomainError("RUN_REQUEST_LEASE_HELD", 409);
        return {
          runId,
          attemptId: attempt.id,
          generation: attempt.generation,
          ownerToken,
          expiresAt,
        };
      });
    },
    async renewRequestLease(
      scope: PlatformScope,
      lease: RunnerRequestLease,
    ): Promise<RunnerRequestLease> {
      assertTrustedScope(scope);
      return this.transaction(scope, async (tx) => {
        const [run] = await tx
          .select()
          .from(enterpriseRuns)
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.workspaceId, scope.workspaceId),
              eq(enterpriseRuns.principalId, scope.principalId),
              eq(enterpriseRuns.id, lease.runId),
              eq(enterpriseRuns.attemptGeneration, lease.generation),
              sql`${enterpriseRuns.status} in ('queued', 'running', 'waiting_approval', 'suspended')`,
              sql`${enterpriseRuns.leaseExpiresAt} > now()`,
            ),
          )
          .for("update")
          .limit(1);
        if (!run) throw new RunDomainError("RUN_ATTEMPT_STALE", 409);
        const now = new Date();
        // A stream longer than one lease window must stay live: the renewal
        // extends the run's main lease (and the active attempt's) alongside
        // the request claim, capped by the maximum run duration so renewal
        // cannot keep a run alive forever.
        const runLeaseExpiresAt = new Date(
          Math.min(
            now.getTime() + leaseMilliseconds,
            run.createdAt.getTime() + MAXIMUM_RUN_DURATION_MILLISECONDS,
          ),
        );
        if (runLeaseExpiresAt <= now)
          throw new RunDomainError("RUN_LEASE_EXPIRED", 409);
        await tx
          .update(enterpriseRuns)
          .set({ leaseExpiresAt: runLeaseExpiresAt, updatedAt: now })
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.id, lease.runId),
              eq(enterpriseRuns.attemptGeneration, lease.generation),
              sql`${enterpriseRuns.status} in ('queued', 'running', 'waiting_approval', 'suspended')`,
            ),
          );
        const [updated] = await tx
          .update(enterpriseRunAttempts)
          .set({
            requestOwnerExpiresAt: runLeaseExpiresAt,
            leaseExpiresAt: runLeaseExpiresAt,
          })
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, scope.tenantId),
              eq(enterpriseRunAttempts.runId, lease.runId),
              eq(enterpriseRunAttempts.id, lease.attemptId),
              eq(enterpriseRunAttempts.generation, lease.generation),
              eq(enterpriseRunAttempts.status, "active"),
              eq(enterpriseRunAttempts.requestOwnerToken, lease.ownerToken),
              sql`${enterpriseRunAttempts.requestOwnerExpiresAt} > now()`,
            ),
          )
          .returning();
        if (!updated) throw new RunDomainError("RUN_REQUEST_LEASE_STALE", 409);
        return { ...lease, expiresAt: runLeaseExpiresAt };
      });
    },
    async releaseRequestLease(
      scope: PlatformScope,
      lease: RunnerRequestLease,
    ): Promise<boolean> {
      assertTrustedScope(scope);
      return this.transaction(scope, async (tx) => {
        const [released] = await tx
          .update(enterpriseRunAttempts)
          .set({ requestOwnerToken: null, requestOwnerExpiresAt: null })
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, scope.tenantId),
              eq(enterpriseRunAttempts.runId, lease.runId),
              eq(enterpriseRunAttempts.id, lease.attemptId),
              eq(enterpriseRunAttempts.generation, lease.generation),
              eq(enterpriseRunAttempts.status, "active"),
              eq(enterpriseRunAttempts.requestOwnerToken, lease.ownerToken),
            ),
          )
          .returning({ id: enterpriseRunAttempts.id });
        return Boolean(released);
      });
    },
    async currentAttempt(scope: PlatformScope, runId: string) {
      const [row] = await this.transaction(scope, (tx) =>
        tx
          .select({ attempt: enterpriseRunAttempts })
          .from(enterpriseRunAttempts)
          .innerJoin(
            enterpriseRuns,
            and(
              eq(enterpriseRuns.tenantId, enterpriseRunAttempts.tenantId),
              eq(enterpriseRuns.id, enterpriseRunAttempts.runId),
            ),
          )
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.workspaceId, scope.workspaceId),
              eq(enterpriseRuns.principalId, scope.principalId),
              eq(enterpriseRuns.id, runId),
              eq(enterpriseRunAttempts.runId, runId),
              eq(enterpriseRunAttempts.status, "active"),
            ),
          )
          .limit(1),
      );
      if (!row) throw new RunDomainError("RUN_ATTEMPT_NOT_FOUND", 404);
      const attempt = row.attempt;
      return {
        attemptId: attempt.id,
        turnId: attempt.turnId,
        generation: attempt.generation,
        fencingToken: attempt.fencingToken,
        leaseExpiresAt: attempt.leaseExpiresAt,
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
              eq(enterpriseRuns.workspaceId, scope.workspaceId),
              eq(enterpriseRuns.principalId, scope.principalId),
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
        const leaseExpiresAt = new Date(now.getTime() + leaseMilliseconds);
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
              eq(enterpriseRuns.workspaceId, scope.workspaceId),
              eq(enterpriseRuns.principalId, scope.principalId),
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
    /**
     * ME09 (#481): the durable-suspension transition. A run whose engine
     * paused on a durable approval/participation call moves to
     * `waiting_approval` (the approval semantics of Spec §5) or `suspended`
     * (a frontend/participation wait) — both remain ACTIVE statuses, so the
     * capability service keeps minting against the SAME run when the
     * continuation is later resumed. Fenced by the exact request lease the
     * pausing driver holds, the same fencing family
     * {@link transitionTerminal} settles under: a driver that lost its lease
     * can neither mark a suspension nor keep the run alive.
     */
    async markRunSuspended(
      scope: PlatformScope,
      input: {
        lease: RunnerRequestLease;
        status: "waiting_approval" | "suspended";
      },
    ): Promise<boolean> {
      return this.transaction(scope, async (tx) => {
        const [updated] = await tx
          .update(enterpriseRuns)
          .set({ status: input.status, updatedAt: sql`now()` })
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.workspaceId, scope.workspaceId),
              eq(enterpriseRuns.principalId, scope.principalId),
              eq(enterpriseRuns.id, input.lease.runId),
              eq(enterpriseRuns.attemptGeneration, input.lease.generation),
              sql`${enterpriseRuns.status} in ('queued', 'running')`,
              sql`exists (
                select 1 from ${enterpriseRunAttempts}
                where ${enterpriseRunAttempts.tenantId} = ${scope.tenantId}
                  and ${enterpriseRunAttempts.runId} = ${input.lease.runId}
                  and ${enterpriseRunAttempts.id} = ${input.lease.attemptId}
                  and ${enterpriseRunAttempts.generation} = ${input.lease.generation}
                  and ${enterpriseRunAttempts.status} = 'active'
                  and ${enterpriseRunAttempts.requestOwnerToken} = ${input.lease.ownerToken}
                  and ${enterpriseRunAttempts.requestOwnerExpiresAt} > clock_timestamp()
              )`,
            ),
          )
          .returning({ id: enterpriseRuns.id });
        if (!updated) return false;
        await tx.insert(enterpriseRunOutbox).values({
          tenantId: scope.tenantId,
          runId: input.lease.runId,
          eventType: `run.${input.status}`,
          payload: {
            runId: input.lease.runId,
            generation: input.lease.generation,
          },
        });
        return true;
      });
    },
    /**
     * ME10 (#482, F6): the dead-suspension disposition. A run parked
     * `waiting_approval`/`suspended` whose reactivation window
     * (createdAt + MAXIMUM_RUN_DURATION, the exact predicate
     * {@link reactivateSuspensionLease} refuses on) has passed can never be
     * driven again — leaving it waiting forever is the "no driver, no
     * recovery" dead row. This settles such runs FAILED with the named code
     * (the user-visible failure reason), once, and emits the outbox event
     * every transition does. Runs still inside the window — including an
     * approval a person has not decided yet — are left alone: waiting is
     * their CORRECT state until the window actually passes.
     */
    async disposeUnresumableSuspensions(scope: PlatformScope): Promise<number> {
      return this.transaction(scope, async (tx) => {
        const now = new Date();
        const settled = await tx
          .update(enterpriseRuns)
          .set({
            status: "failed",
            errorCode: "SUSPENSION_WINDOW_EXPIRED",
            finishedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.workspaceId, scope.workspaceId),
              eq(enterpriseRuns.principalId, scope.principalId),
              sql`${enterpriseRuns.status} in ('waiting_approval', 'suspended')`,
              sql`${enterpriseRuns.createdAt} + interval '${sql.raw(
                String(MAXIMUM_RUN_DURATION_MILLISECONDS),
              )} milliseconds' <= ${now}`,
            ),
          )
          .returning({ id: enterpriseRuns.id, status: enterpriseRuns.status });
        for (const row of settled) {
          await tx.insert(enterpriseRunOutbox).values({
            tenantId: scope.tenantId,
            runId: row.id,
            eventType: "run.suspension_window_expired",
            payload: { runId: row.id },
          });
        }
        return settled.length;
      });
    },
    /**
     * ME09 (#481): the resume drive's lease re-activation — the runs-service
     * face of "run re-activation" for a durable suspension. ONLY a run still
     * waiting (`waiting_approval`/`suspended`) at its CURRENT attempt may
     * re-arm: a terminal run refuses (the settled-run capability fence stays
     * authoritative), a live request owner refuses (one driver at a time),
     * and the re-armed lease is capped by the same maximum run duration every
     * renewal answers to. Returns the admitted execution facts the resumed
     * loop's governed model re-binds to (the run's OWN route ref and cap —
     * never a caller-supplied route), so capability minting continues against
     * the same run, the same payer and the remaining budget.
     */
    async reactivateSuspensionLease(
      scope: PlatformScope,
      runId: string,
    ): Promise<{
      lease: RunnerRequestLease;
      modelRouteRef: string;
      maximumTokens: number;
      /**
       * ME10: the token total this run has ALREADY spent (confirmed usage
       * plus outstanding capability limits) — the resumed carrier seeds its
       * settlement ledger with it, so the resumed dials ask for the run's
       * REMAINING budget, never the ceiling again.
       */
      settledTokens: number;
    }> {
      return this.transaction(scope, async (tx) => {
        const [run] = await tx
          .select()
          .from(enterpriseRuns)
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.workspaceId, scope.workspaceId),
              eq(enterpriseRuns.principalId, scope.principalId),
              eq(enterpriseRuns.id, runId),
              sql`${enterpriseRuns.status} in ('waiting_approval', 'suspended')`,
            ),
          )
          .for("update")
          .limit(1);
        if (!run)
          throw new RunDomainError(
            "RUN_NOT_ACTIVE",
            409,
            "Only a run still waiting on a durable suspension may re-arm its lease.",
          );
        const [attempt] = await tx
          .select()
          .from(enterpriseRunAttempts)
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, scope.tenantId),
              eq(enterpriseRunAttempts.runId, runId),
              eq(enterpriseRunAttempts.generation, run.attemptGeneration),
              eq(enterpriseRunAttempts.status, "active"),
            ),
          )
          .for("update")
          .limit(1);
        if (!attempt) throw new RunDomainError("RUN_ATTEMPT_STALE", 409);
        const now = new Date();
        if (
          attempt.requestOwnerToken &&
          attempt.requestOwnerExpiresAt &&
          attempt.requestOwnerExpiresAt > now
        ) {
          throw new RunDomainError("RUN_REQUEST_LEASE_HELD", 409);
        }
        const runLeaseExpiresAt = new Date(
          Math.min(
            now.getTime() + leaseMilliseconds,
            run.createdAt.getTime() + MAXIMUM_RUN_DURATION_MILLISECONDS,
          ),
        );
        if (runLeaseExpiresAt <= now)
          throw new RunDomainError("RUN_LEASE_EXPIRED", 409);
        // ME10: the token total this run has already spent — the SAME sum
        // the capability mint's budget gate computes (confirmed usage plus
        // outstanding limits) — so the resumed carrier's ledger starts where
        // the park left off and the resumed dials ask for the REMAINING
        // budget, never the ceiling again.
        const spentRows = await tx
          .select({
            status: enterpriseModelInvocationCapabilities.status,
            usedTokens: enterpriseModelInvocationCapabilities.usedTokens,
            maximumTokens: enterpriseModelInvocationCapabilities.maximumTokens,
          })
          .from(enterpriseModelInvocationCapabilities)
          .where(
            and(
              eq(
                enterpriseModelInvocationCapabilities.tenantId,
                scope.tenantId,
              ),
              eq(
                enterpriseModelInvocationCapabilities.workspaceId,
                scope.workspaceId,
              ),
              eq(
                enterpriseModelInvocationCapabilities.principalId,
                scope.principalId,
              ),
              eq(enterpriseModelInvocationCapabilities.runId, runId),
            ),
          );
        const settledTokens = spentRows.reduce(
          (sum, row) =>
            sum +
            (row.status === "confirmed" ? row.usedTokens : row.maximumTokens),
          0,
        );
        await tx
          .update(enterpriseRuns)
          .set({ leaseExpiresAt: runLeaseExpiresAt, updatedAt: now })
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.id, runId),
              eq(enterpriseRuns.attemptGeneration, run.attemptGeneration),
              sql`${enterpriseRuns.status} in ('waiting_approval', 'suspended')`,
            ),
          );
        await tx
          .update(enterpriseRunAttempts)
          .set({ leaseExpiresAt: runLeaseExpiresAt })
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, scope.tenantId),
              eq(enterpriseRunAttempts.runId, runId),
              eq(enterpriseRunAttempts.id, attempt.id),
              eq(enterpriseRunAttempts.generation, attempt.generation),
              eq(enterpriseRunAttempts.status, "active"),
            ),
          );
        const ownerToken = randomUUID();
        const [claimed] = await tx
          .update(enterpriseRunAttempts)
          .set({
            requestOwnerToken: ownerToken,
            requestOwnerExpiresAt: runLeaseExpiresAt,
          })
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, scope.tenantId),
              eq(enterpriseRunAttempts.runId, runId),
              eq(enterpriseRunAttempts.id, attempt.id),
              eq(enterpriseRunAttempts.generation, attempt.generation),
              eq(enterpriseRunAttempts.status, "active"),
              sql`(${enterpriseRunAttempts.requestOwnerToken} is null or ${enterpriseRunAttempts.requestOwnerExpiresAt} <= ${now.toISOString()})`,
            ),
          )
          .returning({ id: enterpriseRunAttempts.id });
        if (!claimed) throw new RunDomainError("RUN_REQUEST_LEASE_HELD", 409);
        return {
          lease: {
            runId,
            attemptId: attempt.id,
            generation: attempt.generation,
            ownerToken,
            expiresAt: runLeaseExpiresAt,
          },
          modelRouteRef: run.modelRouteRef,
          maximumTokens: run.modelRouteMaximumTokens,
          settledTokens,
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
        requestLease?: RunnerRequestLease;
      },
    ): Promise<boolean> {
      return this.transaction(scope, async (tx) => {
        const leasedTupleAdmitted =
          !input.requestLease ||
          (input.status === "failed" &&
            isAdmittedRunFailureCode(input.errorCode)) ||
          (input.status === "succeeded" && input.errorCode === undefined);
        if (!leasedTupleAdmitted) {
          return false;
        }
        const [run] = await tx
          .select({ attemptGeneration: enterpriseRuns.attemptGeneration })
          .from(enterpriseRuns)
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.workspaceId, scope.workspaceId),
              eq(enterpriseRuns.principalId, scope.principalId),
              eq(enterpriseRuns.id, input.runId),
              ...(input.requestLease
                ? [
                    sql`${enterpriseRuns.leaseExpiresAt} > clock_timestamp()`,
                    sql`${enterpriseRuns.status} in ('queued', 'running', 'waiting_approval', 'suspended')`,
                  ]
                : []),
            ),
          )
          .for("update")
          .limit(1);
        if (!run || run.attemptGeneration !== input.generation) return false;
        const [attempt] = await tx
          .select({
            id: enterpriseRunAttempts.id,
            requestOwnerToken: enterpriseRunAttempts.requestOwnerToken,
            requestOwnerExpiresAt: enterpriseRunAttempts.requestOwnerExpiresAt,
          })
          .from(enterpriseRunAttempts)
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, scope.tenantId),
              eq(enterpriseRunAttempts.runId, input.runId),
              eq(enterpriseRunAttempts.id, input.attemptId),
              eq(enterpriseRunAttempts.generation, input.generation),
              eq(enterpriseRunAttempts.status, "active"),
              input.requestLease
                ? sql`${enterpriseRunAttempts.leaseExpiresAt} > clock_timestamp()`
                : sql`${enterpriseRunAttempts.leaseExpiresAt} > now()`,
              ...(input.requestLease
                ? [
                    eq(
                      enterpriseRunAttempts.requestOwnerToken,
                      input.requestLease.ownerToken,
                    ),
                    eq(
                      enterpriseRunAttempts.requestOwnerExpiresAt,
                      input.requestLease.expiresAt,
                    ),
                    sql`${enterpriseRunAttempts.requestOwnerExpiresAt} > clock_timestamp()`,
                  ]
                : []),
            ),
          )
          .for("update")
          .limit(1);
        if (!attempt) return false;
        if (
          input.requestLease &&
          !isCurrentRunLeaseSnapshot(
            input.requestLease,
            attempt.requestOwnerToken,
            attempt.requestOwnerExpiresAt,
          )
        ) {
          return false;
        }
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
              input.requestLease
                ? sql`${enterpriseRuns.leaseExpiresAt} > clock_timestamp()`
                : sql`${enterpriseRuns.leaseExpiresAt} > now()`,
              sql`${enterpriseRuns.status} in ('queued', 'running', 'waiting_approval', 'suspended')`,
              sql`exists (
                select 1 from enterprise_run_attempts active_attempt
                where active_attempt.tenant_id = ${scope.tenantId}
                  and active_attempt.run_id = ${input.runId}
                  and active_attempt.id = ${input.attemptId}
                  and active_attempt.generation = ${input.generation}
                  and active_attempt.status = 'active'
                  and active_attempt.lease_expires_at > ${input.requestLease ? sql`clock_timestamp()` : sql`now()`}
                  ${input.requestLease ? sql`and active_attempt.request_owner_token = ${input.requestLease.ownerToken} and active_attempt.request_owner_expires_at = ${input.requestLease.expiresAt} and active_attempt.request_owner_expires_at > clock_timestamp()` : sql``}
              )`,
            ),
          )
          .returning();
        if (!updated) return false;
        const [completedAttempt] = await tx
          .update(enterpriseRunAttempts)
          .set({
            status: "completed",
            finishedAt: sql`now()`,
            ...(input.requestLease
              ? { requestOwnerToken: null, requestOwnerExpiresAt: null }
              : {}),
          })
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, scope.tenantId),
              eq(enterpriseRunAttempts.id, input.attemptId),
              eq(enterpriseRunAttempts.status, "active"),
              input.requestLease
                ? sql`${enterpriseRunAttempts.leaseExpiresAt} > clock_timestamp()`
                : sql`${enterpriseRunAttempts.leaseExpiresAt} > now()`,
              ...(input.requestLease
                ? [
                    eq(
                      enterpriseRunAttempts.requestOwnerToken,
                      input.requestLease.ownerToken,
                    ),
                    eq(
                      enterpriseRunAttempts.requestOwnerExpiresAt,
                      input.requestLease.expiresAt,
                    ),
                    sql`${enterpriseRunAttempts.requestOwnerExpiresAt} > clock_timestamp()`,
                    input.status === "succeeded"
                      ? runSuccessRunLeaseFence(scope, input.requestLease)
                      : runFailureRunLeaseFence(
                          scope,
                          input.requestLease,
                          // The leased-tuple guard above admitted only fixed
                          // failure codes, so this is the validated code.
                          input.errorCode as RunFailureCode,
                        ),
                  ]
                : []),
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
