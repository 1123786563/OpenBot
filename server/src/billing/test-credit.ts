import { createHash } from "node:crypto";
import {
  and,
  eq,
  isNull,
  like,
  lte,
  ne,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import type { ReleasedBifrostRoute } from "../admin/bifrost-catalog";
import type { Database } from "../db/client";
import {
  testCreditAccounts as accounts,
  billingApplications as applications,
  billingSpendingAuthorizations as authorizations,
  backgroundToolResults,
  testCreditBatches as batches,
  testCreditBudgets as budgets,
  testCreditEnrollments as enrollments,
  enterpriseSettings,
  testCreditEvidence as evidence,
  testCreditExternalAuthorizations as externalAuthorizations,
  testCreditIssuanceBudgets as issuanceBudgets,
  testCreditIssuances as issuances,
  lagoUsageEvents,
  testCreditOperations as operations,
  personalSaasAccounts,
  pilotProviderCostHolds,
  pilotProviderCostLimitEvents,
  pilotProviderCostLimits,
  testCreditResumePoints as resumePoints,
} from "../db/schema";
import type { AccountStatus } from "../db/schema/personal-saas";
import { accountDecision } from "../personal-saas/account-access";
import type { CoordinationModelCall } from "./coordination-model-call";
import {
  allocatePaidSources,
  consumePaidAllocations,
  hasDisputedPaidHold,
  paidBalanceWithin,
  pilotReservesStoppedAt,
  releasePaidAllocations,
  restoreHolds,
} from "./paid-ledger";
import {
  readPilotRoutes as activeRoutes,
  currentRouteLimit,
  type PilotDeployment,
  type PilotResource,
  sharedPilotCostScope,
  signedApplication,
} from "./pilot-signoffs";
import { WEKNORA_APPLICATION_ID } from "./weknora-ingestion";
import type { WeKnoraWork } from "./weknora-scope";

export type ExternalSpendingScope = {
  authorizationId: string;
  application: typeof externalAuthorizations.$inferSelect.application;
  resourceId: string;
};

export type VerifiedBillingIdentity = { issuer: string; subject: string };
export type ChildBudgetBinding = {
  budgetId: string;
  kind: NonNullable<(typeof budgets.$inferSelect)["childKind"]>;
  botId: string;
};
type Budget = typeof budgets.$inferSelect;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

// The catalog only accepts route IDs beginning with a lowercase letter or digit.

function sharedPilotLimitReached(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    "errno" in error &&
    error.errno === "23514" &&
    "constraint" in error &&
    error.constraint === "shared_pilot_provider_cost_limit"
  )
    return true;
  return sharedPilotLimitReached(error.cause);
}

async function providerCostOutstanding(tx: Transaction, path: string) {
  const [row] = await tx
    .select({
      outstanding: sql<string>`coalesce(sum(case when ${pilotProviderCostHolds.state} = 'held' then ${pilotProviderCostHolds.boundMicrocredits} else coalesce(${pilotProviderCostHolds.costMicrocredits}, 0) end), 0)`,
    })
    .from(pilotProviderCostHolds)
    .where(eq(pilotProviderCostHolds.path, path));
  return BigInt(row?.outstanding ?? 0);
}

async function resolveProviderCostHold(
  tx: Transaction,
  routeId: string,
  accountId: string,
  operationId: string,
  outcome:
    | { state: "verified"; costMicrocredits: bigint }
    | { state: "booked" }
    | { state: "released" },
) {
  // Terminal states are final: replays and late evidence never re-open a
  // share that was already resolved, so restarts and retries cannot
  // double-count or resurrect released cost.
  const settled =
    outcome.state === "booked"
      ? {
          state: "booked" as const,
          costMicrocredits: sql`${pilotProviderCostHolds.boundMicrocredits}`,
        }
      : outcome.state === "verified"
        ? {
            state: "verified" as const,
            costMicrocredits: outcome.costMicrocredits,
          }
        : { state: "released" as const, costMicrocredits: 0n };
  await tx
    .update(pilotProviderCostHolds)
    .set({ ...settled, resolvedAt: new Date() })
    .where(
      and(
        eq(pilotProviderCostHolds.path, routeId),
        eq(pilotProviderCostHolds.accountId, accountId),
        eq(pilotProviderCostHolds.operationId, operationId),
        outcome.state === "verified"
          ? sql`${pilotProviderCostHolds.state} in ('held', 'booked')`
          : eq(pilotProviderCostHolds.state, "held"),
      ),
    );
}
type Operation = typeof operations.$inferSelect;
type Usage = { inputTokens: bigint; outputTokens: bigint };

type Evidence = Pick<
  typeof evidence.$inferSelect,
  "evidenceId" | "outcome" | "inputTokens" | "outputTokens"
>;
const reconciliationMilliseconds = 24 * 60 * 60_000;
const cutoffBatchSize = 100;
const evidenceReadBatchSize = 16;
const evidenceRetryMilliseconds = 5 * 60_000;
const evidenceRetentionMilliseconds = 7 * reconciliationMilliseconds;
const gatewayTimeoutMilliseconds = 90_000;
const reservationMilliseconds = 5 * 60_000;
const tokenUnit = 1_000_000n;
const identityFilter = ({ issuer, subject }: VerifiedBillingIdentity) =>
  and(eq(accounts.issuer, issuer), eq(accounts.subject, subject));
const operationFilter = (accountId: string, id: string) =>
  and(eq(operations.accountId, accountId), eq(operations.id, id));

// The account already partitions resume points. An ingestion point also
// needs its immutable grant ID before an operation row (and its FK) exists.
const ingestionPointKey = (authorizationId: string, operationId: string) =>
  `weknora:${authorizationId}:${operationId}`;

const trialEndKey = (accountId: string) =>
  `billing.test-credit-ended.${accountId}`;

async function trialEnded(tx: Transaction, accountId: string) {
  const [row] = await tx
    .select({ key: enterpriseSettings.key })
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, trialEndKey(accountId)));
  return row !== undefined;
}

const denied = (
  reason:
    | "not_authorized"
    | "route_unavailable"
    | "insufficient_credits"
    | "execution_limit"
    | "trial_ended"
    | "pilot_closed"
    | "unavailable",
) => ({ state: "denied", reason }) as const;

function routeEligible(
  active: Awaited<ReturnType<typeof activeRoutes>>,
  frozen: ReleasedBifrostRoute,
) {
  return (
    active?.options.some(
      ({ id, purpose, revision, verification }) =>
        id === frozen.id &&
        purpose === frozen.purpose &&
        revision === frozen.revision &&
        verification.report.artifactDigest ===
          frozen.verification.report.artifactDigest &&
        verification.report.gatewayImageDigest ===
          frozen.verification.report.gatewayImageDigest,
    ) ?? false
  );
}

// Pin compatibility independently of price. Reusing a route ID for an unverified
// or different deployment must never silently change the meaning of a saved choice.
export const testCreditModelPick = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  revision: z.uuid(),
});
type ModelPick = z.infer<typeof testCreditModelPick>;
type ModelPreferences = {
  conversation?: ModelPick | null;
  bot?: ModelPick | null;
};

function modelOption(route: ReleasedBifrostRoute) {
  return {
    id: route.id,
    revision: route.revision,
    provider: route.provider,
    model: route.model,
  };
}

function quoteFor(route: ReleasedBifrostRoute, priceVersion: string) {
  return {
    creditType: "test" as const,
    priceVersion,
    route: route.id,
    provider: route.provider,
    model: route.model,
    price: route.price,
    tools: route.tools,
    maxChargeMicrocredits: route.maxChargeMicrocredits,
    usageDisclosure:
      "Interrupted, cancelled, or failed requests may still use Test Credits.",
  };
}

export type TestCreditQuote = ReturnType<typeof quoteFor>;

export type OneTimeTestCreditGrantConfig = {
  budgetId: string;
  batchId: string;
  amount: bigint;
  budget: bigint;
};

export type OneTimeTestCreditGrant = {
  state: "pending" | "issued";
  amountMicrocredits: string;
  budgetId: string;
  batchId: string;
};

async function totals(database: Database | Transaction, accountId: string) {
  // PostgreSQL sums bigint values as numeric. Parse its exact decimal output.
  const [row] = await database
    .select({
      granted: sql<string>`(
      select coalesce(sum(${batches.amount}), 0)::text
      from ${batches} join ${enrollments} on ${enrollments.batchId} = ${batches.id}
      where ${enrollments.accountId} = ${accountId} and ${enrollments.claimedAt} is not null
    )`,
      held: sql<string>`(
      select coalesce(sum(coalesce(${operations.cutoffHold}, ${operations.reserved}) - ${operations.paidHoldMicrocredits}), 0)::text from ${operations}
      where ${operations.accountId} = ${accountId} and ${operations.state} in ('reserved', 'pending')
    )`,
      spent: sql<string>`(
      select coalesce(sum(${operations.charged} - coalesce(${operations.paidChargeMicrocredits}, 0)), 0)::text from ${operations}
      where ${operations.accountId} = ${accountId} and ${operations.charged} is not null
    )`,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  const granted = BigInt(row?.granted ?? "0");
  const held = BigInt(row?.held ?? "0");
  const spent = BigInt(row?.spent ?? "0");
  return { granted, held, spent, available: granted - held - spent };
}

function receiptCreditType(row: Operation) {
  if (row.requestedCreditType) return row.requestedCreditType;
  const paid =
    row.charged === null
      ? row.paidHoldMicrocredits
      : (row.paidChargeMicrocredits ?? 0n);
  if (paid === 0n) return "test";
  return paid === (row.charged ?? row.reserved) ? "paid" : "mixed";
}

function operationReceipt(
  operation: Operation,
  verified?: Evidence,
  creditType = receiptCreditType(operation),
) {
  const {
    id,
    state,
    priceVersion,
    route,
    charged,
    reserved,
    dispatchedAt,
    inputTokens,
    outputTokens,
    budgetId,
    stepId,
    resultText,
  } = operation;
  const held =
    state === "pending" || state === "reserved"
      ? (operation.cutoffHold ?? reserved)
      : 0n;
  const released =
    state === "released"
      ? reserved
      : charged === null
        ? operation.cutoffHold === null
          ? null
          : reserved - held
        : reserved - charged;
  return {
    operationId: id,
    rerunOfOperationId: operation.rerunOfOperationId,
    outcome:
      verified?.outcome ??
      (state === "pending" || (state === "released" && dispatchedAt)
        ? "unknown"
        : null),
    cutoffAt:
      operation.reconciliationCutoffAt ??
      (dispatchedAt &&
        new Date(dispatchedAt.getTime() + reconciliationMilliseconds)),
    heldMicrocredits: held.toString(),
    state,
    priceVersion,
    route: route.id,
    provider: route.provider,
    model: route.model,
    creditType,
    price: route.price,
    reservedMicrocredits: reserved.toString(),
    chargedMicrocredits: charged?.toString() ?? null,
    releasedMicrocredits: released?.toString() ?? null,
    dispatchedAt,
    inputTokens: (inputTokens ?? verified?.inputTokens)?.toString() ?? null,
    outputTokens: (outputTokens ?? verified?.outputTokens)?.toString() ?? null,
    budgetId,
    stepId,
    parentRunId: operation.parentRunId,
    applicationId: operation.applicationId,
    resultText,
    resultCalls: operation.resultCalls,
    coordinationToolNames: operation.coordinationToolNames,
  };
}

function eligibleCharge(
  row: Operation,
  verified: typeof evidence.$inferSelect,
) {
  if (verified.outcome === "platform_failure") return 0n;
  return verified.cost > row.reserved ? row.reserved : verified.cost;
}

function externalReservationStillAuthorized(
  status: AccountStatus | null,
  reservedEpoch: number | null,
) {
  if (!status || reservedEpoch === null) return false;

  // Each intervening epoch must be accounted for by an OpenBot workspace pause.
  const workspacePauseEpochs = new Set(
    status.executionCutoffs
      ?.filter(
        (event) =>
          event.reason === "workspace_paused" &&
          event.epoch > reservedEpoch &&
          event.epoch <= status.epoch,
      )
      .map((event) => event.epoch),
  );
  return workspacePauseEpochs.size === status.epoch - reservedEpoch;
}

export function createTestCreditLedger(
  database: Database | Transaction,
  clock?: () => Date,
  pilot?: PilotDeployment,
) {
  async function currentTime(tx: Transaction) {
    if (clock) return clock();
    const [row] = await tx.execute<{ time: string }>(
      sql`select clock_timestamp()::text as time`,
    );
    if (!row) throw new Error("Test Credit clock unavailable");
    return new Date(row.time);
  }

  function evidenceFor(row: Operation) {
    return and(
      eq(evidence.accountId, row.accountId),
      eq(evidence.operationId, row.id),
    );
  }

  async function eligibleEvidence(tx: Transaction, row: Operation) {
    if (row.eligibleEvidenceId === null) return undefined;
    const [verified] = await tx
      .select()
      .from(evidence)
      .where(
        and(evidenceFor(row), eq(evidence.evidenceId, row.eligibleEvidenceId)),
      );
    if (!verified) throw new Error("Test Credit evidence unavailable");
    return verified;
  }

  function dueForCutoff(now: Date) {
    return and(
      // Match the partial index predicate even on a generic prepared plan.
      sql`${operations.state} = 'pending'`,
      isNull(operations.cutoffHold),
      or(
        lte(operations.reconciliationCutoffAt, now),
        and(
          isNull(operations.reconciliationCutoffAt),
          lte(
            operations.dispatchedAt,
            new Date(now.getTime() - reconciliationMilliseconds),
          ),
        ),
      ),
    );
  }

  async function applyOperationCutoff(
    tx: Transaction,
    row: Operation,
    now: Date,
  ) {
    const verified = await eligibleEvidence(tx, row);
    const cutoffHold = verified ? eligibleCharge(row, verified) : 0n;
    const released = cutoffHold === 0n && verified?.outcome !== "completed";
    // The paid share follows the user reservation. With verified evidence
    // the charge is final, so the paid tail is consumed now in source order
    // and the hold shrinks to its Test Credit share; without evidence (or
    // with nothing held) every paid allocation returns.
    let hold = cutoffHold;
    let paidCharge = 0n;
    if (row.paidHoldMicrocredits > 0n) {
      if (verified && cutoffHold > 0n) {
        const testShare =
          cutoffHold > row.reserved - row.paidHoldMicrocredits
            ? row.reserved - row.paidHoldMicrocredits
            : cutoffHold;
        const consumed = await consumePaidAllocations(
          tx,
          {
            accountId: row.accountId,
            operationId: row.id,
            chargeMicrocredits: cutoffHold - testShare,
          },
          now,
        );
        hold = testShare;
        paidCharge = consumed.state === "settled" ? consumed.consumed : 0n;
      } else {
        await releasePaidAllocations(tx, row.accountId, row.id, now);
      }
    }
    await tx
      .update(operations)
      .set({
        cutoffHold: hold,
        paidHoldMicrocredits: 0n,
        paidChargeMicrocredits: paidCharge,
        state: released ? "released" : "pending",
      })
      .where(operationFilter(row.accountId, row.id));
    // The user reservation may release here, but an unknown provider result
    // keeps its cost share: verified cost replaces the bound, and a window
    // that closed without evidence books the share at the upper bound.
    await resolveProviderCostHold(
      tx,
      row.route.id,
      row.accountId,
      row.id,
      verified
        ? { state: "verified", costMicrocredits: cutoffHold }
        : { state: "booked" },
    );
  }

  async function applyCutoff(tx: Transaction, accountId: string, now: Date) {
    const due = await tx
      .select()
      .from(operations)
      .where(and(eq(operations.accountId, accountId), dueForCutoff(now)));
    for (const row of due) await applyOperationCutoff(tx, row, now);
  }

  async function lockAccount(
    tx: Transaction,
    accountId: string,
    skipLocked = false,
  ) {
    const [row] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .for("update", skipLocked ? { skipLocked: true } : undefined);
    return row;
  }

  async function account(identity: VerifiedBillingIdentity, tx: Transaction) {
    const [row] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(identityFilter(identity))
      .for("update");
    return row?.id;
  }

  async function operation(accountId: string, id: string, tx: Transaction) {
    const [row] = await tx
      .select()
      .from(operations)
      .where(operationFilter(accountId, id));
    return row;
  }

  async function externalAccount(
    tx: Transaction,
    identity: VerifiedBillingIdentity,
  ) {
    const [row] = await tx
      .select({ status: personalSaasAccounts.status })
      .from(personalSaasAccounts)
      .where(
        and(
          eq(personalSaasAccounts.issuer, identity.issuer),
          eq(personalSaasAccounts.subject, identity.subject),
        ),
      )
      .for("share");
    return row?.status ?? null;
  }

  async function externalAuthorization(
    tx: Transaction,
    accountId: string,
    scope: ExternalSpendingScope,
  ) {
    const [row] = await tx
      .select()
      .from(externalAuthorizations)
      .where(
        and(
          eq(externalAuthorizations.accountId, accountId),
          eq(externalAuthorizations.id, scope.authorizationId),
          eq(externalAuthorizations.application, scope.application),
          eq(externalAuthorizations.resourceId, scope.resourceId),
        ),
      );
    return row;
  }

  // Ends a reservation that will not run. Its paid hold goes back with it,
  // or the credits would stay held for a step that never started.
  async function releaseReservation(tx: Transaction, row: Operation) {
    await tx
      .update(operations)
      .set({ state: "released", paidHoldMicrocredits: 0n })
      .where(operationFilter(row.accountId, row.id));
    if (row.paidHoldMicrocredits > 0n)
      await releasePaidAllocations(
        tx,
        row.accountId,
        row.id,
        await currentTime(tx),
      );
    await resolveProviderCostHold(tx, row.route.id, row.accountId, row.id, {
      state: "released",
    });
  }

  async function receiptFor(
    tx: Transaction,
    row: Operation,
    verified?: Evidence,
  ) {
    const bound =
      row.budgetId && (await budget(row.accountId, row.budgetId, tx));
    return operationReceipt(
      row,
      verified,
      bound ? bound.creditType : undefined,
    );
  }

  async function budget(accountId: string, id: string, tx: Transaction) {
    const [row] = await tx
      .select()
      .from(budgets)
      .where(and(eq(budgets.accountId, accountId), eq(budgets.id, id)));
    return row;
  }

  // What an execution limit has used: a settled step's charge, any other
  // step's hold.
  async function chargedOrHeld(tx: Transaction, where: SQL | undefined) {
    const [row] = await tx
      .select({
        used: sql<string>`coalesce(sum(case when ${operations.state} = 'settled' then ${operations.charged} else coalesce(${operations.cutoffHold}, ${operations.reserved}) end), 0)::text`,
      })
      .from(operations)
      .where(and(where, sql`${operations.state} <> 'released'`));
    return BigInt(row?.used ?? "0");
  }

  function withinBudget(accountId: string, budgetId: string) {
    return sql`${operations.budgetId} IN (
      WITH RECURSIVE subtree(id) AS (
        SELECT ${budgetId}::text
        UNION
        SELECT ${budgets.id} FROM ${budgets}
        JOIN subtree ON ${budgets.parentBudgetId} = subtree.id
        WHERE ${budgets.accountId} = ${accountId}
      )
      SELECT id FROM subtree
    )`;
  }

  function budgetUsage(accountId: string, budgetId: string, tx: Transaction) {
    return chargedOrHeld(
      tx,
      and(
        eq(operations.accountId, accountId),
        withinBudget(accountId, budgetId),
      ),
    );
  }

  async function budgetChain(tx: Transaction, leaf: Budget) {
    const chain = [leaf];
    let parentId = leaf.parentBudgetId;
    while (parentId) {
      const parent = await budget(leaf.accountId, parentId, tx);
      if (!parent) throw new Error("Execution budget ancestor is missing");
      chain.push(parent);
      parentId = parent.parentBudgetId;
    }
    return chain;
  }

  function activeBudget(row: Budget) {
    return row.state === "active" && row.confirmedAt !== null;
  }

  async function canDispatchUnderBudget(tx: Transaction, row: Operation) {
    if (!row.budgetId) return true;
    const leaf = await budget(row.accountId, row.budgetId, tx);
    if (!leaf) return false;
    for (const limit of await budgetChain(tx, leaf)) {
      if (
        !activeBudget(limit) ||
        (await budgetUsage(row.accountId, limit.id, tx)) >
          limit.limitMicrocredits
      )
        return false;
    }
    return true;
  }

  // What an authorization has used, on the same rule as a budget's usage.
  function authorizationUsage(tx: Transaction, accountId: string, id: string) {
    return chargedOrHeld(
      tx,
      and(
        eq(operations.accountId, accountId),
        eq(operations.authorizationId, id),
      ),
    );
  }

  async function authorization(accountId: string, id: string, tx: Transaction) {
    const [row] = await tx
      .select()
      .from(authorizations)
      .where(
        and(eq(authorizations.accountId, accountId), eq(authorizations.id, id)),
      );
    return row;
  }

  async function application(id: string, tx: Transaction, lock = false) {
    const query = tx.select().from(applications).where(eq(applications.id, id));
    return (await (lock ? query.for("share") : query))[0];
  }

  async function paidPolicy(
    tx: Transaction,
    applicationId: string,
    accountId: string,
    route: ReleasedBifrostRoute,
    bound: bigint,
    resource: PilotResource,
  ) {
    if (!pilot) return;
    return signedApplication(
      tx,
      pilot,
      applicationId,
      accountId,
      route,
      await currentRouteLimit(tx, route.id),
      bound,
      resource,
    );
  }

  async function dispatchPolicy(tx: Transaction, row: Operation) {
    if (!pilot) return {};
    const applicationId = row.applicationId ?? "openbot";
    const path = await application(applicationId, tx, true);
    if (path?.pausedAt) return;
    if (row.paidHoldMicrocredits === 0n) return {};
    if (!path?.approvedAt) return;
    const policy = await paidPolicy(
      tx,
      applicationId,
      row.accountId,
      row.route,
      row.reserved,
      row.pilotResource ?? row.route.purpose ?? "chat",
    );
    if (policy) return { windowSeconds: policy.reconciliationWindowSeconds };
  }

  async function authorizationRecord(
    tx: Transaction,
    row: typeof authorizations.$inferSelect,
    spent: bigint,
  ) {
    const at = await currentTime(tx);
    return {
      authorizationId: row.id,
      applicationId: row.applicationId,
      kind: row.kind,
      creditType: row.creditType ?? ("test" as const),
      taskId: row.taskId,
      resourcePrefix: row.resourcePrefix,
      expiresAt: row.expiresAt,
      limitMicrocredits: row.limitMicrocredits.toString(),
      spentMicrocredits: spent.toString(),
      revokedAt: row.revokedAt,
      state:
        row.revokedAt !== null
          ? ("revoked" as const)
          : row.expiresAt <= at
            ? ("expired" as const)
            : ("active" as const),
    };
  }

  // A suspended account (the identity provider disabled it) makes no new
  // reservation and dispatches none (#103 停用期间保持消费暂停).
  async function suspended(tx: Transaction, accountId: string) {
    const [row] = await tx
      .select({ at: accounts.suspendedAt })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    return Boolean(row?.at);
  }

  // Approval lets an application take reservations (#111 未审批应用不能启用);
  // a pause and its lift are recorded with who did it (#112).
  async function markApplication(
    id: string,
    change: "approve" | "pause" | "resume",
    by: string,
  ) {
    return database.transaction(async (tx) => {
      const at = await currentTime(tx);
      return (
        await tx
          .update(applications)
          .set(
            change === "approve"
              ? { approvedAt: at, approvedBy: by }
              : change === "pause"
                ? { pausedAt: at, pausedBy: by }
                : { pausedAt: null, pausedBy: null },
          )
          .where(eq(applications.id, id))
          .returning()
      )[0];
    });
  }

  /**
   * Whether a step may run under a Spending Authorization (#111): the
   * person's authorization is in force for this task, and the application
   * is approved with its path not paused (#112 路径暂停). A background
   * authorization runs its one task only. Returns the refusal reason, or
   * the authorization it runs under.
   */
  async function underAuthorization(
    tx: Transaction,
    accountId: string,
    input: {
      authorizationId: string;
      applicationId?: string;
      taskId?: string;
    },
    at: Date,
  ) {
    const held = await authorization(accountId, input.authorizationId, tx);
    const path = held
      ? await application(held.applicationId, tx, true)
      : undefined;
    if (
      !held ||
      !path ||
      held.revokedAt !== null ||
      at >= held.expiresAt ||
      !path.approvedAt ||
      (input.applicationId !== undefined &&
        input.applicationId !== held.applicationId) ||
      (held.kind === "background"
        ? input.taskId !== held.taskId
        : input.taskId !== undefined)
    )
      return { refusal: "not_authorized" as const, held: undefined };
    if (path.pausedAt)
      return { refusal: "route_unavailable" as const, held: undefined };
    return { refusal: undefined, held };
  }

  async function setCostLimit(input: {
    path: string;
    limitMicrocredits: bigint;
    by: string;
  }) {
    if (input.limitMicrocredits < 0n || !input.by.trim())
      throw new RangeError("Invalid provider cost limit");
    return database.transaction(async (tx) => {
      await tx.execute(
        input.path === sharedPilotCostScope
          ? sql`select lock_pilot_provider_cost()`
          : sql`select pg_advisory_xact_lock(hashtext(${input.path}))`,
      );

      const [existing] = await tx
        .select()
        .from(pilotProviderCostLimits)
        .where(eq(pilotProviderCostLimits.path, input.path));
      const updatedAt = await currentTime(tx);
      await tx
        .insert(pilotProviderCostLimits)
        .values({
          path: input.path,
          limitMicrocredits: input.limitMicrocredits,
          updatedBy: input.by,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: pilotProviderCostLimits.path,
          set: {
            limitMicrocredits: input.limitMicrocredits,
            updatedBy: input.by,
            updatedAt,
          },
        });
      await tx.insert(pilotProviderCostLimitEvents).values({
        path: input.path,
        fromLimitMicrocredits: existing?.limitMicrocredits ?? null,
        toLimitMicrocredits: input.limitMicrocredits,
        by: input.by,
        at: updatedAt,
      });
      return { previous: existing?.limitMicrocredits ?? null };
    });
  }

  return {
    async claimBackgroundTool(
      identity: VerifiedBillingIdentity,
      input: {
        operationId: string;
        call: CoordinationModelCall;
        toolRef: string;
      },
    ) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId || (await suspended(tx, accountId)))
          return { state: "denied" as const };
        const row = await operation(accountId, input.operationId, tx);
        if (
          row?.state !== "settled" ||
          !row.resultCalls?.some(
            (call) =>
              call.id === input.call.id &&
              call.name === input.call.name &&
              call.arguments === input.call.arguments,
          )
        )
          return { state: "denied" as const };

        const key = {
          accountId,
          operationId: input.operationId,
          callId: input.call.id,
        };
        const match = and(
          eq(backgroundToolResults.accountId, key.accountId),
          eq(backgroundToolResults.operationId, key.operationId),
          eq(backgroundToolResults.callId, key.callId),
        );
        const [claim] = await tx
          .insert(backgroundToolResults)
          .values({ ...key, toolRef: input.toolRef })
          .onConflictDoNothing()
          .returning({ callId: backgroundToolResults.callId });
        if (claim)
          return {
            state: "claimed" as const,
            finish: async (result: string) => {
              await database
                .update(backgroundToolResults)
                .set({ result })
                .where(match);
            },
            releaseUnsent: async () => {
              await database.delete(backgroundToolResults).where(match);
            },
          };
        const [existing] = await tx
          .select()
          .from(backgroundToolResults)
          .where(match);
        if (existing?.toolRef !== input.toolRef)
          return { state: "denied" as const };
        return existing.result === null
          ? { state: "pending" as const }
          : { state: "completed" as const, result: existing.result };
      });
    },

    async releaseClosedReservations(accountId: string) {
      await database.transaction(async (tx) => {
        if (!(await lockAccount(tx, accountId))) return;
        if (!(await pilotReservesStoppedAt(tx, accountId))) return;
        const reserved = await tx
          .select()
          .from(operations)
          .where(
            and(
              eq(operations.accountId, accountId),
              eq(operations.state, "reserved"),
            ),
          );
        for (const row of reserved) await releaseReservation(tx, row);
      });
    },

    async sweepCutoffs(limit = cutoffBatchSize) {
      if (!Number.isInteger(limit) || limit < 1 || limit > cutoffBatchSize) {
        throw new RangeError("Invalid Test Credit cutoff batch size");
      }
      const candidates = await database.transaction(async (tx) =>
        tx
          .select({ accountId: operations.accountId, id: operations.id })
          .from(operations)
          .where(dueForCutoff(await currentTime(tx)))
          .orderBy(operations.dispatchedAt, operations.accountId, operations.id)
          .limit(limit),
      );
      let applied = 0;
      for (const { accountId, id } of candidates) {
        applied += await database.transaction(async (tx) => {
          // Other ledger writers take the account lock first. Recheck after
          // locking because they may already have processed this candidate.
          if (!(await lockAccount(tx, accountId, true))) return 0;
          const [row] = await tx
            .select()
            .from(operations)
            .where(
              and(
                operationFilter(accountId, id),
                dueForCutoff(await currentTime(tx)),
              ),
            );
          if (!row) return 0;
          await applyOperationCutoff(tx, row, await currentTime(tx));
          return 1;
        });
      }
      return applied;
    },

    // Called by trusted provisioning. Batch amounts cannot be changed on replay.
    async enroll({
      identity,
      batchId,
      amount,
    }: {
      identity: VerifiedBillingIdentity;
      batchId: string;
      amount: bigint;
    }) {
      await database.transaction(async (tx) => {
        await tx
          .insert(batches)
          .values({ id: batchId, amount })
          .onConflictDoNothing();
        const [batch] = await tx
          .select()
          .from(batches)
          .where(eq(batches.id, batchId));
        if (batch?.amount !== amount)
          throw new Error("Test Credit batch amount differs");
        await tx.insert(accounts).values(identity).onConflictDoNothing();
        const accountId = await account(identity, tx);
        if (!accountId) throw new Error("Billing Account could not be created");
        await tx
          .insert(enrollments)
          .values({ accountId, batchId })
          .onConflictDoNothing();
      });
    },

    /**
     * Admit the stable account identity to one bounded grant. The budget row is
     * locked before the issued amount is changed, so concurrent workspaces can
     * never consume the same global budget twice.
     */
    async ensureOneTimeGrant(
      identity: VerifiedBillingIdentity,
      config: OneTimeTestCreditGrantConfig,
    ): Promise<OneTimeTestCreditGrant> {
      if (config.amount <= 0n || config.budget < 0n)
        throw new RangeError("Invalid Test Credit grant configuration");
      return database.transaction(async (tx) => {
        await tx.insert(accounts).values(identity).onConflictDoNothing();
        const accountId = await account(identity, tx);
        if (!accountId) throw new Error("Billing Account could not be created");

        const [existing] = await tx
          .select()
          .from(issuances)
          .where(eq(issuances.accountId, accountId));
        let grant = existing;
        if (!grant) {
          await tx
            .insert(batches)
            .values({ id: config.batchId, amount: config.amount })
            .onConflictDoNothing();
          const [batch] = await tx
            .select({ amount: batches.amount })
            .from(batches)
            .where(eq(batches.id, config.batchId));
          if (!batch || batch.amount !== config.amount)
            throw new Error("Test Credit grant batch amount differs");
          await tx
            .insert(issuanceBudgets)
            .values({ id: config.budgetId, total: config.budget })
            .onConflictDoNothing();
          const [pending] = await tx
            .insert(issuances)
            .values({
              accountId,
              budgetId: config.budgetId,
              batchId: config.batchId,
              amount: config.amount,
              state: "pending",
            })
            .returning();
          if (!pending) throw new Error("Test Credit grant was not saved");
          grant = pending;
        }
        if (grant.state === "issued")
          return {
            state: "issued",
            amountMicrocredits: grant.amount.toString(),
            budgetId: grant.budgetId,
            batchId: grant.batchId,
          };
        if (
          (await restoreHolds(tx, accountId)) ||
          (await pilotReservesStoppedAt(tx, accountId)) ||
          (await suspended(tx, accountId)) ||
          (await trialEnded(tx, accountId))
        )
          return {
            state: "pending",
            amountMicrocredits: grant.amount.toString(),
            budgetId: grant.budgetId,
            batchId: grant.batchId,
          };
        const [budget] = await tx
          .select()
          .from(issuanceBudgets)
          .where(eq(issuanceBudgets.id, grant.budgetId))
          .for("no key update");
        if (!budget) throw new Error("Test Credit issuance budget unavailable");
        if (budget.total - budget.issued < grant.amount)
          return {
            state: "pending",
            amountMicrocredits: grant.amount.toString(),
            budgetId: grant.budgetId,
            batchId: grant.batchId,
          };

        const issuedAt = await currentTime(tx);
        await tx
          .update(issuanceBudgets)
          .set({ issued: budget.issued + grant.amount })
          .where(eq(issuanceBudgets.id, grant.budgetId));
        await tx
          .update(issuances)
          .set({ state: "issued", issuedAt })
          .where(eq(issuances.accountId, accountId));
        await tx
          .insert(enrollments)
          .values({
            accountId,
            batchId: grant.batchId,
            claimedAt: issuedAt,
          })
          .onConflictDoUpdate({
            target: [enrollments.accountId, enrollments.batchId],
            set: { claimedAt: issuedAt },
            setWhere: isNull(enrollments.claimedAt),
          });
        return {
          state: "issued",
          amountMicrocredits: grant.amount.toString(),
          budgetId: grant.budgetId,
          batchId: grant.batchId,
        };
      });
    },

    async grantStatus(
      identity: VerifiedBillingIdentity,
      budgetId: string,
    ): Promise<OneTimeTestCreditGrant | undefined> {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        const [grant] = await tx
          .select()
          .from(issuances)
          .where(
            and(
              eq(issuances.accountId, accountId),
              eq(issuances.budgetId, budgetId),
            ),
          );
        return grant
          ? {
              state: grant.state,
              amountMicrocredits: grant.amount.toString(),
              budgetId: grant.budgetId,
              batchId: grant.batchId,
            }
          : undefined;
      });
    },

    async restoreOneTimeGrantBudget(budgetId: string, total: bigint) {
      if (total < 0n) throw new RangeError("Invalid Test Credit budget");
      await database
        .update(issuanceBudgets)
        .set({ total })
        .where(eq(issuanceBudgets.id, budgetId));
    },

    async claim(identity: VerifiedBillingIdentity, batchId: string) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        const key = and(
          eq(enrollments.accountId, accountId),
          eq(enrollments.batchId, batchId),
        );
        const [enrollment] = await tx.select().from(enrollments).where(key);
        if (!enrollment) return undefined;
        if (enrollment.claimedAt)
          return { batchId, claimedAt: enrollment.claimedAt };
        if (await restoreHolds(tx, accountId)) return undefined;
        const claimedAt = new Date();
        await tx
          .update(enrollments)
          .set({ claimedAt })
          .where(and(key, isNull(enrollments.claimedAt)));
        return { batchId, claimedAt };
      });
    },

    async createBudget(
      identity: VerifiedBillingIdentity,
      input: {
        budgetId: string;
        // Fixed when the task starts (#107): a trial task runs under test,
        // a paid continuation under paid.
        creditType: "test" | "paid";
        limitMicrocredits: bigint;
        childOf?: ChildBudgetBinding;
        confirmed?: boolean;
        modelQuote?: { route: string; priceVersion: string };
      },
    ) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.budgetId))
        throw new Error("Invalid execution budget ID");
      if (input.limitMicrocredits <= 0n)
        throw new Error("Execution budget must be positive");
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        const parent = input.childOf
          ? await budget(accountId, input.childOf.budgetId, tx)
          : undefined;
        if (
          input.childOf &&
          (!parent || parent.creditType !== input.creditType)
        )
          return undefined;
        const modelRoute =
          input.modelQuote?.route ?? parent?.modelRoute ?? null;
        const modelPriceVersion =
          input.modelQuote?.priceVersion ?? parent?.modelPriceVersion ?? null;
        if (
          parent &&
          (modelRoute !== parent.modelRoute ||
            modelPriceVersion !== parent.modelPriceVersion)
        )
          return undefined;
        if (input.modelQuote) {
          const active = await activeRoutes(tx, true);
          if (
            active?.defaultRoute !== input.modelQuote.route ||
            active.priceVersion !== input.modelQuote.priceVersion
          )
            return undefined;
        }
        const existing = await budget(accountId, input.budgetId, tx);
        if (existing) {
          if (existing.creditType !== input.creditType)
            throw new Error("Execution budget Credit type differs");
          if (
            existing.modelRoute !== modelRoute ||
            existing.modelPriceVersion !== modelPriceVersion
          )
            throw new Error("Execution budget quote differs");
          if (
            existing.parentBudgetId !== (input.childOf?.budgetId ?? null) ||
            existing.childKind !== (input.childOf?.kind ?? null) ||
            existing.childBotId !== (input.childOf?.botId ?? null)
          )
            throw new Error("Execution budget ancestry differs");
          if (existing.limitMicrocredits !== input.limitMicrocredits)
            throw new Error("Execution budget limit differs");
          return {
            budgetId: existing.id,
            creditType: existing.creditType,
            limitMicrocredits: existing.limitMicrocredits.toString(),
            state: existing.state,
            confirmed: existing.confirmedAt !== null,
          };
        }
        const [row] = await tx
          .insert(budgets)
          .values({
            accountId,
            id: input.budgetId,
            creditType: input.creditType,
            limitMicrocredits: input.limitMicrocredits,
            confirmedAt: input.confirmed === false ? null : new Date(),
            modelRoute,
            modelPriceVersion,
            parentBudgetId: input.childOf?.budgetId,
            childKind: input.childOf?.kind,
            childBotId: input.childOf?.botId,
          })
          .onConflictDoNothing()
          .returning();
        if (!row) return undefined;
        return {
          budgetId: row.id,
          creditType: row.creditType,
          limitMicrocredits: row.limitMicrocredits.toString(),
          state: row.state,
          confirmed: row.confirmedAt !== null,
        };
      });
    },

    async confirmBudget(
      identity: VerifiedBillingIdentity,
      budgetId: string,
      limitMicrocredits?: bigint,
    ) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        const row = await budget(accountId, budgetId, tx);
        if (!row) return undefined;
        const nextLimit = limitMicrocredits ?? row.limitMicrocredits;
        if (nextLimit <= 0n || nextLimit < row.limitMicrocredits)
          throw new Error("Execution budget limit can only increase");
        const [updated] = await tx
          .update(budgets)
          .set({
            limitMicrocredits: nextLimit,
            confirmedAt: new Date(),
            state: "active",
          })
          .where(
            and(eq(budgets.accountId, accountId), eq(budgets.id, budgetId)),
          )
          .returning();
        return (
          updated && {
            budgetId: updated.id,
            creditType: updated.creditType,
            limitMicrocredits: updated.limitMicrocredits.toString(),
            state: updated.state,
            confirmed: updated.confirmedAt !== null,
          }
        );
      });
    },

    /** A person's execution budgets with their Credit type and usage. */
    async budgets(identity: VerifiedBillingIdentity) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return [];
        const rows = await tx
          .select()
          .from(budgets)
          .where(eq(budgets.accountId, accountId))
          .orderBy(budgets.createdAt);
        return Promise.all(
          rows.map(async (row) => ({
            budgetId: row.id,
            creditType: row.creditType,
            limitMicrocredits: row.limitMicrocredits.toString(),
            usedMicrocredits: (
              await budgetUsage(accountId, row.id, tx)
            ).toString(),
            state: row.state,
            confirmed: row.confirmedAt !== null,
          })),
        );
      });
    },

    async budget(identity: VerifiedBillingIdentity, budgetId: string) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        const row = await budget(accountId, budgetId, tx);
        if (!row) return undefined;
        return {
          budgetId: row.id,
          creditType: row.creditType,
          limitMicrocredits: row.limitMicrocredits.toString(),
          usedMicrocredits: (
            await budgetUsage(accountId, budgetId, tx)
          ).toString(),
          state: row.state,
          confirmed: row.confirmedAt !== null,
        };
      });
    },

    async backgroundModelBudget(
      identity: VerifiedBillingIdentity,
      budgetId: string,
      operationId?: string,
    ) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        const [point] = operationId
          ? await tx
              .select({ budgetId: resumePoints.budgetId })
              .from(resumePoints)
              .where(
                and(
                  eq(resumePoints.accountId, accountId),
                  eq(resumePoints.operationId, operationId),
                ),
              )
          : [];
        const row = await budget(accountId, point?.budgetId ?? budgetId, tx);
        if (row?.modelRoute && row.modelPriceVersion)
          return {
            modelQuote: {
              route: row.modelRoute,
              priceVersion: row.modelPriceVersion,
            },
          };
      });
    },

    async embeddingRoute(id: string) {
      const active = await activeRoutes(database);
      const route = active?.options.find(
        (option) => option.id === id && option.purpose === "embedding",
      );
      if (route && active?.priceVersion)
        return { route, priceVersion: active.priceVersion };
    },

    async embeddingReplay(
      identity: VerifiedBillingIdentity,
      input: {
        operationId: string;
        scope: ExternalSpendingScope;
        inputDigest: string;
      },
    ) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        const row = await operation(accountId, input.operationId, tx);
        if (!row) return undefined;
        const authorization = await externalAuthorization(
          tx,
          accountId,
          input.scope,
        );
        const now = await currentTime(tx);
        if (
          !authorization ||
          row.externalAuthorizationId !== authorization.id ||
          row.embeddingInputDigest !== input.inputDigest
        )
          return { state: "conflict" } as const;
        if (!row.dispatchedAt && row.state === "reserved") return undefined;
        if (
          row.embeddingResult &&
          row.embeddingResultExpiresAt &&
          row.embeddingResultExpiresAt > now
        ) {
          return {
            state: "completed",
            vectors: row.embeddingResult,
            receipt: await settlePending(tx, accountId, input.operationId),
          } as const;
        }
        return { state: "unavailable" } as const;
      });
    },

    async sweepEmbeddingResults() {
      await database
        .update(operations)
        .set({ embeddingResult: null, embeddingResultExpiresAt: null })
        .where(
          sql`${operations.embeddingResultExpiresAt} <= statement_timestamp()`,
        );
    },

    async modelOptions() {
      const active = await activeRoutes(database);
      return (
        active?.options
          .filter(({ purpose }) => purpose === undefined)
          .map(modelOption) ?? []
      );
    },

    async resolveQuote(
      preferences: ModelPreferences,
      executor: Database | Transaction = database,
    ) {
      const active = await activeRoutes(executor);
      const source = preferences.conversation
        ? "conversation"
        : preferences.bot
          ? "bot"
          : "harness";
      const saved = preferences.conversation ?? preferences.bot;
      const route = active?.options.find(
        ({ id, revision, purpose }) =>
          purpose === undefined &&
          (saved
            ? id === saved.id && revision === saved.revision
            : id === active.defaultRoute),
      );
      const options =
        active?.options
          .filter(({ purpose }) => purpose === undefined)
          .map(modelOption) ?? [];
      if (route && active?.priceVersion)
        return {
          source,
          options,
          quote: quoteFor(route, active.priceVersion),
        } as const;
      const reason = saved
        ? `Saved ${source === "bot" ? "Bot default" : "Conversation override"} is no longer verified for this Harness. Choose another verified model or clear the saved selection.`
        : "No verified administrator default is available for this Harness. Ask an administrator to publish a default.";
      return { source, options, reason } as const;
    },

    async paidChatAvailable(
      accountId: string,
      quote: { route: string; priceVersion: string },
    ) {
      if (!pilot) return false;
      return database.transaction(async (tx) => {
        const catalog = await activeRoutes(tx);
        const route = catalog?.options.find(
          ({ id, purpose }) => id === quote.route && !purpose,
        );
        const path = await application("openbot", tx);
        return Boolean(
          route &&
            catalog?.priceVersion === quote.priceVersion &&
            path?.approvedAt &&
            !path.pausedAt &&
            (await paidPolicy(
              tx,
              "openbot",
              accountId,
              route,
              BigInt(route.maxChargeMicrocredits),
              "chat",
            )),
        );
      });
    },

    async weknoraQuote(
      routeId: string,
      purpose: "embedding" | "rerank" | undefined,
    ) {
      const active = await activeRoutes(database);
      const route = active?.options.find(
        (route) => route.id === routeId && route.purpose === purpose,
      );
      if (route && active?.priceVersion)
        return { route, quote: quoteFor(route, active.priceVersion) };
    },

    async quote() {
      const active = await activeRoutes(database);
      const route = active?.options.find(
        ({ id }) => id === active.defaultRoute,
      );
      if (route && active?.priceVersion)
        return quoteFor(route, active.priceVersion);
    },

    /** The Billing Account a verified identity maps to, if one was opened. */
    async accountOf(identity: VerifiedBillingIdentity) {
      const [row] = await database
        .select({ id: accounts.id })
        .from(accounts)
        .where(identityFilter(identity));
      return row?.id;
    },

    async endTrial(accountId: string, endedBy: string) {
      return database.transaction(async (tx) => {
        if (!(await lockAccount(tx, accountId))) return false;
        const endedAt = await currentTime(tx);
        await tx
          .insert(enterpriseSettings)
          .values({ key: trialEndKey(accountId), value: { endedAt, endedBy } })
          .onConflictDoNothing();
        return true;
      });
    },

    async balance(identity: VerifiedBillingIdentity) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        await applyCutoff(tx, accountId, await currentTime(tx));
        const { granted, held, spent, available } = await totals(tx, accountId);
        return {
          creditType: "test" as const,
          trialEnded: await trialEnded(tx, accountId),
          grantedMicrocredits: granted.toString(),
          reservedMicrocredits: held.toString(),
          chargedMicrocredits: spent.toString(),
          availableMicrocredits: available.toString(),
        };
      });
    },

    async receipt(identity: VerifiedBillingIdentity, id: string) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        await applyCutoff(tx, accountId, await currentTime(tx));
        const row = await operation(accountId, id, tx);
        return (
          row && (await receiptFor(tx, row, await eligibleEvidence(tx, row)))
        );
      });
    },

    // The caller must authenticate the account holder and obtain explicit consent.
    async authorizeExternalSpending(
      identity: VerifiedBillingIdentity,
      {
        authorizationId,
        application,
        resourceId,
        ...terms
      }: ExternalSpendingScope & {
        expiresAt: Date;
        maxMicrocredits: bigint;
      },
    ) {
      return database.transaction(async (tx) => {
        const status = await externalAccount(tx, identity);
        const accountId = await account(identity, tx);
        const now = await currentTime(tx);
        if (
          !accountId ||
          accountDecision(status, now.getTime()).kind !== "active" ||
          terms.expiresAt <= now ||
          terms.maxMicrocredits <= 0n
        )
          return undefined;
        const [created] = await tx
          .insert(externalAuthorizations)
          .values({
            id: authorizationId,
            accountId,
            application,
            resourceId,
            ...terms,
          })
          .onConflictDoNothing()
          .returning({ authorizationId: externalAuthorizations.id });
        if (created) return { ...created, created: true, revoked: false };
        const existing = await externalAuthorization(tx, accountId, {
          authorizationId,
          application,
          resourceId,
        });
        if (
          existing?.expiresAt.getTime() !== terms.expiresAt.getTime() ||
          existing.maxMicrocredits !== terms.maxMicrocredits
        )
          return undefined;
        return {
          authorizationId: existing.id,
          created: false,
          revoked: existing.revokedAt !== null,
        };
      });
    },

    async revokeExternalSpending(
      identity: VerifiedBillingIdentity,
      scope: ExternalSpendingScope,
    ) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return false;
        const authorization = await externalAuthorization(tx, accountId, scope);
        if (!authorization) return false;
        if (authorization.revokedAt === null)
          await tx
            .update(externalAuthorizations)
            .set({ revokedAt: await currentTime(tx) })
            .where(eq(externalAuthorizations.id, authorization.id));
        return true;
      });
    },

    async reserve(
      identity: VerifiedBillingIdentity,
      request: {
        operationId: string;
        route: string;
        priceVersion: string;
        rerunOfOperationId?: string;
        budgetId?: string;
        stepId?: string;
        // Which entry the caller chose (#107): "test" spends Test Credit
        // only, "paid" paid sources only; the default spans both (#101).
        creditType?: "test" | "paid";
        // The app the step runs for, kept on the operation for the bill.
        applicationId?: string;
        // An application's step runs under the person's Spending
        // Authorization for it, within the resource it names (#111). A
        // background authorization names its one task.
        authorizationId?: string;
        resourceId?: string;
        taskId?: string;
        // False for a caller that will not retry this operation by its ID.
        resumable?: boolean;
        // Host-owned execution identity. Include earlier charges if the person
        // moved this execution to another budget while it was paused.
        cumulativeExecution?: boolean;
        child?: Omit<ChildBudgetBinding, "budgetId">;
        coordinationToolNames?: string[];
        parentRunId?: string;
        scope?: ExternalSpendingScope;
        embeddingInputDigest?: string;
      },
      {
        embedding = false,
        weknoraWork,
        managedApplication = false,
      }: {
        embedding?: boolean;
        weknoraWork?: WeKnoraWork;
        managedApplication?: boolean;
      } = {},
    ) {
      const reservation = database.transaction(async (tx) => {
        const status = request.scope
          ? await externalAccount(tx, identity)
          : null;
        const accountId = await account(identity, tx);
        if (!accountId) return denied("not_authorized");
        const external = request.scope
          ? await externalAuthorization(tx, accountId, request.scope)
          : undefined;
        if (
          request.scope &&
          (request.authorizationId ||
            request.creditType === "paid" ||
            weknoraWork ||
            request.budgetId ||
            (request.applicationId !== undefined &&
              request.applicationId !== request.scope.application))
        )
          return denied("not_authorized");
        if (
          !external &&
          (embedding || weknoraWork) &&
          (request.applicationId !== WEKNORA_APPLICATION_ID ||
            // #110 平台预算: maintenance may name an execution budget on the
            // platform Billing Account instead of a person's authorization.
            (!request.authorizationId &&
              !(weknoraWork === "maintenance" && request.budgetId)))
        )
          return denied("not_authorized");
        const purpose =
          embedding || external
            ? "embedding"
            : weknoraWork === "rerank"
              ? "rerank"
              : undefined;
        const pilotResource = weknoraWork ?? purpose ?? "chat";
        const now = await currentTime(tx);
        const access = accountDecision(status, now.getTime());
        if (
          request.scope &&
          (!external ||
            external.revokedAt !== null ||
            external.expiresAt <= now ||
            access.kind !== "active")
        )
          return denied("not_authorized");
        await applyCutoff(tx, accountId, now);
        const expired = new Date(now.getTime() - reservationMilliseconds);
        const stale = await tx
          .select()
          .from(operations)
          .where(
            and(
              eq(operations.accountId, accountId),
              eq(operations.state, "reserved"),
              lte(operations.createdAt, expired),
            ),
          );
        for (const row of stale) await releaseReservation(tx, row);
        // A step that stopped for want of credits or budget room resumes on
        // the budget the person confirmed for it (#107 安全续做点): that one
        // confirmation is the entry for this step, whatever the runner asks.
        const ingestionAuthorizationId =
          embedding && request.creditType !== "paid"
            ? request.authorizationId
            : undefined;
        const pointId = ingestionAuthorizationId
          ? ingestionPointKey(ingestionAuthorizationId, request.operationId)
          : request.operationId;
        const [paused] = await tx
          .select()
          .from(resumePoints)
          .where(
            and(
              eq(resumePoints.accountId, accountId),
              eq(resumePoints.operationId, pointId),
            ),
          )
          .for("update");
        const prior = await operation(accountId, request.operationId, tx);
        const child = request.child;
        const [matched] =
          child && request.budgetId && !prior && !paused?.requiredBudgetId
            ? await tx
                .select({ id: budgets.id })
                .from(budgets)
                .where(
                  and(
                    eq(budgets.accountId, accountId),
                    eq(budgets.parentBudgetId, request.budgetId),
                    eq(budgets.childKind, child.kind),
                    eq(budgets.childBotId, child.botId),
                  ),
                )
            : [];
        const requiredBudgetId =
          paused?.requiredBudgetId ??
          (child
            ? (prior?.budgetId ?? matched?.id ?? request.budgetId)
            : undefined);
        const continued = paused?.budgetId
          ? await budget(accountId, paused.budgetId, tx)
          : undefined;
        const input = requiredBudgetId
          ? { ...request, budgetId: requiredBudgetId }
          : continued
            ? {
                ...request,
                creditType: continued.creditType,
                budgetId: continued.id,
              }
            : request;
        // Nothing is held or dispatched for a step refused for want of
        // credits or budget room, so it waits here until the person sets a
        // budget (#107 安全续做点).
        const pause = async (
          reason: (typeof resumePoints.$inferInsert)["reason"],
        ) => {
          // A step nothing will retry cannot continue, so it waits nowhere.
          if (external || request.resumable === false) return denied(reason);
          await tx
            .insert(resumePoints)
            .values({
              accountId,
              operationId: pointId,
              requiredBudgetId,
              applicationId:
                input.applicationId ?? under?.held?.applicationId ?? null,
              reason,
              createdAt: now,
            })
            .onConflictDoUpdate({
              target: [resumePoints.accountId, resumePoints.operationId],
              set: {
                reason:
                  paused?.reason === "trial_ended" ? paused.reason : reason,
                applicationId:
                  input.applicationId ?? under?.held?.applicationId ?? null,
                // A confirmed budget with no room for the step cannot
                // continue it: the step waits again for the person to pick
                // another.
                ...((request.cumulativeExecution ||
                  reason !== "insufficient_credits") &&
                paused?.budgetId
                  ? { budgetId: null, confirmedAt: null }
                  : {}),
              },
            });
          return denied(reason);
        };
        const existing = prior;
        if (existing) {
          if (!embedding && request.authorizationId) {
            const held = await authorization(
              accountId,
              request.authorizationId,
              tx,
            );
            if (
              !held ||
              held.taskId !== (request.taskId ?? null) ||
              !request.resourceId?.startsWith(held.resourcePrefix)
            )
              return denied("not_authorized");
          }
          if (
            existing.authorizationId !== (input.authorizationId ?? null) ||
            (!request.child &&
              existing.parentRunId !== (input.parentRunId ?? null)) ||
            existing.route.purpose !== purpose ||
            (existing.pilotResource !== null &&
              existing.pilotResource !== pilotResource) ||
            (existing.requestedCreditType !== null &&
              input.creditType !== undefined &&
              existing.requestedCreditType !== input.creditType) ||
            (embedding && existing.stepId !== input.stepId) ||
            (input.applicationId !== undefined &&
              existing.applicationId !== input.applicationId) ||
            existing.externalAuthorizationId !== (external?.id ?? null) ||
            existing.embeddingInputDigest !==
              (input.embeddingInputDigest ?? null)
          )
            return denied("not_authorized");
          const sameQuote =
            existing.route.id === input.route &&
            existing.priceVersion === input.priceVersion &&
            existing.rerunOfOperationId ===
              (input.rerunOfOperationId ?? null) &&
            (embedding || existing.budgetId === (input.budgetId ?? null)) &&
            existing.stepId === (input.stepId ?? null);
          if (
            existing.rerunOfOperationId !==
              (input.rerunOfOperationId ?? null) ||
            (!embedding && existing.budgetId !== (input.budgetId ?? null)) ||
            existing.stepId !== (input.stepId ?? null)
          )
            return denied("not_authorized");
          return {
            state: "existing",
            operation: await receiptFor(
              tx,
              existing,
              await eligibleEvidence(tx, existing),
            ),
            permit:
              existing.state === "reserved" &&
              sameQuote &&
              (existing.externalAccountEpoch === null ||
                externalReservationStillAuthorized(
                  status,
                  existing.externalAccountEpoch,
                ))
                ? existing.permit
                : undefined,
          } as const;
        }
        if (
          input.rerunOfOperationId !== undefined &&
          !(await operation(accountId, input.rerunOfOperationId, tx))
            ?.dispatchedAt
        )
          return denied("not_authorized");
        // Permanent pilot wind-down (#109): no new reservations of
        // either Credit type. Dispatched work above keeps its replay.
        if (await pilotReservesStoppedAt(tx, accountId))
          return denied("pilot_closed");
        if (await suspended(tx, accountId)) return denied("not_authorized");
        // While a restore from backup holds the account, no step is charged
        // (#108 恢复阶段暂停新增收费步骤).
        if (await restoreHolds(tx, accountId)) return denied("unavailable");
        const under = request.authorizationId
          ? await underAuthorization(
              tx,
              accountId,
              {
                authorizationId: request.authorizationId,
                applicationId: request.applicationId,
                taskId: request.taskId,
              },
              now,
            )
          : undefined;
        if (under?.refusal) return denied(under.refusal);
        const grantedType =
          under?.held?.creditType ??
          (under?.held &&
          (pilot || managedApplication || embedding || weknoraWork)
            ? "test"
            : undefined);
        if (grantedType && input.creditType && input.creditType !== grantedType)
          return denied("not_authorized");
        const funding = external ? "test" : (grantedType ?? input.creditType);
        if (grantedType === "paid" && !pilot)
          return denied("route_unavailable");
        const applicationId =
          under?.held.applicationId ??
          external?.application ??
          input.applicationId ??
          "openbot";
        const pilotPath = pilot
          ? await application(applicationId, tx, true)
          : undefined;
        if (pilotPath?.pausedAt) return denied("route_unavailable");
        if (
          under?.held.applicationId === WEKNORA_APPLICATION_ID &&
          !embedding &&
          (!weknoraWork ||
            request.resourceId !== under.held.resourcePrefix ||
            !request.resourceId?.endsWith(`:${weknoraWork}`) ||
            under.held.kind !==
              (weknoraWork === "maintenance" ? "background" : "online"))
        )
          return denied("not_authorized");
        // Within the resource scope the person granted, which every step of
        // an application names (#111 资源范围).
        if (
          under?.held &&
          (embedding
            ? under.held.kind !== "background" ||
              request.resourceId !== under.held.resourcePrefix
            : !request.resourceId?.startsWith(under.held.resourcePrefix))
        )
          return denied("not_authorized");
        if (ingestionAuthorizationId) {
          if (
            paused?.reason === "execution_limit" &&
            continued?.creditType !== "test"
          )
            return denied("execution_limit");
          const [priorPause] = await tx
            .select({ operationId: resumePoints.operationId })
            .from(resumePoints)
            .where(
              and(
                eq(resumePoints.accountId, accountId),
                like(
                  resumePoints.operationId,
                  ingestionPointKey(ingestionAuthorizationId, "%"),
                ),
                ne(resumePoints.operationId, pointId),
                eq(resumePoints.reason, "execution_limit"),
              ),
            )
            .limit(1);
          if (priorPause) return denied("execution_limit");
        }
        if (
          !external &&
          !embedding &&
          paused &&
          !continued &&
          !requiredBudgetId
        )
          return denied(paused.reason);
        const executionBudget = input.budgetId
          ? await budget(accountId, input.budgetId, tx)
          : undefined;
        // A task fixes its Credit type when it starts: the budget must
        // match the entry the caller chose (#107).
        if (
          input.budgetId &&
          executionBudget?.creditType !== (funding ?? "test")
        )
          return denied("not_authorized");
        if (funding !== "paid" && (await trialEnded(tx, accountId)))
          return embedding ? denied("trial_ended") : pause("trial_ended");
        const limits = executionBudget
          ? await budgetChain(tx, executionBudget)
          : [];
        if (limits.some((limit) => !activeBudget(limit)))
          return pause("execution_limit");
        const active = await activeRoutes(tx, true);
        const route = active?.options.find(({ id }) => id === input.route);
        if (
          !route ||
          route.purpose !== purpose ||
          active?.priceVersion !== input.priceVersion
        )
          return denied("route_unavailable");
        const reserved = BigInt(route.maxChargeMicrocredits);
        if (external) {
          const used = await chargedOrHeld(
            tx,
            and(
              eq(operations.accountId, accountId),
              eq(operations.externalAuthorizationId, external.id),
            ),
          );
          if (used + reserved > external.maxMicrocredits)
            return denied("insufficient_credits");
          const atReservation = await currentTime(tx);
          if (
            external.expiresAt <= atReservation ||
            accountDecision(status, atReservation.getTime()).kind !== "active"
          )
            return denied("not_authorized");
        }
        for (const limit of limits) {
          const used =
            limit.id === executionBudget?.id &&
            input.cumulativeExecution &&
            input.stepId
              ? await chargedOrHeld(
                  tx,
                  and(
                    eq(operations.accountId, accountId),
                    or(
                      withinBudget(accountId, limit.id),
                      and(
                        eq(operations.applicationId, "openbot"),
                        eq(operations.stepId, input.stepId),
                      ),
                    ),
                  ),
                )
              : await budgetUsage(accountId, limit.id, tx);
          if (used + reserved > limit.limitMicrocredits)
            return pause("execution_limit");
        }
        // Ingestion waits at its original operation until the person raises
        // the grant ceiling and confirms a Test Credit continuation budget.
        if (under?.held) {
          const used = await authorizationUsage(tx, accountId, under.held.id);
          if (used + reserved > under.held.limitMicrocredits)
            return embedding
              ? pause("execution_limit")
              : denied("execution_limit");
        }
        // The route cap has its own scope. Read it after acquiring the
        // same lock used by route-cap edits.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${route.id}))`,
        );
        const [costLimit] = await tx
          .select()
          .from(pilotProviderCostLimits)
          .where(eq(pilotProviderCostLimits.path, route.id));
        if (costLimit) {
          const outstanding = await providerCostOutstanding(tx, route.id);
          if (outstanding + reserved > costLimit.limitMicrocredits)
            return denied("route_unavailable");
        }
        if (
          input.cumulativeExecution &&
          (executionBudget?.modelRoute !== input.route ||
            executionBudget?.modelPriceVersion !== input.priceVersion)
        )
          return denied("route_unavailable");
        const balance = await totals(tx, accountId);
        // The two entries choose their Credit type (#107 试用与付费入口分
        // 开选择): "test" spends Test Credit only, "paid" funds the whole
        // bound from paid sources only, and the default spans both — the
        // trial balance first and the paid ledger holding any shortfall in
        // this same transaction (#101).
        if (
          pilot &&
          (funding === "paid" ||
            (funding === undefined && balance.available < reserved))
        ) {
          // The shared-cost trigger and the operator use this same lock.
          await tx.execute(sql`select lock_pilot_provider_cost()`);
          if (
            !pilotPath?.approvedAt ||
            !(await paidPolicy(
              tx,
              applicationId,
              accountId,
              route,
              reserved,
              pilotResource,
            ))
          )
            return denied("route_unavailable");
        }
        let paidHold = 0n;
        if (funding === "paid") {
          const paid = await allocatePaidSources(
            tx,
            {
              accountId,
              operationId: input.operationId,
              amountMicrocredits: reserved,
            },
            now,
          );
          if (paid.state !== "allocated") return pause("insufficient_credits");
          paidHold = paid.amount;
        } else if (funding === "test") {
          if (balance.granted === 0n) return denied("not_authorized");
          if (balance.available < reserved)
            return pause("insufficient_credits");
        } else {
          const shortfall = reserved - balance.available;
          if (shortfall > 0n) {
            const paid = await allocatePaidSources(
              tx,
              {
                accountId,
                operationId: input.operationId,
                amountMicrocredits: shortfall,
              },
              now,
            );
            // "existing" cannot happen: the operation row is checked above
            // and allocations roll back with the reservation that created
            // them.
            if (paid.state !== "allocated")
              return balance.granted === 0n
                ? denied("not_authorized")
                : pause("insufficient_credits");
            paidHold = paid.amount;
          }
        }
        const [row] = await tx
          .insert(operations)
          .values({
            accountId,
            id: input.operationId,
            priceVersion: input.priceVersion,
            route,
            reserved,
            paidHoldMicrocredits: paidHold,
            pilotResource,
            requestedCreditType: funding,
            createdAt: now,
            rerunOfOperationId: input.rerunOfOperationId,
            externalAuthorizationId: external?.id,
            embeddingInputDigest: input.embeddingInputDigest,
            externalAccountEpoch:
              external && access.kind === "active" ? access.epoch : undefined,
            state: "reserved",
            budgetId: input.budgetId,
            coordinationToolNames: input.coordinationToolNames,
            parentRunId: input.parentRunId,
            stepId: input.stepId,
            applicationId:
              input.applicationId ??
              under?.held.applicationId ??
              external?.application ??
              null,
            authorizationId: under?.held.id ?? null,
          })
          .returning();
        if (costLimit) {
          await tx
            .insert(pilotProviderCostHolds)
            .values({
              path: route.id,
              accountId,
              operationId: input.operationId,
              boundMicrocredits: reserved,
              state: "held",
            })
            .onConflictDoNothing();
        }
        if (!row)
          throw new Error("Test Credit reservation could not be created");
        if (ingestionAuthorizationId && paused)
          await tx
            .delete(resumePoints)
            .where(
              and(
                eq(resumePoints.accountId, accountId),
                eq(resumePoints.operationId, pointId),
              ),
            );
        return {
          state: "reserved",
          permit: row.permit,
          operation: operationReceipt(
            row,
            undefined,
            executionBudget?.creditType,
          ),
        } as const;
      });
      return reservation.catch((error: unknown) => {
        if (sharedPilotLimitReached(error)) return denied("route_unavailable");
        throw error;
      });
    },

    /** Registers an application and the resource scope it may be authorized for (#111). A second registration must repeat it. */
    async registerApplication(input: {
      id: string;
      name: string;
      operator: "platform" | "independent";
      resourcePrefix: string;
    }) {
      return database.transaction(async (tx) => {
        const existing = await application(input.id, tx);
        if (existing) {
          if (
            existing.operator !== input.operator ||
            existing.resourcePrefix !== input.resourcePrefix
          )
            throw new Error("Application registration differs");
          return existing;
        }
        const [row] = await tx
          .insert(applications)
          .values({
            id: input.id,
            name: input.name,
            operator: input.operator,
            resourcePrefix: input.resourcePrefix,
          })
          .returning();
        if (!row) throw new Error("Application could not be registered");
        return row;
      });
    },

    approveApplication: (id: string, by: string) =>
      markApplication(id, "approve", by),

    /** Pausing an application's path stops its new reservations; the ones already made keep settling (#112). */
    pauseApplication: (id: string, by: string) =>
      markApplication(id, "pause", by),

    resumeApplication: (id: string) => markApplication(id, "resume", ""),

    async approvedIndependentApplication(id: string) {
      const [row] = await database
        .select()
        .from(applications)
        .where(eq(applications.id, id));
      return row?.operator === "independent" && row.approvedAt !== null;
    },

    /** Every application with its approval and pause state. */
    async applications() {
      return database
        .select()
        .from(applications)
        .orderBy(applications.createdAt, applications.id);
    },

    /**
     * The person's explicit grant to an application (#111): which resources,
     * until when, and the most it may spend. Nothing is granted for an
     * application that is not approved, or for a resource outside the scope
     * it registered.
     */
    async authorize(
      identity: VerifiedBillingIdentity,
      input: {
        authorizationId: string;
        applicationId: string;
        // A background authorization is bound to one task.
        kind: "online" | "background";
        creditType?: "test" | "paid";
        taskId?: string;
        resourcePrefix?: string;
        expiresAt: Date;
        limitMicrocredits: bigint;
      },
    ) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        const existing = await authorization(
          accountId,
          input.authorizationId,
          tx,
        );
        // A second ask with the same ID answers with the first grant, or
        // nothing when it was for another application.
        if (existing) {
          if (
            existing.applicationId !== input.applicationId ||
            (existing.creditType ?? "test") !== (input.creditType ?? "test")
          )
            return { state: "denied" as const };
          return {
            state: "existing" as const,
            authorization: await authorizationRecord(
              tx,
              existing,
              await authorizationUsage(tx, accountId, existing.id),
            ),
          };
        }
        const path = await application(input.applicationId, tx);
        const prefix = input.resourcePrefix ?? path?.resourcePrefix;
        const at = await currentTime(tx);
        if (
          !path?.approvedAt ||
          !prefix?.startsWith(path.resourcePrefix) ||
          (input.kind === "background") !== (input.taskId !== undefined) ||
          input.limitMicrocredits <= 0n ||
          input.expiresAt <= at
        )
          return { state: "denied" as const };
        const [granted] = await tx
          .insert(authorizations)
          .values({
            id: input.authorizationId,
            applicationId: input.applicationId,
            accountId,
            kind: input.kind,
            creditType: input.creditType,
            taskId: input.taskId ?? null,
            resourcePrefix: prefix,
            expiresAt: input.expiresAt,
            limitMicrocredits: input.limitMicrocredits,
          })
          .returning();
        if (!granted) throw new Error("Authorization could not be recorded");
        return {
          state: "authorized" as const,
          authorization: await authorizationRecord(tx, granted, 0n),
        };
      });
    },

    /** Withdraws the grant. Reservations already made under it do not run. */
    async revokeAuthorization(
      identity: VerifiedBillingIdentity,
      authorizationId: string,
    ) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        const [row] = await tx
          .update(authorizations)
          .set({ revokedAt: await currentTime(tx) })
          .where(
            and(
              eq(authorizations.accountId, accountId),
              eq(authorizations.id, authorizationId),
            ),
          )
          .returning();
        return (
          row &&
          (await authorizationRecord(
            tx,
            row,
            await authorizationUsage(tx, accountId, row.id),
          ))
        );
      });
    },

    /**
     * Raising what an authorization may spend, or how long it lasts, is the
     * person's own decision (#86 增加上限需用户确认). A change that would lower
     * either changes nothing.
     */
    async amendAuthorization(
      identity: VerifiedBillingIdentity,
      authorizationId: string,
      input: { limitMicrocredits?: bigint; expiresAt?: Date },
    ) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        const row = await authorization(accountId, authorizationId, tx);
        if (!row) return undefined;
        const limitMicrocredits =
          input.limitMicrocredits ?? row.limitMicrocredits;
        const expiresAt = input.expiresAt ?? row.expiresAt;
        if (
          limitMicrocredits < row.limitMicrocredits ||
          expiresAt < row.expiresAt
        )
          return { state: "not_widened" as const };
        const [updated] = await tx
          .update(authorizations)
          .set({ limitMicrocredits, expiresAt })
          .where(
            and(
              eq(authorizations.accountId, accountId),
              eq(authorizations.id, authorizationId),
            ),
          )
          .returning();
        if (!updated) return undefined;
        return {
          state: "amended" as const,
          authorization: await authorizationRecord(
            tx,
            updated,
            await authorizationUsage(tx, accountId, updated.id),
          ),
        };
      });
    },

    /** The person's Spending Authorizations, each with what it has used. */
    async authorizations(identity: VerifiedBillingIdentity) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        const rows = await tx
          .select()
          .from(authorizations)
          .where(eq(authorizations.accountId, accountId))
          .orderBy(authorizations.createdAt, authorizations.id);
        return Promise.all(
          rows.map(
            async (row) =>
              await authorizationRecord(
                tx,
                row,
                await authorizationUsage(tx, accountId, row.id),
              ),
          ),
        );
      });
    },

    /**
     * The account an application acts for through one of its authorizations.
     * An application that was never granted this one acts for nobody.
     */
    async authorizationIdentity(
      applicationId: string,
      authorizationId: string,
    ) {
      return database.transaction(async (tx) => {
        const [row] = await tx
          .select({ issuer: accounts.issuer, subject: accounts.subject })
          .from(authorizations)
          .innerJoin(accounts, eq(accounts.id, authorizations.accountId))
          .where(
            and(
              eq(authorizations.id, authorizationId),
              eq(authorizations.applicationId, applicationId),
            ),
          );
        return row;
      });
    },

    /**
     * What an application may read of a person's account: only through the
     * authorizations granted to it (#111 应用只能查询自身授权范围内的账户摘要).
     */
    async authorizationSummary(applicationId: string, authorizationId: string) {
      return database.transaction(async (tx) => {
        const [held] = await tx
          .select()
          .from(authorizations)
          .where(
            and(
              eq(authorizations.id, authorizationId),
              eq(authorizations.applicationId, applicationId),
            ),
          );
        if (!held) return undefined;
        const spent = await chargedOrHeld(
          tx,
          and(
            eq(operations.accountId, held.accountId),
            eq(operations.authorizationId, held.id),
          ),
        );
        const grant = await authorizationRecord(tx, held, spent);
        if (grant.creditType === "paid") {
          return {
            ...grant,
            ...(await paidBalanceWithin(
              tx,
              held.accountId,
              await currentTime(tx),
            )),
          };
        }
        const balance = await totals(tx, held.accountId);
        return {
          ...grant,
          availableMicrocredits: balance.available.toString(),
          reservedMicrocredits: balance.held.toString(),
          chargedMicrocredits: balance.spent.toString(),
        };
      });
    },

    /** The receipt of one step, if it ran under this application's authorization. */
    async authorizedOperation(
      applicationId: string,
      authorizationId: string,
      operationId: string,
    ) {
      return database.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(operations)
          .innerJoin(
            authorizations,
            and(
              eq(authorizations.accountId, operations.accountId),
              eq(authorizations.id, operations.authorizationId),
            ),
          )
          .where(
            and(
              eq(operations.id, operationId),
              eq(authorizations.id, authorizationId),
              eq(authorizations.applicationId, applicationId),
            ),
          )
          .limit(1);
        const step = row?.test_credit_operations;
        if (!step || !(await lockAccount(tx, step.accountId))) return undefined;
        if (step.route.purpose === "embedding")
          return settlePending(tx, step.accountId, step.id);
        await applyCutoff(tx, step.accountId, await currentTime(tx));
        const record = await operation(step.accountId, step.id, tx);
        return (
          record &&
          (await receiptFor(tx, record, await eligibleEvidence(tx, record)))
        );
      });
    },

    async ingestionPause(authorizationId: string, operationId: string) {
      const [row] = await database
        .select({
          reason: resumePoints.reason,
          confirmedAt: resumePoints.confirmedAt,
        })
        .from(resumePoints)
        .innerJoin(
          authorizations,
          eq(authorizations.accountId, resumePoints.accountId),
        )
        .where(
          and(
            eq(authorizations.id, authorizationId),
            eq(authorizations.applicationId, WEKNORA_APPLICATION_ID),
            eq(
              resumePoints.operationId,
              ingestionPointKey(authorizationId, operationId),
            ),
          ),
        );
      return row;
    },

    /**
     * The steps still waiting on the person to set a budget, oldest first. A
     * resumed step keeps its row, so the runner's replay of the same request
     * resolves to the same budget, and leaves this list.
     */
    async resumePoints(identity: VerifiedBillingIdentity) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        const rows = await tx
          .select({
            operationId: resumePoints.operationId,
            applicationId: resumePoints.applicationId,
            reason: resumePoints.reason,
            createdAt: resumePoints.createdAt,
            requiredBudgetId: resumePoints.requiredBudgetId,
            budgetId: resumePoints.budgetId,
            confirmedAt: resumePoints.confirmedAt,
            creditType: budgets.creditType,
          })
          .from(resumePoints)
          .leftJoin(
            budgets,
            and(
              eq(budgets.accountId, resumePoints.accountId),
              eq(budgets.id, resumePoints.budgetId),
            ),
          )
          .where(
            and(
              eq(resumePoints.accountId, accountId),
              notExists(
                tx
                  .select({ id: operations.id })
                  .from(operations)
                  .where(
                    and(
                      eq(operations.accountId, resumePoints.accountId),
                      eq(operations.id, resumePoints.operationId),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(resumePoints.createdAt);
        return rows.map((row) => {
          const [application, authorizationId, operationId] =
            row.operationId.split(":");
          return application === "weknora" && authorizationId && operationId
            ? { ...row, authorizationId, operationId }
            : row;
        });
      });
    },

    /**
     * The person's explicit confirmation (#107): the budget a paused step
     * continues on, from their own confirmed, active budgets. A step that ran
     * out of credits continues on paid credits only.
     */
    async confirmResumePoint(
      identity: VerifiedBillingIdentity,
      operationId: string,
      budgetId: string,
      authorizationId?: string,
      newLimit?: bigint,
    ) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        const pointId = authorizationId
          ? ingestionPointKey(authorizationId, operationId)
          : operationId;
        const grant = authorizationId
          ? await authorization(accountId, authorizationId, tx)
          : undefined;
        if (
          authorizationId &&
          (grant?.applicationId !== WEKNORA_APPLICATION_ID ||
            grant.revokedAt ||
            grant.expiresAt <= (await currentTime(tx)))
        )
          return undefined;
        const [point] = await tx
          .select()
          .from(resumePoints)
          .where(
            and(
              eq(resumePoints.accountId, accountId),
              eq(resumePoints.operationId, pointId),
            ),
          )
          .for("update");
        if (!point || (await operation(accountId, operationId, tx)))
          return undefined;
        const target = await budget(accountId, budgetId, tx);
        if (
          (point.requiredBudgetId !== null &&
            point.requiredBudgetId !== budgetId) ||
          target?.state !== "active" ||
          target.confirmedAt === null ||
          (target.creditType === "test" && (await trialEnded(tx, accountId))) ||
          (point.reason === "trial_ended" &&
            (target.creditType !== "paid" ||
              target.createdAt < point.createdAt ||
              (point.applicationId === "openbot" &&
                !target.modelPriceVersion))) ||
          (authorizationId
            ? target.creditType !== "test" || point.reason !== "execution_limit"
            : point.reason === "insufficient_credits" &&
              target.creditType !== "paid" &&
              !(point.applicationId === "openbot" && target.modelPriceVersion))
        )
          return { state: "denied" as const };
        if (newLimit !== undefined) {
          if (
            !grant ||
            newLimit < grant.limitMicrocredits ||
            (newLimit === grant.limitMicrocredits && point.confirmedAt === null)
          )
            return { state: "denied" as const };
          await tx
            .update(authorizations)
            .set({ limitMicrocredits: newLimit })
            .where(
              and(
                eq(authorizations.accountId, accountId),
                eq(authorizations.id, grant.id),
              ),
            );
        }
        const confirmedAt = await currentTime(tx);
        await tx
          .update(resumePoints)
          .set({ budgetId, confirmedAt })
          .where(
            and(
              eq(resumePoints.accountId, accountId),
              eq(resumePoints.operationId, pointId),
            ),
          );
        return {
          state: "confirmed" as const,
          operationId,
          budgetId,
          creditType: target.creditType,
          confirmedAt,
        };
      });
    },

    async routeStillEligible(route: ReleasedBifrostRoute) {
      return routeEligible(await activeRoutes(database), route);
    },

    async discardReservation(
      identity: VerifiedBillingIdentity,
      input: {
        operationId: string;
        permit: string;
      },
    ) {
      await database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return;
        const row = await operation(accountId, input.operationId, tx);
        if (row?.state === "reserved" && row.permit === input.permit)
          await releaseReservation(tx, row);
      });
    },

    async beginDispatch(
      identity: VerifiedBillingIdentity,
      input: {
        operationId: string;
        permit: string;
        authorizationId?: string;
        scope?: ExternalSpendingScope;
        embeddingInputDigest?: string;
      },
      { executorAvailable = true, embedding = false, rerank = false } = {},
    ) {
      return database.transaction(async (tx) => {
        const status = input.scope ? await externalAccount(tx, identity) : null;
        const accountId = await account(identity, tx);
        if (!accountId) return denied("not_authorized");
        await applyCutoff(tx, accountId, await currentTime(tx));
        const row = await operation(accountId, input.operationId, tx);
        if (
          !row ||
          row.permit !== input.permit ||
          row.route.purpose !==
            (embedding || input.scope
              ? "embedding"
              : rerank
                ? "rerank"
                : undefined) ||
          row.authorizationId !== (input.authorizationId ?? null) ||
          row.embeddingInputDigest !== (input.embeddingInputDigest ?? null) ||
          row.externalAuthorizationId !== (input.scope?.authorizationId ?? null)
        )
          return denied("not_authorized");
        const externalGrant = input.scope
          ? await externalAuthorization(tx, accountId, input.scope)
          : undefined;
        if (input.scope && !externalGrant) return denied("not_authorized");
        if (row.state !== "reserved")
          return {
            state: "existing",
            operation: await receiptFor(
              tx,
              row,
              await eligibleEvidence(tx, row),
            ),
          } as const;
        const filter = operationFilter(row.accountId, row.id);
        if (await pilotReservesStoppedAt(tx, accountId)) {
          await releaseReservation(tx, row);
          return denied("pilot_closed");
        }
        // Suspension and a restore reach reservations made before them: none
        // may run, while what already dispatched settles (#103, #108).
        if (
          (await suspended(tx, accountId)) ||
          (await restoreHolds(tx, accountId))
        ) {
          await releaseReservation(tx, row);
          return denied("not_authorized");
        }
        if (
          row.paidHoldMicrocredits > 0n &&
          (await hasDisputedPaidHold(tx, row.accountId, row.id))
        ) {
          await releaseReservation(tx, row);
          return denied("insufficient_credits");
        }
        let deadline: Date | undefined;
        if (row.authorizationId) {
          // Revoked, expired or paused since the reservation: it does not
          // run (#111 在派发前复查, #112).
          // The reservation already matched the immutable task of this grant.
          const grant = await authorization(
            row.accountId,
            row.authorizationId,
            tx,
          );
          const under = await underAuthorization(
            tx,
            row.accountId,
            {
              authorizationId: row.authorizationId,
              taskId: grant?.taskId ?? undefined,
            },
            await currentTime(tx),
          );
          if (under.refusal) {
            await releaseReservation(tx, row);
            return denied(under.refusal);
          }
          deadline = under.held.expiresAt;
        }
        const policy = await dispatchPolicy(tx, row);
        if (!policy) {
          await releaseReservation(tx, row);
          return denied("route_unavailable");
        }
        const active = await activeRoutes(tx, true);
        if (!(await canDispatchUnderBudget(tx, row))) {
          await releaseReservation(tx, row);
          return denied("execution_limit");
        }
        const eligible = routeEligible(active, row.route);
        const dispatchedAt = await currentTime(tx);
        if (deadline && dispatchedAt >= deadline) {
          await releaseReservation(tx, row);
          return denied("not_authorized");
        }
        if (externalGrant) {
          const access = accountDecision(status, dispatchedAt.getTime());
          if (
            externalGrant.revokedAt !== null ||
            externalGrant.expiresAt <= dispatchedAt ||
            access.kind !== "active" ||
            !externalReservationStillAuthorized(
              status,
              row.externalAccountEpoch,
            )
          )
            return denied("not_authorized");
        }
        if (
          !eligible ||
          dispatchedAt.getTime() - row.createdAt.getTime() >=
            reservationMilliseconds
        ) {
          await releaseReservation(tx, row);
          return denied("route_unavailable");
        }
        if (!executorAvailable)
          return { state: "executor_unavailable" } as const;
        await tx
          .update(operations)
          .set({
            state: "pending",
            dispatchedAt,
            reconciliationCutoffAt:
              policy.windowSeconds === undefined
                ? null
                : new Date(
                    dispatchedAt.getTime() + policy.windowSeconds * 1000,
                  ),
          })
          .where(filter);
        return {
          state: "dispatch",
          route: row.route,
          accountId: row.accountId,
        } as const;
      });
    },

    async releaseUnsent(accountId: string, id: string) {
      await database.transaction(async (tx) => {
        if (!(await lockAccount(tx, accountId))) return;
        const row = await operation(accountId, id, tx);
        const unsent = await tx
          .update(operations)
          .set({
            state: "released",
            dispatchedAt: null,
            reconciliationCutoffAt: null,
          })
          .where(
            and(
              operationFilter(accountId, id),
              eq(operations.state, "pending"),
              isNull(operations.eligibleEvidenceId),
              isNull(operations.gatewayRequestId),
            ),
          )
          .returning({ id: operations.id });
        if (unsent.length > 0 && row && row.paidHoldMicrocredits > 0n) {
          await tx
            .update(operations)
            .set({ paidHoldMicrocredits: 0n })
            .where(operationFilter(accountId, id));
          await releasePaidAllocations(
            tx,
            accountId,
            id,
            await currentTime(tx),
          );
        }
        if (unsent.length > 0 && row)
          await resolveProviderCostHold(tx, row.route.id, accountId, id, {
            state: "released",
          });
      });
    },

    async bindGatewayRequest(
      accountId: string,
      id: string,
      { requestId, digest }: { requestId: string; digest: string },
      { recheckAdmission = false, recheckAuthorization = false } = {},
    ) {
      return database.transaction(async (tx) => {
        if (!(await lockAccount(tx, accountId))) return false;
        const now = await currentTime(tx);
        await applyCutoff(tx, accountId, now);
        if (pilot || recheckAdmission || recheckAuthorization) {
          const operationRow = await operation(accountId, id, tx);
          if (!operationRow || !(await dispatchPolicy(tx, operationRow)))
            return false;
          if (recheckAuthorization) {
            const grantId = operationRow.authorizationId;
            const grant =
              grantId && (await authorization(accountId, grantId, tx));
            if (
              !grant ||
              (
                await underAuthorization(
                  tx,
                  accountId,
                  {
                    authorizationId: grant.id,
                    taskId: grant.taskId ?? undefined,
                  },
                  now,
                )
              ).refusal ||
              (await suspended(tx, accountId)) ||
              (await restoreHolds(tx, accountId)) ||
              (await pilotReservesStoppedAt(tx, accountId)) ||
              !routeEligible(await activeRoutes(tx, true), operationRow.route)
            )
              return false;
          }
          if (
            recheckAdmission &&
            (!operationRow.budgetId ||
              !(await canDispatchUnderBudget(tx, operationRow)) ||
              (await suspended(tx, accountId)) ||
              (await restoreHolds(tx, accountId)) ||
              (await pilotReservesStoppedAt(tx, accountId)) ||
              !routeEligible(await activeRoutes(tx, true), operationRow.route))
          )
            return false;
        }
        const [bound] = await tx
          .update(operations)
          .set({
            gatewayRequestId: requestId,
            gatewayRequestDigest: digest,
            gatewayEvidenceCheckAt: new Date(
              now.getTime() + gatewayTimeoutMilliseconds,
            ),
          })
          .where(
            and(
              operationFilter(accountId, id),
              eq(operations.state, "pending"),
              isNull(operations.cutoffHold),
              isNull(operations.eligibleEvidenceId),
              isNull(operations.gatewayRequestId),
            ),
          )
          .returning({ id: operations.id });
        return bound !== undefined;
      });
    },

    async claimGatewayEvidenceChecks() {
      return database.transaction(async (tx) => {
        const now = await currentTime(tx);
        const candidates = await tx
          .select({
            accountId: operations.accountId,
            operationId: operations.id,
            route: operations.route,
            requestId: operations.gatewayRequestId,
            digest: operations.gatewayRequestDigest,
            dispatchedAt: operations.dispatchedAt,
            reconciliationCutoffAt: operations.reconciliationCutoffAt,
          })
          .from(operations)
          .where(lte(operations.gatewayEvidenceCheckAt, now))
          .orderBy(
            operations.gatewayEvidenceCheckAt,
            operations.accountId,
            operations.id,
          )
          .limit(evidenceReadBatchSize)
          .for("update", { skipLocked: true });

        const checks = [];
        for (const {
          requestId,
          digest,
          dispatchedAt,
          reconciliationCutoffAt,
          ...candidate
        } of candidates) {
          const valid =
            requestId &&
            digest &&
            dispatchedAt &&
            Math.max(
              dispatchedAt.getTime() + evidenceRetentionMilliseconds,
              reconciliationCutoffAt?.getTime() ?? 0,
            ) > now.getTime();
          await tx
            .update(operations)
            .set({
              gatewayEvidenceCheckAt: valid
                ? new Date(now.getTime() + evidenceRetryMilliseconds)
                : null,
            })
            .where(operationFilter(candidate.accountId, candidate.operationId));
          if (valid) checks.push({ ...candidate, requestId, digest });
        }
        return checks;
      });
    },

    recordEvidence,
    async settleEmbedding(
      accountId: string,
      id: string,
      input:
        | Evidence
        | {
            evidenceId: string;
            inputTokens: bigint;
            vectors?: number[][];
          },
      vectors?: number[][],
    ) {
      if ("outcome" in input) {
        const recorded = await recordEvidence(accountId, id, {
          ...input,
          resultText:
            vectors === undefined ? undefined : JSON.stringify(vectors),
        });
        return recorded && settleRecorded(accountId, id);
      }
      const recorded = await recordEvidence(
        accountId,
        id,
        {
          evidenceId: input.evidenceId,
          outcome: input.vectors ? "completed" : "partial",
          inputTokens: input.inputTokens,
          outputTokens: 0n,
        },
        { vectors: input.vectors },
      );
      return recorded && settleRecorded(accountId, id);
    },
    async recordResult(accountId: string, id: string, text: string) {
      if (!text.trim()) throw new Error("Test Credit result must not be empty");
      return database.transaction(async (tx) => {
        if (!(await lockAccount(tx, accountId))) return undefined;
        const row = await operation(accountId, id, tx);
        if (!row || (row.state !== "pending" && row.state !== "settled"))
          return undefined;
        const [updated] = await tx
          .update(operations)
          .set({ resultText: text })
          .where(operationFilter(accountId, id))
          .returning();
        return (
          updated &&
          (await receiptFor(tx, updated, await eligibleEvidence(tx, updated)))
        );
      });
    },
    settleRecorded,

    /** Sets or replaces a provider-cost ceiling for one route. */
    async setProviderCostLimit(input: {
      path: string;
      limitMicrocredits: bigint;
      by: string;
    }) {
      if (input.path === sharedPilotCostScope)
        throw new RangeError("A route ID is required");
      return setCostLimit(input);
    },

    setPilotProviderCostLimit(input: {
      limitMicrocredits: bigint;
      by: string;
    }) {
      return setCostLimit({ ...input, path: sharedPilotCostScope });
    },

    async pilotProviderCost() {
      const [row] = await database.execute<{
        limit: string | null;
        updated_by: string | null;
        outstanding: string;
        operations: string;
      }>(sql`
        select ${pilotProviderCostLimits.limitMicrocredits}::text as limit,
               ${pilotProviderCostLimits.updatedBy} as updated_by,
               exposure.outstanding, exposure.operations
        from pilot_provider_cost_exposure exposure
        left join ${pilotProviderCostLimits} on ${pilotProviderCostLimits.path} = ${sharedPilotCostScope}
      `);
      if (!row) throw new Error("Pilot provider cost exposure is unavailable");
      return {
        limitMicrocredits: row.limit === null ? null : BigInt(row.limit),
        updatedBy: row.updated_by,
        operations: row.operations,
        outstandingMicrocredits: row.outstanding,
        remainingMicrocredits:
          row.limit === null
            ? null
            : (BigInt(row.limit) - BigInt(row.outstanding)).toString(),
      };
    },

    /** Ceiling and share composition for one path; null limit means uncapped. */
    async providerCost(path: string) {
      const [limit] = await database
        .select()
        .from(pilotProviderCostLimits)
        .where(eq(pilotProviderCostLimits.path, path));
      const rows = await database
        .select()
        .from(pilotProviderCostHolds)
        .where(eq(pilotProviderCostHolds.path, path));
      const outstanding = rows.reduce(
        (sum, row) =>
          sum +
          (row.state === "held"
            ? row.boundMicrocredits
            : (row.costMicrocredits ?? 0n)),
        0n,
      );
      return {
        limitMicrocredits: limit?.limitMicrocredits ?? null,
        updatedBy: limit?.updatedBy ?? null,
        holds: rows.length,
        outstandingMicrocredits: outstanding.toString(),
        remainingMicrocredits: limit
          ? (limit.limitMicrocredits - outstanding).toString()
          : null,
      };
    },

    async reconcile(
      identity: VerifiedBillingIdentity,
      id: string,
      authorizationId?: string,
    ) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        const row = await operation(accountId, id, tx);
        if (!row || row.authorizationId !== (authorizationId ?? null))
          return undefined;
        return settlePending(tx, accountId, id);
      });
    },

    async reconciliationCost(accountId: string, id: string) {
      return database.transaction(async (tx) => {
        if (!(await lockAccount(tx, accountId))) return undefined;
        const row = await operation(accountId, id, tx);
        if (!row) return undefined;
        return platformCost(tx, row, await eligibleEvidence(tx, row));
      });
    },

    // Compatibility for controlled callers that obtain a completed response inline.
    async settle(accountId: string, id: string, usage: Usage) {
      const recorded = await recordEvidence(accountId, id, {
        evidenceId: "inline-completion",
        outcome: "completed",
        ...usage,
      });
      return recorded && settleRecorded(accountId, id);
    },
  };

  // Evidence IDs belong to the trusted source. Each observation is cumulative for
  // the same upstream invocation, so replay or subsequent evidence never adds a debit.
  async function recordEvidence(
    accountId: string,
    id: string,
    verified: Evidence & {
      gatewayRequestId?: string;
      resultText?: string;
      resultCalls?: CoordinationModelCall[];
    },
    embedding?: { vectors?: number[][] },
  ) {
    return database.transaction(async (tx) => {
      if (!(await lockAccount(tx, accountId))) return undefined;
      const now = await currentTime(tx);
      await applyCutoff(tx, accountId, now);
      const row = await operation(accountId, id, tx);
      if (!row?.dispatchedAt) return undefined;
      if (
        embedding &&
        (row.route.purpose !== "embedding" || !row.embeddingInputDigest)
      )
        return undefined;
      const {
        evidenceId,
        outcome,
        inputTokens,
        outputTokens,
        gatewayRequestId,
        resultText,
      } = verified;
      const resultCalls = verified.resultCalls?.every(({ name }) =>
        row.coordinationToolNames?.includes(name),
      )
        ? verified.resultCalls
        : undefined;
      if (
        gatewayRequestId &&
        (row.gatewayRequestId !== gatewayRequestId ||
          row.eligibleEvidenceId !== null ||
          row.gatewayEvidenceCheckAt === null)
      )
        return undefined;
      if (
        resultText !== undefined &&
        row.resultText !== null &&
        row.resultText !== resultText
      )
        throw new Error("Test Credit result differs on replay");
      if (
        resultCalls !== undefined &&
        row.resultCalls !== null &&
        JSON.stringify(row.resultCalls) !== JSON.stringify(resultCalls)
      )
        throw new Error("Test Credit tool calls differ on replay");
      const maxBigint = 9_223_372_036_854_775_807n;
      if (
        !evidenceId ||
        evidenceId.length > 256 ||
        inputTokens < 0n ||
        outputTokens < 0n ||
        inputTokens > maxBigint ||
        outputTokens > maxBigint ||
        (outcome === "zero_cost" && (inputTokens !== 0n || outputTokens !== 0n))
      )
        throw new Error("Invalid Test Credit evidence");
      const scaled =
        inputTokens * BigInt(row.route.price.inputPerMillion) +
        outputTokens * BigInt(row.route.price.outputPerMillion);
      const cost = (scaled + tokenUnit / 2n) / tokenUnit;
      const [existing] = await tx
        .select()
        .from(evidence)
        .where(and(evidenceFor(row), eq(evidence.evidenceId, evidenceId)));
      if (existing) {
        if (
          existing.outcome !== outcome ||
          existing.inputTokens !== inputTokens ||
          existing.outputTokens !== outputTokens
        )
          throw new Error("Test Credit evidence differs on replay");
      } else {
        await tx.insert(evidence).values({
          evidenceId,
          outcome,
          inputTokens,
          outputTokens,
          accountId,
          operationId: id,
          cost,
          recordedAt: now,
        });
        if (embedding?.vectors) {
          await tx
            .update(operations)
            .set({
              embeddingResult: sql`${JSON.stringify(embedding.vectors)}::text::jsonb`,
              embeddingResultExpiresAt: new Date(
                now.getTime() + reconciliationMilliseconds,
              ),
            })
            .where(operationFilter(accountId, id));
        }
        if (
          row.state === "pending" &&
          row.eligibleEvidenceId === null &&
          row.cutoffHold === null
        ) {
          await tx
            .update(operations)
            .set({
              eligibleEvidenceId: evidenceId,
              gatewayEvidenceCheckAt: null,
              ...(resultText === undefined ? {} : { resultText }),
              ...(resultCalls === undefined ? {} : { resultCalls }),
            })
            .where(operationFilter(accountId, id));
          row.eligibleEvidenceId = evidenceId;
          if (resultText !== undefined) row.resultText = resultText;
          if (resultCalls !== undefined) row.resultCalls = resultCalls;
        }
      }
      if (row.eligibleEvidenceId === null && gatewayRequestId)
        await tx
          .update(operations)
          .set({ gatewayEvidenceCheckAt: null })
          .where(operationFilter(accountId, id));
      const eligible = await eligibleEvidence(tx, row);
      // Verified usage replaces the provider-cost share even when it arrives
      // after a cutoff already booked the bound.
      await resolveProviderCostHold(tx, row.route.id, accountId, id, {
        state: "verified",
        costMicrocredits: cost,
      });
      return {
        operation: await receiptFor(tx, row, eligible),
        platformMicrocredits: await platformCost(tx, row, eligible),
      };
    });
  }

  async function platformCost(
    tx: Transaction,
    row: Operation,
    eligible: typeof evidence.$inferSelect | undefined,
  ) {
    const [observed] = await tx
      .select({
        maxCost: sql<string | null>`max(${evidence.cost})::text`,
      })
      .from(evidence)
      .where(evidenceFor(row));
    if (observed?.maxCost == null) return undefined;
    const charge =
      row.charged ?? (eligible ? eligibleCharge(row, eligible) : 0n);
    const totalCost = BigInt(observed.maxCost);
    return (totalCost > charge ? totalCost - charge : 0n).toString();
  }

  async function settleRecorded(accountId: string, id: string) {
    return database.transaction(async (tx) => {
      if (!(await lockAccount(tx, accountId))) return undefined;
      return settlePending(tx, accountId, id);
    });
  }

  async function settlePending(tx: Transaction, accountId: string, id: string) {
    const now = await currentTime(tx);
    await applyCutoff(tx, accountId, now);
    const row = await operation(accountId, id, tx);
    if (!row) return undefined;
    const verified = await eligibleEvidence(tx, row);
    if (row.state !== "pending" || !verified)
      return receiptFor(tx, row, verified);
    const charged = eligibleCharge(row, verified);
    // The Test Credit share of the charge is its head; the paid tail consumes
    // the operation's paid allocations in source order and returns the rest.
    // A cutoff may already have consumed the paid share (then nothing is left
    // held and the recorded paid charge stands).
    let paidCharge = row.paidChargeMicrocredits ?? 0n;
    if (row.paidHoldMicrocredits > 0n && charged > 0n) {
      const testShare =
        charged > row.reserved - row.paidHoldMicrocredits
          ? row.reserved - row.paidHoldMicrocredits
          : charged;
      const consumed = await consumePaidAllocations(
        tx,
        {
          accountId,
          operationId: id,
          chargeMicrocredits: charged - testShare,
        },
        now,
      );
      if (consumed.state === "settled") paidCharge += consumed.consumed;
    } else if (row.paidHoldMicrocredits > 0n) {
      await releasePaidAllocations(tx, accountId, id, now);
    }
    const [settled] = await tx
      .update(operations)
      .set(
        charged === 0n && verified.outcome !== "completed"
          ? { state: "released", paidHoldMicrocredits: 0n }
          : {
              state: "settled",
              charged,
              paidChargeMicrocredits: paidCharge,
              paidHoldMicrocredits: 0n,
              inputTokens: verified.inputTokens,
              outputTokens: verified.outputTokens,
            },
      )
      .where(operationFilter(accountId, id))
      .returning();
    await resolveProviderCostHold(tx, row.route.id, accountId, id, {
      state: "verified",
      costMicrocredits: settled?.state === "settled" ? charged : 0n,
    });
    if (settled?.state === "settled") {
      await tx.insert(lagoUsageEvents).values({
        eventId:
          row.gatewayRequestId ??
          `openbot-${createHash("sha256")
            .update(JSON.stringify([accountId, id]))
            .digest("hex")}`,
        accountId,
        operationId: id,
        resource: settled.route.model,
        inputTokens: verified.inputTokens,
        outputTokens: verified.outputTokens,
        amountMicrocredits: charged,
        occurredAt: row.dispatchedAt ?? verified.recordedAt,
        state: "pending",
      });
    }
    return settled && (await receiptFor(tx, settled, verified));
  }
}

export type TestCreditLedger = ReturnType<typeof createTestCreditLedger>;
