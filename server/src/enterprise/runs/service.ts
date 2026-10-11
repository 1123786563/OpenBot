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
  RunService,
  StartRunInput,
} from "../contracts";
import { createConversationStore } from "../conversations/store";
import {
  createModelBudgetService,
  reserveModelBudgetInTransaction,
  runCeilingIdempotencyKey,
} from "../models/budget";
import type { DataDatabase } from "../tenancy/connections";
import { assertTrustedScope } from "../tenancy/store";
import { createModelInvocationCapabilityService } from "./model-capability";
import { createRunInTransaction, createRunStore } from "./store";

export interface RunModelRoute {
  readonly expertVersionRef: string;
  readonly routeRef: string;
  readonly maximumTokens: number;
}

export interface RunServiceDependencies {
  readonly data: DataDatabase;
  readonly conversations: ConversationService;
  readonly modelRouteFor: (
    scope: PlatformScope,
    threadId: string,
  ) => Promise<RunModelRoute>;
  readonly configuredBudgetTokens: (
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
}

export function createRunService(deps: RunServiceDependencies): RunService {
  const store = createRunStore(deps.data);
  const scopedStore = createConversationStore(deps.data);
  const budget = createModelBudgetService({
    data: deps.data,
    configuredLimitTokens: deps.configuredBudgetTokens,
  });
  const modelCapabilities = createModelInvocationCapabilityService({
    data: deps.data,
    secret: deps.modelCapabilitySecret,
  });
  const leaseMilliseconds = deps.leaseMilliseconds ?? 30_000;
  if (
    !Number.isSafeInteger(leaseMilliseconds) ||
    leaseMilliseconds < 1000 ||
    leaseMilliseconds > 15 * 60_000
  ) {
    throw new RangeError("RUN_LEASE_DURATION_INVALID");
  }

  return {
    async start(scope: PlatformScope, input: StartRunInput): Promise<RunDTO> {
      assertTrustedScope(scope);
      validateStart(scope, input);
      const backend = await deps.conversations.resolveBackend(
        scope,
        input.threadId,
      );
      if (backend !== "platform") throw new Error("LEGACY_HISTORY_READ_ONLY");
      const route = await deps.modelRouteFor(scope, input.threadId);
      if (
        !route ||
        typeof route.expertVersionRef !== "string" ||
        !route.expertVersionRef.trim() ||
        route.expertVersionRef.length > 200 ||
        typeof route.routeRef !== "string" ||
        !route.routeRef.trim() ||
        route.routeRef.length > 200
      ) {
        throw new Error("MODEL_ROUTE_UNAVAILABLE");
      }
      if (
        !Number.isSafeInteger(route.maximumTokens) ||
        route.maximumTokens <= 0
      ) {
        throw new Error("MODEL_ROUTE_BUDGET_INVALID");
      }
      const configuredLimitTokens = await deps.configuredBudgetTokens(scope);
      return store.transaction(scope, async (tx) => {
        const created = await createRunInTransaction(
          tx,
          scope,
          input,
          route.expertVersionRef,
          route.routeRef,
          route.maximumTokens,
          leaseMilliseconds,
        );
        await reserveModelBudgetInTransaction(
          tx,
          scope,
          {
            runId: created.runId,
            modelRouteRef: route.routeRef,
            maximumTokens: configuredLimitTokens,
          },
          configuredLimitTokens,
          {
            idempotencyKey: runCeilingIdempotencyKey(created.runId),
            expiresAt: created.leaseExpiresAt,
            runCeiling: true,
          },
        );
        return created.run;
      });
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
