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
import type { DataDatabase } from "../tenancy/connections";
import { assertTrustedScope } from "../tenancy/store";

type Transaction = Parameters<Parameters<DataDatabase["transaction"]>[0]>[0];

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
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
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

export async function reserveModelBudgetInTransaction(
  tx: Transaction,
  scope: PlatformScope,
  input: BudgetInput,
  configuredLimitTokens: number,
  options: {
    idempotencyKey?: string;
    expiresAt?: Date;
    runCeiling?: boolean;
  } = {},
): Promise<BudgetReservation> {
  assertTokens(input.maximumTokens, "maximumTokens");
  assertTokens(configuredLimitTokens, "configuredLimitTokens");
  const idempotencyKey = options.idempotencyKey ?? `run:${input.runId}`;
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
        eq(enterpriseModelBudgetReservations.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) {
    if (
      existing.runId !== input.runId ||
      existing.modelRouteRef !== input.modelRouteRef ||
      existing.tokenLimit !== input.maximumTokens ||
      existing.isRunCeiling !== (options.runCeiling ?? false)
    ) {
      throw new ModelBudgetError(
        "BUDGET_IDEMPOTENCY_CONFLICT",
        409,
        "Budget idempotency key was used with different inputs.",
      );
    }
    return reservationDto(existing);
  }

  if (options.runCeiling) {
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
      .returning();
    if (!row) throw new Error("BUDGET_RESERVATION_FAILED");
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
        eq(enterpriseModelInvocationCapabilities.runId, input.runId),
        inArray(enterpriseModelInvocationCapabilities.status, [
          "reserved",
          "consumed",
          "unknown",
          "confirmed",
        ]),
      ),
    );
  const usedTokens =
    rows.reduce(
      (sum, row) =>
        sum +
        (row.status === "confirmed" ? row.confirmedTokens : row.tokenLimit),
      0,
    ) +
    claims.reduce(
      (sum, row) =>
        sum + (row.status === "confirmed" ? row.usedTokens : row.maximumTokens),
      0,
    );
  const [ceiling] = await tx
    .select({ tokenLimit: enterpriseModelBudgetReservations.tokenLimit })
    .from(enterpriseModelBudgetReservations)
    .where(
      and(
        eq(enterpriseModelBudgetReservations.tenantId, scope.tenantId),
        eq(enterpriseModelBudgetReservations.runId, input.runId),
        eq(
          enterpriseModelBudgetReservations.idempotencyKey,
          `run-ceiling:${input.runId}`,
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
  if (input.maximumTokens > ceiling.tokenLimit - usedTokens) {
    throw new ModelBudgetError(
      "MODEL_BUDGET_EXCEEDED",
      402,
      "The configured model budget has been exceeded.",
    );
  }
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
    .returning();
  if (!row) throw new Error("BUDGET_RESERVATION_FAILED");
  return reservationDto(row);
}

export function createModelBudgetService(deps: {
  data: DataDatabase;
  configuredLimitTokens(scope: PlatformScope): number | Promise<number>;
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
      return store.transaction(scope, async (tx) =>
        reserveModelBudgetInTransaction(
          tx,
          scope,
          input,
          await deps.configuredLimitTokens(scope),
          options,
        ),
      );
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
        const [row] = await tx
          .select()
          .from(enterpriseModelBudgetReservations)
          .where(
            and(
              eq(enterpriseModelBudgetReservations.tenantId, scope.tenantId),
              eq(enterpriseModelBudgetReservations.id, reservationId),
            ),
          )
          .for("update")
          .limit(1);
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
        await tx
          .update(enterpriseModelBudgetReservations)
          .set({
            status: "confirmed",
            confirmedTokens: usedTokens,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(enterpriseModelBudgetReservations.tenantId, scope.tenantId),
              eq(enterpriseModelBudgetReservations.id, reservationId),
              eq(enterpriseModelBudgetReservations.status, "reserved"),
            ),
          );
      });
    },
    async release(scope: PlatformScope, reservationId: string): Promise<void> {
      assertTrustedScope(scope);
      await store.transaction(scope, async (tx) => {
        const [row] = await tx
          .select()
          .from(enterpriseModelBudgetReservations)
          .where(
            and(
              eq(enterpriseModelBudgetReservations.tenantId, scope.tenantId),
              eq(enterpriseModelBudgetReservations.id, reservationId),
            ),
          )
          .for("update")
          .limit(1);
        if (!row || row.status === "released") return;
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
        await tx
          .update(enterpriseModelBudgetReservations)
          .set({ status: "released", updatedAt: new Date() })
          .where(
            and(
              eq(enterpriseModelBudgetReservations.tenantId, scope.tenantId),
              eq(enterpriseModelBudgetReservations.id, reservationId),
              inArray(enterpriseModelBudgetReservations.status, ["reserved"]),
            ),
          );
      });
    },
  };
}
