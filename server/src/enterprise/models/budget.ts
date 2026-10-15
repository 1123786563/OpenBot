import { and, eq, inArray } from "drizzle-orm";
import {
  enterpriseModelBudgetReservations,
  enterpriseModelInvocationCapabilities,
  enterpriseRuns,
} from "../../db/schema/enterprise-runs";
import type {
  BudgetInput,
  BudgetReservation,
  PlatformScope,
} from "../contracts";
import { createConversationStore } from "../conversations/store";
import { isPositiveInt32TokenCount } from "../runs/output-ceiling";
import type { DataDatabase } from "../tenancy/connections";
import { assertTrustedScope } from "../tenancy/store";

type Transaction = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];

async function lockOwnedReservation(
  tx: Transaction,
  scope: PlatformScope,
  reservationId: string,
) {
  const [result] = await tx
    .select({ reservation: enterpriseModelBudgetReservations })
    .from(enterpriseModelBudgetReservations)
    .innerJoin(
      enterpriseRuns,
      and(
        eq(enterpriseRuns.tenantId, enterpriseModelBudgetReservations.tenantId),
        eq(enterpriseRuns.id, enterpriseModelBudgetReservations.runId),
        eq(enterpriseRuns.workspaceId, scope.workspaceId),
        eq(enterpriseRuns.principalId, scope.principalId),
      ),
    )
    .where(
      and(
        eq(enterpriseModelBudgetReservations.tenantId, scope.tenantId),
        eq(enterpriseModelBudgetReservations.workspaceId, scope.workspaceId),
        eq(enterpriseModelBudgetReservations.principalId, scope.principalId),
        eq(enterpriseModelBudgetReservations.id, reservationId),
      ),
    )
    .for("update", { of: enterpriseModelBudgetReservations })
    .limit(1);
  return result?.reservation;
}

export function runCeilingIdempotencyKey(runId: string): string {
  return `run-ceiling:${runId}`;
}

export class ModelBudgetError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ModelBudgetError";
    this.code = code;
    this.status = status;
  }
}

function assertTokens(value: number, name: string): void {
  if (!isPositiveInt32TokenCount(value)) {
    throw new ModelBudgetError(
      "INVALID_BUDGET",
      400,
      `${name} must be a positive integer.`,
    );
  }
}

function reservationDto(
  row: typeof enterpriseModelBudgetReservations.$inferSelect,
): BudgetReservation {
  return {
    reservationId: row.id,
    runId: row.runId,
    tokenLimit: row.tokenLimit,
    expiresAt: row.expiresAt.toISOString(),
  };
}

export function assertRunBudgetClaim(
  runCeilingTokens: number,
  existingClaims: readonly {
    readonly reservedTokens: number;
    readonly settledTokens?: number;
  }[],
  requestedTokens: number,
): void {
  assertTokens(runCeilingTokens, "runCeilingTokens");
  assertTokens(requestedTokens, "maximumTokens");
  let spentTokens = 0;
  for (const claim of existingClaims) {
    assertTokens(claim.reservedTokens, "reservedTokens");
    const accountedTokens = claim.settledTokens ?? claim.reservedTokens;
    if (
      !Number.isSafeInteger(accountedTokens) ||
      accountedTokens < 0 ||
      accountedTokens > 2_147_483_647
    ) {
      throw new ModelBudgetError(
        "INVALID_BUDGET",
        400,
        "An existing model claim is invalid.",
      );
    }
    spentTokens += accountedTokens;
    if (!Number.isSafeInteger(spentTokens)) {
      throw new ModelBudgetError(
        "MODEL_BUDGET_EXCEEDED",
        402,
        "The Run token ceiling has been exhausted.",
      );
    }
  }
  if (requestedTokens > runCeilingTokens - spentTokens) {
    throw new ModelBudgetError(
      "MODEL_BUDGET_EXCEEDED",
      402,
      "The Run token ceiling has been exhausted.",
    );
  }
}

type ReserveModelBudgetOptions = {
  idempotencyKey?: string;
  expiresAt?: Date;
  runCeiling?: boolean;
  /** Per-tenant configured ceiling a run-ceiling reservation must not exceed. */
  configuredLimitTokens?: number;
};

export async function reserveModelBudgetInTransaction(
  tx: Transaction,
  scope: PlatformScope,
  input: BudgetInput,
  options: ReserveModelBudgetOptions = {},
): Promise<BudgetReservation> {
  assertTokens(input.maximumTokens, "maximumTokens");
  if (options.configuredLimitTokens !== undefined)
    assertTokens(options.configuredLimitTokens, "configuredLimitTokens");
  const runCeiling = options.runCeiling ?? false;
  const canonicalCeilingKey = runCeiling
    ? runCeilingIdempotencyKey(input.runId)
    : undefined;
  if (
    runCeiling &&
    options.idempotencyKey !== undefined &&
    options.idempotencyKey !== canonicalCeilingKey
  ) {
    throw new ModelBudgetError(
      "RUN_BUDGET_CEILING_KEY_INVALID",
      409,
      "A run's configured token ceiling uses its canonical key.",
    );
  }
  if (
    runCeiling &&
    options.configuredLimitTokens !== undefined &&
    input.maximumTokens > options.configuredLimitTokens
  ) {
    throw new ModelBudgetError(
      "RUN_BUDGET_LIMIT_EXCEEDED",
      400,
      "A run's configured token ceiling cannot exceed its configured limit.",
    );
  }
  const idempotencyKey =
    canonicalCeilingKey ?? options.idempotencyKey ?? `run:${input.runId}`;
  if (!idempotencyKey.trim() || idempotencyKey.length > 200) {
    throw new ModelBudgetError(
      "INVALID_IDEMPOTENCY_KEY",
      400,
      "Invalid budget idempotency key.",
    );
  }
  const [run] = await tx
    .select({
      workspaceId: enterpriseRuns.workspaceId,
      principalId: enterpriseRuns.principalId,
    })
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
    throw new ModelBudgetError("RUN_NOT_FOUND", 404, "Run was not found.");
  const [existing] = await tx
    .select()
    .from(enterpriseModelBudgetReservations)
    .where(
      and(
        eq(enterpriseModelBudgetReservations.tenantId, scope.tenantId),
        eq(enterpriseModelBudgetReservations.workspaceId, scope.workspaceId),
        eq(enterpriseModelBudgetReservations.principalId, scope.principalId),
        eq(enterpriseModelBudgetReservations.runId, input.runId),
        eq(enterpriseModelBudgetReservations.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) {
    if (
      existing.runId !== input.runId ||
      existing.modelRouteRef !== input.modelRouteRef ||
      existing.tokenLimit !== input.maximumTokens ||
      existing.isRunCeiling !== runCeiling
    ) {
      throw new ModelBudgetError(
        "BUDGET_IDEMPOTENCY_CONFLICT",
        409,
        "Budget idempotency key was used with different inputs.",
      );
    }
    return reservationDto(existing);
  }

  if (runCeiling) {
    const [row] = await tx
      .insert(enterpriseModelBudgetReservations)
      .values({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        principalId: scope.principalId,
        runId: input.runId,
        idempotencyKey,
        modelRouteRef: input.modelRouteRef,
        tokenLimit: input.maximumTokens,
        isRunCeiling: true,
        expiresAt: options.expiresAt ?? new Date(Date.now() + 15 * 60_000),
      })
      .onConflictDoNothing()
      .returning();
    if (!row)
      throw new ModelBudgetError(
        "BUDGET_IDEMPOTENCY_CONFLICT",
        409,
        "Budget idempotency key was used with different inputs.",
      );
    return reservationDto(row);
  }

  const rows = await tx
    .select({
      tokenLimit: enterpriseModelBudgetReservations.tokenLimit,
      confirmedTokens: enterpriseModelBudgetReservations.confirmedTokens,
      status: enterpriseModelBudgetReservations.status,
    })
    .from(enterpriseModelBudgetReservations)
    .where(
      and(
        eq(enterpriseModelBudgetReservations.tenantId, scope.tenantId),
        eq(enterpriseModelBudgetReservations.workspaceId, scope.workspaceId),
        eq(enterpriseModelBudgetReservations.principalId, scope.principalId),
        eq(enterpriseModelBudgetReservations.runId, input.runId),
        eq(enterpriseModelBudgetReservations.isRunCeiling, false),
        inArray(enterpriseModelBudgetReservations.status, [
          "reserved",
          "confirmed",
        ]),
      ),
    );
  const claims = await tx
    .select({
      maximumTokens: enterpriseModelInvocationCapabilities.maximumTokens,
      usedTokens: enterpriseModelInvocationCapabilities.usedTokens,
      status: enterpriseModelInvocationCapabilities.status,
    })
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
        eq(enterpriseModelInvocationCapabilities.runId, input.runId),
        inArray(enterpriseModelInvocationCapabilities.status, [
          "reserved",
          "consumed",
          "unknown",
          "confirmed",
        ]),
      ),
    );
  const [ceiling] = await tx
    .select({ tokenLimit: enterpriseModelBudgetReservations.tokenLimit })
    .from(enterpriseModelBudgetReservations)
    .where(
      and(
        eq(enterpriseModelBudgetReservations.tenantId, scope.tenantId),
        eq(enterpriseModelBudgetReservations.workspaceId, scope.workspaceId),
        eq(enterpriseModelBudgetReservations.principalId, scope.principalId),
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
    throw new ModelBudgetError(
      "RUN_BUDGET_CEILING_NOT_FOUND",
      409,
      "A run's configured token ceiling is missing.",
    );
  assertRunBudgetClaim(
    ceiling.tokenLimit,
    [
      ...rows.map((row) => ({
        reservedTokens: row.tokenLimit,
        ...(row.status === "confirmed"
          ? { settledTokens: row.confirmedTokens }
          : {}),
      })),
      ...claims.map((row) => ({
        reservedTokens: row.maximumTokens,
        ...(row.status === "confirmed"
          ? { settledTokens: row.usedTokens }
          : {}),
      })),
    ],
    input.maximumTokens,
  );
  const [row] = await tx
    .insert(enterpriseModelBudgetReservations)
    .values({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      principalId: scope.principalId,
      runId: input.runId,
      idempotencyKey,
      modelRouteRef: input.modelRouteRef,
      tokenLimit: input.maximumTokens,
      expiresAt: options.expiresAt ?? new Date(Date.now() + 15 * 60_000),
    })
    .onConflictDoNothing()
    .returning();
  if (!row)
    throw new ModelBudgetError(
      "BUDGET_IDEMPOTENCY_CONFLICT",
      409,
      "Budget idempotency key was used with different inputs.",
    );
  return reservationDto(row);
}

export function createModelBudgetService(deps: {
  data: DataDatabase;
  configuredLimitTokens?: (scope: PlatformScope) => number | Promise<number>;
}) {
  const store = createConversationStore(deps.data);
  return {
    reserveModelBudget(
      scope: PlatformScope,
      input: BudgetInput,
      options?: {
        idempotencyKey?: string;
        expiresAt?: Date;
        runCeiling?: boolean;
      },
    ) {
      assertTrustedScope(scope);
      return store.transaction(scope, async (tx) => {
        const configuredLimitTokens = deps.configuredLimitTokens
          ? await deps.configuredLimitTokens(scope)
          : undefined;
        return reserveModelBudgetInTransaction(tx, scope, input, {
          ...options,
          ...(configuredLimitTokens !== undefined
            ? { configuredLimitTokens }
            : {}),
        });
      });
    },
    async confirm(
      scope: PlatformScope,
      reservationId: string,
      usedTokens: number,
    ): Promise<void> {
      assertTrustedScope(scope);
      if (
        !Number.isSafeInteger(usedTokens) ||
        usedTokens < 0 ||
        usedTokens > 2_147_483_647
      ) {
        throw new ModelBudgetError(
          "INVALID_USAGE",
          400,
          "usedTokens must be a non-negative integer.",
        );
      }
      await store.transaction(scope, async (tx) => {
        const row = await lockOwnedReservation(tx, scope, reservationId);
        if (!row)
          throw new ModelBudgetError(
            "BUDGET_RESERVATION_NOT_FOUND",
            404,
            "Budget reservation was not found.",
          );
        if (row.isRunCeiling) {
          throw new ModelBudgetError(
            "RUN_BUDGET_CEILING_IMMUTABLE",
            409,
            "A run's configured token ceiling is immutable.",
          );
        }
        if (row.status === "confirmed") {
          if (row.confirmedTokens !== usedTokens)
            throw new ModelBudgetError(
              "BUDGET_CONFIRM_CONFLICT",
              409,
              "Budget reservation was already confirmed with different usage.",
            );
          return;
        }
        if (row.status !== "reserved")
          throw new ModelBudgetError(
            "BUDGET_RESERVATION_CLOSED",
            409,
            "Budget reservation is no longer active.",
          );
        if (usedTokens > row.tokenLimit)
          throw new ModelBudgetError(
            "MODEL_BUDGET_EXCEEDED",
            402,
            "Reported model usage exceeds its reservation.",
          );
        const updated = await tx
          .update(enterpriseModelBudgetReservations)
          .set({
            status: "confirmed",
            confirmedTokens: usedTokens,
            updatedAt: new Date(),
          })
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
              eq(enterpriseModelBudgetReservations.runId, row.runId),
              eq(enterpriseModelBudgetReservations.id, reservationId),
              eq(enterpriseModelBudgetReservations.status, "reserved"),
            ),
          )
          .returning({ id: enterpriseModelBudgetReservations.id });
        if (!updated.length)
          throw new ModelBudgetError(
            "BUDGET_RESERVATION_CLOSED",
            409,
            "Budget reservation is no longer active.",
          );
      });
    },
    async release(scope: PlatformScope, reservationId: string): Promise<void> {
      assertTrustedScope(scope);
      await store.transaction(scope, async (tx) => {
        const row = await lockOwnedReservation(tx, scope, reservationId);
        if (!row)
          throw new ModelBudgetError(
            "BUDGET_RESERVATION_NOT_FOUND",
            404,
            "Budget reservation was not found.",
          );
        if (row.status === "released") return;
        if (row.isRunCeiling)
          throw new ModelBudgetError(
            "RUN_BUDGET_CEILING_IMMUTABLE",
            409,
            "A run's configured token ceiling cannot be released.",
          );
        if (row.status === "confirmed")
          throw new ModelBudgetError(
            "BUDGET_RESERVATION_CLOSED",
            409,
            "Confirmed budget usage cannot be released.",
          );
        const updated = await tx
          .update(enterpriseModelBudgetReservations)
          .set({ status: "released", updatedAt: new Date() })
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
              eq(enterpriseModelBudgetReservations.runId, row.runId),
              eq(enterpriseModelBudgetReservations.id, reservationId),
              inArray(enterpriseModelBudgetReservations.status, ["reserved"]),
            ),
          )
          .returning({ id: enterpriseModelBudgetReservations.id });
        if (!updated.length)
          throw new ModelBudgetError(
            "BUDGET_RESERVATION_CLOSED",
            409,
            "Budget reservation is no longer active.",
          );
      });
    },
  };
}
