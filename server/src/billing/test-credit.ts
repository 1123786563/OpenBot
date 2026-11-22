import { and, eq, isNull, lte, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import {
  catalogSchema,
  pilotCatalogKey,
  type ReleasedBifrostRoute,
  view,
} from "../admin/bifrost-catalog";
import type { Database } from "../db/client";
import {
  allocatePaidSources,
  consumePaidAllocations,
  pilotReservesStoppedAt,
  releasePaidAllocations,
} from "./paid-ledger";
import {
  testCreditAccounts as accounts,
  testCreditBatches as batches,
  testCreditBudgets as budgets,
  testCreditEnrollments as enrollments,
  enterpriseSettings,
  testCreditEvidence as evidence,
  lagoUsageEvents,
  pilotProviderCostHolds,
  pilotProviderCostLimitEvents,
  pilotProviderCostLimits,
  testCreditOperations as operations,
  testCreditResumePoints as resumePoints,
} from "../db/schema";

export type VerifiedBillingIdentity = { issuer: string; subject: string };
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Pilot provider-cost ceiling bookkeeping (#106). A reservation on a capped
 * path holds a share at the route's maximum charge; the share stays held while
 * the provider result is unknown — even after the user reservation is released
 * — and is replaced by the verified cost or booked at the bound when the
 * reconciliation window closes without evidence.
 */
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
const reservationMilliseconds = 5 * 60_000;
const tokenUnit = 1_000_000n;
const identityFilter = ({ issuer, subject }: VerifiedBillingIdentity) =>
  and(eq(accounts.issuer, issuer), eq(accounts.subject, subject));
const operationFilter = (accountId: string, id: string) =>
  and(eq(operations.accountId, accountId), eq(operations.id, id));

const denied = (
  reason:
    | "not_authorized"
    | "route_unavailable"
    | "insufficient_credits"
    | "execution_limit"
    | "pilot_closed",
) => ({ state: "denied", reason }) as const;

async function activeRoutes(database: Database | Transaction, lock = false) {
  const query = database
    .select({ value: enterpriseSettings.value })
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, pilotCatalogKey));
  const [row] = await (lock ? query.for("share") : query);
  return row && view(catalogSchema.parse(row.value));
}

function routeEligible(
  active: Awaited<ReturnType<typeof activeRoutes>>,
  frozen: ReleasedBifrostRoute,
) {
  return (
    active?.options.some(
      ({ id, revision, verification }) =>
        id === frozen.id &&
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
    maxChargeMicrocredits: route.maxChargeMicrocredits,
    usageDisclosure:
      "Interrupted, cancelled, or failed requests may still use Test Credits.",
  };
}

export type TestCreditQuote = ReturnType<typeof quoteFor>;

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

function operationReceipt(operation: Operation, verified?: Evidence) {
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
      dispatchedAt &&
      new Date(dispatchedAt.getTime() + reconciliationMilliseconds),
    heldMicrocredits: held.toString(),
    state,
    priceVersion,
    route: route.id,
    provider: route.provider,
    model: route.model,
    creditType: "test",
    price: route.price,
    reservedMicrocredits: reserved.toString(),
    chargedMicrocredits: charged?.toString() ?? null,
    releasedMicrocredits: released?.toString() ?? null,
    dispatchedAt,
    inputTokens: (inputTokens ?? verified?.inputTokens)?.toString() ?? null,
    outputTokens: (outputTokens ?? verified?.outputTokens)?.toString() ?? null,
    budgetId,
    stepId,
    resultText,
  };
}

function eligibleCharge(
  row: Operation,
  verified: typeof evidence.$inferSelect,
) {
  if (verified.outcome === "platform_failure") return 0n;
  return verified.cost > row.reserved ? row.reserved : verified.cost;
}

export function createTestCreditLedger(database: Database, clock?: () => Date) {
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
      lte(
        operations.dispatchedAt,
        new Date(now.getTime() - reconciliationMilliseconds),
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
  }

  async function budget(accountId: string, id: string, tx: Transaction) {
    const [row] = await tx
      .select()
      .from(budgets)
      .where(and(eq(budgets.accountId, accountId), eq(budgets.id, id)));
    return row;
  }

  async function budgetUsage(
    accountId: string,
    budgetId: string,
    tx: Transaction,
  ) {
    const [row] = await tx
      .select({
        used: sql<string>`coalesce(sum(case when ${operations.state} = 'settled' then ${operations.charged} else coalesce(${operations.cutoffHold}, ${operations.reserved}) end), 0)::text`,
      })
      .from(operations)
      .where(
        and(
          eq(operations.accountId, accountId),
          eq(operations.budgetId, budgetId),
          sql`${operations.state} <> 'released'`,
        ),
      );
    return BigInt(row?.used ?? "0");
  }

  return {
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
        const claimedAt = enrollment.claimedAt ?? new Date();
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
        confirmed?: boolean;
      },
    ) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.budgetId))
        throw new Error("Invalid execution budget ID");
      if (input.limitMicrocredits <= 0n)
        throw new Error("Execution budget must be positive");
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        const existing = await budget(accountId, input.budgetId, tx);
        if (existing) {
          if (existing.creditType !== input.creditType)
            throw new Error("Execution budget Credit type differs");
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
          })
          .returning();
        if (!row) throw new Error("Execution budget could not be created");
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

    async modelOptions() {
      const active = await activeRoutes(database);
      return active?.options.map(modelOption) ?? [];
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
      const route = active?.options.find(({ id, revision }) =>
        saved
          ? id === saved.id && revision === saved.revision
          : id === active.defaultRoute,
      );
      if (route && active?.priceVersion)
        return { source, quote: quoteFor(route, active.priceVersion) } as const;
      const reason = saved
        ? `Saved ${source === "bot" ? "Bot default" : "Conversation override"} is no longer verified for this Harness. Choose another verified model or clear the saved selection.`
        : "No verified administrator default is available for this Harness. Ask an administrator to publish a default.";
      return { source, reason } as const;
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

    async balance(identity: VerifiedBillingIdentity) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        await applyCutoff(tx, accountId, await currentTime(tx));
        const { granted, held, spent, available } = await totals(tx, accountId);
        return {
          creditType: "test" as const,
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
        return row && operationReceipt(row, await eligibleEvidence(tx, row));
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
      },
    ) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return denied("not_authorized");
        const now = await currentTime(tx);
        await applyCutoff(tx, accountId, now);
        const expired = new Date(now.getTime() - reservationMilliseconds);
        const stale = await tx
          .update(operations)
          .set({ state: "released", paidHoldMicrocredits: 0n })
          .where(
            and(
              eq(operations.accountId, accountId),
              eq(operations.state, "reserved"),
              lte(operations.createdAt, expired),
            ),
          )
          .returning({
            id: operations.id,
            paidHold: operations.paidHoldMicrocredits,
          });
        for (const row of stale) {
          if (row.paidHold > 0n)
            await releasePaidAllocations(tx, accountId, row.id, now);
        }
        // A step that stopped for want of credits or budget room resumes on
        // the budget the person confirmed for it (#107 安全续做点): that one
        // confirmation is the entry for this step, whatever the runner asks.
        const [paused] = await tx
          .select()
          .from(resumePoints)
          .where(
            and(
              eq(resumePoints.accountId, accountId),
              eq(resumePoints.operationId, request.operationId),
            ),
          )
          .for("update");
        const continued = paused?.budgetId
          ? await budget(accountId, paused.budgetId, tx)
          : undefined;
        const input = continued
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
          reason: "insufficient_credits" | "execution_limit",
        ) => {
          await tx
            .insert(resumePoints)
            .values({
              accountId,
              operationId: input.operationId,
              applicationId: input.applicationId ?? null,
              reason,
              createdAt: now,
            })
            .onConflictDoUpdate({
              target: [resumePoints.accountId, resumePoints.operationId],
              set: {
                reason,
                applicationId: input.applicationId ?? null,
              },
            });
          return denied(reason);
        };
        const existing = await operation(accountId, input.operationId, tx);
        if (existing) {
          const sameQuote =
            existing.route.id === input.route &&
            existing.priceVersion === input.priceVersion &&
            existing.rerunOfOperationId ===
              (input.rerunOfOperationId ?? null) &&
            existing.budgetId === (input.budgetId ?? null) &&
            existing.stepId === (input.stepId ?? null);
          if (
            existing.rerunOfOperationId !==
              (input.rerunOfOperationId ?? null) ||
            existing.budgetId !== (input.budgetId ?? null) ||
            existing.stepId !== (input.stepId ?? null)
          )
            return denied("not_authorized");
          return {
            state: "existing",
            operation: operationReceipt(
              existing,
              await eligibleEvidence(tx, existing),
            ),
            permit:
              existing.state === "reserved" && sameQuote
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
        // Pilot wind-down (#107 trial end, #109): no new reservations of
        // either Credit type. Dispatched work above keeps its replay.
        if (await pilotReservesStoppedAt(tx)) return denied("pilot_closed");
        const executionBudget = input.budgetId
          ? await budget(accountId, input.budgetId, tx)
          : undefined;
        // A task fixes its Credit type when it starts: the budget must
        // match the entry the caller chose (#107).
        if (
          input.budgetId &&
          executionBudget?.creditType !== (input.creditType ?? "test")
        )
          return denied("not_authorized");
        if (
          executionBudget &&
          (executionBudget.state !== "active" ||
            executionBudget.confirmedAt === null)
        )
          return pause("execution_limit");
        const active = await activeRoutes(tx, true);
        const route = active?.options.find(({ id }) => id === input.route);
        if (!route || active?.priceVersion !== input.priceVersion)
          return denied("route_unavailable");
        const balance = await totals(tx, accountId);
        const reserved = BigInt(route.maxChargeMicrocredits);
        // The two entries choose their Credit type (#107 试用与付费入口分
        // 开选择): "test" spends Test Credit only, "paid" funds the whole
        // bound from paid sources only, and the default spans both — the
        // trial balance first and the paid ledger holding any shortfall in
        // this same transaction (#101).
        let paidHold = 0n;
        if (input.creditType === "paid") {
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
        } else if (input.creditType === "test") {
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
        if (executionBudget) {
          const used = await budgetUsage(accountId, executionBudget.id, tx);
          if (used + reserved > executionBudget.limitMicrocredits)
            return pause("execution_limit");
        }
        // The pilot-wide provider-cost ceiling is acquired in the same
        // transaction as the user reservation: both hold or neither does.
        const costLimit = (
          await tx
            .select()
            .from(pilotProviderCostLimits)
            .where(eq(pilotProviderCostLimits.path, route.id))
        )[0];
        if (costLimit) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${route.id}))`,
          );
          const outstanding = await providerCostOutstanding(tx, route.id);
          if (outstanding + reserved > costLimit.limitMicrocredits)
            return denied("route_unavailable");
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
            createdAt: now,
            rerunOfOperationId: input.rerunOfOperationId,
            state: "reserved",
            budgetId: input.budgetId,
            stepId: input.stepId,
            applicationId: input.applicationId,
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
        return {
          state: "reserved",
          permit: row.permit,
          operation: operationReceipt(row),
        } as const;
      });
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
        return rows;
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
    ) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
        const [point] = await tx
          .select()
          .from(resumePoints)
          .where(
            and(
              eq(resumePoints.accountId, accountId),
              eq(resumePoints.operationId, operationId),
            ),
          )
          .for("update");
        if (!point || (await operation(accountId, operationId, tx)))
          return undefined;
        const target = await budget(accountId, budgetId, tx);
        if (
          target?.state !== "active" ||
          target.confirmedAt === null ||
          (point.reason === "insufficient_credits" &&
            target.creditType !== "paid")
        )
          return { state: "denied" as const };
        const confirmedAt = await currentTime(tx);
        await tx
          .update(resumePoints)
          .set({ budgetId, confirmedAt })
          .where(
            and(
              eq(resumePoints.accountId, accountId),
              eq(resumePoints.operationId, operationId),
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

    async beginDispatch(
      identity: VerifiedBillingIdentity,
      input: { operationId: string; permit: string },
    ) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return denied("not_authorized");
        await applyCutoff(tx, accountId, await currentTime(tx));
        const row = await operation(accountId, input.operationId, tx);
        if (!row || row.permit !== input.permit)
          return denied("not_authorized");
        if (row.state !== "reserved")
          return {
            state: "existing",
            operation: operationReceipt(row, await eligibleEvidence(tx, row)),
          } as const;
        const filter = operationFilter(row.accountId, row.id);
        if (row.budgetId) {
          // The budget's Credit type was matched to the entry at reservation
          // (#107), so either type dispatches under the budget it fixed.
          const executionBudget = await budget(row.accountId, row.budgetId, tx);
          const invalid =
            executionBudget?.state !== "active" ||
            executionBudget.confirmedAt === null;
          const overLimit = executionBudget
            ? (await budgetUsage(row.accountId, row.budgetId, tx)) >
              executionBudget.limitMicrocredits
            : false;
          if (invalid || overLimit) {
            await releaseReservation(tx, row);
            return denied(
              invalid && !executionBudget
                ? "not_authorized"
                : "execution_limit",
            );
          }
        }
        const active = await activeRoutes(tx, true);
        const eligible = routeEligible(active, row.route);
        const dispatchedAt = await currentTime(tx);
        if (
          !eligible ||
          dispatchedAt.getTime() - row.createdAt.getTime() >=
            reservationMilliseconds
        ) {
          await releaseReservation(tx, row);
          return denied("route_unavailable");
        }
        await tx
          .update(operations)
          .set({ state: "pending", dispatchedAt })
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
          .set({ state: "released", dispatchedAt: null })
          .where(
            and(
              operationFilter(accountId, id),
              eq(operations.state, "pending"),
              isNull(operations.eligibleEvidenceId),
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
        if (row)
          await resolveProviderCostHold(tx, row.route.id, accountId, id, {
            state: "released",
          });
      });
    },

    recordEvidence,
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
          operationReceipt(updated, await eligibleEvidence(tx, updated))
        );
      });
    },
    settleRecorded,

    /** Sets (or replaces) a pilot-wide provider-cost ceiling for one path. */
    async setProviderCostLimit(input: {
      path: string;
      limitMicrocredits: bigint;
      by: string;
    }) {
      if (input.limitMicrocredits < 0n)
        throw new RangeError("Invalid provider cost limit");
      return database.transaction(async (tx) => {
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

    async reconcile(identity: VerifiedBillingIdentity, id: string) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return undefined;
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
    verified: Evidence,
  ) {
    return database.transaction(async (tx) => {
      if (!(await lockAccount(tx, accountId))) return undefined;
      const now = await currentTime(tx);
      await applyCutoff(tx, accountId, now);
      const row = await operation(accountId, id, tx);
      if (!row?.dispatchedAt) return undefined;
      const { evidenceId, outcome, inputTokens, outputTokens } = verified;
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
          ...verified,
          accountId,
          operationId: id,
          cost,
          recordedAt: now,
        });
        if (
          row.state === "pending" &&
          row.eligibleEvidenceId === null &&
          row.cutoffHold === null
        ) {
          await tx
            .update(operations)
            .set({ eligibleEvidenceId: evidenceId })
            .where(operationFilter(accountId, id));
          row.eligibleEvidenceId = evidenceId;
        }
      }
      const eligible = await eligibleEvidence(tx, row);
      // Verified usage replaces the provider-cost share even when it arrives
      // after a cutoff already booked the bound.
      await resolveProviderCostHold(tx, row.route.id, accountId, id, {
        state: "verified",
        costMicrocredits: cost,
      });
      return {
        operation: operationReceipt(row, eligible),
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
      return operationReceipt(row, verified);
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
    if (settled && verified && settled.state === "settled") {
      await tx
        .insert(lagoUsageEvents)
        .values({
          eventId: `lago:${accountId}:${id}`,
          accountId,
          operationId: id,
          resource: settled.route.model,
          inputTokens: verified.inputTokens,
          outputTokens: verified.outputTokens,
          amountMicrocredits: charged,
          occurredAt: verified.recordedAt,
          state: "pending",
        })
        .onConflictDoNothing();
    }
    return settled && operationReceipt(settled, verified);
  }
}

export type TestCreditLedger = ReturnType<typeof createTestCreditLedger>;
