import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { isPositiveInt32TokenCount } from "./output-ceiling";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  enterpriseModelBudgetReservations,
  enterpriseModelInvocationCapabilities,
  enterpriseRunAttempts,
  enterpriseRuns,
} from "../../db/schema/enterprise-runs";
import type {
  ModelInvocationCapability,
  ModelInvocationCapabilityInput,
  ModelInvocationContext,
  PlatformScope,
} from "../contracts";
import { createConversationStore } from "../conversations/store";
import { runCeilingIdempotencyKey } from "../models/budget";
import type { DataDatabase } from "../tenancy/connections";
import { hasActiveAttemptLease } from "./store";

type Transaction = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];
type CapabilityRow = typeof enterpriseModelInvocationCapabilities.$inferSelect;

export class ModelInvocationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message = code) {
    super(message);
    this.name = "ModelInvocationError";
    this.code = code;
    this.status = status;
  }
}

function canonicalCapability(row: {
  tenantId: string;
  workspaceId: string;
  principalId: string;
  runId: string;
  attemptId: string;
  generation: number;
  modelRouteRef: string;
  modelRequestId: string;
  maximumTokens: number;
  expiresAt: Date;
  capabilityNonce: string;
}): string {
  return JSON.stringify([
    row.tenantId,
    row.workspaceId,
    row.principalId,
    row.runId,
    row.attemptId,
    row.generation,
    row.modelRouteRef,
    row.modelRequestId,
    row.maximumTokens,
    row.expiresAt.toISOString(),
    row.capabilityNonce,
  ]);
}

function createCapability(
  secret: Uint8Array,
  row: Parameters<typeof canonicalCapability>[0],
) {
  return createHmac("sha256", secret)
    .update(canonicalCapability(row))
    .digest("base64url");
}

function digestCapability(capability: string): string {
  return createHash("sha256").update(capability).digest("hex");
}

function capabilityDto(
  row: CapabilityRow,
  capability: string,
): ModelInvocationCapability {
  return {
    capability,
    model_request_id: row.modelRequestId,
    maximum_tokens: row.maximumTokens,
    expires_at: row.expiresAt.toISOString(),
  };
}

function invocationContext(row: CapabilityRow): ModelInvocationContext {
  return {
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    runId: row.runId,
    attemptId: row.attemptId,
    generation: row.generation,
    modelRouteRef: row.modelRouteRef,
    modelRequestId: row.modelRequestId,
    maximumTokens: row.maximumTokens,
    expiresAt: row.expiresAt.toISOString(),
  };
}

function validateCapabilityInput(input: ModelInvocationCapabilityInput): void {
  if (
    !input ||
    typeof input.runId !== "string" ||
    !input.runId.trim() ||
    typeof input.attemptId !== "string" ||
    !input.attemptId.trim() ||
    !Number.isSafeInteger(input.generation) ||
    input.generation <= 0 ||
    typeof input.modelRequestId !== "string" ||
    !input.modelRequestId.trim() ||
    input.modelRequestId.length > 200 ||
    !isPositiveInt32TokenCount(input.maximumTokens)
  ) {
    throw new ModelInvocationError(
      "INVALID_MODEL_INVOCATION_INPUT",
      400,
      "Invalid model invocation capability input.",
    );
  }
}

async function loadByCapability(
  tx: Transaction,
  scope: PlatformScope,
  capability: string,
): Promise<CapabilityRow> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) {
    throw new ModelInvocationError("MODEL_CAPABILITY_INVALID", 401);
  }
  const [row] = await tx
    .select()
    .from(enterpriseModelInvocationCapabilities)
    .where(
      and(
        eq(enterpriseModelInvocationCapabilities.tenantId, scope.tenantId),
        eq(
          enterpriseModelInvocationCapabilities.workspaceId,
          scope.workspaceId,
        ),
        eq(
          enterpriseModelInvocationCapabilities.principalId,
          scope.principalId,
        ),
        eq(
          enterpriseModelInvocationCapabilities.capabilityDigest,
          digestCapability(capability),
        ),
      ),
    )
    .for("update")
    .limit(1);
  if (!row) throw new ModelInvocationError("MODEL_CAPABILITY_INVALID", 401);
  return row;
}

function assertCapabilityOwner(row: CapabilityRow, scope: PlatformScope): void {
  if (
    row.tenantId !== scope.tenantId ||
    row.workspaceId !== scope.workspaceId ||
    row.principalId !== scope.principalId
  ) {
    throw new ModelInvocationError("MODEL_CAPABILITY_INVALID", 401);
  }
}

export function createModelInvocationCapabilityService(deps: {
  data: DataDatabase;
  secret: string | Uint8Array;
}) {
  const store = createConversationStore(deps.data);
  const secret =
    typeof deps.secret === "string"
      ? Buffer.from(deps.secret, "utf8")
      : deps.secret;
  if (secret.byteLength < 32)
    throw new RangeError("MODEL_CAPABILITY_SECRET_TOO_SHORT");

  const assertCapabilityAuthentic = (
    row: CapabilityRow,
    capability: string,
  ) => {
    const expectedCapability = Buffer.from(
      createCapability(secret, row),
      "utf8",
    );
    const presentedCapability = Buffer.from(capability, "utf8");
    if (
      expectedCapability.length !== presentedCapability.length ||
      !timingSafeEqual(expectedCapability, presentedCapability)
    ) {
      throw new ModelInvocationError("MODEL_CAPABILITY_INVALID", 401);
    }
  };

  return {
    async issue(
      scope: PlatformScope,
      input: ModelInvocationCapabilityInput,
    ): Promise<ModelInvocationCapability> {
      validateCapabilityInput(input);
      return store.transaction(scope, async (tx) => {
        const [run] = await tx
          .select()
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
        if (!run)
          throw new ModelInvocationError(
            "RUN_NOT_FOUND",
            404,
            "Run was not found.",
          );
        if (
          !["queued", "running", "waiting_approval", "suspended"].includes(
            run.status,
          )
        ) {
          throw new ModelInvocationError("RUN_NOT_ACTIVE", 409);
        }
        const [attempt] = await tx
          .select()
          .from(enterpriseRunAttempts)
          .where(
            and(
              eq(enterpriseRunAttempts.tenantId, scope.tenantId),
              eq(enterpriseRunAttempts.runId, input.runId),
              eq(enterpriseRunAttempts.id, input.attemptId),
              eq(enterpriseRunAttempts.generation, input.generation),
              eq(enterpriseRunAttempts.status, "active"),
              eq(enterpriseRunAttempts.generation, run.attemptGeneration),
            ),
          )
          .limit(1);
        if (!attempt) throw new ModelInvocationError("RUN_ATTEMPT_STALE", 409);
        if (
          !(await hasActiveAttemptLease(tx, scope, {
            runId: run.id,
            attemptId: attempt.id,
            generation: attempt.generation,
          }))
        )
          throw new ModelInvocationError("RUN_ATTEMPT_STALE", 409);
        if (input.maximumTokens > run.modelRouteMaximumTokens)
          throw new ModelInvocationError(
            "MODEL_ROUTE_BUDGET_EXCEEDED",
            402,
            "The request exceeds the locked model route limit.",
          );

        const now = new Date();
        const [existing] = await tx
          .select()
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
              eq(enterpriseModelInvocationCapabilities.runId, input.runId),
              eq(
                enterpriseModelInvocationCapabilities.modelRequestId,
                input.modelRequestId,
              ),
            ),
          )
          .limit(1);
        if (existing) {
          if (
            existing.attemptId !== input.attemptId ||
            existing.generation !== input.generation ||
            existing.modelRouteRef !== run.modelRouteRef ||
            existing.maximumTokens !== input.maximumTokens
          ) {
            throw new ModelInvocationError(
              "MODEL_REQUEST_IDEMPOTENCY_CONFLICT",
              409,
            );
          }
          if (existing.expiresAt <= now) {
            if (existing.status !== "reserved")
              throw new ModelInvocationError("MODEL_CAPABILITY_EXPIRED", 410);
            const expiresAt = new Date(
              Math.min(
                now.getTime() + 10 * 60_000,
                run.leaseExpiresAt.getTime(),
                attempt.leaseExpiresAt.getTime(),
              ),
            );
            if (expiresAt <= now)
              throw new ModelInvocationError("MODEL_CAPABILITY_EXPIRED", 410);
            const renewedCapability = createCapability(secret, {
              ...existing,
              expiresAt,
            });
            const [renewed] = await tx
              .update(enterpriseModelInvocationCapabilities)
              .set({
                capabilityDigest: digestCapability(renewedCapability),
                expiresAt,
                updatedAt: now,
              })
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
                  eq(enterpriseModelInvocationCapabilities.runId, run.id),
                  eq(enterpriseModelInvocationCapabilities.id, existing.id),
                  eq(enterpriseModelInvocationCapabilities.status, "reserved"),
                  sql`${enterpriseModelInvocationCapabilities.expiresAt} <= now()`,
                ),
              )
              .returning();
            if (!renewed)
              throw new ModelInvocationError(
                "MODEL_CAPABILITY_UNAVAILABLE",
                409,
              );
            return capabilityDto(renewed, renewedCapability);
          }
          return capabilityDto(existing, createCapability(secret, existing));
        }

        const [ceiling] = await tx
          .select({ tokenLimit: enterpriseModelBudgetReservations.tokenLimit })
          .from(enterpriseModelBudgetReservations)
          .where(
            and(
              eq(enterpriseModelBudgetReservations.tenantId, scope.tenantId),
              eq(
                enterpriseModelBudgetReservations.workspaceId,
                scope.workspaceId,
              ),
              eq(
                enterpriseModelBudgetReservations.principalId,
                scope.principalId,
              ),
              eq(enterpriseModelBudgetReservations.runId, input.runId),
              eq(
                enterpriseModelBudgetReservations.idempotencyKey,
                runCeilingIdempotencyKey(input.runId),
              ),
              eq(enterpriseModelBudgetReservations.isRunCeiling, true),
            ),
          )
          .limit(1);
        if (!ceiling)
          throw new ModelInvocationError("RUN_BUDGET_CEILING_NOT_FOUND", 500);
        const otherReservations = await tx
          .select({
            tokenLimit: enterpriseModelBudgetReservations.tokenLimit,
            confirmedTokens: enterpriseModelBudgetReservations.confirmedTokens,
            status: enterpriseModelBudgetReservations.status,
          })
          .from(enterpriseModelBudgetReservations)
          .where(
            and(
              eq(enterpriseModelBudgetReservations.tenantId, scope.tenantId),
              eq(
                enterpriseModelBudgetReservations.workspaceId,
                scope.workspaceId,
              ),
              eq(
                enterpriseModelBudgetReservations.principalId,
                scope.principalId,
              ),
              eq(enterpriseModelBudgetReservations.runId, input.runId),
              eq(enterpriseModelBudgetReservations.isRunCeiling, false),
              inArray(enterpriseModelBudgetReservations.status, [
                "reserved",
                "confirmed",
              ]),
            ),
          );
        const invocationClaims = await tx
          .select({
            maximumTokens: enterpriseModelInvocationCapabilities.maximumTokens,
            usedTokens: enterpriseModelInvocationCapabilities.usedTokens,
            status: enterpriseModelInvocationCapabilities.status,
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
              eq(enterpriseModelInvocationCapabilities.runId, input.runId),
              inArray(enterpriseModelInvocationCapabilities.status, [
                "reserved",
                "consumed",
                "unknown",
                "confirmed",
              ]),
            ),
          );
        const spent =
          otherReservations.reduce(
            (sum, row) =>
              sum +
              (row.status === "confirmed"
                ? row.confirmedTokens
                : row.tokenLimit),
            0,
          ) +
          invocationClaims.reduce(
            (sum, row) =>
              sum +
              (row.status === "confirmed" ? row.usedTokens : row.maximumTokens),
            0,
          );
        if (input.maximumTokens > ceiling.tokenLimit - spent)
          throw new ModelInvocationError(
            "MODEL_BUDGET_EXCEEDED",
            402,
            "The configured model budget has been exceeded.",
          );

        const expiresAt = new Date(
          Math.min(
            now.getTime() + 10 * 60_000,
            run.leaseExpiresAt.getTime(),
            attempt.leaseExpiresAt.getTime(),
          ),
        );
        if (expiresAt <= now)
          throw new ModelInvocationError("MODEL_CAPABILITY_EXPIRED", 410);
        const binding = {
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          principalId: scope.principalId,
          runId: run.id,
          attemptId: attempt.id,
          generation: attempt.generation,
          modelRouteRef: run.modelRouteRef,
          modelRequestId: input.modelRequestId,
          maximumTokens: input.maximumTokens,
          expiresAt,
          capabilityNonce: randomBytes(32).toString("base64url"),
        };
        const capability = createCapability(secret, binding);
        const [row] = await tx
          .insert(enterpriseModelInvocationCapabilities)
          .values({
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            runId: run.id,
            attemptId: attempt.id,
            generation: attempt.generation,
            modelRouteRef: run.modelRouteRef,
            modelRequestId: input.modelRequestId,
            capabilityDigest: digestCapability(capability),
            capabilityNonce: binding.capabilityNonce,
            maximumTokens: input.maximumTokens,
            expiresAt,
          })
          .returning();
        if (!row) throw new Error("MODEL_CAPABILITY_CREATE_FAILED");
        return capabilityDto(row, capability);
      });
    },

    async resolve(
      scope: PlatformScope,
      capability: string,
    ): Promise<ModelInvocationContext> {
      return store.transaction(scope, async (tx) => {
        if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) {
          throw new ModelInvocationError("MODEL_CAPABILITY_INVALID", 401);
        }
        const originalDigest = digestCapability(capability);
        const [candidate] = await tx
          .select()
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
              eq(
                enterpriseModelInvocationCapabilities.capabilityDigest,
                originalDigest,
              ),
            ),
          )
          .limit(1);
        if (!candidate)
          throw new ModelInvocationError("MODEL_CAPABILITY_INVALID", 401);
        const [run] = await tx
          .select()
          .from(enterpriseRuns)
          .where(
            and(
              eq(enterpriseRuns.tenantId, scope.tenantId),
              eq(enterpriseRuns.workspaceId, scope.workspaceId),
              eq(enterpriseRuns.principalId, scope.principalId),
              eq(enterpriseRuns.id, candidate.runId),
            ),
          )
          .for("update")
          .limit(1);
        if (!run)
          throw new ModelInvocationError("MODEL_CAPABILITY_UNAVAILABLE", 409);
        const [row] = await tx
          .select()
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
              eq(enterpriseModelInvocationCapabilities.id, candidate.id),
              eq(enterpriseModelInvocationCapabilities.runId, candidate.runId),
              eq(
                enterpriseModelInvocationCapabilities.capabilityDigest,
                originalDigest,
              ),
            ),
          )
          .for("update")
          .limit(1);
        if (!row)
          throw new ModelInvocationError("MODEL_CAPABILITY_INVALID", 401);
        assertCapabilityAuthentic(row, capability);
        assertCapabilityOwner(row, scope);
        if (
          row.runId !== candidate.runId ||
          row.attemptId !== candidate.attemptId ||
          row.generation !== candidate.generation ||
          row.modelRouteRef !== candidate.modelRouteRef ||
          row.modelRequestId !== candidate.modelRequestId ||
          row.maximumTokens !== candidate.maximumTokens
        ) {
          throw new ModelInvocationError("MODEL_CAPABILITY_INVALID", 401);
        }
        if (
          !["queued", "running", "waiting_approval", "suspended"].includes(
            run.status,
          ) ||
          run.attemptGeneration !== row.generation ||
          run.modelRouteRef !== row.modelRouteRef ||
          row.maximumTokens > run.modelRouteMaximumTokens
        ) {
          throw new ModelInvocationError("MODEL_CAPABILITY_UNAVAILABLE", 409);
        }
        const now = new Date();
        if (row.status !== "reserved") {
          throw new ModelInvocationError("MODEL_CAPABILITY_UNAVAILABLE", 409);
        }
        if (
          !(await hasActiveAttemptLease(tx, scope, {
            runId: run.id,
            attemptId: row.attemptId,
            generation: row.generation,
          }))
        )
          throw new ModelInvocationError("MODEL_CAPABILITY_UNAVAILABLE", 409);
        const [consumed] = await tx
          .update(enterpriseModelInvocationCapabilities)
          .set({ status: "consumed", updatedAt: now })
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
              eq(enterpriseModelInvocationCapabilities.runId, run.id),
              eq(enterpriseModelInvocationCapabilities.id, row.id),
              eq(
                enterpriseModelInvocationCapabilities.attemptId,
                row.attemptId,
              ),
              eq(
                enterpriseModelInvocationCapabilities.generation,
                row.generation,
              ),
              eq(
                enterpriseModelInvocationCapabilities.modelRouteRef,
                row.modelRouteRef,
              ),
              eq(
                enterpriseModelInvocationCapabilities.modelRequestId,
                row.modelRequestId,
              ),
              eq(
                enterpriseModelInvocationCapabilities.maximumTokens,
                row.maximumTokens,
              ),
              eq(
                enterpriseModelInvocationCapabilities.capabilityDigest,
                originalDigest,
              ),
              eq(enterpriseModelInvocationCapabilities.status, "reserved"),
              sql`${enterpriseModelInvocationCapabilities.expiresAt} > now()`,
            ),
          )
          .returning();
        if (!consumed)
          throw new ModelInvocationError("MODEL_CAPABILITY_UNAVAILABLE", 409);
        return invocationContext(consumed);
      });
    },

    async confirmUsage(
      scope: PlatformScope,
      capability: string,
      usedTokens: number,
    ): Promise<void> {
      if (
        !Number.isSafeInteger(usedTokens) ||
        usedTokens < 0 ||
        usedTokens > 2_147_483_647
      ) {
        throw new ModelInvocationError("INVALID_MODEL_USAGE", 400);
      }
      await store.transaction(scope, async (tx) => {
        const row = await loadByCapability(tx, scope, capability);
        assertCapabilityAuthentic(row, capability);
        assertCapabilityOwner(row, scope);
        if (row.status === "confirmed") {
          if (row.usedTokens !== usedTokens)
            throw new ModelInvocationError("MODEL_USAGE_CONFLICT", 409);
          return;
        }
        if (row.status !== "consumed")
          throw new ModelInvocationError("MODEL_CAPABILITY_UNAVAILABLE", 409);
        if (usedTokens > row.maximumTokens)
          throw new ModelInvocationError("MODEL_BUDGET_EXCEEDED", 402);
        const [updated] = await tx
          .update(enterpriseModelInvocationCapabilities)
          .set({ status: "confirmed", usedTokens, updatedAt: new Date() })
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
              eq(enterpriseModelInvocationCapabilities.runId, row.runId),
              eq(enterpriseModelInvocationCapabilities.id, row.id),
              eq(enterpriseModelInvocationCapabilities.status, "consumed"),
            ),
          )
          .returning({ id: enterpriseModelInvocationCapabilities.id });
        if (!updated)
          throw new ModelInvocationError("MODEL_CAPABILITY_UNAVAILABLE", 409);
      });
    },

    async markUnknown(scope: PlatformScope, capability: string): Promise<void> {
      await store.transaction(scope, async (tx) => {
        const row = await loadByCapability(tx, scope, capability);
        assertCapabilityAuthentic(row, capability);
        assertCapabilityOwner(row, scope);
        if (row.status === "unknown") return;
        if (row.status !== "reserved" && row.status !== "consumed")
          throw new ModelInvocationError("MODEL_CAPABILITY_UNAVAILABLE", 409);
        await tx
          .update(enterpriseModelInvocationCapabilities)
          .set({ status: "unknown", updatedAt: new Date() })
          .where(
            and(
              eq(
                enterpriseModelInvocationCapabilities.tenantId,
                scope.tenantId,
              ),
              eq(enterpriseModelInvocationCapabilities.id, row.id),
              inArray(enterpriseModelInvocationCapabilities.status, [
                "reserved",
                "consumed",
              ]),
            ),
          );
      });
    },

    async release(scope: PlatformScope, capability: string): Promise<void> {
      await store.transaction(scope, async (tx) => {
        const row = await loadByCapability(tx, scope, capability);
        assertCapabilityAuthentic(row, capability);
        assertCapabilityOwner(row, scope);
        if (row.status === "released") return;
        if (row.status !== "reserved")
          throw new ModelInvocationError("MODEL_CAPABILITY_UNAVAILABLE", 409);
        await tx
          .update(enterpriseModelInvocationCapabilities)
          .set({ status: "released", updatedAt: new Date() })
          .where(
            and(
              eq(
                enterpriseModelInvocationCapabilities.tenantId,
                scope.tenantId,
              ),
              eq(enterpriseModelInvocationCapabilities.id, row.id),
              eq(enterpriseModelInvocationCapabilities.status, "reserved"),
            ),
          );
      });
    },
  };
}
