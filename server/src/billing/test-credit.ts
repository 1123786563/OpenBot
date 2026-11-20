import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { catalogSchema, pilotCatalogKey, view } from "../admin/bifrost-catalog";
import type { Database } from "../db/client";
import {
  testCreditAccounts as accounts,
  testCreditBatches as batches,
  testCreditEnrollments as enrollments,
  enterpriseSettings,
  testCreditOperations as operations,
  testCreditEvidence as evidence,
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

  async function applyCutoff(tx: Transaction, accountId: string, now: Date) {
    const due = await tx
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.accountId, accountId),
          eq(operations.state, "pending"),
          isNull(operations.cutoffHold),
          lte(
            operations.dispatchedAt,
            new Date(now.getTime() - reconciliationMilliseconds),
          ),
        ),
      );
    for (const row of due) {
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
        .where(operationFilter(accountId, row.id));
    }
  }

  async function lockAccount(tx: Transaction, accountId: string) {
    const [row] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .for("update");
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

    async quote() {
      const active = await activeRoutes(database);
      const route = active?.options.find(
        ({ id }) => id === active.defaultRoute,
      );
      if (!active?.priceVersion || !route) return undefined;
      return {
        creditType: "test" as const,
        priceVersion: active.priceVersion,
        route: route.id,
        price: route.price,
        maxChargeMicrocredits: route.maxChargeMicrocredits,
        usageDisclosure:
          "Interrupted, cancelled, or failed requests may still use Test Credits.",
      };
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
        const eligible = active?.options.some(
          ({ id, revision }) =>
            id === row.route.id && revision === row.route.revision,
        );
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
