/*
 * The item-cancellation lane (Bifrost 18.4, #336): the cancel notifications of a batch's
 * items — recorded with their evidence, audited, and carried into the batch's ONE
 * settlement by the partial lane whose classification vocabulary this ticket extends.
 *
 * A CANCELLATION IS A TERMINAL FACT, NOT A WISH. The only cancellation that releases is
 * the one the PROVIDER's own accounting stands on (`cancelled_unbilled` — its
 * acknowledgement that nothing ran); a cancellation that ran real work settles that work
 * in full (丢账 — a lost charge — is half of this ticket's name, and an executed item's
 * cost does not evaporate because a cancel arrived after it). A cancellation carrying
 * neither shape is `unknown` and keeps the hold — the client's cancel wish is not
 * no-charge evidence, exactly as a disconnect or a timeout never was (06.8's own rule).
 *
 * THE ITEM ID IS THE IDEMPOTENCY KEY. The outcome row is keyed by `item_id` (one row per
 * item, ever — a duplicate notification increments its `reports` counter, never a second
 * row and never a second audit trail), the charge line likewise, and the reservation
 * settles once: three fences answer "同一条目不会被结算两次" from three sides, which is
 * what a duplicate-notification storm actually runs into.
 *
 * THE AUDIT IS THE CANCELLATION'S OWN RECORD. Every classification that LANDS as
 * `cancelled` (first arrival, or a change from another class) writes one
 * `billing.batch_item_cancelled` row — the item, the batch, the payer, whether the item
 * was billed, and the evidence it stands on. The audit lives in the partial lane's
 * recording path, so a cancellation arriving by the settle report instead of this lane
 * still lands its trail — one place, every door.
 */

import { eq } from "drizzle-orm";
import type { AuditStore } from "../audit";
import type { Database } from "../db/client";
import {
  batchItemOutcomes,
  batchJobs,
  creditBatchSettlementDetails,
} from "../db/schema/credit-reservations";
import type { ConversionRate } from "../gateway/conversion-rate";
import type {
  BatchOutcomeCounts,
  BatchPartialItemReport,
  BatchPartialOutcome,
} from "./batch-partial";
import { createBatchPartialSettleService } from "./batch-partial";

/** The unbilled-cancellation evidence kind — the provider's own acknowledgement. */
export const BATCH_CANCEL_EVIDENCE_KIND = "cancelled_unbilled";

/** One item's cancellation notification: usage when billed, evidence when unbilled. */
export type BatchCancellationReport = Extract<
  BatchPartialItemReport,
  { kind: "cancelled" }
>;

/** Which lane delivered the cancellation: the sweeper's poll, or the notification. */
export type BatchCancelTriggerSource = "poll" | "notification";

/** What the cancel lane answers — the partial lane's own outcome, verbatim. */
export type BatchCancelOutcome = BatchPartialOutcome;

export type BatchCancelDependencies = {
  database: Database;
  environmentRate?: ConversionRate;
  /** The audit store the cancellation trail is written to; wired in production. */
  audit?: AuditStore;
  now?: () => Date;
};

/**
 * The cancellation lane: validate the batch exists, then hand the cancellations to the
 * partial lane — which records the outcomes (auditing every classification that lands as
 * cancelled), refuses the contradictory shapes, and settles the batch when nothing is
 * unknown. A batch whose other items are still unreported answers `pending_unknown`:
 * the cancellations stand, the money waits for the rest.
 */
export function createBatchCancelService(
  dependencies: BatchCancelDependencies,
) {
  const { database } = dependencies;
  const partial = createBatchPartialSettleService(dependencies);

  return {
    async reportBatchCancellations(input: {
      batchId: string;
      cancellations: BatchCancellationReport[];
      source: BatchCancelTriggerSource;
    }): Promise<BatchCancelOutcome> {
      if (typeof input.batchId !== "string" || input.batchId.length === 0) {
        return {
          status: "refused",
          reasonCode: "request_invalid",
          detail: { field: "batchId" },
        };
      }
      if (
        !Array.isArray(input.cancellations) ||
        input.cancellations.length === 0
      ) {
        return {
          status: "refused",
          reasonCode: "request_invalid",
          detail: { field: "cancellations" },
        };
      }
      const [batch] = await database
        .select({ batchId: batchJobs.batchId })
        .from(batchJobs)
        .where(eq(batchJobs.batchId, input.batchId))
        .limit(1);
      if (batch === undefined) {
        return {
          status: "refused",
          reasonCode: "batch_not_found",
          detail: { batchId: input.batchId },
        };
      }
      return partial.settlePartialBatch({
        batchId: input.batchId,
        reports: input.cancellations,
        source: input.source,
      });
    },
  };
}

export type BatchCancelService = ReturnType<typeof createBatchCancelService>;

/**
 * The cancellation-aware status view (AC-4): every item with its classification, the
 * cancel/fail distinction explicit (the classification AND the terminal word), and the
 * money shape of each cancellation — `releasedOnEvidence` for the unbilled share,
 * `billed` for the executed one.
 */
export async function readBatchCancelView(
  database: Database,
  batchId: string,
): Promise<
  | {
      batch: {
        batchId: string;
        state: string;
        maximumCredits: number;
        itemCount: number;
        settledAt: Date | null;
      };
      counts: BatchOutcomeCounts;
      items: {
        itemId: string;
        customId: string;
        classification: string;
        terminalState: string | null;
        /** True when the item's share handed back on no-charge evidence. */
        releasedOnEvidence: boolean;
        /** True when the item carries a settled charge (executed, incl. cancelled-run). */
        billed: boolean;
        evidence: { kind: string; reference?: string } | null;
        reports: number;
      }[];
    }
  | undefined
> {
  const [batch] = await database
    .select()
    .from(batchJobs)
    .where(eq(batchJobs.batchId, batchId))
    .limit(1);
  if (batch === undefined) return undefined;
  const items = await database
    .select({
      itemId: batchItemOutcomes.itemId,
      customId: batchItemOutcomes.customId,
      classification: batchItemOutcomes.classification,
      terminalState: batchItemOutcomes.terminalState,
      evidence: batchItemOutcomes.evidence,
      reports: batchItemOutcomes.reports,
      usage: batchItemOutcomes.usage,
    })
    .from(batchItemOutcomes)
    .where(eq(batchItemOutcomes.batchId, batchId))
    .orderBy(batchItemOutcomes.customId);
  const billedItemIds = new Set(
    (
      await database
        .select({ itemId: creditBatchSettlementDetails.itemId })
        .from(creditBatchSettlementDetails)
        .where(eq(creditBatchSettlementDetails.batchId, batchId))
    ).map((row) => row.itemId),
  );
  return {
    batch: {
      batchId: batch.batchId,
      state: batch.state,
      maximumCredits: batch.maximumCredits,
      itemCount: batch.itemCount,
      settledAt: batch.settledAt,
    },
    counts: {
      completed: batch.completedCount,
      failedBillable: batch.failedBillableCount,
      released: batch.releasedCount,
      unknown: batch.unknownCount,
      cancelled: batch.cancelledCount,
    },
    items: items.map((row) => ({
      itemId: row.itemId,
      customId: row.customId,
      classification: row.classification,
      terminalState: row.terminalState,
      releasedOnEvidence:
        (row.classification === "not_dispatched" ||
          (row.classification === "cancelled" && row.usage === null)) &&
        row.evidence !== null,
      billed: billedItemIds.has(row.itemId),
      evidence: row.evidence,
      reports: row.reports,
    })),
  };
}
