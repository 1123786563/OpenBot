import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { catalogSchema, pilotCatalogKey, view } from "../admin/bifrost-catalog";
import type { Database } from "../db/client";
import {
  testCreditAccounts as accounts,
  testCreditBatches as batches,
  testCreditEnrollments as enrollments,
  enterpriseSettings,
  testCreditOperations as operations,
} from "../db/schema";

export type VerifiedBillingIdentity = { issuer: string; subject: string };
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Operation = typeof operations.$inferSelect;
type Usage = { inputTokens: bigint; outputTokens: bigint };

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
      select coalesce(sum(${operations.reserved}), 0)::text from ${operations}
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

function operationReceipt(operation: Operation) {
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
  const released =
    state === "released"
      ? reserved
      : charged === null
        ? null
        : reserved - charged;
  return {
    operationId: id,
    state,
    priceVersion,
    route: route.id,
    creditType: "test",
    price: route.price,
    reservedMicrocredits: reserved.toString(),
    chargedMicrocredits: charged?.toString() ?? null,
    releasedMicrocredits: released?.toString() ?? null,
    dispatchedAt,
    inputTokens: inputTokens?.toString() ?? null,
    outputTokens: outputTokens?.toString() ?? null,
  };
}

export function createTestCreditLedger(database: Database) {
  async function account(identity: VerifiedBillingIdentity, tx?: Transaction) {
    const query = (tx ?? database)
      .select({ id: accounts.id })
      .from(accounts)
      .where(identityFilter(identity));
    const [row] = await (tx ? query.for("update") : query);
    return row?.id;
  }

  async function operation(accountId: string, id: string, tx?: Transaction) {
    const [row] = await (tx ?? database)
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
      };
    },

    async balance(identity: VerifiedBillingIdentity) {
      const accountId = await account(identity);
      if (!accountId) return undefined;
      const { granted, held, spent, available } = await totals(
        database,
        accountId,
      );
      return {
        creditType: "test" as const,
        grantedMicrocredits: granted.toString(),
        reservedMicrocredits: held.toString(),
        chargedMicrocredits: spent.toString(),
        availableMicrocredits: available.toString(),
      };
    },

    async receipt(identity: VerifiedBillingIdentity, id: string) {
      const accountId = await account(identity);
      const row = accountId && (await operation(accountId, id));
      return row ? operationReceipt(row) : undefined;
    },

    async reserve(
      identity: VerifiedBillingIdentity,
      input: {
        operationId: string;
        route: string;
        priceVersion: string;
      },
    ) {
      return database.transaction(async (tx) => {
        const accountId = await account(identity, tx);
        if (!accountId) return denied("not_authorized");
        // Only untouched permits expire here. Pending dispatches keep their holds.
        const expired = new Date(Date.now() - reservationMilliseconds);
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
            existing.priceVersion === input.priceVersion;
          return {
            state: "existing",
            operation: operationReceipt(existing),
            permit:
              existing.state === "reserved" && sameQuote
                ? existing.permit
                : undefined,
          } as const;
        }
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
        const row =
          accountId && (await operation(accountId, input.operationId, tx));
        if (!row || row.permit !== input.permit)
          return denied("not_authorized");
        if (row.state !== "reserved")
          return {
            state: "existing",
            operation: operationReceipt(row),
          } as const;
        const active = await activeRoutes(tx, true);
        const eligible = active?.options.some(
          ({ id, revision }) =>
            id === row.route.id && revision === row.route.revision,
        );
        const filter = operationFilter(row.accountId, row.id);
        if (
          !eligible ||
          Date.now() - row.createdAt.getTime() >= reservationMilliseconds
        ) {
          await tx.update(operations).set({ state: "released" }).where(filter);
          return denied("route_unavailable");
        }
        const dispatchedAt = new Date();
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
      await database
        .update(operations)
        .set({ state: "released", dispatchedAt: null })
        .where(
          and(operationFilter(accountId, id), eq(operations.state, "pending")),
        );
    },

    // Only the controlled route or its trusted reconciler can supply usage.
    async settle(accountId: string, id: string, usage: Usage) {
      return database.transaction(async (tx) => {
        const [locked] = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .for("update");
        if (!locked) return undefined;
        const row = await operation(accountId, id, tx);
        if (!row) return undefined;
        if (row.state === "settled") return operationReceipt(row);
        const { inputTokens, outputTokens } = usage;
        if (
          row.state !== "pending" ||
          inputTokens < 0n ||
          outputTokens < 0n ||
          inputTokens > BigInt(row.route.maxInputTokens) ||
          outputTokens > BigInt(row.route.maxOutputTokens)
        )
          return undefined;
        const scaled =
          inputTokens * BigInt(row.route.price.inputPerMillion) +
          outputTokens * BigInt(row.route.price.outputPerMillion);
        const charged = (scaled + tokenUnit / 2n) / tokenUnit;
        const [settled] = await tx
          .update(operations)
          .set({ state: "settled", charged, inputTokens, outputTokens })
          .where(operationFilter(accountId, id))
          .returning();
        return settled && operationReceipt(settled);
      });
    },
  };
}

export type TestCreditLedger = ReturnType<typeof createTestCreditLedger>;
