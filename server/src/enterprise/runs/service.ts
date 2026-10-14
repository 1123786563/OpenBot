import { and, eq } from "drizzle-orm";
import {
  enterpriseRunAttempts,
  enterpriseRuns,
} from "../../db/schema/enterprise-runs";
import type {
  BudgetInput,
  BudgetReservation,
  CancelRunInput,
  ConversationService,
  ModelInvocationCapabilityInput,
  PlatformScope,
  RunDTO,
  RunFailureCode,
  RunnerRequestLease,
  RunService,
  StartRunInput,
  TrustedRunAdmission,
} from "../contracts";
import { createConversationStore } from "../conversations/store";
import type { ExpertVersionCatalog } from "../experts/version-catalog";
import {
  createModelBudgetService,
  reserveModelBudgetInTransaction,
  runCeilingIdempotencyKey,
} from "../models/budget";
import type { DataDatabase } from "../tenancy/connections";
import { assertTrustedScope } from "../tenancy/store";
import { createModelInvocationCapabilityService } from "./model-capability";
import { runOutputCeilingFromInput } from "./output-ceiling";
import {
  createRunInTransaction,
  createRunStore,
  isAdmittedRunFailureCode,
} from "./store";

export interface RunModelRoute {
  readonly routeRef: string;
  readonly maximumTokens: number;
}

export function validateRunFailureInput(input: {
  lease: RunnerRequestLease;
  errorCode: RunFailureCode;
}): void {
  const lease = input?.lease;
  if (
    !lease ||
    typeof lease.runId !== "string" ||
    !lease.runId.trim() ||
    typeof lease.attemptId !== "string" ||
    !lease.attemptId.trim() ||
    !Number.isSafeInteger(lease.generation) ||
    lease.generation <= 0 ||
    typeof lease.ownerToken !== "string" ||
    !lease.ownerToken.trim() ||
    !(lease.expiresAt instanceof Date) ||
    !Number.isFinite(lease.expiresAt.getTime()) ||
    lease.expiresAt.getTime() <= Date.now() ||
    !isAdmittedRunFailureCode(input.errorCode)
  ) {
    throw new Error("INVALID_RUN_FAILURE_INPUT");
  }
}

export async function failRunWithLease(
  scope: PlatformScope,
  input: { lease: RunnerRequestLease; errorCode: RunFailureCode },
  transition: (
    scope: PlatformScope,
    input: { lease: RunnerRequestLease; errorCode: RunFailureCode },
  ) => Promise<boolean>,
): Promise<boolean> {
  assertTrustedScope(scope);
  validateRunFailureInput(input);
  return transition(scope, input);
}

export function validateRunSuccessInput(input: {
  lease: RunnerRequestLease;
}): void {
  const lease = input?.lease;
  if (
    !lease ||
    typeof lease.runId !== "string" ||
    !lease.runId.trim() ||
    typeof lease.attemptId !== "string" ||
    !lease.attemptId.trim() ||
    !Number.isSafeInteger(lease.generation) ||
    lease.generation <= 0 ||
    typeof lease.ownerToken !== "string" ||
    !lease.ownerToken.trim() ||
    !(lease.expiresAt instanceof Date) ||
    !Number.isFinite(lease.expiresAt.getTime()) ||
    lease.expiresAt.getTime() <= Date.now()
  ) {
    throw new Error("INVALID_RUN_SUCCESS_INPUT");
  }
}

/**
 * Stop input is validated with the same shape discipline as the leased
 * failure/success paths: a malformed runId/attemptId/generation/reason
 * never reaches the store (M-i).
 */
export function validateStopInput(
  input: CancelRunInput & { attemptId: string; generation: number },
): void {
  if (
    !input ||
    typeof input.runId !== "string" ||
    !input.runId.trim() ||
    input.runId.length > 200 ||
    typeof input.attemptId !== "string" ||
    !input.attemptId.trim() ||
    input.attemptId.length > 200 ||
    !Number.isSafeInteger(input.generation) ||
    input.generation <= 0 ||
    !["user_requested", "timeout", "superseded"].includes(input.reason)
  ) {
    throw new Error("INVALID_STOP_INPUT");
  }
}

export async function completeRunWithLease(
  scope: PlatformScope,
  input: { lease: RunnerRequestLease },
  transition: (
    scope: PlatformScope,
    input: { lease: RunnerRequestLease },
  ) => Promise<boolean>,
): Promise<boolean> {
  assertTrustedScope(scope);
  validateRunSuccessInput(input);
  return transition(scope, input);
}

export interface RunServiceDependencies {
  readonly data: DataDatabase;
  readonly conversations: ConversationService;
  readonly expertVersions: Pick<ExpertVersionCatalog, "resolveInTransaction">;
  readonly modelRouteFor: (
    scope: PlatformScope,
    threadId: string,
  ) => Promise<RunModelRoute>;
  readonly configuredBudgetTokens?: (
    scope: PlatformScope,
  ) => number | Promise<number>;
  readonly modelCapabilitySecret: string | Uint8Array;
  readonly leaseMilliseconds?: number;
}

function validateStart(scope: PlatformScope, input: StartRunInput): void {
  if (!input || typeof input !== "object") throw new Error("INVALID_RUN_INPUT");
  if (
    typeof input.threadId !== "string" ||
    !input.threadId.trim() ||
    input.threadId.length > 200
  )
    throw new Error("INVALID_THREAD_ID");
  if (
    typeof input.clientMessageKey !== "string" ||
    !input.clientMessageKey.trim() ||
    input.clientMessageKey.length > 200
  )
    throw new Error("INVALID_CLIENT_MESSAGE_KEY");
  if (
    !Array.isArray(input.attachmentRefs) ||
    input.attachmentRefs.some(
      (value) => typeof value !== "string" || !value.trim(),
    ) ||
    input.attachmentRefs.length > 100
  )
    throw new Error("INVALID_ATTACHMENT_REFS");
  if (input.entrypoint !== scope.entrypoint)
    throw new Error("ENTRYPOINT_SCOPE_MISMATCH");
  runOutputCeilingFromInput(input);
}

export function createRunService(deps: RunServiceDependencies): RunService {
  const leaseMilliseconds = deps.leaseMilliseconds ?? 30_000;
  if (
    !Number.isSafeInteger(leaseMilliseconds) ||
    leaseMilliseconds < 1000 ||
    leaseMilliseconds > 15 * 60_000
  ) {
    throw new RangeError("RUN_LEASE_DURATION_INVALID");
  }
  const store = createRunStore(deps.data, { leaseMilliseconds });
  const scopedStore = createConversationStore(deps.data);
  const budget = createModelBudgetService({ data: deps.data });
  const modelCapabilities = createModelInvocationCapabilityService({
    data: deps.data,
    secret: deps.modelCapabilitySecret,
  });

  return {
    async start(
      scope: PlatformScope,
      admission: TrustedRunAdmission,
    ): Promise<RunDTO> {
      assertTrustedScope(scope);
      if (!admission || typeof admission !== "object" || !admission.input)
        throw new Error("INVALID_RUN_ADMISSION");
      const input: StartRunInput = admission.input;
      validateStart(scope, input);
      const runOutputCeiling = runOutputCeilingFromInput(input);
      const backend = await deps.conversations.resolveBackend(
        scope,
        input.threadId,
      );
      if (backend === "intelligence")
        throw new Error("LEGACY_HISTORY_READ_ONLY");
      const route = await deps.modelRouteFor(scope, input.threadId);
      if (
        !route ||
        typeof route.routeRef !== "string" ||
        !route.routeRef.trim() ||
        route.routeRef.length > 200
      ) {
        throw new Error("MODEL_ROUTE_UNAVAILABLE");
      }
      if (admission.routeRef !== route.routeRef)
        throw new Error("RUN_ROUTE_MISMATCH");
      return store.transaction(scope, async (tx) => {
        const verified = await deps.expertVersions.resolveInTransaction(
          scope,
          tx,
          admission.expertVersionRef,
        );
        if (!verified) throw new Error("EXPERT_VERSION_NOT_FOUND");
        if (verified.agentId !== admission.agentId)
          throw new Error("EXPERT_AGENT_MISMATCH");
        const created = await createRunInTransaction(
          tx,
          scope,
          input,
          verified.expertVersionRef,
          route.routeRef,
          runOutputCeiling,
          leaseMilliseconds,
        );
        await reserveModelBudgetInTransaction(
          tx,
          scope,
          {
            runId: created.runId,
            modelRouteRef: route.routeRef,
            maximumTokens: runOutputCeiling,
          },
          {
            idempotencyKey: runCeilingIdempotencyKey(created.runId),
            expiresAt: created.leaseExpiresAt,
            runCeiling: true,
          },
        );
        return created.run;
      });
    },
    getActiveForThread(scope: PlatformScope, threadId: string) {
      assertTrustedScope(scope);
      if (
        typeof threadId !== "string" ||
        !threadId.trim() ||
        threadId.length > 200
      ) {
        throw new Error("INVALID_THREAD_ID");
      }
      return store.getActiveForThread(scope, threadId);
    },
    async cancel(scope: PlatformScope, input: CancelRunInput): Promise<RunDTO> {
      assertTrustedScope(scope);
      if (
        !input ||
        !["user_requested", "timeout", "superseded"].includes(input.reason)
      )
        throw new Error("INVALID_CANCEL_REASON");
      return store.cancel(
        scope,
        input.runId,
        `CANCELLED_${input.reason.toUpperCase()}`,
      );
    },
    async stop(
      scope: PlatformScope,
      input: CancelRunInput & { attemptId: string; generation: number },
    ): Promise<RunDTO> {
      assertTrustedScope(scope);
      validateStopInput(input);
      return store.cancel(
        scope,
        input.runId,
        `CANCELLED_${input.reason.toUpperCase()}`,
        { attemptId: input.attemptId, generation: input.generation },
      );
    },
    acquireRequestLease(scope: PlatformScope, runId: string) {
      assertTrustedScope(scope);
      return store.acquireRequestLease(scope, runId);
    },
    renewRequestLease(scope: PlatformScope, lease: RunnerRequestLease) {
      assertTrustedScope(scope);
      return store.renewRequestLease(scope, lease);
    },
    releaseRequestLease(scope: PlatformScope, lease: RunnerRequestLease) {
      assertTrustedScope(scope);
      return store.releaseRequestLease(scope, lease);
    },
    fail(
      scope: PlatformScope,
      input: { lease: RunnerRequestLease; errorCode: RunFailureCode },
    ) {
      return failRunWithLease(scope, input, (trustedScope, failure) =>
        store.transitionTerminal(trustedScope, {
          runId: failure.lease.runId,
          attemptId: failure.lease.attemptId,
          generation: failure.lease.generation,
          status: "failed",
          errorCode: failure.errorCode,
          requestLease: failure.lease,
        }),
      );
    },
    complete(scope: PlatformScope, input: { lease: RunnerRequestLease }) {
      return completeRunWithLease(scope, input, (trustedScope, completion) =>
        store.transitionTerminal(trustedScope, {
          runId: completion.lease.runId,
          attemptId: completion.lease.attemptId,
          generation: completion.lease.generation,
          status: "succeeded",
          requestLease: completion.lease,
        }),
      );
    },
    get(scope: PlatformScope, runId: string): Promise<RunDTO> {
      assertTrustedScope(scope);
      if (typeof runId !== "string" || !runId.trim())
        throw new Error("INVALID_RUN_ID");
      return store.get(scope, runId);
    },
    async getActiveAttemptGeneration(
      scope: PlatformScope,
      runId: string,
      attemptId: string,
    ): Promise<number> {
      assertTrustedScope(scope);
      return scopedStore.transaction(scope, async (tx) => {
        const [run] = await tx
          .select({ generation: enterpriseRuns.attemptGeneration })
          .from(enterpriseRuns)
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.workspaceId, scope.workspaceId),
              eq(enterpriseRuns.principalId, scope.principalId),
              eq(enterpriseRuns.id, runId),
            ),
          )
          .limit(1);
        if (!run) throw new Error("RUN_NOT_FOUND");
        const [attempt] = await tx
          .select({ generation: enterpriseRunAttempts.generation })
          .from(enterpriseRunAttempts)
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, scope.tenantId),
              eq(enterpriseRunAttempts.runId, runId),
              eq(enterpriseRunAttempts.id, attemptId),
              eq(enterpriseRunAttempts.status, "active"),
              eq(enterpriseRunAttempts.generation, run.generation),
            ),
          )
          .limit(1);
        if (!attempt) throw new Error("RUN_ATTEMPT_STALE");
        return attempt.generation;
      });
    },
    reserveModelBudget(
      scope: PlatformScope,
      input: BudgetInput,
    ): Promise<BudgetReservation> {
      assertTrustedScope(scope);
      return budget.reserveModelBudget(scope, input);
    },
    issueModelInvocationCapability(
      scope: PlatformScope,
      input: ModelInvocationCapabilityInput,
    ) {
      assertTrustedScope(scope);
      return modelCapabilities.issue(scope, input);
    },
    resolveModelInvocationCapability(scope: PlatformScope, capability: string) {
      assertTrustedScope(scope);
      return modelCapabilities.resolve(scope, capability);
    },
    confirmModelInvocationUsage(
      scope: PlatformScope,
      capability: string,
      usedTokens: number,
    ) {
      assertTrustedScope(scope);
      return modelCapabilities.confirmUsage(scope, capability, usedTokens);
    },
    markModelInvocationUnknown(scope: PlatformScope, capability: string) {
      assertTrustedScope(scope);
      return modelCapabilities.markUnknown(scope, capability);
    },
    releaseModelInvocation(scope: PlatformScope, capability: string) {
      assertTrustedScope(scope);
      return modelCapabilities.release(scope, capability);
    },
  };
}
