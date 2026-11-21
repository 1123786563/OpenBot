import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  catalogSchema,
  pilotCatalogKey,
  type ReleasedBifrostRoute,
  view,
} from "../admin/bifrost-catalog";
import type { Database } from "../db/client";
import {
  testCreditAccounts as accounts,
  testCreditBatches as batches,
  testCreditEnrollments as enrollments,
  enterpriseSettings,
  testCreditEvidence as evidence,
  testCreditIssuanceBudgets as issuanceBudgets,
  testCreditIssuances as issuances,
  testCreditOperations as operations,
} from "../db/schema";

export type VerifiedBillingIdentity = { issuer: string; subject: string };
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
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
  reason: "not_authorized" | "route_unavailable" | "insufficient_credits",
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
      select coalesce(sum(coalesce(${operations.cutoffHold}, ${operations.reserved})), 0)::text from ${operations}
      where ${operations.accountId} = ${accountId} and ${operations.state} in ('reserved', 'pending')
    )`,
      spent: sql<string>`(
      select coalesce(sum(${operations.charged}), 0)::text from ${operations}
      where ${operations.accountId} = ${accountId}
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

  async function applyOperationCutoff(tx: Transaction, row: Operation) {
    const verified = await eligibleEvidence(tx, row);
    const cutoffHold = verified ? eligibleCharge(row, verified) : 0n;
    await tx
      .update(operations)
      .set({
        cutoffHold,
        state:
          cutoffHold === 0n && verified?.outcome !== "completed"
            ? "released"
            : "pending",
      })
      .where(operationFilter(row.accountId, row.id));
  }

  async function applyCutoff(tx: Transaction, accountId: string, now: Date) {
    const due = await tx
      .select()
      .from(operations)
      .where(and(eq(operations.accountId, accountId), dueForCutoff(now)));
    for (const row of due) await applyOperationCutoff(tx, row);
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
          await applyOperationCutoff(tx, row);
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

        await tx.insert(accounts).values(identity).onConflictDoNothing();
        const accountId = await account(identity, tx);
        if (!accountId) throw new Error("Billing Account could not be created");

        await tx
          .insert(issuanceBudgets)
          .values({
            id: config.budgetId,
            total: config.budget,
          })
          .onConflictDoNothing();
        const [budget] = await tx
          .select()
          .from(issuanceBudgets)
          .where(eq(issuanceBudgets.id, config.budgetId))
          .for("update");
        if (!budget) throw new Error("Test Credit issuance budget unavailable");
        await tx
          .insert(issuances)
          .values({
            accountId,
            budgetId: config.budgetId,
            batchId: config.batchId,
            amount: config.amount,
            state: "pending",
          })
          .onConflictDoNothing();
        const [grant] = await tx
          .select()
          .from(issuances)
          .where(eq(issuances.accountId, accountId))
          .for("update");
        if (!grant) throw new Error("Test Credit grant was not saved");
        if (grant.state === "issued")
          return {
            state: "issued",
            amountMicrocredits: grant.amount.toString(),
            budgetId: grant.budgetId,
            batchId: grant.batchId,
          };
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
          .onConflictDoNothing();
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
        const claimedAt = enrollment.claimedAt ?? new Date();
        await tx
          .update(enrollments)
          .set({ claimedAt })
          .where(and(key, isNull(enrollments.claimedAt)));
        return { batchId, claimedAt };
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
      input: {
        operationId: string;
        route: string;
        priceVersion: string;
        rerunOfOperationId?: string;
      },
    ) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return denied("not_authorized");
        const now = await currentTime(tx);
        await applyCutoff(tx, accountId, now);
        const expired = new Date(now.getTime() - reservationMilliseconds);
        await tx
          .update(operations)
          .set({ state: "released" })
          .where(
            and(
              eq(operations.accountId, accountId),
              eq(operations.state, "reserved"),
              lte(operations.createdAt, expired),
            ),
          );
        const existing = await operation(accountId, input.operationId, tx);
        if (existing) {
          const sameQuote =
            existing.route.id === input.route &&
            existing.priceVersion === input.priceVersion &&
            existing.rerunOfOperationId === (input.rerunOfOperationId ?? null);
          if (
            existing.rerunOfOperationId !== (input.rerunOfOperationId ?? null)
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
        const active = await activeRoutes(tx, true);
        const route = active?.options.find(({ id }) => id === input.route);
        if (!route || active?.priceVersion !== input.priceVersion)
          return denied("route_unavailable");
        const balance = await totals(tx, accountId);
        const reserved = BigInt(route.maxChargeMicrocredits);
        if (balance.granted === 0n) return denied("not_authorized");
        if (balance.available < reserved) return denied("insufficient_credits");
        const [row] = await tx
          .insert(operations)
          .values({
            accountId,
            id: input.operationId,
            priceVersion: input.priceVersion,
            route,
            reserved,
            createdAt: now,
            rerunOfOperationId: input.rerunOfOperationId,
            state: "reserved",
          })
          .returning();
        if (!row)
          throw new Error("Test Credit reservation could not be created");
        return {
          state: "reserved",
          permit: row.permit,
          operation: operationReceipt(row),
        } as const;
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
        const active = await activeRoutes(tx, true);
        const eligible = routeEligible(active, row.route);
        const filter = operationFilter(row.accountId, row.id);
        const dispatchedAt = await currentTime(tx);
        if (
          !eligible ||
          dispatchedAt.getTime() - row.createdAt.getTime() >=
            reservationMilliseconds
        ) {
          await tx.update(operations).set({ state: "released" }).where(filter);
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
        await tx
          .update(operations)
          .set({ state: "released", dispatchedAt: null })
          .where(
            and(
              operationFilter(accountId, id),
              eq(operations.state, "pending"),
              isNull(operations.eligibleEvidenceId),
            ),
          );
      });
    },

    recordEvidence,
    settleRecorded,

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
    await applyCutoff(tx, accountId, await currentTime(tx));
    const row = await operation(accountId, id, tx);
    if (!row) return undefined;
    const verified = await eligibleEvidence(tx, row);
    if (row.state !== "pending" || !verified)
      return operationReceipt(row, verified);
    const charged = eligibleCharge(row, verified);
    const [settled] = await tx
      .update(operations)
      .set(
        charged === 0n && verified.outcome !== "completed"
          ? { state: "released" }
          : {
              state: "settled",
              charged,
              inputTokens: verified.inputTokens,
              outputTokens: verified.outputTokens,
            },
      )
      .where(operationFilter(accountId, id))
      .returning();
    return settled && operationReceipt(settled, verified);
  }
}

export type TestCreditLedger = ReturnType<typeof createTestCreditLedger>;
