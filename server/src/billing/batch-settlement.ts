/*
 * The batch terminal settlement lane (Bifrost 18.2, #334): settlement fires on the
 * terminal REPORT of a batch's items — each item priced on its OWN model cell at the
 * batch's locked versions, the per-item EXACT costs summed, and ONE settlement through
 * the credit writer on the batch's single reservation, with every item's line detail
 * riding the same transaction as the ledger row.
 *
 * THE PRICE IS THE LOCKED VERSION'S, FROM EACH ITEM'S OWN CELL. The numbers priced are
 * the provider's real per-item usage — never an estimate, never the certified worst case
 * — converted through 06.5's exact arithmetic at the dims each item's OWN cell locked at
 * the batch's versions (mixed models mean mixed unit prices: cell B's `video` is not cell
 * A's). The batch's pricing basis lives on the batch/item rows, NOT on the reservation's
 * own lock (which names the batch's anchor cell — a true basis, but never the batch's).
 *
 * ONE SETTLEMENT, TWO ATTRIBUTION LEVELS. The reservation settles ONCE with the summed
 * exact actual: one ledger row named by the batchId, one detail line per item sharing
 * that row's ledger id (the writer asserts the lines sum to the actual exactly — the
 * write-side invariant the two-level attribution reconciles by). The unused share of the
 * hold hands back with the settle (the writer's released side): the per-item sums are ≤
 * the certified cap by pricing, and a terminal that prices ABOVE the cap is the over-cap
 * anomaly, recorded out loud (17.6's own discipline): the ledger records the real cost in
 * full, only the held capacity applies, and the `billing.batch_settle_over_cap` audit row
 * names the batch, the cap, the exact cost and the overage.
 *
 * THE FENCE IS THE RESERVATION'S OWN. One settle per reservation: an identical replayed
 * report replays the first result (the writer's same-actual replay), an amended report (a
 * different usage) refuses as `settlement_conflict` — never a top-up. A report that does
 * not cover EVERY item of the batch refuses as `items_incomplete`: partiality is 18.3's
 * classification, and a settlement that guessed the missing items' costs would be exactly
 * the silent truncation strict billing exists to refuse.
 */

import { eq } from "drizzle-orm";
import type { AuditStore } from "../audit";
import { DEPLOYMENT_INITIATOR, recordAuditEvent } from "../audit";
import type { ConversionRate } from "../gateway/conversion-rate";
import { PRICE_DIMENSIONS, type PriceDimension } from "../gateway/price-snapshot";
import { MODEL_CAPABILITIES } from "../gateway/catalog";
import type { Database } from "../db/client";
import {
  batchItems,
  batchJobs,
  creditBatchSettlementDetails,
  creditReservations,
} from "../db/schema/credit-reservations";
import { creditLedger } from "../db/schema/credits";
import { CreditReservationConflictError, createCreditWriter } from "./credits-writer";
import {
  computeReservationCeiling,
  resolveLockedReservationBasis,
} from "./reserve-bound";

/** The item terminal states a batch report may carry — the money's reliable evidence. */
export type BatchItemTerminalState = "completed" | "failed" | "cancelled";

/** Which lane reported the terminal: the sweeper's poll, or the provider's notification. */
export type BatchSettleTriggerSource = "poll" | "notification";

/** One item's terminal report: its custom id, its state, its real usage. */
export type BatchItemReport = {
  customId: string;
  terminalState: BatchItemTerminalState;
  /** One whole quantity per billing dimension of the closed vocabulary. */
  usage: Partial<Record<PriceDimension, number>>;
};

/** Why a batch settle refused — the settlement family's closed vocabulary. */
export type BatchSettleRefusalReasonCode =
  | "batch_not_found"
  | "request_invalid"
  | "items_incomplete"
  | "settlement_conflict"
  | "price_basis_not_found"
  | "price_unknown"
  | "charge_exceeds_ledger";

/** What an over-cap batch settlement says out loud (17.6's shape, the batch's members). */
export type BatchSettleOverCap = {
  maximumCredits: number;
  actualCost: { numerator: string; denominator: string };
  overBy: { numerator: string; denominator: string };
};

/** What a terminal batch settle answers: the ONE settlement, or a refusal that names why. */
export type BatchSettleOutcome =
  | {
      status: "settled";
      batchId: string;
      reservationId: string;
      chargedCredits: number;
      appliedCredits: number;
      releasedCredits: number;
      actualCost: { numerator: string; denominator: string };
      /** Each item's exact cost in report order — the per-item trace the details carry. */
      itemCosts: { customId: string; exact: { numerator: string; denominator: string } }[];
      remainder: { numerator: string; denominator: string };
      overCap?: BatchSettleOverCap;
    }
  | {
      status: "refused";
      reasonCode: BatchSettleRefusalReasonCode;
      detail: Record<string, unknown>;
    };

export type BatchSettleDependencies = {
  database: Database;
  /** The deployment's validated environment rate — the value lock version 0 names. */
  environmentRate?: ConversionRate;
  /** The audit store the over-cap anomaly is written to; wired in production, spied in tests. */
  audit?: AuditStore;
  /** Injectable clock; the app clock by default. */
  now?: () => Date;
};

/** The batch row's view a settle resolves from — the identity 18.1 froze at creation. */
type BatchRow = typeof batchJobs.$inferSelect;

async function readBatchById(
  database: Database,
  batchId: string,
): Promise<BatchRow | undefined> {
  const [row] = await database
    .select()
    .from(batchJobs)
    .where(eq(batchJobs.batchId, batchId))
    .limit(1);
  return row;
}

async function readBatchByProviderBatchId(
  database: Database,
  providerBatchId: string,
): Promise<BatchRow | undefined> {
  const [row] = await database
    .select()
    .from(batchJobs)
    .where(eq(batchJobs.providerBatchId, providerBatchId))
    .limit(1);
  return row;
}

function isNonEmptyIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value
  );
}

/**
 * The basis lookup's capability member: the item's OWN capability, which the batch_items
 * CHECK already holds to the pricing vocabulary. A value outside it cannot have committed
 * — reaching here with one is a defect to refuse loudly, never a basis to guess.
 */
function itemBasisCapability(capability: string) {
  if (!MODEL_CAPABILITIES.includes(capability as never)) {
    throw new TypeError(
      `batch-settlement: item capability outside the pricing vocabulary: ${capability}`,
    );
  }
  return capability as (typeof MODEL_CAPABILITIES)[number];
}

/** One closed-vocabulary anomaly write; a broken trail must never mask the settlement. */
async function auditOverCap(
  audit: AuditStore | undefined,
  input: {
    batchId: string;
    reservationId: string;
    payer: { kind: string; id: string };
    overCap: BatchSettleOverCap;
  },
): Promise<void> {
  if (audit === undefined) return;
  try {
    await recordAuditEvent(audit, {
      eventType: "billing.batch_settle_over_cap",
      targetType: "batch_job",
      targetId: input.batchId,
      initiator: DEPLOYMENT_INITIATOR,
      payload: {
        batchId: input.batchId,
        reservationId: input.reservationId,
        payerKind: input.payer.kind,
        payerId: input.payer.id,
        maximumCredits: input.overCap.maximumCredits,
        actualCost: input.overCap.actualCost,
        overBy: input.overCap.overBy,
      },
    });
  } catch {
    // The settlement stands on its own ledger row; the audit layer's own failures surface
    // there — the anomaly is not un-recorded by failing to re-record it.
  }
}

/**
 * The batch terminal settlement service: resolve the batch, price every reported item on
 * its own locked cell, sum the exacts, and settle exactly once through the credit writer
 * with the per-item line details riding the same transaction.
 */
export function createBatchSettleService(dependencies: BatchSettleDependencies) {
  const { database } = dependencies;
  const writer = createCreditWriter(database);

  return {
    /**
     * One terminal report of a batch, from either lane. The report must cover EVERY item
     * of the batch (partiality is 18.3's classification); exactly one settlement results
     * no matter how many times the same report arrives.
     */
    async settleBatch(input: {
      batchId?: string;
      providerBatchId?: string;
      items: BatchItemReport[];
      source: BatchSettleTriggerSource;
    }): Promise<BatchSettleOutcome> {
      const hasBatchId = input.batchId !== undefined;
      const hasProviderBatchId = input.providerBatchId !== undefined;
      if (hasBatchId === hasProviderBatchId) {
        return {
          status: "refused",
          reasonCode: "request_invalid",
          detail: {
            field: "batchId",
            reason: "exactly_one_of_batchId_providerBatchId",
          },
        };
      }
      if (hasBatchId && !isNonEmptyIdentifier(input.batchId)) {
        return { status: "refused", reasonCode: "request_invalid", detail: { field: "batchId" } };
      }
      if (hasProviderBatchId && !isNonEmptyIdentifier(input.providerBatchId)) {
        return { status: "refused", reasonCode: "request_invalid", detail: { field: "providerBatchId" } };
      }
      if (!Array.isArray(input.items) || input.items.length === 0) {
        return { status: "refused", reasonCode: "request_invalid", detail: { field: "items" } };
      }

      // Resolve the batch: the poll lane names the local id, the notification lane the
      // provider's.
      const batch = hasBatchId
        ? await readBatchById(database, input.batchId as string)
        : await readBatchByProviderBatchId(database, input.providerBatchId as string);
      if (batch === undefined) {
        return {
          status: "refused",
          reasonCode: "batch_not_found",
          detail: hasBatchId
            ? { batchId: input.batchId }
            : { providerBatchId: input.providerBatchId },
        };
      }

      // The batch's items — the identity the report must cover, in submit order.
      const itemRows = await database
        .select()
        .from(batchItems)
        .where(eq(batchItems.batchId, batch.batchId))
        .orderBy(batchItems.itemIndex);
      const byCustomId = new Map(itemRows.map((row) => [row.customId, row]));

      // Validate the report: every reported item must be one of the batch's, its usage a
      // whole non-negative quantity map (a dimension the report does not carry is not a
      // zero — priced strictly, per dimension), and no item reported twice.
      const reported = new Map<string, { report: BatchItemReport; item: typeof itemRows[number] }>();
      for (const [index, report] of input.items.entries()) {
        if (
          report === null ||
          typeof report !== "object" ||
          !isNonEmptyIdentifier(report.customId)
        ) {
          return {
            status: "refused",
            reasonCode: "request_invalid",
            detail: { field: `items[${index}].customId` },
          };
        }
        if (reported.has(report.customId)) {
          return {
            status: "refused",
            reasonCode: "request_invalid",
            detail: { field: `items[${index}].customId`, reason: "duplicate" },
          };
        }
        const item = byCustomId.get(report.customId);
        if (item === undefined) {
          return {
            status: "refused",
            reasonCode: "request_invalid",
            detail: { customId: report.customId, reason: "not_in_batch" },
          };
        }
        if (
          report.terminalState !== "completed" &&
          report.terminalState !== "failed" &&
          report.terminalState !== "cancelled"
        ) {
          return {
            status: "refused",
            reasonCode: "request_invalid",
            detail: { field: `items[${index}].terminalState` },
          };
        }
        const usage = report.usage;
        if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
          return {
            status: "refused",
            reasonCode: "request_invalid",
            detail: { field: `items[${index}].usage` },
          };
        }
        for (const [dimension, quantity] of Object.entries(usage)) {
          if (!PRICE_DIMENSIONS.includes(dimension as PriceDimension)) {
            return {
              status: "refused",
              reasonCode: "request_invalid",
              detail: { field: `items[${index}].usage.${dimension}` },
            };
          }
          if (
            typeof quantity !== "number" ||
            !Number.isSafeInteger(quantity) ||
            quantity < 0
          ) {
            return {
              status: "refused",
              reasonCode: "request_invalid",
              detail: { field: `items[${index}].usage.${dimension}` },
            };
          }
        }
        reported.set(report.customId, { report, item });
      }
      if (reported.size !== itemRows.length) {
        return {
          status: "refused",
          reasonCode: "items_incomplete",
          detail: {
            reported: reported.size,
            expected: itemRows.length,
            missing: itemRows
              .filter((row) => !reported.has(row.customId))
              .map((row) => row.customId),
          },
        };
      }

      // The reservation is the settlement's anchor — it names the account; the pricing
      // basis is the batch's (versions) × each item's own cell, resolved per item below.
      const [reservation] = await database
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.id, batch.reservationId))
        .limit(1);
      if (reservation === undefined) {
        return {
          status: "refused",
          reasonCode: "settlement_conflict",
          detail: { kind: "no_such_reservation", reason: "no such reservation" },
        };
      }
      const wasSettled = reservation.status === "settled";

      // Price every item on its OWN cell at the batch's locked versions — the exact
      // arithmetic admission used, per item, with no rounding until the sum is whole.
      const itemExact: {
        item: typeof itemRows[number];
        report: BatchItemReport;
        exact: { numerator: bigint; denominator: bigint };
        usageFull: Record<PriceDimension, number>;
      }[] = [];
      const basisCache = new Map<string, { dims: Parameters<typeof computeReservationCeiling>[0]["dims"]; rate: ConversionRate }>();
      let totalNumerator = 0n;
      let totalDenominator = 1n;
      for (const row of itemRows) {
        const entry = reported.get(row.customId);
        if (entry === undefined) continue;
        const cellKey = `${row.provider}\u0000${row.model}\u0000${row.capability}`;
        let basis = basisCache.get(cellKey);
        if (basis === undefined) {
          // The batch's own locked versions name the basis — never the reservation's
          // anchor-cell lock (a multi-model batch has no single price basis).
          const resolved = await resolveLockedReservationBasis(
            {
              database,
              ...(dependencies.environmentRate !== undefined
                ? { environmentRate: dependencies.environmentRate }
                : {}),
            },
            {
              provider: row.provider,
              model: row.model,
              capability: itemBasisCapability(row.capability),
              snapshotVersion: batch.snapshotVersion,
              rateVersion: batch.rateVersion,
            },
          );
          if (!resolved.resolved) {
            return {
              status: "refused",
              reasonCode: "price_basis_not_found",
              detail: {
                provider: row.provider,
                model: row.model,
                snapshotVersion: batch.snapshotVersion,
                rateVersion: batch.rateVersion,
                reason: resolved.reason,
              },
            };
          }
          basis = { dims: resolved.dims, rate: resolved.rate };
          basisCache.set(cellKey, basis);
        }
        const usageFull = Object.fromEntries(
          PRICE_DIMENSIONS.map((dimension) => [
            dimension,
            (entry.report.usage as Record<string, number>)[dimension] ?? 0,
          ]),
        ) as Record<PriceDimension, number>;
        const priced = computeReservationCeiling({
          dims: basis.dims,
          quantities: usageFull,
          rate: basis.rate,
        });
        if (!priced.ok) {
          const issue = priced.issue;
          switch (issue.code) {
            case "quantity_invalid":
              return {
                status: "refused",
                reasonCode: "request_invalid",
                detail: {
                  field: `items.customId=${row.customId}`,
                  dimension: issue.dimension,
                },
              };
            case "price_unknown":
              return {
                status: "refused",
                reasonCode: "price_unknown",
                detail: {
                  customId: row.customId,
                  dimension: issue.dimension,
                  reason: issue.reason,
                  snapshotVersion: batch.snapshotVersion,
                },
              };
            case "rate_invalid":
              return {
                status: "refused",
                reasonCode: "price_basis_not_found",
                detail: { rateVersion: batch.rateVersion, reason: "rate_invalid" },
              };
            case "ceiling_exceeds_ledger":
              return {
                status: "refused",
                reasonCode: "charge_exceeds_ledger",
                detail: { snapshotVersion: batch.snapshotVersion },
              };
          }
          throw new TypeError(
            `batch-settlement: unhandled pricing issue ${JSON.stringify(issue)}`,
          );
        }
        itemExact.push({ item: row, report: entry.report, exact: priced.exactScaledUnits, usageFull });
        totalNumerator =
          totalNumerator * priced.exactScaledUnits.denominator +
          priced.exactScaledUnits.numerator * totalDenominator;
        totalDenominator =
          totalDenominator * priced.exactScaledUnits.denominator;
      }
      const actual = { numerator: totalNumerator, denominator: totalDenominator };

      // The over-cap anomaly, computed BEFORE the settle so its shape is the priced fact.
      const cap = BigInt(reservation.maximum);
      const overCap: BatchSettleOverCap | undefined =
        totalNumerator > cap * totalDenominator
          ? {
              maximumCredits: reservation.maximum,
              actualCost: {
                numerator: totalNumerator.toString(),
                denominator: totalDenominator.toString(),
              },
              overBy: {
                numerator: (totalNumerator - cap * totalDenominator).toString(),
                denominator: totalDenominator.toString(),
              },
            }
          : undefined;

      try {
        const settled = await writer.settleReservation({
          reservationId: batch.reservationId,
          actual,
          title: `settle batch ${batch.batchId}`,
          // The batch IS the request's identity here: the ledger row's request id is the
          // attribution key every surface of a batch charge names.
          requestId: batch.batchId,
          // A batch spans models — there is no single model cell to name; null is the
          // honest value, the items' own cells live on the detail lines.
          model: null,
          lineDetail: {
            batchId: batch.batchId,
            providerBatchId: batch.providerBatchId,
            itemCount: itemRows.length,
            items: itemExact.map((entry) => ({
              itemId: entry.item.itemId,
              customId: entry.item.customId,
              provider: entry.item.provider,
              model: entry.item.model,
              capability: entry.item.capability,
              terminalState: entry.report.terminalState,
              actualUsage: entry.usageFull,
              exactCost: entry.exact,
            })),
          },
        });

        if (overCap !== undefined && !wasSettled) {
          await auditOverCap(dependencies.audit, {
            batchId: batch.batchId,
            reservationId: batch.reservationId,
            payer: { kind: batch.payerKind, id: batch.payerId },
            overCap,
          });
        }

        return {
          status: "settled",
          batchId: batch.batchId,
          reservationId: batch.reservationId,
          chargedCredits: settled.chargedCents,
          appliedCredits: settled.appliedCents,
          releasedCredits: settled.releasedCents,
          actualCost: {
            numerator: actual.numerator.toString(),
            denominator: actual.denominator.toString(),
          },
          itemCosts: itemExact.map((entry) => ({
            customId: entry.item.customId,
            exact: {
              numerator: entry.exact.numerator.toString(),
              denominator: entry.exact.denominator.toString(),
            },
          })),
          remainder: {
            numerator: settled.remainder.numerator.toString(),
            denominator: settled.remainder.denominator.toString(),
          },
          ...(overCap !== undefined ? { overCap } : {}),
        };
      } catch (error) {
        if (error instanceof CreditReservationConflictError) {
          return {
            status: "refused",
            reasonCode: "settlement_conflict",
            detail: { kind: error.conflictKind, reason: error.message },
          };
        }
        throw error;
      }
    },
  };
}

export type BatchSettleService = ReturnType<typeof createBatchSettleService>;

/** The per-item settlement lines of one batch — the item-level attribution read. */
export async function readBatchSettlementDetails(
  database: Database,
  batchId: string,
): Promise<
  {
    itemId: string;
    batchId: string;
    ledgerId: string;
    provider: string;
    model: string;
    capability: string;
    customId: string;
    terminalState: string;
    actualUsage: Record<string, number>;
    exactCost: { numerator: string; denominator: string };
    createdAt: Date;
  }[]
> {
  return database
    .select()
    .from(creditBatchSettlementDetails)
    .where(eq(creditBatchSettlementDetails.batchId, batchId))
    .orderBy(creditBatchSettlementDetails.createdAt, creditBatchSettlementDetails.itemId);
}

/** The batch-level attribution read: the one ledger row a settled batch's charge names. */
export async function readBatchLedgerRow(
  database: Database,
  batchId: string,
): Promise<typeof creditLedger.$inferSelect | undefined> {
  const [row] = await database
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.requestId, batchId))
    .limit(1);
  return row;
}
