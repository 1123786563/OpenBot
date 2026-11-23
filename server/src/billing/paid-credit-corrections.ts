import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  paidCorrections,
  paidCreditAllocations,
  paidEntitlements,
  testCreditOperations,
} from "../db/schema";
import { PaidLedgerError } from "./paid-ledger-error";
import { restoreHolds } from "./paid-restore";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export function createPaidCreditCorrections({
  database,
  now,
  lockAccount,
  spendableSources,
  effectiveEntitlement,
}: {
  database: Database;
  now: () => Date;
  lockAccount(tx: Transaction, accountId: string): Promise<unknown>;
  spendableSources(
    tx: Transaction,
    accountId: string,
    at: Date,
  ): Promise<{ remaining: bigint }[]>;
  effectiveEntitlement(
    source: typeof paidEntitlements.$inferSelect,
    at: Date,
  ): string;
}) {
  // ── Verified corrections (#105) ─────────────────────────────────────
  // Original records are never rewritten: a proved overcharge returns
  // credits to the source that paid them while that source is still valid,
  // and anything that cannot return (or platform-fault compensation) lands
  // as non-expiring Correction Credits with its own audit row.

  async function grantCorrectionCredits(
    tx: Transaction,
    accountId: string,
    amountMicrocredits: bigint,
    at: Date,
  ) {
    const [row] = await tx
      .insert(paidEntitlements)
      .values({
        accountId,
        orderId: null,
        kind: "credit_pack",
        creditsMicrocredits: amountMicrocredits,
        state: "granted",
        arrivedAt: at,
      })
      .returning();
    return row;
  }

  type CorrectionCase = {
    accountId: string;
    amountMicrocredits: bigint;
    reason: string;
    evidence: string;
    by: string;
  };

  async function bookCorrection(
    input: CorrectionCase &
      (
        | { kind: "overcharge_refund"; operationId: string }
        | { kind: "fault_compensation"; operationId?: string }
      ),
  ) {
    return database.transaction(async (tx) => {
      const operationId = input.operationId ?? null;
      const account = await lockAccount(tx, input.accountId);
      if (!account)
        throw new PaidLedgerError("order_unknown", "Unknown Billing Account.");

      const prior = await tx
        .select()
        .from(paidCorrections)
        .where(
          and(
            eq(paidCorrections.accountId, input.accountId),
            eq(paidCorrections.kind, input.kind),
            operationId === null
              ? isNull(paidCorrections.operationId)
              : eq(paidCorrections.operationId, operationId),
          ),
        );
      const existing = prior.find((entry) => entry.evidence === input.evidence);
      if (existing) {
        if (
          existing.amountMicrocredits !== input.amountMicrocredits ||
          existing.reason !== input.reason
        ) {
          throw new PaidLedgerError(
            "correction_conflict",
            "This verified case already has a different correction.",
          );
        }
        return existing;
      }

      if (await restoreHolds(tx, input.accountId))
        throw new PaidLedgerError(
          "ledger_restoring",
          "Credits cannot be issued during ledger recovery.",
        );

      const sources = await tx
        .select()
        .from(paidEntitlements)
        .where(eq(paidEntitlements.accountId, input.accountId))
        .orderBy(paidEntitlements.id)
        .for("update");
      const at = now();
      const available = async () =>
        (await spendableSources(tx, input.accountId, at)).reduce(
          (sum, row) => sum + row.remaining,
          0n,
        );
      const availableBefore = await available();
      let creditAmount = input.amountMicrocredits;
      let entitlementId: string | null = null;
      if (operationId !== null) {
        const allocations = await tx
          .select({
            entitlementId: paidCreditAllocations.entitlementId,
            consumed: paidCreditAllocations.consumedMicrocredits,
          })
          .from(paidCreditAllocations)
          .where(
            and(
              eq(paidCreditAllocations.accountId, input.accountId),
              eq(paidCreditAllocations.operationId, operationId),
              eq(paidCreditAllocations.state, "settled"),
            ),
          )
          .orderBy(paidCreditAllocations.position);
        if (input.kind === "fault_compensation" && allocations.length === 0) {
          const [operation] = await tx
            .select({ id: testCreditOperations.id })
            .from(testCreditOperations)
            .where(
              and(
                eq(testCreditOperations.accountId, input.accountId),
                eq(testCreditOperations.id, operationId),
              ),
            );
          if (!operation)
            throw new PaidLedgerError("order_unknown", "Unknown operation.");
        }
        if (input.kind === "overcharge_refund") {
          const total = allocations.reduce(
            (sum, row) => sum + (row.consumed ?? 0n),
            0n,
          );
          if (total === 0n) {
            throw new PaidLedgerError(
              "order_unknown",
              "No settled paid consumption to correct for this operation.",
            );
          }
          let corrected = prior.reduce(
            (sum, row) => sum + row.amountMicrocredits,
            0n,
          );
          if (input.amountMicrocredits > total - corrected) {
            throw new PaidLedgerError(
              "correction_conflict",
              "The amount exceeds the remaining settled charge.",
            );
          }
          let left = input.amountMicrocredits;
          for (const allocation of allocations) {
            if (left === 0n) break;
            const consumed = allocation.consumed ?? 0n;
            const skipped = corrected < consumed ? corrected : consumed;
            corrected -= skipped;
            const uncorrected = consumed - skipped;
            const amount = uncorrected < left ? uncorrected : left;
            left -= amount;
            const source = sources.find(
              ({ id }) => id === allocation.entitlementId,
            );
            if (
              !source ||
              amount === 0n ||
              effectiveEntitlement(source, at) !== "active"
            )
              continue;
            entitlementId ??= source.id;
            creditAmount -= amount;
            await tx
              .update(paidEntitlements)
              .set({
                consumedMicrocredits: sql`${paidEntitlements.consumedMicrocredits} - ${amount}`,
              })
              .where(eq(paidEntitlements.id, source.id));
          }
        }
      }

      if (creditAmount > 0n) {
        const credit = await grantCorrectionCredits(
          tx,
          input.accountId,
          creditAmount,
          at,
        );
        if (input.kind === "fault_compensation") entitlementId = credit.id;
      }
      const [row] = await tx
        .insert(paidCorrections)
        .values({
          accountId: input.accountId,
          operationId,
          entitlementId,
          kind: input.kind,
          amountMicrocredits: input.amountMicrocredits,
          reason: input.reason,
          evidence: input.evidence,
          by: input.by,
          availableBeforeMicrocredits: availableBefore,
          availableAfterMicrocredits: await available(),
          correctionCreditsMicrocredits: creditAmount,
          createdAt: at,
        })
        .returning();
      return row;
    });
  }

  function correctOvercharge(input: CorrectionCase & { operationId: string }) {
    return bookCorrection({ ...input, kind: "overcharge_refund" });
  }

  function applyCompensation(input: CorrectionCase & { operationId?: string }) {
    return bookCorrection({ ...input, kind: "fault_compensation" });
  }

  return { correctOvercharge, applyCompensation };
}
