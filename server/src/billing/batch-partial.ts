/*
 * The batch partial-success lane (Bifrost 18.3, #335): settlement fires when EVERY item's
 * disposition is known — the billable items' exact costs summed into the ONE settlement,
 * the evidenced not-dispatched items' shares handed back WITH it, and the unknown items
 * keeping the hold until evidence arrives.
 *
 * THE CLASSIFICATION IS THE TICKET'S OWN VOCABULARY, DERIVED PURELY. `classifyBatchItem`
 * maps one reported item to exactly one of completed / failed_billable / not_dispatched /
 * unknown: a terminal report with the provider's own state and usage is billable
 * (completed, or failed-but-billed — a failure the provider charged is a cost, not a
 * gift); an ABSENT item releases only on `not_dispatched` evidence (the provider's own
 * accounting that the item never ran); everything else — an absence without evidence, a
 * batch gone from retention, a refused key — is `unknown`, because none of it proves no
 * cost was produced. That last rule is the whole ticket: the whole-batch release is the
 * shortcut this lane exists to refuse ("不得因'批量未全部完成'整体释放").
 *
 * THE MONEY MOVES ONCE, WHEN NOTHING IS UNKNOWN. With any item unknown the lane records
 * every classification it has and answers `pending_unknown` — no settle, no release, the
 * hold keeps its FULL cap occupied (06.8's own rule: an unconfirmed result always
 * occupies). When the last unknown resolves (the same report arriving again with its
 * evidence — the recovery shape), the ONE settlement prices every billable item on its
 * own cell at the batch's locked versions, sums the exacts, and settles the batch's
 * reservation with the per-item line details riding the transaction (18.2's writer
 * branch); the released items contribute no charge, so their certified shares hand back
 * with the settle's released side — ON their evidence, which the outcome rows carry.
 *
 * THE STATUS IS A FACT, NOT A DERIVATION. The batch row's state lands as `partial`
 * (mixed outcomes), `completed` (every item completed) or `failed` (none completed) with
 * the per-class counts beside it — the user/admin views read the row, never re-derive
 * the classification from the ledger.
 */

import { sql as dsql, eq } from "drizzle-orm";
import type { AuditStore } from "../audit";
import { DEPLOYMENT_INITIATOR, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import {
  batchItemOutcomes,
  batchItems,
  batchJobs,
  creditReservations,
} from "../db/schema/credit-reservations";
import { MODEL_CAPABILITIES } from "../gateway/catalog";
import type { ConversionRate } from "../gateway/conversion-rate";
import {
  PRICE_DIMENSIONS,
  type PriceDimension,
} from "../gateway/price-snapshot";
import {
  CreditReservationConflictError,
  createCreditWriter,
} from "./credits-writer";
import {
  computeReservationCeiling,
  resolveLockedReservationBasis,
} from "./reserve-bound";

/** The item's terminal states a partial report may carry. */
export type BatchPartialItemTerminalState =
  | "completed"
  | "failed"
  | "cancelled";

/**
 * The no-charge evidence kinds an ABSENT batch item may release on. Closed on purpose:
 * `not_dispatched` — the provider's own accounting that the item never ran (its batch
 * status naming fewer dispatched items than submitted, the reference naming where). A
 * batch gone from retention or a refused key prove nothing about whether cost was
 * produced, so they are not members; those classify `unknown` and keep the hold.
 */
export const BATCH_ITEM_RELEASE_EVIDENCE_KINDS = ["not_dispatched"] as const;

export type BatchItemReleaseEvidence = {
  kind: (typeof BATCH_ITEM_RELEASE_EVIDENCE_KINDS)[number];
  reference?: string;
};

/** One item's report: terminal with usage, absent with evidence, cancelled (18.4) with
 * whichever money shape the provider's own accounting names, or explicitly unknown. */
export type BatchPartialItemReport =
  | {
      kind: "terminal";
      customId: string;
      terminalState: BatchPartialItemTerminalState;
      usage: Partial<Record<PriceDimension, number>>;
    }
  | { kind: "absent"; customId: string; evidence: BatchItemReleaseEvidence }
  | {
      /** 18.4: the item was cancelled. `usage` when the provider billed what ran (the
       * cost settles in full — 丢账 is lost charge); `evidence` (`cancelled_unbilled`,
       * the provider's own acknowledgement) when nothing ran; neither is `unknown`. */
      kind: "cancelled";
      customId: string;
      usage?: Partial<Record<PriceDimension, number>>;
      evidence?: { kind: "cancelled_unbilled"; reference?: string };
      reason?: string;
    }
  | { kind: "unknown"; customId: string; reason?: string };

/** The closed classification vocabulary the tickets name — one class per item. The
 * `cancelled` member (18.4) is a terminal fact with two money shapes: usage when the
 * provider billed what ran (the cost settles in full), `cancelled_unbilled` evidence
 * when nothing ran (the share releases); neither is `unknown`, which keeps the hold. */
export type BatchItemClassification =
  | "completed"
  | "failed_billable"
  | "not_dispatched"
  | "unknown"
  | "cancelled";

/** Which lane reported: the sweeper's poll, or the provider's notification. */
export type BatchPartialTriggerSource = "poll" | "notification";

/**
 * The pure classifier: one report → one class. Total and deterministic — the same report
 * always classifies the same way, on every lane, so a re-report agrees with the stored
 * outcome instead of re-deriving a different batch.
 */
export function classifyBatchItem(
  report: BatchPartialItemReport,
): BatchItemClassification {
  if (report.kind === "terminal") {
    return report.terminalState === "completed"
      ? "completed"
      : "failed_billable";
  }
  if (report.kind === "absent") {
    // An absence releases ONLY on the closed no-charge vocabulary; anything else the
    // caller might call evidence is an unknown, because it proves nothing about cost.
    const validKind = (
      BATCH_ITEM_RELEASE_EVIDENCE_KINDS as readonly string[]
    ).includes(report.evidence?.kind ?? "");
    return validKind ? "not_dispatched" : "unknown";
  }
  if (report.kind === "cancelled") {
    // The executed half settles (billed for what ran); only the provider's own
    // unbilled acknowledgement releases — the client's cancel wish proves nothing.
    const billed = Object.values(report.usage ?? {}).some(
      (quantity) => (quantity ?? 0) > 0,
    );
    if (billed) return "cancelled";
    return report.evidence?.kind === "cancelled_unbilled"
      ? "cancelled"
      : "unknown";
  }
  return "unknown";
}

/** The per-class outcome counts the batch row carries and every status view reads. */
export type BatchOutcomeCounts = {
  completed: number;
  failedBillable: number;
  released: number;
  unknown: number;
  cancelled: number;
};

/** Why a partial settle refused — the lane's closed vocabulary. */
export type BatchPartialRefusalReasonCode =
  | "batch_not_found"
  | "request_invalid"
  | "settlement_conflict"
  | "price_basis_not_found"
  | "price_unknown"
  | "charge_exceeds_ledger";

/** What a partial report answers: the settlement, the pending wait, or a refusal. */
export type BatchPartialOutcome =
  | {
      status: "settled";
      batchId: string;
      reservationId: string;
      /** The batch's terminal state as the row now records it. */
      batchState: "partial" | "completed" | "failed" | "cancelled";
      chargedCredits: number;
      appliedCredits: number;
      releasedCredits: number;
      counts: BatchOutcomeCounts;
    }
  | {
      /** No unknown remains was false: at least one item keeps the hold. */
      status: "pending_unknown";
      batchId: string;
      unknownItems: string[];
      counts: BatchOutcomeCounts;
    }
  | {
      status: "refused";
      reasonCode: BatchPartialRefusalReasonCode;
      detail: Record<string, unknown>;
    };

export type BatchPartialDependencies = {
  database: Database;
  environmentRate?: ConversionRate;
  /** The audit store the cancellation trail (18.4) is written to; wired in production. */
  audit?: AuditStore;
  now?: () => Date;
};

/**
 * The basis lookup's capability member — the batch_items CHECK's own vocabulary; a value
 * outside it cannot have committed, so reaching here with one is a defect to refuse.
 */
function itemBasisCapability(capability: string) {
  if (!MODEL_CAPABILITIES.includes(capability as never)) {
    throw new TypeError(
      `batch-partial: item capability outside the pricing vocabulary: ${capability}`,
    );
  }
  return capability as (typeof MODEL_CAPABILITIES)[number];
}

function isNonEmptyIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value
  );
}

/** The batch status view (AC-4): the row's own state, counts and per-item classifications. */
export async function readBatchStatusView(
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
  const outcomes = await database
    .select()
    .from(batchItemOutcomes)
    .where(eq(batchItemOutcomes.batchId, batchId))
    .orderBy(batchItemOutcomes.customId);
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
    items: outcomes.map((row) => ({
      itemId: row.itemId,
      customId: row.customId,
      classification: row.classification,
      terminalState: row.terminalState,
      evidence: row.evidence,
      reports: row.reports,
    })),
  };
}

/**
 * The partial settlement lane: classify every reported item (persisting the outcome
 * rows), refuse to move money while any item is unknown, and settle the batch once when
 * nothing is — the billable items' exact costs summed, the released items' evidence on
 * their rows, and the batch's terminal state and counts recorded with the settle.
 */
export function createBatchPartialSettleService(
  dependencies: BatchPartialDependencies,
) {
  const { database } = dependencies;
  const writer = createCreditWriter(database);
  const now = () => dependencies.now?.() ?? new Date();

  /** One closed-vocabulary cancellation audit write; a broken trail must never mask the
   * lane's own answer (the same discipline the over-cap anomaly write keeps). */
  async function auditCancellation(
    input: {
      batchId: string;
      itemId: string;
      customId: string;
      billed: boolean;
      evidence: { kind: string; reference?: string } | null;
    },
    payer: { kind: string; id: string },
  ): Promise<void> {
    if (dependencies.audit === undefined) return;
    try {
      await recordAuditEvent(dependencies.audit, {
        eventType: "billing.batch_item_cancelled",
        targetType: "batch_item",
        targetId: input.itemId,
        initiator: DEPLOYMENT_INITIATOR,
        payload: {
          batchId: input.batchId,
          itemId: input.itemId,
          customId: input.customId,
          payerKind: payer.kind,
          payerId: payer.id,
          billed: input.billed,
          ...(input.evidence !== null ? { evidence: input.evidence } : {}),
        },
      });
    } catch {
      // The outcome row and the ledger stand on their own; the audit layer's failures
      // surface there.
    }
  }

  /** Upsert one item's outcome row: first report writes, later reports count. A
   * classification that CHANGES to `cancelled` lands its audit row exactly once (a pure
   * duplicate increments the counter, never the trail). */
  async function recordOutcome(input: {
    itemId: string;
    batchId: string;
    customId: string;
    classification: BatchItemClassification;
    terminalState: BatchPartialItemTerminalState | null;
    evidence:
      | BatchItemReleaseEvidence
      | { kind: "cancelled_unbilled"; reference?: string }
      | null;
    usage: Record<string, number> | null;
    payer: { kind: string; id: string };
  }): Promise<void> {
    const at = now();
    const [existing] = await database
      .select({ classification: batchItemOutcomes.classification })
      .from(batchItemOutcomes)
      .where(eq(batchItemOutcomes.itemId, input.itemId))
      .limit(1);
    await database
      .insert(batchItemOutcomes)
      .values({
        itemId: input.itemId,
        batchId: input.batchId,
        customId: input.customId,
        classification: input.classification,
        ...(input.terminalState !== null
          ? { terminalState: input.terminalState }
          : {}),
        // The raw SQL wrappers are the jsonb driver trap's own workaround: objects and
        // nulls must land typed, never as strings (the async detail's documented trap).
        ...(input.evidence !== null
          ? {
              evidence: dsql`${input.evidence}` as unknown as {
                kind: string;
                reference?: string;
              },
            }
          : {}),
        ...(input.usage !== null
          ? {
              usage: dsql`${input.usage}` as unknown as Record<string, number>,
            }
          : {}),
        reports: 1,
        firstReportedAt: at,
        lastReportedAt: at,
      })
      .onConflictDoUpdate({
        target: batchItemOutcomes.itemId,
        set: {
          classification: input.classification,
          ...(input.terminalState !== null
            ? { terminalState: input.terminalState }
            : {}),
          ...(input.evidence !== null
            ? {
                evidence: dsql`${input.evidence}` as unknown as {
                  kind: string;
                  reference?: string;
                },
              }
            : {}),
          ...(input.usage !== null
            ? {
                usage: dsql`${input.usage}` as unknown as Record<
                  string,
                  number
                >,
              }
            : {}),
          reports: dsql`${batchItemOutcomes.reports} + 1`,
          lastReportedAt: at,
        },
      });
    if (
      input.classification === "cancelled" &&
      existing?.classification !== "cancelled"
    ) {
      await auditCancellation(
        {
          batchId: input.batchId,
          itemId: input.itemId,
          customId: input.customId,
          billed: input.usage !== null,
          evidence: input.evidence,
        },
        input.payer,
      );
    }
  }

  return {
    async settlePartialBatch(input: {
      batchId: string;
      reports: BatchPartialItemReport[];
      source: BatchPartialTriggerSource;
    }): Promise<BatchPartialOutcome> {
      if (!isNonEmptyIdentifier(input.batchId)) {
        return {
          status: "refused",
          reasonCode: "request_invalid",
          detail: { field: "batchId" },
        };
      }
      if (!Array.isArray(input.reports) || input.reports.length === 0) {
        return {
          status: "refused",
          reasonCode: "request_invalid",
          detail: { field: "reports" },
        };
      }
      void input.source;

      const [batch] = await database
        .select()
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

      const itemRows = await database
        .select()
        .from(batchItems)
        .where(eq(batchItems.batchId, batch.batchId))
        .orderBy(batchItems.itemIndex);
      const byCustomId = new Map(itemRows.map((row) => [row.customId, row]));

      // Validate and classify every report; unknown items are a legitimate ANSWER, not a
      // refusal — the lane's whole subject is what to do with them.
      const reported = new Map<
        string,
        {
          report: BatchPartialItemReport;
          item: (typeof itemRows)[number];
          classification: BatchItemClassification;
          usageFull: Record<PriceDimension, number> | null;
          evidence:
            | BatchItemReleaseEvidence
            | { kind: "cancelled_unbilled"; reference?: string }
            | null;
        }
      >();
      for (const [index, report] of input.reports.entries()) {
        if (
          report === null ||
          typeof report !== "object" ||
          !isNonEmptyIdentifier(report.customId)
        ) {
          return {
            status: "refused",
            reasonCode: "request_invalid",
            detail: { field: `reports[${index}].customId` },
          };
        }
        if (reported.has(report.customId)) {
          return {
            status: "refused",
            reasonCode: "request_invalid",
            detail: {
              field: `reports[${index}].customId`,
              reason: "duplicate",
            },
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
        const classification = classifyBatchItem(report);
        let usageFull: Record<PriceDimension, number> | null = null;
        let evidence:
          | BatchItemReleaseEvidence
          | { kind: "cancelled_unbilled"; reference?: string }
          | null = null;
        if (report.kind === "cancelled") {
          const usage = report.usage ?? {};
          if (typeof usage !== "object" || Array.isArray(usage)) {
            return {
              status: "refused",
              reasonCode: "request_invalid",
              detail: { field: `reports[${index}].usage` },
            };
          }
          let anyPositive = false;
          for (const [dimension, quantity] of Object.entries(usage)) {
            if (
              !PRICE_DIMENSIONS.includes(dimension as PriceDimension) ||
              typeof quantity !== "number" ||
              !Number.isSafeInteger(quantity) ||
              quantity < 0
            ) {
              return {
                status: "refused",
                reasonCode: "request_invalid",
                detail: { field: `reports[${index}].usage.${dimension}` },
              };
            }
            if (quantity > 0) anyPositive = true;
          }
          // The contradiction the shape CHECK refuses at the database: an item billed
          // for what ran cannot simultaneously claim unbilled evidence.
          if (anyPositive && report.evidence !== undefined) {
            return {
              status: "refused",
              reasonCode: "request_invalid",
              detail: {
                field: `reports[${index}]`,
                reason: "billed_with_unbilled_evidence",
              },
            };
          }
          usageFull = anyPositive
            ? (Object.fromEntries(
                PRICE_DIMENSIONS.map((dimension) => [
                  dimension,
                  (usage as Record<string, number>)[dimension] ?? 0,
                ]),
              ) as Record<PriceDimension, number>)
            : null;
          evidence =
            !anyPositive && report.evidence?.kind === "cancelled_unbilled"
              ? report.evidence
              : null;
        } else if (report.kind === "terminal") {
          if (
            report.terminalState !== "completed" &&
            report.terminalState !== "failed" &&
            report.terminalState !== "cancelled"
          ) {
            return {
              status: "refused",
              reasonCode: "request_invalid",
              detail: { field: `reports[${index}].terminalState` },
            };
          }
          const usage = report.usage ?? {};
          if (typeof usage !== "object" || Array.isArray(usage)) {
            return {
              status: "refused",
              reasonCode: "request_invalid",
              detail: { field: `reports[${index}].usage` },
            };
          }
          usageFull = Object.fromEntries(
            PRICE_DIMENSIONS.map((dimension) => [
              dimension,
              (usage as Record<string, number>)[dimension] ?? 0,
            ]),
          ) as Record<PriceDimension, number>;
          for (const [dimension, quantity] of Object.entries(usage)) {
            if (
              !PRICE_DIMENSIONS.includes(dimension as PriceDimension) ||
              typeof quantity !== "number" ||
              !Number.isSafeInteger(quantity) ||
              quantity < 0
            ) {
              return {
                status: "refused",
                reasonCode: "request_invalid",
                detail: { field: `reports[${index}].usage.${dimension}` },
              };
            }
          }
        } else if (report.kind === "absent") {
          evidence = report.evidence;
        }
        reported.set(report.customId, {
          report,
          item,
          classification,
          usageFull,
          evidence,
        });
      }

      // The outcome rows land for every reported item — the classification stands even
      // when the money cannot move yet (a pending batch's facts are the recovery input).
      for (const entry of reported.values()) {
        const cancelledBilled =
          entry.classification === "cancelled" && entry.usageFull !== null;
        const cancelledReleased =
          entry.classification === "cancelled" && entry.usageFull === null;
        await recordOutcome({
          itemId: entry.item.itemId,
          batchId: batch.batchId,
          payer: { kind: batch.payerKind, id: batch.payerId },
          customId: entry.item.customId,
          classification: entry.classification,
          terminalState:
            entry.report.kind === "terminal"
              ? entry.report.terminalState
              : entry.report.kind === "cancelled"
                ? "cancelled"
                : null,
          evidence:
            entry.classification === "not_dispatched" || cancelledReleased
              ? entry.evidence
              : null,
          usage:
            entry.classification === "completed" ||
            entry.classification === "failed_billable" ||
            cancelledBilled
              ? (entry.usageFull as Record<string, number>)
              : null,
        });
      }

      // Every item of the batch must have a classification by now — items nobody reported
      // are unknown (no evidence at all), the strictest member of the vocabulary.
      const classified = new Map(
        (
          await database
            .select()
            .from(batchItemOutcomes)
            .where(eq(batchItemOutcomes.batchId, batch.batchId))
        ).map((row) => [row.customId, row.classification]),
      );
      const counts: BatchOutcomeCounts = {
        completed: 0,
        failedBillable: 0,
        released: 0,
        unknown: 0,
        cancelled: 0,
      };
      const unknownItems: string[] = [];
      for (const row of itemRows) {
        const classification = classified.get(row.customId) ?? "unknown";
        switch (classification) {
          case "completed":
            counts.completed += 1;
            break;
          case "failed_billable":
            counts.failedBillable += 1;
            break;
          case "not_dispatched":
            counts.released += 1;
            break;
          case "cancelled":
            counts.cancelled += 1;
            break;
          case "unknown":
            counts.unknown += 1;
            unknownItems.push(row.customId);
            break;
        }
      }

      if (counts.unknown > 0) {
        // The hold keeps its FULL cap — no settle, no release, no whole-batch shortcut.
        await database
          .update(batchJobs)
          .set({ unknownCount: counts.unknown })
          .where(eq(batchJobs.batchId, batch.batchId));
        return {
          status: "pending_unknown",
          batchId: batch.batchId,
          unknownItems,
          counts,
        };
      }

      // Price every billable item on its OWN cell at the batch's locked versions (18.2's
      // arithmetic, the partial lane's own members).
      const [reservation] = await database
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.id, batch.reservationId))
        .limit(1);
      if (reservation === undefined) {
        return {
          status: "refused",
          reasonCode: "settlement_conflict",
          detail: {
            kind: "no_such_reservation",
            reason: "no such reservation",
          },
        };
      }
      const basisCache = new Map<
        string,
        {
          dims: Parameters<typeof computeReservationCeiling>[0]["dims"];
          rate: ConversionRate;
        }
      >();
      const billable: {
        item: (typeof itemRows)[number];
        report: BatchPartialItemReport & { kind: "terminal" | "cancelled" };
        exact: { numerator: bigint; denominator: bigint };
        usageFull: Record<PriceDimension, number>;
      }[] = [];
      let totalNumerator = 0n;
      let totalDenominator = 1n;
      for (const row of itemRows) {
        const entry = reported.get(row.customId);
        if (entry === undefined) continue;
        if (
          entry.classification !== "completed" &&
          entry.classification !== "failed_billable" &&
          !(entry.classification === "cancelled" && entry.usageFull !== null)
        ) {
          continue;
        }
        const cellKey = `${row.provider}\u0000${row.model}\u0000${row.capability}`;
        let basis = basisCache.get(cellKey);
        if (basis === undefined) {
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
                reason: resolved.reason,
              },
            };
          }
          basis = { dims: resolved.dims, rate: resolved.rate };
          basisCache.set(cellKey, basis);
        }
        const usageFull = entry.usageFull as Record<PriceDimension, number>;
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
                detail: { customId: row.customId, dimension: issue.dimension },
              };
            case "price_unknown":
              return {
                status: "refused",
                reasonCode: "price_unknown",
                detail: {
                  customId: row.customId,
                  dimension: issue.dimension,
                  reason: issue.reason,
                },
              };
            case "rate_invalid":
              return {
                status: "refused",
                reasonCode: "price_basis_not_found",
                detail: { reason: "rate_invalid" },
              };
            case "ceiling_exceeds_ledger":
              return {
                status: "refused",
                reasonCode: "charge_exceeds_ledger",
                detail: { customId: row.customId },
              };
          }
          throw new TypeError(
            `batch-partial: unhandled pricing issue ${JSON.stringify(issue)}`,
          );
        }
        billable.push({
          item: row,
          report: entry.report as BatchPartialItemReport & {
            kind: "terminal" | "cancelled";
          },
          exact: priced.exactScaledUnits,
          usageFull,
        });
        totalNumerator =
          totalNumerator * priced.exactScaledUnits.denominator +
          priced.exactScaledUnits.numerator * totalDenominator;
        totalDenominator =
          totalDenominator * priced.exactScaledUnits.denominator;
      }
      const actual = {
        numerator: totalNumerator,
        denominator: totalDenominator,
      };

      // The batch's terminal state: completed when every item completed, cancelled when
      // every item cancelled (18.4), failed when none completed, partial for every mix
      // in between (the released/failed/cancelled share is the mix).
      const batchState: "partial" | "completed" | "failed" | "cancelled" =
        counts.completed === itemRows.length
          ? "completed"
          : counts.completed === 0 && counts.cancelled === itemRows.length
            ? "cancelled"
            : counts.completed === 0
              ? "failed"
              : "partial";

      try {
        const settled = await writer.settleReservation({
          reservationId: batch.reservationId,
          actual,
          title: `settle batch ${batch.batchId}`,
          requestId: batch.batchId,
          model: null,
          lineDetail: {
            batchId: batch.batchId,
            providerBatchId: batch.providerBatchId,
            itemCount: itemRows.length,
            // Only the billable members carry charge lines; the released items' evidence
            // lives on their outcome rows, not on a zero-cost ledger line.
            items: billable.map((entry) => ({
              itemId: entry.item.itemId,
              customId: entry.item.customId,
              provider: entry.item.provider,
              model: entry.item.model,
              capability: entry.item.capability,
              // A billed cancellation's line carries the provider's terminal word for
              // what ran — `cancelled` — the detail's own closed vocabulary owns it.
              terminalState:
                entry.report.kind === "terminal"
                  ? entry.report.terminalState
                  : "cancelled",
              actualUsage: entry.usageFull,
              exactCost: entry.exact,
            })),
          },
        });

        const settledAt = now();
        await database
          .update(batchJobs)
          .set({
            state: batchState,
            completedCount: counts.completed,
            failedBillableCount: counts.failedBillable,
            releasedCount: counts.released,
            unknownCount: counts.unknown,
            cancelledCount: counts.cancelled,
            settledAt,
          })
          .where(eq(batchJobs.batchId, batch.batchId));

        return {
          status: "settled",
          batchId: batch.batchId,
          reservationId: batch.reservationId,
          batchState,
          chargedCredits: settled.chargedCents,
          appliedCredits: settled.appliedCents,
          releasedCredits: settled.releasedCents,
          counts,
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

export type BatchPartialSettleService = ReturnType<
  typeof createBatchPartialSettleService
>;
