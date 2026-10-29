import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { AuditStore } from "../audit";
import { DEPLOYMENT_INITIATOR, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import {
  asyncSettleTriggers,
  creditReservations,
} from "../db/schema/credit-reservations";
import type { ConversionRate } from "../gateway/conversion-rate";
import { PRICE_DIMENSIONS } from "../gateway/price-snapshot";
import {
  readAsyncJob,
  readAsyncJobByProviderJobId,
} from "./async-job-identity";
import {
  CreditReservationConflictError,
  createCreditWriter,
} from "./credits-writer";
import {
  computeDimensionScaledUnits,
  computeReservationCeiling,
  lockedBasisOfReservation,
  type ReservationBoundQuantities,
  resolveLockedReservationBasis,
} from "./reserve-bound";

/*
 * The async terminal settlement lane (Bifrost 17.5/#329 + 17.6/#330): settlement fires
 * HERE — on the background's own terminal handling — and only here, exactly once per job
 * no matter how many lanes report the terminal or how often, priced from the reliable
 * terminal usage at the basis the reservation LOCKED.
 *
 * WHY THE TRIGGER MOVED OFF THE QUERY PATH. A status GET that settled would double-charge
 * on the second refresh and race itself on concurrent ones; a completion callback that
 * settled while a poll was settling would need its own fence. The design the tickets fix:
 * queries are SELECT-only (17.4's service holds no money seam at all), and the terminal
 * lane — the sweeper's poll and the provider's completion notification — is the only
 * settler. Both lanes arrive with the SAME facts (the provider's terminal report), so both
 * compute the SAME unified idempotency key and converge on ONE settlement.
 *
 * THE KEY IS THE JOB PLUS THE TERMINAL VERSION. `asyncTerminalSettleKey` derives the key
 * from the local job id, the terminal state, and a digest of the reported usage — a pure
 * function, so the notification lane and the poll lane describing the same terminal
 * produce byte-identical keys with no coordination. An amended report (different usage) is
 * a different version: its key differs, and the settlement fence below answers it as the
 * conflict it is, never a top-up. The key is the message identity; the MONEY fence is the
 * reservation's own settle: one settle per reservation, same actual replays the first
 * result, different actual refuses.
 *
 * THE PRICE IS THE LOCKED VERSION'S, FROM THE REAL TERMINAL USAGE. The numbers priced are
 * the provider's own terminal report — never an estimate, never the certified worst case —
 * converted through the exact same arithmetic admission used, at the dims/rate the hold
 * locked (a price sync mid-flight changes nothing). The unused share of the hold hands
 * back with the settle (the writer's released side), and the line the settlement writes
 * beside its ledger row carries the job's own attribution: the jobId the whole charge is
 * named by (17.6's detail table), the entry count, the terminal state and the usage map.
 *
 * OVER THE CAP IS AN ANOMALY, OUT LOUD. A terminal that prices above the full-cap ceiling
 * is a real cost the certification did not cover: the ledger records it in full, only the
 * held capacity applies, and the `billing.async_settle_over_cap` audit row names the job,
 * the cap, the exact cost and the overage — never a silent truncation, never a silent
 * charge beyond the hold, and the record is what 08.x's disposal consumes.
 *
 * THE COUNTERS ARE THE OBSERVABILITY. Every trigger — convergent, refused or first —
 * upserts the job's trigger row atomically: total, per-lane, last source, and the key the
 * FIRST trigger computed (which never moves). A duplicate trigger is therefore visible as
 * a count that outgrew its settlement (the row 22.3 audits), not discovered as a second
 * charge, because the reservation fence makes a second charge impossible.
 */

/** The provider terminal states that end a job — the money's reliable evidence. */
export type AsyncTerminalState = "completed" | "failed" | "cancelled";

/** Which lane reported the terminal: the sweeper's poll, or the provider's notification. */
export type AsyncSettleTriggerSource = "poll" | "notification";

/** The terminal report itself: the state plus the provider's real usage numbers. */
export type AsyncTerminalReport = {
  state: AsyncTerminalState;
  /** One whole quantity per billing dimension of the closed vocabulary — the numbers the
   * provider's own terminal usage report carries, never an estimate. */
  usage: ReservationBoundQuantities;
  /** What the report stands on; rides the settle as its evidence. */
  evidence: { kind: "provider_usage_report"; reference?: string };
};

/**
 * The unified idempotency key: `async-terminal-settle:<jobId>:<state>:<digest>` — the
 * digest a sha256 over the usage in the dimension vocabulary's fixed order, so two callers
 * holding the same terminal compute the same key. Pure and total: same facts in, same key
 * out, every time, on every lane.
 */
export function asyncTerminalSettleKey(
  jobId: string,
  terminal: Pick<AsyncTerminalReport, "state" | "usage">,
): string {
  const digest = createHash("sha256")
    .update(
      (Object.keys(terminal.usage) as (keyof ReservationBoundQuantities)[])
        .sort()
        .map((dimension) => `${dimension}=${terminal.usage[dimension]}`)
        .join("&"),
    )
    .digest("hex")
    .slice(0, 16);
  return `async-terminal-settle:${jobId}:${terminal.state}:${digest}`;
}

/** The trigger row's own view — the counts and the key 22.3 audits. */
export type AsyncSettleTriggerView = {
  jobId: string;
  idempotencyKey: string;
  terminalState: AsyncTerminalState;
  totalTriggers: number;
  pollTriggers: number;
  notificationTriggers: number;
  firstTriggeredAt: string;
  lastTriggeredAt: string;
  lastSource: AsyncSettleTriggerSource;
};

/** The observability read: the job's trigger row, or undefined when nothing fired yet. */
export async function readAsyncSettleTrigger(
  database: Database,
  jobId: string,
): Promise<AsyncSettleTriggerView | undefined> {
  const [row] = await database
    .select()
    .from(asyncSettleTriggers)
    .where(eq(asyncSettleTriggers.jobId, jobId))
    .limit(1);
  if (row === undefined) return undefined;
  return {
    jobId: row.jobId,
    idempotencyKey: row.idempotencyKey,
    terminalState: row.terminalState,
    totalTriggers: row.totalTriggers,
    pollTriggers: row.pollTriggers,
    notificationTriggers: row.notificationTriggers,
    firstTriggeredAt: row.firstTriggeredAt.toISOString(),
    lastTriggeredAt: row.lastTriggeredAt.toISOString(),
    lastSource: row.lastSource,
  };
}

/**
 * The trigger upsert converged against a row whose idempotency key names a DIFFERENT job.
 * The unified key is the pure function of a job's own facts, so a key already carried by
 * another job's row is an identity conflict — refused out loud (the settle surface answers
 * it as `settlement_conflict`), never a raw 23505 escaping the trigger.
 */
export class AsyncSettleTriggerKeyConflictError extends Error {
  /** The stable machine-readable kind the refusal `detail` answers with. */
  readonly conflictKind = "settle_trigger_key_conflict";
  /** The job the existing row — and therefore the key — belongs to, when it could be read. */
  readonly keyOwnerJobId: string | undefined;
  constructor(message: string, keyOwnerJobId: string | undefined) {
    super(message);
    this.name = "AsyncSettleTriggerKeyConflictError";
    this.keyOwnerJobId = keyOwnerJobId;
  }
}

/** Why a terminal settle refused — the settlement family's closed vocabulary. */
export type AsyncTerminalRefusalReasonCode =
  | "job_not_found"
  | "request_invalid"
  | "settlement_conflict"
  | "price_basis_not_found"
  | "price_unknown"
  | "charge_exceeds_ledger";

/** What an over-cap settlement says out loud: the cap, the exact cost, the overage. */
export type AsyncSettleOverCap = {
  /** The full-cap ceiling the submit certified (scaled units). */
  maximumCredits: number;
  /** The exact terminal cost that exceeded it, lowest terms as strings. */
  actualCost: { numerator: string; denominator: string };
  /** exact − cap, the certified-but-uncovered share, lowest terms as strings. */
  overBy: { numerator: string; denominator: string };
};

/**
 * What a terminal trigger answers. `settled` is the ONE settlement's own result — the
 * first trigger's fresh settle and a later lane's convergent replay answer identically
 * (the writer replays the first result for the same actual); the counters on the trigger
 * member tell the two apart, which is the observability this lane exists to carry. An
 * amended report (a different usage digest) is a different terminal VERSION: its key
 * differs and the settle fence refuses it as `settlement_conflict`, never a top-up.
 */
export type AsyncTerminalSettleOutcome =
  | {
      status: "settled";
      jobId: string;
      reservationId: string;
      chargedCredits: number;
      appliedCredits: number;
      releasedCredits: number;
      actualCost: { numerator: string; denominator: string };
      remainder: { numerator: string; denominator: string };
      /** Present only when the reliable terminal cost exceeded the certified cap (17.6). */
      overCap?: AsyncSettleOverCap;
      trigger: Omit<
        AsyncSettleTriggerView,
        "jobId" | "idempotencyKey" | "terminalState" | "firstTriggeredAt"
      >;
    }
  | {
      status: "refused";
      reasonCode: AsyncTerminalRefusalReasonCode;
      detail: Record<string, unknown>;
    };

export type AsyncTerminalSettleDependencies = {
  database: Database;
  /** The deployment's validated environment rate — the value lock version 0 names. */
  environmentRate?: ConversionRate;
  /** The audit store the over-cap anomaly is written to; wired in production, spied in tests. */
  audit?: AuditStore;
  /** Injectable clock; the app clock by default. */
  now?: () => Date;
};

function isNonEmptyIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value
  );
}

/**
 * The line's capability member: the job's OWN capability, which the async_jobs CHECK
 * already holds to the detail table's closed vocabulary. A value outside it cannot have
 * committed — reaching here with one is a defect to refuse loudly, never a line to guess.
 */
function asyncLineCapability(capability: string) {
  const vocabulary = [
    "chat",
    "embedding",
    "image",
    "speech",
    "transcription",
    "rerank",
    "ocr",
    "realtime",
    "video",
    "unknown",
  ] as const;
  if (!(vocabulary as readonly string[]).includes(capability)) {
    throw new TypeError(
      `async-terminal: job capability outside the line vocabulary: ${capability}`,
    );
  }
  return capability as (typeof vocabulary)[number];
}

/** One closed-vocabulary anomaly write; a broken trail must never mask the settlement. */
async function auditOverCap(
  audit: AuditStore | undefined,
  input: {
    jobId: string;
    reservationId: string;
    payer: { kind: string; id: string };
    terminalState: AsyncTerminalState;
    overCap: AsyncSettleOverCap;
  },
): Promise<void> {
  if (audit === undefined) return;
  try {
    await recordAuditEvent(audit, {
      eventType: "billing.async_settle_over_cap",
      targetType: "async_job",
      targetId: input.jobId,
      initiator: DEPLOYMENT_INITIATOR,
      payload: {
        jobId: input.jobId,
        reservationId: input.reservationId,
        payerKind: input.payer.kind,
        payerId: input.payer.id,
        terminalState: input.terminalState,
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
 * The violated constraint's name when `error` is a Postgres unique_violation (SQLSTATE 23505), else
 * null. Bun's driver puts the SQLSTATE in `errno` and the name in `constraint`; drizzle wraps the
 * driver error as `cause`. (Same helper the identity store uses, kept local so the two modules
 * stay independently readable.)
 */
function uniqueViolationConstraint(error: unknown): string | null {
  type Driver = { errno?: unknown; code?: unknown; constraint?: unknown };
  const candidates = [
    error as Driver | null | undefined,
    (error as { cause?: Driver } | null | undefined)?.cause,
  ];
  for (const candidate of candidates) {
    if (
      candidate?.errno === "23505" ||
      candidate?.errno === 23505 ||
      candidate?.code === "23505"
    )
      return typeof candidate.constraint === "string"
        ? candidate.constraint
        : "";
  }
  return null;
}

/**
 * The terminal settlement service: resolve the job, count the trigger, price the terminal
 * usage at the LOCKED basis, and settle exactly once through the credit writer with the
 * job's line detail and the per-dimension split riding the same transaction. The
 * reservation's own fence is the money guarantee; the unified key and the counters are
 * the convergence and its observability.
 */
export function createAsyncTerminalSettleService(
  dependencies: AsyncTerminalSettleDependencies,
) {
  const { database } = dependencies;
  const writer = createCreditWriter(database);
  const now = () => dependencies.now?.() ?? new Date();

  /**
   * The atomic counter upsert — first insert writes the key, every trigger increments.
   * The arbiter is `job_id` only; the idempotency_key unique is NOT one, so a first-trigger
   * race (two lanes inserting the same new key together) can surface as 23505 on that
   * second index. One retry converges through the arbiter — the winner's row is visible by
   * then, so the same-job conflict lands on `job_id` and the counters grow. A retry that
   * violates the key AGAIN names a key owned by a DIFFERENT job: the typed conflict
   * `settleTerminal` refuses with, never a raw 23505 escaping the trigger.
   */
  async function countTrigger(input: {
    jobId: string;
    idempotencyKey: string;
    terminalState: AsyncTerminalState;
    source: AsyncSettleTriggerSource;
  }): Promise<AsyncSettleTriggerView> {
    const at = now();
    const upsert = async (): Promise<AsyncSettleTriggerView> => {
      const [row] = await database
        .insert(asyncSettleTriggers)
        .values({
          jobId: input.jobId,
          idempotencyKey: input.idempotencyKey,
          terminalState: input.terminalState,
          totalTriggers: 1,
          pollTriggers: input.source === "poll" ? 1 : 0,
          notificationTriggers: input.source === "notification" ? 1 : 0,
          firstTriggeredAt: at,
          lastTriggeredAt: at,
          lastSource: input.source,
        })
        .onConflictDoUpdate({
          target: asyncSettleTriggers.jobId,
          set: {
            totalTriggers: sql`${asyncSettleTriggers.totalTriggers} + 1`,
            pollTriggers: sql`${asyncSettleTriggers.pollTriggers} + ${input.source === "poll" ? 1 : 0}`,
            notificationTriggers: sql`${asyncSettleTriggers.notificationTriggers} + ${input.source === "notification" ? 1 : 0}`,
            lastTriggeredAt: at,
            lastSource: input.source,
          },
        })
        .returning();
      return {
        jobId: row.jobId,
        idempotencyKey: row.idempotencyKey,
        terminalState: row.terminalState,
        totalTriggers: row.totalTriggers,
        pollTriggers: row.pollTriggers,
        notificationTriggers: row.notificationTriggers,
        firstTriggeredAt: row.firstTriggeredAt.toISOString(),
        lastTriggeredAt: row.lastTriggeredAt.toISOString(),
        lastSource: row.lastSource,
      };
    };
    try {
      return await upsert();
    } catch (error) {
      if (
        uniqueViolationConstraint(error) !==
        "async_settle_triggers_idempotency_key_key"
      )
        throw error;
    }
    try {
      return await upsert();
    } catch (error) {
      if (
        uniqueViolationConstraint(error) !==
        "async_settle_triggers_idempotency_key_key"
      )
        throw error;
    }
    const [existing] = await database
      .select()
      .from(asyncSettleTriggers)
      .where(eq(asyncSettleTriggers.idempotencyKey, input.idempotencyKey))
      .limit(1);
    throw new AsyncSettleTriggerKeyConflictError(
      `async-terminal: settle idempotency key already owned by job ${existing?.jobId ?? "unknown"}`,
      existing?.jobId,
    );
  }

  return {
    /**
     * One terminal report, from either lane. Exactly one settlement results no matter how
     * many times the same terminal arrives; an amended report refuses as a conflict.
     */
    async settleTerminal(input: {
      jobId?: string;
      /** The notification lane's own key — the reverse mapping resolves it. */
      providerJobId?: string;
      terminal: AsyncTerminalReport;
      source: AsyncSettleTriggerSource;
    }): Promise<AsyncTerminalSettleOutcome> {
      const hasJobId = input.jobId !== undefined;
      const hasProviderJobId = input.providerJobId !== undefined;
      if (hasJobId === hasProviderJobId) {
        return {
          status: "refused",
          reasonCode: "request_invalid",
          detail: {
            field: "jobId",
            reason: "exactly_one_of_jobId_providerJobId",
          },
        };
      }
      if (hasJobId && !isNonEmptyIdentifier(input.jobId)) {
        return {
          status: "refused",
          reasonCode: "request_invalid",
          detail: { field: "jobId" },
        };
      }
      if (hasProviderJobId && !isNonEmptyIdentifier(input.providerJobId)) {
        return {
          status: "refused",
          reasonCode: "request_invalid",
          detail: { field: "providerJobId" },
        };
      }
      // Every dimension of the closed vocabulary, a whole non-negative count: a dimension
      // the report does not carry is not a zero — a terminal report that cannot name its
      // usage in full cannot be priced strictly (06.9's own rule, kept here).
      const usage = input.terminal?.usage;
      if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
        return {
          status: "refused",
          reasonCode: "request_invalid",
          detail: { field: "terminal.usage" },
        };
      }
      for (const dimension of PRICE_DIMENSIONS) {
        const quantity = (usage as Record<string, unknown>)[dimension];
        if (
          typeof quantity !== "number" ||
          !Number.isSafeInteger(quantity) ||
          quantity < 0
        ) {
          return {
            status: "refused",
            reasonCode: "request_invalid",
            detail: { field: "terminal.usage", dimension },
          };
        }
      }

      // Resolve the job: the poll lane names the local id, the notification lane the
      // provider's — the reverse mapping 17.1 owns answers the latter.
      const job = hasJobId
        ? await readAsyncJob(database, input.jobId as string)
        : await readAsyncJobByProviderJobId(
            database,
            input.providerJobId as string,
          );
      if (job === undefined) {
        return {
          status: "refused",
          reasonCode: "job_not_found",
          detail: hasJobId
            ? { jobId: input.jobId }
            : { providerJobId: input.providerJobId },
        };
      }

      // The trigger count FIRST — even a converged or refused trigger is a trigger the
      // observability must see (that is how a duplicate becomes discoverable).
      const idempotencyKey = asyncTerminalSettleKey(job.jobId, input.terminal);
      let trigger: AsyncSettleTriggerView;
      try {
        trigger = await countTrigger({
          jobId: job.jobId,
          idempotencyKey,
          terminalState: input.terminal.state,
          source: input.source,
        });
      } catch (error) {
        if (error instanceof AsyncSettleTriggerKeyConflictError) {
          // The key belongs to a different job's row — the identity conflict it is,
          // answered in the same closed vocabulary as every other refusal here.
          return {
            status: "refused",
            reasonCode: "settlement_conflict",
            detail: {
              kind: error.conflictKind,
              reason: error.message,
              keyOwnerJobId: error.keyOwnerJobId,
            },
          };
        }
        throw error;
      }

      // The reservation is the settlement's anchor: it names the account and carries the
      // pricing basis the terminal usage must be priced at — the LOCK, never the latest.
      const [reservation] = await database
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.id, job.reservationId))
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
      const wasSettled = reservation.status === "settled";
      const basis = lockedBasisOfReservation(reservation);
      if (basis === null) {
        return {
          status: "refused",
          reasonCode: "price_basis_not_found",
          detail: { stage: "reservation_lock_missing" },
        };
      }
      const resolved = await resolveLockedReservationBasis(
        {
          database,
          ...(dependencies.environmentRate !== undefined
            ? { environmentRate: dependencies.environmentRate }
            : {}),
        },
        basis,
      );
      if (!resolved.resolved) {
        return {
          status: "refused",
          reasonCode: "price_basis_not_found",
          detail: {
            snapshotVersion: basis.snapshotVersion,
            rateVersion: basis.rateVersion,
            reason: resolved.reason,
          },
        };
      }

      // The exact pricing of the REAL terminal usage, through the same pure arithmetic
      // admission used — a price sync that minted a new version mid-flight changes nothing.
      const priced = computeReservationCeiling({
        dims: resolved.dims,
        quantities: usage,
        rate: resolved.rate,
      });
      if (!priced.ok) {
        const issue = priced.issue;
        switch (issue.code) {
          case "quantity_invalid":
            return {
              status: "refused",
              reasonCode: "request_invalid",
              detail: { field: "terminal.usage", dimension: issue.dimension },
            };
          case "price_unknown":
            return {
              status: "refused",
              reasonCode: "price_unknown",
              detail: {
                dimension: issue.dimension,
                reason: issue.reason,
                snapshotVersion: basis.snapshotVersion,
              },
            };
          case "rate_invalid":
            return {
              status: "refused",
              reasonCode: "price_basis_not_found",
              detail: {
                rateVersion: basis.rateVersion,
                reason: "rate_invalid",
              },
            };
          case "ceiling_exceeds_ledger":
            return {
              status: "refused",
              reasonCode: "charge_exceeds_ledger",
              detail: {
                snapshotVersion: basis.snapshotVersion,
                rateVersion: basis.rateVersion,
              },
            };
        }
        throw new TypeError(
          `async-terminal: unhandled pricing issue ${JSON.stringify(issue)}`,
        );
      }

      // The per-dimension split (20.3), derived from the same dims/usage/rate the total
      // priced — never accepted from the caller, so it cannot disagree with the total.
      const split = computeDimensionScaledUnits({
        dims: resolved.dims,
        quantities: usage,
        rate: resolved.rate,
      });
      // An all-zero usage (a failed job settled at a real zero, video's own lane) splits
      // into no members: an empty breakdown explains nothing and the writer's allocation
      // check refuses it, so it is omitted — exactly as a split that could not compute is.
      const dimensionBreakdown =
        split.ok && split.members.length > 0 ? split.members : undefined;

      // The over-cap anomaly, computed BEFORE the settle so its shape is the priced fact:
      // exact terminal cost against the certified cap, exact rationals both sides.
      const cap = BigInt(reservation.maximum);
      const exact = priced.exactScaledUnits;
      const overCap: AsyncSettleOverCap | undefined =
        exact.numerator > cap * exact.denominator
          ? {
              maximumCredits: reservation.maximum,
              actualCost: {
                numerator: exact.numerator.toString(),
                denominator: exact.denominator.toString(),
              },
              overBy: {
                numerator: (
                  exact.numerator -
                  cap * exact.denominator
                ).toString(),
                denominator: exact.denominator.toString(),
              },
            }
          : undefined;

      try {
        const settled = await writer.settleReservation({
          reservationId: job.reservationId,
          actual: exact,
          title: `settle async ${basis.provider}/${basis.model}`,
          // The job IS the request's identity here: the ledger row's request id is the
          // attribution key every surface of an async charge names.
          requestId: job.jobId,
          model: basis.model,
          lineDetail: {
            capability: asyncLineCapability(job.model.capability),
            jobId: job.jobId,
            providerJobId: job.providerJobId,
            entryCount: job.entryCount,
            terminalState: input.terminal.state,
            actualUsage: usage,
          },
          ...(dimensionBreakdown !== undefined ? { dimensionBreakdown } : {}),
        });

        if (overCap !== undefined && !wasSettled) {
          // The anomaly is recorded by the trigger whose settlement landed it; a replay's
          // first result carries the same overage, already on the trail.
          await auditOverCap(dependencies.audit, {
            jobId: job.jobId,
            reservationId: job.reservationId,
            payer: job.payer,
            terminalState: input.terminal.state,
            overCap,
          });
        }

        return {
          status: "settled",
          jobId: job.jobId,
          reservationId: job.reservationId,
          chargedCredits: settled.chargedCents,
          appliedCredits: settled.appliedCents,
          releasedCredits: settled.releasedCents,
          actualCost: {
            numerator: exact.numerator.toString(),
            denominator: exact.denominator.toString(),
          },
          remainder: {
            numerator: settled.remainder.numerator.toString(),
            denominator: settled.remainder.denominator.toString(),
          },
          ...(overCap !== undefined ? { overCap } : {}),
          trigger: {
            totalTriggers: trigger.totalTriggers,
            pollTriggers: trigger.pollTriggers,
            notificationTriggers: trigger.notificationTriggers,
            lastTriggeredAt: trigger.lastTriggeredAt,
            lastSource: trigger.lastSource,
          },
        };
      } catch (error) {
        if (error instanceof CreditReservationConflictError) {
          // The writer's own stable kinds (no_such_reservation / reservation_released /
          // settled_with_different_actual): a same-actual replay never reaches here — the
          // writer answers the first result as a normal return; the amended report the key
          // already versioned surfaces as the conflict it is, never a top-up.
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

export type AsyncTerminalSettleService = ReturnType<
  typeof createAsyncTerminalSettleService
>;
